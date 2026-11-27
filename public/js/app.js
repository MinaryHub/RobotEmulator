// 웹 UI 메인: 서버(WebSocket)와 상태 동기화, 3D 뷰/에디터/패널 구동
import { lang as uiLang } from './i18n.js';   // 가장 먼저: 화면 언어 (English 면 DOM 문구를 번역)
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
import { initFaultPanel, renderFaultPanel } from './faultPanel.js';
import { ioLabelMap, escHtml, labelsToCsv, csvToLabels } from './ioLabels.js';
import { initAboutPanel, onAbout, onRestarting } from './aboutPanel.js';
import { extractPointAtLine, touchUpAtLine } from '/shared/teachOps.js';
import { xyzrpyFromFrame } from '/shared/poseformat.js';
import { RfromQuat } from '/shared/math.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const f2 = (v, d = 2) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);
// 텍스트가 바뀐 경우에만 DOM textContent 쓰기 (30 Hz 상태 수신 시 i18n MutationObserver 재실행 방지)
const setText = (el, s) => { if (el && el.textContent !== s) el.textContent = s; };

const app = {
  robots: [], grippers: [], vendors: {}, comms: [], protocolMode: 'vendor',
  st: null, robotId: null, gripperKey: null,
  files: {}, buffers: {}, dirty: new Set(), main: null, openFile: null, cursorLine: 1,
  customGeom: null, jogFrame: 'base', jogStep: 0, ioBase: 1,
  frameEditKind: 'user', uf3pt: { origin: null, xPoint: null, xyPoint: null }, framesSig: '',
  aioKind: 'ai', ioGroupSig: '', aioSig: '',
};

const view = new RobotView($('#viewport'));
const editor = new CodeEditor($('#editor'));
editor.onChange = () => { if (app.openFile) { app.buffers[app.openFile] = editor.text; app.dirty.add(app.openFile); renderFileTabs(); } };
editor.onCursor = ({ line, col }) => { app.cursorLine = line; setText($('#edCursor'), `Ln ${line}, Col ${col}`); };

// ---------------------------------------------------------------- WebSocket (지수 백오프 재연결)
let ws, reqId = 0, reconnectMs = 1000, reconnectTimer = null;
const pending = new Map();
function isWsOpen() { return !!ws && ws.readyState === WebSocket.OPEN; }
function stopJog() {
  if (jogTimer) {
    clearInterval(jogTimer);
    jogTimer = null;
    if (isWsOpen()) ws.send(JSON.stringify({ cmd: 'jogStop' }));
  }
}
function connect() {
  clearTimeout(reconnectTimer);
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    reconnectMs = 1000;
    setPill($('#stConn'), '연결됨', 'on');
    $('#connBanner')?.classList.add('hidden');
    ws.send(JSON.stringify({ cmd: 'uiLang', lang: uiLang }));   // 예제 프로그램 주석 언어
  };
  ws.onclose = () => {
    stopJog();
    setPill($('#stConn'), '연결 끊김', 'off');
    $('#connBanner')?.classList.remove('hidden');
    // 응답을 기다리던 명령은 실패로 끝냄 (그대로 두면 저장·시작 버튼이 영원히 대기)
    for (const p of pending.values()) p.rej(new Error('서버 연결이 끊겼습니다'));
    pending.clear();
    const wait = reconnectMs;
    reconnectMs = Math.min(10000, Math.round(reconnectMs * 1.5));
    reconnectTimer = setTimeout(connect, wait);
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'init') onInit(m);
    else if (m.type === 'state') onState(withSticky(m.state));
    else if (m.type === 'log') addLog(m.entry);
    else if (m.type === 'logs') m.entries.forEach(addLog);
    else if (m.type === 'files') onFiles(m);
    else if (m.type === 'comms') { app.comms = m.comms; if (m.protocolMode) app.protocolMode = m.protocolMode; renderComms(); }
    else if (m.type === 'tl') dbg.onTimeline(m);
    else if (m.type === 'traffic') dbg.onTraffic(m);
    else if (m.type === 'trafficClear') dbg.onTrafficClear();
    else if (m.type === 'chat') onChatEvent(m);
    else if (m.type === 'about') onAbout(m.about);
    else if (m.type === 'restarting') onRestarting(m.tag);
    // 명령 오류는 error 필드로 구분 (start/servo 등은 거부 시 ok:false + reject 를 정상 응답으로 돌려줌)
    else if (m.type === 'reply') { const p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.timer); m.ok || m.error === undefined ? p.res(m) : p.rej(new Error(m.error)); } }
  };
}
// 서버가 바뀌지 않았다고 생략한 상태 항목은 직전 값으로 채움 (server/index.js STICKY 와 같은 목록)
const STICKY = ['sysio', 'cell', 'scene', 'safety', 'ioLabels', 'gripperIO', 'cameras', 'faults', 'frames', 'zones', 'vision'];
function withSticky(st) {
  if (app.st) for (const k of STICKY) if (!(k in st) && k in app.st) st[k] = app.st[k];
  return st;
}
const CMD_TIMEOUT_MS = 20000;
// 명령 전송 → 응답 Promise. 실패하면 로그와 알림(토스트)에 표시하고 거부.
// 호출부가 오류를 처리하지 않아도 되도록 버튼 핸들러용 run() 은 오류를 삼킨다
function cmd(name, args = {}) {
  return new Promise((res, rej) => {
    if (!isWsOpen()) { rej(new Error('서버에 연결되어 있지 않습니다')); return; }
    const id = ++reqId;
    const timer = setTimeout(() => { if (pending.delete(id)) rej(new Error(`응답 시간 초과 (${name})`)); }, CMD_TIMEOUT_MS);
    pending.set(id, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); }, timer });
    ws.send(JSON.stringify({ ...args, cmd: name, rid: id }));   // rid: 요청 번호 (args.id 는 로봇·프리셋 id)
  }).catch((e) => {
    addLog({ t: Date.now(), src: 'alarm', msg: e.message });
    showToast(`<b>명령 실패 (${escHtml(name)})</b> — ${escHtml(e.message)}`);
    throw e;
  });
}
// 이벤트 핸들러에서 쓰는 형태: 오류는 이미 표시했으므로 처리되지 않은 거부로 남기지 않음
const run = (name, args) => cmd(name, args).catch(() => undefined);

function applyChatVisibility() {
  let prefHide = false;
  try { prefHide = localStorage.getItem('hideChat') === '1'; } catch {}
  const serverOff = app.aiEnabled === false;
  const hidden = serverOff || prefHide;
  $('#btnChat')?.classList.toggle('hidden', hidden);
  $('#chat')?.classList.toggle('hidden', hidden);
  if (hidden) document.querySelector('main')?.classList.remove('chat-open');
  const chk = $('#chkHideChat');
  if (chk) { chk.checked = hidden; chk.disabled = serverOff; }
}
$('#chkHideChat')?.addEventListener('change', (e) => {
  try { localStorage.setItem('hideChat', e.target.checked ? '1' : '0'); } catch {}
  applyChatVisibility();
});
applyChatVisibility();

function onInit(m) {
  Object.assign(app, { robots: m.robots, grippers: m.grippers, vendors: m.vendors, comms: m.comms, protocolMode: m.protocolMode || 'vendor', aiEnabled: m.aiEnabled !== false });
  applyChatVisibility();
  $('#log').innerHTML = '';
  m.logs.forEach(addLog);
  buildSelectors();
  buildGripperCards();
  onFiles(m.files);
  onState(m.state);
  renderComms();
  onChatReconnect();
  loadSysioPresets();
  onAbout(m.about, { fromInit: true });
}

