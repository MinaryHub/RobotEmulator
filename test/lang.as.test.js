// Kawasaki AS 언어 모듈 테스트:  node test/lang.as.test.js
import { Controller } from '../server/controller.js';
import AS, { executeLine, listPrograms, formatValue, parseValue } from '../server/lang/as.js';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  OK ' : '  NG '} ${msg}`); if (!cond) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runToEnd(ctrl, timeoutSec = 40) {
  const t0 = performance.now();
  const started = await ctrl.start();
  if (!started) { console.log('    시작 실패', ctrl.compileError, ctrl.alarms); return 'nostart'; }
  while (['running', 'paused', 'idle'].includes(ctrl.vm.status)) {
    if ((performance.now() - t0) / 1000 > timeoutSec) { ctrl.stopProgram(); return 'timeout'; }
    await sleep(20);
  }
  if (ctrl.alarms.length) console.log('    알람:', ctrl.alarms.map((a) => `[${a.code}] ${a.msg}`).join(' | '));
  return ctrl.vm.status;
}

function makeCtrl(robot) {
  const c = new Controller();
  c.setRobot(robot);
  c.setServo(true);
  c.setOverride(100);
  return c;
}

// 스니펫 실행: 파일 하나를 메인으로 로드 후 실행
async function runSnippet(ctrl, text, name = 'snip.as') {
  ctrl.resetAlarms(); ctrl.setServo(true);
  ctrl.loadFiles({ [name]: text }, true);
  if (ctrl.compileError) { console.log('    컴파일 오류', ctrl.compileError); return 'compile'; }
  return runToEnd(ctrl);
}
const R = (c, n) => AS.readVar(c, n);

// ---------------------------------------------------------------- 1. 기본 예제 (3 기종)
for (const robot of ['kawasaki-rs007n', 'kawasaki-rs010n', 'kawasaki-rs020n']) {
  console.log(`[예제 pickplace.as] ${robot}`);
  const c = makeCtrl(robot);
  ok(c.files.has('pickplace.as') && c.main === 'pickplace.as' && !c.compileError, '기본 파일 로드/컴파일');
  const before = c.objects.map((o) => [...o.pose.p]);
  const t0 = performance.now();
  const st = await runToEnd(c, 60);
  ok(st === 'done', `실행 완료 (status=${st}, ${((performance.now() - t0) / 1000).toFixed(1)}s)`);
  ok(c.alarms.length === 0, '알람 없음');
  const moved = c.objects.filter((o, i) => Math.hypot(o.pose.p[0] - before[i][0], o.pose.p[1] - before[i][1]) > 50);
  ok(moved.length === 4, `공작물 4개 이동 (${moved.length})`);
  ok(c.objects.every((o) => Math.abs(o.pose.p[2] - o.size[2] / 2) < 1), '공작물 테이블 위 안착');
  ok(R(c, 'count') === 4, `count = ${R(c, 'count')}`);
  ok(c.logs.some((l) => l.src === 'program' && l.msg.includes('PICK&PLACE: 4 개 완료')), 'PRINT 출력');
  c.removeAllListeners(); clearInterval(c._timer);
}

