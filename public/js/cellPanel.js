// 셀 탭: 레이아웃 프리셋 / 장치 목록 편집 / 실시간 상태 / 레이아웃 JSON 내보내기·가져오기
// 서버 명령: { cmd:'cell', op:'get'|'set'|'preset'|'resetObjects'|'add'|'remove'|'update', ... } (server/cell.js)
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

let ctx = null;          // { cmd, view, getState }
let root = null;
let builtKey = null;     // 목록을 마지막으로 그린 레이아웃 키
let force = false;

const KIND_NAME = { table: '테이블', workpiece: '공작물', obstacle: '장애물', conveyor: '컨베이어', feeder: '피더', sensor: '센서', cylinder: '실린더', sink: '배출구', pallet: '팔레트' };
const LBL = {
  name: '이름', x: 'X', y: 'Y', z: 'Z', w: '폭 W', d: '깊이 D', h: '높이 H', yaw: '회전°', size: '크기',
  x0: '시작 X', y0: '시작 Y', x1: '끝 X', y1: '끝 Y', width: '벨트 폭', speed: '속도 mm/s', runDO: '운전 DO (0=항상)', reverseDO: '역방향 DO', stopper: '끝 스토퍼',
  mode: '모드', triggerDO: '배출 DO', interval: '간격 s', max: '최대 (0=∞)', prefix: 'ID 접두어',
  di: 'DI', invert: '반전', length: '몸체 길이', bore: '보어', stroke: '행정', time: '행정 시간 s', extendDO: '전진 DO', extDI: '전진 확인 DI', retDI: '후진 확인 DI',
  pulseDI: '배출 펄스 DI', rows: '행', cols: '열', pitchX: '피치 X', pitchY: '피치 Y', color: '색', collide: '간섭 체크',
};
const FIELDS = {
  table: ['name', 'x', 'y', 'z', 'w', 'd'],
  workpiece: ['x', 'y', 'z', 'size', 'color'],
  obstacle: ['name', 'x', 'y', 'z', 'w', 'd', 'h', 'yaw', 'color', 'collide'],
  conveyor: ['name', 'x0', 'y0', 'x1', 'y1', 'z', 'width', 'speed', 'runDO', 'reverseDO', 'stopper'],
  feeder: ['name', 'x', 'y', 'z', 'size', 'color', 'mode', 'triggerDO', 'interval', 'max', 'prefix'],
  sensor: ['name', 'x', 'y', 'z', 'w', 'd', 'h', 'yaw', 'di', 'invert'],
  cylinder: ['name', 'x', 'y', 'z', 'yaw', 'length', 'bore', 'stroke', 'time', 'extendDO', 'extDI', 'retDI'],
  sink: ['name', 'x', 'y', 'z', 'w', 'd', 'h', 'pulseDI'],
  pallet: ['name', 'x', 'y', 'z', 'rows', 'cols', 'pitchX', 'pitchY'],
};
const BOOL = new Set(['stopper', 'invert', 'collide']);
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

  const list = $('#cellList', root);
  list.addEventListener('change', (e) => {
    const inp = e.target.closest('[data-f]');
    if (!inp) return;
    const item = inp.closest('[data-id]');
    const f = inp.dataset.f;
    let v;
    if (BOOL.has(f)) v = inp.checked;
    else if (f === 'color') v = parseInt(inp.value.slice(1), 16);
    else if (TEXT.has(f) || f === 'mode') v = inp.value;
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
  if (f === 'color') return `<label>${lb}<input type="color" data-f="color" value="${hex(it.color)}"></label>`;
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
  for (const d of L.devices) {
    const el = list.querySelector(`[data-st="${window.CSS.escape(d.id)}"]`);
    if (!el) continue;
    const html = statusText(d, status[d.id]);
    if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; }
  }
}
