#!/usr/bin/env node
// KUKA KukaVarProxy / OpenShowVar 샘플 클라이언트 — TCP 7000
// 실제 KR C4 의 KukaVarProxy 및 본 에뮬레이터 모두에서 사용 가능. 외부 의존성 없음.
//
// 사용법:  node tools/clients/kuka-varproxy-client.js [host] [port]
//          node tools/clients/kuka-varproxy-client.js 127.0.0.1 7000 '$POS_ACT' '$OUT[3]=TRUE'   ← 임의 읽기/쓰기
import net from 'node:net';
import { pathToFileURL } from 'node:url';

export class KvpClient {
  constructor(host = '127.0.0.1', port = 7000, { timeout = 2000 } = {}) {
    Object.assign(this, { host, port, timeout });
    this.msgId = 0;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(this.port, this.host, resolve);
      this.sock.once('error', reject);
      this.sock.on('data', (d) => this._onData(d));
    });
  }
  close() { this.sock?.destroy(); }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt16BE(2);
      if (this.buf.length < 4 + len) break;
      const id = this.buf.readUInt16BE(0);
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      const vl = body.readUInt16BE(1);
      const value = body.subarray(3, 3 + vl).toString('latin1');
      const tail = body.subarray(3 + vl);
      const ok = tail.length === 3 && tail[2] === 1;
      const p = this.pending.get(id);
      if (p) { this.pending.delete(id); p.resolve({ id, mode: body[0], value, ok }); }
    }
  }

  _send(mode, name, value) {
    const id = (this.msgId = (this.msgId + 1) & 0xffff);
    const n = Buffer.from(name, 'latin1');
    const v = value !== undefined ? Buffer.from(String(value), 'latin1') : null;
    const len = 1 + 2 + n.length + (v ? 2 + v.length : 0);
    const b = Buffer.alloc(4 + len);
    b.writeUInt16BE(id, 0); b.writeUInt16BE(len, 2); b[4] = mode; b.writeUInt16BE(n.length, 5); n.copy(b, 7);
    if (v) { b.writeUInt16BE(v.length, 7 + n.length); v.copy(b, 9 + n.length); }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`응답 시간 초과: ${name}`)); }, this.timeout);
      this.pending.set(id, { resolve: (r) => { clearTimeout(t); resolve(r); } });
      this.sock.write(b);
    });
  }

  // 읽기 → 값 문자열 (실패 시 예외)
  async read(name) { const r = await this._send(0, name); if (!r.ok) throw new Error(`읽기 실패: ${name}`); return r.value; }
  // 쓰기 → 쓴 뒤의 값 문자열
  async write(name, value) { const r = await this._send(1, name, value); if (!r.ok) throw new Error(`쓰기 실패: ${name}`); return r.value; }

  // KRL 구조체 텍스트 → 객체.  "{E6POS: X 1.0, Y 2, S 6}" → {X:1, Y:2, S:6}
  static parseStruct(text) {
    const out = {};
    const body = String(text).replace(/^\{\s*(\w+\s*:)?/, '').replace(/\}\s*$/, '');
    for (const part of body.split(',')) {
      const m = /^\s*(\w+)\s+(.+?)\s*$/.exec(part);
      if (m) out[m[1]] = /^[-+]?[\d.]+(E[-+]?\d+)?$/i.test(m[2]) ? Number(m[2]) : m[2];
    }
    return out;
  }
}

export async function demo(host = '127.0.0.1', port = 7000, out = console.log) {
  const c = new KvpClient(host, port);
  await c.connect();
  const res = {};
  try {
    res.axis = await c.read('$AXIS_ACT'); out('$AXIS_ACT =', res.axis);
    res.pos = await c.read('$POS_ACT'); out('$POS_ACT =', res.pos);
    res.posObj = KvpClient.parseStruct(res.pos);
    res.ov = await c.read('$OV_PRO'); out('$OV_PRO =', res.ov);
    res.ovSet = await c.write('$OV_PRO', '50'); out('$OV_PRO ← 50 →', res.ovSet);
    res.mode = await c.read('$MODE_OP'); out('$MODE_OP =', res.mode);
    res.state = await c.read('$PRO_STATE1'); out('$PRO_STATE1 =', res.state);
    res.outSet = await c.write('$OUT[3]', 'TRUE');
    res.out3 = await c.read('$OUT[3]'); out('$OUT[3] =', res.out3);
    await c.write('$OUT[3]', 'FALSE');
    res.in1 = await c.read('$IN[1]'); out('$IN[1] =', res.in1);
    res.userSet = await c.write('MYCOUNT', '17');
    res.user = await c.read('MYCOUNT'); out('MYCOUNT =', res.user);
    try { res.missing = await c.read('$NO_SUCH_VAR'); } catch (e) { res.missingError = e.message; out(e.message); }
    // 한 번에 여러 요청 전송 (파이프라이닝)
    res.batch = await Promise.all(['$OV_PRO', '$MODE_OP', '$OUT[1]'].map((n) => c.read(n))); out('일괄 읽기:', res.batch);
    await c.write('$OV_PRO', '100');
    return res;
  } finally { c.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [host = '127.0.0.1', port = '7000', ...vars] = process.argv.slice(2);
  (async () => {
    if (!vars.length) return demo(host, Number(port));
    const c = new KvpClient(host, Number(port));
    await c.connect();
    for (const v of vars) {
      const i = v.indexOf('=');
      if (i > 0) console.log(`${v.slice(0, i)} ← ${v.slice(i + 1)} : ${await c.write(v.slice(0, i), v.slice(i + 1))}`);
      else console.log(`${v} = ${await c.read(v)}`);
    }
    c.close();
  })().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
}
