// 컨트롤러 통합: 간섭 진입 시 알람 정지 / 경고 모드 / 알람 후 빠져나오기
import { Controller } from '../server/controller.js';

let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  OK ' : '  NG '} ${m}`); if (!c) fail++; };
const DOWN = [[-1, 0, 0], [0, 1, 0], [0, 0, -1]];

const ctrl = new Controller();
ctrl.setRobot('yaskawa-gp7');
ctrl.setServo(true);
const o = ctrl.objects[0];
const free = [o.pose.p[0], o.pose.p[1] + 120, 0];

// 1) 정지 모드: 테이블 아래로 직선 이동 → COLLISION 알람, 목표 도달 전 정지
await ctrl.move({ kind: 'J', target: { pose: { p: [free[0], free[1], 150], R: DOWN } }, speed: { frac: 0.5 } });
let err = null;
await ctrl.move({ kind: 'L', target: { pose: { p: [free[0], free[1], -80], R: DOWN } }, speed: { tcp: 250 } }).catch((e) => (err = e));
const z = ctrl.tcpPose().p[2];
ok(ctrl.alarms.some((a) => a.code === 'COLLISION'), `정지 모드: COLLISION 알람 (${ctrl.alarms.map((a) => a.msg).join(' / ')})`);
ok(err?.aborted && z > -20 && z < 5, `목표(-80) 전에 정지 (z=${z.toFixed(1)}mm)`);

// 2) 알람 리셋 후 위로 빠져나오는 이동은 허용 (충돌 '진입' 시에만 알람)
ctrl.resetAlarms(); ctrl.setServo(true);
await ctrl.move({ kind: 'L', target: { pose: { p: [free[0], free[1], 150], R: DOWN } }, speed: { tcp: 250 } });
ok(!ctrl.alarms.length && !ctrl.collision.hit, '알람 리셋 후 빠져나오기 가능');

// 3) 경고 모드: 알람 없이 표시만
ctrl.setCollisionMode('warn');
await ctrl.move({ kind: 'L', target: { pose: { p: [free[0], free[1], -30], R: DOWN } }, speed: { tcp: 250 } });
ok(!ctrl.alarms.length && ctrl.collision.hit && ctrl.collision.pairs.some((p) => p.b === 'table'), `경고 모드: 알람 없이 간섭 표시 (${ctrl.collision.pairs.map((p) => p.a + '-' + p.b).join(',')})`);
await ctrl.move({ kind: 'L', target: { pose: { p: [free[0], free[1], 150], R: DOWN } }, speed: { tcp: 250 } });
ok(!ctrl.collision.hit, '빠져나오면 간섭 해제');

// 4) OFF 모드
ctrl.setCollisionMode('off');
await ctrl.move({ kind: 'L', target: { pose: { p: [free[0], free[1], -30], R: DOWN } }, speed: { tcp: 250 } });
ok(!ctrl.collision.hit && !ctrl.alarms.length, 'OFF 모드: 검사 안 함');

console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exit(fail ? 1 : 0);
