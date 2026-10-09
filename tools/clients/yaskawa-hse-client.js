#!/usr/bin/env node
// Yaskawa High-Speed Ethernet Server (HSE) 샘플 클라이언트 — UDP 10040(로봇 제어) / 10041(파일 제어)
// 실제 YRC1000/DX200 및 본 에뮬레이터 모두에서 사용할 수 있다. 외부 의존성 없음.
//
// 사용법:  node tools/clients/yaskawa-hse-client.js [host] [port] [filePort]
//
// 라이브러리로 사용:
//   import { HseClient } from './yaskawa-hse-client.js';
//   const c = new HseClient('192.168.255.1');
//   console.log(await c.readStatus());
//   c.close();
import dgram from 'node:dgram';
import { pathToFileURL } from 'node:url';

export const SVC = { GET_ALL: 0x01, SET_ALL: 0x02, GET_ONE: 0x0e, SET_ONE: 0x10, GET_MULTI: 0x33, SET_MULTI: 0x34 };

export class HseError extends Error {
  constructor(status, added, cmd) {
    super(`HSE 오류 cmd=0x${cmd.toString(16)} status=0x${status.toString(16)} added=0x${added.toString(16)}`);
    this.status = status; this.added = added;
  }
}

// ------------------------------------------------------------ 패킷
function header({ division, ack = 0, reqId, block = 0, dataLen }) {
  const h = Buffer.alloc(32);
  h.write('YERC', 0, 'ascii');
  h.writeUInt16LE(32, 4);
  h.writeUInt16LE(dataLen, 6);
  h[8] = 3; h[9] = division; h[10] = ack; h[11] = reqId & 0xff;
  h.writeUInt32LE(block >>> 0, 12);
  h.write('99999999', 16, 'ascii');
  return h;
}
export function request({ division = 1, reqId = 0, block = 0, cmd, instance = 0, attribute = 0, service, data = Buffer.alloc(0), ack = 0 }) {
  const h = header({ division, ack, reqId, block, dataLen: data.length });
  h.writeUInt16LE(cmd, 24); h.writeUInt16LE(instance, 26); h[28] = attribute; h[29] = service;
  return Buffer.concat([h, data]);
}
export function parseResponse(buf) {
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'YERC') throw new Error('YERC 응답 아님');
  return {
    division: buf[9], ack: buf[10], reqId: buf[11], block: buf.readUInt32LE(12),
    service: buf[24] & 0x7f, status: buf[25], addedSize: buf[26], added: buf.readUInt16LE(28),
    data: buf.subarray(32, 32 + buf.readUInt16LE(6)),
  };
}
const i32 = (...v) => { const b = Buffer.alloc(v.length * 4); v.forEach((x, i) => b.writeInt32LE(Math.round(x) | 0, i * 4)); return b; };
const str = (s, n) => { const b = Buffer.alloc(n); b.write(s, 0, n, 'latin1'); return b; };
const cstr = (b) => b.toString('latin1').replace(/\0.*$/s, '');

// ------------------------------------------------------------ 클라이언트
export class HseClient {
  constructor(host = '127.0.0.1', { port = 10040, filePort = 10041, timeout = 1500, retries = 2 } = {}) {
    Object.assign(this, { host, port, filePort, timeout, retries });
    this.sock = dgram.createSocket('udp4');
    this.reqId = 0;
    this.waiters = [];
    this.sock.on('message', (m) => {
      let r; try { r = parseResponse(m); } catch { return; }
      const i = this.waiters.findIndex((w) => w.match(r));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(r);
    });
  }
  close() { try { this.sock.close(); } catch {} }