// ---------------------------------------------------------------- 상태 반영
function onState(st) {
  const prev = app.st;
  app.st = st;
  const model = app.robots.find((r) => r.id === st.robotId);
  if (!model) return;
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
    // 다른 기종의 관절값으로 되돌리지 않도록 직접교시 되돌리기 기록 초기화
    dt.undo = []; dt.onUndoChange(0); if (dt.enabled) setDirectTeach(false);
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
  setText($('#btnServo'), st.servo ? '서보 OFF' : '서보 ON');
  setText($('#stMode'), st.mode);
  $$('#segMode button').forEach((b) => b.classList.toggle('active', b.dataset.v === st.mode));
  const ps = st.program.status;
  setPill($('#stProg'), st.held && ps === 'running' ? 'HOLD' : ps.toUpperCase(), st.held && ps === 'running' ? 'hold' : ps === 'running' ? 'run' : ps === 'error' ? 'off' : '');
  $('#stAlarm').classList.toggle('hidden', !st.alarms.length);
  const alarmTxt = st.alarms.slice(-3).map((a) => `⚠ [${a.code}${a.vendorCode ? ` / ${a.vendorCode}` : ''}] ${a.msg}`).join('\n');
  setText($('#ovAlarm'), alarmTxt);
  if (document.activeElement !== $('#ovRange')) { $('#ovRange').value = st.override; }
  setText($('#ovVal'), `${st.override}%`);
  const payMass = st.payload?.mass ?? 0;
  if (document.activeElement !== $('#inpPayload')) $('#inpPayload').value = String(payMass);
  const payOver = model.payload > 0 && payMass > model.payload;
  setText($('#payVal'), `${payMass} kg${payOver ? ' ⚠' : ''}`);
  // 홀드 중 경로 이탈 경고 배너
  const pr = st.pathRecovery;
  const prBar = $('#pathRecBar');
  if (prBar) {
    const showPr = !!(pr?.deviated || pr?.recovering);
    prBar.classList.toggle('hidden', !showPr);
    if (showPr) {
      setText($('#pathRecMsg'), pr.recovering ? '↩ 원경로(홀드 위치)로 저속 복귀 중…' : `⚠ 홀드 중 경로 이탈 (${pr.maxDeg}°)`);
      $('#btnRecoverPath').disabled = !!pr.recovering;
    }
  }

  renderPose(st, model);
  renderFrames(st);
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
  renderFaultPanel(st);
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
  setText(eb, sf.estopUI ? '비상정지 해제' : '비상정지');
  $('#stEstop').classList.toggle('hidden', !sf.estopExt);
  const modeNote = st.mode === 'TEACH' && sf.teachSpeedLimit !== false
    ? `${MODE_NOTE.TEACH} · TCP 250 mm/s 제한`
    : (MODE_NOTE[st.mode] ?? '');
  setText($('#modeNote'), modeNote);
  if (document.activeElement !== $('#chkInterlock')) $('#chkInterlock').checked = !!st.interlock;
  if (document.activeElement !== $('#chkReqEnable')) $('#chkReqEnable').checked = !!sf.requireEnable;
  if (document.activeElement !== $('#chkTeachLimit')) $('#chkTeachLimit').checked = sf.teachSpeedLimit !== false;
  if (document.activeElement !== $('#selPathRecovery')) $('#selPathRecovery').value = sf.pathRecovery || 'auto';
  if (document.activeElement !== $('#selFenceStop')) $('#selFenceStop').value = sf.fenceStop || 'stop1';
  const fb = $('#btnFence');
  setText(fb, `안전 펜스: ${sf.fenceOpen ? '열림' : '닫힘'}`);
  fb.classList.toggle('warn', !!sf.fenceOpen);
  const en = $('#btnEnable');
  en.disabled = !sf.requireEnable;
  setText(en, `인에이블 ${sf.enable ? 'ON' : 'OFF'}`);
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
  const r = await cmd(name, args).catch(() => null);
  if (r && r.ok === false) noteReject(r.reject);
  return r || {};
}
$('#btnEstop').onclick = () => run('safety', { estop: !app.st?.safety?.estopUI });
$('#chkInterlock').onchange = (e) => run('safety', { interlock: e.target.checked });
$('#chkReqEnable').onchange = (e) => run('safety', { requireEnable: e.target.checked });
$('#chkTeachLimit').onchange = (e) => run('safety', { teachSpeedLimit: e.target.checked });
$('#selPathRecovery').onchange = (e) => run('safety', { pathRecovery: e.target.value });
$('#inpPayload').onchange = (e) => run('setPayload', { mass: Math.max(0, Number(e.target.value) || 0) });
$('#btnRecoverPath').onclick = () => run('recoverPath');
$('#selFenceStop').onchange = (e) => run('safety', { fenceStop: e.target.value });
$('#btnFence').onclick = () => run('safety', { fence: !app.st?.safety?.fenceOpen });
$('#btnEnable').onclick = () => run('safety', { enable: !app.st?.safety?.enable });

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
$$('#segColl button').forEach((b) => (b.onclick = () => run('collisionMode', { mode: b.dataset.v })));
function setCapsules(on) {
  $('#chkCaps').checked = !!on;
  $('#hudCaps')?.classList.toggle('active', !!on);
  if (!on) view.showCapsules?.(false); else app.st && onState(app.st);
}
$('#chkCaps').onchange = (e) => setCapsules(e.target.checked);

// ---------------------------------------------------------------- 사이클 타임
function renderCycle(st) {
  const cy = st.cycle || {};
  const last = cy.last;
  setText($('#cycNow'), cy.elapsed != null ? `${cy.elapsed.toFixed(2)} s ▶` : last ? `${last.total.toFixed(2)} s` : '-');
  if (document.activeElement !== $('#chkBlend')) $('#chkBlend').checked = st.blendEnabled !== false;
  syncSpeed(st.timeScale ?? 1);
  if (document.activeElement !== $('#chkSpeedLock')) $('#chkSpeedLock').checked = !!st.lockTimeScaleOnExt;
  const speedMismatch = (st.timeScale ?? 1) !== 1 && ((st.extClients || 0) > 0 || st.mode === 'REMOTE');
  $('#speedWarn')?.classList.toggle('hidden', !speedMismatch);
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
    ${last.lines.map((l) => `<tr data-f="${escHtml(l.file ?? '')}" data-l="${l.line ?? ''}"><td>${escHtml(l.file ?? '')}:${l.line ?? ''}</td><td>${{ motion: '모션', wait: '대기', logic: '기타' }[l.cat] ?? ''}</td><td>${l.count}</td><td>${l.time.toFixed(3)}</td><td>${pct(l.time * 1).toFixed(1)}</td></tr>`).join('')}
    </table>
    <div class="hist">최근 사이클: ${hist}  (* 블렌딩 OFF)</div>`;
  $$('#cycDetail tr[data-l]').forEach((tr) => (tr.onclick = () => {
    if (tr.dataset.f && app.buffers[tr.dataset.f] !== undefined) openFile(tr.dataset.f);
    editor.setExecLine(Number(tr.dataset.l), true);
  }));
}
$('#chkAutoScene').onchange = (e) => run('autoResetScene', { on: e.target.checked });
$('#chkSpeedLock').onchange = (e) => run('timeScaleLock', { on: e.target.checked });
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
$('#chkBlend').onchange = (e) => run('blend', { on: e.target.checked });
$('#btnCycDetail').onclick = (e) => { const d = $('#cycDetail'); d.classList.toggle('hidden'); setText(e.target, d.classList.contains('hidden') ? '상세 ▾' : '상세 ▴'); };

function setPill(el, text, cls) {
  if (!el) return;
  setText(el, text);
  const c = `pill ${cls || ''}`;
  if (el.className !== c) el.className = c;
}

function renderPose(st, model) {
  const vd = app.vendors[model.vendor];
  const jn = vd.jointNames;
  const pn = vd.poseNames;
  const jointsTxt = st.joints.map((v, i) => `${jn[i].padEnd(5)} ${f2(v, 3).padStart(9)}°`).join('\n');
  const rad = vd.rotUnit === 'rad';   // UR: 회전 벡터 (rad)
  const poseTxt = st.tcp.map((v, i) => `${pn[i].padEnd(3)} ${f2(v, i < 3 ? 2 : (pn.length === 7 || rad ? 5 : 3)).padStart(10)}${i < 3 ? 'mm' : pn.length === 7 ? '' : rad ? 'r' : '°'}`).join('\n');
  const fr = st.frames;
  const frTag = fr && (fr.activeTool > 0 || fr.activeUser > 0) ? `\nT#${fr.activeTool} · U#${fr.activeUser}` : '';
  setText($('#ovPose'), `${vd.name} ${model.name}\n${jointsTxt}\n────────────────\n${poseTxt}\n그리퍼 ${(st.grip.pos * 100).toFixed(0)}% ${st.grip.holding ? '· ' + st.grip.holding : ''}${frTag}`);
  if ($('#tJog').classList.contains('active')) {
    setText($('#posView'), `${jointsTxt}\n\n${poseTxt}`);
    st.joints.forEach((v, i) => {
      const el = document.getElementById(`jv${i}`);
      if (!el) return;
      const numStr = f2(v, 2);
      if (el.firstChild.textContent !== numStr) el.firstChild.textContent = numStr;
      const [lo, hi] = model.limits[i];
      const frac = Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1)));
      el.querySelector('i').style.left = `${(frac * 100).toFixed(1)}%`;
      el.classList.toggle('lim', frac <= 0.015 || frac >= 0.985);
      el.classList.toggle('near', (frac > 0.015 && frac <= 0.06) || (frac >= 0.94 && frac < 0.985));
    });
  }
}

function renderProgram(st) {
  const p = st.program;
  const cur = p.current;
  setText($('#ovProg'), `프로그램 ${p.main ?? '-'}\n상태 ${p.status.toUpperCase()}${st.held ? ' (HOLD)' : ''}\n${cur ? `${cur.proc ?? ''} ${cur.file ?? ''}:${cur.line ?? ''}` : ''}\n사이클 ${p.cycle}  OV ${st.override}%${(st.timeScale ?? 1) !== 1 ? `  ×${st.timeScale}` : ''}`);
  const bpPrefix = `${app.openFile}:`;
  editor.setBreakpoints((st.breakpoints || []).filter((b) => b.startsWith(bpPrefix)).map((b) => Number(b.slice(bpPrefix.length))));
  const running = p.status === 'running' || p.status === 'paused';
  editor.setExecLine((running || p.ppCustom) && cur && cur.file === app.openFile ? cur.line : null, running);
  if (running && cur?.file && cur.file !== app.openFile && app.files[cur.file] !== undefined && !app.dirty.has(app.openFile)) openFile(cur.file);
  const ce = p.compileError;
  const cm = $('#compileMsg');
  if (ce) {
    if (cm.className !== 'cmsg err') cm.className = 'cmsg err';
    setText(cm, `✖ ${ce.file ?? ''}${ce.line ? ':' + ce.line : ''} ${ce.msg}`);
    editor.setErrLine(ce.file === app.openFile ? ce.line : null);
  } else {
    if (cm.className !== 'cmsg') cm.className = 'cmsg';
    setText(cm, p.main ? `✔ ${p.main} 컴파일 OK` : '');
    editor.setErrLine(null);
  }
  if (app.main !== p.main) { app.main = p.main; renderFileTabs(); }
}

