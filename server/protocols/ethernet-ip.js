// EtherNet/IP CIP Encapsulation TCP 어댑터 — 기본 포트 44818
//  - Rockwell ControlLogix/CompactLogix, Omron NJ/NX, Keyence KV 등 PLC 연동용
//  - 지원 Encapsulation 명령:
//      0x0004 ListServices
//      0x0063 ListIdentity
//      0x0065 RegisterSession / 0x0066 UnregisterSession
//      0x006F SendRRData (UCMM CIP Explicit Messaging)
//  - CIP 객체:
//      Class 0x01 (Identity), Instance 1 — Get Attribute Single / All
//      Class 0x04 (Assembly):
//        Instance 100 (Input Assembly, Robot→PLC, 64B):
//          [0..1]   statusBits (u16LE)    [2..3] override (u16LE)
//          [4..5]   alarmCount (u16LE)    [6..7] alarmCode (u16LE)
//          [8..15]  DO 1..64 (8B bitmask)
//          [16..39] J1..J6 (6 × f32LE deg)
//          [40..63] MB:0..11 (12 × i16LE)
//        Instance 150 (Output Assembly, PLC→Robot, 64B):
//          [0..1]   cmd (u16LE: 1 servoOn, 2 servoOff, 3 start, 4 hold, 5 resume, 6 stop, 7 resetAlarms)
//          [2..3]   override (u16LE: 1..100, 0=유지)
//          [4..7]   reserved
//          [8..15]  DI 1..64 (8B bitmask)
//          [16..63] MB:16..39 (24 × i16LE)
import net from 'node:net';
import { makeLogger, bindServer, progRunning } from './common.js';
import { alarmCodeNum } from './modbus-tcp.js';
import { peerOf, hexOf } from './traffic.js';

const TAG = 'ETHERNET-IP';
export const EIP_CMD = {
  LIST_SERVICES: 0x0004,
  LIST_IDENTITY: 0x0063,
  REGISTER_SESSION: 0x0065,
  UNREGISTER_SESSION: 0x0066,
  SEND_RR_DATA: 0x006f,
};
export const CIP_SVC = {
  GET_ATTR_ALL: 0x01,
  GET_ATTR_SINGLE: 0x0e,
  SET_ATTR_SINGLE: 0x10,
};

function encapHeader(cmd, len, session, status, ctx) {
  const h = Buffer.alloc(24);
  h.writeUInt16LE(cmd, 0);
  h.writeUInt16LE(len, 2);
  h.writeUInt32LE(session >>> 0, 4);
  h.writeUInt32LE(status >>> 0, 8);
  if (ctx && ctx.length >= 8) ctx.copy(h, 12, 0, 8);
  h.writeUInt32LE(0, 20);
  return h;
}

export function buildEncap(cmd, payload = Buffer.alloc(0), session = 0, ctx = Buffer.alloc(8), status = 0) {
  return Buffer.concat([encapHeader(cmd, payload.length, session, status, ctx), payload]);
}

function buildInputAssembly(ctrl) {
  const b = Buffer.alloc(64);
  const st = ctrl.vm?.status ?? 'idle';
  let bits = 0;
  if (ctrl.servo) bits |= 1 << 0;
  if (progRunning(ctrl)) bits |= 1 << 1;
  if (ctrl.held) bits |= 1 << 2;
  if (ctrl.alarms?.length) bits |= 1 << 3;
  if (ctrl.segment || ctrl.jog) bits |= 1 << 4;
  if (ctrl.mode === 'REMOTE') bits |= 1 << 7;
  if (st === 'done') bits |= 1 << 8;
  if (ctrl.estopActive) bits |= 1 << 11;
  b.writeUInt16LE(bits, 0);
  b.writeUInt16LE(Math.round(ctrl.override ?? 100), 2);
  b.writeUInt16LE(ctrl.alarms?.length ?? 0, 4);
  const lastA = ctrl.alarms?.length ? ctrl.alarms[ctrl.alarms.length - 1] : null;
  b.writeUInt16LE(lastA ? alarmCodeNum(lastA.vendorCode ?? lastA.code) : 0, 6);
  for (let i = 0; i < 64; i++) {
    if (ctrl.getDO(i + 1)) b[8 + (i >> 3)] |= 1 << (i & 7);
  }
  for (let i = 0; i < 6; i++) b.writeFloatLE(Number(ctrl.joints[i] ?? 0), 16 + i * 4);
  for (let i = 0; i < 12; i++) {
    const v = ((Math.round(Number(ctrl.regs.get(`MB:${i}`) || 0)) & 0xffff) << 16) >> 16;
    b.writeInt16LE(v, 40 + i * 2);
  }
  return b;
}

