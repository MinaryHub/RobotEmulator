// 셀 탭: 레이아웃 프리셋 / 장치 목록 편집 / 실시간 상태 / 레이아웃 JSON 내보내기·가져오기
// 서버 명령: { cmd:'cell', op:'get'|'set'|'preset'|'resetObjects'|'add'|'addModel'|'remove'|'update', ... } (server/cell.js)
// 3D 모델 가져오기: public/js/modelImport.js (변환·업로드) → op:'addModel'
import { importModelFile, MODEL_ACCEPT } from './modelImport.js';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

let ctx = null;          // { cmd, view, getState }
let root = null;
let builtKey = null;     // 목록을 마지막으로 그린 레이아웃 키
let force = false;

const KIND_NAME = { table: '테이블', workpiece: '공작물', obstacle: '장애물', conveyor: '컨베이어', feeder: '피더', sensor: '센서', cylinder: '실린더', sink: '배출구', pallet: '팔레트', model: '3D 모델' };
const UNITS = [[1, 'mm'], [10, 'cm'], [1000, 'm'], [25.4, 'inch']];
const UPS = [['z', 'Z 위 (CAD·STL)'], ['y', 'Y 위 (glTF·OBJ)'], ['x', 'X 위']];
const LBL = {
  name: '이름', x: 'X', y: 'Y', z: 'Z', w: '폭 W', d: '깊이 D', h: '높이 H', yaw: '회전°', size: '크기',
  x0: '시작 X', y0: '시작 Y', x1: '끝 X', y1: '끝 Y', width: '벨트 폭', speed: '속도 mm/s', runDO: '운전 DO (0=항상)', reverseDO: '역방향 DO', stopper: '끝 스토퍼',
  mode: '모드', triggerDO: '배출 DO', interval: '간격 s', max: '최대 (0=∞)', prefix: 'ID 접두어',
  di: 'DI', invert: '반전', length: '몸체 길이', bore: '보어', stroke: '행정', time: '행정 시간 s', extendDO: '전진 DO', extDI: '전진 확인 DI', retDI: '후진 확인 DI',
  pulseDI: '배출 펄스 DI', rows: '행', cols: '열', pitchX: '피치 X', pitchY: '피치 Y', color: '색', collide: '간섭 체크',
  rx: 'Rx°', ry: 'Ry°', rz: 'Rz°', scale: '배율', unit: '파일 단위', up: '위쪽 축', opacity: '불투명도', origColor: '원본 색', tool: '툴도 검사', support: '공작물 지지면',
};
const FIELDS = {
  table: ['name', 'x', 'y', 'z', 'w', 'd'],
  workpiece: ['x', 'y', 'z', 'size', 'color'],
  obstacle: ['name', 'x', 'y', 'z', 'w', 'd', 'h', 'yaw', 'color', 'opacity', 'collide'],
  conveyor: ['name', 'x0', 'y0', 'x1', 'y1', 'z', 'width', 'speed', 'runDO', 'reverseDO', 'stopper'],
  feeder: ['name', 'x', 'y', 'z', 'size', 'color', 'mode', 'triggerDO', 'interval', 'max', 'prefix'],
  sensor: ['name', 'x', 'y', 'z', 'w', 'd', 'h', 'yaw', 'di', 'invert'],
  cylinder: ['name', 'x', 'y', 'z', 'yaw', 'length', 'bore', 'stroke', 'time', 'extendDO', 'extDI', 'retDI'],
  sink: ['name', 'x', 'y', 'z', 'w', 'd', 'h', 'pulseDI'],
  pallet: ['name', 'x', 'y', 'z', 'rows', 'cols', 'pitchX', 'pitchY'],
  model: ['name', 'x', 'y', 'z', 'rx', 'ry', 'rz', 'scale', 'unit', 'up', 'opacity', 'color', 'origColor', 'collide', 'tool', 'support'],
};
const BOOL = new Set(['stopper', 'invert', 'collide', 'tool', 'support']);
const TEXT = new Set(['name', 'prefix']);

const STYLE = `
#tCell .cell-item { background: var(--panel2); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; margin-bottom: 6px; }
#tCell .cell-item .hd { display: flex; align-items: center; gap: 6px; }
#tCell .cell-item .hd .k { font-size: 11px; color: var(--dim); }
#tCell .cell-item .hd b { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#tCell .cell-item .hd button { padding: 1px 7px; font-size: 11px; }
#tCell .cell-item .st { font-family: var(--mono); font-size: 11px; color: var(--dim); margin-top: 2px; }
#tCell .cell-item .st .on { color: #2fe07a; font-weight: 600; }
#tCell .cell-item .st .run { color: #3d8bfd; font-weight: 600; }
#tCell .cell-item .grid3 { margin: 4px 0 0; }
#tCell .cell-item .grid3 input[type=checkbox] { width: auto; align-self: flex-start; }
#tCell .cell-item .grid3 input[type=color] { height: 26px; padding: 0 2px; background: var(--panel2); border: 1px solid var(--line); border-radius: 4px; }
#tCell .cell-item.collapsed .grid3 { display: none; }
#tCell .addbtns button { padding: 3px 8px; font-size: 12px; }
#tCell select.preset { flex: 1; min-width: 0; }
`;

