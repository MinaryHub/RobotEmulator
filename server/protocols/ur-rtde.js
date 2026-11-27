// Universal Robots RTDE (Real-Time Data Exchange) TCP 서버 — 기본 포트 30004
//  - 바이너리 프레임: [u16BE size][u8 type][payload...]
//  - 지원 메시지:
//      V (86)  RTDE_REQUEST_PROTOCOL_VERSION (v1/v2)
//      v (118) RTDE_GET_URCONTROL_VERSION
//      O (79)  RTDE_CONTROL_PACKAGE_SETUP_OUTPUTS (레시피 등록 + 타입 응답)
//      I (73)  RTDE_CONTROL_PACKAGE_SETUP_INPUTS  (레시피 등록 + 타입 응답)
//      S (83)  RTDE_CONTROL_PACKAGE_START         (주기 DATA_PACKAGE 송신 시작)
//      P (80)  RTDE_CONTROL_PACKAGE_PAUSE         (주기 송신 일시 정지)
//      U (85)  RTDE_DATA_PACKAGE                  (양방향 실시간 데이터 교환)
//  - ctrl.regs 의 'RTDE_IN_I:n', 'RTDE_IN_F:n', 'RTDE_IN_B:n', 'RTDE_OUT_I:n', 'RTDE_OUT_F:n', 'RTDE_OUT_B:n' 과 연동
import net from 'node:net';
import { DEG } from '../../shared/math.js';
import { makeLogger, bindServer, baseTcp, toVendorPose, progRunning } from './common.js';
import { peerOf, hexOf } from './traffic.js';

const TAG = 'UR-RTDE';
export const MSG = {
  REQUEST_PROTOCOL_VERSION: 86, // 'V'
  GET_URCONTROL_VERSION: 118,   // 'v'
  TEXT_MESSAGE: 77,             // 'M'
  DATA_PACKAGE: 85,             // 'U'
  CONTROL_PACKAGE_SETUP_OUTPUTS: 79, // 'O'
  CONTROL_PACKAGE_SETUP_INPUTS: 73,  // 'I'
  CONTROL_PACKAGE_START: 83,    // 'S'
  CONTROL_PACKAGE_PAUSE: 80,    // 'P'
};

const TYPE_SIZE = {
  BOOL: 1, UINT8: 1, UINT32: 4, UINT64: 8, INT32: 4, DOUBLE: 8,
  VECTOR3D: 24, VECTOR6D: 48, VECTOR6INT32: 24, VECTOR6UINT32: 24,
};

function outFieldSpec(name) {
  switch (name) {
    case 'timestamp':
    case 'speed_scaling':
    case 'target_speed_fraction':
    case 'standard_analog_input0':
    case 'standard_analog_input1':
    case 'standard_analog_output0':
    case 'standard_analog_output1':
      return { type: 'DOUBLE' };
    case 'actual_q':
    case 'target_q':
    case 'actual_qd':
    case 'actual_TCP_pose':
    case 'target_TCP_pose':
    case 'actual_TCP_speed':
    case 'actual_TCP_force':
      return { type: 'VECTOR6D' };
    case 'actual_digital_input_bits':
    case 'actual_digital_output_bits':
      return { type: 'UINT64' };
    case 'robot_mode':
    case 'safety_mode':
      return { type: 'INT32' };
    case 'runtime_state':
    case 'robot_status_bits':
    case 'safety_status_bits':
    case 'output_bit_registers0_to_31':
    case 'output_bit_registers32_to_63':
      return { type: 'UINT32' };
  }
  let m;
  if ((m = /^output_int_register_(\d+)$/.exec(name)) && Number(m[1]) <= 47) return { type: 'INT32', kind: 'out_i', idx: Number(m[1]) };
  if ((m = /^output_double_register_(\d+)$/.exec(name)) && Number(m[1]) <= 47) return { type: 'DOUBLE', kind: 'out_f', idx: Number(m[1]) };
  return null;
}

