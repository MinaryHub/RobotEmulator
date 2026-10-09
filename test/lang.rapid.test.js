// ABB RAPID 언어 모듈 테스트: node test/lang.rapid.test.js
import { Controller } from '../server/controller.js';
import rapid, { formatValue, parseValue } from '../server/lang/rapid.js';

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

function load(src, name = 'Test.mod') {
  ctrl.loadFiles({ [name]: src }, true);
  ctrl.main = rapid.pickMain([name], ctrl.files);
  ctrl.compile(true);
}
const progLogs = (since) => ctrl.logs.filter((l) => l.src === 'program' && l.t >= since).map((l) => l.msg);

async function defaultTest(robotId) {
  console.log(`[기본 예제] ${robotId}`);
  ctrl.setRobot(robotId);
  ctrl.loadFiles(ctrl.lang.defaultFiles(ctrl), true);
  const before = ctrl.objects.map((o) => [...o.pose.p]);
  const st = await run(80);
  check(st === 'done', `${robotId} 실행 완료 (status=${st})`);
  check(ctrl.alarms.length === 0, `${robotId} 알람 없음`);
  const moved = ctrl.objects.filter((o, i) => Math.hypot(o.pose.p[0] - before[i][0], o.pose.p[1] - before[i][1]) > 20).length;
  check(moved === 4, `${robotId} 공작물 4개 이동 (${moved})`);
}

// ---------------------------------------------------------------- 기본 예제
ctrl.setRobot('abb-irb1200');
check(ctrl.files.has('MainModule.mod'), 'defaultFiles 로드');
check(!ctrl.compileError, `기본 예제 컴파일 ${ctrl.compileError ? JSON.stringify(ctrl.compileError) : ''}`);
await defaultTest('abb-irb1200');
await defaultTest('abb-irb2600');

// ---------------------------------------------------------------- 문법 스니펫
ctrl.setRobot('abb-irb1200');
console.log('[스니펫] 제어 흐름/함수/데이터');
let t = Date.now();
load(`MODULE TestMod
  CONST num nArr{5} := [1,2,3,4,5];
  VAR num nSum := 0;
  VAR num nMat{2,3} := [[1,2,3],[4,5,6]];
  PERS num nPers := 7;
  VAR string sTxt := "abc";
  VAR bool bFlag := FALSE;
  VAR pos ps := [1,2,3];
  RECORD myrec
    num a;
    string s;
  ENDRECORD
  VAR myrec rec := [5, "hi"];
  VAR robtarget pT := [[400,0,400],[0,0,1,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]];

  FUNC num Square(num x)
    RETURN x * x;
  ENDFUNC

  FUNC num Fact(num n)
    IF n <= 1 RETURN 1;
    RETURN n * Fact(n - 1);
  ENDFUNC

  PROC AddTo(INOUT num acc, num v, \\num mul)
    IF Present(mul) THEN
      acc := acc + v * mul;
    ELSE
      acc := acc + v;
    ENDIF
  ENDPROC

  PROC main()
    VAR num i := 0;
    VAR num k;
    FOR j FROM 1 TO Dim(nArr, 1) DO
      nSum := nSum + nArr{j};
    ENDFOR
    TPWrite "sum=" \\Num:=nSum;
    WHILE i < 3 DO
      Incr i;
    ENDWHILE
    TPWrite "i=" \\Num:=i;
    FOR j FROM 10 TO 1 STEP -3 DO
      k := k + 1;
    ENDFOR
    TPWrite "k=" \\Num:=k;
    TEST i
      CASE 1, 2:
        TPWrite "case12";
      CASE 3:
        TPWrite "case3";
      DEFAULT:
        TPWrite "default";
    ENDTEST
    IF i = 1 THEN
      TPWrite "no";
    ELSEIF i = 3 THEN
      TPWrite "elseif";
    ELSE
      TPWrite "no";
    ENDIF
    TPWrite "sq=" \\Num:=Square(4) + Fact(5);
    AddTo nSum, 5;
    AddTo nSum, 1 \\mul:=10;
    TPWrite "acc=" \\Num:=nSum;
    nMat{2,3} := 60;
    TPWrite "mat=" + ValToStr(nMat{2,3});
    pT.trans.z := pT.trans.z + 50;
    pT.trans := pT.trans + ps;
    TPWrite "pT=" \\Pos:=pT.trans;
    rec.a := rec.a + 1;
    TPWrite "rec=" + rec.s + NumToStr(rec.a, 1);
    TPWrite "round=" \\Num:=Round(3.14159\\Dec:=2);
    TPWrite "len=" \\Num:=StrLen(sTxt + "de");
    TPWrite "atan2=" \\Num:=ATan2(1, 1);
    TPWrite "ez=" \\Num:=Round(EulerZYX(\\Z, OrientZYX(30, 0, 0))\\Dec:=3);
    i := 0;
    lbl:
    Incr i;
    IF i < 5 GOTO lbl;
    TPWrite "goto=" \\Num:=i;
    %"Sub" + "Proc"%;
    bFlag := NOT bFlag AND TRUE;
    TPWrite "flag" \\Bool:=bFlag;
  ENDPROC

  PROC SubProc()
    TPWrite "late";
  ENDPROC
ENDMODULE
`);
let st = await run(20);
let logs = progLogs(t);
check(st === 'done', `스니펫 실행 (status=${st})`);
const has = (s) => { const ok = logs.includes(s); if (!ok) console.log('    logs:', logs); return ok; };
check(has('sum=15'), 'FOR + 배열 합계');
check(has('i=3'), 'WHILE/Incr');
check(has('k=4'), 'FOR STEP -3');
check(has('case3'), 'TEST/CASE');
check(has('elseif'), 'IF/ELSEIF');
check(has('sq=136'), 'FUNC 재귀');
check(has('acc=30'), 'INOUT + 선택 인자');
check(has('mat=60'), '2차원 배열');
check(has('pT=[401,2,453]'), '컴포넌트 대입 / pos 덧셈');
check(has('rec=hi6.0'), 'RECORD');
check(has('round=3.14'), 'Round\\Dec');
check(has('len=5'), 'StrLen');
check(has('atan2=45'), 'ATan2');
check(has('ez=30'), 'OrientZYX/EulerZYX');
check(has('goto=5'), 'GOTO/라벨/한 줄 IF');
check(has('late'), '늦은 바인딩 호출');
check(has('flagTRUE'), 'NOT/AND');

