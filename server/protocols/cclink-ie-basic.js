// Mitsubishi CC-Link IE Field Basic 슬레이브 에뮬레이션 — UDP 기본 포트 61450
//  - 한국·일본 공장(미쓰비시 iQ-R/iQ-F PLC) 연동용 경량 사이클릭 필드버스
//  - 프레임 헤더 (SLMP-like LE, 20바이트):
//      [0..1]   0x0057 (요청) / 0x00D7 (응답) — CC-Link IE Basic 서브헤더
//      [2..3]   command: 0x0001 NodeSearch, 0x0002 CyclicData
//      [4..5]   seqNo (u16LE)
//      [6..7]   stationNo (u16LE, 기본 1)
//      [8..9]   occupiedStations (u16LE, 1)
//      [10..11] errCode (u16LE, 0=OK)
//      [12..19] reserved
//  - CyclicData (0x0002):
//      요청 payload (72B): RY (8B = 64bit → 로봇 DI 1..64) + RWw (32 × i16LE → MB:0..31)
//      응답 payload (72B): RX (8B = 64bit ← 로봇 DO 1..64) + RWr (32 × i16LE ← 상태·오버라이드·알람·관절×100·MB:32..47)
import dgram from 'node:dgram';
import { makeLogger, progRunning } from './common.js';
import { alarmCodeNum } from './modbus-tcp.js';
import { hexOf } from './traffic.js';

const TAG = 'CCLINK-IE';
export const CCLINK_CMD = { NODE_SEARCH: 0x0001, CYCLIC_DATA: 0x0002 };

function bindUdp(sock, port, host) {
  return new Promise((resolve) => {
    const onErr = (error) => resolve({ error });
    sock.once('error', onErr);
    sock.bind(port, host || undefined, () => {
      sock.off('error', onErr);
      resolve({ port: sock.address().port });
    });
  });
}

export function buildPacket(isResp, cmd, seq, station, payload = Buffer.alloc(0), errCode = 0) {
  const h = Buffer.alloc(20);
  h.writeUInt16LE(isResp ? 0x00d7 : 0x0057, 0);
  h.writeUInt16LE(cmd, 2);
  h.writeUInt16LE(seq & 0xffff, 4);
  h.writeUInt16LE(station & 0xffff, 6);
  h.writeUInt16LE(1, 8);
  h.writeUInt16LE(errCode & 0xffff, 10);
  return Buffer.concat([h, payload]);
}

function buildCyclicResp(ctrl) {
  const b = Buffer.alloc(72); // 8B RX + 64B RWr (32 words)
  for (let i = 0; i < 64; i++) if (ctrl.getDO(i + 1)) b[i >> 3] |= 1 << (i & 7);
  let bits = 0;
  if (ctrl.servo) bits |= 1 << 0;
  if (progRunning(ctrl)) bits |= 1 << 1;
  if (ctrl.held) bits |= 1 << 2;
  if (ctrl.alarms?.length) bits |= 1 << 3;
  if (ctrl.segment || ctrl.jog) bits |= 1 << 4;
  if (ctrl.mode === 'REMOTE') bits |= 1 << 7;
  if (ctrl.estopActive) bits |= 1 << 11;
  b.writeUInt16LE(bits, 8);
  b.writeUInt16LE(Math.round(ctrl.override ?? 100), 10);
  b.writeUInt16LE(ctrl.alarms?.length ?? 0, 12);
  const lastA = ctrl.alarms?.length ? ctrl.alarms[ctrl.alarms.length - 1] : null;
  b.writeUInt16LE(lastA ? alarmCodeNum(lastA.vendorCode ?? lastA.code) : 0, 14);
  for (let i = 0; i < 6; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round((ctrl.joints[i] ?? 0) * 100)));
    b.writeInt16LE(v, 16 + i * 2);
  }
  for (let i = 0; i < 16; i++) {
    const v = ((Math.round(Number(ctrl.regs.get(`MB:${32 + i}`) || 0)) & 0xffff) << 16) >> 16;
    b.writeInt16LE(v, 40 + i * 2);
  }
  return b;
}

export async function start(ctrl, opts = {}) {
  const port = opts.port ?? 61450;
  const host = opts.host ?? '0.0.0.0';
  const station = opts.station ?? 1;
  const log = makeLogger(ctrl, TAG);
  const sock = dgram.createSocket('udp4');

  sock.on('message', async (msg, rinfo) => {
    const peer = `${rinfo.address}:${rinfo.port}`;
    if (msg.length < 20) return;
    const sub = msg.readUInt16LE(0);
    if (sub !== 0x0057) return;
    const cmd = msg.readUInt16LE(2);
    const seq = msg.readUInt16LE(4);
    const t0 = performance.now();
    if (await ctrl.traffic?.applyFault('cclinkIeBasic', peer, `cmd=0x${cmd.toString(16)}`)) return;

    let resp;
    if (cmd === CCLINK_CMD.NODE_SEARCH) {
      const meta = Buffer.alloc(40);
      meta.writeUInt16LE(0x0001, 0); // vendor
      meta.writeUInt32LE(0x00001001, 2); // model code
      meta.write(`RobotEmulator-${ctrl.robot.id}`.slice(0, 32), 8, 'ascii');
      resp = buildPacket(true, cmd, seq, station, meta);
      ctrl.traffic?.record('cclinkIeBasic', { client: peer, dir: 'req', summary: `NODE_SEARCH seq=${seq}`, ok: true, ms: performance.now() - t0 });
    } else if (cmd === CCLINK_CMD.CYCLIC_DATA) {
      const payload = msg.subarray(20);
      if (payload.length >= 8) {
        const batch = [];
        for (let i = 0; i < 64; i++) batch.push([i + 1, !!(payload[i >> 3] & (1 << (i & 7)))]);
        ctrl.setDIBatch(batch);
      }
      if (payload.length > 8) {
        const words = Math.min(32, Math.floor((payload.length - 8) / 2));
        for (let i = 0; i < words; i++) ctrl.regs.set(`MB:${i}`, payload.readInt16LE(8 + i * 2));
        ctrl.emitState();
      }
      resp = buildPacket(true, cmd, seq, station, buildCyclicResp(ctrl));
      ctrl.traffic?.record('cclinkIeBasic', { client: peer, dir: 'req', summary: `CYCLIC seq=${seq} (${payload.length}B)`, hex: hexOf(payload, 20), ok: true, ms: performance.now() - t0 });
    } else {
      resp = buildPacket(true, cmd, seq, station, Buffer.alloc(0), 0x4031);
    }
    sock.send(resp, rinfo.port, rinfo.address);
  });

  sock.on('error', (e) => log(`소켓 오류: ${e.message}`, true));
  const r = await bindUdp(sock, port, host);
  if (r.error) {
    ctrl.log('comm', `[${TAG}] UDP ${port} 바인딩 실패: ${r.error.message}`);
    try { sock.close(); } catch {}
    return { name: 'CC-Link IE Field Basic', proto: 'udp', port: null, close() {} };
  }
  ctrl.log('comm', `[${TAG}] CC-Link IE Field Basic 슬레이브 UDP ${r.port} 대기 (국번 ${station})`);
  return {
    name: 'CC-Link IE Field Basic', proto: 'udp', port: r.port,
    close() { try { sock.close(); } catch {} },
  };
}
