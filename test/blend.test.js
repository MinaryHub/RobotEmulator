// 블렌딩(경유점 근사) + 사이클 타임 측정 테스트
import { Controller } from '../server/controller.js';

let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  OK ' : '  NG '} ${m}`); if (!c) fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function runProgram(ctrl) {
  await ctrl.start();
  while (ctrl.vm.status === 'running' || ctrl.vm.status === 'paused' || !ctrl.motionIdle) await sleep(20);
  await sleep(50);
  return ctrl.cycleStats.last;
}

// 1) RAPID: 같은 사각 경로를 fine vs z50 으로 실행 → 블렌딩 쪽이 빨라야 하고 코너를 덜 지나야 함
const ctrl = new Controller();
ctrl.setRobot('abb-irb2600');
ctrl.setServo(true);
const mod = (z) => `MODULE M
  PROC main()
    VAR robtarget p;
    p := CRobT(\\Tool:=tool0);
    MoveL Offs(p, 0, 300, 0), v1000, ${z}, tool0;
    MoveL Offs(p, 300, 300, 0), v1000, ${z}, tool0;
    MoveL Offs(p, 300, 0, 0), v1000, ${z}, tool0;
    MoveL Offs(p, 0, 0, 0), v1000, fine, tool0;
  ENDPROC
ENDMODULE`;
// 코너 최소거리 측정
let minCorner = Infinity, corner = null;
ctrl.on('state', () => { if (corner) { const p = ctrl.flangePose().p; minCorner = Math.min(minCorner, Math.hypot(p[0] - corner[0], p[1] - corner[1], p[2] - corner[2])); } });
const tick = setInterval(() => ctrl.emit('state'), 5);

ctrl.loadFiles({ 'M.mod': mod('fine') }, true);
const home = ctrl.flangePose().p;
corner = [home[0], home[1] + 300, home[2]];
const tFine = (await runProgram(ctrl)).total;
const dFine = minCorner;
ctrl.loadFiles({ 'M.mod': mod('z50') }, true);
minCorner = Infinity;
const last = await runProgram(ctrl);
const tZone = last.total;
ok(tZone < tFine * 0.9, `블렌딩 사이클 단축: fine ${tFine.toFixed(2)}s → z50 ${tZone.toFixed(2)}s`);
ok(dFine < 1, `fine 은 코너 통과 (최소거리 ${dFine.toFixed(2)}mm)`);
ok(minCorner > 5 && minCorner < 60, `z50 은 코너를 둥글게 통과 (최소거리 ${minCorner.toFixed(1)}mm)`);
ok(last.motion > 0 && last.lines.length > 0 && last.moves === 4, `사이클 통계 (모션 ${last.motion}s, 이동 ${last.moves}회, 라인 ${last.lines.length})`);
const endP = ctrl.flangePose().p;
ok(Math.hypot(endP[0] - home[0], endP[1] - home[1], endP[2] - home[2]) < 0.01, '마지막 fine 점에 정확히 도달');

// 2) 블렌딩 OFF 비교 스위치
ctrl.blendEnabled = false;
const tOff = (await runProgram(ctrl)).total;
ok(Math.abs(tOff - tFine) < 0.35, `블렌딩 OFF 시 fine 과 동일 (${tOff.toFixed(2)}s)`);
ctrl.blendEnabled = true;

// 3) HOLD 시간은 사이클 타임에서 제외
await ctrl.start();
await sleep(300); ctrl.hold(); await sleep(800); ctrl.resume();
while (ctrl.vm.status === 'running' || !ctrl.motionIdle) await sleep(20);
await sleep(50);
const tHold = ctrl.cycleStats.last.total;
ok(Math.abs(tHold - tZone) < 0.35, `HOLD 시간 제외 (${tHold.toFixed(2)}s ≈ ${tZone.toFixed(2)}s)`);

// 4) 각 제조사 예제가 블렌딩 상태에서도 정상 완료 + 사이클 기록
for (const id of ['yaskawa-gp7', 'kawasaki-rs007n', 'hyundai-hh7', 'abb-irb1200', 'kuka-kr6-r900']) {
  const c = new Controller();
  c.setRobot(id); c.setServo(true);
  const before = c.objects.map((o) => o.pose.p.join());
  const st = await (async () => { await c.start(); while (c.vm.status === 'running' || !c.motionIdle) await sleep(30); await sleep(50); return c.cycleStats.last; })();
  const moved = c.objects.filter((o, i) => o.pose.p.join() !== before[i]).length;
  ok(c.vm.status === 'done' && !c.alarms.length && moved === 4 && st?.total > 0, `${id}: 예제 완료, 공작물 ${moved}/4, 사이클 ${st?.total}s ${c.alarms.map((a) => a.msg).join()}`);
}
clearInterval(tick);
console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exit(fail ? 1 : 0);
