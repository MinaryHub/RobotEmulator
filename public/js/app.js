// 웹 UI 메인: 서버(WebSocket)와 상태 동기화, 3D 뷰/에디터/패널 구동
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { RobotView } from './robotView.js';
import { DirectTeach, SNAPS } from './directTeach.js';
import { CodeEditor } from './editor.js';
import { robotCapsules } from '/shared/collision.js';
import { initDebugPanels } from './debugPanels.js';
import { initCellPanel, renderCellPanel } from './cellPanel.js';
import { initCameraPanel, renderCameraPanel } from './cameraPanel.js';
import { initChatPanel, onChatEvent, onChatReconnect } from './chatPanel.js';
import { initSysioPanel, renderSysioPanel, loadSysioPresets } from './sysioPanel.js';
import { ioLabelMap, escHtml, labelsToCsv, csvToLabels } from './ioLabels.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const f2 = (v, d = 2) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);

const app = {
  robots: [], grippers: [], vendors: {}, comms: [],
  st: null, robotId: null, gripperKey: null,
  files: {}, buffers: {}, dirty: new Set(), main: null, openFile: null,
  customGeom: null, jogFrame: 'base', ioBase: 1,
};

const view = new RobotView($('#viewport'));
const editor = new CodeEditor($('#editor'));
editor.onChange = () => { if (app.openFile) { app.buffers[app.openFile] = editor.text; app.dirty.add(app.openFile); renderFileTabs(); } };

// ---------------------------------------------------------------- WebSocket
let ws, reqId = 0;
const pending = new Map();
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => setPill($('#stConn'), '연결됨', 'on');
  ws.onclose = () => { setPill($('#stConn'), '연결 끊김', 'off'); setTimeout(connect, 1500); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'init') onInit(m);
    else if (m.type === 'state') onState(m.state);
    else if (m.type === 'log') addLog(m.entry);
    else if (m.type === 'files') onFiles(m);
    else if (m.type === 'comms') { app.comms = m.comms; renderComms(); }
    else if (m.type === 'tl') dbg.onTimeline(m);
    else if (m.type === 'chat') onChatEvent(m);
    // 명령 오류는 error 필드로 구분 (start/servo 등은 거부 시 ok:false + reject 를 정상 응답으로 돌려줌)
    else if (m.type === 'reply') { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.ok || m.error === undefined ? p.res(m) : p.rej(new Error(m.error)); } }
  };
}
function cmd(name, args = {}) {
  return new Promise((res, rej) => {
    const id = ++reqId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ cmd: name, id, ...args }));
  }).catch((e) => { addLog({ t: Date.now(), src: 'alarm', msg: e.message }); throw e; });
}

function onInit(m) {
  Object.assign(app, { robots: m.robots, grippers: m.grippers, vendors: m.vendors, comms: m.comms });
  $('#log').innerHTML = '';
  m.logs.forEach(addLog);
  buildSelectors();
  buildGripperCards();
  onFiles(m.files);
  onState(m.state);
  renderComms();
  onChatReconnect();
  loadSysioPresets();
}

// ---------------------------------------------------------------- 상태 반영
function onState(st) {
  const prev = app.st;
  app.st = st;
  const model = app.robots.find((r) => r.id === st.robotId);
  if (app.robotId !== st.robotId) {
    app.robotId = st.robotId;
    view.setRobot(model, app.vendors[model.vendor], st.scene);
    editor.setLanguage(model.vendor);
    $('#selVendor').value = model.vendor;
    fillRobotSelect(model.vendor);
    $('#selRobot').value = model.id;
    renderSpec(model);
    if ($('#chkEnv').checked) view.showEnvelope(true);
    buildJog(model);
    renderComms();
    app.gripperKey = null;
  }
  const gkey = st.gripperId + (st.gripperCustom ? JSON.stringify(st.gripperCustom.tcp) : '');
  if (app.gripperKey !== gkey) {
    app.gripperKey = gkey;
    const def = st.gripperCustom || app.grippers.find((g) => g.id === st.gripperId);
    view.setGripper(def, app.customGeom);
    $('#selGripper').value = st.gripperId === 'custom' ? '' : st.gripperId;
    $$('#gripperList .card').forEach((c) => c.classList.toggle('sel', c.dataset.id === st.gripperId));
  }
  if (!prev || prev.scene?.floorZ !== st.scene.floorZ) view.buildCell(st.scene);
  view.update(st);
  dt.update(st);
  syncDirectTeachBar(st);

  setPill($('#stServo'), st.servo ? 'SERVO ON' : 'SERVO OFF', st.servo ? 'on' : 'off');
  $('#btnServo').textContent = st.servo ? '서보 OFF' : '서보 ON';
  $('#stMode').textContent = st.mode;
  $$('#segMode button').forEach((b) => b.classList.toggle('active', b.dataset.v === st.mode));
  const ps = st.program.status;
  setPill($('#stProg'), st.held && ps === 'running' ? 'HOLD' : ps.toUpperCase(), st.held && ps === 'running' ? 'hold' : ps === 'running' ? 'run' : ps === 'error' ? 'off' : '');
  $('#stAlarm').classList.toggle('hidden', !st.alarms.length);
  $('#ovAlarm').textContent = st.alarms.slice(-3).map((a) => `⚠ [${a.code}] ${a.msg}`).join('\n');
  if (document.activeElement !== $('#ovRange')) { $('#ovRange').value = st.override; }
  $('#ovVal').textContent = `${st.override}%`;

  renderPose(st, model);
  renderProgram(st);
  renderIO(st);
  renderGripIO(st);
  renderCycle(st);
  dbg.onState(st);
  if (document.activeElement !== $('#chkAutoScene')) $('#chkAutoScene').checked = st.autoResetScene !== false;
  renderCollision(st, model);
  renderCellPanel(st);
  renderCameraPanel(st);
  renderSafety(st);
  renderSysioPanel(st);
}