  _wait(match, ms) {
    return new Promise((resolve, reject) => {
      const w = { match, resolve: (r) => { clearTimeout(t); resolve(r); } };
      const t = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); reject(new Error('응답 시간 초과')); }, ms);
      this.waiters.push(w);
    });
  }

  // 단일 요청/응답 (재전송 포함)
  async call(cmd, instance, attribute, service, data = Buffer.alloc(0), { division = 1, port = this.port, block = 0 } = {}) {
    const reqId = (this.reqId = (this.reqId + 1) & 0xff);
    const pkt = request({ division, reqId, block, cmd, instance, attribute, service, data });
    for (let a = 0; ; a++) {
      const p = this._wait((r) => r.reqId === reqId && r.division === division, this.timeout);
      this.sock.send(pkt, port, this.host);
      try {
        const r = await p;
        if (r.status !== 0) throw new HseError(r.status, r.added, cmd);
        return r;
      } catch (e) { if (e instanceof HseError || a >= this.retries) throw e; }
    }
  }

  // ---- 상태/위치/알람
  async readStatus() {
    const { data } = await this.call(0x72, 1, 0, SVC.GET_ALL);
    const d1 = data.readInt32LE(0), d2 = data.readInt32LE(4);
    return {
      step: !!(d1 & 1), oneCycle: !!(d1 & 2), auto: !!(d1 & 4), running: !!(d1 & 8), safetySpeed: !!(d1 & 16),
      teach: !!(d1 & 32), play: !!(d1 & 64), commandRemote: !!(d1 & 128),
      holdPendant: !!(d2 & 2), holdExternal: !!(d2 & 4), holdCommand: !!(d2 & 8), alarm: !!(d2 & 16), error: !!(d2 & 32), servoOn: !!(d2 & 64),
      raw: [d1, d2],
    };
  }
  static decodePosition(data) {
    const a = []; for (let i = 0; i < 13; i++) a.push(data.readInt32LE(i * 4));
    const out = { type: a[0], form: a[1], tool: a[2], user: a[3], extForm: a[4], axes: a.slice(5) };
    if (a[0] !== 0) out.xyz = [a[5] / 1000, a[6] / 1000, a[7] / 1000, a[8] / 10000, a[9] / 10000, a[10] / 10000];
    return out;
  }
  // cartesian=false → 펄스, true → 베이스 좌표 (mm, deg)
  async readPosition(cartesian = false) {
    const { data } = await this.call(0x75, cartesian ? 101 : 1, 0, SVC.GET_ALL);
    return HseClient.decodePosition(data);
  }
  async readAlarm(n = 1) {
    const { data } = await this.call(0x70, n, 0, SVC.GET_ALL);
    return { code: data.readInt32LE(0), data: data.readInt32LE(4), type: data.readInt32LE(8), time: cstr(data.subarray(12, 28)), name: cstr(data.subarray(28, 60)) };
  }
  async readJobInfo() {
    const { data } = await this.call(0x73, 1, 0, SVC.GET_ALL);
    return { job: cstr(data.subarray(0, 32)), line: data.readInt32LE(32), step: data.readInt32LE(36), override: data.readInt32LE(40) / 100 };
  }
  async readSystemInfo() {
    const { data } = await this.call(0x89, 11, 0, SVC.GET_ALL);
    return { software: cstr(data.subarray(0, 24)), model: cstr(data.subarray(24, 40)), param: cstr(data.subarray(40, 48)) };
  }

  // ---- 제어
  resetAlarm() { return this.call(0x82, 1, 1, SVC.SET_ONE, i32(1)); }
  cancelError() { return this.call(0x82, 2, 1, SVC.SET_ONE, i32(1)); }
  servo(on) { return this.call(0x83, 2, 1, SVC.SET_ONE, i32(on ? 1 : 2)); }
  hold(on) { return this.call(0x83, 1, 1, SVC.SET_ONE, i32(on ? 1 : 2)); }
  setCycleMode(mode /* 'step'|'cycle'|'auto' */) { return this.call(0x84, 2, 1, SVC.SET_ONE, i32({ step: 1, cycle: 2, auto: 3 }[mode] ?? 3)); }
  startJob() { return this.call(0x86, 1, 1, SVC.SET_ONE, i32(1)); }
  selectJob(name, line = 0) { return this.call(0x87, 1, 0, SVC.SET_ALL, Buffer.concat([str(name, 32), i32(line)])); }
  displayMessage(msg) { return this.call(0x85, 1, 1, SVC.SET_ONE, str(msg, 30)); }

  // ---- IO (논리번호: 범용입력 #1 = 00010 → 인스턴스 1, 범용출력 #1 = 10010 → 인스턴스 1001)
  async readIO(instance) { const { data } = await this.call(0x78, instance, 1, SVC.GET_ONE); return data[0]; }
  writeIO(instance, byte) { return this.call(0x78, instance, 1, SVC.SET_ONE, Buffer.from([byte & 0xff])); }
  async readIOMulti(instance, count) {
    const { data } = await this.call(0x300, instance, 0, SVC.GET_MULTI, i32(count));
    return [...data.subarray(4, 4 + count)];
  }

  // ---- 변수 B/I/D/R/S (+ 레지스터 'REG')
  static VT = {
    REG: { cmd: 0x79, size: 2, rd: (b) => b.readUInt16LE(0), wr: (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; } },
    B: { cmd: 0x7a, size: 1, rd: (b) => b.readUInt8(0), wr: (v) => Buffer.from([v & 0xff]) },
    I: { cmd: 0x7b, size: 2, rd: (b) => b.readInt16LE(0), wr: (v) => { const b = Buffer.alloc(2); b.writeInt16LE(v); return b; } },
    D: { cmd: 0x7c, size: 4, rd: (b) => b.readInt32LE(0), wr: (v) => i32(v) },
    R: { cmd: 0x7d, size: 4, rd: (b) => b.readFloatLE(0), wr: (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return b; } },
    S: { cmd: 0x7e, size: 16, rd: (b) => cstr(b), wr: (v) => str(v, 16) },
  };
  async readVar(type, n) { const t = HseClient.VT[type]; const { data } = await this.call(t.cmd, n, 1, SVC.GET_ONE); return t.rd(data); }
  writeVar(type, n, v) { const t = HseClient.VT[type]; return this.call(t.cmd, n, 1, SVC.SET_ONE, t.wr(v)); }

  // P 변수: pos = {xyz:[x,y,z,rx,ry,rz], coord?:16} 또는 {pulse:[...]}
  async readP(n) { const { data } = await this.call(0x7f, n, 0, SVC.GET_ALL); return HseClient.decodePosition(data); }
  writeP(n, pos) {
    const d = pos.pulse
      ? i32(0, 0, pos.tool ?? 0, 0, 0, ...pos.pulse.concat([0, 0, 0, 0, 0, 0, 0, 0]).slice(0, 8))
      : i32(pos.coord ?? 16, pos.form ?? 0, pos.tool ?? 0, pos.user ?? 0, 0,
        pos.xyz[0] * 1000, pos.xyz[1] * 1000, pos.xyz[2] * 1000, pos.xyz[3] * 10000, pos.xyz[4] * 10000, pos.xyz[5] * 10000, 0, 0);
    return this.call(0x7f, n, 0, SVC.SET_ALL, d);
  }

  // ---- 이동: type 'joint'(링크 절대) | 'linear'(직선 절대) | 'increment'(직선 증분)
  // speed: {percent} (링크 %) 또는 {mmps} (V)
  moveCartesian(xyz, { type = 'joint', speed = { percent: 10 }, coord = 16, tool = 0, user = 0, form = 0 } = {}) {
    const [cls, sp] = speed.mmps !== undefined ? [1, speed.mmps * 10] : [0, (speed.percent ?? 10) * 100];
    const inst = { joint: 1, linear: 2, increment: 3 }[type];
    const d = i32(1, 0, cls, sp, coord, xyz[0] * 1000, xyz[1] * 1000, xyz[2] * 1000, xyz[3] * 10000, xyz[4] * 10000, xyz[5] * 10000,
      0, 0, form, 0, tool, user, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    return this.call(0x8a, inst, 1, SVC.SET_ALL, d);
  }
  movePulse(pulse, { type = 'joint', speed = { percent: 10 }, tool = 0 } = {}) {
    const [cls, sp] = speed.mmps !== undefined ? [1, speed.mmps * 10] : [0, (speed.percent ?? 10) * 100];
    const p = pulse.concat(new Array(8).fill(0)).slice(0, 8);
    const d = i32(1, 0, cls, sp, ...p, tool, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    return this.call(0x8b, type === 'linear' ? 2 : 1, 1, SVC.SET_ALL, d);
  }

  // ---- 파일 제어 (UDP 10041)
  async deleteFile(name) { await this.call(0x00, 0, 0, 0x09, Buffer.from(name, 'latin1'), { division: 2, port: this.filePort }); }

  async uploadFile(name, text, chunk = 400) {
    const data = Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'latin1');
    await this.call(0x00, 0, 0, 0x15, Buffer.from(name, 'latin1'), { division: 2, port: this.filePort, block: 0 });
    const n = Math.max(1, Math.ceil(data.length / chunk));
    for (let i = 0; i < n; i++) {
      const blk = (i + 1) | (i === n - 1 ? 0x80000000 : 0);
      await this.call(0x00, 0, 0, 0x15, data.subarray(i * chunk, (i + 1) * chunk), { division: 2, port: this.filePort, block: blk >>> 0 });
    }
  }

  // 컨트롤러 → PC 다중 블록 수신 (0x16 저장 / 0x32 목록)
  async _receive(service, arg) {
    const reqId = (this.reqId = (this.reqId + 1) & 0xff);
    const parts = [];
    let pkt = request({ division: 2, reqId, cmd: 0, service, data: Buffer.from(arg, 'latin1') });
    for (;;) {
      const p = this._wait((r) => r.reqId === reqId && r.division === 2, this.timeout * 2);
      this.sock.send(pkt, this.filePort, this.host);
      const r = await p;
      if (r.status !== 0) throw new HseError(r.status, r.added, service);
      parts.push(r.data);
      // 수신 확인(ACK=1) 전송 — 마지막 블록도 확인을 보낸다
      const ack = request({ division: 2, ack: 1, reqId, block: r.block, cmd: 0, service });
      if (r.block & 0x80000000) { this.sock.send(ack, this.filePort, this.host); break; }
      pkt = ack;
    }
    return Buffer.concat(parts).toString('latin1');
  }
  downloadFile(name) { return this._receive(0x16, name); }
  async listFiles(pattern = '*.JBI') { return (await this._receive(0x32, pattern)).split(/\r?\n/).filter(Boolean); }
}