// ---------------------------------------------------------------- 2. 제어 구조 / 변수
console.log('[제어 구조]');
const c = makeCtrl('kawasaki-rs007n');
let st = await runSnippet(c, `.PROGRAM main()
  sum = 0
  FOR i = 1 TO 10
    sum = sum + i
  END
  FOR i = 10 TO 1 STEP -3
    down = i
  END
  n = 0
  WHILE n < 5 DO
    n = n + 1
  END
  k = 0
  DO
    k = k + 2
  UNTIL k >= 7
  IF sum == 55 AND NOT (n <> 5) THEN
    r1 = 1
  ELSE
    r1 = 2
  END
  IF k < 0 THEN
    r2 = 1
  ELSE
    r2 = 2
  END
  t = TRUE
  f = 3 > 4
  m = 17 MOD 5
  b = ^HF0 BAND 255
  a = MAXVAL(3, 9, 2) + MINVAL(4, 1) + INT(2.7) + ABS(-1)
  ang = ATAN2(1, 1) + SIN(30)*0
  q = SQRT(16)
  FOR j = 1 TO 3
    CASE j OF
      VALUE 1:
        c1 = 10
      VALUE 2, 3:
        c2 = j
      ANY :
        c3 = 1
    END
  END
  CASE 7 OF
    VALUE 1:
      c4 = 1
    ANY :
      c4 = 99
  END
  arr[1] = 5
  arr[2] = arr[1] * 2
  $s = "AB" + "C"
  len = LEN($s)
  CALL sub(x, 4)
  cnt = 0
10 cnt = cnt + 1
  IF cnt < 3 GOTO 10
  GOTO 20
  cnt = 100
20 .loc = 7
  lv = .loc
  TYPE "sum=", sum, " $s=", $s
.END
.PROGRAM sub(.out, .in)
  .out = .in * 10
  RETURN
  .out = -1
.END
`);
ok(st === 'done', `실행 완료 (${st})`);
const exp = { sum: 55, down: 1, n: 5, k: 8, r1: 1, r2: 2, t: -1, f: 0, m: 2, b: 240, a: 13, ang: 45, q: 4, c1: 10, c2: 3, c4: 99, 'arr[2]': 10, len: 3, x: 40, cnt: 3, lv: 7 };
for (const [k, v] of Object.entries(exp)) ok(Math.abs(R(c, k) - v) < 1e-6, `${k} = ${R(c, k)} (기대 ${v})`);
ok(R(c, 'c3') === undefined, 'CASE fallthrough 없음');
ok(R(c, '$s') === 'ABC', `$s = ${R(c, '$s')}`);
ok(c.logs.some((l) => l.msg === 'sum=55 $s=ABC'), 'TYPE 출력');

// ---------------------------------------------------------------- 3. 위치 연산
console.log('[위치 연산]');
st = await runSnippet(c, `.PROGRAM main()
  HOME
  POINT a = TRANS(400, 0, 300, 0, 180, 0)
  POINT dn = TRANS(0, 0, -50)
  POINT b = a + dn
  POINT s = SHIFT(a BY 10, 20, 30)
  bz = DZ(b)
  sx = DX(s)
  sy = DY(s)
  POINT c = a + INVERSE(a)
  cx = DX(c)
  POINT #j1 = #PPOINT(10, 20, -80, 0, -70, 0)
  JMOVE #j1
  HERE h
  HERE #hj
  POINT tj = #j1
  d = DISTANCE(h, tj)
  DECOMPOSE v[0] = a
  JMOVE a
  LMOVE s
  LAPPRO a, 50
  az = DZ(HERE)
  LDEPART 30
  dz2 = DZ(HERE)
  DRAW 0, 50, 0
  dy3 = DY(HERE)
  TDRAW 0, 0, 20
  dz4 = DZ(HERE)
  C1MOVE SHIFT(a BY 50, 50, 0)
  C2MOVE SHIFT(a BY 100, 0, 0)
  cx2 = DX(HERE)
  SPEED 200 MM/S
  LMOVE a
  SPEED 1 S
  JMOVE #j1
  JAPPRO a, 100
  JDEPART 20
  HOME
.END
.TRANS
dummy 0 0 0 0 0 0
.END
`);
ok(st === 'done', `실행 완료 (${st})`);
ok(Math.abs(R(c, 'bz') - 350) < 1e-6, `a+TRANS(0,0,-50) → Z=${R(c, 'bz')} (툴 아래 방향이므로 350)`);
ok(Math.abs(R(c, 'sx') - 410) < 1e-6 && Math.abs(R(c, 'sy') - 20) < 1e-6, 'SHIFT');
ok(Math.abs(R(c, 'cx')) < 1e-6, 'a + INVERSE(a) = NULL');
ok(R(c, 'd') < 1e-3, `HERE == FK(#j1) (d=${R(c, 'd')})`);
ok(R(c, '#hj').every((v, i) => Math.abs(v - [10, 20, -80, 0, -70, 0][i]) < 1e-6), 'HERE #hj');
ok(Math.abs(R(c, 'v[0]') - 400) < 1e-6 && Math.abs(R(c, 'v[4]') - 180) < 1e-3, 'DECOMPOSE');
ok(Math.abs(R(c, 'az') - 350) < 0.01 && Math.abs(R(c, 'dz2') - 380) < 0.01, `LAPPRO/LDEPART (${R(c, 'az')}, ${R(c, 'dz2')})`);
ok(Math.abs(R(c, 'dy3') - 50) < 0.01, 'DRAW');
ok(Math.abs(R(c, 'dz4') - 360) < 0.01, `TDRAW (${R(c, 'dz4')})`);
ok(Math.abs(R(c, 'cx2') - 500) < 0.05, `C1MOVE/C2MOVE (${R(c, 'cx2')})`);
ok(R(c, 's').every((v, i) => Math.abs(v - [410, 20, 330, 0, 180, 0][i]) < 1e-3), `readVar trans ${R(c, 's')}`);

