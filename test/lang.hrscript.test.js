// HRScript 언어 모듈 테스트: node test/lang.hrscript.test.js
import { Controller } from '../server/controller.js';
import hr from '../server/lang/hrscript.js';
import { toVendorPose } from '../shared/poseformat.js';

let fails = 0;
const ok = (cond, msg) => { if (cond) console.log('  ok  ', msg); else { fails++; console.log('  FAIL', msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HDR = 'Hyundai Robot Job File; { version: 1.6, mech_type: "HH7", total_axis: 6, aux_axis: 0 }';

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
  c.loadFiles(files || hr.defaultFiles(c), true); // 같은 제조사 내 모델 변경 시 예제 재생성
  c.setServo(true);
  c.setOverride(100);
  return c;
}

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
  ok(hr.readVar(c, 'V1%') === 4, `${robotId}: V1% = 4 → ${hr.readVar(c, 'V1%')}`);
}

// ---------------------------------------------------------------- 흐름/변수
async function testFlow() {
  const main = [
    HDR,
    "     ' 흐름 테스트",
    '     V1%=0',
    '     *L1',
    '     V1%=V1%+1',
    '     IF V1%<5 THEN *L1',
    '     V2!=0.5',
    '     FOR V3%=1 TO 10 STEP 3',
    '       V2!=V2!+V3%',
    '     NEXT',
    '     IF V1%=4 THEN',
    '       V4%=1',
    '     ELSEIF V1%=5 THEN',
    '       V4%=2',
    '     ELSE',
    '       V4%=3',
    '     ENDIF',
    '     VAR cnt%=0',
    '     WHILE cnt%<3 AND V1%>0',
    '       cnt%=cnt%+1',
    '     ENDWHILE',
    '     V5%=cnt%',
    '     V6$="AB"+"C"',
    '     CALL 2',
    '     P1={100,200,300,180,0,180}',
    '     P2=P1+(10,0,-5,0,0,0)',
    '     P2.Z=P2.Z+1',
    '     V7!=P2.X+P2.Z',
    '     GP3=Shift(P1,1,2,3)',
    '     IF V1%<>5 THEN GOTO *BAD',
    '     V8%=1',
    '     GOTO *FIN',
    '     *BAD',
    '     V8%=-1',
    '     *FIN',
    '     PRINT "V1%=", V1%',
    '     END',
  ].join('\n');
  const sub = [HDR, '     LV1%=7', '     V10%=V10%+LV1%', '     RETURN', '     V10%=999', '     END'].join('\n');
  const c = mkCtrl('hyundai-hh7', { '0001.job': main, '0002.job': sub });
  ok(!c.compileError, `흐름: 컴파일 ${c.compileError ? JSON.stringify(c.compileError) : ''}`);
  await runToEnd(c, 10);
  ok(c.vm.status === 'done', `흐름: 실행 완료 (${c.vm.status})`);
  const rv = (n) => hr.readVar(c, n);
  ok(rv('V1%') === 5, `라벨/한줄 IF 루프 V1% = 5 → ${rv('V1%')}`);
  ok(rv('V2!') === 22.5, `FOR STEP V2! = 22.5 → ${rv('V2!')}`);
  ok(rv('V3%') === 13, `FOR 종료값 V3% = 13 → ${rv('V3%')}`);
  ok(rv('V4%') === 2, `ELSEIF V4% = 2 → ${rv('V4%')}`);
  ok(rv('V5%') === 3, `VAR/WHILE V5% = 3 → ${rv('V5%')}`);
  ok(rv('V6$') === 'ABC', `문자열 V6$ → ${rv('V6$')}`);
  ok(rv('V10%') === 7, `CALL/RETURN V10% = 7 → ${rv('V10%')}`);
  ok(rv('V7!') === 110 + 296, `포즈 연산 V7! = 406 → ${rv('V7!')}`);
  ok(rv('GP3')?.v.join(',') === '101,202,303,180,0,180', `Shift → GP3 ${rv('GP3')?.v}`);
  ok(rv('V8%') === 1, `GOTO V8% = 1 → ${rv('V8%')}`);
}

// ---------------------------------------------------------------- IO 대기
async function testIO() {
  const main = [
    HDR,
    '     DO5=1',
    '     DO[6]=ON',
    '     WAIT DI7=1',
    '     V1%=1',
    '     WAIT DI8,T=0.3',
    '     WAITI DI7',
    '     V2%=DI7+DI[7]',
    '     DELAY 0.1',
    '     DO6=0',
    '     END',
  ].join('\n');
  const c = mkCtrl('hyundai-hh7', { '0001.job': main });
  ok(!c.compileError, `IO: 컴파일 ${c.compileError ? JSON.stringify(c.compileError) : ''}`);
  setTimeout(() => c.setDI(7, true), 300);
  const t = await runToEnd(c, 10);
  ok(c.vm.status === 'done', `IO: 실행 완료 (${t.toFixed(2)}s)`);
  ok(t >= 0.65, `IO: WAIT 대기 시간 반영 (${t.toFixed(2)}s ≥ 0.65)`);
  ok(c.getDO(5) && !c.getDO(6), 'IO: DO5=1, DO6=0');
  ok(hr.readVar(c, 'V1%') === 1 && hr.readVar(c, 'V2%') === 2, `IO: V1%=1, V2%=2 → ${hr.readVar(c, 'V2%')}`);
}

// ---------------------------------------------------------------- 모션 (원호/인라인/Hi5 형식)
async function testMotion() {
  const c0 = new Controller();
  c0.setRobot('hyundai-hh7');
  const v = toVendorPose('hyundai', c0.tcpPose());
  const cx = v[0], cy = v[1], z = v[2] - 100, rr = 60;
  const T = (x, y) => `(${[x, y, z, v[3], v[4], v[5]].map((a) => a.toFixed(3)).join(',')})`;
  const main = [
    HDR,
    `     S1   MOVE L,${T(cx + rr, cy)},S=300mm/sec,A=0,T=0`,
    `     S2   MOVE C,${T(cx, cy + rr)},S=300mm/sec,A=0,T=0`,
    `     S3   MOVE C,${T(cx - rr, cy)},S=300mm/sec,A=0,T=0`,
    '     S4   MOVE L,Pose(' + [cx, cy, z + 40, v[3], v[4], v[5]].join(',') + '),S=0.5m/sec,A=0,T=0',
    '     S5   MOVE P,S=80%,A=0,T=0  (' + c0.robot.home.join(',') + ')A',
    '     S6   MOVE P,[' + c0.robot.home.map((a, i) => (i === 0 ? a + 10 : a)).join(',') + '],S=V9%,A=0,T=0',
    '     END',
  ].join('\n');
  const c = mkCtrl('hyundai-hh7', { '0001.job': main });
  hr.writeVar(c, 'V9%', 70);
  ok(!c.compileError, `모션: 컴파일 ${c.compileError ? JSON.stringify(c.compileError) : ''}`);
  let maxDev = 0, samples = 0;
  const iv = setInterval(() => {
    if (c.vm?.current?.line === 4 && c.segment) {
      const p = c.tcpPose().p;
      maxDev = Math.max(maxDev, Math.abs(Math.hypot(p[0] - cx, p[1] - cy) - rr)); samples++;
    }
  }, 10);
  await runToEnd(c, 30);
  clearInterval(iv);
  ok(c.vm.status === 'done', `모션: 실행 완료 (${c.vm.status})`);
  ok(samples > 5 && maxDev < 0.5, `MOVE C 원호 반경 오차 ${maxDev.toFixed(3)}mm (샘플 ${samples})`);
  ok(Math.abs(c.joints[0] - c.robot.home[0] - 10) < 1e-6, `관절 리터럴 이동 J1 = ${c.joints[0].toFixed(3)}`);
}

// ---------------------------------------------------------------- 컴파일 오류 라인
function testErrors() {
  const c = new Controller();
  c.setRobot('hyundai-hh7');
  const chk = (text, line, what) => {
    c.loadFiles({ '0001.job': text }, true);
    const e = c.compileError;
    ok(e && e.line === line && e.file === '0001.job', `${what}: 오류 라인 ${line} → ${e ? `${e.file}:${e.line} ${e.msg}` : '오류 없음'}`);
  };
  chk(`${HDR}\n     V1%=1\n     FOO BAR\n     END`, 3, '알 수 없는 명령');
  chk(`${HDR}\n     GOTO *NONE\n     END`, 2, '없는 라벨');
  chk(`${HDR}\n     CALL 7\n     END`, 2, '없는 잡');
  chk(`${HDR}\n     IF V1%=1 THEN\n     V2%=1\n     END`, 2, 'ENDIF 누락');
  chk(`${HDR}\n     V1%=1\n     MOVE L,S=100mm/sec\n     END`, 3, 'MOVE 위치 누락');
  chk(`${HDR}\n     NEXT\n     END`, 2, 'FOR 없는 NEXT');
  chk(`${HDR}\n     V1%=(1+\n     END`, 2, '식 오류');
  chk(`${HDR}\n     X=1\n     END`, 2, '알 수 없는 변수');
  ok(hr.pickMain(['0003.job', '0001.job', '0002.job']) === '0001.job', 'pickMain: 0001.job');
  ok(hr.pickMain(['0012.job', '0005.job']) === '0005.job', 'pickMain: 가장 낮은 번호');
  ok(hr.writeVar(c, 'V3!', '2.5') && hr.readVar(c, 'V3!') === 2.5, 'writeVar/readVar V3!');
  ok(hr.writeVar(c, 'GP1', [1, 2, 3, 4, 5, 6]) && hr.readVar(c, 'GP1').v[2] === 3, 'writeVar/readVar GP1');
}

const t0 = performance.now();
try {
  testErrors();
  await testFlow();
  await testIO();
  await testMotion();
  console.log('-- 기본 예제 (병렬) --');
  await Promise.all(['hyundai-hh7', 'hyundai-hh020', 'hyundai-hs220'].map(testDefault));
} catch (e) { fails++; console.error(e); }
console.log(`\n${fails ? 'FAILED' : 'PASSED'} (${fails} 실패, ${((performance.now() - t0) / 1000).toFixed(1)}s)`);
process.exit(fails ? 1 : 0);
