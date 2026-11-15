// Claude 채팅 — Claude Code CLI 백엔드 (API 키 없이, 이 PC 에 로그인된 Claude 구독 계정 사용)
//  - `claude -p` 를 요청마다 실행하고, 에뮬레이터의 MCP 서버(/mcp)를 유일한 도구로 연결
//  - 대화 이어가기: 첫 요청 --session-id, 이후 --resume (같은 브라우저 탭 = 같은 세션)
//  - 이벤트 형식은 ChatSession(API 백엔드)과 같음: text / thinking / tool_start / tool_end / note / done / error
//  - 준비: Claude Code 설치 후 `claude` 로 한 번 로그인 (https://claude.com/claude-code)
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import { SYSTEM, summarizeInput, summarizeResult } from './chat.js';

const MCP_NAME = 'robot';
const PREFIX = `mcp__${MCP_NAME}__`;

let cliChecked = null;
// claude CLI 가 실행 가능한지 (결과 캐시)
export function claudeCliAvailable(cmd = 'claude') {
  if (cliChecked !== null) return cliChecked;
  try {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 10000, shell: process.platform === 'win32' });
    cliChecked = r.status === 0;
  } catch { cliChecked = false; }
  return cliChecked;
}

// 중첩 실행 표시·API 키 환경변수 제거 → 구독 로그인 사용
function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDECODE') || k === 'CLAUDE_CODE_ENTRYPOINT') delete env[k];
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

export class ClaudeCodeSession {
  // opts: { ctrl, config: { cliModel?, effort?, cliCommand? }, mcpUrl, send(ev), spawnFn? }
  constructor({ ctrl, config = {}, mcpUrl, send, spawnFn }) {
    this.ctrl = ctrl;
    this.config = config;
    this.mcpUrl = mcpUrl;
    this.send = send;
    this.spawn = spawnFn || spawn;
    this.cmd = config.cliCommand || 'claude';
    this.busy = false;
    this.child = null;
    this.reset();
  }

  reset() { this.stop(); this.sessionId = crypto.randomUUID(); this.started = false; }
  stop() { if (this.child) { this.stopped = true; this.child.kill('SIGTERM'); } }

  args(text) {
    const mcp = { mcpServers: { [MCP_NAME]: { type: 'http', url: this.mcpUrl } } };
    const a = [
      '-p', text,
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--mcp-config', JSON.stringify(mcp), '--strict-mcp-config',
      '--tools', '',                       // 내장 도구(파일·셸) 없음 — 에뮬레이터 도구만
      '--allowedTools', `mcp__${MCP_NAME}`,
      '--system-prompt', SYSTEM,
      ...(this.started ? ['--resume', this.sessionId] : ['--session-id', this.sessionId]),
    ];
    if (this.config.cliModel) a.push('--model', this.config.cliModel);
    if (this.config.effort) a.push('--effort', this.config.effort);
    return a;
  }

  async ask(text) {
    if (this.busy) { this.send({ ev: 'error', msg: '이전 요청을 처리 중입니다. 정지 후 다시 보내세요.' }); return; }
    this.busy = true;
    this.stopped = false;
    this.ctrl.log('system', `Claude 채팅 (Claude Code): ${String(text).slice(0, 60)}`);
    try {
      const r = await this.run(String(text));
      if (r.error) this.send({ ev: 'error', msg: r.error });
      else this.send({ ev: 'done' });
    } finally {
      this.busy = false;
      this.child = null;
    }
  }

  run(text) {
    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawn(this.cmd, this.args(text), { cwd: os.tmpdir(), env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
      } catch (e) { resolve({ error: cliError(e) }); return; }
      this.child = child;
      const tools = new Map();   // tool_use_id → { name, input }
      let buf = '', stderr = '', result = null, sawText = false;
      const onLine = (line) => {
        if (!line.trim()) return;
        let o;
        try { o = JSON.parse(line); } catch { return; }
        if (o.type === 'system' && o.subtype === 'init') this.started = true;
        else if (o.type === 'stream_event') {
          const e = o.event;
          if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') this.send({ ev: 'tool_start', name: strip(e.content_block.name) });
          else if (e.type === 'content_block_delta') {
            if (e.delta?.type === 'text_delta') { sawText = true; this.send({ ev: 'text', delta: e.delta.text }); }
            else if (e.delta?.type === 'thinking_delta') this.send({ ev: 'thinking', delta: e.delta.thinking });
          } else if (e.type === 'message_start' && sawText) this.send({ ev: 'text', delta: '\n\n' });
        } else if (o.type === 'assistant') {
          for (const b of o.message?.content || []) if (b.type === 'tool_use') tools.set(b.id, { name: strip(b.name), input: b.input });
        } else if (o.type === 'user') {
          for (const b of o.message?.content || []) {
            if (b.type !== 'tool_result') continue;
            const t = tools.get(b.tool_use_id) || { name: '?', input: {} };
            const txt = Array.isArray(b.content) ? b.content.map((c) => c.text ?? '').join('') : String(b.content ?? '');
            const r = { text: txt, isError: !!b.is_error };
            this.send({ ev: 'tool_end', name: t.name, input: summarizeInput(t.name, t.input), ok: !r.isError, result: summarizeResult(t.name, r) });
          }
        } else if (o.type === 'result') result = o;
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
      child.on('error', (e) => resolve({ error: cliError(e) }));
      child.on('close', (code) => {
        if (buf) onLine(buf);
        if (this.stopped) return resolve({ error: '중단했습니다.' });
        if (result && !result.is_error) return resolve({});
        const msg = result?.result || result?.errors?.join(', ') || stderr.trim() || `claude 종료 코드 ${code}`;
        resolve({ error: describeCliError(msg) });
      });
    });
  }
}

const strip = (n) => (n?.startsWith(PREFIX) ? n.slice(PREFIX.length) : n);

function cliError(e) {
  if (e.code === 'ENOENT') return 'Claude Code CLI(claude)를 찾을 수 없습니다. Claude Code 를 설치하고 터미널에서 `claude` 로 로그인한 뒤 서버를 다시 시작하세요.';
  return `Claude Code 실행 실패: ${e.message}`;
}

function describeCliError(msg) {
  if (/log ?in|auth|credential|401/i.test(msg)) return `Claude Code 로그인이 필요합니다. 서버를 실행하는 PC 의 터미널에서 \`claude\` 를 실행해 로그인하세요.\n(${msg.slice(0, 200)})`;
  if (/rate limit|usage limit|limit reached/i.test(msg)) return `Claude 사용 한도에 도달했습니다: ${msg.slice(0, 200)}`;
  return `Claude Code 오류: ${msg.slice(0, 400)}`;
}
