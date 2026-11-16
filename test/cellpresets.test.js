// 추가 셀 프리셋(머신 텐딩 / 2테이블 / 출하 컨베이어 / 안전펜스) 테스트
//  1) 전 로봇 모델: 홈 자세 간섭 없음, 공작물 픽·Y 대칭 플레이스(접근점 포함) 도달 가능, 플레이스 위치 아래 지지면(z=0)
//     (Y 대칭 = INFORM/HRScript/DRL 예제 규칙. KRL/RAPID/AS 는 같은 테이블에서 X 이동 → 2) 에서 실제 실행으로 확인)
//  2) 제조사별 최소·최대 도달거리 모델: 기본 예제 프로그램을 간섭 정지 모드로 끝까지 실행 → 알람 없음, 공작물 이송 확인
//  3) 장치 동작: 출하 컨베이어 → 배출구 계수, CNC 도어 실린더, 반입구 센서
import { Controller } from '../server/controller.js';
import { ROBOTS } from '../shared/robots.js';
import { ikNearest, tcpToFlange } from '../shared/kinematics.js';
import { frameFromXYZRPY } from '../shared/poseformat.js';
import { getGripper } from '../shared/grippers.js';
import { PRESETS, presetLayout, normalizeLayout, partSize } from '../server/cell.js';
import { LANGS } from '../server/lang/index.js';