// ---------------------------------------------------------------- 선택기/사양
function buildSelectors() {
  $('#selVendor').innerHTML = Object.entries(app.vendors).map(([k, v]) => `<option value="${escHtml(k)}">${escHtml(v.name)}</option>`).join('');
  $('#selGripper').innerHTML = app.grippers.map((g) => `<option value="${escHtml(g.id)}">${escHtml(g.maker === '-' ? '' : g.maker + ' ')}${escHtml(g.name)}</option>`).join('') + '<option value="" disabled>사용자 STL</option>';
}
function fillRobotSelect(vendor) {
  $('#selRobot').innerHTML = app.robots.filter((r) => r.vendor === vendor).map((r) => `<option value="${escHtml(r.id)}">${escHtml(r.name)}  (${r.payload}kg / ${r.reach}mm)</option>`).join('');
}
$('#selVendor').onchange = (e) => { const r = app.robots.find((x) => x.vendor === e.target.value); if (r) confirmSwitch(r.id); };
$('#selRobot').onchange = (e) => confirmSwitch(e.target.value);
$('#selGripper').onchange = (e) => e.target.value && run('setGripper', { id: e.target.value });

function confirmSwitch(id) {
  const target = app.robots.find((r) => r.id === id);
  const cur = app.robots.find((r) => r.id === app.robotId);
  if (!target) return;
  if (cur && target.vendor !== cur.vendor && app.dirty.size && !confirm('저장하지 않은 프로그램 변경이 있습니다. 제조사를 바꾸면 프로그램이 교체됩니다. 계속할까요?')) {
    $('#selVendor').value = cur.vendor; fillRobotSelect(cur.vendor); $('#selRobot').value = cur.id; return;
  }
  if (target.vendor !== cur?.vendor) { app.dirty.clear(); app.buffers = {}; }
  run('setRobot', { id });
}

function renderSpec(m) {
  const v = app.vendors[m.vendor];
  const rows = m.limits.map((l, i) => `<tr><td style="text-align:left">${escHtml(v.jointNames[i])}</td><td>${l[0]}</td><td>${l[1]}</td><td>${m.maxSpeed[i]}</td></tr>`).join('');
  $('#robotSpec').innerHTML = `
    <span>제조사</span><span>${escHtml(v.name)}</span>
    <span>모델</span><span>${escHtml(m.name)}</span>
    <span>컨트롤러</span><span>${escHtml(v.controller)}</span>
    <span>로봇 언어</span><span>${escHtml(v.language)} (${escHtml(v.ext)})</span>
    <span>가반하중</span><span>${m.ratedPayload ? `최대 ${m.payload} kg (정격 ${m.ratedPayload} kg)` : `${m.payload} kg`}</span>
    <span>최대 도달</span><span>${m.reach} mm</span>
    <span>반복정밀도</span><span>±${m.repeatability ?? '-'} mm</span>
    ${m.dh ? `<span>DH (mm)</span><span style="font-family:var(--mono);font-size:11px">d1 ${m.dh.d1} a2 ${m.dh.a2} a3 ${m.dh.a3}<br>d4 ${m.dh.d4} d5 ${m.dh.d5} d6 ${m.dh.d6}</span>` : `<span>OPW (mm)</span><span style="font-family:var(--mono);font-size:11px">a1 ${m.opw.a1} a2 ${m.opw.a2} c1 ${m.opw.c1}<br>c2 ${m.opw.c2} c3 ${m.opw.c3} c4 ${m.opw.c4}</span>`}
    ${uiLang === 'ko' ? `<span>출처</span><span style="font-size:11px;color:var(--dim)">${escHtml(m.source ?? '-')}</span>` : ''}
    <table><tr><th style="text-align:left">축</th><th>-한계°</th><th>+한계°</th><th>속도°/s</th></tr>${rows}</table>`;
}

function buildGripperCards() {
  const kindName = { none: '-', parallel: '평행 그리퍼', adaptive2f: '2지 어댑티브', threefinger: '3지 어댑티브', vacuum: '진공', magnet: '자석', torch: '용접 토치', spindle: '스핀들' };
  $('#gripperList').innerHTML = app.grippers.map((g) => `
    <div class="card" data-id="${escHtml(g.id)}">
      <div class="t">${escHtml(g.name)}</div>
      <div class="m">${escHtml(g.maker)} · ${kindName[g.kind]}</div>
      ${g.kind === 'none' ? '' : `<div class="d">TCP Z ${g.tcp[2]}mm${g.tcp[1] ? ` Y ${g.tcp[1]}` : ''}${g.tcp[3] ? ` Rx ${g.tcp[3]}°` : ''} · ${g.mass}kg${g.stroke ? ` · 행정 ${g.stroke}mm` : ''}${g.force ? ` · ${escHtml(g.force)}` : ''}</div>`}
    </div>`).join('');
  $$('#gripperList .card').forEach((c) => (c.onclick = () => run('setGripper', { id: c.dataset.id })));
}

$('#btnCustomGripper').onclick = async () => {
  const f = $('#stlFile').files[0];
  if (!f) return alert('STL 파일을 선택하세요');
  const geom = new STLLoader().parse(await f.arrayBuffer());
  const s = Number($('#cgUnit').value);
  geom.scale(s, s, s);
  geom.computeVertexNormals();
  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  const bounds = bb ? { min: [bb.min.x, bb.min.y, bb.min.z], max: [bb.max.x, bb.max.y, bb.max.z] } : null;
  app.customGeom?.dispose?.();
  app.customGeom = geom;
  app.gripperKey = null;
  run('customGripper', { def: { name: f.name, kind: $('#cgKind').value, stroke: Number($('#cgStroke').value), tcp: [Number($('#cgX').value), Number($('#cgY').value), Number($('#cgZ').value), 0, 0, 0], bounds } });
};

function renderGripIO(st) {
  $$('#gripIO input').forEach((inp) => { if (document.activeElement !== inp) inp.value = st.gripperIO[inp.dataset.k] ?? ''; });
}
$$('#gripIO input').forEach((inp) => (inp.onchange = () => run('gripperIO', { map: { [inp.dataset.k]: Number(inp.value) || 0 } })));

// ---------------------------------------------------------------- 조그 (연속 + 스텝)
function buildJog(model) {
  const vd = app.vendors[model.vendor];
  $('#jogJoints').innerHTML = vd.jointNames.map((n, i) => `
    <span class="n">${escHtml(n)}</span><button data-t="joint" data-a="${i}" data-d="-1" aria-label="${escHtml(n)} −">−</button>
    <div class="v" id="jv${i}">0<div class="bar"><i></i></div></div><button data-t="joint" data-a="${i}" data-d="1" aria-label="${escHtml(n)} +">+</button>`).join('');
  const cn = ['X', 'Y', 'Z', 'Rx', 'Ry', 'Rz'];
  $('#jogCart').innerHTML = cn.map((n, i) => `
    <span class="n">${n}</span><button data-t="cart" data-a="${i}" data-d="-1" aria-label="${n} −">−</button>
    <div class="v">${i < 3 ? 'mm' : 'deg'}</div><button data-t="cart" data-a="${i}" data-d="1" aria-label="${n} +">+</button>`).join('');
  $$('.jog button').forEach(bindJog);
}
let jogTimer = null;
function bindJog(btn) {
  const start = (e) => {
    e.preventDefault();
    if (!app.st?.servo) { addLog({ t: Date.now(), src: 'system', msg: '조그하려면 서보를 ON 하세요' }); return; }
    if (!isWsOpen()) return;
    if (app.jogStep > 0) {
      cmdChecked('stepJog', { type: btn.dataset.t, axis: Number(btn.dataset.a), dir: Number(btn.dataset.d), step: app.jogStep, frame: app.jogFrame });
      return;
    }
    const jog = { type: btn.dataset.t, axis: Number(btn.dataset.a), dir: Number(btn.dataset.d), speed: Number($('#jogSp').value) / 100, frame: app.jogFrame };
    const tick = () => { if (isWsOpen()) ws.send(JSON.stringify({ cmd: 'jog', jog })); else stopJog(); };
    tick();
    clearInterval(jogTimer);
    jogTimer = setInterval(tick, 150);
  };
  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', stopJog);
  btn.addEventListener('pointerleave', stopJog);
  btn.addEventListener('pointercancel', stopJog);
}
window.addEventListener('blur', stopJog);
$('#jogSp').oninput = (e) => setText($('#jogSpVal'), `${e.target.value}%`);
$$('#segFrame button').forEach((b) => (b.onclick = () => { app.jogFrame = b.dataset.v; $$('#segFrame button').forEach((x) => x.classList.toggle('active', x === b)); }));
$$('#segJogStep button').forEach((b) => (b.onclick = () => { app.jogStep = Number(b.dataset.v) || 0; $$('#segJogStep button').forEach((x) => x.classList.toggle('active', x === b)); }));