// ------------------------------------------------------------ 데모 시나리오
export const SAMPLE_JOB = `/JOB
//NAME HSETEST
//POS
///NPOS 0,0,0,0,0,0
//INST
///DATE 2026/01/01 00:00
///ATTR SC,RW
///GROUP1 RB1
NOP
TIMER T=0.10
END
`;

export async function demo(host = '127.0.0.1', opts = {}, out = console.log) {
  const c = new HseClient(host, opts);
  const res = {};
  try {
    res.system = await c.readSystemInfo(); out('시스템 정보:', res.system);
    res.statusBefore = await c.readStatus(); out('상태:', res.statusBefore);
    res.pulse = await c.readPosition(false); out('현재 펄스:', res.pulse.axes.slice(0, 6));
    res.cart = await c.readPosition(true); out('현재 직교(베이스):', res.cart.xyz);
    await c.resetAlarm();
    await c.servo(true);
    res.statusServo = await c.readStatus(); out('서보 ON 후 servoOn =', res.statusServo.servoOn);

    await c.writeIO(1001, 0b00000101); // OT#1, OT#3 ON
    res.out = await c.readIO(1001); out('OT#1-8 =', res.out.toString(2).padStart(8, '0'));
    await c.writeIO(1001, 0);

    await c.writeVar('B', 1, 42); res.b1 = await c.readVar('B', 1);
    await c.writeVar('I', 2, -1234); res.i2 = await c.readVar('I', 2);
    await c.writeVar('D', 3, 123456789); res.d3 = await c.readVar('D', 3);
    await c.writeVar('R', 4, 3.5); res.r4 = await c.readVar('R', 4);
    await c.writeVar('S', 5, 'HELLO'); res.s5 = await c.readVar('S', 5);
    out('변수 B001/I002/D003/R004/S005 =', res.b1, res.i2, res.d3, res.r4, res.s5);
    await c.writeP(10, { xyz: res.cart.xyz });
    res.p10 = await c.readP(10); out('P010 =', res.p10.xyz);

    // 현재 위치에서 Z -20mm 직선 증분 이동
    await c.moveCartesian([0, 0, -20, 0, 0, 0], { type: 'increment', speed: { mmps: 200 } });
    await new Promise((r) => setTimeout(r, 400));
    res.cartAfter = await c.readPosition(true); out('이동 후 직교:', res.cartAfter.xyz);

    await c.uploadFile('HSETEST.JBI', SAMPLE_JOB);
    res.list = await c.listFiles('*.JBI'); out('잡 목록:', res.list);
    res.download = await c.downloadFile('HSETEST.JBI'); out('다운로드 크기:', res.download.length);
    await c.selectJob('HSETEST');
    res.job = await c.readJobInfo(); out('선택 잡:', res.job);
    try { await c.setCycleMode('cycle'); await c.startJob(); res.started = true; out('잡 시작 OK'); }
    catch (e) { res.started = false; res.startError = e.message; out('잡 시작 실패:', e.message); }
    return res;
  } finally { c.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [host = '127.0.0.1', port = '10040', filePort = '10041'] = process.argv.slice(2);
  demo(host, { port: Number(port), filePort: Number(filePort) }).then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
}
