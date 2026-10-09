// Kawasaki AS 언어 (KIDE / AS 터미널 SAVE 형식 .as / .pg)
//
// ── 파일 구조 ──────────────────────────────────────────────────────────────
//   .PROGRAM name(a, .b) ... .END     프로그램 (한 파일에 여러 개, 여러 파일에 걸쳐 정의 가능)
//   .TRANS    name x y z o a t         변환값(직교 위치, OAT = ZYZ 오일러)
//   .JOINTS   #name j1 .. j6           관절값
//   .REALS    name = value             실수 변수
//   .STRINGS  $name = "..."            문자열 변수
//   그 외 .INTER_PANEL_* / .AUXDATA / .SYSDATA 등 '.' 섹션은 .END 까지 무시. '.**' 헤더 주석 무시.
//
// ── 변수 저장 규약 (ctrl.regs, 키는 모두 대문자) ───────────────────────────
//   R:NAME          실수            배열 원소는 R:NAME[1] / R:NAME[1,2]
//   S:$NAME         문자열
//   T:NAME          변환값 → 내부 표현 {p:[x,y,z], R:3x3}
//   J:#NAME         관절값 → 내부 표현 {j:[6 deg]}
//   SIG:n           내부 신호(2001~2999) 상태
//   TIMER:n         타이머 기준 시각(performance.now ms)
//   __AS_LOADED__:파일명   데이터 섹션 적용 표시 (파일 내용이 바뀌었을 때만 다시 적용 → HERE 로 티칭한 값 유지)
//   로컬 변수(.name, 프로그램 인자)는 frame.locals 에 '.' 을 뗀 대문자 이름으로 저장 (예: .$s → '$S').
//   프로그램 인자는 참조 전달: 실인자가 변수이면 RETURN 시 값을 되돌려 쓴다.
//
// ── 진입 프로그램 ───────────────────────────────────────────────────────────
//   compile(files, main): main 파일 안에서 ctrl.asEntry(터미널 EXECUTE 로 지정) → 'main' → 'pg0' → 첫 .PROGRAM 순으로 선택.
//   pickMain: 'main' 프로그램이 있는 파일 → 'pg0' 이 있는 파일 → .PROGRAM 이 있는 첫 파일.
//
// ── 기타 규약 ───────────────────────────────────────────────────────────────
//   논리값 TRUE = -1, FALSE = 0. 신호 번호: 1~512 = 출력(DO n), 1001~1512 = 입력(DI n-1000), 2001~ = 내부 신호.
//   SPEED (ALWAYS 없음) 은 다음 한 번의 동작에만 적용, 이후 ALWAYS 속도(기본 100%)로 복귀.
//   C1MOVE 는 경유점을 기억만 하고, 다음 C2MOVE 에서 현재 위치→경유점→종점 원호를 한 번에 실행한다.
import { Parser, evaluate, truthy, SyntaxErr } from './expr.js';
import { CompileError, RuntimeErr, splitTop, stripComment, at } from './common.js';
import { fromVendorPose, toVendorPose } from '../../shared/poseformat.js';
import { poseMul, poseInv, add, sub, norm, cross, scale, Rx, Ry, Rz, I3, DEG, RAD, RfromZYX } from '../../shared/math.js';
import { fkTcp, ikNearest, tcpToFlange } from '../../shared/kinematics.js';
import { VM } from '../vm.js';

// ============================================================ 값 헬퍼
const isT = (v) => !!v && typeof v === 'object' && Array.isArray(v.R) && Array.isArray(v.p);
const isJ = (v) => !!v && typeof v === 'object' && Array.isArray(v.j);
const mkT = (a) => fromVendorPose('kawasaki', [0, 1, 2, 3, 4, 5].map((i) => Number(a[i] ?? 0) || 0));
const mkJ = (a) => ({ j: [0, 1, 2, 3, 4, 5].map((i) => Number(a[i] ?? 0) || 0) });
const NULLT = () => ({ p: [0, 0, 0], R: I3() });
const B = (b) => (b ? -1 : 0);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function tOf(ctrl, v) {
  if (isT(v)) return v;
  if (isJ(v)) return fkTcp(ctrl.robot, v.j, ctrl.tool, ctrl.base);
  throw new RuntimeErr('AS', '위치 데이터(변환값/관절값)가 필요합니다');
}
function jOf(ctrl, v) {
  if (isJ(v)) return v;
  if (isT(v)) {
    const j = ikNearest(ctrl.robot, tcpToFlange(v, ctrl.tool, ctrl.base), ctrl.joints);
    if (!j) throw new RuntimeErr('UNREACHABLE', '관절값으로 변환할 수 없습니다 (도달 불가 위치)');
    return { j };
  }
  throw new RuntimeErr('AS', '위치 데이터(변환값/관절값)가 필요합니다');
}
const num = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? -1 : 0;
  throw new RuntimeErr('AS', `실수 값이 필요합니다 (${typeof v === 'string' ? '문자열' : '위치'})`);
};

export function fmtNum(v) {
  if (typeof v !== 'number') return String(v);
  if (Number.isInteger(v)) return String(v);
  return String(parseFloat(v.toFixed(5)));
}

// ============================================================ 변수 저장소
// 이름: 토큰 텍스트 (로컬은 전처리로 '_L_' 접두사). 반환 {local, name(대문자, '.' 제외)}
function parseName(id) {
  const up = String(id).toUpperCase();
  if (up.startsWith('_L_')) return { local: true, name: up.slice(3) };
  if (up.startsWith('.')) return { local: true, name: up.slice(1) };
  return { local: false, name: up };
}
const keyOf = (name, idx) => (idx && idx.length ? `${name}[${idx.map((n) => Math.round(num(n))).join(',')}]` : name);

function readV(ctrl, frame, id, idx, ctx) {
  const { local, name } = parseName(id);
  const k = keyOf(name, idx);
  if (local || frame?.locals?.has(k)) {
    const v = frame?.locals?.get(k);
    if (v === undefined) throw new RuntimeErr('AS', `값이 정의되지 않은 로컬 변수: .${k}`);
    return v;
  }
  const kinds = name[0] === '$' ? ['S'] : name[0] === '#' ? ['J'] : ctx === 'pose' ? ['T', 'R'] : ['R', 'T'];
  for (const K of kinds) {
    const v = ctrl.regs.get(`${K}:${k}`);
    if (v !== undefined) return v;
  }
  throw new RuntimeErr('AS', `값이 정의되지 않은 변수: ${k}`);
}

function globalKind(name, value) {
  if (name[0] === '$') { if (typeof value !== 'string') throw new RuntimeErr('AS', `${name} 에는 문자열만 대입할 수 있습니다`); return 'S'; }
  if (name[0] === '#') { if (!isJ(value)) throw new RuntimeErr('AS', `${name} 에는 관절값만 대입할 수 있습니다`); return 'J'; }
  if (isT(value)) return 'T';
  if (typeof value === 'number') return 'R';
  if (typeof value === 'boolean') return 'R';
  throw new RuntimeErr('AS', `${name} 에 대입할 수 없는 값입니다`);
}

function writeV(ctrl, frame, id, idx, value) {
  const { local, name } = parseName(id);
  const k = keyOf(name, idx);
  if (typeof value === 'boolean') value = value ? -1 : 0;
  if (local || frame?.locals?.has(k)) { frame.locals.set(k, value); return; }
  ctrl.regs.set(`${globalKind(name, value)}:${k}`, value);
}

// ============================================================ 신호
function sigGet(ctrl, n) {
  n = Math.round(num(n));
  const a = Math.abs(n);
  let v;
  if (a >= 1 && a <= 512) v = ctrl.getDO(a);
  else if (a >= 1001 && a <= 1512) v = ctrl.getDI(a - 1000);
  else if (a >= 2001 && a <= 2999) v = !!ctrl.regs.get('SIG:' + a);
  else throw new RuntimeErr('AS', `신호 번호 범위 초과: ${n}`);
  return n < 0 ? !v : v;
}
function sigSet(ctrl, a, on) {
  a = Math.abs(Math.round(num(a)));
  if (a >= 1 && a <= 512) ctrl.setDO(a, on);
  else if (a >= 2001 && a <= 2999) ctrl.regs.set('SIG:' + a, !!on);
  else if (a >= 1001 && a <= 1512) throw new RuntimeErr('AS', `입력 신호 ${a} 에는 출력할 수 없습니다`);
  else throw new RuntimeErr('AS', `신호 번호 범위 초과: ${a}`);
}

