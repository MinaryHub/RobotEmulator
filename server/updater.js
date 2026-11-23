// 버전 정보 · 업데이트 확인 · 원클릭 업데이트
//  - 현재 버전: package.json version (+ git 커밋)
//  - 새 버전 확인: GitHub Releases 의 최신 릴리스 (시작 5초 후, 이후 config.update.intervalHours 마다)
//  - 업데이트 적용: git clone 으로 설치한 경우만. 작업 트리가 깨끗하고 프로그램이 실행 중이 아닐 때
//      git fetch --tags → 현재 브랜치를 릴리스 태그로 fast-forward → (의존성이 바뀌었으면) npm install → 재시작 요청
//    실패하면 원래 커밋으로 되돌린다 (git reset --keep — 커밋되지 않은 변경은 건드리지 않음)
//  - 재시작은 server/launcher.js(npm start)가 맡는다. 직접 `node server/index.js` 로 실행했다면 종료 후 다시 실행해야 함
//  GitHub 요청에는 사용자 정보를 넣지 않는다 (User-Agent 는 고정 문자열). 비공개 저장소는 GITHUB_TOKEN 환경변수 사용
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 300000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => {
    if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve(String(stdout).trim());
  });
});

// 'v1.2.3' / '1.2.3-beta' → [1,2,3]. 비교: a>b 면 양수
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// package.json repository.url → 'owner/name'
function repoSlug(pkg) {
  const u = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const m = /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/i.exec(u || '');
  return m ? m[1] : null;
}

export class Updater extends EventEmitter {
  // opts: { root, config: { enabled, repo, intervalHours, allowApply }, log(src,msg), isBusy() → 사유 문자열|null }
  constructor({ root, config = {}, log = () => {}, isBusy = () => null }) {
    super();
    this.root = root;
    this.pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    this.cfg = { enabled: true, intervalHours: 24, allowApply: true, ...config };
    this.repo = this.cfg.repo || repoSlug(this.pkg);
    this.log = log;
    this.isBusy = isBusy;
    this.git = fs.existsSync(path.join(root, '.git'));
    this.commit = null; this.branch = null;
    this.state = { checkedAt: null, latest: null, available: false, error: null, note: null, applying: null };
  }

  get version() { return this.pkg.version; }

  // 정보 창에 보여 줄 링크 (package.json 기준, config 로 덮어쓰기 가능)
  links() {
    const base = this.repo ? `https://github.com/${this.repo}` : null;
    const funding = typeof this.pkg.funding === 'string' ? this.pkg.funding : this.pkg.funding?.url;
    return {
      repo: base,
      releases: base && `${base}/releases`,
      issues: this.pkg.bugs?.url || (base && `${base}/issues`),
      sponsor: this.cfg.sponsorUrl ?? funding ?? null,
      changelog: base && `${base}/blob/main/CHANGELOG.md`,
    };
  }