export function initCellPanel(opts) {
  ctx = opts;
  root = document.getElementById('tCell');
  if (!root) return;
  if (!document.getElementById('cellPanelCss')) {
    const s = document.createElement('style'); s.id = 'cellPanelCss'; s.textContent = STYLE; document.head.append(s);
  }
  root.innerHTML = `
    <h3>셀 레이아웃 <small id="cellName"></small></h3>
    <div class="row btns">
      <select id="cellPreset" class="preset"></select>
      <button id="cellApply" class="primary" title="선택한 프리셋을 현재 로봇 크기에 맞춰 적용">적용</button>
    </div>
    <div class="row btns">
      <button id="cellReset" title="공작물을 초기 위치로, 피더/배출구 카운트 초기화">공작물·장치 초기화</button>
      <button id="cellExport">레이아웃 JSON 내보내기</button>
      <button id="cellImport">레이아웃 JSON 가져오기</button>
      <input type="file" id="cellFile" accept=".json,application/json" hidden>
    </div>
    <h3>항목 추가</h3>
    <div class="row btns addbtns">
      <button id="cellAddModel" class="primary" title="장비·지그·펜스 등 CAD 모델을 불러와 배치 (STL·OBJ·GLB·glTF·STEP·IGES). 간섭은 삼각형 단위로 검사">＋ 3D 모델 가져오기</button>
      <input type="file" id="cellModelFile" accept="${MODEL_ACCEPT}" hidden>
      <span id="cellModelStatus" class="note" style="margin:0"></span>
    </div>
    <div class="row btns addbtns">
      ${['obstacle', 'sensor', 'conveyor', 'feeder', 'cylinder', 'sink', 'pallet', 'table', 'workpiece'].map((k) => `<button data-add="${k}">＋ ${KIND_NAME[k]}</button>`).join('')}
    </div>
    <h3>장치 / 항목 <small>값 변경 시 즉시 적용 (사용자 정의 레이아웃)</small></h3>
    <div id="cellList"></div>
    <div class="note">좌표는 로봇 베이스 기준 mm (Z 위쪽). 프리셋은 로봇 도달거리에 맞춰 배치되며 로봇을 바꾸면 다시 계산됩니다. 값을 수정하면 사용자 정의 레이아웃(절대 좌표)이 됩니다.
    신호 규약(프리셋): DO9 컨베이어 운전, DO10 피더 배출(에지 모드), DI9 스토퍼 도착 센서. 장치 DI 는 Modbus 코일·OPC UA IO/DI 와 공유됩니다.</div>`;

  const cmd = (op, args = {}) => ctx.cmd('cell', { op, ...args }).catch(() => { force = true; const st = ctx.getState(); st && renderCellPanel(st); });
  $('#cellApply', root).onclick = () => cmd('preset', { id: $('#cellPreset', root).value });
  $('#cellReset', root).onclick = () => cmd('resetObjects');
  $('#cellExport', root).onclick = () => {
    const L = ctx.getState()?.cell?.layout;
    if (!L) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(L, null, 2)], { type: 'application/json' }));
    a.download = `cell-layout-${(L.preset || 'custom')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('#cellImport', root).onclick = () => $('#cellFile', root).click();
  $('#cellFile', root).onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      let L = JSON.parse(await f.text());
      if (L && L.layout && !L.tables) L = L.layout;          // { layout: {...} } 래퍼 허용
      if (L && L.cell && !L.tables) L = L.cell;
      await cmd('set', { layout: L });
    } catch (err) { alert(`레이아웃 파일 오류: ${err.message}`); }
  };
  $$('[data-add]', root).forEach((b) => (b.onclick = () => cmd('add', { kind: b.dataset.add })));
  $('#cellAddModel', root).onclick = () => $('#cellModelFile', root).click();
  $('#cellModelFile', root).onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const btn = $('#cellAddModel', root), stEl = $('#cellModelStatus', root);
    btn.disabled = true;
    const t0 = performance.now();
    try {
      const meta = await importModelFile(f, (s) => (stEl.textContent = `${f.name}: ${s}`));
      await ctx.cmd('cell', { op: 'addModel', asset: meta.id, name: f.name });
      const reduced = meta.srcTris && meta.srcTris > meta.tris ? ` (간섭용 ${meta.tris.toLocaleString()}개로 간소화)` : '';
      stEl.textContent = `✔ ${f.name}: ${(meta.srcTris ?? meta.tris).toLocaleString()} 삼각형${reduced} · ${((performance.now() - t0) / 1000).toFixed(1)}s`;
    } catch (err) {
      stEl.textContent = `✖ ${f.name}: ${err.message}`;
    } finally { btn.disabled = false; }
  };

  const list = $('#cellList', root);
  list.addEventListener('change', (e) => {
    const inp = e.target.closest('[data-f]');
    if (!inp) return;
    const item = inp.closest('[data-id]');
    const f = inp.dataset.f;
    let v;
    if (f === 'origColor') return void cmd('update', { id: item.dataset.id, patch: { color: inp.checked ? null : parseInt($('[data-f=color]', item).value.slice(1), 16) } });
    if (BOOL.has(f)) v = inp.checked;
    else if (f === 'color') v = parseInt(inp.value.slice(1), 16);
    else if (TEXT.has(f) || f === 'mode' || f === 'up') v = inp.value;
    else if (f === 'unit') v = Number(inp.value);
    else if (f.startsWith('size')) {
      v = [0, 1, 2].map((i) => Number($(`[data-f=size${i}]`, item).value));
      return void cmd('update', { id: item.dataset.id, patch: { size: v } });
    } else {
      if (inp.value.trim() === '' || !Number.isFinite(Number(inp.value))) { force = true; renderCellPanel(ctx.getState()); return; }
      v = Number(inp.value);
    }
    cmd('update', { id: item.dataset.id, patch: { [f]: v } });
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const item = b.closest('[data-id]');
    if (b.dataset.act === 'del') { if (confirm(`${item.dataset.id} 항목을 삭제할까요?`)) cmd('remove', { id: item.dataset.id }); }
    if (b.dataset.act === 'fold') { item.classList.toggle('collapsed'); b.textContent = item.classList.contains('collapsed') ? '▸' : '▾'; }
  });
  // 편집 중에는 목록을 다시 그리지 않음 → 포커스가 빠지면 반영
  list.addEventListener('focusout', () => setTimeout(() => { const st = ctx.getState(); st && renderCellPanel(st); }, 0));
}

const r1 = (v) => (Math.round(v * 10) / 10).toString();
const hex = (c) => '#' + (Number(c) & 0xffffff).toString(16).padStart(6, '0');

function fieldHtml(it, f) {
  const lb = LBL[f] ?? f;
  if (BOOL.has(f)) return `<label>${lb}<input type="checkbox" data-f="${f}" ${it[f] !== false && it[f] ? 'checked' : ''}></label>`;
  if (f === 'origColor') return `<label>${lb}<input type="checkbox" data-f="origColor" ${it.color === null || it.color === undefined ? 'checked' : ''}></label>`;
  if (f === 'color') return `<label>${lb}<input type="color" data-f="color" value="${hex(it.color ?? 0xb4bcc6)}"></label>`;
  if (f === 'unit') {
    const opts = UNITS.some(([u]) => u === it.unit) ? UNITS : [...UNITS, [it.unit, `${it.unit} mm`]];
    return `<label>${lb}<select data-f="unit">${opts.map(([u, n]) => `<option value="${u}" ${u === it.unit ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`;
  }
  if (f === 'up') return `<label>${lb}<select data-f="up">${UPS.map(([u, n]) => `<option value="${u}" ${u === it.up ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`;
  if (f === 'opacity') return `<label>${lb}<input type="number" step="0.05" min="0.05" max="1" data-f="opacity" value="${it.opacity ?? (it.collide === false ? 0.5 : 1)}"></label>`;
  if (f === 'mode') return `<label>${lb}<select data-f="mode"><option value="auto" ${it.mode === 'auto' ? 'selected' : ''}>자동(비면 배출)</option><option value="edge" ${it.mode === 'edge' ? 'selected' : ''}>DO 상승 에지</option></select></label>`;
  if (f === 'size') return [0, 1, 2].map((i) => `<label>${['크기 X', '크기 Y', '크기 Z'][i]}<input type="number" step="any" data-f="size${i}" value="${r1(it.size[i])}"></label>`).join('');
  if (TEXT.has(f)) return `<label>${lb}<input type="text" data-f="${f}" value="${String(it[f] ?? '').replace(/"/g, '&quot;')}"></label>`;
  const v = it[f];
  return `<label>${lb}<input type="number" step="any" data-f="${f}" value="${v === null || v === undefined ? '' : r1(v)}"${f === 'z' && v === null ? ' placeholder="자동"' : ''}></label>`;
}

