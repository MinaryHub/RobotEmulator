// 그리퍼 3D 형상 생성 (플랜지 좌표계: +Z = 툴 방향, 단위 mm)
import * as THREE from 'three';

const M = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.55, ...opts });
const ALU = () => M(0xb8bec6, { metalness: 0.6, roughness: 0.35 });
const DARK = () => M(0x2b2f36);
const BLUEGRAY = () => M(0x40505f);
const RUBBER = () => M(0x1a1a1a, { roughness: 0.9, metalness: 0 });

export function cylZ(r, h, mat, z0 = 0, seg = 32, rTop = r) {
  const g = new THREE.CylinderGeometry(rTop, r, h, seg);
  g.rotateX(Math.PI / 2); // Y축 → Z축
  const m = new THREE.Mesh(g, mat);
  m.position.z = z0 + h / 2;
  m.castShadow = m.receiveShadow = true;
  return m;
}
export function box(w, d, h, mat, x = 0, y = 0, z0 = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), mat);
  m.position.set(x, y, z0 + h / 2);
  m.castShadow = m.receiveShadow = true;
  return m;
}

// def: grippers.js 항목, customMesh: 사용자 STL (THREE.BufferGeometry)
export function buildGripper(def, customGeometry) {
  const group = new THREE.Group();
  let setPos = () => {};
  const g = def.geom || {};
  const cpl = g.coupling || { d: 63, h: 10 };
  const addCoupling = () => { if (def.kind !== 'none') group.add(cylZ(cpl.d / 2, cpl.h, DARK(), 0)); return cpl.h; };

  if (def.custom && customGeometry) {
    customGeometry.userData = { ...(customGeometry.userData || {}), shared: true };
    const mesh = new THREE.Mesh(customGeometry, M(0x9aa4ae));
    mesh.castShadow = true;
    group.add(mesh);
  } else switch (def.kind) {
    case 'none': break;

    case 'parallel':
    case 'adaptive2f': {
      let z = addCoupling();
      const b = g.body, f = g.finger;
      const bodyMat = def.maker === 'Robotiq' ? M(0x30353b) : def.maker === 'OnRobot' ? M(0xdfe3e6) : BLUEGRAY();
      if (def.kind === 'adaptive2f' && def.maker === 'OnRobot') {
        // OnRobot RG: 길쭉한 본체가 측면으로 기울어진 형상 대신 단순화된 세로 본체
        group.add(box(b.w, b.d, b.h, bodyMat, 0, 0, z));
      } else group.add(box(b.w, b.d, b.h, bodyMat, 0, 0, z));
      z += b.h;
      const fingers = [];
      for (const s of [-1, 1]) {
        const fg = new THREE.Group();
        const finger = box(f.t, f.w, f.l, def.kind === 'adaptive2f' ? DARK() : ALU(), 0, 0, 0);
        fg.add(finger);
        if (def.kind === 'adaptive2f') {
          // 링크(너클) + 패드
          fg.add(box(f.t * 0.8, f.w * 0.9, f.l * 0.35, ALU(), s * f.t * 0.6, 0, f.l * 0.1));
          fg.add(box(f.t * 0.6, f.w, f.pad || f.l * 0.4, RUBBER(), -s * f.t * 0.75, 0, f.l - (f.pad || f.l * 0.4)));
        } else {
          fg.add(box(f.t * 0.5, f.w * 0.95, f.l * 0.45, RUBBER(), -s * f.t * 0.7, 0, f.l * 0.55));
        }
        fg.position.z = z;
        group.add(fg);
        fingers.push([fg, s]);
      }
      // 가이드 레일
      group.add(box(Math.max(b.w, def.stroke + f.t * 2) * 0.9, f.w * 0.6, 8, ALU(), 0, 0, z - 8));
      const minGap = 4;
      setPos = (p) => {
        const gap = minGap + (def.stroke || 40) * (1 - p);
        for (const [fg, s] of fingers) fg.position.x = s * (gap / 2 + f.t / 2);
      };
      break;
    }

    case 'threefinger': {
      let z = addCoupling();
      const b = g.body, f = g.finger;
      group.add(box(b.w, b.d, b.h, M(0x30353b), 0, 0, z));
      z += b.h;
      const fingers = [];
      const specs = [[1, 0.3], [1, -0.3], [-1, 0]];
      for (const [sx, yf] of specs) {
        const pivot = new THREE.Group();
        pivot.position.set(sx * b.w * 0.38, yf * b.d * 1.1, z);
        const seg1 = box(f.t, f.w, f.l * 0.55, DARK(), 0, 0, 0);
        const seg2g = new THREE.Group(); seg2g.position.z = f.l * 0.55;
        seg2g.add(box(f.t * 0.9, f.w * 0.9, f.l * 0.45, ALU(), 0, 0, 0));
        seg2g.add(box(f.t * 0.3, f.w * 0.9, f.l * 0.4, RUBBER(), -sx * f.t * 0.55, 0, f.l * 0.05));
        pivot.add(seg1, seg2g);
        group.add(pivot);
        fingers.push([pivot, seg2g, sx]);
      }
      setPos = (p) => {
        for (const [pivot, seg2, sx] of fingers) {
          pivot.rotation.y = -sx * (0.05 + 0.45 * p);
          seg2.rotation.y = -sx * (0.1 + 0.6 * p);
        }
      };
      break;
    }

    case 'vacuum': {
      let z = addCoupling();
      if (g.box) { group.add(box(g.box.w, g.box.d, g.box.h, M(0xe1e4e7), 0, 0, z)); z += g.box.h; }
      if (g.stem?.h) { group.add(cylZ(g.stem.d / 2, g.stem.h, ALU(), z)); z += g.stem.h; }
      if (g.plate) { group.add(box(g.plate.w, g.plate.d, g.plate.t, ALU(), 0, 0, z)); z += g.plate.t; }
      const cupMat = M(0x2d6cdf, { roughness: 0.8, metalness: 0 });
      for (const c of g.cups || []) {
        const cg = new THREE.Group();
        cg.position.set(c.x, c.y, z);
        cg.add(cylZ(c.d * 0.18, c.h * 0.35, ALU(), 0));
        // 벨로즈 2단 + 립
        cg.add(cylZ(c.d * 0.32, c.h * 0.25, cupMat, c.h * 0.3, 24, c.d * 0.38));
        cg.add(cylZ(c.d * 0.38, c.h * 0.2, cupMat, c.h * 0.55, 24, c.d * 0.32));
        cg.add(cylZ(c.d * 0.5, c.h * 0.25, cupMat, c.h * 0.75, 24, c.d * 0.3).rotateX(0));
        group.add(cg);
      }
      const ledMat = new THREE.MeshStandardMaterial({ color: 0x444444, emissive: 0x000000 });
      const led = box(8, 8, 4, ledMat, 0, (g.box?.d || g.stem?.d || 30) / 2 + 2, cpl.h + 4);
      group.add(led);
      setPos = (p) => { ledMat.emissive.setHex(p > 0.5 ? 0x22ff55 : 0x000000); };
      break;
    }

    case 'magnet': {
      let z = addCoupling();
      group.add(cylZ(g.body.d / 2, g.body.h, M(0xdfe3e6), z)); z += g.body.h;
      const faceMat = M(0x7a1d1d);
      group.add(cylZ(g.face.d / 2, g.face.h, faceMat, z));
      setPos = (p) => { faceMat.emissive?.setHex(p > 0.5 ? 0x661111 : 0x000000); };
      break;
    }

    case 'torch': {
      let z = cpl.h;
      group.add(cylZ(cpl.d / 2, cpl.h, DARK(), 0));
      // 넥: 마운트 끝에서 TCP 직전까지, 노즐: TCP 방향
      const [tx, ty, tz, rx] = def.tcp;
      // 툴 Z = Rx(rx)·[0,0,1]
      const dir = new THREE.Vector3(0, -Math.sin(rx * Math.PI / 180), Math.cos(rx * Math.PI / 180)).normalize();
      const tip = new THREE.Vector3(tx, ty, tz);
      const nozzleStart = tip.clone().addScaledVector(dir, -(g.nozzle.l + 15));
      group.add(tube(new THREE.Vector3(0, 0, z), nozzleStart, g.neck.d / 2, M(0x222222)));
      group.add(tube(nozzleStart, tip.clone().addScaledVector(dir, -15), g.nozzle.d / 2, M(0xb08d57, { metalness: 0.8, roughness: 0.3 })));
      group.add(tube(tip.clone().addScaledVector(dir, -15), tip, 1.2, M(0x999999)));
      break;
    }

    case 'spindle': {
      let z = addCoupling();
      group.add(cylZ(g.body.d / 2, g.body.h, M(0x3b4a5a), z)); z += g.body.h;
      group.add(cylZ(g.body.d * 0.3, 20, ALU(), z)); z += 20;
      const bit = cylZ(g.tool.d / 2, g.tool.h, M(0xd4af37, { metalness: 0.9 }), z);
      group.add(bit);
      break;
    }
  }
  return { group, setPos };
}

export function tube(a, b, r, mat) {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r, r, len, 24);
  const m = new THREE.Mesh(g, mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  m.castShadow = true;
  return m;
}
