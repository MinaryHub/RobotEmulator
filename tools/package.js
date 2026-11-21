// 배포 꾸러미 만들기 (Node.js 설치 없이 실행되는 휴대용 꾸러미 + Android APK 의 앱 자산)
//
//   node tools/package.js desktop [대상...]   → dist/RobotEmulator-<버전>-<대상>.zip|tar.gz
//       대상: win-x64 linux-x64 linux-arm64 darwin-arm64 darwin-x64 (생략 시 전부)
//   node tools/package.js upload                → dist 의 이번 버전 꾸러미 + SHA256SUMS.txt 를 GitHub 릴리스 v<버전> 에 올림
//   node tools/package.js android               → dist/RobotEmulator-<버전>-android.apk
//       앱 자산(zip) + nodejs-mobile libnode.so 준비 → android/gradlew assembleRelease
//       필요: JDK 17+ (JAVA_HOME), Android SDK·NDK 28 (ANDROID_HOME 또는 ~/Library/Android/sdk), android/keystore.properties(정식 서명)
//
// 꾸러미 구성 (데스크톱):
//   RobotEmulator-<버전>-<대상>/
//     Start RobotEmulator.cmd | Start RobotEmulator.command | start-robot-emulator.sh   ← 더블클릭/실행
//     runtime/node(.exe)          ← 공식 Node.js 실행 파일 (SHASUMS256 검증)
//     app/                        ← 저장소의 앱 파일 + 운영용 node_modules (npm ci --omit=dev, 불필요한 파일 정리)
//     README.txt
// 앱 의존성은 모두 순수 JavaScript/WASM 이라 한 PC 에서 모든 OS 용 꾸러미를 만들 수 있다.
// Node 버전: NODE_VERSION 환경변수 (기본: nodejs.org 의 최신 v22 LTS)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(DIST, '.cache');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const log = (...a) => console.log('•', ...a);

// 저장소 파일 중 꾸러미에 넣지 않을 것
const EXCLUDE = [/^test\//, /^\.github\//, /^screenshots\//, /^brand\//, /^android\//, /^tools\/package\.js$/, /^tools\/release\.js$/, /^\.gitignore$/];
// node_modules 정리: 실행에 필요 없는 파일
const PRUNE_FILE = /(\.map|\.d\.ts|\.d\.mts|\.d\.cts|\.tsbuildinfo|(?<!\.d)\.ts|\.md|\.markdown)$/i;
const KEEP_FILE = /^(license|licence|notice|copying)/i;

const TARGETS = {
  'win-x64': { dist: 'win-x64', ext: 'zip', exe: 'node.exe', inner: 'node.exe' },
  'linux-x64': { dist: 'linux-x64', ext: 'tar.xz', exe: 'node', inner: 'bin/node' },
  'linux-arm64': { dist: 'linux-arm64', ext: 'tar.xz', exe: 'node', inner: 'bin/node' },
  'darwin-arm64': { dist: 'darwin-arm64', ext: 'tar.gz', exe: 'node', inner: 'bin/node' },
  'darwin-x64': { dist: 'darwin-x64', ext: 'tar.gz', exe: 'node', inner: 'bin/node' },
};

async function latestNode22() {
  if (process.env.NODE_VERSION) return process.env.NODE_VERSION.replace(/^v?/, 'v');
  const idx = await (await fetch('https://nodejs.org/dist/index.json')).json();
  const v = idx.find((r) => r.version.startsWith('v22.') && r.lts);
  if (!v) throw new Error('Node 22 LTS 를 찾을 수 없습니다');
  return v.version;
}

async function download(url, file) {
  if (fs.existsSync(file)) return file;
  log('내려받기', url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.part', Buffer.from(await r.arrayBuffer()));
  fs.renameSync(file + '.part', file);
  return file;
}
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// 공식 Node 실행 파일 하나를 꺼내 dest 에 둔다 (SHASUMS256 로 검증)
async function fetchNode(version, t, dest) {
  const name = `node-${version}-${t.dist}`;
  const archive = path.join(CACHE, `${name}.${t.ext}`);
  await download(`https://nodejs.org/dist/${version}/${name}.${t.ext}`, archive);
  const sums = await (await fetch(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).text();
  const want = sums.split('\n').find((l) => l.endsWith(`  ${name}.${t.ext}`))?.split(/\s+/)[0];
  if (!want || want !== sha256(archive)) { fs.rmSync(archive, { force: true }); throw new Error(`${name}: SHA256 불일치`); }
  const tmp = fs.mkdtempSync(path.join(CACHE, 'x-'));
  try {
    if (t.ext === 'zip') run('unzip', ['-q', archive, `${name}/${t.inner}`, '-d', tmp]);
    else run('tar', ['-xf', archive, '-C', tmp, `${name}/${t.inner}`]);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(tmp, name, t.inner), dest);
    fs.chmodSync(dest, 0o755);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// 앱 파일 + 운영용 의존성을 dir 에 복사 (한 번 만들고 대상마다 재사용)
function stageApp(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
    .filter((f) => !EXCLUDE.some((re) => re.test(f)) && fs.existsSync(path.join(ROOT, f)));
  for (const f of files) {
    const d = path.join(dir, f);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), d);
  }
  log(`앱 파일 ${files.length}개, 의존성 설치 (npm ci --omit=dev)`);
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, shell: process.platform === 'win32' });
  let pruned = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (PRUNE_FILE.test(e.name) && !KEEP_FILE.test(e.name)) { fs.rmSync(p); pruned++; }
    }
  };
  walk(path.join(dir, 'node_modules'));
  // three: 브라우저가 쓰는 build/ 와 examples/jsm/ 만 (public/index.html importmap)
  for (const sub of ['src', 'examples/fonts', 'examples/models', 'examples/textures']) fs.rmSync(path.join(dir, 'node_modules/three', sub), { recursive: true, force: true });
  log(`불필요한 파일 ${pruned}개 정리`);
  return dir;
}