// ---------------------------------------------------------------- 이동/Offs/RelTool/IO
console.log('[스니펫] 이동/Offs/RelTool/CRobT/WaitDI');
t = Date.now();
load(`MODULE MoveTest
  PERS tooldata tG := [TRUE,[[0,0,150],[1,0,0,0]],[1,[0,0,50],[1,0,0,0],0,0,0]];
  CONST robtarget p10 := [[450,0,300],[0,0,1,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]];
  VAR robtarget pCur;
  VAR jointtarget jCur;
  PERS wobjdata wTable := [FALSE,TRUE,"",[[0,0,100],[1,0,0,0]],[[0,0,0],[1,0,0,0]]];
  VAR num nDi := 0;
  PROC main()
    MoveAbsJ [[0,0,0,0,90,0],[9E9,9E9,9E9,9E9,9E9,9E9]], v1000, fine, tool0;
    MoveJ p10, v1000, fine, tG;
    pCur := CRobT(\\Tool:=tG);
    TPWrite "p10 x=" \\Num:=Round(pCur.trans.x);
    MoveL Offs(p10, 50, 0, -50), v500, fine, tG;
    pCur := CRobT(\\Tool:=tG \\WObj:=wobj0);
    TPWrite "offs=" \\Pos:=[Round(pCur.trans.x), Round(pCur.trans.y), Round(pCur.trans.z)];
    MoveL RelTool(p10, 0, 0, 20 \\Rz:=45), v500, fine, tG;
    pCur := CRobT(\\Tool:=tG);
    TPWrite "reltool z=" \\Num:=Round(pCur.trans.z);
    TPWrite "reltool rz=" \\Num:=Round(EulerZYX(\\Z, pCur.rot));
    MoveC Offs(p10, 50, 50, 0), Offs(p10, 100, 0, 0), v300, fine, tG;
    pCur := CRobT(\\Tool:=tG);
    TPWrite "circ x=" \\Num:=Round(pCur.trans.x);
    MoveL p10, v300, fine, tG \\WObj:=wTable;
    pCur := CRobT(\\Tool:=tG);
    TPWrite "wobj z=" \\Num:=Round(pCur.trans.z);
    pCur := CRobT(\\Tool:=tG \\WObj:=wobj0);
    TPWrite "world z=" \\Num:=Round(pCur.trans.z);
    jCur := CJointT();
    MoveJ Offs(p10,0,0,50), vmax, z50, tG;
    VelSet 50, 200;
    MoveL p10, v1000, fine, tG;
    SetDO do_Valve, 1;
    WaitDO do_Valve, 1;
    Set DO5;
    TPWrite "do5=" \\Num:=DOutput(DO5);
    WaitDI DI7, 1 \\MaxTime:=5;
    WaitUntil DInput(DI7) = 1 AND DOutput(DO5) = 1 \\MaxTime:=2;
    IF DI7 = 1 nDi := 1;
    TPWrite "di=" \\Num:=nDi;
    WaitTime 0.1;
  ENDPROC
ENDMODULE
`);
setTimeout(() => ctrl.setDI(7, true), 1500);
st = await run(40);
logs = progLogs(t);
check(st === 'done', `이동 스니펫 실행 (status=${st})`);
check(has('p10 x=450'), 'MoveJ robtarget + CRobT');
check(has('offs=[500,0,250]'), 'Offs + MoveL');
check(has('reltool z=280'), 'RelTool 이동 (툴 Z 아래 방향)');
check(logs.some((l) => /^reltool rz=(-?45|-?135)$/.test(l)), 'RelTool \\Rz');
check(has('circ x=550'), 'MoveC');
check(has('wobj z=300') && has('world z=400'), 'WObj 오프셋 (활성 wobj 기준 CRobT)');
check(has('do5=1'), 'Set/DOutput');
check(has('di=1'), 'WaitDI (setDI 로 충족) / 신호 비교');
const nValve = ctrl.signalNo('do', 'do_Valve');
check(nValve > 100 && ctrl.getDO(nValve), `이름 신호 자동 매핑 do_Valve → ${nValve}`);

