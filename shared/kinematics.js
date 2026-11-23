// OPW(Ortho-Parallel + spherical Wrist) 해석적 기구학
// 참고: Brandstötter et al., "An Analytical Solution of the Inverse Kinematics Problem
//        of Industrial Serial Manipulators with an Ortho-parallel Basis and a Spherical Wrist" (2014)
// 대부분의 6축 수직다관절 산업용 로봇(야스카와/카와사키/현대/ABB/KUKA)이 이 구조를 따른다.
//
// 파라미터(mm): a1, a2, b, c1, c2, c3, c4
// 제조사 관절각(deg) q_ctrl → OPW 내부각(rad) q = q_ctrl*sign - offset
// 플랜지 좌표계: Z축이 플랜지 면에서 바깥 방향

// Universal Robots 처럼 손목 축이 한 점에서 만나지 않는 협동로봇은 model.kin === 'ur' (표준 DH, model.dh) — 아래 UR 절 참고
import { DEG, RAD, mul3, mulv, add, sub, scale, wrapPi, T3, poseMul, poseInv, rotAngle, norm } from './math.js';

const isUR = (model) => model.kin === 'ur';

export function toOpw(model, jdeg) {
  return jdeg.map((v, i) => v * DEG * model.signs[i] - model.offsets[i] * DEG);
}
export function fromOpw(model, q) {
  return q.map((v, i) => ((v + model.offsets[i] * DEG) / model.signs[i]) * RAD);
}

// 순기구학: 제조사 관절각(deg) → 플랜지 pose (로봇 베이스 기준)
export function fkFlange(model, jdeg) {
  if (isUR(model)) return urChain(model, jdeg)[6];
  const k = model.opw;
  const q = toOpw(model, jdeg);
  const psi3 = Math.atan2(k.a2, k.c3);
  const kk = Math.hypot(k.a2, k.c3);
  const cx1 = k.c2 * Math.sin(q[1]) + kk * Math.sin(q[1] + q[2] + psi3) + k.a1;
  const cy1 = k.b;
  const cz1 = k.c2 * Math.cos(q[1]) + kk * Math.cos(q[1] + q[2] + psi3);
  const cx0 = cx1 * Math.cos(q[0]) - cy1 * Math.sin(q[0]);
  const cy0 = cx1 * Math.sin(q[0]) + cy1 * Math.cos(q[0]);
  const cz0 = cz1 + k.c1;
  const [s1, s2, s3, s4, s5, s6] = q.map(Math.sin);
  const [c1, c2, c3, c4, c5, c6] = q.map(Math.cos);
  const R0c = [
    [c1 * c2 * c3 - c1 * s2 * s3, -s1, c1 * c2 * s3 + c1 * s2 * c3],
    [s1 * c2 * c3 - s1 * s2 * s3, c1, s1 * c2 * s3 + s1 * s2 * c3],
    [-s2 * c3 - c2 * s3, 0, -s2 * s3 + c2 * c3],
  ];
  const Rce = [
    [c4 * c5 * c6 - s4 * s6, -c4 * c5 * s6 - s4 * c6, c4 * s5],
    [s4 * c5 * c6 + c4 * s6, -s4 * c5 * s6 + c4 * c6, s4 * s5],
    [-s5 * c6, s5 * s6, c5],
  ];
  const R = mul3(R0c, Rce);
  const p = add([cx0, cy0, cz0], scale([R[0][2], R[1][2], R[2][2]], k.c4));
  return { p, R };
}

