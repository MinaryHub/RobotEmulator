// 버전·업데이트 테스트: 버전 비교, CHANGELOG 절 추출, 릴리스 확인(가짜 GitHub 응답),
// 임시 git 저장소에서 원클릭 업데이트 적용·거부·되돌리기
//   node test/updater.test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Updater, compareVersions, changelogSection } from '../server/updater.js';

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log(`  ✔ ${msg}`); } else { fail++; console.log(`  ✘ ${msg}`); } };
async function section(title, fn) {
  console.log(`\n■ ${title}`);
  try { await fn(); } catch (e) { fail++; console.log(`  ✘ 예외: ${e.stack || e.message}`); }
}

await section('버전 비교 · CHANGELOG', async () => {
  ok(compareVersions('1.10.0', '1.9.9') > 0 && compareVersions('v1.2.0', '1.2.0') === 0 && compareVersions('1.0.0', '1.0.1') < 0, '숫자 단위 비교 (1.10 > 1.9)');
  const text = '# 변경 기록\n\n## [1.2.0] - 2026-12-01\n### 추가\n- A\n\n## [1.1.0] - 2026-11-21\n- B\n';
  ok(changelogSection(text, '1.2.0') === '### 추가\n- A' && changelogSection(text, '1.1.0') === '- B' && changelogSection(text, '9.9.9') === null, '해당 버전 절만 추출');
  const real = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  ok(!!changelogSection(real, pkg.version), `CHANGELOG.md 에 현재 버전(${pkg.version}) 절이 있음`);
});

// 가짜 GitHub releases/latest
const realFetch = globalThis.fetch;
let release = null;
globalThis.fetch = async (url, opts) => {
  if (!String(url).startsWith('https://api.github.com/repos/')) return realFetch(url, opts);
  if (opts?.headers?.['User-Agent'] !== 'robot-emulator-updater') throw new Error('User-Agent 누락');
  if (!release) return new Response('{}', { status: 404 });
  return new Response(JSON.stringify(release), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

// 임시 git 저장소: origin(bare) ← v1.0.0, v1.1.0 태그 / work = v1.0.0 에서 clone
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const origin = path.join(tmp, 'origin.git'), seed = path.join(tmp, 'seed'), work = path.join(tmp, 'work');
fs.mkdirSync(seed);
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(seed, 'init', '-q', '-b', 'main');
git(seed, 'config', 'user.email', 't@example.com'); git(seed, 'config', 'user.name', 't');
const writePkg = (dir, v) => fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: v, repository: { url: 'https://github.com/example/emu.git' } }, null, 2));
writePkg(seed, '1.0.0'); fs.writeFileSync(path.join(seed, 'a.txt'), 'one\n');
git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'v1'); git(seed, 'tag', 'v1.0.0');
git(seed, 'remote', 'add', 'origin', origin); git(seed, 'push', '-q', 'origin', 'main', '--tags');
git(tmp, 'clone', '-q', origin, work);
git(work, 'config', 'user.email', 't@example.com'); git(work, 'config', 'user.name', 't');
writePkg(seed, '1.1.0'); fs.writeFileSync(path.join(seed, 'a.txt'), 'two\n');
git(seed, 'commit', '-q', '-am', 'v1.1'); git(seed, 'tag', 'v1.1.0'); git(seed, 'push', '-q', 'origin', 'main', '--tags');

const logs = [];
let busy = null;
const mk = () => new Updater({ root: work, config: { intervalHours: 0 }, log: (s, m) => logs.push(m), isBusy: () => busy }).init();

await section('릴리스 확인', async () => {
  const u = await mk();
  ok(u.repo === 'example/emu' && u.info().links.issues === 'https://github.com/example/emu/issues', `저장소 주소 해석 (${u.repo})`);
  await u.check();
  ok(!u.state.available && !u.state.error && /릴리스가 없습니다/.test(u.state.note), '릴리스 없음(404) → 오류가 아닌 안내');
  release = { tag_name: 'v1.1.0', name: 'v1.1.0', html_url: 'https://github.com/example/emu/releases/tag/v1.1.0', body: '- 변경', published_at: '2026-11-21T00:00:00Z' };
  await u.check();
  ok(u.state.available && u.state.latest.version === '1.1.0' && u.state.latest.notes === '- 변경' && !u.state.error, '새 버전 발견');
  release.tag_name = 'v1.0.0';
  await u.check();
  ok(!u.state.available, '같은 버전 → 최신');
  release.tag_name = 'v1.1.0';
});

await section('업데이트 거부 사유', async () => {
  const u = await mk();
  await u.check();
  busy = '프로그램 실행 중';
  ok(await u.blocker() === '프로그램 실행 중', '프로그램 실행 중 거부');
  busy = null;
  fs.writeFileSync(path.join(work, 'a.txt'), 'local edit\n');
  ok(/커밋하지 않은/.test(await u.blocker()), '소스 변경이 있으면 거부');
  git(work, 'checkout', '-q', '--', 'a.txt');
  ok(await u.blocker() === null, '깨끗하면 허용');
});

await section('업데이트 적용 (fast-forward)', async () => {
  const u = await mk();
  await u.check();
  let restarted = null;
  u.on('restart', (t) => (restarted = t));
  await u.apply();
  const v = JSON.parse(fs.readFileSync(path.join(work, 'package.json'), 'utf8')).version;
  ok(restarted === 'v1.1.0' && v === '1.1.0' && fs.readFileSync(path.join(work, 'a.txt'), 'utf8') === 'two\n', `v1.1.0 적용 + 재시작 요청 (${v})`);
  ok(!logs.some((l) => /npm install/.test(l)), '의존성 변화 없으면 npm install 생략');
});

await section('적용 실패 → 되돌리기', async () => {
  // 로컬 커밋을 만들어 fast-forward 불가 상황
  git(work, 'reset', '-q', '--hard', 'v1.0.0');
  fs.writeFileSync(path.join(work, 'b.txt'), 'mine\n');
  git(work, 'add', 'b.txt'); git(work, 'commit', '-q', '-m', 'local');
  const head = git(work, 'rev-parse', 'HEAD');
  const u = await mk();
  await u.check();
  let err = null;
  await u.apply().catch((e) => (err = e));
  ok(err && /앞당길 수 없습니다/.test(err.message) && git(work, 'rev-parse', 'HEAD') === head, `fast-forward 불가 → 오류, HEAD 그대로 (${err?.message?.slice(0, 40)})`);
  ok(/업데이트 실패/.test(u.state.error) && !u.state.applying, '상태에 실패 사유 표시');
});

await section('압축 파일 설치', async () => {
  const zipDir = path.join(tmp, 'zip');
  fs.mkdirSync(zipDir); writePkg(zipDir, '1.0.0');
  const u = await new Updater({ root: zipDir, config: {}, log: () => {} }).init();
  await u.check();
  ok(u.state.available && /git clone/.test(await u.blocker()), '알림은 하되 적용은 git 설치만');
});

globalThis.fetch = realFetch;
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
