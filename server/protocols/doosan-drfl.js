// Doosan Robotics DRFL 스타일 외부 제어 소켓 서버 — TCP 기본 포트 12345
//  - 줄 단위 텍스트 명령 또는 JSON 명령 모두 지원:
//      GET_POSJ / GET_POSX / GET_STATE / GET_DI <n> / SET_DI <n> <0|1> / GET_DO <n> / SET_DO <n> <0|1>
//      GET_AI <n> / SET_AO <n> <val> / SERVO <ON|OFF> / MODE <TEACH|PLAY|REMOTE> / OVERRIDE <1..100>
//      START / STOP / HOLD / RESUME / RESET_ALARM
//      MOVEJ <j1,j2,j3,j4,j5,j6> [vel%] / MOVEL <x,y,z,a,b,c> [vel_mm_s]
import net from 'node:net';
import { makeLogger, bindServer, baseTcp, toVendorPose, fromVendorPose, startMove, progRunning } from './common.js';
import { peerOf } from './traffic.js';

const TAG = 'DOOSAN-DRFL';

export async function start(ctrl, opts = {}) {
  const port = opts.port ?? 12345;
  const host = opts.host ?? '0.0.0.0';
  const log = makeLogger(ctrl, TAG);
  const sockets = new Set();

  async function execCmd(raw) {
    const line = raw.trim();
    if (!line) return '';
    let cmd, args = [];
    if (line.startsWith('{')) {
      const obj = JSON.parse(line);
      cmd = String(obj.cmd || '').toUpperCase();
      args = Array.isArray(obj.args) ? obj.args : (obj.value !== undefined ? [obj.value] : []);
      if (obj.joints) args = [obj.joints.join(','), obj.vel ?? 30];
      if (obj.pose) args = [obj.pose.join(','), obj.vel ?? 200];
    } else {
      const parts = line.split(/\s+/);
      cmd = parts[0].toUpperCase();
      args = parts.slice(1);
    }

    switch (cmd) {
      case 'PING': return 'OK PONG';
      case 'GET_POSJ': return `OK ${JSON.stringify(ctrl.joints.map((v) => +v.toFixed(4)))}`;
      case 'GET_POSX': return `OK ${JSON.stringify(toVendorPose('doosan', baseTcp(ctrl)).map((v) => +v.toFixed(4)))}`;
      case 'GET_STATE': return `OK ${JSON.stringify({
        robot: ctrl.robot.name, servo: ctrl.servo, mode: ctrl.mode, override: ctrl.override,
        running: progRunning(ctrl), held: ctrl.held, alarms: ctrl.alarms.map((a) => ({ code: a.code, vendorCode: a.vendorCode, msg: a.msg })),
      })}`;
      case 'GET_DI': { const n = Number(args[0]); return `OK ${ctrl.getDI(n) ? 1 : 0}`; }
      case 'SET_DI': { const n = Number(args[0]); ctrl.setDI(n, Number(args[1]) !== 0 && String(args[1]).toLowerCase() !== 'false'); return 'OK'; }
      case 'GET_DO': { const n = Number(args[0]); return `OK ${ctrl.getDO(n) ? 1 : 0}`; }
      case 'SET_DO': { const n = Number(args[0]); ctrl.setDO(n, Number(args[1]) !== 0 && String(args[1]).toLowerCase() !== 'false'); return 'OK'; }
      case 'GET_AI': { const n = Number(args[0]); return `OK ${ctrl.getAI?.(n) ?? 0}`; }
      case 'SET_AO': { const n = Number(args[0]), v = Number(args[1]); ctrl.setAO?.(n, v); return 'OK'; }
      case 'OVERRIDE': { ctrl.setOverride(Number(args[0])); return `OK ${ctrl.override}`; }
      case 'SERVO': {
        const on = /^(1|on|true)$/i.test(String(args[0] ?? ''));
        if (on && !ctrl.allow('servoOn')) return `ERR ${ctrl.lastReject.reason}`;
        if (ctrl.setServo(on) === false) return 'ERR SERVO_REJECTED';
        return `OK ${ctrl.servo ? 'ON' : 'OFF'}`;
      }
      case 'MODE': {
        const m = String(args[0] || '').toUpperCase();
        if (ctrl.setMode(m) === false) return `ERR ${ctrl.lastReject.reason}`;
        return `OK ${ctrl.mode}`;
      }
      case 'START': {
        if (!ctrl.allow('start')) return `ERR ${ctrl.lastReject.reason}`;
        const ok = await ctrl.start({ step: false });
        return ok ? 'OK' : `ERR ${ctrl.compileError?.msg || 'START_FAILED'}`;
      }
      case 'STOP': ctrl.stopProgram(); return 'OK';
      case 'HOLD': ctrl.hold(); return 'OK';
      case 'RESUME': return ctrl.resume() === false ? `ERR ${ctrl.lastReject?.reason || 'RESUME_FAILED'}` : 'OK';
      case 'RESET_ALARM': ctrl.resetAlarms(); return 'OK';
      case 'MOVEJ': {
        const j = String(args[0] || '').split(',').map(Number);
        if (j.length !== 6 || !j.every(Number.isFinite)) return 'ERR BAD_JOINTS';
        const frac = Math.max(0.01, Math.min(1, (Number(args[1]) || 30) / 100));
        const err = await startMove(ctrl, { kind: 'J', target: { joints: j }, speed: { frac }, base: null }, log);
        return err ? `ERR ${err.message}` : 'OK';
      }
      case 'MOVEL': {
        const p = String(args[0] || '').split(',').map(Number);
        if (p.length !== 6 || !p.every(Number.isFinite)) return 'ERR BAD_POSE';
        const tcp = Math.max(1, Number(args[1]) || 200);
        const err = await startMove(ctrl, { kind: 'L', target: { pose: fromVendorPose('doosan', p) }, speed: { tcp }, base: null }, log);
        return err ? `ERR ${err.message}` : 'OK';
      }
      default: return `ERR UNKNOWN_CMD ${cmd}`;
    }
  }

  const server = net.createServer((sock) => {
    const peer = peerOf(sock);
    if (sockets.size >= 16) { sock.destroy(); return; }
    sockets.add(sock);
    ctrl.traffic?.connect('doosanDrfl', peer);
    log(`클라이언트 접속 ${peer}`, true);
    let buf = '';
    let chain = Promise.resolve();
    sock.setNoDelay(true);
    sock.setTimeout(120_000, () => sock.destroy());

    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.length > 65536) { sock.destroy(); return; }
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        chain = chain.then(async () => {
          if (sock.destroyed) return;
          const t0 = performance.now();
          if (await ctrl.traffic?.applyFault('doosanDrfl', peer, line.slice(0, 60))) return;
          let resp;
          try { resp = await execCmd(line); }
          catch (e) { resp = `ERR ${e.message}`; }
          if (resp && !sock.destroyed) sock.write(resp + '\n');
          ctrl.traffic?.record('doosanDrfl', { client: peer, dir: 'req', summary: `${line.slice(0, 50)} → ${resp.slice(0, 40)}`, ok: !resp.startsWith('ERR'), error: resp.startsWith('ERR') ? resp : null, ms: performance.now() - t0 });
        });
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => { sockets.delete(sock); ctrl.traffic?.disconnect('doosanDrfl', peer); log(`클라이언트 종료 ${peer}`, true); });
  });

  const r = await bindServer(server, port, host);
  if (r.error) {
    ctrl.log('comm', `[${TAG}] TCP ${port} 바인딩 실패: ${r.error.message}`);
    return { name: 'Doosan DRFL Socket', proto: 'tcp', port: null, close() {} };
  }
  ctrl.log('comm', `[${TAG}] Doosan DRFL 소켓 TCP ${r.port} 대기`);
  return {
    name: 'Doosan DRFL Socket', proto: 'tcp', port: r.port,
    close() { for (const s of sockets) s.destroy(); sockets.clear(); try { server.close(); } catch {} },
  };
}