async function applyOutputAssembly(ctrl, data, outShadow, log) {
  const len = Math.min(64, data.length);
  data.copy(outShadow, 0, 0, len);
  if (len >= 2) {
    const cmd = data.readUInt16LE(0);
    if (cmd === 1) ctrl.setServo(true);
    else if (cmd === 2) ctrl.setServo(false);
    else if (cmd === 3) await ctrl.start({ step: false });
    else if (cmd === 4) ctrl.hold();
    else if (cmd === 5) ctrl.resume();
    else if (cmd === 6) ctrl.stopProgram();
    else if (cmd === 7) ctrl.resetAlarms();
    if (cmd) log(`Output Assembly 명령=${cmd}`, true);
  }
  if (len >= 4) {
    const ov = data.readUInt16LE(2);
    if (ov >= 1 && ov <= 100) ctrl.setOverride(ov);
  }
  if (len >= 16) {
    const batch = [];
    for (let i = 0; i < 64; i++) batch.push([i + 1, !!(data[8 + (i >> 3)] & (1 << (i & 7)))]);
    ctrl.setDIBatch(batch);
  }
  if (len > 16) {
    const nRegs = Math.min(24, Math.floor((len - 16) / 2));
    for (let i = 0; i < nRegs; i++) ctrl.regs.set(`MB:${16 + i}`, data.readInt16LE(16 + i * 2));
    ctrl.emitState();
  }
}

// CIP EPATH 파싱 (8-bit Logical Segments: Class 0x20, Instance 0x24, Attribute 0x30)
function parseEpath(buf) {
  const res = { cls: null, inst: null, attr: null };
  let i = 0;
  while (i < buf.length) {
    const seg = buf[i++];
    if (seg === 0x20 && i < buf.length) res.cls = buf[i++];
    else if (seg === 0x21 && i + 2 <= buf.length) { i++; res.cls = buf.readUInt16LE(i); i += 2; }
    else if (seg === 0x24 && i < buf.length) res.inst = buf[i++];
    else if (seg === 0x25 && i + 2 <= buf.length) { i++; res.inst = buf.readUInt16LE(i); i += 2; }
    else if (seg === 0x30 && i < buf.length) res.attr = buf[i++];
    else if (seg === 0x31 && i + 2 <= buf.length) { i++; res.attr = buf.readUInt16LE(i); i += 2; }
    else break;
  }
  return res;
}

