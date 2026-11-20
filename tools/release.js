// 릴리스 만들기: package.json 의 version 으로 태그(vX.Y.Z)와 GitHub Release 를 만든다
//   npm run release            → 확인만 하고 할 일을 보여 줌 (드라이런)
//   npm run release -- --yes   → 실제로 태그 푸시 + gh release create
//
// 절차 (버전 올리기는 PR 로):
//   1) 기능 브랜치에서 package.json version 을 올리고 CHANGELOG.md 에 '## [X.Y.Z] - 날짜' 절을 쓴다 → PR 머지
//   2) main 에서 git pull 후 npm run release -- --yes
// 조건: main 브랜치, 작업 트리 깨끗함, origin/main 과 같은 커밋, 같은 태그 없음, CHANGELOG 에 해당 버전 절 있음, gh 로그인
// 릴리스가 만들어지면 사용자 PC 의 에뮬레이터가 새 버전 알림을 띄운다 (server/updater.js)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { changelogSection } from '../server/updater.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const yes = process.argv.includes('--yes');
// stdio: 'inherit' 이면 execFileSync 가 null 을 돌려주므로 빈 문자열로
const sh = (cmd, args, opt = {}) => String(execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt }) ?? '').trim();
const fail = (msg) => { console.error(`✘ ${msg}`); process.exit(1); };

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`package.json version 형식 오류: ${version}`);

const notes = changelogSection(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), version);
if (!notes) fail(`CHANGELOG.md 에 '## [${version}]' 절이 없습니다`);

const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'main') fail(`main 브랜치에서 실행하세요 (현재 ${branch})`);
if (sh('git', ['status', '--porcelain', '--untracked-files=no'])) fail('커밋하지 않은 변경이 있습니다');
sh('git', ['fetch', '--tags', 'origin']);
if (sh('git', ['rev-parse', 'HEAD']) !== sh('git', ['rev-parse', 'origin/main'])) fail('origin/main 과 다릅니다 — git pull 또는 push 먼저');
if (sh('git', ['tag', '--list', tag])) fail(`태그 ${tag} 가 이미 있습니다 — package.json version 을 올리세요`);

console.log(`릴리스 ${tag} (${sh('git', ['rev-parse', '--short', 'HEAD'])})\n---\n${notes}\n---`);
if (!yes) { console.log('\n드라이런입니다. 실제로 만들려면: npm run release -- --yes'); process.exit(0); }

const notesFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rel-')), 'notes.md');
fs.writeFileSync(notesFile, notes);
sh('git', ['tag', '-a', tag, '-m', `release ${tag}`]);
sh('git', ['push', 'origin', tag], { stdio: 'inherit' });
const url = sh(process.platform === 'win32' ? 'gh.exe' : 'gh', ['release', 'create', tag, '--title', tag, '--notes-file', notesFile, '--verify-tag']);
console.log(`✔ ${url}`);
