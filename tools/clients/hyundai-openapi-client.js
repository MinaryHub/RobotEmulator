#!/usr/bin/env node
// Hyundai Hi6 Open API(에뮬레이터 REST) 샘플 클라이언트 — HTTP JSON, 기본 포트 8888
// Node 내장 fetch 사용, 외부 의존성 없음.
//
// 사용법:  node tools/clients/hyundai-openapi-client.js [host] [port]
//
// ※ /project/... 경로는 Hi6 Open API 를 근사한 것이다. 실제 장비에서는 현대로보틱스 매뉴얼로 경로를 확인할 것.
import { pathToFileURL } from 'node:url';

export class HyundaiClient {
  constructor(host = '127.0.0.1', port = 8888) { this.base = `http://${host}:${port}`; }

  async req(method, path, body, { raw = false } = {}) {
    const init = { method, headers: {} };
    if (body !== undefined) {
      if (typeof body === 'string') { init.body = body; init.headers['Content-Type'] = 'text/plain; charset=utf-8'; }
      else { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    }
    const r = await fetch(this.base + path, init);
    const text = await r.text();
    if (!r.ok) { let m = text; try { m = JSON.parse(text).error; } catch {} const e = new Error(`${method} ${path} → ${r.status} ${m}`); e.status = r.status; throw e; }
    if (raw || !/json/.test(r.headers.get('content-type') || '')) return text;
    return JSON.parse(text);
  }

  status() { return this.req('GET', '/api/status'); }
  pose() { return this.req('GET', '/api/pose'); }
  joints() { return this.req('GET', '/api/joints'); }
  servo(on) { return this.req('POST', '/api/servo', { on }); }
  resetAlarms() { return this.req('POST', '/api/alarms/reset', {}); }
  program(action, body = {}) { return this.req('POST', `/api/program/${action}`, body); }
  select(name) { return this.program('select', { name }); }
  uploadFile(name, text) { return this.req('PUT', `/api/files/${encodeURIComponent(name)}`, text); }
  listFiles() { return this.req('GET', '/api/files'); }
  getFile(name) { return this.req('GET', `/api/files/${encodeURIComponent(name)}`, undefined, { raw: true }); }
  getVar(name) { return this.req('GET', `/api/var/${encodeURIComponent(name)}`); }
  setVar(name, value) { return this.req('PUT', `/api/var/${encodeURIComponent(name)}`, { value }); }
  getIO(type, n) { return this.req('GET', `/api/io/${type}/${n}`); }
  setIO(type, n, value) { return this.req('PUT', `/api/io/${type}/${n}`, { value }); }
  move(cmd) { return this.req('POST', '/api/move', cmd); }

  // Hi6 스타일
  poCur() { return this.req('GET', '/project/robot/po_cur'); }
  jointStates() { return this.req('GET', '/project/robot/joints/joint_states'); }
  rgen() { return this.req('GET', '/project/rgen'); }
  task0() { return this.req('GET', '/project/context/tasks[0]'); }
}

export const SAMPLE_JOB = `Hyundai Robot Job File; { version: 1.6, mech_type: "", total_axis: 6, aux_axis: 0 }
     S1   MOVE P,S=20%,A=0,T=0  (0,90,0,0,-90,0)A
     DELAY 0.1
     END
`;

export async function demo(host = '127.0.0.1', port = 8888, out = console.log) {
  const c = new HyundaiClient(host, port);
  const res = {};
  res.status = await c.status(); out('상태:', { robot: res.status.robot, servo: res.status.servo, program: res.status.program.main });
  res.pose = await c.pose(); out('TCP:', res.pose);
  res.joints = await c.joints(); out('관절:', res.joints.joints);
  res.poCur = await c.poCur(); out('po_cur:', res.poCur);
  res.rgen = await c.rgen(); out('rgen:', res.rgen);
  await c.resetAlarms();
  res.servo = await c.servo(true); out('서보:', res.servo);
  res.ioSet = await c.setIO('do', 5, true);
  res.io = await c.getIO('do', 5); out('DO5 =', res.io.value);
  await c.setIO('do', 5, false);
  res.varSet = await c.setVar('V1', 12.5);
  res.var = await c.getVar('V1'); out('V1 =', res.var.value);
  const j = res.joints.joints.slice();
  j[0] += 5;
  res.move = await c.move({ type: 'joint', joints: j, speed: 50, wait: true }); out('관절 이동 완료:', res.move.done);
  res.upload = await c.uploadFile('0099.job', SAMPLE_JOB); out('업로드:', res.upload);
  res.files = await c.listFiles(); out('파일:', res.files.map((f) => f.name));
  res.download = await c.getFile('0099.job');
  res.select = await c.select('0099'); out('선택:', res.select.main, res.select.compileError ? `(컴파일 오류: ${res.select.compileError.msg})` : '');
  try { res.start = await c.program('start'); out('시작:', res.start); } catch (e) { res.startError = e.message; out('시작 실패:', e.message); }
  res.task = await c.task0(); out('task0:', res.task);
  return res;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [host = '127.0.0.1', port = '8888'] = process.argv.slice(2);
  demo(host, Number(port)).then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
}
