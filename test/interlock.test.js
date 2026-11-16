// 1단계(SI): 운전 모드 인터록 · 안전 신호 · 시스템 I/O (KUKA Automatic External 시퀀스를 Modbus 코일만으로 구동)
import { Controller } from '../server/controller.js';
import { startAll, closeAll } from '../server/protocols/index.js';
import { ModbusClient, CMD } from '../tools/clients/modbus-client.js';

let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  OK ' : '  NG '} ${m}`); if (!c) fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(20); } return true; };
const code = (c) => c.lastReject?.code ?? 0;

// ---------------------------------------------------------------- 1) 모드 인터록 매트릭스
console.log('■ 모드 인터록');
{
  const c = new Controller();
  c.setTimeScale(5);
  c.setRobot('yaskawa-gp7');
  ok(c.mode === 'TEACH' && c.interlock, '초기: TEACH, 인터록 ON');
  ok(c.setServo(true, 'ext') === false && code(c) === 1, 'TEACH: 외부 서보 ON 거부 (1)');
  ok(c.setServo(true, 'ui') === true, 'TEACH: 펜던트 서보 ON 허용');
  ok((await c.start({ source: 'ext' })) === false && code(c) === 1, 'TEACH: 외부 시작 거부 (1)');
  ok(c.setMode('PLAY', 'ext') === false && c.mode === 'TEACH' && code(c) === 8, '외부 모드 변경 거부 (8)');
  c.setMode('PLAY', 'ui');
  ok((await c.start({ source: 'ext' })) === false && code(c) === 1, 'PLAY: 외부 시작 거부 (1)');
  c.startJog({ type: 'joint', axis: 0, dir: 1, speed: 0.1 }, 'ui');
  ok(!c.jog && code(c) === 11, 'PLAY: 조그 거부 (11)');
  ok((await c.start({ source: 'ui' })) === true, 'PLAY: 펜던트 시작 허용');
  await sleep(300);
  c.setMode('TEACH', 'ui');
  await sleep(50);
  ok(c.vm.status === 'aborted', `PLAY → TEACH 전환 시 프로그램 정지 (${c.vm.status})`);
  c.setMode('REMOTE', 'ui');
  ok((await c.start({ source: 'ui' })) === false && code(c) === 2, 'REMOTE: 펜던트 시작 거부 (2)');
  try { await c.move({ kind: 'J', target: { joints: [10, 0, 0, 0, -90, 0] }, speed: { frac: 0.5 }, source: 'ui' }); ok(false, 'REMOTE: 펜던트 이동 거부'); }
  catch (e) { ok(e.code === 'REJECT_2', 'REMOTE: 펜던트 이동 거부 (2)'); }
  ok((await c.start({ source: 'ext' })) === true, 'REMOTE: 외부 시작 허용');
  c.stopProgram();
  c.setMode('TEACH', 'ui');
  c.setSafetyOptions({ interlock: false });
  ok((await c.start({ source: 'ext' })) === true, '인터록 OFF: TEACH 에서도 외부 시작 허용');
  c.stopProgram();
  clearInterval(c._timer);
}

