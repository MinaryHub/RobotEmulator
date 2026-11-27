// Yaskawa YRC1000 / DX200 / FS100 High-Speed Ethernet Server (HSE) 에뮬레이션 — UDP
//  - 10040: 로봇 제어 (처리 구분 1), 10041: 파일 제어 (처리 구분 2)
//
// 패킷 헤더 (32 바이트, 리틀엔디언)
//   0  "YERC"                 4  헤더 크기 u16 (=0x20)    6  데이터 크기 u16
//   8  예약1 (=3)              9  처리 구분 (1 로봇제어 / 2 파일제어)
//   10 ACK (0 요청 / 1 응답)   11 요청 ID                 12 블록 번호 u32
//   16 예약2 "99999999" (8)
//   요청: 24 명령번호 u16, 26 인스턴스 u16, 28 속성 u8, 29 서비스 u8, 30 패딩 u16
//   응답: 24 서비스|0x80, 25 상태 u8, 26 부가상태 크기 u8, 27 패딩, 28 부가상태 u16, 30 패딩 u16
//
// 명령 번호는 YRC1000 HSE 매뉴얼 기준:
//   0x70 알람, 0x71 알람 이력, 0x72 상태, 0x73 실행 잡 정보, 0x74 축 구성, 0x75 위치,
//   0x76 위치 편차, 0x77 토크, 0x78 IO, 0x79 레지스터, 0x7A B, 0x7B I, 0x7C D, 0x7D R, 0x7E S,
//   0x7F P, 0x80 BP, 0x81 EX, 0x82 알람리셋/에러취소, 0x83 HOLD/서보/HLOCK, 0x84 사이클 전환,
//   0x85 펜던트 문자 표시, 0x86 기동, 0x87 잡 선택, 0x88 관리 시간, 0x89 시스템 정보,
//   0x8A 이동(직교), 0x8B 이동(펄스), 0x300~0x306 복수 IO/레지스터/B/I/D/R/S
import dgram from 'node:dgram';
import { RfromZYX, poseMul } from '../../shared/math.js';
import { makeLogger, bindServer, baseTcp, toVendorPose, fromVendorPose, startMove, busy, progRunning, findFile, makeCycleRunner } from './common.js';
import { hexOf } from './traffic.js';

const TAG = 'YASKAWA-HSE';
const HDR = 32;

// 서비스 코드
const SVC = { GET_ALL: 0x01, SET_ALL: 0x02, GET_ONE: 0x0e, SET_ONE: 0x10, GET_MULTI: 0x33, SET_MULTI: 0x34 };
// 상태/부가상태 코드
const ST = { OK: 0x00, UNDEF_CMD: 0x08, BAD_ATTR: 0x09, BAD_INST: 0x28, ERR: 0x1f };
const AS = {
  OPERATING: 0x2010, HOLD_PP: 0x2020, HOLD_EXT: 0x2040, HOLD_CMD: 0x2050, ALARM: 0x2060, SERVO_OFF: 0x2070,
  BAD_MODE: 0x2080, NO_DATA: 0x2110, CANT_LOAD: 0x2120, SERVO_ON_FAIL: 0x3450, TURN_SERVO_ON: 0x3010,
  JOB_NOT_FOUND: 0x4040, UNREACHABLE: 0x5200, UNDEF: 0xa000, INSTANCE: 0xa001, ATTR: 0xa002, SIZE: 0xb002, RANGE: 0xb008,
  FILE_NOT_FOUND: 0xe2a7,
};

const DEFAULT_PPD = [1000, 1000, 1000, 800, 800, 500];
const ppd = (ctrl) => ctrl.robot.pulsePerDeg || DEFAULT_PPD;
const deg2pulse = (ctrl, j) => j.map((v, i) => Math.round(v * ppd(ctrl)[i]));
const pulse2deg = (ctrl, p) => p.slice(0, 6).map((v, i) => v / ppd(ctrl)[i]);

// 알람 코드 → 숫자 (YRC 는 4자리 숫자 코드)
const ALARM_MAP = { SERVO_OFF: 4100, ALARM: 4101, UNREACHABLE: 4674, PROGRAM: 4416, LIMIT: 4423, COLLISION: 4315 };
const alarmNo = (code) => (/^\d+$/.test(String(code)) ? Number(code) : ALARM_MAP[code] ?? 4000 + ([...String(code)].reduce((a, c) => a + c.charCodeAt(0), 0) % 900));

