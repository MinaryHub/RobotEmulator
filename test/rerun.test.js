// 회귀: 브레이크포인트에서 정지(공작물 파지 중) 후 재시작해도 공작물 초기화 → 정상 완료
import { Controller } from '../server/controller.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const c = new Controller();
c.setRobot('yaskawa-gp7'); c.setServo(true);
for (let k = 0; k < 2; k++) {
  console.log('run', k, 'objs', c.objects.map((o) => o.pose.p.map((v) => v.toFixed(0)).join(',')).join(' | '));
  await c.start();
  while (c.vm.status === 'running' || !c.motionIdle) { await sleep(50); if (c.held) { console.log('HELD at', c.vm.current); break; } }
  console.log('status', c.vm.status, 'alarms', c.alarms.map((a) => a.msg), 'cycle', c.cycleStats.last?.total);
  if (c.held) break;
}
// 브레이크포인트 후 정지 → 재시작
c.breakpoints = new Set(['MASTER.JBI:55']);
await c.start();
await sleep(6000);
console.log('bp status', c.vm.status, c.vm.current);
c.stopProgram();
await sleep(200);
c.breakpoints = new Set();
console.log('after stop objs', c.objects.map((o) => o.pose.p.map((v) => v.toFixed(0)).join(',')).join(' | '), 'holding', c.grip.holding?.id);
await c.start();
while (c.vm.status === 'running' || !c.motionIdle) { await sleep(50); if (c.held) { console.log('HELD at', c.vm.current); break; } }
const okFinal = c.vm.status === 'done' && !c.alarms.length;
console.log(okFinal ? '모두 통과' : '실패: 중간 정지 후 재시작이 완료되지 않음', c.vm.status);
process.exit(okFinal ? 0 : 1);
process.exit(0);
