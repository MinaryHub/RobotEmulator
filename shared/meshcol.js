// 삼각형 메시 정밀 간섭 (브라우저/Node 공용, 의존성 없음)
//
// 사용자가 불러온 3D 모델(장비·지그·펜스 등)과 로봇 캡슐 사이의 최소 거리를 삼각형 단위로 계산한다.
//  - simplifyMesh : 정점 군집화(격자)로 간섭용 메시 삼각형 수를 줄임 (업로드 전 브라우저에서 실행)
//  - encodeCol / decodeCol : 간섭 메시 바이너리 형식 (.col)
//  - buildBVH     : 삼각형 AABB 트리 (중앙값 분할, 리프 ≤ 8개)
//  - segMeshDist  : 선분 ↔ 메시 최소 거리 (정확, cutoff 이상은 하한값만 반환)
//  - rayMesh      : 반직선 ↔ 메시 첫 교차 거리 (공작물 낙하 지지면 계산)
//  - meshObstacle / meshObstacleDist / meshObstacleTopZ : 월드 배치(위치·회전·배율)를 적용한 간섭 객체
//
// 한계: 거리는 '표면'까지의 거리다. 캡슐 전체가 닫힌 모델 내부 깊숙이(표면에서 반경 이상) 들어가 있으면
//       검출되지 않는다. 실제 동작(연속 이동)에서는 표면을 통과하는 순간 검출되므로 문제되지 않는다.
import { segSegDist } from './collision.js';   // 순환 import 이지만 함수 선언이라 호이스팅되어 안전

// ------------------------------------------------------------------ 간소화 (정점 군집화)
// positions: Float32Array (xyz...), indices: Uint32Array | null (null 이면 3정점씩 삼각형)
// maxTris 이하가 될 때까지 격자 크기를 키운다. 반환 { positions, indices, cell }
// 간섭 메시 최대 삼각형 수 (브라우저 간소화 목표 = 서버 업로드 상한)
export const COL_MAX_TRIS = 200000;

export function simplifyMesh(positions, indices, maxTris = COL_MAX_TRIS) {
  const nv = positions.length / 3;
  if (!indices) { indices = new Uint32Array(nv); for (let i = 0; i < nv; i++) indices[i] = i; }
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) { const v = positions[i * 3 + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  // 처음에는 아주 작은 격자(중복 정점 병합 정도)로 시작
  let cell = diag * 1e-6;
  for (let iter = 0; iter < 40; iter++) {
    const r = cluster(positions, indices, lo, cell);
    if (r.indices.length / 3 <= maxTris) return { ...r, cell };
    cell *= 1.6;
  }
  return { ...cluster(positions, indices, lo, cell), cell };
}

function cluster(positions, indices, lo, cell) {
  const nv = positions.length / 3;
  const map = new Map();
  const remap = new Int32Array(nv);
  const sum = [];
  for (let i = 0; i < nv; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const key = Math.floor((x - lo[0]) / cell) + ',' + Math.floor((y - lo[1]) / cell) + ',' + Math.floor((z - lo[2]) / cell);
    let id = map.get(key);
    if (id === undefined) { id = sum.length / 4; map.set(key, id); sum.push(0, 0, 0, 0); }
    sum[id * 4] += x; sum[id * 4 + 1] += y; sum[id * 4 + 2] += z; sum[id * 4 + 3]++;
    remap[i] = id;
  }
  const nc = sum.length / 4;
  const pos = new Float32Array(nc * 3);
  for (let i = 0; i < nc; i++) { const n = sum[i * 4 + 3]; pos[i * 3] = sum[i * 4] / n; pos[i * 3 + 1] = sum[i * 4 + 1] / n; pos[i * 3 + 2] = sum[i * 4 + 2] / n; }
  const out = [];
  const seen = new Set();
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap[indices[t]], b = remap[indices[t + 1]], c = remap[indices[t + 2]];
    if (a === b || b === c || a === c) continue;
    // 같은 삼각형(방향 무관) 중복 제거
    const s = [a, b, c].sort((p, q) => p - q).join(',');
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(a, b, c);
  }
  return { positions: pos, indices: Uint32Array.from(out) };
}

