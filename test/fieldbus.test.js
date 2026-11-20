// 필드버스 인터페이스(Modbus TCP / OPC UA) 통합 테스트
//   node test/fieldbus.test.js
// 가상 컨트롤러 + Modbus(21502) + OPC UA(24840) 를 startAll 로 기동하고 tools/clients/* 로 검증한다.
import net from 'node:net';
import { Controller } from '../server/controller.js';
import { startAll, closeAll } from '../server/protocols/index.js';
import { ModbusClient, CMD, decodeI32 } from '../tools/clients/modbus-client.js';
import * as opc from '../tools/clients/opcua-client.js';

const MB_PORT = 21502, UA_PORT = 24840;
const t0 = Date.now();
const watchdog = setTimeout(() => { console.log('✘ 시간 초과 (85s)'); process.exit(2); }, 85000);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ✔ ${msg}`); } else { fail++; console.log(`  ✘ ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function section(title, fn) {
  console.log(`\n■ ${title}`);
  try { await fn(); } catch (e) { fail++; console.log(`  ✘ 예외: ${e.stack || e.message}`); }
}

const ctrl = new Controller();
ctrl.setMode('REMOTE');   // 모드 인터록: 외부 명령(서보 ON·시작·이동)은 REMOTE 모드에서만 허용
ctrl.on('log', (e) => { if (e.src === 'comm' && /바인딩|실패|대기/.test(e.msg)) console.log('  [log]', e.msg); });
const handles = await startAll(ctrl, {
  yaskawaHse: { enabled: false }, kawasakiAs: { enabled: false }, hyundai: { enabled: false }, abbRws: { enabled: false }, kukaVarProxy: { enabled: false }, urDashboard: { enabled: false },
  modbus: { port: MB_PORT, fallbackPort: MB_PORT + 1, host: '127.0.0.1' },
  opcua: { port: UA_PORT },
});
console.log('기동:', handles.map((h) => `${h.key}:${h.port}`).join(', '), `(${Date.now() - t0}ms)`);
const mbPort = handles.find((h) => h.key === 'modbus')?.port;
const uaPort = handles.find((h) => h.key === 'opcua')?.port;
ok(handles.length === 2, 'startAll: 필드버스 2개만 기동 (나머지 enabled:false)');
ok(!!mbPort && !!uaPort, 'Modbus / OPC UA 포트 바인딩');

