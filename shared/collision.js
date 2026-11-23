// 충돌 검사 모듈 (브라우저/Node 공용, 의존성 없음)
//
// 로봇 링크와 툴을 캡슐(선분 + 반경)로 근사하고, 환경(테이블 상판·바닥·받침대·공작물)과의
// 최소 거리를 계산한다. 단위 mm, 좌표는 로봇 베이스 기준 (에뮬레이터에서는 월드 = 로봇 베이스).
//
// 캡슐 반경은 robotView.js 가 그리는 링크 두께의 약 85% 로 잡아 "닿을락 말락" 한 정상 동작에서
// 오검출(false positive)을 피한다. 즉 시각적으로 살짝 파고들어야 충돌로 판정된다.
//
// 검사 규칙 (정상 Pick & Place 에서 오검출이 없도록 설계)
//  1) 로봇 링크 turret / upperArm / elbow / forearm / wrist  ↔  테이블, 바닥, 공작물
//  2) 툴(tool)  ↔  테이블, 바닥 만 검사 (공작물 제외 — 파지 시 손가락이 공작물에 닿는 것이 정상)
//     - 툴 캡슐은 TCP 보다 5mm 짧게(캡 반경 포함) 끝나도록 잘라낸다(TOOL_TIP_CLEAR).
//       공작물 파지 TCP 는 공작물 중심 높이(≥ 15mm)이므로, 툴을 수직으로 내려 TCP 가 테이블 면
//       높이(z ≥ 0)에 있는 한 툴 캡슐 최하단은 테이블 면보다 5mm 이상 위에 있어 검출되지 않는다.
//       TCP 가 테이블 면 아래로 5mm 이상 내려가면 tool↔table 충돌이 된다.
//       (그 결과 실제로 TCP 너머로 튀어나온 손가락 끝/공구 비트 일부는 검사하지 않는다)
//  3) 자기 충돌: tool↔turret, tool↔upperArm, wrist↔turret (인접 링크 쌍은 제외)
//  4) 받침대(pedestal, 반경 d/2, floorZ~0 원기둥): turret 은 받침대 위에 놓여 있으므로 검사하지 않고
//     wrist / tool 만 검사
//  5) opts.ignoreObjects 에 있는 공작물(파지 중인 공작물 등)은 검사 제외
//  6) opts.margin(mm) 만큼 모든 캡슐 반경을 키워 검사 (기본 0)
//  7) opts.obstacles: 셀 장애물(고정구·컨베이어 프레임·추가 테이블 등) 박스 배열
//     [{id, c:[x,y,z], h:[hx,hy,hz], R?:3x3(열 = 박스 축), tool?:false}]
//     로봇 링크는 항상, 툴은 tool !== false 일 때 검사 (툴 캡슐은 테이블과 동일하게 TCP 5mm 앞에서 잘림
//     → 컨베이어 위 공작물을 파지할 때 벨트 면은 검출되지 않음). pairs.b = 장애물 id
//     mesh 가 있으면(사용자 3D 모델, shared/meshcol.js meshObstacle) c/h/R 은 경계 OBB 이고
//     OBB 근처에서는 삼각형 단위 정밀 거리로 판정
//
// 거리 계산
//  - 선분↔선분: 정확한 최근접점 (Ericson, Real-Time Collision Detection 5.1.9)
//  - 선분↔AABB/OBB/유한 원기둥: 점↔볼록집합 거리는 선분 매개변수 t 에 대해 볼록함수이므로
//    골든섹션 탐색으로 전역 최소를 구한다 (정확도 ≈ 1e-6 · 선분길이, 샘플링 오차 없음).
//  - 선분↔평면: 양 끝점 높이의 최소값 (정확)

import { getGripper } from './grippers.js';
import { toOpw, jointFrames } from './kinematics.js';
import { meshObstacleDist } from './meshcol.js';

export const TABLE_THICKNESS = 30;   // robotView.buildCell 과 동일
export const TOOL_TIP_CLEAR = 5;     // 툴 캡슐을 TCP 보다 짧게 끝내는 여유 (mm)
const SHRINK = 0.85;                 // 그려진 두께 대비 캡슐 반경 비율

