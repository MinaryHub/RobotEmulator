// KUKA KRL 언어 모듈 테스트: node test/lang.krl.test.js
import { Controller } from '../server/controller.js';
import krl, { formatValue, parseValue } from '../server/lang/krl.js';

const T0 = Date.now();
let fails = 0;
const check = (c, msg) => { if (!c) { fails++; console.log('  FAIL', msg); } else console.log('  ok  ', msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctrl = new Controller();

async function run(timeoutS = 60) {
  ctrl.resetAlarms();
  if (ctrl.compileError) { console.log('  compile error:', ctrl.compileError); return 'compile'; }
  ctrl.setServo(true);
  ctrl.setOverride(100);
  const started = await ctrl.start();
  if (!started) return 'nostart';
  const t0 = Date.now();
  while (!['done', 'error', 'aborted'].includes(ctrl.vm.status)) {
    if ((Date.now() - t0) / 1000 > timeoutS) { ctrl.stopProgram(); return 'timeout'; }
    await sleep(20);
  }
  if (ctrl.alarms.length) console.log('  alarms:', ctrl.alarms.map((a) => a.msg));
  return ctrl.vm.status;
}

function load(files) {
  ctrl.loadFiles(files, true);
  ctrl.main = krl.pickMain([...ctrl.files.keys()], ctrl.files);
  ctrl.compile(true);
}
const progLogs = (since) => ctrl.logs.filter((l) => l.src === 'program' && l.t >= since).map((l) => l.msg);
let logs = [];
const has = (s) => { const ok = logs.includes(s); if (!ok) console.log('    logs:', logs); return ok; };

async function defaultTest(robotId) {
  console.log(`[기본 예제] ${robotId}`);
  ctrl.setRobot(robotId);
  ctrl.loadFiles(ctrl.lang.defaultFiles(ctrl), true);
  check(ctrl.main === 'pick_place.src', `메인 선택 ${ctrl.main}`);
  const before = ctrl.objects.map((o) => [...o.pose.p]);
  const t = Date.now();
  const st = await run(80);
  check(st === 'done', `${robotId} 실행 완료 (status=${st}, ${((Date.now() - t) / 1000).toFixed(1)} s)`);
  check(ctrl.alarms.length === 0, `${robotId} 알람 없음`);
  const moved = ctrl.objects.filter((o, i) => Math.hypot(o.pose.p[0] - before[i][0], o.pose.p[1] - before[i][1]) > 20).length;
  check(moved === 4, `${robotId} 공작물 4개 이동 (${moved})`);
  check(krl.readVar(ctrl, 'nPart') === '4', `nPart = ${krl.readVar(ctrl, 'nPart')}`);
}

// ---------------------------------------------------------------- 기본 예제
ctrl.setRobot('kuka-kr6-r900');
check(ctrl.files.has('pick_place.src') && ctrl.files.has('pick_place.dat'), 'defaultFiles 로드');
check(!ctrl.compileError, `기본 예제 컴파일 ${ctrl.compileError ? JSON.stringify(ctrl.compileError) : ''}`);
await defaultTest('kuka-kr6-r900');
await defaultTest('kuka-kr10-r1100');

// ---------------------------------------------------------------- 제어 흐름 / 함수
ctrl.setRobot('kuka-kr6-r900');
console.log('[스니펫] 제어 흐름/함수/데이터');
let t = Date.now();
load({
  'flow.src': `&ACCESS RVP
&REL 1
DEF flow( )
  DECL INT i, k, arr[5]
  DECL REAL r
  DECL CHAR name[10]
  DECL FRAME fr
  DECL BOOL b
  INI_SUB()
  FOR i = 1 TO 5
    arr[i] = i * 2
  ENDFOR
  k = 0
  FOR i = 1 TO 5
    k = k + arr[i]
  ENDFOR
  MsgNotify("sum=" , k)
  Log("sum", k)
  i = 0
  WHILE i < 3
    i = i + 1
  ENDWHILE
  Log("while", i)
  REPEAT
    i = i - 1
  UNTIL i <= 0
  Log("repeat", i)
  LOOP
    i = i + 1
    IF i >= 4 THEN
      EXIT
    ENDIF
  ENDLOOP
  Log("loop", i)
  FOR i = 10 TO 1 STEP -3
    k = k + 100
  ENDFOR
  Log("step", k)
  Log("forend", i)
  i = 4
  SWITCH i
    CASE 1, 2
      Log("case12", i)
    CASE 4
      Log("case4", i)
    DEFAULT
      Log("default", i)
  ENDSWITCH
  IF (i == 4) AND NOT (k <> 430) THEN
    Log("ifand", 1)
  ELSE
    Log("ifand", 0)
  ENDIF
  Log("sq", Square(7))
  Log("fact", Fact(5))
  r = 7 / 2
  i = 2.6
  Log("int", i)
  Log("real", r * 2)
  AddOne(k)
  Log("out", k)
  AddIn(k)
  Log("in", k)
  i = 0
again:
  i = i + 1
  IF i < 5 THEN
    GOTO again
  ENDIF
  Log("goto", i)
  b = TRUE EXOR FALSE
  IF b THEN
    Log("exor", 1)
  ENDIF
  Log("bits", 'B1010' B_AND 6)
  fr = {X 10, Y 20, Z 30, A 0, B 0, C 0}
  fr.X = fr.X + 5
  Log("frx", fr.X)
  fr = {Z 99}
  Log("partial", fr.X + fr.Z)
  Log("gvar", gCount)
  gCount = gCount + 1
  name[] = "abc"
  Log("str", StrLen(name))
  IF $MODE_OP == #T1 THEN
    Log("mode", 1)
  ENDIF
END

DEF INI_SUB( )
  gCount = 10
END

DEF Log(txt:IN, v:IN)
  DECL CHAR txt[20]
  DECL REAL v
  MsgNotify(txt)
  LogVal(v)
END

DEF AddOne(x:OUT)
  DECL INT x
  x = x + 1
END

DEF AddIn(x:IN)
  DECL INT x
  x = x + 1000
END

DEFFCT INT Square(x:IN)
  DECL INT x
  RETURN x * x
ENDFCT

DEFFCT INT Fact(n:IN)
  DECL INT n
  IF n <= 1 THEN
    RETURN 1
  ENDIF
  RETURN n * Fact(n - 1)
ENDFCT
`,
  'flow.dat': `&ACCESS RVP
DEFDAT flow PUBLIC
DECL GLOBAL INT gCount=0
ENDDAT
`,
  'logval.src': `DEF LogVal(v:IN)
  DECL REAL v
  $TIMER[1] = v
END
`,
});
// Log(txt, v): MsgNotify(txt) 로 이름을 출력하고, 다른 .src 의 LogVal(v) 에서 값을 가로채 기록
check(!ctrl.compileError, `컴파일 ${ctrl.compileError ? JSON.stringify(ctrl.compileError) : ''}`);
check(ctrl.main === 'flow.src', `pickMain 은 서브프로그램이 아닌 flow.src (${ctrl.main})`);
const rec = [];
ctrl.on('log', (e) => { if (e.src === 'program') rec.push(e.msg); });
const timerVals = [];
let st;
{
  const prog = ctrl.program;
  const lv = prog.procs.LOGVAL;
  const orig = lv.code[0].run;
  lv.code[0].run = (vm, f) => { timerVals.push(f.locals.get('V')); return orig(vm, f); };
  st = await run(20);
}
check(st === 'done', `스니펫 실행 (status=${st})`);
const msgs = rec.filter((m) => m.startsWith('[MSG] ')).map((m) => m.slice(6));
const kv = {};
msgs.slice(1).forEach((m, i) => { kv[m] = timerVals[i]; });
const want = { sum: 30, while: 3, repeat: 0, loop: 4, step: 430, forend: -2, case4: 4, ifand: 1, sq: 49, fact: 120, int: 3, real: 7, out: 431, in: 431, goto: 5, exor: 1, bits: 2, frx: 15, partial: 114, gvar: 10, str: 3, mode: 1 };
for (const [k, v] of Object.entries(want)) check(kv[k] === v, `${k} = ${kv[k]} (기대 ${v})`);
check(msgs[0] === 'sum=', 'MsgNotify 출력');

// ---------------------------------------------------------------- 이동
console.log('[스니펫] 이동/기하 연산자/부분 목표/IO');
t = Date.now();
ctrl.setGripper('robotiq-2f85');
load({
  'mv.src': `DEF mv( )
  DECL E6POS p
  DECL INT n
  BAS(#INITMOV, 0)
  $TOOL = TOOL_DATA[1]
  $BASE = $NULLFRAME
  PTP $H_POS
  PTP {A1 20}
  PTP HOME Vel=100 % DEFAULT
  Show("home", $AXIS_ACT.A1)
  PTP XP1
  p = $POS_ACT
  Show("p1x", p.X)
  LIN XP1 : {X 0,Y 0,Z -50,A 0,B 0,C 0}
  p = $POS_ACT
  Show("geoz", p.Z)
  LIN {Z 300}
  p = $POS_ACT
  Show("partz", p.Z)
  Show("partx", p.X)
  LIN_REL {X 50}
  p = $POS_ACT
  Show("relx", p.X)
  LIN_REL {Z 20} #TOOL
  p = $POS_ACT
  Show("reltoolz", p.Z)
  $VEL.CP = 0.5
  LIN XP1 C_DIS
  CIRC {X 500,Y 50,Z 300}, {X 550,Y 0,Z 300}
  p = $POS_ACT
  Show("circx", p.X)
  LIN XP1
  CIRC {X 500,Y 50,Z 300}, {X 550,Y 0,Z 300}, CA 180
  p = $POS_ACT
  Show("cax", p.X)
  PTP {A1 10}
  Show("a1", $AXIS_ACT.A1)
  PTP_REL {A1 -10}
  Show("a1rel", $AXIS_ACT.A1)
  PTP XP1
  $BASE = {X 0,Y 0,Z 100,A 0,B 0,C 0}
  LIN {X 450,Y 0,Z 200,A 180,B 0,C 180}
  $BASE = $NULLFRAME
  p = $POS_ACT
  Show("basez", p.Z)
  PTP P1 Vel=50 % PDAT1 Tool[1]:gripper Base[0]
  LIN P2 Vel=0.5 m/s CPDAT1 Tool[1]:gripper Base[0]
  p = $POS_ACT
  Show("ilfz", p.Z)
  $OUT[5] = TRUE
  Show("out5", $OUT[5])
  PULSE($OUT[6], TRUE, 0.3)
  WAIT FOR $IN[7] == TRUE
  Show("in7", $IN[7])
  WAIT SEC 0.1
  n = $OV_PRO
  Show("ov", n)
END

DEF Show(t:IN, v:IN)
  DECL CHAR t[20]
  DECL REAL v
  MsgNotify(t)
  gLast = v
END
`,
  'mv.dat': `DEFDAT mv PUBLIC
DECL GLOBAL REAL gLast=0
DECL E6POS XP1={X 450.0,Y 0.0,Z 300.0,A 180.0,B 0.0,C 180.0,S 2,T 2,E1 0.0,E2 0.0,E3 0.0,E4 0.0,E5 0.0,E6 0.0}
DECL E6POS XP2={X 450.0,Y 0.0,Z 250.0,A 180.0,B 0.0,C 180.0,E1 0.0,E2 0.0,E3 0.0,E4 0.0,E5 0.0,E6 0.0}
DECL FDAT FP1={TOOL_NO 1,BASE_NO 0,IPO_FRAME #BASE,POINT2[] " "}
DECL FDAT FP2={TOOL_NO 1,BASE_NO 0,IPO_FRAME #BASE,POINT2[] " "}
DECL PDAT PPDAT1={VEL 50.000,ACC 100.000,APO_DIST 100.000}
DECL LDAT LCPDAT1={VEL 0.5,ACC 100.000,APO_DIST 100.000,APO_FAC 50.0000,ORI_TYP #VAR}
ENDDAT
`,
});
check(!ctrl.compileError, `이동 스니펫 컴파일 ${ctrl.compileError ? JSON.stringify(ctrl.compileError) : ''}`);
const vals = {};
ctrl.removeAllListeners('log');
{
  const prog = ctrl.program;
  const sh = prog.procs.SHOW;
  const last = sh.code[sh.code.length - 1];
  const orig = last.run;
  last.run = (vm, f) => { vals[f.locals.get('T')] = f.locals.get('V'); return orig(vm, f); };
}
setTimeout(() => ctrl.setDI(7, true), 2500);
let pulseSeen = false;
const pw = setInterval(() => { if (ctrl.getDO(6)) pulseSeen = true; }, 10);
st = await run(60);
await sleep(400); // PULSE(0.3 s) 복귀 대기
clearInterval(pw);
check(st === 'done', `이동 스니펫 실행 (status=${st})`);
const near = (k, v, tol = 0.5) => { const ok = Math.abs((vals[k] ?? NaN) - v) <= tol; check(ok, `${k} = ${vals[k]?.toFixed?.(2)} (기대 ${v})`); };
near('home', 0);
near('p1x', 450);
near('geoz', 350); // 툴 Z 가 아래 방향 → 툴 기준 -50 은 위로
near('partz', 300);
near('partx', 450);
near('relx', 500);
near('reltoolz', 280);
near('circx', 550);
near('cax', 550);
near('a1', 10);
near('a1rel', 0);
near('basez', 300);
near('ilfz', 250);
near('out5', 1);
near('in7', 1);
near('ov', 100);
check(pulseSeen && !ctrl.getDO(6), 'PULSE 출력 후 복귀');

// ---------------------------------------------------------------- readVar / writeVar
console.log('[readVar/writeVar]');
check(krl.readVar(ctrl, '$OV_PRO') === '100', `$OV_PRO ${krl.readVar(ctrl, '$OV_PRO')}`);
check(krl.writeVar(ctrl, '$OV_PRO', '50') && ctrl.override === 50, '$OV_PRO 쓰기 → override');
ctrl.setOverride(100);
const ax = krl.readVar(ctrl, '$AXIS_ACT');
check(/^\{E6AXIS: A1 [-\d.]+, A2 [-\d.]+, A3 [-\d.]+, A4 [-\d.]+, A5 [-\d.]+, A6 [-\d.]+, E1 0\.0/.test(ax), `$AXIS_ACT ${ax}`);
const pa = krl.readVar(ctrl, '$POS_ACT');
check(/^\{E6POS: X [-\d.]+, Y [-\d.]+, Z [-\d.]+, A [-\d.]+, B [-\d.]+, C [-\d.]+, S \d+, T \d+, E1 0\.0/.test(pa), `$POS_ACT ${pa}`);
check(krl.readVar(ctrl, '$OUT[5]') === 'TRUE' && krl.readVar(ctrl, '$IN[7]') === 'TRUE' && krl.readVar(ctrl, '$OUT[9]') === 'FALSE', '$OUT/$IN 읽기');
check(krl.writeVar(ctrl, '$OUT[3]', 'TRUE') && ctrl.getDO(3), '$OUT[3] 쓰기');
check(krl.readVar(ctrl, '$MODE_OP') === '#T1', `$MODE_OP ${krl.readVar(ctrl, '$MODE_OP')}`);
check(krl.readVar(ctrl, 'XP1') === '{E6POS: X 450.0, Y 0.0, Z 300.0, A 180.0, B 0.0, C 180.0, S 2, T 2, E1 0.0, E2 0.0, E3 0.0, E4 0.0, E5 0.0, E6 0.0}', `XP1 ${krl.readVar(ctrl, 'XP1')}`);
check(krl.readVar(ctrl, 'XP1.X') === '450.0', `XP1.X ${krl.readVar(ctrl, 'XP1.X')}`);
check(krl.writeVar(ctrl, 'XP1.Z', '320.5') && krl.readVar(ctrl, 'XP1.Z') === '320.5', 'XP1.Z 쓰기');
check(krl.writeVar(ctrl, 'XP1', '{E6POS: X 100.0, Y 1.5, Z 500.0, A 0.0, B 90.0, C 0.0, S 6, T 27}') && krl.readVar(ctrl, 'XP1').startsWith('{E6POS: X 100.0, Y 1.5, Z 500.0, A 0.0, B 90.0, C 0.0, S 6, T 27, E1 0.0'), `XP1 왕복 ${krl.readVar(ctrl, 'XP1')}`);
check(krl.writeVar(ctrl, 'gLast', '12.25') && krl.readVar(ctrl, 'gLast') === '12.25', 'REAL 변수');
check(krl.readVar(ctrl, 'nope') === undefined, '없는 변수 undefined');
check(krl.writeVar(ctrl, 'nope', '1') === false, '없는 변수 쓰기 실패');
check(formatValue(parseValue('{FDAT: TOOL_NO 1, BASE_NO 0, IPO_FRAME #BASE}')) === '{FDAT: TOOL_NO 1, BASE_NO 0, IPO_FRAME #BASE}', 'formatValue/parseValue 열거형');
check(formatValue(parseValue('"abc"')) === '"abc"' && formatValue(parseValue('FALSE')) === 'FALSE' && formatValue(123) === '123', '기본형 형식');

// ---------------------------------------------------------------- 컴파일 오류
console.log('[컴파일 오류]');
load({ 'bad.src': 'DEF bad( )\n  IF TRUE THEN\n    $OUT[1]=TRUE\nEND\n' });
check(!!ctrl.compileError, `닫히지 않은 IF (${ctrl.compileError?.msg} @${ctrl.compileError?.line})`);
load({ 'bad.src': 'DEF bad( )\n  $OUT[1]=TRUE\n  NoSuch(1)\nEND\n' });
check(ctrl.compileError?.line === 3, `미정의 서브프로그램 라인 (${ctrl.compileError?.msg} @${ctrl.compileError?.line})`);

console.log(`\n${fails ? `실패 ${fails}건` : '모두 통과'} (${((Date.now() - T0) / 1000).toFixed(1)} s)`);
process.exit(fails ? 1 : 0);