// ------------------------------------------------------------------ Modbus
await section('Modbus TCP', async () => {
  const c = await new ModbusClient('127.0.0.1', mbPort).connect();
  try {
    // 코일 → DI
    await c.writeCoil(4, true);
    ok(ctrl.getDI(5) === true, '코일 4 쓰기 → ctrl DI5 ON');
    await c.writeCoils(8, [true, false, true]);
    ok(ctrl.getDI(9) && !ctrl.getDI(10) && ctrl.getDI(11), 'FC15 다중 코일 → DI9..11');
    ctrl.setDI(20, true);
    ok((await c.readCoils(19, 1))[0] === true, 'ctrl DI20 → 코일 19 읽기');
    // DO → 이산 입력
    ctrl.setDO(7, true); ctrl.setDO(300, true);
    const di = await c.readDiscreteInputs(0, 10);
    ok(di[6] === true && di[0] === false, 'ctrl DO7 → 이산 입력 6');
    ok((await c.readDiscreteInputs(299, 1))[0] === true, 'ctrl DO300 → 이산 입력 299');
    ctrl.setDO(7, false);
    // 관절
    ctrl.setJointsDirect([10.5, -20.25, 30, 40, -50.125, 60]);
    const regs = await c.readInputRegisters(10, 12);
    const j = decodeI32(regs);
    ok(j.every((v, i) => v === Math.round(ctrl.joints[i] * 1000)), `관절 레지스터 = joints × 1000 (${j.join(',')})`);
    ok(regs[2] === 0xFFFF && j[1] === -20250, '음수 int32 상위 워드 먼저');
    const pose = await c.readPose();
    const vp = ctrl.vendorPose();
    ok(pose.every((v, i) => Math.abs(v - vp[i]) < 0.002), 'TCP 자세 레지스터 30.. = vendorPose');
    // 명령 레지스터: 서보 ON
    ctrl.setServo(false);
    ok(await c.command(CMD.SERVO_ON) === 0 && ctrl.servo === true, '명령 1 → 서보 ON (결과 0)');
    ok((await c.readHoldingRegisters(0, 1))[0] === 1, '명령 레지스터 읽기 = 마지막 명령');
    let st = await c.readStatus();
    ok(st.servo && !st.teach && (st.raw & (1 << 7)) && (st.raw & (1 << 13)) && !st.alarm, `상태 비트: 서보 ON, REMOTE, 인터록 (raw=0x${st.raw.toString(16)})`);
    ctrl.alarm('E100', '테스트 알람');
    st = await c.readStatus();
    ok(st.alarm && st.alarmCount === 1 && st.alarmCode !== 0, '알람 상태 비트 / 개수 / 코드');
    ok(await c.command(CMD.SERVO_ON) === 1, '알람 중 서보 ON → 거부(결과 1)');
    ok(await c.command(CMD.START) === 1, '알람 중 시작 → 거부(결과 1)');
    ok(await c.command(CMD.RESET_ALARMS) === 0 && ctrl.alarms.length === 0, '명령 7 → 알람 리셋');
    // 오버라이드
    await c.setOverride(35);
    ok(ctrl.override === 35, '홀딩 1 쓰기 → ctrl.override 35');
    ok((await c.readInputRegisters(1, 1))[0] === 35, '입력 레지스터 1 = 오버라이드');
    // 사용자 레지스터 왕복
    await c.writeUserReg(5, -1234);
    ok(ctrl.regs.get('MB:5') === -1234, '홀딩 105 쓰기 → ctrl.regs MB:5 = -1234');
    ctrl.regs.set('MB:6', 777);
    ok(await c.readUserReg(6) === 777, 'ctrl.regs MB:6 → 홀딩 106 읽기');
    await c.writeRegisters(110, [1, 2, 0xFFFF]);
    ok(ctrl.regs.get('MB:10') === 1 && ctrl.regs.get('MB:12') === -1, 'FC16 다중 레지스터');
    const rw = await c.readWriteRegisters(110, 3, 111, [42]);
    ok(rw[0] === 1 && rw[1] === 42 && rw[2] === 0xFFFF, 'FC23 읽기/쓰기 (쓰기 먼저)');
    // 예외
    const exCode = async (p) => { try { await p; return 0; } catch (e) { return e.code; } };
    ok(await exCode(c.request(Buffer.from([0x2B, 0x0E, 0x01, 0x00]))) === 1, '미지원 기능 코드 → 예외 01');
    ok(await exCode(c.readCoils(510, 5)) === 2, '코일 범위 초과 → 예외 02');
    ok(await exCode(c.readInputRegisters(0, 200)) === 3, '수량 초과 → 예외 03');
    ok(await exCode(c.writeRegister(50, 1)) === 2, '예약 홀딩 쓰기 → 예외 02');
    ok(await exCode(c.writeRegister(0, 99)) === 3, '정의되지 않은 명령 코드 → 예외 03');
    ok(await exCode(c.request(Buffer.from([5, 0, 0, 0x12, 0x34]))) === 3, 'FC05 잘못된 값 → 예외 03');
  } finally { c.close(); }

  // 프레이밍: 조각난/합쳐진 TCP 세그먼트
  const raw = await new Promise((res, rej) => { const s = net.connect(mbPort, '127.0.0.1', () => res(s)); s.once('error', rej); });
  const frames = [];
  let buf = Buffer.alloc(0);
  raw.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 7 && buf.length >= 6 + buf.readUInt16BE(4)) { const n = 6 + buf.readUInt16BE(4); frames.push(buf.subarray(0, n)); buf = buf.subarray(n); }
  });
  const req = (tid, unit, pdu) => { const h = Buffer.alloc(7); h.writeUInt16BE(tid, 0); h.writeUInt16BE(pdu.length + 1, 4); h[6] = unit; return Buffer.concat([h, Buffer.from(pdu)]); };
  const a = req(0x1111, 7, [4, 0, 1, 0, 1]), b = req(0x2222, 9, [3, 0, 1, 0, 1]);
  const all = Buffer.concat([a, b]);
  raw.write(all.subarray(0, 3)); await sleep(30);
  raw.write(all.subarray(3, 9)); await sleep(30);
  raw.write(all.subarray(9));
  for (let i = 0; i < 50 && frames.length < 2; i++) await sleep(20);
  raw.destroy();
  ok(frames.length === 2 && frames[0].readUInt16BE(0) === 0x1111 && frames[1].readUInt16BE(0) === 0x2222, '조각/병합 프레임 → 응답 2개 (트랜잭션 ID 보존)');
  ok(frames[0]?.[6] === 7 && frames[1]?.[6] === 9, 'Unit ID 그대로 응답');
  ok(frames[0]?.readUInt16BE(9) === 35, '조각 프레임 요청 결과 (오버라이드 35)');
});

