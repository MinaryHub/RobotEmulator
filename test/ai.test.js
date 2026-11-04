// AI 연동: 도구(tools.js), MCP HTTP 서버(mcp.js), Claude 채팅 루프(chat.js — 가짜 클라이언트로 검증, 네트워크 없음)
import http from 'node:http';
import { Controller } from '../server/controller.js';
import { TOOLS, callTool } from '../server/ai/tools.js';
import { handleMcp } from '../server/ai/mcp.js';
import { ChatSession } from '../server/ai/chat.js';

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
const run = await J(callTool(ctrl, 'run_program', { action: 'start', wait_seconds: 90 }));
ok(run.started && run.status === 'done' && run.lastCycle?.total_s > 0 && !run.alarms.length, `가상 실행 완료 (${run.status}, 사이클 ${run.lastCycle?.total_s}s)`);
ok((await J(callTool(ctrl, 'read_program', { name: 'AI.JBI' }))).text.includes('//NAME AI'), '파일 읽기');
ok((await callTool(ctrl, 'read_program', { name: 'NONE.JBI' })).isError, '없는 파일 오류');

// 2) MCP (Streamable HTTP, JSON 응답)
const srv = http.createServer((req, res) => handleMcp(ctrl, req, res));
await new Promise((res) => srv.listen(0, '127.0.0.1', res));
const url = `http://127.0.0.1:${srv.address().port}/mcp`;
const rpc = (body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
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
res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
ok(res.status === 400 && (await res.json()).error.code === -32700, 'MCP 잘못된 JSON → -32700');
srv.closeAllConnections();
srv.close();
await new Promise((r) => setTimeout(r, 100)); // keep-alive 소켓 정리 (Windows 종료 시 libuv assert 방지)

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

for (const c of [ctrl]) clearInterval(c._timer);
console.log(fail ? `\n${fail}건 실패` : '\n모두 통과');
process.exit(fail ? 1 : 0);
