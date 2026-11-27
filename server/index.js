// 로봇 에뮬레이터 서버 진입점
//  - HTTP: 웹 UI 정적 파일 + 공용 REST API (/api/state, /api/cmd)
//  - WebSocket(/ws): UI 실시간 상태/명령
//  - 제조사별 외부 통신 인터페이스 (server/protocols)
//  - MCP 서버(/mcp)와 Claude 채팅(WebSocket chat 명령) — server/ai
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Controller, ROBOTS, GRIPPERS, VENDORS } from './controller.js';
import { SystemIO } from './sysio.js';
import { CAMERAS } from '../shared/cameras.js';
import { ProjectStore } from './project.js';
import { listVars, Timeline } from './inspect.js';
import { handleMcp } from './ai/mcp.js';
import { configureNetGuard, requestRejected, authRole, authConfigured } from './netguard.js';
import { AssetStore, MAX_UPLOAD } from './assets.js';
import { Updater } from './updater.js';
import { importBackup, isZipBuffer } from './backup.js';
import { parseCliArgs, runScenario, toJUnitXml } from './hil.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = parseCliArgs(process.argv.slice(2));

// Headless HIL 시나리오 실행 모드: HTTP/프로토콜 포트를 열지 않고 시나리오만 검증 후 종료
if (cli.scenario) {
  const report = await runScenario(cli.scenario);
  if (cli.junit) {
    const outPath = path.resolve(cli.junit);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, toJUnitXml(report), 'utf8');
  }
  console.log(`[HIL] ${report.name}: ${report.passed}/${report.total} passed (${(report.durationMs / 1000).toFixed(2)}s)`);
  for (const tc of report.cases) {
    console.log(`  ${tc.ok ? '✓' : '✗'} ${tc.name}${tc.ok ? '' : ' — ' + tc.errors.join('; ')}`);
  }
  process.exit(report.ok ? 0 : 1);
}

const config = loadConfig();
configureNetGuard(config);
const DATA_DIR = path.resolve(config.dataDir || ROOT);
fs.mkdirSync(DATA_DIR, { recursive: true });
if (config.protocols?.opcua && !config.protocols.opcua.pkiDir) {
  config.protocols.opcua = { ...config.protocols.opcua, pkiDir: path.join(DATA_DIR, '.opcua-pki') };
}
const ctrl = new Controller();
// 버전 정보·업데이트 (GitHub Releases). 프로그램 실행 중에는 업데이트 적용 거부
const updater = await new Updater({
  root: ROOT, config: config.update, log: (src, msg) => ctrl.log(src, msg),
  isBusy: () => (['running', 'paused'].includes(ctrl.vm?.status) ? '프로그램 실행 중에는 업데이트할 수 없습니다 — 정지한 뒤 다시 시도하세요' : null),
}).init();
ctrl.netHost = config.host;   // DRL 소켓(server_socket_open) 바인딩 주소 — 통신 모듈과 같은 규칙 (null = 모든 인터페이스)
// 사용자 3D 모델 자산 (셀 레이아웃 models[] 가 참조). 프로젝트 복원 전에 연결해야 간섭 메시를 읽을 수 있음
const ASSET_DIR = path.join(DATA_DIR, 'assets', 'models');
ctrl.assets = new AssetStore(ASSET_DIR, (src, msg) => ctrl.log(src, msg));
if (config.robot) try { ctrl.setRobot(config.robot); } catch (e) { console.error(e.message); }
if (config.gripper) ctrl.setGripper(config.gripper);
// 프로젝트 저장소: 직전 세션 자동 복원 (config.restoreSession=false 또는 robot 지정 시 생략)
const timeline = new Timeline(ctrl);
const projects = new ProjectStore(ctrl, path.join(DATA_DIR, 'projects'));
if (config.restoreSession !== false && !config.robot && !cli.noAutosave) projects.restoreAutosave();
if (!cli.noAutosave && config.autosave !== false) projects.startAutosave();

