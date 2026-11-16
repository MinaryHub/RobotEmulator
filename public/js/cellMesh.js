// 셀 주변기기 3D 표시: 추가 테이블, 장애물, 컨베이어(벨트 무늬 이동), 피더 호퍼, 센서(ON=녹색), 실린더, 배출구, 팔레트
// robotView.updateCell(st) 에서 사용. 좌표 mm (robotView.world 가 m 로 축소)
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { box, cylZ } from './gripperMesh.js';

const DEG = Math.PI / 180;

// 사용자 3D 모델(GLB) 캐시: 자산 id → Promise<THREE.Object3D | null(파일 없음)>
const glbCache = new Map();
function loadAsset(id) {
  // 실패(파일 없음)는 캐시하지 않음 → 프로젝트 가져오기 등으로 파일이 생기면 다음 build 에서 다시 시도
  if (!glbCache.has(id)) glbCache.set(id, new GLTFLoader().loadAsync(`/assets/models/${id}.glb`).then((g) => g.scene).catch(() => { glbCache.delete(id); return null; }));
  return glbCache.get(id);
}
// 위쪽 축 보정 (shared/meshcol.js upMatrix 와 같은 회전)
const UP_ROT = { z: [0, 0, 0], y: [Math.PI / 2, 0, 0], x: [0, -Math.PI / 2, 0] };
const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.6, ...o });
const TABLE_TH = 30;

function beltTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#23272c'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#3a4048';
  for (let i = 0; i < 64; i += 16) g.fillRect(i, 0, 6, 64);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export class CellMeshes {
  constructor(view) {
    this.view = view;
    this.group = new THREE.Group();
    view.world.add(this.group);
    this.key = null;
    this.sceneKey = null;
    this.dyn = {};       // id → 동적 갱신 핸들
    this._t = performance.now();
    // 벨트 무늬는 상태 수신과 무관하게 매 프레임 이동
    const loop = () => { this.animate(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  animate() {
    const now = performance.now(), dt = Math.min(0.2, (now - this._t) / 1000);
    this._t = now;
    const cell = this.cell;
    if (!cell?.layout) return;
    for (const d of cell.layout.devices) {
      const h = this.dyn[d.id], s = cell.status?.[d.id];
      if (d.type === 'conveyor' && h?.tex && s?.running) h.tex.offset.x -= (d.speed * (s.dir || 1) * dt) / h.period;
    }
  }

  update(st) {
    const cell = st.cell;
    if (!cell?.layout) return;
    // 메인 테이블 변경 → 기본 셀 재구성 (바닥 높이 변경 시에는 app.js 가 이미 처리)
    const sk = JSON.stringify(st.scene);
    if (this.sceneKey !== null && sk !== this.sceneKey) this.view.buildCell(st.scene);
    this.sceneKey = sk;
    const key = cell.rev + '|' + sk;
    if (key !== this.key) { this.key = key; this.build(cell.layout, st.scene); }
    this.cell = cell;
    // 간섭 중인 3D 모델 붉게 표시
    this.hitIds = new Set((st.collision?.pairs || []).map((p) => p.b));
    for (const m of cell.layout.models || []) this.tintModel(m.id);
    for (const d of cell.layout.devices) {
      const h = this.dyn[d.id], s = cell.status?.[d.id];
      if (!h || !s) continue;
      if (d.type === 'sensor') {
        h.mat.color.setHex(s.on ? 0x2fe07a : 0x8090a0);
        h.mat.opacity = s.on ? 0.42 : 0.16;
        h.led.material.color.setHex(s.on ? 0x2fe07a : 0x333333);
      }
      if (d.type === 'cylinder') {
        const ext = s.pos * d.stroke;
        h.rod.scale.x = Math.max(1e-3, ext + d.bore * 0.3);
        h.rod.position.x = d.length + (ext + d.bore * 0.3) / 2;
        h.head.position.x = d.length + ext + d.bore * 0.3;
      }
    }
  }

  clear() {
    this.group.traverse((m) => { if (m.isMesh || m.isLineSegments) { m.geometry?.dispose(); } });
    this.group.clear();
    this.dyn = {};
  }

  build(L, scene) {
    this.clear();
    const fz = scene.floorZ;
    const G = this.group;
    const token = (this._token = (this._token || 0) + 1);
    for (const m of L.models || []) this.buildModel(m, token);
    const place = (obj, x, y, yawDeg = 0) => { const g = new THREE.Group(); g.position.set(x, y, 0); g.rotation.z = yawDeg * DEG; g.add(obj); return g; };
    const edges = (mesh, color = 0x111111) => { mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color }))); return mesh; };

    // 추가 테이블 (tables[0] 은 robotView.buildCell 이 그림)
    L.tables.slice(1).forEach((t) => {
      G.add(box(t.w, t.d, TABLE_TH, std(0x8a9199, { metalness: 0.5, roughness: 0.4 }), t.x, t.y, t.z - TABLE_TH));
      const legH = t.z - TABLE_TH - fz, legMat = std(0x3d444c);
      if (legH > 0) for (const sx of [-1, 1]) for (const sy of [-1, 1]) G.add(box(40, 40, legH, legMat, t.x + sx * (t.w / 2 - 40), t.y + sy * (t.d / 2 - 40), fz));
    });

    // 장애물
    for (const o of L.obstacles) {
      const m = edges(box(o.w, o.d, o.h, std(o.color, (() => { const op = o.opacity ?? (o.collide === false ? 0.5 : 1); return { transparent: op < 1, opacity: op, depthWrite: op >= 1 }; })()), 0, 0, o.z));
      G.add(place(m, o.x, o.y, o.yaw || 0));
    }

    for (const d of L.devices) {
      switch (d.type) {
        case 'conveyor': {
          const dx = d.x1 - d.x0, dy = d.y1 - d.y0, len = Math.hypot(dx, dy), yaw = Math.atan2(dy, dx) / DEG;
          const g = new THREE.Group();
          const frameMat = std(0x56606c, { metalness: 0.5 });
          // 프레임 (벨트 아래 몸체)
          const bodyH = 60;
          g.add(box(len, d.width + 20, bodyH, frameMat, len / 2, 0, d.z - bodyH - 2));
          // 다리
          const legH = d.z - bodyH - 2 - fz;
          if (legH > 0) for (const t of [0.06, 0.5, 0.94]) for (const sy of [-1, 1]) g.add(box(30, 30, legH, std(0x3d444c), len * t, sy * (d.width / 2 - 5), fz));
          // 벨트 (줄무늬 텍스처 이동)
          const tex = beltTexture();
          const period = 40;
          tex.repeat.set(len / period, 1);
          const belt = new THREE.Mesh(new THREE.BoxGeometry(len, d.width, 2), [std(0x23272c), std(0x23272c), std(0x23272c), std(0x23272c), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }), std(0x23272c)]);
          belt.position.set(len / 2, 0, d.z - 1);
          belt.receiveShadow = true;
          g.add(belt);
          // 사이드 가이드
          for (const sy of [-1, 1]) g.add(box(len, 6, 14, std(0xb8bec6, { metalness: 0.6 }), len / 2, sy * (d.width / 2 + 7), d.z - 4));
          // 롤러 끝
          for (const x of [0, len]) { const r = new THREE.Mesh(new THREE.CylinderGeometry(bodyH / 2, bodyH / 2, d.width + 4, 20), frameMat); r.position.set(x, 0, d.z - bodyH / 2 - 2); g.add(r); }
          // 스토퍼
          if (d.stopper) g.add(box(10, d.width + 20, 22, std(0xf0a020), len + 5, 0, d.z - 2));
          G.add(place(g, d.x0, d.y0, yaw));
          this.dyn[d.id] = { tex, period };
          break;
        }
        case 'feeder': {
          const s = d.size, zb = d.z + s[2] * 1.6, hh = s[2] * 1.4, w = s[0] * 1.6, dd = s[1] * 1.6;
          const g = new THREE.Group();
          const mat = std(0xd8b200, { metalness: 0.4 });
          for (const sy of [-1, 1]) g.add(box(w, 4, hh, mat, 0, sy * dd / 2, zb));
          for (const sx of [-1, 1]) g.add(box(4, dd, hh, mat, sx * w / 2, 0, zb));
          // 지지대
          for (const sx of [-1, 1]) g.add(box(8, 8, zb - d.z + hh, std(0x3d444c), sx * (w / 2 + 6), 0, d.z));
          // 내부에 대기 중인 공작물 표시
          g.add(edges(box(s[0], s[1], s[2], std(d.color), 0, 0, zb + 4)));
          G.add(place(g, d.x, d.y, d.yaw || 0));
          break;
        }
        case 'sensor': {
          const mat = new THREE.MeshBasicMaterial({ color: 0x8090a0, transparent: true, opacity: 0.16, depthWrite: false });
          const m = new THREE.Mesh(new THREE.BoxGeometry(d.w, d.d, d.h), mat);
          m.position.set(0, 0, d.z);
          const g = new THREE.Group();
          g.add(m);
          m.add(new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color: 0x2fe07a, transparent: true, opacity: 0.6 })));
          // 투광기/수광기
          const head = std(0x30343a);
          g.add(box(14, 20, 24, head, -d.w / 2 - 12, 0, d.z - 12));
          g.add(box(14, 20, 24, head, d.w / 2 + 12, 0, d.z - 12));
          const led = new THREE.Mesh(new THREE.SphereGeometry(5, 12, 8), new THREE.MeshBasicMaterial({ color: 0x333333 }));
          led.position.set(-d.w / 2 - 12, 0, d.z + 17);
          g.add(led);
          G.add(place(g, d.x, d.y, d.yaw || 0));
          this.dyn[d.id] = { mat, led };
          break;
        }
        case 'cylinder': {
          const g = new THREE.Group();
          const body = edges(new THREE.Mesh(new THREE.BoxGeometry(d.length, d.bore, d.bore), std(0x9aa4b0, { metalness: 0.6 })));
          body.position.set(d.length / 2, 0, d.z);
          const rodGeo = new THREE.CylinderGeometry(d.bore * 0.18, d.bore * 0.18, 1, 16);
          rodGeo.rotateZ(Math.PI / 2);
          const rod = new THREE.Mesh(rodGeo, std(0xdde3ea, { metalness: 0.9, roughness: 0.2 }));
          rod.position.set(d.length, 0, d.z);
          const head = edges(new THREE.Mesh(new THREE.BoxGeometry(12, d.bore * 1.2, d.bore * 1.2), std(0x3d8bfd)));
          head.position.set(d.length, 0, d.z);
          g.add(body, rod, head);
          // 받침
          if (d.z - d.bore / 2 > fz) g.add(box(d.length * 0.3, d.bore, d.z - d.bore / 2 - fz, std(0x3d444c), d.length * 0.2, 0, fz));
          G.add(place(g, d.x, d.y, d.yaw || 0));
          this.dyn[d.id] = { rod, head };
          break;
        }
        case 'sink': {
          const g = new THREE.Group();
          const mat = std(0xd9822b, { transparent: true, opacity: 0.55 });
          const t = 6;
          g.add(box(d.w, d.d, t, mat, 0, 0, d.z));
          for (const sy of [-1, 1]) g.add(box(d.w, t, d.h, mat, 0, sy * (d.d / 2 - t / 2), d.z));
          for (const sx of [-1, 1]) g.add(box(t, d.d, d.h, mat, sx * (d.w / 2 - t / 2), 0, d.z));
          G.add(place(g, d.x, d.y));
          break;
        }
        case 'pallet': {
          const g = new THREE.Group();
          const pts = [];
          const cw = Math.abs(d.pitchX) * 0.8, ch = Math.abs(d.pitchY) * 0.8;
          for (let r = 0; r < d.rows; r++) for (let c = 0; c < d.cols; c++) {
            const x = c * d.pitchX, y = r * d.pitchY;
            const q = [[x - cw / 2, y - ch / 2], [x + cw / 2, y - ch / 2], [x + cw / 2, y + ch / 2], [x - cw / 2, y + ch / 2]];
            for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; pts.push(a[0], a[1], 0, b[0], b[1], 0); }
            pts.push(x - 8, y, 0, x + 8, y, 0, x, y - 8, 0, x, y + 8, 0);
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
          const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xf0c040 }));
          lines.position.set(d.x, d.y, d.z + 0.8);
          g.add(lines);
          G.add(g);
          break;
        }
      }
    }
    G.traverse((m) => { if (m.isMesh && !(m.material?.transparent)) { m.castShadow = true; m.receiveShadow = true; } });
  }

  // 사용자 3D 모델: 월드 = 위치 · 회전(Rz·Ry·Rx) · 배율 · [offset · 단위 · 위쪽 축 보정] · 파일 좌표  (server/cell.js models 스키마)
  buildModel(m, token) {
    const outer = new THREE.Group();
    outer.position.set(m.x, m.y, m.z);
    outer.rotation.set(m.rx * DEG, m.ry * DEG, m.rz * DEG, 'ZYX');
    outer.scale.setScalar(m.scale);
    const inner = new THREE.Group();
    inner.position.set(...m.offset);
    inner.scale.setScalar(m.unit);
    inner.rotation.set(...(UP_ROT[m.up] || UP_ROT.z));
    outer.add(inner);
    outer.userData.modelId = m.id;
    this.group.add(outer);
    // 불러오는 동안(또는 파일 없음) 경계 상자 표시
    let ph = null;
    if (m.bbox) {
      const [lo, hi] = m.bbox, sz = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]].map((v) => Math.max(v, 1e-6));
      ph = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(...sz)), new THREE.LineBasicMaterial({ color: 0xf0a020 }));
      ph.position.set((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
      inner.add(ph);
    }
    this.dyn[m.id] = { group: outer };
    loadAsset(m.asset).then((scene) => {
      if (token !== this._token) return;                 // 그 사이 다시 그림
      if (!scene) { if (ph) ph.material.color.setHex(0xe05050); return; }   // 파일 없음 → 빨간 상자
      if (ph) { inner.remove(ph); ph.geometry.dispose(); }
      const obj = scene.clone(true);
      const mats = [];
      obj.traverse((o) => {
        if (!o.isMesh) return;
        // 인스턴스마다 재질 복제 (색·투명도·간섭 하이라이트가 다른 배치에 번지지 않도록)
        o.material = (Array.isArray(o.material) ? o.material : [o.material]).map((src) => {
          const mat = src.clone();
          if (m.color !== null && m.color !== undefined) { mat.color?.setHex(m.color); mat.map = null; mat.vertexColors = false; }
          if (m.opacity < 1) { mat.transparent = true; mat.opacity = m.opacity; mat.depthWrite = false; }
          mats.push(mat);
          return mat;
        });
        if (o.material.length === 1) o.material = o.material[0];
        o.castShadow = m.opacity >= 1; o.receiveShadow = true;
      });
      inner.add(obj);
      this.dyn[m.id] = { group: outer, mats, hit: false };
      this.tintModel(m.id);          // 불러오는 사이에 받은 간섭 상태 반영
    });
  }

  tintModel(id) {
    const h = this.dyn[id];
    if (!h?.mats) return;
    const on = !!this.hitIds?.has(id);
    if (h.hit === on) return;
    h.hit = on;
    // 로봇 링크 하이라이트(robotView.setCollision)와 같은 방식: 색을 빨강 쪽으로 + 자체발광
    const red = new THREE.Color(0xff2a1a);
    for (const mat of h.mats) {
      if (on) {
        mat.userData.orig = { color: mat.color?.getHex(), emissive: mat.emissive?.getHex() };
        mat.color?.lerp(red, 0.65);
        mat.emissive?.setHex(0x550000);
      } else if (mat.userData.orig) {
        if (mat.color) mat.color.setHex(mat.userData.orig.color);
        mat.emissive?.setHex(mat.userData.orig.emissive ?? 0);
      }
    }
  }
}
