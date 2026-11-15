// AI 도구: 로봇 프로그램 생성·검증 + 가상 로봇 직접 제어(서보·이동·I/O·그리퍼). MCP 서버(server/ai/mcp.js)와 Claude 채팅(server/ai/chat.js)이 함께 사용
//  - 모든 도구는 컨트롤러(ctrl)를 직접 조작한다 → 웹 UI 에 즉시 반영
//  - 입력 스키마는 JSON Schema (MCP inputSchema / Claude API input_schema 공용)
//  - run(ctrl, input) → 결과 객체(JSON 직렬화해 반환). 실패는 Error throw → 호출 측에서 isError 처리
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VENDORS } from '../../shared/robots.js';
import { fromVendorPose } from '../../shared/poseformat.js';
import { mulv } from '../../shared/math.js';

const LANG_FILE = { yaskawa: 'inform.js', kawasaki: 'as.js', hyundai: 'hrscript.js', abb: 'rapid.js', kuka: 'krl.js' };
const EXT_RE = { yaskawa: /\.jbi$/i, kawasaki: /\.(as|pg)$/i, hyundai: /\.job$/i, abb: /\.(mod|modx|prg|sys|sysx)$/i, kuka: /\.(src|dat)$/i };
const NAME_RE = /^[\w$\-. ]{1,64}$/;
const r2 = (v) => Math.round(v * 100) / 100;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// 언어 모듈 파일 상단의 주석 블록 = 이 에뮬레이터가 지원하는 문법 요약
const guideCache = new Map();
function syntaxSummary(vendor) {
  if (guideCache.has(vendor)) return guideCache.get(vendor);
  const file = fileURLToPath(new URL(`../lang/${LANG_FILE[vendor]}`, import.meta.url));
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('//')) break;
    out.push(line.replace(/^\/\/ ?/, ''));
  }
  const text = out.join('\n');
  guideCache.set(vendor, text);
  return text;
}

function programStatus(ctrl) {
  const st = ctrl.snapshot();
  return {
    status: st.program.status, held: st.held, main: st.program.main, current: st.program.current,
    cycleCount: st.program.cycle, compileError: st.program.compileError,
    lastCycle: st.cycle.last ? { total_s: st.cycle.last.total, motion_s: st.cycle.last.motion, wait_s: st.cycle.last.wait, moves: st.cycle.last.moves } : null,
    alarms: st.alarms.map((a) => `[${a.code}] ${a.msg}`),
    collision: st.collision.hit ? st.collision.pairs.map((p) => `${p.a}↔${p.b}`) : [],
    servo: st.servo, mode: st.mode,
    joints: st.joints.map(r2), tcp: st.tcp.map((v) => r2(v)),
    gripper: { closed: st.grip.closed, holding: st.grip.holding },
    objects: st.objects.map((o) => ({ id: o.id, p: o.p.map(r2) })),
  };
}

// Claude 의 동작 명령(서보 ON·이동·시작·재개)은 외부 기기(PLC·상위 PC)와 같은 출처로 처리
//  → 모드 인터록이 켜져 있으면 REMOTE 모드에서만 허용. 정지·HOLD·서보 OFF·I/O·파일 작업은 모드와 무관
const AI_SOURCE = 'ext';
const REMOTE_HINT = '운전 모드를 화면(펜던트)에서 REMOTE 로 바꿔 달라고 사용자에게 요청하세요. 모드는 Claude 가 바꿀 수 없습니다.';
function rejectError(ctrl, what) {
  const r = ctrl.lastReject;
  const why = r?.reason ?? '알 수 없는 이유';
  return new Error(`${what} 거부: ${why}${r?.code === 1 ? ` (현재 모드 ${ctrl.mode}). ${REMOTE_HINT}` : ''}`);
}

// 직접 제어 도구 공통: 현재 로봇 상태 요약
function robotStatus(ctrl) {
  const st = ctrl.snapshot();
  return {
    servo: st.servo, mode: st.mode, held: st.held, moving: !ctrl.motionIdle, override: st.override,
    joints_deg: st.joints.map(r2), tcp_vendor: st.tcp.map(r2),
    gripper: { closed: st.grip.closed, holding: st.grip.holding },
    alarms: st.alarms.map((a) => `[${a.code}] ${a.msg}`),
    collision: st.collision.hit ? st.collision.pairs.map((p) => `${p.a}↔${p.b}`) : [],
    lastReject: ctrl.lastReject && Date.now() - ctrl.lastReject.t < 5000 ? `${ctrl.lastReject.op}: ${ctrl.lastReject.reason}` : null,
  };
}