let fails = 0;
const ok = (c, msg) => { if (c) console.log('  ok  ', msg); else { fails++; console.log('  FAIL', msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DOWN = [[-1, 0, 0], [0, 1, 0], [0, 0, -1]];
const NEW = ['machine', 'dual', 'outfeed', 'fenced'];
const FX = [0.38, 0.42, 0.34, 0.46, 0.30, 0.50];   // 예제 생성기(planPickPlace)와 같은 후보

console.log('[프리셋 목록]');
ok(NEW.every((id) => PRESETS.some((p) => p.id === id)), `프리셋 ${PRESETS.length}개: ${PRESETS.map((p) => p.id).join(', ')}`);

// ---------------------------------------------------------------- 1) 전 모델 정적 검사
console.log('[전 모델: 간섭·도달·지지면]');
{
  const tool = frameFromXYZRPY(getGripper('robotiq-2f85').tcp);
  const c = new Controller(); clearInterval(c._timer);
  c.setGripper('robotiq-2f85');
  for (const id of NEW) {
    const bad = [];
    for (const r of ROBOTS) {
      c.setRobot(r.id);
      c.cell.applyPreset(id);
      const L = c.cell.layout;
      try { normalizeLayout(presetLayout(id, r)); } catch (e) { bad.push(`${r.id} 검증 ${e.message}`); continue; }
      c.checkCollisionNow();
      if (c.collision.hit) bad.push(`${r.id} 홈 간섭 ${c.collision.pairs.map((p) => p.a + '-' + p.b)}`);
      const reach = (p) => !!ikNearest(r, tcpToFlange({ p, R: DOWN }, tool, null), r.home);
      const R = r.reach, s = partSize(R), app = Math.round(Math.max(80, s * 2.5));
      const fx = FX.find((f) => L.workpieces.every((w) => {
        const pick = [w.x, w.y, s / 2], place = [R * f, -w.y, s / 2 + 1];
        return [pick, [pick[0], pick[1], pick[2] + app], place, [place[0], place[1], place[2] + app]].every(reach);
      }));
      if (fx === undefined) { bad.push(`${r.id} 도달 불가`); continue; }
      for (const w of L.workpieces) {
        const z = c.cell.supportAt(R * fx, -w.y, 10, true);
        if (Math.abs(z) > 1e-6) bad.push(`${r.id} ${w.id} 플레이스 지지면 z=${z}`);
      }
    }
    ok(!bad.length, `${id}: ${ROBOTS.length}개 모델 ${bad.slice(0, 6).join('; ')}${bad.length > 6 ? ` 외 ${bad.length - 6}건` : ''}`);
  }
}

// ---------------------------------------------------------------- 2) 예제 실행 (제조사별 최소·최대)
async function runExample(robotId, presetId) {
  const c = new Controller();
  c.setRobot(robotId);
  c.setGripper('robotiq-2f85');
  c.cell.applyPreset(presetId);
  c.loadFiles(c.lang.defaultFiles(c), true);
  c.setCollisionMode('stop');
  c.setTimeScale(10);
  c.setOverride(100);
  c.setServo(true);
  const before = new Map(c.objects.map((o) => [o.id, [...o.pose.p]]));
  const t0 = performance.now();
  let started = false;
  try { started = await c.start(); } catch { /* 아래에서 보고 */ }
  while (started && !['done', 'error', 'aborted'].includes(c.vm.status)) {
    if (performance.now() - t0 > 120000) { c.stopProgram(); break; }
    await sleep(20);
  }
  // 제조사마다 예제의 내려놓는 위치 규칙이 다름 (Y 대칭 / X 이동) → 옮겨졌고 z=0 지지면 위에 놓였는지만 확인
  const moved = c.objects.filter((o) => {
    const b = before.get(o.id), a = o.pose.p;
    return b && Math.hypot(a[0] - b[0], a[1] - b[1]) > 30 && Math.abs(a[2] - o.size[2] / 2) < 1.5;
  }).length;
  const res = { status: c.vm.status, alarms: c.alarms.map((a) => a.msg), moved, n: before.size, compile: c.compileError };
  c.setServo(false);
  clearInterval(c._timer);
  return res;
}

{
  const pick = [];
  for (const v of Object.keys(LANGS)) {
    const rs = ROBOTS.filter((r) => r.id.startsWith(v + '-')).sort((a, b) => a.reach - b.reach);
    if (rs.length) pick.push(rs[0].id, rs[rs.length - 1].id);
  }
  for (const id of NEW) {
    console.log(`[예제 실행: ${id}]`);
    const out = await Promise.all(pick.map(async (rid) => [rid, await runExample(rid, id)]));
    for (const [rid, r] of out) ok(r.status === 'done' && !r.alarms.length && r.moved === r.n, `${id} ${rid}: ${r.status}, 이송 ${r.moved}/${r.n}${r.alarms.length ? ' 알람: ' + r.alarms.join(' / ') : ''}${r.compile ? ' 컴파일: ' + JSON.stringify(r.compile) : ''}`);
  }
}

// ---------------------------------------------------------------- 3) 장치 동작
console.log('[장치 동작]');
{
  const c = new Controller(); clearInterval(c._timer);
  c.setRobot('yaskawa-gp7');
  // 출하 컨베이어: 벨트 위 공작물 → DO9 운전 → 끝 센서(DI9) → 배출구 계수(DI10 펄스)
  c.cell.applyPreset('outfeed');
  const cv = c.cell.layout.devices.find((d) => d.id === 'CV1');
  const o = c.objects[0];
  o.pose.p = [cv.x0, cv.y0 + 60, o.size[2] / 2];
  c.setDO(9, true);
  let sawSensor = false, sawPulse = false;
  for (let i = 0; i < 2000 && c.cell.rt.SK1.count === 0; i++) { c.cell.tick(0.02); sawSensor ||= c.getDI(9); sawPulse ||= c.getDI(10); }
  ok(sawSensor && c.cell.rt.SK1.count === 1 && sawPulse && !c.objects.includes(o), `출하 컨베이어 → 끝 센서 → 배출구 계수 (count ${c.cell.rt.SK1.count})`);
  c.setDO(9, false);
  // CNC 도어 실린더
  c.cell.applyPreset('machine');
  c.cell.tick(0.02);
  ok(c.getDI(12) && !c.getDI(11), 'CNC 도어: 초기 닫힘 (DI12)');
  c.setDO(11, true);
  for (let i = 0; i < 100; i++) c.cell.tick(0.02);
  ok(c.getDI(11) && !c.getDI(12), 'CNC 도어: DO11 → 열림 (DI11)');
  c.setDO(11, false);
  // 반입구 센서
  c.cell.applyPreset('fenced');
  const t2 = c.cell.layout.tables[1];
  c.cell.tick(0.02);
  ok(!c.getDI(13), '반입구 센서: 비어 있으면 OFF');
  c.objects[0].pose.p = [t2.x, t2.y, c.objects[0].size[2] / 2];
  c.cell.tick(0.02);
  ok(c.getDI(13), '반입구 센서: 공작물 놓으면 DI13 ON');
}

console.log(fails ? `\n${fails}건 실패` : '\n모두 통과');
process.exit(fails ? 1 : 0);