function inFieldSpec(name) {
  switch (name) {
    case 'speed_slider_mask':
    case 'input_bit_registers0_to_31':
    case 'input_bit_registers32_to_63':
      return { type: 'UINT32' };
    case 'speed_slider_fraction':
    case 'standard_analog_output_0':
    case 'standard_analog_output_1':
      return { type: 'DOUBLE' };
    case 'standard_digital_output_mask':
    case 'standard_digital_output':
    case 'configurable_digital_output_mask':
    case 'configurable_digital_output':
    case 'standard_analog_output_mask':
      return { type: 'UINT8' };
  }
  let m;
  if ((m = /^input_int_register_(\d+)$/.exec(name)) && Number(m[1]) <= 47) return { type: 'INT32', kind: 'in_i', idx: Number(m[1]) };
  if ((m = /^input_double_register_(\d+)$/.exec(name)) && Number(m[1]) <= 47) return { type: 'DOUBLE', kind: 'in_f', idx: Number(m[1]) };
  return null;
}

function readOutValue(ctrl, name, spec) {
  if (spec.kind === 'out_i') return Math.trunc(Number(ctrl.regs.get(`RTDE_OUT_I:${spec.idx}`) ?? 0));
  if (spec.kind === 'out_f') return Number(ctrl.regs.get(`RTDE_OUT_F:${spec.idx}`) ?? 0);
  switch (name) {
    case 'timestamp': return ctrl.simMs / 1000;
    case 'speed_scaling':
    case 'target_speed_fraction': return (ctrl.override ?? 100) / 100;
    case 'actual_q':
    case 'target_q': return ctrl.joints.map((d) => d * DEG);
    case 'actual_qd':
    case 'actual_TCP_speed':
    case 'actual_TCP_force': return [0, 0, 0, 0, 0, 0];
    case 'actual_TCP_pose':
    case 'target_TCP_pose': {
      const vp = toVendorPose('ur', baseTcp(ctrl));
      return [vp[0] / 1000, vp[1] / 1000, vp[2] / 1000, vp[3], vp[4], vp[5]];
    }
    case 'actual_digital_input_bits': {
      let bits = 0n;
      for (let i = 0; i < 18; i++) if (ctrl.getDI(i + 1)) bits |= 1n << BigInt(i);
      return bits;
    }
    case 'actual_digital_output_bits': {
      let bits = 0n;
      for (let i = 0; i < 18; i++) if (ctrl.getDO(i + 1)) bits |= 1n << BigInt(i);
      return bits;
    }
    case 'robot_mode': return ctrl.servo ? 7 : 5;
    case 'safety_mode': return ctrl.estopActive ? 7 : ctrl.alarms?.length ? 3 : 1;
    case 'runtime_state': return progRunning(ctrl) ? (ctrl.held ? 4 : 2) : 1;
    case 'robot_status_bits': return (ctrl.servo ? 1 : 0) | (progRunning(ctrl) ? 2 : 0);
    case 'safety_status_bits': return ctrl.estopActive ? 4 : 1;
    case 'standard_analog_input0': return ctrl.getAI?.(1) ?? 0;
    case 'standard_analog_input1': return ctrl.getAI?.(2) ?? 0;
    case 'standard_analog_output0': return ctrl.getAO?.(1) ?? 0;
    case 'standard_analog_output1': return ctrl.getAO?.(2) ?? 0;
    case 'output_bit_registers0_to_31': {
      let v = 0;
      for (let i = 0; i < 32; i++) if (ctrl.regs.get(`RTDE_OUT_B:${i}`)) v |= (1 << i);
      return v >>> 0;
    }
    case 'output_bit_registers32_to_63': {
      let v = 0;
      for (let i = 0; i < 32; i++) if (ctrl.regs.get(`RTDE_OUT_B:${32 + i}`)) v |= (1 << i);
      return v >>> 0;
    }
  }
  return 0;
}

