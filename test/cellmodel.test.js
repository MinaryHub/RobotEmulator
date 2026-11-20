// 사용자 3D 모델(셀 models[]) 테스트: 자산 저장·검증, 배치 기본값, 메시 정밀 간섭(알람), 지지면(낙하), 위쪽 축 변경, 파일 없음, 프로젝트 왕복
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Controller } from '../server/controller.js';
import { AssetStore } from '../server/assets.js';
import { ProjectStore } from '../server/project.js';
import { encodeCol } from '../shared/meshcol.js';
import { normalizeLayout, modelBaseOffset } from '../server/cell.js';

let fails = 0;
const check = (c, msg) => { if (!c) { fails++; console.log('  FAIL', msg); } else console.log('  ok  ', msg); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 're-model-'));

// 박스 메시 (중심 c, 반폭 h) — 파일 단위
function boxMesh(c, h) {
  const p = [];
  for (const z of [-1, 1]) for (const y of [-1, 1]) for (const x of [-1, 1]) p.push(c[0] + x * h[0], c[1] + y * h[1], c[2] + z * h[2]);
  const f = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const idx = [];
  for (const [a, b, cc, d] of f) idx.push(a, b, cc, a, cc, d);
  return { positions: Float32Array.from(p), indices: Uint32Array.from(idx) };
}
function uploadBody(name, format, mesh, glbTail = 'x') {
  const glb = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(16), Buffer.from(glbTail)]);
  const col = Buffer.from(encodeCol(mesh.positions, mesh.indices));
  const h = Buffer.from(JSON.stringify({ name, format, glbBytes: glb.length, colBytes: col.length, srcTris: 12 }));
  const pre = Buffer.alloc(4); pre.writeUInt32LE(h.length);
  return Buffer.concat([pre, h, glb, col]);
}

const logs = [];
const ctrl = new Controller();
clearInterval(ctrl._timer);
ctrl.on('log', (e) => logs.push(e.msg));
ctrl.assets = new AssetStore(path.join(tmp, 'assets'), (s, m) => ctrl.log(s, m));
ctrl.setRobot('yaskawa-gp7');
const R = ctrl.robot.reach;

console.log('[자산 저장]');
// 1×0.6×0.8 m 장비 (Z 위, 파일 단위 mm, 원점이 한쪽 모서리)
const machine = boxMesh([500, 300, 400], [500, 300, 400]);
const meta = ctrl.assets.save(uploadBody('cnc.step', 'step', machine));
check(/^[0-9a-f]{16}$/.test(meta.id) && meta.tris === 12 && meta.bbox[1][2] === 800, `메타: id ${meta.id}, 삼각형 ${meta.tris}, bbox 높이 ${meta.bbox[1][2]}`);
check(ctrl.assets.save(uploadBody('cnc.step', 'step', machine)).id === meta.id && ctrl.assets.list().length === 1, '같은 내용은 1번만 저장 (내용 해시 id)');
let threw = 0;
for (const bad of [Buffer.alloc(3), (() => { const b = uploadBody('a', 'stl', machine); b.write('XXXX', 4 + b.readUInt32LE(0)); return b; })(), uploadBody('a', 'stl', machine).subarray(0, 100)]) {
  try { ctrl.assets.save(bad); } catch { threw++; }
}
check(threw === 3, '잘못된 업로드(빈 본문 / GLB 아님 / 크기 불일치) 거부');
let trav = false;
try { ctrl.assets.file('../../etc', 'glb'); } catch { trav = true; }
check(trav, '자산 id 형식 검증 (경로 조작 차단)');

console.log('[배치]');
const add = ctrl.cell.handle({ op: 'addModel', asset: meta.id, name: 'cnc.step' });
const m = add.layout.models[0];
check(m.id === 'M1' && m.name === 'cnc' && m.up === 'z' && m.unit === 1, `기본값: ${m.id} ${m.name} up=${m.up} unit=${m.unit}`);
check(m.offset.join() === '-500,-300,0' && m.z === ctrl.scene.floorZ, `바닥 중심 원점 보정 offset=${m.offset} · 바닥 z=${m.z}`);
check(m.x > R, `기본 위치는 로봇 도달거리 밖 (x=${m.x}, reach=${R})`);
check(add.layout.preset === null, '모델 추가 → 사용자 정의 레이아웃');

