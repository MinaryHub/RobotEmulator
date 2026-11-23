// 성능 개선 · 기능 추가 · 버그 수정 회귀 테스트
//   node test/improvements.test.js
import { RfromZYZ, ZYZfromR } from '../shared/math.js';
import { fkFlange, ikNearest } from '../shared/kinematics.js';
import { ROBOTS, VENDORS } from '../shared/robots.js';
import { robotCapsules } from '../shared/collision.js';
import { buildBVH, rayMesh } from '../shared/meshcol.js';
import { vendorAlarm, ALARM_CODES } from '../shared/alarms.js';
import { hostAllowed } from '../server/netguard.js';
import { Controller } from '../server/controller.js';
import { TrafficMonitor } from '../server/protocols/traffic.js';
import { Timeline } from '../server/inspect.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`  ✔ ${msg}`); }
  else { fail++; console.log(`  ✘ ${msg}`); }
};

console.log('■ 기구학 · 수학 · 충돌 회귀 검증');
{
  // 1) ZYZfromR(RfromZYZ(0, 180, 30)) 왕복 검증 (특이점 A=180° 부호 오류 수정)
  const R1 = RfromZYZ(0, 180, 30);
  const [o, a, t] = ZYZfromR(R1);
  const R2 = RfromZYZ(o, a, t);
  let maxErr = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) maxErr = Math.max(maxErr, Math.abs(R1[i][j] - R2[i][j]));
  ok(maxErr < 1e-9, `ZYZfromR(A=180°) 회전 행렬 왕복 오차 < 1e-9 (${maxErr.toExponential(2)})`);

  // 2) UR 손목 특이점(J5=0 + 1e-15 수치 오차)에서 J6 유지
  const ur5e = ROBOTS.find((r) => r.id === 'ur-ur5e');
  const ref = [10, -80, 90, -100, 0, 42];
  const target = fkFlange(ur5e, ref);
  target.R[2][2] += 1e-15; // float64 미세 섭동
  const sol = ikNearest(ur5e, target, ref);
  ok(sol && Math.abs(sol[5] - 42) < 1, `UR5e 손목 특이점에서 J6 유지 (${sol?.[5]?.toFixed(2)}°)`);

  // 3) 사용자 STL 그리퍼(sections/caps 없음)도 기본 충돌 캡슐을 생성
  const gp7 = ROBOTS.find((r) => r.id === 'yaskawa-gp7');
  const caps = robotCapsules(gp7, gp7.home, { id: 'custom', custom: true, kind: 'parallel', tcp: [0, 0, 150, 0, 0, 0] });
  ok(caps.some((c) => c.id === 'tool'), '사용자 STL 그리퍼 fallback 툴 충돌 캡슐 생성');

  // 4) rayMesh 슬랩 테스트 (-0 방향 성분으로 인한 NaN 없음)
  const pos = new Float32Array([
    0, 0, 10,  10, 0, 10,  10, 10, 10,
    0, 0, 10,  10, 10, 10,  0, 10, 10,
  ]);
  const idx = new Uint32Array([0, 1, 2, 3, 4, 5]);
  const bvh = buildBVH(pos, idx);
  const hit = rayMesh(bvh, [10, 10, 20], [-0, -0, -1], 50);
  ok(hit !== null && Math.abs(hit - 10) < 1e-6, `rayMesh 경계(-0 방향) 교차 정상 (t=${hit})`);
}

console.log('■ 보안 · netguard 검증');
{
  const req = (host) => ({ headers: host === undefined ? {} : { host } });
  ok(hostAllowed(req('localhost:3000')), 'localhost:3000 허용');
  ok(hostAllowed(req(undefined)), 'Host 미포함(비HTTP/테스트) 허용');
  ok(!hostAllowed(req('http://evil.com')), '기형적 Host(스킴 포함) 거부');
  ok(!hostAllowed(req('bad host')), '공백 포함 Host 거부');
  ok(!hostAllowed(req('evil.example.com:3000')), '외부 도메인 Host 거부');
}

console.log('■ 제조사별 알람 코드 매핑 (shared/alarms.js)');
{
  const vendors = Object.keys(VENDORS);
  let allMapped = true;
  for (const v of vendors) {
    for (const code of ALARM_CODES) {
      const info = vendorAlarm(v, code);
      if (!info || !info.code || !info.name) allMapped = false;
    }
  }
  ok(allMapped, `${vendors.length}개 제조사 × ${ALARM_CODES.length}개 알람 코드 매핑 완전`);

  const c = new Controller();
  c.close();
  c.setRobot('abb-irb1200');
  c.alarm('ESTOP', 'test estop');
  const a = c.alarms[c.alarms.length - 1];
  const expected = vendorAlarm('abb', 'ESTOP');
  ok(a.vendorCode === expected.code && a.vendorName === expected.name, `Controller.alarm 제조사 코드 첨부 (ABB ESTOP → ${a.vendorCode})`);
}

