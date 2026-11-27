// Universal Robots 테스트: UR 기구학(DH), URScript 인터프리터, Dashboard Server
import net from 'node:net';
import { Controller } from '../server/controller.js';
import urscript, { _internal } from '../server/lang/urscript.js';
import { ROBOTS } from '../shared/robots.js';
import { fkFlange, ikFlangeAll, jointFrames } from '../shared/kinematics.js';
import { checkCollision } from '../shared/collision.js';
import { RfromRotvec, rotvecFromR, rotAngle, norm, sub } from '../shared/math.js';
import { externalView } from '../server/protocols/index.js';
import * as dash from '../server/protocols/ur-dashboard.js';

let fails = 0;
const ok = (c, msg) => { if (c) console.log('  ok  ', msg); else { fails++; console.log('  FAIL', msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UR = ROBOTS.filter((r) => r.vendor === 'ur');

async function runToEnd(c, timeoutSec = 90) {
  if (!(await c.start())) throw new Error('start 실패: ' + JSON.stringify(c.alarms) + JSON.stringify(c.compileError));
  const t0 = performance.now();
  while (!['done', 'error', 'aborted'].includes(c.vm.status)) {
    if ((performance.now() - t0) / 1000 > timeoutSec) { c.stopProgram(); throw new Error('타임아웃'); }
    await sleep(10);
  }
}
function mk(robotId = 'ur-ur5e', files = null) {
  const c = new Controller();
  c.setRobot(robotId);
  if (files) c.loadFiles(files, true);
  c.setTimeScale(10); c.setOverride(100); c.setServo(true);
  return c;
}
const done = (c) => { c.setServo(false); clearInterval(c._timer); };
async function run(src, robot = 'ur-ur5e') {
  const c = mk(robot, { 'main.script': src });
  const out = [];
  c.on('log', (e) => { if (e.src === 'program') out.push(e.msg); });
  if (c.compileError) { done(c); return { c, out, compileError: c.compileError }; }
  await runToEnd(c);
  return { c, out };
}

// ---------------------------------------------------------------- 1) 기구학
console.log('[UR 기구학]');
{
  const m = ROBOTS.find((r) => r.id === 'ur-ur5e');
  const f = fkFlange(m, [0, 0, 0, 0, 0, 0]);
  // UR5e 영점: x = a2 + a3, y = -(d4 + d6), z = d1 - d5 (공식 DH 로 계산한 알려진 값)
  ok(norm(sub(f.p, [-817.2, -232.9, 62.8])) < 1e-6, `UR5e 영점 플랜지 [${f.p.map((v) => v.toFixed(1))}]`);
  let bad = 0;
  for (const r of UR) for (let t = 0; t < 300; t++) {
    const q = Array.from({ length: 6 }, () => (Math.random() * 2 - 1) * 330);
    const T = fkFlange(r, q);
    const sols = ikFlangeAll(r, T);
    const hit = sols.some((s) => s.every((v, i) => Math.abs(((v - q[i]) % 360 + 540) % 360 - 180) < 1e-4));
    const fr = jointFrames(r, q).at(-1);
    if (!hit || norm(sub(fr.p, T.p)) > 1e-6) bad++;
  }
  ok(bad === 0, `${UR.length}개 모델 × 300 자세: IK 해에 원래 관절값 포함, 프레임 = FK (실패 ${bad})`);
  // 관절 프레임 축 규약 (관절 2 축 = 프레임 2 Y 열 = DH z1) — 직접교시·카메라 장착이 기대하는 규약
  const q = [10, -70, 80, -100, -80, 20];
  const F = jointFrames(m, q), F2 = jointFrames(m, q.map((v, i) => (i === 1 ? v + 1 : v)));
  const axis = [F[2].R[0][1], F[2].R[1][1], F[2].R[2][1]];
  const d = sub(F2[6].p, F[6].p), lever = sub(F[6].p, F[2].p);
  ok(Math.abs(d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2]) < 1e-6 && norm(d) > 1, '관절 2 회전 시 플랜지는 프레임 2 의 Y 축에 수직으로 움직임');
  void lever;
  // 회전 벡터 왕복 (π 근처 포함)
  let rvBad = 0;
  for (const v of [[0, 0, 0], [0.1, -0.2, 0.3], [0, Math.PI, 0], [Math.PI / Math.SQRT2, -Math.PI / Math.SQRT2, 0], [2.9, 0.4, -0.7]]) {
    const R = RfromRotvec(v);
    if (rotAngle(RfromRotvec(rotvecFromR(R)), R) > 1e-6) rvBad++;   // rotAngle(acos) 분해능 ~1e-8
  }
  ok(rvBad === 0, '회전 벡터 ↔ 회전 행렬 왕복 (θ = π 포함)');
  // 홈 자세: 간섭 없음, 툴 아래 방향
  const homeBad = UR.filter((r) => { const fk = fkFlange(r, r.home); return fk.R[2][2] > -0.999 || checkCollision(r, r.home, 'robotiq-2f85', null, []).hit; }).map((r) => r.id);
  ok(!homeBad.length, `홈 자세 툴 아래 방향·자체 간섭 없음 ${homeBad.join(',')}`);
}

// ---------------------------------------------------------------- 2) 문법
console.log('[URScript 문법]');
{
  const t = _internal.buildTree(_internal.logicalLines([
    'def main():', '  $ 1 "Robot Program"', '  if a: x = 1', '  elif b:', '    x = 2', '  else:', '    x = 3', '  end', '  while True:', '    break', '  end', 'end',
  ].join('\n'), 'm'), 'm');
  ok(t.length === 1 && t[0].kw === 'def' && t[0].body[0].kw === 'if' && t[0].body[0].branches.length === 2 && t[0].body[0].els.length === 1 && t[0].body[1].kw === 'while', 'def/if/elif/else/while … end 트리, $ 주석 줄 무시');
  const e1 = (await run('def f():\n  x = 1\n')).compileError;
  ok(e1 && /end/.test(e1.msg ?? e1.message ?? JSON.stringify(e1)), 'end 누락 → 컴파일 오류');
  const e2 = (await run('thread t():\n  sleep(0.01)\nend\nth = run t()\njoin th\n')).compileError;
  ok(!e2, 'thread / run / join 컴파일 및 실행 지원');
  const e3 = (await run('foo_bar(1)\n')).compileError;
  ok(e3 && /foo_bar/.test(JSON.stringify(e3)), '알 수 없는 함수 → 컴파일 오류');
}

// ---------------------------------------------------------------- 3) 실행: 식·함수·전역
console.log('[URScript 실행]');
{
  const { out, c } = await run([
    'def add(a, b=10):',
    '  return a + b',
    'end',
    'x = add(1)',
    'p1 = p[0.1, 0.2, 0.3, 0, 0, 0]',
    'l = [1, 2, 3]',
    'l[1] = 20',
    'i = 0',
    's = 0',
    'while True:',
    '  i = i + 1',
    '  if i == 2:',
    '    continue',
    '  elif i > 4:',
    '    break',
    '  end',
    '  s = s + i',
    'end',
    'textmsg("x=", x, " p1z=", p1[2], " l=", l, " s=", s)',
    'textmsg(str_cat("a", to_str(True xor False)), " ", str_len("abc"), " ", floor(2.7), " ", norm([3, 4]))',
    'textmsg(to_str(pose_trans(p[0.1, 0, 0, 0, 0, 1.5707963267948966], p[0.1, 0, 0, 0, 0, 0])))',
  ].join('\n'));
  ok(out.includes('x=11 p1z=0.3 l=[1, 20, 3] s=8'), `함수 기본값·자세 리터럴·리스트 대입·while/continue/break: ${out[0]}`);
  ok(out[1] === 'aTrue 3 2 5', `문자열·논리·수학 함수: ${out[1]}`);
  ok(/^p\[0\.1, 0\.1, 0, 0, 0, 1\.570796/.test(out[2] ?? ''), `pose_trans (회전 후 이동): ${out[2]}`);
  ok(c.vm.status === 'done', '정상 종료');
  done(c);

  // 맨 위 def 만 있는 스크립트 → 그 def 실행, 변수는 전역 / 함수 안 지역 변수와 global
  const r2 = await run(['def prog():', '  global cnt = 0', '  def inc():', '    global cnt = cnt + 1', '    tmp = 5', '  end', '  inc()', '  inc()', '  y = 7', 'end'].join('\n'));
  ok(r2.c.vm.status === 'done' && r2.c.vm.globals.get('cnt') === 2 && r2.c.vm.globals.get('y') === 7 && !r2.c.vm.globals.has('tmp'), 'def 만 있으면 프로그램으로 실행, 중첩 def·global·지역 변수');
  ok(urscript.readVar(r2.c, 'cnt') === 2 && urscript.writeVar(r2.c, 'cnt', '5') && urscript.readVar(r2.c, 'cnt') === 5, 'readVar / writeVar (통신 인터페이스)');
  done(r2.c);
}

// ---------------------------------------------------------------- 4) I/O 번호 대응
console.log('[I/O]');
{
  const { c } = await run(['set_standard_digital_out(0, True)', 'set_configurable_digital_out(1, True)', 'set_tool_digital_out(1, True)', 'set_digital_out(9, True)'].join('\n'));
  ok(c.getDO(1) && c.getDO(10) && c.getDO(18), '표준 DO0 → DO1, 구성 DO1 → DO10, 툴 DO1 → DO18 (구형 set_digital_out(9) = 툴 1)');
  c.setDI(3, true); c.setDI(11, true);
  const r = await run('textmsg(get_standard_digital_in(2), " ", get_configurable_digital_in(2), " ", get_standard_digital_in(5))');
  void r;
  done(c);
  const c2 = mk('ur-ur5e', { 'main.script': 'global a = get_standard_digital_in(2)\nglobal b = get_configurable_digital_in(2)\nglobal z = get_standard_digital_in(5)\n' });
  c2.setDI(3, true); c2.setDI(11, true);
  await runToEnd(c2);
  ok(c2.vm.globals.get('a') === true && c2.vm.globals.get('b') === true && c2.vm.globals.get('z') === false, '표준 DI2 ← DI3, 구성 DI2 ← DI11');
  done(c2);
}

// ---------------------------------------------------------------- 5) 모션 단위 (m·rad)
console.log('[모션]');
{
  const src = [
    'movej([3.14159265, -1.5708, 1.5708, -1.5708, -1.5708, 0], a=1.4, v=1.05)',
    'global home = get_actual_tcp_pose()',
    'target = pose_add(home, p[0, 0.05, -0.03, 0, 0, 0])',
    'movel(target, a=1.2, v=0.25)',
    'global after = get_actual_tcp_pose()',
    'global q = get_actual_joint_positions()',
    'global fk = get_forward_kin(q)',
    'global ik = get_inverse_kin(after, q)',
    'set_tcp(p[0, 0, 0.2, 0, 0, 0])',
    'global tcp2 = get_tcp_offset()',
  ].join('\n');
  const c = mk('ur-ur5e', { 'main.script': src });
  await runToEnd(c);
  const g = (k) => c.vm.globals.get(k);
  const home = g('home'), after = g('after');
  ok(Math.abs(after[1] - home[1] - 0.05) < 1e-4 && Math.abs(after[2] - home[2] + 0.03) < 1e-4, `movel: m 단위 이동 (dy ${(after[1] - home[1]).toFixed(4)}, dz ${(after[2] - home[2]).toFixed(4)})`);
  ok(g('fk').every((v, i) => Math.abs(v - after[i]) < 1e-6) && g('ik').every((v, i) => Math.abs(v - g('q')[i]) < 1e-6), 'get_forward_kin / get_inverse_kin(qnear) 왕복');
  ok(Math.abs(g('tcp2')[2] - 0.2) < 1e-9 && c.toolOverride && Math.abs(c.tool.p[2] - 200) < 1e-6, 'set_tcp → 프로그램 툴 (mm 변환)');
  ok(c.vm.status === 'done' && !c.alarms.length, '알람 없음');
  done(c);
}

// ---------------------------------------------------------------- 6) 예제 (전 모델, 간섭 정지 모드)
console.log('[예제 픽 앤 플레이스]');
{
  const res = await Promise.all(UR.map(async (r) => {
    const c = mk(r.id);
    c.setCollisionMode('stop');
    const before = c.objects.map((o) => [...o.pose.p]);
    await runToEnd(c);
    const moved = c.objects.filter((o, i) => Math.abs(o.pose.p[1] + before[i][1]) < 3 && Math.abs(o.pose.p[2] - o.size[2] / 2) < 1.5).length;
    const out = { id: r.id, status: c.vm.status, moved, n: before.length, alarms: c.alarms.map((a) => a.msg) };
    done(c);
    return out;
  }));
  for (const r of res) ok(r.status === 'done' && r.moved === r.n && !r.alarms.length, `${r.id}: ${r.status}, 공작물 ${r.moved}/${r.n} ${r.alarms.join(' / ')}`);
}

// ---------------------------------------------------------------- 7) 소켓
console.log('[소켓]');
{
  const got = [];
  const srv = net.createServer((s) => { s.on('data', (d) => { got.push(d.toString()); s.write('pong\n(1.5, 2.5)'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const { c } = await run(`global okc = socket_open("127.0.0.1", ${port}, "s1")\nsocket_send_line("ping", "s1")\nglobal ln = socket_read_line("s1", 2)\nglobal fl = socket_read_ascii_float(2, "s1", 2)\nsocket_close("s1")\nglobal bad = socket_open("127.0.0.1", 1, "s2")`);
  ok(c.vm.globals.get('okc') === true && got.join('') === 'ping\n' && c.vm.globals.get('ln') === 'pong', 'socket_open / send_line / read_line');
  ok(JSON.stringify(c.vm.globals.get('fl')) === '[2,1.5,2.5]' && c.vm.globals.get('bad') === false, 'socket_read_ascii_float, 연결 실패 → False');
  done(c);
  srv.close();
}

// ---------------------------------------------------------------- 8) Dashboard Server
console.log('[Dashboard Server]');
{
  const c = mk('ur-ur5e');
  c.setServo(false);
  const h = await dash.start(externalView(c), { port: 0, host: '127.0.0.1' });
  const sock = net.connect({ port: h.port, host: '127.0.0.1' });
  let buf = '';
  sock.on('data', (d) => { buf += d.toString(); });
  const line = async () => { for (let i = 0; i < 300 && !buf.includes('\n'); i++) await sleep(5); const k = buf.indexOf('\n'); const l = buf.slice(0, k); buf = buf.slice(k + 1); return l; };
  const ask = async (s) => { sock.write(s + '\n'); return line(); };
  ok((await line()) === 'Connected: Universal Robots Dashboard Server', '접속 배너');
  ok((await ask('robotmode')) === 'Robotmode: POWER_OFF', 'robotmode POWER_OFF');
  ok((await ask('power on')) === 'Powering on' && (await ask('robotmode')) === 'Robotmode: IDLE', 'power on → IDLE');
  ok((await ask('load /programs/nothing.urp')) === 'File not found: /programs/nothing.urp', 'load 없는 파일');
  ok((await ask('load main.urp')) === 'Loading program: main.urp' && c.main === 'main.script', 'load main.urp → main.script 선택');
  c.setMode('TEACH');
  await ask('brake release');
  ok((await ask('robotmode')) === 'Robotmode: IDLE' && !c.servo, 'TEACH 모드 → brake release 거부 (원격 제어에서만)');
  c.setMode('REMOTE');
  await ask('brake release');
  ok((await ask('robotmode')) === 'Robotmode: RUNNING' && c.servo, 'REMOTE 모드 → brake release → 서보 ON');
  c.setMode('TEACH');
  ok((await ask('play')) === 'Failed to execute: play' && (await ask('is in remote control')) === 'false', 'TEACH 모드 → play 거부 (모드 인터록)');
  c.setMode('REMOTE');
  ok((await ask('play')) === 'Starting program' && (await ask('programState')) === 'PLAYING main.urp', 'REMOTE 모드 → play, programState');
  ok((await ask('pause')) === 'Pausing program' && (await ask('programState')) === 'PAUSED main.urp', 'pause');
  ok((await ask('play')) === 'Starting program' && (await ask('running')) === 'Program running: true', '재개');
  ok((await ask('stop')) === 'Stopped' && (await ask('running')) === 'Program running: false', 'stop');
  ok((await ask('get robot model')) === 'UR5' && (await ask('safetystatus')) === 'Safetystatus: NORMAL', 'get robot model / safetystatus');
  ok((await ask('hello')) === "could not understand: 'hello'", '모르는 명령');
  ok((await ask('quit')) === 'Disconnected', 'quit');
  sock.destroy();
  await h.close();
  done(c);
}

console.log(fails ? `\n${fails}건 실패` : '\n모두 통과');
process.exit(fails ? 1 : 0);