// 설정 우선순위: 기본값 < config.json < 환경변수(PORT, HOST, ROBOT_EMU_*) < CLI 인자
//  host: 바인딩 주소. 기본 '127.0.0.1'(이 PC 에서만 접속). 다른 PC·PLC 에서 접속하려면 '0.0.0.0'(모든 인터페이스).
//        protocols.<키>.host 를 따로 주지 않은 통신 모듈에도 같은 값이 적용된다.
//  allowedHosts: 웹 UI 를 IP 가 아닌 호스트 이름(예: 'robot-pc.local')으로 열 때 그 이름 목록 (DNS 리바인딩 방어)
function loadConfig() {
  const def = {
    httpPort: 3000,
    host: '127.0.0.1',
    allowedHosts: [],
    dataDir: null,
    airGapped: false,
    security: { token: '', readOnlyToken: '', ipAllowlist: [], allowUpdateApply: null },
    robot: null, gripper: null,
    // Claude 채팅. enabled: false 면 폐쇄망 환경용으로 UI/WS 채팅을 완전히 비활성화
    //   backend: 'auto'(API 키 환경변수가 있으면 api, 없으면 claude-code) | 'api'(ANTHROPIC_API_KEY 또는 ant auth login)
    //   | 'claude-code'(설치된 Claude Code CLI 의 구독 로그인 사용, API 키 불필요). 환경변수 AI_BACKEND 로도 지정
    ai: { enabled: true, backend: 'auto', model: 'claude-opus-5-5', effort: 'high', fallbacks: true, cliModel: null },
    // 업데이트: enabled(새 버전 자동 확인), intervalHours(확인 주기), allowApply(화면에서 원클릭 업데이트 허용),
    //   repo('owner/name', 기본 package.json repository), sponsorUrl(후원 링크, 기본 package.json funding)
    update: { enabled: true, intervalHours: 24, allowApply: true },
    // 프로토콜 활성화 방식: 'vendor'(기본: 현재 제조사 + 필드버스만 포트 바인딩) | 'all'(모든 제조사 동시 오픈)
    protocolMode: 'vendor',
    protocols: {
      yaskawaHse: { port: 10040, filePort: 10041 },
      kawasakiAs: { port: 23, fallbackPort: 10023 },
      hyundai: { port: 8888 },
      abbRws: { port: 8080 },
      kukaVarProxy: { port: 7000 },
      urDashboard: { port: 29999 },
      urRtde: { port: 30004 },
      doosanDrfl: { port: 12345 },
      modbus: { port: 502, fallbackPort: 1502 },
      ethernetIp: { port: 44818 },
      cclinkIeBasic: { port: 61450 },
      opcua: { port: 4840 },
    },
  };
  let cfg = def;
  const f = cli.config ? path.resolve(cli.config) : path.join(ROOT, 'config.json');
  if (fs.existsSync(f)) {
    try {
      const u = JSON.parse(fs.readFileSync(f, 'utf8'));
      const protocols = { ...def.protocols };
      for (const [k, v] of Object.entries(u.protocols || {})) protocols[k] = { ...(def.protocols[k] || {}), ...v };
      cfg = {
        ...def, ...u, protocols,
        ai: { ...def.ai, ...(u.ai || {}) },
        update: { ...def.update, ...(u.update || {}) },
        security: { ...def.security, ...(u.security || {}) },
      };
    } catch (e) { console.error('config.json 오류:', e.message); }
  }
  if (process.env.PORT) {
    const n = Number(process.env.PORT);
    if (Number.isInteger(n) && n >= 0 && n < 65536) cfg.httpPort = n;
    else console.error(`PORT 환경변수 값이 올바르지 않습니다: ${process.env.PORT}`);
  }
  if (process.env.HOST) cfg.host = process.env.HOST;
  if (process.env.ROBOT_EMU_DATA_DIR) cfg.dataDir = process.env.ROBOT_EMU_DATA_DIR;
  if (process.env.ROBOT_EMU_TOKEN) cfg.security.token = process.env.ROBOT_EMU_TOKEN;
  if (process.env.ROBOT_EMU_READONLY_TOKEN) cfg.security.readOnlyToken = process.env.ROBOT_EMU_READONLY_TOKEN;
  if (cli.port !== undefined && Number.isInteger(cli.port) && cli.port >= 0 && cli.port < 65536) cfg.httpPort = cli.port;
  if (cli.host) cfg.host = cli.host;
  if (cli.dataDir) cfg.dataDir = cli.dataDir;
  if (cli.token) cfg.security.token = cli.token;
  if (cli.readOnlyToken) cfg.security.readOnlyToken = cli.readOnlyToken;
  if (cli.airGapped || cfg.airGapped) {
    cfg.airGapped = true;
    cfg.ai.enabled = false;
    cfg.update.enabled = false;
    cfg.update.allowApply = false;
  }
  if (cli.noAi) cfg.ai.enabled = false;
  if (cli.noUpdate) { cfg.update.enabled = false; cfg.update.allowApply = false; }
  // 0.0.0.0 / :: 외부 공개 시 명시적 허용이 없으면 원격 원클릭 업데이트 적용 차단
  if ((cfg.host === '0.0.0.0' || cfg.host === '::') && cfg.security.allowUpdateApply !== true) {
    cfg.update.allowApply = false;
  }
  if (cfg.host) {
    for (const k of Object.keys(cfg.protocols)) {
      const p = cfg.protocols[k];
      if (p && typeof p === 'object' && p.host == null) cfg.protocols[k] = { ...p, host: cfg.host };
    }
  }
  return cfg;
}

// ---------------------------------------------------------------- 정적 파일
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary' };
const STATIC = [
  ['/vendor/three/', path.join(ROOT, 'node_modules/three/')],
  ['/vendor/occt/', path.join(ROOT, 'node_modules/occt-import-js/dist/')],   // STEP/IGES 변환 (브라우저 WASM)
  ['/assets/models/', ASSET_DIR + path.sep],
  ['/shared/', path.join(ROOT, 'shared/')],
  ['/examples/', path.join(ROOT, 'examples/')],
  ['/', path.join(ROOT, 'public/')],
];

function serveStatic(req, res) {
  let url;
  try { url = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end('Bad request'); }
  if (url === '/') url = '/index.html';
  for (const [prefix, dir] of STATIC) {
    if (!url.startsWith(prefix)) continue;
    const file = path.join(dir, url.slice(prefix.length));
    if (!file.startsWith(dir)) break;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
      return;
    }
  }
  res.writeHead(404); res.end('Not found');
}

// ---------------------------------------------------------------- 명령 처리 (WS/REST 공용)
let comms = [];
let protoMgr = null;
const commsPayload = () => comms.map(({ key, vendor, name, proto, port, configuredPort, active, standby, error }) => ({ key, vendor, name, proto, port, configuredPort, active, standby, error }));