// ------------------------------------------------------------------ .col 바이너리
// [8B 'RECOL1\0\0'][u32 정점 수][u32 삼각형 수][f32 정점 xyz...][u32 인덱스...] (리틀 엔디언)
const MAGIC = 'RECOL1\0\0';
export function encodeCol(positions, indices) {
  const nv = positions.length / 3, nt = indices.length / 3;
  const buf = new ArrayBuffer(16 + nv * 12 + nt * 12);
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < 8; i++) u8[i] = MAGIC.charCodeAt(i);
  const dv = new DataView(buf);
  dv.setUint32(8, nv, true); dv.setUint32(12, nt, true);
  new Float32Array(buf, 16, nv * 3).set(positions);
  new Uint32Array(buf, 16 + nv * 12, nt * 3).set(indices);
  return buf;
}

// buf: ArrayBuffer | Uint8Array(Node Buffer 포함). 형식 오류 시 Error
export function decodeCol(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 16) throw new Error('간섭 메시가 비어 있습니다');
  for (let i = 0; i < 8; i++) if (u8[i] !== MAGIC.charCodeAt(i)) throw new Error('간섭 메시 형식이 아닙니다');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const nv = dv.getUint32(8, true), nt = dv.getUint32(12, true);
  if (u8.length !== 16 + nv * 12 + nt * 12) throw new Error('간섭 메시 크기가 맞지 않습니다');
  // 정렬 보장을 위해 복사 (Node Buffer.slice 는 복사가 아닌 뷰이므로 Uint8Array 의 slice 를 명시적으로 사용)
  const body = Uint8Array.prototype.slice.call(u8, 16);
  const positions = new Float32Array(body.buffer, 0, nv * 3);
  const indices = new Uint32Array(body.buffer, nv * 12, nt * 3);
  for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i])) throw new Error('간섭 메시에 잘못된 좌표가 있습니다');
  for (let i = 0; i < indices.length; i++) if (indices[i] >= nv) throw new Error('간섭 메시 인덱스 범위 초과');
  return { positions, indices };
}

// ------------------------------------------------------------------ BVH
const LEAF = 8;
export function buildBVH(positions, indices) {
  const nt = indices.length / 3;
  if (!nt) throw new Error('삼각형이 없습니다');
  const cen = new Float32Array(nt * 3), tb = new Float32Array(nt * 6);
  for (let t = 0; t < nt; t++) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k] * 3, x = positions[v], y = positions[v + 1], z = positions[v + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    tb.set([x0, y0, z0, x1, y1, z1], t * 6);
    cen[t * 3] = (x0 + x1) / 2; cen[t * 3 + 1] = (y0 + y1) / 2; cen[t * 3 + 2] = (z0 + z1) / 2;
  }
  const order = new Uint32Array(nt);
  for (let i = 0; i < nt; i++) order[i] = i;
  const maxNodes = Math.max(1, 2 * Math.ceil(nt / (LEAF / 2)));
  const bounds = new Float32Array(maxNodes * 6);
  const left = new Int32Array(maxNodes), start = new Int32Array(maxNodes), count = new Int32Array(maxNodes);
  let n = 0;
  const stack = [[0, nt, n++]];
  while (stack.length) {
    const [s, e, node] = stack.pop();
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
    for (let i = s; i < e; i++) {
      const t = order[i], b = t * 6;
      if (tb[b] < x0) x0 = tb[b]; if (tb[b + 1] < y0) y0 = tb[b + 1]; if (tb[b + 2] < z0) z0 = tb[b + 2];
      if (tb[b + 3] > x1) x1 = tb[b + 3]; if (tb[b + 4] > y1) y1 = tb[b + 4]; if (tb[b + 5] > z1) z1 = tb[b + 5];
      const c = t * 3;
      if (cen[c] < cx0) cx0 = cen[c]; if (cen[c] > cx1) cx1 = cen[c];
      if (cen[c + 1] < cy0) cy0 = cen[c + 1]; if (cen[c + 1] > cy1) cy1 = cen[c + 1];
      if (cen[c + 2] < cz0) cz0 = cen[c + 2]; if (cen[c + 2] > cz1) cz1 = cen[c + 2];
    }
    bounds.set([x0, y0, z0, x1, y1, z1], node * 6);
    const ex = [cx1 - cx0, cy1 - cy0, cz1 - cz0];
    if (e - s <= LEAF) { left[node] = -1; start[node] = s; count[node] = e - s; continue; }
    // 항상 개수 중앙에서 나눔 → 중심이 모두 겹친(퇴화) 메시도 잎 크기 ≤ LEAF, 깊이 O(log n)
    const axis = ex[0] >= ex[1] && ex[0] >= ex[2] ? 0 : ex[1] >= ex[2] ? 1 : 2;
    const mid = (s + e) >> 1;
    if (ex[axis] > 0) quickselect(order, cen, axis, s, e - 1, mid);
    const l = n++, r = n++;
    left[node] = l; start[node] = r; count[node] = 0;     // 내부 노드: start = 오른쪽 자식
    stack.push([s, mid, l], [mid, e, r]);
  }
  return { positions, indices, order, bounds, left, start, count, nodes: n, tris: nt, bbox: [Array.from(bounds.subarray(0, 3)), Array.from(bounds.subarray(3, 6))] };
}

