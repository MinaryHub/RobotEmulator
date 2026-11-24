// KUKA KRL 인터프리터 (.src + .dat, $config.dat 선택)
// - DEF/END, DEFFCT/ENDFCT, DEFDAT/ENDDAT, DECL (INT/REAL/BOOL/CHAR/E6POS/POS/FRAME/E6AXIS/AXIS/PDAT/LDAT/FDAT, 배열, STRUC/ENUM)
// - PTP/LIN/CIRC(+CA)/PTP_REL/LIN_REL, KSS 인라인 폼(ILF) 및 폴드 내부 코드(BAS(#PTP_PARAMS) 등)
// - 기하 연산자 ':', 부분 구조체 목표({Z 300} → 현재 위치와 병합), Status/Turn
// - IF/FOR/WHILE/REPEAT/LOOP/EXIT/SWITCH/GOTO/HALT/WAIT/PULSE, 시스템 변수($OUT,$IN,$VEL,$TOOL,$BASE,$POS_ACT ...)
import { Parser, evaluate, binop, truthy, tokenize } from './expr.js';
import { CompileError, at, RuntimeErr, K, stripComment, splitTop } from './common.js';
import { poseMul, poseInv, mul3, add, sub, cross, norm, scale, dot, DEG, RAD } from '../../shared/math.js';
import { toVendorPose, fromVendorPose, frameFromXYZRPY } from '../../shared/poseformat.js';
import { ikNearest, tcpToFlange, fkTcp, toOpw, wristCenter } from '../../shared/kinematics.js';

const OPTS = { colonOp: true };

// ------------------------------------------------------------------ 데이터 타입
const E = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6'];
const FIELDS = {
  FRAME: ['X', 'Y', 'Z', 'A', 'B', 'C'],
  POS: ['X', 'Y', 'Z', 'A', 'B', 'C', 'S', 'T'],
  E6POS: ['X', 'Y', 'Z', 'A', 'B', 'C', 'S', 'T', ...E],
  AXIS: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'],
  E6AXIS: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', ...E],
  PDAT: ['VEL', 'ACC', 'APO_DIST', 'APO_MODE', 'GEAR_JERK', 'EXAX_IGN'],
  LDAT: ['VEL', 'ACC', 'APO_DIST', 'APO_FAC', 'AXIS_VEL', 'AXIS_ACC', 'ORI_TYP', 'CIRC_TYP', 'JERK_FAC', 'GEAR_JERK', 'EXAX_IGN'],
  FDAT: ['TOOL_NO', 'BASE_NO', 'IPO_FRAME', 'POINT2', 'TQ_STATE'],
};
const INT_FIELDS = new Set(['S', 'T', 'TOOL_NO', 'BASE_NO', 'EXAX_IGN']);
const NUM_FIELDS = new Set([...FIELDS.E6POS, ...FIELDS.E6AXIS]);
const SIMPLE = new Set(['INT', 'REAL', 'BOOL', 'CHAR']);
const BUILTIN_TYPES = new Set([...SIMPLE, ...Object.keys(FIELDS), 'LOAD', 'SIGNAL']);

const clone = (v) => (v && typeof v === 'object' && !v.$proxy ? structuredClone(v) : v);
const isStruct = (v) => v && typeof v === 'object' && !Array.isArray(v) && !v.$proxy;

function defaultK(type, prog) {
  const T = K(type);
  if (T === 'INT' || T === 'REAL') return 0;
  if (T === 'BOOL') return false;
  if (T === 'CHAR') return '';
  if (FIELDS[T]) {
    const o = { $type: T };
    for (const f of FIELDS[T]) {
      if (f === 'S' || f === 'T') continue; // 미지정 Status/Turn
      if (T === 'PDAT' || T === 'LDAT' || T === 'FDAT') continue;
      o[f] = 0;
    }
    if (T === 'PDAT') Object.assign(o, { VEL: 100, ACC: 100, APO_DIST: 100, APO_MODE: '#CDIS' });
    if (T === 'LDAT') Object.assign(o, { VEL: 2, ACC: 100, APO_DIST: 100, APO_FAC: 50, ORI_TYP: '#VAR', CIRC_TYP: '#BASE' });
    if (T === 'FDAT') Object.assign(o, { TOOL_NO: 1, BASE_NO: 0, IPO_FRAME: '#BASE', POINT2: '' });
    return o;
  }
  const st = prog?.strucs?.[T];
  if (st) {
    const o = { $type: T };
    for (const [f, ft] of st) o[f] = defaultK(ft, prog);
    return o;
  }
  const en = prog?.enums?.[T];
  if (en) return en[0];
  return 0;
}

function coerceK(type, v, old, prog) {
  const T = type ? K(type) : null;
  if (v === undefined) return defaultK(T, prog);
  if (T === 'INT') {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v !== 'number') throw new RuntimeErr('TYPE', `INT 형에 ${typeof v} 값을 대입할 수 없습니다`);
    return Math.round(v);
  }
  if (T === 'REAL') {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v !== 'number') throw new RuntimeErr('TYPE', `REAL 형에 ${typeof v} 값을 대입할 수 없습니다`);
    return v;
  }
  if (T === 'BOOL') return typeof v === 'boolean' ? v : truthy(v);
  if (T === 'CHAR') return typeof v === 'number' ? String.fromCharCode(v) : String(v);
  if (isStruct(v) && T && (FIELDS[T] || prog?.strucs?.[T])) {
    // 구조체 집합체 대입: 지정된 성분만 변경 (나머지는 기존 값 유지)
    const allowed = FIELDS[T] || prog.strucs[T].map(([f]) => f);
    const strict = !['PDAT', 'LDAT', 'FDAT'].includes(T);
    const base = isStruct(old) ? clone(old) : defaultK(T, prog);
    base.$type = T;
    for (const [k, x] of Object.entries(v)) {
      if (k === '$type') continue;
      if (strict && !allowed.includes(k)) {
        if (v.$type) continue; // 다른 구조체 형식 → 공통 성분만 복사
        throw new RuntimeErr('TYPE', `${T} 에 성분 '${k}' 가 없습니다`);
      }
      base[k] = INT_FIELDS.has(k) && typeof x === 'number' ? Math.round(x) : clone(x);
    }
    return base;
  }
  return clone(v);
}

function makeArr(type, dims, prog) {
  if (!dims?.length) return defaultK(type, prog);
  if (dims.length === 1 && K(type) === 'CHAR') return '';
  const [d, ...rest] = dims;
  return Array.from({ length: d }, () => makeArr(type, rest, prog));
}

// ------------------------------------------------------------------ 텍스트 형식
function fmtReal(n) {
  if (!Number.isFinite(n)) return String(n);
  let r = +n.toFixed(6);
  if (Object.is(r, -0)) r = 0;
  let s = String(r);
  if (!/[.eE]/.test(s)) s += '.0';
  return s;
}

export function formatValue(v, type) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') {
    if (type && K(type) === 'REAL') return fmtReal(v);
    return Number.isInteger(v) ? String(v) : fmtReal(v);
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return /^#[A-Za-z_]\w*$/.test(v) ? v.toUpperCase() : `"${v}"`;
  if (Array.isArray(v)) return v.map((x) => formatValue(x, type)).join(', ');
  if (typeof v === 'object') {
    const order = FIELDS[v.$type] || [];
    const keys = [...order.filter((k) => k in v), ...Object.keys(v).filter((k) => k !== '$type' && !order.includes(k))];
    const body = keys.map((k) => {
      const x = v[k];
      let s;
      if (typeof x === 'number') s = INT_FIELDS.has(k) ? String(Math.round(x)) : NUM_FIELDS.has(k) || (v.$type && FIELDS[v.$type]) ? fmtReal(x) : formatValue(x);
      else if (typeof x === 'string' && k === 'POINT2') s = `"${x}"`;
      else s = formatValue(x);
      return `${k} ${s}`;
    }).join(', ');
    return `{${v.$type ? `${v.$type}: ` : ''}${body}}`;
  }
  return String(v);
}

// 문자열 밖에서만 치환: EXOR → XOR (공용 파서 연산자명), CHAR 배열 표기 name[] 정리
function prepLine(s) {
  return s.split(/("[^"]*")/).map((seg, i) => (i % 2 ? seg : seg
    .replace(/\bEXOR\b/gi, 'XOR')
    .replace(/(\w)\[\]\s*$/g, '$1 ')         // POINT2[] " "  →  POINT2 " "  (다음 조각이 문자열)
    .replace(/(\w)\[\]\s*=/g, '$1='))).join(''); // name[]="..."  →  name="..."
}

export function parseValue(text) {
  const p = new Parser(prepLine(String(text).trim()), { ...OPTS });
  const ast = p.expr();
  if (!p.eof()) throw new Error(`값 형식 오류: ${text}`);
  return evaluate(ast, {
    get(name) {
      const u = K(name);
      if (u.startsWith('#')) return u;
      if (u === 'TRUE') return true;
      if (u === 'FALSE') return false;
      throw new Error(`값에 사용할 수 없는 이름 '${name}'`);
    },
    call(name) { throw new Error(`값에 함수 호출 불가: ${name}`); },
    struct: (type, obj) => (type ? { $type: K(type), ...obj } : obj),
  });
}

// ------------------------------------------------------------------ 기하 / Status·Turn
const frameToPose = (v) => fromVendorPose('kuka', ['X', 'Y', 'Z', 'A', 'B', 'C'].map((k) => Number(v?.[k] ?? 0)));
function poseToStruct(P, type = 'FRAME') {
  const [x, y, z, a, b, c] = toVendorPose('kuka', P);
  return { $type: type, X: x, Y: y, Z: z, A: a, B: b, C: c };
}
const NULLFRAME = () => ({ $type: 'FRAME', X: 0, Y: 0, Z: 0, A: 0, B: 0, C: 0 });
const isIdent = (P) => Math.hypot(...P.p) < 1e-9 && Math.abs(P.R[0][0] + P.R[1][1] + P.R[2][2] - 3) < 1e-9;
const isAxisVal = (v) => v && (v.$type === 'E6AXIS' || v.$type === 'AXIS' || (!v.$type && Object.keys(v).some((k) => /^A[1-6]$/.test(k))));