// ---------------------------------------------------------------- 안전 · 인터록 · 거부 알림
const OP_NAME = { start: '시작', resume: '재개', servoOn: '서보 ON', move: '이동', jog: '조그', mode: '모드 변경', select: '프로그램 선택' };
const SRC_NAME = { internal: '내부', ui: '펜던트', ext: '외부' };
const MODE_NOTE = {
  TEACH: 'TEACH: 펜던트에서 조그·티칭·시험 실행. 외부 시작 불가',
  PLAY: 'PLAY: 펜던트(화면)에서 자동 운전 시작. 외부 시작 불가',
  REMOTE: 'REMOTE: 외부(PLC·통신·시스템 I/O)에서만 시작. 펜던트 시작·이동 불가',
};
let toastTimer = null;
function showToast(html, kind = 'bad') {
  const el = $('#toast');
  el.innerHTML = html;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 4000);
}
// 새 거부(t 가 바뀐 경우)만 알림. 첫 상태(페이지 로드)의 오래된 거부는 무시
function noteReject(r) {
  if (!r || r.t === app.rejT) return;
  app.rejT = r.t;
  showToast(`<b>거부: ${escHtml(OP_NAME[r.op] ?? r.op)} (${escHtml(SRC_NAME[r.source] ?? r.source)})</b> — ${escHtml(r.reason)}`);
}
function renderSafety(st) {
  const sf = st.safety || {};
  if (app.rejT === undefined) app.rejT = st.lastReject?.t ?? null;
  else noteReject(st.lastReject);
  const eb = $('#btnEstop');
  eb.classList.toggle('on', !!sf.estopUI);
  eb.textContent = sf.estopUI ? '비상정지 해제' : '비상정지';
  $('#stEstop').classList.toggle('hidden', !sf.estopExt);
  $('#modeNote').textContent = MODE_NOTE[st.mode] ?? '';
  if (document.activeElement !== $('#chkInterlock')) $('#chkInterlock').checked = !!st.interlock;
  if (document.activeElement !== $('#chkReqEnable')) $('#chkReqEnable').checked = !!sf.requireEnable;
  if (document.activeElement !== $('#selFenceStop')) $('#selFenceStop').value = sf.fenceStop || 'stop1';
  const fb = $('#btnFence');
  fb.textContent = `안전 펜스: ${sf.fenceOpen ? '열림' : '닫힘'}`;
  fb.classList.toggle('warn', !!sf.fenceOpen);
  const en = $('#btnEnable');
  en.disabled = !sf.requireEnable;
  en.textContent = `인에이블 ${sf.enable ? 'ON' : 'OFF'}`;
  en.classList.toggle('go', !!sf.enable);
  const notes = [];
  if (sf.estop) notes.push(`<span class="bad">● 비상정지 중 (${[sf.estopUI && '화면 버튼', sf.estopExt && '외부 입력'].filter(Boolean).join(' + ')}) — 해제 후 알람 리셋</span>`);
  if (sf.fenceOpen) notes.push(`<span class="warn">● 펜스 열림 — ${st.mode === 'TEACH' ? 'TEACH 에서는 조그 가능' : '자동 운전 불가'}</span>`);
  if (sf.requireEnable && !sf.enable) notes.push('조그하려면 인에이블 ON');
  if (st.sysio?.enabled && st.sysio.inputs.some((x) => x.kind === 'fence')) notes.push('시스템 I/O 사용 중: 펜스 상태는 펜스 입력이 바뀔 때 그 값으로 덮어씁니다');
  const html = notes.join('<br>');
  if ($('#safetyNote').dataset.sig !== html) { $('#safetyNote').innerHTML = html; $('#safetyNote').dataset.sig = html; }
}
// 명령 응답의 거부 정보도 확인 (상태 푸시보다 먼저 알림)
async function cmdChecked(name, args) {
  const r = await cmd(name, args);
  if (r && r.ok === false) noteReject(r.reject);
  return r || {};
}
$('#btnEstop').onclick = () => cmd('safety', { estop: !app.st?.safety?.estopUI });
$('#chkInterlock').onchange = (e) => cmd('safety', { interlock: e.target.checked });
$('#chkReqEnable').onchange = (e) => cmd('safety', { requireEnable: e.target.checked });
$('#selFenceStop').onchange = (e) => cmd('safety', { fenceStop: e.target.value });
$('#btnFence').onclick = () => cmd('safety', { fence: !app.st?.safety?.fenceOpen });
$('#btnEnable').onclick = () => cmd('safety', { enable: !app.st?.safety?.enable });

// ---------------------------------------------------------------- 간섭
function renderCollision(st, model) {
  const c = st.collision || { hit: false, pairs: [] };
  const ids = [...new Set(c.pairs.map((p) => p.a).concat(c.pairs.filter((p) => p.type === 'self').map((p) => p.b)))];
  const sig = ids.join();
  if (app.collSig !== sig) { app.collSig = sig; view.setCollision?.(ids); }
  const pill = $('#stColl');
  pill.classList.toggle('hidden', !c.hit);
  pill.title = c.pairs.map((p) => `${p.a} ↔ ${p.b}`).join('\n');
  $$('#segColl button').forEach((b) => b.classList.toggle('active', b.dataset.v === st.collisionMode));
  if ($('#chkCaps').checked) {
    const g = st.gripperCustom || app.grippers.find((x) => x.id === st.gripperId);
    view.showCapsules?.(true, robotCapsules(model, st.joints, g), ids);
  }
}
$$('#segColl button').forEach((b) => (b.onclick = () => cmd('collisionMode', { mode: b.dataset.v })));
$('#chkCaps').onchange = (e) => { if (!e.target.checked) view.showCapsules?.(false); else app.st && onState(app.st); };