// 시각화용 관절 원점 위치 (베이스 기준, mm) - 링크 그리기에 사용
export function jointFrames(model, jdeg) {
  if (isUR(model)) return urFrames(model, jdeg);
  // 각 관절의 4x4 누적 변환을 OPW 구조에 맞춰 단계적으로 계산
  const k = model.opw;
  const q = toOpw(model, jdeg);
  const frames = [];
  const T = (R, p) => ({ R, p });
  const rz = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; };
  const ry = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; };
  const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let F = T(I, [0, 0, 0]);
  frames.push(F); // 0: base
  F = poseMul(F, T(rz(q[0]), [0, 0, 0]));
  frames.push(F); // 1: J1 회전 후 (원점 바닥)
  F = poseMul(F, T(ry(q[1]), [k.a1, k.b, k.c1]));
  frames.push(F); // 2: J2 축
  F = poseMul(F, T(ry(q[2]), [0, 0, k.c2]));
  frames.push(F); // 3: J3 축
  // J4: 전완 축(Z 방향) - J3에서 x 방향 a2 만큼 (OPW에서 a2 는 위/아래 오프셋, 전완 방향은 +z)
  F = poseMul(F, T(rz(q[3]), [k.a2, 0, 0]));
  frames.push(F); // 4: J4 시작점 (J3 축에서 오프셋)
  F = poseMul(F, T(ry(q[4]), [0, 0, k.c3]));
  frames.push(F); // 5: 손목 중심
  F = poseMul(F, T(rz(q[5]), [0, 0, k.c4]));
  frames.push(F); // 6: 플랜지
  return frames;
}

// 역기구학: 플랜지 pose → 최대 8개 해 (제조사 관절각 deg 배열). 관절 한계 밖 해는 제외 옵션
// ref(제조사 관절각, 선택): 손목 특이점(J5≈0)에서 J4 를 기준값으로 유지하는 해도 함께 낸다 (OPW 계열)
export function ikFlangeAll(model, target, ref) {
  if (isUR(model)) return urIkAll(model, target, ref).map((q) => fromOpw(model, q.map(wrapPi)).map((v) => wrapDeg(v)));
  const t4ref = ref ? toOpw(model, ref)[3] : null;
  const k = model.opw;
  const R = target.R;
  const ez = [R[0][2], R[1][2], R[2][2]];
  const c = sub(target.p, scale(ez, k.c4));
  const [cx, cy, cz] = c;
  const sols = [];

  const nx1 = Math.sqrt(Math.max(0, cx * cx + cy * cy - k.b * k.b)) - k.a1;
  const tmp1 = Math.atan2(cy, cx);
  const tmp2 = Math.atan2(k.b, nx1 + k.a1);
  const th1i = tmp1 - tmp2;
  const th1ii = tmp1 + tmp2 - Math.PI;

  const tmp3 = cz - k.c1;
  const s1_2 = nx1 * nx1 + tmp3 * tmp3;
  const tmp4 = nx1 + 2 * k.a1;
  const s2_2 = tmp4 * tmp4 + tmp3 * tmp3;
  const kappa_2 = k.a2 * k.a2 + k.c3 * k.c3;
  const c2_2 = k.c2 * k.c2;
  const s1 = Math.sqrt(s1_2), s2 = Math.sqrt(s2_2);

  const acosSafe = (x) => (x < -1 - 1e-9 || x > 1 + 1e-9 ? NaN : Math.acos(Math.max(-1, Math.min(1, x))));
  const tmp13 = acosSafe((s1_2 + c2_2 - kappa_2) / (2 * s1 * k.c2));
  const tmp14 = Math.atan2(nx1, tmp3);
  const th2i = -tmp13 + tmp14;
  const th2ii = tmp13 + tmp14;
  const tmp15 = acosSafe((s2_2 + c2_2 - kappa_2) / (2 * s2 * k.c2));
  const tmp16 = Math.atan2(nx1 + 2 * k.a1, tmp3);
  const th2iii = -tmp15 - tmp16;
  const th2iv = tmp15 - tmp16;

  const tmp9 = 2 * k.c2 * Math.sqrt(kappa_2);
  const psi = Math.atan2(k.a2, k.c3);
  const a7 = acosSafe((s1_2 - c2_2 - kappa_2) / tmp9);
  const a8 = acosSafe((s2_2 - c2_2 - kappa_2) / tmp9);
  const arms = [
    [th1i, th2i, a7 - psi],
    [th1i, th2ii, -a7 - psi],
    [th1ii, th2iii, a8 - psi],
    [th1ii, th2iv, -a8 - psi],
  ];

  for (const [t1, t2, t3] of arms) {
    if (![t1, t2, t3].every(Number.isFinite)) continue;
    const s23 = Math.sin(t2 + t3), c23 = Math.cos(t2 + t3);
    const sn1 = Math.sin(t1), cs1 = Math.cos(t1);
    const m = R[0][2] * s23 * cs1 + R[1][2] * s23 * sn1 + R[2][2] * c23;
    const t5 = Math.atan2(Math.sqrt(Math.max(0, 1 - m * m)), m);
    let t4, t6;
    if (Math.abs(Math.sin(t5)) < 1e-6) {
      // 손목 특이점: J4·J6 의 합(또는 차)만 정해짐 → t4 = 0 으로 두고 t6 에 회전 몰기
      t4 = 0;
      const Rc = r0c(t1, t2, t3);
      const Rce = mul3(T3(Rc), R);
      t6 = Math.atan2(Rce[1][0], Rce[0][0]);
      if (m < 0) t6 = Math.atan2(Rce[1][0], -Rce[0][0]);
      // 기준 J4 를 유지하는 해 (조그·직선 이동이 특이점에서 J4 를 0 으로 튀게 하지 않도록).
      //  부호 규약에 따라 t6 = φ − t4 또는 φ + t4 — 둘 다 내고 ikFlangeValid 의 FK 검증이 맞는 쪽만 남긴다
      if (t4ref !== null && Number.isFinite(t4ref)) {
        sols.push([t1, t2, t3, t4ref, t5, t6 - t4ref]);
        sols.push([t1, t2, t3, t4ref, t5, t6 + t4ref]);
      }
    } else {
      t4 = Math.atan2(R[1][2] * cs1 - R[0][2] * sn1, R[0][2] * c23 * cs1 + R[1][2] * c23 * sn1 - R[2][2] * s23);
      t6 = Math.atan2(
        R[0][1] * s23 * cs1 + R[1][1] * s23 * sn1 + R[2][1] * c23,
        -R[0][0] * s23 * cs1 - R[1][0] * s23 * sn1 - R[2][0] * c23,
      );
    }
    sols.push([t1, t2, t3, t4, t5, t6]);
    sols.push([t1, t2, t3, t4 + Math.PI, -t5, t6 - Math.PI]);
  }
  // 내부각 → 제조사각, 정규화
  return sols.map((q) => fromOpw(model, q.map(wrapPi)).map((v) => wrapDeg(v)));
}

