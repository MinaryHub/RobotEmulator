// 셀 레이아웃 / 주변기기 시뮬레이션 테스트: node test/cell.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Controller } from '../server/controller.js';
import { ROBOTS } from '../shared/robots.js';
import { ikNearest, tcpToFlange } from '../shared/kinematics.js';
import { frameFromXYZRPY } from '../shared/poseformat.js';
import { getGripper } from '../shared/grippers.js';
import { checkCollision } from '../shared/collision.js';
import { presetLayout, conveyorGeometry, palletSlots, normalizeLayout } from '../server/cell.js';
import rapid from '../server/lang/rapid.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const check = (c, msg) => { if (!c) { fails++; console.log('  FAIL', msg); } else console.log('  ok  ', msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, sec) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > sec * 1000) return false; await sleep(10); } return true; };
const DOWN = [[-1, 0, 0], [0, 1, 0], [0, 0, -1]];
const near = (a, b, e = 1e-9) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= e);

const ctrl = new Controller();

// ---------------------------------------------------------------- 1) 기본 레이아웃 = 기존 resetScene 결과
console.log('[기본 레이아웃]');
{
  let okAll = true;
  for (const r of ROBOTS) {
    ctrl.setRobot(r.id);
    const R = r.reach;
    const s = Math.round(Math.max(30, Math.min(140, R * 0.045)) / 5) * 5;
    const floorZ = -Math.round(R * 0.45 / 50) * 50;
    const scene = { floorZ, table: { x: R * 0.6, y: 0, z: 0, w: R * 0.55, d: R * 1.1 }, pedestal: { d: Math.max(200, R * 0.3), h: -floorZ } };
    const colors = [0x3fa34d, 0xd9822b, 0x2f7ed8, 0xc03a3a];
    const objs = [-0.3, -0.1, 0.1, 0.3].map((f, i) => ({ id: `W${i + 1}`, size: [s, s, s], color: colors[i], p: [R * 0.55, R * f, s / 2] }));
    const same = JSON.stringify(ctrl.scene) === JSON.stringify(scene) && ctrl.objects.length === 4 &&
      ctrl.objects.every((o, i) => o.id === objs[i].id && o.color === objs[i].color && near(o.size, objs[i].size) && near(o.pose.p, objs[i].p) && near(o.pose.R.flat(), [1, 0, 0, 0, 1, 0, 0, 0, 1]));
    if (!same) { okAll = false; console.log('   차이:', r.id, JSON.stringify(ctrl.scene), JSON.stringify(ctrl.objects.map((o) => o.pose.p))); }
  }
  check(okAll, `${ROBOTS.length}개 모델 모두 기존 씬·공작물(W1..W4) 위치와 동일`);
  check(ctrl.cell.layout.preset === 'default' && ctrl.cell.layout.devices.length === 0, '기본 프리셋: 장치 없음');
  const snap = ctrl.snapshot();
  check(snap.cell && snap.cell.layout && snap.cell.presets.length >= 2, 'snapshot().cell 포함');
}