const README_TXT = (v, target) => `Industrial Robot Emulator v${v} (${target})
https://github.com/MinaryHub/RobotEmulator

Start / 실행
  Windows : double-click "Start RobotEmulator.cmd"
  macOS   : double-click "Start RobotEmulator.command"
            (first time: right-click → Open, because the script is not signed)
  Linux   : ./start-robot-emulator.sh
The browser opens http://localhost:3000 automatically. Close the console window (or Ctrl+C) to stop.
Node.js is included in runtime/ — no installation needed.

Your projects are saved in app/projects/. Keep that folder when you move to a new version.
Other PCs and PLCs: set "host": "0.0.0.0" in app/config.json (see README.md).
`;

const LAUNCHERS = {
  win: ['Start RobotEmulator.cmd', '@echo off\r\ncd /d "%~dp0app"\r\nset ROBOT_EMU_OPEN=1\r\n"%~dp0runtime\\node.exe" server\\launcher.js\r\nif errorlevel 1 pause\r\n'],
  darwin: ['Start RobotEmulator.command', '#!/bin/bash\ncd "$(dirname "$0")/app" || exit 1\nexport ROBOT_EMU_OPEN=1\nexec ../runtime/node server/launcher.js\n'],
  linux: ['start-robot-emulator.sh', '#!/bin/sh\ncd "$(dirname "$0")/app" || exit 1\nexport ROBOT_EMU_OPEN=1\nexec ../runtime/node server/launcher.js\n'],
};