// ---------------------------------------------------------------- 4. 신호 / SWAIT
console.log('[신호]');
// DI1 은 기본적으로 그리퍼 닫힘 피드백이므로 이 테스트 동안 피드백 매핑 해제
const gio = c.gripperIO;
c.gripperIO = { ...gio, fbClosed: 0 };
c.setDI(1, false); c.setDI(4, false);
c.resetAlarms();
c.loadFiles({ 'sig.as': `.PROGRAM main()
  SIGNAL 5, -6, 2010
  s5 = SIG(5)
  s6 = SIG(-6)
  s2010 = SIG(2010)
  BITS 9, 4 = 10
  bv = BITS(9, 4)
  TIMER 1 = 0
  SWAIT 1001
  t = TIMER(1)
  WAIT SIG(1004)
  PULSE 7, 0.1
  p7 = SIG(7)
  TWAIT 0.2
  p7b = SIG(7)
.END
` }, true);
const run2 = runToEnd(c);
setTimeout(() => c.setDI(1, true), 300);
setTimeout(() => c.setDI(4, true), 500);
st = await run2;
c.gripperIO = gio;
ok(st === 'done', `SWAIT 이후 완료 (${st})`);
ok(R(c, 's5') === -1 && R(c, 's6') === -1 && R(c, 's2010') === -1, 'SIGNAL / SIG');
ok(c.getDO(5) && !c.getDO(6), 'DO5 ON / DO6 OFF');
ok(R(c, 'bv') === 10 && c.getDO(10) && c.getDO(12) && !c.getDO(9), 'BITS');
ok(R(c, 't') >= 0.25, `SWAIT 대기 시간 ${R(c, 't')?.toFixed(2)}s`);
ok(R(c, 'p7') === -1 && R(c, 'p7b') === 0, 'PULSE');

// ---------------------------------------------------------------- 5. 컴파일 오류
console.log('[컴파일 오류]');
c.loadFiles({ 'bad.as': '.PROGRAM main()\n  IF x THEN\n  JMOVE p\n.END\n' }, true);
ok(c.compileError && c.compileError.line === 2, `IF 미종결 오류 라인 ${c.compileError?.line}: ${c.compileError?.msg}`);
c.loadFiles({ 'bad.as': '.PROGRAM main()\n  JMOVE p\n  FOO 1\n.END\n' }, true);
ok(c.compileError && c.compileError.line === 3, `알 수 없는 명령 라인 ${c.compileError?.line}: ${c.compileError?.msg}`);
c.loadFiles({ 'bad.as': '.PROGRAM main()\n  GOTO 99\n.END\n' }, true);
ok(c.compileError && /99/.test(c.compileError.msg), `라벨 없음: ${c.compileError?.msg}`);
c.loadFiles({ 'bad.as': '.PROGRAM main()\n  CALL nothere\n.END\n' }, true);
ok(!!c.compileError, `CALL 대상 없음: ${c.compileError?.msg}`);