function r0c(t1, t2, t3) {
  const s1 = Math.sin(t1), c1 = Math.cos(t1), s2 = Math.sin(t2), c2 = Math.cos(t2), s3 = Math.sin(t3), c3 = Math.cos(t3);
  return [
    [c1 * c2 * c3 - c1 * s2 * s3, -s1, c1 * c2 * s3 + c1 * s2 * c3],
    [s1 * c2 * c3 - s1 * s2 * s3, c1, s1 * c2 * s3 + s1 * s2 * c3],
    [-s2 * c3 - c2 * s3, 0, -s2 * s3 + c2 * c3],
  ];
}

const wrapDeg = (v) => { v = ((v + 180) % 360 + 360) % 360 - 180; return v; };

// 관절 한계 내에서 360° 배수 변형까지 고려해 기준 관절각에 가장 가까운 해로 맞춤
function adjustToLimits(model, j, ref) {
  const out = [];
  for (let i = 0; i < 6; i++) {
    const [lo, hi] = model.limits[i];
    let best = null;
    for (const k of [-2, -1, 0, 1, 2]) {
      const v = j[i] + 360 * k;
      if (v < lo - 1e-6 || v > hi + 1e-6) continue;
      if (best === null || Math.abs(v - ref[i]) < Math.abs(best - ref[i])) best = v;
    }
    if (best === null) return null;
    out.push(best);
  }
  return out;
}