// ---------------------------------------------------------------- 2) getLayout / setLayout 왕복 + 검증
console.log('[레이아웃 왕복/검증]');
{
  ctrl.setRobot('yaskawa-gp7');
  ctrl.cell.applyPreset('conveyor');
  const L = ctrl.cell.getLayout();
  const json = JSON.stringify(ctrl.cell);
  check(json === JSON.stringify(L), 'toJSON() = getLayout()');
  L.preset = null; L.name = '왕복';
  L.obstacles.push({ id: 'OBX', name: '박스', x: 100, y: 600, z: 0, w: 50, d: 60, h: 70, color: '#ff0000' });
  ctrl.cell.setLayout(JSON.parse(JSON.stringify(L)));
  const L2 = ctrl.cell.getLayout();
  const L3 = normalizeLayout(L2);
  check(JSON.stringify(L2) === JSON.stringify(L3), 'setLayout → getLayout → normalize 결과 동일 (안정)');
  check(L2.obstacles[0].color === 0xff0000 && L2.preset === null, '색 문자열 정규화, 사용자 정의 레이아웃');
  let e1 = null; try { ctrl.cell.setLayout({ tables: [] }); } catch (e) { e1 = e; }
  check(e1 && /테이블/.test(e1.message), `테이블 없음 거부 (${e1?.message})`);
  let e2 = null; try { ctrl.cell.setLayout({ tables: [{ id: 'A', x: 1, w: 1, d: 1 }], obstacles: [{ id: 'A', x: 0, y: 0, w: 1, d: 1, h: 1 }] }); } catch (e) { e2 = e; }
  check(e2 && /중복/.test(e2.message), `id 중복 거부 (${e2?.message})`);
  let e3 = null; try { ctrl.cell.setLayout({ tables: [{ x: 1, w: 1, d: 1 }], devices: [{ type: 'sensor', x: 0, y: 0, di: 999 }] }); } catch (e) { e3 = e; }
  check(e3 && /범위/.test(e3.message), `신호 번호 범위 거부 (${e3?.message})`);
  check(JSON.stringify(ctrl.cell.getLayout()) === JSON.stringify(L2), '거부 시 기존 레이아웃 유지');
  // 사용자 정의 레이아웃은 같은 로봇 재선택 시 유지, 프리셋은 재생성
  ctrl.setRobot('yaskawa-gp12');
  check(ctrl.cell.layout.name === '왕복' && ctrl.cell.layout.obstacles.length === 1, '로봇 변경 시 사용자 정의 레이아웃 유지');
  ctrl.cell.applyPreset('conveyor');
  ctrl.setRobot('yaskawa-gp7');
  check(Math.abs(ctrl.cell.layout.devices[0].x0 - 927 * 0.5) < 1e-6, '로봇 변경 시 프리셋 재계산 (도달거리 비례)');
  // handle() 명령
  const r1 = ctrl.cell.handle({ op: 'add', kind: 'obstacle' });
  check(r1.itemId && r1.layout.obstacles.some((o) => o.id === r1.itemId) && r1.layout.preset === null, `handle add → ${r1.itemId}`);
  const r2 = ctrl.cell.handle({ op: 'update', id: r1.itemId, patch: { h: 123 } });
  check(r2.layout.obstacles.find((o) => o.id === r1.itemId).h === 123, 'handle update');
  const r3 = ctrl.cell.handle({ op: 'remove', id: r1.itemId });
  check(!r3.layout.obstacles.some((o) => o.id === r1.itemId), 'handle remove');
  ctrl.cell.handle({ op: 'preset', id: 'default' });
  check(ctrl.cell.layout.preset === 'default' && ctrl.objects.length === 4, 'handle preset default');
}

