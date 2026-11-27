// ABB Robot Web Services 에뮬레이션 — HTTP (기본 8080, 실제 컨트롤러는 IRC5 80 / OmniCore 443)
//  - RWS 1.0 (IRC5, RobotWare 6) 경로/형식과 RWS 2.0 (OmniCore, RobotWare 7) 경로/형식을 모두 지원
//  - 인증: Basic/Digest 모두 관대하게 허용 (Default User / robotics 또는 인증 없음). 세션 쿠키 -http-session-, ABBCX 발급
//  - 응답: 기본 XHTML (ABB <li class> + <span class> 구조), ?json=1 → RWS1 JSON,
//          Accept: application/hal+json;v=2.0 → RWS2 JSON, Accept: application/xhtml+xml;v=2.0 → RWS2 XHTML
//  - 구독: POST /subscription → 201 + Location: ws://host/poll/{id}, WebSocket(서브프로토콜 robapi2_subscription / rws_subscription)으로 이벤트 푸시
//
// 지원 리소스 요약
//   /rw/motionsystem/mechunits[/ROB_1[/jointtarget|/robtarget|/cartesian]]
//   /rw/rapid/execution (GET, POST ?action=start|stop|resetpp, RWS2: /execution/start|stop|resetpp)
//   /rw/rapid/tasks[/T_ROB1[/pcp|/modules]] , POST /rw/rapid/tasks/T_ROB1?action=loadmod|unloadmod (RWS2: /loadmod, /unloadmod)
//   /rw/rapid/symbol/data/RAPID/T_ROB1/<mod>/<sym> (GET, POST ?action=set value=..)
//   /rw/rapid/symbol/RAPID/T_ROB1/<mod>/<sym>/data (RWS2 GET/POST value=..)
//   /rw/iosystem/signals[/<net>/<dev>/<name>|/<name>] (GET, POST ?action=set lvalue=1, RWS2 /set-value)
//   /rw/panel/ctrlstate (|/ctrl-state), /rw/panel/opmode, /rw/panel/speedratio (+ POST 액션)
//   /fileservice/$HOME/<path> GET/PUT/DELETE (디렉터리 GET 은 목록)
//   /rw/elog/0 (알람 이력), /ctrl/identity, /rw/system, /rw/system/robottype
//   /subscription (POST, DELETE /subscription/{id})
import http from 'node:http';
import { hostAllowed, originAllowed } from '../netguard.js';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { quatFromR } from '../../shared/math.js';
import { fkTcp } from '../../shared/kinematics.js';
import { makeLogger, bindServer, langExt, safeReadVar, safeWriteVar, makeCycleRunner, progRunning, readBody, stripExt, fx } from './common.js';
import { peerOf } from './traffic.js';

const TAG = 'ABB-RWS';
const RAPID_EXT = /\.(mod|modx|sys|sysx|prg|pgf)$/i;
const ERR = { MOTOR_OFF: -1073442812, NOT_FOUND: -1073445879, BAD_ARG: -1073445865, BUSY: -1073445860, BAD_STATE: -1073445861, PROGRAM: -1073442794 };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

class RwsError extends Error { constructor(status, msg, code = ERR.BAD_ARG) { super(msg); this.status = status; this.code = code; } }

// RAPID 값 문자열화 (rapid.js formatValue 가 없을 때)
function fmtRapid(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toPrecision(9));
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return `"${v}"`;
  if (Array.isArray(v)) return `[${v.map(fmtRapid).join(',')}]`;
  if (v.kind && Array.isArray(v.v)) return fmtRapid(v.v);
  if (typeof v === 'object') return `[${Object.values(v).map(fmtRapid).join(',')}]`;
  return String(v);
}
// RAPID 값 파싱 (rapid.js parseValue 가 없을 때)
function parseRapid(text) {
  const s = String(text).trim();
  if (/^TRUE$/i.test(s)) return true;
  if (/^FALSE$/i.test(s)) return false;
  if (/^".*"$/s.test(s)) return s.slice(1, -1);
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('[')) {
    try { return JSON.parse(s.replace(/\bTRUE\b/gi, 'true').replace(/\bFALSE\b/gi, 'false').replace(/(\d)E([+-]?\d)/g, '$1e$2')); } catch {}
  }
  return s;
}