function programBusy(ctrl) {
  const s = ctrl.vm?.status;
  return s === 'running' || s === 'paused';
}

const numArray = (v, n, what) => {
  if (!Array.isArray(v) || !n.includes(v.length) || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new Error(`${what}: 숫자 ${n.join(' 또는 ')}개 배열이어야 합니다`);
  return v;
};

// 모션 완료(또는 시간 초과)까지 대기. 실패는 Error throw
async function awaitMotion(ctrl, p, waitSec) {
  let timer;
  const timeout = new Promise((res) => { timer = setTimeout(() => res('timeout'), Math.max(0, Math.min(120, waitSec)) * 1000); });
  try {
    const r = await Promise.race([p.then(() => 'done'), timeout]);
    return r;
  } catch (e) {
    if (e.aborted) return 'aborted';
    throw new Error(`이동 실패 [${e.code ?? 'MOTION'}]: ${e.message}`);
  } finally { clearTimeout(timer); }
}

function recentLogs(ctrl, n = 30, src) {
  return ctrl.logs.filter((e) => !src || e.src === src).slice(-n).map((e) => `${new Date(e.t).toTimeString().slice(0, 8)} ${e.src} ${e.msg}`);
}

export const TOOLS = [
  {
    name: 'get_context',
    description: '현재 에뮬레이터 상태를 조회한다: 선택된 로봇(제조사·모델·관절 한계·도달 거리), 로봇 언어와 파일 확장자, 그리퍼와 TCP·그리퍼 I/O 번호, 현재 관절각과 TCP(제조사 표기), 셀 레이아웃(테이블·공작물·장애물·컨베이어 등 주변기기, 로봇 베이스 좌표 mm), 카메라, 프로그램 파일 목록·메인·컴파일 오류·실행 상태. 로봇 프로그램을 작성하기 전에 반드시 먼저 호출해 좌표와 I/O 번호를 확인한다.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run(ctrl) {
      const st = ctrl.snapshot();
      const r = ctrl.robot, v = VENDORS[r.vendor];
      return {
        robot: { id: r.id, vendor: r.vendor, vendorName: v.name, model: r.name, controller: v.controller, payload_kg: r.payload, ratedPayload_kg: r.ratedPayload ?? null, reach_mm: r.reach, jointLimits_deg: r.limits, maxSpeed_degps: r.maxSpeed, jointNames: v.jointNames, poseNames: v.poseNames },
        language: { name: v.language, ext: v.ext },
        gripper: { id: ctrl.gripper.id, name: ctrl.gripper.name, kind: ctrl.gripper.kind, tcp_xyzrpy: ctrl.gripper.tcp, stroke_mm: ctrl.gripper.stroke ?? null, io: st.gripperIO, ioNote: 'close/open = 그리퍼 닫기/열기 DO 번호, fbClosed/fbOpen/fbPart = 닫힘/열림/공작물 감지 DI 번호' },
        pose: { joints_deg: st.joints.map(r2), tcp_vendor: st.tcp.map(r2), tcpNote: '제조사 표기 (yaskawa/hyundai: X,Y,Z,Rx,Ry,Rz / kuka: X,Y,Z,A,B,C / kawasaki: X,Y,Z,O,A,T / abb: x,y,z,q1..q4)' },
        scene: { table: st.scene.table, floorZ: st.scene.floorZ, pedestal: st.scene.pedestal },
        cell: ctrl.cell?.getLayout ? ctrl.cell.getLayout() : null,
        objects: st.objects.map((o) => ({ id: o.id, size_mm: o.size, p: o.p.map(r2) })),
        ioNames: st.io.names,
        cameras: st.cameras,
        program: { files: [...ctrl.files.keys()], main: ctrl.main, status: st.program.status, compileError: st.program.compileError },
        state: { servo: st.servo, mode: st.mode, override: st.override, alarms: st.alarms.map((a) => `[${a.code}] ${a.msg}`), collisionMode: st.collisionMode, blendEnabled: st.blendEnabled },
        coordinateNote: '모든 좌표는 로봇 베이스 기준 mm. 테이블 윗면 z = scene.table.z(보통 0). 공작물 p 는 중심 좌표 → 윗면 = p.z + size_z/2.',
      };
    },
  },
  {
    name: 'get_language_guide',
    description: '현재 로봇 제조사 언어에서 이 에뮬레이터가 지원하는 문법 요약과, 현재 셀 배치에 맞춰 자동 생성한 동작하는 예제 프로그램(파일별 전체 내용)을 반환한다. 새 프로그램을 쓸 때 예제의 파일 구조·좌표 표기·그리퍼 I/O 사용법·툴 정의를 그대로 따른다.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run(ctrl) {
      return { vendor: ctrl.vendor, language: VENDORS[ctrl.vendor].language, syntax: syntaxSummary(ctrl.vendor), exampleFiles: ctrl.lang.defaultFiles(ctrl) };
    },
  },
  {
    name: 'read_program',
    description: '가상 컨트롤러에 저장된 프로그램 파일 내용을 읽는다.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: '파일 이름 (get_context 의 program.files 중 하나)' } }, required: ['name'], additionalProperties: false },
    run(ctrl, { name }) {
      if (!ctrl.files.has(name)) throw new Error(`파일 없음: ${name}. 있는 파일: ${[...ctrl.files.keys()].join(', ') || '(없음)'}`);
      return { name, text: ctrl.files.get(name) };
    },
  },
  {
    name: 'write_program',
    description: '로봇 프로그램 파일을 가상 컨트롤러에 저장(같은 이름이면 덮어씀)하고 컴파일한다. 웹 UI 에디터에 바로 나타난다. 결과의 compileError 가 null 이 아니면 해당 파일·라인을 고쳐 다시 저장한다. 파일 확장자는 현재 제조사 언어에 맞아야 한다 (get_context 의 language.ext).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '파일 이름 (예: PICK.JBI, pick.as, 0001.job, MainModule.mod, pick.src / pick.dat)' },
        text: { type: 'string', description: '파일 전체 내용' },
        set_main: { type: 'boolean', description: 'true 면 이 파일을 메인 프로그램으로 지정 (기본 true, .dat 등 보조 파일은 false)' },
      },
      required: ['name', 'text'],
      additionalProperties: false,
    },
    run(ctrl, { name, text, set_main = true }) {
      if (!NAME_RE.test(name)) throw new Error(`사용할 수 없는 파일 이름: ${name}`);
      if (!EXT_RE[ctrl.vendor].test(name)) throw new Error(`${VENDORS[ctrl.vendor].name} 언어 파일 확장자가 아닙니다: ${name} (사용 가능: ${VENDORS[ctrl.vendor].ext})`);
      const s = ctrl.vm?.status;
      if (s === 'running' || s === 'paused') throw new Error('프로그램 실행 중에는 파일을 바꿀 수 없습니다. run_program 의 stop 을 먼저 호출하세요.');
      ctrl.loadFiles({ [name]: text });
      if (set_main) ctrl.setMain(name);
      ctrl.log('program', `AI: ${name} 저장${set_main ? ' (메인)' : ''}`);
      ctrl.emit('files');
      return { saved: name, main: ctrl.main, files: [...ctrl.files.keys()], compileError: ctrl.compileError ?? null, ok: !ctrl.compileError };
    },
  },
  {
    name: 'run_program',
    description: '가상 로봇에서 메인 프로그램을 제어하고 결과를 확인한다. start/step 은 운전 모드가 REMOTE 일 때만 가능하다 (모드 인터록). action: start(서보 자동 ON 후 처음부터 실행), step(한 줄 실행), stop(정지), reset(정지 후 처음으로), reset_alarms(알람 해제), status(조회만). start/step 은 wait_seconds 동안 종료를 기다린 뒤 상태·사이클 타임·알람·간섭·공작물 위치·최근 로그를 반환한다. 실제 로봇이 아니라 에뮬레이터의 가상 로봇만 움직인다.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'step', 'stop', 'reset', 'reset_alarms', 'status'] },
        wait_seconds: { type: 'number', description: 'start/step 후 최대 대기 시간 초 (0~120, 기본 30). 프로그램이 끝나면 바로 반환' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async run(ctrl, { action, wait_seconds = 30 }) {
      const logStart = ctrl.logs.length ? ctrl.logs[ctrl.logs.length - 1].t : 0;
      let started = null;
      switch (action) {
        case 'stop': ctrl.stopProgram(); break;
        case 'reset': ctrl.resetProgram(); break;
        case 'reset_alarms': ctrl.resetAlarms(); break;
        case 'status': break;
        case 'start': case 'step': {
          if (!ctrl.servo && ctrl.setServo(true, AI_SOURCE) === false) throw rejectError(ctrl, '서보 ON');
          started = await ctrl.start({ step: action === 'step', source: AI_SOURCE });
          if (!started && ctrl.lastReject?.op === 'start') throw rejectError(ctrl, '프로그램 시작');
          if (started) {
            const until = Date.now() + Math.max(0, Math.min(120, Number(wait_seconds) || 0)) * 1000;
            await sleep(200);
            while (Date.now() < until && ctrl.vm?.status === 'running' && !ctrl.held && !ctrl.alarms.length) await sleep(200);
          }
          break;
        }
        default: throw new Error(`알 수 없는 action: ${action}`);
      }
      const st = programStatus(ctrl);
      return {
        action, started, ...st,
        stillRunning: st.status === 'running',
        logs: ctrl.logs.filter((e) => e.t >= logStart).slice(-40).map((e) => `${e.src} ${e.msg}`),
      };
    },
  },
  // ------------------------------------------------------------ 직접 제어 (가상 로봇을 바로 움직임)
  {
    name: 'set_servo',
    description: '가상 로봇의 서보 전원을 켜거나 끈다. 서보 ON 은 REMOTE 모드에서만 가능하다. 이동 전에 서보 ON 이 필요하다. 알람이 있으면 reset_alarms=true 로 먼저 해제할 수 있다. 비상정지 중에는 켜지지 않는다.',
    input_schema: {
      type: 'object',
      properties: {
        on: { type: 'boolean', description: 'true = 서보 ON, false = 서보 OFF' },
        reset_alarms: { type: 'boolean', description: 'true 면 서보 ON 전에 알람 리셋 (기본 false)' },
      },
      required: ['on'],
      additionalProperties: false,
    },
    run(ctrl, { on, reset_alarms = false }) {
      if (on && reset_alarms) ctrl.resetAlarms();
      const r = ctrl.setServo(on, AI_SOURCE);
      if (on && r === false) throw rejectError(ctrl, '서보 ON');
      ctrl.log('system', `AI: 서보 ${on ? 'ON' : 'OFF'}`);
      return robotStatus(ctrl);
    },
  },
  {
    name: 'move_robot',
    description: '가상 로봇을 직접 이동시키고 도착(또는 wait_seconds 초과)까지 기다린 뒤 최종 관절각·TCP·알람을 반환한다. 대상은 정확히 하나만 지정: home(홈 자세) / joints(관절각 deg, 6개) / pose(TCP 절대 위치, 제조사 표기 — get_context 의 pose.tcp_vendor 와 같은 형식) / offset_mm(현재 TCP 기준 상대 이동 [dx,dy,dz], 자세 유지) / joint_offsets(현재 관절각에 더할 deg, 6개). motion: joint(관절보간, 기본) 또는 linear(직선보간, pose/offset_mm 에만). REMOTE 모드와 서보 ON 이 필요하며 프로그램 실행 중에는 사용할 수 없다. 좌표는 로봇 베이스 기준 mm.',
    input_schema: {
      type: 'object',
      properties: {
        home: { type: 'boolean', description: 'true 면 홈 자세로 관절 이동' },
        joints: { type: 'array', items: { type: 'number' }, description: '목표 관절각 deg [J1..J6]' },
        joint_offsets: { type: 'array', items: { type: 'number' }, description: '현재 관절각에 더할 값 deg [dJ1..dJ6]' },
        pose: { type: 'array', items: { type: 'number' }, description: 'TCP 목표 (제조사 표기: yaskawa/hyundai X,Y,Z,Rx,Ry,Rz / kuka X,Y,Z,A,B,C / kawasaki X,Y,Z,O,A,T / abb x,y,z,q1..q4)' },
        offset_mm: { type: 'array', items: { type: 'number' }, description: '현재 TCP 에서 상대 이동 [dx,dy,dz] mm' },
        frame: { type: 'string', enum: ['base', 'tool'], description: 'offset_mm 의 좌표계 (기본 base)' },
        motion: { type: 'string', enum: ['joint', 'linear'], description: '보간 방식 (기본 joint)' },
        speed_percent: { type: 'number', description: '속도 % (1~100, 기본 20). joint: 관절 최고속 대비, linear: TCP 최고속 대비. 오버라이드가 추가로 적용됨' },
        wait_seconds: { type: 'number', description: '도착 대기 최대 시간 초 (0~120, 기본 30). 0 이면 시작만 하고 바로 반환' },
      },
      additionalProperties: false,
    },
    async run(ctrl, input) {
      const { home, joints, joint_offsets, pose, offset_mm, frame = 'base', motion = 'joint', speed_percent = 20, wait_seconds = 30 } = input;
      const targets = [home ? 'home' : null, joints && 'joints', joint_offsets && 'joint_offsets', pose && 'pose', offset_mm && 'offset_mm'].filter(Boolean);
      if (targets.length !== 1) throw new Error('home / joints / joint_offsets / pose / offset_mm 중 정확히 하나를 지정하세요');
      if (programBusy(ctrl)) throw new Error('프로그램 실행 중에는 직접 이동할 수 없습니다. run_program 의 stop 을 먼저 호출하세요.');
      const safe = ctrl.checkCommand('move', AI_SOURCE);
      if (safe) throw new Error(`이동 거부: ${safe.reason}${safe.code === 1 ? ` (현재 모드 ${ctrl.mode}). ${REMOTE_HINT}` : ''}`);
      if (!ctrl.servo) throw new Error('서보 OFF 상태입니다. set_servo(on=true) 를 먼저 호출하세요.');
      if (ctrl.alarms.length) throw new Error(`알람 발생 중: ${ctrl.alarms.map((a) => `[${a.code}] ${a.msg}`).join(', ')} — set_servo(on=true, reset_alarms=true) 로 해제 후 다시 시도하세요.`);
      if (ctrl.held) throw new Error('HOLD 상태입니다. stop_robot(action=resume 또는 stop) 후 다시 시도하세요.');
      if (!ctrl.motionIdle) throw new Error('이전 이동이 아직 진행 중입니다. 끝날 때까지 기다리거나 stop_robot(action=stop) 을 호출하세요.');

      const frac = Math.max(1, Math.min(100, speed_percent)) / 100;
      let target;
      if (home) target = { joints: [...ctrl.robot.home] };
      else if (joints) target = { joints: [...numArray(joints, [6], 'joints')] };
      else if (joint_offsets) target = { joints: ctrl.joints.map((v, i) => v + numArray(joint_offsets, [6], 'joint_offsets')[i]) };
      else if (pose) target = { pose: fromVendorPose(ctrl.vendor, numArray(pose, ctrl.vendor === 'abb' ? [7] : [6], 'pose')) };
      else {
        const d = numArray(offset_mm, [3], 'offset_mm');
        const cur = ctrl.tcpPose();
        const dv = frame === 'tool' ? mulv(cur.R, d) : d;
        target = { pose: { p: cur.p.map((v, i) => v + dv[i]), R: cur.R } };
      }
      const kind = motion === 'linear' ? 'L' : 'J';
      if (kind === 'L' && target.joints) throw new Error('linear 이동은 pose 또는 offset_mm 대상에서만 사용할 수 있습니다');
      const speed = kind === 'J' ? { frac } : { tcp: frac * ctrl.robot.tcpMaxSpeed };
      ctrl.log('system', `AI: ${kind === 'J' ? '관절' : '직선'} 이동 (${targets[0]}, ${Math.round(frac * 100)}%)`);
      const result = await awaitMotion(ctrl, ctrl.move({ kind, target, speed, source: AI_SOURCE }), Number(wait_seconds) || 0);
      return { result, ...robotStatus(ctrl) };
    },
  },
  {
    name: 'stop_robot',
    description: '가상 로봇 동작 제어: hold(일시 정지 — 프로그램·이동 모두), resume(HOLD 해제 후 재개 — REMOTE 모드에서만), stop(진행 중인 이동 취소 + 프로그램 정지). status 는 조회만.',
    input_schema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['hold', 'resume', 'stop', 'status'] } },
      required: ['action'],
      additionalProperties: false,
    },
    run(ctrl, { action }) {
      if (action === 'hold') ctrl.hold();
      else if (action === 'resume') { if (ctrl.resume(AI_SOURCE) === false) throw rejectError(ctrl, '재개'); }
      else if (action === 'stop') {
        if (programBusy(ctrl)) ctrl.stopProgram();
        ctrl.cancelMotion();
        if (ctrl.held) { ctrl.held = false; ctrl.emitState(); }
        ctrl.log('system', 'AI: 동작 정지');
      }
      return robotStatus(ctrl);
    },
  },
  {
    name: 'set_io',
    description: '가상 컨트롤러 I/O 를 쓴다. type=do 는 로봇 출력(그리퍼 DO 면 그리퍼가 실제로 개폐), type=di 는 입력 시뮬레이션(센서·PLC 신호 흉내). 번호와 이름은 get_context 의 ioNames·gripper.io 참고.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['do', 'di'] },
        n: { type: 'integer', description: 'I/O 번호 (1부터)' },
        value: { type: 'boolean' },
      },
      required: ['type', 'n', 'value'],
      additionalProperties: false,
    },
    run(ctrl, { type, n, value }) {
      if (type === 'do') ctrl.setDO(n, value); else ctrl.setDI(n, value);
      ctrl.log('system', `AI: ${type.toUpperCase()}${n} = ${value ? 'ON' : 'OFF'}`);
      const st = ctrl.snapshot();
      return { type, n, value: type === 'do' ? ctrl.getDO(n) : ctrl.getDI(n), doOn: st.io.do, diOn: st.io.di };
    },
  },
  {
    name: 'gripper',
    description: '가상 그리퍼를 열거나 닫는다 (그리퍼 DO 로 구동 → 닫힘·열림·감지 DI 피드백도 갱신). 닫을 때 TCP 근처에 공작물이 있으면 파지하고, 열면 내려놓는다. 결과의 holding 에 파지한 공작물 id.',
    input_schema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['open', 'close'] } },
      required: ['action'],
      additionalProperties: false,
    },
    async run(ctrl, { action }) {
      const g = ctrl.gripperIO, close = action === 'close';
      if (g.close) ctrl.setDO(g.close, close);
      if (g.open && g.open !== g.close) ctrl.setDO(g.open, !close);
      if (!g.close) ctrl.gripperCmd(close);
      // 개폐 동작(시뮬레이션) 완료 대기 — 최대 3초
      const until = Date.now() + 3000;
      while (Date.now() < until && (close ? ctrl.grip.pos < 0.95 && !ctrl.grip.holding : ctrl.grip.pos > 0.05)) await sleep(50);
      ctrl.log('system', `AI: 그리퍼 ${close ? '닫기' : '열기'}`);
      return { action, closed: ctrl.grip.closed, holding: ctrl.grip.holding?.id ?? null, position: r2(ctrl.grip.pos) };
    },
  },
  {
    name: 'get_logs',
    description: '컨트롤러 로그(시스템·프로그램 PRINT/MSG·그리퍼·통신·알람)의 최근 항목을 반환한다.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '개수 (1~200, 기본 40)' },
        source: { type: 'string', enum: ['system', 'program', 'gripper', 'comm', 'alarm'], description: '이 출처만' },
      },
      additionalProperties: false,
    },
    run(ctrl, { limit = 40, source } = {}) {
      return { logs: recentLogs(ctrl, Math.max(1, Math.min(200, Number(limit) || 40)), source) };
    },
  },
];

