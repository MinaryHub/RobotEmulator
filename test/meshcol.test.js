// 메시 정밀 간섭 모듈 테스트: 거리 정확도(전수 비교), BVH 가지치기 일관성, 반직선, 배치 변환, 간소화, .col 형식, 성능
import { simplifyMesh, encodeCol, decodeCol, buildBVH, segMeshDist, segTriDist, rayMesh, meshObstacle, meshObstacleDist, meshObstacleTopZ, modelTransform, toWorld } from '../shared/meshcol.js';
import { checkCollision } from '../shared/collision.js';
import { ROBOTS } from '../shared/robots.js';

let fail = 0;
const ok = (c, msg) => { if (c) console.log('  OK ', msg); else { fail++; console.log('  FAIL', msg); } };
const rnd = (s) => (Math.random() * 2 - 1) * s;

// 구 메시 (UV 구)
function sphere(r, nu = 32, nv = 16, c = [0, 0, 0]) {
  const pos = [], idx = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const th = (j / nv) * Math.PI, ph = (i / nu) * 2 * Math.PI;
    pos.push(c[0] + r * Math.sin(th) * Math.cos(ph), c[1] + r * Math.sin(th) * Math.sin(ph), c[2] + r * Math.cos(th));
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, b = a + nu + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}
// 박스 메시 (중심 c, 반폭 h)
function boxMesh(c, h) {
  const p = [];
  for (const z of [-1, 1]) for (const y of [-1, 1]) for (const x of [-1, 1]) p.push(c[0] + x * h[0], c[1] + y * h[1], c[2] + z * h[2]);
  const f = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const idx = [];
  for (const [a, b, cc, d] of f) idx.push(a, b, cc, a, cc, d);
  return { positions: Float32Array.from(p), indices: Uint32Array.from(idx) };
}

// (1) 선분↔삼각형: 조밀 샘플링(점↔삼각형) 대비
{
  let maxErr = 0;
  for (let n = 0; n < 300; n++) {
    const A = [rnd(100), rnd(100), rnd(100)], B = [rnd(100), rnd(100), rnd(100)], C = [rnd(100), rnd(100), rnd(100)];
    const p = [rnd(200), rnd(200), rnd(200)], q = [rnd(200), rnd(200), rnd(200)];
    const d = segTriDist(p, q, A, B, C);
    // 기준: 선분 위 2000점 × 삼각형 위 조밀 격자
    let best = Infinity;
    const S = 400, G = 60;
    for (let i = 0; i <= S; i++) {
      const t = i / S, x = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
      for (let u = 0; u <= G; u++) for (let v = 0; v <= G - u; v++) {
        const a = u / G, b = v / G, y = [A[0] + (B[0] - A[0]) * a + (C[0] - A[0]) * b, A[1] + (B[1] - A[1]) * a + (C[1] - A[1]) * b, A[2] + (B[2] - A[2]) * a + (C[2] - A[2]) * b];
        const dd = Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
        if (dd < best) best = dd;
      }
      if (n >= 40) break;     // 조밀 비교는 일부만 (시간)
    }
    if (n < 40) maxErr = Math.max(maxErr, d - best);   // 정확값은 샘플 최소보다 작거나 같아야 함
    if (n < 40 && best - d > 6) maxErr = Math.max(maxErr, best - d - 6);
  }
  ok(maxErr < 0.5, `선분↔삼각형 거리: 샘플링 대비 오차 ${maxErr.toFixed(3)}mm`);
}

// (2) BVH 거리 = 전수 탐색 거리
{
  const m = sphere(200, 48, 24);
  const bvh = buildBVH(m.positions, m.indices);
  const tri = (t) => [0, 1, 2].map((k) => { const v = m.indices[t * 3 + k] * 3; return [m.positions[v], m.positions[v + 1], m.positions[v + 2]]; });
  let maxErr = 0, cutOk = true;
  for (let n = 0; n < 200; n++) {
    const p = [rnd(400), rnd(400), rnd(400)], q = [rnd(400), rnd(400), rnd(400)];
    let brute = Infinity;
    for (let t = 0; t < m.indices.length / 3; t++) { const [A, B, C] = tri(t); brute = Math.min(brute, segTriDist(p, q, A, B, C)); }
    const d = segMeshDist(bvh, p, q);
    maxErr = Math.max(maxErr, Math.abs(d - brute));
    const dc = segMeshDist(bvh, p, q, 30);
    if (brute < 30 ? Math.abs(dc - brute) > 1e-6 : dc < 30 - 1e-6 && dc > brute + 1e-6) cutOk = false;
  }
  ok(maxErr < 1e-6, `BVH 거리 = 전수 탐색 (최대 차 ${maxErr.toExponential(1)})`);
  ok(cutOk, 'cutoff: 안쪽은 정확값, 바깥은 cutoff 이상 하한');
  // 구 바깥 점에서 중심 방향 선분: 거리 ≈ |p| - r (다면체 근사 오차 이내)
  const d = segMeshDist(bvh, [500, 0, 0], [400, 0, 0]);
  ok(Math.abs(d - 200) < 2, `구 표면 거리 ${d.toFixed(2)} ≈ 200`);
  ok(segMeshDist(bvh, [-300, 0, 0], [300, 0, 0]) === 0, '관통 선분 → 0');
  ok(segMeshDist(bvh, [0, 0, 0], [10, 0, 0]) > 150, '내부(표면에서 먼) 선분 → 표면까지 거리 (내부 판정 없음)');
}

