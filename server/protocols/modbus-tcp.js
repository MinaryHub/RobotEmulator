// Modbus TCP 서버 (외부 의존성 없음) — 기본 포트 502, 바인딩 실패 시 1502
//
// PLC/HMI/SCADA 가 로봇 에뮬레이터를 Modbus TCP 슬레이브(서버)로 접근하기 위한 인터페이스.
//  - MBAP 프레이밍 (TCP 조각/여러 프레임 합쳐 도착하는 경우 모두 처리), 다중 클라이언트
//  - Unit ID 는 무시하고 요청에 들어온 값을 그대로 응답에 사용
//  - 지원 기능 코드: 01 Read Coils, 02 Read Discrete Inputs, 03 Read Holding Registers,
//    04 Read Input Registers, 05 Write Single Coil, 06 Write Single Register,
//    15 Write Multiple Coils, 16 Write Multiple Registers, 23 Read/Write Multiple Registers
//  - 예외 응답: 01 ILLEGAL FUNCTION, 02 ILLEGAL DATA ADDRESS, 03 ILLEGAL DATA VALUE
//    (04 SERVER DEVICE FAILURE 는 내부 예외 시)
//
// 주소 맵 (모두 0 기준 프로토콜 주소. 5자리 표기 = 0xxxx/1xxxx/3xxxx/4xxxx 에서 +1)
//
//  ■ Coils (00001~) 0..511          ↔ 로봇 DI 1..512  (PLC 가 로봇 입력을 구동: 쓰기 = ctrl.setDI, 읽기 = ctrl.getDI)
//  ■ Discrete Inputs (10001~) 0..511 ← 로봇 DO 1..512  (읽기 전용)
//
//  ■ Input Registers (30001~, 읽기 전용, 16bit. 32bit 값은 2워드 상위 워드 먼저, 부호 있음 int32)
//     0      상태 비트: b0 서보 ON, b1 프로그램 실행 중(일시정지 포함), b2 HOLD, b3 알람 발생,
//            b4 이동 중, b5 TEACH, b6 PLAY, b7 REMOTE, b8 프로그램 정상 종료(done),
//            b9 프로그램 오류(error), b10 충돌 감지(ctrl.collision?.hit),
//            b11 비상정지 중, b12 안전 펜스 열림, b13 모드 인터록 ON, b14 시스템 I/O 사용 중
//     1      오버라이드 %
//     2      알람 개수
//     3      마지막 알람 코드 (숫자 코드면 그 값 & 0xFFFF, 문자열이면 16bit FNV 해시, 없으면 0)
//     4-5    프로그램 사이클 횟수 (u32)
//     6      제조사 코드 (1 Yaskawa, 2 Kawasaki, 3 Hyundai, 4 ABB, 5 KUKA, 6 Doosan) — 30..43 자세 형식 판별용
//     7      마지막 명령 거부 사유 코드 (server/controller.js REJECT: 1 REMOTE 아님, 2 REMOTE 에서 펜던트 조작,
//            3 비상정지, 4 펜스 열림, 5 인에이블 OFF, 6 알람, 7 서보 OFF, 8 모드 변경 불가, 9 프로그램 번호 미할당,
//            10 패리티 오류, 11 조그 모드, 12 실행 중 선택, 13 홀드 입력, 14 서보 OFF 입력), 거부 없으면 0
//     8      마지막으로 확정된 프로그램 번호 (시스템 I/O 스트로브, 없으면 0)
//     10..21 관절 J1..J6, int32 = deg × 1000 (J1 = 10-11, J2 = 12-13, ...)
//     30..43 TCP 자세 (ctrl.vendorPose(), 제조사 표현, 사용자 좌표계 적용) 7개 int32:
//            30-31 X, 32-33 Y, 34-35 Z  (mm × 1000)
//            36-37, 38-39, 40-41 : 각도 3개 (deg × 1000; Yaskawa/Hyundai Rx,Ry,Rz / KUKA A,B,C / Kawasaki O,A,T / Doosan A,B,C ZYZ)
//                                  ABB 는 q1,q2,q3 (× 1,000,000)
//            42-43 : ABB 는 q4 (× 1,000,000), 그 외 제조사는 0
//     50-51  마지막 사이클 시간 ms (u32, ctrl.cycleStats.last.total 초 → ms, 없으면 0)
//     52-53  현재 사이클 경과 ms (u32, ctrl.cycleStats.current.elapsed 초 → ms, 없으면 0)
//     60     그리퍼 위치 % (0 = 열림, 100 = 완전 닫힘)
//     61     공작물 파지 중 (1/0)
//     그 외 0..99 범위의 미사용 주소는 0 을 반환. 100 이상은 예외 02.
//
//  ■ Holding Registers (40001~, 읽기/쓰기)
//     0      명령 레지스터: 코드를 쓰면 한 번 실행. 1 서보 ON, 2 서보 OFF, 3 시작, 4 HOLD, 5 재개,
//            6 정지, 7 알람 리셋, 8 프로그램 리셋, 9 HOME 이동 (0 = 아무것도 안 함). 읽으면 마지막 명령 코드.
//            정의되지 않은 코드는 예외 03.
//     1      오버라이드 % (1~100)
//     2      마지막 명령 결과 (0 정상, 1 거부) — 읽기 전용 성격 (쓰기는 무시)
//     3..99  예약 (읽기 0, 쓰기 시 예외 02)
//     100..355 사용자 레지스터: ctrl.regs 의 'MB:<n>' (n = 주소 - 100, 0..255), 부호 있는 int16.
//            로봇 프로그램/다른 인터페이스와 값을 공유한다.
import net from 'node:net';
import { makeLogger, bindServer, startMove } from './common.js';