function statusText(d, s) {
  if (!s) return '';
  switch (d.type) {
    case 'conveyor': return s.running ? `<span class="run">● 운전 중${s.dir < 0 ? ' (역방향)' : ''}</span> · ${d.speed} mm/s` : `○ 정지${d.runDO ? ` (DO${d.runDO} OFF)` : ''}`;
    case 'sensor': return `${s.on ? '<span class="on">● 감지 ON</span>' : '○ 감지 없음'} → DI${d.di} = ${s.di ? 'ON' : 'OFF'}${d.invert ? ' (반전)' : ''}`;
    case 'feeder': return `배출 ${s.count}${d.max ? ' / ' + d.max : ''}${s.blocked ? ' · 배출 위치 막힘' : ''} · ${d.mode === 'edge' ? `DO${d.triggerDO} 에지` : `자동 ${d.interval}s`}`;
    case 'cylinder': return `${s.extended ? '<span class="on">전진 완료</span>' : s.retracted ? '후진 완료' : '<span class="run">이동 중</span>'} ${Math.round(s.pos * 100)}% · DO${d.extendDO}`;
    case 'sink': return `배출된 공작물 ${s.count}개`;
    case 'pallet': return `슬롯 ${d.rows * d.cols}개 (첫 슬롯 ${r1(d.x)}, ${r1(d.y)})`;
  }
  return '';
}