// ============================================================ 함수
function frameFn(a, b, c, d) {
  const x0 = sub(b.p, a.p), nx = norm(x0);
  if (nx < 1e-9) throw new RuntimeErr('AS', 'FRAME: 원점과 X 방향 점이 같습니다');
  const x = scale(x0, 1 / nx);
  let z = cross(x, sub(c.p, a.p));
  const nz = norm(z);
  if (nz < 1e-9) throw new RuntimeErr('AS', 'FRAME: 세 점이 일직선입니다');
  z = scale(z, 1 / nz);
  const y = cross(z, x);
  return { p: [...d.p], R: [[x[0], y[0], z[0]], [x[1], y[1], z[1]], [x[2], y[2], z[2]]] };
}

function callFn(vm, frame, fn, args) {
  const ctrl = vm.ctrl;
  const n = (i) => num(args[i] ?? 0);
  const s = (i) => { if (typeof args[i] !== 'string') throw new RuntimeErr('AS', `${fn}: 문자열 인자가 필요합니다`); return args[i]; };
  switch (fn) {
    case 'TRANS': return mkT(args.map((v) => (v === undefined ? 0 : num(v))));
    case '#PPOINT': return mkJ(args.map((v) => (v === undefined ? 0 : num(v))));
    case 'SHIFT': { const p = tOf(ctrl, args[0]); return { p: add(p.p, [n(1), n(2), n(3)]), R: p.R }; }
    case 'DX': return tOf(ctrl, args[0]).p[0];
    case 'DY': return tOf(ctrl, args[0]).p[1];
    case 'DZ': return tOf(ctrl, args[0]).p[2];
    case 'INVERSE': return poseInv(tOf(ctrl, args[0]));
    case 'RX': return { p: [0, 0, 0], R: Rx(n(0) * DEG) };
    case 'RY': return { p: [0, 0, 0], R: Ry(n(0) * DEG) };
    case 'RZ': return { p: [0, 0, 0], R: Rz(n(0) * DEG) };
    case 'FRAME': return frameFn(...[0, 1, 2, 3].map((i) => tOf(ctrl, args[i])));
    case 'DISTANCE': return norm(sub(tOf(ctrl, args[0]).p, tOf(ctrl, args[1]).p));
    case 'ABS': return Math.abs(n(0));
    case 'SQRT': if (n(0) < 0) throw new RuntimeErr('AS', 'SQRT: 음수'); return Math.sqrt(n(0));
    case 'SIN': return Math.sin(n(0) * DEG);
    case 'COS': return Math.cos(n(0) * DEG);
    case 'TAN': return Math.tan(n(0) * DEG);
    case 'ASIN': return Math.asin(clamp(n(0), -1, 1)) * RAD;
    case 'ACOS': return Math.acos(clamp(n(0), -1, 1)) * RAD;
    case 'ATAN2': return Math.atan2(n(0), n(1)) * RAD;
    case 'INT': return Math.trunc(n(0));
    case 'SIGN': return Math.sign(n(0));
    case 'MAXVAL': return Math.max(...args.map(num));
    case 'MINVAL': return Math.min(...args.map(num));
    case 'RANDOM': return Math.random();
    case 'SIG': return B(args.every((a) => sigGet(ctrl, a)));
    case 'BITS': {
      const st = Math.round(n(0)), cnt = Math.round(args.length > 1 ? n(1) : 1);
      let v = 0;
      for (let i = 0; i < cnt; i++) if (sigGet(ctrl, st + i)) v |= 1 << i;
      return v;
    }
    case 'TIMER': {
      const t0 = ctrl.regs.get('TIMER:' + Math.round(n(0)));
      return (performance.now() - (t0 ?? 0)) / 1000;
    }
    case 'LEN': return s(0).length;
    case 'VAL': return Number(s(0)) || 0;
    case 'ASC': return s(0).charCodeAt(args.length > 1 ? n(1) - 1 : 0) || 0;
    case '$CHR': return String.fromCharCode(n(0));
    case '$LEFT': return s(0).slice(0, n(1));
    case '$RIGHT': return n(1) > 0 ? s(0).slice(-n(1)) : '';
    case '$MID': return s(0).substr(n(1) - 1, args.length > 2 ? n(2) : undefined);
    case '$ENCODE': return args.map((v) => (typeof v === 'string' ? v : formatValue(v))).join('');
    case '$ERROR': return `오류 ${n(0)}`;
  }
  throw new RuntimeErr('AS', `알 수 없는 함수: ${fn}`);
}

// 평가 환경. ctx: 'pose' 이면 이름 조회 시 변환값을 실수보다 우선
const POSE_REF = '@POSE'; // 위치 인자 조회용 내부 함수명 (토크나이저가 만들 수 없는 이름)
function env(vm, frame, ctx) {
  const ctrl = vm.ctrl;
  return {
    numericBool: true,
    get(name) { return getId(vm, frame, name.toUpperCase(), ctx); },
    index(obj, idx) { return readV(ctrl, frame, obj, idx, ctx); },
    call(fn, args) {
      if (fn === POSE_REF) return args.length > 1 ? readV(ctrl, frame, args[0], args.slice(1), 'pose') : getId(vm, frame, args[0].toUpperCase(), 'pose');
      return callFn(vm, frame, fn.toUpperCase(), args);
    },
    binop(op, a, b) {
      const pa = isT(a) || isJ(a), pb = isT(b) || isJ(b);
      if (!pa && !pb) return undefined;
      if (op === '+') return poseMul(tOf(ctrl, a), tOf(ctrl, b));
      if (op === '-') return poseMul(tOf(ctrl, a), poseInv(tOf(ctrl, b)));
      throw new RuntimeErr('AS', `위치 데이터에 연산자 ${op} 를 사용할 수 없습니다`);
    },
    neg(a) { return isT(a) || isJ(a) ? poseInv(tOf(ctrl, a)) : -num(a); },
  };
}
function getId(vm, frame, up, ctx) {
  const ctrl = vm.ctrl;
  switch (up) {
    case 'TRUE': case 'ON': return -1;
    case 'FALSE': case 'OFF': return 0;
    case 'PI': return Math.PI;
    case 'NULL': return NULLT();
    case 'HERE': return ctrl.tcpPose();
    case '#HERE': return { j: [...ctrl.joints] };
  }
  return readV(ctrl, frame, up, null, ctx);
}
const ev = (vm, frame, ast, ctx) => evaluate(ast, env(vm, frame, ctx));

// ============================================================ 출력 포맷
const pad = (s, w = 10) => String(s).padStart(w);
export function formatValue(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return fmtNum(v);
  if (typeof v === 'boolean') return v ? '-1' : '0';
  if (typeof v === 'string') return v;
  if (isJ(v)) return ['JT1', 'JT2', 'JT3', 'JT4', 'JT5', 'JT6'].map((s) => pad(s)).join('') + '\n' + v.j.map((x) => pad(x.toFixed(3))).join('');
  let arr = null;
  if (isT(v)) arr = toVendorPose('kawasaki', v);
  else if (Array.isArray(v) && v.length === 6 && v.every((x) => typeof x === 'number')) arr = v;
  if (arr) return ['X[mm]', 'Y[mm]', 'Z[mm]', 'O[deg]', 'A[deg]', 'T[deg]'].map((s) => pad(s)).join('') + '\n' + arr.map((x) => pad((Math.abs(x) < 5e-4 ? 0 : x).toFixed(3))).join('');
  if (Array.isArray(v)) return v.map(formatValue).join(' ');
  return String(v);
}

