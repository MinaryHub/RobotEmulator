// 로봇 에뮬레이터 서버 진입점
//  - HTTP: 웹 UI 정적 파일 + 공용 REST API (/api/state, /api/cmd)
//  - WebSocket(/ws): UI 실시간 상태/명령
//  - 제조사별 외부 통신 인터페이스 (server/protocols)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Controller, ROBOTS, GRIPPERS, VENDORS } from './controller.js';
import { ProjectStore } from './project.js';
import { listVars, Timeline } from './inspect.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig();
const ctrl = new Controller();
if (config.robot) try { ctrl.setRobot(config.robot); } catch (e) { console.error(e.message); }
if (config.gripper) ctrl.setGripper(config.gripper);
// 프로젝트 저장소: 직전 세션 자동 복원 (config.restoreSession=false 또는 robot 지정 시 생략)
const timeline = new Timeline(ctrl);
const projects = new ProjectStore(ctrl, path.join(ROOT, 'projects'));
if (config.restoreSession !== false && !config.robot) projects.restoreAutosave();
projects.startAutosave();

function loadConfig() {
  const def = {
    httpPort: 3000,
    robot: null, gripper: null,
    protocols: {
      yaskawaHse: { port: 10040, filePort: 10041 },
      kawasakiAs: { port: 23, fallbackPort: 10023 },
      hyundai: { port: 8888 },
      abbRws: { port: 8080 },
      kukaVarProxy: { port: 7000 },
      modbus: { port: 502, fallbackPort: 1502 },
      opcua: { port: 4840 },
    },
  };
  const f = path.join(ROOT, 'config.json');
  if (fs.existsSync(f)) {
    try {
      const u = JSON.parse(fs.readFileSync(f, 'utf8'));
      return { ...def, ...u, protocols: { ...def.protocols, ...(u.protocols || {}) } };
    } catch (e) { console.error('config.json 오류:', e.message); }
  }
  if (process.env.PORT) def.httpPort = Number(process.env.PORT);
  return def;
}

// ---------------------------------------------------------------- 정적 파일
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const STATIC = [
  ['/vendor/three/', path.join(ROOT, 'node_modules/three/')],
  ['/shared/', path.join(ROOT, 'shared/')],
  ['/examples/', path.join(ROOT, 'examples/')],
  ['/', path.join(ROOT, 'public/')],
];

function serveStatic(req, res) {
  let url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (url === '/') url = '/index.html';
  for (const [prefix, dir] of STATIC) {
    if (!url.startsWith(prefix)) continue;
    const file = path.join(dir, url.slice(prefix.length));
    if (!file.startsWith(dir)) break;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
      return;
    }
  }
  res.writeHead(404); res.end('Not found');
}

// ---------------------------------------------------------------- 명령 처리 (WS/REST 공용)
let comms = [];

async function handleCmd(m) {
  switch (m.cmd) {
    case 'setRobot': ctrl.setRobot(m.id); return { files: filesMsg() };
    case 'setGripper': ctrl.setGripper(m.id); return;
    case 'customGripper': ctrl.setCustomGripper(m.def); return;
    case 'servo': ctrl.setServo(m.on); return;
    case 'mode': ctrl.setMode(m.mode); return;
    case 'override': ctrl.setOverride(m.value); return;
    case 'jog': ctrl.startJog(m.jog); return;
    case 'jogStop': ctrl.stopJog(); return;
    case 'setJoints': return { ok: ctrl.setJointsDirect(m.joints) };
    case 'moveJoints':
      ctrl.move({ kind: 'J', target: { joints: m.joints }, speed: { frac: m.speed ?? 0.3 } }).catch((e) => !e.aborted && ctrl.alarm(e.code || 'MOTION', e.message));
      return;
    case 'moveHome':
      ctrl.move({ kind: 'J', target: { joints: [...ctrl.robot.home] }, speed: { frac: 0.3 } }).catch((e) => !e.aborted && ctrl.alarm(e.code || 'MOTION', e.message));
      return;
    case 'setDO': ctrl.setDO(m.n, m.v); return;
    case 'setDI': ctrl.setDI(m.n, m.v); return;
    case 'gripperIO': Object.assign(ctrl.gripperIO, m.map); ctrl.emitState(); return;
    case 'saveFile': ctrl.loadFiles({ [m.name]: m.text }); return { files: filesMsg() };
    case 'deleteFile': ctrl.deleteFile(m.name); return { files: filesMsg() };
    case 'setMain': ctrl.setMain(m.name); return;
    case 'start': return { ok: await ctrl.start({ step: false }) };
    case 'step': return { ok: await ctrl.start({ step: true }) };
    case 'hold': ctrl.hold(); return;
    case 'resume': ctrl.resume(); return;
    case 'stop': ctrl.stopProgram(); return;
    case 'reset': ctrl.resetProgram(); return;
    case 'resetAlarms': ctrl.resetAlarms(); return;
    case 'resetScene': ctrl.resetScene(); return;
    case 'cell': return ctrl.cell.handle(m);   // 셀 레이아웃/주변기기 (op: get|set|preset|resetObjects|add|remove|update)
    case 'autoResetScene': ctrl.autoResetScene = !!m.on; ctrl.emitState(); return;
    case 'blend': ctrl.blendEnabled = !!m.on; ctrl.log('system', `블렌딩 ${m.on ? 'ON' : 'OFF (모든 점 정위치 정지)'}`); ctrl.emitState(); return;
    case 'collisionMode': if (ctrl.setCollisionMode) ctrl.setCollisionMode(m.mode); return;
    case 'loadExample': ctrl.loadExample(); return { files: filesMsg() };
    case 'getFiles': return { files: filesMsg() };
    case 'breakpoints': ctrl.breakpoints = new Set((m.list || []).map(String)); ctrl.emitState(); return;
    case 'vars': return { vars: listVars(ctrl) };
    case 'timeline': return { timeline: timeline.snapshot() };
    case 'timelineClear': timeline.clear(); return;
    case 'projectList': return { projects: projects.list(), current: projects.current };
    case 'projectSave': projects.save(String(m.name || '').trim()); return { projects: projects.list(), current: projects.current };
    case 'projectLoad': projects.load(m.name); return { files: filesMsg(), current: projects.current };
    case 'projectDelete': projects.remove(m.name); return { projects: projects.list() };
    case 'projectExport': return { project: projects.serialize(m.name) };
    case 'projectImport': projects.apply(m.project); return { files: filesMsg(), current: projects.current };
    case 'state': return { state: ctrl.snapshot() };
    default: throw new Error(`알 수 없는 명령: ${m.cmd}`);
  }
}