async function handleCmd(m) {
  switch (m.cmd) {
    case 'setRobot': ctrl.setRobot(m.id); return { files: filesMsg() };
    case 'setGripper': ctrl.setGripper(m.id); return;
    case 'customGripper': ctrl.setCustomGripper(m.def); return;
    case 'cameras': ctrl.setCameras(m.list); return;
    case 'servo': return { ok: ctrl.setServo(m.on, 'ui') !== false, reject: ctrl.lastReject };
    case 'mode': return { ok: ctrl.setMode(m.mode, 'ui') !== false };
    case 'override': ctrl.setOverride(m.value); return;
    case 'setPayload': return { payload: ctrl.setPayload(m.mass, m.cog) };
    case 'setAccelScale': return { accelScale: ctrl.setAccelScale(m.value) };
    case 'timeScale': ctrl.setTimeScale(m.value); return;
    case 'timeScaleLock': ctrl.setTimeScaleLock(m.on); return;
    case 'jog': ctrl.startJog(m.jog, 'ui'); return;
    case 'stepJog': return ctrl.stepJog(m.jog, 'ui');
    case 'jogStop': ctrl.stopJog(); return;
    case 'goToPoint': return await ctrl.goToPoint(m, 'ui');
    case 'setPP': return ctrl.setPP(m.file, m.line);
    case 'setActiveFrames': return { frames: ctrl.setActiveFrames(m) };
    case 'setFrame': return { entry: ctrl.setFrame(m.kind, m.id, m), frames: ctrl.frames };
    case 'teachUserFrame3Pt': return { entry: ctrl.teachUserFrame3Pt(m.id, m), frames: ctrl.frames };
    case 'protocolMode': {
      if (!protoMgr) return { protocolMode: config.protocolMode };
      comms = await protoMgr.setMode(m.mode);
      return { protocolMode: protoMgr.mode, comms: commsPayload() };
    }
    case 'setJoints': return ctrl.teachJoints(m.joints, 'ui');   // 펜던트 관절 직접 지정 = 조그와 같은 조건
    case 'teachPose': return ctrl.teachPose({ p: m.p, q: m.q, allowJump: !!m.allowJump }, 'ui');   // p[3] mm, q[4] 쿼터니언 — 형식 검사는 teachPose 에서
    case 'teachJoints': return ctrl.teachJoints(m.joints, 'ui');      // 직접교시: 관절 드래그 · 되돌리기
    case 'moveJoints':
      ctrl.move({ kind: 'J', target: { joints: m.joints }, speed: { frac: m.speed ?? 0.3 }, source: 'ui' }).catch((e) => !e.aborted && !String(e.code).startsWith('REJECT') && ctrl.alarm(e.code || 'MOTION', e.message));
      return;
    case 'moveHome':
      ctrl.move({ kind: 'J', target: { joints: [...ctrl.robot.home] }, speed: { frac: 0.3 }, source: 'ui' }).catch((e) => !e.aborted && !String(e.code).startsWith('REJECT') && ctrl.alarm(e.code || 'MOTION', e.message));
      return;
    case 'setDO': ctrl.setDO(m.n, m.v); return;
    case 'setDI': ctrl.setDI(m.n, m.v); return;
    case 'setAI': ctrl.setAI(m.n, m.v); return;
    case 'setAO': ctrl.setAO(m.n, m.v); return;
    case 'aioConfig': ctrl.setAioConfig(m.type, m.n, m); return;
    case 'ioGroups': return { ioGroups: ctrl.setIoGroups(m.list) };
    case 'writeGroupIO': return { value: ctrl.writeGroupIO(m.id, m.value) };
    case 'zones': return { zones: ctrl.setZones(m.list) };
    case 'visionTrigger': return ctrl.triggerVision(m.camId, { deterministic: !!m.deterministic });
    case 'gripperIO': {   // { map: { close, open, fbClosed, fbOpen, fbPart } } — 번호는 정수 1~512
      const next = { ...ctrl.gripperIO };
      for (const [k, v] of Object.entries(m.map || {})) {
        if (!(k in next)) throw new Error(`알 수 없는 그리퍼 신호: ${k}`);
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 512) throw new Error(`그리퍼 신호 ${k} 번호가 올바르지 않습니다: ${v} (1~512)`);
        next[k] = n;
      }
      Object.assign(ctrl.gripperIO, next); ctrl._bumpRev?.('gripperIO'); ctrl.emitState(); return;
    }
    case 'saveFile':
      if (typeof m.name !== 'string' || !m.name.trim()) throw new Error('파일 이름(name)이 필요합니다');
      if (typeof m.text !== 'string') throw new Error('파일 내용(text)이 필요합니다');
      ctrl.loadFiles({ [m.name]: m.text }); return { files: filesMsg() };
    case 'deleteFile': ctrl.deleteFile(m.name); return { files: filesMsg() };
    case 'setMain': ctrl.setMain(m.name); return;
    case 'start': return { ok: await ctrl.start({ step: false, source: 'ui' }), reject: ctrl.lastReject };
    case 'step': return { ok: await ctrl.start({ step: true, source: 'ui' }), reject: ctrl.lastReject };
    case 'hold': ctrl.hold(); return;
    case 'resume': return { ok: ctrl.resume('ui') !== false, reject: ctrl.lastReject };
    case 'recoverPath': return ctrl.recoverPath('ui');
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
    case 'setFaults': return { faults: ctrl.setFaults(m.faults ?? m.patch) };
    case 'clearFaults': return { faults: ctrl.clearFaults() };
    case 'injectFault': ctrl.injectFaultAction(m.kind ?? (m.action === 'alarm' ? m.code : m.action), m.msg); return;
    case 'traffic': return { traffic: ctrl.traffic?.snapshot(m) ?? { entries: [], clients: [], stats: { total: 0, errors: 0, dropped: 0, buffered: 0 } } };
    case 'trafficClear': ctrl.traffic?.clear(); return;
    case 'projectList': return { projects: projects.list(), current: projects.current };
    case 'projectSave': projects.save(String(m.name || '').trim()); return { projects: projects.list(), current: projects.current };
    case 'projectLoad': projects.load(m.name); return { files: filesMsg(), current: projects.current };
    case 'projectDelete': projects.remove(m.name); return { projects: projects.list() };
    case 'projectExport': return { project: projects.serialize(m.name) };
    case 'projectImport': projects.apply(m.project); return { files: filesMsg(), current: projects.current };
    case 'safety':   // { estop?, fence?, enable?, requireEnable?, fenceStop?, teachSpeedLimit?, interlock? }
      if (m.estop !== undefined) ctrl.setEstop(m.estop, 'ui');
      if (m.fence !== undefined) ctrl.setFence(m.fence);
      if (m.enable !== undefined) ctrl.setEnableSwitch(m.enable);
      ctrl.setSafetyOptions(m);
      return;
    case 'sysio':    // { op:'presets' } | { op:'set', config:{enabled, preset, diBase, doBase, assign, logic, programs} }
      if (m.op === 'presets') return { presets: SystemIO.presetList() };
      ctrl.sysio.configure(m.config || {});
      return { sysio: ctrl.sysio.snapshot() };
    case 'ioLabel': ctrl.setIoLabel(m.type, m.n, { name: m.name, desc: m.desc }); return;
    case 'ioLabels': if (m.labels) ctrl.setIoLabels(m.labels); return { labels: ctrl.ioLabels };
    case 'state': return { state: ctrl.snapshot() };
    // 화면 언어 → 예제 프로그램 주석 언어. 손대지 않은 예제는 그 언어로 다시 생성
    case 'uiLang': {
      const l = m.lang === 'en' ? 'en' : 'ko';
      if (ctrl.uiLang === l) return;
      const untouched = ctrl.isExampleUntouched();
      ctrl.uiLang = l;
      if (untouched && !['running', 'paused'].includes(ctrl.vm?.status)) { ctrl.loadExample(); return { files: filesMsg() }; }
      return;
    }
    // 버전·업데이트 (정보 창)
    case 'about': return { about: updater.info() };
    case 'updateCheck': await updater.check(); return { about: updater.info() };
    case 'updateApply': {   // 오래 걸리므로 시작만 하고 진행 상황은 'about' 브로드캐스트·로그로 알림
      const why = await updater.blocker();
      if (why) throw new Error(why);
      updater.apply().catch(() => {});
      return { started: true };
    }
    default: throw new Error(m.cmd === undefined ? '명령(cmd)이 없습니다' : `알 수 없는 명령: ${m.cmd}`);
  }
}