  async init() {
    if (this.git) {
      try { this.commit = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: this.root }); } catch {}
      try { this.branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.root }); } catch {}
    }
    return this;
  }

  // 자동 확인 시작 (비활성 설정이면 수동 확인만)
  start() {
    if (!this.cfg.enabled || !this.repo) return;
    setTimeout(() => this.check().catch(() => {}), 5000).unref?.();
    const h = Number(this.cfg.intervalHours);
    if (h > 0) setInterval(() => this.check().catch(() => {}), h * 3600 * 1000).unref?.();
  }

  info() {
    return {
      name: '산업용 로봇 에뮬레이터', version: this.version, commit: this.commit, branch: this.branch,
      install: this.git ? 'git' : 'archive', node: process.version, platform: `${process.platform}-${process.arch}`,
      links: this.links(), update: { ...this.state, autoCheck: !!(this.cfg.enabled && this.repo) },
    };
  }

  _set(patch) { Object.assign(this.state, patch); this.emit('change', this.info()); }

  async check() {
    if (!this.repo) { this._set({ error: '저장소 주소(package.json repository)가 없습니다' }); return this.state; }
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'robot-emulator-updater', 'X-GitHub-Api-Version': '2022-11-28' };
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const r = await fetch(`https://api.github.com/repos/${this.repo}/releases/latest`, { headers, signal: AbortSignal.timeout(10000) });
      // 릴리스가 아직 없음(또는 비공개 저장소) — 오류가 아니라 안내
      if (r.status === 404) { this._set({ checkedAt: Date.now(), latest: null, available: false, error: null, note: `아직 공개된 릴리스가 없습니다${token ? '' : ' (비공개 저장소이면 GITHUB_TOKEN 환경변수 필요)'}` }); return this.state; }
      if (!r.ok) throw new Error(`GitHub 응답 ${r.status}`);
      const j = await r.json();
      const latest = {
        version: String(j.tag_name || '').replace(/^v/, ''), tag: j.tag_name, name: j.name || j.tag_name,
        url: j.html_url, notes: String(j.body || '').slice(0, 8000), publishedAt: j.published_at,
      };
      const available = compareVersions(latest.version, this.version) > 0;
      if (available && !this.state.available) this.log('system', `새 버전이 있습니다: v${latest.version} (현재 v${this.version})`);
      this._set({ checkedAt: Date.now(), latest, available, error: null, note: null });
    } catch (e) {
      this._set({ checkedAt: Date.now(), error: `업데이트 확인 실패: ${e.name === 'TimeoutError' ? '시간 초과' : e.message}` });
    }
    return this.state;
  }

  // 원클릭 업데이트를 지금 할 수 없는 이유 (없으면 null)
  async blocker() {
    if (!this.cfg.allowApply) return '설정에서 자동 업데이트 적용이 꺼져 있습니다 (config.update.allowApply)';
    if (!this.git) return 'git clone 으로 설치한 경우에만 자동 업데이트할 수 있습니다 — 릴리스 페이지에서 내려받으세요';
    if (!this.state.available || !this.state.latest?.tag) return '설치할 새 버전이 없습니다';
    if (this.state.applying) return '업데이트 진행 중입니다';
    const busy = this.isBusy();
    if (busy) return busy;
    if (!this.branch || this.branch === 'HEAD') return 'git 브랜치에 있지 않습니다 (detached HEAD)';
    try {
      const dirty = await run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: this.root });
      if (dirty) return '커밋하지 않은 소스 변경이 있습니다 — 직접 정리한 뒤 업데이트하세요';
    } catch (e) { return `git 상태 확인 실패: ${e.message}`; }
    return null;
  }

  // 적용 → 성공 시 'restart' 이벤트
  async apply() {
    if (this._applyLock || this.state.applying) throw new Error('업데이트 진행 중입니다');
    this._applyLock = true;
    try {
      const why = await this.blocker();
      if (why) throw new Error(why);
      const tag = String(this.state.latest.tag || '');
      if (!/^[0-9A-Za-z][0-9A-Za-z._/-]{0,127}$/.test(tag) || tag.includes('..')) {
        throw new Error(`잘못된 릴리스 태그 형식: ${tag.slice(0, 40)}`);
      }
      const step = (msg) => { this._set({ applying: msg }); this.log('system', `[업데이트] ${msg}`); };
      const before = await run('git', ['rev-parse', 'HEAD'], { cwd: this.root });
      try {
        step(`${tag} 내려받는 중 (git fetch)`);
        await run('git', ['fetch', '--tags', 'origin'], { cwd: this.root });
        step(`${tag} 적용 중 (fast-forward)`);
        try { await run('git', ['merge', '--ff-only', `refs/tags/${tag}`], { cwd: this.root }); }
        catch { throw new Error(`현재 브랜치(${this.branch})를 ${tag} 로 앞당길 수 없습니다 — 로컬 커밋이 있거나 다른 브랜치입니다`); }
        if (await depsChanged(this.root, before)) {
          step('의존성 설치 중 (npm install)');
          await npmInstall(this.root);
        }
        step(`v${this.version} → ${tag} 완료. 재시작합니다`);
        this.emit('restart', tag);
      } catch (e) {
        try { await run('git', ['reset', '--keep', before], { cwd: this.root }); } catch {}
        this._set({ applying: null, error: `업데이트 실패 (이전 버전 유지): ${e.message}` });
        this.log('system', `[업데이트] 실패 — 이전 버전으로 되돌렸습니다: ${e.message}`);
        throw e;
      }
    } finally {
      this._applyLock = false;
    }
  }
}

// 의존성이 바뀌었는지: package-lock.json 변경 또는 package.json 의 dependencies 계열 변경 (버전 숫자만 바뀐 경우는 제외)
async function depsChanged(root, before) {
  const changed = await run('git', ['diff', '--name-only', before, 'HEAD'], { cwd: root });
  if (/^package-lock\.json$/m.test(changed)) return true;
  if (!/^package\.json$/m.test(changed)) return false;
  const pick = (t) => { try { const j = JSON.parse(t); return JSON.stringify([j.dependencies, j.optionalDependencies, j.engines]); } catch { return null; } };
  const old = await run('git', ['show', `${before}:package.json`], { cwd: root }).catch(() => '');
  return pick(old) !== pick(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
}

// CHANGELOG.md 에서 해당 버전 절의 본문 (릴리스 노트용, tools/release.js)
export function changelogSection(text, ver) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s*\\[?v?${ver.replace(/\./g, '\\.')}\\]?(\\s|$)`).test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

// npm install: npm start 로 실행했으면 같은 npm(npm_execpath)을 node 로 직접 실행 (Windows npm.cmd 셸 실행 회피)
async function npmInstall(cwd) {
  const npmJs = process.env.npm_execpath;
  const args = ['install', '--no-audit', '--no-fund'];
  if (npmJs && /\.c?js$/i.test(npmJs)) return run(process.execPath, [npmJs, ...args], { cwd });
  if (process.platform === 'win32') return run('cmd.exe', ['/d', '/s', '/c', 'npm', ...args], { cwd });   // 인수는 고정 문자열뿐
  return run('npm', args, { cwd });
}
