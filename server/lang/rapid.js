// ABB RAPID 인터프리터 (.mod / .modx / .prg / .sys, 다중 모듈)
// - MODULE/ENDMODULE, CONST/PERS/VAR 데이터 선언(배열 포함), RECORD
// - PROC/FUNC/TRAP, 지역 변수, 선택 인자(\Name), INOUT 인자
// - 이동: MoveJ/MoveL/MoveC/MoveAbsJ/MoveJDO/MoveLDO/MoveCDO
// - IO/대기/제어 흐름/주요 내장 함수
import { Parser, evaluate, binop, truthy, tokenize } from './expr.js';
import { CompileError, at, RuntimeErr, K, stripComment, splitTop } from './common.js';
import { quatFromR, RfromQuat, poseMul, poseInv, mul3, Rx, Ry, Rz, DEG, RAD, RfromZYX, ZYXfromR, add, sub, cross, norm, scale, mulv, I3 } from '../../shared/math.js';
import { frameFromXYZRPY } from '../../shared/poseformat.js';
import { ikNearest, tcpToFlange, fkTcp } from '../../shared/kinematics.js';

const EXTS = ['.mod', '.modx', '.prg', '.sys', '.sysx'];
const NINE = 9e9;

// ------------------------------------------------------------------ 데이터 타입
const N = 'num';
const SCHEMA = {
  pos: [['x', N], ['y', N], ['z', N]],
  orient: [['q1', N], ['q2', N], ['q3', N], ['q4', N]],
  confdata: [['cf1', N], ['cf4', N], ['cf6', N], ['cfx', N]],
  extjoint: [['eax_a', N], ['eax_b', N], ['eax_c', N], ['eax_d', N], ['eax_e', N], ['eax_f', N]],
  robjoint: [['rax_1', N], ['rax_2', N], ['rax_3', N], ['rax_4', N], ['rax_5', N], ['rax_6', N]],
  pose: [['trans', 'pos'], ['rot', 'orient']],
  robtarget: [['trans', 'pos'], ['rot', 'orient'], ['robconf', 'confdata'], ['extax', 'extjoint']],
  jointtarget: [['robax', 'robjoint'], ['extax', 'extjoint']],
  loaddata: [['mass', N], ['cog', 'pos'], ['aom', 'orient'], ['ix', N], ['iy', N], ['iz', N]],
  tooldata: [['robhold', 'bool'], ['tframe', 'pose'], ['tload', 'loaddata']],
  wobjdata: [['robhold', 'bool'], ['ufprog', 'bool'], ['ufmec', 'string'], ['uframe', 'pose'], ['oframe', 'pose']],
  speeddata: [['v_tcp', N], ['v_ori', N], ['v_leax', N], ['v_reax', N]],
  zonedata: [['finep', 'bool'], ['pzone_tcp', N], ['pzone_ori', N], ['pzone_eax', N], ['zone_ori', N], ['zone_leax', N], ['zone_reax', N]],
  clock: [['acc', N], ['start', N], ['running', 'bool']],
};
const NUMLIKE = new Set(['num', 'dnum', 'signaldi', 'signaldo', 'signalgi', 'signalgo', 'signalai', 'signalao', 'intnum', 'errnum', 'byte', 'triggdata', 'identno', 'iodev', 'errdomain', 'errtype', 'opnum', 'symnum']);

// 신호 이름 (선언되지 않은 식별자 → 신호로 간주)
class Sig { constructor(name) { this.name = name; } }

// 사용자 RECORD 는 컴파일 시 SCHEMA 사본에 등록
function typeKey(t) { return String(t).toLowerCase(); }

function defaultOf(type, schema) {
  const t = typeKey(type);
  if (t === 'bool') return false;
  if (t === 'string') return '';
  if (t === 'orient') return { $type: 'orient', q1: 1, q2: 0, q3: 0, q4: 0 };
  const sc = schema[t];
  if (sc) {
    const o = { $type: t };
    for (const [f, ft] of sc) o[f] = defaultOf(ft, schema);
    return o;
  }
  return 0;
}

// 값 → 선언 타입으로 변환 (집합체 [a,b,c] → 레코드)
function coerce(type, v, schema, what = '') {
  const t = typeKey(type);
  if (v instanceof Sig) throw new RuntimeErr('ERR_UNDEF', `정의되지 않은 이름 '${v.name}'`);
  if (v === undefined) return defaultOf(t, schema);
  if (t === 'bool') return typeof v === 'boolean' ? v : truthy(v);
  if (t === 'string') return typeof v === 'string' ? v : String(v);
  const sc = schema[t];
  if (sc) {
    if (Array.isArray(v)) {
      if (v.length !== sc.length) throw new RuntimeErr('ERR_TYPE', `${t} 집합체의 성분 수가 맞지 않습니다 (${v.length}/${sc.length})${what}`);
      const o = { $type: t };
      sc.forEach(([f, ft], i) => { o[f] = coerce(ft, v[i], schema, what); });
      return o;
    }
    if (v && typeof v === 'object') {
      if (v.$type && v.$type !== t) throw new RuntimeErr('ERR_TYPE', `타입 불일치: ${v.$type} → ${t}${what}`);
      return clone(v);
    }
    throw new RuntimeErr('ERR_TYPE', `${t} 타입이 필요합니다${what}`);
  }
  if (NUMLIKE.has(t) || !sc) {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string' && t === 'num') throw new RuntimeErr('ERR_TYPE', `num 타입에 문자열을 대입할 수 없습니다${what}`);
    return clone(v);
  }
  return v;
}

// 배열 선언 [d1,d2] 에 맞춰 변환
function coerceDecl(type, dims, v, schema) {
  if (!dims || !dims.length) return coerce(type, v, schema);
  const [d, ...rest] = dims;
  const arr = [];
  if (v === undefined) { for (let i = 0; i < d; i++) arr.push(coerceDecl(type, rest, undefined, schema)); return arr; }
  if (!Array.isArray(v) || v.length !== d) throw new RuntimeErr('ERR_TYPE', `배열 크기가 맞지 않습니다 (선언 ${d}, 값 ${Array.isArray(v) ? v.length : 1})`);
  for (let i = 0; i < d; i++) arr.push(coerceDecl(type, rest, v[i], schema));
  return arr;
}

const clone = (v) => (v && typeof v === 'object' && !(v instanceof Sig) ? structuredClone(v) : v);

// ------------------------------------------------------------------ 텍스트 형식
function fmtNum(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n);
  if (Math.abs(n) >= 1e7) {
    const [m, e] = n.toExponential(6).split('e');
    return `${parseFloat(m)}E${e[0] === '-' ? '-' : '+'}${e.replace(/^[+-]/, '').padStart(2, '0')}`;
  }
  if (Number.isInteger(n)) return String(n);
  const r = +n.toFixed(6);
  return String(Object.is(r, -0) ? 0 : r);
}