// ---------------------------------------------------------------- 사이클 타임
function renderCycle(st) {
  const cy = st.cycle || {};
  const last = cy.last;
  $('#cycNow').textContent = cy.elapsed != null ? `${cy.elapsed.toFixed(2)} s ▶` : last ? `${last.total.toFixed(2)} s` : '-';
  if (document.activeElement !== $('#chkBlend')) $('#chkBlend').checked = st.blendEnabled !== false;
  syncSpeed(st.timeScale ?? 1);
  const sig = last ? last.at : 0;
  if (app.cycSig === sig) return;
  app.cycSig = sig;
  if (!last) { $('#cycBar').innerHTML = ''; $('#cycDetail').innerHTML = '<div class="hist">프로그램을 끝까지 실행하면 사이클 타임이 기록됩니다.</div>'; return; }
  const pct = (v) => (last.total > 0 ? (100 * v) / last.total : 0);
  $('#cycBar').innerHTML = `<i class="m" style="width:${pct(last.motion)}%"></i><i class="w" style="width:${pct(last.wait)}%"></i><i class="l" style="width:${pct(last.logic)}%"></i>`;
  const hist = (cy.history || []).slice(-8).map((h) => `${h.total.toFixed(2)}${h.blend ? '' : '*'}`).join('  ');
  $('#cycDetail').innerHTML = `
    <div class="cyc-legend"><span><b style="background:#3d8bfd"></b>모션 ${last.motion.toFixed(2)}s</span><span><b style="background:#f0a020"></b>대기 ${last.wait.toFixed(2)}s</span><span><b style="background:#8c96a3"></b>기타 ${last.logic.toFixed(2)}s</span><span>이동 ${last.moves}회 · OV ${last.override}%${last.blend ? '' : ' · 블렌딩 OFF'}</span></div>
    <table><tr><th>라인 (시간 상위)</th><th>구분</th><th>횟수</th><th>시간 s</th><th>%</th></tr>
    ${last.lines.map((l) => `<tr data-f="${l.file ?? ''}" data-l="${l.line ?? ''}"><td>${l.file ?? ''}:${l.line ?? ''}</td><td>${{ motion: '모션', wait: '대기', logic: '기타' }[l.cat] ?? ''}</td><td>${l.count}</td><td>${l.time.toFixed(3)}</td><td>${pct(l.time * 1).toFixed(1)}</td></tr>`).join('')}
    </table>
    <div class="hist">최근 사이클: ${hist}  (* 블렌딩 OFF)</div>`;
  $$('#cycDetail tr[data-l]').forEach((tr) => (tr.onclick = () => {
    if (tr.dataset.f && app.buffers[tr.dataset.f] !== undefined) openFile(tr.dataset.f);
    editor.setExecLine(Number(tr.dataset.l), true);
  }));
}
$('#chkAutoScene').onchange = (e) => cmd('autoResetScene', { on: e.target.checked });
// 배속 표시: 목록에 없는 값(외부 API 로 지정)은 임시 항목으로 표시
function syncSpeed(v) {
  const sel = $('#selSpeed');
  if (document.activeElement === sel) return;
  let opt = [...sel.options].find((o) => Math.abs(Number(o.value) - v) < 1e-9);
  if (!opt) {
    sel.querySelector('option[data-custom]')?.remove();
    opt = new Option(`×${+v.toFixed(2)}`, String(v));
    opt.dataset.custom = '1';
    sel.add(opt);
  }
  sel.value = opt.value;
  sel.classList.toggle('fast', v !== 1);
}
$('#chkBlend').onchange = (e) => cmd('blend', { on: e.target.checked });
$('#btnCycDetail').onclick = (e) => { const d = $('#cycDetail'); d.classList.toggle('hidden'); e.target.textContent = d.classList.contains('hidden') ? '상세 ▾' : '상세 ▴'; };

function setPill(el, text, cls) { el.textContent = text; el.className = `pill ${cls || ''}`; }

function renderPose(st, model) {
  const vd = app.vendors[model.vendor];
  const jn = vd.jointNames;
  const pn = vd.poseNames;
  const jointsTxt = st.joints.map((v, i) => `${jn[i].padEnd(5)} ${f2(v, 3).padStart(9)}°`).join('\n');
  const poseTxt = st.tcp.map((v, i) => `${pn[i].padEnd(3)} ${f2(v, i < 3 ? 2 : (pn.length === 7 ? 5 : 3)).padStart(10)}${i < 3 ? 'mm' : pn.length === 7 ? '' : '°'}`).join('\n');
  $('#ovPose').textContent = `${vd.name} ${model.name}\n${jointsTxt}\n────────────────\n${poseTxt}\n그리퍼 ${(st.grip.pos * 100).toFixed(0)}% ${st.grip.holding ? '· ' + st.grip.holding : ''}`;
  $('#posView').textContent = `${jointsTxt}\n\n${poseTxt}`;
  st.joints.forEach((v, i) => {
    const el = document.getElementById(`jv${i}`);
    if (!el) return;
    el.firstChild.textContent = f2(v, 2);
    const [lo, hi] = model.limits[i];
    el.querySelector('i').style.left = `${((v - lo) / (hi - lo)) * 100}%`;
  });
}

function renderProgram(st) {
  const p = st.program;
  const cur = p.current;
  $('#ovProg').textContent = `프로그램 ${p.main ?? '-'}\n상태 ${p.status.toUpperCase()}${st.held ? ' (HOLD)' : ''}\n${cur ? `${cur.proc ?? ''} ${cur.file ?? ''}:${cur.line ?? ''}` : ''}\n사이클 ${p.cycle}  OV ${st.override}%${(st.timeScale ?? 1) !== 1 ? `  ×${st.timeScale}` : ''}`;
  const bpPrefix = `${app.openFile}:`;
  editor.setBreakpoints((st.breakpoints || []).filter((b) => b.startsWith(bpPrefix)).map((b) => Number(b.slice(bpPrefix.length))));
  const running = p.status === 'running' || p.status === 'paused';
  editor.setExecLine(running && cur && cur.file === app.openFile ? cur.line : null, true);
  if (running && cur?.file && cur.file !== app.openFile && app.files[cur.file] !== undefined && !app.dirty.has(app.openFile)) openFile(cur.file);
  const ce = p.compileError;
  const cm = $('#compileMsg');
  if (ce) {
    cm.className = 'cmsg err';
    cm.textContent = `✖ ${ce.file ?? ''}${ce.line ? ':' + ce.line : ''} ${ce.msg}`;
    editor.setErrLine(ce.file === app.openFile ? ce.line : null);
  } else {
    cm.className = 'cmsg';
    cm.textContent = p.main ? `✔ ${p.main} 컴파일 OK` : '';
    editor.setErrLine(null);
  }
  if (app.main !== p.main) { app.main = p.main; renderFileTabs(); }
}

// ---------------------------------------------------------------- 선택기/사양
function buildSelectors() {
  $('#selVendor').innerHTML = Object.entries(app.vendors).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('');
  $('#selGripper').innerHTML = app.grippers.map((g) => `<option value="${g.id}">${g.maker === '-' ? '' : g.maker + ' '}${g.name}</option>`).join('') + '<option value="" disabled>사용자 STL</option>';
}
function fillRobotSelect(vendor) {
  $('#selRobot').innerHTML = app.robots.filter((r) => r.vendor === vendor).map((r) => `<option value="${r.id}">${r.name}  (${r.payload}kg / ${r.reach}mm)</option>`).join('');
}
$('#selVendor').onchange = (e) => { const r = app.robots.find((x) => x.vendor === e.target.value); confirmSwitch(r.id); };
$('#selRobot').onchange = (e) => confirmSwitch(e.target.value);
$('#selGripper').onchange = (e) => e.target.value && cmd('setGripper', { id: e.target.value });

