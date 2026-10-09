// KUKA KukaVarProxy / OpenShowVar 바이너리 TCP 프로토콜 에뮬레이션 — 기본 포트 7000
//
// 요청:  msgId u16 BE | contentLength u16 BE | mode u8 (0 읽기, 1 쓰기) | varNameLength u16 BE | varName (ASCII)
//        [쓰기: valueLength u16 BE | value (ASCII)]
//        contentLength = mode 부터 끝까지의 바이트 수
// 응답:  msgId u16 BE | contentLength u16 BE | mode u8 | valueLength u16 BE | value (ASCII) | 꼬리 3바이트 00 01 01
//        (마지막 바이트 1 = 성공, 실패 시 꼬리 00 00 00 + 빈 값)
// 하나의 TCP 청크에 여러 메시지가 오거나 메시지가 쪼개져 와도 처리(프레이밍)한다.
//
// 변수: krl.js 의 readVar/writeVar + formatValue/parseValue 를 우선 사용하고,
//       없거나 미정의인 경우 시스템 변수는 이 모듈에서 직접 처리한다.
//       $AXIS_ACT, $AXIS_ACT_MEAS, $POS_ACT, $POS_ACT_MES, $OV_PRO, $OUT[n], $IN[n], $MODE_OP,
//       $PRO_STATE, $PRO_STATE1, $PRO_NAME, $PERI_RDY, $STOPMESS, $ALARM_STOP, $USER_SAF, $TOOL, $BASE, $VEL_ACT, $DATE
import net from 'node:net';
import { wristCenter } from '../../shared/kinematics.js';
import { xyzrpyFromFrame } from '../../shared/poseformat.js';
import { makeLogger, bindServer, baseTcp, toVendorPose, langExt, safeReadVar, safeWriteVar, progRunning, stripExt } from './common.js';

