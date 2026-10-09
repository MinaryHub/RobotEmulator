// 공용 수학 유틸리티 (브라우저/Node 공용, 의존성 없음)
// 단위: 위치 mm, 각도 API는 deg, 내부 행렬 연산은 rad

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const wrapPi = (a) => {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
};

// ---- 3x3 회전 행렬 (row-major 배열의 배열) ----
export const I3 = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
export const Rx = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[1, 0, 0], [0, c, -s], [0, s, c]]; };
export const Ry = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; };
export const Rz = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; };

export function mul3(A, B) {
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
  return C;
}
export const T3 = (A) => [[A[0][0], A[1][0], A[2][0]], [A[0][1], A[1][1], A[2][1]], [A[0][2], A[1][2], A[2][2]]];
export const mulv = (A, v) => [
  A[0][0] * v[0] + A[0][1] * v[1] + A[0][2] * v[2],
  A[1][0] * v[0] + A[1][1] * v[1] + A[1][2] * v[2],
  A[2][0] * v[0] + A[2][1] * v[1] + A[2][2] * v[2],
];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a) => Math.hypot(a[0], a[1], a[2]);
export const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ---- Pose = { p:[x,y,z] mm, R:3x3 } ----
export const pose = (p, R) => ({ p: [...p], R: R.map((r) => [...r]) });
export const poseMul = (A, B) => ({ p: add(A.p, mulv(A.R, B.p)), R: mul3(A.R, B.R) });
export const poseInv = (A) => { const Rt = T3(A.R); return { p: scale(mulv(Rt, A.p), -1), R: Rt }; };
export const IDENTITY_POSE = () => ({ p: [0, 0, 0], R: I3() });

// ---- 쿼터니언 [w,x,y,z] ----
export function quatFromR(R) {
  const tr = R[0][0] + R[1][1] + R[2][2];
  let w, x, y, z;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s; x = (R[2][1] - R[1][2]) / s; y = (R[0][2] - R[2][0]) / s; z = (R[1][0] - R[0][1]) / s;
  } else if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) {
    const s = Math.sqrt(1 + R[0][0] - R[1][1] - R[2][2]) * 2;
    w = (R[2][1] - R[1][2]) / s; x = 0.25 * s; y = (R[0][1] + R[1][0]) / s; z = (R[0][2] + R[2][0]) / s;
  } else if (R[1][1] > R[2][2]) {
    const s = Math.sqrt(1 + R[1][1] - R[0][0] - R[2][2]) * 2;
    w = (R[0][2] - R[2][0]) / s; x = (R[0][1] + R[1][0]) / s; y = 0.25 * s; z = (R[1][2] + R[2][1]) / s;
  } else {
    const s = Math.sqrt(1 + R[2][2] - R[0][0] - R[1][1]) * 2;
    w = (R[1][0] - R[0][1]) / s; x = (R[0][2] + R[2][0]) / s; y = (R[1][2] + R[2][1]) / s; z = 0.25 * s;
  }
  const n = Math.hypot(w, x, y, z);
  // ABB 관례: q1(w) >= 0
  const sg = w < 0 ? -1 : 1;
  return [sg * w / n, sg * x / n, sg * y / n, sg * z / n];
}
export function RfromQuat(q) {
  let [w, x, y, z] = q;
  const n = Math.hypot(w, x, y, z) || 1;
  w /= n; x /= n; y /= n; z /= n;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}
export function quatSlerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (d < 0) { d = -d; bb = b.map((v) => -v); }
  if (d > 0.9995) {
    const r = a.map((v, i) => v + (bb[i] - v) * t);
    const n = Math.hypot(...r);
    return r.map((v) => v / n);
  }
  const th = Math.acos(Math.min(1, d));
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return a.map((v, i) => v * wa + bb[i] * wb);
}
// 두 회전 사이 각도 (rad)
export function rotAngle(Ra, Rb) {
  const Rd = mul3(T3(Ra), Rb);
  const c = (Rd[0][0] + Rd[1][1] + Rd[2][2] - 1) / 2;
  return Math.acos(clamp(c, -1, 1));
}

// ---- 오일러 각 변환 (deg) ----
// 고정축 XYZ = 회전 R = Rz(c)*Ry(b)*Rx(a)  (KUKA A,B,C 의 경우 A=Rz, B=Ry, C=Rx)
export function RfromZYX(rz, ry, rx) { return mul3(mul3(Rz(rz * DEG), Ry(ry * DEG)), Rx(rx * DEG)); }
export function ZYXfromR(R) {
  // 반환: [rz, ry, rx] deg
  const sy = -R[2][0];
  let ry, rz, rx;
  if (Math.abs(sy) > 0.9999999) {
    ry = Math.sign(sy) * Math.PI / 2;
    rz = Math.atan2(-R[0][1], R[1][1]);
    rx = 0;
  } else {
    ry = Math.asin(clamp(sy, -1, 1));
    rz = Math.atan2(R[1][0], R[0][0]);
    rx = Math.atan2(R[2][1], R[2][2]);
  }
  return [rz * RAD, ry * RAD, rx * RAD];
}
// ZYZ (Kawasaki O,A,T): R = Rz(O)*Ry(A)*Rz(T)
export function RfromZYZ(o, a, t) { return mul3(mul3(Rz(o * DEG), Ry(a * DEG)), Rz(t * DEG)); }
export function ZYZfromR(R) {
  const ca = clamp(R[2][2], -1, 1);
  let o, a, t;
  a = Math.acos(ca);
  if (Math.abs(Math.sin(a)) < 1e-7) {
    o = 0;
    t = ca > 0 ? Math.atan2(R[1][0], R[0][0]) : Math.atan2(-R[1][0], -R[0][0]);
  } else {
    o = Math.atan2(R[1][2], R[0][2]);
    t = Math.atan2(R[2][1], -R[2][0]);
  }
  return [o * RAD, a * RAD, t * RAD];
}

export const fmt = (v, d = 3) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);
