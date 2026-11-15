// 충돌 검사 모듈 테스트: 오검출 없음(홈/파지 자세), 검출(테이블 관통/접힘 자세), 정확도, 성능
import { ROBOTS } from '../shared/robots.js';
import { GRIPPERS } from '../shared/grippers.js';
import { ikNearest, tcpToFlange, fromOpw, withinLimits } from '../shared/kinematics.js';
import { Rz, Rx, Ry, mul3 } from '../shared/math.js';
import { checkCollision, robotCapsules, segBoxDist, segSegDist, segCylDist, linkRadius } from '../shared/collision.js';
import { Controller } from '../server/controller.js';

let fail = 0;
const bad = (msg) => { fail++; console.log('  FAIL', msg); };
const fmtPairs = (r) => r.pairs.map((p) => `${p.a}-${p.b}(${p.dist.toFixed(1)})`).join(', ');

const ctrl = new Controller();
clearInterval(ctrl._timer);
ctrl.setGripper?.('robotiq-2f85');
const DOWN = [[-1, 0, 0], [0, 1, 0], [0, 0, -1]];

// ---------------------------------------------------------------- (0) 기하 정확도 (무작위 vs 조밀 샘플링)
{
  const rnd = (s) => (Math.random() * 2 - 1) * s;
  let maxErrBox = 0, maxErrSeg = 0, maxErrCyl = 0;
  const N = 400, S = 20000;
  for (let n = 0; n < N; n++) {
    const a = [rnd(300), rnd(300), rnd(300)], b = [rnd(300), rnd(300), rnd(300)];
    const R = mul3(mul3(Rz(rnd(3)), Ry(rnd(3))), Rx(rnd(3)));
    const box = { c: [rnd(50), rnd(50), rnd(50)], R, h: [10 + Math.random() * 100, 10 + Math.random() * 100, 10 + Math.random() * 100] };
    const c = [rnd(300), rnd(300), rnd(300)], d = [rnd(300), rnd(300), rnd(300)];
    let bestBox = Infinity, bestSeg = Infinity, bestCyl = Infinity;
    for (let i = 0; i <= S; i++) {
      const t = i / S;
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      // 점-OBB
      const x = p[0] - box.c[0], y = p[1] - box.c[1], z = p[2] - box.c[2];
      const l = [0, 1, 2].map((k) => R[0][k] * x + R[1][k] * y + R[2][k] * z);
      const o = l.map((v, k) => Math.max(0, Math.abs(v) - box.h[k]));
      bestBox = Math.min(bestBox, Math.hypot(...o));
      // 점-선분 (c,d) 근사: 선분 c-d 도 정밀 투영
      const dx = d[0] - c[0], dy = d[1] - c[1], dz = d[2] - c[2];
      const tt = Math.max(0, Math.min(1, ((p[0] - c[0]) * dx + (p[1] - c[1]) * dy + (p[2] - c[2]) * dz) / (dx * dx + dy * dy + dz * dz)));
      bestSeg = Math.min(bestSeg, Math.hypot(c[0] + dx * tt - p[0], c[1] + dy * tt - p[1], c[2] + dz * tt - p[2]));
      // 점-원기둥 (반경 80, z -200~0)
      const dr = Math.max(0, Math.hypot(p[0], p[1]) - 80), dzz = p[2] > 0 ? p[2] : p[2] < -200 ? -200 - p[2] : 0;
      bestCyl = Math.min(bestCyl, Math.hypot(dr, dzz));
    }
    maxErrBox = Math.max(maxErrBox, Math.abs(segBoxDist(a, b, box) - bestBox));
    maxErrSeg = Math.max(maxErrSeg, Math.abs(segSegDist(a, b, c, d) - bestSeg));
    maxErrCyl = Math.max(maxErrCyl, Math.abs(segCylDist(a, b, 0, 0, 80, -200, 0) - bestCyl));
  }
  console.log(`정확도 (조밀샘플링 대비 최대 오차, ${N}건): 선분-OBB ${maxErrBox.toFixed(4)} mm, 선분-선분 ${maxErrSeg.toFixed(4)} mm, 선분-원기둥 ${maxErrCyl.toFixed(4)} mm`);
  // 조밀 샘플링 자체 오차(≈ 선분길이/S·0.5 ≈ 0.03mm) 포함
  if (maxErrBox > 0.1 || maxErrSeg > 0.1 || maxErrCyl > 0.1) bad('geometry accuracy');
}