const TAG = 'KUKA-KVP';
const f3 = (v) => { const r = Math.round(v * 1e4) / 1e4; return (Object.is(r, -0) ? 0 : r).toFixed(Number.isInteger(r) ? 1 : 4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0'); };

// 요청 프레임 파싱 → { msgs:[...], rest:Buffer }
export function parseFrames(buf) {
  const msgs = [];
  let off = 0;
  while (buf.length - off >= 4) {
    const msgId = buf.readUInt16BE(off);
    const len = buf.readUInt16BE(off + 2);
    if (buf.length - off < 4 + len) break;
    const body = buf.subarray(off + 4, off + 4 + len);
    off += 4 + len;
    if (body.length < 3) { msgs.push({ msgId, bad: true }); continue; }
    const mode = body[0];
    const nl = body.readUInt16BE(1);
    const name = body.subarray(3, 3 + nl).toString('latin1');
    let value = null;
    if (mode === 1 && body.length >= 3 + nl + 2) {
      const vl = body.readUInt16BE(3 + nl);
      value = body.subarray(5 + nl, 5 + nl + vl).toString('latin1');
    }
    msgs.push({ msgId, mode, name, value });
  }
  return { msgs, rest: buf.subarray(off) };
}

export function buildResponse(msgId, mode, value, ok) {
  const v = Buffer.from(ok ? String(value) : '', 'latin1');
  const b = Buffer.alloc(4 + 1 + 2 + v.length + 3);
  b.writeUInt16BE(msgId, 0);
  b.writeUInt16BE(1 + 2 + v.length + 3, 2);
  b[4] = mode;
  b.writeUInt16BE(v.length, 5);
  v.copy(b, 7);
  b[7 + v.length] = 0; b[8 + v.length] = ok ? 1 : 0; b[9 + v.length] = ok ? 1 : 0;
  return b;
}

export async function start(ctrl, opts = {}) {
  const port = opts.port ?? 7000;
  const host = opts.host ?? '0.0.0.0';
  const log = makeLogger(ctrl, TAG);
  const clients = new Set();

  // ------------------------------------------------------------ 시스템 변수 (폴백)
  const statusTurn = (j) => {
    // S: bit0 손목중심이 A1 축 뒤쪽(오버헤드), bit1 A3 ≥ φ(≈0), bit2 A5 ≤ 0
    let s = 0;
    try {
      const wc = wristCenter(ctrl.robot, j);
      const arm = ctrl.robot.signs?.[0] < 0 ? -j[0] : j[0];
      const d = Math.atan2(wc[1], wc[0]) - arm * Math.PI / 180;
      if (Math.cos(d) * Math.hypot(wc[0], wc[1]) < -1e-6) s |= 1;
    } catch {}
    if (j[2] >= 0) s |= 2;
    if (j[4] <= 0) s |= 4;
    let t = 0;
    j.forEach((v, i) => { if (v < 0) t |= 1 << i; });
    return { s, t };
  };
  const e6axis = () => `{E6AXIS: ${ctrl.joints.map((v, i) => `A${i + 1} ${f3(v)}`).join(', ')}, E1 0.0, E2 0.0, E3 0.0, E4 0.0, E5 0.0, E6 0.0}`;
  const e6pos = (useBase = false) => {
    const p = toVendorPose('kuka', useBase ? ctrl.tcpPose() : baseTcp(ctrl));
    const { s, t } = statusTurn(ctrl.joints);
    return `{E6POS: X ${f3(p[0])}, Y ${f3(p[1])}, Z ${f3(p[2])}, A ${f3(p[3])}, B ${f3(p[4])}, C ${f3(p[5])}, S ${s}, T ${t}, E1 0.0, E2 0.0, E3 0.0, E4 0.0, E5 0.0, E6 0.0}`;
  };
  const frame = (fr) => {
    if (!fr) return '{FRAME: X 0.0, Y 0.0, Z 0.0, A 0.0, B 0.0, C 0.0}';
    const v = xyzrpyFromFrame(fr); // [x,y,z,rx,ry,rz] → KUKA A=rz, B=ry, C=rx
    return `{FRAME: X ${f3(v[0])}, Y ${f3(v[1])}, Z ${f3(v[2])}, A ${f3(v[5])}, B ${f3(v[4])}, C ${f3(v[3])}}`;
  };
  const proState = () => {
    const st = ctrl.vm?.status;
    if (!ctrl.vm) return '#P_FREE';
    if (st === 'running' && !ctrl.held) return '#P_ACTIVE';
    if (st === 'running' || st === 'paused') return '#P_STOP';
    if (st === 'done') return '#P_END';
    return '#P_RESET';
  };
  const B = (v) => (v ? 'TRUE' : 'FALSE');

  function sysRead(nameU) {
    let m;
    if ((m = /^\$(OUT|IN)\[\s*(\d+)\s*\]$/.exec(nameU))) {
      const n = Number(m[2]);
      if (!(n >= 1 && n <= 512)) return undefined;
      return B(m[1] === 'OUT' ? ctrl.getDO(n) : ctrl.getDI(n));
    }
    switch (nameU) {
      case '$AXIS_ACT': case '$AXIS_ACT_MEAS': case '$AXIS_ACT_MES': return e6axis();
      case '$POS_ACT': case '$POS_ACT_MES': return e6pos(true);
      case '$OV_PRO': return String(Math.round(ctrl.override));
      case '$MODE_OP': return ctrl.mode === 'TEACH' ? '#T1' : ctrl.mode === 'REMOTE' ? '#EXT' : '#AUT';
      case '$PRO_STATE': case '$PRO_STATE1': case '$PRO_STATE0': return proState();
      case '$PRO_NAME': case '$PRO_NAME1': case '$PRO_NAME[]': case '$PRO_NAME1[]': return `"${ctrl.main ? stripExt(ctrl.main).toUpperCase() : ''}"`;
      case '$PRO_IP': case '$PRO_IP1': {
        const c = ctrl.vm?.current;
        return `{PRO_IP: NAME[] "${c?.file ? stripExt(c.file).toUpperCase() : ''}", SNR ${c?.line ?? 0}, NAME_C[] "${c?.proc ?? ''}", I_EXECUTED FALSE}`;
      }
      case '$PERI_RDY': return B(ctrl.servo);
      case '$USER_SAF': return 'TRUE';
      case '$STOPMESS': case '$ALARM_STOP': return B(ctrl.alarms.length > 0);
      case '$TOOL': return frame(ctrl.tool);
      case '$BASE': return frame(ctrl.base);
      case '$VEL_ACT': return '0.0';
      case '$ROBNAME[]': case '$ROBNAME': return `"${ctrl.robot.name}"`;
      case '$TRAFONAME[]': return `"${ctrl.robot.name}"`;
      case '$DATE': {
        const d = new Date();
        return `{DATE: CSEC 0, SEC ${d.getSeconds()}, MIN ${d.getMinutes()}, HOUR ${d.getHours()}, DAY ${d.getDate()}, MONTH ${d.getMonth() + 1}, YEAR ${d.getFullYear() % 100}}`;
      }
    }
    return undefined;
  }

  function sysWrite(nameU, text) {
    let m;
    const t = String(text).trim().toUpperCase();
    if ((m = /^\$(OUT|IN)\[\s*(\d+)\s*\]$/.exec(nameU))) {
      const n = Number(m[2]);
      if (!(n >= 1 && n <= 512) || !['TRUE', 'FALSE', '1', '0'].includes(t)) return false;
      const v = t === 'TRUE' || t === '1';
      if (m[1] === 'OUT') ctrl.setDO(n, v); else ctrl.setDI(n, v); // $IN 쓰기는 에뮬레이터 시뮬레이션용
      return true;
    }
    if (nameU === '$OV_PRO') { const n = Number(t); if (!Number.isFinite(n)) return false; ctrl.setOverride(n); return true; }
    return false;
  }

  // ------------------------------------------------------------ 읽기/쓰기
  async function formatKrl(v) {
    if (typeof v === 'string') return v; // krl.readVar 가 이미 KRL 텍스트를 반환한 경우
    const m = await langExt('kuka');
    try { if (m?.formatValue) return String(m.formatValue(v)); } catch {}
    if (typeof v === 'boolean') return B(v);
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : f3(v);
    return JSON.stringify(v);
  }

  async function readVar(name) {
    const nameU = name.trim().toUpperCase();
    // 실시간 시스템 변수는 컨트롤러 상태에서 직접 (언어 모듈보다 우선)
    const sys = sysRead(nameU);
    if (sys !== undefined && /^\$(AXIS_ACT|POS_ACT|OV_PRO|OUT\[|IN\[|MODE_OP|PRO_STATE|PERI_RDY|STOPMESS|ALARM_STOP)/.test(nameU)) return sys;
    const v = safeReadVar('kuka', ctrl, name.trim());
    if (v !== undefined) return formatKrl(v);
    if (sys !== undefined) return sys;
    const r = ctrl.regs.get(`KRL:${nameU}`);
    if (r !== undefined) return formatKrl(r);
    return undefined;
  }

  async function writeVar(name, text) {
    const nameU = name.trim().toUpperCase();
    if (sysWrite(nameU, text)) return true;
    if (safeWriteVar('kuka', ctrl, name.trim(), String(text))) { ctrl.emitState(); return true; }
    const m = await langExt('kuka');
    if (m?.parseValue) {
      try { const v = m.parseValue(String(text)); if (safeWriteVar('kuka', ctrl, name.trim(), v)) { ctrl.emitState(); return true; } } catch {}
    }
    if (nameU.startsWith('$')) return false; // 알 수 없는 시스템 변수는 쓰기 거부
    // 프로그램에 없는 변수 → 에뮬레이터 레지스터에 KRL 텍스트로 저장
    ctrl.regs.set(`KRL:${nameU}`, String(text));
    ctrl.emitState();
    return true;
  }

  async function handle(msg) {
    if (msg.bad) return buildResponse(msg.msgId, 0, '', false);
    if (msg.mode === 1) {
      let ok = false;
      try { ok = msg.value !== null && await writeVar(msg.name, msg.value); } catch { ok = false; }
      log(`쓰기 ${msg.name} = ${String(msg.value).slice(0, 60)} → ${ok ? 'OK' : '실패'}`, true);
      if (!ok) return buildResponse(msg.msgId, 1, '', false);
      const v = (await readVar(msg.name).catch(() => undefined)) ?? msg.value;
      return buildResponse(msg.msgId, 1, v, true);
    }
    let v;
    try { v = await readVar(msg.name); } catch { v = undefined; }
    log(`읽기 ${msg.name}${v === undefined ? ' → 없음' : ''}`);
    return buildResponse(msg.msgId, msg.mode, v ?? '', v !== undefined);
  }

  const server = net.createServer((sock) => {
    const peer = `${sock.remoteAddress}:${sock.remotePort}`;
    clients.add(sock);
    sock.setNoDelay(true);
    log(`접속: ${peer}`, true);
    let buf = Buffer.alloc(0);
    let queue = Promise.resolve();
    sock.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const { msgs, rest } = parseFrames(buf);
      buf = Buffer.from(rest);
      for (const m of msgs) queue = queue.then(async () => { const r = await handle(m); if (!sock.destroyed) sock.write(r); });
    });
    sock.on('close', () => { clients.delete(sock); log(`연결 종료: ${peer}`, true); });
    sock.on('error', () => {});
  });

  const r = await bindServer(server, port, host);
  if (r.error) ctrl.log('comm', `[${TAG}] TCP ${port} 바인딩 실패: ${r.error.message}`);
  else ctrl.log('comm', `[${TAG}] KukaVarProxy TCP ${r.port} 대기`);
  return {
    name: 'KUKA KukaVarProxy (OpenShowVar)', proto: 'tcp', vendor: 'kuka',
    port: r.error ? null : r.port,
    close() { for (const s of clients) s.destroy(); try { server.close(); } catch {} },
  };
}