function quickselect(order, cen, axis, lo, hi, k) {
  while (hi > lo) {
    const pv = cen[order[(lo + hi) >> 1] * 3 + axis];
    let i = lo, j = hi;
    while (i <= j) {
      while (cen[order[i] * 3 + axis] < pv) i++;
      while (cen[order[j] * 3 + axis] > pv) j--;
      if (i <= j) { const t = order[i]; order[i] = order[j]; order[j] = t; i++; j--; }
    }
    if (k <= j) hi = j; else if (k >= i) lo = i; else return;
  }
}

// ------------------------------------------------------------------ 거리
// 점 ↔ 삼각형 최근접점 제곱거리 (Ericson 5.1.5)
function pointTriDist2(px, py, pz, A, B, C) {
  const abx = B[0] - A[0], aby = B[1] - A[1], abz = B[2] - A[2];
  const acx = C[0] - A[0], acy = C[1] - A[1], acz = C[2] - A[2];
  const apx = px - A[0], apy = py - A[1], apz = pz - A[2];
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz;
  if (d1 <= 0 && d2 <= 0) { qx = A[0]; qy = A[1]; qz = A[2]; }
  else {
    const bpx = px - B[0], bpy = py - B[1], bpz = pz - B[2];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { qx = B[0]; qy = B[1]; qz = B[2]; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); qx = A[0] + abx * v; qy = A[1] + aby * v; qz = A[2] + abz * v; }
      else {
        const cpx = px - C[0], cpy = py - C[1], cpz = pz - C[2];
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { qx = C[0]; qy = C[1]; qz = C[2]; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); qx = A[0] + acx * w; qy = A[1] + acy * w; qz = A[2] + acz * w; }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
              qx = B[0] + (C[0] - B[0]) * w; qy = B[1] + (C[1] - B[1]) * w; qz = B[2] + (C[2] - B[2]) * w;
            } else {
              const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
              qx = A[0] + abx * v + acx * w; qy = A[1] + aby * v + acy * w; qz = A[2] + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

// 선분 PQ 가 삼각형을 관통하는지 (Möller–Trumbore, t ∈ [0,1])
function segHitsTri(p, q, A, B, C) {
  const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
  const t = rayTri(p[0], p[1], p[2], dx, dy, dz, A, B, C);
  return t >= 0 && t <= 1;
}

// 반직선 o + t·d ↔ 삼각형: t (교차 없으면 -1). 양면
function rayTri(ox, oy, oz, dx, dy, dz, A, B, C) {
  const e1x = B[0] - A[0], e1y = B[1] - A[1], e1z = B[2] - A[2];
  const e2x = C[0] - A[0], e2y = C[1] - A[1], e2z = C[2] - A[2];
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det;
  const tx = ox - A[0], ty = oy - A[1], tz = oz - A[2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

// 선분 ↔ 삼각형 최소 거리 (관통 → 0, 아니면 끝점↔면 / 선분↔세 변 중 최소)
export function segTriDist(p, q, A, B, C) {
  if (segHitsTri(p, q, A, B, C)) return 0;
  const d2 = Math.min(pointTriDist2(p[0], p[1], p[2], A, B, C), pointTriDist2(q[0], q[1], q[2], A, B, C));
  return Math.min(Math.sqrt(d2), segSegDist(p, q, A, B), segSegDist(p, q, B, C), segSegDist(p, q, C, A));
}

const TA = [0, 0, 0], TB = [0, 0, 0], TC = [0, 0, 0];
function loadTri(bvh, t) {
  const P = bvh.positions, I = bvh.indices;
  let v = I[t * 3] * 3; TA[0] = P[v]; TA[1] = P[v + 1]; TA[2] = P[v + 2];
  v = I[t * 3 + 1] * 3; TB[0] = P[v]; TB[1] = P[v + 1]; TB[2] = P[v + 2];
  v = I[t * 3 + 2] * 3; TC[0] = P[v]; TC[1] = P[v + 1]; TC[2] = P[v + 2];
}

// 노드 AABB ↔ 선분 거리 하한: max(선분 AABB 간격, 노드 중심↔선분 거리 − 반대각선)
function nodeLowerBound(bvh, node, p, q, sl, sh) {
  const b = bvh.bounds, o = node * 6;
  let g = 0;
  for (let k = 0; k < 3; k++) {
    const d = sl[k] > b[o + 3 + k] ? sl[k] - b[o + 3 + k] : b[o + k] > sh[k] ? b[o + k] - sh[k] : 0;
    g += d * d;
  }
  g = Math.sqrt(g);
  const cx = (b[o] + b[o + 3]) / 2, cy = (b[o + 1] + b[o + 4]) / 2, cz = (b[o + 2] + b[o + 5]) / 2;
  const hd = Math.hypot(b[o + 3] - b[o], b[o + 4] - b[o + 1], b[o + 5] - b[o + 2]) / 2;
  const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
  const L2 = dx * dx + dy * dy + dz * dz;
  let t = L2 > 1e-12 ? ((cx - p[0]) * dx + (cy - p[1]) * dy + (cz - p[2]) * dz) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const s = Math.hypot(p[0] + dx * t - cx, p[1] + dy * t - cy, p[2] + dz * t - cz) - hd;
  return s > g ? s : g;
}

// 선분 PQ ↔ 메시 최소 거리. cutoff 보다 먼 부분은 탐색하지 않음 (그때 반환값 ≥ cutoff 인 하한)
const STACK = new Int32Array(256);
export function segMeshDist(bvh, p, q, cutoff = Infinity) {
  const sl = [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.min(p[2], q[2])];
  const sh = [Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.max(p[2], q[2])];
  let best = cutoff;
  let lowest = Infinity;                // 잘라낸 노드 하한 중 최소 (best 가 cutoff 일 때 반환)
  let sp = 0;
  const stack = bvh.nodes * 2 > STACK.length ? new Int32Array(bvh.nodes * 2) : STACK;
  stack[sp++] = 0;
  while (sp) {
    const node = stack[--sp];
    const lb = nodeLowerBound(bvh, node, p, q, sl, sh);
    if (lb >= best) { if (lb < lowest) lowest = lb; continue; }
    const l = bvh.left[node];
    if (l < 0) {
      const s = bvh.start[node], e = s + bvh.count[node];
      for (let i = s; i < e; i++) {
        loadTri(bvh, bvh.order[i]);
        const d = segTriDist(p, q, TA, TB, TC);
        if (d < best) { best = d; if (d === 0) return 0; }
      }
    } else {
      // 가까운 자식을 나중에 넣어 먼저 탐색
      const r = bvh.start[node];
      const dl = nodeLowerBound(bvh, l, p, q, sl, sh), dr = nodeLowerBound(bvh, r, p, q, sl, sh);
      if (dl < dr) { stack[sp++] = r; stack[sp++] = l; } else { stack[sp++] = l; stack[sp++] = r; }
    }
  }
  return best < cutoff ? best : Math.min(cutoff, lowest === Infinity ? cutoff : Math.max(lowest, best));
}

// 반직선 o + t·d (t ∈ [0, tmax]) ↔ 메시 첫 교차 t (없으면 Infinity)
export function rayMesh(bvh, o, d, tmax = Infinity) {
  const inv = [1 / d[0], 1 / d[1], 1 / d[2]];
  let best = tmax;
  let sp = 0;
  const stack = bvh.nodes * 2 > STACK.length ? new Int32Array(bvh.nodes * 2) : STACK;
  stack[sp++] = 0;
  const b = bvh.bounds;
  while (sp) {
    const node = stack[--sp], k = node * 6;
    // 슬랩 테스트
    let t0 = 0, t1 = best;
    for (let a = 0; a < 3; a++) {
      let ta = (b[k + a] - o[a]) * inv[a], tb = (b[k + 3 + a] - o[a]) * inv[a];
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (Number.isNaN(ta)) { ta = -Infinity; tb = Infinity; }    // 축과 평행하고 경계면 위
      if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
      if (t0 > t1) break;
    }
    if (t0 > t1) continue;
    const l = bvh.left[node];
    if (l < 0) {
      const s = bvh.start[node], e = s + bvh.count[node];
      for (let i = s; i < e; i++) {
        loadTri(bvh, bvh.order[i]);
        const t = rayTri(o[0], o[1], o[2], d[0], d[1], d[2], TA, TB, TC);
        if (t >= 0 && t < best) best = t;
      }
    } else { stack[sp++] = l; stack[sp++] = bvh.start[node]; }
  }
  return best < tmax ? best : Infinity;
}

// ------------------------------------------------------------------ 월드 배치
// 모델 좌표(파일 단위) v → 월드(mm):  w = t + R·(scale·(unit·U·v + offset))
//   U = 위쪽 축 보정('z' 그대로, 'y' → Y 위 모델을 Z 위로 세움 = Rx(+90°)), R = Rz·Ry·Rx (deg)
// 정리하면  w = p0 + k·Q·v  (Q = R·U 직교행렬, k = scale·unit, p0 = t + scale·R·offset)
const D2R = Math.PI / 180;
export function upMatrix(up) {
  if (up === 'y') return [[1, 0, 0], [0, 0, -1], [0, 1, 0]];
  if (up === 'x') return [[0, 0, -1], [0, 1, 0], [1, 0, 0]];   // +X 위 → Ry(-90°)
  return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
}
export function eulerZYX(rx, ry, rz) {
  const a = rx * D2R, b = ry * D2R, c = rz * D2R;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
  return [
    [cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa],
    [sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa],
    [-sb, cb * sa, cb * ca],
  ];
}
const mul3 = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
const mv = (M, v) => [M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2], M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2], M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2]];