// ---------------------------------------------------------------- (a)(b)(c)(d) 모델별
console.log('\nmodel                 r    home minDist  pick minDist (worst)   below-table        fold');
for (const m of ROBOTS) {
  ctrl.setRobot(m.id);
  const scene = ctrl.scene, objects = ctrl.objects, gripper = ctrl.gripper, tool = ctrl.tool;
  let line = m.id.padEnd(20) + String(Math.round(linkRadius(m))).padStart(4);

  // (a) 홈 자세
  const home = checkCollision(m, m.home, gripper, scene, objects);
  line += home.minDist.toFixed(1).padStart(14);
  if (home.hit) bad(`${m.id} home: ${fmtPairs(home)}`);

  // (b) 공작물 위(접근) / 파지 높이 — 공작물 각각
  let worst = Infinity;
  for (const o of objects) {
    const s = o.size[2];
    for (const dz of [150, 50, 0]) {
      const pose = { p: [o.pose.p[0], o.pose.p[1], o.pose.p[2] + dz], R: DOWN };
      const j = ikNearest(m, tcpToFlange(pose, tool, null), m.home);
      if (!j) { bad(`${m.id} ${o.id} dz=${dz}: IK 실패`); continue; }
      // 파지 높이(dz=0)에서는 해당 공작물을 쥐는 중이므로 다른 공작물만 검사해도 되지만,
      // 링크↔공작물 규칙상 툴은 공작물 검사를 하지 않으므로 무시 목록 없이 검사
      const r = checkCollision(m, j, gripper, scene, objects);
      worst = Math.min(worst, r.minDist);
      if (r.hit) bad(`${m.id} ${o.id} dz=${dz} (s=${s}): ${fmtPairs(r)}`);
    }
  }
  line += worst.toFixed(1).padStart(14);

  // (c) TCP 를 테이블 면 아래(z=-50)로 → tool/wrist ↔ table
  {
    const t = scene.table;
    const pose = { p: [t.x, t.y, -50], R: DOWN };
    const j = ikNearest(m, tcpToFlange(pose, tool, null), m.home);
    if (!j) bad(`${m.id} below-table IK 실패`);
    else {
      const r = checkCollision(m, j, gripper, scene, objects);
      const ok = r.pairs.some((p) => (p.a === 'tool' || p.a === 'wrist') && p.b === 'table');
      line += ('  ' + (ok ? 'hit ' : 'MISS ') + r.pairs.filter((p) => p.b === 'table').map((p) => p.a).join('/')).padEnd(19);
      if (!ok) bad(`${m.id} below-table not detected: ${fmtPairs(r)}`);
      // 경계: TCP z = 0 (테이블 면) 은 오검출 없어야 함
      const j0 = ikNearest(m, tcpToFlange({ p: [t.x, t.y, 0], R: DOWN }, tool, null), m.home);
      const r0 = j0 && checkCollision(m, j0, gripper, scene, objects);
      if (r0?.hit) bad(`${m.id} TCP z=0 on table falsely flagged: ${fmtPairs(r0)}`);
    }
  }

  // (d) 전완을 베이스 쪽으로 접은 자세: 하완 수직(q2=0), 전완이 아래를 향하도록 q3≈π-ψ, 툴은 아래로
  {
    const k = m.opw, psi = Math.atan2(k.a2, k.c3);
    let found = null;
    for (const d3 of [0.15, 0.3, 0.45]) {
      for (const q5 of [0, 0.5, -0.5]) {
        const q = [0, 0, Math.PI - psi - d3, 0, q5, 0];
        const j = fromOpw(m, q);
        const r = checkCollision(m, j, gripper, scene, objects);
        const self = r.pairs.filter((p) => p.type === 'self');
        if (self.length) { found = { r, j, self }; break; }
      }
      if (found) break;
    }
    // 소형 로봇은 전완을 접으면 손목이 베이스에 닿아야 함.
    // 예외: HH012A — 어깨 오프셋 a1=200 으로 접힌 손목이 J1 축 앞 약 300 mm 에 놓여 실제로도 베이스와 닿지 않음
    const FOLD_EXEMPT = new Set(['hyundai-hh012a']);
    const small = m.reach < 1500 && !FOLD_EXEMPT.has(m.id);
    line += '  ' + (found ? 'self: ' + found.self.map((p) => p.a + '-' + p.b).join(',') : 'none');
    if (small && !found) bad(`${m.id} folded pose not flagged as self collision`);
  }
  console.log(line);
}

