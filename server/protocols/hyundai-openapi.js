// Hyundai Robotics Hi6 "Open API" 스타일 REST(JSON over HTTP) 에뮬레이션 — 기본 포트 8888
//
// ※ 주의: 현대로보틱스 Hi5/Hi6 Open API 의 정확한 공개 사양을 오프라인에서 확인할 수 없어,
//   일반적으로 알려진 Hi6 Open API 형태(/project/robot/..., /project/rgen, /project/context/tasks[0]/...)를
//   최대한 흉내 냈다. 실제 장비와 연동할 클라이언트를 작성할 때는 반드시 현대로보틱스
//   "Hi6 Open API 매뉴얼"의 경로/필드명을 확인할 것.
//   대신 아래의 /api/... 엔드포인트는 에뮬레이터 고유의 명확히 문서화된 인터페이스이다.
//
// Hi6 스타일 경로 (근사)
//   GET  /project/robot/po_cur                현재 TCP 자세 {_type:'Pose', x,y,z,rx,ry,rz, crd}
//   GET  /project/robot/joint_cur             현재 관절각 {_type:'JntPose', j1..j6}
//   GET  /project/robot/joints/joint_states   관절 상태 배열 [{name, position, velocity, effort}]
//   GET  /project/rgen                        일반 상태 (모터, 재생/티치, 운전 중, 오버라이드, 알람 ...)
//   GET  /project/context/tasks               태스크 목록, GET /project/context/tasks[0] 태스크 0 상태
//   POST /project/context/tasks[0]/start|stop|hold|resume|reset|select {name}
//   POST /project/robot/motor_on | motor_off,  POST /project/robot/move (= /api/move)
//   GET  /project/control/ios/dout/:n , PUT 동일 (값 {value})  — din 도 동일
//
// 에뮬레이터 표준 경로
//   GET  /api/status, /api/pose, /api/joints, /api/alarms ; POST /api/alarms/reset
//   POST /api/servo {on}
//   POST /api/program/start|stop|hold|resume|reset ; POST /api/program/select {name}
//   GET  /api/files ; GET|PUT|DELETE /api/files/:name (PUT 본문 = 잡 텍스트 또는 {text})
//   GET|PUT /api/var/:name ({value} 또는 원시 텍스트)
//   GET|PUT /api/io/do/:n , /api/io/di/:n ({value:true|false|1|0})
//   POST /api/move {type:'joint'|'linear', joints?:[deg], pose?:[x,y,z,rx,ry,rz], speed?, wait?}
//        speed: joint → % (1~100), linear → mm/s
import http from 'node:http';
import { hostAllowed, originAllowed } from '../netguard.js';
import { VENDORS } from '../../shared/robots.js';
import { makeLogger, bindServer, baseTcp, toVendorPose, fromVendorPose, startMove, busy, progRunning, findFile, readBody, safeReadVar, safeWriteVar, stripExt } from './common.js';
import { peerOf } from './traffic.js';

const TAG = 'HYUNDAI-API';

class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