// robotView.setRobot 과 동일한 기준 링크 반경
export function linkRadius(model) {
  const R = model.reach;
  return Math.max(36, Math.min(250, R * 0.072));
}

// ------------------------------------------------------------------ 툴(그리퍼) 형상 → 플랜지 좌표계 캡슐
// 결과는 그리퍼 정의별로 캐시 (형상은 관절각과 무관)
const toolCache = new WeakMap();

function toolLocalCapsules(g) {
  if (!g || g.kind === 'none') return [];
  let cached = toolCache.get(g);
  if (cached) return cached;
  const geom = g.geom || {};
  const tcp = g.tcp || [0, 0, 100, 0, 0, 0];
  const tip = [tcp[0], tcp[1], tcp[2]];
  const caps = [];
  // 축방향 구간 [z0, z1, 반경(그려진 값)] → 캡슐. 캡 반구가 구간 밖으로 너무 튀어나오지 않도록 안쪽으로 당김
  const sections = [];
  const cpl = geom.coupling || { d: 63, h: 10 };
  let z = 0;
  const addSec = (h, rad) => { if (h > 0 && rad > 0) sections.push([z, z + h, rad]); z += h; };

  switch (g.kind) {
    case 'parallel':
    case 'adaptive2f': {
      const b = geom.body, f = geom.finger;
      if (b) addSec(cpl.h + b.h, Math.max(b.w, b.d) / 2); else z = cpl.h;
      // 손가락: 중심축 캡슐(손가락 폭 기준). 열린 손가락 간격까지는 덮지 않음
      if (f) addSec(f.l, Math.max(f.w / 2, f.t));
      break;
    }
    case 'threefinger': {
      const b = geom.body, f = geom.finger;
      if (b) addSec(cpl.h + b.h, Math.min(b.w, b.d) / 2 + 10); else z = cpl.h;
      if (f) addSec(f.l, Math.max(f.w, f.t));
      break;
    }
    case 'vacuum': {
      addSec(cpl.h, cpl.d / 2);
      if (geom.box) addSec(geom.box.h, Math.max(geom.box.w, geom.box.d) / 2);
      if (geom.stem?.h) addSec(geom.stem.h, geom.stem.d / 2);
      if (geom.plate) {
        // 넓고 얇은 판: 축방향 캡슐로는 무리 → 판의 긴 방향(X)으로 누운 캡슐 2개 (Y=±d/4, 반경 d/4)
        const p = geom.plate, zc = z + p.t / 2, rr = (p.d / 4) * SHRINK, hx = Math.max(0, p.w / 2 - rr);
        for (const sy of [-1, 1]) caps.push({ a: [-hx, sy * p.d / 4, zc], b: [hx, sy * p.d / 4, zc], r: rr, flat: true });
        z += p.t;
      }
      // 컵: 단일 컵이면 축 캡슐, 다수 컵이면 컵 영역을 덮는 판 캡슐들을 컵 높이까지 연장하지 않고
      // 각 컵을 작은 캡슐로 표현
      const cups = geom.cups || [];
      for (const c of cups) {
        const rr = (c.d / 2) * SHRINK;
        caps.push({ a: [c.x, c.y, z + rr * 0.5], b: [c.x, c.y, z + c.h - rr * 0.5], r: rr, cup: true });
      }
      z += cups.length ? Math.max(...cups.map((c) => c.h)) : 0;
      break;
    }
    case 'magnet': {
      addSec(cpl.h, cpl.d / 2);
      if (geom.body) addSec(geom.body.h, geom.body.d / 2);
      if (geom.face) addSec(geom.face.h, geom.face.d / 2);
      break;
    }
    case 'spindle': {
      addSec(cpl.h, cpl.d / 2);
      if (geom.body) addSec(geom.body.h, geom.body.d / 2);
      addSec(20, (geom.body?.d || 40) * 0.3);
      if (geom.tool) addSec(geom.tool.h, Math.max(geom.tool.d / 2, 6));
      break;
    }
    case 'torch': {
      // 마운트(커플링) + 휜 넥: 마운트 끝 → TCP 직선 캡슐로 근사
      addSec(cpl.h, cpl.d / 2);
      const rn = ((geom.neck?.d || 26) / 2) * SHRINK;
      caps.push({ a: [0, 0, cpl.h], b: tip.slice(), r: rn, toTip: true });
      break;
    }
    default: {
      // 사용자/미지 그리퍼: 플랜지 → TCP 직선, 반경 30
      const L = Math.hypot(...tip);
      if (L > 1) caps.push({ a: [0, 0, 0], b: tip.slice(), r: 30 * SHRINK, toTip: true });
    }
  }
  // 커스텀 STL 그리퍼 등 geom 세부 치수가 비어 있는 경우에도 기본 툴 캡슐 보장
  if (!sections.length && !caps.length) {
    const L = Math.hypot(...tip);
    if (L > 1) caps.push({ a: [0, 0, 0], b: tip.slice(), r: 30 * SHRINK, toTip: true });
  }
  for (const [z0, z1, rad] of sections) {
    const r = rad * SHRINK;
    const pull = Math.min(r, (z1 - z0) / 2) * 0.5;
    caps.push({ a: [0, 0, z0 + pull], b: [0, 0, Math.max(z0 + pull, z1 - pull)], r });
  }
  // TCP 앞 TOOL_TIP_CLEAR 에서 캡슐(반구 포함)이 끝나도록 자르기 — TCP 방향(플랜지→TCP) 투영 기준
  const L = Math.hypot(...tip);
  if (L > 1) {
    const u = [tip[0] / L, tip[1] / L, tip[2] / L];
    const out = [];
    for (const c of caps) {
      const lim = L - TOOL_TIP_CLEAR - c.r;      // 캡슐 중심선이 넘어서는 안 되는 투영 길이
      const pa = c.a[0] * u[0] + c.a[1] * u[1] + c.a[2] * u[2];
      const pb = c.b[0] * u[0] + c.b[1] * u[1] + c.b[2] * u[2];
      if (pa > lim && pb > lim) continue;         // 전부 TCP 너머 → 제외
      const clip = (p, q, pp, pq) => {            // p 가 넘으면 q 쪽으로 당김
        if (pp <= lim) return p;
        const t = (pp - lim) / (pp - pq);
        return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
      };
      out.push({ a: clip(c.a, c.b, pa, pb), b: clip(c.b, c.a, pb, pa), r: c.r });
    }
    cached = out;
  } else cached = caps.map((c) => ({ a: c.a, b: c.b, r: c.r }));
  toolCache.set(g, cached);
  return cached;
}

