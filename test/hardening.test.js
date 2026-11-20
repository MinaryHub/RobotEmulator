// 견고성 회귀 테스트 — 잘못된 입력·악의적 요청으로 서버가 죽거나 멈추지 않는지
//   node test/hardening.test.js
import net from 'node:net';
import dgram from 'node:dgram';
import http from 'node:http';
import { Controller } from '../server/controller.js';
import { startAll, closeAll } from '../server/protocols/index.js';
import { hostAllowed, originAllowed } from '../server/netguard.js';
import { buildResponse } from '../server/protocols/kuka-varproxy.js';
import { ROBOTS } from '../shared/robots.js';
import { fkFlange, ikNearest } from '../shared/kinematics.js';
import { request as hseRequest, parseResponse as hseParse } from '../tools/clients/yaskawa-hse-client.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ✔ ${msg}`); } else { fail++; console.log(`  ✘ ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function section(title, fn) {
  console.log(`\n■ ${title}`);
  try { await fn(); } catch (e) { fail++; console.log(`  ✘ 예외: ${e.stack || e.message}`); }
}
process.on('unhandledRejection', (e) => { fail++; console.log(`  ✘ 처리되지 않은 거부: ${e?.message ?? e}`); });

const ctrl = new Controller();

// 프로그램을 실행하고 (최대 ms) 결과 상태·프로그램 로그를 돌려줌
async function runProgram(robot, file, src, ms = 5000) {
  ctrl.setRobot(robot);
  ctrl.resetAlarms();
  ctrl.loadFiles({ [file]: src }, true);
  if (ctrl.compileError) return { status: 'compile', msg: ctrl.compileError.msg };
  ctrl.setServo(true, 'ui');
  const logs = [];
  const h = (e) => logs.push(e.msg);
  ctrl.on('log', h);
  ctrl.vm.reset();
  const p = ctrl.vm.run();
  await Promise.race([p, sleep(ms)]);
  ctrl.off('log', h);
  const status = ctrl.vm.status;
  if (status === 'running') { ctrl.stopProgram(); await p; }
  return { status, logs };
}

await section('VM: 동작 없는 반복문이 이벤트 루프를 막지 않음', async () => {
  let ticks = 0;
  const iv = setInterval(() => ticks++, 10);
  const t0 = Date.now();
  // 입력 대기 폴링 루프 — 다른 곳(타이머)에서 DI 를 켜야 끝남. 양보하지 않으면 영원히 멈춤
  setTimeout(() => ctrl.setDI(3, true), 200);
  const r = await runProgram('doosan-m1013', 'main.drl', 'while True:\n    if get_digital_input(3):\n        break\ntp_log("got")\n', 4000);
  clearInterval(iv);
  ctrl.setDI(3, false);
  ok(r.status === 'done' && r.logs.includes('got'), `폴링 루프가 외부 입력으로 종료 (${r.status}, ${Date.now() - t0}ms)`);
  ok(ticks >= 10, `루프 중에도 타이머 동작 (${ticks}회)`);
});

await section('VM: 무한 재귀 → 알람 (프로세스 유지)', async () => {
  const r = await runProgram('abb-irb1200', 'MainModule.mod', 'MODULE MainModule\n  PROC main()\n    sub;\n  ENDPROC\n  PROC sub()\n    main;\n  ENDPROC\nENDMODULE\n');
  ok(r.status === 'error' && ctrl.alarms.some((a) => a.code === 'STACK'), `RAPID 상호 재귀 → STACK 알람 (${r.status})`);
});

await section('DRL: and / or / 조건식 단락 평가', async () => {
  let r = await runProgram('doosan-m1013', 'main.drl', 'def fact(n):\n    return 1 if n <= 1 else n * fact(n - 1)\ntp_log(str(fact(10)))\n');
  ok(r.status === 'done' && r.logs.includes('3628800'), '재귀 팩토리얼 (조건식)');
  r = await runProgram('doosan-m1013', 'main.drl', 'cnt = 0\ndef pick():\n    global cnt\n    cnt += 1\n    return True\ndef first(a):\n    return a[0]\nlst = []\nif len(lst) > 0 and first(lst) == 1:\n    tp_log("bad")\nready = False\nif ready and pick():\n    tp_log("bad")\nr = ready or pick()\ntp_log("cnt=" + str(cnt) + " r=" + str(r))\n');
  ok(r.status === 'done' && r.logs.includes('cnt=1 r=True') && !r.logs.includes('bad'), `and 는 앞이 거짓이면 뒤를 호출하지 않음 (${r.logs.filter((l) => /cnt|bad/.test(l)).join(',')})`);
});

