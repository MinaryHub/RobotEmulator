// INFORM 언어 모듈 테스트: node test/lang.inform.test.js
import { Controller } from '../server/controller.js';
import inform from '../server/lang/inform.js';
import { toVendorPose } from '../shared/poseformat.js';

let fails = 0;
const ok = (cond, msg) => { if (cond) console.log('  ok  ', msg); else { fails++; console.log('  FAIL', msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (files) c.loadFiles(files, true);
  else c.loadFiles(inform.defaultFiles(c), true); // 같은 제조사 내 모델 변경 시 예제 재생성
  c.setServo(true);
  c.setOverride(100);
  return c;
}

// ---------------------------------------------------------------- 기본 예제 (모델별 병렬 실행)
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
  ok(c.regs.get('I:0') === 4, `${robotId}: I000 = 4 (작업 카운트) → ${c.regs.get('I:0')}`);
  return c;
}

// ---------------------------------------------------------------- 변수/라벨/점프/구조화
async function testFlow() {
  const files = {
    'TEST.JBI': [
      '/JOB', '//NAME TEST', '//POS', '///NPOS 0,0,0,0,0,0', '//INST', '///DATE 2026/10/09 12:00', '///ATTR SC,RW',
      'NOP',
      "'변수 테스트",
      'SET I000 0',
      'SET R001 0.5',
      '*L1',
      'INC I000',
      'ADD R001 1.5',
      'JUMP *L1 IF I000<5',
      'SET B001 I000',
      'MUL B001 3',
      'DIV I000 2',
      'SUB I000 1',
      'SET D002 -100000',
      'CALL JOB:SUB1',
      'CALL JOB:SUB1 IF I000=99',
      'IFTHEN I000=1',
      'SET I005 11',
      'ELSEIF I000=2',
      'SET I005 22',
      'ELSE',
      'SET I005 33',
      'ENDIF',
      'SET I006 0',
      'WHILEEXP I006<3',
      'INC I006',
      'ENDWHILE',
      'SET P003 P004',
      'SETE P003 (1) 12.5',
      'GETE R009 P003 (1)',
      'JUMP *SKIP IF B001<>15',
      'SET I007 1',
      '*SKIP',
      'END',
    ].join('\n'),
    'SUB1.JBI': ['/JOB', '//NAME SUB1', '//POS', '///NPOS 0,0,0,0,0,0', '//INST', 'NOP', 'INC I010', 'RET', 'SET I010 999', 'END'].join('\n'),
  };
  const c = mkCtrl('yaskawa-gp7', files);
  ok(!c.compileError, `흐름: 컴파일 ${c.compileError ? JSON.stringify(c.compileError) : ''}`);
  inform.writeVar(c, 'P004', [1, 2, 3, 4, 5, 6]);
  await runToEnd(c, 10);
  ok(c.vm.status === 'done', `흐름: 실행 완료 (${c.vm.status})`);
  const rv = (n) => inform.readVar(c, n);
  ok(rv('I000') === 1, `I000 = 1 → ${rv('I000')}`);
  ok(Math.abs(rv('R001') - 8) < 1e-9, `R001 = 8 → ${rv('R001')}`);
  ok(rv('B001') === 15, `B001 = 15 → ${rv('B001')}`);
  ok(rv('D002') === -100000, `D002 = -100000 → ${rv('D002')}`);
  ok(rv('I005') === 11, `IFTHEN 분기 I005 = 11 → ${rv('I005')}`);
  ok(rv('I006') === 3, `WHILEEXP I006 = 3 → ${rv('I006')}`);
  ok(rv('I010') === 1, `CALL/RET I010 = 1 → ${rv('I010')}`);
  ok(rv('I007') === 1, `JUMP IF <> I007 = 1 → ${rv('I007')}`);
  ok(rv('R009') === 12.5, `SETE/GETE R009 = 12.5 → ${rv('R009')}`);
  ok(rv('P003')?.v?.join(',') === '12.5,2,3,4,5,6', `SET P / SETE P003 → ${rv('P003')?.v}`);
}

// ---------------------------------------------------------------- IO 대기
async function testIO() {
  const text = [
    'NOP',
    'DOUT OT#(5) ON',
    'WAIT IN#(7)=ON',
    'SET B002 1',
    'WAIT IN#(8)=ON T=0.30',
    'DIN B003 IN#(7)',
    'PULSE OT#(6) T=0.10',
    'DOUT OG#(2) 5',
    'TIMER T=0.10',
    'JUMP *A IF IN#(7)=OFF',
    'SET B004 1',
    '*A',
    'END',
  ].join('\n');
  const c = mkCtrl('yaskawa-gp7', { 'IO.JBI': text });
  ok(!c.compileError, `IO: 컴파일 ${c.compileError ? JSON.stringify(c.compileError) : ''}`);
  setTimeout(() => c.setDI(7, true), 300);
  const t = await runToEnd(c, 10);
  ok(c.vm.status === 'done', `IO: 실행 완료 (${t.toFixed(2)}s)`);
  ok(t >= 0.75, `IO: WAIT 대기 시간 반영 (${t.toFixed(2)}s ≥ 0.75)`);
  ok(c.getDO(5) && !c.getDO(6), 'IO: OT#(5)=ON, PULSE 후 OT#(6)=OFF');
  ok(c.getDO(9) && !c.getDO(10) && c.getDO(11), 'IO: OG#(2)=5 → OT#9,11 ON');
  ok(inform.readVar(c, 'B002') === 1 && inform.readVar(c, 'B003') === 1 && inform.readVar(c, 'B004') === 1, 'IO: B002/B003/B004 = 1');
}

// ---------------------------------------------------------------- 원호/증분/P 변수 이동
async function testMotion() {
  const c0 = mkCtrl('yaskawa-gp7');
  const home = c0.tcpPose();
  const v = toVendorPose('yaskawa', home);
  const cx = v[0], cy = v[1], z = v[2] - 100, rr = 60;
  const P = (x, y, zz = z) => [x, y, zz, v[3], v[4], v[5]].map((a, i) => (i < 3 ? a.toFixed(3) : a.toFixed(4))).join(',');
  const text = [
    '/JOB', '//NAME MOT', '//POS', '///NPOS 5,0,0,0,0,0', '///TOOL 0', '///POSTYPE BASE', '///RECTAN', '///RCONF 0,0,0,0,0,0,0,0',
    `C00000=${P(cx + rr, cy)}`,
    `C00001=${P(cx, cy + rr)}`,
    `C00002=${P(cx - rr, cy)}`,
    `C00003=${P(cx, cy - rr)}`,
    `C00004=${P(cx + rr, cy)}`,
    '//INST', '///DATE 2026/10/09 12:00', '///ATTR SC,RW', '///GROUP1 RB1',
    'NOP',
    'MOVC C00000 V=300.0',
    'MOVC C00001 V=300.0',
    'MOVC C00002 V=300.0',
    'MOVC C00003 V=300.0',
    'MOVC C00004 V=300.0',
    'MOVL P010 V=500.0',
    'IMOV P011 V=200.0 BF',
    'MOVJ P012 VJ=80.00',
    'END',
  ].join('\n');
  const c = mkCtrl('yaskawa-gp7', { 'MOT.JBI': text });
  ok(!c.compileError, `모션: 컴파일 ${c.compileError ? JSON.stringify(c.compileError) : ''}`);
  inform.writeVar(c, 'P010', { kind: 'pose', v: [cx, cy, z + 50, v[3], v[4], v[5]] });
  inform.writeVar(c, 'P011', [0, 0, -30, 0, 0, 0]);
  inform.writeVar(c, 'P012', { kind: 'joints', v: [...c.robot.home] });
  // 원호 중 반경 확인용 샘플링
  let maxDev = 0, samples = 0;
  const iv = setInterval(() => {
    const cur = c.vm?.current;
    if (cur && cur.line >= 20 && cur.line <= 23 && c.segment) {
      const p = c.tcpPose().p;
      maxDev = Math.max(maxDev, Math.abs(Math.hypot(p[0] - cx, p[1] - cy) - rr)); samples++;
    }
  }, 10);
  await runToEnd(c, 30);
  clearInterval(iv);
  ok(c.vm.status === 'done', `모션: 실행 완료 (${c.vm.status})`);
  ok(samples > 10 && maxDev < 0.5, `MOVC 원호 반경 오차 ${maxDev.toFixed(3)}mm (샘플 ${samples})`);
  ok(c.joints.every((q, i) => Math.abs(q - c.robot.home[i]) < 1e-6), 'MOVJ P012 (관절 P 변수) → HOME');
  // IMOV 확인: 별도 실행
  const c2 = mkCtrl('yaskawa-gp7', { 'IM.JBI': 'NOP\nIMOV P000 V=100 BF\nEND\n' });
  inform.writeVar(c2, 'P000', [10, 0, -40, 0, 0, 0]);
  const z0 = c2.tcpPose().p;
  await runToEnd(c2, 10);
  const z1 = c2.tcpPose().p;
  ok(c2.vm.status === 'done' && Math.abs(z1[2] - z0[2] + 40) < 0.01 && Math.abs(z1[0] - z0[0] - 10) < 0.01, `IMOV BF: Δ=[${(z1[0] - z0[0]).toFixed(2)}, ${(z1[2] - z0[2]).toFixed(2)}]`);
}

// ---------------------------------------------------------------- 컴파일 오류 라인
function testErrors() {
  const c = new Controller();
  const chk = (text, line, what) => {
    c.loadFiles({ 'E.JBI': text }, true);
    const e = c.compileError;
    ok(e && e.line === line && e.file === 'E.JBI', `${what}: 오류 라인 ${line} → ${e ? `${e.file}:${e.line} ${e.msg}` : '오류 없음'}`);
  };
  chk('NOP\nSET I000 1\nFOO 1\nEND', 3, '알 수 없는 명령');
  chk('/JOB\n//NAME E\n//POS\n///NPOS 0,0,0,0,0,0\n//INST\nNOP\nMOVJ C00003 VJ=10.00\nEND', 7, '정의되지 않은 위치');
  chk('NOP\nJUMP *NOWHERE\nEND', 2, '없는 라벨');
  chk('NOP\nCALL JOB:NOJOB\nEND', 2, '없는 잡');
  chk('NOP\nJUMP *A IF IN#(1)=\n*A\nEND', 2, '조건식 오류');
  chk('NOP\nMOVC P000 V=10\nMOVC P001 V=10\nEND', 2, 'MOVC 2점');
  chk('NOP\nIFTHEN B000=1\nNOP\nEND', 2, 'ENDIF 누락');
  ok(inform.pickMain(['A.JBI', 'MASTER.JBI'], new Map()) === 'MASTER.JBI', 'pickMain: MASTER 우선');
  ok(inform.pickMain(['B.JBI', 'X.JBI'], new Map([['X.JBI', '/JOB\n//NAME MASTER\n']])) === 'X.JBI', 'pickMain: //NAME MASTER 인식');
  ok(inform.writeVar(c, 'B005', 300) && inform.readVar(c, 'B005') === 44, 'writeVar B 바이트 범위 처리');
  ok(!inform.writeVar(c, 'I001', 70000), 'writeVar I 범위 초과 거부');
}

const t0 = performance.now();
try {
  testErrors();
  await testFlow();
  await testIO();
  await testMotion();
  console.log('-- 기본 예제 (병렬) --');
  await Promise.all(['yaskawa-gp7', 'yaskawa-gp12', 'yaskawa-gp25'].map(testDefault));
} catch (e) { fails++; console.error(e); }
console.log(`\n${fails ? 'FAILED' : 'PASSED'} (${fails} 실패, ${((performance.now() - t0) / 1000).toFixed(1)}s)`);
process.exit(fails ? 1 : 0);