// ---------------------------------------------------------------- 2) 비상정지 · 펜스 · 인에이블
console.log('■ 안전 신호');
{
  const c = new Controller();
  c.setTimeScale(5);
  c.setRobot('yaskawa-gp7');
  c.setMode('PLAY', 'ui');
  c.setServo(true, 'ui');
  await c.start({ source: 'ui' });
  await sleep(500);
  c.setEstop(true, 'ui');
  const j0 = c.joints.join();
  await sleep(150);
  ok(!c.servo && c.held && c.alarms.some((a) => a.code === 'ESTOP'), '비상정지: 서보 OFF + 동결 + ESTOP 알람');
  ok(c.joints.join() === j0, '비상정지 중 로봇 정지 유지');
  ok(c.setServo(true, 'ui') === false && code(c) === 3, '비상정지 중 서보 ON 거부 (3)');
  c.resetAlarms();
  ok(c.alarms.some((a) => a.code === 'ESTOP'), '비상정지 유지 중에는 알람 리셋 안 됨');
  c.setEstop(false, 'ui');
  c.resetAlarms();
  ok(c.alarms.length === 0, '해제 후 알람 리셋');
  ok(c.setServo(true, 'ui') && (await c.start({ source: 'ui' })), '서보 ON → 시작(재개)');
  ok(await until(() => c.vm.status === 'done' && c.motionIdle), `재개 후 프로그램 완료 (${c.vm.status})`);
  ok(c.alarms.length === 0, '완료 시 알람 없음');

  // 펜스 (stop1)
  c.setMode('REMOTE', 'ui');
  await c.start({ source: 'ext' });
  await sleep(300);
  c.setFence(true);
  ok(!c.servo && c.held && c.alarms.some((a) => a.code === 'FENCE'), '자동 운전 중 펜스 열림 (stop1): 서보 OFF + FENCE 알람');
  ok((await c.start({ source: 'ext' })) === false && code(c) === 4, '펜스 열린 상태 시작 거부 (4)');
  c.setFence(false); c.resetAlarms(); c.setServo(true, 'ext');
  ok((await c.start({ source: 'ext' })) && (await until(() => c.vm.status === 'done' && c.motionIdle)), '펜스 닫고 복귀 → 완료');
  // stop2
  c.setSafetyOptions({ fenceStop: 'stop2' });
  await c.start({ source: 'ext' });
  await sleep(300);
  c.setFence(true);
  ok(c.servo && c.held && !c.alarms.length, '펜스 열림 (stop2): HOLD 만, 서보 유지');
  c.setFence(false);
  ok((await c.start({ source: 'ext' })) && (await until(() => c.vm.status === 'done' && c.motionIdle)), 'stop2 복귀 → 완료');
  // TEACH 에서는 펜스 무시
  c.setMode('TEACH', 'ui');
  c.setFence(true);
  ok(c.servo && !c.alarms.length, 'TEACH 모드에서는 펜스 열림 무시');
  c.setFence(false);
  // 인에이블
  c.setSafetyOptions({ requireEnable: true });
  c.startJog({ type: 'joint', axis: 0, dir: 1, speed: 0.1 }, 'ui');
  ok(!c.jog && code(c) === 5, '인에이블 OFF: 조그 거부 (5)');
  c.setEnableSwitch(true);
  c.startJog({ type: 'joint', axis: 0, dir: 1, speed: 0.1 }, 'ui');
  ok(!!c.jog, '인에이블 ON: 조그 허용');
  clearInterval(c._timer);
}

