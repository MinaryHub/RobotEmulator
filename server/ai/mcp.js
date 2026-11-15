// MCP 서버 (Model Context Protocol, Streamable HTTP 전송 — 외부 의존성 없음)
//   엔드포인트: POST http://<host>:<port>/mcp   (JSON-RPC 2.0, 응답은 application/json)
//   지원 메서드: initialize, notifications/*, ping, tools/list, tools/call
//   도구 정의: server/ai/tools.js (Claude 채팅과 공용)
//
//   Claude Code 등록 예:  claude mcp add --transport http robot-emulator http://localhost:3000/mcp
//   stdio 만 지원하는 클라이언트: node tools/mcp-stdio.js [http://localhost:3000/mcp]
import { TOOLS, callTool } from './tools.js';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'robot-emulator', title: '산업용 로봇 에뮬레이터', version: '1.0.0' };
const INSTRUCTIONS = `가상 산업용 로봇 컨트롤러(Yaskawa INFORM / Kawasaki AS / Hyundai HRScript / ABB RAPID / KUKA KRL / Doosan DRL)를 조작한다.
로봇 프로그램을 만들 때: get_context 로 로봇·셀·I/O 를 확인 → get_language_guide 로 문법과 동작하는 예제를 확인 → write_program 으로 저장·컴파일(오류가 있으면 고쳐서 다시 저장) → 필요하면 run_program(start) 으로 가상 로봇에서 실행해 결과(사이클 타임, 알람, 간섭, 공작물 위치)를 확인한다.
가상 로봇을 직접 조작할 때: set_servo(on) → move_robot(home/joints/joint_offsets/pose/offset_mm) · gripper(open/close) · set_io · stop_robot(hold/resume/stop). 각 결과에 최종 관절각·TCP·알람·간섭이 포함된다.
로봇을 움직이거나 신호를 바꾸는 명령(서보 ON·이동·프로그램 시작·재개·그리퍼 개폐·I/O 쓰기)은 운전 모드가 REMOTE 일 때만 허용된다. 거부되면 사용자에게 화면에서 REMOTE 로 바꿔 달라고 요청한다.`;

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });

async function dispatch(ctrl, msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return msg && 'id' in msg && !('method' in msg) ? null : rpcError(msg?.id, -32600, 'Invalid Request');
  }
  const isNotification = !('id' in msg);
  if (isNotification) return null; // notifications/initialized, notifications/cancelled 등
  const p = msg.params || {};
  switch (msg.method) {
    case 'initialize': {
      const v = PROTOCOL_VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOL_VERSIONS[0];
      return ok(msg.id, { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    case 'ping': return ok(msg.id, {});
    case 'tools/list':
      return ok(msg.id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) });
    case 'tools/call': {
      if (!TOOLS.some((t) => t.name === p.name)) return rpcError(msg.id, -32602, `Unknown tool: ${p.name}`);
      ctrl.log('comm', `[MCP] ${p.name}`);
      const r = await callTool(ctrl, p.name, p.arguments ?? {});
      return ok(msg.id, { content: [{ type: 'text', text: r.text }], isError: r.isError });
    }
    default: return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

// 브라우저발 DNS 리바인딩 방지: Origin 이 있으면 요청 Host 와 같거나 localhost 여야 함
function originAllowed(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    const u = new URL(o);
    return u.host === req.headers.host || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch { return false; }
}

// http 요청 처리 (index.js 에서 /mcp 경로를 넘김)
export async function handleMcp(ctrl, req, res) {
  if (!originAllowed(req)) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(rpcError(null, -32000, 'Origin not allowed'))); }
  if (req.method === 'GET') { res.writeHead(405, { Allow: 'POST' }); return res.end(); } // 서버 → 클라이언트 SSE 스트림은 제공하지 않음
  if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }              // 세션 없음
  if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
  let body = '';
  for await (const c of req) { body += c; if (body.length > 8e6) { res.writeHead(413); return res.end(); } }
  let msg;
  try { msg = JSON.parse(body); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')));
  }
  const out = Array.isArray(msg)
    ? (await Promise.all(msg.map((m) => dispatch(ctrl, m)))).filter(Boolean)
    : await dispatch(ctrl, msg);
  if (out == null || (Array.isArray(out) && !out.length)) { res.writeHead(202); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(out));
}
