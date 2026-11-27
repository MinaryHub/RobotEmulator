// 가상 로봇 컨트롤러 — 상태/모션/IO/그리퍼/공작물/프로그램 관리의 단일 진실 원천(authoritative)
// UI(WebSocket)와 각 제조사 통신 인터페이스는 모두 이 객체를 통해 로봇을 조작한다.
import { SystemIO } from './sysio.js';
import { EventEmitter } from 'node:events';
import { ROBOTS, VENDORS, getRobot } from '../shared/robots.js';
import { GRIPPERS, getGripper } from '../shared/grippers.js';
import { normalizeCameras } from '../shared/cameras.js';
import { fkFlange, fkTcp, ikNearest, tcpToFlange, withinLimits } from '../shared/kinematics.js';
import { toVendorPose, fromVendorPose, frameFromXYZRPY } from '../shared/poseformat.js';
import { computeUserFrame3Pt } from '../shared/teachOps.js';
import { poseMul, poseInv, mulv, mul3, Rx, Ry, Rz, DEG, add, sub, norm, quatFromR, RfromQuat, T3 } from '../shared/math.js';
import { planJoint, planLinear, planCircular, MotionError } from './motion.js';
import { VM } from './vm.js';
import { checkCollision } from '../shared/collision.js';
import { LANGS } from './lang/index.js';
import { Cell } from './cell.js';
import { localizeFiles } from './lang/examples-en.js';
import { vendorAlarm } from '../shared/alarms.js';
import { normalizeZones, robotInZone } from '../shared/zones.js';
import { VisionEngine } from './vision.js';

const NIO = 512;
export const NAIO = 16;
const TICK_MS = 8;
const SUB_MAX_S = 0.010;   // 배속 시 한 서브스텝의 최대 시뮬레이션 시간 (간섭 체크·블렌딩 정확도 유지)
const MAX_SUB = 100;
export const TEACH_TCP_MAX = 250; // ISO 10218-1 T1(TEACH) 모드 TCP 최대 속도 (mm/s)
const N_FRAMES = 8;
const defaultFrames = () => ({
  activeTool: 0, // 0 = 그리퍼 기본 TCP, 1..8 = Tool 프레임
  activeUser: 0, // 0 = 로봇 베이스(WORLD), 1..8 = User/Base/WObj 프레임
  tools: Array.from({ length: N_FRAMES }, (_, i) => ({ id: i + 1, name: `Tool ${i + 1}`, pose: [0, 0, 0, 0, 0, 0] })),
  users: Array.from({ length: N_FRAMES }, (_, i) => ({ id: i + 1, name: `User ${i + 1}`, pose: [0, 0, 0, 0, 0, 0] })),
});
const defaultIoGroups = () => ([
  { id: 'GI1', name: '품종 코드', dir: 'in', start: 17, bits: 8, signed: false },
  { id: 'GO1', name: '공정 코드', dir: 'out', start: 17, bits: 8, signed: false },
]);
// 명령 거부 사유 (code 는 Modbus 입력 레지스터 7 / OPC UA LastRejectCode 로도 노출)
export const REJECT = {
  NOT_REMOTE: { code: 1, reason: '외부 명령은 REMOTE 모드에서만 허용됩니다' },
  REMOTE_LOCAL: { code: 2, reason: 'REMOTE 모드에서는 펜던트(화면)에서 시작·이동할 수 없습니다' },
  ESTOP: { code: 3, reason: '비상정지 중입니다' },
  FENCE_OPEN: { code: 4, reason: '자동 운전 모드에서 안전 펜스가 열려 있습니다' },
  ENABLE_OFF: { code: 5, reason: '인에이블 스위치를 누르지 않았습니다' },
  ALARM: { code: 6, reason: '알람 상태입니다 (알람 리셋 필요)' },
  SERVO_OFF: { code: 7, reason: '서보 OFF 상태입니다' },
  MODE_LOCKED: { code: 8, reason: '운전 모드는 펜던트 키 스위치(화면)에서만 바꿀 수 있습니다' },
  PGNO_INVALID: { code: 9, reason: '프로그램 번호에 할당된 프로그램이 없습니다' },
  PGNO_PARITY: { code: 10, reason: '프로그램 번호 패리티 오류' },
  JOG_NOT_TEACH: { code: 11, reason: '조그는 TEACH 모드에서만 가능합니다' },
  BUSY: { code: 12, reason: '프로그램 실행 중에는 프로그램을 선택할 수 없습니다' },
  HOLD_INPUT: { code: 13, reason: '외부 홀드 입력이 걸려 있습니다' },
  SERVO_OFF_INPUT: { code: 14, reason: '서보 OFF 입력이 걸려 있습니다' },
  PATH_DEVIATED: { code: 15, reason: '홀드 중 수동 이동으로 원경로에서 이탈했습니다 (원경로 복귀 필요)' },
};
const OP_NAME = { start: '시작', resume: '재개', servoOn: '서보 ON', move: '이동', jog: '조그', mode: '모드 변경', select: '프로그램 선택' };
const SRC_NAME = { internal: '내부', ui: '펜던트', ext: '외부' };
export const MODES = ['TEACH', 'PLAY', 'REMOTE'];
export const TIME_SCALE_MIN = 0.1, TIME_SCALE_MAX = 10;