// KUKA Status 비트: bit0 손목 중심이 A1 축 뒤(오버헤드), bit1 A3 (팔 펴짐 기준각 이상), bit2 A5 <= 0
function statusInfo(robot, j) {
  const q = toOpw(robot, j);
  const wc = wristCenter(robot, j);
  const x1 = wc[0] * Math.cos(q[0]) + wc[1] * Math.sin(q[0]);
  const e = (q[2] + Math.atan2(robot.opw.a2, robot.opw.c3)) * RAD;
  return [
    { bit: x1 < 0 ? 1 : 0, margin: Math.abs(x1) > 1 },
    { bit: e >= 0 ? 1 : 0, margin: Math.abs(e) > 0.5 },
    { bit: j[4] <= 0 ? 1 : 0, margin: Math.abs(j[4]) > 0.5 },
  ];
}
function statusTurn(robot, j) {
  let S = 0, T = 0;
  statusInfo(robot, j).forEach((s, i) => { if (s.bit) S |= 1 << i; });
  for (let i = 0; i < 6; i++) if (j[i] < 0) T |= 1 << i;
  return { S, T };
}
// S/T 지정 시 일치하는 IK 해 우선 (0° 근처 등 경계값은 허용)
function stFilter(robot, S, T) {
  return (sol) => {
    let pen = 0;
    if (T !== undefined) for (let i = 0; i < 6; i++) {
      if (Math.abs(sol[i]) <= 0.5) continue;
      if (((T >> i) & 1) !== (sol[i] < 0 ? 1 : 0)) pen++;
    }
    if (S !== undefined) statusInfo(robot, sol).forEach((s, i) => { if (s.margin && ((S >> i) & 1) !== s.bit) pen++; });
    return pen;
  };
}

function e6pos(ctrl) {
  const P = ctrl.tcpPose();
  const { S, T } = statusTurn(ctrl.robot, ctrl.joints);
  const o = poseToStruct(P, 'E6POS');
  Object.assign(o, { S, T, E1: 0, E2: 0, E3: 0, E4: 0, E5: 0, E6: 0 });
  return o;
}
function e6axis(j) {
  const o = { $type: 'E6AXIS' };
  j.forEach((v, i) => { o[`A${i + 1}`] = v; });
  for (const k of E) o[k] = 0;
  return o;
}

// 원호 위의 점: 시작점에서 보조점 방향으로 ang(deg) 만큼
function circlePoint(A, B, C, ang) {
  const ab = sub(B, A), ac = sub(C, A);
  const n = cross(ab, ac);
  const nn = norm(n);
  if (nn < 1e-6) throw new RuntimeErr('CIRC', 'CIRC: 세 점이 일직선 위에 있습니다');
  const ab2 = dot(ab, ab), ac2 = dot(ac, ac);
  const center = add(A, scale(add(scale(cross(n, ab), ac2), scale(cross(ac, n), ab2)), 1 / (2 * nn * nn)));
  const r = norm(sub(A, center));
  const nz = scale(n, 1 / nn);
  const ex = scale(sub(A, center), 1 / r);
  const ey = cross(nz, ex);
  const th = ang * DEG;
  return add(center, add(scale(ex, r * Math.cos(th)), scale(ey, r * Math.sin(th))));
}

// ------------------------------------------------------------------ 런타임 상태
function newState() {
  return {
    velAxis: [100, 100, 100, 100, 100, 100],
    accAxis: [100, 100, 100, 100, 100, 100],
    vel: { CP: 2, ORI1: 200, ORI2: 200 },
    acc: { CP: 2.3, ORI1: 300, ORI2: 300 },
    apo: { CDIS: 0, CPTP: 0, CORI: 0, CVEL: 0 },
    tool: null, base: null, toolNo: null, baseNo: 0,
    sys: new Map(),
    timers: Array.from({ length: 65 }, () => ({ v: 0, since: 0, stop: true })),
    pendingTriggers: [],
  };
}

class Ctx {
  constructor(prog, ctrl, vm, frame) { this.prog = prog; this.ctrl = ctrl; this.vm = vm; this.frame = frame; this.st = prog.state; }
  get env() { return this._env ||= makeEnv(this); }
  ev(ast) { return evaluate(ast, this.env); }
}

const PROXY_IO = { $proxy: 'io' };
function sysGet(cx, u) {
  const { ctrl, st } = cx;
  switch (u) {
    case '$OV_PRO': return ctrl.override;
    case '$POS_ACT': case '$POS_ACT_MES': case '$POS_INT': return e6pos(ctrl);
    case '$AXIS_ACT': case '$AXIS_ACT_MES': case '$AXIS_INT': return e6axis(ctrl.joints);
    case '$OUT': case '$OUT_C': return { $proxy: 'do' };
    case '$IN': return { $proxy: 'di' };
    case '$ANIN': case '$ANOUT': return { $proxy: 'an' };
    case '$TIMER': return { $proxy: 'timer' };
    case '$TIMER_STOP': return { $proxy: 'timerstop' };
    case '$TIMER_FLAG': return { $proxy: 'timerflag' };
    case '$TOOL': return st.tool ? st.tool : poseToStruct(ctrl.tool);
    case '$BASE': return st.base ? st.base : NULLFRAME();
    case '$NULLFRAME': case '$WORLD': case '$ROBROOT': return NULLFRAME();
    case '$VEL': return st.vel;
    case '$ACC': return st.acc;
    case '$APO': return st.apo;
    case '$VEL_AXIS': return st.velAxis;
    case '$ACC_AXIS': return st.accAxis;
    case '$MODE_OP': return ctrl.mode === 'PLAY' ? '#AUT' : ctrl.mode === 'REMOTE' ? '#EX' : '#T1';
    case '$H_POS': return st.sys.get(u) ?? e6axis(ctrl.robot.home);
    case '$STOPMESS': return ctrl.alarms.length > 0;
    case '$PRO_STATE': case '$PRO_STATE1': return cx.vm?.status === 'running' ? '#P_ACTIVE' : '#P_FREE';
    case '$TOOL_NO': case '$ACT_TOOL': return st.toolNo ?? 1;
    case '$BASE_NO': case '$ACT_BASE': return st.baseNo ?? 0;
    case '$ROBNAME': return [ctrl.robot.name];
    case '$NUM_AX': return 6;
  }
  if (st.sys.has(u)) return st.sys.get(u);
  if (/^\$(ADVANCE|BWDSTART|CIRC_TYPE|ORI_TYPE|APO_DIS_PTP|SPL_.*|IPO_MODE|LOAD|TORQUE.*|CP_.*)$/.test(u)) return 0;
  throw new RuntimeErr('SYSVAR', `알 수 없는 시스템 변수 ${u}`);
}

function setTool(cx, frame, no) {
  const { st, ctrl } = cx;
  if (no !== undefined) st.toolNo = no;
  if (!frame) { st.tool = null; ctrl.toolOverride = null; return; }
  st.tool = { ...poseToStruct(frameToPose(frame)) };
  ctrl.toolOverride = frameToPose(frame);
}
function setBase(cx, frame, no) {
  const { st, ctrl } = cx;
  if (no !== undefined) st.baseNo = no;
  const P = frame ? frameToPose(frame) : null;
  st.base = P ? poseToStruct(P) : null;
  ctrl.base = P && !isIdent(P) ? P : null;
}
// TOOL_DATA[n] (미설정 → 선택된 그리퍼 TCP), n=0 → 플랜지
function selectTool(cx, n) {
  n = Math.round(Number(n));
  if (n === 0) { setTool(cx, NULLFRAME(), 0); return; }
  const td = cx.prog.globals.get('TOOL_DATA');
  const v = Array.isArray(td) ? td[n - 1] : undefined;
  setTool(cx, v || null, n);
}
function selectBase(cx, n) {
  n = Math.round(Number(n));
  if (n === 0) { setBase(cx, null, 0); return; }
  const bd = cx.prog.globals.get('BASE_DATA');
  setBase(cx, (Array.isArray(bd) ? bd[n - 1] : null) || null, n);
}

function sysSet(cx, u, v) {
  const { ctrl, st } = cx;
  switch (u) {
    case '$OV_PRO': ctrl.setOverride(Number(v)); return;
    case '$TOOL': setTool(cx, v); return;
    case '$BASE': setBase(cx, v); return;
    case '$VEL': Object.assign(st.vel, filterKeys(v)); return;
    case '$ACC': Object.assign(st.acc, filterKeys(v)); return;
    case '$APO': Object.assign(st.apo, filterKeys(v)); return;
    case '$VEL_AXIS': case '$ACC_AXIS': throw new RuntimeErr('SYSVAR', `${u} 는 배열입니다 (${u}[n]=값)`);
    case '$POS_ACT': case '$AXIS_ACT': case '$IN': case '$OUT': case '$MODE_OP': throw new RuntimeErr('SYSVAR', `${u} 는 쓰기 금지입니다`);
  }
  st.sys.set(u, clone(v));
}
const filterKeys = (v) => { const o = {}; for (const [k, x] of Object.entries(v || {})) if (k !== '$type') o[k] = x; return o; };

function timerVal(t, now) { return t.stop ? t.v : t.v + (now - t.since); }

function makeEnv(cx) {
  const { prog, ctrl } = cx;
  return {
    get(name) {
      const u = K(name);
      if (u.startsWith('#')) return u;
      if (cx.frame?.locals.has(u)) return cx.frame.locals.get(u);
      if (prog.signals.has(u)) return readSignal(cx, prog.signals.get(u));
      if (prog.globals.has(u)) return prog.globals.get(u);
      if (u === 'TRUE') return true;
      if (u === 'FALSE') return false;
      if (u.startsWith('$')) return sysGet(cx, u);
      throw new RuntimeErr('UNDEF', `선언되지 않은 변수 '${name}'`);
    },
    call(name, args, named, node) { return callFunc(cx, name, args, node); },
    field(obj, name) {
      const k = K(name);
      if (!isStruct(obj) || !(k in obj)) throw new RuntimeErr('TYPE', `구조체 성분 '${name}' 이 없습니다`);
      return obj[k];
    },
    index(obj, idx) {
      if (obj?.$proxy) {
        const n = Math.round(idx[0]);
        if (obj.$proxy.startsWith('timer')) timerAt(cx, n);
        switch (obj.$proxy) {
          case 'do': return ctrl.getDO(n);
          case 'di': return ctrl.getDI(n);
          case 'an': return 0;
          case 'timer': return Math.round(timerVal(cx.st.timers[n], cx.ctrl.simMs));
          case 'timerstop': return cx.st.timers[n].stop;
          case 'timerflag': return false;
        }
      }
      let v = obj;
      for (const i of idx) {
        const n = Math.round(i);
        if (typeof v === 'string') { v = v[n - 1] ?? ''; continue; }
        if (!Array.isArray(v)) throw new RuntimeErr('TYPE', '배열이 아닌 변수에 인덱스 사용');
        if (n < 1 || n > v.length) throw new RuntimeErr('INDEX', `배열 인덱스 범위 초과: ${n} (크기 ${v.length})`);
        v = v[n - 1];
      }
      return v;
    },
    struct: (type, obj) => (type ? { $type: K(type), ...obj } : obj),
    binop(op, a, b, node) {
      // KRL: INT / INT 는 정수 나눗셈 (소수부 버림). 피연산자의 선언 타입으로 판단 — 7.0 같은 REAL 값과 구분하기 위해 값이 아닌 식을 봄
      if (op === '/' && node && typeof a === 'number' && typeof b === 'number' && staticInt(cx, node.a) && staticInt(cx, node.b)) {
        if (b === 0) throw new RuntimeErr('MATH', '0 으로 나눔');
        return Math.trunc(a / b);
      }
      if (op === ':') {
        if (!isStruct(a) || !isStruct(b)) throw new RuntimeErr('TYPE', "기하 연산자 ':' 의 피연산자는 FRAME/POS 여야 합니다");
        if (isAxisVal(a) || isAxisVal(b)) throw new RuntimeErr('TYPE', "기하 연산자 ':' 에 AXIS 형은 사용할 수 없습니다");
        const P = poseMul(frameToPose(a), frameToPose(b));
        const type = b.$type || a.$type || 'FRAME';
        const out = poseToStruct(P, type);
        if (type === 'POS' || type === 'E6POS') {
          for (const k of ['S', 'T', ...E]) { const x = b[k] ?? a[k]; if (x !== undefined) out[k] = x; }
        }
        return out;
      }
      if (isStruct(a) || isStruct(b)) {
        if (op === '=' || op === '<>') { const e = formatValue(a) === formatValue(b); return op === '=' ? e : !e; }
        throw new RuntimeErr('TYPE', `연산자 '${op}' 를 구조체에 사용할 수 없습니다`);
      }
      return undefined;
    },
  };
}

