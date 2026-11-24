// Phase 3 종합 테스트: 모션 자세 검증(ConfL/KRL S), 가감속/페이로드, 선독 트리거(KRL TRIGGER/ABB TriggL),
// INFORM ACC=, 홀드 경로 이탈/원경로 복귀(block/auto/recoverPath), 용접 아크, 프로젝트 직렬화
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Controller, REJECT } from '../server/controller.js';
import { planJoint, planLinear } from '../server/motion.js';
import { ProjectStore } from '../server/project.js';
import { fkTcp } from '../shared/kinematics.js';
import { quatFromR } from '../shared/math.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ok   ${msg}`); }
  else { fail++; console.error(`  FAIL ${msg}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitDone(ctrl, maxSec = 10) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxSec * 1000) {
    const s = ctrl.vm?.status;
    if (s && s !== 'running' && s !== 'paused') return s;
    await sleep(25);
  }
  return ctrl.vm?.status ?? 'timeout';
}

const ctrl = new Controller();

try {
  // 1. 모션 가감속 · 페이로드 스케일링
  console.log('[1] 가감속 · 페이로드 스케일링');
  ctrl.setRobot('yaskawa-gp7');
  const jA = [0, 0, 0, 0, -90, 0];
  const jB = [35, 10, -10, 0, -90, 0];
  const segFast = planJoint(ctrl.robot, jA, jB, 1.0, { accelScale: 100, payloadRatio: 0 });
  const segSlowAcc = planJoint(ctrl.robot, jA, jB, 1.0, { accelScale: 20, payloadRatio: 0 });
  const segHeavy = planJoint(ctrl.robot, jA, jB, 1.0, { accelScale: 100, payloadRatio: 1.0 });
  ok(segSlowAcc.duration > segFast.duration * 1.3, `accelScale=20 가감속 연장 (${segFast.duration.toFixed(3)}s → ${segSlowAcc.duration.toFixed(3)}s)`);
  ok(segHeavy.duration > segFast.duration * 1.05, `payloadRatio=1.0 가감속 연장 (${segFast.duration.toFixed(3)}s → ${segHeavy.duration.toFixed(3)}s)`);

  const pA = fkTcp(ctrl.robot, jA, ctrl.tool, null);
  const pB = { p: [pA.p[0] + 100, pA.p[1], pA.p[2]], R: pA.R };
  const linFast = planLinear(ctrl.robot, jA, pB, { tcp: 500 }, ctrl.tool, null, { accelScale: 100, payloadRatio: 0 });
  const linSlow = planLinear(ctrl.robot, jA, pB, { tcp: 500 }, ctrl.tool, null, { accelScale: 25, payloadRatio: 1.0 });
  ok(linSlow.duration > linFast.duration * 1.3, `planLinear accel+payload 연장 (${linFast.duration.toFixed(3)}s → ${linSlow.duration.toFixed(3)}s)`);

  ctrl.setPayload(7, [0, 0, 50]);
  ok(ctrl.snapshot().payload.mass === 7 && ctrl.snapshot().payload.cog[2] === 50, 'setPayload 스냅샷 반영');
  ctrl.setPayload(0);

  // 2. ABB RAPID ConfL \On / \Off, AccSet, TriggIO / TriggL, SetAO, SetGO
  console.log('[2] ABB RAPID ConfL · AccSet · TriggIO/TriggL · SetAO/SetGO');
  ctrl.setRobot('abb-irb120');
  ctrl.setMode('PLAY');
  ctrl.setServo(true);
  ctrl.setTimeScale(4);

  // ConfL \On 에서 의도적으로 잘못된 robconf (cf1=2 → 180~270° 영역 요구) → CONFIG 알람 발생
  ctrl.loadFiles({
    'MainModule.mod': `MODULE MainModule
  PERS tooldata tG := [TRUE,[[0,0,150],[1,0,0,0]],[1,[0,0,50],[1,0,0,0],0,0,0]];
  CONST robtarget pOk  := [[420,0,300],[0,0,1,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]];
  CONST robtarget pBad := [[420,50,300],[0,0,1,0],[2,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]];
  PROC main()
    ConfL \\On;
    MoveJ pOk, v500, fine, tG;
    MoveL pBad, v300, fine, tG;
  ENDPROC
ENDMODULE`,
  }, true);
  await ctrl.start();
  let st = await waitDone(ctrl, 6);
  ok(st === 'error' && ctrl.alarms.some((a) => a.code === 'CONFIG' && a.vendorCode === '50080'), `RAPID ConfL \\On 자세 불일치 → CONFIG/50080 알람 (status=${st})`);
  ctrl.resetAlarms();
  ctrl.setServo(true);

  // ConfL \Off + AccSet + TriggIO/TriggL + SetAO + SetGO
  let triggFiredWhileMoving = false;
  const onIo = (ev) => {
    if (ev.type === 'do' && ev.n === 10 && ev.v === true && ctrl.segs.length > 0) triggFiredWhileMoving = true;
  };
  ctrl.on('io', onIo);
  ctrl.loadFiles({
    'MainModule.mod': `MODULE MainModule
  PERS tooldata tG := [TRUE,[[0,0,150],[1,0,0,0]],[1,[0,0,50],[1,0,0,0],0,0,0]];
  CONST robtarget pA := [[420,-80,300],[0,0,1,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]];
  CONST robtarget pB := [[420,80,300],[0,0,1,0],[2,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]];
  VAR triggdata tOn;
  VAR triggdata tOff;
  PROC main()
    ConfL \\Off;
    AccSet 30, 100;
    SetAO AO2, 6.25;
    SetGO GO1, 53;
    MoveJ pA, v500, fine, tG;
    TriggIO tOn, 20 \\Start \\DOp:=DO10, 1;
    TriggIO tOff, 15 \\DOp:=DO11, 1;
    TriggL pB, v200, tOn, tOff, fine, tG;
  ENDPROC
ENDMODULE`,
  }, true);
  await ctrl.start();
  st = await waitDone(ctrl, 8);
  ctrl.off('io', onIo);
  ok(st === 'done', `RAPID ConfL \\Off + TriggL 완료 (status=${st})`);
  ok(ctrl.accelScale === 30, `RAPID AccSet 30 반영 (accelScale=${ctrl.accelScale})`);
  ok(ctrl.getAO(2) === 6.25, `RAPID SetAO AO2=6.25 (${ctrl.getAO(2)})`);
  ok(ctrl.readGroupIO('GO1') === 53, `RAPID SetGO GO1=53 (${ctrl.readGroupIO('GO1')})`);
  ok(ctrl.getDO(10) && ctrl.getDO(11), 'RAPID TriggIO DO10/DO11 출력');
  ok(triggFiredWhileMoving, 'RAPID TriggL 이동 중 선독 DO10 트리거 발동');

  // 3. KUKA KRL TRIGGER WHEN DISTANCE/PATH + BAS(#ACC_*) + LIN Status 검증
  console.log('[3] KUKA KRL TRIGGER · BAS(#ACC_*) · LIN Status 검증');
  ctrl.setRobot('kuka-kr6-r900');
  ctrl.setMode('PLAY');
  ctrl.setServo(true);
  ctrl.setTimeScale(4);
  let krlStartTriggDuringMove = false;
  let krlPathTriggDuringMove = false;
  const onKrlIo = (ev) => {
    if (ev.type === 'do' && ev.n === 12 && ev.v && ctrl.segs.length > 0) krlStartTriggDuringMove = true;
    if (ev.type === 'do' && ev.n === 13 && ev.v && ctrl.segs.length > 0) krlPathTriggDuringMove = true;
  };
  ctrl.on('io', onKrlIo);
  ctrl.loadFiles({
    'trigg.src': `DEF trigg()
  BAS(#INITMOV, 0)
  BAS(#VEL_CP, 0.25)
  BAS(#ACC_PTP, 40)
  BAS(#ACC_CP, 50)
  $TOOL = {X 0,Y 0,Z 150,A 0,B 0,C 0}
  $BASE = $NULLFRAME
  PTP {X 450,Y -80,Z 300,A 180,B 0,C 180}
  TRIGGER WHEN DISTANCE=0 DELAY=0 DO $OUT[12]=TRUE
  TRIGGER WHEN PATH=-30 DELAY=0 DO $OUT[13]=TRUE
  LIN {X 450,Y 80,Z 300,A 180,B 0,C 180}
END`,
  }, true);
  ok(!ctrl.compileError && (ctrl.program?.warnings?.length ?? 0) === 0, `KRL TRIGGER 경고 없이 컴파일 (err=${ctrl.compileError?.msg || 'none'})`);
  await ctrl.start();
  st = await waitDone(ctrl, 8);
  ctrl.off('io', onKrlIo);
  ok(st === 'done', `KRL TRIGGER 프로그램 완료 (status=${st})`);
  ok(ctrl.getDO(12) && ctrl.getDO(13), 'KRL TRIGGER $OUT[12]/$OUT[13] 출력');
  ok(krlStartTriggDuringMove && krlPathTriggDuringMove, 'KRL TRIGGER 이동 중 실시간 발동');

  // KRL LIN 잘못된 Status(S 7 — 실제와 다른 Status 비트) → CONFIG/KSS01446
  ctrl.loadFiles({
    'badstat.src': `DEF badstat()
  BAS(#INITMOV, 0)
  $TOOL = {X 0,Y 0,Z 150,A 0,B 0,C 0}
  $BASE = $NULLFRAME
  PTP {X 450,Y 0,Z 300,A 180,B 0,C 180,S 2,T 2}
  LIN {X 450,Y 50,Z 300,A 180,B 0,C 180,S 7}
END`,
  }, true);
  await ctrl.start();
  st = await waitDone(ctrl, 6);
  ok(st === 'error' && ctrl.alarms.some((a) => a.code === 'CONFIG' && a.vendorCode === 'KSS01446'), `KRL LIN Status 불일치 → CONFIG/KSS01446 알람 (status=${st})`);
  ctrl.resetAlarms();
  ctrl.setServo(true);

  // 4. Yaskawa INFORM ACC= 태그
  console.log('[4] Yaskawa INFORM ACC= 태그');
  ctrl.setRobot('yaskawa-gp7');
  ctrl.setMode('PLAY');
  ctrl.setServo(true);
  ctrl.setTimeScale(4);
  const runInformAcc = async (acc) => {
    ctrl.setJointsDirect([0, 0, 0, 0, 0, 0]);
    ctrl.loadFiles({
      'ACC_TEST.JBI': `/JOB
//NAME ACC_TEST
//POS
///NPOS 2,0,0,0,0,0
///TOOL 0
///POSTYPE PULSE
///PULSE
C00000=0,0,0,0,0,0
C00001=40000,0,0,0,0,0
//INST
///DATE 2026/01/01 00:00
///ATTR SC,RW
///GROUP1 RB1
NOP
MOVJ C00000 VJ=100.00
MOVJ C00001 VJ=100.00 ACC=${acc}
END`,
    }, true);
    const t0 = ctrl.simMs;
    await ctrl.start();
    const s = await waitDone(ctrl, 8);
    return { status: s, ms: ctrl.simMs - t0 };
  };
  const infFast = await runInformAcc(100);
  const infSlow = await runInformAcc(15);
  ok(infFast.status === 'done' && infSlow.status === 'done', 'INFORM ACC=100 / ACC=15 실행 완료');
  ok(infSlow.ms > infFast.ms * 1.15, `INFORM ACC=15 시뮬레이션 시간 증가 (${infFast.ms.toFixed(0)}ms → ${infSlow.ms.toFixed(0)}ms)`);

  // 5. 홀드 중 수동 조그 이탈 → 원경로 복귀 (block / recoverPath / auto)
  console.log('[5] 홀드 경로 이탈 & 원경로 복귀 (block / recoverPath / auto)');
  ctrl.setTimeScale(2);
  ctrl.setMode('TEACH');
  ctrl.setSafetyOptions({ interlock: true, teachSpeedLimit: false, pathRecovery: 'block' });
  ctrl.setServo(true, 'ui');
  ctrl.setJointsDirect([0, 0, 0, 0, -90, 0]);
  const moveP = ctrl.move({ kind: 'J', target: { joints: [45, 0, 0, 0, -90, 0] }, speed: { frac: 0.25 } });
  await sleep(120);
  ctrl.hold();
  const anchor = [...ctrl.holdAnchor];
  ok(ctrl.held && Array.isArray(anchor) && !ctrl.getPathRecovery().deviated, 'HOLD 진입 시 holdAnchor 저장 (deviated=false)');

  // HOLD 중 수동 스텝 조그 허용 → 경로 이탈 감지
  const jogRes = ctrl.stepJog({ type: 'joint', axis: 0, dir: -1, step: 15 }, 'ui');
  ok(jogRes.ok, 'HOLD 중 수동 스텝 조그 허용');
  const pr = ctrl.getPathRecovery();
  ok(pr.deviated && pr.maxDeg >= 14.5, `경로 이탈 감지 (${pr.maxDeg}°)`);

  // block 모드: 복귀 전 재개 거부 (code 15)
  const blkResume = ctrl.resume('ui');
  ok(blkResume === false && ctrl.lastReject?.code === REJECT.PATH_DEVIATED.code, `block 모드: 재개 거부 (code=${ctrl.lastReject?.code})`);

  // 수동 원경로 복귀 실행 후 재개
  const recP = ctrl.recoverPath('ui', { wait: true });
  await recP;
  ok(!ctrl.getPathRecovery().deviated, `recoverPath 완료 → 홀드 위치 복귀 (maxDeg=${ctrl.getPathRecovery().maxDeg}°)`);
  ok(ctrl.resume('ui') === true, '원경로 복귀 후 재개 허용');
  await moveP;
  ok(Math.abs(ctrl.joints[0] - 45) < 0.2, `원래 이동 목표 도달 (J1=${ctrl.joints[0].toFixed(1)}°)`);

  // auto 모드: 이탈 후 resume() 호출 시 자동으로 저속 원경로 복귀 후 이어서 진행
  ctrl.setSafetyOptions({ pathRecovery: 'auto' });
  ctrl.setJointsDirect([0, 0, 0, 0, -90, 0]);
  const moveP2 = ctrl.move({ kind: 'J', target: { joints: [35, 0, 0, 0, -90, 0] }, speed: { frac: 0.3 } });
  await sleep(100);
  ctrl.hold();
  ctrl.stepJog({ type: 'joint', axis: 0, dir: -1, step: 12 }, 'ui');
  ok(ctrl.getPathRecovery().deviated, 'auto 모드 테스트: 경로 이탈 상태');
  const autoOk = ctrl.resume('ui');
  ok(autoOk && ctrl.held && !!ctrl._recoverSeg, 'auto 모드: resume 시 저속 원경로 복귀 자동 시작');
  await moveP2;
  ok(!ctrl.held && Math.abs(ctrl.joints[0] - 35) < 0.2, `auto 모드: 복귀 후 자동 재개하여 목표 도달 (J1=${ctrl.joints[0].toFixed(1)}°)`);

  // 6. 용접 토치 아크 상태 + teachPose(allowJump)
  console.log('[6] 용접 토치 아크 상태 · teachPose allowJump');
  ctrl.setGripper('torch-22');
  ctrl.setDO(ctrl.gripperIO.close, false);
  ok(ctrl.snapshot().weldArc === false, '토치 DO OFF → weldArc=false');
  ctrl.setDO(ctrl.gripperIO.close, true);
  ok(ctrl.snapshot().weldArc === true, '토치 DO ON → weldArc=true');
  ctrl.setDO(ctrl.gripperIO.close, false);

  ctrl.setGripper('robotiq-2f85');
  ctrl.setJointsDirect([0, 0, 0, 0, -90, 0]);
  const tp = ctrl.tcpPose();
  // Z축 60° 회전 (일반 드래그는 30° 초과로 거부, allowJump=true 면 허용)
  const rot60 = (R) => {
    const c = Math.cos(Math.PI / 3), s = Math.sin(Math.PI / 3);
    const rz = [[c, -s, 0], [s, c, 0], [0, 0, 1]];
    return R.map((row) => [0, 1, 2].map((j) => row[0] * rz[0][j] + row[1] * rz[1][j] + row[2] * rz[2][j]));
  };
  const q60 = quatFromR(rot60(tp.R));
  const rNoJump = ctrl.teachPose({ p: tp.p, q: q60, allowJump: false }, 'ui');
  const rJump = ctrl.teachPose({ p: tp.p, q: q60, allowJump: true }, 'ui');
  ok(!rNoJump.ok && rJump.ok, `teachPose 60° 회전: 기본 거부 / allowJump=true 허용`);

  // 7. 프로젝트 직렬화 (payload / accelScale / safety.pathRecovery)
  console.log('[7] 프로젝트 직렬화 (Phase 3 설정)');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robemu-p3-'));
  const store = new ProjectStore(ctrl, tmpDir);
  ctrl.setPayload(5.5, [10, -5, 40]);
  ctrl.setAccelScale(65);
  ctrl.setSafetyOptions({ pathRecovery: 'block' });
  const saved = store.serialize('phase3-test');
  ctrl.setPayload(0);
  ctrl.setAccelScale(100);
  ctrl.setSafetyOptions({ pathRecovery: 'off' });
  store.apply(saved);
  ok(ctrl.payload.mass === 5.5 && ctrl.payload.cog[0] === 10, `프로젝트 payload 복원 (${ctrl.payload.mass} kg)`);
  ok(ctrl.accelScale === 65, `프로젝트 accelScale 복원 (${ctrl.accelScale}%)`);
  ok(ctrl.safety.pathRecovery === 'block', `프로젝트 pathRecovery 복원 (${ctrl.safety.pathRecovery})`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
} finally {
  ctrl.close();
}

console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