const MAX_FILES = 256, MAX_FILE_CHARS = 4 * 1024 * 1024, MAX_FILE_NAME = 128;
export class Controller extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
    this.io = { do: new Array(NIO + 1).fill(false), di: new Array(NIO + 1).fill(false) };
    this.aio = { ai: new Array(NAIO + 1).fill(0), ao: new Array(NAIO + 1).fill(0) };
    this.aioConfig = { ai: {}, ao: {} }; // { n: { name, unit, min, max } }
    this.ioGroups = defaultIoGroups();
    this.ioNames = { do: {}, di: {} };
    this.gripperIO = { close: 1, open: 2, fbClosed: 1, fbOpen: 2, fbPart: 3 };
    this.servo = false;
    this.mode = 'TEACH';       // TEACH | PLAY | REMOTE
    this.override = 100;       // %
    this.accelScale = 100;     // % (5~100, AccSet / ACC 전역 가감속 배율)
    this.payload = { mass: 0, cog: [0, 0, 0] }; // kg, [x,y,z] mm (가감속 관성 보정)
    this.held = false;
    this.holdAnchor = null;    // HOLD 진입 시 관절 위치 (경로 이탈 감지 및 원경로 복귀용)
    this._recoverSeg = null;   // HOLD 중 원경로 복귀 세그먼트
    this.alarms = [];
    this.logs = [];
    this.segs = [];            // 실행 중 모션 구간 (블렌딩 시 2개 이상 겹침)
    this.blendEnabled = true;  // false → 모든 점에서 정위치 정지 (비교용)
    this.breakpoints = new Set(); // 'file:line'
    this.autoResetScene = true; // 프로그램을 처음부터 시작할 때 공작물 초기 배치로 복원
    this.collisionMode = 'stop'; // off | warn(표시만) | stop(알람 정지)
    this.collision = { hit: false, pairs: [] };
    this.zones = [];           // 안전 영역(SafeZone) · 간섭 구역(Interference Zone)
    this.zoneStates = {};      // zoneId → boolean (로봇 진입 여부)
    this.cameras = [];         // 장착 비전 카메라 (shared/cameras.js normalizeCameras 형식)
    this.jog = null;
    this.files = new Map();    // 가상 컨트롤러 저장소: 파일명 → 내용
    this.main = null;          // 메인 프로그램(잡) 이름
    this.program = null;       // 컴파일 결과
    this.vm = null;
    this.regs = new Map();     // 컨트롤러 전역 레지스터 (INFORM B/I/D/R/P, HRScript V 변수 등)
    this.toolOverride = null;  // 프로그램이 지정한 툴 (null → activeTool 또는 그리퍼 TCP)
    this.base = null;          // 프로그램이 지정한 사용자 좌표계 (null → activeUser 또는 로봇 베이스)
    this.frames = defaultFrames();
    this.motionStats = { moves: 0 };
    this.cycleStats = { current: null, last: null, history: [] };
    this.heldMs = 0;
    this._heldSince = 0;
    this._dirty = true;
    // WebSocket stateDelta 최적화용 필드별 리비전 카운터 (매 틱 JSON.stringify 회피)
    this._rev = { sysio: 1, cell: 1, scene: 1, safety: 1, ioLabels: 1, gripperIO: 1, cameras: 1, faults: 1, frames: 1, zones: 1, vision: 1 };
    // 고장 주입 상태 (ROADMAP-SI P1-1)
    this.faults = {
      gripperFail: false,
      conveyorStall: false,
      feederJam: false,
      sensorStuck: {},         // { sensorId: 'on' | 'off' }
      commLatencyMs: 0,
      commDropPct: 0,
    };
    this.cell = new Cell(this);
    this.sysio = new SystemIO(this);  // 시스템 I/O (전용 입출력, 기본 사용 안 함)
    this.vision = new VisionEngine(this); // 가상 비전 센서 (DO 트리거 → 프러스텀 공작물 검출)
    this.setGripper('robotiq-2f85');
    this.setRobot('yaskawa-gp7');
    this._last = performance.now();
    this.simMs = 0;            // 시뮬레이션 시계 (HOLD 중 정지)
    // 운전 모드 인터록 · 안전 (docs/ROADMAP-SI.md P0-1, P0-3)
    //  명령 출처 source: 'internal'(로봇 프로그램·테스트·AI 도구) | 'ui'(펜던트에 해당: 웹 UI·/api/cmd) | 'ext'(통신 인터페이스·시스템 I/O)
    this.interlock = true;       // false → 모드에 따른 외부/펜던트 명령 제한을 끔 (안전 신호는 항상 적용)
    this.safety = { estopUI: false, estopExt: false, fenceOpen: false, enable: false, requireEnable: false, fenceStop: 'stop1', teachSpeedLimit: true, pathRecovery: 'auto' };
    this.lastReject = null;      // { op, source, code, reason, t } 마지막으로 거부된 명령
    this.ioLabels = { do: {}, di: {} };  // 사용자 I/O 이름표 { n: { name, desc } } (P1-3)
    this.timeScale = 1;        // 배속: 시뮬레이션 시간 / 실제 시간 (모션·대기·타이머·주변기기 모두 적용, 조그는 실시간)
    this.lockTimeScaleOnExt = false; // 외부 통신/REMOTE 연동 시 ×1 배속 강제 잠금
    this._waiters = [];        // 시뮬레이션 시계 기준 대기/조건/타이머 (서브스텝마다 평가)
    this._ticking = false;
    this._timer = setInterval(() => this.tick(), TICK_MS);
  }

  _bumpRev(key) { if (this._rev && key in this._rev) this._rev[key]++; }

  close() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this.stopProgram();
  }

  // ------------------------------------------------------------ 고장 주입 (P1-1)
  setFaults(patch = {}) {
    if (!patch || typeof patch !== 'object') return this.faults;
    const f = this.faults;
    if (patch.gripperFail !== undefined) f.gripperFail = !!patch.gripperFail;
    if (patch.conveyorStall !== undefined) f.conveyorStall = !!patch.conveyorStall;
    if (patch.feederJam !== undefined) f.feederJam = !!patch.feederJam;
    if (patch.commLatencyMs !== undefined) {
      const ms = Number(patch.commLatencyMs);
      f.commLatencyMs = Number.isFinite(ms) ? Math.max(0, Math.min(5000, Math.round(ms))) : 0;
    }
    if (patch.commDropPct !== undefined) {
      const pct = Number(patch.commDropPct);
      f.commDropPct = Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : 0;
    }
    if (patch.sensorStuck && typeof patch.sensorStuck === 'object') {
      const next = { ...f.sensorStuck };
      for (const [id, mode] of Object.entries(patch.sensorStuck)) {
        if (mode === 'on' || mode === 'off') next[id] = mode;
        else delete next[id];
      }
      f.sensorStuck = next;
    }
    this.syncGripperFeedback();
    this.cell._syncDeviceDIs?.();
    this._bumpRev('faults');
    this.log('system', `고장 주입 설정 변경 (그리퍼실패=${f.gripperFail ? 'ON' : 'OFF'}, 컨베이어정지=${f.conveyorStall ? 'ON' : 'OFF'}, 피더막힘=${f.feederJam ? 'ON' : 'OFF'}, 지연=${f.commLatencyMs}ms, 손실=${f.commDropPct}%)`);
    this.emitState();
    return f;
  }
  clearFaults() {
    this.faults = { gripperFail: false, conveyorStall: false, feederJam: false, sensorStuck: {}, commLatencyMs: 0, commDropPct: 0 };
    this.syncGripperFeedback();
    this.cell._syncDeviceDIs?.();
    this._bumpRev('faults');
    this.log('system', '고장 주입 전체 해제');
    this.emitState();
    return this.faults;
  }
  injectFaultAction(kind, msg) {
    if (kind === 'servoTrip') {
      this._freeze();
      this._servoOffKeep();
      this.alarm('SERVO_TRIP', msg || '고장 주입: 서보 드라이브 트립');
    } else if (kind === 'motionStop') {
      this.cancelMotion();
      if (this.vm && (this.vm.status === 'running' || this.vm.status === 'paused' || this.vm._finishing)) this.vm.abort();
      this.log('alarm', '고장 주입: 모션 강제 정지');
      this.emitState();
    } else {
      const code = String(kind || 'INTERNAL').toUpperCase();
      this.alarm(code, msg || `고장 주입: ${code}`);
      if (this.vm && (this.vm.status === 'running' || this.vm.status === 'paused' || this.vm._finishing)) this.vm.abort();
    }
  }

  // ------------------------------------------------------------ 설정
  get vendor() { return this.robot.vendor; }
  get lang() { return LANGS[this.vendor]; }

  setRobot(id) {
    const r = getRobot(id);
    if (!r) throw new Error(`알 수 없는 로봇: ${id}`);
    this.stopProgram();
    const prevVendor = this.robot?.vendor;
    const vendorChanged = prevVendor !== r.vendor;
    this.vendorStore ??= {};
    this.robot = r;
    this.joints = [...r.home];
    this.segs = [];
    this.jog = null;
    this.toolOverride = null;
    this.base = null;
    // 비상정지/안전 펜스가 여전히 활성인 경우 해당 안전 알람은 유지
    this.alarms = this.safety ? this.alarms.filter((a) => (a.code === 'ESTOP' && this.estopActive) || (a.code === 'FENCE' && this.safety.fenceOpen && this.autoMode)) : [];
    this.resetScene();
    if (vendorChanged) {
      // 이전 제조사의 프로그램/변수는 보관해 두었다가 다시 선택하면 복원
      if (prevVendor) this.vendorStore[prevVendor] = { files: Object.fromEntries(this.files), main: this.main, regs: [...this.regs], ioNames: this.ioNames, exampleSig: this._exampleSig };
      const saved = this.vendorStore[r.vendor];
      this.files = new Map();
      this.main = null;
      this.program = null;
      this.regs = new Map(saved?.regs ?? []);
      this.ioNames = saved?.ioNames ?? { do: {}, di: {} };
      if (saved && Object.keys(saved.files).length) {
        this._exampleSig = saved.exampleSig;
        this.main = saved.main;
        const untouched = saved.exampleSig && saved.exampleSig === JSON.stringify(Object.entries(saved.files));
        if (untouched) this.loadExample(); else this.loadFiles(saved.files, true);
      } else this.loadExample();
    } else if (this.isExampleUntouched()) {
      // 같은 제조사 내 모델 변경: 예제를 수정하지 않았다면 새 모델/공작물 배치에 맞게 재생성
      this.loadExample();
    } else this.compile(true);
    this.log('system', `로봇 선택: ${VENDORS[r.vendor].name} ${r.name}`);
    this.emit('robot', r);
    this.emitState();
  }

  setGripper(id) {
    this.gripper = getGripper(id);
    this.grip = { pos: 0, closed: false, holding: null };
    this.syncGripperFeedback();
    this.log('system', `그리퍼 선택: ${this.gripper.maker} ${this.gripper.name}`);
    this.emitState();
  }

  // 사용자 정의(STL) 그리퍼 등록
  setCustomGripper(def) {
    if (!def || typeof def !== 'object') throw new Error('그리퍼 정의(def)가 필요합니다');
    if (def.tcp !== undefined && !(Array.isArray(def.tcp) && def.tcp.length === 6 && def.tcp.every(Number.isFinite))) throw new Error('그리퍼 tcp 는 숫자 6개 [x,y,z,rx,ry,rz] 여야 합니다');
    const geom = (def.geom && typeof def.geom === 'object') ? { ...def.geom } : {};
    if (def.bounds?.min?.length === 3 && def.bounds?.max?.length === 3 && [...def.bounds.min, ...def.bounds.max].every(Number.isFinite)) {
      geom.bounds = { min: def.bounds.min.map(Number), max: def.bounds.max.map(Number) };
    }
    this.gripper = { id: 'custom', kind: def.kind || 'parallel', name: def.name || '사용자 그리퍼', maker: 'User', tcp: def.tcp || [0, 0, 100, 0, 0, 0], mass: def.mass || 1, grip: def.grip ?? 20, stroke: def.stroke || 50, geom, custom: true };
    this.grip = { pos: 0, closed: false, holding: null };
    this.emitState();
  }

  // 비전 카메라 목록 교체 (추가/삭제/편집 모두 전체 목록으로 전달)
  setCameras(list) {
    const before = this.cameras.length;
    this.cameras = normalizeCameras(list);
    this._bumpRev('cameras');
    if (this.cameras.length !== before) this.log('system', `카메라 ${this.cameras.length}대 장착`);
    this.emitState();
  }

  get tool() {
    if (this.toolOverride) return this.toolOverride;
    if (this.frames?.activeTool > 0) return this.getToolFrame(this.frames.activeTool);
    return this.gripperTcp;
  }
  // 파지 판정/보유 공작물 추종은 프로그램 툴 설정과 무관하게 그리퍼 실제 TCP 사용
  get gripperTcp() { return frameFromXYZRPY(this.gripper.tcp); }
  get effectiveBase() {
    if (this.base) return this.base;
    if (this.frames?.activeUser > 0) return this.getUserFrame(this.frames.activeUser);
    return null;
  }
  getToolFrame(idx) {
    const n = Number(idx);
    if (!Number.isInteger(n) || n <= 0) return this.gripperTcp;
    const entry = this.frames?.tools?.[n - 1];
    return entry ? frameFromXYZRPY(entry.pose) : this.gripperTcp;
  }
  getUserFrame(idx) {
    const n = Number(idx);
    if (!Number.isInteger(n) || n <= 0) return null;
    const entry = this.frames?.users?.[n - 1];
    return entry ? frameFromXYZRPY(entry.pose) : null;
  }
  setActiveFrames({ activeTool, activeUser } = {}) {
    if (activeTool !== undefined) {
      const n = Number(activeTool);
      if (!Number.isInteger(n) || n < 0 || n > N_FRAMES) throw new Error(`Tool 번호 범위 초과: ${activeTool} (0~${N_FRAMES})`);
      this.frames.activeTool = n;
    }
    if (activeUser !== undefined) {
      const n = Number(activeUser);
      if (!Number.isInteger(n) || n < 0 || n > N_FRAMES) throw new Error(`User 번호 범위 초과: ${activeUser} (0~${N_FRAMES})`);
      this.frames.activeUser = n;
    }
    this._bumpRev('frames');
    this.log('system', `좌표계 선택: Tool #${this.frames.activeTool} / User #${this.frames.activeUser}`);
    this.emitState();
    return this.frames;
  }
  setFrame(kind, id, { name, pose } = {}) {
    if (kind !== 'tool' && kind !== 'user') throw new Error(`좌표계 종류 오류: ${kind}`);
    const n = Number(id);
    if (!Number.isInteger(n) || n < 1 || n > N_FRAMES) throw new Error(`좌표계 번호 범위 초과: ${id} (1~${N_FRAMES})`);
    const arr = kind === 'tool' ? this.frames.tools : this.frames.users;
    const entry = arr[n - 1];
    if (name !== undefined) entry.name = String(name).trim().slice(0, 32) || `${kind === 'tool' ? 'Tool' : 'User'} ${n}`;
    if (pose !== undefined) {
      const p = Array.isArray(pose) ? pose.map(Number) : [];
      if (p.length !== 6 || !p.every(Number.isFinite)) throw new Error('좌표계 pose 는 숫자 6개 [x,y,z,rx,ry,rz] 여야 합니다');
      entry.pose = p;
    }
    this._bumpRev('frames');
    this.log('system', `${kind === 'tool' ? 'Tool' : 'User'} #${n} (${entry.name}) 저장: [${entry.pose.map((v) => Number(v.toFixed(2))).join(', ')}]`);
    this.emitState();
    return entry;
  }
  teachUserFrame3Pt(id, { origin, xPoint, xyPoint, name, activate = true } = {}) {
    const pose = computeUserFrame3Pt(origin, xPoint, xyPoint);
    const entry = this.setFrame('user', id, { name, pose });
    if (activate) this.setActiveFrames({ activeUser: Number(id) });
    return entry;
  }
  setFramesData(data) {
    const def = defaultFrames();
    if (data && typeof data === 'object') {
      const at = Number(data.activeTool);
      const au = Number(data.activeUser);
      if (Number.isInteger(at) && at >= 0 && at <= N_FRAMES) def.activeTool = at;
      if (Number.isInteger(au) && au >= 0 && au <= N_FRAMES) def.activeUser = au;
      for (const k of ['tools', 'users']) {
        if (!Array.isArray(data[k])) continue;
        for (let i = 0; i < N_FRAMES && i < data[k].length; i++) {
          const src = data[k][i];
          if (!src || typeof src !== 'object') continue;
          if (typeof src.name === 'string' && src.name.trim()) def[k][i].name = src.name.trim().slice(0, 32);
          if (Array.isArray(src.pose) && src.pose.length === 6 && src.pose.every((v) => Number.isFinite(Number(v)))) {
            def[k][i].pose = src.pose.map(Number);
          }
        }
      }
    }
    this.frames = def;
    this._bumpRev('frames');
    this.emitState();
  }

  // ------------------------------------------------------------ 상태/로그
  log(src, msg) {
    const e = { t: Date.now(), src, msg };
    this.logs.push(e);
    if (this.logs.length > 500) this.logs.shift();
    this.emit('log', e);
  }

  alarm(code, msg) {
    const va = vendorAlarm(this.vendor, code);
    const a = { t: Date.now(), code, vendorCode: va.code, vendorName: va.name, msg };
    this.alarms.push(a);
    if (this.alarms.length > 200) this.alarms.shift();
    this.log('alarm', `[${code}${va.code !== code ? '/' + va.code : ''}] ${msg}`);
    this.cancelMotion();
    this.emitState();
  }
  resetAlarms() {
    // 원인이 남아 있는 안전 알람은 리셋되지 않음
    const keep = this.alarms.filter((a) => (a.code === 'ESTOP' && this.estopActive) || (a.code === 'FENCE' && this.safety.fenceOpen && this.autoMode));
    if (keep.length) this.log('system', `알람 리셋 불가: ${keep.map((a) => a.code).join(', ')} 원인이 해제되지 않음`);
    this.alarms = keep;
    this.emitState();
  }

  emitState() { this._dirty = true; }

  tcpPose() { return fkTcp(this.robot, this.joints, this.tool, this.effectiveBase); }
  flangePose() { return fkFlange(this.robot, this.joints); }
  vendorPose() { return toVendorPose(this.vendor, this.tcpPose()); }

  snapshot() {
    const tcpWorld = fkTcp(this.robot, this.joints, this.tool, null);
    const effBase = this.effectiveBase;
    const tcpPose = effBase ? poseMul(poseInv(effBase), tcpWorld) : tcpWorld;
    const doOn = [], diOn = [];
    for (let i = 1; i <= NIO; i++) { if (this.io.do[i]) doOn.push(i); if (this.io.di[i]) diOn.push(i); }
    const extClients = this.traffic ? this.traffic.listClients().length : 0;
    return {
      robotId: this.robot.id, vendor: this.vendor, gripperId: this.gripper.id, gripperCustom: this.gripper.custom ? this.gripper : null,
      joints: this.joints, tcp: toVendorPose(this.vendor, tcpPose), tcpWorld: { p: tcpWorld.p, q: quatFromR(tcpWorld.R) },
      tool: this.tool.p.concat(quatFromR(this.tool.R)),
      frames: this.frames,
      activeUserFrame: effBase ? { p: effBase.p, q: quatFromR(effBase.R) } : null,
      grip: { pos: this.grip.pos, closed: this.grip.closed, holding: this.grip.holding?.id ?? null },
      io: { do: doOn, di: diOn, names: this.ioNames }, gripperIO: this.gripperIO,
      aio: { ai: this.aio.ai.slice(1), ao: this.aio.ao.slice(1), config: this.aioConfig },
      ioGroups: this.ioGroups.map((g) => ({ ...g, value: this.readGroupIO(g.id) })),
      servo: this.servo, mode: this.mode, override: this.override, held: this.held,
      accelScale: this.accelScale, payload: this.payload,
      weldArc: this.gripper.kind === 'torch' && this.getDO(this.gripperIO.close),
      pathRecovery: this.getPathRecovery(),
      interlock: this.interlock, safety: { ...this.safety, estop: this.estopActive }, lastReject: this.lastReject,
      ioLabels: this.ioLabels, sysio: this.sysio.snapshot(), faults: this.faults,
      moving: this.segs.length > 0 || !!this.jog || !!this._recoverSeg, blendEnabled: this.blendEnabled,
      collision: this.collision, collisionMode: this.collisionMode, autoResetScene: this.autoResetScene,
      zones: this.zones.map((z) => ({ ...z, active: !!this.zoneStates[z.id] })),
      breakpoints: [...this.breakpoints], simMs: Math.round(this.simMs), timeScale: this.timeScale,
      lockTimeScaleOnExt: this.lockTimeScaleOnExt, extClients,
      alarms: this.alarms,
      program: {
        main: this.main, files: [...this.files.keys()],
        status: this.vm?.status ?? 'idle', current: this.vm?.current ?? null, cycle: this.vm?.cycle ?? 0,
        ppCustom: !!this.vm?._ppCustom,
        compileError: this.compileError ?? null,
      },
      cycle: {
        elapsed: this.cycleStats.current ? +((this.simMs - this.cycleStats.current.start) / 1000).toFixed(2) : null,
        last: this.cycleStats.last, history: this.cycleStats.history,
      },
      objects: this.objects.map((o) => ({ id: o.id, size: o.size, color: o.color, p: o.pose.p, q: quatFromR(o.pose.R) })),
      scene: this.scene,
      cell: this.cell.snapshot(),
      cameras: this.cameras,
      vision: this.vision?.results || {},
    };
  }

  // ------------------------------------------------------------ 페이로드 · 가감속 · 경로 복귀 상태
  setPayload(mass, cog) {
    const m = Number(mass);
    if (!Number.isFinite(m) || m < 0) throw new Error(`페이로드 질량이 올바르지 않습니다: ${mass}`);
    const maxAllowed = Math.max(1, (this.robot?.payload || 10) * 1.5);
    const clamped = Math.min(maxAllowed, +m.toFixed(3));
    const nextCog = Array.isArray(cog) && cog.length === 3 && cog.every((v) => Number.isFinite(Number(v)))
      ? cog.map((v) => +Number(v).toFixed(2))
      : [...(this.payload?.cog || [0, 0, 0])];
    this.payload = { mass: clamped, cog: nextCog };
    const over = this.robot?.payload > 0 && clamped > this.robot.payload;
    this.log('system', `페이로드 설정: ${clamped} kg${over ? ` (⚠ 정격 ${this.robot.payload} kg 초과)` : ''}`);
    this.emitState();
    return this.payload;
  }

  setAccelScale(pct) {
    const v = Number(pct);
    if (!Number.isFinite(v)) return this.accelScale;
    this.accelScale = Math.max(5, Math.min(100, Math.round(v)));
    this.emitState();
    return this.accelScale;
  }

  getPathRecovery() {
    if (!this.held || !this.holdAnchor) {
      return { active: false, deviated: false, maxDeg: 0, anchor: null, recovering: !!this._recoverSeg };
    }
    const maxDeg = Math.max(...this.joints.map((v, i) => Math.abs(v - this.holdAnchor[i])));
    return {
      active: true,
      deviated: maxDeg > 0.5,
      maxDeg: +maxDeg.toFixed(2),
      anchor: this.holdAnchor,
      recovering: !!this._recoverSeg,
    };
  }

  // ------------------------------------------------------------ 인터록 · 안전
  get estopActive() { return this.safety.estopUI || this.safety.estopExt; }
  get autoMode() { return this.mode === 'PLAY' || this.mode === 'REMOTE'; }

  // 명령 허용 판정. 허용이면 null, 거부면 { code, reason }
  //  op: start | resume | servoOn | move | jog | mode | select
  checkCommand(op, source = 'internal') {
    const S = this.safety;
    // 안전 신호는 출처·인터록 설정과 관계없이 항상 적용
    if (['start', 'resume', 'servoOn', 'move', 'jog', 'select'].includes(op)) {
      if (this.estopActive) return REJECT.ESTOP;
      if (S.fenceOpen && this.autoMode && op !== 'jog' && op !== 'select') return REJECT.FENCE_OPEN;
    }
    if (op === 'jog' && S.requireEnable && !S.enable) return REJECT.ENABLE_OFF;
    if (!this.interlock || source === 'internal') return null;
    if (op === 'mode') return source === 'ext' ? REJECT.MODE_LOCKED : null;
    if (op === 'jog') return this.mode === 'TEACH' ? null : REJECT.JOG_NOT_TEACH;
    if (source === 'ext' && ['start', 'resume', 'servoOn', 'move', 'select'].includes(op) && this.mode !== 'REMOTE') return REJECT.NOT_REMOTE;
    if (source === 'ui' && ['start', 'resume', 'move'].includes(op) && this.mode === 'REMOTE') return REJECT.REMOTE_LOCAL;
    return null;
  }
  // 거부 기록 + 로그. 항상 false 반환 (호출부에서 return this.reject(...) 로 사용)
  reject(op, source, r) {
    this.lastReject = { op, source, code: r.code, reason: r.reason, t: Date.now() };
    this.log('system', `거부: ${OP_NAME[op] ?? op} (${SRC_NAME[source] ?? source}) — ${r.reason}`);
    this.emit('reject', this.lastReject);
    this.emitState();
    return false;
  }
  // 로그 없이 거부 기록만 (호출부에서 이미 사유를 로그한 경우) + 상태 전파
  _noteReject(op, source, r) {
    this.lastReject = { op, source, code: r.code, reason: r.reason, t: Date.now() };
    this.emit('reject', this.lastReject);
    this.emitState();
  }
  // 판정 후 거부면 기록하고 false, 허용이면 true
  allow(op, source) {
    const r = this.checkCommand(op, source);
    return r ? this.reject(op, source, r) : true;
  }

  // 안전 알람: 일반 알람과 달리 모션을 취소하지 않음 (정지 위치에서 재개 가능하도록 HOLD 로 동결)
  _safetyAlarm(code, msg) {
    if (this.alarms.some((a) => a.code === code)) return;
    const va = vendorAlarm(this.vendor, code);
    this.alarms.push({ t: Date.now(), code, vendorCode: va.code, vendorName: va.name, msg });
    this.log('alarm', `[${code}${va.code !== code ? '/' + va.code : ''}] ${msg}`);
  }
  // 동작 중이면 HOLD 로 동결 (hold() 와 달리 동작이 없어도 조용히 통과)
  _freeze() {
    const active = this.segment || this.vm?.status === 'running' || this.vm?.status === 'paused';
    if (active && !this.held) {
      this.held = true;
      this._heldSince = performance.now();
      if (!this.holdAnchor) this.holdAnchor = [...this.joints];
    }
    this.jog = null;
  }
  // 서보 OFF (모션은 취소하지 않고 동결 → 복귀 후 시작 신호로 같은 위치에서 재개)
  _servoOffKeep() {
    if (!this.servo) return;
    this.servo = false;
    this.log('system', '서보 OFF');
  }

  // 비상정지 (정지 범주 0: 즉시 정지 + 서보 OFF). src: 'ui'(화면 버튼) | 'ext'(시스템 I/O 입력)
  setEstop(on, src = 'ui') {
    const key = src === 'ext' ? 'estopExt' : 'estopUI';
    on = !!on;
    if (this.safety[key] === on) return;
    const was = this.estopActive;
    this.safety[key] = on;
    if (this.estopActive && !was) {
      this._freeze();
      this._servoOffKeep();
      this._safetyAlarm('ESTOP', `비상정지 (${src === 'ext' ? '외부 입력' : '화면 버튼'})`);
    } else if (!this.estopActive && was) {
      this.log('system', '비상정지 해제 — 알람 리셋 후 서보 ON, 시작');
    }
    this._bumpRev('safety');
    this.emitState();
  }

  // 안전 펜스(도어). 자동 운전(PLAY/REMOTE) 중 열리면 stop1(감속 정지 + 서보 OFF + 알람) 또는 stop2(HOLD)
  setFence(open) {
    open = !!open;
    if (this.safety.fenceOpen === open) return;
    this.safety.fenceOpen = open;
    this.log('system', `안전 펜스 ${open ? '열림' : '닫힘'}`);
    if (open && this.autoMode) {
      const active = this.segment || this.vm?.status === 'running';
      if (this.safety.fenceStop === 'stop2') { if (active) { this._freeze(); this.log('system', '펜스 열림: HOLD (정지 범주 2)'); } }
      else if (active || this.servo) {
        this._freeze();
        this._servoOffKeep();
        this._safetyAlarm('FENCE', '자동 운전 중 안전 펜스 열림 (정지 범주 1)');
      }
    }
    this._bumpRev('safety');
    this.emitState();
  }

  setEnableSwitch(on) { this.safety.enable = !!on; if (!on) this.jog = null; this._bumpRev('safety'); this.emitState(); }

  setSafetyOptions(o = {}) {
    if (o.requireEnable !== undefined) this.safety.requireEnable = !!o.requireEnable;
    if (o.fenceStop === 'stop1' || o.fenceStop === 'stop2') this.safety.fenceStop = o.fenceStop;
    if (o.teachSpeedLimit !== undefined) {
      this.safety.teachSpeedLimit = !!o.teachSpeedLimit;
      this.log('system', `TEACH 속도 제한 (${TEACH_TCP_MAX} mm/s) ${this.safety.teachSpeedLimit ? 'ON' : 'OFF'}`);
    }
    if (o.pathRecovery === 'auto' || o.pathRecovery === 'block' || o.pathRecovery === 'off') {
      this.safety.pathRecovery = o.pathRecovery;
      this.log('system', `홀드 경로 복귀 모드: ${o.pathRecovery}`);
    }
    if (o.interlock !== undefined) { this.interlock = !!o.interlock; this.log('system', `모드 인터록 ${this.interlock ? 'ON' : 'OFF'}`); }
    this._bumpRev('safety');
    this.emitState();
  }

  // I/O 이름표 (type: 'do'|'di', n, label: {name, desc} | null)
  setIoLabel(type, n, label) {
    if (type !== 'do' && type !== 'di') throw new Error('type 은 do 또는 di');
    n = Number(n);
    if (!(n >= 1 && n <= NIO)) throw new Error(`I/O 번호 범위 초과: ${n}`);
    const name = String(label?.name ?? '').trim().slice(0, 40), desc = String(label?.desc ?? '').trim().slice(0, 120);
    if (!name && !desc) delete this.ioLabels[type][n];
    else this.ioLabels[type][n] = { name, desc };
    this._bumpRev('ioLabels');
    this.emitState();
  }
  setIoLabels(labels) {
    const out = { do: {}, di: {} };
    for (const t of ['do', 'di']) for (const [n, l] of Object.entries(labels?.[t] || {})) {
      const k = Number(n);
      if (k >= 1 && k <= NIO && (l?.name || l?.desc)) out[t][k] = { name: String(l.name ?? '').slice(0, 40), desc: String(l.desc ?? '').slice(0, 120) };
    }
    this.ioLabels = out;
    this._bumpRev('ioLabels');
    this.emitState();
  }

  // ------------------------------------------------------------ 서보/모드/오버라이드
  setServo(on, source = 'internal') {
    if (on && !this.allow('servoOn', source)) return false;
    if (on && this.alarms.length) { this.log('system', '알람 상태에서는 서보 ON 할 수 없습니다. 알람 리셋 필요'); this._noteReject('servoOn', source, REJECT.ALARM); return false; }
    this.servo = !!on;
    if (!on) this.cancelMotion();
    this.log('system', `서보 ${on ? 'ON' : 'OFF'}`);
    this.emitState();
    return true;
  }
  setMode(m, source = 'internal') {
    m = String(m || '').toUpperCase();
    if (!MODES.includes(m)) throw new Error(`알 수 없는 모드: ${m}`);
    if (m === this.mode) return true;
    if (!this.allow('mode', source)) return false;
    const prev = this.mode;
    this.mode = m;
    this.log('system', `모드 ${prev} → ${m}`);
    // 실제 컨트롤러처럼 TEACH ↔ 자동 운전 전환 시 실행 중인 프로그램 정지
    if (this.interlock && (prev === 'TEACH') !== (m === 'TEACH') && (this.vm?.status === 'running' || this.vm?.status === 'paused' || this.segment)) {
      this.stopProgram();
      this.log('system', '모드 전환으로 프로그램 정지');
    }
    // 안전 펜스가 열린 채 자동 운전(PLAY/REMOTE)으로 전환되면 즉시 안전 정지 적용
    if (this.autoMode && this.safety.fenceOpen && this.safety.fenceStop !== 'stop2' && this.servo) {
      this._freeze();
      this._servoOffKeep();
      this._safetyAlarm('FENCE', '안전 펜스 열린 상태에서 자동 운전 전환 (정지 범주 1)');
    }
    if (this.lockTimeScaleOnExt && m === 'REMOTE' && this.timeScale !== 1) {
      this.timeScale = 1;
      this.log('system', 'REMOTE 모드 전환 + ×1 배속 잠금 → 배속을 ×1로 복원');
    }
    this.jog = null;
    this.emitState();
    return true;
  }
  // 0 이하는 최저(1%)로 — 0 을 100% 로 해석하면 안 됨. 숫자가 아니면 무시
  setOverride(v) {
    const n = Number(v);
    if (v === null || v === '' || !Number.isFinite(n)) return;
    this.override = Math.max(1, Math.min(100, n));
    this.emitState();
  }

  // ------------------------------------------------------------ IO
  setDO(n, v) {
    n = Number(n);
    if (!(n >= 1 && n <= NIO)) throw new Error(`출력 번호 범위 초과: ${n}`);
    v = !!v;
    if (this.io.do[n] === v) return;
    this.io.do[n] = v;
    const g = this.gripperIO;
    if (n === g.close) this.gripperCmd(v);
    if (n === g.open && v) this.gripperCmd(false);
    this.emit('io', { type: 'do', n, v });
    this.emitState();
  }
  getDO(n) { return !!this.io.do[Number(n)]; }
  setDI(n, v) {
    n = Number(n);
    if (!(n >= 1 && n <= NIO)) throw new Error(`입력 번호 범위 초과: ${n}`);
    v = !!v;
    if (this.io.di[n] === v) return;
    this.io.di[n] = v;
    this.emit('io', { type: 'di', n, v });
    this.emitState();
  }
  // 대량 DI 갱신 (Modbus FC15, HSE 다중 쓰기 등): 바뀐 비트만 이벤트 발생, 상태 갱신은 1회
  setDIBatch(entries) {
    let any = false;
    for (const [rawN, rawV] of entries) {
      const n = Number(rawN);
      if (!(n >= 1 && n <= NIO)) throw new Error(`입력 번호 범위 초과: ${n}`);
      const v = !!rawV;
      if (this.io.di[n] === v) continue;
      this.io.di[n] = v;
      this.emit('io', { type: 'di', n, v });
      any = true;
    }
    if (any) this.emitState();
  }
  getDI(n) { return !!this.io.di[Number(n)]; }
  // 이름 기반 신호 (RAPID 등). 처음 보는 이름은 빈 번호에 자동 매핑
  signalNo(type, name) {
    const names = this.ioNames[type];
    const key = String(name);
    for (const [n, nm] of Object.entries(names)) if (nm.toUpperCase() === key.toUpperCase()) return Number(n);
    const m = /(\d+)$/.exec(key);
    let n = m ? Number(m[1]) : 0;
    if (!n || n < 1 || n > NIO || names[n]) {
      n = 101;
      while (n <= NIO && names[n]) n++;
      if (n > NIO) { n = 1; while (n <= NIO && names[n]) n++; }
      if (n > NIO) throw new Error(`I/O 신호 매핑 한도(${NIO}) 초과: ${key}`);
    }
    names[n] = key;
    return n;
  }

  // ------------------------------------------------------------ 아날로그 I/O (AI/AO 1..16)
  getAI(n) { const k = Number(n); return k >= 1 && k <= NAIO ? Number(this.aio.ai[k]) || 0 : 0; }
  getAO(n) { const k = Number(n); return k >= 1 && k <= NAIO ? Number(this.aio.ao[k]) || 0 : 0; }
  setAI(n, val) {
    const k = Number(n), v = Number(val);
    if (!Number.isInteger(k) || k < 1 || k > NAIO) throw new Error(`AI 채널 범위 초과: ${n} (1~${NAIO})`);
    if (!Number.isFinite(v)) throw new Error(`AI 값이 올바르지 않습니다: ${val}`);
    const clamped = Math.max(-327.68, Math.min(327.67, +v.toFixed(4)));
    if (this.aio.ai[k] === clamped) return;
    this.aio.ai[k] = clamped;
    this.emit('aio', { type: 'ai', n: k, v: clamped });
    this.emitState();
  }
  setAO(n, val) {
    const k = Number(n), v = Number(val);
    if (!Number.isInteger(k) || k < 1 || k > NAIO) throw new Error(`AO 채널 범위 초과: ${n} (1~${NAIO})`);
    if (!Number.isFinite(v)) throw new Error(`AO 값이 올바르지 않습니다: ${val}`);
    const clamped = Math.max(-327.68, Math.min(327.67, +v.toFixed(4)));
    if (this.aio.ao[k] === clamped) return;
    this.aio.ao[k] = clamped;
    this.emit('aio', { type: 'ao', n: k, v: clamped });
    this.emitState();
  }
  setAioConfig(type, n, cfg = {}) {
    if (type !== 'ai' && type !== 'ao') throw new Error('type 은 ai 또는 ao');
    const k = Number(n);
    if (!Number.isInteger(k) || k < 1 || k > NAIO) throw new Error(`채널 범위 초과: ${n}`);
    const name = String(cfg?.name ?? '').trim().slice(0, 32);
    const unit = String(cfg?.unit ?? 'V').trim().slice(0, 12) || 'V';
    const min = Number.isFinite(Number(cfg?.min)) ? Number(cfg.min) : 0;
    const max = Number.isFinite(Number(cfg?.max)) ? Number(cfg.max) : 10;
    if (!name && unit === 'V' && min === 0 && max === 10) delete this.aioConfig[type][k];
    else this.aioConfig[type][k] = { name, unit, min, max: max > min ? max : min + 1 };
    this.emitState();
  }

  // ------------------------------------------------------------ 그룹 I/O (GI/GO — DI/DO 비트 매핑)
  setIoGroups(list) {
    if (!Array.isArray(list)) return this.ioGroups;
    const out = [], used = new Set();
    for (const g of list.slice(0, 32)) {
      if (!g || typeof g !== 'object') continue;
      const dir = g.dir === 'out' ? 'out' : 'in';
      let id = String(g.id || '').replace(/[^\w-]/g, '').slice(0, 16) || `${dir === 'in' ? 'GI' : 'GO'}${out.length + 1}`;
      while (used.has(id)) id += '_';
      used.add(id);
      const bits = Math.max(1, Math.min(16, Math.round(Number(g.bits) || 8)));
      const start = Math.max(1, Math.min(NIO - bits + 1, Math.round(Number(g.start) || 1)));
      out.push({ id, name: String(g.name || id).trim().slice(0, 32), dir, start, bits, signed: !!g.signed });
    }
    this.ioGroups = out;
    this.emitState();
    return this.ioGroups;
  }
  readGroupIO(id) {
    const g = this.ioGroups.find((x) => x.id === id);
    if (!g) return 0;
    let v = 0;
    for (let b = 0; b < g.bits; b++) {
      const bit = g.dir === 'out' ? this.getDO(g.start + b) : this.getDI(g.start + b);
      if (bit) v |= 1 << b;
    }
    if (g.signed && g.bits < 32 && (v & (1 << (g.bits - 1)))) v -= 1 << g.bits;
    return v;
  }
  writeGroupIO(id, value) {
    const g = this.ioGroups.find((x) => x.id === id);
    if (!g) throw new Error(`알 수 없는 그룹 I/O: ${id}`);
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n)) throw new Error(`그룹 I/O 값이 숫자가 아닙니다: ${value}`);
    const mask = (1 << g.bits) - 1;
    const u = n & mask;
    if (g.dir === 'out') {
      for (let b = 0; b < g.bits; b++) this.setDO(g.start + b, !!(u & (1 << b)));
    } else {
      const batch = [];
      for (let b = 0; b < g.bits; b++) batch.push([g.start + b, !!(u & (1 << b))]);
      this.setDIBatch(batch);
    }
    return this.readGroupIO(id);
  }

  // ------------------------------------------------------------ 안전 영역(SafeZone) · 간섭 구역(World Zone)
  setZones(list) {
    this.zones = normalizeZones(list);
    this.zoneStates = {};
    this._bumpRev('zones');
    this.checkZonesNow(true);
    this.log('system', `안전/간섭 구역 ${this.zones.length}개 설정`);
    this.emitState();
    return this.zones;
  }
  checkZonesNow(initSync = false) {
    if (!this.zones?.length || !this.robot || !this.joints) return;
    let changed = false;
    for (const z of this.zones) {
      const prev = !!this.zoneStates[z.id];
      const inside = z.enabled ? robotInZone(this.robot, this.joints, this.tool, z) : false;
      if (inside !== prev) { this.zoneStates[z.id] = inside; changed = true; }
      if (z.outDO > 0 && z.enabled && (inside !== prev || initSync)) {
        this.setDO(z.outDO, z.invertDO ? !inside : inside);
      }
      if (z.kind === 'safe' && z.enabled && inside && !prev && !initSync) {
        this.alarm('SAFE_ZONE', `안전 영역 진입 금지: ${z.name} (${z.id})`);
        if (this.vm && (this.vm.status === 'running' || this.vm.status === 'paused' || this.vm._finishing)) this.vm.abort();
      }
    }
    if (changed) { this._bumpRev('zones'); this.emitState(); }
  }

  // ------------------------------------------------------------ 가상 비전 센서 트리거
  triggerVision(camId, opts = {}) {
    return this.vision.trigger(camId, opts);
  }

  // ------------------------------------------------------------ 그리퍼
  gripperCmd(close) {
    // 파지 기능이 없는 툴(없음/용접 토치/스핀들): 닫기 DO 를 툴 ON/OFF 로 보고 닫힘·열림 피드백 DI 만 응답.
    // (피드백이 없으면 그리퍼용 프로그램이 WAIT DI 에서 최대 대기 시간 초과로 멈춤) 공작물은 집지 않음
    if (this.gripper.kind === 'none' || this.gripper.kind === 'torch' || this.gripper.kind === 'spindle') {
      if (this.grip.closed === close) return;
      this.grip.closed = close;
      if (close) this.log('gripper', `${this.gripper.name}: 공작물을 집을 수 없는 툴 — 닫기 신호는 툴 ON 으로 처리 (피드백 DI 만 응답)`);
      this.emitState();
      return;
    }
    this.grip.closed = close;
    if (close) {
      if (this.faults?.gripperFail) {
        this.log('gripper', '[고장 주입] 그리퍼 파지 실패 (공작물 미파지 · 확인 DI 미응답)');
        this.emitState();
        return;
      }
      const obj = this.findGraspable();
      if (obj) {
        const tcp = fkTcp(this.robot, this.joints, this.gripperTcp, null);
        this.grip.holding = obj;
        obj.rel = poseMul(poseInv(tcp), obj.pose);
        this.log('gripper', `공작물 ${obj.id} 파지`);
      } else this.log('gripper', '닫힘 (파지 대상 없음)');
    } else if (this.grip.holding) {
      const o = this.grip.holding;
      this.grip.holding = null;
      this.dropObject(o);
      this.log('gripper', `공작물 ${o.id} 해제`);
    }
    this.emitState();
  }

  findGraspable() {
    const tcp = fkTcp(this.robot, this.joints, this.gripperTcp, null);
    const tol = this.gripper.kind === 'vacuum' || this.gripper.kind === 'magnet' ? 8 : Math.max(10, (this.gripper.grip || 20) * 0.5);
    let best = null, bestD = Infinity;
    for (const o of this.objects) {
      // TCP 를 공작물 로컬 좌표로 변환 후 박스까지 거리
      const l = mulv(T3(o.pose.R), sub(tcp.p, o.pose.p));
      const d = norm(l.map((v, i) => Math.max(0, Math.abs(v) - o.size[i] / 2)));
      if (d < tol && d < bestD) { best = o; bestD = d; }
    }
    return best;
  }

  dropObject(o) {
    // 단순 낙하: 아래쪽 지지면(테이블/다른 공작물/바닥)에 안착, 자세는 수평으로 정리
    const yaw = Math.atan2(o.pose.R[1][0], o.pose.R[0][0]);
    o.pose = { p: [...o.pose.p], R: Rz(yaw) };
    let support = this.scene.floorZ;
    const [x, y, z] = o.pose.p;
    const t = this.scene.table;
    if (z >= t.z - 1 && Math.abs(x - t.x) <= t.w / 2 && Math.abs(y - t.y) <= t.d / 2) support = Math.max(support, t.z);
    support = Math.max(support, this.cell.supportAt(x, y, z)); // 추가 테이블·컨베이어·장애물 윗면
    for (const other of this.objects) {
      if (other === o) continue;
      if (Math.abs(x - other.pose.p[0]) < (other.size[0] + o.size[0]) / 2 * 0.8 &&
          Math.abs(y - other.pose.p[1]) < (other.size[1] + o.size[1]) / 2 * 0.8 &&
          other.pose.p[2] < z) support = Math.max(support, other.pose.p[2] + other.size[2] / 2);
    }
    o.pose.p[2] = support + o.size[2] / 2;
  }

  syncGripperFeedback() {
    const g = this.gripperIO;
    if (!this.grip) return;
    const fail = !!this.faults?.gripperFail;
    const closedFb = !fail && (this.grip.closed && this.grip.pos > 0.95 || (this.grip.holding && this.grip.closed));
    const openFb = !this.grip.closed && this.grip.pos < 0.05;
    // 변화가 있을 때만 기록 → 외부(UI/통신)에서 같은 DI 를 강제로 바꿔도 덮어쓰지 않음
    const fb = { fbClosed: !!closedFb, fbOpen: !!openFb, fbPart: !fail && !!this.grip.holding };
    const last = this._fbLast || {};
    for (const k of ['fbClosed', 'fbOpen', 'fbPart']) {
      if (g[k] && (fb[k] !== last[k] || last[k + 'No'] !== g[k])) { this.io.di[g[k]] = fb[k]; this.emit('io', { type: 'di', n: g[k], v: fb[k] }); this.emitState(); }
      fb[k + 'No'] = g[k];
    }
    this._fbLast = fb;
  }

  // ------------------------------------------------------------ 공작물 씬
  resetScene() {
    // 씬(바닥/받침대/테이블)·공작물·주변기기 상태는 셀 레이아웃이 결정 (server/cell.js, 기본 = 테이블 + W1..W4)
    this.cell.resetScene();
    if (this.grip) this.grip.holding = null;
    this.emitState();
  }

  // ------------------------------------------------------------ 모션
  // cmd: {kind:'J'|'L'|'C', target:{joints}|{pose,cfgFilter?}, via?:{pose}, speed:{frac}|{tcp,rot}, tool?, base?}
  move(cmd) {
    if (cmd.source && cmd.source !== 'internal') {
      const r = this.checkCommand('move', cmd.source);
      if (r) { this.reject('move', cmd.source, r); return Promise.reject(new MotionError(`REJECT_${r.code}`, r.reason)); }
    }
    if (!this.servo) return Promise.reject(new MotionError('SERVO_OFF', '서보가 OFF 상태입니다'));
    if (this.alarms.length) return Promise.reject(new MotionError('ALARM', '알람 발생 중입니다'));
    const tool = cmd.tool ?? this.tool;
    const base = cmd.base !== undefined ? cmd.base : this.effectiveBase;
    const teachCap = this.mode === 'TEACH' && this.safety?.teachSpeedLimit ? TEACH_TCP_MAX : Infinity;
    // 블렌딩 중이면 앞 구간의 목표점에서부터 계획 (경로는 겹침 구간에서 합성됨)
    const j0 = this.segs.length ? [...this.segs[this.segs.length - 1].end] : [...this.joints];
    let seg;
    const toJoints = (tg) => {
      if (tg.joints) {
        const j = Array.isArray(tg.joints) ? tg.joints.map(Number) : [];
        if (j.length !== 6 || !j.every(Number.isFinite)) throw new MotionError('BAD_TARGET', `관절 목표값이 올바르지 않습니다 (숫자 6개 필요): ${JSON.stringify(tg.joints)?.slice(0, 80)}`);
        return j;
      }
      if (!tg.pose?.p?.every?.(Number.isFinite)) throw new MotionError('BAD_TARGET', '목표 위치가 올바르지 않습니다');
      const fl = tcpToFlange(tg.pose, tool, base);
      const j = ikNearest(this.robot, fl, j0, tg.cfgFilter);
      if (!j) throw new MotionError('UNREACHABLE', `목표 위치에 도달할 수 없습니다 (작업영역/관절한계 밖) [${tg.pose.p.map((v) => v.toFixed(1)).join(', ')}]`);
      return j;
    };
    const toPose = (tg) => {
      if (!tg || typeof tg !== 'object') throw new MotionError('BAD_TARGET', '목표 위치가 올바르지 않습니다');
      if (tg.pose) {
        if (!Array.isArray(tg.pose.p) || tg.pose.p.length !== 3 || !tg.pose.p.every(Number.isFinite) || !Array.isArray(tg.pose.R) || tg.pose.R.length !== 3) {
          throw new MotionError('BAD_TARGET', '목표 위치(pose)가 올바르지 않습니다');
        }
        return tg.pose;
      }
      const j = Array.isArray(tg.joints) ? tg.joints.map(Number) : [];
      if (j.length !== 6 || !j.every(Number.isFinite)) throw new MotionError('BAD_TARGET', '목표 관절값(joints)이 올바르지 않습니다');
      return fkTcp(this.robot, j, tool, base);
    };
    try {
      const sp = cmd.speed || {};
      for (const k of ['frac', 'tcp', 'rot']) {
        if (sp[k] !== undefined && !(Number.isFinite(sp[k]) && sp[k] > 0)) throw new MotionError('BAD_SPEED', `속도 값이 올바르지 않습니다 (${k}=${sp[k]})`);
      }
      const accelScale = cmd.accelScale !== undefined ? Number(cmd.accelScale) : this.accelScale;
      const payloadRatio = this.robot?.payload > 0 ? (this.payload?.mass || 0) / this.robot.payload : 0;
      const planOpts = { accelScale, payloadRatio };
      if (cmd.kind === 'J') {
        let frac = sp.frac;
        if (frac === undefined) frac = Math.min(1, (sp.tcp ?? 250) / this.robot.tcpMaxSpeed);
        const jEnd = toJoints(cmd.target);
        if (cmd.target?.cfgStrict && cmd.target?.cfgFilter && cmd.target.cfgFilter(jEnd) > 0) {
          throw new MotionError('CONFIG', `목표 관절 자세(Configuration)가 지정된 설정과 일치하지 않습니다`);
        }
        seg = planJoint(this.robot, j0, jEnd, frac, planOpts);
        // ISO 10218-1 T1(TEACH) TCP 250 mm/s 상한: 관절 이동도 평균 TCP 속도가 250 mm/s를 넘지 않도록 감속
        if (Number.isFinite(teachCap) && seg.duration > 1e-4) {
          const p0 = fkTcp(this.robot, j0, tool, null).p;
          const p1 = fkTcp(this.robot, jEnd, tool, null).p;
          const dist = norm(sub(p1, p0));
          const avgTcp = dist / seg.duration;
          if (avgTcp > teachCap) {
            seg = planJoint(this.robot, j0, jEnd, Math.max(0.01, frac * (teachCap / avgTcp)), planOpts);
          }
        }
      } else if (cmd.kind === 'L') {
        const reqTcp = sp.tcp ?? (sp.frac ?? 0.1) * this.robot.tcpMaxSpeed;
        seg = planLinear(this.robot, j0, toPose(cmd.target), { tcp: Math.min(reqTcp, teachCap), rot: sp.rot }, tool, base, { ...planOpts, cfgFilter: cmd.target?.cfgFilter });
      } else if (cmd.kind === 'C') {
        const reqTcp = sp.tcp ?? (sp.frac ?? 0.1) * this.robot.tcpMaxSpeed;
        seg = planCircular(this.robot, j0, toPose(cmd.via), toPose(cmd.target), { tcp: Math.min(reqTcp, teachCap), rot: sp.rot }, tool, base, { ...planOpts, cfgFilter: cmd.target?.cfgFilter });
      } else throw new Error(`알 수 없는 이동 종류 ${cmd.kind}`);
    } catch (e) {
      return Promise.reject(e);
    }
    this.jog = null;
    this.motionStats.moves++;
    const zone = this.blendEnabled ? Math.max(0, Number(cmd.zone) || 0) : 0;
    const segLen = seg.length ?? norm(sub(fkFlange(this.robot, seg.end).p, fkFlange(this.robot, j0).p));
    seg.blendAt = seg.duration;
    if (zone > 0 && seg.prof?.tAcc > 0) {
      // 남은 TCP 이동거리가 zone 이하가 되는 시점 (감속 구간 안에서만) → 다음 구간 시작
      const lo0 = Math.max(0, seg.duration - seg.prof.tAcc);
      let lo = lo0, hi = seg.duration;
      if ((1 - seg.prof.s(lo0)) * segLen <= zone) hi = lo0;
      else for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if ((1 - seg.prof.s(m)) * segLen <= zone) hi = m; else lo = m; }
      seg.blendAt = hi;
    }
    const triggers = Array.isArray(cmd.triggers) && cmd.triggers.length
      ? cmd.triggers.map((t) => ({ ...t, fired: false }))
      : null;
    return new Promise((resolve, reject) => {
      this.segs.push({ ...seg, _length: segLen, triggers, j0, zone, t: 0, resolve, reject, resolved: false });
    });
  }

  get segment() { return this.segs[0] ?? null; }
  get motionIdle() { return this.segs.length === 0; }

  cancelMotion() {
    const ss = this.segs;
    this.segs = [];
    this.jog = null;
    if (this._recoverSeg) {
      const rs = this._recoverSeg;
      this._recoverSeg = null;
      rs.reject?.(Object.assign(new Error('recovery cancelled'), { aborted: true }));
    }
    this.holdAnchor = null;
    for (const s of ss) if (!s.resolved) s.reject?.(Object.assign(new Error('motion cancelled'), { aborted: true }));
  }

  // 직교 조그 다음 자세 계산 (frame: 'base' | 'tool' | 'user')
  _cartJogPose(curWorld, axis, d, frame) {
    if (axis < 3) {
      const v = [0, 0, 0]; v[axis] = d;
      if (frame === 'tool') return poseMul(curWorld, { p: v, R: Rz(0) });
      if (frame === 'user') {
        const uf = this.effectiveBase;
        return uf ? { p: add(curWorld.p, mulv(uf.R, v)), R: curWorld.R } : { p: add(curWorld.p, v), R: curWorld.R };
      }
      return { p: add(curWorld.p, v), R: curWorld.R };
    }
    const rot = [Rx, Ry, Rz][axis - 3](d);
    if (frame === 'tool') return { p: curWorld.p, R: mul3(curWorld.R, rot) };
    if (frame === 'user') {
      const uf = this.effectiveBase;
      if (uf) {
        const rw = mul3(mul3(uf.R, rot), T3(uf.R));
        return { p: curWorld.p, R: mul3(rw, curWorld.R) };
      }
    }
    return { p: curWorld.p, R: mul3(rot, curWorld.R) };
  }

  // 조그: {type:'joint', axis:0..5, dir:±1, speed:0~1} | {type:'cart', axis:0..5 (x,y,z,rx,ry,rz), dir, speed, frame:'base'|'tool'|'user'}
  startJog(j, source = 'ui') {
    if (!j || typeof j !== 'object') return;
    const type = j.type === 'cart' ? 'cart' : j.type === 'joint' ? 'joint' : null;
    const axis = Number(j.axis);
    const dir = Number(j.dir);
    const speed = j.speed === undefined ? 0.1 : Number(j.speed);
    if (!type || !Number.isInteger(axis) || axis < 0 || axis > 5 || !Number.isFinite(dir) || dir === 0 || !Number.isFinite(speed)) return;
    if (!this.servo) { this.log('system', '조그: 서보 OFF'); return; }
    const r = this.checkCommand('jog', source);
    if (r) { if (this.lastReject?.op !== 'jog' || Date.now() - this.lastReject.t > 2000) this.reject('jog', source, r); return; }
    if (this._recoverSeg || (!this.held && (this.segment || (this.vm && this.vm.status === 'running')))) {
      if (!this._jogBusyLog || Date.now() - this._jogBusyLog > 2000) {
        this._jogBusyLog = Date.now();
        this.log('system', this._recoverSeg ? '조그 불가: 원경로 복귀 이동 중' : '조그 불가: 이동 또는 프로그램 실행 중');
      }
      return;
    }
    const frame = j.frame === 'tool' ? 'tool' : j.frame === 'user' ? 'user' : 'base';
    this.jog = { type, axis, dir: Math.sign(dir), speed: Math.max(0.01, Math.min(1, speed)), frame, until: performance.now() + 400 };
  }
  stopJog() { this.jog = null; this.emitState(); }

  // 스텝 조그: 지정한 증분(deg 또는 mm)만큼 1회 이동
  stepJog(j, source = 'ui') {
    if (!j || typeof j !== 'object') return { ok: false, reason: '잘못된 조그 입력' };
    const type = j.type === 'cart' ? 'cart' : j.type === 'joint' ? 'joint' : null;
    const axis = Number(j.axis), dir = Number(j.dir), step = Number(j.step);
    if (!type || !Number.isInteger(axis) || axis < 0 || axis > 5 || !Number.isFinite(dir) || dir === 0 || !Number.isFinite(step) || step <= 0 || step > 100) {
      return { ok: false, reason: '잘못된 스텝 조그 값' };
    }
    const g = this._teachGate(source);
    if (g) return g;
    const r = this.robot;
    const s = Math.sign(dir) * step;
    let nj;
    if (type === 'joint') {
      nj = [...this.joints];
      nj[axis] += s;
      const [lo, hi] = r.limits[axis];
      if (nj[axis] < lo || nj[axis] > hi) return { ok: false, reason: `소프트 리밋: ${axis + 1}축` };
    } else {
      const tool = this.tool;
      const cur = fkTcp(r, this.joints, tool, null);
      const frame = j.frame === 'tool' ? 'tool' : j.frame === 'user' ? 'user' : 'base';
      const next = this._cartJogPose(cur, axis, axis < 3 ? s : s * DEG, frame);
      nj = ikNearest(r, tcpToFlange(next, tool, null), this.joints);
      if (!nj || nj.some((v, i) => Math.abs(v - this.joints[i]) > 20)) return { ok: false, reason: '조그: 도달 불가/특이점' };
    }
    return this._teachApply(nj);
  }

  // 티칭용: 선택한 포인트(pose 또는 joints)로 안전 속도 이동 (Go To Point)
  async goToPoint({ kind, values, moveKind = 'J', label = '' } = {}, source = 'ui') {
    const g = this._teachGate(source);
    if (g) return g;
    if (!Array.isArray(values) || values.length < 6 || !values.every(Number.isFinite)) {
      return { ok: false, reason: '이동할 좌표 숫자가 올바르지 않습니다' };
    }
    const target = kind === 'joints'
      ? { joints: values.slice(0, 6) }
      : { pose: fromVendorPose(this.vendor, values) };
    const mk = moveKind === 'L' ? 'L' : 'J';
    try {
      this.log('system', `포인트 이동 (${label || mk}): [${values.slice(0, 6).map((v) => Number(v.toFixed(2))).join(', ')}]`);
      await this.move({ kind: mk, target, speed: { frac: 0.2, tcp: 150 }, source });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.message || String(e), code: e.code };
    }
  }

  // 티칭용: 관절각 직접 지정 (모션 없이 즉시)
  setJointsDirect(j) {
    if (!this.held && (this.segment || this.vm?.status === 'running')) return false;
    if (!withinLimits(this.robot, j)) return false;
    this.joints = [...j];
    this.updateHeld();
    this.checkCollisionNow();
    this.checkZonesNow();
    this.emitState();
    return true;
  }

  // ------------------------------------------------------------ 직접교시 (핸드 가이딩)
  // 3D 화면에서 TCP 핸들이나 링크를 끌어 로봇을 즉시 움직인다. 조그와 같은 조건(서보 ON, 정지/홀드 상태, TEACH 모드·인에이블 — 인터록 설정 시)을 따른다.
  // 결과: { ok, joints?, reason? }  — 도달 불가·자세 급변·간섭(정지 모드)은 로그 없이 사유만 돌려줌 (드래그 중 초당 수십 번 호출되므로)
  _teachGate(source) {
    if (!this.servo) return { ok: false, reason: '서보 OFF — 서보를 켜야 직접교시가 됩니다' };
    if (this._recoverSeg) return { ok: false, reason: '원경로 복귀 이동 중' };
    if (!this.held && (this.segment || this.vm?.status === 'running')) return { ok: false, reason: '프로그램·모션 실행 중' };
    const r = this.checkCommand('jog', source);
    if (r) {
      if (this.lastReject?.op !== 'jog' || Date.now() - this.lastReject.t > 2000) this.reject('jog', source, r);
      return { ok: false, reason: r.reason, code: r.code };
    }
    return null;
  }
  _teachApply(j) {
    if (!withinLimits(this.robot, j)) {
      const ax = j.findIndex((v, i) => v < this.robot.limits[i][0] || v > this.robot.limits[i][1]);
      return { ok: false, reason: `소프트 리밋: ${ax + 1}축 (${j[ax].toFixed(1)}°)` };
    }
    // SafeZone 진입 금지 사전 검사 (이미 내부에 있는 경우 빠져나오는 이동은 허용)
    for (const z of this.zones || []) {
      if (z.kind === 'safe' && z.enabled && !this.zoneStates[z.id] && robotInZone(this.robot, j, this.tool, z)) {
        return { ok: false, reason: `안전 영역 진입 금지: ${z.name}` };
      }
    }
    let preCol = null;
    if (this.collisionMode === 'stop') {
      const heldObj = this.grip?.holding || null;
      const predHeld = heldObj && heldObj.rel ? { ...heldObj, pose: poseMul(fkTcp(this.robot, j, this.gripperTcp, null), heldObj.rel) } : heldObj;
      preCol = checkCollision(this.robot, j, this.gripper, this.scene, this.objects, { ignoreObjects: heldObj ? [heldObj.id] : [], heldObject: predHeld, obstacles: this.cell.obstacles() });
      if (preCol.hit) return { ok: false, reason: `간섭: ${preCol.pairs.map((p) => `${p.a}↔${p.b}`).join(', ')}`, collision: true };
    }
    this.joints = [...j];
    this.jog = null;
    this.updateHeld();
    if (preCol) this.collision = { hit: false, pairs: [] };
    else this.checkCollisionNow();
    this.checkZonesNow();
    this.emitState();
    return { ok: true, joints: this.joints };
  }
  // TCP 목표 자세 (로봇 베이스 좌표, mm / 쿼터니언 [w,x,y,z]) — 활성 툴 프레임(this.tool) 기준
  teachPose({ p, q, R, allowJump = false }, source = 'ui') {
    const g = this._teachGate(source);
    if (g) return g;
    if (!Array.isArray(p) || p.length !== 3 || (!R && !(Array.isArray(q) && q.length === 4 && q.every(Number.isFinite)))) return { ok: false, reason: '위치 p[3] 와 자세 q[4](쿼터니언)가 필요합니다' };
    const target = { p: p.map(Number), R: R ?? RfromQuat(q) };
    if (!target.p.every(Number.isFinite)) return { ok: false, reason: '잘못된 위치' };
    const j = ikNearest(this.robot, tcpToFlange(target, this.tool, null), this.joints);
    if (!j) return { ok: false, reason: '도달 불가 (작업 영역·관절 한계 밖)' };
    const jump = Math.max(...j.map((v, i) => Math.abs(v - this.joints[i])));
    const maxJump = allowJump ? 120 : 30;
    if (jump > maxJump) return { ok: false, reason: `자세 급변 ${jump.toFixed(0)}° — 특이점 부근 (관절을 직접 끌어 자세를 바꾸십시오)` };
    return this._teachApply(j);
  }
  // 관절각 직접 지정 (관절 드래그·되돌리기)
  teachJoints(joints, source = 'ui') {
    const g = this._teachGate(source);
    if (g) return g;
    const j = Array.isArray(joints) ? joints.map(Number) : [];
    if (j.length !== 6 || !j.every(Number.isFinite)) return { ok: false, reason: '관절값 6개가 필요합니다' };
    return this._teachApply(j);
  }

  // ------------------------------------------------------------ 시뮬레이션 시계
  // 배속 1 이면 실시간. 실제 경과 시간 × timeScale 만큼 시뮬레이션을 진행하되,
  // 한 번에 SUB_MAX_S 를 넘지 않도록 서브스텝으로 나누고 서브스텝 사이에 이벤트 루프를 양보한다
  // (VM 이 다음 명령을 바로 넣을 수 있어 배속을 올려도 블렌딩·사이클 타임이 1배속과 같다).
  setTimeScale(v) {
    const x = Number(v);
    if (!Number.isFinite(x) || x <= 0) return;
    const clamped = Math.max(TIME_SCALE_MIN, Math.min(TIME_SCALE_MAX, x));
    const ext = this.traffic ? this.traffic.listClients().length : 0;
    if (this.lockTimeScaleOnExt && clamped !== 1 && (ext > 0 || this.mode === 'REMOTE')) {
      this.timeScale = 1;
      this.log('system', '⚠ 외부/REMOTE 연동 중 ×1 배속 잠금이 켜져 있어 배속을 ×1로 유지합니다');
      this.emitState();
      return;
    }
    this.timeScale = clamped;
    this.log('system', `배속 ×${+this.timeScale.toFixed(2)}${clamped !== 1 && (ext > 0 || this.mode === 'REMOTE') ? ' (⚠ 외부 PLC 타이머와 시간 불일치 주의)' : ''}`);
    this.emitState();
  }
  setTimeScaleLock(on) {
    this.lockTimeScaleOnExt = !!on;
    const ext = this.traffic ? this.traffic.listClients().length : 0;
    if (this.lockTimeScaleOnExt && this.timeScale !== 1 && (ext > 0 || this.mode === 'REMOTE')) {
      this.timeScale = 1;
      this.log('system', '외부 연동 ×1 배속 잠금 ON → 배속을 ×1로 복원');
    } else {
      this.log('system', `외부 연동 ×1 배속 잠금 ${this.lockTimeScaleOnExt ? 'ON' : 'OFF'}`);
    }
    this.emitState();
  }

  // 시뮬레이션 시간 sec 동안 대기 (HOLD 중에는 시계가 멈춤). owner: abort 시 깨울 대상 식별용
  sleep(sec, owner = null) {
    const s = Number(sec);
    const ms = s === Infinity ? Infinity : Number.isFinite(s) ? Math.max(0, s) * 1000 : 0;   // NaN 은 0 (영원히 멈추지 않게)
    return new Promise((res) => this._waiters.push({ until: this.simMs + ms, res, owner }));
  }
  // 조건이 참이 될 때까지 대기 → true, 시뮬레이션 시간 timeoutSec 초과 → false
  waitFor(pred, timeoutSec = Infinity, owner = null) {
    if (pred()) return Promise.resolve(true);
    const t = Number(timeoutSec);
    const until = Number.isFinite(t) ? this.simMs + Math.max(0, t) * 1000 : Infinity;   // NaN·생략 = 무한 대기
    return new Promise((res) => this._waiters.push({ pred, until, res, owner }));
  }
  // 시뮬레이션 시간 sec 후 fn 실행 (펄스 출력 등). owner 지정 시 wakeWaiters(owner) 로 취소 가능
  after(sec, fn, owner = undefined) {
    const s = Number(sec);
    const ms = Number.isFinite(s) ? Math.max(0, s) * 1000 : 0;
    const tag = owner !== undefined ? owner : (this.vm || 'program');
    this._waiters.push({ until: this.simMs + ms, fn, owner: tag });
  }
  // owner 의 대기 및 예약 콜백을 모두 즉시 깨움/제거 (프로그램 중단 시)
  wakeWaiters(owner) {
    const keep = [];
    for (const w of this._waiters) {
      if (owner && w.owner === owner) {
        if (w.res) w.res(w.pred ? false : undefined);
      } else keep.push(w);
    }
    this._waiters = keep;
  }
  _processWaiters() {
    if (!this._waiters.length) return;
    const due = [];
    this._waiters = this._waiters.filter((w) => {
      let hit = false, val;
      if (w.pred) { try { if (w.pred()) { hit = true; val = true; } } catch { hit = true; val = false; } }
      if (!hit && this.simMs >= w.until) { hit = true; val = w.pred ? false : undefined; }
      if (hit) due.push([w, val]);
      return !hit;
    });
    for (const [w, val] of due) {
      if (w.fn) { try { w.fn(); } catch { /* 무시 */ } }
      else w.res(val);
    }
  }

  // 주기 처리 중 예외가 나도 서버(setInterval)가 죽지 않게 — 알람으로 알리고 계속
  _tickFault(e) {
    this._ticking = false;
    const msg = `내부 오류: ${e?.message ?? e}`;
    if (this._lastFault !== msg || Date.now() - (this._lastFaultAt ?? 0) > 5000) {
      this._lastFault = msg; this._lastFaultAt = Date.now();
      console.error('[tick]', e);
      try { this.alarm('INTERNAL', msg); } catch {}
    }
  }
  tick() {
    try { this._tick(); } catch (e) { this._tickFault(e); }
  }
  _tick() {
    if (this._ticking) return;            // 이전 틱의 서브스텝이 아직 진행 중
    const now = performance.now();
    const dt = Math.min(0.1, (now - this._last) / 1000);
    this._last = now;
    let moved = false;
    // 조그는 사람이 조작하므로 배속과 무관하게 실시간 (HOLD 중 경로 이탈 조그 허용)
    if (this.jog && this.servo && !this._recoverSeg && (!this.segs.length || this.held)) {
      if (now > this.jog.until) this.jog = null;
      else { this.applyJog(dt); moved = true; this.updateHeld(); this.checkCollisionNow(); this.checkZonesNow(); }
    }
    const simDt = dt * this.timeScale;
    const n = Math.max(1, Math.min(MAX_SUB, Math.ceil(simDt / SUB_MAX_S - 1e-9)));
    const finish = () => {
      if (moved || this._dirty) { this._dirty = false; this.emit('state'); }
    };
    if (n === 1) { if (this._step(simDt)) moved = true; return finish(); }
    this._ticking = true;
    let i = 0;
    const run = () => {
      try {
        if (this._step(simDt / n)) moved = true;
        if (++i < n) setImmediate(run);
        else { this._ticking = false; finish(); }
      } catch (e) { this._tickFault(e); }
    };
    run();
  }

  // 시뮬레이션 dt(초) 만큼 진행. 상태가 바뀌었으면 true
  _step(dt) {
    if (!this.held) this.simMs += dt * 1000;
    let moved = false;
    // HOLD 중 원경로 복귀 이동 (동결된 프로그램 세그먼트는 그대로 유지)
    if (this.held && this._recoverSeg && this.servo && !this.alarms.length) {
      const rs = this._recoverSeg;
      rs.t = Math.min(rs.duration, rs.t + dt * this.override / 100);
      this.joints = rs.t >= rs.duration ? [...rs.end] : rs.sample(rs.t);
      moved = true;
      if (rs.t >= rs.duration) {
        this._recoverSeg = null;
        rs.resolve?.();
        if (rs.thenResume && this.held && !this.alarms.length) {
          this.heldMs += performance.now() - this._heldSince;
          this.held = false;
          this.holdAnchor = null;
          this.emit('resume');
          this.log('system', '원경로 복귀 완료 — 재개');
          this.emitState();
        } else {
          this.log('system', '원경로(홀드 위치) 복귀 완료');
          this.emitState();
        }
      }
    }
    if (this.segs.length && this.servo && !this.held) {
      // 구간 합성: q = seg0(t0) + Σ_k (seg_k(t_k) − seg_k.j0)  (seg_k.j0 = seg_{k-1}.end)
      const step = dt * this.override / 100;
      let q = null;
      let prev = null;
      for (const s of this.segs) {
        // 앞 구간이 블렌딩 시작점에 도달하기 전이면 대기 (블렌딩 없이 연속 호출된 경우 순차 실행)
        const advanced = !prev || prev.resolved;
        if (advanced) s.t = Math.min(s.duration, s.t + step);
        prev = s;
        const v = s.t >= s.duration ? s.end : s.sample(s.t);
        q = q ? q.map((x, i) => x + v[i] - s.j0[i]) : [...v];
        // 경로 선독 트리거 평가 (KRL TRIGGER WHEN DISTANCE/PATH, ABB TriggL/TriggJ)
        if (advanced && s.triggers?.length) {
          const prog = s.duration > 1e-9 ? s.prof.s(s.t) : 1;
          const L = s._length || 0;
          const done = s.t >= s.duration - 1e-9;
          for (const tr of s.triggers) {
            if (tr.fired) continue;
            const dMs = Number(tr.delayMs) || 0;
            let hit = false;
            if (tr.mode === 'progress') {
              if (tr.value >= 1 && dMs < 0) hit = (s.duration - s.t) <= (-dMs / 1000) + 1e-9;
              else hit = prog >= tr.value - 1e-9 || done;
            } else if (tr.mode === 'distFromStart') {
              hit = (prog * L) >= (tr.value - 1e-9) || done;
            } else if (tr.mode === 'distFromEnd') {
              hit = ((1 - prog) * L) <= (tr.value + 1e-9) || done;
            } else if (tr.mode === 'timeFromStart') {
              hit = s.t >= (tr.value - 1e-9) || done;
            } else if (tr.mode === 'timeFromEnd') {
              hit = (s.duration - s.t) <= (tr.value + 1e-9) || done;
            }
            if (hit) {
              tr.fired = true;
              if (dMs > 0) this.after(dMs / 1000, tr.fn);
              else { try { tr.fn(); } catch {} }
            }
          }
        }
        if (!s.resolved && s.t >= s.blendAt - 1e-9) { s.resolved = true; s.resolve(); }
      }
      this.joints = q;
      while (this.segs.length && this.segs[0].t >= this.segs[0].duration) this.segs.shift();
      moved = true;
    }
    // 그리퍼 개폐 애니메이션 (전체 행정 0.4s)
    const g = this.grip;
    if (g) {
      let target = g.closed ? 1 : 0;
      if (g.closed && g.holding && this.gripper.stroke) {
        const w = Math.min(...g.holding.size.slice(0, 2));
        target = Math.max(0, Math.min(1, 1 - w / this.gripper.stroke));
      }
      if (Math.abs(g.pos - target) > 1e-3) {
        g.pos += Math.sign(target - g.pos) * Math.min(Math.abs(target - g.pos), dt / 0.4);
        moved = true;
      }
      this.syncGripperFeedback();
    }
    if (this.cell.tick(dt)) moved = true;   // 주변기기 (컨베이어/피더/센서/실린더/배출구)
    if (moved) { this.updateHeld(); this.checkCollisionNow(); this.checkZonesNow(); }
    this._processWaiters();
    this.sysio.update();
    return moved;
  }

  applyJog(dt) {
    const j = this.jog;
    if (!j || !Number.isInteger(j.axis) || j.axis < 0 || j.axis > 5 || !Number.isFinite(j.dir)) { this.jog = null; return; }
    const r = this.robot;
    const sp = Math.max(0.01, Math.min(1, j.speed ?? 0.1)) * this.override / 100;
    if (j.type === 'joint') {
      const nj = [...this.joints];
      nj[j.axis] += j.dir * r.maxSpeed[j.axis] * sp * dt;
      const [lo, hi] = r.limits[j.axis];
      if (!Number.isFinite(nj[j.axis]) || nj[j.axis] < lo || nj[j.axis] > hi) { this.jog = null; this.log('system', `조그: 축${j.axis + 1} 소프트리밋`); return; }
      this.joints = nj;
    } else {
      const tool = this.tool;
      const cur = fkTcp(r, this.joints, tool, null);
      const d = j.dir * (j.axis < 3 ? 250 * sp * dt : 45 * sp * dt * DEG);
      const next = this._cartJogPose(cur, j.axis, d, j.frame);
      const nj = ikNearest(r, tcpToFlange(next, tool, null), this.joints);
      if (!nj || nj.some((v, i) => Math.abs(v - this.joints[i]) > 10)) { this.jog = null; this.log('system', '조그: 도달 불가/특이점'); return; }
      this.joints = nj;
    }
  }

  // 간섭 체크 (매 틱). 충돌 상태로 '진입'할 때만 알람 → 알람 리셋 후 빠져나오는 조그는 허용
  checkCollisionNow() {
    if (this.collisionMode === 'off') { if (this.collision.hit) this.collision = { hit: false, pairs: [] }; return; }
    const heldObj = this.grip?.holding || null;
    const r = checkCollision(this.robot, this.joints, this.gripper, this.scene, this.objects, { ignoreObjects: heldObj ? [heldObj.id] : [], heldObject: heldObj, obstacles: this.cell.obstacles() });
    const was = this.collision.hit;
    this.collision = { hit: r.hit, pairs: r.pairs.map((p) => ({ a: p.a, b: p.b, type: p.type })) };
    if (r.hit && !was) {
      const desc = r.pairs.map((p) => `${p.a}↔${p.b}`).join(', ');
      if (this.collisionMode === 'stop') {
        this.alarm('COLLISION', `간섭 감지: ${desc}`);
        if (this.vm && (this.vm.status === 'running' || this.vm.status === 'paused' || this.vm._finishing)) this.vm.abort();
      } else this.log('alarm', `[경고] 간섭 감지: ${desc}`);
    }
    if (r.hit !== was) this.emitState();
  }
  setCollisionMode(m) {
    if (!['off', 'warn', 'stop'].includes(m)) throw new Error(`간섭 체크 모드 오류: ${m}`);
    this.collisionMode = m; this.log('system', `간섭 체크: ${m}`); this.checkCollisionNow(); this.emitState();
  }

  updateHeld() {
    const o = this.grip?.holding;
    if (o) o.pose = poseMul(fkTcp(this.robot, this.joints, this.gripperTcp, null), o.rel);
  }

  // ------------------------------------------------------------ 프로그램
  // uiLang: 화면 언어 ('en' 이면 예제 주석·메시지를 영어로 — server/lang/examples-en.js)
  loadExample() {
    const files = localizeFiles(this.lang.defaultFiles(this), this.uiLang);
    this.loadFiles(files, true);
    this._exampleSig = JSON.stringify(Object.entries(files));
  }
  isExampleUntouched() {
    return !this.files.size || (this._exampleSig && this._exampleSig === JSON.stringify([...this.files]));
  }

  // 프로그램 파일 저장 (UI · 통신 모듈 · 프로젝트 공용). 이름·크기·개수 검사 — 외부 클라이언트가 메모리를 무한히 쓰지 못하게
  loadFiles(files, replace = false) {
    if (!files || typeof files !== 'object') throw new Error('파일 목록이 올바르지 않습니다');
    const entries = Object.entries(files);
    for (const [name, text] of entries) {
      if (!name || name === 'undefined' || name.length > MAX_FILE_NAME || /[\x00-\x1f\\/]/.test(name)) throw new Error(`파일 이름이 올바르지 않습니다: ${JSON.stringify(String(name).slice(0, 40))}`);
      if (String(text ?? '').length > MAX_FILE_CHARS) throw new Error(`파일이 너무 큽니다: ${name} (최대 ${MAX_FILE_CHARS / 1024 / 1024} MB)`);
    }
    const base = replace ? 0 : this.files.size;
    if (base + entries.filter(([n]) => replace || !this.files.has(n)).length > MAX_FILES) throw new Error(`파일이 너무 많습니다 (최대 ${MAX_FILES}개)`);
    if (replace) this.files = new Map();
    for (const [name, text] of entries) this.files.set(name, String(text ?? '').replace(/\r\n/g, '\n'));
    if (!this.main || !this.files.has(this.main)) this.main = this.lang.pickMain([...this.files.keys()], this.files);
    this.compile(true);
    this.emit('files');
    this.emitState();
  }
  deleteFile(name) { this.files.delete(name); if (this.main === name) this.main = this.lang.pickMain([...this.files.keys()], this.files); this.compile(true); this.emit('files'); this.emitState(); }
  setMain(name) {
    if (!this.files.has(name)) throw new Error(`파일 없음: ${name}`);
    this.main = name; this.compile(true); this.emit('files'); this.emitState();
  }

  compile(quiet = false) {
    if (this.vm?.status === 'running' || this.vm?.status === 'paused') return this.program;
    this.compileError = null;
    this.program = null;
    this.vm = null;
    if (!this.main) return null;
    try {
      this.program = this.lang.compile(this.files, this.main, this);
      this.vm = new VM(this, this.program);
      this.program.init?.(this.vm);
      this.vm.reset();
      if (!quiet) this.log('system', `컴파일 완료: ${this.main}`);
      // 에뮬레이터가 실행하지 않는 문장 경고 (내용이 바뀌었을 때만 한 번)
      const w = this.program.warnings || [];
      const sig = w.map((x) => `${x.file}:${x.line}:${x.msg}`).join('|');
      if (sig !== this._warnSig) {
        this._warnSig = sig;
        if (w.length) this.log('system', `⚠ 에뮬레이터가 실행하지 않는 문장 ${w.length}개 (무시됨): ${w.slice(0, 6).map((x) => `${x.msg} (${x.file}:${x.line})`).join(', ')}${w.length > 6 ? ' …' : ''}`);
      }
    } catch (e) {
      this.compileError = { msg: e.message, file: e.file ?? null, line: e.line ?? null };
      this.log('alarm', `컴파일 오류 ${e.file ?? ''}${e.line ? ':' + e.line : ''} ${e.message}`);
    }
    this.emitState();
    return this.program;
  }

  // 프로그램 포인터(PP)를 지정 파일·줄로 이동 (Set PP to Cursor)
  setPP(file, line) {
    if (this.vm?.status === 'running' && !this.held) {
      return { ok: false, reason: '프로그램 실행 중에는 PP를 이동할 수 없습니다 (정지 후 시도)' };
    }
    if (this.vm?.status === 'running' || this.vm?.status === 'paused') this.stopProgram();
    if (!this.vm || ['done', 'error', 'aborted'].includes(this.vm.status)) this.compile(true);
    if (!this.vm) return { ok: false, reason: this.compileError?.msg || '컴파일된 프로그램이 없습니다' };
    const r = this.vm.setPointer(file || this.main, line);
    if (r.ok) {
      this.log('system', `PP 이동: ${r.file}:${r.line} (${r.proc})`);
      this.emitState();
    }
    return r;
  }

  async start({ step = false, source = 'internal' } = {}) {
    if (!this.allow('start', source)) return false;
    if (this.alarms.length) { this.log('system', '알람 리셋 후 시작하십시오'); this._noteReject('start', source, REJECT.ALARM); return false; }
    if (!this.servo) { this.log('system', '서보 OFF — 시작 불가'); this._noteReject('start', source, REJECT.SERVO_OFF); return false; }
    if (this.vm && this.vm.status === 'running' && this.held) { return this.resume(source); }
    if (this.vm && this.vm.status === 'paused') {
      if (this.held) {
        if (!this.resume(source)) return false;
      }
      this.vm.stepResume(step);
      this.emitState();
      return true;
    }
    if (this.vm?.status === 'running') return true;
    // 직전 실행이 아직 마지막 모션(블렌딩 꼬리)을 기다리는 중이면 분리 — 새 실행의 모션을 자기 것으로 세지 않게
    if (['done', 'error', 'aborted'].includes(this.vm?.status)) this.vm.detach?.();
    // 정지(E-stop·펜스·서보 OFF)로 동결된 이전 이동은 버림 — 새 프로그램 시작 시 옛 수동 이동이 이어서 실행되지 않게
    if (this.held && this.segment) { this.cancelMotion(); this.log('system', '정지로 중단된 이전 이동을 취소했습니다'); }
    if (!this.vm || ['done', 'error', 'aborted'].includes(this.vm.status)) this.compile(true);
    if (!this.vm) return false;
    if (this.vm.status !== 'idle') this.vm.reset();
    this.held = false;
    this.holdAnchor = null;
    this._recoverSeg = null;
    const ppCustom = !!this.vm._ppCustom;
    if (this.autoResetScene && !step && !ppCustom) {
      // 중간 정지로 공작물을 쥔 채 남아 있으면 그리퍼를 열고 셀을 초기 배치로
      if (this.grip?.closed || this.grip?.holding) { this.setDO(this.gripperIO.close, false); this.gripperCmd(false); }
      this.resetScene();
    }
    this.log('system', `프로그램 시작: ${this.main}${ppCustom && this.vm.current?.line ? ` (Ln ${this.vm.current.line}부터)` : ''}${step ? ' (단계 실행)' : ''}`);
    this.vm.run({ step });
    return true;
  }
  hold() {
    // 실행 중인 프로그램/모션이 없으면 HOLD 는 의미가 없음 (이후 이동이 멈춘 채 남지 않도록)
    const active = this.segment || this.vm?.status === 'running' || this.vm?.status === 'paused';
    if (!active) { this.log('system', 'HOLD: 실행 중인 동작 없음'); return; }
    if (!this.held) {
      this.held = true;
      this._heldSince = performance.now();
      if (!this.holdAnchor) this.holdAnchor = [...this.joints];
      this.log('system', 'HOLD');
      this.emitState();
    }
  }
  // HOLD 중 수동 이동으로 이탈한 로봇을 홀드 위치(원경로)로 저속 복귀
  recoverPath(source = 'ui', { thenResume = false, wait = false } = {}) {
    if (!this.held || !this.holdAnchor) return { ok: false, reason: '홀드 상태가 아니거나 복귀 기준점이 없습니다' };
    if (!this.servo) return { ok: false, reason: '서보 OFF — 서보를 켠 뒤 원경로 복귀하십시오' };
    if (this.alarms.length) return { ok: false, reason: '알람 리셋 후 원경로 복귀하십시오' };
    const r = this.checkCommand('move', source);
    if (r) { this.reject('move', source, r); return { ok: false, reason: r.reason, code: r.code }; }
    const pr = this.getPathRecovery();
    if (!pr.deviated) return { ok: true, recovering: false, alreadyAtAnchor: true };
    if (this._recoverSeg) {
      if (thenResume) this._recoverSeg.thenResume = true;
      return wait ? this._recoverSeg.promise : { ok: true, recovering: true };
    }
    const seg = planJoint(this.robot, [...this.joints], [...this.holdAnchor], 0.15, { accelScale: Math.min(50, this.accelScale) });
    this.jog = null;
    let resolveFn, rejectFn;
    const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
    this._recoverSeg = { ...seg, t: 0, thenResume: !!thenResume, resolve: () => resolveFn({ ok: true }), reject: rejectFn, promise };
    this.log('system', `⚠ 경로 이탈 ${pr.maxDeg}° 감지 — 홀드 위치(원경로)로 저속 복귀 시작${thenResume ? ' (완료 후 자동 재개)' : ''}`);
    this.emitState();
    return wait ? promise : { ok: true, recovering: true, duration: +seg.duration.toFixed(2) };
  }
  resume(source = 'internal') {
    if (!this.held) return true;
    if (!this.allow('resume', source)) return false;
    if (!this.servo && (this.segment || this.vm?.status === 'running')) { this.log('system', '재개 불가: 서보 OFF'); this._noteReject('resume', source, REJECT.SERVO_OFF); return false; }
    const pr = this.getPathRecovery();
    const mode = this.safety?.pathRecovery || 'auto';
    if (pr.deviated && mode === 'block') {
      return this.reject('resume', source, REJECT.PATH_DEVIATED);
    }
    if (pr.deviated && mode === 'auto') {
      const rec = this.recoverPath(source, { thenResume: true });
      return !!rec?.ok;
    }
    if (this.held) {
      this.heldMs += performance.now() - this._heldSince;
      this.held = false;
      this.holdAnchor = null;
      this._recoverSeg = null;
      this.emit('resume');
      this.log('system', '재개');
      this.emitState();
    }
    return true;
  }
  heldNow() { return this.heldMs + (this.held ? performance.now() - this._heldSince : 0); }

  finishCycle(st) {
    const total = st.motion + st.wait + st.logic;
    const lines = [...st.lines.values()].sort((a, b) => b.time - a.time).slice(0, 15)
      .map((l) => ({ ...l, time: +(l.time / 1000).toFixed(3) }));
    const s = (ms) => +(ms / 1000).toFixed(3);
    this.cycleStats.last = { total: s(total), motion: s(st.motion), wait: s(st.wait), logic: s(st.logic), moves: st.moves, lines, blend: this.blendEnabled, override: this.override, robot: this.robot.id, at: Date.now() };
    this.cycleStats.history.push({ total: s(total), blend: this.blendEnabled, at: Date.now() });
    if (this.cycleStats.history.length > 30) this.cycleStats.history.shift();
    this.cycleStats.current = null;
    this.log('program', `사이클 타임 ${s(total).toFixed(2)}s (모션 ${s(st.motion).toFixed(2)} / 대기 ${s(st.wait).toFixed(2)} / 기타 ${s(st.logic).toFixed(2)})${this.blendEnabled ? '' : ' [블렌딩 OFF]'}`);
    this.emitState();
  }

  stopProgram() {
    if (this.vm && (this.vm.status === 'running' || this.vm.status === 'paused' || this.vm._finishing)) { this.vm.abort(); this.log('system', '프로그램 정지'); }
    if (this.held) this.heldMs += performance.now() - this._heldSince;
    this.held = false;
    this.holdAnchor = null;
    this._recoverSeg = null;
    this.emit('resume');
    this.cancelMotion();
  }
  resetProgram() { this.stopProgram(); this.compile(true); }
}

export { ROBOTS, GRIPPERS, VENDORS, fromVendorPose };