// ------------------------------------------------------------------ OPC UA
await section('OPC UA', async () => {
  const c = await opc.connect(`opc.tcp://127.0.0.1:${uaPort}/UA/RobotEmulator`);
  try {
    const names = (await opc.browseRobot(c)).map((x) => x.name);
    ok(['Joints', 'Servo', 'Override', 'IO', 'Registers', 'ServoOn', 'MoveJoints'].every((n) => names.includes(n)), `Robot 폴더 탐색 (${names.length}개 노드)`);
    ctrl.setJointsDirect([1, 2, 3, 4, -5, 6]);
    const j = await opc.readJoints(c);
    ok(j.length === 6 && j.every((v, i) => Math.abs(v - ctrl.joints[i]) < 1e-9), `Joints 읽기 = ctrl.joints (${j.join(',')})`);
    ok((await opc.read(c, 'Model')) === ctrl.robot.name, 'Model 읽기');
    ok((await opc.writeOverride(c, 42)) === 'Good' && ctrl.override === 42, 'Override 쓰기 → ctrl.override 42');
    ok((await opc.writeOverride(c, 500)) !== 'Good' && ctrl.override === 42, 'Override 범위 초과 쓰기 거부');
    ctrl.setServo(false);
    const r = await opc.call(c, 'ServoOn');
    ok(r.status === 'Good' && r.ok === true && ctrl.servo === true, 'ServoOn 메서드 → ctrl.servo');
    ok((await opc.write(c, 'IO.DI_1', 'Boolean', true)) === 'Good' && ctrl.getDI(1) === true, 'IO/DI_1 쓰기 → ctrl DI1');
    ctrl.setDO(3, true);
    ok((await opc.read(c, 'IO.DO_3')) === true && (await opc.read(c, 'IO.DO'))[2] === true, 'ctrl DO3 → IO/DO_3, IO/DO[2]');
    ok((await opc.write(c, 'IO.DO_3', 'Boolean', false)) !== 'Good' && ctrl.getDO(3), 'DO_3 는 읽기 전용');
    ok((await opc.write(c, 'Registers.MB_7', 'Int16', -321)) === 'Good' && ctrl.regs.get('MB:7') === -321, 'Registers/MB_7 쓰기 → ctrl.regs MB:7');
    ok((await opc.write(c, 'Mode', 'String', 'PLAY')) !== 'Good' && ctrl.mode === 'REMOTE', 'Mode 쓰기: 인터록 ON 이면 거부 (키 스위치 전용)');
    ok((await opc.read(c, 'LastRejectCode')) === 8, 'LastRejectCode = 8 (모드 변경 불가)');
    ctrl.setSafetyOptions({ interlock: false });
    ok((await opc.write(c, 'Mode', 'String', 'PLAY')) === 'Good' && ctrl.mode === 'PLAY', 'Mode 쓰기 PLAY (인터록 OFF)');
    ctrl.setSafetyOptions({ interlock: true });
    ctrl.setMode('REMOTE');
    // 구독: 시작 후 관절 변경 → 통지 수신
    const target = [15, -10, 20, 0, -60, 30];
    const vals = await opc.subscribeJoints(c, 1500, { onStart: async () => { await sleep(200); ctrl.setJointsDirect(target); } });
    ok(vals.length >= 2 && vals.some((v) => v.every((x, i) => Math.abs(x - target[i]) < 1e-9)), `Joints 구독 → 변경 통지 수신 (${vals.length}건)`);
    // MoveJoints
    const m = await opc.moveJoints(c, [0, 0, 0, 0, -90, 0], 1);
    ok(m.ok === true, `MoveJoints 호출 (${m.message})`);
    for (let i = 0; i < 300 && ctrl.segment; i++) await sleep(20);
    ok(Math.abs(ctrl.joints[4] + 90) < 1e-6, 'MoveJoints 완료 위치');
    const bad = await opc.call(c, 'SelectProgram', [{ dataType: 12 /* String */, value: 'NO_SUCH_PROGRAM' }]);
    ok(bad.ok === false, `SelectProgram 없는 프로그램 거부 (${bad.message})`);
  } finally { await c.close(); }
});

await closeAll(handles);
clearTimeout(watchdog);
console.log(`\n결과: ${pass} 통과, ${fail} 실패  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
process.exit(fail ? 1 : 0);
