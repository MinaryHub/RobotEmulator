// 궤적 생성기: 관절보간(PTP/MOVJ), 직선보간(LIN/MOVL), 원호보간(CIRC/MOVC)
// - 사다리꼴 속도 프로파일 (가감속 시간 = 모델 maxAccelTime)
// - 직선/원호 보간 시 경로 위 IK 를 미리 계산해 관절 속도 한계를 넘지 않도록 시간을 늘림 (실機와 동일하게 특이점 부근 감속)
import { ikNearest, fkTcp, tcpToFlange, withinLimits } from '../shared/kinematics.js';
import { quatFromR, RfromQuat, quatSlerp, rotAngle, lerp3, sub, norm, cross, dot, scale, add, RAD, mulv } from '../shared/math.js';

export class MotionError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

// 정규화 거리 1 을 cruise 시간 Tc(=1/v) 와 가속시간 ta 로 이동하는 사다리꼴 프로파일
function trapezoid(Tc, ta) {
  if (Tc <= 1e-9) return { T: 0, tAcc: 0, s: () => 1 };
  ta = Math.max(0.02, ta);
  let T, v, a, tAcc;
  if (Tc >= ta) {
    // 사다리꼴: 거리 = v*(T - ta)  → T = Tc + ta
    v = 1 / Tc; T = Tc + ta; tAcc = ta; a = v / ta;
  } else {
    // 삼각형: 최고속 미도달
    a = (1 / Tc) / ta; tAcc = Math.sqrt(1 / a); T = 2 * tAcc; v = a * tAcc;
  }
  const s = (t) => {
    if (t <= 0) return 0;
    if (t >= T) return 1;
    if (t < tAcc) return 0.5 * a * t * t;
    if (t > T - tAcc) { const r = T - t; return 1 - 0.5 * a * r * r; }
    return 0.5 * a * tAcc * tAcc + v * (t - tAcc);
  };
  return { T, s, tAcc };
}

// 관절보간. speedFrac: 0~1 (최대 관절속도 대비)
export function planJoint(model, j0, j1, speedFrac) {
  if (!withinLimits(model, j1)) throw new MotionError('LIMIT', `관절 한계 초과: [${j1.map((v) => v.toFixed(2)).join(', ')}]`);
  const f = Math.max(0.001, Math.min(1, speedFrac));
  let Tc = 0;
  for (let i = 0; i < 6; i++) Tc = Math.max(Tc, Math.abs(j1[i] - j0[i]) / (model.maxSpeed[i] * f));
  const prof = trapezoid(Tc, model.maxAccelTime);
  return {
    kind: 'J', duration: prof.T, end: [...j1], prof,
    sample: (t) => { const s = prof.s(t); return j0.map((v, i) => v + (j1[i] - v) * s); },
  };
}

// 경로 함수 path(s) → TCP pose (s: 0~1). length(mm), angle(deg)
function planPath(model, j0, path, length, angleDeg, speed, tool, base, kind) {
  const vLin = Math.max(0.1, Math.min(speed.tcp ?? 250, model.tcpMaxSpeed));
  const vRot = Math.max(1, speed.rot ?? 180);
  const N = Math.max(20, Math.min(4000, Math.ceil(length / 1 + angleDeg / 0.5)));
  const table = new Array(N + 1);
  let prev = j0;
  table[0] = [...j0];
  for (let k = 1; k <= N; k++) {
    const tcp = path(k / N);
    const fl = tcpToFlange(tcp, tool, base);
    const j = ikNearest(model, fl, prev);
    if (!j) throw new MotionError('UNREACHABLE', `경로상 ${(100 * k / N).toFixed(0)}% 지점이 작업영역 밖이거나 관절 한계를 넘습니다.`);
    // 형태 변화(손목 플립 등) 감지
    for (let i = 0; i < 6; i++) {
      if (Math.abs(j[i] - prev[i]) > 25) throw new MotionError('SINGULARITY', `특이점/형태 변경 감지 (축${i + 1}, ${(100 * k / N).toFixed(0)}% 지점). 직선보간으로 통과할 수 없습니다.`);
    }
    table[k] = j; prev = j;
  }
  // 관절 속도 제한으로 인한 최소 시간
  let Tc = Math.max(length / vLin, angleDeg / vRot);
  for (let k = 1; k <= N; k++) {
    for (let i = 0; i < 6; i++) {
      const dq = Math.abs(table[k][i] - table[k - 1][i]) * N; // deg per unit s
      Tc = Math.max(Tc, dq / model.maxSpeed[i]);
    }
  }
  const prof = trapezoid(Tc, model.maxAccelTime);
  return {
    kind, duration: prof.T, end: [...table[N]], prof, length,
    sample: (t) => {
      const x = prof.s(t) * N;
      const k = Math.min(N - 1, Math.floor(x));
      const u = x - k;
      const a = table[k], b = table[k + 1];
      return a.map((v, i) => v + (b[i] - v) * u);
    },
  };
}

// 직선보간. target: TCP pose (base 좌표계 기준)
export function planLinear(model, j0, target, speed, tool, base) {
  const start = fkTcp(model, j0, tool, base);
  const q0 = quatFromR(start.R), q1 = quatFromR(target.R);
  const length = norm(sub(target.p, start.p));
  const angle = rotAngle(start.R, target.R) * RAD;
  const path = (s) => ({ p: lerp3(start.p, target.p, s), R: RfromQuat(quatSlerp(q0, q1, s)) });
  return planPath(model, j0, path, length, angle, speed, tool, base, 'L');
}

// 원호보간: 시작점 → 경유점(via) → 끝점
export function planCircular(model, j0, via, target, speed, tool, base) {
  const start = fkTcp(model, j0, tool, base);
  const A = start.p, B = via.p, C = target.p;
  const ab = sub(B, A), ac = sub(C, A);
  const n = cross(ab, ac);
  const nn = norm(n);
  if (nn < 1e-6) return planLinear(model, j0, target, speed, tool, base); // 일직선
  // 외접원 중심
  const ab2 = dot(ab, ab), ac2 = dot(ac, ac);
  const center = add(A, scale(add(scale(cross(n, ab), ac2), scale(cross(ac, n), ab2)), 1 / (2 * nn * nn)));
  const r = norm(sub(A, center));
  const nz = scale(n, 1 / nn);
  const ex = scale(sub(A, center), 1 / r);
  const ey = cross(nz, ex);
  const ang = (P) => { const d = sub(P, center); let a = Math.atan2(dot(d, ey), dot(d, ex)); if (a < 0) a += 2 * Math.PI; return a; };
  const thetaC = ang(C);
  const q0 = quatFromR(start.R), q1 = quatFromR(target.R);
  const path = (s) => {
    const th = thetaC * s;
    return { p: add(center, add(scale(ex, r * Math.cos(th)), scale(ey, r * Math.sin(th)))), R: RfromQuat(quatSlerp(q0, q1, s)) };
  };
  return planPath(model, j0, path, r * thetaC, rotAngle(start.R, target.R) * RAD, speed, tool, base, 'C');
}