console.log('[간섭]');
ctrl.setServo?.(true, 'ui');
const before = ctrl.collision.hit;
// 장비를 로봇 정면 가까이로: 손목이 장비 안쪽 벽을 지나도록 (x=R*0.45, 장비 상면 = 홈 TCP 높이 근처)
const tcpZ = ctrl.tcpPose().p[2];
ctrl.cell.handle({ op: 'update', id: 'M1', patch: { x: R * 0.55, y: 0, z: tcpZ - 400 } });
ctrl.checkCollisionNow();
check(!before && ctrl.collision.hit && ctrl.collision.pairs.some((p) => p.b === 'M1'), `장비가 손목·툴 위치를 덮음 → 간섭 (${ctrl.collision.pairs.map((p) => p.a + '↔' + p.b).join(', ')})`);
check(ctrl.alarms.some((a) => a.code === 'COLLISION'), '정지 모드 → COLLISION 알람');
ctrl.resetAlarms?.();
ctrl.cell.handle({ op: 'update', id: 'M1', patch: { collide: false } });
ctrl.checkCollisionNow();
check(!ctrl.collision.pairs.some((p) => p.b === 'M1'), 'collide=false → 간섭 제외');
// 박스 근사였다면 검출됐을 위치: 장비를 L 자형(속이 빈 형상)으로 바꾸기 대신, 45° 회전한 얇은 판 옆 → 정밀 판정 확인
const plate = ctrl.assets.save(uploadBody('plate.stl', 'stl', boxMesh([0, 0, 0], [600, 5, 400]), 'p'));
ctrl.cell.handle({ op: 'update', id: 'M1', patch: { asset: plate.id, bbox: plate.bbox, offset: [0, 0, 0], collide: true, x: R * 0.6, y: 0, z: tcpZ, rz: 45 } });
const tcp = ctrl.tcpPose().p;
ctrl.checkCollisionNow();
const obb = ctrl.cell.obstacles().find((o) => o.id === 'M1');
check(!!obb?.mesh, '메시 간섭 객체 생성');
// TCP 를 판 쪽으로 옮겨가며 처음 간섭이 나는 위치와 판 표면 사이 거리가 툴 캡슐 반경 수준인지 확인
let firstHit = null;
for (let dx = 0; dx < R; dx += 5) {
  ctrl.cell.handle({ op: 'update', id: 'M1', patch: { x: tcp[0] + 700 - dx } });
  ctrl.checkCollisionNow();
  if (ctrl.collision.pairs.some((p) => p.b === 'M1')) { firstHit = 700 - dx; break; }
}
// 판(두께 10mm)이 45° 로 놓였으므로 OBB 근사의 경계는 판 중심선에서 최대 ~430mm 떨어져 있음. 정밀 판정이면 훨씬 가까이 가서야 간섭
check(firstHit !== null && firstHit < 300, `45° 얇은 판: 판 중심이 TCP 에서 ${firstHit}mm 일 때 처음 간섭 (OBB 근사였다면 ~${Math.round(600 * Math.SQRT1_2 + 5)}mm)`);
ctrl.resetAlarms?.();

console.log('[지지면]');
ctrl.cell.handle({ op: 'update', id: 'M1', patch: { asset: meta.id, bbox: meta.bbox, offset: [-500, -300, 0], rz: 0, x: 0, y: -R * 0.9, z: 0, collide: false } });
check(Math.abs(ctrl.cell.supportAt(0, -R * 0.9, Infinity) - 800) < 1e-6, `장비 윗면 지지 z=${ctrl.cell.supportAt(0, -R * 0.9, Infinity)}`);
const o = ctrl.objects[0];
o.pose.p = [0, -R * 0.9, 1500];
ctrl.dropObject(o);
check(Math.abs(o.pose.p[2] - (800 + o.size[2] / 2)) < 1e-6, `공작물 낙하 → 장비 윗면에 안착 (z=${o.pose.p[2]})`);
ctrl.cell.handle({ op: 'update', id: 'M1', patch: { support: false } });
check(ctrl.cell.supportAt(0, -R * 0.9, Infinity) === -Infinity, 'support=false → 지지면 아님');

console.log('[위쪽 축·단위 변경]');
const r1 = ctrl.cell.handle({ op: 'update', id: 'M1', patch: { up: 'y' } }).layout.models[0];
const exp = modelBaseOffset(meta.bbox, 'y', 1).offset;
// Y 위 보정 Rx(90°): 파일 (x, y, z) → (x, -z, y). bbox x 0..1000, y 0..600, z 0..800 → x 0..1000, y -800..0, z 0..600
check(r1.offset.join() === exp.join() && exp.join() === '-500,400,0', `up=y → offset 재계산 ${r1.offset}`);
check(Math.abs(ctrl.cell.supportAt(0, -R * 0.9, Infinity, false)) === Infinity, '(support=false 유지)');
const r2 = ctrl.cell.handle({ op: 'update', id: 'M1', patch: { unit: 1000 } }).layout.models[0];
check(r2.offset.join() === '-500000,400000,0', `unit=1000 → offset ×1000 (${r2.offset})`);