// ------------------------------------------------------------------ 로봇 캡슐
// 관절 프레임을 직접 계산 (jointFrames 와 동일한 결과, 할당 최소화)
// 반환: [{id, a:[x,y,z], b:[x,y,z], r}] — 로봇 베이스 좌표 (mm)
export function robotCapsules(model, jointsDeg, gripper) {
  const g = typeof gripper === 'string' ? getGripper(gripper) : gripper;
  if (model.kin === 'ur') return urCapsules(model, jointsDeg, g);
  const k = model.opw;
  const r = linkRadius(model);
  const q = toOpw(model, jointsDeg);
  const c1 = Math.cos(q[0]), s1 = Math.sin(q[0]);
  // F1 = Rz(q1)
  const R1 = [[c1, -s1, 0], [s1, c1, 0], [0, 0, 1]];
  // F2 = F1 * [Ry(q2), (a1, b, c1)]
  const p2 = [c1 * k.a1 - s1 * k.b, s1 * k.a1 + c1 * k.b, k.c1];
  const R2 = mulR(R1, ry(q[1]));
  const p3 = addv(p2, colz(R2, k.c2));
  const R3 = mulR(R2, ry(q[2]));
  const p4 = addv(p3, colx(R3, k.a2));
  const R4 = mulR(R3, rz(q[3]));
  const p5 = addv(p4, colz(R4, k.c3));
  const R5 = mulR(R4, ry(q[4]));
  const p6 = addv(p5, colz(R5, k.c4));
  const R6 = mulR(R5, rz(q[5]));

  const loc = (R, p, x, y, zz) => [
    p[0] + R[0][0] * x + R[0][1] * y + R[0][2] * zz,
    p[1] + R[1][0] * x + R[1][1] * y + R[1][2] * zz,
    p[2] + R[2][0] * x + R[2][1] * y + R[2][2] * zz,
  ];
  const O = [0, 0, 0];
  const caps = [];
  // turret: 선회 기둥 (바닥 근처 ~ J2 축 높이) + 어깨(J2 축으로 뻗는 부분)
  const rt = r * 1.2 * SHRINK;
  const hb = Math.min(k.c1 * 0.38, r * 2.2);
  const zt0 = Math.max(hb * 0.5, rt * 0.6), zt1 = Math.max(zt0, k.c1 - r * 0.5);
  caps.push({ id: 'turret', a: loc(R1, O, 0, 0, zt0), b: loc(R1, O, 0, 0, zt1), r: rt });
  if (Math.hypot(k.a1, k.b) > r * 0.3) caps.push({ id: 'turret', a: loc(R1, O, 0, 0, zt1), b: p2, r: r * SHRINK });
  // upperArm (하완): J2 → J3. public/js/robotMesh.js 의 편측 하완(y = 0.36r ~ 0.36r + armT·r)에 맞춰 y 로 0.8r 오프셋
  caps.push({ id: 'upperArm', a: loc(R2, p2, 0, r * 0.8, 0), b: loc(R2, p2, 0, r * 0.8, k.c2), r: r * 0.65 * SHRINK });
  // elbow: J3 → J4 시작 (a2 오프셋) + J4 모터 하우징(전완 후방)
  const re = r * 0.62 * SHRINK;
  if (Math.abs(k.a2) > 1) caps.push({ id: 'elbow', a: p3, b: p4, r: re });
  caps.push({ id: 'elbow', a: loc(R4, p4, 0, 0, -r * 1.45), b: loc(R4, p4, 0, 0, r * 0.3), r: re });
  // forearm (전완): J4 시작 + 여유 → 손목 중심 - 여유
  const rf = r * 0.46 * SHRINK;
  caps.push({ id: 'forearm', a: loc(R4, p4, 0, 0, r * 0.4 + rf * 0.5), b: loc(R4, p4, 0, 0, Math.max(r * 0.4 + rf * 0.5, k.c3 - r * 0.55)), r: rf });
  // wrist: 손목 중심 → 플랜지
  caps.push({ id: 'wrist', a: p5, b: p6, r: r * 0.33 * SHRINK });
  // tool: 플랜지 좌표계 캡슐 → 베이스
  for (const c of toolLocalCapsules(g)) {
    caps.push({ id: 'tool', a: loc(R6, p6, c.a[0], c.a[1], c.a[2]), b: loc(R6, p6, c.b[0], c.b[1], c.b[2]), r: c.r });
  }
  return caps;
}