export async function start(ctrl, opts = {}) {
  const port = opts.port ?? 44818;
  const host = opts.host ?? '0.0.0.0';
  const log = makeLogger(ctrl, TAG);
  const sockets = new Set();
  const outShadow = Buffer.alloc(64);
  let nextSession = 1;

  const cipReply = (svc, status, data = Buffer.alloc(0)) => {
    const h = Buffer.from([(svc | 0x80) & 0xff, 0x00, status & 0xff, 0x00]);
    return Buffer.concat([h, data]);
  };

  const handleCip = async (cipBuf) => {
    if (cipBuf.length < 2) return cipReply(0, 0x13);
    const svc = cipBuf[0];
    const pathWords = cipBuf[1];
    const pathLen = pathWords * 2;
    if (cipBuf.length < 2 + pathLen) return cipReply(svc, 0x13);
    const path = parseEpath(cipBuf.subarray(2, 2 + pathLen));
    const reqData = cipBuf.subarray(2 + pathLen);

    // Identity Object (0x01)
    if (path.cls === 0x01 && path.inst === 1) {
      const prod = Buffer.from(`RobotEmulator (${ctrl.robot.name})`.slice(0, 32), 'utf8');
      if (svc === CIP_SVC.GET_ATTR_SINGLE) {
        if (path.attr === 1) { const b = Buffer.alloc(2); b.writeUInt16LE(0x0001, 0); return cipReply(svc, 0, b); }
        if (path.attr === 7) return cipReply(svc, 0, Buffer.concat([Buffer.from([prod.length]), prod]));
        return cipReply(svc, 0x14);
      }
      if (svc === CIP_SVC.GET_ATTR_ALL) {
        const b = Buffer.alloc(14);
        b.writeUInt16LE(1, 0); b.writeUInt16LE(0x0c, 2); b.writeUInt16LE(1, 4);
        b[6] = 1; b[7] = 5; b.writeUInt16LE(0x0060, 8); b.writeUInt32LE(0x12345678, 10);
        return cipReply(svc, 0, Buffer.concat([b, Buffer.from([prod.length]), prod]));
      }
      return cipReply(svc, 0x08);
    }

    // Assembly Object (0x04)
    if (path.cls === 0x04) {
      if (svc === CIP_SVC.GET_ATTR_SINGLE && path.attr === 3) {
        if (path.inst === 100) return cipReply(svc, 0, buildInputAssembly(ctrl));
        if (path.inst === 150) return cipReply(svc, 0, Buffer.from(outShadow));
        return cipReply(svc, 0x05);
      }
      if (svc === CIP_SVC.SET_ATTR_SINGLE && path.attr === 3) {
        if (path.inst === 150) {
          await applyOutputAssembly(ctrl, reqData, outShadow, log);
          return cipReply(svc, 0);
        }
        return cipReply(svc, 0x0e); // Input Assembly 100 is read-only
      }
      return cipReply(svc, 0x08);
    }
    return cipReply(svc, 0x05);
  };

  const server = net.createServer((sock) => {
    const peer = peerOf(sock);
    if (sockets.size >= 32) { sock.destroy(); return; }
    sockets.add(sock);
    ctrl.traffic?.connect('ethernetIp', peer);
    log(`클라이언트 접속 ${peer}`, true);
    let session = 0;
    let buf = Buffer.alloc(0);
    let chain = Promise.resolve();
    sock.setNoDelay(true);
    sock.setTimeout(120_000, () => sock.destroy());

    const handleFrame = async (cmd, sessId, ctx, payload) => {
      const t0 = performance.now();
      if (await ctrl.traffic?.applyFault('ethernetIp', peer, `cmd=0x${cmd.toString(16)}`)) return;
      switch (cmd) {
        case EIP_CMD.LIST_SERVICES: {
          const itemData = Buffer.alloc(20);
          itemData.writeUInt16LE(1, 0); // version
          itemData.writeUInt16LE(0x0120, 2); // TCP + UDP capability
          itemData.write('Communications', 4, 'ascii');
          const cpf = Buffer.alloc(6);
          cpf.writeUInt16LE(1, 0); cpf.writeUInt16LE(0x0100, 2); cpf.writeUInt16LE(itemData.length, 4);
          sock.write(buildEncap(cmd, Buffer.concat([cpf, itemData]), 0, ctx));
          break;
        }
        case EIP_CMD.LIST_IDENTITY: {
          const name = Buffer.from(`RobotEmulator EIP (${ctrl.robot.name})`.slice(0, 32), 'utf8');
          const item = Buffer.alloc(34 + name.length);
          item.writeUInt16LE(1, 0);
          item.writeUInt16LE(2, 2); // AF_INET
          item.writeUInt16BE(port, 4);
          item[6] = 127; item[7] = 0; item[8] = 0; item[9] = 1;
          item.writeUInt16LE(1, 18); // vendor
          item.writeUInt16LE(0x0c, 20); // comms adapter
          item.writeUInt16LE(1, 22);
          item[24] = 1; item[25] = 5;
          item.writeUInt16LE(0x0060, 26);
          item.writeUInt32LE(0x12345678, 28);
          item[32] = name.length;
          name.copy(item, 33);
          item[33 + name.length] = 0;
          const cpf = Buffer.alloc(6);
          cpf.writeUInt16LE(1, 0); cpf.writeUInt16LE(0x000c, 2); cpf.writeUInt16LE(item.length, 4);
          sock.write(buildEncap(cmd, Buffer.concat([cpf, item]), 0, ctx));
          break;
        }
        case EIP_CMD.REGISTER_SESSION: {
          session = nextSession++;
          const body = Buffer.alloc(4);
          body.writeUInt16LE(1, 0); body.writeUInt16LE(0, 2);
          sock.write(buildEncap(cmd, body, session, ctx));
          ctrl.traffic?.record('ethernetIp', { client: peer, dir: 'req', summary: `REGISTER_SESSION #${session}`, ok: true, ms: performance.now() - t0 });
          break;
        }
        case EIP_CMD.UNREGISTER_SESSION: {
          session = 0;
          sock.end();
          break;
        }
        case EIP_CMD.SEND_RR_DATA: {
          if (payload.length < 8) { sock.write(buildEncap(cmd, Buffer.alloc(0), sessId, ctx, 0x0069)); break; }
          const itemCount = payload.readUInt16LE(6);
          let off = 8, cipReq = null;
          for (let i = 0; i < itemCount && off + 4 <= payload.length; i++) {
            const typeId = payload.readUInt16LE(off);
            const itemLen = payload.readUInt16LE(off + 2);
            off += 4;
            if (typeId === 0x00b2 && off + itemLen <= payload.length) cipReq = payload.subarray(off, off + itemLen);
            off += itemLen;
          }
          const cipResp = cipReq ? await handleCip(cipReq) : cipReply(0, 0x13);
          const hdr = Buffer.alloc(16);
          hdr.writeUInt32LE(0, 0); // interface handle
          hdr.writeUInt16LE(0, 4); // timeout
          hdr.writeUInt16LE(2, 6); // 2 CPF items
          hdr.writeUInt16LE(0x0000, 8); hdr.writeUInt16LE(0, 10); // Null Address
          hdr.writeUInt16LE(0x00b2, 12); hdr.writeUInt16LE(cipResp.length, 14);
          sock.write(buildEncap(cmd, Buffer.concat([hdr, cipResp]), sessId || session, ctx));
          const ok = cipResp[2] === 0;
          ctrl.traffic?.record('ethernetIp', {
            client: peer, dir: 'req',
            summary: `CIP svc=0x${(cipReq?.[0] ?? 0).toString(16)} → st=0x${cipResp[2].toString(16)}`,
            hex: hexOf(cipReq || Buffer.alloc(0), 20), ok, error: ok ? null : `CIP 0x${cipResp[2].toString(16)}`, ms: performance.now() - t0,
          });
          break;
        }
        default:
          sock.write(buildEncap(cmd, Buffer.alloc(0), sessId, ctx, 0x0001));
      }
    };

    sock.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= 24) {
        const cmd = buf.readUInt16LE(0);
        const len = buf.readUInt16LE(2);
        if (len > 4096) { sock.destroy(); return; }
        if (buf.length < 24 + len) break;
        const sessId = buf.readUInt32LE(4);
        const ctx = Buffer.from(buf.subarray(12, 20));
        const payload = Buffer.from(buf.subarray(24, 24 + len));
        buf = buf.subarray(24 + len);
        chain = chain.then(() => handleFrame(cmd, sessId, ctx, payload));
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => { sockets.delete(sock); ctrl.traffic?.disconnect('ethernetIp', peer); log(`클라이언트 종료 ${peer}`, true); });
  });

  const r = await bindServer(server, port, host);
  if (r.error) {
    ctrl.log('comm', `[${TAG}] TCP ${port} 바인딩 실패: ${r.error.message}`);
    return { name: 'EtherNet/IP (CIP)', proto: 'tcp', port: null, close() {} };
  }
  ctrl.log('comm', `[${TAG}] EtherNet/IP 어댑터 TCP ${r.port} 대기 (Assembly 100/150)`);
  return {
    name: 'EtherNet/IP (CIP)', proto: 'tcp', port: r.port,
    close() { for (const s of sockets) s.destroy(); sockets.clear(); try { server.close(); } catch {} },
  };
}
