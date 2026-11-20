// Universal Robots Dashboard Server 에뮬레이션 — TCP 29999, 줄 단위 텍스트 명령 (\n 종료)
//  접속 시 "Connected: Universal Robots Dashboard Server" 를 보내고, 명령마다 한 줄로 응답한다 (응답 문구는 UR 설명서 형식).
//  명령: load <프로그램>, play, stop, pause, quit, shutdown, running, robotmode, get loaded program, programState,
//        power on|off, brake release, unlock protective stop, close safety popup, restart safety, safetymode, safetystatus,
//        is in remote control, get operational mode, set operational mode manual|automatic, clear operational mode,
//        popup <문자열>, close popup, addToLog <문자열>, isProgramSaved, polyscopeVersion, version, get robot model,
//        get serial number, generate flight report(무시)
//  에뮬레이터 대응
//   - load: .urp 이름을 주어도 같은 이름의 .script 파일을 메인으로 고른다 (PolyScope 프로그램 파일은 지원하지 않음)
//   - power on = 전원만 켬(IDLE), brake release = 서보 ON(RUNNING), power off = 서보 OFF
//   - play/stop/pause 는 외부 명령이라 모드 인터록(원격 모드)·안전 판정을 받는다. 거부되면 "Failed to execute: play"
import net from 'node:net';
import { makeLogger, bindServer, findFile, progRunning, stripExt } from './common.js';

const TAG = 'UR-DASHBOARD';

