// 화면 언어 (한국어 / English)
//  화면 코드는 한국어 문구로 작성되어 있고, English 일 때 DOM 의 글자·툴팁을 사전(i18n-en.js)으로 바꾼다.
//  MutationObserver 로 새로 그려지는 내용도 계속 바꾸므로 각 화면 코드를 고칠 필요가 없다.
//  언어 결정: ?lang=en|ko → 저장된 선택 → 브라우저 언어 (ko 가 아니면 English)
//  번역하지 않는 곳: 프로그램 편집기, 로그(서버 메시지), 알람 표시, Claude 대화 본문 — 데이터이므로 원문 유지
import { makeTranslator } from '/shared/i18n.js';
import { EN } from './i18n-en.js';

const KEY = 'uiLang';
function detect() {
  const q = new URLSearchParams(location.search).get('lang');
  if (q === 'en' || q === 'ko') { try { localStorage.setItem(KEY, q); } catch {} return q; }
  try { const s = localStorage.getItem(KEY); if (s === 'en' || s === 'ko') return s; } catch {}
  return /^ko\b/i.test(navigator.language || '') ? 'ko' : 'en';
}

export const lang = detect();
const tr = lang === 'en' ? makeTranslator(EN) : (s) => s;
// 코드에서 직접 쓰는 문구 (alert·confirm·prompt·캔버스 글자)
export const t = (s) => tr(s);

export function setLang(l) {
  try { localStorage.setItem(KEY, l); } catch {}
  const u = new URL(location.href);
  u.searchParams.delete('lang');
  location.replace(u.toString());
}

const SKIP = '#editor, #log, #ovAlarm, .chat-msg.user, .chat-msg .txt, .chat-msg .think > div, script, style, [data-no-i18n]';
const ATTRS = ['title', 'placeholder', 'aria-label'];
const skip = (el) => !el || el.closest?.(SKIP);

function textNode(n) {
  if (skip(n.parentElement)) return;
  const v = n.data;
  const r = tr(v);
  if (r !== v) n.data = r;
}
function attrs(el) {
  if (skip(el)) return;
  for (const a of ATTRS) {
    const v = el.getAttribute?.(a);
    if (v) { const r = tr(v); if (r !== v) el.setAttribute(a, r); }
  }
}
function walk(root) {
  if (root.nodeType === 3) { textNode(root); return; }
  if (root.nodeType !== 1 || skip(root)) return;
  attrs(root);
  const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === 1 && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = it.nextNode(); n; n = it.nextNode()) n.nodeType === 3 ? textNode(n) : attrs(n);
}

if (lang === 'en') {
  document.documentElement.lang = 'en';
  walk(document.body);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') textNode(m.target);
      else if (m.type === 'attributes') attrs(m.target);
      else for (const n of m.addedNodes) walk(n);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  // 대화상자(alert/confirm/prompt) 문구
  const { alert: A, confirm: C, prompt: P } = window;
  window.alert = (m) => A.call(window, tr(String(m)));
  window.confirm = (m) => C.call(window, tr(String(m)));
  window.prompt = (m, d) => P.call(window, tr(String(m)), d);
}