// ---------------------------------------------------------------- Tool / User 좌표계 관리 & 3점 티칭
function loadFrameEditFields() {
  const fr = app.st?.frames;
  if (!fr) return;
  const kind = app.frameEditKind;
  const id = Number($('#selEditFrameId').value) || 1;
  const arr = kind === 'tool' ? fr.tools : fr.users;
  const entry = arr?.[id - 1];
  if (!entry) return;
  $('#inpFrameName').value = entry.name || '';
  const ids = ['#frX', '#frY', '#frZ', '#frRx', '#frRy', '#frRz'];
  ids.forEach((sel, i) => { $(sel).value = Number((entry.pose?.[i] ?? 0).toFixed(3)); });
  $('#uf3ptBox').classList.toggle('hidden', kind !== 'user');
}
function renderFrames(st) {
  const fr = st?.frames;
  if (!fr) return;
  const sig = JSON.stringify(fr);
  if (app.framesSig === sig) return;
  app.framesSig = sig;
  const tSel = $('#selToolFrame');
  const uSel = $('#selUserFrame');
  const eSel = $('#selEditFrameId');
  if (tSel && document.activeElement !== tSel) {
    tSel.innerHTML = `<option value="0">#0 그리퍼 기본</option>` + fr.tools.map((x) => `<option value="${x.id}">#${x.id} ${escHtml(x.name)}</option>`).join('');
    tSel.value = String(fr.activeTool || 0);
  }
  if (uSel && document.activeElement !== uSel) {
    uSel.innerHTML = `<option value="0">#0 로봇 베이스</option>` + fr.users.map((x) => `<option value="${x.id}">#${x.id} ${escHtml(x.name)}</option>`).join('');
    uSel.value = String(fr.activeUser || 0);
  }
  if (eSel && !eSel.options.length) {
    eSel.innerHTML = fr.users.map((x) => `<option value="${x.id}">#${x.id}</option>`).join('');
    eSel.value = '1';
  }
  if (!$('#frameEditor').classList.contains('hidden')) loadFrameEditFields();
}
$('#selToolFrame').onchange = (e) => run('setActiveFrames', { activeTool: Number(e.target.value) });
$('#selUserFrame').onchange = (e) => run('setActiveFrames', { activeUser: Number(e.target.value) });
$('#btnFrameEdit').onclick = (e) => {
  const ed = $('#frameEditor');
  ed.classList.toggle('hidden');
  setText(e.target, ed.classList.contains('hidden') ? '편집 ▾' : '편집 ▴');
  if (!ed.classList.contains('hidden')) {
    const fr = app.st?.frames;
    if (fr) {
      const active = app.frameEditKind === 'tool' ? fr.activeTool : fr.activeUser;
      if (active > 0) $('#selEditFrameId').value = String(active);
    }
    loadFrameEditFields();
  }
};
$$('#segFrameKind button').forEach((b) => (b.onclick = () => {
  app.frameEditKind = b.dataset.v;
  $$('#segFrameKind button').forEach((x) => x.classList.toggle('active', x === b));
  loadFrameEditFields();
}));
$('#selEditFrameId').onchange = () => loadFrameEditFields();
$('#btnFrameSave').onclick = async () => {
  const id = Number($('#selEditFrameId').value) || 1;
  const pose = ['#frX', '#frY', '#frZ', '#frRx', '#frRy', '#frRz'].map((s) => Number($(s).value) || 0);
  const name = $('#inpFrameName').value.trim();
  const r = await cmd('setFrame', { kind: app.frameEditKind, id, name, pose }).catch(() => null);
  if (r?.ok) showToast(`${app.frameEditKind === 'tool' ? 'Tool' : 'User'} #${id} 저장됨`, 'ok');
};
$('#btnFrameCopyTcp').onclick = () => {
  const tw = app.st?.tcpWorld;
  if (!tw) return;
  const pose = xyzrpyFromFrame({ p: tw.p, R: RfromQuat(tw.q) });
  ['#frX', '#frY', '#frZ', '#frRx', '#frRy', '#frRz'].forEach((s, i) => { $(s).value = Number(pose[i].toFixed(3)); });
};
function syncUf3pt() {
  const u = app.uf3pt;
  $('#btnUfP0').classList.toggle('done', !!u.origin);
  $('#btnUfPx').classList.toggle('done', !!u.xPoint);
  $('#btnUfPxy').classList.toggle('done', !!u.xyPoint);
  $('#btnUfApply').disabled = !(u.origin && u.xPoint && u.xyPoint);
  const fmt = (p) => (p ? `[${p.map((v) => f2(v, 1)).join(', ')}]` : '-');
  setText($('#uf3ptStatus'), `O:${fmt(u.origin)}  +X:${fmt(u.xPoint)}  +XY:${fmt(u.xyPoint)}`);
}
const captureUfPt = (key, label) => () => {
  const p = app.st?.tcpWorld?.p;
  if (!p) return;
  app.uf3pt[key] = [...p];
  syncUf3pt();
  showToast(`User Frame ${label} 캡처: [${p.map((v) => f2(v, 1)).join(', ')}]`, 'ok');
};
$('#btnUfP0').onclick = captureUfPt('origin', '원점');
$('#btnUfPx').onclick = captureUfPt('xPoint', '+X 점');
$('#btnUfPxy').onclick = captureUfPt('xyPoint', '+XY 점');
$('#btnUfApply').onclick = async () => {
  const id = Number($('#selEditFrameId').value) || 1;
  const name = $('#inpFrameName').value.trim() || undefined;
  const u = app.uf3pt;
  const r = await cmd('teachUserFrame3Pt', { id, origin: u.origin, xPoint: u.xPoint, xyPoint: u.xyPoint, name, activate: true }).catch(() => null);
  if (r?.ok) {
    app.uf3pt = { origin: null, xPoint: null, xyPoint: null };
    syncUf3pt();
    loadFrameEditFields();
    showToast(`User #${id} 3점 티칭 완료 및 활성화`, 'ok');
  }
};

// ---------------------------------------------------------------- 컨트롤러 버튼 · 3D HUD
$('#btnServo').onclick = () => app.st && cmdChecked('servo', { on: !app.st.servo });
$('#btnAlarmReset').onclick = () => run('resetAlarms');
$('#btnHome').onclick = () => run('moveHome');
$$('#segMode button').forEach((b) => (b.onclick = () => cmdChecked('mode', { mode: b.dataset.v })));
$('#ovRange').oninput = (e) => { setText($('#ovVal'), `${e.target.value}%`); run('override', { value: Number(e.target.value) }); };
$('#btnResetScene').onclick = () => run('resetScene');
function setTrailOn(on) {
  view.trailOn = !!on;
  setText($('#btnTrail'), `궤적 표시 ${view.trailOn ? 'ON' : 'OFF'}`);
  $('#hudTrail')?.classList.toggle('active', view.trailOn);
}
function setEnvelopeOn(on) {
  $('#chkEnv').checked = !!on;
  $('#hudEnv')?.classList.toggle('active', !!on);
  view.showEnvelope(!!on);
}
$('#btnTrail').onclick = () => setTrailOn(!view.trailOn);
$('#btnClearTrail').onclick = () => view.clearTrail();
$('#btnFit').onclick = () => view.fitView();
$('#chkEnv').onchange = (e) => setEnvelopeOn(e.target.checked);

$$('#viewHud button[data-cam]').forEach((b) => (b.onclick = () => view.setViewPreset(b.dataset.cam)));
$('#hudTrail').onclick = () => setTrailOn(!view.trailOn);
$('#hudEnv').onclick = () => setEnvelopeOn(!$('#chkEnv').checked);
$('#hudCaps').onclick = () => setCapsules(!$('#chkCaps').checked);