// (3) 반직선
{
  const m = boxMesh([0, 0, 50], [100, 80, 50]);
  const bvh = buildBVH(m.positions, m.indices);
  ok(Math.abs(rayMesh(bvh, [10, 10, 500], [0, 0, -1]) - 400) < 1e-6, '반직선: 박스 윗면 z=100');
  ok(rayMesh(bvh, [300, 0, 500], [0, 0, -1]) === Infinity, '반직선: 빗나감 → Infinity');
  ok(rayMesh(bvh, [10, 10, 500], [0, 0, -1], 100) === Infinity, '반직선: tmax 이내 없음');
}

// (4) 배치 변환: 단위·배율·위쪽 축·회전·오프셋
{
  const m = { x: 1000, y: 200, z: -300, rx: 0, ry: 0, rz: 90, scale: 2, unit: 1000, up: 'y', offset: [5, 0, 0] };
  const xf = modelTransform(m);
  // 모델(Y 위, m 단위) 점 (0, 1, 0) = 위로 1 m → up 보정 후 +Z 1000mm, 배율 2 → 2000mm
  const w = toWorld(xf, [0, 1, 0]);
  // offset (5,0,0)mm 를 Rz(90) → (0,5,0), ×2 → (0,10,0)
  ok(Math.abs(w[0] - 1000) < 1e-6 && Math.abs(w[1] - 210) < 1e-6 && Math.abs(w[2] - 1700) < 1e-6, `toWorld: ${w.map((v) => v.toFixed(1))}`);
  const box = boxMesh([0, 0.5, 0], [0.1, 0.5, 0.1]);       // Y 위로 서 있는 0.2×1×0.2 m 기둥
  const bvh = buildBVH(box.positions, box.indices);
  const ob = meshObstacle('M1', bvh, { ...m, scale: 1, offset: [0, 0, 0] });
  ok(Math.abs(meshObstacleTopZ(ob, 1000, 200, Infinity) - 700) < 1e-3, `세운 기둥 윗면 z = ${meshObstacleTopZ(ob, 1000, 200, Infinity).toFixed(2)} (-300 + 1000)`);
  ok(meshObstacleTopZ(ob, 1500, 200, Infinity) === -Infinity, '기둥 밖 → 지지면 없음');
  // 장비 내부(z=0)에서 놓으면 그 아래 면(기둥 바닥 z=-300)에 안착 — 인클로저 안 작업대에 놓는 경우와 같음
  ok(Math.abs(meshObstacleTopZ(ob, 1000, 200, 0) + 300) < 1e-3, 'zMax 아래 첫 면 = 내부 바닥면');
  ok(meshObstacleTopZ(ob, 1000, 200, -400) === -Infinity, '모델 아래 → 지지면 없음');
  // 기둥 옆면(x=±100mm)에서 50mm 떨어진 수직 선분
  const d = meshObstacleDist([1150, 200, -200], [1150, 200, 500], ob);
  ok(Math.abs(d - 50) < 1e-3, `월드 거리 ${d.toFixed(3)} = 50`);
}

