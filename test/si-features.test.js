// Phase 2 (v1.5) SI 현장 연동 검증 테스트:
//  - Group I/O (GI/GO) & Analog I/O (AI/AO)
//  - Modbus TCP (IR 64..95, HR 356..387) & OPC UA (IO.AI/AO, SafeZoneActive) 연동
//  - SafeZone(진입 금지 정지 + 제조사 알람) & Interference Zone(진입 시 DO 출력 / 반전)
//  - 가상 비전 센서 (DO 상승 에지 트리거 → 프러스텀 공작물 검출 → 노이즈/지연 → MB/R/P 레지스터 + DI 반환)
//  - ProjectStore 저장/복원
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Controller } from '../server/controller.js';
import { ProjectStore } from '../server/project.js';
import { startAll, closeAll } from '../server/protocols/index.js';
import { ModbusClient } from '../tools/clients/modbus-client.js';
import { pointInZone } from '../shared/zones.js';
import { fkTcp } from '../shared/kinematics.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  OK  ${m}`); } else { fail++; console.log(`  NG  ${m}`); } };
const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toI16 = (u) => (u > 32767 ? u - 65536 : u);

// ------------------------------------------------------------ 1. Group I/O (GI/GO) & Analog I/O (AI/AO)
console.log('\n■ 1. Group I/O (GI/GO) · Analog I/O (AI/AO)');
{
  const c = new Controller();
  c.writeGroupIO('GI1', 0xA5); // 10100101 on DI 17..24
  ok(c.readGroupIO('GI1') === 0xA5, `GI1 쓰기/읽기 0xA5 (${c.readGroupIO('GI1')})`);
  ok(c.getDI(17) === true && c.getDI(18) === false && c.getDI(19) === true && c.getDI(24) === true,
    'GI1 비트 매핑 (DI17=1, DI18=0, DI19=1, DI24=1)');

  c.writeGroupIO('GO1', 42);
  ok(c.readGroupIO('GO1') === 42 && c.getDO(18) === true && c.getDO(20) === true && c.getDO(22) === true,
    'GO1 쓰기/읽기 42 → DO 비트 반영');

  c.setIoGroups([
    ...c.ioGroups,
    { id: 'GI_S', name: '부호 입력', dir: 'in', start: 33, bits: 8, signed: true },
  ]);
  c.writeGroupIO('GI_S', -12);
  ok(c.readGroupIO('GI_S') === -12, `부호 있는 그룹 I/O (-12 → ${c.readGroupIO('GI_S')})`);

  c.setAI(1, 7.25);
  c.setAO(2, -3.5);
  c.setAioConfig('ai', 1, { name: '압력센서', unit: 'bar', min: 0, max: 10 });
  const snap = c.snapshot();
  ok(near(snap.aio.ai[0], 7.25) && near(snap.aio.ao[1], -3.5) && snap.aio.config.ai[1]?.unit === 'bar',
    '아날로그 I/O 값 및 채널 설정 스냅샷 반영');
  c.close();
}

// ------------------------------------------------------------ 2. Modbus TCP & OPC UA 아날로그 I/O + SafeZoneActive
console.log('\n■ 2. Modbus TCP · OPC UA 아날로그 I/O 연동');
{
  const c = new Controller();
  c.setMode('REMOTE');
  c.setAI(1, 7.25);
  c.setAO(2, -3.5);
  const handles = await startAll(c, {
    yaskawaHse: { enabled: false }, kawasakiAs: { enabled: false }, hyundai: { enabled: false },
    abbRws: { enabled: false }, kukaVarProxy: { enabled: false }, urDashboard: { enabled: false },
    modbus: { port: 23502, fallbackPort: 23503, host: '127.0.0.1' },
    opcua: { port: 25840 },
  });
  try {
    const mbPort = handles.find((h) => h.key === 'modbus')?.port;
    const uaPort = handles.find((h) => h.key === 'opcua')?.port;
    const mb = await new ModbusClient('127.0.0.1', mbPort).connect();
    try {
      const irAO = await mb.readInputRegisters(65, 1); // AO2
      const irAI = await mb.readInputRegisters(80, 1); // AI1
      ok(toI16(irAO[0]) === -350 && toI16(irAI[0]) === 725, `Modbus IR: AO2=${toI16(irAO[0])}, AI1=${toI16(irAI[0])}`);
      await mb.writeRegister(357, 485); // HR 357 = AI2 → 4.85
      await mb.writeRegister(372, 910); // HR 372 = AO1 → 9.10
      ok(near(c.getAI(2), 4.85) && near(c.getAO(1), 9.10), `Modbus HR 쓰기: AI2=${c.getAI(2)}, AO1=${c.getAO(1)}`);
      const hrBack = await mb.readHoldingRegisters(356, 2);
      ok(toI16(hrBack[0]) === 725 && toI16(hrBack[1]) === 485, 'Modbus HR 356..357 읽기 왕복');
    } finally { mb.close(); }

    if (uaPort) {
      const { OPCUAClient, AttributeIds, DataType } = await import('node-opcua');
      const client = OPCUAClient.create({ endpointMustExist: false });
      await client.connect(`opc.tcp://127.0.0.1:${uaPort}/UA/RobotEmulator`);
      const sess = await client.createSession();
      try {
        const nsArr = (await sess.read({ nodeId: 'ns=0;i=2255', attributeId: AttributeIds.Value })).value.value;
        const ns = nsArr.indexOf('urn:robot-emulator');
        await sess.write({ nodeId: `ns=${ns};s=Robot.IO.AI_3`, attributeId: AttributeIds.Value, value: { value: { dataType: DataType.Double, value: 6.4 } } });
        const vAi = (await sess.read({ nodeId: `ns=${ns};s=Robot.IO.AI`, attributeId: AttributeIds.Value })).value.value;
        const vSz = (await sess.read({ nodeId: `ns=${ns};s=Robot.SafeZoneActive`, attributeId: AttributeIds.Value })).value.value;
        ok(near(c.getAI(3), 6.4) && near(vAi[2], 6.4), `OPC UA IO.AI_3 쓰기 및 IO.AI 배열 읽기 (${vAi[2]})`);
        ok(vSz === false, `OPC UA SafeZoneActive 초기값 false`);
      } finally {
        await sess.close();
        await client.disconnect();
      }
    }
  } finally {
    await closeAll(handles);
    c.close();
  }
}