const filesMsg = () => ({ main: ctrl.main, files: Object.fromEntries(ctrl.files) });

// ---------------------------------------------------------------- HTTP 서버
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    try {
      let out;
      if (url.pathname === '/api/state') out = ctrl.snapshot();
      else if (url.pathname === '/api/robots') out = { robots: ROBOTS, grippers: GRIPPERS, vendors: VENDORS };
      else if (url.pathname === '/api/comms') out = comms.map(({ name, proto, port }) => ({ name, proto, port }));
      else if (url.pathname === '/api/cmd' && req.method === 'POST') {
        const body = await new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => r(s)); });
        out = (await handleCmd(JSON.parse(body || '{}'))) ?? { ok: true };
      } else { res.writeHead(404); return res.end('{"error":"not found"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  serveStatic(req, res);
});

// ---------------------------------------------------------------- WebSocket
const wss = new WebSocketServer({ server, path: '/ws' });
const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
const broadcast = (msg) => { const s = JSON.stringify(msg); for (const c of wss.clients) if (c.readyState === 1) c.send(s); };

wss.on('connection', (ws) => {
  send(ws, {
    type: 'init', robots: ROBOTS, grippers: GRIPPERS, vendors: VENDORS,
    state: ctrl.snapshot(), logs: ctrl.logs.slice(-200), files: filesMsg(),
    comms: comms.map(({ name, proto, port }) => ({ name, proto, port })),
  });
  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    try {
      const r = await handleCmd(m);
      if (r?.files) broadcast({ type: 'files', ...r.files });
      if (m.id !== undefined) send(ws, { type: 'reply', id: m.id, ok: true, ...r });
    } catch (e) {
      ctrl.log('system', `명령 오류(${m.cmd}): ${e.message}`);
      if (m.id !== undefined) send(ws, { type: 'reply', id: m.id, ok: false, error: e.message });
    }
  });
});

// 상태 브로드캐스트 (최대 30Hz)
let pending = false;
ctrl.on('state', () => {
  if (pending) return;
  pending = true;
  setTimeout(() => { pending = false; broadcast({ type: 'state', state: ctrl.snapshot() }); }, 33);
});
ctrl.on('log', (e) => broadcast({ type: 'log', entry: e }));
// 타임라인 이벤트는 100ms 단위로 묶어 전송
let tlPending = [];
timeline.listeners.add((e) => tlPending.push(e));
setInterval(() => { if (tlPending.length) { broadcast({ type: 'tl', events: tlPending, now: Math.round(ctrl.simMs) }); tlPending = []; } }, 100);
// 외부 인터페이스가 파일을 바꾸면 UI 에디터 갱신
let lastFilesSig = '';
setInterval(() => {
  const sig = ctrl.main + '|' + [...ctrl.files].map(([k, v]) => k + v.length + v.slice(0, 40)).join('|');
  if (sig !== lastFilesSig) { lastFilesSig = sig; broadcast({ type: 'files', ...filesMsg() }); }
}, 500);

server.listen(config.httpPort, async () => {
  console.log(`\n  산업용 로봇 에뮬레이터  →  http://localhost:${config.httpPort}\n`);
  try {
    const { startAll } = await import('./protocols/index.js');
    comms = await startAll(ctrl, config.protocols);
    for (const c of comms) console.log(`  [통신] ${c.name.padEnd(28)} ${c.proto.padEnd(5)} ${c.port ?? '(비활성)'}`);
    broadcast({ type: 'comms', comms: comms.map(({ name, proto, port }) => ({ name, proto, port })) });
  } catch (e) {
    console.error('통신 모듈 시작 실패:', e.message);
  }
});

process.on('SIGINT', () => { for (const c of comms) c.close?.(); process.exit(0); });