// ---------------------------------------------------------------- 3) 컨베이어 이송 + 스토퍼 + 센서 DI
console.log('[컨베이어/센서]');
{
  ctrl.setRobot('yaskawa-gp7');
  const s = 40;
  const base = ctrl.cell.getLayout();
  ctrl.cell.setLayout({
    ...base, preset: null, name: '컨베이어 시험',
    workpieces: [{ id: 'A', x: 0, y: -900, z: 0, size: [s, s, s], color: 0xff0000 }, { id: 'B', x: 0, y: -960, z: 0, size: [s, s, s], color: 0x00ff00 }],
    devices: [
      { type: 'conveyor', id: 'CV', x0: 0, y0: -1000, x1: 0, y1: -700, z: 0, width: 100, speed: 400, runDO: 9, stopper: true },
      { type: 'sensor', id: 'S', x: 0, y: -720, z: 20, w: 100, d: 20, h: 30, di: 9 },
      { type: 'sensor', id: 'SI', x: 0, y: -720, z: 20, w: 100, d: 20, h: 30, di: 20, invert: true },
    ],
  });
  await sleep(100);
  const A = ctrl.objects.find((o) => o.id === 'A');
  check(Math.abs(A.pose.p[1] + 900) < 1e-6 && !ctrl.getDI(9) && ctrl.getDI(20), 'DO9 OFF: 정지, 센서 OFF (반전 센서 DI20 ON)');
  ctrl.setDO(9, true);
  const arrived = await until(() => ctrl.getDI(9), 3);
  check(arrived, '컨베이어 운전 → 스토퍼 도착 센서 DI9 ON');
  await sleep(300);
  const B = ctrl.objects.find((o) => o.id === 'B');
  check(Math.abs(A.pose.p[1] - (-700 - s / 2)) < 1e-6, `A 가 스토퍼에서 정지 (y=${A.pose.p[1].toFixed(2)})`);
  check(Math.abs(B.pose.p[1] - (-700 - s - 0.5 - s / 2)) < 1e-6, `B 는 A 뒤에 줄 섬 (y=${B.pose.p[1].toFixed(2)})`);
  check(!ctrl.getDI(20), '반전 센서 DI20 OFF');
  check(ctrl.snapshot().cell.status.CV.running && ctrl.snapshot().cell.status.S.on, '상태: 컨베이어 운전, 센서 ON');
  // 파지 중 공작물은 이송하지 않음: A 를 들어 올리면 센서 OFF, B 가 전진
  ctrl.objects.splice(ctrl.objects.indexOf(A), 1);
  const gone = await until(() => Math.abs(B.pose.p[1] - (-700 - s / 2)) < 1e-6, 2);
  await sleep(30);
  check(gone && Math.abs(B.pose.p[1] - (-700 - s / 2)) < 1e-6 && ctrl.getDI(9), `A 제거 후 B 가 스토퍼로 전진, DI9 재 ON (gone=${gone} y=${B.pose.p[1]} di=${ctrl.getDI(9)})`);
  ctrl.setDO(9, false);
  // 레이아웃 교체 시 장치 DI 해제
  ctrl.cell.applyPreset('default');
  check(!ctrl.getDI(9) && !ctrl.getDI(20), '레이아웃 교체 시 장치가 켠 DI 해제');
}

// ---------------------------------------------------------------- 4) 피더 (DO 상승 에지) / 배출구 / 실린더
console.log('[피더/배출구/실린더]');
{
  const base = ctrl.cell.getLayout();
  ctrl.cell.setLayout({
    ...base, preset: null, workpieces: [],
    devices: [
      { type: 'feeder', id: 'F', x: 300, y: 600, z: 0, size: [30, 30, 30], mode: 'edge', triggerDO: 10, max: 2, prefix: 'Q' },
      { type: 'sink', id: 'SK', x: 300, y: -600, z: -400, w: 200, d: 200, h: 450, pulseDI: 30 },
      { type: 'cylinder', id: 'CY', x: 0, y: 700, z: 50, yaw: 0, length: 100, bore: 30, stroke: 80, time: 0.3, extendDO: 11, extDI: 11, retDI: 12 },
    ],
  });
  await sleep(50);
  check(ctrl.objects.length === 0, '피더 edge 모드: 신호 전에는 배출 없음');
  ctrl.setDO(10, true); await sleep(50);
  check(ctrl.objects.length === 1 && ctrl.objects[0].id === 'Q1' && Math.abs(ctrl.objects[0].pose.p[2] - 15) < 1e-9, `DO10 상승 에지 → 공작물 Q1 배출 (${ctrl.objects.map((o) => o.id)})`);
  await sleep(50);
  check(ctrl.objects.length === 1, 'DO10 유지 중에는 추가 배출 없음');
  ctrl.setDO(10, false); await sleep(30); ctrl.setDO(10, true); await sleep(50);
  check(ctrl.objects.length === 1 && ctrl.snapshot().cell.status.F.blocked, '배출 위치가 막혀 있으면 배출 안 함');
  // Q1 을 배출구 영역으로 이동 → 제거·계수 + DI30 펄스
  ctrl.objects[0].pose.p = [300, -600, -300];
  await sleep(50);
  check(ctrl.objects.length === 0 && ctrl.snapshot().cell.status.SK.count === 1, '배출구: 공작물 제거, 카운트 1');
  check(ctrl.getDI(30), '배출구 펄스 DI30 ON');
  await sleep(400);
  check(!ctrl.getDI(30), '배출구 펄스 DI30 OFF (0.3s 후)');
  ctrl.setDO(10, false); await sleep(30); ctrl.setDO(10, true); await sleep(50);
  ctrl.setDO(10, false); await sleep(30); ctrl.setDO(10, true); await sleep(50);
  check(ctrl.snapshot().cell.status.F.count === 2 && ctrl.objects.length === 1, '피더 최대 배출 수(2) 제한');
  ctrl.setDO(10, false);
  check(ctrl.getDI(12) && !ctrl.getDI(11), '실린더 후진 확인 DI12 ON');
  ctrl.setDO(11, true);
  await sleep(100);
  check(!ctrl.getDI(12) && !ctrl.getDI(11), '실린더 이동 중: 양쪽 OFF');
  check(await until(() => ctrl.getDI(11), 1), '행정 시간 후 전진 확인 DI11 ON');
  const rod = ctrl.cell.obstacles().find((o) => o.id === 'CY.rod');
  check(rod && Math.abs(rod.h[0] * 2 - (80 + 9)) < 1e-6, '실린더 로드 간섭 박스가 전진 위치 반영');
  ctrl.setDO(11, false);
  ctrl.cell.applyPreset('default');
}