// 모델 크기 (위쪽 축 보정·단위·배율 적용, 회전 전) + 간섭 상태
function modelStatus(m, hit) {
  let size = '';
  if (m.bbox) {
    const d = [0, 1, 2].map((k) => (m.bbox[1][k] - m.bbox[0][k]) * m.unit * m.scale);
    const s = m.up === 'y' ? [d[0], d[2], d[1]] : m.up === 'x' ? [d[2], d[1], d[0]] : d;
    size = `${s.map((v) => Math.round(v)).join(' × ')} mm`;
  }
  const flags = [m.collide ? (m.tool ? '간섭(링크+툴)' : '간섭(링크)') : '간섭 제외', m.support ? '지지면' : ''].filter(Boolean).join(' · ');
  return `${size} · ${flags}${hit ? ' · <span style="color:#ff6b6b;font-weight:600">● 간섭 중</span>' : ''}`;
}

export function renderCellPanel(st) {
  if (!root || !st?.cell?.layout) return;
  const { layout: L, status = {}, presets = [], rev } = st.cell;
  const sel = $('#cellPreset', root);
  if (sel.options.length !== presets.length) sel.innerHTML = presets.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  if (document.activeElement !== sel && L.preset) sel.value = L.preset;
  $('#cellName', root).textContent = L.preset ? (presets.find((p) => p.id === L.preset)?.name ?? L.name) : `${L.name} (사용자 정의)`;
  const list = $('#cellList', root);
  const key = rev + '|' + JSON.stringify(L);
  const editing = list.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName);
  if ((key !== builtKey || force) && !editing) {
    builtKey = key; force = false;
    const collapsed = new Set($$('.cell-item.collapsed', list).map((e) => e.dataset.id));
    const items = [
      ...(L.models || []).map((m) => ({ kind: 'model', it: m })),
      ...L.devices.map((d) => ({ kind: d.type, it: d })),
      ...L.obstacles.map((o) => ({ kind: 'obstacle', it: o })),
      ...L.tables.map((t) => ({ kind: 'table', it: t })),
      ...L.workpieces.map((w) => ({ kind: 'workpiece', it: w })),
    ];
    list.innerHTML = items.map(({ kind, it }) => {
      return `<div class="cell-item ${collapsed.has(it.id) ? 'collapsed' : ''}" data-id="${it.id}" data-kind="${kind}">
        <div class="hd"><button data-act="fold" title="접기/펼치기">${collapsed.has(it.id) ? '▸' : '▾'}</button><span class="k">${KIND_NAME[kind]}</span><b>${it.id}${it.name ? ' · ' + it.name : ''}</b>
        <button data-act="del" title="삭제" ${kind === 'table' && L.tables.length < 2 ? 'disabled' : ''}>삭제</button></div>
        <div class="st" data-st="${it.id}"></div>
        <div class="grid3">${FIELDS[kind].map((f) => fieldHtml(it, f)).join('')}</div>
      </div>`;
    }).join('') || '<div class="note">항목 없음</div>';
  }
  const hit = new Set((st.collision?.pairs || []).map((p) => p.b));
  for (const d of [...L.devices, ...(L.models || [])]) {
    const el = list.querySelector(`[data-st="${window.CSS.escape(d.id)}"]`);
    if (!el) continue;
    const html = d.asset ? modelStatus(d, hit.has(d.id)) : statusText(d, status[d.id]);
    if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; }
  }
}
