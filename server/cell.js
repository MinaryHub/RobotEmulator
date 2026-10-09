// 셀 레이아웃 + 주변기기 시뮬레이션 (컨베이어 / 피더 / 센서 / 실린더 / 배출구 / 팔레트)
//
// 컨트롤러(ctrl)에 붙어 동작한다: ctrl.cell = new Cell(ctrl)
//  - ctrl.resetScene()  → cell.resetScene()  : 레이아웃으로 씬(ctrl.scene)·공작물(ctrl.objects) 재구성
//  - ctrl.tick()        → cell.tick(dt)      : 주변기기 시뮬레이션 (실시간 dt, HOLD 와 무관하게 계속 동작)
//  - ctrl.snapshot()    → cell.snapshot()    : { rev, layout, status, presets }
//  - ctrl.checkCollisionNow() → cell.obstacles() 를 checkCollision(opts.obstacles) 로 전달
//  - ctrl.dropObject()  → cell.supportAt(x, y, z) : 추가 테이블·컨베이어·장애물 윗면 지지
//
// ★ 영속화(프로젝트 저장/불러오기) API
//    ctrl.cell.getLayout()      → JSON 직렬화 가능한 레이아웃 객체 (깊은 복사)
//    ctrl.cell.setLayout(obj)   → 검증 후 적용 (오류 시 Error throw, 일부 값은 기본값으로 보정)
//    ctrl.cell.toJSON()         → getLayout() 과 동일 (JSON.stringify(ctrl.cell) 가능)
//    레이아웃의 preset 필드가 프리셋 id 이면 로봇 변경 시 해당 프리셋을 새 로봇 도달거리로 재생성하고,
//    null 이면(사용자 정의) 절대 좌표를 그대로 유지한다.
//
// 레이아웃 스키마 (단위 mm, 각도 deg, 좌표 = 로봇 베이스 기준, z 위쪽)
// {
//   version: 1, name: '표시 이름', preset: 'default' | 'conveyor' | null,
//   tables:     [{ id, name, x, y, z(상판 윗면), w(X 폭), d(Y 깊이) }]            // 1개 이상. tables[0] = ctrl.scene.table
//   workpieces: [{ id, x, y, z(바닥면), size:[sx,sy,sz], color, yaw? }]            // 초기 공작물 (리셋 시 이 위치로)
//   obstacles:  [{ id, name, x, y, z(바닥면), w, d, h, color, yaw?, collide? }]     // 고정구/장애물 박스 (간섭 체크)
//   devices: [
//     { type:'conveyor', id, name, x0, y0, x1, y1, z(벨트 윗면), width, speed(mm/s), runDO(0=항상 운전),
//       reverseDO(0=없음), stopper(true=끝단 스토퍼), color }
//     { type:'feeder', id, name, x, y, z(배출면), size:[sx,sy,sz], color, yaw?, mode:'auto'|'edge',
//       triggerDO(edge 모드 상승 에지), interval(s, auto 모드 최소 간격), max(0=무제한), prefix }
//     { type:'sensor', id, name, x, y, z(중심), w, d, h, yaw?, di, invert }           // 영역 안 공작물 → DI ON
//     { type:'cylinder', id, name, x, y, z(축 높이), yaw(전진 방향), length, bore, stroke, time(s),
//       extendDO, extDI(0=없음), retDI(0=없음) }
//     { type:'sink', id, name, x, y, z(바닥면), w, d, h, pulseDI(0=없음) }            // 영역에 놓인 공작물 제거·계수
//     { type:'pallet', id, name, x, y, z, rows, cols, pitchX, pitchY }                // 표시 전용 적재 격자 (슬롯 좌표 제공)
//   ]
// }
// 기본 신호 규약(프리셋): DO9 = 컨베이어 운전, DO10 = 피더 배출 요청(edge 모드), DI9 = 스토퍼 도착 센서
//   (그리퍼 DO1/DO2, DI1..3 과 겹치지 않도록 9번부터 사용)

import { Rz, DEG, mulv, T3, sub } from '../shared/math.js';
import { TABLE_THICKNESS } from '../shared/collision.js';

const COLORS = [0x3fa34d, 0xd9822b, 0x2f7ed8, 0xc03a3a];
const DEVICE_TYPES = ['conveyor', 'feeder', 'sensor', 'cylinder', 'sink', 'pallet'];

export const PRESETS = [
  { id: 'default', name: '기본 (테이블 + 공작물 4개)' },
  { id: 'conveyor', name: '컨베이어 픽 앤 플레이스' },
];

// ------------------------------------------------------------------ 프리셋
// 공작물 크기: 기존 resetScene 공식과 동일
export const partSize = (R) => Math.round(Math.max(30, Math.min(160, R * 0.045)) / 5) * 5;