export function formatValue(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return fmtNum(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return `"${v.replace(/"/g, '""')}"`;
  if (v instanceof Sig) return v.name;
  if (Array.isArray(v)) return `[${v.map(formatValue).join(',')}]`;
  if (typeof v === 'object') {
    const sc = SCHEMA[v.$type];
    const keys = sc ? sc.map(([f]) => f) : Object.keys(v).filter((k) => k !== '$type');
    return `[${keys.map((k) => formatValue(v[k])).join(',')}]`;
  }
  return String(v);
}

// RAPID 텍스트 → JS 값 (집합체는 중첩 배열; 타입 지정 시 레코드로 변환)
export function parseValue(text, type) {
  const src = String(text).trim();
  const p = new Parser(src);
  const ast = p.expr();
  if (!p.eof()) throw new Error(`값 형식 오류: ${src}`);
  const v = evaluate(ast, {
    get(name) {
      const u = K(name);
      if (u === 'TRUE') return true;
      if (u === 'FALSE') return false;
      const c = constant(u, null);
      if (c !== undefined) return c;
      throw new Error(`값에 사용할 수 없는 이름 '${name}'`);
    },
    call(name) { throw new Error(`값에 함수 호출 불가: ${name}`); },
  });
  return type ? coerce(type, v, SCHEMA) : v;
}

// ------------------------------------------------------------------ 기본 상수
const speed = (v, ori = 500, leax = 5000, reax = 1000) => ({ $type: 'speeddata', v_tcp: v, v_ori: ori, v_leax: leax, v_reax: reax });
const zone = (z) => (z === null
  ? { $type: 'zonedata', finep: true, pzone_tcp: 0, pzone_ori: 0, pzone_eax: 0, zone_ori: 0, zone_leax: 0, zone_reax: 0 }
  : { $type: 'zonedata', finep: false, pzone_tcp: z, pzone_ori: z * 1.5, pzone_eax: z * 1.5, zone_ori: z * 0.15, zone_leax: z * 0.15, zone_reax: z * 0.15 });
const poseRec = (p, q) => ({ $type: 'pose', trans: { $type: 'pos', x: p[0], y: p[1], z: p[2] }, rot: { $type: 'orient', q1: q[0], q2: q[1], q3: q[2], q4: q[3] } });
const load0 = () => ({ $type: 'loaddata', mass: 0.001, cog: { $type: 'pos', x: 0, y: 0, z: 0.001 }, aom: { $type: 'orient', q1: 1, q2: 0, q3: 0, q4: 0 }, ix: 0, iy: 0, iz: 0 });

function constant(u, ctrl) {
  if (u === 'PI') return Math.PI;
  if (u === 'TOOL0') return { $type: 'tooldata', robhold: true, tframe: poseRec([0, 0, 0], [1, 0, 0, 0]), tload: load0() };
  if (u === 'WOBJ0') return { $type: 'wobjdata', robhold: false, ufprog: true, ufmec: '', uframe: poseRec([0, 0, 0], [1, 0, 0, 0]), oframe: poseRec([0, 0, 0], [1, 0, 0, 0]) };
  if (u === 'LOAD0') return load0();
  if (u === 'FINE') return zone(null);
  if (u === 'VMAX') return speed(ctrl?.robot?.tcpMaxSpeed ?? 7000);
  if (u === 'V_MAX') return speed(ctrl?.robot?.tcpMaxSpeed ?? 7000);
  let m = /^V(\d+)$/.exec(u);
  if (m) return speed(Number(m[1]));
  m = /^Z(\d+)$/.exec(u);
  if (m) return zone(Number(m[1]));
  if (u === 'STEMPTY') return '';
  if (u === 'HIGH') return 1;
  if (u === 'LOW') return 0;
  if (u === 'ON') return 1;
  if (u === 'OFF') return 0;
  if (u === 'EOF_NUM') return 9.998e37;
  return undefined;
}

// ------------------------------------------------------------------ 기하 헬퍼
const posArr = (t) => [t.x, t.y, t.z];
const quatArr = (o) => [o.q1, o.q2, o.q3, o.q4];
const poseOf = (pr) => ({ p: posArr(pr.trans), R: RfromQuat(quatArr(pr.rot)) });
const isIdent = (P) => Math.hypot(...P.p) < 1e-9 && Math.abs(P.R[0][0] + P.R[1][1] + P.R[2][2] - 3) < 1e-9;
const setPos = (t, p) => { t.x = p[0]; t.y = p[1]; t.z = p[2]; };
const setQuat = (o, q) => { o.q1 = q[0]; o.q2 = q[1]; o.q3 = q[2]; o.q4 = q[3]; };
const quad = (deg) => Math.floor(deg / 90 + 1e-9);

function asRec(type, v) {
  if (Array.isArray(v)) return coerce(type, v, SCHEMA);
  if (v && typeof v === 'object' && !(v instanceof Sig)) {
    if (v.$type !== type) throw new RuntimeErr('ERR_TYPE', `${type} 타입이 필요합니다 (발견: ${v.$type ?? typeof v})`);
    return v;
  }
  throw new RuntimeErr('ERR_TYPE', `${type} 타입이 필요합니다${v instanceof Sig ? ` ('${v.name}' 미정의)` : ''}`);
}

function confOf(j) { return { $type: 'confdata', cf1: quad(j[0]), cf4: quad(j[3]), cf6: quad(j[5]), cfx: 0 }; }
const extNine = () => ({ $type: 'extjoint', eax_a: NINE, eax_b: NINE, eax_c: NINE, eax_d: NINE, eax_e: NINE, eax_f: NINE });
function robT(pose, joints) {
  return {
    $type: 'robtarget',
    trans: { $type: 'pos', x: pose.p[0], y: pose.p[1], z: pose.p[2] },
    rot: Object.assign({ $type: 'orient' }, (([a, b, c, d]) => ({ q1: a, q2: b, q3: c, q4: d }))(quatFromR(pose.R))),
    robconf: confOf(joints), extax: extNine(),
  };
}

// confdata 의 cf1/cf4/cf6 사분면이 맞는 해를 우선 (경계 ±1° 허용)
function confFilter(cf) {
  const want = [[0, cf.cf1], [3, cf.cf4], [5, cf.cf6]];
  return (sol) => {
    let pen = 0;
    for (const [i, c] of want) {
      if (!Number.isFinite(c)) continue;
      const lo = c * 90 - 1, hi = (c + 1) * 90 + 1;
      if (sol[i] < lo || sol[i] > hi) pen++;
    }
    return pen;
  };
}

// ------------------------------------------------------------------ 실행 컨텍스트 / 평가 환경
function sigType(ctrl, name) {
  const u = K(name);
  if (/^(DO|GO|AO)/.test(u)) return 'do';
  if (/^(DI|GI|AI)/.test(u)) return 'di';
  for (const nm of Object.values(ctrl.ioNames.do)) if (K(nm) === u) return 'do';
  return 'di';
}
function sigNo(ctrl, v, type) {
  if (v instanceof Sig) return ctrl.signalNo(type || sigType(ctrl, v.name), v.name);
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return ctrl.signalNo(type || sigType(ctrl, v), v);
  throw new RuntimeErr('ERR_SIG', '신호 이름이 필요합니다');
}
function sigVal(ctrl, s, type) {
  const t = type || sigType(ctrl, s.name);
  const n = sigNo(ctrl, s, t);
  return (t === 'do' ? ctrl.getDO(n) : ctrl.getDI(n)) ? 1 : 0;
}

const isLv = (a) => a && (a.t === 'id' || a.t === 'field' || a.t === 'index');

class Ctx {
  constructor(prog, ctrl, vm, frame) { this.prog = prog; this.ctrl = ctrl; this.vm = vm; this.frame = frame; this.st = prog.state; }
  get env() { return this._env ||= makeEnv(this); }
  ev(ast) { return evaluate(ast, this.env); }
  typeOfName(key) {
    if (this.frame?.locals.has(key)) return this.frame.proc.ltypes?.get(key)?.type;
    return this.prog.meta.get(key)?.type;
  }
}

function makeEnv(cx) {
  const { prog, ctrl } = cx;
  return {
    get(name) {
      const u = K(name);
      if (cx.frame?.locals.has(u)) return cx.frame.locals.get(u);
      if (prog.globals.has(u)) return prog.globals.get(u);
      if (u === 'TRUE') return true;
      if (u === 'FALSE') return false;
      const c = constant(u, ctrl);
      if (c !== undefined) return c;
      if (!cx.vm) throw new RuntimeErr('ERR_UNDEF', `정의되지 않은 이름 '${name}'`);
      return new Sig(name);
    },
    call(name, args, named, node) { return callFunc(cx, name, args, named, node); },
    field(obj, name) {
      if (obj instanceof Sig) throw new RuntimeErr('ERR_UNDEF', `정의되지 않은 이름 '${obj.name}'`);
      if (Array.isArray(obj)) throw new RuntimeErr('ERR_TYPE', `집합체에는 컴포넌트 '${name}' 가 없습니다`);
      const k = name.toLowerCase();
      if (!obj || typeof obj !== 'object' || !(k in obj)) throw new RuntimeErr('ERR_TYPE', `컴포넌트 '${name}' 가 없습니다 (${obj?.$type ?? typeof obj})`);
      return obj[k];
    },
    index(obj, idx) {
      let v = obj;
      for (const i of idx) {
        if (!Array.isArray(v)) throw new RuntimeErr('ERR_TYPE', '배열이 아닌 데이터에 인덱스 사용');
        const n = Math.round(i);
        if (n < 1 || n > v.length) throw new RuntimeErr('ERR_OUTOFBND', `배열 인덱스 범위 초과: ${n} (크기 ${v.length})`);
        v = v[n - 1];
      }
      return v;
    },
    neg(a) {
      if (a && typeof a === 'object' && a.$type === 'pos') return { $type: 'pos', x: -a.x, y: -a.y, z: -a.z };
      return -a;
    },
    binop(op, a, b) {
      if (a instanceof Sig) a = sigVal(ctrl, a);
      if (b instanceof Sig) b = sigVal(ctrl, b);
      const ao = a && typeof a === 'object', bo = b && typeof b === 'object';
      if (ao || bo) {
        if (op === '=' || op === '<>') { const e = formatValue(a) === formatValue(b); return op === '=' ? e : !e; }
        if (a?.$type === 'pos' && b?.$type === 'pos') {
          if (op === '+') return { $type: 'pos', x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
          if (op === '-') return { $type: 'pos', x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
          if (op === '*') return a.x * b.x + a.y * b.y + a.z * b.z;
        }
        if (a?.$type === 'pos' && typeof b === 'number' && (op === '*' || op === '/')) { const s = op === '*' ? b : 1 / b; return { $type: 'pos', x: a.x * s, y: a.y * s, z: a.z * s }; }
        if (b?.$type === 'pos' && typeof a === 'number' && op === '*') return { $type: 'pos', x: b.x * a, y: b.y * a, z: b.z * a };
        if (a?.$type === 'orient' && b?.$type === 'orient' && op === '*') {
          const q = quatFromR(mul3(RfromQuat(quatArr(a)), RfromQuat(quatArr(b))));
          return { $type: 'orient', q1: q[0], q2: q[1], q3: q[2], q4: q[3] };
        }
        throw new RuntimeErr('ERR_TYPE', `연산자 '${op}' 를 이 데이터 타입에 사용할 수 없습니다`);
      }
      if (op === '+' && (typeof a === 'string' || typeof b === 'string')) return String(a) + String(b);
      return binop(op, a, b);
    },
  };
}

// 대입: 변수/배열요소/컴포넌트
function lvType(cx, node) {
  if (node.t === 'id') return cx.typeOfName(K(node.name));
  if (node.t === 'index') return lvType(cx, node.obj);
  if (node.t === 'field') {
    const pt = lvType(cx, node.obj);
    const sc = cx.prog.schema[typeKey(pt ?? '')];
    return sc?.find(([f]) => f === node.name.toLowerCase())?.[1];
  }
  return undefined;
}

function assign(cx, node, value) {
  const schema = cx.prog.schema;
  if (node.t === 'id') {
    const u = K(node.name);
    const where = cx.frame?.locals.has(u) ? cx.frame.locals : cx.prog.globals.has(u) ? cx.prog.globals : null;
    if (!where) throw new RuntimeErr('ERR_UNDEF', `정의되지 않은 변수 '${node.name}'`);
    if (where === cx.prog.globals && cx.prog.meta.get(u)?.kind === 'CONST') throw new RuntimeErr('ERR_CONST', `상수 '${node.name}' 에는 대입할 수 없습니다`);
    const meta = where === cx.prog.globals ? cx.prog.meta.get(u) : cx.frame.proc.ltypes?.get(u);
    const t = meta?.type;
    const v = t ? (meta.dims?.length ? coerceDecl(t, meta.dims, value, schema) : coerce(t, value, schema)) : clone(value);
    where.set(u, v);
    return;
  }
  const root = rootName(node);
  if (root && !cx.frame?.locals.has(root) && cx.prog.meta.get(root)?.kind === 'CONST') throw new RuntimeErr('ERR_CONST', `상수 '${root}' 에는 대입할 수 없습니다`);
  const t = lvType(cx, node);
  const v = t ? coerce(t, value, schema) : clone(value);
  if (node.t === 'field') {
    const obj = cx.ev(node.obj);
    const k = node.name.toLowerCase();
    if (!obj || typeof obj !== 'object' || !(k in obj)) throw new RuntimeErr('ERR_TYPE', `컴포넌트 '${node.name}' 가 없습니다`);
    obj[k] = v;
  } else if (node.t === 'index') {
    let arr = cx.ev(node.obj);
    const idx = node.idx.map((x) => Math.round(cx.ev(x)));
    for (let i = 0; i < idx.length; i++) {
      if (!Array.isArray(arr)) throw new RuntimeErr('ERR_TYPE', '배열이 아닌 데이터에 인덱스 사용');
      if (idx[i] < 1 || idx[i] > arr.length) throw new RuntimeErr('ERR_OUTOFBND', `배열 인덱스 범위 초과: ${idx[i]}`);
      if (i === idx.length - 1) arr[idx[i] - 1] = v; else arr = arr[idx[i] - 1];
    }
  } else throw new RuntimeErr('ERR_SYNTAX', '대입할 수 없는 식입니다');
}
const rootName = (n) => (n.t === 'id' ? K(n.name) : n.obj ? rootName(n.obj) : null);

// ------------------------------------------------------------------ 루틴 호출
// 인자 바인딩: 필수 인자는 순서대로, 선택 인자(\x)는 이름으로
function bindArgs(cx, proc, args, named) {
  const locals = new Map();
  const back = [];
  const req = proc.rparams.filter((p) => !p.optional);
  if (args.length > req.length) throw new RuntimeErr('ERR_ARG', `${proc.name}: 인자가 너무 많습니다`);
  req.forEach((p, i) => {
    const a = args[i];
    if (!a) throw new RuntimeErr('ERR_ARG', `${proc.name}: 인자 '${p.name}' 가 없습니다`);
    const v = a.ast ? cx.ev(a.ast) : a.v;
    locals.set(p.key, p.dims ? clone(v) : coerce(p.type, v, cx.prog.schema, ` (인자 ${p.name})`));
    if (p.mode && a.ast && isLv(a.ast)) back.push([a.ast, p.key]);
  });
  for (const p of proc.rparams.filter((q) => q.optional)) {
    const a = named[p.key];
    if (a === undefined) { locals.set(p.key, undefined); continue; }
    if (a === true) { locals.set(p.key, true); continue; }
    const v = a.ast ? cx.ev(a.ast) : a.v;
    locals.set(p.key, p.type === 'switch' ? true : coerce(p.type, v, cx.prog.schema, ` (인자 ${p.name})`));
    if (p.mode && a.ast && isLv(a.ast)) back.push([a.ast, p.key]);
  }
  for (const k of Object.keys(named)) if (!proc.rparams.some((p) => p.key === k)) throw new RuntimeErr('ERR_ARG', `${proc.name}: 알 수 없는 선택 인자 \\${k}`);
  const writeBack = () => { for (const [ast, key] of back) assign(cx, ast, locals.get(key)); };
  return { locals, writeBack };
}

// FUNC 는 식 평가 중 동기 실행 (이동/대기 명령 불가)
function runSync(vm, proc, locals, depth = 0) {
  if (depth > 200) throw new RuntimeErr('ERR_STACK', '호출 깊이 초과');
  const frame = { proc, pc: 0, locals };
  let guard = 0;
  while (frame.pc < proc.code.length) {
    if (++guard > 2e6) throw new RuntimeErr('ERR_LOOP', `${proc.name}: 무한 루프로 판단되어 중단`);
    const r = proc.code[frame.pc].run(vm, frame);
    if (r && typeof r.then === 'function') throw new RuntimeErr('ERR_FUNC', `FUNC ${proc.name} 안에서는 이동/대기 명령을 사용할 수 없습니다`);
    if (!r) frame.pc++;
    else if (r.goto !== undefined) frame.pc = r.goto;
    else if (r.call) { const v = runSync(vm, r.call.proc, r.call.locals || new Map(), depth + 1); r.call.onReturn?.(v); frame.pc++; }
    else if ('ret' in r) return r.ret;
    else if (r.halt) throw new RuntimeErr('ERR_FUNC', `FUNC ${proc.name} 안에서 프로그램 종료`);
  }
  return undefined;
}

function callFunc(cx, name, args, named, node) {
  const u = K(name);
  const user = cx.prog.procs[u];
  if (user && user.kind === 'FUNC') {
    const a = node.args.map((ast, i) => ({ ast, v: args[i] }));
    const nm = {};
    for (const [k, v] of Object.entries(node.named || {})) nm[k] = v === true ? true : { ast: v };
    const { locals, writeBack } = bindArgs(cx, user, a, nm);
    const v = runSync(cx.vm, user, locals);
    writeBack();
    if (v === undefined) throw new RuntimeErr('ERR_FUNC', `FUNC ${user.name} 이 값을 반환하지 않았습니다`);
    return v;
  }
  const f = FUNCS[u];
  if (f) return f(cx, args, named, node);
  if (user) throw new RuntimeErr('ERR_FUNC', `${user.name} 은 FUNC 가 아닙니다`);
  throw new RuntimeErr('ERR_UNDEF', `알 수 없는 함수 '${name}'`);
}

// ------------------------------------------------------------------ 내장 함수
const num = (v, nm = '') => {
  if (v instanceof Sig) throw new RuntimeErr('ERR_UNDEF', `정의되지 않은 이름 '${v.name}'`);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v !== 'number') throw new RuntimeErr('ERR_TYPE', `숫자가 필요합니다${nm}`);
  return v;
};
const roundDec = (x, d) => { const f = 10 ** d; return Math.round(x * f) / f; };

function curTool(cx, named) {
  if (named.TOOL !== undefined) return poseOf(asRec('tooldata', named.TOOL).tframe);
  return cx.st.tool ?? cx.ctrl.tool;
}
function curWobj(cx, named) {
  if (named.WOBJ !== undefined) return wobjPose(named.WOBJ);
  return cx.st.wobj ?? cx.ctrl.base ?? null;
}
function wobjPose(w) {
  const o = asRec('wobjdata', w);
  const P = poseMul(poseOf(o.uframe), poseOf(o.oframe));
  return isIdent(P) ? null : P;
}

const FUNCS = {
  OFFS(cx, [p, dx, dy, dz]) {
    const r = clone(asRec('robtarget', p));
    r.trans.x += num(dx); r.trans.y += num(dy); r.trans.z += num(dz);
    return r;
  },
  RELTOOL(cx, [p, dx, dy, dz], named) {
    const r = clone(asRec('robtarget', p));
    const P = poseOf(r);
    const np = add(P.p, mulv(P.R, [num(dx), num(dy), num(dz)]));
    let R = P.R;
    if (named.RX !== undefined) R = mul3(R, Rx(num(named.RX) * DEG));
    if (named.RY !== undefined) R = mul3(R, Ry(num(named.RY) * DEG));
    if (named.RZ !== undefined) R = mul3(R, Rz(num(named.RZ) * DEG));
    setPos(r.trans, np); setQuat(r.rot, quatFromR(R));
    return r;
  },
  CROBT(cx, args, named) {
    const pose = fkTcp(cx.ctrl.robot, cx.ctrl.joints, curTool(cx, named), curWobj(cx, named));
    return robT(pose, cx.ctrl.joints);
  },
  CPOS(cx, args, named) {
    const pose = fkTcp(cx.ctrl.robot, cx.ctrl.joints, curTool(cx, named), curWobj(cx, named));
    return { $type: 'pos', x: pose.p[0], y: pose.p[1], z: pose.p[2] };
  },
  CJOINTT(cx) {
    const j = cx.ctrl.joints;
    return { $type: 'jointtarget', robax: { $type: 'robjoint', rax_1: j[0], rax_2: j[1], rax_3: j[2], rax_4: j[3], rax_5: j[4], rax_6: j[5] }, extax: extNine() };
  },
  CTOOL(cx) { const t = cx.st.toolData; return t ? clone(t) : constant('TOOL0'); },
  CWOBJ(cx) { const w = cx.st.wobjData; return w ? clone(w) : constant('WOBJ0'); },
  ABS: (cx, [x]) => Math.abs(num(x)),
  ABSDNUM: (cx, [x]) => Math.abs(num(x)),
  ROUND: (cx, [x], n) => roundDec(num(x), n.DEC !== undefined ? num(n.DEC) : 0),
  TRUNC: (cx, [x], n) => { const d = n.DEC !== undefined ? num(n.DEC) : 0; const f = 10 ** d; return Math.trunc(num(x) * f) / f; },
  SQRT: (cx, [x]) => { if (num(x) < 0) throw new RuntimeErr('ERR_ARG', 'Sqrt: 음수'); return Math.sqrt(x); },
  SIN: (cx, [x]) => Math.sin(num(x) * DEG),
  COS: (cx, [x]) => Math.cos(num(x) * DEG),
  TAN: (cx, [x]) => Math.tan(num(x) * DEG),
  ASIN: (cx, [x]) => Math.asin(num(x)) * RAD,
  ACOS: (cx, [x]) => Math.acos(num(x)) * RAD,
  ATAN: (cx, [x]) => Math.atan(num(x)) * RAD,
  ATAN2: (cx, [y, x]) => Math.atan2(num(y), num(x)) * RAD,
  POW: (cx, [b, e]) => num(b) ** num(e),
  EXP: (cx, [x]) => Math.exp(num(x)),
  MAX: (cx, [a, b]) => Math.max(num(a), num(b)),
  MIN: (cx, [a, b]) => Math.min(num(a), num(b)),
  NUMTOSTR: (cx, [v, d]) => { const s = num(v).toFixed(Math.max(0, Math.round(num(d ?? 0)))); return s; },
  NUMTODNUM: (cx, [v]) => num(v),
  DNUMTONUM: (cx, [v]) => num(v),
  VALTOSTR: (cx, [v]) => (typeof v === 'string' ? v : formatValue(v)),
  STRLEN: (cx, [s]) => String(s).length,
  STRPART: (cx, [s, st, len]) => String(s).substr(num(st) - 1, num(len)),
  STRFIND: (cx, [s, st, set]) => { const str = String(s); for (let i = num(st) - 1; i < str.length; i++) if (String(set).includes(str[i])) return i + 1; return str.length + 1; },
  STRTOVAL: () => true,
  ORIENTZYX(cx, [z, y, x]) {
    const q = quatFromR(RfromZYX(num(z), num(y), num(x)));
    return { $type: 'orient', q1: q[0], q2: q[1], q3: q[2], q4: q[3] };
  },
  EULERZYX(cx, [o], named) {
    const [rz, ry, rx] = ZYXfromR(RfromQuat(quatArr(asRec('orient', o))));
    if (named.X) return rx;
    if (named.Y) return ry;
    return rz;
  },
  NORIENT(cx, [o]) {
    const r = clone(asRec('orient', o));
    const n = Math.hypot(r.q1, r.q2, r.q3, r.q4) || 1;
    r.q1 /= n; r.q2 /= n; r.q3 /= n; r.q4 /= n;
    return r;
  },
  POSEMULT(cx, [a, b]) { const P = poseMul(poseOf(asRec('pose', a)), poseOf(asRec('pose', b))); return poseRec(P.p, quatFromR(P.R)); },
  POSEINV(cx, [a]) { const P = poseInv(poseOf(asRec('pose', a))); return poseRec(P.p, quatFromR(P.R)); },
  POSEVECT(cx, [a, v]) { const P = poseOf(asRec('pose', a)); const r = add(P.p, mulv(P.R, posArr(asRec('pos', v)))); return { $type: 'pos', x: r[0], y: r[1], z: r[2] }; },
  DEFFRAME(cx, [p1, p2, p3]) {
    const a = posArr(asRec('robtarget', p1).trans), b = posArr(asRec('robtarget', p2).trans), c = posArr(asRec('robtarget', p3).trans);
    const ex = scale(sub(b, a), 1 / (norm(sub(b, a)) || 1));
    let ez = cross(ex, sub(c, a));
    ez = scale(ez, 1 / (norm(ez) || 1));
    const ey = cross(ez, ex);
    const R = [[ex[0], ey[0], ez[0]], [ex[1], ey[1], ez[1]], [ex[2], ey[2], ez[2]]];
    return poseRec(a, quatFromR(R));
  },
  DIM(cx, [arr, d]) {
    let v = arr;
    for (let i = 1; i < num(d); i++) v = v?.[0];
    if (!Array.isArray(v)) throw new RuntimeErr('ERR_ARG', 'Dim: 배열이 아닙니다');
    return v.length;
  },
  DOUTPUT: (cx, [s]) => (cx.ctrl.getDO(sigNo(cx.ctrl, s, 'do')) ? 1 : 0),
  DINPUT: (cx, [s]) => (cx.ctrl.getDI(sigNo(cx.ctrl, s, 'di')) ? 1 : 0),
  TESTDI: (cx, [s]) => cx.ctrl.getDI(sigNo(cx.ctrl, s, 'di')),
  PRESENT(cx, args, named, node) {
    const a = node.args[0];
    if (!a || a.t !== 'id') return false;
    const u = K(a.name);
    return !!cx.frame?.locals.has(u) && cx.frame.locals.get(u) !== undefined;
  },
  CLKREAD(cx, [c]) { const k = asRec('clock', c); return roundDec(k.acc + (k.running ? (performance.now() - k.start) / 1000 : 0), 3); },
  ROBOS: () => false,
  ISPERS: () => false,
  OPMODE: (cx) => (cx.ctrl.mode === 'TEACH' ? 1 : 0),
  CDATE: () => new Date().toISOString().slice(0, 10),
  CTIME: () => new Date().toTimeString().slice(0, 8),
  GETTASKNAME: () => 'T_ROB1',
  BITAND: (cx, [a, b]) => num(a) & num(b),
  BITOR: (cx, [a, b]) => num(a) | num(b),
};

// ------------------------------------------------------------------ 문장 분할
const HEADER = [
  /^(LOCAL\s+|TASK\s+)?(MODULE|PROC|FUNC|TRAP|RECORD)\b/i,
  /^(ENDMODULE|ENDPROC|ENDFUNC|ENDTRAP|ENDRECORD|ENDIF|ELSE|ENDWHILE|ENDFOR|ENDTEST|ERROR|BACKWARD|UNDO)\b/i,
  /^TEST\b/i,
  /\b(THEN|DO)$/i,
  /^(CASE\b.*|DEFAULT\s*):$/i,
  /^[A-Za-z_]\w*\s*:$/,
];

function splitStatements(text) {
  let lines = text.replace(/\r\n?/g, '\n').split('\n');
  // 구형 .prg 헤더 (%%% VERSION:1 LANGUAGE:ENGLISH %%%)
  if (lines[0]?.trim() === '%%%') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '%%%');
    if (end > 0) lines = lines.map((l, i) => (i <= end ? '' : l));
  }
  const out = [];
  let cur = '', curLine = 1;
  for (let li = 0; li < lines.length; li++) {
    const s = stripComment(lines[li], ['!']);
    let inStr = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (!cur.trim() && ch.trim()) curLine = li + 1;
      if (ch === '"') inStr = !inStr;
      if (ch === ';' && !inStr) {
        if (cur.trim()) out.push({ text: cur.trim(), line: curLine, semi: true });
        cur = '';
        continue;
      }
      cur += ch;
    }
    const t = cur.trim();
    if (t && HEADER.some((r) => r.test(t))) { out.push({ text: t, line: curLine }); cur = ''; }
    else cur += ' ';
  }
  if (cur.trim()) out.push({ text: cur.trim(), line: curLine });
  return out;
}

