#!/usr/bin/env node
// stdio ↔ HTTP MCP 브리지: stdio 전송만 지원하는 MCP 클라이언트(예: Claude Desktop)용
//   실행 중인 에뮬레이터의 /mcp 엔드포인트로 JSON-RPC 메시지를 그대로 전달한다.
//   사용: node tools/mcp-stdio.js [http://localhost:3000/mcp]
//
//   Claude Desktop 설정(claude_desktop_config.json) 예:
//   { "mcpServers": { "robot-emulator": { "command": "node", "args": ["C:/path/to/RobotEmulator/tools/mcp-stdio.js"] } } }
import readline from 'node:readline';

const url = process.argv[2] || process.env.ROBOT_EMULATOR_MCP || 'http://localhost:3000/mcp';
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const rl = readline.createInterface({ input: process.stdin });
// 받은 순서대로 하나씩 전달 (응답 순서 유지)
let queue = Promise.resolve();
rl.on('line', (line) => { queue = queue.then(() => relay(line)); });

async function relay(line) {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: line });
    if (r.status === 202) return;
    const body = await r.json();
    for (const m of Array.isArray(body) ? body : [body]) out(m);
  } catch (e) {
    if ('id' in msg) out({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `에뮬레이터(${url})에 연결할 수 없습니다. npm start 로 먼저 실행하세요. (${e.message})` } });
  }
}
