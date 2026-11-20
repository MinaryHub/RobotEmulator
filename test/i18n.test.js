// 화면 언어(English) 테스트: 번역 엔진, 화면 사전, 예제 프로그램·셀 프리셋 영어화
//   node test/i18n.test.js
import fs from 'node:fs';
import { makeTranslator } from '../shared/i18n.js';
import { EN } from '../public/js/i18n-en.js';
import { Controller } from '../server/controller.js';
import { ROBOTS } from '../shared/robots.js';
import { presetLayout, PRESETS } from '../server/cell.js';
import { localizeLayout } from '../server/lang/examples-en.js';

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log(`  ✔ ${msg}`); } else { fail++; console.log(`  ✘ ${msg}`); } };
const HANGUL = /[가-힣]/;
const tr = makeTranslator(EN);

console.log('■ 번역 엔진');
ok(tr('  서보 ON  ') === ' Servo ON ', '정확히 일치 + 앞뒤 공백 유지');
ok(tr('거부: 시작 (펜던트)') === 'Rejected: Start (pendant)', '패턴 + 자리값 번역');
ok(tr('최신 버전입니다 (확인: x)') === 'You are up to date (checked: x)', '구체적인 패턴 우선');
ok(tr('프로그램 main.src\n상태 IDLE\n사이클 0  OV 100%') === 'Program main.src\nState IDLE\nCycle 0 OV 100%', '여러 줄은 줄마다 (줄바꿈 유지)');
ok(tr('프로그램 번호 비트8: DI416') === 'Program number bit 8: DI416', '자리값을 번역할 수 없으면 그 패턴은 건너뜀');
ok(tr('로봇 프로그래밍 도우미') === 'Robot programming assistant' && !/Log/.test(tr('프로그래밍 예시')), '부분 치환은 낱말 경계에서만');
ok(tr('J1 0.000°') === 'J1 0.000°', '한국어가 없으면 그대로');

console.log('■ 화면 사전');
const keys = Object.keys(EN.exact);
ok(keys.every((k) => typeof EN.exact[k] === 'string' && EN.exact[k].length), `exact ${keys.length}개 모두 번역문 있음`);
ok(EN.patterns.every(([ko, en]) => (ko.match(/\{\d+\}/g) || []).sort().join() === (en.match(/\{\d+\}/g) || []).sort().join()), `패턴 ${EN.patterns.length}개 자리값 일치`);
// index.html 의 고정 문구·툴팁은 모두 사전에 있어야 함 (새 화면 문구 추가 시 사전 누락 방지)
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '');
const texts = [...html.matchAll(/>([^<>]+)</g), ...html.matchAll(/\s(?:title|placeholder|aria-label)="([^"]*)"/g)].map((m) => m[1].replace(/\s+/g, ' ').trim()).filter((s) => HANGUL.test(s) && s !== '한국어');
const missing = texts.filter((s) => HANGUL.test(tr(s)));
ok(!missing.length, `index.html 문구 ${texts.length}개 번역됨${missing.length ? ` — 누락: ${JSON.stringify(missing.slice(0, 5))}` : ''}`);

console.log('■ 예제 프로그램 (English)');
const c = new Controller(); clearInterval(c._timer);
c.uiLang = 'en';
const left = new Set(); let bad = 0;
for (const r of ROBOTS) {
  c.setRobot(r.id); c.loadExample();
  if (c.compileError) bad++;
  for (const t of c.files.values()) for (const l of t.split('\n')) if (HANGUL.test(l)) left.add(`${r.vendor}: ${l.trim()}`);
}
ok(!left.size, `${ROBOTS.length}개 모델 예제에 한국어 없음${left.size ? ` — ${JSON.stringify([...left].slice(0, 3))}` : ''}`);
ok(!bad, '영어 예제도 모두 컴파일');

console.log('■ 셀 프리셋 이름 (English)');
const leftNames = [];
for (const p of PRESETS) {
  const L = localizeLayout(presetLayout(p.id, ROBOTS[0]), 'en');
  for (const v of [L.name, ...Object.values(L).filter(Array.isArray).flat().map((x) => x?.name)]) if (v && HANGUL.test(v)) leftNames.push(v);
}
ok(!leftNames.length, `프리셋 ${PRESETS.length}개 장치 이름 영어${leftNames.length ? ` — ${JSON.stringify(leftNames)}` : ''}`);

console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