// SIGNAL 별칭: $OUT[n] 또는 $OUT[a] TO $OUT[b] (정수 그룹)
function readSignal(cx, sg) {
  if (!sg.to) return cx.ev(sg.from);
  const get = sg.type === 'do' ? (n) => cx.ctrl.getDO(n) : (n) => cx.ctrl.getDI(n);
  let v = 0;
  for (let n = sg.a; n <= sg.b; n++) if (get(n)) v |= 1 << (n - sg.a);
  return v;
}
function writeSignal(cx, sg, v) {
  if (!sg.to) { assignK(cx, sg.from, v); return; }
  if (sg.type !== 'do') throw new RuntimeErr('SYSVAR', '입력 신호에는 쓸 수 없습니다');
  for (let n = sg.a; n <= sg.b; n++) cx.ctrl.setDO(n, !!((Number(v) >> (n - sg.a)) & 1));
}

// ------------------------------------------------------------------ 대입
function rootKey(n) { return n.t === 'id' ? K(n.name) : n.obj ? rootKey(n.obj) : null; }
function varMeta(cx, key) {
  if (cx.frame?.locals.has(key)) return cx.frame.proc.ltypes.get(key);
  return cx.prog.meta.get(key);
}

// 식의 정적 타입이 INT 인지 (리터럴·선언된 변수·배열 요소·정수 연산). 알 수 없으면 false (= 실수 나눗셈)
function staticInt(cx, n) {
  switch (n?.t) {
    case 'num': return !n.real;
    case 'id': case 'index': {
      const key = rootKey(n);
      if (!key || (n.t === 'index' && n.obj.t !== 'id')) return false;
      return varMeta(cx, key)?.type === 'INT';
    }
    case 'un': return (n.op === '-' || n.op === '+') && staticInt(cx, n.a);
    case 'bin': return ['+', '-', '*', '/', 'DIV', 'MOD'].includes(n.op) && staticInt(cx, n.a) && staticInt(cx, n.b);
    default: return false;
  }
}

// $TIMER[n] 범위 검사 (1~64)
function timerAt(cx, n) {
  const t = n >= 1 ? cx.st.timers[n] : undefined;
  if (!t) throw new RuntimeErr('INDEX', `$TIMER 인덱스 범위 초과: ${n} (1~${cx.st.timers.length - 1})`);
  return t;
}

function assignK(cx, node, value) {
  const { prog } = cx;
  if (node.t === 'id') {
    const u = K(node.name);
    if (prog.signals.has(u)) { writeSignal(cx, prog.signals.get(u), value); return; }
    const where = cx.frame?.locals.has(u) ? cx.frame.locals : prog.globals.has(u) ? prog.globals : null;
    if (!where) {
      if (u.startsWith('$')) { sysSet(cx, u, value); return; }
      throw new RuntimeErr('UNDEF', `선언되지 않은 변수 '${node.name}'`);
    }
    const meta = varMeta(cx, u);
    if (meta?.konst) throw new RuntimeErr('CONST', `상수 '${node.name}' 에는 대입할 수 없습니다`);
    if (meta?.dims?.length && !(meta.dims.length === 1 && meta.type === 'CHAR')) throw new RuntimeErr('TYPE', `배열 '${node.name}' 전체에는 대입할 수 없습니다`);
    where.set(u, coerceK(meta?.dims?.length ? 'CHAR' : meta?.type, value, where.get(u), prog));
    return;
  }
  if (node.t === 'index') {
    const obj = cx.ev(node.obj);
    const idx = node.idx.map((x) => Math.round(cx.ev(x)));
    if (obj?.$proxy) {
      const n = idx[0];
      if (obj.$proxy.startsWith('timer')) timerAt(cx, n);
      switch (obj.$proxy) {
        case 'do': cx.ctrl.setDO(n, truthy(value)); return;
        case 'di': cx.ctrl.setDI(n, truthy(value)); return;
        case 'an': return;
        case 'timer': { const t = cx.st.timers[n]; t.v = Number(value); t.since = cx.ctrl.simMs; return; }
        case 'timerstop': {
          const t = cx.st.timers[n];
          const stop = truthy(value);
          if (stop && !t.stop) { t.v = timerVal(t, cx.ctrl.simMs); t.stop = true; }
          else if (!stop && t.stop) { t.since = cx.ctrl.simMs; t.stop = false; }
          return;
        }
        default: return;
      }
    }
    const meta = node.obj.t === 'id' ? varMeta(cx, K(node.obj.name)) : null;
    // CHAR 배열(문자열)의 한 글자
    if (typeof obj === 'string' && node.obj.t === 'id') {
      const s = obj.split('');
      while (s.length < idx[0]) s.push(' ');
      s[idx[0] - 1] = typeof value === 'number' ? String.fromCharCode(value) : String(value)[0] ?? ' ';
      assignK(cx, node.obj, s.join(''));
      return;
    }
    let arr = obj;
    for (let i = 0; i < idx.length; i++) {
      if (!Array.isArray(arr)) throw new RuntimeErr('TYPE', '배열이 아닌 변수에 인덱스 사용');
      if (idx[i] < 1 || idx[i] > arr.length) throw new RuntimeErr('INDEX', `배열 인덱스 범위 초과: ${idx[i]} (크기 ${arr.length})`);
      if (i === idx.length - 1) arr[idx[i] - 1] = coerceK(meta?.type, value, arr[idx[i] - 1], cx.prog);
      else arr = arr[idx[i] - 1];
    }
    return;
  }
  if (node.t === 'field') {
    const root = rootKey(node);
    if (root && varMeta(cx, root)?.konst) throw new RuntimeErr('CONST', `상수 '${root}' 에는 대입할 수 없습니다`);
    if (root === '$TOOL' || root === '$BASE') {
      const cur = clone(cx.ev({ t: 'id', name: root }));
      cur[K(node.name)] = Number(value);
      sysSet(cx, root, cur);
      return;
    }
    const obj = cx.ev(node.obj);
    if (!isStruct(obj)) throw new RuntimeErr('TYPE', '구조체가 아닌 변수의 성분 대입');
    const k = K(node.name);
    obj[k] = INT_FIELDS.has(k) && typeof value === 'number' ? Math.round(value) : clone(value);
    return;
  }
  throw new RuntimeErr('SYNTAX', '대입할 수 없는 식입니다');
}

// ------------------------------------------------------------------ 함수 / 서브프로그램
function runSync(vm, proc, locals, depth = 0) {
  if (depth > 200) throw new RuntimeErr('STACK', '호출 깊이 초과');
  const frame = { proc, pc: 0, locals };
  let guard = 0;
  while (frame.pc < proc.code.length) {
    if (++guard > 2e6) throw new RuntimeErr('LOOP', `${proc.name}: 무한 루프로 판단되어 중단`);
    const ins = proc.code[frame.pc];
    let r;
    // 함수 안에서 난 오류는 실제로 실패한 줄을 가리키도록 위치를 붙임 (가장 안쪽이 우선)
    try { r = ins.run(vm, frame); } catch (e) { if (e && typeof e === 'object' && e.line === undefined && !e.aborted) { e.file = ins.file ?? proc.file; e.line = ins.line; } throw e; }
    if (r && typeof r.then === 'function') throw new RuntimeErr('FUNC', `함수 ${proc.name} 안에서는 이동/대기 명령을 사용할 수 없습니다`);
    if (!r) frame.pc++;
    else if (r.goto !== undefined) frame.pc = r.goto;
    else if (r.call) { const v = runSync(vm, r.call.proc, r.call.locals || new Map(), depth + 1); r.call.onReturn?.(v); frame.pc++; }
    else if ('ret' in r) return r.ret;
    else if (r.halt) throw new RuntimeErr('FUNC', `함수 ${proc.name} 안에서 프로그램 종료`);
  }
  return undefined;
}

// 인자 바인딩 (:IN 값 전달, :OUT(기본) 참조 전달 → 복귀 시 되쓰기)
function bindArgs(cx, proc, argAsts, argVals) {
  if (argAsts.length > proc.rparams.length) throw new RuntimeErr('ARG', `${proc.name}: 인자가 너무 많습니다`);
  const locals = new Map();
  const back = [];
  proc.rparams.forEach((p, i) => {
    const ast = argAsts[i];
    if (!ast) { locals.set(p.key, defaultK(proc.ltypes.get(p.key)?.type, cx.prog)); return; }
    const v = argVals ? argVals[i] : cx.ev(ast);
    const t = proc.ltypes.get(p.key)?.type;
    locals.set(p.key, coerceK(t, clone(v), undefined, cx.prog));
    if (p.mode !== 'IN' && (ast.t === 'id' || ast.t === 'index' || ast.t === 'field')) back.push([ast, p.key]);
  });
  return { locals, writeBack: () => { for (const [ast, key] of back) assignK(cx, ast, locals.get(key)); } };
}

function callFunc(cx, name, args, node) {
  const u = K(name);
  const user = cx.prog.procs[u];
  if (user) {
    if (user.kind !== 'DEFFCT') throw new RuntimeErr('FUNC', `${user.name} 은 함수(DEFFCT)가 아닙니다`);
    const { locals, writeBack } = bindArgs(cx, user, node.args, args);
    const v = runSync(cx.vm, user, locals);
    writeBack();
    if (v === undefined) throw new RuntimeErr('FUNC', `함수 ${user.name} 이 값을 반환하지 않았습니다`);
    return v;
  }
  const f = FUNCS[u];
  if (f) return f(cx, args, node);
  throw new RuntimeErr('UNDEF', `알 수 없는 함수 '${name}'`);
}

