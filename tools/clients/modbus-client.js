#!/usr/bin/env node
// Modbus TCP 샘플 클라이언트 (외부 의존성 없음) — 로봇 에뮬레이터 Modbus 맵용 헬퍼 포함
// 주소 맵은 server/protocols/modbus-tcp.js 헤더 / README 참고.
//
// 사용법:  node tools/clients/modbus-client.js [host] [port]
//   데모: 상태/관절 읽기 → DI1 코일 쓰기 → 오버라이드 쓰기 → 명령(서보 ON, 시작)
import net from 'node:net';
import { pathToFileURL } from 'node:url';

export class ModbusError extends Error {
  constructor(fc, code) { super(`Modbus 예외 FC${fc} 코드 ${code}`); this.fc = fc; this.code = code; }
}

export class ModbusClient {
  constructor(host = '127.0.0.1', port = 502, { unit = 1, timeout = 2000 } = {}) {
    Object.assign(this, { host, port, unit, timeout });
    this.tid = 0;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(this.port, this.host, () => { this.sock.off('error', reject); this.sock.on('error', () => {}); resolve(this); });
      this.sock.once('error', reject);
      this.sock.on('data', (d) => this._onData(d));
      this.sock.on('close', () => { for (const p of this.pending.values()) p.reject(new Error('연결 종료')); this.pending.clear(); });
    });
  }
  close() { this.sock?.destroy(); }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 7) {
      const len = this.buf.readUInt16BE(4);
      if (this.buf.length < 6 + len) break;
      const tid = this.buf.readUInt16BE(0);
      const pdu = this.buf.subarray(7, 6 + len);
      this.buf = this.buf.subarray(6 + len);
      const p = this.pending.get(tid);
      if (!p) continue;
      this.pending.delete(tid); clearTimeout(p.timer);
      if (pdu[0] & 0x80) p.reject(new ModbusError(pdu[0] & 0x7F, pdu[1]));
      else p.resolve(Buffer.from(pdu));
    }
  }

  // 원시 PDU 요청 → 응답 PDU
  request(pdu) {
    const tid = (this.tid = (this.tid + 1) & 0xFFFF);
    const h = Buffer.alloc(7);
    h.writeUInt16BE(tid, 0); h.writeUInt16BE(0, 2); h.writeUInt16BE(pdu.length + 1, 4); h[6] = this.unit;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(tid); reject(new Error('응답 시간 초과')); }, this.timeout);
      this.pending.set(tid, { resolve, reject, timer });
      this.sock.write(Buffer.concat([h, pdu]));
    });
  }

  async _readBits(fc, addr, qty) {
    const r = await this.request(Buffer.from([fc, addr >> 8, addr & 255, qty >> 8, qty & 255]));
    const out = [];
    for (let i = 0; i < qty; i++) out.push(!!(r[2 + (i >> 3)] & (1 << (i & 7))));
    return out;
  }
  async _readRegs(fc, addr, qty) {
    const r = await this.request(Buffer.from([fc, addr >> 8, addr & 255, qty >> 8, qty & 255]));
    const out = [];
    for (let i = 0; i < r[1] / 2; i++) out.push(r.readUInt16BE(2 + i * 2));
    return out;
  }
  readCoils(addr, qty = 1) { return this._readBits(1, addr, qty); }
  readDiscreteInputs(addr, qty = 1) { return this._readBits(2, addr, qty); }
  readHoldingRegisters(addr, qty = 1) { return this._readRegs(3, addr, qty); }
  readInputRegisters(addr, qty = 1) { return this._readRegs(4, addr, qty); }
  async writeCoil(addr, on) { await this.request(Buffer.from([5, addr >> 8, addr & 255, on ? 0xFF : 0, 0])); }
  async writeRegister(addr, v) { await this.request(Buffer.from([6, addr >> 8, addr & 255, (v >> 8) & 255, v & 255])); }
  async writeCoils(addr, vals) {
    const b = Buffer.alloc(Math.ceil(vals.length / 8));
    vals.forEach((v, i) => { if (v) b[i >> 3] |= 1 << (i & 7); });
    await this.request(Buffer.concat([Buffer.from([15, addr >> 8, addr & 255, vals.length >> 8, vals.length & 255, b.length]), b]));
  }
  async writeRegisters(addr, vals) {
    const b = Buffer.alloc(6 + vals.length * 2);
    b[0] = 16; b.writeUInt16BE(addr, 1); b.writeUInt16BE(vals.length, 3); b[5] = vals.length * 2;
    vals.forEach((v, i) => b.writeUInt16BE(v & 0xFFFF, 6 + i * 2));
    await this.request(b);
  }
  async readWriteRegisters(rAddr, rQty, wAddr, wVals) {
    const b = Buffer.alloc(10 + wVals.length * 2);
    b[0] = 23; b.writeUInt16BE(rAddr, 1); b.writeUInt16BE(rQty, 3); b.writeUInt16BE(wAddr, 5); b.writeUInt16BE(wVals.length, 7); b[9] = wVals.length * 2;
    wVals.forEach((v, i) => b.writeUInt16BE(v & 0xFFFF, 10 + i * 2));
    const r = await this.request(b);
    const out = [];
    for (let i = 0; i < r[1] / 2; i++) out.push(r.readUInt16BE(2 + i * 2));
    return out;
  }

  // ---------------------------------------------------- 로봇 에뮬레이터 맵 헬퍼
  async readStatus() {
    const r = await this.readInputRegisters(0, 9);
    const b = r[0];
    const bit = (n) => !!(b & (1 << n));
    return {
      raw: b, servo: bit(0), running: bit(1), held: bit(2), alarm: bit(3), moving: bit(4),
      teach: bit(5), play: bit(6), remote: bit(7), done: bit(8), error: bit(9), collision: bit(10),
      estop: bit(11), fenceOpen: bit(12), interlock: bit(13), sysio: bit(14),
      override: r[1], alarmCount: r[2], alarmCode: r[3], cycle: r[4] * 65536 + r[5], vendorCode: r[6],
      rejectCode: r[7], programNumber: r[8],
    };
  }
  async readJoints() { return decodeI32(await this.readInputRegisters(10, 12)).map((v) => v / 1000); }
  async readPose() {
    const st = await this.readInputRegisters(6, 1);
    const v = decodeI32(await this.readInputRegisters(30, 14));
    const abb = st[0] === 4;
    return v.map((x, i) => x / (i < 3 ? 1000 : abb ? 1e6 : 1000)).slice(0, abb ? 7 : 6);
  }
  async readCycleTimes() {
    const r = await this.readInputRegisters(50, 4);
    return { lastMs: r[0] * 65536 + r[1], currentMs: r[2] * 65536 + r[3] };
  }
  async readGripper() { const r = await this.readInputRegisters(60, 2); return { posPct: r[0], holding: !!r[1] }; }
  // 명령 레지스터 실행 → 결과 (0 정상, 1 거부)
  async command(code) {
    await this.writeRegister(0, code);
    return (await this.readHoldingRegisters(2, 1))[0];
  }
  async setOverride(pct) { await this.writeRegister(1, pct); }
  async readUserReg(n) { return toSigned16((await this.readHoldingRegisters(100 + n, 1))[0]); }
  async writeUserReg(n, v) { await this.writeRegister(100 + n, v & 0xFFFF); }
}