// UR (비구형 손목): 링크가 관절 축 방향으로 옆으로 비켜 있는 구조. public/js/urMesh.js 형상과 같은 배치
//  lat = 어깨·팔꿈치·손목1 축 방향(평행). 상완은 lat 쪽으로 su, 전완은 sf 만큼 비켜 있고 손목1→손목2 사이가 나머지(d4)를 잇는다
export const UR_OFFSETS = (k) => ({ su: k.d4 * 1.25, sf: k.d4 * 0.15 });
export const urRadii = (model) => { const r = linkRadius(model); return { rj: r * 1.0, rt: r * 0.72 }; };
function urCapsules(model, jointsDeg, g) {
  const k = model.dh, F = jointFrames(model, jointsDeg);
  const { su, sf } = UR_OFFSETS(k), { rj, rt } = urRadii(model);
  const lat = [F[2].R[0][1], F[2].R[1][1], F[2].R[2][1]];
  const off = (p, s) => [p[0] + lat[0] * s, p[1] + lat[1] * s, p[2] + lat[2] * s];
  const D1 = F[2].p, D2 = F[3].p, D3 = F[4].p, D4 = F[5].p, R6 = F[6].R, p6 = F[6].p;
  const D5 = [p6[0] - R6[0][2] * k.d6, p6[1] - R6[1][2] * k.d6, p6[2] - R6[2][2] * k.d6];
  const caps = [
    { id: 'turret', a: [0, 0, k.d1 * 0.35], b: D1, r: rj * SHRINK },
    { id: 'turret', a: D1, b: off(D1, su), r: rj * SHRINK },
    { id: 'upperArm', a: off(D1, su), b: off(D2, su), r: rt * SHRINK },
    { id: 'elbow', a: off(D2, su), b: off(D2, sf), r: rj * 0.85 * SHRINK },
    { id: 'forearm', a: off(D2, sf), b: off(D3, sf), r: rt * 0.85 * SHRINK },
    { id: 'wrist', a: off(D3, sf), b: D4, r: rj * 0.7 * SHRINK },
    { id: 'wrist', a: D4, b: D5, r: rj * 0.7 * SHRINK },
    { id: 'wrist', a: D5, b: p6, r: rj * 0.68 * SHRINK },
  ];
  const loc = (x, y, z) => [p6[0] + R6[0][0] * x + R6[0][1] * y + R6[0][2] * z, p6[1] + R6[1][0] * x + R6[1][1] * y + R6[1][2] * z, p6[2] + R6[2][0] * x + R6[2][1] * y + R6[2][2] * z];
  for (const c of toolLocalCapsules(g)) caps.push({ id: 'tool', a: loc(...c.a), b: loc(...c.b), r: c.r });
  return caps;
}