export async function start(ctrl, opts = {}) {
  const port = opts.port ?? 29999;
  const host = opts.host ?? '0.0.0.0';
  const log = makeLogger(ctrl, TAG);
  const clients = new Set();
  let powered = !!ctrl.servo;   // 전원 켜짐(브레이크 잠김) 상태 — 서보 OFF 여도 IDLE 로 보이게
  let loaded = null;             // load 로 고른 이름 (응답 표시용)

  const programName = () => loaded ?? (ctrl.main ? ctrl.main : null);
  const programState = () => {
    if (progRunning(ctrl)) return ctrl.held || ctrl.vm?.status === 'paused' ? 'PAUSED' : 'PLAYING';
    return 'STOPPED';
  };
  const robotMode = () => {
    if (ctrl.servo) return 'RUNNING';
    return powered ? 'IDLE' : 'POWER_OFF';
  };
  const safetyMode = () => {
    if (ctrl.estopActive) return 'ROBOT_EMERGENCY_STOP';
    if (ctrl.safety?.fenceOpen) return 'SAFEGUARD_STOP';
    if (ctrl.alarms.length) return 'PROTECTIVE_STOP';
    return 'NORMAL';
  };
  const modelName = () => (ctrl.vendor === 'ur' ? String(ctrl.robot.name).replace(/e$/i, '') : 'UR5');

  async function handle(line) {
    const raw = line.trim();
    const cmd = raw.toLowerCase();
    if (!raw) return null;
    let m;
    if ((m = /^load\s+(.+)$/i.exec(raw))) {
      const want = m[1].trim();
      const base = stripExt(want.split(/[\\/]/).pop());
      const file = findFile(ctrl, base, ['.script', '.urscript']);
      if (!file) return `File not found: ${want}`;
      try { ctrl.stopProgram(); ctrl.setMain(file); } catch (e) { return `Error while loading program: ${want}`; }
      if (ctrl.compileError) return `Error while loading program: ${want}`;
      loaded = want;
      log(`load ${want} → ${file}`);
      return `Loading program: ${want}`;
    }
    if (cmd === 'play') {
      if (!programName()) return 'Failed to execute: play';
      const ok = await ctrl.start();
      log(`play → ${ok ? '시작' : '거부'}`);
      return ok ? 'Starting program' : 'Failed to execute: play';
    }
    if (cmd === 'stop') {
      if (!progRunning(ctrl)) return 'Failed to execute: stop';
      ctrl.stopProgram();
      return 'Stopped';
    }
    if (cmd === 'pause') {
      if (!progRunning(ctrl)) return 'Failed to execute: pause';
      ctrl.hold();
      return 'Pausing program';
    }
    if (cmd === 'running') return `Program running: ${progRunning(ctrl) && programState() === 'PLAYING' ? 'true' : 'false'}`;
    if (cmd === 'robotmode') return `Robotmode: ${robotMode()}`;
    if (cmd === 'get loaded program') return programName() ? `Loaded program: ${programName()}` : 'No program loaded';
    if (cmd === 'programstate') return `${programState()} ${programName() ?? ''}`.trim();
    if (cmd === 'isprogramsaved') return `true ${programName() ?? ''}`.trim();
    if (cmd === 'power on') { powered = true; return 'Powering on'; }
    if (cmd === 'power off') { powered = false; if (ctrl.servo) ctrl.setServo(false); return 'Powering off'; }
    if (cmd === 'brake release') {
      powered = true;
      ctrl.setServo(true);   // 거부되면 사유는 로그에 남고 robotmode 가 IDLE 로 보인다 (실제 UR 도 응답은 같음)
      return 'Brake releasing';
    }
    if (cmd === 'unlock protective stop') { ctrl.resetAlarms(); return ctrl.alarms.length ? 'Cannot unlock protective stop until 5s after occurrence. Always inspect cause of protective stop before unlocking' : 'Protective stop releasing'; }
    if (cmd === 'close safety popup') return 'closing safety popup';
    if (cmd === 'restart safety') { ctrl.resetAlarms(); return 'Restarting safety'; }
    if (cmd === 'safetymode') return `Safetymode: ${safetyMode()}`;
    if (cmd === 'safetystatus') return `Safetystatus: ${safetyMode()}`;
    if (cmd === 'is in remote control') return ctrl.mode === 'REMOTE' ? 'true' : 'false';
    if (cmd === 'get operational mode') return ctrl.mode === 'TEACH' ? 'MANUAL' : 'AUTOMATIC';
    if ((m = /^set operational mode\s+(manual|automatic)$/i.exec(raw))) {
      ctrl.setMode(m[1].toLowerCase() === 'manual' ? 'TEACH' : 'PLAY');
      return `Operational mode '${m[1].toLowerCase()}' is set`;
    }
    if (cmd === 'clear operational mode') return 'No longer controlling the operational mode. Current operational mode: \'' + (ctrl.mode === 'TEACH' ? 'manual' : 'automatic') + '\'.';
    if ((m = /^popup\s+(.*)$/i.exec(raw))) { log(`popup: ${m[1]}`, true); return 'showing popup'; }
    if (cmd === 'close popup') return 'closing popup';
    if ((m = /^addtolog\s+(.*)$/i.exec(raw))) { ctrl.log('comm', `[${TAG}] 로그: ${m[1]}`); return 'Added log message'; }
    if (cmd === 'polyscopeversion') return 'URSoftware 5.21.0 (Robot Emulator)';
    if (cmd === 'version') return '5.21.0';
    if (cmd === 'get robot model') return modelName();
    if (cmd === 'get serial number') return '20265500001';
    if (cmd === 'generate flight report') return 'Flight Report generated with id: 0';
    if (cmd === 'shutdown') { log('shutdown 요청 (에뮬레이터는 무시)', true); return 'Shutting down'; }
    if (cmd === 'quit') return { quit: 'Disconnected' };
    return `could not understand: '${raw}'`;
  }

  const make = () => net.createServer((sock) => {
    clients.add(sock);
    log(`접속 ${sock.remoteAddress}:${sock.remotePort}`, true);
    sock.write('Connected: Universal Robots Dashboard Server\n');
    let buf = '', chain = Promise.resolve();
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k).replace(/\r$/, '');
        buf = buf.slice(k + 1);
        chain = chain.then(async () => {
          let r;
          try { r = await handle(line); } catch (e) { r = `could not understand: '${line.trim()}'`; log(`오류: ${e.message}`); }
          if (r === null || sock.destroyed) return;
          if (typeof r === 'object') { sock.end(r.quit + '\n'); return; }
          sock.write(r + '\n');
        });
      }
      if (buf.length > 65536) buf = '';
    });
    sock.on('close', () => clients.delete(sock));
    sock.on('error', () => clients.delete(sock));
  });

  const server = make();
  const r = await bindServer(server, port, host);
  if (r.error) ctrl.log('comm', `[${TAG}] TCP ${port} 바인딩 실패: ${r.error.message}`);
  else ctrl.log('comm', `[${TAG}] Dashboard Server TCP ${r.port} 대기`);
  return {
    name: 'UR Dashboard Server', proto: 'TCP (text)', port: r.error ? null : r.port,
    close: () => new Promise((res) => { for (const c of clients) c.destroy(); server.close(() => res()); }),
  };
}