export async function start(ctrl, opts = {}) {
  const port = opts.port ?? 8080;
  const host = opts.host ?? '0.0.0.0';
  const requireAuth = !!opts.requireAuth;
  const log = makeLogger(ctrl, TAG);
  const cycles = makeCycleRunner(ctrl, log);
  const MAX_FS_FILES = 512, MAX_FS_BYTES = 64 * 1024 * 1024;   // fileservice 저장소 상한
  const fsStore = new Map(); // fileservice 저장소: '$HOME/경로' 정규화 키(소문자) → {path, data:Buffer, mtime}
  const startTime = new Date();
  const sysId = crypto.randomUUID();
  let execCycle = 'once';
  const mastership = { rapid: 'nomaster', cfg: 'nomaster', edit: 'nomaster' };
  let elogSeq = 0;
  const elog = [];
  const onLog = (e) => {
    if (e.src !== 'alarm') return;
    const a = ctrl.alarms[ctrl.alarms.length - 1];
    const numMatch = /\d+/.exec(String(a?.vendorCode ?? a?.code ?? ''));
    const code = numMatch ? Number(numMatch[0]) : 50000;
    elog.unshift({ seq: ++elogSeq, type: 3, code, t: e.t, title: a?.vendorName ?? a?.code ?? 'ALARM', desc: e.msg });
    if (elog.length > 200) elog.pop();
  };
  ctrl.on('log', onLog);

  // ------------------------------------------------------------ 응답 형식
  function ctxOf(req, url) {
    const accept = String(req.headers.accept || '');
    const v2 = /v=2\.0/.test(accept) || /v=2\.0/.test(String(req.headers['content-type'] || ''));
    const json = url.searchParams.get('json') === '1' || /json/i.test(accept);
    return { v2, json, host: req.headers.host || `localhost:${port}` };
  }

  // body: {items:[{cls,title,href?,fields}], list?:bool, self?:string}
  function render(ctx, path, body) {
    const base = `http://${ctx.host}${path.replace(/[^/]*$/, '')}`;
    if (ctx.json) {
      const items = body.items.map((it) => ({ _type: it.cls, _title: it.title, ...(it.href ? { _links: { self: { href: it.href } } } : {}), ...it.fields }));
      let obj;
      if (ctx.v2) obj = body.list ? { _links: { base: { href: base } }, _embedded: { resources: items } } : { _links: { base: { href: base } }, state: items };
      else obj = { _links: { base: { href: base } }, _embedded: { _state: items } };
      return { type: ctx.v2 ? 'application/hal+json;v=2.0' : 'application/json', data: JSON.stringify(obj) };
    }
    const lis = body.items.map((it) => `<li class="${esc(it.cls)}" title="${esc(it.title)}">${it.href ? `<a href="${esc(it.href)}" rel="self"></a>` : ''}${Object.entries(it.fields).map(([k, v]) => `<span class="${esc(k)}">${esc(v)}</span>`).join('')}</li>`).join('');
    const html = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(body.title || 'RWS')}</title><base href="${esc(base)}"/></head><body><div class="${body.list && ctx.v2 ? '_embedded' : 'state'}"><a href="${esc(path.split('/').pop() || '')}" rel="self"></a><ul>${lis}</ul></div></body></html>`;
    return { type: ctx.v2 ? 'application/xhtml+xml;v=2.0' : 'application/xhtml+xml', data: html };
  }
  function renderError(ctx, e) {
    if (ctx.json) {
      const st = { _type: 'status', code: String(e.code ?? ERR.BAD_ARG), msg: e.message };
      return { type: ctx.v2 ? 'application/hal+json;v=2.0' : 'application/json', data: JSON.stringify(ctx.v2 ? { status: st } : { _embedded: { _state: [st] } }) };
    }
    return { type: 'application/xhtml+xml', data: `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Error</title></head><body><div class="status"><span class="code">${esc(e.code ?? ERR.BAD_ARG)}</span><span class="msg">${esc(e.message)}</span></div></body></html>` };
  }
  const state = (cls, title, fields, extra = {}) => ({ items: [{ cls, title, fields }], ...extra });

  // ------------------------------------------------------------ 데이터
  const execState = () => (progRunning(ctrl) && !ctrl.held ? 'running' : 'stopped');
  const ctrlState = () => (ctrl.servo ? 'motoron' : ctrl.alarms.length ? 'guardstop' : 'motoroff');
  const opMode = () => (ctrl.mode === 'TEACH' ? 'MANR' : 'AUTO');
  const jointFields = () => {
    const f = {};
    ctrl.joints.forEach((v, i) => { f[`rax_${i + 1}`] = fx(v, 6); });
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) f[`eax_${k}`] = '9E+09';
    return f;
  };
  const cfOf = (j) => ({ cf1: String(Math.floor(j[0] / 90)), cf4: String(Math.floor(j[3] / 90)), cf6: String(Math.floor(j[5] / 90)), cfx: '0' });
  const robFields = (coord = 'Base') => {
    const useWobj = /wobj/i.test(coord);
    const p = useWobj ? ctrl.tcpPose() : fkTcp(ctrl.robot, ctrl.joints, ctrl.tool, null);
    const q = quatFromR(p.R);
    const f = { x: fx(p.p[0], 6), y: fx(p.p[1], 6), z: fx(p.p[2], 6), q1: fx(q[0], 9), q2: fx(q[1], 9), q3: fx(q[2], 9), q4: fx(q[3], 9), ...cfOf(ctrl.joints) };
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) f[`eax_${k}`] = '9E+09';
    return f;
  };

  // 모듈 = ctrl.files 의 RAPID 파일. 모듈명은 "MODULE 이름" 또는 파일명
  const modName = (file) => /^\s*MODULE\s+(\w+)/im.exec(ctrl.files.get(file) || '')?.[1] ?? stripExt(file);
  const modType = (file) => (/\bSYSMODULE\b/i.test(/^\s*MODULE\s+\w+\s*\(([^)]*)\)/im.exec(ctrl.files.get(file) || '')?.[1] || '') || /\.sys/i.test(file) ? 'SysMod' : 'ProgMod');
  const findModule = (name) => [...ctrl.files.keys()].find((f) => modName(f).toUpperCase() === String(name).toUpperCase() || f.toUpperCase() === String(name).toUpperCase()) ?? null;

  // RAPID 심볼 읽기/쓰기
  // rapid.js 규약: readVar 는 RAPID 텍스트(포맷된 문자열)를 반환, writeVar 는 RAPID 텍스트 문자열을 받아 파싱.
  //   이름은 'sym' 또는 'module/sym' (레코드 필드는 'sym.field').
  //   언어 모듈에 없는 심볼은 에뮬레이터 레지스터(ctrl.regs 'RAPID:SYM')에 저장한다.
  async function symRead(mod, sym) {
    const v = safeReadVar('abb', ctrl, mod ? `${mod}/${sym}` : sym) ?? (mod ? safeReadVar('abb', ctrl, sym) : undefined);
    if (typeof v === 'string') return v;
    const m = await langExt('abb');
    const fmt = (x) => { try { if (m?.formatValue) return String(m.formatValue(x)); } catch {} return fmtRapid(x); };
    if (v !== undefined) return fmt(v);
    const r = ctrl.regs.get(`RAPID:${sym.toUpperCase()}`);
    if (r === undefined) throw new RwsError(400, `Symbol not found: ${mod ? mod + '/' : ''}${sym}`, ERR.NOT_FOUND);
    return fmt(r);
  }
  async function symWrite(mod, sym, text) {
    if (safeWriteVar('abb', ctrl, mod ? `${mod}/${sym}` : sym, String(text))) { ctrl.emitState(); return; }
    // 프로그램에 없는 심볼 → 레지스터
    const m = await langExt('abb');
    let v;
    try { v = m?.parseValue ? m.parseValue(text) : parseRapid(text); } catch (e) { throw new RwsError(400, `Invalid value: ${e.message}`); }
    ctrl.regs.set(`RAPID:${sym.toUpperCase()}`, v);
    ctrl.emitState();
  }

  // IO 신호: 이름 → {type, n, name} (조회만으로는 ioNames 를 무한히 오염시키지 않음)
  function resolveSignal(name) {
    let raw = String(name);
    try { raw = decodeURIComponent(raw); } catch {}
    name = raw.split('/').pop();
    const findNamed = (t) => Object.entries(ctrl.ioNames[t]).find(([, nm]) => nm.toUpperCase() === name.toUpperCase());
    const fdo = findNamed('do'), fdi = findNamed('di');
    if (fdo) return { type: 'do', n: Number(fdo[0]), name };
    if (fdi) return { type: 'di', n: Number(fdi[0]), name };
    const type = /^(di|in|i|sdi|abb_?di)[_\d]/i.test(name) || /^di/i.test(name) ? 'di' : 'do';
    const m = /(\d+)$/.exec(name);
    const num = m ? Number(m[1]) : 0;
    if (num >= 1 && num <= 512) return { type, n: num, name };
    throw new RwsError(404, `Signal not found: ${name}`, ERR.NOT_FOUND);
  }
  const signalItem = (s, single = false) => ({
    cls: single ? 'ios-signal' : 'ios-signal-li', title: `Local/DRV_1/${s.name}`, href: `Local/DRV_1/${s.name}`,
    fields: {
      name: s.name, type: s.type.toUpperCase(), category: '', lvalue: (s.type === 'do' ? ctrl.getDO(s.n) : ctrl.getDI(s.n)) ? '1' : '0',
      lstate: 'not simulated', unitnm: 'DRV_1', network: 'Local', device: 'DRV_1',
    },
  });
  function listSignals() {
    const out = [];
    for (const t of ['di', 'do']) {
      const named = ctrl.ioNames[t];
      const seen = new Set();
      for (const [n, nm] of Object.entries(named)) { out.push({ type: t, n: Number(n), name: nm }); seen.add(Number(n)); }
      for (let n = 1; n <= 16; n++) if (!seen.has(n)) out.push({ type: t, n, name: `${t.toUpperCase()}${n}` });
    }
    return out;
  }

  // fileservice 경로 정규화: '$HOME/a/b.mod' | 'HOME:/a' | '$home' → {key:'a/b.mod', name:'b.mod'}
  function fsPath(p) {
    let s = String(p);
    try { s = decodeURIComponent(s); } catch { throw new RwsError(400, 'Invalid path encoding'); }
    s = s.replace(/\\/g, '/').replace(/^\$?home:?\/?/i, '').replace(/^\/+/, '');
    const parts = [];
    for (const seg of s.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (!parts.length) throw new RwsError(400, 'Invalid path'); parts.pop(); }
      else parts.push(seg);
    }
    s = parts.join('/');
    return { key: s.toLowerCase(), path: s, name: parts[parts.length - 1] || '' };
  }
  function fsGet(rel) {
    const f = fsPath(rel);
    const e = fsStore.get(f.key);
    if (e) return e.data;
    if (!f.path.includes('/')) {
      const k = [...ctrl.files.keys()].find((x) => x.toLowerCase() === f.key);
      if (k) return Buffer.from(ctrl.files.get(k), 'utf8');
    }
    return null;
  }

  // ------------------------------------------------------------ 실행 제어
  async function execAction(action, form) {
    switch (action) {
      case 'start': {
        if (!ctrl.allow('start')) throw new RwsError(400, `Operation not allowed: ${ctrl.lastReject.reason}`, ERR.BUSY);
        if (!ctrl.servo) throw new RwsError(400, 'Motors off. Operation not allowed.', ERR.MOTOR_OFF);
        if (ctrl.alarms.length) throw new RwsError(400, 'Controller in error state', ERR.PROGRAM);
        const step = /step/i.test(form.get('execmode') || '');
        const ok = await ctrl.start({ step });
        if (!ok) throw new RwsError(400, ctrl.compileError ? `Program error: ${ctrl.compileError.msg}` : 'Unable to start program', ERR.PROGRAM);
        const cyc = (form.get('cycle') || 'asis').toLowerCase();
        if (cyc === 'forever') { execCycle = 'forever'; if (!cycles.active) cycles.set(-1); }
        else if (cyc === 'once' || cyc === 'oncedone') { execCycle = 'once'; cycles.stop(); }
        return;
      }
      case 'stop': if (progRunning(ctrl)) ctrl.hold(); return;
      case 'resetpp': cycles.stop(); ctrl.resetProgram(); return;
      default: throw new RwsError(400, `Unknown action ${action}`);
    }
  }

  async function taskAction(action, form) {
    if (action === 'loadmod') {
      const mp = form.get('modulepath');
      if (!mp) throw new RwsError(400, 'modulepath missing');
      const data = fsGet(mp);
      if (!data) throw new RwsError(400, `Module file not found: ${mp}`, ERR.NOT_FOUND);
      const name = fsPath(mp).name;
      const text = data.toString('utf8');
      const mod = /^\s*MODULE\s+(\w+)/im.exec(text)?.[1];
      const existing = mod && findModule(mod);
      if (existing && existing !== name) {
        if (!/^true$/i.test(form.get('replace') || 'false')) throw new RwsError(400, `Module ${mod} already loaded`, ERR.BUSY);
        ctrl.files.delete(existing);
      }
      if (progRunning(ctrl)) throw new RwsError(400, 'Program running', ERR.BUSY);
      ctrl.loadFiles({ [name]: text });
      log(`모듈 로드: ${name}`, true);
      return;
    }
    if (action === 'unloadmod') {
      const m = form.get('module');
      const f = m && findModule(m);
      if (!f) throw new RwsError(400, `Module not found: ${m}`, ERR.NOT_FOUND);
      if (progRunning(ctrl)) throw new RwsError(400, 'Program running', ERR.BUSY);
      ctrl.deleteFile(f);
      log(`모듈 언로드: ${f}`, true);
      return;
    }
    if (action === 'activate' || action === 'deactivate') return;
    throw new RwsError(400, `Unknown action ${action}`);
  }

  // ------------------------------------------------------------ 구독
  const subs = new Map(); // id → {resources:[path], ws:Set, last:Map, idleSince}
  const MAX_SUBS = 200, SUB_IDLE_MS = 60000;
  let subSeq = 0;
  const eventOf = async (res) => {
    // 반환: {cls, title, href, fields} 또는 null
    const [path, param] = res.split(';');
    const p = path.replace(/\/+$/, '');
    if (/\/rw\/panel\/ctrl-?state$/i.test(p)) return { cls: 'pnl-ctrlstate-ev', title: 'ctrlstate', href: p, fields: { ctrlstate: ctrlState() } };
    if (/\/rw\/panel\/opmode$/i.test(p)) return { cls: 'pnl-opmode-ev', title: 'opmode', href: p, fields: { opmode: opMode() } };
    if (/\/rw\/panel\/speedratio$/i.test(p)) return { cls: 'pnl-speedratio-ev', title: 'speedratio', href: p, fields: { speedratio: String(ctrl.override) } };
    if (/\/rw\/rapid\/execution$/i.test(p)) return { cls: 'rap-ctrlexecstate-ev', title: 'execution', href: p, fields: { ctrlexecstate: execState() } };
    if (/\/rw\/elog\/\d+$/i.test(p)) { const e = elog[0]; return { cls: 'elog-message-ev', title: `message`, href: e ? `${p}/${e.seq}` : p, fields: { seqnum: String(e?.seq ?? 0) } }; }
    if (/\/rw\/motionsystem\/mechunits\/[^/]+\/jointtarget$/i.test(p)) {
      const f = jointFields(); for (const k of Object.keys(f)) if (k.startsWith('rax')) f[k] = fx(Number(f[k]), 2);
      return { cls: 'ms-jointtarget-ev', title: 'jointtarget', href: p, fields: f };
    }
    let m = /\/rw\/iosystem\/signals\/(.+)$/i.exec(p);
    if (m) { const s = resolveSignal(m[1]); return { cls: 'ios-signalstate-ev', title: m[1], href: p, fields: { lvalue: (s.type === 'do' ? ctrl.getDO(s.n) : ctrl.getDI(s.n)) ? '1' : '0', lstate: 'not simulated' } }; }
    m = /\/rw\/rapid\/symbol\/(?:data\/)?RAPID\/[^/]+\/(?:([^/]+)\/)?([^/]+?)(?:\/data)?$/i.exec(p);
    if (m) { let v = ''; try { v = await symRead(m[1], m[2]); } catch {} return { cls: 'rap-value-ev', title: p, href: p, fields: { value: v } }; }
    m = /\/rw\/rapid\/tasks\/([^/]+)\/pcp$/i.exec(p);
    if (m || /programpointerchange/i.test(param || '')) { const c = ctrl.vm?.current; return { cls: 'pcp-info-ev', title: 'pcp', href: p, fields: { 'module-name': c?.file ? stripExt(c.file) : '', 'routine-name': c?.proc ?? '', 'begin-position': `${c?.line ?? 0},1` } }; }
    return null;
  };
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try { await pollOnce(); } finally { polling = false; }
  };
  const pollOnce = async () => {
    const now = Date.now();
    for (const [id, s] of subs) {
      // WebSocket 이 붙지 않은(또는 끊긴) 구독은 일정 시간 후 정리 — 클라이언트가 DELETE 없이 사라져도 쌓이지 않게
      if (!s.ws.size) { s.idleSince ??= now; if (now - s.idleSince > SUB_IDLE_MS) subs.delete(id); continue; }
      s.idleSince = null;
      const evs = [];
      for (const r of s.resources) {
        let ev; try { ev = await eventOf(r); } catch { ev = null; }
        if (!ev) continue;
        const key = JSON.stringify(ev.fields);
        if (s.last.get(r) !== key) { if (s.last.has(r)) evs.push(ev); s.last.set(r, key); }
      }
      if (!evs.length) continue;
      const lis = evs.map((it) => `<li class="${esc(it.cls)}" title="${esc(it.title)}"><a href="${esc(it.href)}" rel="self"></a>${Object.entries(it.fields).map(([k, v]) => `<span class="${esc(k)}">${esc(v)}</span>`).join('')}</li>`).join('');
      const msg = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="http://localhost/"/></head><body><div class="state"><a href="subscription/${id}" rel="group"></a><ul>${lis}</ul></div></body></html>`;
      for (const w of s.ws) { try { w.send(msg); } catch {} }
    }
  };
  const pollTimer = setInterval(poll, 100);
  pollTimer.unref?.();
  // IO 변화는 즉시 평가 (짧은 펄스도 이벤트로 전달)
  const onIo = () => { if (subs.size) poll(); };
  ctrl.on('io', onIo);

  // ------------------------------------------------------------ 라우팅
  // 핸들러 반환: 렌더 바디 객체 | {status, raw?, headers?}
  async function route(req, path, url, form, rawBody, ctx) {
    const M = req.method;
    const action = url.searchParams.get('action');
    let m;

    // --- 모션 시스템
    if ((m = /^\/rw\/motionsystem\/mechunits$/i.exec(path)) && M === 'GET') {
      return { list: true, items: [{ cls: 'ms-mechunit-li', title: 'ROB_1', href: 'mechunits/ROB_1', fields: { mode: 'Activated' } }] };
    }
    if ((m = /^\/rw\/motionsystem\/mechunits\/([^/]+)$/i.exec(path)) && M === 'GET') {
      return state('ms-mechunit', m[1], {
        mode: 'Activated', 'activation-allowed': 'true', 'drive-module': '1', 'task-name': 'T_ROB1', type: 'TCPRobot',
        axes: '6', 'axes-total': '6', 'is-integrated-unit': '', 'has-integrated-unit': '', status: 'OK',
        tool: 'tool0', wobj: 'wobj0', 'payload-name': 'load0', 'total-payload-name': 'load0',
      });
    }
    if ((m = /^\/rw\/motionsystem\/mechunits\/([^/]+)\/jointtarget$/i.exec(path)) && M === 'GET') return state('ms-jointtarget', m[1], jointFields());
    if ((m = /^\/rw\/motionsystem\/mechunits\/([^/]+)\/robtarget$/i.exec(path)) && M === 'GET') {
      return state('ms-robtargets', m[1], robFields(url.searchParams.get('coordinate') || 'Base'));
    }
    if ((m = /^\/rw\/motionsystem\/mechunits\/([^/]+)\/cartesian$/i.exec(path)) && M === 'GET') {
      const f = robFields(url.searchParams.get('coordinate') || 'Base');
      return state('ms-mechunit-cartesian', m[1], { x: f.x, y: f.y, z: f.z, q1: f.q1, q2: f.q2, q3: f.q3, q4: f.q4, j1: f.cf1, j4: f.cf4, j6: f.cf6, jx: f.cfx });
    }

    // --- RAPID 실행
    if (/^\/rw\/rapid\/execution$/i.test(path)) {
      if (M === 'GET') return state('rap-execution', 'execution', { ctrlexecstate: execState(), cycle: execCycle });
      if (M === 'POST' && action) { await execAction(action.toLowerCase(), form); return { status: 204 }; }
    }
    if ((m = /^\/rw\/rapid\/execution\/(start|stop|resetpp)$/i.exec(path)) && M === 'POST') { await execAction(m[1].toLowerCase(), form); return { status: 204 }; }
    if (/^\/rw\/rapid\/execution\/cycle$/i.test(path) && M === 'POST') { execCycle = form.get('cycle') || execCycle; return { status: 204 }; }

    // --- 태스크/모듈
    const taskFields = () => ({ name: 'T_ROB1', type: 'normal', taskstate: 'started', excstate: progRunning(ctrl) && !ctrl.held ? 'started' : ctrl.held ? 'stopped' : 'ready', active: 'On', motiontask: 'TRUE' });
    if (/^\/rw\/rapid\/tasks$/i.test(path) && M === 'GET') return { list: true, items: [{ cls: 'rap-task-li', title: 'T_ROB1', href: 'tasks/T_ROB1', fields: taskFields() }] };
    if ((m = /^\/rw\/rapid\/tasks\/([^/]+)$/i.exec(path))) {
      if (M === 'GET') return state('rap-task', m[1], taskFields());
      if (M === 'POST' && action) { await taskAction(action.toLowerCase(), form); return { status: 204 }; }
    }
    if ((m = /^\/rw\/rapid\/tasks\/([^/]+)\/(loadmod|unloadmod|activate|deactivate)$/i.exec(path)) && M === 'POST') { await taskAction(m[2].toLowerCase(), form); return { status: 204 }; }
    if ((m = /^\/rw\/rapid\/tasks\/([^/]+)\/pcp$/i.exec(path)) && M === 'GET') {
      const c = ctrl.vm?.current;
      const pos = c?.line ? `${c.line},1` : '';
      const f = { beginposition: pos, endposition: pos, modulename: c?.file ? (ctrl.files.has(c.file) ? modName(c.file) : stripExt(c.file)) : '', routinename: c?.proc ?? '', execlevel: 'Normal' };
      return { items: [{ cls: 'pcp-info', title: 'progpointer', fields: f }, { cls: 'pcp-info', title: 'motionpointer', fields: f }] };
    }
    if ((m = /^\/rw\/rapid\/tasks\/([^/]+)\/modules$/i.exec(path)) && M === 'GET') {
      const items = [...ctrl.files.keys()].map((f) => ({ cls: 'rap-module-info-li', title: modName(f), href: `modules/${modName(f)}`, fields: { name: modName(f), type: modType(f) } }));
      return { list: true, items };
    }
    if ((m = /^\/rw\/rapid\/(?:tasks\/[^/]+\/)?modules\/([^/]+)(?:\/text)?$/i.exec(path)) && M === 'GET') {
      const f = findModule(m[1]);
      if (!f) throw new RwsError(404, `Module not found: ${m[1]}`, ERR.NOT_FOUND);
      return state('rap-module', modName(f), { modulename: modName(f), filename: f, attribute: modType(f), text: ctrl.files.get(f) });
    }

    // --- RAPID 심볼
    m = /^\/rw\/rapid\/symbol\/data\/RAPID\/([^/]+)\/(?:([^/]+)\/)?([^/]+)$/i.exec(path);
    if (m) {
      const [, , mod, sym] = m;
      if (M === 'GET') return state('rap-data', `RAPID/${m[1]}${mod ? '/' + mod : ''}/${sym}`, { value: await symRead(mod, sym) });
      if (M === 'POST' && (action === 'set' || form.has('value'))) {
        if (!form.has('value')) throw new RwsError(400, 'value missing');
        await symWrite(mod, sym, form.get('value'));
        log(`심볼 쓰기 ${mod ? mod + '/' : ''}${sym} = ${form.get('value')}`, true);
        return { status: 204 };
      }
    }
    m = /^\/rw\/rapid\/symbol\/RAPID\/([^/]+)\/(?:([^/]+)\/)?([^/]+)\/data$/i.exec(path);
    if (m) {
      const [, , mod, sym] = m;
      if (M === 'GET') return state('rap-data', `RAPID/${m[1]}${mod ? '/' + mod : ''}/${sym}`, { value: await symRead(mod, sym) });
      if (M === 'POST') {
        if (!form.has('value')) throw new RwsError(400, 'value missing');
        await symWrite(mod, sym, form.get('value'));
        log(`심볼 쓰기 ${mod ? mod + '/' : ''}${sym} = ${form.get('value')}`, true);
        return { status: 204 };
      }
    }

    // --- IO 시스템
    if (/^\/rw\/iosystem\/signals$/i.test(path) && M === 'GET') return { list: true, items: listSignals().map((s) => signalItem(s)) };
    if ((m = /^\/rw\/iosystem\/signals\/(.+?)(?:\/(set-value))?$/i.exec(path))) {
      const s = resolveSignal(m[1]);
      if (M === 'GET' && !m[2]) return { items: [signalItem(s, true)] };
      if (M === 'POST' && (action === 'set' || m[2] || form.has('lvalue'))) {
        if (!form.has('lvalue')) throw new RwsError(400, 'lvalue missing');
        const v = /^(1|true)$/i.test(form.get('lvalue').trim());
        if (s.type === 'do') ctrl.setDO(s.n, v); else ctrl.setDI(s.n, v);
        log(`신호 ${s.name}(${s.type.toUpperCase()}${s.n}) = ${v ? 1 : 0}`, true);
        return { status: 204 };
      }
    }

    // --- 패널
    if (/^\/rw\/panel\/ctrl-?state$/i.test(path)) {
      if (M === 'GET') return state('pnl-ctrlstate', 'ctrlstate', { ctrlstate: ctrlState() });
      if (M === 'POST') {
        const v = (form.get('ctrl-state') || '').toLowerCase();
        if (!['motoron', 'motoroff'].includes(v)) throw new RwsError(400, 'ctrl-state must be motoron|motoroff');
        if (v === 'motoron' && !ctrl.allow('servoOn')) throw new RwsError(400, `Operation not allowed: ${ctrl.lastReject.reason}`, ERR.BUSY);
        if (!ctrl.setServo(v === 'motoron')) throw new RwsError(400, 'Cannot turn motors on (controller in error state)', ERR.MOTOR_OFF);
        return { status: 204 };
      }
    }
    if (/^\/rw\/panel\/opmode$/i.test(path)) {
      if (M === 'GET') return state('pnl-opmode', 'opmode', { opmode: opMode() });
      if (M === 'POST') {
        const v = (form.get('opmode') || '').toLowerCase();
        if (ctrl.setMode(v === 'auto' ? 'PLAY' : 'TEACH') === false) throw new RwsError(403, `Operation not allowed: ${ctrl.lastReject.reason}`, ERR.BUSY);
        return { status: 204 };
      }
    }
    if (/^\/rw\/panel\/speedratio$/i.test(path)) {
      if (M === 'GET') return state('pnl-speedratio', 'speedratio', { speedratio: String(Math.round(ctrl.override)) });
      if (M === 'POST') {
        const v = Number(form.get('speed-ratio'));
        if (!(v >= 0 && v <= 100)) throw new RwsError(400, 'speed-ratio must be 0..100');
        ctrl.setOverride(v);
        return { status: 204 };
      }
    }

    // --- 마스터십 (abb_librws / RobotStudio 호환)
    if ((m = /^\/rw\/mastership(?:\/(rapid|cfg|edit))?(?:\/(request|release))?$/i.exec(path))) {
      const dom = m[1]?.toLowerCase() || null;
      const subAct = m[2]?.toLowerCase() || action;
      const keys = dom ? [dom] : ['rapid', 'cfg', 'edit'];
      if (M === 'GET') {
        if (dom) return state('msh-resource', dom, { mastership: mastership[dom] });
        return {
          list: true,
          items: keys.map((k) => ({ cls: 'msh-resource', title: k, href: k, fields: { mastership: mastership[k] } })),
        };
      }
      if (M === 'POST') {
        if (subAct === 'request') { for (const k of keys) mastership[k] = 'held'; return { status: 204 }; }
        if (subAct === 'release') { for (const k of keys) mastership[k] = 'nomaster'; return { status: 204 }; }
        throw new RwsError(400, `Unknown mastership action: ${subAct}`);
      }
    }

    // --- 이벤트 로그
    if ((m = /^\/rw\/elog\/(\d+)$/i.exec(path))) {
      if (M === 'GET') {
        return {
          list: true,
          items: elog.map((e) => ({ cls: 'elog-message-li', title: `/rw/elog/${m[1]}/${e.seq}`, href: `${m[1]}/${e.seq}`, fields: { msgtype: String(e.type), code: String(e.code), tstamp: new Date(e.t).toISOString().replace('T', ' ').slice(0, 19), title: String(e.title), desc: e.desc } })),
        };
      }
      if (M === 'POST' && (action === 'clear' || action === 'clearall')) { elog.length = 0; ctrl.resetAlarms(); return { status: 204 }; }
    }
    if (/^\/rw\/elog$/i.test(path) && M === 'GET') return { list: true, items: [{ cls: 'elog-domain-li', title: '0', href: 'elog/0', fields: { domain: '0', numevts: String(elog.length) } }] };

    // --- 시스템
    if (/^\/ctrl(\/identity)?$/i.test(path) && M === 'GET') {
      return state('ctrl-identity-info', 'ctrl-identity-info', { 'ctrl-name': `EMU-${ctrl.robot.id}`, 'ctrl-type': 'Virtual Controller', 'ctrl-id': sysId.slice(0, 8), 'ctrl-uuid': sysId, mac: '00:00:00:00:00:00' });
    }
    if (/^\/rw\/system$/i.test(path) && M === 'GET') {
      return state('sys-system-li', 'system', { major: '6', minor: '13', build: '0', title: 'RobotWare', type: 'RobotWare', description: 'Robot Emulator RWS', date: startTime.toISOString().slice(0, 10), mctimestamp: '', name: 'EMU_SYSTEM', rwversion: '6.13.0', sysid: `{${sysId}}`, starttm: startTime.toISOString().replace('T', ' ').slice(0, 19), rwversionname: '6.13.00.00' });
    }
    if (/^\/rw\/system\/robottype$/i.test(path) && M === 'GET') return state('sys-robottype', 'robottype', { 'robot-type': `${ctrl.robot.name}` });
    if (/^\/rw\/?$/.test(path) && M === 'GET') return { list: true, items: ['motionsystem', 'rapid', 'iosystem', 'panel', 'mastership', 'elog', 'system'].map((x) => ({ cls: 'rw-service-li', title: x, href: x, fields: {} })) };

    // --- 파일 서비스
    if ((m = /^\/fileservice(?:\/(.*))?$/i.exec(path))) {
      const rel = m[1] || '';
      const f = fsPath(rel);
      if (M === 'GET') {
        const data = f.path && !rel.endsWith('/') ? fsGet(rel) : null;
        if (data) return { status: 200, raw: data, headers: { 'Content-Type': 'application/octet-stream' } };
        // 디렉터리 목록
        const dir = f.key.replace(/\/+$/, '');
        const pre = dir ? dir + '/' : '';
        const files = new Map(), dirs = new Set();
        for (const [k, e] of fsStore) {
          if (!k.startsWith(pre)) continue;
          const restp = e.path.slice(pre.length);
          if (restp.includes('/')) dirs.add(restp.split('/')[0]); else files.set(restp, { size: e.data.length, mtime: e.mtime });
        }
        if (!dir) for (const [name, text] of ctrl.files) if (!files.has(name)) files.set(name, { size: Buffer.byteLength(text), mtime: startTime });
        if (dir && !files.size && !dirs.size) throw new RwsError(404, `File or directory not found: ${rel}`, ERR.NOT_FOUND);
        const items = [
          ...[...dirs].map((d) => ({ cls: 'fs-dir', title: d, href: `${d}`, fields: { 'fs-cdate': startTime.toISOString(), 'fs-mdate': startTime.toISOString() } })),
          ...[...files].map(([n, e]) => ({ cls: 'fs-file', title: n, href: `${n}`, fields: { 'fs-cdate': e.mtime.toISOString(), 'fs-mdate': e.mtime.toISOString(), 'fs-size': String(e.size), 'fs-readonly': 'false' } })),
        ];
        return { list: true, items };
      }
      if (M === 'PUT') {
        if (!f.path) throw new RwsError(400, 'File name missing');
        if (RAPID_EXT.test(f.name) && !f.path.includes('/') && progRunning(ctrl)) throw new RwsError(409, 'Program is running', ERR.BAD_STATE);
        const existed = fsStore.has(f.key);
        let total = rawBody.length;
        for (const [k, e] of fsStore) if (k !== f.key) total += e.data.length;
        if ((!existed && fsStore.size >= MAX_FS_FILES) || total > MAX_FS_BYTES) throw new RwsError(507, 'File storage full');
        fsStore.set(f.key, { path: f.path, data: rawBody, mtime: new Date() });
        // RAPID 모듈 파일은 가상 컨트롤러 프로그램 저장소(ctrl.files)에도 반영
        if (RAPID_EXT.test(f.name) && !f.path.includes('/')) ctrl.loadFiles({ [f.name]: rawBody.toString('utf8') });
        log(`파일 업로드 $HOME/${f.path} (${rawBody.length} bytes)`, true);
        return { status: existed ? 200 : 201 };
      }
      if (M === 'DELETE') {
        if (!f.path.includes('/') && RAPID_EXT.test(f.name) && progRunning(ctrl)) throw new RwsError(409, 'Program is running', ERR.BAD_STATE);
        let found = fsStore.delete(f.key);
        if (!f.path.includes('/')) {
          const k = [...ctrl.files.keys()].find((x) => x.toLowerCase() === f.key);
          if (k) { ctrl.deleteFile(k); found = true; }
        }
        if (!found) throw new RwsError(404, `File not found: ${rel}`, ERR.NOT_FOUND);
        return { status: 204 };
      }
    }

    // --- 구독
    if (/^\/subscription$/i.test(path) && M === 'POST') {
      const idx = form.getAll('resources');
      const resources = idx.map((i) => form.get(i)).filter(Boolean);
      if (!resources.length) throw new RwsError(400, 'No resources to subscribe');
      if (resources.length > 64) throw new RwsError(400, 'Too many resources in subscription');
      if (subs.size >= MAX_SUBS) throw new RwsError(503, 'Too many subscriptions');
      const id = String(++subSeq);
      subs.set(id, { resources, ws: new Set(), last: new Map(), idleSince: Date.now() });
      // 기준값 저장 (이후 변경분만 푸시)
      for (const r of resources) { try { const ev = await eventOf(r); if (ev) subs.get(id).last.set(r, JSON.stringify(ev.fields)); } catch {} }
      const loc = `ws://${ctx.host}/poll/${id}`;
      log(`구독 생성 #${id}: ${resources.join(', ')}`, true);
      return { status: 201, headers: { Location: loc }, body: { items: [{ cls: 'subscription', title: id, href: loc, fields: { group: `/subscription/${id}` } }] } };
    }
    if ((m = /^\/subscription\/(\d+)$/i.exec(path)) && M === 'DELETE') {
      const s = subs.get(m[1]);
      if (!s) throw new RwsError(404, 'Subscription not found', ERR.NOT_FOUND);
      for (const w of s.ws) w.close();
      subs.delete(m[1]);
      return { status: 200 };
    }
    if (/^\/logout$/i.test(path)) return { status: 200 };

    throw new RwsError(404, `Resource not found: ${M} ${path}`, ERR.NOT_FOUND);
  }

  // ------------------------------------------------------------ HTTP 서버
  const server = http.createServer(async (req, res) => {
    const t0 = performance.now();
    const peer = peerOf(req);
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
    if (!hostAllowed(req) || !originAllowed(req)) { res.writeHead(403); return res.end(); }   // DNS 리바인딩 · CSRF 방어
    const path = url.pathname.replace(/\/+$/, '') || '/';
    let decodedPath;
    try { decodedPath = decodeURI(path); } catch { res.writeHead(400); return res.end(); }
    if (await ctrl.traffic?.applyFault('abbRws', peer, `${req.method} ${path}`)) { res.destroy(); return; }
    const ctx = ctxOf(req, url);
    const headers = {};
    // 세션 쿠키
    const cookie = String(req.headers.cookie || '');
    if (!/-http-session-=/.test(cookie)) {
      headers['Set-Cookie'] = [`-http-session-=${crypto.randomBytes(12).toString('hex')}; Path=/; HttpOnly`, `ABBCX=${Math.floor(Math.random() * 1e6)}; Path=/`];
    }
    // 인증 (옵션): 인증 헤더도 쿠키도 없으면 401 + Digest/Basic 챌린지
    if (requireAuth && !req.headers.authorization && !/-http-session-=/.test(cookie)) {
      res.writeHead(401, { 'WWW-Authenticate': [`Digest realm="validusers@robapi.abb", qop="auth", nonce="${crypto.randomBytes(8).toString('hex')}", algorithm=MD5`, 'Basic realm="validusers@robapi.abb"'] });
      return res.end();
    }
    let rawBody = Buffer.alloc(0);
    try {
      rawBody = await readBody(req);
      const form = new URLSearchParams(['POST', 'DELETE'].includes(req.method) && !/^\/fileservice/i.test(path) ? rawBody.toString('utf8') : '');
      const out = await route(req, decodedPath, url, form, rawBody, ctx);
      const st = out.status ?? 200;
      if (req.method !== 'GET' || st >= 300) log(`${req.method} ${path}${url.search} → ${st}`, true);
      else log(`GET ${path}`);
      ctrl.traffic?.record('abbRws', { client: peer, dir: 'req', summary: `${req.method} ${path}${url.search} → ${st}`, raw: rawBody.length ? rawBody.toString('utf8').slice(0, 200) : '', ok: st < 400, error: st >= 400 ? `HTTP ${st}` : null, ms: performance.now() - t0 });
      if (out.raw) { res.writeHead(st, { ...headers, ...out.headers }); return res.end(out.raw); }
      const body = out.items ? out : out.body;
      if (!body) { res.writeHead(st, { ...headers, ...out.headers }); return res.end(); }
      const r = render(ctx, path, body);
      res.writeHead(st, { ...headers, ...out.headers, 'Content-Type': r.type });
      res.end(r.data);
    } catch (e) {
      const st = e instanceof RwsError ? e.status : (e.status || 500);
      log(`${req.method} ${path}${url.search} → ${st} ${e.message}`, true);
      ctrl.traffic?.record('abbRws', { client: peer, dir: 'req', summary: `${req.method} ${path}${url.search} → ${st}`, ok: false, error: e.message, ms: performance.now() - t0 });
      const r = renderError(ctx, e);
      res.writeHead(st, { ...headers, 'Content-Type': r.type });
      res.end(r.data);
    }
  });

  // WebSocket (구독 이벤트)
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => {
      for (const p of ['robapi2_subscription', 'rws_subscription']) if (protocols.has(p)) return p;
      return false;
    },
  });
  server.on('upgrade', (req, socket, head) => {
    if (!hostAllowed(req) || !originAllowed(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    const m = /^\/poll\/(\d+)/.exec(req.url || '');
    const s = m && subs.get(m[1]);
    if (!s) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    const peer = peerOf(req);
    wss.handleUpgrade(req, socket, head, (ws) => {
      s.ws.add(ws);
      ctrl.traffic?.connect('abbRws', peer);
      log(`구독 WebSocket 연결 #${m[1]} (${ws.protocol || '프로토콜 없음'})`, true);
      ws.on('close', () => { s.ws.delete(ws); ctrl.traffic?.disconnect('abbRws', peer); });
      ws.on('error', () => {});
    });
  });

  const r = await bindServer(server, port, host);
  if (r.error) ctrl.log('comm', `[${TAG}] HTTP ${port} 바인딩 실패: ${r.error.message}`);
  else ctrl.log('comm', `[${TAG}] Robot Web Services HTTP ${r.port} 대기`);
  return {
    name: 'ABB Robot Web Services (RWS 1.0/2.0)', proto: 'http', vendor: 'abb',
    port: r.error ? null : r.port,
    close() {
      clearInterval(pollTimer);
      cycles.stop();
      ctrl.off('log', onLog);
      ctrl.off('io', onIo);
      for (const s of subs.values()) for (const w of s.ws) w.terminate();
      wss.close();
      server.closeAllConnections?.();
      try { server.close(); } catch {}
    },
  };
}