const ry = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; };
const rz = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; };
function mulR(A, B) {
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
  return C;
}
const addv = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const colz = (R, s) => [R[0][2] * s, R[1][2] * s, R[2][2] * s];
const colx = (R, s) => [R[0][0] * s, R[1][0] * s, R[2][0] * s];

// ------------------------------------------------------------------ 기하 거리 함수
// 선분 PQ ↔ 선분 RS 최소 거리
export function segSegDist(p, q, r0, s) {
  const d1x = q[0] - p[0], d1y = q[1] - p[1], d1z = q[2] - p[2];
  const d2x = s[0] - r0[0], d2y = s[1] - r0[1], d2z = s[2] - r0[2];
  const rx = p[0] - r0[0], ry_ = p[1] - r0[1], rz_ = p[2] - r0[2];
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry_ + d2z * rz_;
  let sP, tP;
  const EPS = 1e-12;
  if (a <= EPS && e <= EPS) { sP = 0; tP = 0; }
  else if (a <= EPS) { sP = 0; tP = clamp01(f / e); }
  else {
    const c = d1x * rx + d1y * ry_ + d1z * rz_;
    if (e <= EPS) { tP = 0; sP = clamp01(-c / a); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const den = a * e - b * b;
      sP = den > EPS ? clamp01((b * f - c * e) / den) : 0;
      tP = (b * sP + f) / e;
      if (tP < 0) { tP = 0; sP = clamp01(-c / a); }
      else if (tP > 1) { tP = 1; sP = clamp01((b - c) / a); }
    }
  }
  const dx = p[0] + d1x * sP - (r0[0] + d2x * tP);
  const dy = p[1] + d1y * sP - (r0[1] + d2y * tP);
  const dz = p[2] + d1z * sP - (r0[2] + d2z * tP);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// 점 ↔ 선분 거리
export function pointSegDist(pt, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const L2 = dx * dx + dy * dy + dz * dz;
  let t = L2 > 1e-12 ? ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy + (pt[2] - a[2]) * dz) / L2 : 0;
  t = clamp01(t);
  return Math.hypot(a[0] + dx * t - pt[0], a[1] + dy * t - pt[1], a[2] + dz * t - pt[2]);
}

// 볼록 거리함수 f(t), t∈[0,1] 의 최소값 — 골든섹션 탐색 (볼록이므로 전역 최소)
const GR = (Math.sqrt(5) - 1) / 2;
function minConvex(f, iters = 34) {
  let lo = 0, hi = 1;
  let x1 = hi - GR * (hi - lo), x2 = lo + GR * (hi - lo);
  let f1 = f(x1), f2 = f(x2);
  for (let i = 0; i < iters; i++) {
    if (f1 <= f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - GR * (hi - lo); f1 = f(x1); }
    else { lo = x1; x1 = x2; f1 = f2; x2 = lo + GR * (hi - lo); f2 = f(x2); }
    if (f1 === 0 || f2 === 0) return 0;          // 박스 내부 진입 → 거리 0
  }
  return Math.min(f1, f2, f(0), f(1));
}

