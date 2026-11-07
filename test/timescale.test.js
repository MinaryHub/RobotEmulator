// 배속(timeScale): 실제 소요 시간은 배속에 반비례, 시뮬레이션 사이클 타임·결과는 1배속과 같아야 한다
import { Controller } from '../server/controller.js';

let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  OK ' : '  NG '} ${m}`); if (!c) fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runCycle(robot, scale) {
  const c = new Controller();
  c.setRobot(robot);
  c.setServo(true);
  c.setTimeScale(scale);
  const t0 = performance.now();
  await c.start();
  while (c.vm.status === 'running' || !c.motionIdle) await sleep(20);
  const real = (performance.now() - t0) / 1000;
  const r = { real, sim: c.cycleStats.last?.total, status: c.vm.status, alarms: c.alarms.map((a) => a.msg), objs: c.objects.map((o) => o.pose.p.map((v) => Math.round(v)).join(',')).join(' | ') };
  clearInterval(c._timer);
  return r;
}

// 1) 기본 예제 1사이클: 1배속 vs 8배속
for (const robot of ['yaskawa-gp7', 'abb-irb1200']) {
  const a = await runCycle(robot, 1);
  const b = await runCycle(robot, 8);
  console.log(`${robot}: x1 real ${a.real.toFixed(2)}s sim ${a.sim}s | x8 real ${b.real.toFixed(2)}s sim ${b.sim}s`);
  ok(a.status === 'done' && b.status === 'done' && !a.alarms.length && !b.alarms.length, `${robot} 두 배속 모두 정상 완료 ${b.alarms.join(';')}`);
  ok(Math.abs(a.sim - b.sim) <= Math.max(0.15, a.sim * 0.03), `${robot} 사이클 타임 동일 (x1 ${a.sim}s, x8 ${b.sim}s)`);
  ok(b.real < a.real / 4, `${robot} 8배속 실제 시간 단축 (${a.real.toFixed(2)}s → ${b.real.toFixed(2)}s)`);
  ok(a.objs === b.objs, `${robot} 공작물 최종 위치 동일`);
}

// 2) 대기·타이머: 시뮬레이션 시계 기준
{
  const c = new Controller();
  c.setTimeScale(5);
  const s0 = c.simMs, t0 = performance.now();
  await c.sleep(1.0);
  const sim = (c.simMs - s0) / 1000, real = (performance.now() - t0) / 1000;
  ok(sim >= 1.0 && sim < 1.05, `sleep(1s) 시뮬레이션 ${sim.toFixed(3)}s`);
  ok(real < 0.4, `sleep(1s) @x5 실제 ${real.toFixed(3)}s`);
  // 조건 대기 타임아웃
  const r = await c.waitFor(() => false, 0.5);
  ok(r === false, 'waitFor 타임아웃 → false');
  // after(): 펄스
  c.setDO(5, true);
  c.after(0.3, () => c.setDO(5, false));
  await c.sleep(0.2); ok(c.getDO(5) === true, 'after 0.3s: 0.2s 시점 아직 ON');
  await c.sleep(0.2); ok(c.getDO(5) === false, 'after 0.3s: 0.4s 시점 OFF');
  // HOLD 중 시계·모션 정지 (이동 중 HOLD)
  c.setServo(true);
  const mv = c.move({ kind: 'J', target: { joints: [40, 10, 10, 0, -30, 0] }, speed: { frac: 0.2 } });
  await c.sleep(0.2);
  c.hold();
  const h0 = c.simMs, j0 = c.joints.join(); await sleep(150);
  ok(c.simMs === h0 && c.joints.join() === j0, 'HOLD 중 시뮬레이션 시계·모션 정지');
  c.resume();
  await mv;
  ok(c.joints[0] > 39.99, 'HOLD 해제 후 이동 완료');
  // 범위 제한
  c.setTimeScale(100); ok(c.timeScale === 10, '최대 10배속 제한');
  c.setTimeScale(0.01); ok(c.timeScale === 0.1, '최소 0.1배속 제한');
  clearInterval(c._timer);
}

console.log(fail ? `\n${fail}개 실패` : '\n모두 통과');
process.exit(fail ? 1 : 0);