const n_ = (v) => { if (typeof v === 'boolean') return v ? 1 : 0; if (typeof v !== 'number') throw new RuntimeErr('TYPE', '숫자가 필요합니다'); return v; };
const FUNCS = {
  ABS: (cx, [x]) => Math.abs(n_(x)),
  SQRT: (cx, [x]) => Math.sqrt(n_(x)),
  SIN: (cx, [x]) => Math.sin(n_(x) * DEG),
  COS: (cx, [x]) => Math.cos(n_(x) * DEG),
  TAN: (cx, [x]) => Math.tan(n_(x) * DEG),
  ASIN: (cx, [x]) => Math.asin(n_(x)) * RAD,
  ACOS: (cx, [x]) => Math.acos(n_(x)) * RAD,
  ATAN2: (cx, [y, x]) => Math.atan2(n_(y), n_(x)) * RAD,
  MAX: (cx, a) => Math.max(...a.map(n_)),
  MIN: (cx, a) => Math.min(...a.map(n_)),
  ROUND: (cx, [x]) => Math.round(n_(x)),
  TRUNC: (cx, [x]) => Math.trunc(n_(x)),
  STRLEN: (cx, [s]) => String(s).length,
  INV_POS: (cx, [f]) => { const o = poseToStruct(poseInv(frameToPose(f)), f?.$type === 'E6POS' || f?.$type === 'POS' ? f.$type : 'FRAME'); return o; },
  VARSTATE: (cx, [s]) => {
    const u = K(s);
    return cx.frame?.locals.has(u) || cx.prog.globals.has(u) ? '#INITIALIZED' : '#UNKNOWN';
  },
  MSGDIALOG: () => 1,
  GET_SIG_INF: () => 0,
};

// ------------------------------------------------------------------ 문장 컴파일
const LOOP_KINDS = new Set(['FOR', 'WHILE', 'REPEAT', 'LOOP']);
const parseE = (src) => {
  const p = new Parser(src, { ...OPTS });
  const e = p.expr();
  if (!p.eof()) throw new Error(`수식 뒤에 불필요한 토큰 '${p.peek().v}'`);
  return e;
};

// 최상위 '=' (대입) 토큰 위치
function splitAssign(s) {
  let toks;
  try { toks = tokenize(s); } catch { return null; }
  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k !== 'op') continue;
    if ('([{'.includes(t.v)) depth++;
    else if (')]}'.includes(t.v)) depth--;
    else if (t.v === '=' && depth === 0) return [s.slice(0, t.col), s.slice(t.col + 1)];
  }
  return null;
}

const DECL_HEAD = /^(?:GLOBAL\s+)?(?:DECL\s+)?(?:GLOBAL\s+)?(CONST\s+)?([A-Za-z_$][\w$]*)\s+([\s\S]+)$/i;

// DECL 파싱 → [{name, key, type, dims(AST[]), init(AST|null), konst}]
function parseDecl(prog, text) {
  const m = DECL_HEAD.exec(text.replace(/^DECL\s+GLOBAL\s+/i, 'GLOBAL DECL '));
  if (!m) throw new Error('DECL 형식 오류');
  const type = K(m[2]);
  const out = [];
  for (const part of splitTop(m[3], ',')) {
    const pm = /^\s*([A-Za-z_$][\w$]*)\s*(\[[^\]]*\])?\s*(?:=\s*([\s\S]*))?$/.exec(part);
    if (!pm) throw new Error(`DECL 형식 오류: ${part.trim()}`);
    out.push({
      name: pm[1], key: K(pm[1]), type,
      dims: pm[2] && pm[2].slice(1, -1).trim() ? splitTop(pm[2].slice(1, -1), ',').map((d) => parseE(d)) : null,
      init: pm[3] !== undefined && pm[3].trim() ? parseE(pm[3].trim()) : null,
      konst: !!m[1],
    });
  }
  return out;
}

function isDeclLine(prog, t) {
  if (/^(GLOBAL\s+)?DECL\b/i.test(t) || /^DECL\s+GLOBAL\b/i.test(t)) return true;
  const m = /^(?:CONST\s+)?([A-Za-z_]\w*)\s+([A-Za-z_$][\w$]*)\s*(\[|=|,|$)/.exec(t);
  if (!m) return false;
  const T = K(m[1]);
  return BUILTIN_TYPES.has(T) || !!prog.strucs[T] || !!prog.enums[T];
}

function compile(files, main, ctrl) {
  const prog = {
    lang: 'krl', entry: null, procs: {}, globals: new Map(), meta: new Map(), signals: new Map(),
    strucs: {}, enums: {}, state: newState(), warnings: [],   // warnings: 에뮬레이터가 실행하지 않는 문장 {file, line, msg}
    init(vm) {
      vm.krl = prog.state;
      vm.ctrl.toolOverride = null;
      vm.ctrl.base = null;
    },
  };
  predefine(prog, ctrl);
  const cctx = new Ctx(prog, ctrl, null, null);
  const names = [...files.keys()];
  const dats = names.filter((n) => /\.dat$/i.test(n)).sort((a, b) => (/^\$config/i.test(a) ? -1 : /^\$config/i.test(b) ? 1 : 0));
  const srcs = names.filter((n) => /\.(src|sub)$/i.test(n));
  if (!srcs.includes(main) && files.has(main) && !/\.dat$/i.test(main)) srcs.push(main);

  // 1) 데이터 리스트(.dat)
  for (const file of dats) {
    const lines = files.get(file).replace(/\r\n?/g, '\n').split('\n');
    lines.forEach((raw, i) => at(file, i + 1, () => datLine(prog, cctx, raw, file)));
  }
  // 2) 소스(.src): 루틴 분리
  const pending = [];
  for (const file of srcs) {
    const lines = files.get(file).replace(/\r\n?/g, '\n').split('\n').map((raw, i) => ({ text: prepLine(stripComment(raw, [';']).trim()), line: i + 1 }));
    let i = 0;
    let first = true;
    while (i < lines.length) {
      const { text: t, line } = lines[i];
      if (!t || t.startsWith('&')) { i++; continue; }
      const m = /^(?:GLOBAL\s+)?(DEF|DEFFCT)\s+(?:([A-Za-z_]\w*)\s+(?=[A-Za-z_]\w*\s*\())?([A-Za-z_]\w*)\s*\(([^)]*)\)\s*$/i.exec(t);
      if (m) {
        const kind = K(m[1]);
        const endRe = kind === 'DEF' ? /^END$/i : /^ENDFCT$/i;
        let j = i + 1;
        const body = [];
        while (j < lines.length && !endRe.test(lines[j].text)) { if (lines[j].text) body.push(lines[j]); j++; }
        if (j >= lines.length) throw new CompileError(`${kind === 'DEF' ? 'END' : 'ENDFCT'} 가 없습니다`, file, line);
        const key = K(m[3]);
        if (prog.procs[key]) throw new CompileError(`루틴 '${m[3]}' 이 중복 정의되었습니다`, file, line);
        const rparams = m[4].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
          const pm = /^([A-Za-z_]\w*)\s*(?::\s*(IN|OUT))?$/i.exec(s);
          if (!pm) throw new CompileError(`매개변수 형식 오류: ${s}`, file, line);
          return { name: pm[1], key: K(pm[1]), mode: pm[2] ? K(pm[2]) : 'OUT' };
        });
        const proc = { name: m[3], kind, rtype: m[2] ? K(m[2]) : null, params: [], rparams, file, line, code: [], labels: {}, ltypes: new Map() };
        prog.procs[key] = proc;
        if (first && file === main) prog.entry = key;
        first = false;
        proc.body = body;
        i = j + 1;
        continue;
      }
      if (/^DEFDAT\b/i.test(t)) { // .src 안의 DEFDAT (드묾)
        let j = i + 1;
        while (j < lines.length && !/^ENDDAT$/i.test(lines[j].text)) { const l = lines[j]; at(file, l.line, () => datLine(prog, cctx, l.text, file)); j++; }
        i = j + 1;
        continue;
      }
      if (isDeclLine(prog, t) || /^(EXT|EXTFCT|IMPORT|STRUC|ENUM|SIGNAL)\b/i.test(t)) { at(file, line, () => datLine(prog, cctx, t, file)); i++; continue; }
      throw new CompileError(`DEF 밖의 문장입니다: ${t.slice(0, 50)}`, file, line);
    }
  }
  for (const proc of Object.values(prog.procs)) compileBody(prog, proc, ctrl, pending);
  for (const p of pending) if (!prog.procs[p.key]) throw new CompileError(`정의되지 않은 서브프로그램 '${p.name}'`, p.file, p.line);
  if (!prog.entry) throw new CompileError('메인 파일에 DEF 가 없습니다', main, 1);
  return prog;
}

function predefine(prog, ctrl) {
  const g = prog.globals, m = prog.meta;
  const set = (name, type, v, dims = null) => { g.set(name, v); m.set(name, { name, type, dims }); };
  const home = ctrl?.robot?.home ?? [0, -90, 90, 0, 0, 0];
  set('TOOL_DATA', 'FRAME', Array(16).fill(null), [16]);
  set('BASE_DATA', 'FRAME', Array(32).fill(null), [32]);
  set('PDAT_ACT', 'PDAT', defaultK('PDAT'));
  set('LDAT_ACT', 'LDAT', defaultK('LDAT'));
  set('FDAT_ACT', 'FDAT', defaultK('FDAT'));
  set('PDEFAULT', 'PDAT', defaultK('PDAT'));
  set('LDEFAULT', 'LDAT', defaultK('LDAT'));
  set('FHOME', 'FDAT', { ...defaultK('FDAT'), TOOL_NO: 0 });
  set('XHOME', 'E6AXIS', e6axis(home));
  set('HOME', 'E6AXIS', e6axis(home));
}