// ---------------------------------------------------------------- I/O (검색·필터 지원)
function renderIO(st) {
  if (!$('#tIO').classList.contains('active')) return;
  const base = app.ioBase;
  const q = ($('#ioSearch')?.value || '').trim().toLowerCase();
  const onlyOn = !!$('#ioOnlyOn')?.checked;
  const onlyLbl = !!$('#ioOnlyLbl')?.checked;
  const filtering = !!(q || onlyOn || onlyLbl);
  const draw = (el, on, type) => {
    const set = new Set(on);
    const labels = ioLabelMap(st, type);
    const T = type.toUpperCase();
    const start = filtering ? 1 : base;
    const end = filtering ? 512 : base + 31;
    let html = '';
    for (let n = start; n <= end; n++) {
      const l = labels[n];
      const isOn = set.has(n);
      if (onlyOn && !isOn) continue;
      if (onlyLbl && !l) continue;
      if (q) {
        const hay = `${T}${n} ${n} ${l?.name || ''} ${l?.desc || ''}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      const tip = l ? [`${T}${n} ${l.name}`, l.src === 'sys' ? '(시스템 I/O)' : '', l.src === 'sys' && l.other ? `이름표: ${l.other}` : '', l.desc].filter(Boolean).join('\n') : `${T}${n}`;
      html += `<div data-n="${n}" data-t="${type}" class="${isOn ? 'on' : ''}${l ? ` lb ${l.src}` : ''}" title="${escHtml(tip)}"><b>${n}</b><span class="ln">${l ? escHtml(l.name) : ''}</span><i class="ed" title="이름표 편집">✎</i></div>`;
    }
    if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; }
  };
  draw($('#ioDO'), st.io.do, 'do');
  draw($('#ioDI'), st.io.di, 'di');
  renderIoGroups(st);
  renderAnalogIO(st);
}
for (const id of ['#ioDO', '#ioDI']) {
  $(id).onclick = (e) => {
    const d = e.target.closest('div[data-n]');
    if (!d) return;
    if (e.target.closest('.ed')) return openLabelEdit(d.dataset.t, Number(d.dataset.n), d);
    const n = Number(d.dataset.n), on = !d.classList.contains('on');
    run(d.dataset.t === 'do' ? 'setDO' : 'setDI', { n, v: on });
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
$('#ioSearch').oninput = () => app.st && renderIO(app.st);
$('#ioOnlyOn').onchange = () => app.st && renderIO(app.st);
$('#ioOnlyLbl').onchange = () => app.st && renderIO(app.st);

// 이름표 편집 (우클릭 또는 ✎)
let lblEdit = null;
function openLabelEdit(type, n, cell) {
  const st = app.st;
  if (!st) return;
  const user = st.ioLabels?.[type]?.[n] || {};
  const l = ioLabelMap(st, type)[n];
  lblEdit = { type, n };
  setText($('#ioEditT'), `${type.toUpperCase()}${n} 이름표`);
  setText($('#ioEditSys'), l?.src === 'sys' ? ` · 시스템 I/O: ${l.name}` : l?.src === 'lang' ? ` · 프로그램 신호: ${l.name}` : '');
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
  await cmd('ioLabel', { ...lblEdit, name: del ? '' : $('#ioEditName').value.trim(), desc: del ? '' : $('#ioEditDesc').value.trim() }).catch(() => {});
  closeLabelEdit();
}
$('#ioEditSave').onclick = () => saveLabelEdit(false);
$('#ioEditDel').onclick = () => saveLabelEdit(true);
$('#ioEditCancel').onclick = closeLabelEdit;
for (const id of ['#ioEditName', '#ioEditDesc']) $(id).onkeydown = (e) => { if (e.key === 'Enter') saveLabelEdit(false); else if (e.key === 'Escape') closeLabelEdit(); };

// 이름표 CSV (type,n,name,desc — UTF-8 BOM, Excel 호환)
$('#btnLblExport').onclick = () => {
  const a = document.createElement('a');
  const url = URL.createObjectURL(new Blob([labelsToCsv(app.st?.ioLabels)], { type: 'text/csv;charset=utf-8' }));
  a.href = url;
  a.download = 'io-labels.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};
$('#btnLblImport').onclick = () => $('#lblFile').click();
$('#lblFile').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const { labels, count, bad } = csvToLabels(await f.text());
  await cmd('ioLabels', { labels }).catch(() => {});
  addLog({ t: Date.now(), src: 'system', msg: `I/O 이름표 ${count}개 가져옴${bad ? ` (형식 오류 ${bad}행 건너뜀)` : ''}` });
  showToast(`이름표 ${count}개 가져옴${bad ? ` · 형식 오류 ${bad}행` : ''}`, 'ok');
};

// ---------------------------------------------------------------- 그룹 I/O (GI/GO) · 아날로그 I/O (AI/AO)
function renderIoGroups(st) {
  const el = $('#ioGroupList');
  if (!el) return;
  const groups = st.ioGroups || [];
  const sig = JSON.stringify(groups);
  if (sig === app.ioGroupSig) return;
  if (el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  app.ioGroupSig = sig;
  el.innerHTML = groups.length ? groups.map((g, i) => {
    const end = g.start + g.bits - 1;
    const hex = '0x' + ((g.value >>> 0) & ((1 << g.bits) - 1)).toString(16).toUpperCase().padStart(Math.ceil(g.bits / 4), '0');
    const tag = g.dir === 'out' ? 'DO' : 'DI';
    return `<div class="iogrp-row" data-gi="${i}">
      <span class="iogrp-id ${g.dir}">${escHtml(g.id)}</span>
      <span class="iogrp-meta"><b>${escHtml(g.name)}</b><small>${tag}${g.start}..${end} (${g.bits}b · ${hex})</small></span>
      <input type="number" class="iogrp-val" data-id="${escHtml(g.id)}" value="${g.value}" title="Enter 또는 포커스 해제 시 비트에 반영">
      <button type="button" class="mini" data-gdel="${i}" title="그룹 삭제">✕</button>
    </div>`;
  }).join('') : '<div class="note">정의된 그룹 I/O가 없습니다.</div>';
  $$('.iogrp-val', el).forEach((inp) => (inp.onchange = () => run('writeGroupIO', { id: inp.dataset.id, value: Number(inp.value) || 0 })));
  $$('[data-gdel]', el).forEach((b) => (b.onclick = () => {
    const idx = Number(b.dataset.gdel);
    const next = (app.st?.ioGroups || []).filter((_, k) => k !== idx).map(({ value, ...g }) => g);
    run('ioGroups', { list: next });
  }));
}
$('#btnAddGroup').onclick = () => $('#ioGroupForm').classList.toggle('hidden');
$('#grpCancel').onclick = () => $('#ioGroupForm').classList.add('hidden');
$('#grpSave').onclick = () => {
  const dir = $('#grpDir').value === 'out' ? 'out' : 'in';
  const start = Math.max(1, Math.min(512, Number($('#grpStart').value) || 1));
  const bits = Math.max(1, Math.min(16, Number($('#grpBits').value) || 8));
  const cur = (app.st?.ioGroups || []).map(({ value, ...g }) => g);
  const pfx = dir === 'out' ? 'GO' : 'GI';
  let n = 1; while (cur.some((g) => g.id === `${pfx}${n}`)) n++;
  const id = `${pfx}${n}`;
  const name = $('#grpName').value.trim() || id;
  cur.push({ id, name, dir, start, bits, signed: false });
  run('ioGroups', { list: cur });
  $('#grpName').value = '';
  $('#ioGroupForm').classList.add('hidden');
};

function renderAnalogIO(st) {
  const el = $('#ioAnalog');
  if (!el || !st.aio) return;
  const k = app.aioKind;
  const vals = st.aio[k] || [];
  const cfg = st.aio.config?.[k] || {};
  const sig = k + '|' + JSON.stringify(vals) + '|' + JSON.stringify(cfg);
  if (sig === app.aioSig) return;
  if (el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  app.aioSig = sig;
  const T = k.toUpperCase();
  el.innerHTML = vals.map((v, i) => {
    const ch = i + 1;
    const c = cfg[ch] || {};
    const unit = c.unit || 'V';
    return `<div class="aio-cell" title="${escHtml(c.name || `${T}${ch}`)} (${escHtml(unit)})">
      <span class="ch">${T}${ch}</span>
      <input type="number" step="0.1" data-ak="${k}" data-ch="${ch}" value="${Number(v).toFixed(2)}">
      <span class="u">${escHtml(unit)}</span>
    </div>`;
  }).join('');
  $$('input[data-ch]', el).forEach((inp) => (inp.onchange = () => {
    run(inp.dataset.ak === 'ao' ? 'setAO' : 'setAI', { n: Number(inp.dataset.ch), v: Number(inp.value) || 0 });
  }));
}
$$('#segAioKind button').forEach((b) => (b.onclick = () => {
  app.aioKind = b.dataset.v === 'ao' ? 'ao' : 'ai';
  $$('#segAioKind button').forEach((x) => x.classList.toggle('active', x === b));
  app.aioSig = '';
  app.st && renderAnalogIO(app.st);
}));

// ---------------------------------------------------------------- 통신
const COMM_INFO = {
  yaskawa: { k: /yaskawa|hse|motoman/i, d: 'High-Speed Ethernet Server (UDP). 위치/상태/IO/변수(B,I,D,R,P) 읽기·쓰기, 서보/홀드, 잡 선택·시작, 이동 명령, 파일 전송(10041)' },
  kawasaki: { k: /kawasaki|\bas\b|telnet/i, d: 'AS 터미널(Telnet). WHERE, ZPOW ON, EXECUTE, HOLD/CONTINUE, DO 명령, LOAD/SAVE 프로그램 전송' },
  hyundai: { k: /hyundai|hi6|openapi/i, d: 'Hi6 Open API 스타일 REST(JSON). 위치/상태/IO/변수/프로그램 제어/이동' },
  abb: { k: /abb|rws/i, d: 'Robot Web Services (RWS 1.0/2.0 경로). jointtarget/robtarget, RAPID 실행/모듈 로드/심볼 데이터, IO 신호, 파일 서비스' },
  kuka: { k: /kuka|varproxy|showvar/i, d: 'KukaVarProxy / OpenShowVar (TCP 7000). $AXIS_ACT, $POS_ACT, $OV_PRO, $OUT[n], 전역 변수 읽기·쓰기' },
  ur: { k: /\bur\b|dashboard/i, d: 'UR Dashboard Server (TCP 29999). power on, brake release, play, pause, stop, load, robotmode' },
  modbus: { k: /modbus/i, d: 'Modbus TCP 서버 (제조사 공통). 코일 0~511 = DI, 이산 입력 = DO, 입력 레지스터 = 상태/관절/TCP/사이클 타임, 홀딩 0 = 명령, 1 = 오버라이드, 100~ = 사용자 레지스터' },
  opcua: { k: /opc[ -]?ua/i, d: 'OPC UA 서버 (제조사 공통). opc.tcp://…:4840/UA/RobotEmulator — Robot 폴더: 상태·관절·TCP·IO·레지스터 변수(구독 가능), ServoOn/Start/MoveJoints 등 메서드' },
};
function renderComms() {
  const vendor = app.robots.find((r) => r.id === app.robotId)?.vendor;
  $$('#segProtoMode button').forEach((b) => b.classList.toggle('active', b.dataset.v === app.protocolMode));
  $('#commList').innerHTML = app.comms.length ? app.comms.map((c) => {
    const v = Object.entries(COMM_INFO).find(([, x]) => x.k.test(c.name))?.[0];
    const standby = c.standby || c.active === false;
    const portTxt = standby ? `대기 (${c.configuredPort ?? '-'})` : (c.port ?? '비활성');
    return `<div class="comm ${v === vendor ? 'cur' : ''} ${standby ? 'standby' : ''}">
      <div class="t"><span>${escHtml(c.name)}</span><span class="p">${escHtml(c.proto)} ${escHtml(String(portTxt))}</span></div>
      <div class="d">${v ? COMM_INFO[v].d : ''}</div></div>`;
  }).join('') : '<div class="note">통신 모듈 로딩 중…</div>';
}
$$('#segProtoMode button').forEach((b) => (b.onclick = async () => {
  const mode = b.dataset.v;
  if (mode === app.protocolMode) return;
  const r = await cmd('protocolMode', { mode }).catch(() => null);
  if (r?.comms) { app.comms = r.comms; app.protocolMode = r.protocolMode || mode; renderComms(); }
}));

// ---------------------------------------------------------------- 로그 (검색 · 스크롤 고정 · 내보내기)
const logEl = $('#log');
const logFilter = () => Object.fromEntries($$('.logopts input[data-src]').map((c) => [c.dataset.src, c.checked]));
function logMatches(d, f, q) {
  if (f[d.className] === false) return false;
  if (q && !d.textContent.toLowerCase().includes(q)) return false;
  return true;
}
function applyLogFilter() {
  const f = logFilter();
  const q = ($('#logSearch')?.value || '').trim().toLowerCase();
  for (const d of logEl.children) d.hidden = !logMatches(d, f, q);
}
function addLog(e) {
  const d = document.createElement('div');
  d.className = e.src;
  const t = new Date(e.t).toTimeString().slice(0, 8);
  d.innerHTML = `<span class="ts">${t}</span> <span class="src">${escHtml(e.src)}</span>`;
  d.append(document.createTextNode(e.msg));
  const f = logFilter();
  const q = ($('#logSearch')?.value || '').trim().toLowerCase();
  d.hidden = !logMatches(d, f, q);
  const paused = !!$('#logPause')?.checked;
  const atBottom = !paused && logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20;
  logEl.append(d);
  while (logEl.childElementCount > 1500) logEl.firstChild.remove();
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}
$$('.logopts input[data-src]').forEach((c) => (c.onchange = applyLogFilter));
$('#logSearch').oninput = applyLogFilter;
$('#btnExportLog').onclick = () => {
  const lines = [...logEl.children].filter((d) => !d.hidden).map((d) => d.textContent);
  const a = document.createElement('a');
  const url = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }));
  a.href = url;
  a.download = `robot-log-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};
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
    `<button data-n="${escHtml(n)}" class="${n === app.openFile ? 'active' : ''} ${n === app.main ? 'main' : ''} ${app.dirty.has(n) ? 'dirty' : ''}">${escHtml(n)}</button>`).join('');
  $$('#fileTabs button').forEach((b) => (b.onclick = () => openFile(b.dataset.n)));
}
function openFile(n) {
  app.openFile = n;
  editor.text = app.buffers[n] ?? '';
  if (app.dirty.has(n)) editor.dirty = true;
  renderFileTabs();
  app.st && renderProgram(app.st);
}
// 저장: 보낸 내용과 현재 버퍼가 같을 때만 '저장됨' 처리 (저장 중에 계속 입력한 내용은 dirty 로 남음)
async function saveAll() {
  for (const n of [...app.dirty]) {
    const sent = app.buffers[n];
    await cmd('saveFile', { name: n, text: sent });
    if (app.buffers[n] === sent) app.dirty.delete(n);
  }
  renderFileTabs();
}
$('#btnSave').onclick = () => saveAll().catch(() => {});
$('#btnFind').onclick = () => editor.openFind();
// Ctrl/Cmd+S 저장, Ctrl/Cmd+Enter 저장 후 시작(에디터 안에서도). e.code 기준 → 한글 입력·Caps Lock 에서도 동작
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing) return;
  if (e.code === 'KeyS') { e.preventDefault(); saveAll().catch(() => {}); }
  else if (e.code === 'Enter' || e.code === 'NumpadEnter') { if (document.querySelector('dialog[open]')) return; e.preventDefault(); $('#btnStart').onclick(); }
});
// 저장하지 않은 변경이 있으면 창 닫기·새로고침 전에 확인
window.addEventListener('beforeunload', (e) => { if (app.dirty.size) { e.preventDefault(); e.returnValue = ''; } });
$('#btnNew').onclick = () => {
  if (!app.st) return;
  const ext = { yaskawa: '.JBI', kawasaki: '.as', hyundai: '.job', abb: '.mod', kuka: '.src', doosan: '.drl', ur: '.script' }[app.st.vendor];
  const name = prompt('새 파일 이름', `NEW${ext}`);
  if (!name) return;
  app.buffers[name] = ''; app.dirty.add(name); openFile(name);
};
$('#btnOpen').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = async (e) => {
  for (const f of e.target.files) {
    const text = await f.text();
    await cmd('saveFile', { name: f.name, text }).catch(() => {});
    app.dirty.delete(f.name);
    app.openFile = f.name;
  }
  e.target.value = '';
};
$('#btnDownload').onclick = () => {
  if (!app.openFile) return;
  const a = document.createElement('a');
  const url = URL.createObjectURL(new Blob([app.buffers[app.openFile].replace(/\n/g, '\r\n')], { type: 'text/plain' }));
  a.href = url;
  a.download = app.openFile;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};