// 터미널 입력 문자열 → 값 ("abc" → 문자열, "1 2 3 4 5 6" → 배열, "5" → 수)
export function parseValue(text) {
  const s = String(text).trim();
  const m = /^"(.*)"$/.exec(s);
  if (m) return m[1];
  const parts = s.split(/[\s,]+/).filter(Boolean);
  if (parts.length && parts.every((p) => p !== '' && Number.isFinite(Number(p)))) {
    const nums = parts.map(Number);
    return nums.length === 1 ? nums[0] : nums;
  }
  return s;
}

function whereText(ctrl) {
  return formatValue({ j: ctrl.joints }) + '\n' + formatValue(ctrl.tcpPose());
}

// ============================================================ 파일 스캔
const PROG_RE = /^\.PROGRAM\s+([A-Za-z_][\w.]*)\s*(?:\(([^)]*)\))?/i;

function scanFiles(files) {
  const progs = [], data = [];
  for (const [file, text0] of files) {
    const lines = String(text0).replace(/\r\n?/g, '\n').split('\n');
    let st = null, cur = null;
    for (let i = 0; i < lines.length; i++) {
      const ln = i + 1, raw = lines[i], t = raw.trim();
      if (st === 'PROG') {
        if (/^\.END(\s|;|$)/i.test(t)) { progs.push(cur); st = null; cur = null; } else cur.body.push({ line: ln, text: raw });
        continue;
      }
      if (st) {
        if (/^\.END(\s|;|$)/i.test(t)) st = null;
        else if (st !== 'SKIP' && t && !t.startsWith(';')) data.push({ file, line: ln, kind: st, text: t });
        continue;
      }
      if (!t || t.startsWith(';') || t.startsWith('.*')) continue;
      let m;
      if ((m = PROG_RE.exec(t))) {
        cur = { name: m[1], params: (m[2] || '').split(',').map((s) => s.trim()).filter(Boolean), file, line: ln, body: [] };
        st = 'PROG';
      } else if ((m = /^\.(TRANS|JOINTS|REALS|STRINGS)\s*(;.*)?$/i.exec(t))) st = m[1].toUpperCase();
      else if (t.startsWith('.')) st = 'SKIP';
      else throw new CompileError(`섹션(.PROGRAM / .TRANS 등) 밖의 문장: ${t}`, file, ln);
    }
    if (st === 'PROG') progs.push(cur); // .END 누락은 관대하게 허용
  }
  return { progs, data };
}