function confirmSwitch(id) {
  const target = app.robots.find((r) => r.id === id);
  const cur = app.robots.find((r) => r.id === app.robotId);
  if (cur && target.vendor !== cur.vendor && app.dirty.size && !confirm('저장하지 않은 프로그램 변경이 있습니다. 제조사를 바꾸면 프로그램이 교체됩니다. 계속할까요?')) {
    $('#selVendor').value = cur.vendor; fillRobotSelect(cur.vendor); $('#selRobot').value = cur.id; return;
  }
  if (target.vendor !== cur?.vendor) { app.dirty.clear(); app.buffers = {}; }
  cmd('setRobot', { id });
}

function renderSpec(m) {
  const v = app.vendors[m.vendor];
  const rows = m.limits.map((l, i) => `<tr><td style="text-align:left">${v.jointNames[i]}</td><td>${l[0]}</td><td>${l[1]}</td><td>${m.maxSpeed[i]}</td></tr>`).join('');
  $('#robotSpec').innerHTML = `
    <span>제조사</span><span>${v.name}</span>
    <span>모델</span><span>${m.name}</span>
    <span>컨트롤러</span><span>${v.controller}</span>
    <span>로봇 언어</span><span>${v.language} (${v.ext})</span>
    <span>가반하중</span><span>${m.ratedPayload ? `최대 ${m.payload} kg (정격 ${m.ratedPayload} kg)` : `${m.payload} kg`}</span>
    <span>최대 도달</span><span>${m.reach} mm</span>
    <span>반복정밀도</span><span>±${m.repeatability ?? '-'} mm</span>
    <span>OPW (mm)</span><span style="font-family:var(--mono);font-size:11px">a1 ${m.opw.a1} a2 ${m.opw.a2} c1 ${m.opw.c1}<br>c2 ${m.opw.c2} c3 ${m.opw.c3} c4 ${m.opw.c4}</span>
    <span>출처</span><span style="font-size:11px;color:var(--dim)">${m.source ?? '-'}</span>
    <table><tr><th style="text-align:left">축</th><th>-한계°</th><th>+한계°</th><th>속도°/s</th></tr>${rows}</table>`;
}

function buildGripperCards() {
  const kindName = { none: '-', parallel: '평행 그리퍼', adaptive2f: '2지 어댑티브', threefinger: '3지 어댑티브', vacuum: '진공', magnet: '자석', torch: '용접 토치', spindle: '스핀들' };
  $('#gripperList').innerHTML = app.grippers.map((g) => `
    <div class="card" data-id="${g.id}">
      <div class="t">${g.name}</div>
      <div class="m">${g.maker} · ${kindName[g.kind]}</div>
      ${g.kind === 'none' ? '' : `<div class="d">TCP Z ${g.tcp[2]}mm${g.tcp[1] ? ` Y ${g.tcp[1]}` : ''}${g.tcp[3] ? ` Rx ${g.tcp[3]}°` : ''} · ${g.mass}kg${g.stroke ? ` · 행정 ${g.stroke}mm` : ''}${g.force ? ` · ${g.force}` : ''}</div>`}
    </div>`).join('');
  $$('#gripperList .card').forEach((c) => (c.onclick = () => cmd('setGripper', { id: c.dataset.id })));
}

$('#btnCustomGripper').onclick = async () => {
  const f = $('#stlFile').files[0];
  if (!f) return alert('STL 파일을 선택하세요');
  const geom = new STLLoader().parse(await f.arrayBuffer());
  const s = Number($('#cgUnit').value);
  geom.scale(s, s, s);
  geom.computeVertexNormals();
  app.customGeom = geom;
  app.gripperKey = null;
  cmd('customGripper', { def: { name: f.name, kind: $('#cgKind').value, stroke: Number($('#cgStroke').value), tcp: [Number($('#cgX').value), Number($('#cgY').value), Number($('#cgZ').value), 0, 0, 0] } });
};

function renderGripIO(st) {
  $$('#gripIO input').forEach((inp) => { if (document.activeElement !== inp) inp.value = st.gripperIO[inp.dataset.k] ?? ''; });
}
$$('#gripIO input').forEach((inp) => (inp.onchange = () => cmd('gripperIO', { map: { [inp.dataset.k]: Number(inp.value) || 0 } })));

// ---------------------------------------------------------------- 조그
function buildJog(model) {
  const vd = app.vendors[model.vendor];
  $('#jogJoints').innerHTML = vd.jointNames.map((n, i) => `
    <span class="n">${n}</span><button data-t="joint" data-a="${i}" data-d="-1">−</button>
    <div class="v" id="jv${i}">0<div class="bar"><i></i></div></div><button data-t="joint" data-a="${i}" data-d="1">+</button>`).join('');
  const cn = ['X', 'Y', 'Z', 'Rx', 'Ry', 'Rz'];
  $('#jogCart').innerHTML = cn.map((n, i) => `
    <span class="n">${n}</span><button data-t="cart" data-a="${i}" data-d="-1">−</button>
    <div class="v">${i < 3 ? 'mm' : 'deg'}</div><button data-t="cart" data-a="${i}" data-d="1">+</button>`).join('');
  $$('.jog button').forEach(bindJog);
}
let jogTimer = null;
function bindJog(btn) {
  const start = (e) => {
    e.preventDefault();
    if (!app.st?.servo) { addLog({ t: Date.now(), src: 'system', msg: '조그하려면 서보를 ON 하세요' }); return; }
    const jog = { type: btn.dataset.t, axis: Number(btn.dataset.a), dir: Number(btn.dataset.d), speed: Number($('#jogSp').value) / 100, frame: app.jogFrame };
    const tick = () => ws.send(JSON.stringify({ cmd: 'jog', jog }));
    tick();
    clearInterval(jogTimer);
    jogTimer = setInterval(tick, 150);
  };
  const stop = () => { if (jogTimer) { clearInterval(jogTimer); jogTimer = null; ws.send(JSON.stringify({ cmd: 'jogStop' })); } };
  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointerleave', stop);
}
$('#jogSp').oninput = (e) => ($('#jogSpVal').textContent = `${e.target.value}%`);
$$('#segFrame button').forEach((b) => (b.onclick = () => { app.jogFrame = b.dataset.v; $$('#segFrame button').forEach((x) => x.classList.toggle('active', x === b)); }));