export function withinLimits(model, j) {
  return j.every((v, i) => v >= model.limits[i][0] - 1e-6 && v <= model.limits[i][1] + 1e-6);
}

// 한계 내 모든 해 (기준각 ref 근처로 정렬)
export function ikFlangeValid(model, target, ref) {
  const raw = ikFlangeAll(model, target, ref);
  const res = [];
  for (const s of raw) {
    const a = adjustToLimits(model, s, ref || model.home);
    if (!a) continue;
    // 수치 검증
    const f = fkFlange(model, a);
    if (norm(sub(f.p, target.p)) > 0.05 || rotAngle(f.R, target.R) > 1e-3) continue;
    res.push(a);
  }
  return res;
}

// 관절 거리 (가중치: 손목은 덜 중요)
export function jointDist(a, b) {
  const w = [1.5, 1.5, 1.2, 0.6, 0.6, 0.4];
  let s = 0;
  for (let i = 0; i < 6; i++) s += w[i] * Math.abs(a[i] - b[i]);
  return s;
}

// 기준 관절각에 가장 가까운 해. cfgFilter(sol)→ 페널티(0이면 일치) 제공 시 형태 우선
export function ikNearest(model, target, ref, cfgFilter) {
  const sols = ikFlangeValid(model, target, ref);
  if (!sols.length) return null;
  let best = null, bestCost = Infinity;
  for (const s of sols) {
    const cost = jointDist(s, ref) + (cfgFilter ? cfgFilter(s) * 10000 : 0);
    if (cost < bestCost) { bestCost = cost; best = s; }
  }
  return best;
}

// TCP = 베이스프레임 * 플랜지 * 툴
export function fkTcp(model, jdeg, tool, base) {
  let F = fkFlange(model, jdeg);
  if (tool) F = poseMul(F, tool);
  if (base) F = poseMul(poseInv(base), F); // 사용자 좌표계 기준 표현
  return F;
}
export function tcpToFlange(tcp, tool, base) {
  let F = tcp;
  if (base) F = poseMul(base, F);
  if (tool) F = poseMul(F, poseInv(tool));
  return F;
}

// 손목 중심 위치 (특이점/형태 판별용)
export function wristCenter(model, jdeg) {
  if (isUR(model)) return urChain(model, jdeg)[5].p;
  const f = fkFlange(model, jdeg);
  return sub(f.p, scale([f.R[0][2], f.R[1][2], f.R[2][2]], model.opw.c4));
}