// ------------------------------------------------------------ 3. SafeZone & Interference Zone
console.log('\n■ 3. 안전 영역(SafeZone) · 간섭 구역(Interference Zone)');
{
  ok(pointInZone([100, 50, 200], { shape: 'box', p: [100, 50, 200], size: [100, 100, 100] }) === true, 'pointInZone box 내부');
  ok(pointInZone([160, 50, 200], { shape: 'box', p: [100, 50, 200], size: [100, 100, 100] }) === false, 'pointInZone box 외부');
  ok(pointInZone([140, 50, 200], { shape: 'cylinder', p: [100, 50, 200], size: [100, 100, 100] }) === true, 'pointInZone cylinder 내부');
  ok(pointInZone([145, 95, 200], { shape: 'cylinder', p: [100, 50, 200], size: [100, 100, 100] }) === false, 'pointInZone cylinder 모서리 외부');

  const c = new Controller();
  c.setRobot('yaskawa-gp7');
  c.setMode('PLAY', 'ui');
  c.setServo(true, 'ui');
  c.setTimeScale(8);
  const p0 = fkTcp(c.robot, c.joints, c.tool, null).p;
  // 간섭 구역: Y +180mm 지점에 배치 (초기엔 외부), 반전 구역은 DO31
  c.setZones([
    { id: 'press', name: 'PressZone', kind: 'interference', shape: 'box', p: [p0[0], p0[1] + 180, p0[2]], size: [160, 160, 200], outDO: 30, invertDO: false },
    { id: 'clear', name: 'ClearZone', kind: 'interference', shape: 'box', p: [p0[0], p0[1] + 180, p0[2]], size: [160, 160, 200], outDO: 31, invertDO: true },
    { id: 'forbid', name: 'OperatorArea', kind: 'safe', shape: 'box', p: [p0[0], p0[1] - 200, p0[2]], size: [160, 160, 200], outDO: 32 },
  ]);
  ok(c.getDO(30) === false && c.getDO(31) === true, '간섭 구역 초기 외부: DO30=OFF, 반전 DO31=ON');

  const curPose = c.tcpPose();
  await c.move({ kind: 'L', target: { pose: { p: [p0[0], p0[1] + 180, p0[2]], R: curPose.R } }, speed: { tcp: 400 } });
  ok(c.getDO(30) === true && c.getDO(31) === false && c.zoneStates.press === true,
    '간섭 구역 진입: DO30=ON, 반전 DO31=OFF');

  // 원위치 복귀
  await c.move({ kind: 'L', target: { pose: curPose }, speed: { tcp: 400 } });
  ok(c.getDO(30) === false && c.getDO(31) === true, '간섭 구역 이탈: DO30=OFF, 반전 DO31=ON');

  // SafeZone 진입 시도 → SAFE_ZONE 알람(Yaskawa 4332) + 모션 중단
  let aborted = false;
  await c.move({ kind: 'L', target: { pose: { p: [p0[0], p0[1] - 200, p0[2]], R: curPose.R } }, speed: { tcp: 400 } }).catch(() => { aborted = true; });
  const szAlarm = c.alarms.find((a) => a.code === 'SAFE_ZONE');
  ok(aborted && !!szAlarm && szAlarm.vendorCode === '4332', `SafeZone 진입 시 즉시 정지 + 알람 (${szAlarm?.code}/${szAlarm?.vendorCode})`);

  // TEACH 스텝 조그 시 SafeZone 사전 차단
  c.resetAlarms();
  c.setJointsDirect(c.robot.home);
  c.setMode('TEACH', 'ui');
  // 홈 바로 옆(-10mm)에 SafeZone 배치 후 -Y 10mm 스텝 조그 시도
  const ph = fkTcp(c.robot, c.joints, c.tool, null).p;
  c.setZones([{ id: 'nearSafe', name: 'NearSafe', kind: 'safe', shape: 'box', p: [ph[0], ph[1] - 55, ph[2]], size: [100, 100, 100] }]);
  const sr = c.stepJog({ type: 'cart', axis: 1, dir: -1, step: 10, frame: 'base' }, 'ui');
  ok(sr.ok === false && /안전 영역/.test(sr.reason), `TEACH 스텝 조그 SafeZone 사전 차단 (${sr.reason})`);
  c.close();
}

