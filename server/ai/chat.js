// Claude 채팅 (웹 UI 오른쪽 패널) — Claude API + 에뮬레이터 도구(server/ai/tools.js) 에이전트 루프
//  - 인증: ANTHROPIC_API_KEY 환경변수 또는 `ant auth login` 프로필 (SDK 기본 해석 순서)
//  - 모델: config.json 의 "ai": { "model": "...", "effort": "..." } 로 변경 가능 (기본 claude-opus-5-5 / high)
//  - 세션: 브라우저 탭(WebSocket 연결)마다 대화 1개. 이벤트는 send(ev) 로 스트리밍
import Anthropic from '@anthropic-ai/sdk';
import { TOOLS, callTool, validateInput } from './tools.js';

const SYSTEM = `당신은 산업용 로봇 에뮬레이터에 내장된 로봇 프로그래밍 도우미입니다. 사용자는 PLC·로봇 엔지니어입니다.
에뮬레이터는 Yaskawa INFORM, Kawasaki AS, Hyundai HRScript, ABB RAPID, KUKA KRL 프로그램을 가상 컨트롤러에서 실행하고 3D 로 보여 줍니다.

로봇 프로그램을 작성하거나 고칠 때:
1. get_context 로 현재 로봇·언어·그리퍼 I/O·셀 배치(공작물·테이블·장애물·컨베이어 좌표)를 확인합니다. 좌표와 I/O 번호를 추측하지 마세요.
2. get_language_guide 로 이 에뮬레이터가 지원하는 문법과 현재 셀에 맞춘 동작하는 예제를 확인하고, 예제의 파일 구조·좌표 표기·툴 정의·그리퍼 신호 사용법을 따릅니다. 지원 목록에 없는 명령은 쓰지 않습니다.
3. write_program 으로 저장합니다. compileError 가 있으면 해당 라인을 고쳐 다시 저장합니다.
4. 사용자가 실행·검증을 원하거나 동작 확인이 중요한 작업이면 run_program(start) 으로 가상 로봇에서 실행해 알람·간섭·공작물 최종 위치·사이클 타임을 확인하고, 문제가 있으면 고칩니다. 가상 로봇이므로 실행해도 안전합니다.
접근 높이·안전 높이·속도는 셀 치수에서 합리적으로 정하고, 답변에서 무엇을 가정했는지 짧게 밝힙니다.
코드는 에디터에 이미 저장되므로 답변에 전체 코드를 다시 붙이지 말고, 핵심 동작과 결과(컴파일·실행 결과, 사이클 타임)를 요약합니다.
실제 로봇에 옮길 때 확인할 점(툴·유저 좌표계, 티칭 위치 보정, 속도)이 있으면 한두 줄로 알립니다. 사용자의 언어로 답합니다.`;

const API_TOOLS = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, eager_input_streaming: true }));
const MAX_TURNS = 30;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// 응답 content 를 다음 요청에 되돌려 보낼 때: 마지막 fallback 블록 이전의 thinking/tool_use 등 모델 내부 블록은 제외
function echoContent(content) {
  const last = content.map((b) => b.type).lastIndexOf('fallback');
  if (last < 0) return content;
  return content.filter((b, i) => i > last || b.type === 'text');
}

export class ChatSession {
  // opts: { ctrl, config: { model, effort }, send(ev), client? }
  constructor({ ctrl, config = {}, send, client }) {
    this.ctrl = ctrl;
    this.model = config.model || 'claude-opus-5-5';
    this.effort = config.effort || 'high';
    this.useFallbacks = config.fallbacks !== false;
    this.send = send;
    this.client = client || new Anthropic();
    this.messages = [];
    this.busy = false;
    this.abort = null;
  }

  reset() { this.stop(); this.messages = []; }
  stop() { this.abort?.abort(); }

  async ask(text) {
    if (this.busy) { this.send({ ev: 'error', msg: '이전 요청을 처리 중입니다. 정지 후 다시 보내세요.' }); return; }
    this.busy = true;
    this.abort = new AbortController();
    const base = this.messages.length;
    this.messages.push({ role: 'user', content: String(text) });
    this.ctrl.log('system', `Claude 채팅: ${String(text).slice(0, 60)}`);
    try {
      await this._loop();
      this.send({ ev: 'done' });
    } catch (e) {
      // 실패한 턴은 대화에서 제거 (다음 질문이 깨진 기록 위에서 시작하지 않도록)
      this.messages.length = base;
      this.send({ ev: 'error', msg: describeError(e) });
    } finally {
      this.busy = false;
      this.abort = null;
    }
  }