// ---------------------------------------------------------------- 참고: 다른 그리퍼로 파지 자세 오검출 여부 (정보용, 실패 처리 안 함)
{
  const notes = [];
  for (const g of GRIPPERS) {
    if (g.kind === 'none' || g.kind === 'torch' || g.kind === 'spindle') continue;
    ctrl.setGripper(g.id);
    let n = 0, hit = 0;
    for (const m of ROBOTS) {
      ctrl.setRobot(m.id);
      for (const o of ctrl.objects) for (const dz of [150, 0]) {
        const pose = { p: [o.pose.p[0], o.pose.p[1], o.pose.p[2] + dz], R: DOWN };
        const j = ikNearest(m, tcpToFlange(pose, ctrl.tool, null), m.home);
        if (!j) continue;
        n++;
        const r = checkCollision(m, j, ctrl.gripper, ctrl.scene, ctrl.objects);
        if (r.hit) { hit++; if (notes.length < 8) notes.push(`${g.id}/${m.id}/${o.id}/dz${dz}: ${fmtPairs(r)}`); }
      }
    }
    console.log(`그리퍼 ${g.id.padEnd(16)} 파지 자세 ${n}건 중 충돌 ${hit}`);
  }
  for (const s of notes) console.log('   ', s);
  ctrl.setGripper('robotiq-2f85');
}

// ---------------------------------------------------------------- (e) 성능
{
  const m = ROBOTS.find((r) => r.id === 'yaskawa-gp7');
  ctrl.setRobot(m.id);
  const configs = [];
  for (let i = 0; i < 1000; i++) configs.push(m.limits.map(([lo, hi]) => lo + Math.random() * (hi - lo)));
  const run = (n) => { let h = 0; for (let i = 0; i < n; i++) if (checkCollision(m, configs[i % 1000], ctrl.gripper, ctrl.scene, ctrl.objects).hit) h++; return h; };
  run(5000); // 워밍업
  const N = 50000;
  const t0 = performance.now();
  const hits = run(N);
  const us = ((performance.now() - t0) / N) * 1000;
  // 정상 자세(홈) 기준
  const t1 = performance.now();
  for (let i = 0; i < N; i++) checkCollision(m, m.home, ctrl.gripper, ctrl.scene, ctrl.objects);
  const usHome = ((performance.now() - t1) / N) * 1000;
  console.log(`\n성능: checkCollision 평균 ${us.toFixed(1)} µs (무작위 자세, 충돌 ${((hits / N) * 100).toFixed(0)}%), 홈 자세 ${usHome.toFixed(1)} µs, 캡슐 ${robotCapsules(m, m.home, ctrl.gripper).length}개, 공작물 ${ctrl.objects.length}개`);
  if (us > 300 || usHome > 300) bad('performance > 0.3 ms');
}

console.log(fail ? `\n${fail}건 실패` : '\n모두 통과');
process.exit(fail ? 1 : 0);
