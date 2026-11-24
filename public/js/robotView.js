// Three.js 3D 뷰: 로봇(OPW 파라미터 기반 절차적 형상), 그리퍼, 셀(받침대/테이블/공작물), TCP 궤적
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { jointFrames } from '/shared/kinematics.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildGripper, cylZ, box } from './gripperMesh.js';
import { buildRobotLinks } from './robotMesh.js';
import { CellMeshes } from './cellMesh.js';
import { disposeTree, clearGroup } from './dispose.js';
import { CameraRig, HELPER_LAYER } from './cameraView.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const setMat4 = (out, f) => out.set(
  f.R[0][0], f.R[0][1], f.R[0][2], f.p[0],
  f.R[1][0], f.R[1][1], f.R[1][2], f.p[1],
  f.R[2][0], f.R[2][1], f.R[2][2], f.p[2],
  0, 0, 0, 1);
const mat4 = (f) => setMat4(new THREE.Matrix4(), f);

export class RobotView {
  constructor(el) {
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1b1f24);
    // 도장면/가공면 반사용 실내 환경맵 (한 번만 생성)
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const roomEnv = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(roomEnv, 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    roomEnv.dispose();
    pmrem.dispose();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    this.camera.up.set(0, 0, 1);
    this.camera.layers.enable(HELPER_LAYER); // 보조 표시 (비전 카메라 영상에는 제외)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this._dirty = true;
    this._damping = false;
    this.controls.addEventListener('change', () => { this._dirty = true; });
    this.controls.addEventListener('start', () => { this._damping = true; this._dirty = true; });
    this.controls.addEventListener('end', () => { this._dirty = true; });

    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30302a, 0.8));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(2, -3, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.1, far: 20 });
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0x9fb4ff, 0.6);
    fill.position.set(-3, 2, 2);
    this.scene.add(fill);

    // 월드: mm 단위 → m 로 축소
    this.world = new THREE.Group();
    this.world.scale.setScalar(0.001);
    this.scene.add(this.world);
    this.cell = new THREE.Group();
    this.robotGroup = new THREE.Group();
    this.objGroup = new THREE.Group();
    this.world.add(this.cell, this.robotGroup, this.objGroup);

    this.links = [];
    this.tool = null;
    this.toolGroup = new THREE.Group();
    this.toolGroup.matrixAutoUpdate = false;
    this.robotGroup.add(this.toolGroup);
    this.tcpAxes = new THREE.AxesHelper(80);
    this.tcpAxes.matrixAutoUpdate = false;
    this.tcpAxes.layers.set(HELPER_LAYER);
    this.world.add(this.tcpAxes);
    this.userAxes = new THREE.AxesHelper(140);
    this.userAxes.matrixAutoUpdate = false;
    this.userAxes.visible = false;
    this.userAxes.layers.set(HELPER_LAYER);
    this.world.add(this.userAxes);
    this.zoneGroup = new THREE.Group();
    this.zoneGroup.layers.set(HELPER_LAYER);
    this.world.add(this.zoneGroup);
    this._zoneSig = '';
    this.objMeshes = new Map();

    // 프레임당 할당을 줄이기 위한 재사용 벡터·행렬
    this._m = new THREE.Matrix4();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._one = new THREE.Vector3(1, 1, 1);
    this._q = new THREE.Quaternion();
    this._lastTcp = null;

    this.trailOn = true;
    this.trailMax = 3000;
    this.trailPts = new Float32Array(this.trailMax * 3);
    this.trailN = 0;
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.trailPts, 3));
    this.trail = new THREE.Line(tg, new THREE.LineBasicMaterial({ color: 0x00e0ff }));
    this.trail.frustumCulled = false;
    this.trail.layers.set(HELPER_LAYER);
    this.world.add(this.trail);

    this.cameras = new CameraRig(this, el.parentElement);

    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    const loop = (now) => {
      const movedBelt = this.cellDevices?.animate(now) || false;
      const movedCam = this.controls.update();
      if (this._dirty || movedBelt || movedCam) {
        this._dirty = false;
        this.renderer.render(this.scene, this.camera);
        this.cameras.render();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  markDirty(shadow = false) {
    this._dirty = true;
    if (shadow) this.renderer.shadowMap.needsUpdate = true;
  }

  setTheme(light) {
    this.scene.background.setHex(light ? 0xdce2ea : 0x1b1f24);
    this.markDirty(false);
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.markDirty(false);
  }

  fitView() { this.setViewPreset('iso'); }

  setViewPreset(preset = 'iso') {
    if (!this.model) return;
    const R = this.model.reach / 1000;
    const cx = R * 0.35, cz = R * 0.25;
    if (preset === 'top') {
      this.camera.position.set(cx, -0.01, R * 2.5);
      this.controls.target.set(cx, 0, 0);
    } else if (preset === 'front') {
      this.camera.position.set(R * 2.4, 0, cz + R * 0.15);
      this.controls.target.set(0, 0, cz);
    } else if (preset === 'side') {
      this.camera.position.set(cx, -R * 2.4, cz + R * 0.15);
      this.controls.target.set(cx, 0, cz);
    } else if (preset === 'tcp' && this._lastTcp) {
      const [x, y, z] = this._lastTcp.map((v) => v / 1000);
      const d = Math.max(0.35, R * 0.45);
      this.camera.position.set(x + d, y - d, z + d * 0.7);
      this.controls.target.set(x, y, z);
    } else {
      this.camera.position.set(R * 1.9, -R * 1.7, R * 1.3);
      this.controls.target.set(cx, 0, cz);
    }
    this.controls.update();
    this.markDirty(false);
  }

  // ------------------------------------------------------------------ 셀 (바닥/받침대/테이블)
  buildCell(sc) {
    clearGroup(this.cell);
    const fz = sc.floorZ;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000), new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.95 }));
    floor.position.z = fz;
    floor.receiveShadow = true;
    this.cell.add(floor);
    const grid = new THREE.GridHelper(10000, 50, 0x55606c, 0x3a424c);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = fz + 0.5;
    this.cell.add(grid);
    // 로봇 받침대
    const ped = cylZ(sc.pedestal.d / 2, sc.pedestal.h, new THREE.MeshStandardMaterial({ color: 0x5b6470, metalness: 0.4, roughness: 0.6 }), fz, 6);
    this.cell.add(ped);
    this.cell.add(cylZ(sc.pedestal.d * 0.62, 12, new THREE.MeshStandardMaterial({ color: 0xd8b200 }), -12, 48));
    // 작업 테이블
    const t = sc.table, th = 30, legH = -fz - th;
    const top = box(t.w, t.d, th, new THREE.MeshStandardMaterial({ color: 0x8a9199, metalness: 0.5, roughness: 0.4 }), t.x, t.y, -th);
    this.cell.add(top);
    const legMat = new THREE.MeshStandardMaterial({ color: 0x3d444c });
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) this.cell.add(box(40, 40, legH, legMat, t.x + sx * (t.w / 2 - 40), t.y + sy * (t.d / 2 - 40), fz));
    // 테이블 위 좌표 눈금 (100mm)
    const g2 = new THREE.GridHelper(Math.max(t.w, t.d), Math.round(Math.max(t.w, t.d) / 100), 0x6f7880, 0x6f7880);
    g2.rotation.x = Math.PI / 2;
    g2.position.set(t.x, t.y, 0.6);
    g2.material.transparent = true; g2.material.opacity = 0.25;
    this.cell.add(g2);
    // 베이스 좌표축
    const ax = new THREE.AxesHelper(Math.max(150, this.model.reach * 0.2));
    ax.position.z = 1;
    ax.layers.set(HELPER_LAYER);
    this.cell.add(ax);
    this.markDirty(true);
  }

  // ------------------------------------------------------------------ 로봇
  setRobot(model, vendor, sceneInfo) {
    this.model = model;
    for (const l of this.links) {
      this.robotGroup.remove(l);
      disposeTree(l);
    }
    this.links = [];
    // 링크 형상: public/js/robotMesh.js (OPW 파라미터로 치수 산출, 제조사별 색/비례)
    const { links: L, update } = buildRobotLinks(model, vendor);
    this._linkUpdate = update;

    // 재질은 링크 간 공유되므로 메시별로 복제 (충돌 하이라이트 시 다른 링크까지 물들지 않도록) — 원본 공유 재질은 해제
    const origMats = new Set();
    for (const g of L) {
      g.traverse((m) => {
        if (!m.isMesh) return;
        m.castShadow = true; m.receiveShadow = true;
        if (Array.isArray(m.material)) {
          m.material = m.material.map((mt) => { origMats.add(mt); return mt.clone(); });
        } else if (m.material) {
          origMats.add(m.material);
          m.material = m.material.clone();
        }
      });
    }
    for (const mt of origMats) mt.dispose?.();
    this.links = L;
    this._lastJSig = null;
    this._lastGripPos = null;
    // 이전 링크 재질은 폐기됨 → 툴 쪽 하이라이트 기록만 남겨 원복 대상으로 유지
    this._tinted = (this._tinted || []).filter((t) => t.owner === 'tool');
    this.robotGroup.add(...L);
    this.buildCell(sceneInfo);
    this.clearTrail();
    this.fitView();
    this._reapplyCollision();
    this.markDirty(true);
  }

  setGripper(def, customGeometry) {
    clearGroup(this.toolGroup);
    this.tool = buildGripper(def, customGeometry);
    this.toolGroup.add(this.tool.group);
    this.gripperId = def.id;
    this._lastGripPos = null;
    this._tinted = (this._tinted || []).filter((t) => t.owner !== 'tool');
    this._reapplyCollision();
    this.markDirty(true);
  }

  // ------------------------------------------------------------------ 충돌 표시
  // ids: shared/collision.js 캡슐 id 배열 (turret/upperArm/elbow/forearm/wrist/tool). 빈 배열/null → 해제
  setCollision(ids) {
    const want = [...new Set(ids || [])].sort();
    const key = want.join(',');
    this._collIds = want;
    if (key === this._collKey) return;
    this._collKey = key;
    // 이전 하이라이트 원복
    for (const t of this._tinted || []) {
      t.mat.color.setHex(t.color);
      t.mat.emissive?.setHex(t.emissive);
    }
    this._tinted = [];
    const map = { turret: this.links[1], upperArm: this.links[2], elbow: this.links[3], forearm: this.links[4], wrist: this.links[5], tool: this.toolGroup };
    const red = new THREE.Color(0xff2a1a);
    const done = new Set();
    for (const id of want) {
      const g = map[id];
      if (!g) continue;
      g.traverse((m) => {
        if (!m.isMesh) return;
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
          if (!mat?.color || done.has(mat)) continue;
          done.add(mat);
          this._tinted.push({ mat, owner: id === 'tool' ? 'tool' : 'link', color: mat.color.getHex(), emissive: mat.emissive ? mat.emissive.getHex() : 0 });
          mat.color.lerp(red, 0.65);
          mat.emissive?.setHex(0x550000);
        }
      });
    }
    if (this.capGroup?.visible && this._lastCaps) this.showCapsules(true, this._lastCaps);
    this.markDirty(false);
  }

  _reapplyCollision() {
    const ids = this._collIds;
    this._collKey = null;
    if (ids?.length) this.setCollision(ids);
  }

  // 디버그: 충돌 캡슐을 반투명으로 표시 (capsules: robotCapsules() 결과, 로봇 베이스 좌표 mm)
  showCapsules(on, capsules) {
    if (!this.capGroup) {
      this.capGroup = new THREE.Group();
      this.capGroup.visible = false;
      this.world.add(this.capGroup);
      const mk = (color) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, depthWrite: false });
      this._capMat = mk(0x22ff88);
      this._capHitMat = mk(0xff3322);
      this._capCyl = new THREE.CylinderGeometry(1, 1, 1, 18, 1, true);
      this._capSph = new THREE.SphereGeometry(1, 18, 12);
      this._capPool = [];
    }
    this.capGroup.visible = !!on;
    this.markDirty(false);
    if (!on || !capsules) return;
    this._lastCaps = capsules;
    while (this._capPool.length < capsules.length) {
      const set = { cyl: new THREE.Mesh(this._capCyl, this._capMat), s1: new THREE.Mesh(this._capSph, this._capMat), s2: new THREE.Mesh(this._capSph, this._capMat) };
      for (const m of [set.cyl, set.s1, set.s2]) m.layers.set(HELPER_LAYER);
      this.capGroup.add(set.cyl, set.s1, set.s2);
      this._capPool.push(set);
    }
    const hit = new Set(this._collIds || []);
    const up = this._up, dir = this._v3, a = this._v1, b = this._v2;
    this._capPool.forEach((set, i) => {
      const c = capsules[i];
      for (const m of [set.cyl, set.s1, set.s2]) m.visible = !!c;
      if (!c) return;
      const mat = hit.has(c.id) ? this._capHitMat : this._capMat;
      a.set(c.a[0], c.a[1], c.a[2]);
      b.set(c.b[0], c.b[1], c.b[2]);
      const len = a.distanceTo(b);
      set.s1.position.copy(a); set.s2.position.copy(b);
      set.s1.scale.setScalar(c.r); set.s2.scale.setScalar(c.r);
      set.cyl.position.copy(a).add(b).multiplyScalar(0.5);
      set.cyl.scale.set(c.r, Math.max(1e-3, len), c.r);
      if (len > 1e-6) set.cyl.quaternion.setFromUnitVectors(up, dir.copy(b).sub(a).normalize());
      set.cyl.visible = len > 1e-6;
      set.cyl.material = set.s1.material = set.s2.material = mat;
    });
  }

  // ------------------------------------------------------------------ 상태 반영
  update(st) {
    if (!this.model) return;
    let movedShadow = false;
    const jSig = st.joints.join(',');
    if (jSig !== this._lastJSig || st.grip.pos !== this._lastGripPos) {
      this._lastJSig = jSig;
      this._lastGripPos = st.grip.pos;
      movedShadow = true;
      const F = jointFrames(this.model, st.joints);
      for (let i = 0; i < 7; i++) setMat4(this.links[i].matrix, F[i]);
      this._linkUpdate?.();
      setMat4(this.toolGroup.matrix, F[6]);
      this.cameras.update(F, mat4);
      this.tool?.setPos(st.grip.pos);
    }
    // TCP
    const { p, q } = st.tcpWorld;
    this._lastTcp = p;
    this._v1.set(p[0], p[1], p[2]);
    this._q.set(q[1], q[2], q[3], q[0]);
    this.tcpAxes.matrix.compose(this._v1, this._q, this._one);
    // 활성 User Frame 3D 축 표시
    if (st.activeUserFrame) {
      const uf = st.activeUserFrame;
      this.userAxes.visible = true;
      this._v2.set(uf.p[0], uf.p[1], uf.p[2]);
      this._q.set(uf.q[1], uf.q[2], uf.q[3], uf.q[0]);
      this.userAxes.matrix.compose(this._v2, this._q, this._one);
    } else {
      this.userAxes.visible = false;
    }
    if (this.trailOn && st.moving) this.pushTrail(p);
    // 공작물
    const seen = new Set();
    for (const o of st.objects) {
      seen.add(o.id);
      let mesh = this.objMeshes.get(o.id);
      const sk = o.size.join();
      if (!mesh || mesh.userData.sizeKey !== sk) {
        if (mesh) { this.objGroup.remove(mesh); disposeTree(mesh); }
        mesh = new THREE.Mesh(new THREE.BoxGeometry(...o.size), new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.6 }));
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.userData.sizeKey = sk;
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: 0x111111 }));
        mesh.add(edges);
        this.objMeshes.set(o.id, mesh);
        this.objGroup.add(mesh);
        movedShadow = true;
      }
      if (mesh.position.x !== o.p[0] || mesh.position.y !== o.p[1] || mesh.position.z !== o.p[2]) {
        mesh.position.set(o.p[0], o.p[1], o.p[2]);
        movedShadow = true;
      }
      if (mesh.quaternion.x !== o.q[1] || mesh.quaternion.y !== o.q[2] || mesh.quaternion.z !== o.q[3] || mesh.quaternion.w !== o.q[0]) {
        mesh.quaternion.set(o.q[1], o.q[2], o.q[3], o.q[0]);
        movedShadow = true;
      }
      mesh.material.emissive?.setHex(st.grip.holding === o.id ? 0x222222 : 0);
    }
    for (const [id, mesh] of this.objMeshes) if (!seen.has(id)) { this.objGroup.remove(mesh); disposeTree(mesh); this.objMeshes.delete(id); movedShadow = true; }
    if (st.cell) this.updateCell(st);
    if (st.zones) this.updateZones(st.zones);
    this.markDirty(movedShadow);
  }

  // 셀 주변기기 (컨베이어/피더/센서/장애물/실린더/배출구/팔레트) — public/js/cellMesh.js
  updateCell(st) {
    if (!this.cellDevices) this.cellDevices = new CellMeshes(this);
    this.cellDevices.update(st);
  }

  // 안전 영역(SafeZone) · 간섭 구역(Interference Zone) 3D 표시 (HELPER_LAYER → 비전 영상 제외)
  updateZones(zones) {
    const list = Array.isArray(zones) ? zones : [];
    const sig = JSON.stringify(list.map((z) => [z.id, z.kind, z.shape, z.enabled, z.p, z.size, !!z.active]));
    if (sig === this._zoneSig) return;
    this._zoneSig = sig;
    clearGroup(this.zoneGroup);
    for (const z of list) {
      if (!z.enabled) continue;
      const isSafe = z.kind === 'safe';
      const col = isSafe ? 0xff3b30 : (z.active ? 0xf59e0b : 0x38bdf8);
      const geo = z.shape === 'cylinder'
        ? (() => { const g = new THREE.CylinderGeometry(z.size[0] / 2, z.size[0] / 2, z.size[2], 24); g.rotateX(Math.PI / 2); return g; })()
        : new THREE.BoxGeometry(z.size[0], z.size[1], z.size[2]);
      const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: z.active ? 0.24 : 0.10, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(z.p[0], z.p[1], z.p[2]);
      mesh.layers.set(HELPER_LAYER);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: z.active ? 0.95 : 0.6 }));
      edges.layers.set(HELPER_LAYER);
      mesh.add(edges);
      this.zoneGroup.add(mesh);
    }
    this.markDirty(false);
  }

  // 작업 영역: 관절 한계 내 무작위 자세의 손목 중심(P점) 분포 — 데이터시트의 동작 범위도와 같은 기준
  showEnvelope(on) {
    if (this.envelope) { this.world.remove(this.envelope); disposeTree(this.envelope); this.envelope = null; }
    this.markDirty(false);
    if (!on || !this.model) return;
    const m = this.model, N = 24000;
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    const c = new THREE.Color();
    let zmin = Infinity, zmax = -Infinity;
    const j = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < N; i++) {
      for (let k = 0; k < 3; k++) { const [lo, hi] = m.limits[k]; j[k] = lo + Math.random() * (hi - lo); }
      const w = jointFrames(m, j)[5].p;
      pos.set(w, i * 3);
      zmin = Math.min(zmin, w[2]); zmax = Math.max(zmax, w[2]);
    }
    for (let i = 0; i < N; i++) {
      c.setHSL(0.62 - 0.5 * (pos[i * 3 + 2] - zmin) / (zmax - zmin || 1), 0.85, 0.55);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.envelope = new THREE.Points(g, new THREE.PointsMaterial({ size: Math.max(4, m.reach * 0.006), vertexColors: true, transparent: true, opacity: 0.35, depthWrite: false }));
    this.envelope.layers.set(HELPER_LAYER);
    this.world.add(this.envelope);
    this.markDirty(false);
  }

  pushTrail(p) {
    const n = this.trailN;
    if (n > 0) {
      const i = (n - 1) * 3;
      if (Math.hypot(this.trailPts[i] - p[0], this.trailPts[i + 1] - p[1], this.trailPts[i + 2] - p[2]) < 2) return;
    }
    if (n >= this.trailMax) { this.trailPts.copyWithin(0, 3); this.trailN--; }
    this.trailPts.set(p, this.trailN * 3);
    this.trailN++;
    this.trail.geometry.setDrawRange(0, this.trailN);
    this.trail.geometry.attributes.position.needsUpdate = true;
    this.markDirty(false);
  }
  clearTrail() { this.trailN = 0; this.trail.geometry.setDrawRange(0, 0); this.markDirty(false); }
}
