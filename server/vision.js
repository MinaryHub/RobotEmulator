// 가상 비전 센서 엔진 (DO 트리거 → 프러스텀 내 공작물 검출 → 노이즈 반영 → 레지스터/DI 반환)
//  - shared/cameras.js 의 카메라 장착/좌표계 규약을 그대로 따름 (+Z 광축, +X 오른쪽, +Y 아래)
//  - DO 상승 에지(OFF → ON) 또는 UI/API 수동 트리거로 동작
//  - 결과 기록:
//      · Modbus/공유 int16 레지스터: MB:<base+0> found(1/0), MB:<base+1..4> X,Y,Z,Rz (×10 스케일 = 0.1 mm / 0.1°)
//      · 로봇 프로그램 레지스터: B:<base> found, R:<base+0..3> X,Y,Z,Rz, P:<base> pose [X,Y,Z,180,0,Rz]
//      · 편의 전역 키: VISION_FOUND, VISION_X, VISION_Y, VISION_Z, VISION_RZ
//      · 디지털 입력: foundDI (검출 여부), doneDI (처리 완료)
import { getCamera, normalizeVision } from '../shared/cameras.js';
import { jointFrames } from '../shared/kinematics.js';
import { frameFromXYZRPY } from '../shared/poseformat.js';
import { poseMul, poseInv, mulv, sub, DEG } from '../shared/math.js';

const toI16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));
const randSym = (amp) => (amp > 0 ? (Math.random() * 2 - 1) * amp : 0);

// 카메라 월드 자세 계산 (public/js/cameraView.js 와 동일한 장착 규약)
export function cameraWorldPose(ctrl, cam) {
  const local = frameFromXYZRPY([...cam.pos, ...cam.rot]);
  if (cam.mount === 'world') return local;
  const F = jointFrames(ctrl.robot, ctrl.joints);
  const parent = cam.mount === 'forearm' ? F[3] : F[6];
  return poseMul(parent, local);
}

// 카메라 시야(프러스텀) 내 가장 가까운 공작물 검출 (로봇이 쥔 공작물 제외)
export function detectInFrustum(ctrl, cam) {
  const def = getCamera(cam.type);
  if (!def) return { found: false, count: 0 };
  const camW = cameraWorldPose(ctrl, cam);
  const invCam = poseInv(camW);
  const [rmin, rmax] = def.range || [50, 5000];
  const halfH = Math.tan((def.hfov * DEG) / 2);
  const halfV = halfH * (def.res[1] / def.res[0]);
  const heldId = ctrl.grip?.holding?.id ?? null;

  let best = null;
  let count = 0;
  for (const o of ctrl.objects || []) {
    if (!o || o.id === heldId) continue;
    const pCam = mulv(invCam.R, sub(o.pose.p, camW.p));
    const z = pCam[2];
    if (z < rmin || z > rmax) continue;
    if (Math.abs(pCam[0]) > z * halfH || Math.abs(pCam[1]) > z * halfV) continue;
    count++;
    if (!best || z < best.z) best = { obj: o, z };
  }
  if (!best) return { found: false, count: 0 };
  return { found: true, count, obj: best.obj, distMm: best.z };
}

export class VisionEngine {
  constructor(ctrl) {
    this.ctrl = ctrl;
    this.results = {};      // camId → 마지막 검출 결과
    this._prevDO = new Map();
    ctrl.on('io', ({ type, n, v }) => {
      if (type !== 'do') return;
      const prev = !!this._prevDO.get(n);
      this._prevDO.set(n, !!v);
      if (!v || prev) return; // 상승 에지만 반응
      for (const cam of ctrl.cameras || []) {
        if (cam.vision?.enabled && cam.vision.triggerDO === n) {
          this.trigger(cam.id);
        }
      }
    });
  }

  trigger(camId, { deterministic = false } = {}) {
    const c = this.ctrl;
    const cam = (c.cameras || []).find((x) => x.id === camId);
    if (!cam) return { ok: false, reason: `카메라를 찾을 수 없습니다: ${camId}` };
    const vis = normalizeVision(cam.vision || {});
    const det = detectInFrustum(c, cam);
    if (vis.doneDI > 0) c.setDI(vis.doneDI, false);

    const finalize = () => {
      let pose = [0, 0, 0, 0];
      let objectId = null;
      if (det.found && det.obj) {
        objectId = det.obj.id;
        let objPose = det.obj.pose;
        if (vis.frame === 'user' && c.effectiveBase) {
          objPose = poseMul(poseInv(c.effectiveBase), objPose);
        }
        const yawDeg = Math.atan2(objPose.R[1][0], objPose.R[0][0]) / DEG;
        const nx = deterministic ? 0 : randSym(vis.noiseMm);
        const ny = deterministic ? 0 : randSym(vis.noiseMm);
        const nz = deterministic ? 0 : randSym(vis.noiseMm);
        const nr = deterministic ? 0 : randSym(vis.noiseDeg);
        pose = [
          +(objPose.p[0] + nx).toFixed(2),
          +(objPose.p[1] + ny).toFixed(2),
          +(objPose.p[2] + nz).toFixed(2),
          +(yawDeg + nr).toFixed(2),
        ];
      }
      const res = {
        camId: cam.id,
        camName: cam.name,
        found: !!det.found,
        count: det.count || 0,
        objectId,
        pose,
        frame: vis.frame,
        regBase: vis.regBase,
        at: Date.now(),
      };
      this.results[cam.id] = res;
      // 레지스터 기록 (Modbus MB:n, Yaskawa B/R/P, 공통 VISION_*)
      const b = vis.regBase;
      c.regs.set(`MB:${b}`, res.found ? 1 : 0);
      c.regs.set(`MB:${b + 1}`, toI16(pose[0] * 10));
      c.regs.set(`MB:${b + 2}`, toI16(pose[1] * 10));
      c.regs.set(`MB:${b + 3}`, toI16(pose[2] * 10));
      c.regs.set(`MB:${b + 4}`, toI16(pose[3] * 10));
      c.regs.set(`B:${b}`, res.found ? 1 : 0);
      c.regs.set(`R:${b}`, pose[0]);
      c.regs.set(`R:${b + 1}`, pose[1]);
      c.regs.set(`R:${b + 2}`, pose[2]);
      c.regs.set(`R:${b + 3}`, pose[3]);
      c.regs.set(`P:${b}`, { kind: 'pose', v: [pose[0], pose[1], pose[2], 180, 0, pose[3]] });
      c.regs.set('VISION_FOUND', res.found ? 1 : 0);
      c.regs.set('VISION_X', pose[0]);
      c.regs.set('VISION_Y', pose[1]);
      c.regs.set('VISION_Z', pose[2]);
      c.regs.set('VISION_RZ', pose[3]);
      if (vis.foundDI > 0) c.setDI(vis.foundDI, res.found);
      if (vis.doneDI > 0) c.setDI(vis.doneDI, true);
      c._bumpRev?.('vision');
      c.log('system', res.found
        ? `비전 검출 (${cam.name}): ${objectId} [${pose[0]}, ${pose[1]}, ${pose[2]} mm, Rz ${pose[3]}°] → MB:${b}..${b + 4}`
        : `비전 검출 (${cam.name}): 시야 내 공작물 없음`);
      c.emitState();
      return res;
    };

    if (vis.latencyMs > 0 && !deterministic) {
      c.after(vis.latencyMs / 1000, finalize);
      return { ok: true, pending: true, latencyMs: vis.latencyMs };
    }
    const result = finalize();
    return { ok: true, pending: false, result };
  }
}