function writeField(buf, off, type, val) {
  switch (type) {
    case 'BOOL':
    case 'UINT8': buf.writeUInt8(Number(val) & 0xff, off); return off + 1;
    case 'INT32': buf.writeInt32BE(Math.trunc(Number(val) || 0), off); return off + 4;
    case 'UINT32': buf.writeUInt32BE((Math.trunc(Number(val) || 0)) >>> 0, off); return off + 4;
    case 'UINT64': buf.writeBigUInt64BE(BigInt(val || 0), off); return off + 8;
    case 'DOUBLE': buf.writeDoubleBE(Number(val) || 0, off); return off + 8;
    case 'VECTOR6D': {
      const a = Array.isArray(val) ? val : [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < 6; i++) buf.writeDoubleBE(Number(a[i]) || 0, off + i * 8);
      return off + 48;
    }
  }
  return off;
}

function readField(buf, off, type) {
  switch (type) {
    case 'BOOL':
    case 'UINT8': return [buf.readUInt8(off), off + 1];
    case 'INT32': return [buf.readInt32BE(off), off + 4];
    case 'UINT32': return [buf.readUInt32BE(off), off + 4];
    case 'UINT64': return [buf.readBigUInt64BE(off), off + 8];
    case 'DOUBLE': return [buf.readDoubleBE(off), off + 8];
    case 'VECTOR6D': {
      const a = [];
      for (let i = 0; i < 6; i++) a.push(buf.readDoubleBE(off + i * 8));
      return [a, off + 48];
    }
  }
  return [0, off];
}

export function buildFrame(type, payload = Buffer.alloc(0)) {
  const b = Buffer.alloc(3 + payload.length);
  b.writeUInt16BE(b.length, 0);
  b[2] = type & 0xff;
  payload.copy(b, 3);
  return b;
}