export const CMD = { SERVO_ON: 1, SERVO_OFF: 2, START: 3, HOLD: 4, RESUME: 5, STOP: 6, RESET_ALARMS: 7, RESET_PROGRAM: 8, MOVE_HOME: 9 };
// 입력 레지스터 7 (마지막 명령 거부 사유) — server/controller.js REJECT
export const REJECT_TEXT = {
  1: 'REMOTE 모드가 아님', 2: 'REMOTE 모드에서 펜던트 조작', 3: '비상정지 중', 4: '안전 펜스 열림', 5: '인에이블 OFF',
  6: '알람 상태', 7: '서보 OFF', 8: '모드 변경 불가', 9: '프로그램 번호 미할당', 10: '패리티 오류',
  11: '조그는 TEACH 에서만', 12: '실행 중 프로그램 선택', 13: '외부 홀드 입력', 14: '서보 OFF 입력',
};
export const toSigned16 = (v) => (v << 16) >> 16;
export function decodeI32(regs) {
  const out = [];
  for (let i = 0; i + 1 < regs.length; i += 2) out.push(((regs[i] << 16) | regs[i + 1]) | 0);
  return out;
}

export async function demo(host = '127.0.0.1', port = 502, out = console.log) {
  const c = await new ModbusClient(host, port).connect();
  try {
    const res = {};
    res.status = await c.readStatus();
    out('상태:', JSON.stringify(res.status));
    res.joints = await c.readJoints();
    out('관절(deg):', res.joints.map((v) => v.toFixed(3)).join(', '));
    res.pose = await c.readPose();
    out('TCP 자세:', res.pose.map((v) => v.toFixed(3)).join(', '));
    await c.writeCoil(0, true);
    res.di1 = (await c.readCoils(0, 1))[0];
    out('DI1 (코일 0) ON →', res.di1);
    res.do = await c.readDiscreteInputs(0, 16);
    out('DO1~16 (이산 입력 0~15):', res.do.map((v) => (v ? 1 : 0)).join(''));
    await c.setOverride(50);
    res.override = (await c.readHoldingRegisters(1, 1))[0];
    out('오버라이드 50% 쓰기 →', res.override);
    const why = async () => { const code = (await c.readInputRegisters(7, 1))[0]; return `거부 (사유 코드 ${code}${REJECT_TEXT[code] ? ': ' + REJECT_TEXT[code] : ''})`; };
    res.servoResult = await c.command(CMD.SERVO_ON);
    out('명령 서보 ON → 결과', res.servoResult === 0 ? '정상' : await why());
    res.startResult = await c.command(CMD.START);
    out('명령 시작 → 결과', res.startResult === 0 ? '정상' : await why());
    if (res.servoResult || res.startResult) out('  ※ 외부 명령은 REMOTE 모드에서만 허용됩니다. 에뮬레이터 화면 로봇 탭에서 모드를 REMOTE 로 바꾸고 다시 실행하십시오.');
    res.statusAfter = await c.readStatus();
    out('상태:', JSON.stringify(res.statusAfter));
    return res;
  } finally { c.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [host = '127.0.0.1', port = '502'] = process.argv.slice(2);
  demo(host, Number(port)).catch((e) => { console.error('오류:', e.message); process.exit(1); });
}