const filesMsg = () => ({ main: ctrl.main, files: Object.fromEntries(ctrl.files) });

// 바이너리 본문 읽기 (상한 초과 시 413 응답을 안전히 보낼 수 있도록 destroy 대신 pause)
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0, done = false;
    const finish = (err, val) => { if (done) return; done = true; err ? reject(err) : resolve(val); };
    req.on('data', (c) => {
      if (done) return;
      n += c.length;
      if (n > max) { finish(Object.assign(new Error(`업로드 크기 상한(${Math.round(max / 1048576)} MB) 초과`), { status: 413 })); req.pause(); return; }
      chunks.push(c);
    });
    req.on('end', () => finish(null, Buffer.concat(chunks)));
    req.on('error', (e) => finish(e));
    req.on('close', () => { if (!req.complete) finish(new Error('요청이 중단되었습니다')); });
  });
}

// ---------------------------------------------------------------- HTTP 서버
let serverReady = false;
const READ_ONLY_CMDS = new Set(['getFiles', 'vars', 'timeline', 'traffic', 'projectList', 'projectExport', 'state', 'about']);
function isReadOnlyCmd(m) {
  if (!m || typeof m !== 'object') return false;
  if (READ_ONLY_CMDS.has(m.cmd)) return true;
  if (m.cmd === 'sysio' && m.op === 'presets') return true;
  if (m.cmd === 'cell' && m.op === 'get') return true;
  if (m.cmd === 'ioLabels' && !m.labels) return true;
  return false;
}

const server = http.createServer((req, res) => {
  handleHttp(req, res).catch((e) => {
    console.error('HTTP 처리 오류:', e);
    if (!res.headersSent) { res.writeHead(500); res.end(); } else res.destroy();
  });
});