// ---------------------------------------------------------------- 컨트롤러 버튼
$('#btnServo').onclick = () => cmdChecked('servo', { on: !app.st.servo });
$('#btnAlarmReset').onclick = () => cmd('resetAlarms');
$('#btnHome').onclick = () => cmd('moveHome');
$$('#segMode button').forEach((b) => (b.onclick = () => cmdChecked('mode', { mode: b.dataset.v })));
$('#ovRange').oninput = (e) => { $('#ovVal').textContent = `${e.target.value}%`; cmd('override', { value: Number(e.target.value) }); };
$('#btnResetScene').onclick = () => cmd('resetScene');
$('#btnTrail').onclick = (e) => { view.trailOn = !view.trailOn; e.target.textContent = `궤적 표시 ${view.trailOn ? 'ON' : 'OFF'}`; };
$('#btnClearTrail').onclick = () => view.clearTrail();
$('#btnFit').onclick = () => view.fitView();
$('#chkEnv').onchange = (e) => view.showEnvelope(e.target.checked);

// ---------------------------------------------------------------- I/O
function renderIO(st) {
  const base = app.ioBase;
  const draw = (el, on, type) => {
    const set = new Set(on);
    const labels = ioLabelMap(st, type);
    const T = type.toUpperCase();
    let html = '';
    for (let n = base; n < base + 32; n++) {
      const l = labels[n];
      const tip = l ? [`${T}${n} ${l.name}`, l.src === 'sys' ? '(시스템 I/O)' : '', l.src === 'sys' && l.other ? `이름표: ${l.other}` : '', l.desc].filter(Boolean).join('\n') : `${T}${n}`;
      html += `<div data-n="${n}" data-t="${type}" class="${set.has(n) ? 'on' : ''}${l ? ` lb ${l.src}` : ''}" title="${escHtml(tip)}"><b>${n}</b><span class="ln">${l ? escHtml(l.name) : ''}</span><i class="ed" title="이름표 편집">✎</i></div>`;
    }
    if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; }
  };
  draw($('#ioDO'), st.io.do, 'do');
  draw($('#ioDI'), st.io.di, 'di');
}
for (const id of ['#ioDO', '#ioDI']) {
  $(id).onclick = (e) => {
    const d = e.target.closest('div[data-n]');
    if (!d) return;
    if (e.target.closest('.ed')) return openLabelEdit(d.dataset.t, Number(d.dataset.n), d);
    const n = Number(d.dataset.n), on = !d.classList.contains('on');
    cmd(d.dataset.t === 'do' ? 'setDO' : 'setDI', { n, v: on });
  };
  $(id).oncontextmenu = (e) => {
    const d = e.target.closest('div[data-n]');
    if (!d) return;
    e.preventDefault();
    openLabelEdit(d.dataset.t, Number(d.dataset.n), d);
  };
}
$('#ioPage').innerHTML = Array.from({ length: 16 }, (_, i) => `<option value="${i * 32 + 1}">${i * 32 + 1}-${i * 32 + 32}</option>`).join('');
$('#ioPage').onchange = (e) => { app.ioBase = Number(e.target.value); app.st && renderIO(app.st); };

// 이름표 편집 (우클릭 또는 ✎)
let lblEdit = null;
function openLabelEdit(type, n, cell) {
  const st = app.st;
  const user = st.ioLabels?.[type]?.[n] || {};
  const l = ioLabelMap(st, type)[n];
  lblEdit = { type, n };
  $('#ioEditT').textContent = `${type.toUpperCase()}${n} 이름표`;
  $('#ioEditSys').textContent = l?.src === 'sys' ? ` · 시스템 I/O: ${l.name}` : l?.src === 'lang' ? ` · 프로그램 신호: ${l.name}` : '';
  $('#ioEditName').value = user.name ?? '';
  $('#ioEditDesc').value = user.desc ?? '';
  const ed = $('#ioEdit');
  cell.closest('.io').after(ed);
  ed.classList.remove('hidden');
  $('#ioEditName').focus();
}
function closeLabelEdit() { $('#ioEdit').classList.add('hidden'); lblEdit = null; }
async function saveLabelEdit(del = false) {
  if (!lblEdit) return;
  await cmd('ioLabel', { ...lblEdit, name: del ? '' : $('#ioEditName').value.trim(), desc: del ? '' : $('#ioEditDesc').value.trim() });
  closeLabelEdit();
}
$('#ioEditSave').onclick = () => saveLabelEdit(false);
$('#ioEditDel').onclick = () => saveLabelEdit(true);
$('#ioEditCancel').onclick = closeLabelEdit;
for (const id of ['#ioEditName', '#ioEditDesc']) $(id).onkeydown = (e) => { if (e.key === 'Enter') saveLabelEdit(false); else if (e.key === 'Escape') closeLabelEdit(); };

// 이름표 CSV (type,n,name,desc — UTF-8 BOM, Excel 호환)
$('#btnLblExport').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([labelsToCsv(app.st?.ioLabels)], { type: 'text/csv;charset=utf-8' }));
  a.download = 'io-labels.csv';
  a.click();
};
$('#btnLblImport').onclick = () => $('#lblFile').click();
$('#lblFile').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const { labels, count, bad } = csvToLabels(await f.text());
  await cmd('ioLabels', { labels });
  addLog({ t: Date.now(), src: 'system', msg: `I/O 이름표 ${count}개 가져옴${bad ? ` (형식 오류 ${bad}행 건너뜀)` : ''}` });
  showToast(`이름표 ${count}개 가져옴${bad ? ` · 형식 오류 ${bad}행` : ''}`, 'ok');
};

