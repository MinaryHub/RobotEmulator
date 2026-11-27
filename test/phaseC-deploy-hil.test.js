// Phase C 회귀/통합 테스트:
//  1) netguard.js: IP 허용목록(CIDR 포함), Bearer/X-Auth-Token/?token= 인증, admin/readonly RBAC
//  2) hil.js: CLI 인자 파서, Headless HIL 시나리오 러너(성공/실패/DO/AO/regs), JUnit XML 생성
//  3) CLI 서브프로세스: --scenario + --junit 헤드리스 실행 및 종료 코드
//  4) 실서버 통합: --data-dir, --token, --readonly-token, --air-gapped, --headless,
//     /healthz, /readyz, HTTP 401/403/200, /api/backup/import ZIP,
//     WebSocket 인증 + Single-Writer Pendant Control Lock (claimControl + disconnect failover)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { configureNetGuard, ipAllowed, authRole, authConfigured, requestRejected } from '../server/netguard.js';
import { parseCliArgs, runScenario, toJUnitXml } from '../server/hil.js';
import { createZip } from '../server/backup.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_JS = path.join(ROOT, 'server/index.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.stack || e.message}`); failed++; }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function runSubprocess(args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_JS, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('subprocess timeout')); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const msgs = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString('utf8'));
      const idx = waiters.findIndex((w) => w.pred(m));
      if (idx >= 0) { const [w] = waiters.splice(idx, 1); clearTimeout(w.t); w.res(m); }
      else msgs.push(m);
    });
    ws.drain = () => { msgs.length = 0; };
    ws.waitFor = (pred, ms = 5000) => {
      const idx = msgs.findIndex(pred);
      if (idx >= 0) return Promise.resolve(msgs.splice(idx, 1)[0]);
      return new Promise((res, rej) => {
        const w = { pred, res, t: setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); rej(new Error('ws waitFor timeout')); }, ms) };
        waiters.push(w);
      });
    };
    let reqSeq = 1;
    ws.cmd = (cmd, extra = {}) => {
      const rid = reqSeq++;
      const p = ws.waitFor((m) => m.type === 'reply' && m.id === rid);
      ws.send(JSON.stringify({ ...extra, cmd, rid }));
      return p;
    };
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

// ---------------------------------------------------------------- 1. netguard.js
await test('netguard: IP allowlist (exact, CIDR /24, ::ffff:) & RBAC tokens', () => {
  configureNetGuard({
    host: '127.0.0.1',
    security: {
      token: 'adm-secret-123',
      readOnlyToken: 'view-only-456',
      ipAllowlist: ['127.0.0.1', '10.20.30.0/24'],
    },
  });
  assert.equal(authConfigured(), true);
  assert.equal(ipAllowed({ socket: { remoteAddress: '127.0.0.1' } }), true);
  assert.equal(ipAllowed({ socket: { remoteAddress: '::ffff:10.20.30.42' } }), true);
  assert.equal(ipAllowed({ socket: { remoteAddress: '10.20.31.1' } }), false);
  assert.match(requestRejected({ headers: { host: '127.0.0.1:3000' }, socket: { remoteAddress: '192.168.1.50' } }) || '', /허용되지 않은 IP/);

  assert.equal(authRole({ headers: { authorization: 'Bearer adm-secret-123' }, url: '/api/state' }), 'admin');
  assert.equal(authRole({ headers: { 'x-auth-token': 'view-only-456' }, url: '/api/state' }), 'readonly');
  assert.equal(authRole({ headers: {}, url: '/ws?token=adm-secret-123' }), 'admin');
  assert.equal(authRole({ headers: { authorization: 'Bearer wrong' }, url: '/api/state' }), null);
  assert.equal(authRole({ headers: {}, url: '/api/state' }), null);

  configureNetGuard({ host: '127.0.0.1', security: {} });
  assert.equal(authConfigured(), false);
  assert.equal(authRole({ headers: {}, url: '/api/state' }), 'admin');
});

// ---------------------------------------------------------------- 2. hil.js 단위 테스트
await test('hil: parseCliArgs, runScenario (pass & fail), toJUnitXml', async () => {
  const args = parseCliArgs([
    '--port', '4123', '--host', '0.0.0.0', '--data-dir', '/tmp/d',
    '--token', 't1', '--readonly-token', 'r1', '--air-gapped', '--headless', '--no-autosave',
  ]);
  assert.equal(args.port, 4123);
  assert.equal(args.host, '0.0.0.0');
  assert.equal(args.dataDir, '/tmp/d');
  assert.equal(args.token, 't1');
  assert.equal(args.readOnlyToken, 'r1');
  assert.equal(args.airGapped, true);
  assert.equal(args.headless, true);
  assert.equal(args.noAutosave, true);

  const report = await runScenario({
    name: 'PhaseC-HIL-Unit',
    cases: [
      {
        name: 'URScript DO & AO & GP Reg pass',
        robot: 'ur-ur5e',
        mode: 'PLAY',
        files: {
          'main.script': [
            'def main():',
            '  set_standard_digital_out(0, True)',
            '  set_standard_analog_out(0, 0.5)',
            '  write_output_integer_register(2, 77)',
            'end',
          ].join('\n'),
        },
        expect: {
          status: 'done',
          alarms: 0,
          do: { 1: true },
          ao: { 1: 0.5 },
          regs: { 'RTDE_OUT_I:2': 77 },
        },
      },
      {
        name: 'Intentional expectation failure',
        robot: 'ur-ur5e',
        mode: 'PLAY',
        files: {
          'main.script': 'def main():\n  set_standard_digital_out(0, False)\nend\n',
        },
        expect: { status: 'done', do: { 1: true } },
      },
    ],
  });
  assert.equal(report.total, 2);
  assert.equal(report.passed, 1, JSON.stringify(report.cases));
  assert.equal(report.failed, 1);
  assert.equal(report.ok, false);
  const xml = toJUnitXml(report);
  assert.match(xml, /<testsuites tests="2" failures="1"/);
  assert.match(xml, /<testcase name="URScript DO &amp; AO &amp; GP Reg pass"/);
  assert.match(xml, /<failure message="DO1 기대=true, 실제=false">/);
});

// ---------------------------------------------------------------- 3. CLI --scenario --junit 서브프로세스
await test('CLI subprocess: --scenario --junit exits 0 and writes JUnit XML', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robotemu-hil-'));
  try {
    const scPath = path.join(tmpDir, 'scenario.json');
    const xmlPath = path.join(tmpDir, 'junit.xml');
    fs.writeFileSync(scPath, JSON.stringify({
      name: 'CLI-HIL-Smoke',
      cases: [{
        name: 'KRL DO set',
        robot: 'kuka-kr10-r1100',
        mode: 'PLAY',
        files: {
          'main.src': 'DEF MAIN()\n  $OUT[3] = TRUE\n  WAIT SEC 0.05\nEND\n',
        },
        expect: { status: 'done', alarms: 0, do: { 3: true } },
      }],
    }));
    const r = await runSubprocess(['--scenario', scPath, '--junit', xmlPath]);
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /1\/1 passed/);
    const xml = fs.readFileSync(xmlPath, 'utf8');
    assert.match(xml, /<testsuite name="CLI-HIL-Smoke" tests="1" failures="0"/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 4. 실서버 HTTP/WS 통합 테스트
await test('Live server: /healthz, /readyz, RBAC 401/403/200, backup ZIP, --data-dir, WS Control Lock', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robotemu-srv-'));
  const dataDir = path.join(tmpDir, 'data');
  const cfgPath = path.join(tmpDir, 'config.json');
  const port = await getFreePort();
  // 다른 병렬 테스트와 포트 충돌이 없도록 프로토콜 비활성화 설정
  fs.writeFileSync(cfgPath, JSON.stringify({
    protocols: {
      yaskawaHse: { enabled: false },
      kawasakiAs: { enabled: false },
      hyundai: { enabled: false },
      abbRws: { enabled: false },
      kukaVarProxy: { enabled: false },
      urDashboard: { enabled: false },
      urRtde: { enabled: false },
      doosanDrfl: { enabled: false },
      modbus: { enabled: false },
      ethernetIp: { enabled: false },
      cclinkIeBasic: { enabled: false },
      opcua: { enabled: false },
    },
  }));

  const child = spawn(process.execPath, [
    SERVER_JS,
    '--config', cfgPath,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--data-dir', dataDir,
    '--token', 'admin123',
    '--readonly-token', 'view123',
    '--air-gapped',
    '--no-autosave',
    '--headless',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));

  const base = `http://127.0.0.1:${port}`;
  try {
    // /readyz == 200 대기
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(`${base}/readyz`);
        if (r.status === 200) { ready = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(ready, true, `server did not become ready. stderr=${stderr}`);

    // /healthz 인증 없이 200
    const hz = await fetch(`${base}/healthz`);
    assert.equal(hz.status, 200);
    const hzJson = await hz.json();
    assert.equal(hzJson.ok, true);

    // /api/state 토큰 없음 → 401
    const unauth = await fetch(`${base}/api/state`);
    assert.equal(unauth.status, 401);

    // /api/state readonly 토큰 → 200
    const roState = await fetch(`${base}/api/state`, { headers: { Authorization: 'Bearer view123' } });
    assert.equal(roState.status, 200);

    // POST /api/cmd (vars, 읽기 전용 명령) readonly 토큰 → 200
    const roVars = await fetch(`${base}/api/cmd`, {
      method: 'POST',
      headers: { Authorization: 'Bearer view123', 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'vars' }),
    });
    assert.equal(roVars.status, 200);

    // POST /api/cmd (servo, 제어 명령) readonly 토큰 → 403
    const roMut = await fetch(`${base}/api/cmd`, {
      method: 'POST',
      headers: { Authorization: 'Bearer view123', 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'servo', on: true }),
    });
    assert.equal(roMut.status, 403);

    // POST /api/cmd (servo) admin 토큰 → 200
    const admMut = await fetch(`${base}/api/cmd`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin123', 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'servo', on: true }),
    });
    assert.equal(admMut.status, 200);

    // POST /api/backup/import: readonly → 403, admin + ZIP → 200
    const zipBuf = createZip({
      'KRC/R1/Program/cell_pick.src': 'DEF CELL_PICK()\n  $OUT[1] = TRUE\nEND\n',
      'KRC/R1/Program/cell_pick.dat': 'DEFDAT CELL_PICK\nENDDAT\n',
    });
    const roImp = await fetch(`${base}/api/backup/import`, {
      method: 'POST',
      headers: { 'X-Auth-Token': 'view123', 'Content-Type': 'application/zip' },
      body: zipBuf,
    });
    assert.equal(roImp.status, 403);

    const admImp = await fetch(`${base}/api/backup/import`, {
      method: 'POST',
      headers: { 'X-Auth-Token': 'admin123', 'Content-Type': 'application/zip' },
      body: zipBuf,
    });
    assert.equal(admImp.status, 200);
    const impJson = await admImp.json();
    assert.equal(impJson.ok, true);
    assert.equal(impJson.vendor, 'kuka');
    assert.equal(impJson.count, 2);

    // --data-dir 격리 확인 (projects/, assets/models/가 dataDir 안에 생성됨)
    assert.equal(fs.existsSync(path.join(dataDir, 'projects')), true);
    assert.equal(fs.existsSync(path.join(dataDir, 'assets', 'models')), true);

    // WebSocket: 미인증 접속 거부
    await assert.rejects(() => connectWs(`ws://127.0.0.1:${port}/ws`));

    // WebSocket: readonly 클라이언트 접속 → 제어 명령 거부, claimControl 거부
    const wsRo = await connectWs(`ws://127.0.0.1:${port}/ws?token=view123`);
    const initRo = await wsRo.waitFor((m) => m.type === 'init');
    assert.equal(initRo.role, 'readonly');
    assert.equal(initRo.aiEnabled, false); // --air-gapped
    const roReply = await wsRo.cmd('override', { v: 50 });
    assert.equal(roReply.ok, false);
    assert.match(roReply.error, /읽기 전용/);
    const roClaim = await wsRo.cmd('claimControl');
    assert.equal(roClaim.ok, false);

    // WebSocket: admin 클라이언트 #1 → 자동으로 제어권 획득
    const ws1 = await connectWs(`ws://127.0.0.1:${port}/ws?token=admin123`);
    const init1 = await ws1.waitFor((m) => m.type === 'init');
    assert.equal(init1.role, 'admin');
    assert.equal(init1.controlLock.holder, init1.clientId);
    const r1 = await ws1.cmd('override', { v: 65 });
    assert.equal(r1.ok, true);

    // WebSocket: admin 클라이언트 #2 → 제어권 없음 → 거부 → claimControl → 성공!
    const ws2 = await connectWs(`ws://127.0.0.1:${port}/ws?token=admin123`);
    const init2 = await ws2.waitFor((m) => m.type === 'init');
    assert.equal(init2.controlLock.holder, init1.clientId);
    const r2Blocked = await ws2.cmd('override', { v: 70 });
    assert.equal(r2Blocked.ok, false);
    assert.match(r2Blocked.error, /제어권/);

    const claimed = await ws2.cmd('claimControl');
    assert.equal(claimed.ok, true);
    assert.equal(claimed.holder, init2.clientId);

    // 이제 #2 는 제어 가능, #1 은 거부
    assert.equal((await ws2.cmd('override', { v: 75 })).ok, true);
    assert.equal((await ws1.cmd('override', { v: 80 })).ok, false);

    // #2 연결 종료 → #1 으로 제어권 자동 복구
    ws1.drain();
    const lockBack = ws1.waitFor((m) => m.type === 'controlLock' && m.holder === init1.clientId);
    ws2.close();
    await lockBack;
    assert.equal((await ws1.cmd('override', { v: 85 })).ok, true);

    ws1.close();
    wsRo.close();
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
      child.once('close', () => { clearTimeout(t); resolve(); });
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

console.log(`\nPhase C deploy/HIL tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