const NAME_IDX = /^([$#]?[A-Za-z_][\w.]*)\s*(?:\[([^\]]*)\])?$/;
function dataKey(nameText, file, line) {
  const m = NAME_IDX.exec(nameText.trim());
  if (!m) throw new CompileError(`잘못된 변수 이름: ${nameText}`, file, line);
  const idx = m[2] ? m[2].split(',').map((s) => Number(s.trim())) : null;
  return keyOf(m[1].toUpperCase(), idx);
}

function parseData(d) {
  const { file, line, text } = d;
  if (d.kind === 'TRANS' || d.kind === 'JOINTS') {
    const m = /^([$#]?[A-Za-z_][\w.]*\s*(?:\[[^\]]*\])?)\s*[,\s]\s*(.*)$/.exec(text);
    if (!m) throw new CompileError(`잘못된 위치 데이터: ${text}`, file, line);
    const vals = m[2].split(/[\s,]+/).filter(Boolean).map(Number);
    if (vals.some((v) => !Number.isFinite(v))) throw new CompileError(`잘못된 수치: ${text}`, file, line);
    if (d.kind === 'TRANS') return [`T:${dataKey(m[1], file, line)}`, mkT(vals)];
    let nm = m[1].trim(); if (!nm.startsWith('#')) nm = '#' + nm;
    return [`J:${dataKey(nm, file, line)}`, mkJ(vals)];
  }
  const m = /^([^=]+)=\s*(.*)$/.exec(text);
  if (!m) throw new CompileError(`잘못된 데이터: ${text}`, file, line);
  if (d.kind === 'REALS') {
    const v = Number(m[2].trim());
    if (!Number.isFinite(v)) throw new CompileError(`잘못된 실수 값: ${text}`, file, line);
    return [`R:${dataKey(m[1], file, line)}`, v];
  }
  let nm = m[1].trim(); if (!nm.startsWith('$')) nm = '$' + nm;
  const sm = /^"(.*)"\s*$/.exec(m[2].trim());
  return [`S:${dataKey(nm, file, line)}`, sm ? sm[1].replace(/""/g, '"') : m[2].trim()];
}

// 파일 내용이 바뀌었을 때만 데이터 섹션을 레지스터에 적용
function applyData(ctrl, files, data) {
  if (!ctrl?.regs) return;
  const parsed = data.map((d) => ({ file: d.file, kv: parseData(d) }));
  for (const [file, text] of files) {
    const mk = '__AS_LOADED__:' + file;
    if (ctrl.regs.get(mk) === text) continue;
    for (const p of parsed) if (p.file === file) ctrl.regs.set(p.kv[0], p.kv[1]);
    ctrl.regs.set(mk, text);
  }
}

// ============================================================ 문장 컴파일
// 로컬 변수 '.name' → '_L_name', SHIFT 의 'BY' → ','  (문자열 밖에서만)
function prep(s) {
  let out = '', inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') inStr = !inStr;
    if (!inStr) {
      const prev = s[i - 1] || '';
      if (c === '.' && /[A-Za-z_$#]/.test(s[i + 1] || '') && !/[A-Za-z0-9_$#\])]/.test(prev)) { out += '_L_'; continue; }
      if ((c === 'B' || c === 'b') && /^BY\b/i.test(s.slice(i)) && !/[A-Za-z0-9_$#]/.test(prev)) { out += ','; i++; continue; }
    }
    out += c;
  }
  return out;
}

// 배열 첨자 대상 이름을 문자열 노드로 바꿔 env.index 가 이름으로 조회하게 함
// 위치 인자를 받는 함수의 변수 인자는 변환값 우선으로 조회 (실수 변수와 이름이 같아도 위치를 택함)
const POSE_FNS = new Set(['SHIFT', 'DX', 'DY', 'DZ', 'INVERSE', 'DISTANCE', 'FRAME']);
function fixAst(n) {
  if (!n || typeof n !== 'object') return n;
  if (n.t === 'index' && n.obj.t === 'id') n.obj = { t: 'str', v: n.obj.name };
  if (n.t === 'call' && POSE_FNS.has(String(n.fn.name).toUpperCase())) {
    n.args = n.args.map((a) => {
      if (a.t === 'id') return { t: 'call', fn: { name: POSE_REF }, args: [{ t: 'str', v: a.name }], named: {} };
      if (a.t === 'index' && a.obj.t === 'id') return { t: 'call', fn: { name: POSE_REF }, args: [{ t: 'str', v: a.obj.name }, ...a.idx], named: {} };
      return a;
    });
  }
  for (const k of ['a', 'b', 'obj']) if (n[k]) fixAst(n[k]);
  for (const k of ['args', 'idx', 'items']) if (n[k]) n[k].forEach(fixAst);
  return n;
}
function E(text) {
  const src = text == null ? '' : String(text).trim();
  if (!src) throw new SyntaxErr('식이 필요합니다', 0);
  const p = new Parser(src);
  const e = p.expr();
  if (!p.eof()) throw new SyntaxErr(`식 뒤에 불필요한 토큰 '${p.peek().v}'`, p.peek().col);
  return fixAst(e);
}
// 대입 대상 (변수 / 배열 원소)
function LHS(text) {
  const n = E(text);
  if (n.t === 'id') return { name: n.name, idx: null };
  if (n.t === 'index' && n.obj.t === 'str') return { name: n.obj.v, idx: n.idx };
  throw new SyntaxErr(`대입할 수 없는 대상: ${text}`, 0);
}
const lhsIdx = (vm, frame, l) => (l.idx ? l.idx.map((x) => num(ev(vm, frame, x))) : null);
const assign = (vm, frame, l, v) => writeV(vm.ctrl, frame, l.name, lhsIdx(vm, frame, l), v);
const readL = (vm, frame, l) => readV(vm.ctrl, frame, l.name, lhsIdx(vm, frame, l), 'num');

const newState = () => ({ always: { v: 100, u: '%' }, next: null, accuracy: 1, accNext: null, c1: null });
const st = (vm) => (vm.as ??= newState());

// SPEED 인자: "50", "200 MM/S", "2 S", "50 ALWAYS"
function parseSpeedArgs(rest) {
  let s = rest.trim(), always = false, unit = '%';
  if (/\bALWAYS$/i.test(s)) { always = true; s = s.replace(/\bALWAYS$/i, '').trim(); }
  let m;
  if ((m = /^(.*?)\s*MM\/S$/i.exec(s))) { unit = 'mm/s'; s = m[1]; }
  else if ((m = /^(.*?)\s*MM\/MIN$/i.exec(s))) { unit = 'mm/min'; s = m[1]; }
  else if ((m = /^(.*\S)\s+S$/i.exec(s))) { unit = 's'; s = m[1]; }
  const first = splitTop(s, ',')[0];
  return { ast: E(first), unit, always };
}

// 속도 지정 → vm.move 의 speed
function speedOf(vm, kind, tg, pctOverride) {
  const ctrl = vm.ctrl, r = ctrl.robot, S = st(vm);
  let sp = S.next ?? S.always;
  S.next = null;
  if (pctOverride != null) sp = { v: pctOverride, u: '%' };
  const lin = kind !== 'J';
  const v = Math.max(1e-6, sp.v);
  switch (sp.u) {
    case 'mm/s': return lin ? { tcp: Math.min(v, r.tcpMaxSpeed) } : { frac: clamp(v / r.tcpMaxSpeed, 0.001, 1) };
    case 'mm/min': return lin ? { tcp: Math.min(v / 60, r.tcpMaxSpeed) } : { frac: clamp(v / 60 / r.tcpMaxSpeed, 0.001, 1) };
    case 's': {
      // 시간 지정 (근사): 이동량 / 시간
      if (!lin) {
        const j1 = tg.joints || ikNearest(r, tcpToFlange(tg.pose, ctrl.tool, ctrl.base), ctrl.joints);
        if (!j1) return { frac: 1 };
        let need = 0;
        for (let i = 0; i < 6; i++) need = Math.max(need, Math.abs(j1[i] - ctrl.joints[i]) / r.maxSpeed[i]);
        return { frac: clamp(need / v, 0.001, 1) };
      }
      const p1 = tg.pose ? tg.pose.p : fkTcp(r, tg.joints, ctrl.tool, ctrl.base).p;
      return { tcp: clamp(norm(sub(p1, ctrl.tcpPose().p)) / v, 1, r.tcpMaxSpeed) };
    }
    default: return lin ? { tcp: clamp(v / 100, 0.0001, 1) * r.tcpMaxSpeed } : { frac: clamp(v / 100, 0.001, 1) };
  }
}

const targetOf = (v) => {
  if (isJ(v)) return { joints: v.j };
  if (isT(v)) return { pose: v };
  throw new RuntimeErr('AS', '이동 목표는 위치 데이터여야 합니다');
};
async function doMove(vm, kind, val, opt = {}) {
  const tg = targetOf(val);
  // ACCURACY(mm) → 블렌딩 반경 (CP 모드). ALWAYS 없는 ACCURACY 는 다음 1회 동작에만 적용
  const S = st(vm);
  const acc = S.accNext ?? S.accuracy;
  S.accNext = null;
  const cmd = { kind, target: tg, speed: speedOf(vm, kind, tg, opt.pct), zone: acc > 1 ? acc : 0 };
  if (opt.via) cmd.via = targetOf(opt.via);
  await vm.move(cmd);
}

const KEYWORDS = new Set(('JMOVE LMOVE JAPPRO LAPPRO JDEPART LDEPART C1MOVE C2MOVE HOME DRAW TDRAW DELAY TWAIT STABLE SPEED ACCURACY ' +
  'ACCEL DECEL BREAK BRAKE CP TOOL BASE SIGNAL PULSE DLYSIG SWAIT BITS WAIT IF ELSE END WHILE DO UNTIL FOR CASE VALUE ANY ' +
  'CALL RETURN STOP HALT PAUSE PRINT TYPE GOTO POINT HERE DECOMPOSE TIMER RESET').split(' '));
const IGNORED = new Set(['STABLE', 'ACCEL', 'DECEL', 'CP']);

function compileProc(p, calls) {
  const code = [], labels = {}, fix = [], stack = [];
  const file = p.file;
  let line = 0, uid = 0;
  const emit = (run, extra = {}) => { const ins = { line, file, run, ...extra }; code.push(ins); return ins; };
  const jump = () => { const ins = emit(() => ({ goto: ins.target }), { target: -1 }); return ins; };
  const jumpIfNot = (cond) => { const ins = emit((vm, f) => (truthy(ev(vm, f, cond)) ? undefined : { goto: ins.target }), { target: -1 }); return ins; };
  const label = (s) => String(/^\d+$/.test(s) ? Number(s) : s.toUpperCase());

  function stmt(s0) {
    let s = s0;
    const kwm = /^([A-Za-z_#$][\w$#]*)/.exec(s);
    const kw = kwm ? kwm[1].toUpperCase() : '';
    const rest = kwm ? s.slice(kwm[1].length).trim() : s;
    if (!KEYWORDS.has(kw)) {
      // 대입문  name = expr / $s = expr / a[i] = expr
      const m = /^(.+?)\s*=(?!=)\s*(.+)$/.exec(s);
      if (m && !/[<>!]$/.test(m[1])) {
        const l = LHS(m[1]), e = E(m[2]);
        emit((vm, f) => { assign(vm, f, l, ev(vm, f, e)); });
        return;
      }
      throw new SyntaxErr(`알 수 없는 명령: ${s}`, 0);
    }
    if (IGNORED.has(kw)) { emit(() => {}); return; }
    // BREAK: 앞선 동작이 완전히 끝날 때까지 대기 (블렌딩 차단)
    if (kw === 'BREAK' || kw === 'BRAKE') { emit((vm) => vm.waitUntil(() => vm.ctrl.motionIdle)); return; }
    const args = () => (rest ? splitTop(rest, ',').map((x) => x.trim()) : []);
    switch (kw) {
      // ---------------- 동작
      case 'JMOVE': case 'LMOVE': {
        const e = E(args()[0]); const K = kw[0];
        emit((vm, f) => doMove(vm, K, ev(vm, f, e, 'pose')));
        return;
      }
      case 'JAPPRO': case 'LAPPRO': {
        const [a, d] = args(); const e = E(a), de = E(d ?? '0'); const K = kw[0];
        emit((vm, f) => doMove(vm, K, poseMul(tOf(vm.ctrl, ev(vm, f, e, 'pose')), { p: [0, 0, -num(ev(vm, f, de))], R: I3() })));
        return;
      }
      case 'JDEPART': case 'LDEPART': {
        const de = E(args()[0] ?? '0'); const K = kw[0];
        emit((vm, f) => doMove(vm, K, poseMul(vm.ctrl.tcpPose(), { p: [0, 0, -num(ev(vm, f, de))], R: I3() })));
        return;
      }
      case 'C1MOVE': {
        const e = E(args()[0]);
        emit((vm, f) => { st(vm).c1 = tOf(vm.ctrl, ev(vm, f, e, 'pose')); });
        return;
      }
      case 'C2MOVE': {
        const e = E(args()[0]);
        emit(async (vm, f) => {
          const S = st(vm);
          if (!S.c1) throw new RuntimeErr('AS', 'C2MOVE 앞에 C1MOVE 가 필요합니다');
          const via = S.c1; S.c1 = null;
          await doMove(vm, 'C', tOf(vm.ctrl, ev(vm, f, e, 'pose')), { via });
        });
        return;
      }
      case 'HOME': {
        const ne = rest ? E(rest) : null;
        emit((vm, f) => {
          const n = ne ? num(ev(vm, f, ne)) : 1;
          const h2 = n === 2 ? vm.ctrl.regs.get('J:#HOME2') : null;
          return doMove(vm, 'J', h2 || { j: [...vm.ctrl.robot.home] });
        });
        return;
      }
      case 'DRAW': case 'TDRAW': {
        const a = args().map((x) => (x ? E(x) : null));
        const tool = kw === 'TDRAW';
        emit((vm, f) => {
          const v = a.map((x) => (x ? num(ev(vm, f, x)) : 0));
          const cur = vm.ctrl.tcpPose();
          const R = RfromZYX(v[5] || 0, v[4] || 0, v[3] || 0);
          const d = [v[0] || 0, v[1] || 0, v[2] || 0];
          const tgt = tool ? poseMul(cur, { p: d, R }) : { p: add(cur.p, d), R: poseMul({ p: [0, 0, 0], R }, { p: [0, 0, 0], R: cur.R }).R };
          return doMove(vm, 'L', tgt, { pct: a[6] ? v[6] : undefined });
        });
        return;
      }
      case 'DELAY': case 'TWAIT': {
        const e = E(rest || '0');
        emit((vm, f) => vm.wait(Math.max(0, num(ev(vm, f, e)))));
        return;
      }
      // ---------------- 속도/정밀도/툴/베이스
      case 'SPEED': {
        const sp = parseSpeedArgs(rest);
        emit((vm, f) => {
          const S = st(vm), v = { v: num(ev(vm, f, sp.ast)), u: sp.unit };
          if (sp.always) { S.always = v; S.next = null; } else S.next = v;
        });
        return;
      }
      case 'ACCURACY': {
        const e = E(splitTop(rest.replace(/\b(ALWAYS|FINE)\b/gi, ''), ',')[0] || '1');
        const always = /\bALWAYS\b/i.test(rest);
        emit((vm, f) => {
          const v = num(ev(vm, f, e));
          if (always) { st(vm).accuracy = v; st(vm).accNext = null; } else st(vm).accNext = v;
        });
        return;
      }
      case 'TOOL': case 'BASE': {
        const isNull = /^NULL$/i.test(rest);
        const e = isNull ? null : E(args()[0]);
        const prop = kw === 'TOOL' ? 'toolOverride' : 'base';
        emit((vm, f) => { vm.ctrl[prop] = e ? tOf(vm.ctrl, ev(vm, f, e, 'pose')) : null; vm.ctrl.emitState(); });
        return;
      }
      // ---------------- 신호
      case 'SIGNAL': {
        const a = args().map(E);
        emit((vm, f) => { for (const x of a) { const v = num(ev(vm, f, x)); sigSet(vm.ctrl, v, v > 0); } });
        return;
      }
      case 'PULSE': {
        const [a, t] = args(); const e = E(a), te = t ? E(t) : null;
        emit((vm, f) => {
          const n = num(ev(vm, f, e)), dt = te ? num(ev(vm, f, te)) : 0.2;
          sigSet(vm.ctrl, n, true);
          setTimeout(() => { try { sigSet(vm.ctrl, n, false); } catch { /* 무시 */ } }, dt * 1000);
        });
        return;
      }
      case 'DLYSIG': {
        const [a, t] = args(); const e = E(a), te = E(t ?? '0');
        emit((vm, f) => {
          const n = num(ev(vm, f, e)), dt = num(ev(vm, f, te));
          setTimeout(() => { try { sigSet(vm.ctrl, n, n > 0); } catch { /* 무시 */ } }, dt * 1000);
        });
        return;
      }
      case 'SWAIT': {
        const a = args().map(E);
        emit(async (vm, f) => {
          const ns = a.map((x) => num(ev(vm, f, x)));
          await vm.waitUntil(() => ns.every((n) => sigGet(vm.ctrl, n)));
        });
        return;
      }
      case 'BITS': {
        const m = /^(.+?)=(?!=)(.+)$/.exec(rest);
        if (!m) throw new SyntaxErr('BITS 시작, 개수 = 값 형식이어야 합니다', 0);
        const [a, c] = splitTop(m[1], ','); const ae = E(a), ce = E(c ?? '1'), ve = E(m[2]);
        emit((vm, f) => {
          const s0 = Math.round(num(ev(vm, f, ae))), cnt = Math.round(num(ev(vm, f, ce))), val = Math.round(num(ev(vm, f, ve)));
          for (let i = 0; i < cnt; i++) sigSet(vm.ctrl, s0 + i, !!((val >> i) & 1));
        });
        return;
      }
      case 'WAIT': {
        const e = E(rest);
        emit(async (vm, f) => { await vm.waitUntil(() => truthy(ev(vm, f, e))); });
        return;
      }
      case 'TIMER': {
        const m = /^(.+?)=(?!=)(.+)$/.exec(rest);
        if (!m) throw new SyntaxErr('TIMER 번호 = 값 형식이어야 합니다', 0);
        const ne = E(m[1]), ve = E(m[2]);
        emit((vm, f) => { vm.ctrl.regs.set('TIMER:' + Math.round(num(ev(vm, f, ne))), performance.now() - num(ev(vm, f, ve)) * 1000); });
        return;
      }
      case 'RESET': {
        emit((vm) => { for (let i = 1; i <= 512; i++) if (vm.ctrl.getDO(i)) vm.ctrl.setDO(i, false); });
        return;
      }
      // ---------------- 위치 변수
      case 'POINT': {
        const m = /^(.+?)\s*=(?!=)\s*(.+)$/.exec(rest);
        if (!m) throw new SyntaxErr('POINT 변수 = 위치식 형식이어야 합니다', 0);
        const l = LHS(m[1]), e = E(m[2]);
        const joint = parseName(l.name).name.startsWith('#');
        emit((vm, f) => {
          const v = ev(vm, f, e, 'pose');
          assign(vm, f, l, joint ? jOf(vm.ctrl, v) : tOf(vm.ctrl, v));
        });
        return;
      }
      case 'HERE': {
        const l = LHS(rest);
        const joint = parseName(l.name).name.startsWith('#');
        emit((vm, f) => { assign(vm, f, l, joint ? { j: [...vm.ctrl.joints] } : vm.ctrl.tcpPose()); });
        return;
      }
      case 'DECOMPOSE': {
        const m = /^(.+?)\s*=(?!=)\s*(.+)$/.exec(rest);
        if (!m) throw new SyntaxErr('DECOMPOSE 배열[시작] = 위치 형식이어야 합니다', 0);
        const lt = m[1].trim().replace(/\[\s*\]$/, '[0]');
        const l = LHS(lt), e = E(m[2]);
        emit((vm, f) => {
          const v = ev(vm, f, e, 'pose');
          const arr = isJ(v) ? v.j : toVendorPose('kawasaki', tOf(vm.ctrl, v));
          const idx = lhsIdx(vm, f, l) || [0];
          arr.forEach((x, i) => writeV(vm.ctrl, f, l.name, [idx[0] + i, ...idx.slice(1)], x));
        });
        return;
      }
      // ---------------- 출력
      case 'PRINT': case 'TYPE': {
        const body = rest.replace(/^\d+\s*:/, '');
        const items = body.trim() ? splitTop(body, ',').map((x) => x.trim()).filter((x) => x && !x.startsWith('/')).map(E) : [];
        emit((vm, f) => { vm.print(items.map((x) => formatValue(ev(vm, f, x))).join('')); });
        return;
      }
      // ---------------- 제어
      case 'GOTO': {
        const m = /^(\w+)(?:\s+IF\s+(.+))?$/i.exec(rest);
        if (!m) throw new SyntaxErr('GOTO 라벨 이 필요합니다', 0);
        const c = m[2] ? E(m[2]) : null;
        const ins = emit((vm, f) => (!c || truthy(ev(vm, f, c)) ? { goto: ins.target } : undefined), { target: -1 });
        fix.push({ ins, label: label(m[1]), line });
        return;
      }
      case 'IF': {
        let m;
        if ((m = /^(.+?)\s+THEN$/i.exec(rest))) {
          const jf = jumpIfNot(E(m[1]));
          stack.push({ type: 'IF', jf, endJ: null, line });
          return;
        }
        if ((m = /^(.+?)\s+GOTO\s+(\w+)$/i.exec(rest))) {
          const c = E(m[1]);
          const ins = emit((vm, f) => (truthy(ev(vm, f, c)) ? { goto: ins.target } : undefined), { target: -1 });
          fix.push({ ins, label: label(m[2]), line });
          return;
        }
        throw new SyntaxErr('IF 조건 THEN 또는 IF 조건 GOTO 라벨 형식이어야 합니다', 0);
      }
      case 'ELSE': {
        const top = stack.at(-1);
        if (!top || top.type !== 'IF' || top.endJ) throw new SyntaxErr('대응하는 IF 없는 ELSE', 0);
        top.endJ = jump();
        top.jf.target = code.length;
        return;
      }
      case 'WHILE': {
        const m = /^(.+?)\s+DO$/i.exec(rest) || /^(.+)$/.exec(rest);
        const top = code.length;
        const jf = jumpIfNot(E(m[1]));
        stack.push({ type: 'WHILE', top, jf, line });
        return;
      }
      case 'DO': {
        if (rest) throw new SyntaxErr('DO 뒤에는 문장을 쓸 수 없습니다 (DO ... UNTIL 블록)', 0);
        stack.push({ type: 'DO', top: code.length, line });
        return;
      }
      case 'UNTIL': {
        const top = stack.pop();
        if (!top || top.type !== 'DO') throw new SyntaxErr('대응하는 DO 없는 UNTIL', 0);
        const jf = jumpIfNot(E(rest));
        jf.target = top.top;
        return;
      }
      case 'FOR': {
        const m = /^(.+?)\s*=(?!=)\s*(.+?)\s+TO\s+(.+?)(?:\s+STEP\s+(.+))?$/i.exec(rest);
        if (!m) throw new SyntaxErr('FOR 변수 = 시작 TO 끝 [STEP 증분] 형식이어야 합니다', 0);
        const l = LHS(m[1]), a = E(m[2]), b = E(m[3]), se = m[4] ? E(m[4]) : null;
        const hid = `\0FOR${uid++}`;
        emit((vm, f) => {
          const step = se ? num(ev(vm, f, se)) : 1;
          if (step === 0) throw new RuntimeErr('AS', 'FOR STEP 이 0 입니다');
          f.locals.set(hid, { end: num(ev(vm, f, b)), step });
          assign(vm, f, l, num(ev(vm, f, a)));
        });
        const check = emit((vm, f) => {
          const h = f.locals.get(hid), v = num(readL(vm, f, l));
          return (h.step > 0 ? v > h.end + 1e-9 : v < h.end - 1e-9) ? { goto: check.target } : undefined;
        }, { target: -1 });
        stack.push({ type: 'FOR', check, l, hid, line });
        return;
      }
      case 'CASE': {
        const m = /^(.+?)\s+OF$/i.exec(rest);
        if (!m) throw new SyntaxErr('CASE 식 OF 형식이어야 합니다', 0);
        const e = E(m[1]); const hid = `\0CASE${uid++}`;
        emit((vm, f) => { f.locals.set(hid, ev(vm, f, e)); });
        stack.push({ type: 'CASE', hid, pending: null, ends: [], had: false, line });
        return;
      }
      case 'VALUE': case 'ANY': {
        const top = stack.at(-1);
        if (!top || top.type !== 'CASE') throw new SyntaxErr(`CASE 밖의 ${kw}`, 0);
        if (top.had) top.ends.push(jump());
        if (top.pending) top.pending.target = code.length;
        top.had = true;
        top.pending = null;
        if (kw === 'VALUE') {
          const vs = splitTop(rest.replace(/:\s*$/, ''), ',').map((x) => E(x));
          const hid = top.hid;
          const ins = emit((vm, f) => {
            const x = f.locals.get(hid);
            return vs.some((v) => { const y = ev(vm, f, v); return typeof x === 'number' && typeof y === 'number' ? Math.abs(x - y) < 1e-9 : x === y; }) ? undefined : { goto: ins.target };
          }, { target: -1 });
          top.pending = ins;
        }
        return;
      }
      case 'END': {
        const top = stack.pop();
        if (!top) throw new SyntaxErr('대응하는 블록(IF/WHILE/FOR/CASE) 없는 END', 0);
        if (top.type === 'IF') { (top.endJ ? top.endJ : top.jf).target = code.length; if (top.endJ) { /* else 블록 끝 */ } }
        else if (top.type === 'WHILE') { const j = jump(); j.target = top.top; top.jf.target = code.length; }
        else if (top.type === 'FOR') {
          const { l, hid, check } = top;
          const inc = emit((vm, f) => { assign(vm, f, l, num(readL(vm, f, l)) + f.locals.get(hid).step); return { goto: inc.target }; }, { target: code.indexOf(check) });
          check.target = code.length;
        } else if (top.type === 'CASE') {
          if (top.pending) top.pending.target = code.length;
          for (const j of top.ends) j.target = code.length;
        } else throw new SyntaxErr(`${top.type} 블록은 END 가 아닌 UNTIL 로 닫아야 합니다`, 0);
        return;
      }
      case 'CALL': {
        const m = /^([A-Za-z_][\w.]*)\s*(?:\((.*)\))?$/.exec(rest);
        if (!m) throw new SyntaxErr('CALL 프로그램명(인자) 형식이어야 합니다', 0);
        const argAst = m[2] && m[2].trim() ? splitTop(m[2], ',').map((x) => (x.trim() ? E(x) : null)) : [];
        const ins = emit((vm, f) => {
          const proc = ins.proc;
          // 변수 실인자는 미정의여도 허용 (출력용 인자)
          const vals = argAst.map((a) => {
            if (!a) return undefined;
            if (a.t === 'id' || (a.t === 'index' && a.obj.t === 'str')) { try { return ev(vm, f, a); } catch (e) { if (/정의되지 않은/.test(e.message)) return undefined; throw e; } }
            return ev(vm, f, a);
          });
          const locals = new Map();
          // 참조 전달: 변수 실인자는 복귀 시 값 되돌려 쓰기
          const onReturn = () => {
            argAst.forEach((a, i) => {
              const pn = proc.params[i];
              if (!a || !pn || !(a.t === 'id' || (a.t === 'index' && a.obj.t === 'str'))) return;
              const nv = locals.get(pn);
              if (nv === undefined) return;
              try {
                const l = a.t === 'id' ? { name: a.name, idx: null } : { name: a.obj.v, idx: a.idx };
                assign(vm, f, l, nv);
              } catch { /* 형 불일치 등은 무시 */ }
            });
          };
          return { call: { proc, args: vals, locals, onReturn } };
        });
        calls.push({ ins, name: m[1].toUpperCase(), file, line });
        return;
      }
      case 'RETURN': emit(() => ({ ret: undefined })); return;
      case 'STOP': case 'HALT': emit(() => ({ halt: true })); return;
      case 'PAUSE': emit((vm) => { vm.print('PAUSE'); vm.ctrl.hold(); }); return;
    }
    throw new SyntaxErr(`지원하지 않는 명령: ${kw}`, 0);
  }

  for (const b of p.body) {
    line = b.line;
    at(file, line, () => {
      let s = stripComment(b.text, [';']).trim();
      if (!s) return;
      let m = /^(\d+)(?:\s+(.*))?$/.exec(s);
      if (m) { labels[label(m[1])] = code.length; s = (m[2] || '').trim(); if (!s) return; }
      m = /^([A-Za-z_]\w*)\s*:(?!=)\s*(.*)$/.exec(s);
      if (m && !/^(ANY|VALUE)$/i.test(m[1])) { labels[label(m[1])] = code.length; s = m[2].trim(); if (!s) return; }
      stmt(prep(s));
    });
  }
  if (stack.length) { const t = stack.at(-1); throw new CompileError(`${t.type} 블록이 닫히지 않았습니다 (${t.type === 'DO' ? 'UNTIL' : 'END'} 누락)`, file, t.line); }
  for (const f of fix) {
    if (!(f.label in labels)) throw new CompileError(`라벨 ${f.label} 이(가) 없습니다`, file, f.line);
    f.ins.target = labels[f.label];
  }
  const params = p.params.map((x) => x.replace(/^\./, '').toUpperCase());
  return { name: p.name, params, file, code, labels };
}

function compileAll(files) {
  const { progs, data } = scanFiles(files);
  const procs = {}, calls = [];
  for (const p of progs) {
    const K = p.name.toUpperCase();
    if (procs[K]) throw new CompileError(`프로그램 ${p.name} 이(가) 중복 정의되었습니다 (${procs[K].file})`, p.file, p.line);
    procs[K] = compileProc(p, calls);
  }
  return { progs, data, procs, calls };
}
function link(procs, calls) {
  for (const c of calls) {
    const proc = procs[c.name];
    if (!proc) throw new CompileError(`프로그램 ${c.name} 이(가) 없습니다`, c.file, c.line);
    c.ins.proc = proc;
  }
}

const progNames = (text) => [...String(text ?? '').matchAll(/^[ \t]*\.PROGRAM[ \t]+([A-Za-z_][\w.]*)/gim)].map((m) => m[1]);

// ============================================================ 모니터 명령 (터미널)
export function listPrograms(ctrl) {
  const out = [];
  for (const [, text] of ctrl.files) out.push(...progNames(text));
  return out;
}

// 단일 문장을 임시 VM 으로 실행 (CALL 은 컨트롤러 파일의 프로그램과 링크)
async function runStatement(ctrl, text, out) {
  let procs = {};
  try { const r = compileAll(ctrl.files); link(r.procs, r.calls); procs = r.procs; } catch { /* 파일 오류 시 CALL 만 불가 */ }
  const calls = [];
  const proc = compileProc({ name: '(monitor)', params: [], file: '(monitor)', line: 1, body: [{ line: 1, text }] }, calls);
  link(procs, calls);
  const vm = new VM(ctrl, { lang: 'as', entry: '', procs, globals: new Map() });
  vm.as = newState();
  vm.print = (m) => out.push(String(m));
  const realMove = vm.move.bind(vm);
  vm.move = (cmd) => {
    if (ctrl.vm && (ctrl.vm.status === 'running' || ctrl.vm.status === 'paused')) throw new RuntimeErr('AS', '프로그램 실행 중에는 동작 명령을 실행할 수 없습니다');
    return realMove(cmd);
  };
  ctrl._asDoVm = vm;
  const frames = [{ proc, pc: 0, locals: new Map() }];
  try {
    while (frames.length) {
      if (vm.aborted) throw new Error('중단되었습니다');
      const f = frames.at(-1);
      if (f.pc >= f.proc.code.length) { frames.pop().onReturn?.(undefined); continue; }
      let r = f.proc.code[f.pc].run(vm, f);
      if (r && typeof r.then === 'function') r = await r;
      if (!r) f.pc++;
      else if (r.goto !== undefined) f.pc = r.goto;
      else if (r.call) {
        f.pc++;
        const lm = r.call.locals || new Map();
        r.call.proc.params?.forEach((p, i) => lm.set(p, r.call.args?.[i]));
        frames.push({ proc: r.call.proc, pc: 0, locals: lm, onReturn: r.call.onReturn });
      } else if ('ret' in r) frames.pop().onReturn?.(r.ret);
      else if (r.halt) break;
    }
  } finally {
    if (ctrl._asDoVm === vm) ctrl._asDoVm = null;
  }
}

// AS 모니터 명령 1줄 실행 → 출력 문자열. 오류는 '(E) 메시지' 문자열로 반환 (reject 하지 않음)
export async function executeLine(ctrl, line) {
  const out = [];
  const s = stripComment(String(line ?? ''), [';']).trim();
  if (!s) return '';
  const kw = /^\S+/.exec(s)[0].toUpperCase(), rest = s.slice(kw.length).trim();
  try {
    switch (kw) {
      case 'WHERE': case 'W': return whereText(ctrl);
      case 'SPEED':
        if (rest && !/ALWAYS|MM\/|\sS$/i.test(rest)) { ctrl.setOverride(Number(rest)); return `모니터 속도 = ${ctrl.override}%`; }
        if (!rest) return `모니터 속도 = ${ctrl.override}%`;
        break;
      case 'EXECUTE': case 'EX': {
        if (ctrl.vm && ctrl.vm.status === 'running') return '(E) 프로그램이 이미 실행 중입니다';
        const name = rest.split(/[\s,]+/)[0];
        if (name) {
          let file = null;
          for (const [fn, text] of ctrl.files) if (progNames(text).some((n) => n.toUpperCase() === name.toUpperCase())) { file = fn; break; }
          if (!file) return `(E) 프로그램 ${name} 이(가) 없습니다`;
          ctrl.asEntry = name;
          ctrl.setMain(file);
        }
        const ok = await ctrl.start();
        return ok ? `프로그램 ${name || ctrl.program?.entry || ''} 실행 시작` : '(E) 실행할 수 없습니다 (서보/알람/컴파일 상태 확인)';
      }
      case 'ABORT': ctrl.stopProgram(); ctrl._asDoVm?.abort(); return '';
      case 'HOLD': ctrl.hold(); return '';
      case 'CONTINUE': ctrl.resume(); return '';
      case 'ERESET': ctrl.resetAlarms(); return '';
      case 'ZPOWER': case 'ZPOW': {
        if (!rest) return `서보 ${ctrl.servo ? 'ON' : 'OFF'}`;
        return ctrl.setServo(/^ON$/i.test(rest)) ? '' : '(E) 서보 ON 불가 (알람 리셋 필요)';
      }
      case 'STATUS': return [
        `모니터 속도 ${ctrl.override}%`, `서보 ${ctrl.servo ? 'ON' : 'OFF'}`,
        `프로그램 ${ctrl.program?.entry ?? '-'} (${ctrl.vm?.status ?? 'idle'}) 사이클 ${ctrl.vm?.cycle ?? 0}`,
        ...ctrl.alarms.map((a) => `알람 [${a.code}] ${a.msg}`),
      ].join('\n');
      case 'DIRECTORY': case 'DIR': return listPrograms(ctrl).join('\n');
      case 'LIST': {
        const sw = rest.toUpperCase();
        const rows = [];
        const want = (k) => sw === '' ? false : (sw.startsWith('/L') && (k === 'T' || k === 'J')) || (sw.startsWith('/R') && k === 'R') || (sw.startsWith('/S') && k === 'S') || (sw.startsWith('/J') && k === 'J');
        if (/^\/[LRSJ]/.test(sw)) {
          for (const [k, v] of ctrl.regs) {
            const m = /^([TJRS]):(.*)$/.exec(k);
            if (!m || !want(m[1])) continue;
            if (m[1] === 'T') rows.push(`${m[2].padEnd(12)}${toVendorPose('kawasaki', v).map((x) => pad(x.toFixed(3))).join('')}`);
            else if (m[1] === 'J') rows.push(`${m[2].padEnd(12)}${v.j.map((x) => pad(x.toFixed(3))).join('')}`);
            else if (m[1] === 'R') rows.push(`${m[2]} = ${fmtNum(v)}`);
            else rows.push(`${m[2]} = "${v}"`);
          }
          return rows.join('\n');
        }
        // LIST 프로그램명 → 원문
        const name = rest.replace(/^\/P\s*/i, '').trim().toUpperCase();
        for (const [, text] of ctrl.files) {
          const lines = String(text).split('\n');
          let on = false;
          for (const l of lines) {
            const m = PROG_RE.exec(l.trim());
            if (m && (!name || m[1].toUpperCase() === name)) on = true;
            if (on) rows.push(l);
            if (on && /^\s*\.END\b/i.test(l)) { on = false; if (name) return rows.join('\n'); }
          }
        }
        return rows.length ? rows.join('\n') : `(E) 프로그램 ${name} 이(가) 없습니다`;
      }
    }
    await runStatement(ctrl, kw === 'DO' ? rest : s, out);
  } catch (e) {
    out.push(`(E) ${e.message}`);
  }
  return out.join('\n');
}

// ============================================================ 예제 프로그램
const DOWN = [[-1, 0, 0], [0, 1, 0], [0, 0, -1]];
const f3 = (v) => (Math.abs(v) < 5e-4 ? 0 : v).toFixed(3);

function defaultFiles(ctrl) {
  const robot = ctrl.robot;
  let tool;
  try { tool = ctrl.tool; } catch { tool = { p: [0, 0, 150], R: I3() }; }
  const objs = [...(ctrl.objects || [])].sort((a, b) => a.pose.p[1] - b.pose.p[1]);
  if (objs.length < 1) return {};
  const R = robot.reach;
  const z = objs[0].pose.p[2];
  const pitch = objs.length > 1 ? (objs[objs.length - 1].pose.p[1] - objs[0].pose.p[1]) / (objs.length - 1) : 0;
  const pick0 = [objs[0].pose.p[0], objs[0].pose.p[1], z];
  const appro = Math.round(Math.max(80, Math.min(200, objs[0].size[2] * 2.5)) / 10) * 10;
  const ik = (p, ref) => ikNearest(robot, tcpToFlange({ p, R: DOWN }, tool, null), ref);

  // 도달 가능성 검증: 실제 동작 순서대로 IK 연쇄
  const check = (placeX) => {
    let ref = [...robot.home];
    for (let i = 0; i < objs.length; i++) {
      const y = pick0[1] + pitch * i;
      for (const p of [[pick0[0], y, z + appro], [pick0[0], y, z], [placeX, y, z + appro], [placeX, y, z]]) {
        const j = ik(p, ref);
        if (!j) return false;
        ref = j;
      }
    }
    return true;
  };
  let placeX = null;
  for (const fx of [0.75, 0.7, 0.8, 0.4, 0.65, 0.35]) if (check(R * fx)) { placeX = Math.round(R * fx); break; }
  if (placeX === null) placeX = Math.round(R * 0.7);
  // 대기 위치(관절값): 작업 영역 중앙 위
  let standby = null;
  for (const dz of [0.35, 0.25, 0.15, 0.5]) {
    standby = ik([(pick0[0] + placeX) / 2, 0, z + R * dz], robot.home);
    if (standby) break;
  }
  standby ||= [...robot.home];

  const tr = (p) => toVendorPose('kawasaki', { p, R: DOWN }).map(f3).join(' ');
  const n = objs.length;
  const text = `.******************************************
.** pickplace.as  — Kawasaki AS 예제 (${robot.name})
.** 공작물 ${n}개를 차례로 집어 X=${placeX} 열로 옮긴다
.** DO1(OX1)=그리퍼 닫기, DO2(OX2)=열기, DI1(1001)=닫힘, DI2(1002)=열림, DI3(1003)=공작물 감지
.******************************************
.PROGRAM main()
  ; 메인: pick & place 사이클
  ACCURACY 1 ALWAYS
  SPEED 100 ALWAYS
  count = 0
  HOME
  CALL grip_open
  JMOVE #standby
  FOR i = 0 TO n_work-1
    POINT .pk = SHIFT(pick BY 0, i*pitch, 0)
    POINT .pl = SHIFT(place BY 0, i*pitch, 0)
    CALL pick_place(.pk, .pl)
  END
  JMOVE #standby
  HOME
  PRINT $msg, count, " 개 완료"
.END
.PROGRAM pick_place(.src, .dst)
  ; .src 위치의 공작물을 집어 .dst 에 내려놓는다
  JAPPRO .src, appro
  SPEED 30
  LMOVE .src
  BREAK
  CALL grip_close
  IF SIG(-1003) THEN
    PRINT "경고: 공작물이 감지되지 않음"
  END
  SPEED 50
  LDEPART appro
  JAPPRO .dst, appro
  SPEED 30
  LMOVE .dst
  BREAK
  CALL grip_open
  LDEPART appro
  count = count + 1
.END
.PROGRAM grip_close()
  SIGNAL 1, -2      ; 닫기 ON, 열기 OFF
  SWAIT 1001        ; 닫힘 확인
  TWAIT 0.2
.END
.PROGRAM grip_open()
  SIGNAL -1, 2      ; 닫기 OFF, 열기 ON
  SWAIT 1002        ; 열림 확인
  TWAIT 0.1
.END
.TRANS
pick ${tr(pick0)}
place ${tr([placeX, pick0[1], z])}
.END
.JOINTS
#standby ${standby.map(f3).join(' ')}
.END
.REALS
n_work = ${n}
pitch = ${f3(pitch)}
appro = ${appro}
count = 0
.END
.STRINGS
$msg = "PICK&PLACE: "
.END
`;
  return { 'pickplace.as': text };
}

// ============================================================ 통신용 변수 접근
function readVar(ctrl, name) {
  const m = NAME_IDX.exec(String(name).trim());
  if (!m) return undefined;
  const k = keyOf(m[1].toUpperCase(), m[2] ? m[2].split(',').map((s) => Number(s.trim())) : null);
  const kinds = k[0] === '$' ? ['S'] : k[0] === '#' ? ['J'] : ['R', 'T'];
  for (const K of kinds) {
    const v = ctrl.regs.get(`${K}:${k}`);
    if (v === undefined) continue;
    if (isT(v)) return toVendorPose('kawasaki', v);
    if (isJ(v)) return [...v.j];
    return v;
  }
  return undefined;
}

function writeVar(ctrl, name, value) {
  const m = NAME_IDX.exec(String(name).trim());
  if (!m) return false;
  const k = keyOf(m[1].toUpperCase(), m[2] ? m[2].split(',').map((s) => Number(s.trim())) : null);
  if (typeof value === 'string' && k[0] !== '$') value = parseValue(value);
  if (k[0] === '$') { ctrl.regs.set(`S:${k}`, String(value)); return true; }
  if (k[0] === '#') {
    const a = isJ(value) ? value.j : value;
    if (!Array.isArray(a) || a.length < 6) return false;
    ctrl.regs.set(`J:${k}`, mkJ(a)); return true;
  }
  if (isT(value)) { ctrl.regs.set(`T:${k}`, value); return true; }
  if (Array.isArray(value)) { if (value.length < 6) return false; ctrl.regs.set(`T:${k}`, mkT(value)); return true; }
  const v = Number(value);
  if (!Number.isFinite(v)) return false;
  ctrl.regs.set(`R:${k}`, v);
  return true;
}

// ============================================================ 모듈
export default {
  id: 'as', name: 'Kawasaki AS', exts: ['.as', '.pg'],

  compile(files, main, ctrl) {
    const { progs, data, procs, calls } = compileAll(files);
    link(procs, calls);
    const inMain = progs.filter((p) => p.file === main);
    if (!inMain.length) throw new CompileError(`${main} 에 .PROGRAM 이 없습니다`, main, 1);
    const want = [ctrl?.asEntry, 'MAIN', 'PG0'].filter(Boolean).map((s) => String(s).toUpperCase());
    let entry = null;
    for (const w of want) { const p = inMain.find((x) => x.name.toUpperCase() === w); if (p) { entry = p; break; } }
    entry ||= inMain[0];
    applyData(ctrl, files, data);
    return { lang: 'as', entry: entry.name.toUpperCase(), procs, globals: new Map(), init(vm) { vm.as = newState(); } };
  },

  pickMain(names, files) {
    const progsIn = (n) => progNames(files?.get?.(n)).map((s) => s.toUpperCase());
    for (const pref of ['MAIN', 'PG0']) { const f = names.find((n) => progsIn(n).includes(pref)); if (f) return f; }
    return names.find((n) => progsIn(n).length) ?? names[0] ?? null;
  },

  defaultFiles,
  readVar,
  writeVar,
};

export { readVar, writeVar, defaultFiles };