async function desktop(targets) {
  const version = await latestNode22();
  log(`Node ${version}, 앱 v${pkg.version}, 대상: ${targets.join(', ')}`);
  const app = stageApp(path.join(DIST, 'stage-app'));
  for (const target of targets) {
    const t = TARGETS[target];
    if (!t) throw new Error(`알 수 없는 대상: ${target} (${Object.keys(TARGETS).join(', ')})`);
    const name = `RobotEmulator-${pkg.version}-${target}`;
    const dir = path.join(DIST, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    log(`${name}: 앱 복사`);
    fs.cpSync(app, path.join(dir, 'app'), { recursive: true });
    await fetchNode(version, t, path.join(dir, 'runtime', t.exe));
    const os = target.split('-')[0];
    const [lname, body] = LAUNCHERS[os];
    fs.writeFileSync(path.join(dir, lname), body, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'README.txt'), README_TXT(pkg.version, target).replace(/\n/g, os === 'win' ? '\r\n' : '\n'));
    const out = path.join(DIST, `${name}.${os === 'win' ? 'zip' : 'tar.gz'}`);
    fs.rmSync(out, { force: true });
    if (os === 'win') run('zip', ['-qry', out, name], { cwd: DIST });
    else run('tar', ['-czf', out, name], { cwd: DIST, env: { ...process.env, COPYFILE_DISABLE: '1' } });
    fs.rmSync(dir, { recursive: true, force: true });   // 디스크 절약: 압축 후 폴더 삭제
    log(`✔ ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
  }
  fs.rmSync(app, { recursive: true, force: true });
}

const NODEJS_MOBILE = 'v18.20.4';   // Android 용 Node (nodejs-mobile). OPC UA(node-opcua)는 Node 18 에서 불러오지 못해 비활성
const ANDROID_ABIS = ['arm64-v8a', 'armeabi-v7a'];

async function android() {
  const A = path.join(ROOT, 'android');
  // 1) 앱 자산: assets/nodejs-project.zip + bundle-version.txt (MainActivity 가 버전이 바뀌면 다시 풂)
  const assets = path.join(A, 'app/src/main/assets');
  fs.mkdirSync(assets, { recursive: true });
  const stage = stageApp(path.join(DIST, 'stage-android'));
  const zip = path.join(assets, 'nodejs-project.zip');
  fs.rmSync(zip, { force: true });
  run('zip', ['-qr9', zip, '.'], { cwd: stage });
  fs.rmSync(stage, { recursive: true, force: true });
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(assets, 'bundle-version.txt'), `${pkg.version}+${commit}+${Date.now()}`);
  log(`앱 자산 ${(fs.statSync(zip).size / 1048576).toFixed(1)} MB`);
  // 2) libnode.so + 헤더 (android/libnode)
  const lib = path.join(A, 'libnode');
  if (!ANDROID_ABIS.every((abi) => fs.existsSync(path.join(lib, 'bin', abi, 'libnode.so')))) {
    const zipName = `nodejs-mobile-${NODEJS_MOBILE}-android.zip`;
    const z = await download(`https://github.com/nodejs-mobile/nodejs-mobile/releases/download/${NODEJS_MOBILE}/${zipName}`, path.join(CACHE, zipName));
    fs.rmSync(lib, { recursive: true, force: true });
    run('unzip', ['-q', z, 'include/*', ...ANDROID_ABIS.map((abi) => `bin/${abi}/*`), '-d', lib]);
  }
  // 3) Gradle 빌드
  const env = { ...process.env };
  if (!env.ANDROID_HOME) { const d = path.join(process.env.HOME || '', 'Library/Android/sdk'); if (fs.existsSync(d)) env.ANDROID_HOME = d; }
  if (!env.JAVA_HOME) { const j = '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home'; if (fs.existsSync(j)) env.JAVA_HOME = j; }
  if (!fs.existsSync(path.join(A, 'keystore.properties'))) log('⚠ android/keystore.properties 없음 — 디버그 키로 서명합니다');
  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  run(gradlew, ['--no-daemon', '-q', 'assembleRelease'], { cwd: A, env, shell: process.platform === 'win32' });
  const apk = path.join(A, 'app/build/outputs/apk/release/app-release.apk');
  const out = path.join(DIST, `RobotEmulator-${pkg.version}-android.apk`);
  fs.mkdirSync(DIST, { recursive: true });
  fs.copyFileSync(apk, out);
  log(`✔ ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
}

// 릴리스 자산 올리기 (릴리스는 npm run release 로 먼저 만들어 둔다)
function upload() {
  const files = fs.readdirSync(DIST).filter((f) => f.startsWith(`RobotEmulator-${pkg.version}-`) && /\.(zip|tar\.gz|apk)$/.test(f)).sort();
  if (!files.length) throw new Error(`dist 에 v${pkg.version} 꾸러미가 없습니다`);
  const sums = path.join(DIST, `SHA256SUMS-${pkg.version}.txt`);
  fs.writeFileSync(sums, files.map((f) => `${sha256(path.join(DIST, f))}  ${f}`).join('\n') + '\n');
  log(`v${pkg.version} 에 ${files.length + 1}개 올림`);
  run('gh', ['release', 'upload', `v${pkg.version}`, ...files.map((f) => path.join(DIST, f)), sums, '--clobber']);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'desktop') await desktop(rest.length ? rest : Object.keys(TARGETS));
else if (cmd === 'android') await android();
else if (cmd === 'upload') upload();
else { console.log('사용법: node tools/package.js desktop [win-x64 linux-x64 linux-arm64 darwin-arm64 darwin-x64] | android'); process.exit(1); }
