// Claude 채팅 패널 (오른쪽 끝 열). 서버 server/ai/chat.js 와 WebSocket 으로 통신
//   보냄: {cmd:'chat', text} / {cmd:'chatStop'} / {cmd:'chatReset'}
//   받음: {type:'chat', ev:'text'|'thinking'|'tool_start'|'tool_end'|'note'|'done'|'error', ...}
const $ = (s, el = document) => el.querySelector(s);

const EXAMPLES = [
  '테이블 위 공작물 4개를 순서대로 집어서 오른쪽으로 200mm 옮겨 놓는 프로그램을 만들어 줘',
  '현재 프로그램을 설명하고 사이클 타임을 줄일 방법을 제안해 줘',
  '프로그램을 실행해서 알람이나 간섭이 없는지 확인해 줘',
];
const TOOL_NAME = { get_context: '상태 조회', get_language_guide: '문법·예제 확인', read_program: '파일 읽기', write_program: '저장·컴파일', run_program: '실행', get_logs: '로그 조회' };

let wsSend = null;
let root, log, input, busy = false, cur = null, hadMessages = false;

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 간단한 마크다운: ``` 코드 블록, `인라인 코드`, **굵게**, 제목(#), 목록, 줄바꿈
function md(text) {
  const parts = text.split(/```[\w-]*\n?/);
  return parts.map((p, i) => {
    if (i % 2) return `<pre>${esc(p.replace(/\n$/, ''))}</pre>`;
    return esc(p)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/^#{1,4} (.+)$/gm, '<b class="h">$1</b>')
      .replace(/^[-*] (.+)$/gm, '• $1')
      .replace(/\n/g, '<br>');
  }).join('');
}

export function initChatPanel({ send }) {
  wsSend = send;
  root = $('#chat');
  root.innerHTML = `
    <div class="chat-head"><b>Claude</b><span class="sub">로봇 프로그래밍 도우미</span>
      <button id="chatNew" title="새 대화">새 대화</button><button id="chatClose" title="닫기">✕</button></div>
    <div id="chatLog" class="chat-log"></div>
    <form id="chatForm" class="chat-form">
      <textarea id="chatInput" rows="3" placeholder="예: 공작물을 팔레트에 2×2로 적재하는 프로그램을 만들어 줘  (Enter 전송, Shift+Enter 줄바꿈)"></textarea>
      <div class="chat-btns"><span class="hint">현재 로봇·셀 기준으로 코드를 만들고 에디터에 저장합니다</span><button type="button" id="chatStop" class="danger" hidden>■ 정지</button><button type="submit" id="chatSend" class="primary">보내기</button></div>
    </form>`;
  log = $('#chatLog');
  input = $('#chatInput');
  showWelcome();
  $('#chatForm').onsubmit = (e) => { e.preventDefault(); submit(); };
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } };
  $('#chatStop').onclick = () => wsSend({ cmd: 'chatStop' });
  $('#chatNew').onclick = () => { wsSend({ cmd: 'chatReset' }); log.innerHTML = ''; hadMessages = false; setBusy(false); showWelcome(); };
  $('#chatClose').onclick = () => toggleChat(false);
  $('#btnChat').onclick = () => toggleChat();
  try { if (localStorage.getItem('chatOpen') === '1') toggleChat(true); } catch { /* 저장소 사용 불가 */ }
}

function toggleChat(on) {
  const main = document.querySelector('main');
  on = on ?? !main.classList.contains('chat-open');
  main.classList.toggle('chat-open', on);
  $('#btnChat').classList.toggle('active', on);
  try { localStorage.setItem('chatOpen', on ? '1' : '0'); } catch { /* 무시 */ }
  if (on) setTimeout(() => input.focus(), 50);
}