// ---------------------------------------------------------------- 5) 장애물 간섭
console.log('[장애물 간섭]');
{
  // shared/collision.js 하위 호환: obstacles 미지정 시 결과 동일
  const m = ROBOTS.find((r) => r.id === 'yaskawa-gp7');
  ctrl.setRobot('yaskawa-gp7');
  const j = [0, 30, 0, 0, -60, 0];
  const a = checkCollision(m, j, ctrl.gripper, ctrl.scene, ctrl.objects);
  const b = checkCollision(m, j, ctrl.gripper, ctrl.scene, ctrl.objects, { obstacles: [] });
  check(a.hit === b.hit && a.minDist === b.minDist, 'obstacles 미지정/빈 배열 → 결과 동일');
  const tcp = ctrl.tcpPose();
  const ob = { id: 'BOX', c: [...tcp.p], h: [30, 30, 30] };
  const c = checkCollision(m, ctrl.joints, ctrl.gripper, ctrl.scene, ctrl.objects, { obstacles: [{ ...ob, c: [tcp.p[0], tcp.p[1], tcp.p[2] + 60] }] });
  check(c.hit && c.pairs.some((p) => p.a === 'tool' && p.b === 'BOX'), 'tool ↔ 장애물 충돌 검출');
  const d = checkCollision(m, ctrl.joints, ctrl.gripper, ctrl.scene, ctrl.objects, { obstacles: [{ ...ob, c: [tcp.p[0], tcp.p[1], tcp.p[2] + 60], tool: false }] });
  check(!d.pairs.some((p) => p.a === 'tool' && p.b === 'BOX'), 'tool:false 장애물은 툴 검사 제외');

  // 컨트롤러: 테이블 위 장애물로 내려가면 COLLISION 알람
  const L = ctrl.cell.getLayout();
  const o = ctrl.objects[0];
  const px = o.pose.p[0], py = o.pose.p[1] + 140;
  L.preset = null;
  L.obstacles.push({ id: 'FIX1', name: '고정구', x: px, y: py, z: 0, w: 80, d: 80, h: 120, color: 0x888888 });
  ctrl.cell.setLayout(L);
  ctrl.setServo(true);
  await ctrl.move({ kind: 'J', target: { pose: { p: [px, py, 400], R: DOWN } }, speed: { frac: 0.5 } });
  check(!ctrl.collision.hit, '장애물 위 400mm: 간섭 없음');
  let err = null;
  await ctrl.move({ kind: 'L', target: { pose: { p: [px, py, 50], R: DOWN } }, speed: { tcp: 250 } }).catch((e) => (err = e));
  check(ctrl.alarms.some((x) => x.code === 'COLLISION' && /FIX1/.test(x.msg)) && err?.aborted, `장애물 진입 → COLLISION 알람 (${ctrl.alarms.map((x) => x.msg).join(' / ')})`);
  check(ctrl.tcpPose().p[2] > 110, `장애물 윗면(120) 부근에서 정지 (z=${ctrl.tcpPose().p[2].toFixed(1)})`);
  ctrl.resetAlarms(); ctrl.setServo(true);
  await ctrl.move({ kind: 'L', target: { pose: { p: [px, py, 400], R: DOWN } }, speed: { tcp: 250 } });
  // 컨베이어 프레임도 간섭 대상
  ctrl.cell.applyPreset('conveyor');
  const g = conveyorGeometry(ctrl.robot.reach);
  const obs = ctrl.cell.obstacles();
  check(obs.some((x) => x.id === 'CV1') && obs.some((x) => x.id === 'F1'), '컨베이어 프레임·피더 호퍼가 간섭 박스에 포함');
  // 컨베이어 끝 공작물 파지 자세: 벨트 면은 툴 검사에서 검출되지 않음 (TCP 5mm 여유)
  await ctrl.move({ kind: 'J', target: { pose: { p: [g.pick[0], g.pick[1], 150], R: DOWN } }, speed: { frac: 0.5 } });
  await ctrl.move({ kind: 'L', target: { pose: { p: g.pick, R: DOWN } }, speed: { tcp: 250 } });
  check(!ctrl.collision.hit && !ctrl.alarms.length, `컨베이어 위 공작물 파지 위치에서 간섭 없음 (${ctrl.collision.pairs.map((p) => p.a + '-' + p.b)})`);
  let err2 = null;
  await ctrl.move({ kind: 'L', target: { pose: { p: [g.pick[0], g.pick[1] - 100, -30], R: DOWN } }, speed: { tcp: 250 } }).catch((e) => (err2 = e));
  check(ctrl.alarms.some((x) => x.code === 'COLLISION' && /CV1/.test(x.msg)), `벨트 아래로 내려가면 컨베이어 간섭 (${ctrl.alarms.map((x) => x.msg).join(' / ')})`);
  ctrl.resetAlarms(); ctrl.setServo(true);
  await ctrl.move({ kind: 'L', target: { pose: { p: [g.pick[0], g.pick[1], 200], R: DOWN } }, speed: { tcp: 250 } });
  ctrl.setServo(false);
}

