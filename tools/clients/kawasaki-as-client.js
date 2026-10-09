#!/usr/bin/env node
// Kawasaki AS 터미널(텔넷) 샘플 클라이언트 — 기본 포트 23 (에뮬레이터는 바인딩 실패 시 10023)
// 텔넷 협상 없이 원시 TCP 로 접속하므로 서버 에코가 없다.
//
// 사용법:  node tools/clients/kawasaki-as-client.js [host] [port]
//          node tools/clients/kawasaki-as-client.js 127.0.0.1 23 "WHERE" "STATUS"   ← 임의 명령 실행
import net from 'node:net';
import { pathToFileURL } from 'node:url';

export class AsClient {
  constructor(host = '127.0.0.1', port = 23, { timeout = 3000 } = {}) {
    Object.assign(this, { host, port, timeout });
    this.buf = '';
    this.waiter = null;
  }

  connect(user = 'as') {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(this.port, this.host);
      // 원시 TCP 접속에서는 서버가 텔넷 협상(IAC)을 보내지 않으므로 그대로 UTF-8 텍스트로 처리
      this.sock.setEncoding('utf8');
      this.sock.on('data', (s) => { this.buf += s; this._check(); });
      this.sock.once('error', reject);
      this.sock.once('connect', async () => {
        try {
          await this._until((b) => b.includes('login:'));
          this.buf = '';
          this.sock.write(user + '\r\n');
          resolve(await this._until((b) => b.endsWith('\r\n>')));
        } catch (e) { reject(e); }
      });
    });
  }
  close() { this.sock?.destroy(); }

  _check() { if (this.waiter && this.waiter.test(this.buf)) { const w = this.waiter; this.waiter = null; const out = this.buf; this.buf = ''; w.resolve(out); } }
  _until(test, ms = this.timeout) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiter = null; reject(new Error(`응답 시간 초과 (수신: ${JSON.stringify(this.buf.slice(-80))})`)); }, ms);
      this.waiter = { test, resolve: (v) => { clearTimeout(t); resolve(v); } };
      this._check();
    });
  }

  // 명령 실행 → 프롬프트 이전까지의 출력 텍스트
  async cmd(line) {
    this.buf = '';
    this.sock.write(line + '\r\n');
    const out = await this._until((b) => b.endsWith('\r\n>'));
    return out.replace(/\r\n>$/, '').replace(/^\r\n/, '').replace(/\r\n$/, '');
  }

  // 파일 업로드: LOAD → 파일 텍스트 → Ctrl-Z
  async load(name, text) {
    this.buf = '';
    this.sock.write(`LOAD ${name}\r\n`);
    await this._until((b) => /Loading/i.test(b));
    this.buf = '';
    this.sock.write(text.replace(/\r?\n/g, '\r\n') + '\x1a');
    const out = await this._until((b) => b.endsWith('\r\n>'));
    return out.replace(/\r\n>$/, '').trim();
  }

  // 파일 다운로드: SAVE → 내용 + Ctrl-Z
  async save(name = '') {
    this.buf = '';
    this.sock.write(`SAVE ${name}\r\n`);
    const out = await this._until((b) => b.includes('\x1a') && b.endsWith('\r\n>'));
    const body = out.slice(out.indexOf('Saving...') + 'Saving...'.length).replace(/^\r\n/, '');
    return body.slice(0, body.indexOf('\x1a')).replace(/\r\n/g, '\n');
  }

  // WHERE 출력 해석 → {joints, pose}
  static parseWhere(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const nums = (l) => l.split(/\s+/).map(Number);
    const ji = lines.findIndex((l) => l.startsWith('JT1'));
    const pi = lines.findIndex((l) => l.startsWith('X[mm]'));
    return { joints: ji >= 0 ? nums(lines[ji + 1]) : null, pose: pi >= 0 ? nums(lines[pi + 1]) : null };
  }
}

export const SAMPLE_PROGRAM = `.PROGRAM astest()
  ; 에뮬레이터 통신 테스트용 프로그램
  SPEED 50
  HOME
  TWAIT 0.1
.END
`;

export async function demo(host = '127.0.0.1', port = 23, out = console.log) {
  const c = new AsClient(host, port);
  const res = {};
  try {
    res.banner = await c.connect(); out(res.banner.trim());
    res.id = await c.cmd('ID'); out(res.id);
    res.where = await c.cmd('WHERE'); out(res.where);
    res.parsed = AsClient.parseWhere(res.where);
    res.ereset = await c.cmd('ERESET');
    res.zpow = await c.cmd('ZPOW ON'); out(res.zpow);
    res.speed = await c.cmd('SPEED 80');
    res.signal = await c.cmd('SIGNAL 1,-2,3'); // OUT1 ON, OUT2 OFF, OUT3 ON
    res.io = await c.cmd('IO'); out(res.io);
    res.print = await c.cmd('PRINT 1+2*3'); out('PRINT 1+2*3 →', res.print);
    res.here = await c.cmd('HERE pt1'); out('HERE pt1 →', res.here);
    res.doPoint = await c.cmd('POINT pt2 = pt1'); out('POINT →', res.doPoint);
    res.load = await c.load('astest.as', SAMPLE_PROGRAM); out(res.load);
    res.dir = await c.cmd('DIRECTORY'); out(res.dir);
    res.list = await c.cmd('LIST /P astest'); out(res.list);
    res.saved = await c.save('astest.as'); out(`SAVE ${res.saved.length} bytes`);
    res.execute = await c.cmd('EXECUTE astest'); out('EXECUTE →', res.execute || 'OK');
    res.status = await c.cmd('STATUS'); out(res.status);
    res.time = await c.cmd('TIME'); out(res.time);
    res.invalid = await c.cmd('FOOBAR'); out(res.invalid);
    return res;
  } finally { c.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [host = '127.0.0.1', port = '23', ...cmds] = process.argv.slice(2);
  (async () => {
    if (cmds.length) {
      const c = new AsClient(host, Number(port));
      await c.connect();
      for (const l of cmds) console.log(`>${l}\n${await c.cmd(l)}`);
      c.close();
    } else await demo(host, Number(port));
  })().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
}