// m: 레이아웃 모델 항목 { x,y,z, rx,ry,rz, scale, unit, up, offset }
export function modelTransform(m) {
  const R = eulerZYX(m.rx || 0, m.ry || 0, m.rz || 0);
  const Q = mul3(R, upMatrix(m.up));
  const s = m.scale || 1, k = s * (m.unit || 1);
  const off = mv(R, m.offset || [0, 0, 0]);
  return { Q, k, p0: [m.x + s * off[0], m.y + s * off[1], m.z + s * off[2]] };
}
export const toWorld = (xf, v) => { const r = mv(xf.Q, v); return [xf.p0[0] + xf.k * r[0], xf.p0[1] + xf.k * r[1], xf.p0[2] + xf.k * r[2]]; };
const toModel = (xf, w) => {
  const x = (w[0] - xf.p0[0]) / xf.k, y = (w[1] - xf.p0[1]) / xf.k, z = (w[2] - xf.p0[2]) / xf.k, Q = xf.Q;
  return [Q[0][0] * x + Q[1][0] * y + Q[2][0] * z, Q[0][1] * x + Q[1][1] * y + Q[2][1] * z, Q[0][2] * x + Q[1][2] * y + Q[2][2] * z];
};

// 간섭 객체: collision.js 의 obstacles 배열에 그대로 넣는다 (c/h/R = 월드 OBB, 빠른 배제용)
export function meshObstacle(id, bvh, m, extra = {}) {
  const xf = modelTransform(m);
  const [lo, hi] = bvh.bbox;
  const cl = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  return { id, mesh: bvh, xf, c: toWorld(xf, cl), R: xf.Q, h: [(hi[0] - lo[0]) / 2 * xf.k, (hi[1] - lo[1]) / 2 * xf.k, (hi[2] - lo[2]) / 2 * xf.k], ...extra };
}

