// Kawasaki AS 터미널 (TCP/텔넷) 에뮬레이션 — 기본 포트 23 (바인딩 실패 시 10023)
//  - 접속 시 "login: " → 아무 사용자(as) 허용 → 배너 + ">" 프롬프트
//  - 텔넷 IAC 협상 바이트는 제거. 클라이언트가 IAC 를 보내면(진짜 텔넷 클라이언트) 서버 에코 활성화
//  - 명령: WHERE, HERE, POINT, ZPOW/ZPOWER, EXECUTE, PRIME, HOLD, CONTINUE, ABORT, KILL, ERESET, STATUS,
//          SPEED, DO, PRINT, TYPE, SIGNAL, IO, DIRECTORY/DIR, LIST, LOAD, SAVE, DELETE, ID, TIME, HELP, EXIT
//  - LOAD 파일명: 이후 수신 텍스트를 Ctrl-Z(0x1A)까지 파일 내용으로 저장 (KRterm 식 단순 전송, STX/ETB 제어문자는 무시)
//  - SAVE 파일명: 파일 내용을 전송하고 Ctrl-Z(0x1A)로 끝을 알림
import net from 'node:net';
import { makeLogger, bindServer, baseTcp, toVendorPose, langExt, safeReadVar, safeWriteVar, makeCycleRunner, progRunning, findFile, stripExt, fx, lpad, pad } from './common.js';
import { parseExpr, evaluate } from '../lang/expr.js';
import { VENDORS } from '../../shared/robots.js';

const TAG = 'KAWASAKI-AS';
const CRLF = '\r\n';
const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const OPT_ECHO = 1, OPT_SGA = 3;
const ERR_INVALID = '(P1002)Invalid command.';

// AS 프로그램 목록 (.PROGRAM 이름) — as.js 의 listPrograms 가 없을 때 사용
function fallbackPrograms(ctrl) {
  const out = [];
  for (const [file, text] of ctrl.files) {
    const re = /^\s*\.PROGRAM\s+([A-Za-z_][\w.]*)/gim;
    let m, any = false;
    while ((m = re.exec(text))) { out.push({ name: m[1], file }); any = true; }
    if (!any) out.push({ name: stripExt(file), file });
  }
  return out;
}

const loadName = (n) => (/\.\w+$/.test(n) ? n : n + '.as');

// 파일에서 특정 .PROGRAM 블록 추출
function extractProgram(text, name) {
  const re = new RegExp(`^\\s*\\.PROGRAM\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[\\s\\S]*?^\\s*\\.END\\s*$`, 'im');
  const m = re.exec(text);
  return m ? m[0] : null;
}