async function handleHttp(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end('Bad request'); }
  // 컨테이너·오케스트레이터용 헬스/레디니스 프로브 (인증 불필요)
  if (url.pathname === '/healthz' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, uptimeSec: Math.round(process.uptime()), version: updater.info().version }));
  }
  if (url.pathname === '/readyz' && req.method === 'GET') {
    res.writeHead(serverReady ? 200 : 503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: serverReady, ready: serverReady, protocols: commsPayload() }));
  }
  // /api · /mcp 는 로봇을 움직일 수 있으므로 다른 사이트(브라우저)발 요청 및 비허용 IP 차단 + 토큰 인증
  if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') {
    const why = requestRejected(req);
    if (why) {
      ctrl.log('comm', `요청 거부 (${url.pathname}): ${why}`);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: why }));
    }
    if (url.pathname.startsWith('/api/') && req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const role = authRole(req);
    if (!role) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
      return res.end(JSON.stringify({ error: '인증 토큰이 필요합니다' }));
    }
    req._role = role;
  }
  if (url.pathname.startsWith('/api/')) {
    const isReadOnly = req._role === 'readonly';
    if (isReadOnly && req.method !== 'GET' && url.pathname !== '/api/cmd') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '읽기 전용(관찰자) 권한입니다' }));
    }
    if (url.pathname === '/api/timeline.csv' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="timeline.csv"' });
      return res.end(timeline.toCSV(ctrl.ioLabels));
    }
    if (url.pathname === '/api/traffic.csv' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="traffic.csv"' });
      return res.end(ctrl.traffic?.toCSV() ?? 'seq,timestamp,interface,client,dir,ok,ms,summary,error,raw,hex\n');
    }
    try {
      let out;
      if (url.pathname === '/api/state') out = ctrl.snapshot();
      else if (url.pathname === '/api/robots') out = { robots: ROBOTS, grippers: GRIPPERS, vendors: VENDORS, cameras: CAMERAS };
      else if (url.pathname === '/api/comms') out = comms.map(({ key, name, proto, port }) => ({ key, name, proto, port }));
      else if (url.pathname === '/api/traffic' && req.method === 'GET') {
        out = ctrl.traffic?.snapshot({
          limit: url.searchParams.get('limit'),
          iface: url.searchParams.get('iface') || '',
          errorsOnly: url.searchParams.get('errors') === '1',
          search: url.searchParams.get('q') || '',
        }) ?? { entries: [], clients: [], stats: { total: 0, errors: 0, dropped: 0, buffered: 0 } };
      }
      else if (url.pathname === '/api/assets' && req.method === 'GET') out = { models: ctrl.assets.list() };
      else if (url.pathname === '/api/assets' && req.method === 'POST') {
        // 3D 모델 업로드 (server/assets.js 형식) → 메타. 같은 자산을 참조하던 모델이 있으면 간섭 메시 갱신
        const body = await readBody(req, MAX_UPLOAD);
        out = ctrl.assets.save(body);
        ctrl.cell.refreshModels?.(out.id);
      }
      // 프로젝트 파일 1개로 내보내기/가져오기 (3D 모델 묶음 포함 — 크기가 커서 WebSocket 대신 HTTP)
      else if (url.pathname === '/api/project/export' && req.method === 'GET') {
        out = projects.serialize(url.searchParams.get('name') || undefined, { bundle: url.searchParams.get('bundle') !== '0' });
      }
      else if (url.pathname === '/api/project/import' && req.method === 'POST') {
        const body = await readBody(req, MAX_UPLOAD * 2);
        let p;
        try { p = JSON.parse(body.toString('utf8')); } catch { throw new Error('프로젝트 파일이 JSON 형식이 아닙니다'); }
        projects.apply(p);
        out = { files: filesMsg(), current: projects.current, models: Object.keys(p.assets || {}).length };
      }
      else if (url.pathname === '/api/backup/import' && req.method === 'POST') {
        const body = await readBody(req, MAX_UPLOAD * 2);
        const ct = String(req.headers['content-type'] || '');
        let res;
        let replace = url.searchParams.get('replace') !== '0';
        let vendorHint = url.searchParams.get('vendor') || null;
        if (isZipBuffer(body) || /zip|octet-stream/i.test(ct)) {
          res = importBackup(body, { vendor: vendorHint });
        } else {
          let p;
          try { p = JSON.parse(body.toString('utf8')); } catch { throw new Error('백업 입력이 ZIP 또는 JSON 형식이 아닙니다'); }
          if (p.replace !== undefined) replace = !!p.replace;
          if (p.vendor) vendorHint = p.vendor;
          res = importBackup(p.files || p, { vendor: vendorHint });
        }
        if (!res.count) throw new Error('가져올 수 있는 로봇 프로그램 파일이 없습니다');
        if (res.vendor && res.vendor !== ctrl.vendor && url.searchParams.get('switchVendor') !== '0') {
          const match = ROBOTS.find((r) => r.vendor === res.vendor);
          if (match) ctrl.setRobot(match.id);
        }
        ctrl.loadFiles(res.files, replace);
        scheduleFilesBroadcast();
        out = { ok: true, vendor: res.vendor, count: res.count, files: Object.keys(res.files), skipped: res.skipped, compileError: ctrl.compileError };
      }
      else if (url.pathname === '/api/cmd' && req.method === 'POST') {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
          res.writeHead(415, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Content-Type: application/json 이 필요합니다' }));
        }
        const body = (await readBody(req, 16e6)).toString('utf8');
        let m;
        try { m = JSON.parse(body || '{}'); } catch { throw new Error('JSON 형식 오류'); }
        if (isReadOnly && !isReadOnlyCmd(m)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: '읽기 전용(관찰자) 권한입니다' }));
        }
        out = (await handleCmd(m)) ?? { ok: true };
      } else { res.writeHead(404); return res.end('{"error":"not found"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(e.status || 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url.pathname === '/mcp') {
    if (req._role !== 'admin') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '읽기 전용(관찰자) 권한입니다' }));
    }
    try { await handleMcp(ctrl, req, res); } catch (e) { if (!res.headersSent) { res.writeHead(500); res.end(); } ctrl.log('comm', `[MCP] 오류: ${e.message}`); }
    return;
  }
  serveStatic(req, res);
}

// ---------------------------------------------------------------- WebSocket
const wss = new WebSocketServer({
  server, path: '/ws', maxPayload: 16 * 1024 * 1024,
  verifyClient: ({ req }) => {
    const why = requestRejected(req);
    if (why) { ctrl.log('comm', `WebSocket 접속 거부: ${why}`); return false; }
    const role = authRole(req);
    if (!role) { ctrl.log('comm', 'WebSocket 접속 거부: 인증 토큰이 필요합니다'); return false; }
    req._role = role;
    return true;
  },
});
const WS_MAX_BUFFERED = 2 * 1024 * 1024;
const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
const broadcast = (msg, { droppable = false } = {}) => {
  if (!wss.clients.size) return;
  const s = JSON.stringify(msg);
  for (const c of wss.clients) {
    if (c.readyState !== 1) continue;
    if (droppable && c.bufferedAmount > WS_MAX_BUFFERED) continue;
    c.send(s);
  }
};