$('#btnMain').onclick = async () => { if (app.openFile) { await saveAll().catch(() => {}); run('setMain', { name: app.openFile }); } };
$('#btnDelete').onclick = () => {
  if (!app.openFile || !confirm(`${app.openFile} 파일을 삭제할까요?`)) return;
  const n = app.openFile;
  app.dirty.delete(n); delete app.buffers[n]; app.openFile = null;
  if (n in app.files) run('deleteFile', { name: n }); else onFiles({ files: app.files, main: app.main });
};
$('#btnExample').onclick = () => { if (confirm('현재 로봇·공작물 배치에 맞는 예제 프로그램을 다시 생성합니다. 기존 파일은 교체됩니다.')) { app.dirty.clear(); app.buffers = {}; run('loadExample'); } };

// 프로그램 제어
$('#btnStart').onclick = async () => {
  if (!app.st) return;
  try { await saveAll(); } catch { return; }
  if (!app.st.servo && !(await cmdChecked('servo', { on: true })).ok) return;
  cmdChecked(app.st.held ? 'resume' : 'start');
};
$('#btnStep').onclick = async () => {
  if (!app.st) return;
  try { await saveAll(); } catch { return; }
  if (!app.st.servo && !(await cmdChecked('servo', { on: true })).ok) return;
  cmdChecked('step');
};
$('#btnHold').onclick = () => app.st && cmdChecked(app.st.held ? 'resume' : 'hold');
$('#btnStop').onclick = () => run('stop');

// Space: 재생/일시정지 — 정지·완료 상태면 시작, 실행 중이면 홀드, 홀드 중이면 재개
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !app.st) return;
  const t = e.target;
  if (t.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])') || document.querySelector('dialog[open]')) return;
  e.preventDefault();
  if (t.tagName === 'BUTTON') t.blur();
  const st = app.st;
  if (st.program.status === 'running' && !st.held) run('hold');
  else $('#btnStart').onclick();
});
$('#btnReset').onclick = () => run('reset');

// 배속 (시뮬레이션 시간 배율). 단축키 - / + (= 키 포함) + 카메라 프리셋 1~5 + 단축키 모달 ?
const SPEEDS = [...document.querySelectorAll('#selSpeed option')].map((o) => Number(o.value));
$('#selSpeed').onchange = (e) => { run('timeScale', { value: Number(e.target.value) }); e.target.blur(); };
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])') || document.querySelector('dialog[open]')) return;
  if (e.key === '?') { e.preventDefault(); $('#keysDlg').showModal(); return; }
  const camMap = { '1': 'iso', '2': 'top', '3': 'front', '4': 'side', '5': 'tcp' };
  if (camMap[e.key] && !e.shiftKey) { e.preventDefault(); view.setViewPreset(camMap[e.key]); return; }
  if (!['-', '=', '+'].includes(e.key) || !app.st) return;
  e.preventDefault();
  const sel = $('#selSpeed');
  const cur = Number(sel.value) || 1;
  const v = e.key === '-' ? [...SPEEDS].reverse().find((x) => x < cur - 1e-9) : SPEEDS.find((x) => x > cur + 1e-9);
  if (v === undefined) return;
  sel.value = String(v);
  sel.classList.toggle('fast', v !== 1);
  run('timeScale', { value: v });
});