export async function start(ctrl, opts = {}) {
  const port = opts.port ?? 23;
  const fallbackPort = opts.fallbackPort ?? 10023;
  const host = opts.host ?? '0.0.0.0';
  const log = makeLogger(ctrl, TAG);
  const cycles = makeCycleRunner(ctrl, log);
  const clients = new Set();
  let primed = null; // PRIME/EXECUTE 로 선택된 프로그램 이름

  const as = () => langExt('kawasaki');

  async function programs() {
    const m = await as();
    try {
      const r = m?.listPrograms?.(ctrl);
      if (Array.isArray(r) && r.length) {
        const fb = fallbackPrograms(ctrl);
        return r.map((p) => (typeof p === 'string' ? { name: p, file: fb.find((x) => x.name.toUpperCase() === p.toUpperCase())?.file ?? findFile(ctrl, p, ['.as', '.pg']) } : p));
      }
    } catch {}
    return fallbackPrograms(ctrl);
  }

  // 프로그램 이름 → main 파일 선택
  async function selectProgram(name) {
    const list = await programs();
    const p = list.find((x) => String(x.name).toUpperCase() === name.toUpperCase());
    const m = await as();
    if (m?.selectProgram) { try { if (m.selectProgram(ctrl, name)) return true; } catch {} }
    const file = p?.file ?? findFile(ctrl, name, ['.as', '.pg']);
    if (!file || !ctrl.files.has(file)) return false;
    ctrl.asEntry = name; // as.js 규약: 시작 프로그램 이름 (setMain → compile 시 사용)
    ctrl.setMain(file);
    return true;
  }

  async function fmtValue(v) {
    const m = await as();
    if (m?.formatValue) { try { return String(m.formatValue(v)); } catch {} }
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : fx(v, 3);
    if (typeof v === 'boolean') return v ? '-1' : '0';
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'number' ? fx(x, 3) : String(x))).join(' ');
    if (v && typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  // 언어 모듈 execLine 이 없을 때 PRINT 용 간이 평가
  function evalFallback(expr) {
    const ast = parseExpr(expr);
    return evaluate(ast, {
      get: (n) => {
        const v = safeReadVar('kawasaki', ctrl, n);
        if (v === undefined) throw new Error(`(P1013)Variable is not defined. ${n}`);
        return v;
      },
      call: (n, args) => {
        const f = { SIN: (x) => Math.sin(x * Math.PI / 180), COS: (x) => Math.cos(x * Math.PI / 180), SQRT: Math.sqrt, ABS: Math.abs, SIG: (n) => (n > 0 ? ctrl.getDO(n) : ctrl.getDI(-n)) ? -1 : 0 }[String(n).toUpperCase()];
        if (!f) throw new Error(`(P1002)Invalid function. ${n}`);
        return f(...args);
      },
    });
  }

  // ------------------------------------------------------------ 출력 포맷
  function whereText() {
    const j = ctrl.joints;
    const p = toVendorPose('kawasaki', baseTcp(ctrl));
    const row = (a) => a.map((v) => lpad(typeof v === 'number' ? fx(v, 3) : v, 10)).join('');
    return [
      row(['JT1', 'JT2', 'JT3', 'JT4', 'JT5', 'JT6']),
      row(j),
      row(['X[mm]', 'Y[mm]', 'Z[mm]', 'O[deg]', 'A[deg]', 'T[deg]']),
      row(p),
    ].join(CRLF);
  }

  function statusText() {
    const vm = ctrl.vm;
    const running = progRunning(ctrl);
    const lines = [];
    lines.push(`Robot status: ${ctrl.alarms.length ? 'Error occurred.' : 'Error free.'}`);
    lines.push(`               Motor power ${ctrl.servo ? 'on' : 'off'}.`);
    lines.push(`               ${ctrl.mode === 'TEACH' ? 'TEACH' : 'REPEAT'} mode.`);
    lines.push(`               ${running && !ctrl.held ? 'Program running.' : ctrl.held ? 'Program held.' : 'Program not running.'}`);
    lines.push(`Environment:   Monitor speed(%)  = ${lpad(fx(ctrl.override, 1), 10)}`);
    lines.push(`               Program speed(%)  ALWAYS = ${lpad('100.0', 8)}`);
    lines.push(`               ALWAYS Accu.[mm]  = ${lpad('1.0', 8)}`);
    lines.push(`Stepper status: ${running ? (ctrl.held ? 'Program is held.' : 'Program is running.') : vm?.status === 'done' ? 'Program completed.' : 'Program is not running.'}`);
    lines.push('Execution cycles');
    lines.push(`     Completed cycles: ${vm?.cycle ?? 0}`);
    lines.push(`     Remaining cycles: ${cycles.active ? (cycles.remaining < 0 ? 'Infinite' : cycles.remaining) : 0}`);
    lines.push(`${pad('Program name', 16)}${pad('Priority', 10)}Step No.`);
    const cur = vm?.current;
    const name = primed || ctrl.asEntry || (ctrl.main ? stripExt(ctrl.main) : '');
    if (name) lines.push(`${pad(cur?.proc || name, 16)}${pad(running ? '1' : '0', 10)}${cur?.line ?? 0}`);
    if (ctrl.alarms.length) for (const a of ctrl.alarms) lines.push(`(E${String(a.code).slice(0, 6)}) ${a.msg}`);
    return lines.join(CRLF);
  }

  function ioText() {
    const out = [];
    const bits = (get, from) => {
      let s = '';
      for (let i = from + 31; i >= from; i--) {
        s += get(i) ? 'o' : 'x';
        if ((i - from) % 8 === 0 && i !== from) s += ' ';
      }
      return s;
    };
    for (let b = 1; b <= 64; b += 32) out.push(`${lpad(b + 31, 5)}-${lpad(b, 5)}  ${bits((n) => ctrl.getDO(n), b)}`);
    for (let b = 1; b <= 64; b += 32) out.push(`${lpad(b + 1031, 5)}-${lpad(b + 1000, 5)}  ${bits((n) => ctrl.getDI(n), b)}`);
    return out.join(CRLF);
  }

  function idText() {
    const v = VENDORS[ctrl.robot.vendor];
    return [
      `Robot model : ${ctrl.robot.name}${ctrl.robot.vendor !== 'kawasaki' ? ` (${v.name})` : ''}`,
      'Controller  : F60 (AS Emulator)',
      'AS version  : ASF_01000000E-EMU',
      `Serial No.  : EMU-${ctrl.robot.id.toUpperCase()}`,
      `Axes        : 6   Payload ${ctrl.robot.payload} kg   Reach ${ctrl.robot.reach} mm`,
    ].join(CRLF);
  }

  const timeText = () => {
    const d = new Date(), z = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${z(d.getMonth() + 1)}/${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
  };

  // 언어 모듈의 executeLine 실행 (HERE/POINT/DO/PRINT 등)
  async function execLine(line) {
    const m = await as();
    if (!m?.executeLine) return null;
    const r = await m.executeLine(ctrl, line);
    return r == null ? '' : String(r);
  }

  // ------------------------------------------------------------ 명령 처리 → 출력 문자열
  async function command(sess, raw) {
    const line = raw.trim();
    if (!line) return '';
    const sp = line.search(/\s/);
    const cmd = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
    const arg = sp < 0 ? '' : line.slice(sp + 1).trim();
    const onOff = (s) => (/^ON$/i.test(s) ? true : /^OFF$/i.test(s) ? false : null);

    switch (cmd) {
      case 'WHERE': case 'WH': return whereText();
      case 'HERE': case 'POINT': case 'PO': {
        const r = await execLine(`${cmd === 'PO' ? 'POINT' : cmd} ${arg}`);
        if (r !== null) return r;
        // 폴백: 변환값(trans)을 언어 모듈 writeVar 로 저장
        const name = arg.split('=')[0].trim();
        if (!name) return '(P1009)Missing argument.';
        const src = cmd === 'HERE' ? toVendorPose('kawasaki', baseTcp(ctrl)) : null;
        if (!src) return '(P2000)POINT 명령은 AS 언어 모듈이 필요합니다.';
        const val = name.startsWith('#') ? { kind: 'joints', v: [...ctrl.joints] } : { kind: 'trans', v: src };
        if (!safeWriteVar('kawasaki', ctrl, name, val)) ctrl.regs.set(`AS:${name.toUpperCase()}`, val);
        return `${name} = ${val.v.map((x) => fx(x, 3)).join(' ')}`;
      }
      case 'ZPOW': case 'ZPOWER': {
        const v = onOff(arg);
        if (v === null) return `Motor power ${ctrl.servo ? 'ON' : 'OFF'}`;
        if (v && !ctrl.allow('servoOn')) return `(P1013)Cannot turn on motor power. ${ctrl.lastReject.reason}`;
        if (!ctrl.setServo(v)) return '(P1013)Cannot turn on motor power. Reset error first.';
        return `Motor power ${v ? 'ON' : 'OFF'}`;
      }
      case 'EXECUTE': case 'EX': case 'EXE': case 'PRIME': case 'PR': {
        const [nm, cy] = arg.split(',').map((s) => s.trim());
        const name = nm || primed || ctrl.asEntry || (ctrl.main ? stripExt(ctrl.main) : '');
        if (!name) return '(P1009)Program name is missing.';
        if (progRunning(ctrl) && !ctrl.held) return '(P1013)Program is already running.';
        if (!cmd.startsWith('PR') && !ctrl.allow('start')) return `(P1013)Cannot execute program. ${ctrl.lastReject.reason}`;
        if (progRunning(ctrl)) ctrl.stopProgram();
        if (!(await selectProgram(name))) return `(P1001)Program does not exist. ${name}`;
        primed = name;
        if (cmd.startsWith('PR')) return `Program ${name} primed.`;
        if (ctrl.compileError) return `(P1100)Program error: ${ctrl.compileError.msg}${ctrl.compileError.line ? ` (line ${ctrl.compileError.line})` : ''}`;
        if (!ctrl.servo) return '(P1013)Motor power is OFF.';
        const ok = await ctrl.start();
        if (!ok) return `(P1013)Cannot execute program. ${ctrl.alarms.length ? 'Error occurred.' : ''}`;
        const n = cy === undefined || cy === '' ? 1 : Number(cy);
        cycles.set(n < 0 ? -1 : Math.max(0, n - 1));
        return '';
      }
      case 'HOLD': case 'HO': ctrl.hold(); return '';
      case 'CONTINUE': case 'CONT': case 'CO': {
        if (!progRunning(ctrl)) return '(P1013)Program is not running.';
        if (!ctrl.allow('resume')) return `(P1013)Cannot continue. ${ctrl.lastReject.reason}`;
        const ok = await ctrl.start();
        return ok ? '' : '(P1013)Cannot continue.';
      }
      case 'ABORT': case 'AB': ctrl.hold(); return '';
      case 'KILL': case 'KI': cycles.stop(); ctrl.resetProgram(); return '';
      case 'ERESET': case 'ER': ctrl.resetAlarms(); return '';
      case 'STATUS': case 'ST': return statusText();
      case 'SPEED': case 'SP': {
        if (!arg) return `Monitor speed(%) = ${fx(ctrl.override, 1)}`;
        const n = parseFloat(arg);
        if (!Number.isFinite(n) || n <= 0 || n > 100) return '(P1009)Invalid speed.';
        ctrl.setOverride(n);
        return '';
      }
      case 'DO': {
        const r = await execLine(arg);
        return r !== null ? r : '(P2000)DO 명령은 AS 언어 모듈이 필요합니다.';
      }
      case 'PRINT': case 'TYPE': case 'TY': case 'PRI': {
        const r = await execLine(`${cmd.startsWith('T') ? 'TYPE' : 'PRINT'} ${arg}`);
        if (r !== null) return r;
        const parts = arg.split(',').map((s) => s.trim()).filter(Boolean);
        const out = [];
        for (const p of parts) {
          if (/^".*"$/.test(p)) { out.push(p.slice(1, -1)); continue; }
          try { out.push(await fmtValue(evalFallback(p))); } catch (e) { return e.message; }
        }
        return out.join(' ');
      }
      case 'SIGNAL': case 'SIG': {
        if (!arg) return '(P1009)Missing argument.';
        for (const s of arg.split(',')) {
          const n = parseInt(s, 10);
          if (!Number.isFinite(n) || n === 0) return `(P1009)Invalid signal number. ${s.trim()}`;
          const a = Math.abs(n), on = n > 0;
          if (a >= 1001 && a <= 1512) ctrl.setDI(a - 1000, on); // 입력 신호 (에뮬레이터 시뮬레이션용)
          else if (a >= 1 && a <= 512) ctrl.setDO(a, on);
          else if (a >= 2001 && a <= 2256) ctrl.setDO(a - 2000 + 256, on); // 내부 신호 → DO 257~512 영역에 매핑
          else return `(P1009)Signal number out of range. ${a}`;
        }
        return '';
      }
      case 'IO': return ioText();
      case 'DIRECTORY': case 'DIR': case 'DI': {
        const list = await programs();
        const lines = list.map((p) => `  ${pad(p.name, 16)}${p.file && p.file !== p.name ? p.file : ''}`);
        return [`Programs: ${list.length}`, ...lines].join(CRLF);
      }
      case 'LIST': case 'LI': {
        const m = /^(?:\/([A-Z]+)\s+)?(.*)$/i.exec(arg);
        const name = (m?.[2] || '').trim();
        if (!name) return [...ctrl.files.values()].join('\n').replace(/\r?\n/g, CRLF);
        for (const [, text] of ctrl.files) { const b = extractProgram(text, name); if (b) return b.replace(/\r?\n/g, CRLF); }
        const f = findFile(ctrl, name, ['.as', '.pg']);
        if (f) return ctrl.files.get(f).replace(/\r?\n/g, CRLF);
        return `(P1001)Program does not exist. ${name}`;
      }
      case 'LOAD': {
        const name = arg.replace(/^\/\w+\s+/, '').trim();
        if (!name) return '(P1009)File name is missing.';
        // 업로드 상태 전환은 수신 루프에서 동기적으로 처리된다 (같은 청크의 파일 내용 유실 방지)
        log(`LOAD 시작: ${loadName(name)}`, true);
        return { raw: `Loading... ${loadName(name)} (send file text, end with Ctrl-Z)${CRLF}`, noPrompt: true };
      }
      case 'SAVE': {
        const name = arg.replace(/^\/\w+\s+/, '').trim();
        let text;
        const f = name && findFile(ctrl, name, ['.as', '.pg']);
        if (f) text = ctrl.files.get(f);
        else if (!name || /\.\w+$/.test(name)) text = [...ctrl.files.values()].join('\n'); // 전체 저장
        else {
          for (const [, t] of ctrl.files) { const b = extractProgram(t, name); if (b) { text = b; break; } }
          if (!text) return `(P1001)Program does not exist. ${name}`;
        }
        log(`SAVE ${name || '(전체)'} ${text.length} bytes`, true);
        return { raw: `Saving...${CRLF}` + text.replace(/\r?\n/g, CRLF) + (text.endsWith('\n') ? '' : CRLF) + '\x1a' + CRLF };
      }
      case 'DELETE': case 'DEL': case 'DE': {
        const name = arg.replace(/^\/\w+\s+/, '').trim();
        if (!name) return '(P1009)Missing argument.';
        const f = findFile(ctrl, name, ['.as', '.pg']);
        if (f) { ctrl.deleteFile(f); return ''; }
        for (const [file, t] of ctrl.files) {
          const b = extractProgram(t, name);
          if (b) { ctrl.loadFiles({ [file]: t.replace(b, '').replace(/\n{3,}/g, '\n\n') }); return ''; }
        }
        return `(P1001)Program does not exist. ${name}`;
      }
      case 'ID': return idText();
      case 'TIME': return timeText();
      case 'HELP': return 'WHERE HERE POINT ZPOWER EXECUTE PRIME HOLD CONTINUE ABORT KILL ERESET STATUS SPEED DO PRINT TYPE SIGNAL IO DIRECTORY LIST LOAD SAVE DELETE ID TIME EXIT';
      case 'EXIT': case 'LOGOUT': case 'BYE': return { close: true };
      default: {
        // 단독 변수 대입 등은 언어 모듈에 위임 (예: "a = 3")
        if (/^[A-Za-z_#.$][\w.]*\s*(\[.*\])?\s*=/.test(line)) {
          const r = await execLine(line);
          if (r !== null) return r;
        }
        return ERR_INVALID;
      }
    }
  }

  // ------------------------------------------------------------ 세션
  function onConnection(sock) {
    const peer = `${sock.remoteAddress}:${sock.remotePort}`;
    const sess = { state: 'login', line: [], echo: false, upload: null, lastCR: false, queue: Promise.resolve() };
    clients.add(sock);
    sock.setNoDelay(true);
    log(`접속: ${peer}`, true);
    const write = (s) => { if (!sock.destroyed) sock.write(Buffer.from(s, 'utf8')); };
    write('login: ');

    const enableEcho = () => {
      if (sess.echo) return;
      sess.echo = true;
      sock.write(Buffer.from([IAC, WILL, OPT_ECHO, IAC, WILL, OPT_SGA]));
    };

    const handleLine = async (line) => {
      if (sess.state === 'login') {
        sess.user = line.trim() || 'as';
        sess.state = 'cmd';
        log(`로그인: ${sess.user} (${peer})`, true);
        write(`${CRLF}Kawasaki AS terminal emulator  -  ${ctrl.robot.name}${CRLF}AS system emulation. Type HELP for commands.${CRLF}${CRLF}>`);
        return;
      }
      let out;
      try { out = await command(sess, line); } catch (e) { out = `(P9999)${e.message}`; }
      const summary = typeof out === 'string' ? out.split(/\r?\n/)[0].slice(0, 60) : out?.raw ? '(파일 전송)' : 'EXIT';
      log(`${line.trim().slice(0, 60)} → ${summary || 'OK'}`, true);
      if (out && typeof out === 'object') {
        if (out.close) { write(`${CRLF}Logout.${CRLF}`); sock.end(); return; }
        write(CRLF + out.raw + (out.noPrompt ? '' : '>'));
        return;
      }
      write(CRLF + (out ? out + CRLF : '') + '>');
    };

    const finishUpload = (up) => {
      let text = Buffer.concat(up.buf).toString('utf8').replace(/[\x02\x17]/g, '').replace(/\r\n?/g, '\n');
      text = text.replace(/^\n+/, '');
      ctrl.loadFiles({ [up.name]: text });
      const n = (text.match(/^\s*\.PROGRAM\s/gim) || []).length;
      const err = ctrl.compileError;
      log(`LOAD 완료: ${up.name} (${text.length} bytes, 프로그램 ${n}개)`, true);
      write(`${CRLF}${up.name} loaded. ${n} program(s), ${text.length} bytes.${err ? `${CRLF}(P1100)${err.msg}${err.line ? ` line ${err.line}` : ''}` : ''}${CRLF}>`);
    };

    sock.on('data', (chunk) => {
      // 텔넷 IAC 처리
      const bytes = [];
      for (let i = 0; i < chunk.length; i++) {
        const b = chunk[i];
        if (b === IAC && !sess.upload) {
          const c = chunk[i + 1];
          if (c === IAC) { bytes.push(IAC); i++; continue; }
          if (c >= WILL && c <= DONT) { i += 2; enableEcho(); continue; }
          if (c === SB) { while (i < chunk.length && !(chunk[i] === IAC && chunk[i + 1] === SE)) i++; i++; enableEcho(); continue; }
          i++; continue;
        }
        bytes.push(b);
      }
      for (const b of bytes) {
        if (sess.upload) {
          if (b === 0x1a) { const up = sess.upload; sess.upload = null; sess.line = []; sess.queue = sess.queue.then(() => finishUpload(up)); continue; }
          sess.upload.buf.push(Buffer.from([b]));
          continue;
        }
        if (b === 0x0d || b === 0x0a) {
          if (b === 0x0a && sess.lastCR) { sess.lastCR = false; continue; }
          sess.lastCR = b === 0x0d;
          const line = Buffer.from(sess.line).toString('utf8'); sess.line = [];
          if (sess.echo) write(CRLF);
          // LOAD 명령: 같은 TCP 청크에 이어지는 파일 내용을 놓치지 않도록 즉시 업로드 모드로 전환
          const lm = sess.state === 'cmd' && /^\s*LOAD\s+(?:\/\w+\s+)?(\S.*)$/i.exec(line);
          if (lm) sess.upload = { name: loadName(lm[1].trim()), buf: [] };
          sess.queue = sess.queue.then(() => handleLine(line));
          continue;
        }
        sess.lastCR = false;
        if (b === 0) continue;
        if (b === 0x08 || b === 0x7f) { if (sess.line.length) { sess.line.pop(); if (sess.echo) write('\b \b'); } continue; }
        if (b === 0x03) { sess.line = []; write(`${CRLF}>`); continue; }
        sess.line.push(b);
        if (sess.echo && sess.state === 'cmd') sock.write(Buffer.from([b]));
      }
    });
    sock.on('close', () => { clients.delete(sock); log(`연결 종료: ${peer}`, true); });
    sock.on('error', () => {});
  }

  const make = () => net.createServer(onConnection);
  let server = make();
  let r = await bindServer(server, port, host);
  if (r.error && ['EACCES', 'EADDRINUSE', 'EPERM'].includes(r.error.code) && fallbackPort && fallbackPort !== port) {
    ctrl.log('comm', `[${TAG}] TCP ${port} 바인딩 실패(${r.error.code}) → ${fallbackPort} 로 대체`);
    server = make();
    r = await bindServer(server, fallbackPort, host);
  }
  if (r.error) ctrl.log('comm', `[${TAG}] TCP 바인딩 실패: ${r.error.message}`);
  else ctrl.log('comm', `[${TAG}] AS 터미널 TCP ${r.port} 대기`);

  return {
    name: 'Kawasaki AS Terminal (telnet)', proto: 'tcp', vendor: 'kawasaki',
    port: r.error ? null : r.port,
    close() {
      cycles.stop();
      for (const s of clients) s.destroy();
      try { server.close(); } catch {}
    },
  };
}
