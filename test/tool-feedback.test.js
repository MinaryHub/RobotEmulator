// 파지 기능이 없는 툴(용접 토치·스핀들·없음)도 닫기/열기 DO 에 피드백 DI 로 응답해야 함
// (그리퍼용 예제 프로그램의 WAIT DI 가 최대 대기 시간 초과로 멈추지 않도록). 공작물은 집지 않음
import { Controller } from '../server/controller.js';

let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  OK ' : '  NG '} ${m}`); if (!c) fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctrl = new Controller();
for (const id of ['torch-22', 'spindle', 'none']) {
  const g = (await import('../shared/grippers.js')).GRIPPERS.find((x) => x.id === id) ? id : null;
  if (!g) { ok(false, `그리퍼 id 없음: ${id}`); continue; }
  ctrl.setGripper(id);
  const io = ctrl.gripperIO;
  ctrl.setDO(io.open, false);
  ctrl.setDO(io.close, true);
  await sleep(700);
  ok(ctrl.io.di[io.fbClosed] && !ctrl.io.di[io.fbOpen] && !ctrl.grip.holding, `${id}: 닫기 → 닫힘 DI ON, 공작물 파지 없음`);
  ctrl.setDO(io.close, false);
  ctrl.setDO(io.open, true);
  await sleep(700);
  ok(!ctrl.io.di[io.fbClosed] && ctrl.io.di[io.fbOpen], `${id}: 열기 → 열림 DI ON`);
  ctrl.setDO(io.open, false);
}

clearInterval(ctrl._timer);
console.log(fail ? `\n${fail}건 실패` : '\n모두 통과');
process.exit(fail ? 1 : 0);