await section('컨트롤러 입력 검사', async () => {
  ctrl.setRobot('kuka-kr6-r900');
  ctrl.resetAlarms();
  ctrl.setServo(true, 'ui');
  const before = [...ctrl.joints];
  let err = null;
  await ctrl.move({ kind: 'J', target: { joints: [10, 0, 0, 0, -90] }, speed: { frac: 0.3 } }).catch((e) => (err = e));
  ok(err?.code === 'BAD_TARGET' && ctrl.joints.every(Number.isFinite), `관절 5개 → BAD_TARGET (${err?.code})`);
  err = null;
  await ctrl.move({ kind: 'J', target: { joints: before }, speed: { frac: 'fast' } }).catch((e) => (err = e));
  ok(err?.code === 'BAD_SPEED' && ctrl.joints.every(Number.isFinite), '문자열 속도 → BAD_SPEED');
  ctrl.setOverride(0);
  ok(ctrl.override === 1, `오버라이드 0 → 1% (${ctrl.override})`);
  ctrl.setOverride('abc');
  ok(ctrl.override === 1, '숫자가 아닌 오버라이드는 무시');
  ctrl.setOverride(100);
  const t = await Promise.race([ctrl.sleep(NaN).then(() => 'ok'), sleep(500).then(() => 'hang')]);
  ok(t === 'ok', 'sleep(NaN) 이 영원히 멈추지 않음');
  ok(ctrl.teachPose({ p: [400, 0, 400] }, 'ui').ok === false, 'teachPose: q 없음 → 오류 응답 (예외 아님)');
  let thrown = null;
  try { ctrl.loadFiles({ undefined: 'x' }); } catch (e) { thrown = e; }
  ok(/파일 이름/.test(thrown?.message), "파일 이름 'undefined' 거부");
  thrown = null;
  try { ctrl.loadFiles({ 'a/b.src': 'x' }); } catch (e) { thrown = e; }
  ok(/파일 이름/.test(thrown?.message), '경로 구분자가 든 파일 이름 거부');
});

await section('시스템 I/O 번호 검사', async () => {
  let thrown = null;
  try { ctrl.sysio.configure({ enabled: true, assign: { out: { servoOn: 600 } } }); } catch (e) { thrown = e; }
  ok(/1~512/.test(thrown?.message), '출력 번호 600 거부');
  ctrl.sysio.configure({ enabled: true, assign: { in: { start: '450' } } });
  ok(ctrl.sysio.inputs.some((s) => s.n === 450 && typeof s.n === 'number'), '문자열 "450" → 숫자 450');
  ctrl.sysio.configure({ enabled: false, assign: { in: {}, out: {} } });
});

await section('주기 처리 예외 → 알람 (서버 유지)', async () => {
  const orig = ctrl.sysio.update;
  ctrl.sysio.update = () => { throw new Error('boom'); };
  await sleep(50);            // 진행 중인 서브스텝이 끝나도록
  ctrl._ticking = false;
  ctrl.tick();
  ctrl.sysio.update = orig;
  ok(ctrl.alarms.some((a) => a.code === 'INTERNAL' && /boom/.test(a.msg)), 'tick 예외가 INTERNAL 알람으로');
  ctrl.resetAlarms();
});

await section('netguard: Host · Origin 검사', async () => {
  const req = (host, origin) => ({ headers: { host, ...(origin !== undefined ? { origin } : {}) } });
  ok(hostAllowed(req('localhost:3000')) && hostAllowed(req('192.168.0.10:3000')) && hostAllowed(req('[::1]:3000')), 'localhost · IP 허용');
  ok(!hostAllowed(req('evil.example:3000')), '외부 도메인 Host 거부 (DNS 리바인딩)');
  ok(originAllowed(req('localhost:3000')), 'Origin 없음(비브라우저) 허용');
  ok(originAllowed(req('localhost:3000', 'http://localhost:3000')), '같은 출처 허용');
  ok(!originAllowed(req('localhost:3000', 'http://evil.example')), '다른 사이트 Origin 거부 (CSRF)');
  ok(!originAllowed(req('localhost:3000', 'null')), "Origin 'null' 거부");
});