// (5) 간소화 + .col 왕복
{
  const m = sphere(300, 256, 128);                       // 약 6.5만 삼각형
  const s = simplifyMesh(m.positions, m.indices, 5000);
  ok(s.indices.length / 3 <= 5000 && s.indices.length / 3 > 1000, `간소화: ${m.indices.length / 3} → ${s.indices.length / 3} 삼각형`);
  const bvh = buildBVH(s.positions, s.indices);
  const d = segMeshDist(bvh, [600, 0, 0], [500, 0, 0]);
  ok(Math.abs(d - 200) < s.cell * 2 + 2, `간소화 후 거리 ${d.toFixed(1)} ≈ 200 (격자 ${s.cell.toFixed(1)}mm)`);
  // 비색인 입력(STL 처럼 3정점씩)도 중복 정점 병합
  const flat = new Float32Array(m.indices.length * 3);
  m.indices.forEach((v, i) => flat.set(m.positions.subarray(v * 3, v * 3 + 3), i * 3));
  const s2 = simplifyMesh(flat, null, 1e9);
  ok(s2.positions.length < flat.length / 4, `비색인 메시 정점 병합: ${flat.length / 3} → ${s2.positions.length / 3}`);
  const buf = encodeCol(s.positions, s.indices);
  const back = decodeCol(new Uint8Array(buf));
  ok(back.positions.length === s.positions.length && back.indices.every((v, i) => v === s.indices[i]), '.col 왕복');
  let threw = 0;
  for (const badBuf of [new Uint8Array(4), new Uint8Array(buf).slice(0, buf.byteLength - 4), (() => { const b = new Uint8Array(buf.slice(0)); new DataView(b.buffer).setUint32(16 + back.positions.length * 4, 1e9, true); return b; })()]) {
    try { decodeCol(badBuf); } catch { threw++; }
  }
  ok(threw === 3, '.col 손상(짧음/크기 불일치/인덱스 범위) 거부');
}

// (6) checkCollision 연동 + 성능
{
  const model = ROBOTS.find((r) => r.id === 'yaskawa-gp7');
  const big = sphere(150, 400, 200);                     // 16만 삼각형
  const bvh = buildBVH(big.positions, big.indices);
  const scene = { floorZ: -400, table: null, pedestal: { d: 200, h: 400 } };
  // 홈 자세 손목 근처에 구 배치 → 충돌, 멀리 → 비충돌
  const capsWrist = checkCollision(model, model.home, 'robotiq-2f85', scene, [], {}).capsules.find((c) => c.id === 'wrist');
  const at = (p) => meshObstacle('MDL', bvh, { x: p[0], y: p[1], z: p[2], scale: 1, unit: 1, up: 'z', offset: [0, 0, 0] });
  const hit = checkCollision(model, model.home, 'robotiq-2f85', scene, [], { obstacles: [at(capsWrist.a)] });
  ok(hit.pairs.some((p) => p.b === 'MDL'), `손목 위치 모델 → 간섭 (${hit.pairs.map((p) => p.a + '-' + p.b).join(',')})`);
  const far = checkCollision(model, model.home, 'robotiq-2f85', scene, [], { obstacles: [at([2000, 2000, 0])] });
  ok(!far.pairs.some((p) => p.b === 'MDL'), '먼 모델 → 간섭 없음');
  // 표면 바로 옆을 지나는 자세 (근접, 최악에 가까운 경우) 성능
  const ob = at([capsWrist.a[0] + 150 + 60, capsWrist.a[1], capsWrist.a[2]]);
  const N = 300, t0 = performance.now();
  for (let i = 0; i < N; i++) checkCollision(model, model.home, 'robotiq-2f85', scene, [], { obstacles: [ob] });
  const ms = (performance.now() - t0) / N;
  ok(ms < 2, `16만 삼각형 근접 검사 ${ms.toFixed(3)} ms/회 (< 2ms, 틱 주기 대비 여유)`);
}

console.log('[퇴화 메시 BVH]');
{
  // 모든 삼각형 중심이 같은 메시 → 잎이 하나로 뭉치면 매 검사가 전수 탐색이 됨
  const n = 50000, pos = new Float32Array(n * 9), idx = new Uint32Array(n * 3);
  for (let i = 0; i < n; i++) { pos.set([-1, -1, 0, 1, -1, 0, 0, 2, 0], i * 9); idx.set([i * 3, i * 3 + 1, i * 3 + 2], i * 3); }
  const b = buildBVH(pos, idx);
  let maxLeaf = 0;
  for (let i = 0; i < b.nodes; i++) if (b.left[i] === -1) maxLeaf = Math.max(maxLeaf, b.count[i]);
  ok(maxLeaf <= 8, `중심이 모두 같아도 잎 크기 ≤ 8 (최대 ${maxLeaf})`);
  ok(Math.abs(segMeshDist(b, [0, 0, 100], [0, 0, 50]) - 50) < 1e-3, '퇴화 메시 거리 정확');
}

console.log(fail ? `\n${fail}건 실패` : '\n모두 통과');
process.exit(fail ? 1 : 0);