// 단일 제어권(Single-Writer Pendant Lock): 다중 브라우저 동시 접속 시 오조작 방지
let nextClientId = 1, controllerWs = null;
const lockPayload = () => ({ holder: controllerWs?._cid ?? null, clients: wss.clients.size });
const broadcastLock = () => broadcast({ type: 'controlLock', ...lockPayload() });

// Claude 채팅: 연결(브라우저 탭)마다 대화 세션 1개. SDK 는 처음 사용할 때 불러옴
let ChatSession = null, chatBackend = null;
async function resolveChatBackend() {
  if (chatBackend) return chatBackend;
  const want = process.env.AI_BACKEND || config.ai.backend || 'auto';
  if (want === 'api' || want === 'claude-code') chatBackend = want;
  else if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) chatBackend = 'api';
  else chatBackend = (await import('./ai/chat-cli.js')).claudeCliAvailable(config.ai.cliCommand) ? 'claude-code' : 'api';
  ctrl.log('system', `Claude 채팅 백엔드: ${chatBackend === 'api' ? 'Claude API' : 'Claude Code CLI (구독 로그인)'}`);
  return chatBackend;
}
// 채팅(Claude Code 백엔드)이 접속할 이 서버의 MCP 주소
function localMcpUrl() {
  const h = config.host;
  const host = !h || h === '0.0.0.0' || h === '::' ? '127.0.0.1' : h.includes(':') ? `[${h}]` : h;
  const tok = config.security?.token ? `?token=${encodeURIComponent(config.security.token)}` : '';
  return `http://${host}:${server.address()?.port ?? config.httpPort}/mcp${tok}`;
}
async function chatSession(ws) {
  if (ws.chat) return ws.chat;
  if (!ws._chatPromise) {
    ws._chatPromise = (async () => {
      const sendChat = (ev) => send(ws, { type: 'chat', ...ev });
      let session;
      if (await resolveChatBackend() === 'claude-code') {
        const { ClaudeCodeSession } = await import('./ai/chat-cli.js');
        session = new ClaudeCodeSession({ ctrl, config: config.ai, mcpUrl: localMcpUrl(), send: sendChat });
      } else {
        ChatSession ??= (await import('./ai/chat.js')).ChatSession;
        session = new ChatSession({ ctrl, config: config.ai, send: sendChat });
      }
      if (ws.readyState !== 1) { session.stop?.(); return null; }
      ws.chat = session;
      return session;
    })().finally(() => { ws._chatPromise = null; });
  }
  return ws._chatPromise;
}

wss.on('connection', (ws, req) => {
  ws._alive = true;
  ws._cid = nextClientId++;
  ws._role = req._role || authRole(req) || 'admin';
  if (ws._role === 'admin' && !controllerWs) controllerWs = ws;
  ws.on('pong', () => { ws._alive = true; });
  ws.on('close', () => {
    ws.chat?.stop();
    if (controllerWs === ws) {
      controllerWs = null;
      for (const c of wss.clients) {
        if (c !== ws && c.readyState === 1 && c._role === 'admin') { controllerWs = c; break; }
      }
    }
    broadcastLock();
  });
  send(ws, {
    type: 'init', robots: ROBOTS, grippers: GRIPPERS, vendors: VENDORS, cameras: CAMERAS,
    state: ctrl.snapshot(), logs: ctrl.logs.slice(-200), files: filesMsg(),
    comms: commsPayload(), protocolMode: protoMgr?.mode ?? (config.allProtocols ? 'all' : config.protocolMode || 'vendor'),
    aiEnabled: config.ai?.enabled !== false,
    clientId: ws._cid, role: ws._role, controlLock: lockPayload(),
    about: updater.info(),
  });
  broadcastLock();
  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    // 요청 번호: rid (권장). 예전 형식 id 도 받지만, setRobot·cell 등은 인자 이름도 id 라 겹치므로 rid 를 쓰십시오
    const reqId = m.rid !== undefined ? m.rid : m.id;
    if (m.cmd === 'claimControl') {
      if (ws._role !== 'admin') {
        if (reqId !== undefined) send(ws, { type: 'reply', id: reqId, ok: false, error: '읽기 전용(관찰자) 권한입니다' });
        return;
      }
      controllerWs = ws;
      broadcastLock();
      if (reqId !== undefined) send(ws, { type: 'reply', id: reqId, ok: true, holder: ws._cid });
      return;
    }
    if (m.cmd === 'releaseControl') {
      if (controllerWs === ws) { controllerWs = null; broadcastLock(); }
      if (reqId !== undefined) send(ws, { type: 'reply', id: reqId, ok: true, holder: controllerWs?._cid ?? null });
      return;
    }
    if (m.cmd === 'chat' || m.cmd === 'chatStop' || m.cmd === 'chatReset') {
      if (config.ai?.enabled === false) {
        send(ws, { type: 'chat', ev: 'error', msg: '폐쇄망 설정(config.ai.enabled=false)으로 AI 채팅이 비활성화되어 있습니다.' });
        return;
      }
      if (ws._role !== 'admin') {
        send(ws, { type: 'chat', ev: 'error', msg: '읽기 전용(관찰자) 권한입니다.' });
        return;
      }
      if (controllerWs && controllerWs !== ws) {
        send(ws, { type: 'chat', ev: 'error', msg: '다른 브라우저가 제어권을 보유 중입니다. 상단의 "제어권 가져오기"를 누르세요.' });
        return;
      }
      try {
        const c = await chatSession(ws);
        if (!c || ws.readyState !== 1) return;
        if (m.cmd === 'chat') c.ask(String(m.text ?? '').slice(0, 20000)); else if (m.cmd === 'chatStop') c.stop(); else c.reset();
      } catch (e) { send(ws, { type: 'chat', ev: 'error', msg: `채팅을 시작할 수 없습니다: ${e.message}` }); }
      return;
    }
    if (m.cmd === 'uiLang' && (ws._role !== 'admin' || (controllerWs && controllerWs !== ws))) {
      if (reqId !== undefined) send(ws, { type: 'reply', id: reqId, ok: true });
      return;
    }
    if (!isReadOnlyCmd(m)) {
      if (ws._role !== 'admin') {
        if (reqId !== undefined) send(ws, { type: 'reply', id: reqId, ok: false, error: '읽기 전용(관찰자) 권한입니다' });
        return;
      }
      if (controllerWs && controllerWs !== ws) {
        if (reqId !== undefined) send(ws, { type: 'reply', id: reqId, ok: false, error: '다른 브라우저가 제어권을 보유 중입니다 ("제어권 가져오기"를 누르세요)' });
        return;
      }
    }
    try {
      const r = await handleCmd(m);
      if (r?.files) scheduleFilesBroadcast();
      if (reqId !== undefined) send(ws, { type: 'reply', id: reqId, ok: true, ...r });
    } catch (e) {
      ctrl.log('system', `명령 오류(${m.cmd}): ${e.message}`);
      if (reqId !== undefined) send(ws, { type: 'reply', id: reqId, ok: false, error: e.message });
    }
  });
});

