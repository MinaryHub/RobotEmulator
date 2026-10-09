#!/usr/bin/env node
// ABB Robot Web Services (RWS 1.0, IRC5 스타일) 샘플 클라이언트 — 기본 포트 8080 (실제 IRC5 는 80)
// Node 내장 fetch + (구독용) ws 패키지. Basic 인증 "Default User"/"robotics" + 세션 쿠키 유지.
// 실제 IRC5 는 Digest 인증만 허용하므로, 실제 장비에서는 Digest 를 지원하는 HTTP 클라이언트를 사용할 것.
//
// 사용법:  node tools/clients/abb-rws-client.js [host] [port]
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

export class RwsClient {
  constructor(host = '127.0.0.1', port = 8080, { user = 'Default User', password = 'robotics' } = {}) {
    this.host = host; this.port = port;
    this.base = `http://${host}:${port}`;
    this.auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
    this.cookies = new Map();
  }

  async req(method, path, form, { json = true, body, headers = {} } = {}) {
    const h = { Authorization: this.auth, ...headers };
    if (this.cookies.size) h.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload = body;
    if (form) { payload = new URLSearchParams(form).toString(); h['Content-Type'] = 'application/x-www-form-urlencoded;v=2.0'; }
    const url = this.base + path + (json ? (path.includes('?') ? '&' : '?') + 'json=1' : '');
    const r = await fetch(url, { method, headers: h, body: payload });
    for (const c of r.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); this.cookies.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await r.text();
    if (r.status >= 400) {
      let msg = text; try { msg = JSON.parse(text)._embedded._state[0].msg; } catch {}
      const e = new Error(`${method} ${path} → ${r.status} ${msg}`); e.status = r.status; throw e;
    }
    return { status: r.status, headers: r.headers, text, data: json && text && /json/.test(r.headers.get('content-type') || '') ? JSON.parse(text) : null };
  }
  // RWS1 JSON 의 첫 상태 객체 / 목록
  async state(path) { return (await this.req('GET', path)).data._embedded._state[0]; }
  async list(path) { return (await this.req('GET', path)).data._embedded._state; }

  jointTarget(mech = 'ROB_1') { return this.state(`/rw/motionsystem/mechunits/${mech}/jointtarget`); }
  robTarget(mech = 'ROB_1', coordinate = 'Base') { return this.state(`/rw/motionsystem/mechunits/${mech}/robtarget?tool=tool0&wobj=wobj0&coordinate=${coordinate}`); }
  ctrlState() { return this.state('/rw/panel/ctrlstate'); }
  setMotors(on) { return this.req('POST', '/rw/panel/ctrlstate?action=setctrlstate', { 'ctrl-state': on ? 'motoron' : 'motoroff' }); }
  opMode() { return this.state('/rw/panel/opmode'); }
  speedRatio() { return this.state('/rw/panel/speedratio'); }
  setSpeedRatio(v) { return this.req('POST', '/rw/panel/speedratio?action=setspeedratio', { 'speed-ratio': String(v) }); }
  execution() { return this.state('/rw/rapid/execution'); }
  start(cycle = 'once') { return this.req('POST', '/rw/rapid/execution?action=start', { regain: 'continue', execmode: 'continue', cycle, condition: 'none', stopatbp: 'disabled', alltaskbytsp: 'false' }); }
  stop() { return this.req('POST', '/rw/rapid/execution?action=stop', { stopmode: 'stop', usetsp: 'normal' }); }
  resetPP() { return this.req('POST', '/rw/rapid/execution?action=resetpp', {}); }
  tasks() { return this.list('/rw/rapid/tasks'); }
  modules(task = 'T_ROB1') { return this.list(`/rw/rapid/tasks/${task}/modules`); }
  pcp(task = 'T_ROB1') { return this.list(`/rw/rapid/tasks/${task}/pcp`); }
  loadModule(path, task = 'T_ROB1', replace = true) { return this.req('POST', `/rw/rapid/tasks/${task}?action=loadmod`, { modulepath: path, replace: String(replace) }); }
  unloadModule(name, task = 'T_ROB1') { return this.req('POST', `/rw/rapid/tasks/${task}?action=unloadmod`, { module: name }); }
  async getSymbol(module, name, task = 'T_ROB1') { return (await this.state(`/rw/rapid/symbol/data/RAPID/${task}/${module}/${name}`)).value; }
  setSymbol(module, name, value, task = 'T_ROB1') { return this.req('POST', `/rw/rapid/symbol/data/RAPID/${task}/${module}/${name}?action=set`, { value: String(value) }); }
  signals() { return this.list('/rw/iosystem/signals'); }
  async getSignal(name, net = 'Local', dev = 'DRV_1') { return (await this.state(`/rw/iosystem/signals/${net}/${dev}/${name}`)).lvalue; }
  setSignal(name, v, net = 'Local', dev = 'DRV_1') { return this.req('POST', `/rw/iosystem/signals/${net}/${dev}/${name}?action=set`, { lvalue: v ? '1' : '0' }); }
  uploadFile(path, text) { return this.req('PUT', `/fileservice/$HOME/${path}`, null, { json: false, body: text, headers: { 'Content-Type': 'text/plain' } }); }
  async downloadFile(path) { return (await this.req('GET', `/fileservice/$HOME/${path}`, null, { json: false })).text; }
  listDir(path = '') { return this.list(`/fileservice/$HOME/${path}`); }
  deleteFile(path) { return this.req('DELETE', `/fileservice/$HOME/${path}`, null, { json: false }); }
  elog() { return this.list('/rw/elog/0?lang=en'); }
  identity() { return this.state('/ctrl/identity'); }
  system() { return this.state('/rw/system'); }