export function presetLayout(id, robot) {
  const R = robot.reach;
  const s = partSize(R);
  if (id === 'default') {
    return {
      version: 1, name: PRESETS[0].name, preset: 'default',
      tables: [{ id: 'T1', name: '작업 테이블', x: R * 0.6, y: 0, z: 0, w: R * 0.55, d: R * 1.1 }],
      workpieces: [-0.3, -0.1, 0.1, 0.3].map((f, i) => ({ id: `W${i + 1}`, x: R * 0.55, y: R * f, z: 0, size: [s, s, s], color: COLORS[i] })),
      obstacles: [],
      devices: [],
    };
  }
  if (id === 'conveyor') {
    const g = conveyorGeometry(R);
    return {
      version: 1, name: PRESETS[1].name, preset: 'conveyor',
      tables: [{ id: 'T1', name: '적재 테이블', x: R * 0.6, y: R * 0.12, z: 0, w: R * 0.45, d: R * 0.6 }],
      workpieces: [{ id: 'W1', x: g.pick[0], y: g.pick[1], z: 0, size: [s, s, s], color: COLORS[0] }],
      obstacles: [],
      devices: [
        { type: 'conveyor', id: 'CV1', name: '공급 컨베이어', x0: g.x, y0: g.yStart, x1: g.x, y1: g.yEnd, z: 0, width: g.width, speed: g.speed, runDO: 9, reverseDO: 0, stopper: true, color: 0x2b2f35 },
        { type: 'feeder', id: 'F1', name: '부품 피더', x: g.x, y: g.yStart + s * 0.75, z: 0, size: [s, s, s], color: COLORS[1], yaw: 0, mode: 'auto', triggerDO: 10, interval: 2, max: 12, prefix: 'P' },
        { type: 'sensor', id: 'S1', name: '스토퍼 도착 센서', x: g.pick[0], y: g.pick[1], z: s * 0.4, w: g.width, d: s * 0.5, h: s * 0.8, yaw: 0, di: 9, invert: false },
        { type: 'pallet', id: 'PL1', name: '적재 위치 (2×3)', x: R * 0.5, y: 0, z: 0, rows: 3, cols: 2, pitchX: R * 0.15, pitchY: R * 0.15 },
      ],
    };
  }
  throw new Error(`알 수 없는 프리셋: ${id}`);
}

// 컨베이어 프리셋 기하 (테스트·예제 생성에서도 사용)
export function conveyorGeometry(R) {
  const s = partSize(R);
  const x = R * 0.5, yStart = -R * 1.2, yEnd = -R * 0.42;
  return {
    s, x, yStart, yEnd,
    width: Math.max(100, Math.round(s * 2.5)),
    speed: Math.round(Math.max(100, R * 0.25) / 10) * 10,
    pick: [x, yEnd - s / 2, s / 2],          // 스토퍼에 닿은 공작물 중심 (z = 벨트 윗면 0 + s/2)
  };
}

// 팔레트 슬롯 좌표 (행 우선: row 0 col 0, row 0 col 1, ...) — 공작물 바닥면 z
export function palletSlots(p) {
  const out = [];
  for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.cols; c++) out.push([p.x + c * p.pitchX, p.y + r * p.pitchY, p.z]);
  return out;
}