const TAG = 'MODBUS';
const NIO = 512;
const VENDOR_CODE = { yaskawa: 1, kawasaki: 2, hyundai: 3, abb: 4, kuka: 5, doosan: 6 };
export const COMMANDS = { 1: 'servoOn', 2: 'servoOff', 3: 'start', 4: 'hold', 5: 'resume', 6: 'stop', 7: 'resetAlarms', 8: 'resetProgram', 9: 'moveHome' };
export const IR_SIZE = 100;
export const HR_USER_BASE = 100;
export const HR_USER_COUNT = 256;

// 예외 코드
const EX_FUNC = 1, EX_ADDR = 2, EX_VALUE = 3, EX_FAIL = 4;
class MbEx extends Error { constructor(code, msg) { super(msg); this.code = code; } }

// ------------------------------------------------------------ 값 변환
const i32 = (v) => { v = Math.round(Number(v) || 0); return Math.max(-2147483648, Math.min(2147483647, v)); };
const u32 = (v) => { v = Math.round(Number(v) || 0); return Math.max(0, Math.min(0xFFFFFFFF, v)); };
const putI32 = (regs, at, v) => { const x = i32(v) >>> 0; regs[at] = (x >>> 16) & 0xFFFF; regs[at + 1] = x & 0xFFFF; };
const putU32 = (regs, at, v) => { const x = u32(v); regs[at] = Math.floor(x / 65536) & 0xFFFF; regs[at + 1] = x & 0xFFFF; };
const toInt16 = (v) => ((Math.round(Number(v) || 0) & 0xFFFF) << 16) >> 16;