export async function start(ctrl, opts = {}) {
  const port = opts.port ?? 8888;
  const host = opts.host ?? '0.0.0.0';
  const log = makeLogger(ctrl, TAG);

  // ------------------------------------------------------------ 데이터 생성
  const pose = () => {
    const v = toVendorPose('hyundai', baseTcp(ctrl)).map((x) => Math.round(x * 1e6) / 1e6);
    return { x: v[0], y: v[1], z: v[2], rx: v[3], ry: v[4], rz: v[5] };
  };
  const status = () => {
    const vm = ctrl.vm;
    return {
      vendor: ctrl.vendor, controller: VENDORS[ctrl.vendor].controller, robot: ctrl.robot.name, robotId: ctrl.robot.id,
      active: ctrl.vendor === 'hyundai',
      servo: ctrl.servo, mode: ctrl.mode, override: ctrl.override, held: ctrl.held, moving: !!ctrl.segment || !!ctrl.jog,
      alarms: ctrl.alarms.map((a) => ({ code: a.code, msg: a.msg, time: new Date(a.t).toISOString() })),
      program: {
        main: ctrl.main, status: vm?.status ?? 'idle', file: vm?.current?.file ?? null, line: vm?.current?.line ?? null,
        proc: vm?.current?.proc ?? null, cycle: vm?.cycle ?? 0, compileError: ctrl.compileError ?? null,
      },
      joints: ctrl.joints, pose: pose(),
      io: { do: onBits('do'), di: onBits('di') },
    };
  };
  const onBits = (t) => { const r = []; for (let i = 1; i <= 512; i++) if (ctrl.io[t][i]) r.push(i); return r; };

  const readVar = (name) => {
    let v = safeReadVar('hyundai', ctrl, name);
    if (v === undefined) v = ctrl.regs.get(name) ?? ctrl.regs.get(name.toUpperCase());
    return v;
  };
  const writeVar = (name, value) => {
    if (safeWriteVar('hyundai', ctrl, name, value)) return;
    ctrl.regs.set(name, value);
    ctrl.emitState();
  };

  // ------------------------------------------------------------ 동작
  const program = async (action, body = {}) => {
    switch (action) {
      case 'start': {
        if (!ctrl.allow('start')) throw new ApiError(409, ctrl.lastReject.reason);
        if (ctrl.alarms.length) throw new ApiError(409, '알람 상태 — 알람 리셋 필요');
        if (!ctrl.servo) throw new ApiError(409, '서보 OFF 상태');
        const ok = await ctrl.start({ step: !!body.step });
        if (!ok) throw new ApiError(409, ctrl.compileError ? `컴파일 오류: ${ctrl.compileError.msg}` : '프로그램 시작 실패');
        return { ok: true, main: ctrl.main };
      }
      case 'stop': ctrl.stopProgram(); return { ok: true };
      case 'hold': ctrl.hold(); return { ok: true };
      case 'resume': if (ctrl.resume() === false) throw new ApiError(409, ctrl.lastReject?.reason ?? '재개 불가'); return { ok: true };
      case 'reset': ctrl.resetProgram(); return { ok: true };
      case 'select': {
        const name = body.name ?? body.job ?? body.prog;
        if (name === undefined) throw new ApiError(400, 'name 필요');
        let f = findFile(ctrl, String(name), ['.job', '.JOB']);
        if (!f && /^\d+$/.test(String(name))) f = findFile(ctrl, String(name).padStart(4, '0'), ['.job']);
        if (!f) throw new ApiError(404, `잡 없음: ${name}`);
        if (progRunning(ctrl)) throw new ApiError(409, '프로그램 실행 중');
        ctrl.setMain(f);
        return { ok: true, main: f, compileError: ctrl.compileError ?? null };
      }
      default: throw new ApiError(404, `알 수 없는 동작: ${action}`);
    }
  };

  const move = async (b, req) => {
    if (!ctrl.servo) throw new ApiError(409, '서보 OFF 상태');
    if (ctrl.alarms.length) throw new ApiError(409, '알람 상태');
    if (busy(ctrl)) throw new ApiError(409, '로봇 동작 중');
    const type = String(b.type || 'joint').toLowerCase();
    const linear = type === 'linear' || type === 'l';
    let target;
    if (Array.isArray(b.joints)) {
      if (b.joints.length !== 6) throw new ApiError(400, 'joints 는 6개 숫자 배열이어야 합니다');
      const j = b.joints.map(Number);
      if (!j.every(Number.isFinite)) throw new ApiError(400, 'joints 값 오류');
      target = { joints: j };
    } else if (Array.isArray(b.pose)) {
      if (b.pose.length !== 6) throw new ApiError(400, 'pose 는 6개 숫자 배열이어야 합니다');
      const p = b.pose.map(Number);
      if (!p.every(Number.isFinite)) throw new ApiError(400, 'pose 값 오류');
      target = { pose: fromVendorPose('hyundai', p) };
    } else if (b.pose && typeof b.pose === 'object') {
      const p = ['x', 'y', 'z', 'rx', 'ry', 'rz'].map((k) => Number(b.pose[k] ?? 0));
      if (!p.every(Number.isFinite)) throw new ApiError(400, 'pose 값 오류');
      target = { pose: fromVendorPose('hyundai', p) };
    } else throw new ApiError(400, 'joints 또는 pose 필요');
    const speed = linear ? { tcp: Number(b.speed) || 250 } : { frac: Math.max(0.01, Math.min(1, (Number(b.speed) || 20) / 100)) };
    const err = await startMove(ctrl, { kind: linear ? 'L' : 'J', target, speed, base: null }, log);
    if (err) throw new ApiError(err.code === 'UNREACHABLE' ? 422 : 409, err.message);
    if (b.wait) {
      const t0 = Date.now(), maxMs = Math.max(100, Math.min(120000, (Number(b.timeout) || 60) * 1000));
      while (ctrl.segment && !req?.socket?.destroyed && Date.now() - t0 < maxMs) await new Promise((r) => setTimeout(r, 20));
    }
    return { ok: true, accepted: true, done: !ctrl.segment, joints: ctrl.joints };
  };

  const ioNo = (n) => { const k = Number(n); if (!(k >= 1 && k <= 512)) throw new ApiError(400, `IO 번호 범위 오류: ${n}`); return k; };
  const boolOf = (b) => {
    const v = b && typeof b === 'object' ? b.value ?? b.val ?? b.state : b;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    return /^(1|true|on)$/i.test(String(v).trim());
  };

  // ------------------------------------------------------------ 라우팅
  // [메서드, 정규식, 핸들러(match, body, req, url) → 객체|{text}|{status,...}]
  const routes = [
    // --- 에뮬레이터 표준
    ['GET', /^\/api\/status$/, () => status()],
    ['GET', /^\/api\/pose$/, () => ({ frame: 'base', ...pose(), vendorPose: ctrl.vendorPose() })],
    ['GET', /^\/api\/joints$/, () => ({ joints: ctrl.joints, names: VENDORS[ctrl.vendor].jointNames })],
    ['GET', /^\/api\/alarms$/, () => status().alarms],
    ['POST', /^\/api\/alarms\/reset$/, () => { ctrl.resetAlarms(); return { ok: true }; }],
    ['POST', /^\/api\/servo$/, (m, b) => {
      const on = boolOf(b && typeof b === 'object' && 'on' in b ? b.on : b);
      if (on && !ctrl.allow('servoOn')) throw new ApiError(409, ctrl.lastReject.reason);
      if (!ctrl.setServo(on)) throw new ApiError(409, '알람 상태에서는 서보 ON 불가');
      return { ok: true, servo: ctrl.servo };
    }],
    ['POST', /^\/api\/program\/(start|stop|hold|resume|reset|select)$/, (m, b) => program(m[1], b || {})],
    ['GET', /^\/api\/files$/, () => [...ctrl.files.keys()].map((name) => ({ name, size: ctrl.files.get(name).length, main: name === ctrl.main }))],
    ['GET', /^\/api\/files\/(.+)$/, (m) => {
      const f = findFile(ctrl, m[1], ['.job']);
      if (!f) throw new ApiError(404, `파일 없음: ${m[1]}`);
      return { text: ctrl.files.get(f) };
    }],
    ['PUT', /^\/api\/files\/(.+)$/, (m, b, req, raw) => {
      if (progRunning(ctrl)) throw new ApiError(409, '프로그램 실행 중에는 파일을 수정할 수 없습니다');
      const text = b && typeof b === 'object' && typeof b.text === 'string' ? b.text : raw.toString('utf8');
      ctrl.loadFiles({ [m[1]]: text });
      return { ok: true, name: m[1], size: text.length, main: ctrl.main, compileError: ctrl.compileError ?? null };
    }],
    ['DELETE', /^\/api\/files\/(.+)$/, (m) => {
      if (progRunning(ctrl)) throw new ApiError(409, '프로그램 실행 중에는 파일을 삭제할 수 없습니다');
      const f = findFile(ctrl, m[1], ['.job']);
      if (!f) throw new ApiError(404, `파일 없음: ${m[1]}`);
      ctrl.deleteFile(f);
      return { ok: true };
    }],
    ['GET', /^\/api\/var\/(.+)$/, (m) => {
      const v = readVar(m[1]);
      if (v === undefined) throw new ApiError(404, `변수 없음: ${m[1]}`);
      return { name: m[1], value: v };
    }],
    ['PUT', /^\/api\/var\/(.+)$/, (m, b, req, raw) => {
      let v = b && typeof b === 'object' && 'value' in b ? b.value : b ?? raw.toString('utf8');
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) v = Number(v);
      writeVar(m[1], v);
      return { ok: true, name: m[1], value: readVar(m[1]) ?? v };
    }],
    ['GET', /^\/api\/io\/(do|di)\/(\d+)$/, (m) => ({ type: m[1], n: Number(m[2]), value: m[1] === 'do' ? ctrl.getDO(ioNo(m[2])) : ctrl.getDI(ioNo(m[2])) })],
    ['PUT', /^\/api\/io\/(do|di)\/(\d+)$/, (m, b, req, raw) => {
      const v = boolOf(b ?? raw.toString('utf8'));
      if (m[1] === 'do') ctrl.setDO(ioNo(m[2]), v); else ctrl.setDI(ioNo(m[2]), v);
      return { ok: true, type: m[1], n: Number(m[2]), value: v };
    }],
    ['POST', /^\/api\/move$/, (m, b, req) => move(b || {}, req)],

    // --- Hi6 Open API 스타일 (근사)
    ['GET', /^\/project\/robot\/po_cur$/, (m, b, req, raw, url) => ({ _type: 'Pose', ...pose(), crd: url.searchParams.get('crd') === '1' ? 'robot' : 'base', mechinfo: 1 })],
    ['GET', /^\/project\/robot\/joint_cur$/, () => Object.fromEntries([['_type', 'JntPose'], ...ctrl.joints.map((v, i) => [`j${i + 1}`, v])])],
    ['GET', /^\/project\/robot\/joints\/joint_states$/, () => ctrl.joints.map((v, i) => ({ name: VENDORS.hyundai.jointNames[i], position: v, velocity: 0, effort: 0 }))],
    ['GET', /^\/project\/rgen$/, () => ({
      _type: 'RGen', is_motor_on: ctrl.servo, enable_state: ctrl.servo ? 1 : 0,
      playback_mode: ctrl.mode !== 'TEACH', teach_mode: ctrl.mode === 'TEACH', remote: ctrl.mode === 'REMOTE',
      is_running: progRunning(ctrl) && !ctrl.held, is_stopped: ctrl.held, is_moving: !!ctrl.segment,
      spd_ratio: ctrl.override, err_cnt: ctrl.alarms.length, robot_model: ctrl.robot.name, cur_prog: ctrl.main ? stripExt(ctrl.main) : null,
    })],
    ['GET', /^\/project\/context\/tasks$/, () => [task()]],
    ['GET', /^\/project\/context\/tasks\[0\]$/, () => task()],
    ['POST', /^\/project\/context\/tasks\[0\]\/(start|stop|hold|resume|reset|select)$/, (m, b) => program(m[1], b || {})],
    ['POST', /^\/project\/robot\/motor_(on|off)$/, (m) => {
      if (m[1] === 'on' && !ctrl.allow('servoOn')) throw new ApiError(409, ctrl.lastReject.reason);
      if (!ctrl.setServo(m[1] === 'on')) throw new ApiError(409, '알람 상태에서는 모터 ON 불가');
      return { ok: true, is_motor_on: ctrl.servo };
    }],
    ['POST', /^\/project\/robot\/move$/, (m, b, req) => move(b || {}, req)],
    ['GET', /^\/project\/control\/ios\/(dout|din)\/(\d+)$/, (m) => ({ _type: 'IoSignal', type: m[1], index: Number(m[2]), val: (m[1] === 'dout' ? ctrl.getDO(ioNo(m[2])) : ctrl.getDI(ioNo(m[2]))) ? 1 : 0 })],
    ['PUT', /^\/project\/control\/ios\/(dout|din)\/(\d+)$/, (m, b, req, raw) => {
      const v = boolOf(b ?? raw.toString('utf8'));
      if (m[1] === 'dout') ctrl.setDO(ioNo(m[2]), v); else ctrl.setDI(ioNo(m[2]), v);
      return { ok: true };
    }],
  ];
  const task = () => ({
    _type: 'Task', task_no: 0, cur_prog: ctrl.main ? stripExt(ctrl.main) : null, cur_file: ctrl.vm?.current?.file ?? null,
    cur_line: ctrl.vm?.current?.line ?? 0, exec_state: ctrl.held ? 'hold' : ctrl.vm?.status ?? 'idle', cycle: ctrl.vm?.cycle ?? 0,
  });

  // ------------------------------------------------------------ HTTP
  const server = http.createServer(async (req, res) => {
    const t0 = performance.now();
    const peer = peerOf(req);
    const cors = {
      'Access-Control-Allow-Origin': req.headers.origin && originAllowed(req) ? req.headers.origin : '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    const send = (status, body) => {
      const isText = body && typeof body === 'object' && 'text' in body && Object.keys(body).length === 1;
      const data = isText ? body.text : JSON.stringify(body);
      res.writeHead(status, { ...cors, 'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8' });
      res.end(data);
    };
    if (!hostAllowed(req)) return send(403, { error: `허용되지 않은 Host: ${req.headers.host}` });   // DNS 리바인딩 방어
    if (!originAllowed(req)) return send(403, { error: `허용되지 않은 Origin: ${req.headers.origin}` }); // 브라우저 CSRF 방어
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return send(400, { error: 'bad url' }); }
    let path;
    try { path = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/'; } catch { return send(400, { error: 'bad url' }); }
    if (await ctrl.traffic?.applyFault('hyundai', peer, `${req.method} ${path}`)) { res.destroy(); return; }
    try {
      const raw = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : Buffer.alloc(0);
      let body = null;
      if (raw.length) {
        const s = raw.toString('utf8');
        if (/json/i.test(req.headers['content-type'] || '') || /^\s*[[{"]/.test(s)) { try { body = JSON.parse(s); } catch { if (/json/i.test(req.headers['content-type'] || '')) throw new ApiError(400, 'JSON 파싱 오류'); } }
      }
      for (const [method, re, fn] of routes) {
        if (method !== req.method) continue;
        const m = re.exec(path);
        if (!m) continue;
        const out = await fn(m, body, req, raw, url);
        log(`${req.method} ${path} → 200`, req.method !== 'GET');
        ctrl.traffic?.record('hyundai', { client: peer, dir: 'req', summary: `${req.method} ${path} → 200`, raw: raw.length ? raw.toString('utf8').slice(0, 200) : '', ok: true, ms: performance.now() - t0 });
        return send(200, out);
      }
      if (path === '/' || path === '/api') {
        return send(200, { name: 'Hyundai Hi6 Open API (emulator)', endpoints: routes.map(([m, re]) => `${m} ${re.source.replace(/\\\//g, '/').replace(/^\^|\$$/g, '')}`) });
      }
      throw new ApiError(404, `경로 없음: ${req.method} ${path}`);
    } catch (e) {
      const st = e instanceof ApiError ? e.status : (e.status || 500);
      log(`${req.method} ${path} → ${st} ${e.message}`, true);
      ctrl.traffic?.record('hyundai', { client: peer, dir: 'req', summary: `${req.method} ${path} → ${st}`, ok: false, error: e.message, ms: performance.now() - t0 });
      send(st, { error: e.message, status: st });
    }
  });

  const r = await bindServer(server, port, host);
  if (r.error) ctrl.log('comm', `[${TAG}] HTTP ${port} 바인딩 실패: ${r.error.message}`);
  else ctrl.log('comm', `[${TAG}] Open API HTTP ${r.port} 대기`);
  return {
    name: 'Hyundai Hi6 Open API (REST)', proto: 'http', vendor: 'hyundai',
    port: r.error ? null : r.port,
    close() { server.closeAllConnections?.(); try { server.close(); } catch {} },
  };
}