// ------------------------------------------------------------------ 검증/정규화
const num = (v, def, name, where) => {
  if (v === undefined || v === null || v === '') { if (def === undefined) throw new Error(`${where}: ${name} 값이 필요합니다`); return def; }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${where}: ${name} 값이 숫자가 아닙니다 (${v})`);
  return n;
};
const pos = (v, def, name, where) => { const n = num(v, def, name, where); if (n <= 0) throw new Error(`${where}: ${name} 는 0보다 커야 합니다`); return n; };
const sig = (v, where, name) => { const n = Math.round(num(v, 0, name, where)); if (n < 0 || n > 512) throw new Error(`${where}: ${name} 신호 번호 범위(0~512) 초과`); return n; };
const color = (v, def) => { const n = typeof v === 'string' ? parseInt(v.replace('#', ''), 16) : Number(v); return Number.isFinite(n) ? n & 0xffffff : def; };
const size3 = (v, where) => {
  if (!Array.isArray(v) || v.length !== 3) throw new Error(`${where}: size 는 [sx,sy,sz] 배열이어야 합니다`);
  return v.map((x, i) => pos(x, undefined, 'size' + i, where));
};

export function normalizeLayout(src) {
  if (!src || typeof src !== 'object') throw new Error('레이아웃이 객체가 아닙니다');
  const ids = new Set();
  const uid = (id, def, where) => {
    const s = String(id ?? def ?? '').trim();
    if (!s) throw new Error(`${where}: id 가 필요합니다`);
    if (ids.has(s)) throw new Error(`id 중복: ${s}`);
    ids.add(s);
    return s;
  };
  const L = {
    version: 1,
    name: String(src.name ?? '사용자 레이아웃'),
    preset: PRESETS.some((p) => p.id === src.preset) ? src.preset : null,
    tables: [], workpieces: [], obstacles: [], devices: [],
  };
  const tables = Array.isArray(src.tables) ? src.tables : src.table ? [src.table] : [];
  if (!tables.length) throw new Error('테이블은 최소 1개 필요합니다');
  tables.forEach((t, i) => {
    const w = `테이블 ${t.id ?? i + 1}`;
    L.tables.push({ id: uid(t.id, `T${i + 1}`, w), name: String(t.name ?? `테이블 ${i + 1}`), x: num(t.x, undefined, 'x', w), y: num(t.y, 0, 'y', w), z: num(t.z, 0, 'z', w), w: pos(t.w, undefined, 'w', w), d: pos(t.d, undefined, 'd', w) });
  });
  (src.workpieces || []).forEach((o, i) => {
    const w = `공작물 ${o.id ?? i + 1}`;
    const q = { id: uid(o.id, `W${i + 1}`, w), x: num(o.x, undefined, 'x', w), y: num(o.y, undefined, 'y', w), z: o.z === undefined || o.z === null ? null : num(o.z, 0, 'z', w), size: size3(o.size, w), color: color(o.color, COLORS[i % 4]) };
    if (o.yaw) q.yaw = num(o.yaw, 0, 'yaw', w);
    L.workpieces.push(q);
  });
  (src.obstacles || []).forEach((o, i) => {
    const w = `장애물 ${o.id ?? i + 1}`;
    const q = { id: uid(o.id, `OB${i + 1}`, w), name: String(o.name ?? `장애물 ${i + 1}`), x: num(o.x, undefined, 'x', w), y: num(o.y, undefined, 'y', w), z: num(o.z, 0, 'z', w), w: pos(o.w, undefined, 'w', w), d: pos(o.d, undefined, 'd', w), h: pos(o.h, undefined, 'h', w), color: color(o.color, 0x7a828c), yaw: num(o.yaw, 0, 'yaw', w), collide: o.collide !== false };
    L.obstacles.push(q);
  });
  (src.devices || []).forEach((d, i) => {
    const t = d.type;
    if (!DEVICE_TYPES.includes(t)) throw new Error(`장치 ${d.id ?? i + 1}: 알 수 없는 종류 ${t}`);
    const w = `${t} ${d.id ?? i + 1}`;
    const base = { type: t, id: uid(d.id, `${t.slice(0, 2).toUpperCase()}${i + 1}`, w), name: String(d.name ?? t) };
    let q;
    switch (t) {
      case 'conveyor': {
        q = { ...base, x0: num(d.x0, undefined, 'x0', w), y0: num(d.y0, undefined, 'y0', w), x1: num(d.x1, undefined, 'x1', w), y1: num(d.y1, undefined, 'y1', w), z: num(d.z, 0, 'z', w), width: pos(d.width, 100, 'width', w), speed: num(d.speed, 150, 'speed', w), runDO: sig(d.runDO, w, 'runDO'), reverseDO: sig(d.reverseDO, w, 'reverseDO'), stopper: d.stopper !== false, color: color(d.color, 0x2b2f35) };
        if (Math.hypot(q.x1 - q.x0, q.y1 - q.y0) < 10) throw new Error(`${w}: 컨베이어 길이가 너무 짧습니다`);
        break;
      }
      case 'feeder':
        q = { ...base, x: num(d.x, undefined, 'x', w), y: num(d.y, undefined, 'y', w), z: num(d.z, 0, 'z', w), size: size3(d.size ?? [40, 40, 40], w), color: color(d.color, COLORS[1]), yaw: num(d.yaw, 0, 'yaw', w), mode: d.mode === 'edge' ? 'edge' : 'auto', triggerDO: sig(d.triggerDO, w, 'triggerDO'), interval: Math.max(0, num(d.interval, 2, 'interval', w)), max: Math.max(0, Math.round(num(d.max, 0, 'max', w))), prefix: String(d.prefix ?? 'P').replace(/[^\w-]/g, '') || 'P' };
        break;
      case 'sensor':
        q = { ...base, x: num(d.x, undefined, 'x', w), y: num(d.y, undefined, 'y', w), z: num(d.z, 0, 'z', w), w: pos(d.w, 50, 'w', w), d: pos(d.d, 50, 'd', w), h: pos(d.h, 50, 'h', w), yaw: num(d.yaw, 0, 'yaw', w), di: sig(d.di, w, 'di'), invert: !!d.invert };
        break;
      case 'cylinder':
        q = { ...base, x: num(d.x, undefined, 'x', w), y: num(d.y, undefined, 'y', w), z: num(d.z, 50, 'z', w), yaw: num(d.yaw, 0, 'yaw', w), length: pos(d.length, 150, 'length', w), bore: pos(d.bore, 40, 'bore', w), stroke: pos(d.stroke, 100, 'stroke', w), time: Math.max(0.01, num(d.time, 0.5, 'time', w)), extendDO: sig(d.extendDO, w, 'extendDO'), extDI: sig(d.extDI, w, 'extDI'), retDI: sig(d.retDI, w, 'retDI') };
        break;
      case 'sink':
        q = { ...base, x: num(d.x, undefined, 'x', w), y: num(d.y, undefined, 'y', w), z: num(d.z, 0, 'z', w), w: pos(d.w, 200, 'w', w), d: pos(d.d, 200, 'd', w), h: pos(d.h, 100, 'h', w), pulseDI: sig(d.pulseDI, w, 'pulseDI') };
        break;
      case 'pallet':
        q = { ...base, x: num(d.x, undefined, 'x', w), y: num(d.y, undefined, 'y', w), z: num(d.z, 0, 'z', w), rows: Math.max(1, Math.round(num(d.rows, 2, 'rows', w))), cols: Math.max(1, Math.round(num(d.cols, 2, 'cols', w))), pitchX: num(d.pitchX, 100, 'pitchX', w), pitchY: num(d.pitchY, 100, 'pitchY', w) };
        break;
    }
    L.devices.push(q);
  });
  return L;
}

const clone = (o) => JSON.parse(JSON.stringify(o));
// 박스 로컬 좌표 (yaw 회전만)
const toLocalYaw = (p, c, yawDeg) => {
  const a = -yawDeg * DEG, cs = Math.cos(a), sn = Math.sin(a);
  const x = p[0] - c[0], y = p[1] - c[1];
  return [x * cs - y * sn, x * sn + y * cs, p[2] - c[2]];
};
const objYaw = (o) => Math.atan2(o.pose.R[1][0], o.pose.R[0][0]);
// 물체의 (yaw 기준 프레임에서의) XY 반폭
const halfExt = (o, frameYawRad) => {
  const d = objYaw(o) - frameYawRad, c = Math.abs(Math.cos(d)), s = Math.abs(Math.sin(d));
  return [c * o.size[0] / 2 + s * o.size[1] / 2, s * o.size[0] / 2 + c * o.size[1] / 2, o.size[2] / 2];
};

// ------------------------------------------------------------------ Cell
export class Cell {
  constructor(ctrl) {
    this.ctrl = ctrl;
    this.layout = null;     // 정규화된 레이아웃
    this.rev = 0;           // 레이아웃 변경 카운터 (UI 재구성 판단)
    this.rt = {};           // 장치별 런타임 상태
    this._static = [];      // 정적 간섭 박스 캐시
    this._diLast = {};      // DI 번호 → 마지막으로 쓴 값 (변화 시에만 기록)
  }

  toJSON() { return this.getLayout(); }
  getLayout() { return this.layout ? clone(this.layout) : null; }
  get presets() { return PRESETS; }

  // 레이아웃 적용 (검증). 공작물·장치 상태는 초기화된다
  setLayout(obj, { quiet = false } = {}) {
    const L = normalizeLayout(clone(obj));
    this._apply(L);
    if (!quiet) this.ctrl.log('system', `셀 레이아웃 적용: ${L.name}${L.preset ? '' : ' (사용자 정의)'}`);
    return this.getLayout();
  }

  applyPreset(id) {
    const L = presetLayout(id, this.ctrl.robot);
    this._apply(normalizeLayout(L));
    this.ctrl.log('system', `셀 프리셋: ${L.name}`);
    return this.getLayout();
  }

  _apply(L) {
    const changed = JSON.stringify(L) !== JSON.stringify(this.layout);
    this._releaseSignals();
    this.layout = L;
    if (changed) this.rev++;
    this._buildScene();
    this.resetObjects();
  }

  // ctrl.resetScene() 에서 호출: 프리셋 레이아웃이면 현재 로봇에 맞게 재생성
  resetScene() {
    if (!this.layout || this.layout.preset) {
      const L = normalizeLayout(presetLayout(this.layout?.preset || 'default', this.ctrl.robot));
      if (JSON.stringify(L) !== JSON.stringify(this.layout)) { this._releaseSignals(); this.layout = L; this.rev++; }
    }
    this._buildScene();
    this.resetObjects();
  }

  _buildScene() {
    const c = this.ctrl, R = c.robot.reach;
    const floorZ = -Math.round(R * 0.45 / 50) * 50;
    const t = this.layout.tables[0];
    c.scene = { floorZ, table: { x: t.x, y: t.y, z: t.z, w: t.w, d: t.d }, pedestal: { d: Math.max(200, R * 0.3), h: -floorZ } };
    this._static = this._staticObstacles();
  }

  // 공작물 초기 배치 + 장치 런타임 상태 초기화
  resetObjects() {
    const c = this.ctrl;
    if (c.grip) c.grip.holding = null;
    c.objects = this.layout.workpieces.map((w) => {
      const z = w.z ?? this.supportAt(w.x, w.y, Infinity, true);
      return { id: w.id, size: [...w.size], color: w.color, pose: { p: [w.x, w.y, z + w.size[2] / 2], R: Rz((w.yaw || 0) * DEG) } };
    });
    this.rt = {};
    for (const d of this.layout.devices) {
      const r = { type: d.type };
      if (d.type === 'conveyor') Object.assign(r, { running: false, dir: 1 });
      if (d.type === 'feeder') Object.assign(r, { count: 0, last: -Infinity, prevDO: c.getDO(d.triggerDO || 0), blocked: false });
      if (d.type === 'sensor') r.on = false;
      if (d.type === 'cylinder') Object.assign(r, { pos: 0, extended: false, retracted: true });
      if (d.type === 'sink') Object.assign(r, { count: 0, pulse: 0 });
      this.rt[d.id] = r;
    }
    this._t = 0;
    this._diLast = {};
    c.emitState();
  }

  // 장치가 구동하던 DI 를 OFF (레이아웃 교체 시)
  _releaseSignals() {
    const c = this.ctrl;
    for (const [n, v] of Object.entries(this._diLast)) if (v) c.setDI(Number(n), false);
    this._diLast = {};
  }
  _writeDI(n, v) {
    if (!n) return;
    if (this._diLast[n] === v) return;
    this._diLast[n] = v;
    this.ctrl.setDI(n, v);
  }

  // ---------------------------------------------------------------- 지지면 / 간섭 박스
  // (x,y) 위치에서 높이 zMax 이하에 있는 가장 높은 지지면 (추가 테이블·컨베이어·장애물). 없으면 -Infinity
  // includeMain: tables[0] 포함 여부 (dropObject 는 메인 테이블을 자체 처리)
  supportAt(x, y, zMax = Infinity, includeMain = false) {
    let best = -Infinity;
    const L = this.layout;
    if (!L) return best;
    const take = (z) => { if (z <= zMax + 1 && z > best) best = z; };
    L.tables.forEach((t, i) => { if ((i > 0 || includeMain) && Math.abs(x - t.x) <= t.w / 2 && Math.abs(y - t.y) <= t.d / 2) take(t.z); });
    for (const o of L.obstacles) {
      const l = toLocalYaw([x, y, 0], [o.x, o.y, 0], o.yaw || 0);
      if (Math.abs(l[0]) <= o.w / 2 && Math.abs(l[1]) <= o.d / 2) take(o.z + o.h);
    }
    for (const d of L.devices) {
      if (d.type !== 'conveyor') continue;
      const g = this._conv(d);
      const a = (x - d.x0) * g.u[0] + (y - d.y0) * g.u[1], b = (x - d.x0) * g.n[0] + (y - d.y0) * g.n[1];
      if (a >= 0 && a <= g.L && Math.abs(b) <= d.width / 2) take(d.z);
    }
    if (best === -Infinity && includeMain) best = this.ctrl.scene?.floorZ ?? 0;
    return best;
  }

  _conv(d) {
    const dx = d.x1 - d.x0, dy = d.y1 - d.y0, L = Math.hypot(dx, dy);
    const u = [dx / L, dy / L], n = [-u[1], u[0]];
    return { L, u, n, yaw: Math.atan2(u[1], u[0]) };
  }

  _staticObstacles() {
    const out = [];
    const L = this.layout, floorZ = this.ctrl.scene.floorZ;
    L.tables.forEach((t, i) => { if (i > 0) out.push({ id: t.id, c: [t.x, t.y, t.z - TABLE_THICKNESS / 2], h: [t.w / 2, t.d / 2, TABLE_THICKNESS / 2] }); });
    for (const o of L.obstacles) if (o.collide !== false) out.push({ id: o.id, c: [o.x, o.y, o.z + o.h / 2], h: [o.w / 2, o.d / 2, o.h / 2], R: o.yaw ? Rz(o.yaw * DEG) : null });
    for (const d of L.devices) {
      if (d.type === 'conveyor') {
        const g = this._conv(d);
        const bot = Math.min(floorZ, d.z - 10);
        out.push({ id: d.id, c: [(d.x0 + d.x1) / 2, (d.y0 + d.y1) / 2, (d.z + bot) / 2], h: [g.L / 2, d.width / 2, (d.z - bot) / 2], R: Rz(g.yaw) });
      } else if (d.type === 'feeder') {
        // 호퍼: 배출 위치 위 (공작물 1개 높이 띄움)
        const s = d.size, zb = d.z + s[2] * 1.6, hh = s[2] * 1.4;
        out.push({ id: d.id, c: [d.x, d.y, zb + hh / 2], h: [s[0] * 0.8, s[1] * 0.8, hh / 2], R: d.yaw ? Rz(d.yaw * DEG) : null });
      } else if (d.type === 'cylinder') {
        const yaw = d.yaw * DEG, u = [Math.cos(yaw), Math.sin(yaw)];
        out.push({ id: d.id, c: [d.x + u[0] * d.length / 2, d.y + u[1] * d.length / 2, d.z], h: [d.length / 2, d.bore / 2, d.bore / 2], R: Rz(yaw) });
      }
    }
    return out;
  }

  // 간섭 체크용 박스 목록 (정적 + 실린더 로드 현재 위치)
  obstacles() {
    if (!this.layout) return [];
    const dyn = [];
    for (const d of this.layout.devices) {
      if (d.type !== 'cylinder') continue;
      const ext = (this.rt[d.id]?.pos || 0) * d.stroke + d.bore * 0.3;
      const yaw = d.yaw * DEG, u = [Math.cos(yaw), Math.sin(yaw)];
      const a = d.length, mid = a + ext / 2;
      dyn.push({ id: d.id + '.rod', c: [d.x + u[0] * mid, d.y + u[1] * mid, d.z], h: [ext / 2, d.bore * 0.6, d.bore * 0.6], R: Rz(yaw) });
    }
    return dyn.length ? this._static.concat(dyn) : this._static;
  }

  // ---------------------------------------------------------------- 시뮬레이션 (매 틱)
  // 반환: 공작물/장치 상태가 바뀌었으면 true
  tick(dt) {
    if (!this.layout || !dt) return false;
    const c = this.ctrl;
    this._t += dt;
    let changed = false;
    const held = c.grip?.holding ?? null;
    for (const d of this.layout.devices) {
      const r = this.rt[d.id];
      if (!r) continue;
      switch (d.type) {
        case 'conveyor': changed = this._tickConveyor(d, r, dt, held) || changed; break;
        case 'feeder': changed = this._tickFeeder(d, r) || changed; break;
        case 'cylinder': {
          const target = d.extendDO && c.getDO(d.extendDO) ? 1 : 0;
          if (r.pos !== target) {
            r.pos += Math.sign(target - r.pos) * Math.min(Math.abs(target - r.pos), dt / d.time);
            changed = true;
          }
          r.extended = r.pos >= 0.999; r.retracted = r.pos <= 0.001;
          this._writeDI(d.extDI, r.extended);
          this._writeDI(d.retDI, r.retracted);
          break;
        }
        case 'sink': {
          for (let i = c.objects.length - 1; i >= 0; i--) {
            const o = c.objects[i];
            if (o === held) continue;
            const p = o.pose.p;
            if (Math.abs(p[0] - d.x) <= d.w / 2 && Math.abs(p[1] - d.y) <= d.d / 2 && p[2] <= d.z + d.h) {
              c.objects.splice(i, 1);
              r.count++;
              r.pulse = 0.3;
              c.log('system', `[${d.name}] 공작물 ${o.id} 배출 (누계 ${r.count})`);
              changed = true;
            }
          }
          if (r.pulse > 0) r.pulse = Math.max(0, r.pulse - dt);
          this._writeDI(d.pulseDI, r.pulse > 0);
          break;
        }
      }
    }
    // 센서는 공작물 이동 후 평가
    for (const d of this.layout.devices) {
      if (d.type !== 'sensor') continue;
      const r = this.rt[d.id];
      let hit = false;
      for (const o of c.objects) {
        const l = toLocalYaw(o.pose.p, [d.x, d.y, d.z], d.yaw || 0);
        const e = halfExt(o, (d.yaw || 0) * DEG);
        if (Math.abs(l[0]) < d.w / 2 + e[0] && Math.abs(l[1]) < d.d / 2 + e[1] && Math.abs(l[2]) < d.h / 2 + e[2]) { hit = true; break; }
      }
      if (r.on !== hit) { r.on = hit; changed = true; }
      this._writeDI(d.di, d.invert ? !hit : hit);
    }
    if (changed) c.emitState();
    return changed;
  }

  _tickConveyor(d, r, dt, held) {
    const c = this.ctrl;
    const running = !d.runDO || c.getDO(d.runDO);
    const dir = d.reverseDO && c.getDO(d.reverseDO) ? -1 : 1;
    let changed = running !== r.running || dir !== r.dir;
    r.running = running; r.dir = dir;
    if (!running || d.speed === 0) return changed;
    const g = this._conv(d);
    const v = d.speed * dir;                 // 음수 speed 도 허용 (역방향)
    const fwd = v > 0 ? 1 : -1;
    // 벨트 위 공작물 수집 (축 좌표 a, 축방향 반폭 e)
    const items = [];
    for (const o of c.objects) {
      const p = o.pose.p;
      const a = (p[0] - d.x0) * g.u[0] + (p[1] - d.y0) * g.u[1];
      const b = (p[0] - d.x0) * g.n[0] + (p[1] - d.y0) * g.n[1];
      if (a < -1 || a > g.L + 1 || Math.abs(b) > d.width / 2) continue;
      const bottom = p[2] - o.size[2] / 2;
      const e = halfExt(o, g.yaw)[0];
      if (o === held) {
        // 파지 중인 공작물: 벨트 높이 층에 걸쳐 있으면 뒤 공작물을 막는 정지 장애물
        if (bottom < d.z + o.size[2] && bottom > d.z - o.size[2]) items.push({ o, a, e, fixed: true });
        continue;
      }
      if (Math.abs(bottom - d.z) > 3) continue;
      items.push({ o, a, e, fixed: false });
    }
    if (!items.length) return changed;
    // 진행 방향 앞쪽부터 처리
    items.sort((p, q) => fwd * (q.a - p.a));
    // limit = 앞쪽 경계 (스토퍼 또는 앞 공작물의 뒷면). 공작물 중심은 limit ∓ 반폭 까지
    let limit = fwd > 0 ? (d.stopper ? g.L : Infinity) : (d.stopper ? 0 : -Infinity);
    for (const it of items) {
      let na;
      if (it.fixed) na = it.a;
      else if (fwd > 0) na = Math.max(it.a, Math.min(it.a + v * dt, limit - it.e));
      else na = Math.min(it.a, Math.max(it.a + v * dt, limit + it.e));
      if (na !== it.a) {
        const da = na - it.a;
        it.o.pose.p = [it.o.pose.p[0] + g.u[0] * da, it.o.pose.p[1] + g.u[1] * da, it.o.pose.p[2]];
        changed = true;
      }
      // 스토퍼 없이 끝을 넘으면 낙하
      if (!it.fixed && (na > g.L || na < 0)) { c.dropObject(it.o); changed = true; continue; }
      limit = fwd > 0 ? na - it.e - 0.5 : na + it.e + 0.5;
    }
    return changed;
  }

  _tickFeeder(d, r) {
    const c = this.ctrl;
    let want = false;
    if (d.mode === 'edge') {
      const now = d.triggerDO ? c.getDO(d.triggerDO) : false;
      if (now && !r.prevDO) want = true;
      r.prevDO = now;
    } else want = this._t - r.last >= d.interval;
    if (!want) return false;
    if (d.max && r.count >= d.max) { if (d.mode === 'edge') c.log('system', `[${d.name}] 최대 배출 수(${d.max}) 도달`); return false; }
    // 배출 위치가 비어 있어야 함
    const s = d.size, p = [d.x, d.y, d.z + s[2] / 2];
    const occupied = c.objects.some((o) => Math.abs(o.pose.p[0] - p[0]) < (o.size[0] + s[0]) / 2 + 2 && Math.abs(o.pose.p[1] - p[1]) < (o.size[1] + s[1]) / 2 + 2 && Math.abs(o.pose.p[2] - p[2]) < (o.size[2] + s[2]) / 2);
    if (occupied) {
      if (d.mode === 'edge') c.log('system', `[${d.name}] 배출 위치가 막혀 있어 배출하지 않음`);
      const was = r.blocked; r.blocked = true; return was !== true;
    }
    r.blocked = false;
    let k = r.count + 1, id;
    do { id = `${d.prefix}${k++}`; } while (c.objects.some((o) => o.id === id));
    c.objects.push({ id, size: [...s], color: d.color, pose: { p, R: Rz((d.yaw || 0) * DEG) } });
    r.count++;
    r.last = this._t;
    if (d.mode === 'edge') c.log('system', `[${d.name}] 공작물 ${id} 배출 (${r.count}${d.max ? '/' + d.max : ''})`);
    return true;
  }

  // ---------------------------------------------------------------- 상태/명령
  status() {
    const out = {};
    for (const d of this.layout?.devices || []) {
      const r = this.rt[d.id] || {};
      switch (d.type) {
        case 'conveyor': out[d.id] = { running: !!r.running, dir: r.dir ?? 1 }; break;
        case 'feeder': out[d.id] = { count: r.count ?? 0, blocked: !!r.blocked }; break;
        case 'sensor': out[d.id] = { on: !!r.on, di: d.invert ? !r.on : !!r.on }; break;
        case 'cylinder': out[d.id] = { pos: +(r.pos ?? 0).toFixed(3), extended: !!r.extended, retracted: !!r.retracted }; break;
        case 'sink': out[d.id] = { count: r.count ?? 0 }; break;
        case 'pallet': out[d.id] = { slots: palletSlots(d) }; break;
      }
    }
    return out;
  }

  snapshot() {
    return { rev: this.rev, layout: this.layout, status: this.status(), presets: PRESETS };
  }

  // 장치 추가 기본값 (현재 로봇 도달거리 기준 위치)
  newItem(kind) {
    const R = this.ctrl.robot.reach, s = partSize(R);
    const L = this.layout;
    const all = new Set([...L.tables, ...L.workpieces, ...L.obstacles, ...L.devices].map((x) => x.id));
    const id = (p) => { let i = 1; while (all.has(p + i)) i++; return p + i; };
    switch (kind) {
      case 'table': return { list: 'tables', item: { id: id('T'), name: '추가 테이블', x: R * 0.2, y: R * 0.7, z: 0, w: R * 0.4, d: R * 0.3 } };
      case 'workpiece': return { list: 'workpieces', item: { id: id('W'), x: R * 0.6, y: 0, z: 0, size: [s, s, s], color: COLORS[L.workpieces.length % 4] } };
      case 'obstacle': return { list: 'obstacles', item: { id: id('OB'), name: '장애물', x: R * 0.6, y: R * 0.5, z: 0, w: s * 2, d: s * 2, h: s * 3, color: 0x7a828c, yaw: 0, collide: true } };
      case 'conveyor': return { list: 'devices', item: { type: 'conveyor', id: id('CV'), name: '컨베이어', x0: R * 0.5, y0: -R * 1.2, x1: R * 0.5, y1: -R * 0.42, z: 0, width: Math.max(100, s * 2.5), speed: 150, runDO: 0, reverseDO: 0, stopper: true, color: 0x2b2f35 } };
      case 'feeder': return { list: 'devices', item: { type: 'feeder', id: id('F'), name: '피더', x: R * 0.5, y: -R * 1.2 + s, z: 0, size: [s, s, s], color: COLORS[1], yaw: 0, mode: 'edge', triggerDO: 10, interval: 2, max: 0, prefix: 'P' } };
      case 'sensor': return { list: 'devices', item: { type: 'sensor', id: id('S'), name: '센서', x: R * 0.5, y: -R * 0.42 - s / 2, z: s * 0.4, w: s * 2, d: s * 0.5, h: s * 0.8, yaw: 0, di: 9, invert: false } };
      case 'cylinder': return { list: 'devices', item: { type: 'cylinder', id: id('CY'), name: '실린더', x: R * 0.3, y: R * 0.65, z: s, yaw: 0, length: s * 3, bore: s * 0.8, stroke: s * 2, time: 0.5, extendDO: 11, extDI: 11, retDI: 12 } };
      case 'sink': return { list: 'devices', item: { type: 'sink', id: id('SK'), name: '배출구', x: R * 0.2, y: -R * 0.6, z: this.ctrl.scene.floorZ, w: s * 4, d: s * 4, h: -this.ctrl.scene.floorZ + 20, pulseDI: 0 } };
      case 'pallet': return { list: 'devices', item: { type: 'pallet', id: id('PL'), name: '팔레트', x: R * 0.5, y: 0, z: 0, rows: 2, cols: 2, pitchX: s * 2, pitchY: s * 2 } };
    }
    throw new Error(`알 수 없는 항목 종류: ${kind}`);
  }

  // WebSocket/REST 명령: { cmd:'cell', op, ... }
  handle(m) {
    switch (m.op) {
      case 'get': return { layout: this.getLayout(), presets: PRESETS };
      case 'set': return { layout: this.setLayout(m.layout) };
      case 'preset': return { layout: this.applyPreset(m.id) };
      case 'resetObjects': this.resetObjects(); return {};
      case 'add': {
        const L = this.getLayout();
        const { list, item } = this.newItem(m.kind);
        L[list].push(item);
        L.preset = null;
        return { layout: this.setLayout(L), itemId: item.id };
      }
      case 'remove': {
        const L = this.getLayout();
        for (const k of ['tables', 'workpieces', 'obstacles', 'devices']) L[k] = L[k].filter((x) => x.id !== m.id);
        L.preset = null;
        return { layout: this.setLayout(L) };
      }
      case 'update': {
        // 단일 항목 일부 필드 변경: { id, patch:{...} }
        const L = this.getLayout();
        let found = false;
        for (const k of ['tables', 'workpieces', 'obstacles', 'devices']) {
          const it = L[k].find((x) => x.id === m.id);
          if (it) { Object.assign(it, m.patch || {}); found = true; break; }
        }
        if (!found) throw new Error(`항목 없음: ${m.id}`);
        L.preset = null;
        return { layout: this.setLayout(L, { quiet: true }) };
      }
      default: throw new Error(`알 수 없는 셀 명령: ${m.op}`);
    }
  }
}