console.log('[파일 없음 · 검증]');
let bad = false;
try { normalizeLayout({ tables: [{ x: 1, w: 1, d: 1 }], models: [{ asset: '../x' }] }); } catch { bad = true; }
check(bad, '잘못된 asset id 레이아웃 거부');
const L = ctrl.cell.getLayout();
L.models.push({ ...L.models[0], id: 'M9', asset: 'ffffffffffffffff' });
logs.length = 0;
ctrl.cell.setLayout(L);
check(logs.some((s) => s.includes('3D 모델 파일 없음')) && !ctrl.cell.obstacles().some((x) => x.id === 'M9'), '파일 없는 모델 → 경고, 간섭 제외 (표시만)');

console.log('[프로젝트 왕복]');
const ps = new ProjectStore(ctrl, path.join(tmp, 'projects'));
ps.save('withmodel');
ctrl.cell.applyPreset('default');
check(ctrl.cell.getLayout().models.length === 0, '프리셋 적용 → 모델 없음');
ps.load('withmodel');
const back = ctrl.cell.getLayout().models;
check(back.length === 2 && back[0].asset === meta.id && back[0].up === 'y' && back[0].unit === 1000, '프로젝트 불러오기 → 모델 복원');

console.log('[모델 묶음 내보내기/가져오기]');
{
  // 파일이 있는 모델만, 간섭 켠 상태로 (앞 단계의 M9 는 일부러 파일 없는 모델)
  const L2 = ctrl.cell.getLayout();
  L2.models = L2.models.filter((m) => ctrl.assets.has(m.asset)).map((m) => ({ ...m, collide: true }));
  ctrl.cell.setLayout(L2);
  const kept = ctrl.cell.getLayout().models;
  const bundle = JSON.parse(JSON.stringify(ps.serialize('bundled', { bundle: true })));
  const ids = [...new Set(kept.map((m) => m.asset))];
  check(ids.length > 0 && ids.every((id) => typeof bundle.assets?.[id]?.glb === 'string' && bundle.assets[id].col), '묶음 내보내기 → 참조 모델 파일 포함');
  check(!ps.serialize('plain').assets, '일반 저장은 모델 id 만 (파일 미포함)');
  // 다른 PC 흉내: 빈 자산 저장소의 새 컨트롤러로 가져오기
  const c2 = new Controller(); clearInterval(c2._timer);
  const logs2 = []; c2.on('log', (e) => logs2.push(e.msg));
  c2.assets = new AssetStore(path.join(tmp, 'assets2'), (s, m) => c2.log(s, m));
  const ps2 = new ProjectStore(c2, path.join(tmp, 'projects2'));
  ps2.apply(bundle);
  check(ids.every((id) => c2.assets.has(id) && c2.assets.collider(id)), '가져오기 → 모델 파일·간섭 메시 복원');
  check(c2.cell.getLayout().models.length === kept.length && !logs2.some((s) => s.includes('3D 모델 파일 없음')), '가져오기 → 레이아웃 모델 그대로, 파일 없음 경고 없음');
  check(c2.cell.obstacles().some((x) => x.id === kept[0].id), '가져온 모델이 간섭 장애물로 동작');
  // 손상된 묶음 → 거부, 기존 상태 유지
  const c3 = new Controller(); clearInterval(c3._timer);
  c3.assets = new AssetStore(path.join(tmp, 'assets3'));
  const ps3 = new ProjectStore(c3, path.join(tmp, 'projects3'));
  const bad = JSON.parse(JSON.stringify(bundle));
  const id0 = ids[0];
  bad.assets[id0].col = Buffer.from(Buffer.from(bad.assets[id0].col, 'base64').map((x, i) => (i === 40 ? x ^ 1 : x))).toString('base64');
  const robotBefore = c3.robot.id;
  let err = null; try { ps3.apply(bad); } catch (e) { err = e; }
  check(err && /손상/.test(err.message) && !c3.assets.has(id0) && c3.robot.id === robotBefore, '손상된 묶음 모델 → 거부, 프로젝트 적용 안 함');
  clearInterval(c2._timer); clearInterval(c3._timer);
}

console.log('[업로드 상한]');
{
  const n = 200001, pos = new Float32Array(n * 9), idx = new Uint32Array(n * 3);
  for (let i = 0; i < n; i++) { pos.set([i, 0, 0, i + 1, 0, 0, i, 1, 0], i * 9); idx.set([i * 3, i * 3 + 1, i * 3 + 2], i * 3); }
  let err = null; try { ctrl.assets.save(uploadBody('huge', 'stl', { positions: pos, indices: idx })); } catch (e) { err = e; }
  check(err && /너무 많/.test(err.message), '간섭 메시 20만 삼각형 초과 → 거부');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails}건 실패` : '\n모두 통과');
process.exit(fails ? 1 : 0);