await section('손목 특이점(J5=0)에서 J4 유지', async () => {
  for (const id of ['kuka-kr6-r900', 'abb-irb1200', 'yaskawa-gp7', 'doosan-m1013']) {
    const m = ROBOTS.find((r) => r.id === id);
    const j = [...m.home]; j[3] = 30; j[4] = 0;
    const f = fkFlange(m, j);
    const c5 = Math.cos(5 * Math.PI / 180), s5 = Math.sin(5 * Math.PI / 180);
    const R = f.R.map((row) => [row[0] * c5 + row[1] * s5, -row[0] * s5 + row[1] * c5, row[2]]);   // 공구 Z 축 5° 회전
    const s = ikNearest(m, { p: f.p, R }, j);
    const jump = s ? Math.max(...s.map((v, i) => Math.abs(v - j[i]))) : Infinity;
    ok(s && Math.abs(s[3] - 30) < 1e-6 && jump < 5.01, `${id}: J4=${s?.[3].toFixed(1)}, 최대 변화 ${jump.toFixed(1)}°`);
  }
});

await section('KUKA VarProxy: 64KB 초과 값', async () => {
  let b = null, thrown = null;
  try { b = buildResponse(1, 0, 'x'.repeat(100000), true); } catch (e) { thrown = e; }
  ok(!thrown && b && b[b.length - 1] === 0, '예외 없이 실패 응답');
});

const PORTS = {
  yaskawaHse: { port: 21540, filePort: 21541 },
  kawasakiAs: { port: 21523, fallbackPort: 21524 },
  hyundai: { port: 21588 },
  abbRws: { port: 21580 },
  kukaVarProxy: { port: 21570 },
};
ctrl.setMode('REMOTE');
const handles = await startAll(ctrl, PORTS);

await section('Hyundai: 잘못된 URL 인코딩 → 400 (프로세스 유지)', async () => {
  const r = await new Promise((resolve, reject) => {
    const q = http.request({ host: '127.0.0.1', port: PORTS.hyundai.port, path: '/api/%E0%A4%A', agent: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    q.on('error', reject); q.end();
  });
  ok(r === 400, `상태 ${r}`);
  const r2 = await new Promise((resolve, reject) => {
    const q = http.request({ host: '127.0.0.1', port: PORTS.hyundai.port, path: '/api/status', headers: { Host: 'evil.example' }, agent: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    q.on('error', reject); q.end();
  });
  ok(r2 === 403, `외부 도메인 Host → 403 (${r2})`);
});

await section('Yaskawa HSE: 엉뚱한 블록 번호로 멈추지 않음', async () => {
  const sock = dgram.createSocket('udp4');
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  const replies = [];
  sock.on('message', (m) => replies.push(hseParse(m)));
  const send = (block, data) => sock.send(hseRequest({ division: 2, cmd: 0, service: 0x15, block, data }), PORTS.yaskawaHse.filePort, '127.0.0.1');
  send(0, Buffer.from('BIG.JBI', 'latin1'));
  await sleep(100);
  const t0 = Date.now();
  send(0x7ffffff0, Buffer.from('x'));
  await sleep(150);
  ok(Date.now() - t0 < 1000 && replies.at(-1)?.status !== 0, `블록 번호 오류 응답 (${Date.now() - t0}ms, status=${replies.at(-1)?.status})`);
  sock.close();
});

await section('Kawasaki AS: 줄 길이 제한 · 쪼개진 텔넷 협상', async () => {
  const s = net.connect(PORTS.kawasakiAs.port, '127.0.0.1');
  let out = '';
  s.on('data', (d) => (out += d.toString('latin1')));
  await new Promise((r) => s.on('connect', r));
  await sleep(100);
  const rss0 = process.memoryUsage().rss;
  s.write(Buffer.alloc(5 * 1024 * 1024, 0x41));   // 5MB, 줄바꿈 없음
  await sleep(300);
  const grew = (process.memoryUsage().rss - rss0) / 1024 / 1024;
  ok(grew < 200, `5MB 한 줄 → 메모리 증가 ${grew.toFixed(0)}MB`);
  s.write('\r\n');
  await sleep(100);
  // IAC WILL 을 두 청크로 나눠 보낸 뒤 명령 — 옵션 바이트가 명령 앞에 끼면 안 됨
  out = '';
  s.write(Buffer.from([255]));
  await sleep(30);
  s.write(Buffer.concat([Buffer.from([251, 1]), Buffer.from('as\r\n')]));
  await sleep(200);
  ok(!/\x01as/.test(out), '쪼개진 IAC 협상 바이트가 명령에 섞이지 않음');
  s.destroy();
});

await closeAll(handles);
clearInterval(ctrl._timer);
console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