export async function start(ctrl, opts = {}) {
  const port = opts.port ?? 30004;
  const host = opts.host ?? '0.0.0.0';
  const log = makeLogger(ctrl, TAG);
  const clients = new Set();

  const server = net.createServer((sock) => {
    const peer = peerOf(sock);
    if (clients.size >= 16) { sock.destroy(); return; }
    const sess = {
      sock, peer, version: 2, outRecipes: new Map(), inRecipes: new Map(),
      nextOutId: 1, nextInId: 1, activeOutId: null, freq: 25, timer: null, buf: Buffer.alloc(0),
    };
    clients.add(sess);
    ctrl.traffic?.connect('urRtde', peer);
    log(`클라이언트 접속 ${peer}`, true);
    sock.setNoDelay(true);

    const stopTimer = () => { if (sess.timer) { clearInterval(sess.timer); sess.timer = null; } };
    const sendFrame = (type, payload) => { if (!sock.destroyed) sock.write(buildFrame(type, payload)); };

    const sendOutputData = () => {
      const rec = sess.outRecipes.get(sess.activeOutId);
      if (!rec || sock.destroyed) return;
      const totalBytes = (sess.version >= 2 ? 1 : 0) + rec.byteLen;
      const payload = Buffer.alloc(totalBytes);
      let off = 0;
      if (sess.version >= 2) { payload[0] = rec.id; off = 1; }
      for (const f of rec.fields) {
        off = writeField(payload, off, f.spec.type, readOutValue(ctrl, f.name, f.spec));
      }
      sendFrame(MSG.DATA_PACKAGE, payload);
    };

    const handlePacket = async (type, payload) => {
      const t0 = performance.now();
      if (await ctrl.traffic?.applyFault('urRtde', peer, `type=${type}`)) return;
      switch (type) {
        case MSG.REQUEST_PROTOCOL_VERSION: {
          const v = payload.length >= 2 ? payload.readUInt16BE(0) : 2;
          const ok = v === 1 || v === 2;
          if (ok) sess.version = v;
          sendFrame(MSG.REQUEST_PROTOCOL_VERSION, Buffer.from([ok ? 1 : 0]));
          ctrl.traffic?.record('urRtde', { client: peer, dir: 'req', summary: `PROTO_VER v${v} → ${ok ? 'OK' : 'NO'}`, ok, ms: performance.now() - t0 });
          break;
        }
        case MSG.GET_URCONTROL_VERSION: {
          const b = Buffer.alloc(16);
          b.writeUInt32BE(5, 0); b.writeUInt32BE(15, 4); b.writeUInt32BE(0, 8); b.writeUInt32BE(0, 12);
          sendFrame(MSG.GET_URCONTROL_VERSION, b);
          break;
        }
        case MSG.CONTROL_PACKAGE_SETUP_OUTPUTS: {
          let freq = 25, namesStr;
          if (sess.version >= 2 && payload.length >= 8) {
            freq = payload.readDoubleBE(0);
            namesStr = payload.subarray(8).toString('utf8');
          } else {
            namesStr = payload.toString('utf8');
          }
          const names = namesStr.split(',').map((s) => s.trim()).filter(Boolean);
          const fields = [];
          const types = [];
          let byteLen = 0, valid = names.length > 0;
          for (const nm of names) {
            const spec = outFieldSpec(nm);
            if (!spec) { types.push('NOT_FOUND'); valid = false; }
            else { types.push(spec.type); fields.push({ name: nm, spec }); byteLen += TYPE_SIZE[spec.type]; }
          }
          const id = valid ? sess.nextOutId++ : 0;
          if (valid) {
            sess.outRecipes.set(id, { id, fields, byteLen, freq: Math.max(1, Math.min(125, Number(freq) || 25)) });
            sess.activeOutId = id;
            sess.freq = sess.outRecipes.get(id).freq;
          }
          const typeBuf = Buffer.from(types.join(','), 'utf8');
          const resp = sess.version >= 2 ? Buffer.concat([Buffer.from([id]), typeBuf]) : typeBuf;
          sendFrame(MSG.CONTROL_PACKAGE_SETUP_OUTPUTS, resp);
          ctrl.traffic?.record('urRtde', { client: peer, dir: 'req', summary: `SETUP_OUT #${id} (${names.length} vars, ${sess.freq}Hz)`, ok: valid, ms: performance.now() - t0 });
          break;
        }
        case MSG.CONTROL_PACKAGE_SETUP_INPUTS: {
          const names = payload.toString('utf8').split(',').map((s) => s.trim()).filter(Boolean);
          const fields = [];
          const types = [];
          let valid = names.length > 0;
          for (const nm of names) {
            const spec = inFieldSpec(nm);
            if (!spec) { types.push('NOT_FOUND'); valid = false; }
            else { types.push(spec.type); fields.push({ name: nm, spec }); }
          }
          const id = valid ? sess.nextInId++ : 0;
          if (valid) sess.inRecipes.set(id, { id, fields });
          const typeBuf = Buffer.from(types.join(','), 'utf8');
          sendFrame(MSG.CONTROL_PACKAGE_SETUP_INPUTS, Buffer.concat([Buffer.from([id]), typeBuf]));
          ctrl.traffic?.record('urRtde', { client: peer, dir: 'req', summary: `SETUP_IN #${id} (${names.length} vars)`, ok: valid, ms: performance.now() - t0 });
          break;
        }
        case MSG.CONTROL_PACKAGE_START: {
          stopTimer();
          const ok = sess.activeOutId !== null && sess.outRecipes.has(sess.activeOutId);
          sendFrame(MSG.CONTROL_PACKAGE_START, Buffer.from([ok ? 1 : 0]));
          if (ok) {
            const ms = Math.max(8, Math.round(1000 / sess.freq));
            sendOutputData();
            sess.timer = setInterval(sendOutputData, ms);
          }
          log(`스트림 시작 (${ok ? sess.freq + 'Hz' : '레시피 없음'})`, true);
          break;
        }
        case MSG.CONTROL_PACKAGE_PAUSE: {
          stopTimer();
          sendFrame(MSG.CONTROL_PACKAGE_PAUSE, Buffer.from([1]));
          break;
        }
        case MSG.DATA_PACKAGE: {
          if (payload.length < 1) break;
          const rid = payload[0];
          const rec = sess.inRecipes.get(rid);
          if (!rec) break;
          let off = 1;
          const vals = {};
          for (const f of rec.fields) {
            if (off + TYPE_SIZE[f.spec.type] > payload.length) break;
            const [v, nextOff] = readField(payload, off, f.spec.type);
            off = nextOff;
            vals[f.name] = v;
            if (f.spec.kind === 'in_i') ctrl.regs.set(`RTDE_IN_I:${f.spec.idx}`, v);
            else if (f.spec.kind === 'in_f') ctrl.regs.set(`RTDE_IN_F:${f.spec.idx}`, v);
            else if (f.name === 'input_bit_registers0_to_31') {
              for (let i = 0; i < 32; i++) ctrl.regs.set(`RTDE_IN_B:${i}`, !!((v >>> i) & 1));
            } else if (f.name === 'input_bit_registers32_to_63') {
              for (let i = 0; i < 32; i++) ctrl.regs.set(`RTDE_IN_B:${32 + i}`, !!((v >>> i) & 1));
            }
          }
          if (vals.speed_slider_mask & 1 && vals.speed_slider_fraction !== undefined) {
            ctrl.setOverride(Math.max(1, Math.min(100, Math.round(vals.speed_slider_fraction * 100))));
          }
          if (vals.standard_digital_output_mask !== undefined && vals.standard_digital_output !== undefined) {
            for (let i = 0; i < 8; i++) if (vals.standard_digital_output_mask & (1 << i)) ctrl.setDO(i + 1, !!(vals.standard_digital_output & (1 << i)));
          }
          if (vals.standard_analog_output_mask !== undefined) {
            if ((vals.standard_analog_output_mask & 1) && vals.standard_analog_output_0 !== undefined) ctrl.setAO?.(1, vals.standard_analog_output_0);
            if ((vals.standard_analog_output_mask & 2) && vals.standard_analog_output_1 !== undefined) ctrl.setAO?.(2, vals.standard_analog_output_1);
          }
          ctrl.emitState();
          ctrl.traffic?.record('urRtde', { client: peer, dir: 'req', summary: `DATA_IN #${rid} (${rec.fields.length} vars)`, hex: hexOf(payload, 24), ok: true, ms: performance.now() - t0 });
          break;
        }
      }
    };

    let chain = Promise.resolve();
    sock.on('data', (chunk) => {
      sess.buf = sess.buf.length ? Buffer.concat([sess.buf, chunk]) : chunk;
      while (sess.buf.length >= 3) {
        const len = sess.buf.readUInt16BE(0);
        if (len < 3 || len > 65535) { sock.destroy(); return; }
        if (sess.buf.length < len) break;
        const type = sess.buf[2];
        const payload = Buffer.from(sess.buf.subarray(3, len));
        sess.buf = sess.buf.subarray(len);
        chain = chain.then(() => handlePacket(type, payload));
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      stopTimer();
      clients.delete(sess);
      ctrl.traffic?.disconnect('urRtde', peer);
      log(`클라이언트 종료 ${peer}`, true);
    });
  });

  const r = await bindServer(server, port, host);
  if (r.error) {
    ctrl.log('comm', `[${TAG}] TCP ${port} 바인딩 실패: ${r.error.message}`);
    return { name: 'UR RTDE', proto: 'tcp', port: null, close() {} };
  }
  ctrl.log('comm', `[${TAG}] UR RTDE 서버 TCP ${r.port} 대기`);
  return {
    name: 'UR RTDE', proto: 'tcp', port: r.port,
    close() {
      for (const s of clients) { if (s.timer) clearInterval(s.timer); s.sock.destroy(); }
      clients.clear();
      try { server.close(); } catch {}
    },
  };
}