// WebSocket 좀비 연결 정리 (30s ping/pong)
const wsPingTimer = setInterval(() => {
  for (const c of wss.clients) {
    if (c._alive === false) { try { c.terminate(); } catch {} continue; }
    c._alive = false;
    try { c.ping(); } catch {}
  }
}, 30_000);
wsPingTimer.unref();

// 상태 브로드캐스트 (최대 30Hz)
//  자주 바뀌지 않는 큰 항목은 리비전 카운터(ctrl._rev)로 O(1) 비교 후 직전 전송과 같으면 뺀다 (app.js STICKY).
//  접속된 웹 클라이언트가 없으면 스냅샷 생성 자체를 생략한다.
const STICKY = ['sysio', 'cell', 'scene', 'safety', 'ioLabels', 'gripperIO', 'cameras', 'faults', 'frames', 'zones', 'vision'];
const lastStickyRev = {};
function stateDelta(st) {
  const rev = ctrl._rev;
  for (const k of STICKY) {
    if (!(k in st)) continue;
    const r = rev?.[k];
    if (r !== undefined && lastStickyRev[k] === r) delete st[k];
    else lastStickyRev[k] = r;
  }
  return st;
}
let pending = false;
ctrl.on('state', () => {
  if (pending || !wss.clients.size) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    if (!wss.clients.size) return;
    broadcast({ type: 'state', state: stateDelta(ctrl.snapshot()) }, { droppable: true });
  }, 33);
});
// 로그는 100ms 단위로 묶어 전송 (반복문 안의 출력이 쏟아져도 클라이언트·네트워크가 버티도록, 묶음당 최대 300개)
let logQ = [], logDropped = 0;
ctrl.on('log', (e) => {
  if (!wss.clients.size) return;
  if (logQ.length >= 300) { logDropped++; return; }
  logQ.push(e);
  if (logQ.length === 1) setTimeout(flushLogs, 100);
});
function flushLogs() {
  if (logDropped) { logQ.push({ t: Date.now(), src: 'system', msg: `로그 ${logDropped}개 생략 (너무 많음)` }); logDropped = 0; }
  const q = logQ; logQ = [];
  if (q.length === 1) broadcast({ type: 'log', entry: q[0] }, { droppable: true });
  else if (q.length) broadcast({ type: 'logs', entries: q }, { droppable: true });
}
// 타임라인 이벤트는 100ms 단위로 묶어 전송
let tlPending = [];
timeline.listeners.add((e) => { if (wss.clients.size) tlPending.push(e); });
const tlTimer = setInterval(() => { if (tlPending.length) { broadcast({ type: 'tl', events: tlPending, now: Math.round(ctrl.simMs) }, { droppable: true }); tlPending = []; } }, 100);
tlTimer.unref();

// 이벤트 기반 파일 변경 브로드캐스트 (외부 프로토콜·REST·MCP·UI 모든 경로에서 동일 길이 수정도 즉시 반영)
let filesTimer = null;
function scheduleFilesBroadcast() {
  if (filesTimer || !wss.clients.size) return;
  filesTimer = setTimeout(() => {
    filesTimer = null;
    if (wss.clients.size) broadcast({ type: 'files', ...filesMsg() });
  }, 20);
}
ctrl.on('files', scheduleFilesBroadcast);