// ---------------------------------------------------------------- 직접교시 (핸드 가이딩) — public/js/directTeach.js
let dtStatusTimer = null;
function dtStatus({ text, level = 'info', hover } = {}) {
  const el = $('#dtStatus');
  setText(el, text || '');
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
    if (st.program?.status === 'running' && !st.held) { dtStatus({ text: '프로그램 실행 중에는 직접교시를 켤 수 없습니다', level: 'err' }); return; }
    if (st.safety?.estop) { dtStatus({ text: '비상정지 중', level: 'err' }); return; }
    if (st.mode !== 'TEACH') { const r = await cmdChecked('mode', { mode: 'TEACH' }); if (r?.ok === false) return; }
    if (!st.servo) { const r = await cmdChecked('servo', { on: true }); if (r?.ok === false) return; }
  }
  dt.setEnabled(on);
  $('#dtBar').classList.toggle('on', on);
  $('#dtAlign')?.classList.toggle('active', !!dt.alignMode);
  setText($('#dtToggle'), on ? '✋ 직접교시 ON' : '✋ 직접교시');
  if (on) dtStatus({ text: 'TCP 핸들을 끌어 이동·회전, 로봇 링크를 끌어 관절 회전', level: 'info' });
}
$('#dtToggle').onclick = () => setDirectTeach(!dt.enabled);
$$('#dtMode button').forEach((b) => {
  b.onclick = () => {
    if (dt.alignMode) { dt.setAlignMode(false); $('#dtAlign')?.classList.remove('active'); }
    dt.setMode(b.dataset.v);
    dtSeg('dtMode', b.dataset.v);
  };
});
$$('#dtSpace button').forEach((b) => { b.onclick = () => { dt.setSpace(b.dataset.v); dtSeg('dtSpace', b.dataset.v); }; });
$('#dtSnap').onchange = (e) => { dt.setSnap(Number(e.target.value)); e.target.blur(); };
$('#dtAlign')?.addEventListener('click', () => {
  const on = dt.setAlignMode(!dt.alignMode);
  $('#dtAlign').classList.toggle('active', on);
});
$('#dtUndo').onclick = () => dt.undoLast();
$('#dtGrip').onclick = () => {
  if (!app.st) return;
  const g = app.st.gripperIO, closed = app.st.grip.closed;
  if (!g?.close) return;
  run('setDO', { n: g.close, v: !closed });
  if (closed && g.open && g.open !== g.close) { run('setDO', { n: g.open, v: true }); setTimeout(() => run('setDO', { n: g.open, v: false }), 300); }
};
$('#dtRecord').onclick = () => { $('#btnTeach').onclick(); dtStatus({ text: '현재 위치를 프로그램에 기록했습니다', level: 'info' }); };

// 상태에 맞춰 툴바 갱신 (모드·실행·비상정지로 조건이 깨지면 자동으로 끔)
function syncDirectTeachBar(st) {
  setText($('#dtGrip'), st.grip.closed ? '그리퍼 열기' : '그리퍼 닫기');
  if (dt.enabled && (st.mode !== 'TEACH' || (st.program?.status === 'running' && !st.held) || st.safety?.estop)) {
    setDirectTeach(false);
    dtStatus({ text: '직접교시 해제 (모드 변경·실행·비상정지)', level: 'warn' });
  }
}

// 단축키 (입력칸 밖): T 켜기/끄기 — 켜진 동안 W 이동, E 회전, Q BASE/TOOL, X 스냅, F 면 정렬, G 그리퍼, Enter 위치 기록, Ctrl/Cmd+Z 되돌리기, Esc 끄기
document.addEventListener('keydown', (e) => {
  if (e.altKey || !app.st) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])') || document.querySelector('dialog[open]')) return;
  const k = { KeyT: 't', KeyZ: 'z', KeyW: 'w', KeyE: 'e', KeyQ: 'q', KeyX: 'x', KeyF: 'f', KeyG: 'g', Enter: 'enter', NumpadEnter: 'enter', Escape: 'escape' }[e.code] ?? e.key.toLowerCase();
  if (dt.enabled && (e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); dt.undoLast(); return; }
  if (e.ctrlKey || e.metaKey) return;
  if (k === 't') { e.preventDefault(); setDirectTeach(!dt.enabled); return; }
  if (!dt.enabled) return;
  const act = {
    w: () => $('#dtMode button[data-v="translate"]').click(),
    e: () => $('#dtMode button[data-v="rotate"]').click(),
    q: () => $(`#dtSpace button[data-v="${dt.space === 'world' ? 'tool' : 'world'}"]`).click(),
    x: () => { const i = (dt.snap + 1) % SNAPS.length; $('#dtSnap').value = String(i); dt.setSnap(i); dtStatus({ text: SNAPS[i].label, level: 'info' }); },
    f: () => $('#dtAlign')?.click(),
    g: () => $('#dtGrip').click(),
    enter: () => $('#dtRecord').click(),
    escape: () => setDirectTeach(false),
  }[k];
  if (act) { e.preventDefault(); act(); }
});

// ---------------------------------------------------------------- 티칭: 현재 위치를 제조사 문법으로 삽입
$('#btnTeach').onclick = () => {
  const st = app.st;
  if (!st) return;
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
      const posHdr = lastC !== undefined ? lastC : lines.findIndex((l) => l.trim() === '//POS' || l.startsWith('///POSTYPE'));
      if (posHdr !== -1) {
        const lineNo = editor.ta.value.slice(0, editor.ta.selectionStart).split('\n').length - 1;
        let postype = 'PULSE';
        for (let i = 0; i <= posHdr; i++) {
          const u = lines[i].trim().toUpperCase();
          const pm = /^\/\/\/(\w+)\s*(.*)$/.exec(u);
          if (!pm) continue;
          if (pm[1] === 'POSTYPE') postype = pm[2].trim();
          else if (pm[1] === 'PULSE') postype = 'PULSE';
          else if (pm[1] === 'RECTAN' && postype === 'PULSE') postype = 'BASE';
        }
        const ppd = app.robots.find((r) => r.id === st.robotId)?.pulsePerDeg || [1000, 1000, 1000, 1000, 1000, 1000];
        const coords = postype === 'PULSE' ? st.joints.map((deg, i) => String(Math.round(deg * ppd[i]))) : t;
        lines.splice(posHdr + 1, 0, `${tag}=${coords.join(',')}`);
        const np = lines.findIndex((l) => l.startsWith('///NPOS'));
        if (np >= 0) lines[np] = lines[np].replace(/^\/\/\/NPOS (\d+)/, (_, c) => `///NPOS ${Number(c) + 1}`);
        editor.ta.value = lines.join('\n');
        const off = lines.slice(0, lineNo + 1 + (posHdr < lineNo ? 1 : 0)).join('\n').length;
        editor.ta.selectionStart = editor.ta.selectionEnd = off;
        editor.insertAtCursor(postype === 'PULSE' ? `MOVJ ${tag} VJ=50.00` : `MOVL ${tag} V=250.0`);
      } else {
        // 헤더 없는 빈 파일: 기본 //POS 스켈레톤에 C 포인트와 MOVL 함께 삽입 (활성 Tool/User 반영)
        const fr = st.frames;
        const toolHdr = fr?.activeTool > 0 ? `///TOOL ${fr.activeTool}\n` : '';
        const userHdr = fr?.activeUser > 0 ? `///USER ${fr.activeUser}\n///POSTYPE USER\n` : '///POSTYPE BASE\n';
        editor.insertAtCursor(`//POS\n///NPOS 1,0,0,0,0,0\n${toolHdr}${userHdr}${tag}=${t.join(',')}\n//INST\nNOP\nMOVL ${tag} V=250.0\nEND`);
      }
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
    case 'ur': editor.insertAtCursor(`movel(p[${st.tcp.map((v, i) => (i < 3 ? +(v / 1000).toFixed(5) : +v.toFixed(5))).join(', ')}], a=1.2, v=0.25)`); break;
    case 'kuka': editor.insertAtCursor(`LIN {X ${t[0]}, Y ${t[1]}, Z ${t[2]}, A ${t[3]}, B ${t[4]}, C ${t[5]}}`); break;
  }
  addLog({ t: Date.now(), src: 'system', msg: `현재 위치 삽입 (관절: ${j.join(', ')})` });
};

// ---------------------------------------------------------------- Touch-Up (좌표 덮어쓰기)
$('#btnTouchUp').onclick = () => {
  const st = app.st;
  if (!st || !app.openFile) return;
  const model = app.robots.find((r) => r.id === st.robotId);
  const r = touchUpAtLine({
    vendor: st.vendor, text: editor.text, fileName: app.openFile, files: app.buffers,
    cursorLine: app.cursorLine, tcp: st.tcp, joints: st.joints, robot: model,
  });
  if (!r.ok) { showToast(`<b>좌표 덮어쓰기 불가</b> — ${escHtml(r.reason)}`); return; }
  app.buffers[r.file] = r.text;
  app.dirty.add(r.file);
  if (r.file === app.openFile) {
    const ss = editor.ta.selectionStart, se = editor.ta.selectionEnd, stp = editor.ta.scrollTop;
    editor.ta.value = r.text;
    editor.ta.selectionStart = Math.min(ss, r.text.length);
    editor.ta.selectionEnd = Math.min(se, r.text.length);
    editor.ta.scrollTop = stp;
    editor.dirty = true;
    editor.render();
  }
  renderFileTabs();
  addLog({ t: Date.now(), src: 'system', msg: `좌표 덮어쓰기 (Touch-Up): ${r.label} (${r.file}:${r.line})` });
  showToast(`좌표 덮어쓰기 완료: <b>${escHtml(r.label)}</b> (${escHtml(r.file)}:${r.line})`, 'ok');
};

