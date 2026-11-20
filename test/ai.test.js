// AI 연동: 도구(tools.js), MCP HTTP 서버(mcp.js), Claude 채팅 루프(chat.js — 가짜 클라이언트로 검증, 네트워크 없음)
import http from 'node:http';
import fs from 'node:fs';
import { Controller } from '../server/controller.js';
import { TOOLS, callTool } from '../server/ai/tools.js';
import { handleMcp } from '../server/ai/mcp.js';
import { ChatSession } from '../server/ai/chat.js';
import { ClaudeCodeSession } from '../server/ai/chat-cli.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  OK ' : '  NG '} ${m}`); if (!c) fail++; };
const J = async (p) => JSON.parse((await p).text);

const ctrl = new Controller();
ctrl.setRobot('yaskawa-gp7');

// 1) 도구
const ctx = await J(callTool(ctrl, 'get_context', {}));
ok(ctx.robot.vendor === 'yaskawa' && ctx.language.ext.includes('JBI') && ctx.objects.length > 0 && ctx.gripper.io.close >= 1, '컨텍스트: 로봇·언어·공작물·그리퍼 I/O');
const guide = await J(callTool(ctrl, 'get_language_guide', {}));
ok(/MOVJ/.test(guide.syntax) && Object.keys(guide.exampleFiles).length > 0, '언어 가이드: 문법 요약 + 현재 셀 예제');
const [exName, exText] = Object.entries(guide.exampleFiles)[0];

let r = await callTool(ctrl, 'write_program', { name: 'X.src', text: 'DEF X()\nEND' });
ok(r.isError && /확장자/.test(r.text), '다른 제조사 확장자 거부');
r = await callTool(ctrl, 'write_program', { name: 'BAD.JBI', text: '/JOB\n//NAME BAD\n//INST\nNOP\nMOVJ C99999 VJ=10\nEND\n' });
ok(!r.isError && JSON.parse(r.text).compileError, '컴파일 오류를 결과로 반환');
r = await callTool(ctrl, 'write_program', { name: 'AI.JBI', text: exText.replace(new RegExp(`//NAME\\s+${exName.replace(/\.JBI$/i, '')}`, 'i'), '//NAME AI') });
const w = JSON.parse(r.text);
ok(!r.isError && w.ok && ctrl.main === 'AI.JBI', `저장·컴파일·메인 지정 (${w.compileError?.msg ?? 'OK'})`);
ok((await callTool(ctrl, 'write_program', { name: 'A.JBI' })).isError, '필수 항목 누락 거부');
ok((await callTool(ctrl, 'run_program', { action: 'jump' })).isError, 'enum 밖 action 거부');
ok(ctrl.mode === 'TEACH', '기본 모드 TEACH');
r = await callTool(ctrl, 'run_program', { action: 'start', wait_seconds: 1 });
ok(r.isError && /REMOTE/.test(r.text) && ctrl.vm?.status !== 'running', `TEACH 모드: AI 프로그램 시작 거부 (${r.text.slice(0, 50)})`);
ctrl.setMode('REMOTE', 'ui');
const run = await J(callTool(ctrl, 'run_program', { action: 'start', wait_seconds: 90 }));
ok(run.started && run.status === 'done' && run.lastCycle?.total_s > 0 && !run.alarms.length, `가상 실행 완료 (${run.status}, 사이클 ${run.lastCycle?.total_s}s)`);
ok((await J(callTool(ctrl, 'read_program', { name: 'AI.JBI' }))).text.includes('//NAME AI'), '파일 읽기');
ok((await callTool(ctrl, 'read_program', { name: 'NONE.JBI' })).isError, '없는 파일 오류');