function showWelcome() {
  const w = document.createElement('div');
  w.className = 'chat-welcome';
  w.innerHTML = `<p>현재 선택된 로봇·그리퍼·셀 배치를 읽어 해당 제조사 언어로 프로그램을 만들고, 컴파일·가상 실행까지 확인합니다.</p>
    ${EXAMPLES.map((t) => `<button class="ex">${esc(t)}</button>`).join('')}`;
  w.querySelectorAll('.ex').forEach((b) => (b.onclick = () => { input.value = b.textContent; submit(); }));
  log.append(w);
}

function submit() {
  const text = input.value.trim();
  if (!text || busy) return;
  log.querySelector('.chat-welcome')?.remove();
  addMsg('user').innerHTML = md(text);
  input.value = '';
  hadMessages = true;
  setBusy(true);
  wsSend({ cmd: 'chat', text });
}

function setBusy(b) {
  busy = b;
  $('#chatSend').disabled = b;
  $('#chatStop').hidden = !b;
  root.classList.toggle('busy', b);
  if (!b) cur = null;
}

function addMsg(cls) {
  const d = document.createElement('div');
  d.className = `chat-msg ${cls}`;
  log.append(d);
  scroll();
  return d;
}
function scroll() { log.scrollTop = log.scrollHeight; }

// 현재 응답 블록 (텍스트·생각·도구 칩이 순서대로 쌓임)
function reply() {
  if (!cur) cur = { el: addMsg('bot'), text: null, think: null };
  return cur;
}

export function onChatEvent(m) {
  const r = () => reply();
  switch (m.ev) {
    case 'text': {
      const c = r();
      if (!c.text) { c.text = { el: document.createElement('div'), raw: '' }; c.text.el.className = 'txt'; c.el.append(c.text.el); c.think = null; }
      c.text.raw += m.delta;
      c.text.el.innerHTML = md(c.text.raw);
      break;
    }
    case 'thinking': {
      const c = r();
      if (!c.think) {
        const d = document.createElement('details');
        d.className = 'think';
        d.innerHTML = '<summary>생각 중…</summary><div></div>';
        c.el.append(d);
        c.think = { el: d, raw: '' };
        c.text = null;
      }
      c.think.raw += m.delta;
      c.think.el.querySelector('div').textContent = c.think.raw;
      break;
    }
    case 'tool_start': {
      const c = r();
      const chip = document.createElement('div');
      chip.className = 'tool run';
      chip.dataset.name = m.name;
      chip.textContent = `⚙ ${TOOL_NAME[m.name] ?? m.name}…`;
      c.el.append(chip);
      c.text = null; c.think = null;
      break;
    }
    case 'tool_end': {
      const c = r();
      const chip = [...c.el.querySelectorAll('.tool.run')].find((x) => x.dataset.name === m.name) || c.el.appendChild(document.createElement('div'));
      chip.className = `tool ${m.ok ? 'ok' : 'err'}`;
      chip.textContent = `${m.ok ? '✔' : '✖'} ${TOOL_NAME[m.name] ?? m.name}${m.input ? ` · ${m.input}` : ''}${m.result ? ` — ${m.result}` : ''}`;
      break;
    }
    case 'note': {
      const d = document.createElement('div');
      d.className = 'note';
      d.textContent = m.msg;
      r().el.append(d);
      break;
    }
    case 'error': {
      const d = addMsg('err');
      d.textContent = m.msg;
      setBusy(false);
      break;
    }
    case 'done':
      cur?.el.querySelectorAll('details.think summary').forEach((s) => (s.textContent = '생각 과정'));
      setBusy(false);
      break;
  }
  scroll();
}

// 서버와 다시 연결되면 서버 쪽 대화 기록은 새로 시작됨
export function onChatReconnect() {
  if (busy) setBusy(false);
  if (hadMessages) { addMsg('err').textContent = '서버와 다시 연결되었습니다. 이전 대화 내용은 Claude 가 기억하지 않으므로 필요한 내용을 다시 알려 주세요.'; hadMessages = false; }
}