  async _loop() {
    let jsonRetries = 0;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const params = {
        model: this.model,
        max_tokens: 64000,
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: this.effort },
        cache_control: { type: 'ephemeral' },
        system: SYSTEM,
        tools: API_TOOLS,
        messages: this.messages,
      };
      if (this.useFallbacks) Object.assign(params, { betas: [FALLBACK_BETA], fallbacks: 'default' });
      const stream = this.client.beta.messages.stream(params, { signal: this.abort.signal });
      for await (const ev of stream) {
        if (ev.type === 'content_block_start') {
          if (ev.content_block.type === 'tool_use') this.send({ ev: 'tool_start', name: ev.content_block.name });
          else if (ev.content_block.type === 'fallback') this.send({ ev: 'note', msg: `${ev.content_block.from?.model} → ${ev.content_block.to?.model} 로 전환` });
        } else if (ev.type === 'content_block_delta') {
          if (ev.delta.type === 'text_delta') this.send({ ev: 'text', delta: ev.delta.text });
          else if (ev.delta.type === 'thinking_delta') this.send({ ev: 'thinking', delta: ev.delta.thinking });
        }
      }
      let msg;
      try {
        msg = await stream.finalMessage();
        jsonRetries = 0;
      } catch (e) {
        // 도구 입력 JSON 을 해석하지 못한 경우만 재시도 (API 오류·중단은 그대로 전달)
        if (e instanceof Anthropic.APIError || e instanceof Anthropic.APIUserAbortError || this.abort.signal.aborted || jsonRetries++ >= 2) throw e;
        this.send({ ev: 'note', msg: '도구 입력을 해석하지 못해 다시 요청합니다' });
        continue;
      }
      if (msg.stop_reason === 'refusal') {
        this.messages.push({ role: 'assistant', content: echoContent(msg.content) });
        this.send({ ev: 'note', msg: '요청이 거절되었습니다.' });
        return;
      }
      const toolUses = msg.content.filter((b) => b.type === 'tool_use');
      if (msg.stop_reason === 'max_tokens' && toolUses.length) throw new Error('응답이 너무 길어 도구 입력이 잘렸습니다. 작업을 나눠서 요청해 주세요.');
      this.messages.push({ role: 'assistant', content: echoContent(msg.content) });
      if (msg.stop_reason === 'pause_turn') continue;
      if (!toolUses.length) return;

      const results = [];
      for (const tu of toolUses) {
        // 스트리밍된 도구 입력은 서버가 검증하지 않으므로 실행 전에 스키마 검증
        const tool = TOOLS.find((t) => t.name === tu.name);
        const bad = !tool ? `알 수 없는 도구: ${tu.name}` : validateInput(tool, tu.input);
        const r = bad ? { text: `INVALID_INPUT: ${bad}`, isError: true } : await callTool(this.ctrl, tu.name, tu.input);
        this.send({ ev: 'tool_end', name: tu.name, input: summarizeInput(tu.name, tu.input), ok: !r.isError, result: summarizeResult(tu.name, r) });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: r.text, ...(r.isError ? { is_error: true } : {}) });
      }
      this.messages.push({ role: 'user', content: results });
      if (this.abort.signal.aborted) throw new Anthropic.APIUserAbortError();
    }
    throw new Error(`도구 호출이 ${MAX_TURNS}회를 넘어 중단했습니다.`);
  }
}

function summarizeInput(name, input = {}) {
  if (name === 'write_program') return `${input.name} (${String(input.text ?? '').split('\n').length}줄)`;
  if (name === 'read_program') return input.name;
  if (name === 'run_program') return input.action;
  return '';
}

function summarizeResult(name, r) {
  if (r.isError) return r.text.slice(0, 300);
  try {
    const o = JSON.parse(r.text);
    if (name === 'write_program') return o.compileError ? `컴파일 오류 ${o.compileError.file ?? ''}:${o.compileError.line ?? ''} ${o.compileError.msg}` : '컴파일 OK';
    if (name === 'run_program') {
      const parts = [o.status?.toUpperCase()];
      if (o.lastCycle && o.status === 'done') parts.push(`사이클 ${o.lastCycle.total_s}s`);
      if (o.alarms?.length) parts.push(`알람 ${o.alarms.join(', ')}`);
      if (o.collision?.length) parts.push(`간섭 ${o.collision.join(', ')}`);
      return parts.filter(Boolean).join(' · ');
    }
    if (name === 'get_context') return `${o.robot.vendorName} ${o.robot.model} · ${o.language.name} · 공작물 ${o.objects.length}개`;
  } catch { /* 요약 실패 → 생략 */ }
  return '';
}

function describeError(e) {
  if (e instanceof Anthropic.APIUserAbortError || e?.name === 'AbortError') return '중단했습니다.';
  if (e instanceof Anthropic.AuthenticationError) return 'Claude API 인증에 실패했습니다. 서버를 실행하는 터미널에서 ANTHROPIC_API_KEY 환경변수를 설정하거나 `ant auth login` 후 서버를 다시 시작하세요.';
  if (e instanceof Anthropic.PermissionDeniedError) return `API 권한이 없습니다: ${e.message}`;
  if (e instanceof Anthropic.NotFoundError) return `모델 또는 리소스를 찾을 수 없습니다 (config.json 의 ai.model 확인): ${e.message}`;
  if (e instanceof Anthropic.RateLimitError) return '요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.';
  if (e instanceof Anthropic.BadRequestError) return `잘못된 요청: ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return `Claude API 에 연결할 수 없습니다 (네트워크 확인): ${e.message}`;
  if (e instanceof Anthropic.APIError) return `API 오류 ${e.status ?? ''}: ${e.message}`;
  // 자격 증명을 찾지 못한 경우 등 요청 전에 SDK 가 낸 오류
  if (e instanceof Anthropic.AnthropicError) return `${e.message}
→ 서버를 실행하는 터미널에서 ANTHROPIC_API_KEY 환경변수를 설정하거나 \`ant auth login\` 후 서버를 다시 시작하세요.`;
  return e?.message ?? String(e);
}