// 문자열 밖의 { } → [ ] (RAPID 배열 첨자/초기값)
function braces(s) {
  let out = '', inStr = false;
  for (const ch of s) {
    if (ch === '"') inStr = !inStr;
    out += inStr ? ch : ch === '{' ? '[' : ch === '}' ? ']' : ch;
  }
  return out;
}

const parseExpr = (src) => {
  const p = new Parser(src);
  const e = p.expr();
  if (!p.eof()) throw new Error(`수식 뒤에 불필요한 토큰 '${p.peek().v}'`);
  return e;
};

// 최상위 ':=' 위치 (문자열/괄호 밖)
function findAssign(s) {
  let depth = 0, inStr = false;
  for (let i = 0; i < s.length - 1; i++) {
    const ch = s[i];
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ':' && s[i + 1] === '=' && depth === 0) {
      // \Name:= (선택 인자) 는 대입이 아님
      let j = i - 1;
      while (j >= 0 && /\s/.test(s[j])) j--;
      while (j >= 0 && /\w/.test(s[j])) j--;
      while (j >= 0 && /\s/.test(s[j])) j--;
      if (s[j] === '\\') continue;
      return i;
    }
  }
  return -1;
}

const DECL_RE = /^(?:(?:LOCAL|TASK)\s+)?(CONST|PERS|VAR)\s+([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*(?::=\s*([\s\S]*))?$/i;

// ------------------------------------------------------------------ 컴파일러
function compile(files, main, ctrl) {
  const schema = { ...SCHEMA };
  const prog = {
    lang: 'rapid', entry: 'MAIN', procs: {}, globals: new Map(), meta: new Map(), schema,
    modules: {}, state: null,
    init(vm) {
      prog.state = vm.rapid = {
        confJ: true, confL: true, velOv: 100, velMax: ctrl?.robot?.tcpMaxSpeed ?? 7000,
        tool: null, wobj: null, toolData: null, wobjData: null,
      };
    },
  };
  prog.state = { confJ: true, confL: true, velOv: 100, velMax: 7000, tool: null, wobj: null };
  const pending = []; // 미해결 루틴 호출 [{name, file, line}]
  const names = [...files.keys()].filter((f) => EXTS.some((e) => f.toLowerCase().endsWith(e)) || f === main);
  names.sort((a, b) => (a === main ? 1 : b === main ? -1 : 0));
  const cctx = new Ctx(prog, ctrl, null, null);

  for (const file of names) {
    const stmts = splitStatements(files.get(file));
    let module = null;
    let i = 0;
    while (i < stmts.length) {
      const { text, line } = stmts[i];
      const t = braces(text);
      const u = t.toUpperCase();
      let m;
      if ((m = /^MODULE\s+([A-Za-z_]\w*)/i.exec(t))) { module = m[1]; prog.modules[K(module)] = { name: module, file }; i++; continue; }
      if (/^ENDMODULE\b/i.test(t)) { module = null; i++; continue; }
      if (!module) throw new CompileError(`MODULE 선언 밖의 문장입니다: ${text.slice(0, 40)}`, file, line);
      if ((m = /^(?:(?:LOCAL|TASK)\s+)?RECORD\s+([A-Za-z_]\w*)$/i.exec(t))) {
        const fields = [];
        i++;
        while (i < stmts.length && !/^ENDRECORD\b/i.test(stmts[i].text)) {
          const fm = /^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)$/.exec(stmts[i].text.trim());
          if (!fm) throw new CompileError('RECORD 성분 형식 오류', file, stmts[i].line);
          fields.push([fm[2].toLowerCase(), typeKey(fm[1])]);
          i++;
        }
        schema[typeKey(m[1])] = fields;
        i++;
        continue;
      }
      if ((m = DECL_RE.exec(t))) {
        at(file, line, () => declare(cctx, prog, m, module, null));
        i++;
        continue;
      }
      if ((m = /^(?:(?:LOCAL|TASK)\s+)?(PROC|FUNC|TRAP)\s+(?:([A-Za-z_]\w*)\s+)?([A-Za-z_]\w*)\s*(?:\(([\s\S]*)\))?$/i.exec(t))) {
        const kind = m[1].toUpperCase();
        const endKw = 'END' + kind;
        let j = i + 1;
        const body = [];
        let inErr = false;
        while (j < stmts.length && !new RegExp(`^${endKw}\\b`, 'i').test(stmts[j].text)) {
          if (/^(ERROR|BACKWARD|UNDO)\b/i.test(stmts[j].text)) inErr = true;
          if (!inErr) body.push(stmts[j]);
          j++;
        }
        if (j >= stmts.length) throw new CompileError(`${endKw} 가 없습니다`, file, line);
        if (kind !== 'TRAP') {
          const name = kind === 'FUNC' ? m[3] : (m[2] ? null : m[3]);
          if (!name) throw new CompileError('루틴 선언 형식 오류', file, line);
          const key = K(name);
          if (prog.procs[key]) throw new CompileError(`루틴 '${name}' 이 중복 정의되었습니다`, file, line);
          const rparams = at(file, line, () => parseParams(m[4] || ''));
          const proc = { name, kind, rtype: kind === 'FUNC' ? m[2] : null, params: [], rparams, file, line, module, code: [], labels: {}, ltypes: new Map() };
          for (const p of rparams) proc.ltypes.set(p.key, { type: p.type, dims: p.dims });
          prog.procs[key] = proc;
          compileBody(prog, proc, body, file, ctrl, pending);
        }
        i = j + 1;
        continue;
      }
      throw new CompileError(`모듈 수준에서 허용되지 않는 문장: ${text.slice(0, 50)}`, file, line);
    }
    if (module) throw new CompileError(`ENDMODULE 가 없습니다 (${module})`, file, stmts.at(-1)?.line ?? 1);
  }
  for (const p of pending) {
    if (!prog.procs[K(p.name)] && !p.late) throw new CompileError(`정의되지 않은 루틴 또는 명령 '${p.name}'`, p.file, p.line);
  }
  if (!prog.procs.MAIN) throw new CompileError('PROC main() 이 없습니다', main, 1);
  return prog;
}

function parseParams(src) {
  const out = [];
  if (!src.trim()) return out;
  for (let part of splitTop(src, ',')) {
    part = part.trim();
    if (!part) continue;
    // 대안 인자 \a | \b → 각각 선택 인자
    for (let alt of part.split('|')) {
      alt = alt.trim();
      const optional = alt.startsWith('\\');
      if (optional) alt = alt.slice(1).trim();
      const m = /^(?:(INOUT|VAR|PERS)\s+)?([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(\{[^}]*\}|\[[^\]]*\])?$/i.exec(alt);
      if (!m) throw new Error(`매개변수 형식 오류: ${alt}`);
      out.push({ name: m[3], key: K(m[3]), type: typeKey(m[2]), mode: m[1] ? m[1].toUpperCase() : null, optional, dims: m[4] ? true : null });
    }
  }
  return out;
}

function evalDims(cx, s) {
  if (!s) return null;
  const inner = s.slice(1, -1).trim();
  if (inner === '*' || inner === '') return null;
  return splitTop(inner, ',').map((d) => Math.round(cx.ev(parseExpr(d))));
}

// 데이터 선언 (전역: compile 시 즉시 평가)
function declare(cx, prog, m, module, proc) {
  const [, kindRaw, typeRaw, name, dimS, init] = m;
  const kind = kindRaw.toUpperCase();
  const type = typeKey(typeRaw);
  const key = K(name);
  const dims = evalDims(cx, dimS);
  if (!prog.schema[type] && !NUMLIKE.has(type) && !['bool', 'string'].includes(type)) throw new Error(`알 수 없는 데이터 타입 '${typeRaw}'`);
  const meta = { name, type, kind, module, dims };
  const value = init !== undefined && init.trim() ? coerceDecl(type, dims, cx.ev(parseExpr(init.trim())), prog.schema) : coerceDecl(type, dims, undefined, prog.schema);
  if (proc) return { meta, value };
  if (prog.meta.has(key) && prog.meta.get(key).module !== module) throw new Error(`데이터 '${name}' 가 여러 모듈에 중복 정의되었습니다`);
  prog.meta.set(key, meta);
  prog.globals.set(key, value);
  return null;
}

// ------------------------------------------------------------------ 루틴 본문 컴파일
function compileBody(prog, proc, body, file, ctrl, pending) {
  const code = proc.code;
  const stack = [];
  const gotos = [];
  let hid = 0;
  const emit = (line, run) => { const ins = { line, file, run }; code.push(ins); return ins; };
  const jumpIfNot = (line, cond) => { const ins = emit(line, (vm, f) => (truthy(cond(vm, f)) ? undefined : { goto: ins.target })); return ins; };
  const jump = (line) => { const ins = emit(line, () => ({ goto: ins.target })); return ins; };
  const cx = (vm, f) => new Ctx(prog, vm.ctrl, vm, f);
  const evr = (ast) => (vm, f) => { const c = cx(vm, f); const v = c.ev(ast); return v instanceof Sig ? sigVal(vm.ctrl, v) : v; };

  const top = (k) => { const s = stack[stack.length - 1]; if (!s || s.k !== k) throw new Error(`${k} 블록 밖에서 사용되었습니다`); return s; };

  function stmt(text, line) {
    const t = braces(text);
    const u = t.toUpperCase();
    let m;
    // 라벨
    if ((m = /^([A-Za-z_]\w*)\s*:$/.exec(t)) && !/^DEFAULT$/i.test(m[1])) {
      if (proc.labels[K(m[1])] !== undefined) throw new Error(`라벨 '${m[1]}' 중복`);
      proc.labels[K(m[1])] = code.length;
      return;
    }
    // 지역 데이터 선언
    if ((m = DECL_RE.exec(t))) {
      const [, kindRaw, typeRaw, name, dimS, init] = m;
      const type = typeKey(typeRaw);
      const key = K(name);
      if (!prog.schema[type] && !NUMLIKE.has(type) && !['bool', 'string'].includes(type)) throw new Error(`알 수 없는 데이터 타입 '${typeRaw}'`);
      const initAst = init !== undefined && init.trim() ? parseExpr(init.trim()) : null;
      const dimAst = dimS ? splitTop(dimS.slice(1, -1), ',').map((d) => parseExpr(d)) : null;
      proc.ltypes.set(key, { type, dims: null, kind: kindRaw.toUpperCase() });
      emit(line, (vm, f) => {
        const c = cx(vm, f);
        const dims = dimAst ? dimAst.map((d) => Math.round(c.ev(d))) : null;
        proc.ltypes.get(key).dims = dims;
        f.locals.set(key, coerceDecl(type, dims, initAst ? c.ev(initAst) : undefined, prog.schema));
      });
      return;
    }
    // IF
    if (/^IF\b/i.test(t)) {
      const p = new Parser(t.slice(2));
      const cond = p.expr();
      if (p.acceptKw('THEN')) {
        if (!p.eof()) throw new Error('THEN 뒤에 불필요한 토큰');
        stack.push({ k: 'IF', j: jumpIfNot(line, evr(cond)), ends: [] });
        return;
      }
      // 한 줄 IF: IF cond 명령;
      const rest = p.rest();
      const j = jumpIfNot(line, evr(cond));
      stmt(rest, line);
      j.target = code.length;
      return;
    }
    if (/^ELSEIF\b/i.test(t)) {
      const s = top('IF');
      if (!s.j) throw new Error('ELSE 뒤에 ELSEIF 를 사용할 수 없습니다');
      const p = new Parser(t.slice(6));
      const cond = p.expr();
      p.expectKw('THEN');
      s.ends.push(jump(line));
      s.j.target = code.length;
      s.j = jumpIfNot(line, evr(cond));
      return;
    }
    if (/^ELSE$/i.test(t)) {
      const s = top('IF');
      if (!s.j) throw new Error('ELSE 가 중복되었습니다');
      s.ends.push(jump(line));
      s.j.target = code.length;
      s.j = null;
      return;
    }
    if (/^ENDIF$/i.test(t)) {
      const s = top('IF'); stack.pop();
      if (s.j) s.j.target = code.length;
      for (const e of s.ends) e.target = code.length;
      return;
    }
    // WHILE
    if ((m = /^WHILE\b([\s\S]*)\bDO$/i.exec(t))) {
      const cond = parseExpr(m[1]);
      const topPc = code.length;
      stack.push({ k: 'WHILE', top: topPc, j: jumpIfNot(line, evr(cond)) });
      return;
    }
    if (/^ENDWHILE$/i.test(t)) {
      const s = top('WHILE'); stack.pop();
      jump(line).target = s.top;
      s.j.target = code.length;
      return;
    }
    // FOR
    if (/^FOR\b/i.test(t)) {
      const p = new Parser(t.slice(3));
      const v = K(p.ident());
      p.expectKw('FROM');
      const a = p.expr();
      p.expectKw('TO');
      const b = p.expr();
      let st = null;
      if (p.acceptKw('STEP')) st = p.expr();
      p.expectKw('DO');
      const id = hid++;
      const kE = `__FORE${id}`, kS = `__FORS${id}`;
      proc.ltypes.set(v, { type: 'num' });
      emit(line, (vm, f) => {
        const c = cx(vm, f);
        f.locals.set(v, num(c.ev(a)));
        f.locals.set(kE, num(c.ev(b)));
        const sv = st ? num(c.ev(st)) : (f.locals.get(kE) >= f.locals.get(v) ? 1 : -1);
        f.locals.set(kS, sv);
      });
      const chkPc = code.length;
      const chk = emit(line, (vm, f) => {
        const x = f.locals.get(v), e = f.locals.get(kE), s = f.locals.get(kS);
        return (s >= 0 ? x > e + 1e-9 : x < e - 1e-9) ? { goto: chk.target } : undefined;
      });
      stack.push({ k: 'FOR', chk, chkPc, v, kS });
      return;
    }
    if (/^ENDFOR$/i.test(t)) {
      const s = top('FOR'); stack.pop();
      emit(line, (vm, f) => { f.locals.set(s.v, f.locals.get(s.v) + f.locals.get(s.kS)); return { goto: s.chkPc }; });
      s.chk.target = code.length;
      return;
    }
    // TEST / CASE / DEFAULT
    if (/^TEST\b/i.test(t)) {
      const ast = parseExpr(t.slice(4));
      const key = `__TEST${hid++}`;
      emit(line, (vm, f) => { f.locals.set(key, evr(ast)(vm, f)); });
      stack.push({ k: 'TEST', key, skip: null, ends: [], any: false });
      return;
    }
    if ((m = /^CASE\b([\s\S]*):$/i.exec(t))) {
      const s = top('TEST');
      const vals = splitTop(m[1], ',').map((x) => parseExpr(x));
      if (s.any) s.ends.push(jump(line));
      if (s.skip) s.skip.target = code.length;
      s.any = true;
      const ins = emit(line, (vm, f) => {
        const v = f.locals.get(s.key);
        const c = cx(vm, f);
        for (const a of vals) { let w = c.ev(a); if (w instanceof Sig) w = sigVal(vm.ctrl, w); if (binop('=', v, w)) return undefined; }
        return { goto: ins.target };
      });
      s.skip = ins;
      return;
    }
    if (/^DEFAULT\s*:$/i.test(t)) {
      const s = top('TEST');
      if (s.any) s.ends.push(jump(line));
      if (s.skip) s.skip.target = code.length;
      s.skip = null; s.any = true;
      return;
    }
    if (/^ENDTEST$/i.test(t)) {
      const s = top('TEST'); stack.pop();
      if (s.skip) s.skip.target = code.length;
      for (const e of s.ends) e.target = code.length;
      return;
    }
    // GOTO
    if ((m = /^GOTO\s+([A-Za-z_]\w*)$/i.exec(t))) {
      const ins = jump(line); gotos.push([ins, K(m[1]), line]);
      return;
    }
    if (/^RETURN\b/i.test(t)) {
      const rest = t.slice(6).trim();
      const ast = rest ? parseExpr(rest) : null;
      if (proc.kind === 'FUNC' && !ast) throw new Error('FUNC 의 RETURN 에는 반환값이 필요합니다');
      emit(line, (vm, f) => ({ ret: ast ? evr(ast)(vm, f) : undefined }));
      return;
    }
    if (/^(EXIT|EXITCYCLE)$/i.test(t)) { emit(line, (vm) => { vm.print('EXIT: 프로그램 종료'); return { halt: true }; }); return; }
    if (/^RAISE\b/i.test(t)) { emit(line, () => { throw new RuntimeErr('ERR_RAISE', `RAISE ${t.slice(5).trim()}`); }); return; }
    if (/^(RETRY|TRYNEXT)$/i.test(t)) return;
    // 대입
    const ai = findAssign(t);
    if (ai > 0) {
      const lhs = parseExpr(t.slice(0, ai));
      if (!isLv(lhs)) throw new Error('대입문의 좌변이 변수가 아닙니다');
      const rhs = parseExpr(t.slice(ai + 2));
      emit(line, (vm, f) => { const c = cx(vm, f); let v = c.ev(rhs); if (v instanceof Sig) v = sigVal(vm.ctrl, v); assign(c, lhs, v); });
      return;
    }
    // 늦은 바인딩 호출 %"name"% args
    if ((m = /^%([\s\S]+?)%\s*([\s\S]*)$/.exec(t))) {
      const nameAst = parseExpr(m[1]);
      const p = new Parser(m[2]);
      const { args, named } = p.argList(';');
      emit(line, (vm, f) => {
        const c = cx(vm, f);
        const nm = String(c.ev(nameAst));
        const target = prog.procs[K(nm)];
        if (!target || target.kind !== 'PROC') throw new RuntimeErr('ERR_REFUNKPRC', `루틴 '${nm}' 을 찾을 수 없습니다`);
        return callProc(c, target, args, named);
      });
      return;
    }
    // 명령 / 루틴 호출
    const p = new Parser(t);
    const name = p.ident();
    if (p.isOp('(')) throw new Error(`'${name}' 뒤의 '(' — RAPID 루틴 호출은 'name arg1, arg2;' 형식입니다`);
    const { args, named } = p.argList(';');
    const U = K(name);
    const builtin = INSTR[U];
    if (builtin) {
      if (!IGNORE_REST.has(U) && !p.eof()) throw new Error(`인자 형식 오류: '${p.peek().v}'`);
      const run = builtin({ args, named, line, prog, ctrl, name });
      if (run) emit(line, run);
      return;
    }
    if (IGNORED.has(U)) return;
    if (!p.eof()) throw new Error(`인자 형식 오류: '${p.peek().v}'`);
    pending.push({ name, file, line });
    emit(line, (vm, f) => {
      const target = prog.procs[U];
      if (!target || target.kind !== 'PROC') throw new RuntimeErr('ERR_REFUNKPRC', `'${name}' 은 PROC 가 아닙니다`);
      return callProc(cx(vm, f), target, args, named);
    });
  }

  for (const s of body) {
    at(file, s.line, () => stmt(s.text, s.line));
  }
  if (stack.length) throw new CompileError(`${stack[stack.length - 1].k} 블록이 닫히지 않았습니다`, file, body.at(-1)?.line ?? proc.line);
  for (const [ins, lbl, line] of gotos) {
    if (proc.labels[lbl] === undefined) throw new CompileError(`라벨 '${lbl}' 이 없습니다`, file, line);
    ins.target = proc.labels[lbl];
  }
}

function callProc(c, target, args, named) {
  const a = args.map((ast) => ({ ast }));
  const nm = {};
  for (const [k, v] of Object.entries(named || {})) nm[k] = v === true ? true : { ast: v };
  const { locals, writeBack } = bindArgs(c, target, a, nm);
  return { call: { proc: target, args: [], locals, onReturn: () => writeBack() } };
}

// ------------------------------------------------------------------ 명령어
const IGNORED = new Set(['ACCSET', 'SINGAREA', 'GRIPLOAD', 'PATHACCLIM', 'WORLDACCLIM', 'TPERASE', 'CIRPATHMODE', 'IDELETE', 'ISIGNALDI', 'ISIGNALDO',
  'ITIMER', 'IENABLE', 'IDISABLE', 'ISLEEP', 'IWATCH', 'CONNECT', 'SOFTACT', 'SOFTDEACT', 'STOREPATH', 'RESTOPATH', 'MOTIONSUP', 'LOADID', 'TRIGGIO', 'TRIGGEQUIP',
  'STOPMOVE', 'STARTMOVE', 'CLEARPATH', 'ERRLOG', 'SKIPWARN', 'RESETRETRYCOUNT', 'SETAO', 'SETGO', 'CORRCON', 'CORRDISCON', 'PATHRESOL', 'CONFJ_', 'SPEEDREFRESH',
  'ACTUNIT', 'DEACTUNIT', 'TUNESERVO', 'SETSYSDATA', 'TPSHOW', 'UILISTVIEW', 'STEPBWDPATH', 'WAITSYNCTASK', 'SYNCMOVEON', 'SYNCMOVEOFF', 'CIRCPATHMODE']);
const IGNORE_REST = new Set(['CONNECT', 'ISIGNALDI', 'ISIGNALDO', 'ITIMER']);

const evalArg = (c, ast) => (ast === true || ast === undefined ? ast : c.ev(ast));
function namedVals(c, named) { const o = {}; for (const [k, v] of Object.entries(named)) o[k] = v === true ? true : c.ev(v); return o; }
// 신호 인자: 식별자 그대로 이름으로 사용 (선언된 변수면 그 값)
function sigArg(c, ast, type) {
  if (ast?.t === 'id') {
    const u = K(ast.name);
    if (!c.frame?.locals.has(u) && !c.prog.globals.has(u)) return c.ctrl.signalNo(type, ast.name);
  }
  return sigNo(c.ctrl, c.ev(ast), type);
}

function speedOf(c, sp, nm, kind) {
  const s = asRec('speeddata', sp);
  let v = nm.V !== undefined ? num(nm.V) : s.v_tcp;
  v = Math.min(v * c.st.velOv / 100, c.st.velMax);
  if (kind === 'J') return { frac: Math.max(0.001, Math.min(1, v / 1500)) };
  return { tcp: Math.max(0.1, v), rot: Math.max(1, s.v_ori * c.st.velOv / 100) };
}

async function doMove(c, kind, { target, via, sp, zn, tool, nm }) {
  const ctrl = c.ctrl;
  const td = tool === undefined ? null : asRec('tooldata', tool);
  const toolPose = td ? poseOf(td.tframe) : (c.st.tool ?? ctrl.tool);
  const wd = nm.WOBJ !== undefined ? asRec('wobjdata', nm.WOBJ) : null;
  const base = wd ? wobjPose(wd) : null;
  const speed = speedOf(c, sp, nm, kind === 'A' ? 'J' : kind);
  // zonedata → 블렌딩 반경(mm). fine 또는 Inpos 는 정위치 정지, Z:= 는 반경 직접 지정
  let zone = 0;
  if (zn !== undefined && !nm.INPOS) {
    const zd = asRec('zonedata', zn);
    zone = zd.finep ? 0 : num(zd.pzone_tcp);
    if (nm.Z !== undefined) zone = num(nm.Z);
  }
  let tg, vtg;
  if (kind === 'A') {
    const jt = asRec('jointtarget', target);
    const r = jt.robax;
    tg = { joints: [r.rax_1, r.rax_2, r.rax_3, r.rax_4, r.rax_5, r.rax_6] };
  } else {
    const rt = asRec('robtarget', target);
    tg = { pose: poseOf(rt) };
    if (kind === 'J' ? c.st.confJ : false) tg.cfgFilter = confFilter(rt.robconf);
    if (via !== undefined) vtg = { pose: poseOf(asRec('robtarget', via)) };
  }
  c.st.tool = toolPose; c.st.toolData = td; c.st.wobj = base; c.st.wobjData = wd;
  ctrl.toolOverride = toolPose;
  ctrl.base = base;
  await c.vm.move({ kind: kind === 'A' ? 'J' : kind, target: tg, via: vtg, speed, zone, tool: toolPose, base });
}

function moveInstr(kind, withVia, withDO) {
  return ({ args, named }) => {
    const need = (withVia ? 5 : 4) + (withDO ? 2 : 0);
    if (args.length < need) throw new Error(`인자가 부족합니다 (필요 ${need}, 발견 ${args.length})`);
    return async (vm, f) => {
      const c = new Ctx(vm.prog, vm.ctrl, vm, f);
      const nm = namedVals(c, named);
      let k = 0;
      const via = withVia ? c.ev(args[k++]) : undefined;
      const target = c.ev(args[k++]);
      const sp = c.ev(args[k++]);
      const zn = c.ev(args[k++]);
      const tool = c.ev(args[k++]);
      await doMove(c, kind, { target, via, sp, zn, tool, nm });
      if (withDO) {
        const n = sigArg(c, args[k++], 'do');
        vm.ctrl.setDO(n, truthy(num(c.ev(args[k++]))));
      }
    };
  };
}

function setSig(vmc, n, v) { vmc.setDO(n, v); }

const INSTR = {
  MOVEJ: moveInstr('J', false, false),
  MOVEL: moveInstr('L', false, false),
  MOVEC: moveInstr('C', true, false),
  MOVEABSJ: moveInstr('A', false, false),
  MOVEJDO: moveInstr('J', false, true),
  MOVELDO: moveInstr('L', false, true),
  MOVECDO: moveInstr('C', true, true),
  WAITTIME: ({ args }) => async (vm, f) => { const c = new Ctx(vm.prog, vm.ctrl, vm, f); await vm.wait(Math.max(0, num(c.ev(args[0])))); },
  WAITDI: ({ args, named }) => waitSig('di', args, named),
  WAITDO: ({ args, named }) => waitSig('do', args, named),
  WAITUNTIL: ({ args, named }) => async (vm, f) => {
    const c = new Ctx(vm.prog, vm.ctrl, vm, f);
    const { TIMEFLAG, ...rest } = named;
    const nm = namedVals(c, rest);
    const maxT = nm.MAXTIME !== undefined ? num(nm.MAXTIME) : Infinity;
    const cond = () => { let v = c.ev(args[0]); if (v instanceof Sig) v = sigVal(vm.ctrl, v); return truthy(v); };
    const ok = await vm.waitUntil(cond, maxT);
    if (named.TIMEFLAG && named.TIMEFLAG !== true) { assign(c, named.TIMEFLAG, !ok); return; }
    if (!ok) throw new RuntimeErr('ERR_WAIT_MAXTIME', 'WaitUntil: 최대 대기 시간 초과');
  },
  SETDO: ({ args }) => (vm, f) => { const c = new Ctx(vm.prog, vm.ctrl, vm, f); vm.ctrl.setDO(sigArg(c, args[0], 'do'), truthy(num(c.ev(args[1])))); },
  SET: ({ args }) => (vm, f) => { const c = new Ctx(vm.prog, vm.ctrl, vm, f); vm.ctrl.setDO(sigArg(c, args[0], 'do'), true); },
  RESET: ({ args }) => (vm, f) => { const c = new Ctx(vm.prog, vm.ctrl, vm, f); vm.ctrl.setDO(sigArg(c, args[0], 'do'), false); },
  INVERTDO: ({ args }) => (vm, f) => { const c = new Ctx(vm.prog, vm.ctrl, vm, f); const n = sigArg(c, args[0], 'do'); vm.ctrl.setDO(n, !vm.ctrl.getDO(n)); },
  PULSEDO: ({ args, named }) => (vm, f) => {
    const c = new Ctx(vm.prog, vm.ctrl, vm, f);
    const nm = namedVals(c, named);
    const n = sigArg(c, args[0], 'do');
    const len = nm.PLENGTH !== undefined ? num(nm.PLENGTH) : 0.2;
    const ctrl = vm.ctrl;
    if (nm.HIGH) { ctrl.setDO(n, true); return; }
    const was = ctrl.getDO(n);
    ctrl.setDO(n, !was);
    setTimeout(() => ctrl.setDO(n, was), len * 1000);
  },
  TPWRITE: ({ args, named }) => (vm, f) => {
    const c = new Ctx(vm.prog, vm.ctrl, vm, f);
    const nm = namedVals(c, named);
    let s = String(c.ev(args[0]));
    if (nm.NUM !== undefined) s += fmtNum(num(nm.NUM));
    if (nm.DNUM !== undefined) s += fmtNum(num(nm.DNUM));
    if (nm.BOOL !== undefined) s += nm.BOOL ? 'TRUE' : 'FALSE';
    if (nm.POS !== undefined) s += formatValue(nm.POS);
    if (nm.ORIENT !== undefined) s += formatValue(nm.ORIENT);
    vm.print(s);
  },
  ERRWRITE: ({ args }) => (vm, f) => { const c = new Ctx(vm.prog, vm.ctrl, vm, f); vm.print(`[ErrWrite] ${args.map((a) => c.ev(a)).join(' / ')}`); },
  STOP: () => (vm) => { vm.print('Stop: 프로그램 정지 (재시작 시 계속)'); vm.ctrl.hold(); },
  BREAK: () => (vm) => { vm.ctrl.hold(); },
  INCR: ({ args }) => (vm, f) => { const c = new Ctx(vm.prog, vm.ctrl, vm, f); assign(c, args[0], num(c.ev(args[0])) + 1); },
  DECR: ({ args }) => (vm, f) => { const c = new Ctx(vm.prog, vm.ctrl, vm, f); assign(c, args[0], num(c.ev(args[0])) - 1); },
  ADD: ({ args }) => (vm, f) => { const c = new Ctx(vm.prog, vm.ctrl, vm, f); assign(c, args[0], num(c.ev(args[0])) + num(c.ev(args[1]))); },
  CLEAR: ({ args }) => (vm, f) => { const c = new Ctx(vm.prog, vm.ctrl, vm, f); assign(c, args[0], 0); },
  CONFJ: ({ named }) => (vm) => { vm.rapid.confJ = !named.OFF; },
  CONFL: ({ named }) => (vm) => { vm.rapid.confL = !named.OFF; },
  VELSET: ({ args }) => (vm, f) => {
    const c = new Ctx(vm.prog, vm.ctrl, vm, f);
    vm.rapid.velOv = Math.max(0.01, num(c.ev(args[0])));
    vm.rapid.velMax = Math.max(0.1, num(c.ev(args[1])));
  },
  CLKRESET: ({ args }) => (vm, f) => { const c = new Ctx(vm.prog, vm.ctrl, vm, f); assign(c, args[0], { $type: 'clock', acc: 0, start: performance.now(), running: false }); },
  CLKSTART: ({ args }) => (vm, f) => { const c = new Ctx(vm.prog, vm.ctrl, vm, f); const k = asRec('clock', c.ev(args[0])); if (!k.running) { k.start = performance.now(); k.running = true; } },
  CLKSTOP: ({ args }) => (vm, f) => { const c = new Ctx(vm.prog, vm.ctrl, vm, f); const k = asRec('clock', c.ev(args[0])); if (k.running) { k.acc += (performance.now() - k.start) / 1000; k.running = false; } },
};

function waitSig(type, args, named) {
  return async (vm, f) => {
    const c = new Ctx(vm.prog, vm.ctrl, vm, f);
    const n = sigArg(c, args[0], type);
    const want = truthy(num(c.ev(args[1])));
    const maxT = named.MAXTIME && named.MAXTIME !== true ? num(c.ev(named.MAXTIME)) : Infinity;
    const get = type === 'di' ? () => vm.ctrl.getDI(n) : () => vm.ctrl.getDO(n);
    const ok = await vm.waitUntil(() => get() === want, maxT);
    if (named.TIMEFLAG && named.TIMEFLAG !== true) { assign(c, named.TIMEFLAG, !ok); return; }
    if (!ok) throw new RuntimeErr('ERR_WAIT_MAXTIME', `Wait${type.toUpperCase()}: 최대 대기 시간 초과 (${type.toUpperCase()}${n})`);
  };
}

// ------------------------------------------------------------------ 통신용 변수 접근
function resolveVar(ctrl, name) {
  const prog = ctrl.program;
  if (!prog || prog.lang !== 'rapid') return null;
  const parts = String(name).split('/').filter(Boolean);
  let sym = parts.pop() || '';
  const path = sym.split('.');
  sym = path.shift();
  const key = K(sym);
  const meta = prog.meta.get(key);
  if (!meta || !prog.globals.has(key)) return null;
  if (parts.length) {
    const mod = parts[parts.length - 1];
    if (prog.modules[K(mod)] && K(meta.module) !== K(mod)) return null;
  }
  return { prog, key, meta, path };
}

function readVar(ctrl, name) {
  const r = resolveVar(ctrl, name);
  if (!r) return undefined;
  let v = r.prog.globals.get(r.key);
  for (const f of r.path) { v = v?.[f.toLowerCase()]; if (v === undefined) return undefined; }
  return formatValue(v);
}

function writeVar(ctrl, name, value) {
  const r = resolveVar(ctrl, name);
  if (!r || r.meta.kind === 'CONST') return false;
  try {
    let v = typeof value === 'string' ? parseValue(value) : value;
    if (!r.path.length) {
      v = r.meta.dims?.length ? coerceDecl(r.meta.type, r.meta.dims, v, r.prog.schema) : coerce(r.meta.type, v, r.prog.schema);
      r.prog.globals.set(r.key, v);
      return true;
    }
    let obj = r.prog.globals.get(r.key);
    let type = r.meta.type;
    for (let i = 0; i < r.path.length; i++) {
      const f = r.path[i].toLowerCase();
      const ft = r.prog.schema[type]?.find(([n]) => n === f)?.[1];
      if (!ft || !obj || typeof obj !== 'object') return false;
      if (i === r.path.length - 1) obj[f] = coerce(ft, v, r.prog.schema);
      else { obj = obj[f]; type = ft; }
    }
    return true;
  } catch { return false; }
}

// ------------------------------------------------------------------ 예제 프로그램
const f2 = (v) => { const r = Math.round(v * 100) / 100; return String(Object.is(r, -0) ? 0 : r); };
const f6 = (v) => { const r = +v.toFixed(6); return String(Object.is(r, -0) ? 0 : r); };
const NINES = '[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]';

function defaultFiles(ctrl) {
  const r = ctrl.robot;
  const g = ctrl.gripper ?? { tcp: [0, 0, 150, 0, 0, 0], mass: 1, name: 'Gripper', maker: '' };
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
  const rt = (p, j) => `[[${p.map(f2).join(',')}],[0,0,1,0],[${[quad(j[0]), quad(j[3]), quad(j[5]), 0].join(',')}],${NINES}]`;
  const picks = [], places = [], skipped = [];
  const dxs = [0.17, -0.15, 0.25, -0.2, 0];
  for (const o of ctrl.objects) {
    const save0 = ref;
    const pp = [o.pose.p[0], o.pose.p[1], o.pose.p[2]];
    const ja = solve([pp[0], pp[1], pp[2] + APP]);
    const jp = ja && solve(pp);
    let ok = null;
    if (jp) {
      for (const dx of dxs) {
        const q = [pp[0] + dx * R, pp[1], pp[2]];
        const save = ref;
        const a = solve([q[0], q[1], q[2] + APP]), b = a && solve(q);
        if (a && b) { ok = rt(q, b); break; }
        ref = save;
      }
    }
    // 도달 불가 공작물은 예제에서 제외 (주석으로 표시)
    if (!ok) { ref = save0; skipped.push(o.id); continue; }
    picks.push(rt(pp, jp));
    places.push(ok);
  }
  if (!picks.length) {
    return { 'MainModule.mod': `MODULE MainModule\n  ! ${r.name}: 공작물 위치에 도달할 수 없어 예제를 생성하지 못했습니다\n  CONST jointtarget jHome:=[[${r.home.map(f2).join(',')}],${NINES}];\n  PROC main()\n    MoveAbsJ jHome, v1000, fine, tool0;\n  ENDPROC\nENDMODULE\n` };
  }
  const q = quatFromR(tool.R);
  const mass = g.mass || 0.5;
  const cogZ = f2(Math.max(1, g.tcp[2] / 2));
  const tGripper = `[TRUE,[[${g.tcp.slice(0, 3).map(f2).join(',')}],[${q.map(f6).join(',')}]],[${f2(mass)},[0,0,${cogZ}],[1,0,0,0],0,0,0]]`;
  const home = `[[${r.home.map(f2).join(',')}],${NINES}]`;
  const n = picks.length;
  const txt = `MODULE MainModule
  !=====================================================================
  ! ${r.name} 픽 앤 플레이스 예제 (RobotEmulator 자동 생성)
  ! 그리퍼: ${g.maker} ${g.name}
  ! IO: DO1=그리퍼 닫기, DO2=그리퍼 열기, DI1=닫힘 확인, DI2=열림 확인${skipped.length ? `\n  ! 도달 불가로 제외된 공작물: ${skipped.join(', ')}` : ''}
  !=====================================================================
  PERS tooldata tGripper:=${tGripper};
  CONST jointtarget jHome:=${home};
  CONST num nParts:=${n};
  CONST num nApproach:=${APP};
  ! 공작물 집는 위치 (TCP, 공작물 중심)
  CONST robtarget pPick{${n}}:=[
    ${picks.join(',\n    ')}];
  ! 공작물 내려놓는 위치
  CONST robtarget pPlace{${n}}:=[
    ${places.join(',\n    ')}];
  CONST speeddata vApproach:=[200,500,5000,1000];
  VAR num nCount:=0;

  PROC main()
    rInit;
    FOR i FROM 1 TO nParts DO
      rPick pPick{i};
      rPlace pPlace{i};
      Incr nCount;
      TPWrite "완료된 공작물 수: "\\Num:=nCount;
    ENDFOR
    MoveAbsJ jHome, v1000, fine, tGripper;
    TPWrite "사이클 완료";
  ENDPROC

  PROC rInit()
    ConfJ \\On;
    ConfL \\Off;
    VelSet 100, ${r.tcpMaxSpeed};
    nCount:=0;
    rGripOpen;
    MoveAbsJ jHome, v1000, fine, tGripper;
  ENDPROC

  PROC rPick(robtarget pTarget)
    MoveJ Offs(pTarget,0,0,nApproach), v1000, z50, tGripper\\WObj:=wobj0;
    MoveL pTarget, vApproach, fine, tGripper\\WObj:=wobj0;
    rGripClose;
    MoveL Offs(pTarget,0,0,nApproach), v500, z10, tGripper\\WObj:=wobj0;
  ENDPROC

  PROC rPlace(robtarget pTarget)
    MoveJ Offs(pTarget,0,0,nApproach), v1000, z50, tGripper\\WObj:=wobj0;
    MoveL pTarget, vApproach, fine, tGripper\\WObj:=wobj0;
    rGripOpen;
    MoveL Offs(pTarget,0,0,nApproach), v500, z10, tGripper\\WObj:=wobj0;
  ENDPROC

  PROC rGripClose()
    SetDO DO2, 0;
    SetDO DO1, 1;
    WaitDI DI1, 1\\MaxTime:=5;
    WaitTime 0.2;
  ENDPROC

  PROC rGripOpen()
    SetDO DO1, 0;
    SetDO DO2, 1;
    WaitDI DI2, 1\\MaxTime:=5;
    SetDO DO2, 0;
    WaitTime 0.2;
  ENDPROC
ENDMODULE
`;
  return { 'MainModule.mod': txt };
}

function pickMain(names, files) {
  const mods = names.filter((n) => EXTS.some((e) => n.toLowerCase().endsWith(e)));
  for (const n of mods) if (/^\s*(?:LOCAL\s+)?PROC\s+main\s*\(/im.test(files?.get?.(n) ?? '')) return n;
  return mods[0] ?? names[0] ?? null;
}

export default {
  id: 'rapid', name: 'ABB RAPID', exts: EXTS,
  compile, pickMain, defaultFiles, readVar, writeVar,
  formatValue, parseValue,
};