// .dat 한 줄 (DECL, STRUC, ENUM, SIGNAL)
function datLine(prog, cctx, raw, file) {
  const t = prepLine(stripComment(raw, [';']).trim());
  if (!t || t.startsWith('&')) return;
  if (/^(DEFDAT|ENDDAT|EXT|EXTFCT|IMPORT)\b/i.test(t)) return;
  let m;
  if ((m = /^(?:GLOBAL\s+)?STRUC\s+([A-Za-z_]\w*)\s+([\s\S]+)$/i.exec(t))) {
    const fields = [];
    let curType = null;
    for (const part of splitTop(m[2], ',')) {
      const w = part.trim().split(/\s+/);
      if (w.length >= 2) { curType = K(w[0]); fields.push([K(w[1].replace(/\[.*$/, '')), curType]); } else fields.push([K(w[0]), curType]);
    }
    prog.strucs[K(m[1])] = fields;
    return;
  }
  if ((m = /^(?:GLOBAL\s+)?ENUM\s+([A-Za-z_]\w*)\s+([\s\S]+)$/i.exec(t))) {
    prog.enums[K(m[1])] = m[2].split(',').map((s) => '#' + K(s.trim()));
    return;
  }
  if ((m = /^(?:GLOBAL\s+)?SIGNAL\s+([A-Za-z_]\w*)\s+(\$(?:OUT|IN)\s*\[\s*(\d+)\s*\])(?:\s+TO\s+\$(?:OUT|IN)\s*\[\s*(\d+)\s*\])?$/i.exec(t))) {
    const type = /\$OUT/i.test(m[2]) ? 'do' : 'di';
    prog.signals.set(K(m[1]), m[4] ? { to: true, type, a: Number(m[3]), b: Number(m[4]) } : { from: parseE(m[2]) });
    return;
  }
  if (isDeclLine(prog, t)) {
    for (const d of parseDecl(prog, t)) {
      const dims = d.dims ? d.dims.map((x) => Math.round(cctx.ev(x))) : null;
      let v = makeArr(d.type, dims, prog);
      if (d.init) {
        if (dims?.length && !(dims.length === 1 && d.type === 'CHAR')) throw new Error('배열 선언에는 초기값을 줄 수 없습니다');
        v = coerceK(dims?.length ? 'CHAR' : d.type, cctx.ev(d.init), undefined, prog);
      }
      prog.globals.set(d.key, v);
      prog.meta.set(d.key, { name: d.name, type: d.type, dims, konst: d.konst, file });
    }
    return;
  }
  if (/^(INT|REAL|BOOL|CHAR)\b/i.test(t)) return;
  // .dat 안의 배열 요소 초기화: NAME[1]=값
  const sa = splitAssign(t);
  if (sa) { assignK(cctx, parseE(sa[0]), cctx.ev(parseE(sa[1]))); return; }
  throw new Error(`데이터 리스트에서 허용되지 않는 문장: ${t.slice(0, 50)}`);
}

// ------------------------------------------------------------------ 루틴 본문
function compileBody(prog, proc, ctrl, pending) {
  const file = proc.file;
  const code = proc.code;
  const stack = [];
  const gotos = [];
  let hid = 0;
  const emit = (line, run) => { const ins = { line, file, run }; code.push(ins); return ins; };
  const jumpIfNot = (line, cond) => { const ins = emit(line, (vm, f) => (truthy(cond(vm, f)) ? undefined : { goto: ins.target })); return ins; };
  const jumpIf = (line, cond) => { const ins = emit(line, (vm, f) => (truthy(cond(vm, f)) ? { goto: ins.target } : undefined)); return ins; };
  const jump = (line) => { const ins = emit(line, () => ({ goto: ins.target })); return ins; };
  const cx = (vm, f) => new Ctx(prog, vm.ctrl, vm, f);
  const evr = (ast) => (vm, f) => cx(vm, f).ev(ast);
  const top = (k) => { const s = stack[stack.length - 1]; if (!s || s.k !== k) throw new Error(`${k} 블록 밖에서 사용되었습니다`); return s; };
  const loopTop = () => { for (let i = stack.length - 1; i >= 0; i--) if (LOOP_KINDS.has(stack[i].k)) return stack[i]; throw new Error('EXIT 는 루프 안에서만 사용할 수 있습니다'); };
  const closeLoop = (s) => { for (const b of s.breaks) b.target = code.length; };

  function stmt(t, line) {
    let m;
    // 선독 트리거: TRIGGER WHEN DISTANCE=<0|1> DELAY=<ms> DO <대입|PULSE(...)>  /  TRIGGER WHEN PATH=<mm> [ONSTART] DELAY=<ms> DO ...
    if ((m = /^TRIGGER\s+WHEN\s+(DISTANCE|PATH)\s*=\s*([^\s]+)(?:\s+ONSTART)?(?:\s+DELAY\s*=\s*([^\s]+))?\s+DO\s+([\s\S]+)$/i.exec(t))) {
      const kind = K(m[1]);
      const valAst = parseE(m[2]);
      const onStart = /\bONSTART\b/i.test(t.slice(0, t.toUpperCase().indexOf(' DO ')));
      const delayAst = m[3] ? parseE(m[3]) : null;
      const actText = m[4].replace(/\s+PRIO\s*=\s*\S+\s*$/i, '').trim();
      const sa = splitAssign(actText);
      if (sa) {
        const lhs = parseE(sa[0]), rhs = parseE(sa[1]);
        emit(line, (vm, f) => {
          const c = cx(vm, f);
          const v = n_(c.ev(valAst));
          const delayMs = delayAst ? n_(c.ev(delayAst)) : 0;
          const mode = kind === 'DISTANCE' ? 'progress' : (v >= 0 && onStart ? 'distFromStart' : v < 0 ? 'distFromEnd' : 'distFromStart');
          const value = kind === 'DISTANCE' ? (v ? 1 : 0) : Math.abs(v);
          c.st.pendingTriggers.push({
            mode, value, delayMs,
            fn: () => { const tc = new Ctx(prog, vm.ctrl, vm, f); assignK(tc, lhs, tc.ev(rhs)); },
          });
        });
        return;
      }
      const actAst = parseE(actText);
      if (actAst.t === 'call' && K(actAst.fn.name) === 'PULSE' && INSTR.PULSE) {
        const runPulse = INSTR.PULSE(actAst, line);
        emit(line, (vm, f) => {
          const c = cx(vm, f);
          const v = n_(c.ev(valAst));
          const delayMs = delayAst ? n_(c.ev(delayAst)) : 0;
          const mode = kind === 'DISTANCE' ? 'progress' : (v < 0 ? 'distFromEnd' : 'distFromStart');
          const value = kind === 'DISTANCE' ? (v ? 1 : 0) : Math.abs(v);
          c.st.pendingTriggers.push({ mode, value, delayMs, fn: () => runPulse(vm, f) });
        });
        return;
      }
      prog.warnings.push({ file, line, msg: 'TRIGGER DO (미지원 동작)' });
      return;
    }
    if (/^(GLOBAL\s+)?INTERRUPT\b/i.test(t) || /^(TRIGGER|ANIN|ANOUT|BRAKE|RESUME|ON_ERROR_PROCEED|CONTINUE|EXT|EXTFCT|IMPORT|SIGNAL)\b/i.test(t)) {
      // 동작에 영향을 주는데 에뮬레이터가 실행하지 않는 문장은 경고 (표준 IR_STOPM 인터럽트 선언은 제외)
      if ((/^(GLOBAL\s+)?INTERRUPT\s+DECL\b/i.test(t) && !/\$STOPMESS/i.test(t)) || /^(TRIGGER|ANOUT)\b/i.test(t)) prog.warnings.push({ file, line, msg: t.split(/\s+/).slice(0, 2).join(' ') });
      return;
    }
    // 라벨
    if ((m = /^([A-Za-z_]\w*)\s*:$/.exec(t))) { proc.labels[K(m[1])] = code.length; return; }
    // 지역 선언
    if (isDeclLine(prog, t)) {
      for (const d of parseDecl(prog, t)) {
        proc.ltypes.set(d.key, { name: d.name, type: d.type, dims: null, konst: d.konst });
        if (proc.rparams.some((p) => p.key === d.key)) continue; // 매개변수 형 선언
        emit(line, (vm, f) => {
          const c = cx(vm, f);
          const dims = d.dims ? d.dims.map((x) => Math.round(c.ev(x))) : null;
          proc.ltypes.get(d.key).dims = dims;
          let v = makeArr(d.type, dims, prog);
          if (d.init) v = coerceK(dims?.length ? 'CHAR' : d.type, c.ev(d.init), undefined, prog);
          f.locals.set(d.key, v);
        });
      }
      return;
    }
    // IF / ELSE / ENDIF
    if (/^IF\b/i.test(t)) {
      const p = new Parser(t.slice(2), { ...OPTS });
      const cond = p.expr();
      p.expectKw('THEN');
      if (!p.eof()) throw new Error('THEN 뒤에 불필요한 토큰');
      stack.push({ k: 'IF', line, j: jumpIfNot(line, evr(cond)), ends: [] });
      return;
    }
    if (/^ELSE$/i.test(t)) {
      const s = top('IF');
      if (!s.j) throw new Error('ELSE 가 중복되었습니다');
      s.ends.push(jump(line)); s.j.target = code.length; s.j = null;
      return;
    }
    if (/^ENDIF$/i.test(t)) {
      const s = top('IF'); stack.pop();
      if (s.j) s.j.target = code.length;
      for (const e of s.ends) e.target = code.length;
      return;
    }
    // FOR
    if (/^FOR\b/i.test(t)) {
      const p = new Parser(t.slice(3), { ...OPTS });
      const vname = p.ident();
      const v = K(vname);
      p.expectOp('=');
      const a = p.expr();
      p.expectKw('TO');
      const b = p.expr();
      const stepA = p.acceptKw('STEP') ? p.expr() : null;
      if (!p.eof()) throw new Error('FOR 문 형식 오류');
      const id = hid++;
      const kE = `__FORE${id}`, kS = `__FORS${id}`;
      const vNode = { t: 'id', name: vname };
      emit(line, (vm, f) => {
        const c = cx(vm, f);
        const start = n_(c.ev(a));
        if (!f.locals.has(v) && !prog.globals.has(v)) { f.locals.set(v, 0); proc.ltypes.set(v, { type: 'INT' }); }
        assignK(c, vNode, start);
        f.locals.set(kE, n_(c.ev(b)));
        f.locals.set(kS, stepA ? n_(c.ev(stepA)) : 1);
      });
      const chkPc = code.length;
      const chk = emit(line, (vm, f) => {
        const x = cx(vm, f).ev(vNode), e = f.locals.get(kE), s = f.locals.get(kS);
        return (s >= 0 ? x > e : x < e) ? { goto: chk.target } : undefined;
      });
      stack.push({ k: 'FOR', line, chk, chkPc, vNode, kS, breaks: [] });
      return;
    }
    if (/^ENDFOR$/i.test(t)) {
      const s = top('FOR'); stack.pop();
      emit(line, (vm, f) => { const c = cx(vm, f); assignK(c, s.vNode, c.ev(s.vNode) + f.locals.get(s.kS)); return { goto: s.chkPc }; });
      s.chk.target = code.length;
      closeLoop(s);
      return;
    }
    // WHILE
    if (/^WHILE\b/i.test(t)) {
      const cond = parseE(t.slice(5));
      const topPc = code.length;
      stack.push({ k: 'WHILE', line, top: topPc, j: jumpIfNot(line, evr(cond)), breaks: [] });
      return;
    }
    if (/^ENDWHILE$/i.test(t)) {
      const s = top('WHILE'); stack.pop();
      jump(line).target = s.top;
      s.j.target = code.length;
      closeLoop(s);
      return;
    }
    // REPEAT / UNTIL
    if (/^REPEAT$/i.test(t)) { stack.push({ k: 'REPEAT', line, top: code.length, breaks: [] }); return; }
    if (/^UNTIL\b/i.test(t)) {
      const s = top('REPEAT'); stack.pop();
      const cond = parseE(t.slice(5));
      jumpIfNot(line, evr(cond)).target = s.top;
      closeLoop(s);
      return;
    }
    // LOOP / ENDLOOP
    if (/^LOOP$/i.test(t)) { stack.push({ k: 'LOOP', line, top: code.length, breaks: [] }); return; }
    if (/^ENDLOOP$/i.test(t)) {
      const s = top('LOOP'); stack.pop();
      jump(line).target = s.top;
      closeLoop(s);
      return;
    }
    if (/^EXIT$/i.test(t)) { loopTop().breaks.push(jump(line)); return; }
    // SWITCH / CASE / DEFAULT / ENDSWITCH
    if (/^SWITCH\b/i.test(t)) {
      const ast = parseE(t.slice(6));
      const key = `__SW${hid++}`;
      emit(line, (vm, f) => { f.locals.set(key, evr(ast)(vm, f)); });
      stack.push({ k: 'SWITCH', line, key, skip: null, ends: [], any: false });
      return;
    }
    if (/^CASE\b/i.test(t)) {
      const s = top('SWITCH');
      const vals = splitTop(t.slice(4), ',').map((x) => parseE(x));
      if (s.any) s.ends.push(jump(line));
      if (s.skip) s.skip.target = code.length;
      s.any = true;
      const ins = emit(line, (vm, f) => {
        const v = f.locals.get(s.key);
        const c = cx(vm, f);
        for (const a of vals) if (binop('=', v, c.ev(a))) return undefined;
        return { goto: ins.target };
      });
      s.skip = ins;
      return;
    }
    if (/^DEFAULT$/i.test(t)) {
      const s = top('SWITCH');
      if (s.any) s.ends.push(jump(line));
      if (s.skip) s.skip.target = code.length;
      s.skip = null; s.any = true;
      return;
    }
    if (/^ENDSWITCH$/i.test(t)) {
      const s = top('SWITCH'); stack.pop();
      if (s.skip) s.skip.target = code.length;
      for (const e of s.ends) e.target = code.length;
      return;
    }
    if ((m = /^GOTO\s+([A-Za-z_]\w*)$/i.exec(t))) { const ins = jump(line); gotos.push([ins, K(m[1]), line]); return; }
    if (/^RETURN\b/i.test(t)) {
      const rest = t.slice(6).trim();
      const ast = rest ? parseE(rest) : null;
      if (proc.kind === 'DEFFCT' && !ast) throw new Error('DEFFCT 의 RETURN 에는 반환값이 필요합니다');
      emit(line, (vm, f) => ({ ret: ast ? cx(vm, f).ev(ast) : undefined }));
      return;
    }
    if (/^HALT$/i.test(t)) { emit(line, (vm) => { vm.print('HALT: 프로그램 정지 (재시작 시 계속)'); vm.ctrl.hold(); }); return; }
    // WAIT
    if ((m = /^WAIT\s+SEC\s+([\s\S]+)$/i.exec(t))) {
      const ast = parseE(m[1]);
      emit(line, async (vm, f) => { await vm.wait(Math.max(0, n_(cx(vm, f).ev(ast)))); });
      return;
    }
    if ((m = /^WAIT\s+FOR\s+([\s\S]+)$/i.exec(t))) {
      const ast = parseE(m[1]);
      emit(line, async (vm, f) => { const c = cx(vm, f); await vm.waitUntil(() => truthy(c.ev(ast))); });
      return;
    }
    // 인라인 폼: PTP P1 [CONT] Vel=100 % PDAT1 Tool[1]:gripper Base[0]
    if ((m = /^(S?PTP|S?LIN|S?CIRC)\s+([\s\S]*?)\s*\bVel\s*=\s*([\d.]+)\s*(%|m\/s)\s*([A-Za-z_]\w*)?([\s\S]*)$/i.exec(t))) {
      inlineMotion(m, line);
      return;
    }
    // 이동 명령
    if ((m = /^(S?PTP_REL|S?LIN_REL|S?CIRC_REL|S?PTP|S?LIN|S?CIRC)\b\s*([\s\S]*)$/i.exec(t)) && !/^\s*[=(]/.test(m[2])) {
      motion(K(m[1]).replace(/^S(?=PTP|LIN|CIRC)/, ''), m[2], line);
      return;
    }
    // 대입
    const sa = splitAssign(t);
    if (sa) {
      const lhs = parseE(sa[0]);
      if (!['id', 'index', 'field'].includes(lhs.t)) throw new Error('대입문의 좌변이 변수가 아닙니다');
      const rhs = parseE(sa[1]);
      emit(line, (vm, f) => { const c = cx(vm, f); assignK(c, lhs, c.ev(rhs)); });
      return;
    }
    // 서브프로그램/내장 명령 호출
    const ast = parseE(t);
    if (ast.t === 'call') {
      const name = ast.fn.name;
      const U = K(name);
      const bi = INSTR[U];
      if (bi) { const run = bi(ast, line); if (run) emit(line, run); return; }
      pending.push({ key: U, name, file, line });
      emit(line, (vm, f) => {
        const target = prog.procs[U];
        const c = cx(vm, f);
        const { locals, writeBack } = bindArgs(c, target, ast.args);
        return { call: { proc: target, args: [], locals, onReturn: () => writeBack() } };
      });
      return;
    }
    if (ast.t === 'id' && INSTR[K(ast.name)]) { const run = INSTR[K(ast.name)]({ args: [] }, line); if (run) emit(line, run); return; }
    throw new Error(`알 수 없는 문장: ${t.slice(0, 50)}`);
  }

  // ---- 이동 명령 (일반형)
  function motion(kind, rest, line) {
    // 근사(블렌딩) 플래그: C_PTP/C_DIS/C_VEL/C_ORI → $APO.CDIS(mm) 또는 $APO.CPTP 사용
    const approx = /\sC_(PTP|DIS|VEL|ORI|SPL)\b/i.test(rest);
    const zoneOf = (c) => (approx ? Math.max(Number(n_(c.st.apo.CDIS)) || 0, Number(n_(c.st.apo.CPTP)) || 0) : 0);
    rest = rest.replace(/\s+WITH\s+[\s\S]*$/i, '').replace(/(\s+C_(PTP|DIS|VEL|ORI|SPL))+\s*$/i, '').trim();
    let relFrame = 'BASE';
    if (kind.endsWith('_REL')) {
      const fm = /\s+#(BASE|TOOL)\s*$/i.exec(rest);
      if (fm) { relFrame = K(fm[1]); rest = rest.slice(0, fm.index).trim(); }
    }
    const parts = splitTop(rest, ',').map((s) => s.trim());
    if (kind === 'CIRC' || kind === 'CIRC_REL') {
      if (parts.length < 2) throw new Error('CIRC 보조점, 목표점이 필요합니다');
      const aux = parseE(parts[0]), tgt = parseE(parts[1]);
      let ca = null;
      if (parts[2]) {
        const cm = /^CA\s+([\s\S]+)$/i.exec(parts[2]);
        if (!cm) throw new Error(`CIRC 인자 형식 오류: ${parts[2]}`);
        ca = parseE(cm[1]);
      }
      emit(line, async (vm, f) => {
        const c = cx(vm, f);
        let auxV = c.ev(aux), tgtV = c.ev(tgt);
        if (kind === 'CIRC_REL') { auxV = relTarget(c, auxV, 'BASE'); tgtV = relTarget(c, tgtV, 'BASE'); }
        await doCirc(c, auxV, tgtV, ca ? n_(c.ev(ca)) : null, zoneOf(c));
      });
      return;
    }
    if (parts.length !== 1 || !parts[0]) throw new Error(`${kind} 목표점 형식 오류`);
    const tgt = parseE(parts[0]);
    const base = kind.replace('_REL', '');
    emit(line, async (vm, f) => {
      const c = cx(vm, f);
      let v = c.ev(tgt);
      if (kind.endsWith('_REL')) v = relTarget(c, v, relFrame);
      await doMove(c, base, v, zoneOf(c));
    });
  }

  // ---- 인라인 폼 (KSS ILF)
  function inlineMotion(m, line) {
    const kind = K(m[1]).replace(/^S/, '');
    const pts = m[2].split(/\s+/).filter((s) => s && !/^CONT$/i.test(s));
    const cont = /(^|\s)CONT(\s|$)/i.test(m[2]); // 인라인 폼 CONT → PDAT/LDAT 의 APO_DIST(mm) 로 근사
    const vel = Number(m[3]);
    const unit = m[4];
    const dat = m[5] ? K(m[5]) : null;
    const rest = m[6] || '';
    const tm = /Tool\s*\[\s*(\d+)\s*\]/i.exec(rest);
    const bm = /Base\s*\[\s*(\d+)\s*\]/i.exec(rest);
    const need = kind === 'CIRC' ? 2 : 1;
    if (pts.length !== need) throw new Error(`인라인 ${kind} 의 점 이름 형식 오류`);
    if ((kind === 'PTP') !== (unit === '%')) throw new Error(`${kind} 의 속도 단위가 맞지 않습니다 (${unit})`);
    const ptKey = (p) => (prog.globals.has('X' + K(p)) ? 'X' + K(p) : K(p));
    const keys = pts.map(ptKey);
    for (const k of keys) if (!prog.globals.has(k)) throw new Error(`점 데이터 '${k}' 가 데이터 리스트(.dat)에 없습니다`);
    emit(line, async (vm, f) => {
      const c = cx(vm, f);
      const g = prog.globals;
      if (kind === 'PTP') {
        c.st.velAxis.fill(vel);
        if (dat && g.has('P' + dat)) g.set('PDAT_ACT', clone(g.get('P' + dat)));
      } else {
        c.st.vel.CP = vel;
        if (dat && g.has('L' + dat)) g.set('LDAT_ACT', clone(g.get('L' + dat)));
      }
      const fd = g.get('F' + K(pts[pts.length - 1]));
      if (fd) g.set('FDAT_ACT', clone(fd));
      if (tm) selectTool(c, Number(tm[1])); else if (fd?.TOOL_NO !== undefined) selectTool(c, fd.TOOL_NO);
      if (bm) selectBase(c, Number(bm[1])); else if (fd?.BASE_NO !== undefined) selectBase(c, fd.BASE_NO);
      const zone = cont ? Number(n_(g.get(kind === 'PTP' ? 'PDAT_ACT' : 'LDAT_ACT')?.APO_DIST ?? 0)) || 0 : 0;
      if (kind === 'CIRC') await doCirc(c, g.get(keys[0]), g.get(keys[1]), null, zone);
      else await doMove(c, kind, g.get(keys[0]), zone);
    });
  }

  for (const l of proc.body) at(file, l.line, () => stmt(l.text, l.line));
  delete proc.body;
  if (stack.length) throw new CompileError(`${stack[stack.length - 1].k} 블록이 닫히지 않았습니다`, file, stack[stack.length - 1].line ?? code.at(-1)?.line ?? proc.line);   // 여는 줄을 가리킴
  for (const [ins, lbl, line] of gotos) {
    if (proc.labels[lbl] === undefined) throw new CompileError(`라벨 '${lbl}' 이 없습니다`, file, line);
    ins.target = proc.labels[lbl];
  }
}

// ------------------------------------------------------------------ 이동 실행
function ptpSpeed(c) { return { frac: Math.max(0.001, Math.min(1, Math.min(...c.st.velAxis) / 100)) }; }
function cpSpeed(c) { return { tcp: Math.max(0.1, n_(c.st.vel.CP) * 1000), rot: Math.max(1, n_(c.st.vel.ORI1)) }; }
function ptpAccel(c) { return Math.max(5, Math.min(100, Math.min(...c.st.accAxis))); }
function cpAccel(c) { return Math.max(5, Math.min(100, (n_(c.st.acc.CP) / 2.3) * 100)); }

// 목표 값 → 컨트롤러 목표 (부분 구조체는 현재 위치로 채움)
function toTarget(c, v, kind) {
  if (!isStruct(v)) throw new RuntimeErr('TYPE', '이동 목표는 POS/E6POS/FRAME/AXIS/E6AXIS 여야 합니다');
  const ctrl = c.ctrl;
  if (isAxisVal(v)) return { joints: ctrl.joints.map((cur, i) => Number(v[`A${i + 1}`] ?? cur)) };
  const cur = e6pos(ctrl);
  const g = (k) => Number(v[k] ?? cur[k]);
  const tg = { pose: fromVendorPose('kuka', [g('X'), g('Y'), g('Z'), g('A'), g('B'), g('C')]) };
  if (kind === 'PTP' && (v.S !== undefined || v.T !== undefined)) tg.cfgFilter = stFilter(ctrl.robot, v.S, v.T);
  else if (kind !== 'PTP' && v.S !== undefined) tg.cfgFilter = stFilter(ctrl.robot, v.S, undefined);
  return tg;
}

function relTarget(c, v, frame) {
  if (!isStruct(v)) throw new RuntimeErr('TYPE', '상대 이동 값은 구조체여야 합니다');
  const ctrl = c.ctrl;
  if (isAxisVal(v)) {
    const o = { $type: 'E6AXIS' };
    ctrl.joints.forEach((cur, i) => { o[`A${i + 1}`] = cur + Number(v[`A${i + 1}`] ?? 0); });
    return o;
  }
  const curP = ctrl.tcpPose();
  const rel = frameToPose(v);
  const P = frame === 'TOOL' ? poseMul(curP, rel) : { p: add(curP.p, rel.p), R: mul3(rel.R, curP.R) };
  return poseToStruct(P, 'FRAME');
}

async function doMove(c, kind, v, zone = 0) {
  const target = toTarget(c, v, kind);
  const triggers = c.st.pendingTriggers?.length ? c.st.pendingTriggers.splice(0) : undefined;
  if (kind === 'PTP') await c.vm.move({ kind: 'J', target, speed: ptpSpeed(c), zone, accelScale: ptpAccel(c), triggers });
  else await c.vm.move({ kind: 'L', target, speed: cpSpeed(c), zone, accelScale: cpAccel(c), triggers });
}

async function doCirc(c, auxV, tgtV, ca, zone = 0) {
  const aux = toTarget(c, auxV, 'CIRC'), tgt = toTarget(c, tgtV, 'CIRC');
  if (!aux.pose || !tgt.pose) throw new RuntimeErr('TYPE', 'CIRC 의 보조점/목표점은 직교 좌표(POS/FRAME)여야 합니다');
  let via = aux, end = tgt;
  if (ca !== null && ca !== undefined) {
    if (!(Math.abs(ca) > 0.01 && Math.abs(ca) < 360)) throw new RuntimeErr('CIRC', `CA 각도 범위 오류: ${ca}`);
    const start = c.ctrl.tcpPose().p;
    const pEnd = circlePoint(start, aux.pose.p, tgt.pose.p, ca);
    const pVia = circlePoint(start, aux.pose.p, tgt.pose.p, ca / 2);
    via = { pose: { p: pVia, R: tgt.pose.R } };
    end = { pose: { p: pEnd, R: tgt.pose.R } };
  }
  const triggers = c.st.pendingTriggers?.length ? c.st.pendingTriggers.splice(0) : undefined;
  await c.vm.move({ kind: 'C', via, target: end, speed: cpSpeed(c), zone, accelScale: cpAccel(c), triggers });
}

// ------------------------------------------------------------------ 내장 명령 (문장 호출)
const MSG = (prefix) => (ast) => (vm, f) => {
  const c = new Ctx(vm.prog, vm.ctrl, vm, f);
  const args = ast.args.map((a) => c.ev(a));
  vm.print(`${prefix}${args.filter((x) => typeof x === 'string' && !x.startsWith('#')).join(' ')}`);
};
const INSTR = {
  BAS: (ast) => (vm, f) => {
    const c = new Ctx(vm.prog, vm.ctrl, vm, f);
    const [cmd, val] = ast.args.map((a) => c.ev(a));
    const v = Number(val ?? 0);
    const g = c.prog.globals;
    switch (K(cmd)) {
      case '#INITMOV':
        c.st.velAxis.fill(100); c.st.accAxis.fill(100);
        Object.assign(c.st.vel, { CP: 2, ORI1: 200, ORI2: 200 });
        Object.assign(c.st.acc, { CP: 2.3, ORI1: 300, ORI2: 300 });
        break;
      case '#VEL_PTP': c.st.velAxis.fill(v); break;
      case '#VEL_CP': c.st.vel.CP = v; break;
      case '#ACC_PTP': c.st.accAxis.fill(Math.max(1, Math.min(100, v))); break;
      case '#ACC_CP': c.st.acc.CP = 2.3 * Math.max(1, Math.min(100, v)) / 100; break;
      case '#TOOL': selectTool(c, v); break;
      case '#BASE': selectBase(c, v); break;
      case '#FRAMES': { const fd = g.get('FDAT_ACT'); selectTool(c, fd?.TOOL_NO ?? 1); selectBase(c, fd?.BASE_NO ?? 0); break; }
      case '#PTP_PARAMS': {
        c.st.velAxis.fill(v);
        const fd = g.get('FDAT_ACT'); selectTool(c, fd?.TOOL_NO ?? 1); selectBase(c, fd?.BASE_NO ?? 0);
        break;
      }
      case '#CP_PARAMS': {
        c.st.vel.CP = v;
        const fd = g.get('FDAT_ACT'); selectTool(c, fd?.TOOL_NO ?? 1); selectBase(c, fd?.BASE_NO ?? 0);
        break;
      }
      default: break;
    }
  },
  PULSE: (ast) => (vm, f) => {
    const c = new Ctx(vm.prog, vm.ctrl, vm, f);
    const [sigAst, stAst, tAst] = ast.args;
    const state = truthy(c.ev(stAst));
    const dur = Math.max(0, n_(c.ev(tAst ?? { t: 'num', v: 0.1 })));
    const before = c.ev(sigAst);
    assignK(c, sigAst, state);
    const ctrl = vm.ctrl;
    ctrl.after(dur, () => assignK(new Ctx(c.prog, ctrl, vm, f), sigAst, typeof before === 'boolean' ? before : !state));
  },
  MSGNOTIFY: MSG('[MSG] '), MSGQUIT: MSG('[QUIT] '), MSGSTATE: MSG('[STATE] '), MSGDIALOG: MSG('[DIALOG] '),
  MSGLOOP: MSG('[MSG] '), MSG_NOTIFY: MSG('[MSG] '),
  IR_STOPM: () => null, SET_CD_PARAMS: () => null, USER_GRP: () => null, USERSPOT: () => null, P00: () => null,
  H50: () => null, CHECK_HOME: () => null, ON_ERROR_PROCEED: () => null, ERR_RAISE: () => null,
};

// ------------------------------------------------------------------ 통신용 변수 접근 (KukaVarProxy 형식)
function varCtx(ctrl) {
  let prog = ctrl.program;
  if (!prog || prog.lang !== 'krl') {
    prog = { lang: 'krl', procs: {}, globals: new Map(), meta: new Map(), signals: new Map(), strucs: {}, enums: {}, state: ctrl._krlState ||= newState() };
  }
  return new Ctx(prog, ctrl, ctrl.vm ?? null, null);
}

function readVar(ctrl, name) {
  try {
    const c = varCtx(ctrl);
    const ast = parseE(prepLine(String(name).trim()));
    const v = c.ev(ast);
    if (v?.$proxy) return undefined;
    let type = ast.t === 'id' ? c.prog.meta.get(K(ast.name))?.type : undefined;
    if (ast.t === 'field' && typeof v === 'number') {
      const parent = c.ev(ast.obj);
      if (INT_FIELDS.has(K(ast.name))) type = 'INT';
      else if (FIELDS[parent?.$type] || NUM_FIELDS.has(K(ast.name))) type = 'REAL';
    }
    return formatValue(v, type);
  } catch { return undefined; }
}

function writeVar(ctrl, name, value) {
  try {
    const c = varCtx(ctrl);
    const ast = parseE(prepLine(String(name).trim()));
    if (!['id', 'index', 'field'].includes(ast.t)) return false;
    const v = typeof value === 'string' ? parseValue(value) : value;
    assignK(c, ast, v);
    return true;
  } catch { return false; }
}

// ------------------------------------------------------------------ 예제 프로그램
const r1 = (v) => { const r = Math.round(v * 1000) / 1000; return fmtReal(Object.is(r, -0) ? 0 : r); };

function defaultFiles(ctrl) {
  const r = ctrl.robot;
  const g = ctrl.gripper ?? { tcp: [0, 0, 150, 0, 0, 0], name: 'Gripper', maker: '' };
  const tool = frameFromXYZRPY(g.tcp);
  const down = [[-1, 0, 0], [0, 1, 0], [0, 0, -1]];
  const R = r.reach;
  const APP = 100;
  let ref = [...r.home];
  const solve = (p) => {
    const j = ikNearest(r, tcpToFlange({ p, R: down }, tool, null), ref);
    if (j) ref = j;
    return j;
  };
  const points = []; // {name, p, j}
  const addPt = (p, j) => { const name = `P${points.length + 1}`; points.push({ name, p, j }); return name; };
  const seq = []; // 이동/동작 순서
  const dxs = [0.17, -0.15, 0.25, -0.2, 0];
  ctrl.objects.forEach((o, idx) => {
    const save0 = ref;
    const pp = [...o.pose.p];
    const pa = [pp[0], pp[1], pp[2] + APP];
    const ja = solve(pa), jp = ja && solve(pp);
    let place = null;
    if (jp) {
      for (const dx of dxs) {
        const save = ref;
        const q = [pp[0] + dx * R, pp[1], pp[2]];
        const qa = [q[0], q[1], q[2] + APP];
        const a = solve(qa), b = a && solve(q);
        if (a && b) { place = [[qa, a], [q, b]]; break; }
        ref = save;
      }
    }
    // 도달 불가 공작물은 예제에서 제외 (주석으로 표시)
    if (!place) { ref = save0; seq.push({ c: `; ---- 공작물 ${o.id}: 도달 불가로 제외 ----` }); return; }
    const nA = addPt(pa, ja), nP = addPt(pp, jp);
    place = [addPt(...place[0]), addPt(...place[1])];
    seq.push({ c: `; ---- 공작물 ${o.id} (${idx + 1}/${ctrl.objects.length}) ----` });
    seq.push({ m: 'PTP', pt: nA, vel: 100 });
    seq.push({ m: 'LIN', pt: nP, vel: 0.3 });
    seq.push({ call: 'GripClose()' });
    seq.push({ m: 'LIN', pt: nA, vel: 0.5 });
    seq.push({ m: 'PTP', pt: place[0], vel: 100 });
    seq.push({ m: 'LIN', pt: place[1], vel: 0.3 });
    seq.push({ call: 'GripOpen()' });
    seq.push({ m: 'LIN', pt: place[0], vel: 0.5 });
    seq.push({ call: 'nPart = nPart + 1' });
  });

  let pdat = 0, ldat = 0;
  const datDecl = [];
  const body = [];
  for (const s of seq) {
    if (s.c) { body.push('', s.c); continue; }
    if (s.call) { body.push(s.call); continue; }
    const { m, pt, vel } = s;
    if (m === 'PTP') {
      const d = `PDAT${++pdat}`;
      datDecl.push(`DECL PDAT P${d}={VEL ${vel}.000,ACC 100.000,APO_DIST 100.000,APO_MODE #CDIS,GEAR_JERK 50.0000,EXAX_IGN 0}`);
      body.push(`;FOLD PTP ${pt} Vel=${vel} % ${d} Tool[1]:gripper Base[0];%{PE}%R 8.3.48,%MKUKATPBASIS,%CMOVE,%VPTP,%P 1:PTP, 2:${pt}, 3:, 5:${vel}, 7:${d}`,
        '$BWDSTART=FALSE', `PDAT_ACT=P${d}`, `FDAT_ACT=F${pt}`, `BAS(#PTP_PARAMS,${vel})`, `PTP X${pt}`, ';ENDFOLD');
    } else {
      const d = `CPDAT${++ldat}`;
      datDecl.push(`DECL LDAT L${d}={VEL ${vel},ACC 100.000,APO_DIST 100.000,APO_FAC 50.0000,AXIS_VEL 100.000,AXIS_ACC 100.000,ORI_TYP #VAR,CIRC_TYP #BASE,JERK_FAC 50.0000,GEAR_JERK 50.0000,EXAX_IGN 0}`);
      body.push(`;FOLD LIN ${pt} Vel=${vel} m/s ${d} Tool[1]:gripper Base[0];%{PE}%R 8.3.48,%MKUKATPBASIS,%CMOVE,%VLIN,%P 1:LIN, 2:${pt}, 3:, 5:${vel}, 7:${d}`,
        '$BWDSTART=FALSE', `LDAT_ACT=L${d}`, `FDAT_ACT=F${pt}`, `BAS(#CP_PARAMS,${vel})`, `LIN X${pt}`, ';ENDFOLD');
    }
  }
  const homeFold = [
    ';FOLD PTP HOME  Vel= 100 % DEFAULT;%{PE}%MKUKATPBASIS,%CMOVE,%VPTP,%P 1:PTP, 2:HOME, 3:, 5:100, 7:DEFAULT',
    '$BWDSTART = FALSE', 'PDAT_ACT=PDEFAULT', 'FDAT_ACT=FHOME', 'BAS (#PTP_PARAMS,100 )', '$H_POS=XHOME', 'PTP  XHOME', ';ENDFOLD',
  ];
  const ind = (arr) => arr.map((l) => (l ? '  ' + l : l));
  const src = [
    '&ACCESS RVP',
    '&REL 1',
    '&PARAM EDITMASK = *',
    '&PARAM TEMPLATE = C:\\KRC\\Roboter\\Template\\vorgabe',
    '&PARAM DISKPATH = KRC:\\R1\\Program',
    'DEF pick_place( )',
    `; ${r.name} 픽 앤 플레이스 예제 (RobotEmulator 자동 생성)`,
    `; 그리퍼: ${g.maker} ${g.name}`,
    '; $OUT[1]=그리퍼 닫기, $OUT[2]=그리퍼 열기, $IN[1]=닫힘 확인, $IN[2]=열림 확인',
    ...ind([
      ';FOLD INI;%{PE}',
      '  ;FOLD BASISTECH INI',
      '    GLOBAL INTERRUPT DECL 3 WHEN $STOPMESS==TRUE DO IR_STOPM ( )',
      '    INTERRUPT ON 3 ',
      '    BAS (#INITMOV,0 )',
      '  ;ENDFOLD (BASISTECH INI)',
      '  ;FOLD USER INI',
      '    ;Make your modifications here',
      '    nPart = 0',
      '  ;ENDFOLD (USER INI)',
      ';ENDFOLD (INI)',
      '',
      ...homeFold,
      'GripOpen()',
      ...body,
      '',
      ...homeFold,
      'MsgNotify("픽 앤 플레이스 완료")',
    ]),
    'END',
    '',
    'DEF GripClose( )',
    ...ind([
      ';FOLD OUT 2 \'Gripper open\' State=FALSE ;%{PE}%R 8.3.48,%MKUKATPBASIS,%COUT,%VOUTX,%P 2:2, 3:Gripper open, 5:FALSE, 6:',
      '$OUT[2]=FALSE',
      ';ENDFOLD',
      ';FOLD OUT 1 \'Gripper close\' State=TRUE ;%{PE}%R 8.3.48,%MKUKATPBASIS,%COUT,%VOUTX,%P 2:1, 3:Gripper close, 5:TRUE, 6:',
      '$OUT[1]=TRUE',
      ';ENDFOLD',
      ';FOLD WAIT FOR IN 1 \'Gripper closed\' ;%{PE}%R 8.3.48,%MKUKATPBASIS,%CEXT_WAIT_FOR,%VEXT_WAIT_FOR,%P 2:, 4:, 5:$IN, 6:1, 7:Gripper closed, 9:',
      'WAIT FOR  ( $IN[1] )',
      ';ENDFOLD',
      ';FOLD WAIT Time=0.2 sec;%{PE}%R 8.3.48,%MKUKATPBASIS,%CWAIT,%VWAIT,%P 2:0.2',
      'WAIT SEC 0.2',
      ';ENDFOLD',
    ]),
    'END',
    '',
    'DEF GripOpen( )',
    ...ind([
      ';FOLD OUT 1 \'Gripper close\' State=FALSE ;%{PE}%R 8.3.48,%MKUKATPBASIS,%COUT,%VOUTX,%P 2:1, 3:Gripper close, 5:FALSE, 6:',
      '$OUT[1]=FALSE',
      ';ENDFOLD',
      ';FOLD OUT 2 \'Gripper open\' State=TRUE ;%{PE}%R 8.3.48,%MKUKATPBASIS,%COUT,%VOUTX,%P 2:2, 3:Gripper open, 5:TRUE, 6:',
      '$OUT[2]=TRUE',
      ';ENDFOLD',
      ';FOLD WAIT FOR IN 2 \'Gripper opened\' ;%{PE}%R 8.3.48,%MKUKATPBASIS,%CEXT_WAIT_FOR,%VEXT_WAIT_FOR,%P 2:, 4:, 5:$IN, 6:2, 7:Gripper opened, 9:',
      'WAIT FOR  ( $IN[2] )',
      ';ENDFOLD',
      '$OUT[2]=FALSE',
      'WAIT SEC 0.2',
    ]),
    'END',
    '',
  ].join('\n');

  const e6 = (p, j) => {
    const { S, T } = statusTurn(r, j);
    return `{X ${r1(p[0])},Y ${r1(p[1])},Z ${r1(p[2])},A 180.000,B 0.0,C 180.000,S ${S},T ${T},E1 0.0,E2 0.0,E3 0.0,E4 0.0,E5 0.0,E6 0.0}`;
  };
  const dat = [
    '&ACCESS RVP',
    '&REL 1',
    '&PARAM EDITMASK = *',
    '&PARAM TEMPLATE = C:\\KRC\\Roboter\\Template\\vorgabe',
    '&PARAM DISKPATH = KRC:\\R1\\Program',
    'DEFDAT  pick_place',
    ';FOLD EXTERNAL DECLARATIONS;%{PE}%MKUKATPBASIS,%CEXT,%VCOMMON,%P',
    ';FOLD BASISTECH EXT;%{PE}%MKUKATPBASIS,%CEXT,%VEXT,%P',
    'EXT  BAS (BAS_COMMAND  :IN,REAL  :IN )',
    'DECL INT SUCCESS',
    ';ENDFOLD (BASISTECH EXT)',
    ';FOLD USER EXT;%{E}%MKUKATPUSER,%CEXT,%VEXT,%P',
    ';Make your modifications here',
    'DECL INT nPart=0',
    ';ENDFOLD (USER EXT)',
    ';ENDFOLD (EXTERNAL DECLARATIONS)',
    ...points.flatMap(({ name, p, j }) => [
      `DECL E6POS X${name}=${e6(p, j)}`,
      `DECL FDAT F${name}={TOOL_NO 1,BASE_NO 0,IPO_FRAME #BASE,POINT2[] " "}`,
    ]),
    ...datDecl,
    'ENDDAT',
    '',
  ].join('\n');
  return { 'pick_place.src': src, 'pick_place.dat': dat };
}

function pickMain(names, files) {
  const srcs = names.filter((n) => /\.src$/i.test(n));
  if (!srcs.length) return names.find((n) => !/\.dat$/i.test(n)) ?? null;
  const info = srcs.map((n) => {
    const txt = files?.get?.(n) ?? '';
    const m = /^\s*(?:GLOBAL\s+)?DEF\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/im.exec(txt);
    const base = n.replace(/^.*[\\/]/, '').replace(/\.src$/i, '');
    return { n, name: m?.[1] ?? '', params: (m?.[2] ?? '').trim(), base };
  });
  // 다른 .src 에서 호출되는 루틴은 서브프로그램으로 간주
  const called = (nm) => srcs.some((o) => o !== nm.n && new RegExp(`\\b${nm.name}\\s*\\(`, 'i').test((files?.get?.(o) ?? '').replace(/^\s*(?:GLOBAL\s+)?DEF\s+.*$/gim, '')));
  const cand = info.filter((i) => i.name && K(i.name) === K(i.base) && !i.params && !/^\$/.test(i.base));
  return (cand.find((i) => !called(i)) ?? cand[0] ?? info[0]).n;
}

export default {
  id: 'krl', name: 'KUKA KRL', exts: ['.src', '.dat', '.sub'],
  compile, pickMain, defaultFiles, readVar, writeVar,
  formatValue, parseValue,
};
