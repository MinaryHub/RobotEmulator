// 직접교시 (핸드 가이딩): 3D 뷰에서 로봇을 손으로 끌듯이 움직인다
//  - TCP 핸들 (TransformControls): 화살표·평면을 끌면 이동, 링을 끌면 회전. 좌표계 BASE / TOOL, 스냅
//  - 관절 드래그: 링크를 잡고 끌면 그 링크를 움직이는 관절이 회전 (관절 축에 회전 링 표시)
//  - 서버 명령 teachPose {p:[mm], q:[w,x,y,z]} / teachJoints {joints} — 도달 불가·자세 급변·간섭(정지 모드)은 거부 사유를 돌려줌
// 좌표: RobotView.world 그룹은 mm 단위 (scale 0.001), 로봇 베이스 = 월드 원점
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { jointFrames } from '/shared/kinematics.js';
import { HELPER_LAYER } from './cameraView.js';

const AXIS_COL = [null, 2, 1, 1, 2, 1, 2];   // 링크 i 프레임에서 관절 i 회전축 = R 의 열 (2 = Z, 1 = Y)
export const SNAPS = [
  { label: '스냅 끔', t: null, r: null },
  { label: '1 mm · 1°', t: 1, r: 1 },
  { label: '10 mm · 5°', t: 10, r: 5 },
];
const DEG = Math.PI / 180;
const col = (R, c) => [R[0][c], R[1][c], R[2][c]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mat4 = (f) => new THREE.Matrix4().set(
  f.R[0][0], f.R[0][1], f.R[0][2], f.p[0],
  f.R[1][0], f.R[1][1], f.R[1][2], f.p[1],
  f.R[2][0], f.R[2][1], f.R[2][2], f.p[2],
  0, 0, 0, 1);

export class DirectTeach {
  // send(name, args) → Promise<reply>, onStatus({ text, level: 'info'|'warn'|'err', joint? })
  constructor(view, { send, onStatus, onUndoChange }) {
    this.view = view;
    this.send = send;
    this.onStatus = onStatus || (() => {});
    this.onUndoChange = onUndoChange || (() => {});
    this.enabled = false;
    this.space = 'world';
    this.snap = 0;
    this.undo = [];
    this.st = null;
    this._inflight = false;
    this._pending = null;
    this._dragTcp = false;
    this._settleUntil = 0;

    const dom = view.renderer.domElement;
    this.dom = dom;

    // TCP 핸들
    this.handle = new THREE.Object3D();
    view.world.add(this.handle);
    this.tc = new TransformControls(view.camera, dom);
    this.tc.setSize(0.85);
    this.tc.attach(this.handle);
    this.tc.enabled = false;
    this.helper = this.tc.getHelper();
    this.helper.visible = false;
    this.helper.traverse((o) => o.layers.set(HELPER_LAYER));   // 비전 카메라 영상에는 그리지 않음
    this.tc.getRaycaster().layers.enableAll();
    view.scene.add(this.helper);
    this.tc.addEventListener('dragging-changed', (e) => {
      view.controls.enabled = !e.value;
      this._dragTcp = e.value;
      view.markDirty?.(false);
      if (e.value) this.pushUndo();
      else this._settleUntil = performance.now() + 250;   // 마지막 응답 반영 후 핸들을 실제 TCP 로 되돌림
    });
    this.tc.addEventListener('change', () => { view.markDirty?.(false); });
    this.tc.addEventListener('objectChange', () => { if (this._dragTcp) this._queue({ kind: 'pose' }); });

    // 관절 회전 링
    this.ringGroup = new THREE.Group();
    this.ringGroup.matrixAutoUpdate = false;
    this.ringGroup.visible = false;
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0xffc040, transparent: true, opacity: 0.75, depthTest: false });
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.035, 10, 72), this.ringMat);
    this.ring.renderOrder = 10;
    this.ring.layers.set(HELPER_LAYER);
    this.ringGroup.add(this.ring);
    view.world.add(this.ringGroup);

    this.raycaster = new THREE.Raycaster();
    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onHover = this._onHover.bind(this);
    dom.addEventListener('pointerdown', this._onDown, true);   // 캡처: OrbitControls 보다 먼저 받아 링크 드래그를 가로챔
    dom.addEventListener('pointermove', this._onHover);
    dom.addEventListener('pointerleave', () => { if (!this.jd) this._showRing(0); });
  }

  // ------------------------------------------------------------ 설정
  setEnabled(on) {
    this.enabled = !!on;
    this.tc.enabled = this.enabled;
    this.helper.visible = this.enabled;
    if (!this.enabled) {
      if (this.jd) this._onUp();
      this._showRing(0);
      this.dom.style.cursor = '';
      this.view.controls.enabled = true;
    }
    if (this.st) this.update(this.st);
    this.view.markDirty?.(false);
  }
  setMode(m) { this.tc.setMode(m); this.view.markDirty?.(false); }                     // 'translate' | 'rotate'
  get mode() { return this.tc.mode; }
  setSpace(s) { this.space = s; this.tc.setSpace(s === 'tool' ? 'local' : 'world'); this.view.markDirty?.(false); }
  setSnap(i) {
    this.snap = i;
    const s = SNAPS[i];
    this.tc.setTranslationSnap(s.t);
    this.tc.setRotationSnap(s.r ? s.r * DEG : null);
  }

  pushUndo() {
    if (!this.st) return;
    const j = [...this.st.joints];
    const last = this.undo[this.undo.length - 1];
    if (last && last.every((v, i) => Math.abs(v - j[i]) < 1e-6)) return;
    this.undo.push(j);
    if (this.undo.length > 50) this.undo.shift();
    this.onUndoChange(this.undo.length);
  }
  async undoLast() {
    const j = this.undo.pop();
    this.onUndoChange(this.undo.length);
    if (!j) return;
    const r = await this.send('teachJoints', { joints: j });
    this.onStatus(r?.ok ? { text: '되돌림', level: 'info' } : { text: r?.reason || r?.error || '되돌리기 실패', level: 'err' });
  }

  // ------------------------------------------------------------ 상태 반영 (매 state)
  update(st) {
    this.st = st;
    if (!this.enabled) return;
    if (!this._dragTcp && performance.now() > this._settleUntil && !this._inflight) {
      const { p, q } = st.tcpWorld;
      this.handle.position.set(p[0], p[1], p[2]);
      this.handle.quaternion.set(q[1], q[2], q[3], q[0]);
    }
    if (this.ringGroup.visible && this._ringK) this._placeRing(this._ringK);
  }

  // ------------------------------------------------------------ 서버 전송 (한 번에 하나, 최신 값만)
  _queue(req) {
    this._pending = req;
    if (!this._inflight) this._flush();
  }
  async _flush() {
    const req = this._pending;
    this._pending = null;
    if (!req) return;
    this._inflight = true;
    let r;
    try {
      if (req.kind === 'pose') {
        const p = this.handle.position, q = this.handle.quaternion;
        r = await this.send('teachPose', { p: [p.x, p.y, p.z], q: [q.w, q.x, q.y, q.z] });
      } else r = await this.send('teachJoints', { joints: req.joints });
    } catch (e) { r = { ok: false, reason: e.message }; }
    this._inflight = false;
    if (r?.ok) this.onStatus(req.kind === 'joint' ? { text: `J${req.k} ${req.joints[req.k - 1].toFixed(1)}°`, level: 'info', joint: req.k } : { text: '', level: 'info' });
    else this.onStatus({ text: r?.reason || r?.error || '거부', level: r?.collision ? 'warn' : 'err' });
    if (this._pending) this._flush();
  }

  // ------------------------------------------------------------ 링크 픽킹 · 관절 드래그
  _pick(e) {
    const rect = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.view.camera);
    const links = this.view.links || [];
    const hits = this.raycaster.intersectObjects(links.slice(1), true);
    for (const h of hits) {
      let o = h.object;
      while (o && !links.includes(o)) o = o.parent;
      const k = links.indexOf(o);
      if (k >= 1 && k <= 6) return k;
    }
    return 0;
  }

  _frames(joints) { return jointFrames(this.view.model, joints); }
  _placeRing(k) {
    const F = this._frames(this.st.joints)[k];
    this.ringGroup.matrix.copy(mat4(F));
    this.ringGroup.matrixWorldNeedsUpdate = true;
    const r = Math.max(36, Math.min(250, this.view.model.reach * 0.072));
    this.ring.scale.setScalar(k <= 3 ? r * 1.75 : r * 1.15);
    this.ring.rotation.set(AXIS_COL[k] === 1 ? Math.PI / 2 : 0, 0, 0);   // 토러스 법선(Z)을 관절 축에
  }
  _showRing(k, dragging = false) {
    this._ringK = k;
    this.ringGroup.visible = !!k && this.enabled;
    if (k && this.st) this._placeRing(k);
    this.ringMat.color.setHex(dragging ? 0x40d0ff : 0xffc040);
    this.view.markDirty?.(false);
  }

  _gateOk() {
    const st = this.st;
    if (!st) return false;
    if (!st.servo) { this.onStatus({ text: '서보 OFF — 서보를 켜야 직접교시가 됩니다', level: 'err' }); return false; }
    if (st.program?.status === 'running') { this.onStatus({ text: '프로그램 실행 중에는 직접교시 불가', level: 'err' }); return false; }
    return true;
  }

  _onHover(e) {
    if (!this.enabled || this.jd || this._dragTcp || e.buttons) return;
    if (this.tc.axis) { this._showRing(0); this.dom.style.cursor = 'pointer'; return; }
    const k = this._pick(e);
    if (k !== this._ringK) this._showRing(k);
    this.dom.style.cursor = k ? 'grab' : '';
    if (k && this.st) this.onStatus({ text: `J${k} ${this.st.joints[k - 1].toFixed(1)}° — 끌어서 회전 (Shift: 미세)`, level: 'info', joint: k, hover: true });
  }

  _onDown(e) {
    if (!this.enabled || e.button !== 0 || this.tc.axis) return;
    const k = this._pick(e);
    if (!k) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (!this._gateOk()) return;
    const st = this.st, model = this.view.model;
    const F = this._frames(st.joints);
    const o = F[k].p, axis = col(F[k].R, AXIS_COL[k]);
    // 관절 + 방향과 축 + 회전(오른손) 방향의 관계: 작은 회전을 수치로 확인
    const jp = [...st.joints]; jp[k - 1] += 0.5;
    const F2 = this._frames(jp);
    const pt = (Fs) => { const f = Fs[6]; return [f.p[0] + f.R[0][0] * 100, f.p[1] + f.R[1][0] * 100, f.p[2] + f.R[2][0] * 100]; };
    const P0 = pt(F), P1 = pt(F2);
    const dirSign = dot(cross(axis, sub(P0, o)), sub(P1, P0)) >= 0 ? 1 : -1;
    const cam = this.view.camera.position.clone().multiplyScalar(1000);
    const toCam = [cam.x - o[0], cam.y - o[1], cam.z - o[2]];
    const len = Math.hypot(...toCam);
    const facing = dot(axis, toCam) / len;
    const rect = this.dom.getBoundingClientRect();
    const sc = new THREE.Vector3(o[0], o[1], o[2]).multiplyScalar(0.001).project(this.view.camera);
    const cx = rect.left + (sc.x + 1) / 2 * rect.width, cy = rect.top + (1 - sc.y) / 2 * rect.height;
    this.pushUndo();
    this.jd = {
      k, value: st.joints[k - 1], joints: [...st.joints], lim: model.limits[k - 1],
      dirSign, facing, cx, cy, lastA: Math.atan2(-(e.clientY - cy), e.clientX - cx), lastX: e.clientX, pid: e.pointerId,
    };
    this.view.controls.enabled = false;
    this.dom.style.cursor = 'grabbing';
    this._showRing(k, true);
    try { this.dom.setPointerCapture(e.pointerId); } catch {}
    window.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onUp);
  }

  _onMove(e) {
    const d = this.jd;
    if (!d) return;
    const fine = e.shiftKey ? 0.2 : 1;
    let delta;
    const dist = Math.hypot(e.clientX - d.cx, e.clientY - d.cy);
    if (Math.abs(d.facing) > 0.3 && dist > 25) {
      // 화면에서 관절 중심을 도는 각도 = 관절 회전 (축이 카메라를 향하면 반시계 = +)
      const a = Math.atan2(-(e.clientY - d.cy), e.clientX - d.cx);
      let da = a - d.lastA;
      if (da > Math.PI) da -= 2 * Math.PI;
      if (da < -Math.PI) da += 2 * Math.PI;
      d.lastA = a;
      delta = (da / DEG) * Math.sign(d.facing) * d.dirSign;
    } else {
      // 축이 화면과 거의 평행하거나 중심에 너무 가까우면 좌우 이동량으로
      delta = (e.clientX - d.lastX) * 0.4;
      d.lastA = Math.atan2(-(e.clientY - d.cy), e.clientX - d.cx);
    }
    d.lastX = e.clientX;
    d.value = Math.max(d.lim[0], Math.min(d.lim[1], d.value + delta * fine));
    const step = SNAPS[this.snap].r;
    const v = step ? Math.round(d.value / step) * step : d.value;
    const joints = [...(this.st?.joints ?? d.joints)];
    joints[d.k - 1] = v;
    this._queue({ kind: 'joint', k: d.k, joints });
  }

  _onUp() {
    if (!this.jd) return;
    try { this.dom.releasePointerCapture(this.jd.pid); } catch {}
    this.jd = null;
    this.view.controls.enabled = true;
    this.dom.style.cursor = '';
    this._showRing(0);
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('pointercancel', this._onUp);
  }
}