// 최소 JSON Schema 검증 (type / required / enum / additionalProperties:false)
export function validateInput(tool, input) {
  const s = tool.input_schema;
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return '입력은 객체여야 합니다';
  for (const k of s.required || []) if (!(k in input)) return `필수 항목 누락: ${k}`;
  for (const [k, v] of Object.entries(input)) {
    const p = s.properties?.[k];
    if (!p) { if (s.additionalProperties === false) return `알 수 없는 항목: ${k}`; continue; }
    const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
    const ok = p.type === 'integer' ? Number.isInteger(v) : p.type === 'number' ? isNum(v)
      : p.type === 'array' ? Array.isArray(v) && (p.items?.type !== 'number' || v.every(isNum)) : typeof v === p.type;
    if (!ok) return `${k}: ${p.type} 형식이어야 합니다`;
    if (p.enum && !p.enum.includes(v)) return `${k}: ${p.enum.join('|')} 중 하나여야 합니다`;
  }
  return null;
}

// 도구 실행 → { text, isError }
export async function callTool(ctrl, name, input) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { text: `알 수 없는 도구: ${name}`, isError: true };
  const bad = validateInput(tool, input ?? {});
  if (bad) return { text: `입력 오류: ${bad}`, isError: true };
  try {
    const r = await tool.run(ctrl, input ?? {});
    return { text: JSON.stringify(r), isError: false };
  } catch (e) {
    return { text: e.message, isError: true };
  }
}