console.log('■ 고장 주입 · 스텝 조그 · 입력 방어 · 복구 시나리오');
{
  const c = new Controller();
  c.close();
  c.setRobot('yaskawa-gp7');
  c.setMode('TEACH', 'ui');
  c.setServo(true, 'ui');

  // 1) 스텝 조그 (관절 & 직교)
  const j0Before = c.joints[0];
  const r1 = c.stepJog({ type: 'joint', axis: 0, dir: 1, step: 5 }, 'ui');
  ok(r1.ok && Math.abs(c.joints[0] - (j0Before + 5)) < 1e-6, `관절 스텝 조그 +5° (${c.joints[0].toFixed(2)}°)`);
  const zBefore = c.tcpPose().p[2];
  const r2 = c.stepJog({ type: 'cart', axis: 2, dir: 1, step: 10, frame: 'base' }, 'ui');
  ok(r2.ok && Math.abs(c.tcpPose().p[2] - (zBefore + 10)) < 0.2, `직교 스텝 조그 +Z 10mm (${c.tcpPose().p[2].toFixed(2)})`);

  // 2) 잘못된 조그 페이로드가 NaN으로 관절을 오염시키지 않음
  c.startJog({ type: 'joint', axis: 99, dir: NaN, speed: 'bad' }, 'ui');
  c.applyJog(0.1);
  ok(c.joints.every(Number.isFinite), '비정상 jog 입력 시 관절각 NaN 오염 없음');

  // 3) 고장 주입: 그리퍼 파지 실패
  const obj = c.objects[0];
  c.setFaults({ gripperFail: true });
  c.gripperCmd(true);
  // 툴을 공작물 위치에 가깝게 두더라도 gripperFail 때문에 파지 안 됨
  ok(!c.grip.holding && c.faults.gripperFail, '고장 주입: gripperFail 설정 시 파지 방지');

  // 4) 고장 주입: 센서 고착 (컨베이어 프리셋에서 센서 확인)
  c.cell.applyPreset('conveyor');
  const sensor = c.cell.layout.devices.find((d) => d.type === 'sensor');
  c.setFaults({ sensorStuck: { [sensor.id]: 'on' } });
  c.cell.tick(0.05);
  ok(c.getDI(sensor.di) === true, `고장 주입: 센서(${sensor.id}) 고착 ON → DI${sensor.di}=ON`);

  // 5) 고장 주입: 컨베이어 정지
  c.setFaults({ conveyorStall: true });
  const conv = c.cell.layout.devices.find((d) => d.type === 'conveyor');
  if (conv.runDO) c.setDO(conv.runDO, true);
  c.cell.tick(0.05);
  ok(c.cell.snapshot().status[conv.id]?.running === false, '고장 주입: conveyorStall 시 컨베이어 정지');

  // 6) 즉시 고장 트리거: 서보 트립
  c.injectFaultAction('servoTrip');
  ok(!c.servo && c.alarms.some((x) => x.code === 'SERVO_TRIP'), '서보 트립 주입 → 서보 OFF + SERVO_TRIP 알람');

  // 7) 비상정지 활성 상태에서 로봇 교체 시 ESTOP 알람 유지
  c.resetAlarms();
  c.setEstop(true, 'ui');
  c.setRobot('kuka-kr6-r900');
  ok(c.estopActive && c.alarms.some((x) => x.code === 'ESTOP'), '로봇 교체 후에도 활성 비상정지 알람 유지');
  c.setEstop(false, 'ui');
  c.clearFaults();
  ok(!c.faults.gripperFail && !c.faults.conveyorStall && Object.keys(c.faults.sensorStuck).length === 0, 'clearFaults() 전체 고장 해제');
}

console.log('■ 통신 모니터(TrafficMonitor) · 타임라인 CSV');
{
  const c = new Controller();
  c.close();
  const tm = new TrafficMonitor(c);
  tm.connect('modbus', '127.0.0.1:50001');
  tm.record('modbus', { client: '127.0.0.1:50001', ok: true, ms: 1.25, summary: 'FC03 HR0..1', hex: '00 01 | 00 02' });
  tm.record('abbRws', { client: '127.0.0.1:50002', ok: false, ms: 4.5, summary: 'POST /rw/rapid/execution', error: 'HTTP 400' });
  const all = tm.listEntries();
  const errs = tm.listEntries({ errorsOnly: true });
  const mb = tm.listEntries({ iface: 'modbus' });
  ok(all.length === 2 && errs.length === 1 && mb.length === 1, 'TrafficMonitor 기록 및 인터페이스/오류 필터');
  const tcsv = tm.toCSV();
  ok(tcsv.includes('FC03 HR0..1') && tcsv.includes('HTTP 400'), 'TrafficMonitor CSV 내보내기');
  tm.disconnect('modbus', '127.0.0.1:50001');
  ok(tm.listClients().every((cl) => !cl.active), 'TrafficMonitor 클라이언트 세션 해제');

  const tl = new Timeline(c);
  c.setDO(1, true);
  c.setDO(1, false);
  const csv = tl.toCSV({ do: { 1: { name: 'CLAMP' } } });
  ok(csv.includes(',DO1,CLAMP,1') && csv.includes(',DO1,CLAMP,0'), 'Timeline.toCSV() 이름표 포함 CSV 출력');
}

console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