// 선분 ↔ OBB 거리. box = {c:[x,y,z], R:3x3 (열 = 박스 축), h:[hx,hy,hz]}  (AABB 는 R=null)
export function segBoxDist(a, b, box) {
  // 박스 로컬 좌표로 변환
  const la = toLocal(a, box), lb = toLocal(b, box);
  const h = box.h;
  const dx = lb[0] - la[0], dy = lb[1] - la[1], dz = lb[2] - la[2];
  const f = (t) => {
    const x = Math.abs(la[0] + dx * t) - h[0], y = Math.abs(la[1] + dy * t) - h[1], z = Math.abs(la[2] + dz * t) - h[2];
    const ox = x > 0 ? x : 0, oy = y > 0 ? y : 0, oz = z > 0 ? z : 0;
    return ox * ox + oy * oy + oz * oz;
  };
  return Math.sqrt(minConvex(f));
}
function toLocal(p, box) {
  const x = p[0] - box.c[0], y = p[1] - box.c[1], z = p[2] - box.c[2];
  const R = box.R;
  if (!R) return [x, y, z];
  return [R[0][0] * x + R[1][0] * y + R[2][0] * z, R[0][1] * x + R[1][1] * y + R[2][1] * z, R[0][2] * x + R[1][2] * y + R[2][2] * z];
}

// 선분 ↔ 수직 원기둥(축 = z, 중심 (cx,cy), 반경 rad, z0~z1) 거리
export function segCylDist(a, b, cx, cy, rad, z0, z1) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  return Math.sqrt(minConvex((t) => {
    const x = a[0] + dx * t - cx, y = a[1] + dy * t - cy, z = a[2] + dz * t;
    let dr = Math.sqrt(x * x + y * y) - rad; if (dr < 0) dr = 0;
    const dzz = z > z1 ? z - z1 : z < z0 ? z0 - z : 0;
    return dr * dr + dzz * dzz;
  }));
}

// 선분 ↔ 평면 z = z0 (위쪽이 자유공간) — 부호 있는 거리 (아래로 뚫고 들어가면 음수)
export const segPlaneZ = (a, b, z0) => Math.min(a[2], b[2]) - z0;

// ------------------------------------------------------------------ 충돌 검사
const LINK_ENV = new Set(['turret', 'upperArm', 'elbow', 'forearm', 'wrist']);
const PEDESTAL_TEST = new Set(['wrist', 'tool']);
const SELF_PAIRS = [['tool', 'turret'], ['tool', 'upperArm'], ['wrist', 'turret']];

// 환경 객체 준비 (공작물 수가 적어 매 호출 새로 만들어도 수 µs 수준)
function buildEnv(scene, objects) {
  const env = { table: null, floorZ: null, pedestal: null, objs: [] };
  if (scene) {
    if (scene.table) {
      const t = scene.table, tz = t.z ?? 0;
      env.table = { c: [t.x, t.y, tz - TABLE_THICKNESS / 2], R: null, h: [t.w / 2, t.d / 2, TABLE_THICKNESS / 2] };
    }
    if (Number.isFinite(scene.floorZ)) env.floorZ = scene.floorZ;
    if (scene.pedestal && Number.isFinite(scene.floorZ)) env.pedestal = { r: scene.pedestal.d / 2, z0: scene.floorZ, z1: 0 };
  }
  for (const o of objects || []) {
    const h = [o.size[0] / 2, o.size[1] / 2, o.size[2] / 2];
    env.objs.push({ id: o.id, c: o.pose.p.slice(), R: o.pose.R, h, br: Math.hypot(h[0], h[1], h[2]) });
  }
  return env;
}