// ---------------------------------------------------------------- 6) 컨베이어 프리셋 도달 가능성 (전 모델)
console.log('[컨베이어 프리셋 도달 가능성]');
{
  const tool = frameFromXYZRPY(getGripper('robotiq-2f85').tcp);
  const bad = [];
  for (const r of ROBOTS) {
    const L = presetLayout('conveyor', r);
    const g = conveyorGeometry(r.reach);
    const app = Math.max(100, g.s * 2.5);
    const pts = [g.pick, [g.pick[0], g.pick[1], g.pick[2] + app]];
    for (const q of palletSlots(L.devices.find((d) => d.type === 'pallet'))) pts.push([q[0], q[1], q[2] + g.s / 2 + 1], [q[0], q[1], q[2] + g.s / 2 + app]);
    for (const p of pts) if (!ikNearest(r, tcpToFlange({ p, R: DOWN }, tool, null), r.home)) bad.push(`${r.id} ${p.map((v) => v.toFixed(0))}`);
    // 레이아웃 정합성: 픽 위치가 센서 영역 안, 팔레트 슬롯이 테이블 위
    const sen = L.devices.find((d) => d.type === 'sensor'), t = L.tables[0];
    if (Math.abs(sen.y - g.pick[1]) > 1e-6) bad.push(`${r.id} 센서 위치`);
    for (const q of palletSlots(L.devices.find((d) => d.type === 'pallet'))) if (Math.abs(q[0] - t.x) > t.w / 2 - g.s || Math.abs(q[1] - t.y) > t.d / 2 - g.s) bad.push(`${r.id} 슬롯 테이블 밖`);
  }
  check(!bad.length, `${ROBOTS.length}개 모델: 픽/적재 위치(접근점 포함) 모두 도달 가능 ${bad.join('; ')}`);
}