// ------------------------------------------------------------ 4. 가상 비전 센서 (DO 트리거 → 좌표 반환)
console.log('\n■ 4. 가상 비전 센서 (DO 트리거 · 노이즈 · 레지스터/DI 반환)');
{
  const c = new Controller();
  c.setRobot('yaskawa-gp7');
  c.setTimeScale(5);
  const w1 = c.objects[0];
  // W1 바로 위 600mm에서 수직 아래를 보는 고정 카메라 장착 (rot=[180,0,0] → +Z 광축이 월드 -Z 방향)
  c.setCameras([{
    id: 'vis1', type: 'mv-2d-8mm', name: 'Overhead Cam', mount: 'world',
    pos: [w1.pose.p[0], w1.pose.p[1], w1.pose.p[2] + 600], rot: [180, 0, 0], view: false,
    vision: { enabled: true, triggerDO: 20, doneDI: 20, foundDI: 21, regBase: 50, frame: 'base', noiseMm: 0.5, noiseDeg: 0.2, latencyMs: 60 },
  }]);
  // DO 20 상승 에지 트리거
  c.setDO(20, true);
  ok(c.getDI(20) === false, '트리거 직후 완료 DI20=OFF (처리 중)');
  await sleep(60); // 60ms sim latency / 5x = ~12ms real
  const res = c.vision.results.vis1;
  ok(c.getDI(20) === true && c.getDI(21) === true && res?.found === true && res.objectId === w1.id,
    `DO20 트리거 검출 완료: ${res?.objectId} DI20=${c.getDI(20)}, DI21=${c.getDI(21)}`);
  ok(c.regs.get('MB:50') === 1 && near(c.regs.get('MB:51') / 10, w1.pose.p[0], 0.8) && near(c.regs.get('MB:52') / 10, w1.pose.p[1], 0.8),
    `Modbus 레지스터 MB:50..53 기록 확인 (X=${c.regs.get('MB:51') / 10}, Y=${c.regs.get('MB:52') / 10} vs W1=${w1.pose.p[0]},${w1.pose.p[1]})`);
  ok(c.regs.get('P:50')?.kind === 'pose' && near(c.regs.get('R:50'), w1.pose.p[0], 0.8),
    '로봇 프로그램 레지스터 P:50 / R:50 기록 확인');

  // User Frame 기준 출력 검증
  c.setFrame('user', 1, { name: 'UF1', pose: [w1.pose.p[0] - 50, w1.pose.p[1], w1.pose.p[2], 0, 0, 0] });
  c.setActiveFrames({ activeUser: 1 });
  c.setCameras([{
    ...c.cameras[0],
    vision: { ...c.cameras[0].vision, frame: 'user', noiseMm: 0, noiseDeg: 0, latencyMs: 0 },
  }]);
  const rUf = c.triggerVision('vis1', { deterministic: true });
  ok(rUf.ok && rUf.result.found && near(rUf.result.pose[0], 50, 0.1) && near(rUf.result.pose[1], 0, 0.1),
    `USER 좌표계 비전 오프셋 출력: [${rUf.result.pose.join(', ')}] ≈ [50, 0, 0, 0]`);

  // 빈 공간을 보는 카메라 → 미검출
  c.setCameras([{
    ...c.cameras[0],
    pos: [-1500, -1500, 1000], rot: [180, 0, 0],
    vision: { ...c.cameras[0].vision, latencyMs: 0 },
  }]);
  const rEmpty = c.triggerVision('vis1', { deterministic: true });
  ok(rEmpty.ok && rEmpty.result.found === false && c.getDI(21) === false && c.getDI(20) === true && c.regs.get('MB:50') === 0,
    '시야 밖 미검출 처리: foundDI=OFF, doneDI=ON, MB:50=0');

  // ProjectStore 저장/복원
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'robotemu-p2-'));
  try {
    c.setAI(4, 3.33);
    c.setAO(5, 8.88);
    c.setZones([{ id: 'z1', name: 'KeepOut', kind: 'safe', shape: 'cylinder', p: [400, -300, 200], size: [200, 200, 300], outDO: 35 }]);
    const snap = new ProjectStore(c, dir).serialize('p2-test');
    const c2 = new Controller();
    new ProjectStore(c2, dir).apply(snap);
    ok(near(c2.getAI(4), 3.33) && near(c2.getAO(5), 8.88) && c2.zones.length === 1 && c2.zones[0].shape === 'cylinder' && c2.cameras[0]?.vision?.triggerDO === 20,
      '프로젝트 저장/복원 시 AI/AO · Zones · 카메라 비전 설정 유지');
    c2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  c.close();
}

console.log(`\n결과: 통과 ${pass}, 실패 ${fail}`);
process.exit(fail ? 1 : 0);