// ---------------------------------------------------------------- 통신
const COMM_INFO = {
  yaskawa: { k: /yaskawa|hse|motoman/i, d: 'High-Speed Ethernet Server (UDP). 위치/상태/IO/변수(B,I,D,R,P) 읽기·쓰기, 서보/홀드, 잡 선택·시작, 이동 명령, 파일 전송(10041)' },
  kawasaki: { k: /kawasaki|\bas\b|telnet/i, d: 'AS 터미널(Telnet). WHERE, ZPOW ON, EXECUTE, HOLD/CONTINUE, DO 명령, LOAD/SAVE 프로그램 전송' },
  hyundai: { k: /hyundai|hi6|openapi/i, d: 'Hi6 Open API 스타일 REST(JSON). 위치/상태/IO/변수/프로그램 제어/이동' },
  abb: { k: /abb|rws/i, d: 'Robot Web Services (RWS 1.0/2.0 경로). jointtarget/robtarget, RAPID 실행/모듈 로드/심볼 데이터, IO 신호, 파일 서비스' },
  kuka: { k: /kuka|varproxy|showvar/i, d: 'KukaVarProxy / OpenShowVar (TCP 7000). $AXIS_ACT, $POS_ACT, $OV_PRO, $OUT[n], 전역 변수 읽기·쓰기' },
  modbus: { k: /modbus/i, d: 'Modbus TCP 서버 (제조사 공통). 코일 0~511 = DI, 이산 입력 = DO, 입력 레지스터 = 상태/관절/TCP/사이클 타임, 홀딩 0 = 명령, 1 = 오버라이드, 100~ = 사용자 레지스터' },
  opcua: { k: /opc[ -]?ua/i, d: 'OPC UA 서버 (제조사 공통). opc.tcp://…:4840/UA/RobotEmulator — Robot 폴더: 상태·관절·TCP·IO·레지스터 변수(구독 가능), ServoOn/Start/MoveJoints 등 메서드' },
};
function renderComms() {
  const vendor = app.robots.find((r) => r.id === app.robotId)?.vendor;
  $('#commList').innerHTML = app.comms.length ? app.comms.map((c) => {
    const v = Object.entries(COMM_INFO).find(([, x]) => x.k.test(c.name))?.[0];
    return `<div class="comm ${v === vendor ? 'cur' : ''}">
      <div class="t"><span>${c.name}</span><span class="p">${c.proto} ${c.port ?? '비활성'}</span></div>
      <div class="d">${v ? COMM_INFO[v].d : ''}</div></div>`;
  }).join('') : '<div class="note">통신 모듈 로딩 중…</div>';
}

// ---------------------------------------------------------------- 로그
const logEl = $('#log');
const logFilter = () => Object.fromEntries($$('.loghead input').map((c) => [c.dataset.src, c.checked]));
function addLog(e) {
  const d = document.createElement('div');
  d.className = e.src;
  const t = new Date(e.t).toTimeString().slice(0, 8);
  d.innerHTML = `<span class="ts">${t}</span> <span class="src">${e.src}</span>`;
  d.append(document.createTextNode(e.msg));
  d.hidden = logFilter()[e.src] === false;
  const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20;
  logEl.append(d);
  while (logEl.childElementCount > 1500) logEl.firstChild.remove();
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}
$$('.loghead input').forEach((c) => (c.onchange = () => { const f = logFilter(); for (const d of logEl.children) d.hidden = f[d.className] === false; }));
$('#btnClearLog').onclick = () => (logEl.innerHTML = '');

// ---------------------------------------------------------------- 파일/에디터
function onFiles(m) {
  app.files = m.files;
  for (const [n, t] of Object.entries(m.files)) if (!app.dirty.has(n)) app.buffers[n] = t;
  for (const n of Object.keys(app.buffers)) if (!(n in m.files) && !app.dirty.has(n)) delete app.buffers[n];
  app.main = m.main;
  if (!app.openFile || !(app.openFile in app.buffers)) app.openFile = m.main ?? Object.keys(app.buffers)[0] ?? null;
  if (app.openFile && !app.dirty.has(app.openFile) && editor.text !== app.buffers[app.openFile]) editor.text = app.buffers[app.openFile];
  if (!app.openFile) editor.text = '';
  renderFileTabs();
}
function renderFileTabs() {
  $('#fileTabs').innerHTML = Object.keys(app.buffers).map((n) =>
    `<button data-n="${n}" class="${n === app.openFile ? 'active' : ''} ${n === app.main ? 'main' : ''} ${app.dirty.has(n) ? 'dirty' : ''}">${n}</button>`).join('');
  $$('#fileTabs button').forEach((b) => (b.onclick = () => openFile(b.dataset.n)));
}
function openFile(n) {
  app.openFile = n;
  editor.text = app.buffers[n] ?? '';
  if (app.dirty.has(n)) editor.dirty = true;
  renderFileTabs();
  app.st && renderProgram(app.st);
}
async function saveAll() {
  for (const n of [...app.dirty]) {
    await cmd('saveFile', { name: n, text: app.buffers[n] });
    app.dirty.delete(n);
  }
  renderFileTabs();
}
$('#btnSave').onclick = saveAll;
document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveAll(); } });
$('#btnNew').onclick = () => {
  const ext = { yaskawa: '.JBI', kawasaki: '.as', hyundai: '.job', abb: '.mod', kuka: '.src', doosan: '.drl' }[app.st.vendor];
  const name = prompt('새 파일 이름', `NEW${ext}`);
  if (!name) return;
  app.buffers[name] = ''; app.dirty.add(name); openFile(name);
};
$('#btnOpen').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = async (e) => {
  for (const f of e.target.files) {
    const text = await f.text();
    await cmd('saveFile', { name: f.name, text });
    app.dirty.delete(f.name);
    app.openFile = f.name;
  }
  e.target.value = '';
};
$('#btnDownload').onclick = () => {
  if (!app.openFile) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([app.buffers[app.openFile].replace(/\n/g, '\r\n')], { type: 'text/plain' }));
  a.download = app.openFile;
  a.click();
};
$('#btnMain').onclick = async () => { if (app.openFile) { await saveAll(); cmd('setMain', { name: app.openFile }); } };
$('#btnDelete').onclick = () => {
  if (!app.openFile || !confirm(`${app.openFile} 파일을 삭제할까요?`)) return;
  const n = app.openFile;
  app.dirty.delete(n); delete app.buffers[n]; app.openFile = null;
  if (n in app.files) cmd('deleteFile', { name: n }); else onFiles({ files: app.files, main: app.main });
};
$('#btnExample').onclick = () => { if (confirm('현재 로봇·공작물 배치에 맞는 예제 프로그램을 다시 생성합니다. 기존 파일은 교체됩니다.')) { app.dirty.clear(); app.buffers = {}; cmd('loadExample'); } };

// 프로그램 제어
$('#btnStart').onclick = async () => {
  await saveAll();
  if (!app.st.servo && !(await cmdChecked('servo', { on: true })).ok) return;
  cmdChecked(app.st.held ? 'resume' : 'start');
};
$('#btnStep').onclick = async () => { await saveAll(); if (!app.st.servo && !(await cmdChecked('servo', { on: true })).ok) return; cmdChecked('step'); };
$('#btnHold').onclick = () => cmdChecked(app.st.held ? 'resume' : 'hold');
$('#btnStop').onclick = () => cmd('stop');