// 반환: { hit, pairs:[{a, b, dist}], minDist, capsules }
//   pairs.a = 로봇 캡슐 id, pairs.b = 'table' | 'floor' | 'pedestal' | 공작물 id | 다른 캡슐 id (self 충돌)
//   dist = 여유거리(표면간, 음수면 침투), minDist = 검사한 모든 쌍 중 최소 여유거리 (mm)
// opts: { margin=0, ignoreObjects=[], capsules (미리 계산한 캡슐 재사용), obstacles=[] (규칙 7) }
export function checkCollision(model, jointsDeg, gripper, scene, objects, opts = {}) {
  const margin = opts.margin || 0;
  const ignore = opts.ignoreObjects;
  const caps = opts.capsules || robotCapsules(model, jointsDeg, gripper);
  const env = buildEnv(scene, objects);
  const obstacles = Array.isArray(opts.obstacles) && opts.obstacles.length ? opts.obstacles : null;
  const pairs = [];
  const seen = new Set();
  let minDist = Infinity;
  const report = (a, b, d, type) => {
    if (d < minDist) minDist = d;
    if (d < 0) {
      const key = a + '|' + b;
      if (seen.has(key)) { const p = pairs.find((x) => x.a === a && x.b === b); if (d < p.dist) p.dist = d; return; }
      seen.add(key);
      pairs.push({ a, b, type, dist: d });
    }
  };

  for (const c of caps) {
    const rr = c.r + margin;
    const isLink = LINK_ENV.has(c.id), isTool = c.id === 'tool';
    if (!isLink && !isTool) continue;
    // 바닥
    if (env.floorZ !== null) report(c.id, 'floor', segPlaneZ(c.a, c.b, env.floorZ) - rr, 'env');
    // 테이블 상판
    if (env.table) {
      const t = env.table;
      // 빠른 배제: 선분 AABB 와 상판 AABB 간격
      const gap = aabbGap(c.a, c.b, t);
      report(c.id, 'table', gap > rr + 1 ? gap - rr : segBoxDist(c.a, c.b, t) - rr, 'env');
    }
    // 받침대 (Z축 빠른 배제로 상공 작업 시 36회 탐색 생략)
    if (env.pedestal && PEDESTAL_TEST.has(c.id)) {
      const p = env.pedestal;
      const zMin = c.a[2] < c.b[2] ? c.a[2] : c.b[2];
      const zGap = zMin - p.z1;
      report(c.id, 'pedestal', zGap > rr + 1 ? zGap - rr : segCylDist(c.a, c.b, 0, 0, p.r, p.z0, p.z1) - rr, 'env');
    }
    // 셀 장애물 (OBB / 메시). 외접구 → OBB 순으로 빠른 배제
    if (obstacles) {
      for (const ob of obstacles) {
        if (isTool && ob.tool === false) continue;
        const br = ob._br ?? (ob._br = Math.hypot(ob.h[0], ob.h[1], ob.h[2]));
        const dc = pointSegDist(ob.c, c.a, c.b) - br;
        if (dc > rr + 1) { report(c.id, ob.id, dc - rr, 'env'); continue; }
        const db = segBoxDist(c.a, c.b, ob);
        if (!ob.mesh || db > rr + 1) { report(c.id, ob.id, db - rr, 'env'); continue; }
        // 사용자 3D 모델: 삼각형 단위 정밀 거리 (반경 + 50mm 밖은 탐색 생략)
        report(c.id, ob.id, meshObstacleDist(c.a, c.b, ob, rr + 50) - rr, 'env');
      }
    }
    // 공작물 (링크만)
    if (isLink) {
      for (const o of env.objs) {
        if (ignore && ignore.includes(o.id)) continue;
        const dc = pointSegDist(o.c, c.a, c.b) - o.br;   // 외접구로 빠른 배제 (하한)
        report(c.id, o.id, dc > rr + 1 ? dc - rr : segBoxDist(c.a, c.b, o) - rr, 'env');
      }
    }
  }
  // 자기 충돌
  for (const [ia, ib] of SELF_PAIRS) {
    for (const ca of caps) {
      if (ca.id !== ia) continue;
      for (const cb of caps) {
        if (cb.id !== ib) continue;
        report(ia, ib, segSegDist(ca.a, ca.b, cb.a, cb.b) - ca.r - cb.r - 2 * margin, 'self');
      }
    }
  }
  return { hit: pairs.length > 0, pairs, minDist, capsules: caps };
}

// 선분의 AABB 와 박스(AABB) 사이 간격 (하한, 빠른 배제용)
function aabbGap(a, b, box) {
  let s = 0;
  for (let i = 0; i < 3; i++) {
    const lo = Math.min(a[i], b[i]), hi = Math.max(a[i], b[i]);
    const bl = box.c[i] - box.h[i], bh = box.c[i] + box.h[i];
    const d = lo > bh ? lo - bh : bl > hi ? bl - hi : 0;
    s += d * d;
  }
  return Math.sqrt(s);
}
