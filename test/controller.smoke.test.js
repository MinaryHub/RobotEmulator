// 컨트롤러 기본 동작 스모크 테스트: 직선/관절 이동, 공작물 파지·이송·낙하
import { Controller } from '../server/controller.js';

let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  OK ' : '  NG '} ${m}`); if (!c) fail++; };
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const DOWN = [[-1, 0, 0], [0, 1, 0], [0, 0, -1]];

const c = new Controller();
c.setServo(true);

// 1) 직선 이동: 목표 TCP 위치 도달
const p = c.tcpPose();
const tgt = [p.p[0], p.p[1] + 100, p.p[2] - 100];
await c.move({ kind: 'L', target: { pose: { p: tgt, R: p.R } }, speed: { tcp: 250 } });
ok(near(c.tcpPose().p, tgt, 0.5), `직선 이동 도달 ${c.tcpPose().p.map((v) => v.toFixed(2))}`);

// 2) 관절 이동: 목표 관절각 도달
const J = [30, 10, 10, 0, -60, 0];
await c.move({ kind: 'J', target: { joints: J }, speed: { frac: 1 } });
ok(near(c.joints, J, 0.01), `관절 이동 도달 ${c.joints.map((v) => v.toFixed(2))}`);

// 3) 공작물 접근 → DO1 닫기 → 들어 올리기 → DO1 해제(낙하)
const o = c.objects[0];
const z0 = o.pose.p[2];
await c.move({ kind: 'J', target: { pose: { p: [o.pose.p[0], o.pose.p[1], o.pose.p[2] + 100], R: DOWN } }, speed: { frac: 1 } });
await c.move({ kind: 'L', target: { pose: { p: [...o.pose.p], R: DOWN } }, speed: { tcp: 500 } });
c.setDO(1, true);
await c.move({ kind: 'L', target: { pose: { p: [o.pose.p[0], o.pose.p[1], 200], R: DOWN } }, speed: { tcp: 500 } });
ok(c.grip.holding?.id === o.id, `공작물 파지 (${c.grip.holding?.id})`);
ok(o.pose.p[2] > z0 + 50, `공작물 이송 z ${z0.toFixed(1)} → ${o.pose.p[2].toFixed(1)}`);
c.setDO(1, false);
ok(!c.grip.holding, '그리퍼 해제');
ok(Math.abs(o.pose.p[2] - z0) < 1, `공작물 낙하 z ${o.pose.p[2].toFixed(1)}`);

console.log(fail ? `\n${fail}개 실패` : '\n모두 통과');
process.exit(fail ? 1 : 0);
