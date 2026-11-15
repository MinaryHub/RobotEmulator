// Doosan DRL 언어 모듈 테스트: node test/lang.drl.test.js
import net from 'node:net';
import { Controller } from '../server/controller.js';
import drl from '../server/lang/drl.js';
import { ROBOTS } from '../shared/robots.js';
import { toVendorPose } from '../shared/poseformat.js';

let fails = 0;
const ok = (cond, msg) => { if (cond) console.log('  ok  ', msg); else { fails++; console.log('  FAIL', msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

async function runToEnd(c, timeoutSec = 90) {
  const t0 = performance.now();
  if (!(await c.start())) throw new Error('start 실패: ' + JSON.stringify(c.alarms) + JSON.stringify(c.compileError));
  while (!['done', 'error', 'aborted'].includes(c.vm.status)) {
    if ((performance.now() - t0) / 1000 > timeoutSec) { c.stopProgram(); throw new Error('타임아웃'); }
    await sleep(20);
  }
  if (c.alarms.length) console.log('    alarms:', c.alarms.map((a) => `[${a.code}] ${a.msg}`).join(' | '));
  return (performance.now() - t0) / 1000;
}

function mkCtrl(robotId, files) {
  const c = new Controller();
  c.setRobot(robotId);
  c.loadFiles(files || drl.defaultFiles(c), true);
  c.setServo(true);
  c.setOverride(100);
  return c;
}
const rv = (c, n) => drl.readVar(c, n);

// ---------------------------------------------------------------- 기본 예제
async function testDefault(robotId) {
  const c = mkCtrl(robotId);
  ok(!c.compileError, `${robotId}: 기본 예제 컴파일 (${c.main}) ${c.compileError ? JSON.stringify(c.compileError) : ''}`);
  const before = c.objects.map((o) => [...o.pose.p]);
  const t = await runToEnd(c);
  ok(c.vm.status === 'done', `${robotId}: 실행 완료 status=${c.vm.status} (${t.toFixed(1)}s)`);
  ok(c.alarms.length === 0, `${robotId}: 알람 없음`);
  const R = c.robot.reach;
  c.objects.forEach((o, i) => {
    const b = before[i], a = o.pose.p;
    const moved = Math.hypot(a[0] - b[0], a[1] - b[1]) > 50;
    const mirrored = Math.abs(a[1] + b[1]) < 3 && Math.abs(a[2] - o.size[2] / 2) < 1 && a[0] < R * 0.55;
    ok(moved && mirrored, `${robotId}: ${o.id} 이동 [${b.map((v) => v.toFixed(0))}] → [${a.map((v) => v.toFixed(0))}]`);
  });
  ok(rv(c, 'count') === 4, `${robotId}: count = 4 → ${rv(c, 'count')}`);
}

// ---------------------------------------------------------------- 파이썬 문법·흐름
async function testFlow() {
  const main = `
from DRCF import *   # 무시
"""문서 문자열 — 무시"""
N = 3
total = 0

def add(a, b=10):
    return a + b

def fact(n):
    if n <= 1:
        return 1
    return n * fact(n - 1)

def bump():
    global total
    total += 100

def swap(p):
    a, b = p
    return (b, a)

for i in range(N):
    total = total + add(i)       # 10 + 11 + 12
bump()
f5 = fact(5)
x, y = swap((1, 2))
lst = [1, 2, 3]
lst.append(4); lst[0] = 9
s = 0
k = 0
while True:
    k += 1
    if k % 2 == 0:
        continue
    elif k > 7:
        break
    else:
        s += k                   # 1+3+5+7
names = "a,b,c".split(",")
msg = f"n={len(names)} {names[-1].upper()} {3.14159:.2f}"
fmt = "%d-%s" % (7, "x")
cond = 1 < 2 <= 2 and not (3 in lst) and "b" in names
tern = "yes" if s > 10 else "no"
sl = lst[1:3]
neg = -7 // 2
mod = -7 % 3
pw = 2 ** 10
p = posx(100, 200, 300, 0, 180, 0)
p[2] = p[2] + 50
pz = p[2]
q = trans(p, [10, 0, 0, 0, 0, 0])
for idx, v in enumerate([5, 6]):
    last = idx * 10 + v
if True: one_line = 1
`;
  const c = mkCtrl('doosan-m1013', { 'main.drl': main });
  ok(!c.compileError, `흐름: 컴파일 ${c.compileError ? JSON.stringify(c.compileError) : ''}`);
  await runToEnd(c, 10);
  ok(c.vm.status === 'done', `흐름: 실행 완료 (${c.vm.status})`);
  ok(rv(c, 'total') === 133, `함수·기본값·global: total = 133 → ${rv(c, 'total')}`);
  ok(rv(c, 'f5') === 120, `재귀 fact(5) = 120 → ${rv(c, 'f5')}`);
  ok(rv(c, 'x') === 2 && rv(c, 'y') === 1, `튜플 풀기 → ${rv(c, 'x')},${rv(c, 'y')}`);
  ok(rv(c, 'lst').join() === '9,2,3,4', `리스트 메서드·요소 대입 → ${rv(c, 'lst')}`);
  ok(rv(c, 's') === 16, `while/continue/break/elif: s = 16 → ${rv(c, 's')}`);
  ok(rv(c, 'msg') === 'n=3 C 3.14', `f 문자열 → ${rv(c, 'msg')}`);
  ok(rv(c, 'fmt') === '7-x', `% 서식 → ${rv(c, 'fmt')}`);
  ok(rv(c, 'cond') === false, `연쇄 비교·in → ${rv(c, 'cond')} (4 in lst 이므로 False)`);
  ok(rv(c, 'tern') === 'yes', '조건식');
  ok(rv(c, 'sl').join() === '2,3', `슬라이스 → ${rv(c, 'sl')}`);
  ok(rv(c, 'neg') === -4 && rv(c, 'mod') === 2 && rv(c, 'pw') === 1024, `// % ** 파이썬 규칙 → ${rv(c, 'neg')}, ${rv(c, 'mod')}, ${rv(c, 'pw')}`);
  ok(rv(c, 'pz') === 350, `posx 요소 대입 → ${rv(c, 'pz')}`);
  ok(near(rv(c, 'q')[0], 110, 1e-6) && near(rv(c, 'q')[2], 350, 1e-6), `trans(베이스) → ${rv(c, 'q')}`);
  ok(rv(c, 'last') === 16, `enumerate → ${rv(c, 'last')}`);
  ok(rv(c, 'one_line') === 1, '한 줄 if');
  ok(drl.writeVar(c, 'total', '5') && rv(c, 'total') === 5, 'writeVar/readVar (문자열 숫자 → 숫자)');
}

// ---------------------------------------------------------------- I/O
async function testIO() {
  const main = `
set_digital_output(5, ON)
set_digital_output(6)
set_digital_output(-6)
r1 = wait_digital_input(7, ON)
r2 = wait_digital_input(8, ON, 0.3)
v = get_digital_input(7) + get_digital_output(5)
wait(0.1)
`;
  const c = mkCtrl('doosan-m0609', { 'main.drl': main });
  ok(!c.compileError, `IO: 컴파일 ${c.compileError ? JSON.stringify(c.compileError) : ''}`);
  setTimeout(() => c.setDI(7, true), 300);
  const t = await runToEnd(c, 10);
  ok(c.vm.status === 'done', `IO: 실행 완료 (${t.toFixed(2)}s)`);
  ok(t >= 0.65, `IO: 대기 시간 반영 (${t.toFixed(2)}s ≥ 0.65)`);
  ok(c.getDO(5) && !c.getDO(6), 'IO: DO5 ON, 음수 번호로 DO6 OFF');
  ok(rv(c, 'r1') === 0 && rv(c, 'r2') === -1, `IO: 대기 결과 0 / 타임아웃 -1 → ${rv(c, 'r1')}, ${rv(c, 'r2')}`);
  ok(rv(c, 'v') === 2, `IO: get_digital_input + get_digital_output = 2 → ${rv(c, 'v')}`);
}

// ---------------------------------------------------------------- 모션
async function testMotion() {
  const c0 = new Controller();
  c0.setRobot('doosan-m1013');
  const v = toVendorPose('doosan', c0.tcpPose());
  const cx = v[0], cy = v[1], z = v[2] - 100, rr = 60;
  const X = (x, y, zz = z) => `posx(${[x, y, zz, v[3], v[4], v[5]].map((a) => a.toFixed(3)).join(', ')})`;
  const home = c0.robot.home;
  const main = `
set_velx(300, 90)
movel(${X(cx + rr, cy)})
movec(${X(cx, cy + rr)}, ${X(cx - rr, cy)}, vel=300, acc=1000)
movel(posx(0, 0, 40, 0, 0, 0), vel=[500, 90], mod=DR_MV_MOD_REL)
zrel = get_current_posx()[0][2]
movel(posx(0, 0, 25, 0, 0, 0), vel=200, ref=DR_TOOL)
ztool = get_current_posx()[0][2]
movej(posj(${home.join(', ')}), vel=90, acc=200)
movej(posj(10, 0, 0, 0, 0, 0), vel=60, mod=DR_MV_MOD_REL)
j1 = get_current_posj()[0]
t0 = 0
movej(posj(${home.join(', ')}), time=1.5)
wait(0.5)
pz =fkin(posj(${home.join(', ')}))[2]
`;
  const c = mkCtrl('doosan-m1013', { 'main.drl': main });
  ok(!c.compileError, `모션: 컴파일 ${c.compileError ? JSON.stringify(c.compileError) : ''}`);
  let maxDev = 0, samples = 0;
  const iv = setInterval(() => {
    if (c.vm?.current?.line === 4 && c.segment) {
      const p = c.tcpPose().p;
      maxDev = Math.max(maxDev, Math.abs(Math.hypot(p[0] - cx, p[1] - cy) - rr)); samples++;
    }
  }, 10);
  let tStart = null, tEnd = null;
  const iv2 = setInterval(() => {
    if (c.vm?.current?.line === 13 && tStart === null) tStart = c.simMs;
    if (c.vm?.current?.line === 14 && tEnd === null) tEnd = c.simMs;
  }, 5);
  await runToEnd(c, 30);
  clearInterval(iv); clearInterval(iv2);
  ok(c.vm.status === 'done', `모션: 실행 완료 (${c.vm.status})`);
  ok(samples > 5 && maxDev < 0.5, `movec 원호 반경 오차 ${maxDev.toFixed(3)}mm (샘플 ${samples})`);
  ok(near(rv(c, 'zrel'), z + 40, 0.01), `mod=REL 베이스 Z +40 → ${rv(c, 'zrel')?.toFixed(3)}`);
  ok(near(rv(c, 'ztool'), z + 40 - 25, 0.01), `ref=DR_TOOL Z +25 (툴 아래 방향) → ${rv(c, 'ztool')?.toFixed(3)}`);
  ok(near(rv(c, 'j1'), home[0] + 10, 1e-6), `movej 상대 이동 J1 → ${rv(c, 'j1')}`);
  const dt = tStart !== null && tEnd !== null ? (tEnd - tStart) / 1000 : NaN;
  ok(dt > 1.3 && dt < 1.9, `movej time=1.5 → ${dt.toFixed(2)}s`);
  ok(near(rv(c, 'pz'), toVendorPose('doosan', c.tcpPose())[2], 0.01), 'fkin = 현재 TCP Z');
}

// ---------------------------------------------------------------- 소켓 (서버/클라이언트)
async function testSocket() {
  const port = 21910;
  const main = `
sock = server_socket_open(${port})
res, rx = server_socket_read(sock)
server_socket_write(sock, b"ACK:" + rx.decode())
res2, rx2 = server_socket_read(sock, length=4, timeout=0.3)
server_socket_close(sock)
`;
  const c = mkCtrl('doosan-m1013', { 'main.drl': main });
  ok(!c.compileError, `소켓 서버: 컴파일 ${c.compileError ? JSON.stringify(c.compileError) : ''}`);
  const run = runToEnd(c, 10);
  let reply = '';
  for (let i = 0; i < 50; i++) {
    const r = await new Promise((res) => {
      const s = net.connect({ host: '127.0.0.1', port }, () => {
        s.write('HELLO');
        s.on('data', (d) => { reply += d; res(true); s.end(); });
      });
      s.on('error', () => res(false));
    });
    if (r) break;
    await sleep(50);
  }
  await run;
  ok(c.vm.status === 'done', `소켓 서버: 실행 완료 (${c.vm.status})`);
  ok(reply === 'ACK:HELLO', `소켓 서버: 응답 '${reply}'`);
  ok(rv(c, 'res') === 5 && rv(c, 'rx') === 'HELLO', `소켓 서버: 읽기 (${rv(c, 'res')}, ${rv(c, 'rx')})`);
  ok(rv(c, 'res2') === -1 || rv(c, 'res2') === -3, `소켓 서버: 끊김/타임아웃 음수 → ${rv(c, 'res2')}`);

  // 클라이언트: 테스트가 연 서버에 접속
  const srv = net.createServer((s) => { s.on('data', (d) => s.write(String(d).toUpperCase())); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const c2 = mkCtrl('doosan-m1013', { 'main.drl': `
sock = client_socket_open("127.0.0.1", ${srv.address().port})
client_socket_write(sock, "abc")
res, rx = client_socket_read(sock, -1, 3)
client_socket_close(sock)
` });
  await runToEnd(c2, 10);
  srv.close();
  ok(c2.vm.status === 'done' && rv(c2, 'rx') === 'ABC', `소켓 클라이언트: 왕복 '${rv(c2, 'rx')}'`);

  // 정지 시 열린 서버 소켓 정리
  const c3 = mkCtrl('doosan-m1013', { 'main.drl': `sock = server_socket_open(${port + 1})\n` });
  await c3.start();
  await sleep(200);
  c3.stopProgram();
  await sleep(100);
  const free = await new Promise((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(port + 1, () => { s.close(); res(true); }); });
  ok(free, '프로그램 정지 시 서버 소켓 닫힘');
}

// ---------------------------------------------------------------- 컴파일·실행 오류
async function testErrors() {
  const c = new Controller();
  c.setRobot('doosan-m1013');
  const chk = (text, line, what) => {
    c.loadFiles({ 'main.drl': text }, true);
    const e = c.compileError;
    ok(e && e.line === line && e.file === 'main.drl', `${what}: 오류 라인 ${line} → ${e ? `${e.file}:${e.line} ${e.msg}` : '오류 없음'}`);
  };
  chk('x = 1\nfoo_bar(3)\n', 2, '알 수 없는 함수');
  chk('if x > 1\n    y = 2\n', 1, "':' 누락");
  chk('x = 1\n  y = 2\n', 2, '들여쓰기');
  chk('x = (1 +\n 2\nwait(1)\n', 1, '닫히지 않은 괄호 (논리 줄 시작 행)');
  chk('for i in range(3):\nx = 1\n', 1, '빈 블록');
  chk('x = 1\nbreak\n', 2, '반복문 밖 break');
  chk('x = 1\nelse:\n    pass\n', 2, 'if 없는 else');
  chk('x = {"a": 1}\n', 1, '딕셔너리 미지원');
  chk('sub_program_run("nothing")\n', 1, '없는 서브 프로그램');
  ok(drl.pickMain(['b.drl', 'main.drl', 'a.py']) === 'main.drl', 'pickMain: main.drl');

  const rt = async (src, re, what) => {
    const cc = mkCtrl('doosan-m1013', { 'main.drl': src });
    await runToEnd(cc, 10);
    const a = cc.alarms.map((x) => x.msg).join(' | ');
    ok(cc.vm.status === 'error' && re.test(a), `${what}: ${a}`);
  };
  await rt('def f():\n    print(y)\n    y = 1\nf()\n', /main\.drl:2 .*지역 변수 'y'/, '지역 변수 사용 전 참조');
  await rt('a = [1]\nb = a[3]\n', /main\.drl:2 .*범위/, '인덱스 범위');
  await rt('p = posx(1,2,3,0,0,0) + posx(1,2,3,0,0,0)\n', /trans/, 'posx 더하기 안내');
  await rt('movej(posj(0, 0, 90, 0, 90, 0))\n', /set_velj/, '속도 없는 movej');
  await rt('movel(posx(5000, 0, 0, 0, 180, 0), vel=100)\n', /./, '도달 불가 movel');
}

// ---------------------------------------------------------------- 서브 프로그램
async function testSub() {
  const c = mkCtrl('doosan-m1013', {
    'main.drl': 'n = 1\nsub_program_run("sub")\nn = n * 10\n',
    'sub.drl': 'n = n + 4\nset_digital_output(9, ON)\n',
  });
  ok(!c.compileError, `서브 프로그램: 컴파일 ${c.compileError ? JSON.stringify(c.compileError) : ''}`);
  await runToEnd(c, 10);
  ok(rv(c, 'n') === 50 && c.getDO(9), `sub_program_run: n = 50 → ${rv(c, 'n')}`);
}

const t0 = performance.now();
try {
  await testErrors();
  await testFlow();
  await testIO();
  await testMotion();
  await testSub();
  await testSocket();
  console.log('-- 기본 예제 (병렬, 두산 전 모델) --');
  await Promise.all(ROBOTS.filter((r) => r.vendor === 'doosan').map((r) => testDefault(r.id)));
} catch (e) { fails++; console.error(e); }
console.log(`\n${fails ? 'FAILED' : 'PASSED'} (${fails} 실패, ${((performance.now() - t0) / 1000).toFixed(1)}s)`);
process.exit(fails ? 1 : 0);