const fmtTime = (t) => {
  const d = new Date(t), z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${z(d.getMonth() + 1)}/${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
};

function strBuf(s, n) {
  const b = Buffer.alloc(n);
  b.write(String(s ?? ''), 0, n, 'latin1');
  return b;
}
const bufStr = (b) => b.toString('latin1').replace(/\0.*$/s, '').trim();
const i32s = (arr) => { const b = Buffer.alloc(arr.length * 4); arr.forEach((v, i) => b.writeInt32LE(Math.round(v) | 0, i * 4)); return b; };

class HseError extends Error {
  constructor(added, status = ST.ERR, msg = '') { super(msg || `HSE 오류 0x${added.toString(16)}`); this.added = added; this.status = status; }
}

export function buildPacket({ division, ack, reqId, block = 0, sub, data = Buffer.alloc(0) }) {
  const h = Buffer.alloc(HDR);
  h.write('YERC', 0, 'ascii');
  h.writeUInt16LE(HDR, 4);
  h.writeUInt16LE(data.length, 6);
  h.writeUInt8(3, 8);
  h.writeUInt8(division, 9);
  h.writeUInt8(ack, 10);
  h.writeUInt8(reqId & 0xff, 11);
  h.writeUInt32LE(block >>> 0, 12);
  h.write('99999999', 16, 'ascii');
  sub.copy(h, 24);
  return Buffer.concat([h, data]);
}

export function parsePacket(buf) {
  if (buf.length < HDR || buf.toString('ascii', 0, 4) !== 'YERC') return null;
  const hdrSize = buf.readUInt16LE(4);
  const dataSize = buf.readUInt16LE(6);
  if (hdrSize !== HDR || buf.length < HDR + dataSize) return null;
  return {
    division: buf[9], ack: buf[10], reqId: buf[11], block: buf.readUInt32LE(12),
    cmd: buf.readUInt16LE(24), instance: buf.readUInt16LE(26), attribute: buf[28], service: buf[29],
    // 응답 해석용
    rService: buf[24], status: buf[25], addedSize: buf[26], added: buf.readUInt16LE(28),
    data: buf.subarray(HDR, HDR + dataSize),
  };
}

const respSub = (service, status = 0, added = 0) => {
  const s = Buffer.alloc(8);
  s[0] = (service | 0x80) & 0xff;
  s[1] = status;
  s[2] = added ? 2 : 0;
  s.writeUInt16LE(added, 4);
  return s;
};

export async function start(ctrl, opts = {}) {
  const port = opts.port ?? 10040;
  const filePort = opts.filePort ?? 10041;
  const host = opts.host ?? '0.0.0.0';
  const log = makeLogger(ctrl, TAG);

  // 컨트롤러 측 부가 상태
  const st = { cmdHold: false, hlock: false, cycleMode: 3 /* 1 step, 2 one cycle, 3 continuous */ };
  const cycles = makeCycleRunner(ctrl, log);
  const history = []; // 알람 이력 (최근 먼저)
  const onLog = (e) => {
    if (e.src !== 'alarm') return;
    const a = ctrl.alarms[ctrl.alarms.length - 1];
    if (a) { history.unshift(a); if (history.length > 100) history.pop(); }
  };
  ctrl.on('log', onLog);

  // ------------------------------------------------------------ 변수 접근
  const regGet = (k, def) => (ctrl.regs.has(k) ? ctrl.regs.get(k) : def);
  const regSet = (k, v) => { ctrl.regs.set(k, v); ctrl.emitState(); };

  // P 변수 / 위치 13 x int32 인코딩
  const encodePos = (val) => {
    // val: {kind:'pose'|'joints', v, tool?, user?, form?, type?}
    if (!val) return i32s(new Array(13).fill(0));
    if (val.kind === 'joints') {
      const p = deg2pulse(ctrl, val.v);
      return i32s([0, val.form ?? 0, val.tool ?? 0, val.user ?? 0, 0, ...p, 0, 0].slice(0, 13));
    }
    const v = val.v;
    return i32s([val.type ?? 16, val.form ?? 0, val.tool ?? 0, val.user ?? 0, 0,
      v[0] * 1000, v[1] * 1000, v[2] * 1000, v[3] * 10000, v[4] * 10000, v[5] * 10000, 0, 0]);
  };
  const decodePos = (d) => {
    if (d.length < 52) throw new HseError(AS.SIZE);
    const a = []; for (let i = 0; i < 13; i++) a.push(d.readInt32LE(i * 4));
    const [type, form, tool, user] = a;
    if (type === 0) return { kind: 'joints', v: pulse2deg(ctrl, a.slice(5, 11)), form, tool, user };
    return { kind: 'pose', v: [a[5] / 1000, a[6] / 1000, a[7] / 1000, a[8] / 10000, a[9] / 10000, a[10] / 10000], type, form, tool, user };
  };

  // 형태(figure) 비트: bit0 후방, bit1 하완(Lower arm), bit2 Flip, bit3 R≥180, bit4 T≥180, bit5 S≥180
  const formOf = (j) => (j[4] < 0 ? 0 : 4) | (Math.abs(j[3]) >= 180 ? 8 : 0) | (Math.abs(j[5]) >= 180 ? 16 : 0) | (Math.abs(j[0]) >= 180 ? 32 : 0);

  const curPos = (instance) => {
    if (instance >= 1 && instance <= 8) return { kind: 'joints', v: ctrl.joints, form: formOf(ctrl.joints) };
    if (instance >= 101 && instance <= 108) {
      return { kind: 'pose', v: toVendorPose('yaskawa', baseTcp(ctrl)), type: 16, form: formOf(ctrl.joints) };
    }
    throw new HseError(AS.INSTANCE, ST.BAD_INST);
  };

  // ------------------------------------------------------------ 상태 데이터
  const statusData = () => {
    const running = progRunning(ctrl) && !ctrl.held || !!ctrl.segment;
    let d1 = 0;
    if (st.cycleMode === 1) d1 |= 1; else if (st.cycleMode === 2) d1 |= 2; else d1 |= 4;
    if (running) d1 |= 8;
    if (ctrl.mode === 'TEACH') d1 |= 0x20; else d1 |= 0x40;
    if (ctrl.mode === 'REMOTE') d1 |= 0x80;
    let d2 = 0;
    if (ctrl.held && !st.cmdHold) d2 |= 0x02;
    if (st.cmdHold) d2 |= 0x08;
    if (ctrl.alarms.length) d2 |= 0x10;
    if (ctrl.compileError) d2 |= 0x20;
    if (ctrl.servo) d2 |= 0x40;
    return [d1, d2];
  };

  const jobName = () => (ctrl.main ? ctrl.main.replace(/\.JBI$/i, '') : '');

  // ------------------------------------------------------------ 단일 값 변수 (B/I/D/R/S/레지스터)
  const VARS = {
    0x79: { key: 'REG', size: 2, rd: (b, o) => b.readUInt16LE(o), wr: (b, v, o) => b.writeUInt16LE(Number(v) & 0xffff, o), max: 999 },
    0x7a: { key: 'B', size: 1, rd: (b, o) => b.readUInt8(o), wr: (b, v, o) => b.writeUInt8(Number(v) & 0xff, o), max: 999 },
    0x7b: { key: 'I', size: 2, rd: (b, o) => b.readInt16LE(o), wr: (b, v, o) => b.writeInt16LE(((Number(v) << 16) >> 16), o), max: 999 },
    0x7c: { key: 'D', size: 4, rd: (b, o) => b.readInt32LE(o), wr: (b, v, o) => b.writeInt32LE(Number(v) | 0, o), max: 999 },
    0x7d: { key: 'R', size: 4, rd: (b, o) => b.readFloatLE(o), wr: (b, v, o) => b.writeFloatLE(Number(v) || 0, o), max: 999 },
    0x7e: { key: 'S', size: 16, rd: (b, o) => bufStr(b.subarray(o, o + 16)), wr: (b, v, o) => strBuf(v, 16).copy(b, o), max: 999 },
  };
  const MULTI = { 0x300: 'IO', 0x301: 0x79, 0x302: 0x7a, 0x303: 0x7b, 0x304: 0x7c, 0x305: 0x7d, 0x306: 0x7e };

  // ------------------------------------------------------------ IO
  // 인스턴스 = 논리 IO 번호/10 : 1~512 범용입력(IN#), 1001~1512 범용출력(OT#), 2001~ 외부입력,
  //   2701~2956 네트워크 입력(쓰기 가능). 10000 이상이면 논리번호(예: 10010)로 보고 /10.
  const ioRef = (inst) => {
    if (inst >= 10000) inst = Math.floor(inst / 10);
    if (inst >= 1 && inst <= 512) return { type: 'di', base: (inst - 1) * 8 + 1, writable: false };
    if (inst >= 1001 && inst <= 1512) return { type: 'do', base: (inst - 1001) * 8 + 1, writable: true };
    if (inst >= 2701 && inst <= 2956) return { type: 'di', base: (inst - 2701) * 8 + 1, writable: true };
    if (inst >= 2001 && inst <= 2512) return { type: 'di', base: (inst - 2001) * 8 + 1, writable: false };
    if (inst >= 3001 && inst <= 3512) return { type: 'do', base: (inst - 3001) * 8 + 1, writable: false };
    throw new HseError(AS.INSTANCE, ST.BAD_INST);
  };
  const ioRead = (inst) => {
    const r = ioRef(inst);
    let byte = 0;
    for (let b = 0; b < 8; b++) {
      const n = r.base + b;
      if (n <= 512 && (r.type === 'do' ? ctrl.getDO(n) : ctrl.getDI(n))) byte |= 1 << b;
    }
    return byte;
  };
  const ioWrite = (inst, byte) => {
    const r = ioRef(inst);
    if (!r.writable) throw new HseError(AS.NO_DATA);
    for (let b = 0; b < 8; b++) {
      const n = r.base + b;
      if (n > 512) break;
      const v = !!(byte & (1 << b));
      if (r.type === 'do') ctrl.setDO(n, v); else ctrl.setDI(n, v);
    }
  };

  // ------------------------------------------------------------ 이동 명령
  const checkMovable = () => {
    if (ctrl.alarms.length) throw new HseError(AS.ALARM);
    if (!ctrl.servo) throw new HseError(AS.TURN_SERVO_ON);
    if (st.cmdHold) throw new HseError(AS.HOLD_CMD);
    if (ctrl.held) throw new HseError(AS.HOLD_PP);
    if (busy(ctrl)) throw new HseError(AS.OPERATING);
  };
  const speedOf = (cls, sp, linear) => {
    if (cls === 0) { const frac = Math.max(0.0001, Math.min(1, sp / 10000)); return linear ? { tcp: frac * ctrl.robot.tcpMaxSpeed } : { frac }; }
    if (cls === 1) return linear ? { tcp: Math.max(0.1, sp / 10) } : { tcp: Math.max(0.1, sp / 10) };
    if (cls === 2) return linear ? { tcp: 250, rot: Math.max(0.1, sp / 10) } : { frac: 0.2 };
    throw new HseError(AS.RANGE);
  };
  const doMove = async (cmd) => {
    checkMovable();
    const err = await startMove(ctrl, cmd, log);
    if (err) {
      if (err.code === 'SERVO_OFF') throw new HseError(AS.TURN_SERVO_ON);
      if (err.code === 'ALARM') throw new HseError(AS.ALARM);
      if (err.code === 'REJECT_1' || ctrl.lastReject?.code === 1) throw new HseError(AS.BAD_MODE);
      throw new HseError(AS.UNREACHABLE, ST.ERR, err.message);
    }
  };

  const moveCart = async (instance, d) => {
    if (d.length < 104) throw new HseError(AS.SIZE);
    const a = []; for (let i = 0; i < 26; i++) a.push(d.readInt32LE(i * 4));
    const [, , cls, speed, coord] = a;
    const v = [a[5] / 1000, a[6] / 1000, a[7] / 1000, a[8] / 10000, a[9] / 10000, a[10] / 10000];
    if (![1, 2, 3].includes(instance)) throw new HseError(AS.INSTANCE, ST.BAD_INST);
    const linear = instance !== 1;
    const cur = baseTcp(ctrl);
    let pose, base = null;
    if (instance === 3 || coord === 19) {
      // 증분 이동 (툴 좌표면 툴 기준, 그 외 베이스 기준)
      const dR = RfromZYX(v[5], v[4], v[3]);
      if (coord === 19) pose = poseMul(cur, { p: v.slice(0, 3), R: dR });
      else {
        const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) R[i][j] += dR[i][k] * cur.R[k][j];
        pose = { p: [cur.p[0] + v[0], cur.p[1] + v[1], cur.p[2] + v[2]], R };
      }
    } else {
      pose = fromVendorPose('yaskawa', v);
      if (coord === 18) base = ctrl.base ?? null;
    }
    const sp = speedOf(cls, speed, linear);
    log(`이동(직교) ${['', 'MOVJ', 'MOVL', 'IMOV'][instance]} coord=${coord} [${v.map((x) => x.toFixed(1)).join(',')}]`, true);
    await doMove({ kind: linear ? 'L' : 'J', target: { pose }, speed: sp, base });
  };

  const movePulse = async (instance, d) => {
    if (d.length < 88) throw new HseError(AS.SIZE);
    const a = []; for (let i = 0; i < 22; i++) a.push(d.readInt32LE(i * 4));
    const [, , cls, speed] = a;
    const joints = pulse2deg(ctrl, a.slice(4, 12));
    if (![1, 2].includes(instance)) throw new HseError(AS.INSTANCE, ST.BAD_INST);
    const linear = instance === 2;
    log(`이동(펄스) ${linear ? 'MOVL' : 'MOVJ'} [${joints.map((x) => x.toFixed(2)).join(',')}]`, true);
    await doMove({ kind: linear ? 'L' : 'J', target: { joints }, speed: speedOf(cls, speed, linear) });
  };

  // ------------------------------------------------------------ 로봇 제어 명령 처리
  // 반환: 응답 데이터 Buffer
  async function robotCommand(q) {
    const { cmd, instance: inst, attribute: attr, service: svc, data } = q;
    const getAll = svc === SVC.GET_ALL, getOne = svc === SVC.GET_ONE;
    const isGet = getAll || getOne || svc === SVC.GET_MULTI;
    // 속성 선택 헬퍼: fields 는 Buffer 배열
    const pick = (fields) => {
      if (getAll) return Buffer.concat(fields);
      if (getOne) { if (attr < 1 || attr > fields.length) throw new HseError(AS.ATTR, ST.BAD_ATTR); return fields[attr - 1]; }
      throw new HseError(AS.UNDEF, ST.UNDEF_CMD);
    };

    switch (cmd) {
      case 0x70: case 0x71: { // 알람 데이터 / 이력
        let a;
        if (cmd === 0x70) {
          if (inst < 1 || inst > 4) throw new HseError(AS.INSTANCE, ST.BAD_INST);
          a = ctrl.alarms[ctrl.alarms.length - inst];
        } else {
          const idx = inst >= 1 && inst <= 100 ? inst - 1 : inst >= 1001 && inst <= 1100 ? inst - 1001 : -1;
          if (idx < 0 && !(inst >= 2001 && inst <= 4100)) throw new HseError(AS.INSTANCE, ST.BAD_INST);
          a = idx >= 0 ? history[idx] : undefined;
        }
        const f = [i32s([a ? alarmNo(a.vendorCode ?? a.code) : 0]), i32s([0]), i32s([a ? 1 : 0]), strBuf(a ? fmtTime(a.t) : '', 16), strBuf(a ? a.msg : '', 32)];
        return pick(f);
      }
      case 0x72: { // 상태 정보
        const [d1, d2] = statusData();
        return pick([i32s([d1]), i32s([d2])]);
      }
      case 0x73: { // 실행 잡 정보 (1~ 태스크)
        if (inst < 1 || inst > 16) throw new HseError(AS.INSTANCE, ST.BAD_INST);
        const cur = ctrl.vm?.current;
        const line = inst === 1 ? cur?.line ?? 0 : 0;
        const job = inst === 1 ? (cur?.file ? cur.file.replace(/\.JBI$/i, '') : jobName()) : '';
        return pick([strBuf(job, 32), i32s([line]), i32s([line]), i32s([ctrl.override * 100])]);
      }
      case 0x74: { // 축 구성 정보
        if (inst >= 101 && inst <= 108) return pick(['X', 'Y', 'Z', 'Rx', 'Ry', 'Rz', '', ''].map((s) => strBuf(s, 4)));
        if (inst >= 1 && inst <= 8) return pick(['S', 'L', 'U', 'R', 'B', 'T', '', ''].map((s) => strBuf(s, 4)));
        throw new HseError(AS.INSTANCE, ST.BAD_INST);
      }
      case 0x75: { // 로봇 위치
        const b = encodePos(curPos(inst));
        const f = []; for (let i = 0; i < 13; i++) f.push(b.subarray(i * 4, i * 4 + 4));
        return pick(f);
      }
      case 0x76: case 0x77: { // 위치 편차 / 토크 (에뮬레이터는 항상 0)
        if (!(inst >= 1 && inst <= 8) && !(inst >= 11 && inst <= 18) && !(inst >= 21 && inst <= 44)) throw new HseError(AS.INSTANCE, ST.BAD_INST);
        return pick(new Array(6).fill(0).map(() => i32s([0])));
      }
      case 0x78: { // IO
        if (isGet) { log(`IO 읽기 #${inst}`); return pick([Buffer.from([ioRead(inst)])]); }
        if (svc === SVC.SET_ONE || svc === SVC.SET_ALL) {
          if (!data.length) throw new HseError(AS.SIZE);
          ioWrite(inst, data[0]);
          log(`IO 쓰기 #${inst} = 0x${data[0].toString(16).padStart(2, '0')}`, true);
          return Buffer.alloc(0);
        }
        throw new HseError(AS.UNDEF, ST.UNDEF_CMD);
      }
      case 0x79: case 0x7a: case 0x7b: case 0x7c: case 0x7d: case 0x7e: {
        const V = VARS[cmd];
        if (inst > V.max) throw new HseError(AS.INSTANCE, ST.BAD_INST);
        const k = `${V.key}:${inst}`;
        if (isGet) {
          const b = Buffer.alloc(V.size === 1 ? 1 : V.size);
          V.wr(b, regGet(k, V.key === 'S' ? '' : 0), 0);
          log(`${V.key}${String(inst).padStart(3, '0')} 읽기`);
          return pick([b]);
        }
        if (svc === SVC.SET_ONE || svc === SVC.SET_ALL) {
          if (data.length < V.size) throw new HseError(AS.SIZE);
          const v = V.rd(data, 0);
          regSet(k, v);
          log(`${V.key}${String(inst).padStart(3, '0')} = ${JSON.stringify(v)}`, true);
          return Buffer.alloc(0);
        }
        throw new HseError(AS.UNDEF, ST.UNDEF_CMD);
      }
      case 0x7f: case 0x80: case 0x81: { // P / BP / EX 변수
        if (inst > 999) throw new HseError(AS.INSTANCE, ST.BAD_INST);
        const key = { 0x7f: 'P', 0x80: 'BP', 0x81: 'EX' }[cmd];
        const k = `${key}:${inst}`;
        if (isGet) {
          const b = encodePos(key === 'P' ? regGet(k, null) : null);
          const f = []; for (let i = 0; i < 13; i++) f.push(b.subarray(i * 4, i * 4 + 4));
          log(`${key}${String(inst).padStart(3, '0')} 읽기`);
          return pick(f);
        }
        if (svc === SVC.SET_ALL || svc === SVC.SET_ONE) {
          if (key !== 'P') return Buffer.alloc(0);
          const v = decodePos(data);
          regSet(k, v);
          log(`P${String(inst).padStart(3, '0')} = ${v.kind} [${v.v.map((x) => x.toFixed(3)).join(',')}]`, true);
          return Buffer.alloc(0);
        }
        throw new HseError(AS.UNDEF, ST.UNDEF_CMD);
      }
      case 0x82: { // 1 알람 리셋, 2 에러 취소
        if (inst === 1) { ctrl.resetAlarms(); log('알람 리셋', true); }
        else if (inst === 2) { log('에러 취소 (에뮬레이터: 별도 에러 상태 없음)', true); }
        else throw new HseError(AS.INSTANCE, ST.BAD_INST);
        return Buffer.alloc(0);
      }
      case 0x83: { // 1 HOLD, 2 서보, 3 HLOCK ; 데이터 1=ON 2=OFF
        const on = (data.length >= 4 ? data.readInt32LE(0) : 0) === 1;
        if (inst === 1) {
          st.cmdHold = on;
          if (on) ctrl.hold(); else if (ctrl.held) ctrl.resume();
          log(`HOLD ${on ? 'ON' : 'OFF'}`, true);
        } else if (inst === 2) {
          if (on && !ctrl.allow('servoOn')) throw new HseError(ctrl.lastReject.code === 1 ? AS.BAD_MODE : AS.SERVO_ON_FAIL);
          if (on && ctrl.alarms.length) throw new HseError(AS.ALARM);
          if (!ctrl.setServo(on)) throw new HseError(AS.SERVO_ON_FAIL);
          log(`서보 ${on ? 'ON' : 'OFF'}`, true);
        } else if (inst === 3) { st.hlock = on; log(`HLOCK ${on ? 'ON' : 'OFF'}`, true); }
        else throw new HseError(AS.INSTANCE, ST.BAD_INST);
        return Buffer.alloc(0);
      }
      case 0x84: { // 사이클 전환: 1 step, 2 1cycle, 3 continuous
        const m = data.length >= 4 ? data.readInt32LE(0) : 0;
        if (![1, 2, 3].includes(m)) throw new HseError(AS.RANGE);
        st.cycleMode = m;
        if (m !== 3) cycles.stop();
        log(`사이클 모드 = ${['', 'STEP', '1CYCLE', 'AUTO'][m]}`, true);
        return Buffer.alloc(0);
      }
      case 0x85: { // 펜던트 문자열 표시
        ctrl.log('program', `[펜던트 메시지] ${bufStr(data)}`);
        return Buffer.alloc(0);
      }
      case 0x86: { // 기동 (잡 시작)
        if (!ctrl.allow('start')) throw new HseError(ctrl.lastReject.code === 1 ? AS.BAD_MODE : AS.ALARM);
        if (ctrl.alarms.length) throw new HseError(AS.ALARM);
        if (!ctrl.servo) throw new HseError(AS.SERVO_OFF);
        if (st.cmdHold) throw new HseError(AS.HOLD_CMD);
        const ok = await ctrl.start({ step: st.cycleMode === 1 });
        if (!ok) throw new HseError(AS.JOB_NOT_FOUND, ST.ERR, '잡 시작 실패');
        if (st.cycleMode === 3) cycles.set(-1);
        log(`잡 기동: ${ctrl.main}`, true);
        return Buffer.alloc(0);
      }
      case 0x87: { // 잡 선택: 이름 32 + 라인 u32
        const name = bufStr(data.subarray(0, 32));
        const f = findFile(ctrl, name, ['.JBI']);
        if (!f) throw new HseError(AS.JOB_NOT_FOUND, ST.ERR, `잡 없음: ${name}`);
        if (progRunning(ctrl)) throw new HseError(AS.OPERATING);
        ctrl.setMain(f);
        log(`잡 선택: ${f}`, true);
        return Buffer.alloc(0);
      }
      case 0x88: { // 관리 시간 (시작시각 16 + 경과시간 12)
        return pick([strBuf(fmtTime(Date.now() - process.uptime() * 1000), 16), strBuf(`${Math.floor(process.uptime() / 3600)}:${String(Math.floor(process.uptime() / 60) % 60).padStart(2, '0')}'00`, 12)]);
      }
      case 0x89: { // 시스템 정보: 소프트웨어 버전 24, 모델 16, 파라미터 버전 8
        return pick([strBuf('YAS4.20.00A(EMU)', 24), strBuf(ctrl.robot.name.replace('MOTOMAN-', ''), 16), strBuf('1.00', 8)]);
      }
      case 0x8a: await moveCart(inst, data); return Buffer.alloc(0);
      case 0x8b: await movePulse(inst, data); return Buffer.alloc(0);
      default: {
        if (MULTI[cmd] !== undefined) return multiCommand(q);
        throw new HseError(AS.UNDEF, ST.UNDEF_CMD);
      }
    }
  }

  // 복수 읽기/쓰기 (0x300~0x306): 데이터 = 개수 u32 + 값들
  function multiCommand(q) {
    const { cmd, instance: inst, service: svc, data } = q;
    if (data.length < 4) throw new HseError(AS.SIZE);
    const count = data.readUInt32LE(0);
    if (count < 1 || count > 474) throw new HseError(AS.RANGE);
    const which = MULTI[cmd];
    if (which === 'IO') {
      if (svc === SVC.GET_MULTI) {
        const b = Buffer.alloc(4 + count); b.writeUInt32LE(count, 0);
        for (let i = 0; i < count; i++) b[4 + i] = ioRead(inst + i);
        log(`IO 복수 읽기 #${inst} x${count}`);
        return b;
      }
      if (svc === SVC.SET_MULTI) {
        if (data.length < 4 + count) throw new HseError(AS.SIZE);
        for (let i = 0; i < count; i++) ioWrite(inst + i, data[4 + i]);
        log(`IO 복수 쓰기 #${inst} x${count}`, true);
        return Buffer.alloc(0);
      }
      throw new HseError(AS.UNDEF, ST.UNDEF_CMD);
    }
    const V = VARS[which];
    if (inst + count - 1 > V.max) throw new HseError(AS.RANGE);
    if (svc === SVC.GET_MULTI) {
      const b = Buffer.alloc(4 + count * V.size); b.writeUInt32LE(count, 0);
      for (let i = 0; i < count; i++) V.wr(b, regGet(`${V.key}:${inst + i}`, V.key === 'S' ? '' : 0), 4 + i * V.size);
      log(`${V.key} 복수 읽기 ${inst} x${count}`);
      return b;
    }
    if (svc === SVC.SET_MULTI) {
      if (data.length < 4 + count * V.size) throw new HseError(AS.SIZE);
      for (let i = 0; i < count; i++) regSet(`${V.key}:${inst + i}`, V.rd(data, 4 + i * V.size));
      log(`${V.key} 복수 쓰기 ${inst} x${count}`, true);
      return Buffer.alloc(0);
    }
    throw new HseError(AS.UNDEF, ST.UNDEF_CMD);
  }

  // 선형 와일드카드 매칭 (*, ?) — ReDoS 방지
  function globMatch(pat, str) {
    const p = pat.toLowerCase(), s = str.toLowerCase();
    let pi = 0, si = 0, star = -1, match = 0;
    while (si < s.length) {
      if (pi < p.length && (p[pi] === '?' || p[pi] === s[si])) { pi++; si++; }
      else if (pi < p.length && p[pi] === '*') { star = pi++; match = si; }
      else if (star >= 0) { pi = star + 1; si = ++match; }
      else return false;
    }
    while (pi < p.length && p[pi] === '*') pi++;
    return pi === p.length;
  }

  // ------------------------------------------------------------ 소켓 처리 공통
  function makeSocket(division, handler) {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    sock.on('error', (e) => log(`UDP 소켓 오류: ${e.message}`, true));
    sock.on('message', async (msg, rinfo) => {
      const t0 = performance.now();
      const peer = `${rinfo.address}:${rinfo.port}`;
      const q = parsePacket(msg);
      if (!q) { log(`잘못된 패킷 (${msg.length} bytes) from ${rinfo.address}`); return; }
      const sum = division === 1
        ? `CMD 0x${q.cmd.toString(16)} inst=${q.instance} attr=${q.attribute} svc=0x${q.service.toString(16)}`
        : `FILE svc=0x${q.service.toString(16)} blk=${q.block & 0x7fffffff}`;
      if (await ctrl.traffic?.applyFault('yaskawaHse', peer, sum)) return;
      let sentPkt = null;
      const reply = (sub, data, block = 0x80000000) => {
        const pkt = buildPacket({ division, ack: 1, reqId: q.reqId, block, sub, data });
        sentPkt = pkt;
        sock.send(pkt, rinfo.port, rinfo.address);
      };
      try {
        await handler(q, reply, rinfo);
        ctrl.traffic?.record('yaskawaHse', { client: peer, dir: 'req', summary: `${sum} → OK`, hex: `${hexOf(msg, 24)} | ${hexOf(sentPkt, 24)}`, ok: true, ms: performance.now() - t0 });
      } catch (e) {
        const added = e instanceof HseError ? e.added : AS.UNDEF;
        const status = e instanceof HseError ? e.status : ST.ERR;
        log(`명령 0x${q.cmd.toString(16)} 오류 status=0x${status.toString(16)} added=0x${added.toString(16)} ${e.message}`, true);
        reply(respSub(q.service, status, added), Buffer.alloc(0));
        ctrl.traffic?.record('yaskawaHse', { client: peer, dir: 'req', summary: `${sum} → ERR 0x${status.toString(16)}/0x${added.toString(16)}`, hex: hexOf(msg, 24), ok: false, error: e.message, ms: performance.now() - t0 });
      }
    });
    return sock;
  }

  const robotSock = makeSocket(1, async (q, reply) => {
    if (q.division !== 1) throw new HseError(AS.UNDEF, ST.UNDEF_CMD);
    const data = await robotCommand(q);
    reply(respSub(q.service), data);
  });

  // ------------------------------------------------------------ 파일 제어
  // 세션: key=주소:포트 → { kind:'load'|'save', name, chunks, out:[Buffer], reqId }
  //   클라이언트가 보낸 블록 번호·크기를 그대로 믿지 않도록 순서·용량·개수·유휴 시간 제한
  const sessions = new Map();
  const CHUNK = 400;
  const MAX_LOAD_BYTES = 4 * 1024 * 1024, MAX_SESSIONS = 64, SESSION_IDLE_MS = 30000;
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of sessions) if (now - (v.at ?? 0) > SESSION_IDLE_MS) sessions.delete(k);
  }, 5000);
  sweep.unref?.();
  const fileSock = makeSocket(2, async (q, reply, rinfo) => {
    const key = `${rinfo.address}:${rinfo.port}`;
    const svc = q.service;
    const cur = sessions.get(key);
    if (cur) cur.at = Date.now();
    const sendBlock = (s, idx) => {
      const last = idx === s.out.length - 1;
      const blk = (idx + 1) | (last ? 0x80000000 : 0);
      reply(respSub(svc), s.out[idx] ?? Buffer.alloc(0), blk >>> 0);
      if (last) sessions.delete(key);
    };
    if (q.division !== 2) throw new HseError(AS.UNDEF, ST.UNDEF_CMD);
    switch (svc) {
      case 0x09: { // 파일 삭제
        const name = bufStr(q.data);
        const f = findFile(ctrl, name, ['.JBI']);
        if (!f) throw new HseError(AS.FILE_NOT_FOUND, ST.ERR, `파일 없음: ${name}`);
        ctrl.deleteFile(f);
        log(`파일 삭제: ${f}`, true);
        return reply(respSub(svc), Buffer.alloc(0));
      }
      case 0x15: { // 파일 로드 (PC → 컨트롤러)
        const blockNo = q.block & 0x7fffffff;
        const lastBit = (q.block & 0x80000000) !== 0;
        if (blockNo === 0 && !lastBit) {
          const name = bufStr(q.data);
          if (!name) throw new HseError(AS.SIZE);
          if (!sessions.has(key) && sessions.size >= MAX_SESSIONS) throw new HseError(AS.CANT_LOAD, ST.ERR, '동시 파일 세션이 너무 많음');
          sessions.set(key, { kind: 'load', name, chunks: [], bytes: 0, at: Date.now() });
          log(`파일 로드 시작: ${name}`, true);
          return reply(respSub(svc), Buffer.alloc(0), 0);
        }
        const s = sessions.get(key);
        if (!s || s.kind !== 'load') throw new HseError(AS.CANT_LOAD, ST.ERR, '로드 세션 없음');
        // 블록은 1부터 순서대로. 직전 블록 재전송(UDP 재시도)은 다시 확인 응답만
        if (blockNo === s.chunks.length && blockNo > 0) return reply(respSub(svc), Buffer.alloc(0), q.block);
        if (blockNo !== s.chunks.length + 1) { sessions.delete(key); throw new HseError(AS.CANT_LOAD, ST.ERR, `블록 번호 오류: ${blockNo} (기대 ${s.chunks.length + 1})`); }
        s.bytes += q.data.length;
        if (s.bytes > MAX_LOAD_BYTES) { sessions.delete(key); throw new HseError(AS.SIZE, ST.ERR, '파일이 너무 큼'); }
        s.chunks.push(Buffer.from(q.data));
        reply(respSub(svc), Buffer.alloc(0), q.block);
        if (lastBit) {
          sessions.delete(key);
          const text = Buffer.concat(s.chunks).toString('latin1');
          ctrl.loadFiles({ [s.name]: text });
          log(`파일 로드 완료: ${s.name} (${text.length} bytes, ${blockNo} 블록)`, true);
        }
        return;
      }
      case 0x16: case 0x32: { // 파일 저장(컨트롤러 → PC) / 파일 목록
        if (q.ack === 1) { // PC 의 블록 수신 확인 → 다음 블록 송신
          const s = sessions.get(key);
          if (!s) return;
          const idx = q.block & 0x7fffffff; // 확인한 블록 번호 (1부터)
          if (idx < s.out.length) sendBlock(s, idx);
          return;
        }
        let content;
        if (svc === 0x16) {
          const name = bufStr(q.data);
          const f = findFile(ctrl, name, ['.JBI']);
          if (!f) throw new HseError(AS.FILE_NOT_FOUND, ST.ERR, `파일 없음: ${name}`);
          content = Buffer.from(ctrl.files.get(f).replace(/\r?\n/g, '\r\n'), 'latin1');
          log(`파일 저장(전송): ${f} (${content.length} bytes)`, true);
        } else {
          const pat = bufStr(q.data) || '*.JBI';
          const names = [...ctrl.files.keys()].filter((n) => globMatch(pat, n));
          content = Buffer.from(names.map((n) => n + '\r\n').join(''), 'latin1');
          log(`파일 목록 (${pat}): ${names.length}개`, true);
        }
        const out = [];
        for (let i = 0; i < content.length; i += CHUNK) out.push(content.subarray(i, i + CHUNK));
        if (!out.length) out.push(Buffer.alloc(0));
        const s = { kind: 'save', out, at: Date.now() };
        if (!sessions.has(key) && sessions.size >= MAX_SESSIONS) throw new HseError(AS.CANT_LOAD, ST.ERR, '동시 파일 세션이 너무 많음');
        sessions.set(key, s);
        sendBlock(s, 0);
        return;
      }
      default: throw new HseError(AS.UNDEF, ST.UNDEF_CMD);
    }
  });

  const r1 = await bindServer(robotSock, port, host);
  const r2 = await bindServer(fileSock, filePort, host);
  if (r1.error) ctrl.log('comm', `[${TAG}] UDP ${port} 바인딩 실패: ${r1.error.message}`);
  else ctrl.log('comm', `[${TAG}] 로봇 제어 UDP ${r1.port} 대기`);
  if (r2.error) ctrl.log('comm', `[${TAG}] UDP ${filePort} 바인딩 실패: ${r2.error.message}`);
  else ctrl.log('comm', `[${TAG}] 파일 제어 UDP ${r2.port} 대기`);

  return {
    name: 'Yaskawa High-Speed Ethernet Server', proto: 'udp', vendor: 'yaskawa',
    port: r1.error ? null : r1.port, filePort: r2.error ? null : r2.port,
    close() {
      clearInterval(sweep);
      cycles.stop();
      ctrl.off('log', onLog);
      try { robotSock.close(); } catch {}
      try { fileSock.close(); } catch {}
    },
  };
}