// 1b) 직접 제어 도구
{
  await callTool(ctrl, 'run_program', { action: 'reset' });
  await J(callTool(ctrl, 'set_servo', { on: false }));
  r = await callTool(ctrl, 'move_robot', { home: true });
  ok(r.isError && /서보 OFF/.test(r.text), '직접 이동: 서보 OFF 거부');
  ctrl.setMode('TEACH', 'ui');
  r = await callTool(ctrl, 'set_servo', { on: true });
  ok(r.isError && /REMOTE/.test(r.text) && !ctrl.servo, 'TEACH 모드: AI 서보 ON 거부');
  ctrl.setServo(true, 'ui');
  const jBefore = [...ctrl.joints];
  r = await callTool(ctrl, 'move_robot', { joint_offsets: [5, 0, 0, 0, 0, 0] });
  ok(r.isError && /REMOTE/.test(r.text) && ctrl.joints[0] === jBefore[0], 'TEACH 모드: AI 직접 이동 거부');
  ctrl.setMode('PLAY', 'ui');
  r = await callTool(ctrl, 'move_robot', { joint_offsets: [5, 0, 0, 0, 0, 0] });
  ok(r.isError && /REMOTE/.test(r.text), 'PLAY 모드: AI 직접 이동 거부');
  r = await callTool(ctrl, 'set_io', { type: 'do', n: 31, value: true });
  ok(r.isError && /REMOTE/.test(r.text) && !ctrl.getDO(31), 'PLAY 모드: AI DO 출력 거부');
  r = await callTool(ctrl, 'set_io', { type: 'di', n: 8, value: true });
  ok(r.isError && /REMOTE/.test(r.text) && !ctrl.getDI(8), 'PLAY 모드: AI DI 시뮬레이션 거부');
  ok(!(await callTool(ctrl, 'stop_robot', { action: 'status' })).isError && !(await callTool(ctrl, 'get_context', {})).isError, 'TEACH/PLAY 모드: 상태 조회는 허용');
  ctrl.setMode('TEACH', 'ui');
  const gio = ctrl.gripperIO, closed0 = ctrl.grip.closed;
  r = await callTool(ctrl, 'gripper', { action: 'close' });
  ok(r.isError && /REMOTE/.test(r.text) && ctrl.grip.closed === closed0, 'TEACH 모드: AI 그리퍼 닫기 거부');
  r = await callTool(ctrl, 'gripper', { action: 'open' });
  ok(r.isError && /REMOTE/.test(r.text), 'TEACH 모드: AI 그리퍼 열기 거부');
  r = await callTool(ctrl, 'set_io', { type: 'do', n: gio.close, value: true });
  ok(r.isError && /REMOTE/.test(r.text) && !ctrl.getDO(gio.close) && ctrl.grip.closed === closed0, 'TEACH 모드: set_io 로 그리퍼 DO 거부');
  ctrl.interlock = false;
  ok(!(await callTool(ctrl, 'gripper', { action: 'open' })).isError && !(await callTool(ctrl, 'set_io', { type: 'do', n: 31, value: false })).isError, '인터록 OFF: 그리퍼·I/O 허용');
  ctrl.interlock = true;
  ctrl.setServo(false, 'ui');
  ctrl.setMode('REMOTE', 'ui');
  let s = await J(callTool(ctrl, 'set_servo', { on: true, reset_alarms: true }));
  ok(s.servo === true, '서보 ON');
  ok((await callTool(ctrl, 'move_robot', { home: true, joints: [0, 0, 0, 0, 0, 0] })).isError, '대상 2개 지정 거부');
  ok((await callTool(ctrl, 'move_robot', { joints: [0, 0, 0] })).isError, '관절 개수 오류 거부');
  ok((await callTool(ctrl, 'move_robot', { joints: [0, 'a', 0, 0, 0, 0] })).isError, '배열 원소 형식 오류 거부');
  ok((await callTool(ctrl, 'move_robot', { joints: [0, 0, 0, 0, 0, 0], motion: 'linear' })).isError, '관절 대상 linear 거부');

  let m = await J(callTool(ctrl, 'move_robot', { joints: [10, 10, -10, 0, -60, 5], speed_percent: 100 }));
  ok(m.result === 'done' && m.joints_deg.every((v, i) => Math.abs(v - [10, 10, -10, 0, -60, 5][i]) < 0.05), `관절 이동 도착 (${m.joints_deg})`);
  m = await J(callTool(ctrl, 'move_robot', { joint_offsets: [5, 0, 0, 0, 0, 0], speed_percent: 100 }));
  ok(m.result === 'done' && Math.abs(m.joints_deg[0] - 15) < 0.05, '관절 상대 이동');

  const z0 = ctrl.tcpPose().p[2], x0 = ctrl.tcpPose().p[0];
  m = await J(callTool(ctrl, 'move_robot', { offset_mm: [0, 0, 50], motion: 'linear', speed_percent: 50 }));
  const p1 = ctrl.tcpPose().p;
  ok(m.result === 'done' && Math.abs(p1[2] - z0 - 50) < 0.5 && Math.abs(p1[0] - x0) < 0.5, `직선 상대 이동 +Z50 (Δz=${(p1[2] - z0).toFixed(2)})`);

  const tgt = [...m.tcp_vendor]; tgt[0] += 30; tgt[1] -= 20;
  m = await J(callTool(ctrl, 'move_robot', { pose: tgt, speed_percent: 50 }));
  ok(m.result === 'done' && m.tcp_vendor.slice(0, 3).every((v, i) => Math.abs(v - tgt[i]) < 0.5), '절대 TCP 이동 (제조사 표기)');
  r = await callTool(ctrl, 'move_robot', { pose: [5000, 0, 0, 180, 0, 0] });
  ok(r.isError && /도달/.test(r.text), `도달 불가 위치 오류 반환`);

  m = await J(callTool(ctrl, 'move_robot', { home: true, speed_percent: 100, wait_seconds: 0 }));
  ok(m.result === 'timeout' && m.moving, '대기 0초 → 이동 중 반환');
  ok((await callTool(ctrl, 'move_robot', { home: true })).isError, '이동 중 새 이동 거부');
  s = await J(callTool(ctrl, 'stop_robot', { action: 'stop' }));
  ok(!s.moving && !s.held, '정지: 이동 취소');
  m = await J(callTool(ctrl, 'move_robot', { home: true, speed_percent: 100 }));
  ok(m.result === 'done' && m.joints_deg.every((v, i) => Math.abs(v - ctrl.robot.home[i]) < 0.05), '홈 복귀');

  const g = await J(callTool(ctrl, 'gripper', { action: 'close' }));
  ok(g.closed && (!ctrl.gripperIO.fbClosed || ctrl.getDI(ctrl.gripperIO.fbClosed)), '그리퍼 닫기 + 닫힘 DI');
  const go = await J(callTool(ctrl, 'gripper', { action: 'open' }));
  ok(!go.closed && go.holding === null, '그리퍼 열기');

  const io = await J(callTool(ctrl, 'set_io', { type: 'do', n: 30, value: true }));
  ok(io.value === true && io.doOn.includes(30) && ctrl.getDO(30), 'DO 출력');
  await callTool(ctrl, 'set_io', { type: 'do', n: 30, value: false });
  ok((await J(callTool(ctrl, 'set_io', { type: 'di', n: 7, value: true }))).diOn.includes(7), 'DI 시뮬레이션');
  await callTool(ctrl, 'set_io', { type: 'di', n: 7, value: false });
  ok((await callTool(ctrl, 'set_io', { type: 'do', n: 99999, value: true })).isError, 'I/O 범위 초과 오류');

  ctrl.setEstop(true, 'ui');
  r = await callTool(ctrl, 'move_robot', { joint_offsets: [1, 0, 0, 0, 0, 0] });
  ok(r.isError, `비상정지 중 이동 거부 (${r.text.slice(0, 40)})`);
  ctrl.setEstop(false, 'ui');
  ctrl.resetAlarms();
}