// 알람 코드 → 16bit 숫자
export function alarmCodeNum(code) {
  if (code === undefined || code === null) return 0;
  if (typeof code === 'number' || /^\d+$/.test(String(code))) return Number(code) & 0xFFFF;
  let h = 0x811c9dc5;
  for (const ch of String(code)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return ((h >>> 16) ^ (h & 0xFFFF)) & 0xFFFF || 1;
}

// ------------------------------------------------------------ 입력 레지스터 이미지 생성
export function inputRegisters(ctrl) {
  const r = new Array(IR_SIZE).fill(0);
  const st = ctrl.vm?.status ?? 'idle';
  let bits = 0;
  if (ctrl.servo) bits |= 1 << 0;
  if (st === 'running' || st === 'paused') bits |= 1 << 1;
  if (ctrl.held) bits |= 1 << 2;
  if (ctrl.alarms?.length) bits |= 1 << 3;
  if (ctrl.segment || ctrl.jog) bits |= 1 << 4;
  if (ctrl.mode === 'TEACH') bits |= 1 << 5;
  if (ctrl.mode === 'PLAY') bits |= 1 << 6;
  if (ctrl.mode === 'REMOTE') bits |= 1 << 7;
  if (st === 'done') bits |= 1 << 8;
  if (st === 'error') bits |= 1 << 9;
  if (ctrl.collision?.hit) bits |= 1 << 10;
  if (ctrl.estopActive) bits |= 1 << 11;
  if (ctrl.safety?.fenceOpen) bits |= 1 << 12;
  if (ctrl.interlock) bits |= 1 << 13;
  if (ctrl.sysio?.enabled) bits |= 1 << 14;
  r[0] = bits;
  r[1] = Math.round(ctrl.override) & 0xFFFF;
  r[2] = (ctrl.alarms?.length ?? 0) & 0xFFFF;
  r[3] = ctrl.alarms?.length ? alarmCodeNum(ctrl.alarms[ctrl.alarms.length - 1].code) : 0;
  putU32(r, 4, ctrl.vm?.cycle ?? 0);
  r[6] = VENDOR_CODE[ctrl.vendor] ?? 0;
  r[7] = ctrl.lastReject?.code ?? 0;
  r[8] = (ctrl.sysio?.lastPgno ?? 0) & 0xFFFF;
  for (let i = 0; i < 6; i++) putI32(r, 10 + i * 2, (ctrl.joints[i] ?? 0) * 1000);
  let vp = [];
  try { vp = ctrl.vendorPose(); } catch {}
  const isAbb = ctrl.vendor === 'abb';
  for (let i = 0; i < 7; i++) {
    const v = vp[i] ?? 0;
    const scale = i < 3 ? 1000 : isAbb ? 1e6 : 1000;
    putI32(r, 30 + i * 2, i === 6 && !isAbb ? 0 : v * scale);
  }
  putU32(r, 50, (Number(ctrl.cycleStats?.last?.total) || 0) * 1000);
  putU32(r, 52, (Number(ctrl.cycleStats?.current?.elapsed) || 0) * 1000);
  r[60] = Math.round(Math.max(0, Math.min(1, Number(ctrl.grip?.pos) || 0)) * 100);
  r[61] = ctrl.grip?.holding ? 1 : 0;
  return r;
}

// ------------------------------------------------------------ 서버
export async function start(ctrl, opts = {}) {
  const port = opts.port ?? 502;
  const fallbackPort = opts.fallbackPort ?? 1502;
  const host = opts.host ?? '0.0.0.0';
  const log = makeLogger(ctrl, TAG);
  const state = { lastCmd: 0, lastResult: 0 };
  const sockets = new Set();

  // --- 명령 레지스터 실행 (0 = 정상, 1 = 거부)
  const runCommand = async (code) => {
    let ok = true;
    switch (code) {
      case 0: return 0;
      case 1: ok = ctrl.setServo(true) !== false; break;
      case 2: ctrl.setServo(false); break;
      case 3: ok = !ctrl.alarms.length && ctrl.servo && !!(await ctrl.start({ step: false })); break;
      case 4: {
        const active = ctrl.segment || ctrl.vm?.status === 'running' || ctrl.vm?.status === 'paused';
        if (active) ctrl.hold(); else ok = false;
        break;
      }
      case 5: ok = !!ctrl.held && ctrl.resume() !== false; break;
      case 6: ctrl.stopProgram(); break;
      case 7: ctrl.resetAlarms(); break;
      case 8: ctrl.resetProgram(); break;
      case 9: {
        if (!ctrl.servo || ctrl.alarms.length || ctrl.segment || ctrl.vm?.status === 'running') { ok = false; break; }
        const err = await startMove(ctrl, { kind: 'J', target: { joints: [...ctrl.robot.home] }, speed: { frac: 0.3 }, base: null }, log);
        ok = !err;
        break;
      }
      default: throw new MbEx(EX_VALUE, `알 수 없는 명령 코드 ${code}`);
    }
    log(`명령 ${code}(${COMMANDS[code]}) → ${ok ? '정상' : '거부'}`, true);
    return ok ? 0 : 1;
  };

  // --- 비트 영역
  const checkRange = (addr, qty, max, size) => {
    if (qty < 1 || qty > max) throw new MbEx(EX_VALUE, `수량 범위 오류 ${qty}`);
    if (addr + qty > size) throw new MbEx(EX_ADDR, `주소 범위 오류 ${addr}+${qty}`);
  };
  const packBits = (vals) => {
    const b = Buffer.alloc(Math.ceil(vals.length / 8));
    vals.forEach((v, i) => { if (v) b[i >> 3] |= 1 << (i & 7); });
    return b;
  };

  // --- 레지스터 영역
  const readHolding = (addr, qty) => {
    checkRange(addr, qty, 125, HR_USER_BASE + HR_USER_COUNT);
    const out = [];
    for (let a = addr; a < addr + qty; a++) {
      if (a === 0) out.push(state.lastCmd);
      else if (a === 1) out.push(Math.round(ctrl.override) & 0xFFFF);
      else if (a === 2) out.push(state.lastResult);
      else if (a >= HR_USER_BASE) out.push(toInt16(ctrl.regs.get(`MB:${a - HR_USER_BASE}`)) & 0xFFFF);
      else out.push(0);
    }
    return out;
  };
  // 쓰기 전 전체 주소 검증 → 일부만 쓰이는 일이 없도록
  const writeHolding = async (addr, vals) => {
    for (let a = addr; a < addr + vals.length; a++) {
      if (a >= 3 && a < HR_USER_BASE) throw new MbEx(EX_ADDR, `예약 주소 쓰기 ${a}`);
      if (a >= HR_USER_BASE + HR_USER_COUNT) throw new MbEx(EX_ADDR, `주소 범위 오류 ${a}`);
      if (a === 0 && !(vals[a - addr] in COMMANDS) && vals[a - addr] !== 0) throw new MbEx(EX_VALUE, `알 수 없는 명령 코드 ${vals[a - addr]}`);
    }
    let regsChanged = false;
    for (let a = addr; a < addr + vals.length; a++) {
      const v = vals[a - addr];
      if (a === 0) { state.lastCmd = v; state.lastResult = await runCommand(v); }
      else if (a === 1) ctrl.setOverride(Math.max(1, Math.min(100, v)));
      else if (a === 2) { /* 결과 레지스터: 쓰기 무시 */ }
      else { ctrl.regs.set(`MB:${a - HR_USER_BASE}`, toInt16(v)); regsChanged = true; }
    }
    if (regsChanged) ctrl.emitState();
  };

  // --- PDU 처리 → 응답 PDU
  const handlePdu = async (pdu) => {
    const fc = pdu[0];
    const need = (n) => { if (pdu.length < n) throw new MbEx(EX_VALUE, 'PDU 길이 부족'); };
    switch (fc) {
      case 1: case 2: {
        need(5);
        const addr = pdu.readUInt16BE(1), qty = pdu.readUInt16BE(3);
        checkRange(addr, qty, 2000, NIO);
        const vals = [];
        for (let i = 0; i < qty; i++) vals.push(fc === 1 ? ctrl.getDI(addr + i + 1) : ctrl.getDO(addr + i + 1));
        const b = packBits(vals);
        return Buffer.concat([Buffer.from([fc, b.length]), b]);
      }
      case 3: case 4: {
        need(5);
        const addr = pdu.readUInt16BE(1), qty = pdu.readUInt16BE(3);
        let vals;
        if (fc === 3) vals = readHolding(addr, qty);
        else { checkRange(addr, qty, 125, IR_SIZE); vals = inputRegisters(ctrl).slice(addr, addr + qty); }
        return regsResp(fc, vals);
      }
      case 5: {
        need(5);
        const addr = pdu.readUInt16BE(1), v = pdu.readUInt16BE(3);
        if (v !== 0xFF00 && v !== 0x0000) throw new MbEx(EX_VALUE, `코일 값 오류 0x${v.toString(16)}`);
        if (addr >= NIO) throw new MbEx(EX_ADDR, `코일 주소 범위 오류 ${addr}`);
        ctrl.setDI(addr + 1, v === 0xFF00);
        return Buffer.from(pdu.subarray(0, 5));
      }
      case 6: {
        need(5);
        const addr = pdu.readUInt16BE(1), v = pdu.readUInt16BE(3);
        if (addr >= HR_USER_BASE + HR_USER_COUNT) throw new MbEx(EX_ADDR, `주소 범위 오류 ${addr}`);
        await writeHolding(addr, [v]);
        return Buffer.from(pdu.subarray(0, 5));
      }
      case 15: {
        need(6);
        const addr = pdu.readUInt16BE(1), qty = pdu.readUInt16BE(3), bc = pdu[5];
        if (qty < 1 || qty > 1968 || bc !== Math.ceil(qty / 8) || pdu.length < 6 + bc) throw new MbEx(EX_VALUE, '수량/바이트 수 오류');
        if (addr + qty > NIO) throw new MbEx(EX_ADDR, `코일 주소 범위 오류 ${addr}+${qty}`);
        for (let i = 0; i < qty; i++) ctrl.setDI(addr + i + 1, !!(pdu[6 + (i >> 3)] & (1 << (i & 7))));
        return Buffer.from(pdu.subarray(0, 5));
      }
      case 16: {
        need(6);
        const addr = pdu.readUInt16BE(1), qty = pdu.readUInt16BE(3), bc = pdu[5];
        if (qty < 1 || qty > 123 || bc !== qty * 2 || pdu.length < 6 + bc) throw new MbEx(EX_VALUE, '수량/바이트 수 오류');
        if (addr + qty > HR_USER_BASE + HR_USER_COUNT) throw new MbEx(EX_ADDR, `주소 범위 오류 ${addr}+${qty}`);
        const vals = []; for (let i = 0; i < qty; i++) vals.push(pdu.readUInt16BE(6 + i * 2));
        await writeHolding(addr, vals);
        return Buffer.from(pdu.subarray(0, 5));
      }
      case 23: {
        need(10);
        const rAddr = pdu.readUInt16BE(1), rQty = pdu.readUInt16BE(3);
        const wAddr = pdu.readUInt16BE(5), wQty = pdu.readUInt16BE(7), bc = pdu[9];
        if (rQty < 1 || rQty > 125 || wQty < 1 || wQty > 121 || bc !== wQty * 2 || pdu.length < 10 + bc) throw new MbEx(EX_VALUE, '수량/바이트 수 오류');
        if (wAddr + wQty > HR_USER_BASE + HR_USER_COUNT || rAddr + rQty > HR_USER_BASE + HR_USER_COUNT) throw new MbEx(EX_ADDR, '주소 범위 오류');
        const vals = []; for (let i = 0; i < wQty; i++) vals.push(pdu.readUInt16BE(10 + i * 2));
        await writeHolding(wAddr, vals); // 규격: 쓰기 먼저, 읽기 나중
        return regsResp(fc, readHolding(rAddr, rQty));
      }
      default: throw new MbEx(EX_FUNC, `지원하지 않는 기능 코드 ${fc}`);
    }
  };
  const regsResp = (fc, vals) => {
    const b = Buffer.alloc(2 + vals.length * 2);
    b[0] = fc; b[1] = vals.length * 2;
    vals.forEach((v, i) => b.writeUInt16BE(v & 0xFFFF, 2 + i * 2));
    return b;
  };

  // --- TCP 연결: MBAP 프레이밍
  const server = net.createServer((sock) => {
    sockets.add(sock);
    const peer = `${sock.remoteAddress}:${sock.remotePort}`;
    log(`클라이언트 접속 ${peer}`, true);
    let buf = Buffer.alloc(0);
    let chain = Promise.resolve(); // 연결별 요청 순차 처리
    sock.setNoDelay(true);
    sock.on('data', (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= 7) {
        const tid = buf.readUInt16BE(0), pid = buf.readUInt16BE(2), len = buf.readUInt16BE(4), unit = buf[6];
        if (len < 2 || len > 254) { log(`잘못된 MBAP 길이 ${len} — 연결 종료 (${peer})`, true); sock.destroy(); return; }
        if (buf.length < 6 + len) break;
        const pdu = Buffer.from(buf.subarray(7, 6 + len));
        buf = buf.subarray(6 + len);
        if (pid !== 0) { log(`프로토콜 ID ${pid} != 0 — 무시`); continue; }
        chain = chain.then(async () => {
          let resp;
          try { resp = await handlePdu(pdu); }
          catch (e) {
            const code = e instanceof MbEx ? e.code : EX_FAIL;
            log(`FC${pdu[0]} 예외 ${String(code).padStart(2, '0')}: ${e.message}`);
            resp = Buffer.from([(pdu[0] | 0x80) & 0xFF, code]);
          }
          const h = Buffer.alloc(7);
          h.writeUInt16BE(tid, 0); h.writeUInt16BE(0, 2); h.writeUInt16BE(resp.length + 1, 4); h[6] = unit;
          if (!sock.destroyed) sock.write(Buffer.concat([h, resp]));
        });
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => { sockets.delete(sock); log(`클라이언트 종료 ${peer}`, true); });
  });

  let r = await bindServer(server, port, host);
  let bound = r.error ? null : r.port;
  if (r.error) {
    ctrl.log('comm', `[${TAG}] TCP ${port} 바인딩 실패: ${r.error.message} — 대체 포트 ${fallbackPort} 시도`);
    if (fallbackPort && fallbackPort !== port) {
      r = await bindServer(server, fallbackPort, host);
      if (r.error) ctrl.log('comm', `[${TAG}] TCP ${fallbackPort} 바인딩 실패: ${r.error.message}`);
      else bound = r.port;
    }
  }
  if (bound) ctrl.log('comm', `[${TAG}] Modbus TCP 서버 ${bound} 대기 (Unit ID 무시)`);
  return {
    name: 'Modbus TCP Server', proto: 'tcp',
    port: bound,
    close() { for (const s of sockets) s.destroy(); try { server.close(); } catch {} },
  };
}