// ---------------------------------------------------------------- readVar / writeVar
console.log('[readVar/writeVar]');
load(`MODULE VarMod
  VAR num nVal := 12.5;
  PERS robtarget pX := [[100,0,500],[1,0,0,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]];
  CONST num nC := 3;
  VAR bool bB := TRUE;
  VAR string sS := "hello";
  PROC main()
    TPWrite "v=" \\Num:=nVal;
  ENDPROC
ENDMODULE
`);
check(rapid.readVar(ctrl, 'T_ROB1/VarMod/nVal') === '12.5', 'readVar num (T_ROB1/Module/sym)');
check(rapid.readVar(ctrl, 'pX') === '[[100,0,500],[1,0,0,0],[0,0,0,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]]', `readVar robtarget ${rapid.readVar(ctrl, 'pX')}`);
check(rapid.readVar(ctrl, 'bB') === 'TRUE' && rapid.readVar(ctrl, 'sS') === '"hello"', 'readVar bool/string');
check(rapid.writeVar(ctrl, 'VarMod/nVal', '42') && rapid.readVar(ctrl, 'nVal') === '42', 'writeVar num');
check(rapid.writeVar(ctrl, 'pX', '[[1,2,3],[0,0,1,0],[1,0,-1,0],[9E9,9E9,9E9,9E9,9E9,9E9]]'), 'writeVar robtarget');
check(rapid.readVar(ctrl, 'pX') === '[[1,2,3],[0,0,1,0],[1,0,-1,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]]', 'robtarget 왕복');
check(rapid.writeVar(ctrl, 'pX.trans.z', '77') && rapid.readVar(ctrl, 'pX.trans') === '[1,2,77]', 'writeVar 컴포넌트');
check(rapid.writeVar(ctrl, 'nC', '5') === false, 'CONST 쓰기 거부');
check(rapid.writeVar(ctrl, 'sS', '"bye"') && rapid.readVar(ctrl, 'sS') === '"bye"', 'writeVar string');
check(rapid.readVar(ctrl, 'nope') === undefined, '없는 변수 undefined');
t = Date.now();
st = await run(10);
check(progLogs(t).includes('v=42'), 'writeVar 값이 프로그램에 반영');
check(formatValue(parseValue('[1,TRUE,"a",[2.5,-3]]')) === '[1,TRUE,"a",[2.5,-3]]', 'formatValue/parseValue');

// ---------------------------------------------------------------- 컴파일 오류
console.log('[컴파일 오류]');
load(`MODULE Bad
  PROC main()
    IF TRUE THEN
      TPWrite "x";
  ENDPROC
ENDMODULE
`);
check(!!ctrl.compileError, `닫히지 않은 IF 오류 보고 (${ctrl.compileError?.msg} @${ctrl.compileError?.line})`);
load(`MODULE Bad2
  PROC main()
    NoSuchProc 1, 2;
  ENDPROC
ENDMODULE
`);
check(ctrl.compileError?.line === 3, `미정의 루틴 라인 보고 (${ctrl.compileError?.msg} @${ctrl.compileError?.line})`);

console.log(`\n${fails ? `실패 ${fails}건` : '모두 통과'} (${((Date.now() - T0) / 1000).toFixed(1)} s)`);
process.exit(fails ? 1 : 0);
