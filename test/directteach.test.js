// 직접교시 (teachPose / teachJoints): 조건 · 도달 불가 · 자세 급변 · 소프트 리밋 · 간섭(정지/경고 모드)
import { Controller } from '../server/controller.js';
import { quatFromR } from '../shared/math.js';

let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  OK ' : '  NG '} ${m}`); if (!c) fail++; };
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

const c = new Controller();
c.setRobot('yaskawa-gp7');
const t0 = c.tcpPose();
const q0 = quatFromR(t0.R);

ok(!c.teachPose({ p: t0.p, q: q0 }).ok, '서보 OFF: 거부');
c.setServo(true, 'ui');

// 이동: 목표 TCP 도달, 자세 유지
let r = c.teachPose({ p: [t0.p[0] + 40, t0.p[1] - 25, t0.p[2] - 30], q: q0 });
ok(r.ok && near(c.tcpPose().p, [t0.p[0] + 40, t0.p[1] - 25, t0.p[2] - 30], 0.01), `TCP 이동 → ${c.tcpPose().p.map((v) => v.toFixed(1))}`);
ok(near(quatFromR(c.tcpPose().R), q0, 1e-6) || near(quatFromR(c.tcpPose().R), q0.map((v) => -v), 1e-6), 'TCP 자세 유지');

// 거부: 도달 불가 / 자세 급변 / 소프트 리밋
const j1 = [...c.joints];
ok(!c.teachPose({ p: [3000, 0, 0], q: q0 }).ok && near(c.joints, j1, 0), '작업 영역 밖: 거부, 위치 유지');
r = c.teachPose({ p: [t0.p[0], t0.p[1], -400], q: q0 });
ok(!r.ok && /급변|도달|간섭/.test(r.reason), `큰 점프: 거부 (${r.reason})`);
r = c.teachJoints([0, 0, 0, 0, -90, 400]);
ok(!r.ok && /소프트 리밋/.test(r.reason), `관절 한계 밖: 거부 (${r.reason})`);

// 관절 직접 지정
r = c.teachJoints([10, 5, -5, 0, -80, 15]);
ok(r.ok && near(c.joints, [10, 5, -5, 0, -80, 15], 1e-9), '관절 직접 지정');

// 간섭: 정지 모드에서는 테이블 안으로 들어가지 않음, 경고 모드에서는 들어가고 간섭 표시
c.teachJoints([0, 0, 0, 0, -90, 0]);
const top = c.tcpPose();
const qd = quatFromR(top.R);
let z = top.p[2], hitAt = null;
c.setCollisionMode('stop');
for (let i = 0; i < 80; i++) {          // 10 mm 씩 내리기
  r = c.teachPose({ p: [top.p[0], top.p[1], z - 10], q: qd });
  if (!r.ok) { hitAt = r; break; }
  z -= 10;
}
ok(hitAt && hitAt.collision, `정지 모드: 테이블 접촉 직전에서 거부 (z=${z.toFixed(0)}, ${hitAt?.reason})`);
ok(!c.collision.hit && !c.alarms.length, '정지 모드: 간섭 상태·알람 없음');
c.setCollisionMode('warn');
r = c.teachPose({ p: [top.p[0], top.p[1], z - 10], q: qd });
ok(r.ok && c.collision.hit && !c.alarms.length, '경고 모드: 진입 허용, 간섭 표시 (알람 없음)');
c.setCollisionMode('stop');
c.resetAlarms();

// 인터록: TEACH 아니면 거부 / 인에이블 필요 / 비상정지 / 실행 중
c.teachJoints([0, 0, 0, 0, -90, 0]);
c.setMode('PLAY', 'ui');
r = c.teachJoints([5, 0, 0, 0, -90, 0]);
ok(!r.ok && r.code === 11, 'PLAY: 거부 (11)');
c.setMode('TEACH', 'ui');
c.setSafetyOptions({ requireEnable: true });
ok(c.teachJoints([5, 0, 0, 0, -90, 0]).code === 5, '인에이블 OFF: 거부 (5)');
c.setEnableSwitch(true);
ok(c.teachJoints([5, 0, 0, 0, -90, 0]).ok, '인에이블 ON: 허용');
c.setSafetyOptions({ requireEnable: false });
c.setEstop(true, 'ui');
ok(!c.teachJoints([0, 0, 0, 0, -90, 0]).ok, '비상정지: 거부');
c.setEstop(false, 'ui'); c.resetAlarms(); c.setServo(true, 'ui');
c.setTimeScale(10);
await c.start({ source: 'ui' });
ok(!c.teachJoints([0, 0, 0, 0, -90, 0]).ok, '프로그램 실행 중: 거부');
c.stopProgram();
ok(c.teachJoints([0, 0, 0, 0, -90, 0]).ok, '정지 후 다시 가능');

clearInterval(c._timer);
console.log(fail ? `\n${fail}개 실패` : '\n모두 통과');
process.exit(fail ? 1 : 0);