// ------------------------------------------------------------------ UR (표준 DH, 비구형 손목)
// 참고: K. P. Hawkins, "Analytic Inverse Kinematics for the Universal Robots UR-5/UR-10 Arms" (2013)
// DH (mm): d1, a2, a3, d4, d5, d6 — alpha = [π/2, 0, 0, π/2, -π/2, 0], 나머지 a·d 는 0.
// UR 공식 DH 표와 같은 값이며 베이스·플랜지 프레임은 PolyScope 의 Base·Tool flange 와 같다 (관절 0 = 팔 수평 펼침).
const UR_ALPHA = [Math.PI / 2, 0, 0, Math.PI / 2, -Math.PI / 2, 0];
const urD = (k) => [k.d1, 0, 0, k.d4, k.d5, k.d6];
const urA = (k) => [0, k.a2, k.a3, 0, 0, 0];
// 표준 DH 변환 Rz(θ)·Tz(d)·Tx(a)·Rx(α)
function dhT(th, d, a, al) {
  const ct = Math.cos(th), st = Math.sin(th), ca = Math.cos(al), sa = Math.sin(al);
  return { R: [[ct, -st * ca, st * sa], [st, ct * ca, -ct * sa], [0, sa, ca]], p: [a * ct, a * st, d] };
}
// DH 프레임 D0(베이스)..D6(플랜지)
function urChain(model, jdeg) {
  const k = model.dh, q = toOpw(model, jdeg), d = urD(k), a = urA(k);
  const out = [{ R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], p: [0, 0, 0] }];
  for (let i = 0; i < 6; i++) out.push(poseMul(out[i], dhT(q[i], d[i], a[i], UR_ALPHA[i])));
  return out;
}
// 화면·직접교시·캡슐용 관절 프레임: OPW 와 같은 규약 (관절 1·4·6 축 = 로컬 Z, 2·3·5 축 = 로컬 Y)
//  F_k 원점 = 관절 k 축 위의 DH 원점, 자세 = 링크 k 몸체 (D_{k-1}·Rz(θk), Y 축 관절은 Rx(π/2) 로 돌려 축을 Y 에)
//  F6 = 플랜지 (DH D6)
const RX90 = [[1, 0, 0], [0, 0, -1], [0, 1, 0]];
const rzM = (t) => { const c = Math.cos(t), s = Math.sin(t); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; };
function urFrames(model, jdeg) {
  const D = urChain(model, jdeg), q = toOpw(model, jdeg);
  const F = [D[0]];
  for (let k = 1; k <= 5; k++) {
    let R = mul3(D[k - 1].R, rzM(q[k - 1]));
    if (k === 2 || k === 3 || k === 5) R = mul3(R, RX90);
    F.push({ R, p: [...D[k - 1].p] });
  }
  F.push(D[6]);
  return F;
}
// 역기구학: 최대 8개 해 (내부각 rad)
function urIkAll(model, target, ref) {
  const k = model.dh, R = target.R, p6 = target.p;
  const { d1, a2, a3, d4, d5, d6 } = k;
  const t6ref = ref ? toOpw(model, ref)[5] : 0;
  const p5 = [p6[0] - d6 * R[0][2], p6[1] - d6 * R[1][2], p6[2] - d6 * R[2][2]];
  const r = Math.hypot(p5[0], p5[1]);
  if (r < Math.abs(d4) - 1e-9) return [];
  const psi = Math.atan2(p5[1], p5[0]), phi = Math.acos(Math.max(-1, Math.min(1, d4 / r)));
  const sols = [];
  const T06 = { R, p: p6 };
  for (const t1 of [psi + phi + Math.PI / 2, psi - phi + Math.PI / 2]) {
    const s1 = Math.sin(t1), c1 = Math.cos(t1);
    const c5 = (p6[0] * s1 - p6[1] * c1 - d4) / d6;
    if (Math.abs(c5) > 1 + 1e-9) continue;
    const a5 = Math.acos(Math.max(-1, Math.min(1, c5)));
    for (const t5 of [a5, -a5]) {
      const s5 = Math.sin(t5);
      const t6 = Math.abs(s5) < 1e-6
        ? (Number.isFinite(t6ref) ? t6ref : 0)
        : Math.atan2((-R[0][1] * s1 + R[1][1] * c1) / s5, (R[0][0] * s1 - R[1][0] * c1) / s5);
      const T01 = dhT(t1, d1, 0, UR_ALPHA[0]);
      const T46 = poseMul(dhT(t5, d5, 0, UR_ALPHA[4]), dhT(t6, d6, 0, UR_ALPHA[5]));
      const T14 = poseMul(poseMul(poseInv(T01), T06), poseInv(T46));
      const px = T14.p[0], py = T14.p[1];
      const c3 = (px * px + py * py - a2 * a2 - a3 * a3) / (2 * a2 * a3);
      if (Math.abs(c3) > 1 + 1e-9) continue;
      const a3c = Math.acos(Math.max(-1, Math.min(1, c3)));
      for (const t3 of [a3c, -a3c]) {
        const t2 = Math.atan2(py, px) - Math.atan2(a3 * Math.sin(t3), a2 + a3 * Math.cos(t3));
        const t4 = Math.atan2(T14.R[1][0], T14.R[0][0]) - t2 - t3;
        sols.push([t1, t2, t3, t4, t5, t6]);
      }
    }
  }
  return sols;
}
export const urFramesForTest = urChain;