// 통신 트래픽 모니터 스트리밍 (150ms 배치, 최대 100건/배치)
let trQ = [], trTimer = null;
function attachTrafficStream() {
  if (!ctrl.traffic || ctrl.traffic._streamBound) return;
  ctrl.traffic._streamBound = true;
  const flush = () => {
    trTimer = null;
    if (!wss.clients.size) { trQ = []; return; }
    const entries = trQ; trQ = [];
    broadcast({ type: 'traffic', entries, clients: ctrl.traffic.listClients(), stats: { ...ctrl.traffic.stats, buffered: ctrl.traffic._size } }, { droppable: true });
  };
  ctrl.traffic.on('entry', (e) => {
    if (!wss.clients.size) return;
    if (trQ.length < 100) trQ.push(e);
    if (!trTimer) trTimer = setTimeout(flush, 150);
  });
  ctrl.traffic.on('client', () => {
    if (ctrl.lockTimeScaleOnExt && ctrl.timeScale !== 1 && ctrl.traffic.listClients().length > 0) {
      ctrl.timeScale = 1;
      ctrl.log('system', '외부 클라이언트 접속 + ×1 배속 잠금 → 배속을 ×1로 복원');
    }
    ctrl.emitState();
    if (!wss.clients.size) return;
    if (!trTimer) trTimer = setTimeout(flush, 150);
  });
  ctrl.traffic.on('clear', () => {
    trQ = [];
    broadcast({ type: 'trafficClear' });
  });
}

server.on('error', (e) => {
  console.error(`HTTP 서버 시작 실패 (${config.host ?? '*'}:${config.httpPort}): ${e.code === 'EADDRINUSE' ? '포트가 이미 사용 중입니다. config.json 의 httpPort 또는 PORT 환경변수로 바꾸세요.' : e.message}`);
  process.exit(1);
});

server.listen(config.httpPort, config.host || undefined, async () => {
  const actualPort = server.address()?.port ?? config.httpPort;
  const shown = !config.host || config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  console.log(`\n  산업용 로봇 에뮬레이터  →  http://${shown}:${actualPort}`);
  // 휴대용 꾸러미(더블클릭 실행): 브라우저 자동 열기. --headless 또는 업데이트 후 재시작 때는 열지 않음
  if (!cli.headless && process.env.ROBOT_EMU_OPEN === '1' && !process.env.ROBOT_EMU_RESTARTED) openBrowser(`http://${shown}:${actualPort}/`);
  const authNote = authConfigured() ? '인증 토큰 활성' : '인증 없음, 신뢰할 수 있는 네트워크에서만 사용';
  console.log(config.host && /^(127\.|::1$|localhost$)/i.test(config.host) ? `  (이 PC 에서만 접속 가능${authConfigured() ? ' · 인증 토큰 활성' : ''})\n` : `  (바인딩: ${config.host || '모든 인터페이스'} — ${authNote})\n`);
  try {
    const { ProtocolManager } = await import('./protocols/index.js');
    const mode = config.allProtocols ? 'all' : (config.protocolMode === 'all' ? 'all' : 'vendor');
    protoMgr = new ProtocolManager(ctrl, config.protocols, {
      mode,
      onChange: (list, pm) => {
        comms = list;
        broadcast({ type: 'comms', comms: commsPayload(), protocolMode: pm });
      },
    });
    comms = await protoMgr.sync();
    attachTrafficStream();
    for (const c of comms) {
      const st = c.active ? (c.port ?? '(실패)') : `(대기:${c.configuredPort ?? '-'})`;
      console.log(`  [통신] ${c.name.padEnd(28)} ${c.proto.padEnd(5)} ${st}`);
    }
  } catch (e) {
    console.error('통신 모듈 시작 실패:', e.message);
  } finally {
    serverReady = true;
  }
  updater.start();
});

// 업데이트 상태 변화 → 모든 화면에 알림. 적용이 끝나면 재시작 (npm start = launcher 가 다시 띄움)
updater.on('change', (about) => broadcast({ type: 'about', about }));
updater.on('restart', (tag) => {
  broadcast({ type: 'restarting', tag });
  if (process.env.ROBOT_EMU_LAUNCHER) setTimeout(() => shutdown('update', 75), 300);
  else {
    ctrl.log('system', `[업데이트] ${tag} 설치 완료 — 'npm start' 로 실행하지 않아 자동 재시작할 수 없습니다. 서버를 직접 다시 시작하세요`);
    updater._set({ applying: null, restartNeeded: tag });
  }
});

// 기본 브라우저로 URL 열기 (실패해도 무시 — 콘솔의 주소로 직접 열면 됨)
function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  import('node:child_process').then(({ spawn }) => {
    try { spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref(); } catch {}
  });
}

// 최후 안전망: 처리되지 않은 Promise 거부로 프로세스가 종료되지 않게 (기본 동작은 종료) — 기록만 남김
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e);
  try { ctrl.log('system', `내부 오류(처리되지 않은 거부): ${e?.message ?? e}`); } catch {}
});
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e);
  try { projects.saveAutosave?.(); } catch {}
  process.exit(1);
});

// 종료 처리: Ctrl+C(SIGINT, 모든 OS), SIGTERM(Linux/macOS 서비스·컨테이너), SIGBREAK(Windows Ctrl+Break)
let shuttingDown = false;
// code: 종료 코드 (75 = 업데이트 후 재시작 요청 — server/launcher.js)
async function shutdown(sig, code = 0) {
  if (shuttingDown) return process.exit(1);   // 두 번째 신호는 즉시 종료
  shuttingDown = true;
  console.log(`\n  종료 중 (${sig})...`);
  clearInterval(wsPingTimer);
  clearInterval(tlTimer);
  try { projects.saveAutosave?.(); } catch {}
  const force = setTimeout(() => process.exit(code), 3000);
  force.unref();
  if (protoMgr) await protoMgr.closeAll().catch(() => {});
  else await Promise.allSettled(comms.map(async (c) => c.close?.()));
  try { for (const c of wss.clients) c.terminate(); server.closeAllConnections?.(); server.close(); } catch {}
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  try { process.on(sig, () => shutdown(sig)); } catch {}
}