// ---------------------------------------------------------------- Go To Point (선택 포인트로 이동)
$('#btnGoTo').onclick = async () => {
  const st = app.st;
  if (!st || !app.openFile) return;
  const model = app.robots.find((r) => r.id === st.robotId);
  const pt = extractPointAtLine({
    vendor: st.vendor, text: editor.text, fileName: app.openFile, files: app.buffers,
    cursorLine: app.cursorLine, robot: model,
  });
  if (!pt.ok) { showToast(`<b>포인트 이동 불가</b> — ${escHtml(pt.reason)}`); return; }
  const r = await cmdChecked('goToPoint', { kind: pt.kind, values: pt.values, label: pt.label });
  if (r?.ok === false && r.reason && !r.reject) showToast(`<b>포인트 이동 실패</b> — ${escHtml(r.reason)}`);
  else if (r?.ok) showToast(`포인트 이동 완료: <b>${escHtml(pt.label)}</b>`, 'ok');
};

// ---------------------------------------------------------------- Set PP to Cursor (프로그램 포인터 이동)
$('#btnSetPP').onclick = async () => {
  if (!app.st || !app.openFile) return;
  try { await saveAll(); } catch { return; }
  const r = await cmd('setPP', { file: app.openFile, line: app.cursorLine }).catch(() => null);
  if (!r) return;
  if (r.ok === false) { showToast(`<b>PP 이동 불가</b> — ${escHtml(r.reason || '실행 가능한 줄 없음')}`); return; }
  showToast(`PP 이동: <b>${escHtml(r.file)}:${r.line}</b> (${escHtml(r.proc)})`, 'ok');
};

// ---------------------------------------------------------------- 탭
$$('.tabs').forEach((n) => n.setAttribute('role', 'tablist'));
$$('#left .tab').forEach((t) => t.setAttribute('role', 'tabpanel'));
const syncTabAria = () => $$('.tabs button').forEach((x) => { x.setAttribute('role', 'tab'); x.setAttribute('aria-controls', x.dataset.tab); x.setAttribute('aria-selected', String(x.classList.contains('active'))); });
syncTabAria();
$$('.tabs button').forEach((b) => (b.onclick = () => {
  $$('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $$('#left .tab').forEach((t) => t.classList.toggle('active', t.id === b.dataset.tab));
  syncTabAria();
  // 숨겨져 있던 탭이 열리면 최신 상태 즉시 반영
  if (app.st) {
    if (b.dataset.tab === 'tIO') renderIO(app.st);
    else if (b.dataset.tab === 'tSys') renderSysioPanel(app.st);
    else if (b.dataset.tab === 'tCell') renderCellPanel(app.st);
    else if (b.dataset.tab === 'tFault') renderFaultPanel(app.st);
    else if (b.dataset.tab === 'tJog') { const m = app.robots.find((r) => r.id === app.robotId); if (m) renderPose(app.st, m); }
  }
}));

// ---------------------------------------------------------------- 테마 & 단축키 창 & 패널 리사이즈
function applyTheme(theme) {
  const light = theme === 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  $('#btnTheme').textContent = light ? '☾' : '☀';
  view.setTheme(light);
  try { localStorage.setItem('uiTheme', light ? 'light' : 'dark'); } catch {}
}
$('#btnTheme').onclick = () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
try { if (localStorage.getItem('uiTheme') === 'light') applyTheme('light'); } catch {}

$('#btnKeys').onclick = () => $('#keysDlg').showModal();

// 리사이즈 스플리터 (왼쪽/오른쪽/채팅 폭, 하단 높이 — localStorage 저장)
const RZ_CFG = {
  left: { var: '--left-w', min: 220, max: 540, axis: 'x', sign: 1 },
  right: { var: '--right-w', min: 280, max: 760, axis: 'x', sign: -1 },
  chat: { var: '--chat-w', min: 260, max: 620, axis: 'x', sign: -1 },
  foot: { var: '--foot-h', min: 110, max: 480, axis: 'y', sign: -1 },
};
for (const [k, c] of Object.entries(RZ_CFG)) {
  try {
    const saved = Number(localStorage.getItem(`pane:${k}`));
    if (saved >= c.min && saved <= c.max) document.documentElement.style.setProperty(c.var, `${saved}px`);
  } catch {}
}
$$('.resizer[data-rz]').forEach((h) => {
  const k = h.dataset.rz, c = RZ_CFG[k];
  if (!c) return;
  h.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    h.classList.add('dragging');
    document.body.classList.add('resizing');
    const start = c.axis === 'x' ? e.clientX : e.clientY;
    const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(c.var)) || (c.axis === 'x' ? h.parentElement.offsetWidth : h.parentElement.offsetHeight);
    const move = (ev) => {
      const d = ((c.axis === 'x' ? ev.clientX : ev.clientY) - start) * c.sign;
      const v = Math.round(Math.max(c.min, Math.min(c.max, cur + d)));
      document.documentElement.style.setProperty(c.var, `${v}px`);
      try { localStorage.setItem(`pane:${k}`, String(v)); } catch {}
    };
    const up = () => {
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', up);
      h.removeEventListener('pointercancel', up);
      h.classList.remove('dragging');
      document.body.classList.remove('resizing');
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', up);
  });
});

// ---------------------------------------------------------------- 브레이크포인트 (라인 번호 클릭)
editor.onGutterClick = (line) => {
  if (!app.openFile) return;
  const key = `${app.openFile}:${line}`;
  const set = new Set(app.st?.breakpoints || []);
  set.has(key) ? set.delete(key) : set.add(key);
  run('breakpoints', { list: [...set] });
};

// ---------------------------------------------------------------- 프로젝트
const dlg = $('#projDlg');
async function refreshProjects() {
  const r = await cmd('projectList').catch(() => null);
  if (!r) return;
  setText($('#projCur'), r.current ? `— 현재: ${r.current}` : '');
  if (r.current && !$('#projName').value) $('#projName').value = r.current;
  $('#projList').innerHTML = r.projects.length ? r.projects.map((p) => `
    <div class="pi" data-n="${escHtml(p.name)}"><span class="nm">${escHtml(p.name)}</span>
      <span class="mt">${escHtml(p.robotId ?? '')} · ${p.savedAt ? escHtml(new Date(p.savedAt).toLocaleString()) : ''}</span>
      <button type="button" data-a="load">불러오기</button><button type="button" data-a="del">삭제</button></div>`).join('')
    : '<div class="empty">저장된 프로젝트가 없습니다.</div>';
  $$('#projList button').forEach((b) => (b.onclick = async () => {
    const n = b.closest('.pi').dataset.n;
    if (b.dataset.a === 'load') {
      if (app.dirty.size && !confirm('저장하지 않은 편집 내용이 있습니다. 불러오면 사라집니다. 계속할까요?')) return;
      app.dirty.clear(); app.buffers = {};
      await cmd('projectLoad', { name: n }).catch(() => {});
      dlg.close();
    } else if (confirm(`프로젝트 '${n}' 을(를) 삭제할까요?`)) { await cmd('projectDelete', { name: n }).catch(() => {}); refreshProjects(); }
  }));
}
$('#btnProject').onclick = () => { refreshProjects(); dlg.showModal(); };
$('#projSave').onclick = async () => {
  const n = $('#projName').value.trim();
  if (!n) return alert('프로젝트 이름을 입력하세요');
  try {
    await saveAll();
    await cmd('projectSave', { name: n });
    refreshProjects();
  } catch {}
};
$('#projExport').onclick = async () => {
  try {
    await saveAll();
    // 셀에 배치한 3D 모델 파일까지 묶은 JSON 1개 → 다른 PC 에서 그대로 가져오기 가능
    const n = $('#projName').value.trim();
    const res = await fetch(`/api/project/export${n ? `?name=${encodeURIComponent(n)}` : ''}`);
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || res.statusText);
    const blob = new Blob([JSON.stringify(r)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${r.name || 'project'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    const k = Object.keys(r.assets || {}).length;
    const size = blob.size >= 1048576 ? `${(blob.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(blob.size / 1024))} KB`;
    showToast(k ? `내보냄: 3D 모델 ${k}개 포함 (${size})` : `내보냄 (${size})`, 'ok');
  } catch (err) { alert(`내보내기 실패: ${err.message}`); }
};
$('#projImport').onclick = () => $('#projFile').click();
$('#projFile').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    app.dirty.clear(); app.buffers = {};
    const res = await fetch('/api/project/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: f });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || res.statusText);
    showToast(r.models ? `가져옴: 3D 모델 ${r.models}개 포함` : '가져옴', 'ok');
    dlg.close();
  } catch (err) { alert(`가져오기 실패: ${err.message}`); }
};

const dbg = initDebugPanels({ cmd, isConnected: isWsOpen });
initSysioPanel({ cmd, getState: () => app.st });
initCellPanel({ cmd, view, getState: () => app.st });
initFaultPanel({ cmd, getState: () => app.st });
initChatPanel({ send: (msg) => { if (!isWsOpen()) return false; ws.send(JSON.stringify(msg)); return true; } });
initAboutPanel({ cmd, getState: () => app.st, isDirty: () => app.dirty.size > 0, saveAll, showToast });
initCameraPanel({ cmd, view, getState: () => app.st, getModel: () => app.robots.find((r) => r.id === app.robotId) });
connect();
