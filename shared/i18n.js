// 한국어 원문 → 다른 언어 번역 엔진 (브라우저 화면 · 서버 예제 프로그램 공용)
//  화면 코드는 한국어 문구를 그대로 쓰고, 표시할 때 사전으로 바꾼다 (public/js/i18n.js 가 DOM 을 감시하며 적용).
//  사전 형식: { exact: { '원문': '번역' }, patterns: [['원문 {0}…', '번역 {0}…']], fragments?: { '부분 원문': '부분 번역' } }
//   - exact: 공백을 한 칸으로 줄이고 앞뒤를 자른 전체 문구가 같을 때
//   - patterns: {0} {1} … 자리에 아무 문자열이나 오는 문구 (템플릿 문자열 결과)
//   - 여러 줄이면 줄마다 다시 시도, 그래도 안 되면 fragments(+exact) 의 부분 문자열을 긴 것부터 치환
const HANGUL = /[가-힣]/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function makeTranslator(dict) {
  const exact = new Map(Object.entries(dict.exact || {}).map(([k, v]) => [norm(k), v]));
  const patterns = (dict.patterns || []).map(([ko, en]) => {
    const keys = [];
    const src = norm(ko).split(/(\{\d+\})/).map((p) => {
      const m = /^\{(\d+)\}$/.exec(p);
      if (m) { keys.push(Number(m[1])); return '(.*?)'; }
      return esc(p);
    }).join('');
    return { re: new RegExp(`^${src}$`, 's'), keys, en, ml: ko.includes('\n'), lit: norm(ko).replace(/\{\d+\}/g, '').length };
  }).sort((a, b) => b.lit - a.lit);   // 고정 글자가 많은(구체적인) 패턴부터 — '{0} (확인: {1})' 이 '최신 버전입니다 (확인: {0})' 를 가로채지 않게
  // 부분 치환: 한국어 낱말 경계에서만 (앞뒤가 한글이 아닐 때) — '프로그래밍' 안의 '로그' 같은 오치환 방지
  const frags = Object.entries({ ...(dict.exact || {}), ...(dict.fragments || {}) })
    .filter(([k]) => norm(k).length >= 2 && HANGUL.test(k))
    .map(([k, v]) => [norm(k), v])
    .sort((a, b) => b[0].length - a[0].length)
    .map(([k, v]) => [k, new RegExp(`(?<![가-힣])${esc(k)}(?![가-힣])`, 'g'), v]);
  const cache = new Map();

  // multi: 여러 줄 원문 전체에 맞출 때는 여러 줄로 정의된 패턴만 (한 줄 패턴이 줄바꿈을 삼키지 않게)
  function whole(s, multi = false) {
    const n = norm(s);
    if (exact.has(n)) return exact.get(n);
    for (const p of patterns) {
      if (multi && !p.ml) continue;
      const m = p.re.exec(n);
      if (!m) continue;
      const vals = {};
      p.keys.forEach((k, i) => { vals[k] = m[i + 1]; });
      // 자리값 안의 한국어도 사전에 있어야 함 (예: '거부: {0}' 의 {0} = '시작'). 없으면 이 패턴은 맞지 않는 것으로 봄
      //  — '프로그램 {0}' 이 '프로그램 번호 비트8' 을 가로채 반쪽 번역이 되지 않게
      let ok = true;
      for (const k of Object.keys(vals)) if (HANGUL.test(vals[k])) { const w = whole(vals[k]); if (w == null) { ok = false; break; } vals[k] = w; }
      if (!ok) continue;
      return p.en.replace(/\{(\d+)\}/g, (_, k) => vals[k] ?? '');
    }
    return null;
  }
  function fragment(s) {
    let out = s;
    for (const [k, re, v] of frags) if (out.includes(k)) out = out.replace(re, () => v);
    return out;
  }

  // 번역 결과 (바꿀 것이 없으면 원문 그대로)
  return function translate(s) {
    if (typeof s !== 'string' || !HANGUL.test(s)) return s;
    if (cache.has(s)) return cache.get(s);
    let r;
    // 여러 줄(오버레이·대화상자 문구): 전체가 사전에 있으면 그대로, 아니면 줄마다 (줄바꿈 유지)
    if (s.includes('\n')) {
      r = whole(s, true) ?? s.split('\n').map((l) => (HANGUL.test(l) ? keepEdges(l, whole(l) ?? fragment(l)) : l)).join('\n');
    } else {
      r = whole(s);
      r = r == null ? fragment(s) : keepEdges(s, r);
    }
    if (cache.size > 5000) cache.clear();
    cache.set(s, r);
    return r;
  };
}

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
// 원문 앞뒤 공백 유지 (인라인 요소 사이 간격)
function keepEdges(src, out) {
  const lead = /^\s*/.exec(src)[0], trail = /\s*$/.exec(src)[0];
  return (lead ? ' ' : '') + String(out).trim() + (trail ? ' ' : '');
}