// 2) MCP (Streamable HTTP, JSON 응답)
const srv = http.createServer((req, res) => handleMcp(ctrl, req, res));
await new Promise((res) => srv.listen(0, '127.0.0.1', res));
const url = `http://127.0.0.1:${srv.address().port}/mcp`;
// fetch 대신 keep-alive 없는 http.request — fetch 의 유휴 소켓이 남은 채 process.exit 하면 Windows 에서 간헐적으로 libuv assert 로 종료됨
const post = (raw, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request(url, { method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Connection: 'close', ...headers } }, (r) => {
    let data = '';
    r.on('data', (c) => (data += c));
    r.on('end', () => resolve({ status: r.statusCode, json: async () => JSON.parse(data) }));
  });
  req.on('error', reject);
  req.end(raw);
});
const rpc = (body, headers) => post(JSON.stringify(body), headers);
let res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
let body = await res.json();
ok(res.status === 200 && body.result.protocolVersion === '2025-06-18' && body.result.capabilities.tools, 'MCP initialize');
res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
ok(res.status === 202, 'MCP 알림 → 202');
body = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
ok(body.result.tools.length === TOOLS.length && body.result.tools.every((t) => t.inputSchema?.type === 'object'), `MCP tools/list (${body.result.tools.length}개)`);
body = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_context', arguments: {} } })).json();
ok(body.result.isError === false && JSON.parse(body.result.content[0].text).robot.id === 'yaskawa-gp7', 'MCP tools/call');
body = await (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read_program', arguments: {} } })).json();
ok(body.result.isError === true, 'MCP 도구 입력 오류 → isError');
body = await (await rpc({ jsonrpc: '2.0', id: 5, method: 'nope' })).json();
ok(body.error?.code === -32601, 'MCP 모르는 메서드 → -32601');
res = await rpc({ jsonrpc: '2.0', id: 6, method: 'ping' }, { Origin: 'http://evil.example' });
ok(res.status === 403, 'MCP 외부 Origin 거부');
res = await rpc({ jsonrpc: '2.0', id: 7, method: 'ping' }, { Origin: 'http://evil.example:3000', Host: 'evil.example:3000' });
ok(res.status === 403, 'MCP DNS 리바인딩(Origin=Host=외부 도메인) 거부');
res = await rpc({ jsonrpc: '2.0', id: 8, method: 'ping' }, { Origin: `http://127.0.0.1:${srv.address().port}` });
ok(res.status === 200, 'MCP 같은 출처 Origin 허용');
res = await post('{bad');
ok(res.status === 400 && (await res.json()).error.code === -32700, 'MCP 잘못된 JSON → -32700');
srv.close();

// 3) 채팅 루프 (가짜 Claude 클라이언트: 1턴 도구 호출 → 2턴 답변)
function fakeStream(content, stop_reason) {
  const events = [];
  for (const b of content) {
    events.push({ type: 'content_block_start', content_block: b.type === 'text' ? { type: 'text', text: '' } : b });
    if (b.type === 'text') events.push({ type: 'content_block_delta', delta: { type: 'text_delta', text: b.text } });
  }
  return { async *[Symbol.asyncIterator]() { yield* events; }, finalMessage: async () => ({ role: 'assistant', content, stop_reason }) };
}
const turns = [
  fakeStream([{ type: 'text', text: '확인합니다.' }, { type: 'tool_use', id: 'tu1', name: 'get_context', input: {} }, { type: 'tool_use', id: 'tu2', name: 'run_program', input: { action: 'fly' } }], 'tool_use'),
  fakeStream([{ type: 'text', text: '완료' }], 'end_turn'),
];
const seen = [];
const calls = [];
const client = { beta: { messages: { stream: (params) => { calls.push(structuredClone(params)); return turns.shift(); } } } };
const events = [];
const chat = new ChatSession({ ctrl, client, send: (e) => events.push(e) });
await chat.ask('상태 알려줘');
ok(calls.length === 2 && calls[0].model === 'claude-opus-5-5' && calls[0].tools.every((t) => t.eager_input_streaming) && calls[0].fallbacks === 'default', '요청: 모델·도구·fallbacks');
const t2 = calls[1].messages;
ok(t2.length === 3 && t2[2].content.length === 2 && t2[2].content[0].tool_use_id === 'tu1' && !t2[2].content[0].is_error, '도구 결과를 한 user 메시지로 반환');
ok(t2[2].content[1].is_error === true && /INVALID_INPUT/.test(t2[2].content[1].content), '잘못된 도구 입력 → is_error');
ok(events.some((e) => e.ev === 'text' && e.delta === '완료') && events.some((e) => e.ev === 'tool_end' && e.name === 'get_context' && e.ok) && events.at(-1).ev === 'done', 'UI 이벤트 스트리밍');
ok(chat.messages.length === 4 && !chat.busy, '대화 기록 유지');

// API 오류 → 실패한 턴은 기록에서 제거, 오류 이벤트
const before = chat.messages.length;
client.beta.messages.stream = () => { throw new Error('boom'); };
events.length = 0;
await chat.ask('다시');
ok(chat.messages.length === before && events.at(-1).ev === 'error' && !chat.busy, '오류 시 턴 롤백');

// 4) 채팅 — Claude Code CLI 백엔드 (가짜 프로세스: stream-json 출력)
{
  const runs = [];
  let script = null;
  const spawnFn = (cmd, args, opts) => {
    const run = { cmd, args, env: opts.env, stdin: '' };
    runs.push(run);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.stdin.on('data', (d) => (run.stdin += d));
    child.kill = () => { child.stdout.end(); setImmediate(() => child.emit('close', null)); };
    setImmediate(() => script(child));
    return child;
  };
  const emitLines = (child, lines, code = 0) => { for (const l of lines) child.stdout.write(JSON.stringify(l) + '\n'); child.stdout.end(); setImmediate(() => child.emit('close', code)); };
  script = (child) => emitLines(child, [
    { type: 'system', subtype: 'init', session_id: 'x' },
    { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'mcp__robot__move_robot' } } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__robot__move_robot', input: { home: true } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '{"result":"done"}' }] }] } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '홈으로 이동했습니다' } } },
    { type: 'result', subtype: 'success', is_error: false, result: '홈으로 이동했습니다' },
  ]);
  const ev = [];
  process.env.ANTHROPIC_API_KEY ??= 'sk-test';
  const cc = new ClaudeCodeSession({ ctrl, config: { effort: 'high' }, mcpUrl: 'http://127.0.0.1:1/mcp', send: (e) => ev.push(e), spawnFn });
  await cc.ask('홈으로');
  const a0 = runs[0].args;
  ok(a0.includes('--session-id') && a0.includes('--strict-mcp-config') && a0[a0.indexOf('--tools') + 1] === '' && JSON.parse(fs.readFileSync(a0[a0.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.robot.url === 'http://127.0.0.1:1/mcp', 'CLI: MCP 전용·내장 도구 없음·새 세션');
  ok(runs[0].stdin === '홈으로' && !a0.includes('홈으로') && fs.existsSync(a0[a0.indexOf('--system-prompt-file') + 1]), 'CLI: 사용자 입력은 stdin, 시스템 프롬프트는 파일 (명령줄 주입 방지)');
  ok(!('ANTHROPIC_API_KEY' in runs[0].env), 'CLI: API 키 환경변수 제거 (구독 로그인 사용)');
  ok(ev.some((e) => e.ev === 'tool_start' && e.name === 'move_robot') && ev.some((e) => e.ev === 'tool_end' && e.name === 'move_robot' && e.ok) && ev.some((e) => e.ev === 'text') && ev.at(-1).ev === 'done', 'CLI: 도구·텍스트 이벤트 변환');
  await cc.ask('다시');
  ok(runs[1].args.includes('--resume') && runs[1].args[runs[1].args.indexOf('--resume') + 1] === runs[0].args[runs[0].args.indexOf('--session-id') + 1], 'CLI: 같은 세션 이어가기');
  script = (child) => { child.stderr.write('Not logged in · Please run /login'); emitLines(child, [], 1); };
  ev.length = 0; await cc.ask('x');
  ok(ev.at(-1).ev === 'error' && /로그인/.test(ev.at(-1).msg) && !cc.busy, 'CLI: 로그인 필요 오류');
  script = () => {};   // 응답 없이 대기 → stop
  ev.length = 0; const p = cc.ask('y'); await sleep0(); cc.stop(); await p;
  ok(ev.at(-1).ev === 'error' && /중단/.test(ev.at(-1).msg), 'CLI: 중단');
  cc.reset();
  ok(!cc.started && cc.sessionId !== runs[0].args[runs[0].args.indexOf('--session-id') + 1], 'CLI: 새 대화 = 새 세션');
}
function sleep0() { return new Promise((r) => setTimeout(r, 20)); }

for (const c of [ctrl]) clearInterval(c._timer);
console.log(fail ? `\n${fail}건 실패` : '\n모두 통과');
process.exit(fail ? 1 : 0);