// Space: 재생/일시정지 — 정지·완료 상태면 시작, 실행 중이면 홀드, 홀드 중이면 재개
// (에디터·채팅·입력칸에서는 공백 입력, 대화상자가 열려 있으면 무시)
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !app.st) return;
  const t = e.target;
  if (t.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])') || document.querySelector('dialog[open]')) return;
  e.preventDefault();
  if (t.tagName === 'BUTTON') t.blur(); // 마지막으로 누른 버튼이 Space 로 다시 눌리지 않도록
  const st = app.st;
  if (st.program.status === 'running' && !st.held) cmd('hold');
  else $('#btnStart').onclick();
});
$('#btnReset').onclick = () => cmd('reset');

// 배속 (시뮬레이션 시간 배율). 단축키 - / + (= 키 포함)
const SPEEDS = [...document.querySelectorAll('#selSpeed option')].map((o) => Number(o.value));
$('#selSpeed').onchange = (e) => { cmd('timeScale', { value: Number(e.target.value) }); e.target.blur(); };
document.addEventListener('keydown', (e) => {
  if (!['-', '=', '+'].includes(e.key) || e.ctrlKey || e.altKey || e.metaKey || !app.st) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])') || document.querySelector('dialog[open]')) return;
  e.preventDefault();
  // 서버 상태 반영 전에 연달아 눌러도 누적되도록 선택 상자 값을 기준으로 계산
  const sel = $('#selSpeed');
  const cur = Number(sel.value) || 1;
  const v = e.key === '-' ? [...SPEEDS].reverse().find((x) => x < cur - 1e-9) : SPEEDS.find((x) => x > cur + 1e-9);
  if (v === undefined) return;
  sel.value = String(v);
  sel.classList.toggle('fast', v !== 1);
  cmd('timeScale', { value: v });
});

// ---------------------------------------------------------------- 직접교시 (핸드 가이딩) — public/js/directTeach.js
let dtStatusTimer = null;
function dtStatus({ text, level = 'info', hover } = {}) {
  const el = $('#dtStatus');
  el.textContent = text || '';
  el.className = `dt-status ${level}`;
  clearTimeout(dtStatusTimer);
  if (text && (level !== 'info' || !hover)) dtStatusTimer = setTimeout(() => { el.textContent = ''; }, level === 'info' ? 2500 : 3500);
}
const dt = new DirectTeach(view, {
  send: (name, args) => cmd(name, args),
  onStatus: dtStatus,
  onUndoChange: (n) => { $('#dtUndo').disabled = n === 0; $('#dtUndo').title = `되돌리기 (Ctrl+Z) — ${n}단계`; },
});
$('#dtSnap').innerHTML = SNAPS.map((x, i) => `<option value="${i}">${x.label}</option>`).join('');
const dtSeg = (id, v) => $$(`#${id} button`).forEach((b) => b.classList.toggle('active', b.dataset.v === v));

async function setDirectTeach(on) {
  const st = app.st;
  if (on && st) {
    // 직접교시는 TEACH 모드 + 서보 ON 에서 동작 (실제 협동로봇의 핸드 가이딩과 같은 조건)
    if (st.program?.status === 'running') { dtStatus({ text: '프로그램 실행 중에는 직접교시를 켤 수 없습니다', level: 'err' }); return; }
    if (st.safety?.estop) { dtStatus({ text: '비상정지 중', level: 'err' }); return; }
    if (st.mode !== 'TEACH') { const r = await cmd('mode', { mode: 'TEACH' }); if (r?.ok === false) return; }
    if (!st.servo) await cmd('servo', { on: true });
  }
  dt.setEnabled(on);
  $('#dtBar').classList.toggle('on', on);
  $('#dtToggle').textContent = on ? '✋ 직접교시 ON' : '✋ 직접교시';
  if (on) dtStatus({ text: 'TCP 핸들을 끌어 이동·회전, 로봇 링크를 끌어 관절 회전', level: 'info' });
}
$('#dtToggle').onclick = () => setDirectTeach(!dt.enabled);
$$('#dtMode button').forEach((b) => { b.onclick = () => { dt.setMode(b.dataset.v); dtSeg('dtMode', b.dataset.v); }; });
$$('#dtSpace button').forEach((b) => { b.onclick = () => { dt.setSpace(b.dataset.v); dtSeg('dtSpace', b.dataset.v); }; });
$('#dtSnap').onchange = (e) => { dt.setSnap(Number(e.target.value)); e.target.blur(); };
$('#dtUndo').onclick = () => dt.undoLast();
$('#dtGrip').onclick = () => {
  const g = app.st.gripperIO, closed = app.st.grip.closed;
  cmd('setDO', { n: g.close, v: !closed });
  if (closed && g.open && g.open !== g.close) { cmd('setDO', { n: g.open, v: true }); setTimeout(() => cmd('setDO', { n: g.open, v: false }), 300); }
};
$('#dtRecord').onclick = () => { $('#btnTeach').onclick(); dtStatus({ text: '현재 위치를 프로그램에 기록했습니다', level: 'info' }); };

// 상태에 맞춰 툴바 갱신 (모드·실행·비상정지로 조건이 깨지면 자동으로 끔)
function syncDirectTeachBar(st) {
  $('#dtGrip').textContent = st.grip.closed ? '그리퍼 열기' : '그리퍼 닫기';
  if (dt.enabled && (st.mode !== 'TEACH' || st.program?.status === 'running' || st.safety?.estop)) {
    setDirectTeach(false);
    dtStatus({ text: '직접교시 해제 (모드 변경·실행·비상정지)', level: 'warn' });
  }
}

// 단축키 (입력칸 밖): T 켜기/끄기 — 켜진 동안 W 이동, E 회전, Q BASE/TOOL, X 스냅, G 그리퍼, Enter 위치 기록, Ctrl+Z 되돌리기, Esc 끄기
document.addEventListener('keydown', (e) => {
  if (e.altKey || e.metaKey || !app.st) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])') || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  if (k === 't' && !e.ctrlKey) { e.preventDefault(); setDirectTeach(!dt.enabled); return; }
  if (!dt.enabled) return;
  if (e.ctrlKey && k === 'z') { e.preventDefault(); dt.undoLast(); return; }
  if (e.ctrlKey) return;
  const act = {
    w: () => $('#dtMode button[data-v="translate"]').click(),
    e: () => $('#dtMode button[data-v="rotate"]').click(),
    q: () => $(`#dtSpace button[data-v="${dt.space === 'world' ? 'tool' : 'world'}"]`).click(),
    x: () => { const i = (dt.snap + 1) % SNAPS.length; $('#dtSnap').value = String(i); dt.setSnap(i); dtStatus({ text: SNAPS[i].label, level: 'info' }); },
    g: () => $('#dtGrip').click(),
    enter: () => $('#dtRecord').click(),
    escape: () => setDirectTeach(false),
  }[k];
  if (act) { e.preventDefault(); act(); }
});