// ---------------------------------------------------------------- 7) 예제 프로그램: examples/conveyor (RAPID)
console.log('[컨베이어 예제 실행 abb-irb1200]');
{
  ctrl.setRobot('abb-irb1200');
  ctrl.setGripper('robotiq-2f85');
  ctrl.setCollisionMode('stop');
  ctrl.cell.applyPreset('conveyor');
  const name = 'ConveyorPick.mod';
  ctrl.loadFiles({ [name]: fs.readFileSync(path.join(ROOT, 'examples/conveyor/abb-irb1200', name), 'utf8') }, true);
  ctrl.main = name; ctrl.compile(true);
  check(!ctrl.compileError, `컴파일 ${ctrl.compileError ? JSON.stringify(ctrl.compileError) : ''}`);
  ctrl.resetAlarms(); ctrl.setServo(true); ctrl.setOverride(100);
  const t0 = Date.now();
  const started = await ctrl.start();
  const done = started && await until(() => ['done', 'error', 'aborted'].includes(ctrl.vm.status), 150);
  check(done && ctrl.vm.status === 'done', `실행 완료 (status=${ctrl.vm.status}, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  check(ctrl.alarms.length === 0, `알람 없음 ${ctrl.alarms.map((a) => a.msg).join(' / ')}`);
  check(rapid.readVar(ctrl, 'nCount') === '4', `nCount = ${rapid.readVar(ctrl, 'nCount')}`);
  const slots = palletSlots(ctrl.cell.layout.devices.find((d) => d.type === 'pallet')).slice(0, 4);
  const placed = slots.filter((q) => ctrl.objects.some((o) => Math.hypot(o.pose.p[0] - q[0], o.pose.p[1] - q[1]) < 3 && Math.abs(o.pose.p[2] - 20) < 1e-6));
  check(placed.length === 4, `팔레트 슬롯 4곳에 적재 (${placed.length})`);
  check(!ctrl.getDO(9), '종료 후 컨베이어 정지 (DO9 OFF)');
  ctrl.setServo(false);
  ctrl.cell.applyPreset('default');
}

// ---------------------------------------------------------------- 회귀: 실린더 끝단 확인 DI 와 로드 위치 일치 (스텝 크기와 무관)
// dt = 0.00833 s 로 진행하면 이전에는 pos = 0.9996 에서 DI 가 ON 인데 로드 간섭 박스가 덜 나온 스텝이 생겼다 (CI 간헐 실패 원인)
console.log('[실린더 확인 DI ↔ 로드 위치]');
{
  const c = new Controller();
  clearInterval(c._timer);
  const base = c.cell.getLayout();
  c.cell.setLayout({ ...base, devices: [...base.devices, { type: 'cylinder', id: 'CY', name: 'CY', x: 600, y: -300, z: 50, yaw: 0, length: 120, bore: 30, stroke: 80, time: 0.5, extendDO: 11, extDI: 11, retDI: 12 }] });
  let bad = 0;
  for (const dt of [0.00833, 0.0071, 0.0109]) {
    for (const ext of [true, false]) {
      c.setDO(11, ext);
      for (let i = 0; i < 200; i++) {
        c.cell.tick(dt);
        const rod = c.cell.obstacles().find((o) => o.id === 'CY.rod');
        if (c.getDI(11) && Math.abs(rod.h[0] * 2 - 89) > 1e-6) bad++;
        if (c.getDI(12) && c.cell.rt.CY.pos !== 0) bad++;
      }
    }
  }
  check(bad === 0, `확인 DI ON 이면 실린더가 끝단에 있음 (불일치 ${bad} 스텝)`);
}

console.log(fails ? `\n실패 ${fails}건` : '\n모두 통과');
process.exit(fails ? 1 : 0);