// 여러 파일 / pickMain
c.loadFiles({ 'lib.as': '.PROGRAM helper(.a)\n  .a = .a + 1\n.END\n', 'job.as': '.PROGRAM pg0()\n  v = 1\n  CALL helper(v)\n.END\n' }, true);
ok(c.main === 'job.as' && !c.compileError, `pickMain → ${c.main}`);
st = await runToEnd(c);
ok(st === 'done' && R(c, 'v') === 2, `파일 간 CALL (v=${R(c, 'v')})`);
ok(listPrograms(c).join(',') === 'helper,pg0', `listPrograms ${listPrograms(c)}`);

// ---------------------------------------------------------------- 6. executeLine (터미널)
console.log('[executeLine]');
c.loadFiles(AS.defaultFiles(c), true);
let out = await executeLine(c, 'DO HOME');
ok(out === '', `DO HOME → '${out}'`);
out = await executeLine(c, 'DO JMOVE #standby');
ok(c.joints.every((v, i) => Math.abs(v - R(c, '#standby')[i]) < 1e-6), 'DO JMOVE #standby');
out = await executeLine(c, 'HERE p9');
ok(Array.isArray(R(c, 'p9')), `HERE p9 → ${R(c, 'p9')?.map((v) => v.toFixed(1))}`);
out = await executeLine(c, 'POINT p10 = SHIFT(HERE BY 0, 0, 10)');
ok(Math.abs(R(c, 'p10')[2] - R(c, 'p9')[2] - 10) < 1e-6, 'POINT p10 = SHIFT(HERE ...)');
out = await executeLine(c, 'SIGNAL 3');
ok(c.getDO(3), 'SIGNAL 3');
out = await executeLine(c, 'PRINT "n=", n_work');
ok(out === 'n=4', `PRINT → '${out}'`);
out = await executeLine(c, 'WHERE');
ok(out.includes('JT1') && out.includes('X[mm]'), 'WHERE');
out = await executeLine(c, 'LIST /R');
ok(out.includes('PITCH'), 'LIST /R');
out = await executeLine(c, 'DO JMOVE nowhere');
ok(out.startsWith('(E)'), `오류 → '${out}'`);
out = await executeLine(c, 'SPEED 50');
ok(c.override === 50, `모니터 SPEED → ${out}`);
c.setOverride(100);
ok(AS.writeVar(c, 'p11', [400, 0, 300, 0, 180, 0]) && AS.writeVar(c, 'z1', '12.5') && AS.writeVar(c, '$m', 'hi') && AS.writeVar(c, '#jj', [0, 0, -90, 0, -90, 0]), 'writeVar');
ok(R(c, 'z1') === 12.5 && R(c, '$m') === 'hi' && R(c, '#jj')[2] === -90, 'readVar');
ok(formatValue(5) === '5' && parseValue('1 2 3 4 5 6').length === 6 && parseValue('"x"') === 'x', 'formatValue / parseValue');
out = await executeLine(c, 'EXECUTE main');
ok(out.includes('실행'), `EXECUTE → ${out}`);
const t0 = performance.now();
while (c.vm.status === 'running' && performance.now() - t0 < 40000) await sleep(20);
ok(c.vm.status === 'done' && c.alarms.length === 0, `EXECUTE 실행 완료 (${c.vm.status})`);

console.log(fails ? `\n실패 ${fails}건` : '\n모두 통과');
process.exit(fails ? 1 : 0);