// ---------------------------------------------------------------- 티칭: 현재 위치를 제조사 문법으로 삽입
$('#btnTeach').onclick = () => {
  const st = app.st;
  const t = st.tcp.map((v) => f2(v, 3));
  const j = st.joints.map((v) => f2(v, 3));
  const text = editor.text;
  switch (st.vendor) {
    case 'yaskawa': {
      // //POS 섹션에 C 포인트 추가 + 커서 위치에 MOVL
      const nums = [...text.matchAll(/^C(\d{5})=/gm)].map((m) => Number(m[1]));
      const n = nums.length ? Math.max(...nums) + 1 : 0;
      const tag = `C${String(n).padStart(5, '0')}`;
      const lines = text.split('\n');
      const lastC = lines.map((l, i) => (/^C\d{5}=/.test(l) ? i : -1)).filter((i) => i >= 0).pop();
      if (lastC !== undefined) {
        const lineNo = editor.ta.value.slice(0, editor.ta.selectionStart).split('\n').length - 1;
        lines.splice(lastC + 1, 0, `${tag}=${t.join(',')}`);
        const np = lines.findIndex((l) => l.startsWith('///NPOS'));
        if (np >= 0) lines[np] = lines[np].replace(/^\/\/\/NPOS (\d+)/, (_, c) => `///NPOS ${Number(c) + 1}`);
        editor.ta.value = lines.join('\n');
        const off = lines.slice(0, lineNo + 1 + (lastC < lineNo ? 1 : 0)).join('\n').length;
        editor.ta.selectionStart = editor.ta.selectionEnd = off;
      }
      editor.insertAtCursor(`MOVL ${tag} V=250.0`);
      break;
    }
    case 'kawasaki': editor.insertAtCursor(`  LMOVE TRANS(${t.join(', ')})`); break;
    case 'hyundai': editor.insertAtCursor(`MOVE L,(${t.join(',')}),S=250mm/sec,A=0,T=0`); break;
    case 'abb': {
      const tool = /tooldata\s+(\w+)/i.exec(text)?.[1] ?? 'tool0';
      const cf = [0, 3, 5].map((i) => Math.floor(st.joints[i] / 90));
      editor.insertAtCursor(`    MoveL [[${t.slice(0, 3).join(',')}],[${st.tcp.slice(3).map((v) => f2(v, 6)).join(',')}],[${cf.join(',')},0],[9E9,9E9,9E9,9E9,9E9,9E9]], v200, fine, ${tool};`);
      break;
    }
    case 'doosan': editor.insertAtCursor(`movel(posx(${t.join(', ')}), vel=250, acc=1000)`); break;
    case 'kuka': editor.insertAtCursor(`LIN {X ${t[0]}, Y ${t[1]}, Z ${t[2]}, A ${t[3]}, B ${t[4]}, C ${t[5]}}`); break;
  }
  addLog({ t: Date.now(), src: 'system', msg: `현재 위치 삽입 (관절: ${j.join(', ')})` });
};

// ---------------------------------------------------------------- 탭
$$('.tabs button').forEach((b) => (b.onclick = () => {
  $$('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $$('#left .tab').forEach((t) => t.classList.toggle('active', t.id === b.dataset.tab));
}));

// ---------------------------------------------------------------- 브레이크포인트 (라인 번호 클릭)
editor.onGutterClick = (line) => {
  if (!app.openFile) return;
  const key = `${app.openFile}:${line}`;
  const set = new Set(app.st?.breakpoints || []);
  set.has(key) ? set.delete(key) : set.add(key);
  cmd('breakpoints', { list: [...set] });
};

// ---------------------------------------------------------------- 프로젝트
const dlg = $('#projDlg');
async function refreshProjects() {
  const r = await cmd('projectList');
  $('#projCur').textContent = r.current ? `— 현재: ${r.current}` : '';
  if (r.current && !$('#projName').value) $('#projName').value = r.current;
  $('#projList').innerHTML = r.projects.length ? r.projects.map((p) => `
    <div class="pi" data-n="${p.name}"><span class="nm">${p.name}</span>
      <span class="mt">${p.robotId ?? ''} · ${p.savedAt ? new Date(p.savedAt).toLocaleString() : ''}</span>
      <button type="button" data-a="load">불러오기</button><button type="button" data-a="del">삭제</button></div>`).join('')
    : '<div class="empty">저장된 프로젝트가 없습니다.</div>';
  $$('#projList button').forEach((b) => (b.onclick = async () => {
    const n = b.closest('.pi').dataset.n;
    if (b.dataset.a === 'load') {
      if (app.dirty.size && !confirm('저장하지 않은 편집 내용이 있습니다. 불러오면 사라집니다. 계속할까요?')) return;
      app.dirty.clear(); app.buffers = {};
      await cmd('projectLoad', { name: n });
      dlg.close();
    } else if (confirm(`프로젝트 '${n}' 을(를) 삭제할까요?`)) { await cmd('projectDelete', { name: n }); refreshProjects(); }
  }));
}
$('#btnProject').onclick = () => { refreshProjects(); dlg.showModal(); };
$('#projSave').onclick = async () => {
  const n = $('#projName').value.trim();
  if (!n) return alert('프로젝트 이름을 입력하세요');
  await saveAll();
  await cmd('projectSave', { name: n });
  refreshProjects();
};
$('#projExport').onclick = async () => {
  await saveAll();
  const r = await cmd('projectExport', { name: $('#projName').value.trim() || undefined });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(r.project, null, 1)], { type: 'application/json' }));
  a.download = `${r.project.name || 'project'}.json`;
  a.click();
};
$('#projImport').onclick = () => $('#projFile').click();
$('#projFile').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    app.dirty.clear(); app.buffers = {};
    await cmd('projectImport', { project: JSON.parse(await f.text()) });
    dlg.close();
  } catch (err) { alert(`가져오기 실패: ${err.message}`); }
};

const dbg = initDebugPanels({ cmd });
initSysioPanel({ cmd, getState: () => app.st });
initCellPanel({ cmd, view, getState: () => app.st });
initChatPanel({ send: (msg) => ws?.readyState === 1 && ws.send(JSON.stringify(msg)) });
initCameraPanel({ cmd, view, getState: () => app.st, getModel: () => app.robots.find((r) => r.id === app.robotId) });
connect();