  // 구독: resources = ['/rw/panel/ctrlstate', '/rw/iosystem/signals/Local/DRV_1/DO1;state', ...]
  // onEvent(xhtml 문자열) 콜백. 반환: { ws, close() }
  async subscribe(resources, onEvent) {
    const form = new URLSearchParams();
    resources.forEach((r, i) => { form.append('resources', String(i + 1)); form.append(String(i + 1), r); form.append(`${i + 1}-p`, '1'); });
    const r = await this.req('POST', '/subscription', null, { json: false, body: form.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const loc = r.headers.get('location');
    const ws = new WebSocket(loc, ['robapi2_subscription'], { headers: { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '), Authorization: this.auth } });
    ws.on('message', (m) => onEvent(m.toString()));
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const id = loc.split('/').pop();
    return { ws, location: loc, close: async () => { ws.close(); await this.req('DELETE', `/subscription/${id}`, null, { json: false }).catch(() => {}); } };
  }

  // XHTML 이벤트에서 <span class="k">v</span> 추출
  static spans(xhtml) {
    const out = {};
    for (const m of xhtml.matchAll(/<span class="([^"]+)">([^<]*)<\/span>/g)) out[m[1]] = m[2];
    return out;
  }
}

export const SAMPLE_MODULE = `MODULE RwsTest
  VAR num counter := 0;
  PERS num rwsValue := 1;
  PROC rwsTest()
    counter := counter + 1;
    WaitTime 0.1;
  ENDPROC
ENDMODULE
`;

export async function demo(host = '127.0.0.1', port = 8080, out = console.log) {
  const c = new RwsClient(host, port);
  const res = {};
  res.identity = await c.identity(); out('컨트롤러:', res.identity['ctrl-name'], res.identity['ctrl-type']);
  res.joint = await c.jointTarget(); out('jointtarget:', [1, 2, 3, 4, 5, 6].map((i) => res.joint[`rax_${i}`]).join(', '));
  res.rob = await c.robTarget(); out('robtarget:', ['x', 'y', 'z', 'q1', 'q2', 'q3', 'q4'].map((k) => res.rob[k]).join(', '));
  res.exec = await c.execution(); out('실행 상태:', res.exec.ctrlexecstate);
  await c.setMotors(true);
  res.ctrl = await c.ctrlState(); out('ctrlstate:', res.ctrl.ctrlstate);
  await c.setSpeedRatio(75);
  res.speed = await c.speedRatio(); out('speedratio:', res.speed.speedratio);

  const events = [];
  const sub = await c.subscribe(['/rw/iosystem/signals/Local/DRV_1/DO1;state', '/rw/panel/speedratio'], (x) => events.push(RwsClient.spans(x)));
  await c.setSignal('DO1', true);
  res.do1 = await c.getSignal('DO1'); out('DO1 =', res.do1);
  await c.setSignal('DO1', false);
  await c.setSpeedRatio(100);
  await new Promise((r) => setTimeout(r, 400));
  res.events = events; out('구독 이벤트:', events);
  await sub.close();

  res.upload = await c.uploadFile('RwsTest.mod', SAMPLE_MODULE); out('업로드 상태:', res.upload.status);
  res.dir = await c.listDir(); out('$HOME:', res.dir.map((f) => f._title));
  res.download = await c.downloadFile('RwsTest.mod');
  await c.loadModule('$HOME/RwsTest.mod');
  res.modules = await c.modules(); out('모듈:', res.modules.map((m) => m.name));
  try {
    await c.setSymbol('RwsTest', 'rwsValue', 42);
    res.symbol = await c.getSymbol('RwsTest', 'rwsValue'); out('rwsValue =', res.symbol);
  } catch (e) { res.symbolError = e.message; out('심볼 접근 실패:', e.message); }
  await c.resetPP().catch(() => {});
  try { await c.start('once'); res.started = true; out('RAPID 시작 OK'); } catch (e) { res.started = false; res.startError = e.message; out('RAPID 시작 실패:', e.message); }
  res.exec2 = await c.execution(); out('실행 상태:', res.exec2.ctrlexecstate);
  res.pcp = await c.pcp(); out('PP:', res.pcp[0]);
  return res;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [host = '127.0.0.1', port = '8080'] = process.argv.slice(2);
  demo(host, Number(port)).then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
}