// 월드 선분 ↔ 배치된 메시 거리 (mm). cutoff(mm) 이상은 하한값
export function meshObstacleDist(a, b, ob, cutoff = Infinity) {
  const la = toModel(ob.xf, a), lb = toModel(ob.xf, b);
  return segMeshDist(ob.mesh, la, lb, cutoff / ob.xf.k) * ob.xf.k;
}

// (x,y) 에서 높이 zMax 이하로 내려다볼 때 처음 만나는 모델 윗면 z (없으면 -Infinity)
export function meshObstacleTopZ(ob, x, y, zMax) {
  const top = ob.c[2] + Math.abs(ob.R[2][0]) * ob.h[0] + Math.abs(ob.R[2][1]) * ob.h[1] + Math.abs(ob.R[2][2]) * ob.h[2];
  const z0 = Math.min(zMax, top + 1);
  const bot = ob.c[2] - (top - ob.c[2]);
  if (z0 < bot) return -Infinity;
  const o = toModel(ob.xf, [x, y, z0]);
  const Q = ob.xf.Q, d = [-Q[2][0], -Q[2][1], -Q[2][2]];      // 월드 -Z 를 모델 좌표로
  const t = rayMesh(ob.mesh, o, d, (z0 - bot) / ob.xf.k + 1);
  return t === Infinity ? -Infinity : z0 - t * ob.xf.k;
}