// ---------------------------------------------------------------- 3) 시스템 I/O: KUKA Automatic External (Modbus 코일만 사용)
console.log('■ 시스템 I/O — KUKA Automatic External via Modbus');
{
  const c = new Controller();
  c.setTimeScale(5);
  c.setRobot('kuka-kr6-r900');
  const handles = await startAll(c, {
    yaskawaHse: { enabled: false }, kawasakiAs: { enabled: false }, hyundai: { enabled: false }, abbRws: { enabled: false }, kukaVarProxy: { enabled: false }, urDashboard: { enabled: false },
    modbus: { port: 22502, fallbackPort: 22503, host: '127.0.0.1' },
  });
  const mb = await new ModbusClient('127.0.0.1', handles.find((h) => h.key === 'modbus').port).connect();
  const ir7 = async () => (await mb.readInputRegisters(7, 1))[0];

  // 인터록: TEACH 에서 Modbus 서보 ON 명령 → 거부, 사유 코드 1
  ok((await mb.command(CMD.SERVO_ON)) === 1 && (await ir7()) === 1, 'Modbus 명령(TEACH): 거부, IR7 = 1');

  c.setMode('REMOTE', 'ui');
  c.sysio.configure({ enabled: true, preset: 'kuka', programs: { 1: 'pick_place.src' } });
  const snap = c.sysio.snapshot();
  const I = Object.fromEntries(snap.inputs.map((s) => [s.key, s.n]));
  const O = Object.fromEntries(snap.outputs.map((s) => [s.kind, s.n]));
  const coil = (n, v) => mb.writeCoil(n - 1, v);
  const pulse = async (n) => { await coil(n, true); await sleep(60); await coil(n, false); await sleep(60); };
  const out = async (kind) => (await mb.readDiscreteInputs(O[kind] - 1, 1))[0];
  ok((await mb.readCoils(I.servoOff - 1, 1))[0] && (await mb.readCoils(I.hold - 1, 1))[0] && (await mb.readCoils(I.estop - 1, 1))[0], '활성화 시 NC 입력($DRIVES_OFF, $MOVE_ENABLE, 비상정지) 정상 상태');
  ok((await out('estopOk')) && (await out('fenceOk')) && (await out('remote')), '$ALARM_STOP, $USER_SAF, $EXT 출력 ON');

  await pulse(I.servoOn);
  ok(c.servo && (await out('servoOn')), '$DRIVES_ON 펄스 → 서보 ON, $PERI_RDY ON');
  ok(await out('pgnoReq'), 'PGNO_REQ ON (번호 요청)');

  // 패리티 오류: 번호 1 (1비트) + 패리티 1 → 짝수 → 오류
  await coil(I.pgno0, true); await coil(I.pgnoParity, true);
  await pulse(I.pgnoStrobe);
  ok((await out('pgnoErr')) && (await ir7()) === 10, 'PGNO 패리티 오류 → 오류 출력, IR7 = 10');
  // 올바른 패리티 (홀수)
  await coil(I.pgnoParity, false);
  await pulse(I.pgnoStrobe);
  ok(!(await out('pgnoErr')) && c.main === 'pick_place.src' && (await mb.readInputRegisters(8, 1))[0] === 1, 'PGNO 1 + 홀수 패리티 → pick_place.src 선택, IR8 = 1');
  // 할당되지 않은 번호
  await coil(I.pgno0, false); await coil(I.pgno1, true); await coil(I.pgnoParity, false);
  await pulse(I.pgnoStrobe);
  ok((await out('pgnoErr')) && (await ir7()) === 9, 'PGNO 2 (미할당) → 오류, IR7 = 9');
  await coil(I.pgno1, false); await coil(I.pgno0, true);
  await pulse(I.pgnoStrobe);

  await pulse(I.start);
  ok(await until(() => c.vm?.status === 'running'), '$EXT_START → 프로그램 실행');
  await sleep(150);
  ok(await out('running'), '$PRO_ACT ON');
  await sleep(400);
  await coil(I.hold, false);            // $MOVE_ENABLE OFF → 홀드
  await sleep(100);
  ok(c.held && !(await out('running')), '$MOVE_ENABLE OFF → HOLD, $PRO_ACT OFF');
  await pulse(I.start);
  ok(c.held && (await ir7()) === 13, '$MOVE_ENABLE OFF 상태에서 $EXT_START 거부 (IR7 = 13)');
  await coil(I.hold, true);
  await pulse(I.start);
  ok(!c.held, '$MOVE_ENABLE ON + $EXT_START → 재개');
  ok(await until(() => c.getDO(O.done), 30000), '사이클 완료 출력 ON');
  ok(c.vm.status === 'done' && !c.alarms.length, `프로그램 정상 종료 (${c.vm.status})`);

  // 외부 비상정지 (NC: 코일 OFF = 비상정지)
  await coil(I.estop, false);
  await sleep(80);
  ok(!c.servo && c.estopActive && !(await out('estopOk')) && (await out('alarm')), '외부 비상정지 → 서보 OFF, $ALARM_STOP OFF, $STOPMESS ON');
  await pulse(I.alarmReset);
  ok(c.alarms.length > 0, '비상정지 유지 중 $CONF_MESS 무효');
  await coil(I.estop, true);
  await pulse(I.alarmReset);
  await pulse(I.servoOn);
  ok(!c.alarms.length && c.servo && (await out('estopOk')), '비상정지 해제 → $CONF_MESS → $DRIVES_ON 복귀');
  // $DRIVES_OFF (NC) OFF → 서보 OFF, 이후 $DRIVES_ON 거부
  await coil(I.servoOff, false);
  await sleep(60);
  ok(!c.servo, '$DRIVES_OFF OFF → 서보 OFF');
  await pulse(I.servoOn);
  ok(!c.servo && (await ir7()) === 14, '$DRIVES_OFF OFF 중 $DRIVES_ON 거부 (IR7 = 14)');

  mb.close();
  await closeAll(handles);
  clearInterval(c._timer);
}

// ---------------------------------------------------------------- 4) 이름표 · 프로젝트 저장
console.log('■ I/O 이름표 · 프로젝트');
{
  const { ProjectStore } = await import('../server/project.js');
  const os = await import('node:os'), path = await import('node:path'), fs = await import('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'robemu-'));
  const c = new Controller();
  c.setIoLabel('di', 5, { name: 'PART_PRESENT', desc: '지그 공작물 감지' });
  c.setIoLabel('do', 7, { name: 'CLAMP' });
  c.sysio.configure({ enabled: true, preset: 'abb', programs: { 3: 'MainModule.mod' } });
  c.setSafetyOptions({ requireEnable: true, fenceStop: 'stop2' });
  const ps = new ProjectStore(c, dir);
  ps.save('t1');
  const c2 = new Controller();
  new ProjectStore(c2, dir).load('t1');
  ok(c2.ioLabels.di[5]?.name === 'PART_PRESENT' && c2.ioLabels.do[7]?.name === 'CLAMP', '이름표 저장/복원');
  ok(c2.sysio.enabled && c2.sysio.preset === 'abb' && c2.sysio.programs[3] === 'MainModule.mod', '시스템 I/O 설정 저장/복원');
  ok(c2.safety.requireEnable && c2.safety.fenceStop === 'stop2', '안전 옵션 저장/복원');
  c2.setIoLabel('di', 5, null);
  ok(!c2.ioLabels.di[5], '이름표 삭제');
  fs.rmSync(dir, { recursive: true, force: true });
  clearInterval(c._timer); clearInterval(c2._timer);
}

console.log(fail ? `\n${fail}개 실패` : '\n모두 통과');
process.exit(fail ? 1 : 0);
