// Universal Robots URScript 인터프리터 (.script)
//
// 파일 : main.script (+ 다른 .script). 주석은 #, PolyScope 가 넣는 `$ 1 "..."` 주석 줄은 무시.
// 문법 : def 이름(인수, 기본값=…): … end / if … elif … else … end / while … end / return / break / continue / halt
//        global x = … (전역 대입·선언), local x = …, 대입 a = …, a[i] = …, 복합 대입(+= -= *= /=)
//        함수 안의 def 도 허용 (전역 함수로 등록 — PolyScope 가 내보내는 스크립트 구조)
// 실행 : 파일 맨 위에 def 만 있으면(PolyScope·보조 인터페이스로 보내는 스크립트 형태) 인수 없는 첫 def 를 프로그램으로 실행한다.
//        이때 그 def 의 변수는 전역으로 다룬다. 그 밖의 맨 위 문장이 있으면 위에서부터 실행한다.
// 식   : + - * / %, 비교, and/or/xor/not, 리스트 [ … ], 자세 p[x, y, z, rx, ry, rz], 인덱스, True/False, 문자열 "…" '…', pi
// 단위 : 위치 m, 각도 rad (관절 리스트·회전 벡터·속도 rad/s·m/s·가속도), 블렌드 반경 r (m). 에뮬레이터 내부(mm·deg)와는 여기서 변환.
// I/O  : 표준 디지털 출력/입력 0~7 → 에뮬레이터 DO/DI 1~8, 구성 가능 0~7 → 9~16, 툴 0~1 → 17~18
//        (그리퍼 기본 규약: 표준 DO0 = 닫기(DO1), DO1 = 열기(DO2), DI0 닫힘 확인, DI1 열림 확인, DI2 공작물 감지)
// 에뮬레이터 구현 방식
//  - 사용자 함수와 기다리는 내장 함수(movej·sleep·sync·소켓 읽기 등)는 식 안에서 호출해도 되지만, 그 문장의 다른 부분보다 먼저 실행된다.
//  - thread / run / join / kill, 구조체·행렬, RTDE 레지스터 함수는 지원하지 않는다 (컴파일 오류로 알림).
//  - 가속도(a)는 무시하고 속도(v)·시간(t)·블렌드(r)만 반영한다. movep 는 movel 과 같게 처리한다.
//  - set_tcp(pose) 는 프로그램 툴로 반영(ctrl.toolOverride), set_payload 류는 기록만 한다.
import net from 'node:net';
import { CompileError, RuntimeErr } from './common.js';
import { toVendorPose, fromVendorPose, frameFromXYZRPY } from '../../shared/poseformat.js';
import { ikNearest, tcpToFlange, fkTcp } from '../../shared/kinematics.js';
import { poseMul, poseInv, mul3, T3, add, sub, norm, quatFromR, RfromQuat, quatSlerp, RfromZYX, ZYXfromR, RfromRotvec, rotvecFromR, DEG, RAD } from '../../shared/math.js';

const VENDOR = 'ur';
const DOWN = [[-1, 0, 0], [0, 1, 0], [0, 0, -1]];
const CONSTS = { True: true, False: false, pi: Math.PI };
const SIG = { std: 1, cfg: 9, tool: 17 };   // 에뮬레이터 신호 번호 = 기준 + UR 번호

// ------------------------------------------------------------ 값
// 자세: 길이 6 배열 + 숨김 속성 pose=true (m, rad)
const mkPose = (arr) => { const a = arr.map(Number); Object.defineProperty(a, 'pose', { value: true, enumerable: false }); return a; };
const isPose = (v) => Array.isArray(v) && v.pose === true;
function typeOf(v) {
  if (v === null || v === undefined) return 'none';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'string') return 'string';
  if (isPose(v)) return 'pose';
  if (Array.isArray(v)) return 'list';
  return 'object';
}
const err = (msg, code = 'VAR') => new RuntimeErr(code, msg);
const numStr = (x) => (Number.isFinite(x) ? String(+x.toPrecision(12)) : String(x));
function str(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return numStr(v);
  if (typeof v === 'string') return v;
  if (isPose(v)) return `p[${v.map((x) => numStr(+x.toFixed(6))).join(', ')}]`;
  if (Array.isArray(v)) return `[${v.map((x) => (typeof x === 'string' ? `"${x}"` : str(x))).join(', ')}]`;
  if (v && typeof v === 'object' && v.$struct) {
    return `struct(${Object.entries(v).filter(([k]) => k !== '$struct').map(([k, x]) => `${k}=${typeof x === 'string' ? `"${x}"` : str(x)}`).join(', ')})`;
  }
  return String(v);
}
const truthy = (v) => !(v === null || v === undefined || v === false || v === 0 || v === '');
const num = (v, what = '값') => {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v !== 'number') throw err(`${what}: 숫자가 필요합니다 (${typeOf(v)})`);
  return v;
};
const int = (v) => Math.trunc(num(v));
function eq(a, b) {
  if (typeof a === 'boolean') a = a ? 1 : 0;
  if (typeof b === 'boolean') b = b ? 1 : 0;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => eq(x, b[i]));
  return a === b;
}

// ------------------------------------------------------------ 토크나이저
const PUNCT = ['==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '+', '-', '*', '/', '%', '<', '>', '=', '(', ')', '[', ']', '{', '}', ',', ':', '.', ';'];
const ESC = { n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', "'": "'", '"': '"' };

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (' \t\r\n\f'.includes(ch)) { i++; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    const col = i;
    if (ch === '"' || ch === "'") {
      let j = i + 1, s = '';
      for (;;) {
        if (j >= src.length || src[j] === '\n') throw new Error('문자열이 닫히지 않았습니다');
        if (src[j] === ch) { j++; break; }
        if (src[j] === '\\' && src[j + 1] in ESC) { s += ESC[src[j + 1]]; j += 2; continue; }
        s += src[j++];
      }
      toks.push({ k: 'str', v: s, col }); i = j; continue;
    }
    let m;
    if (/[0-9.]/.test(ch) && (m = /^(0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(src.slice(i)))) {
      const t = m[0];
      toks.push({ k: 'num', v: /^0[xX]/.test(t) ? parseInt(t.slice(2), 16) : parseFloat(t), col }); i += t.length; continue;
    }
    if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i)))) { toks.push({ k: 'id', v: m[0], col }); i += m[0].length; continue; }
    const op = PUNCT.find((o) => src.startsWith(o, i));
    if (op) { toks.push({ k: 'op', v: op, col }); i += op.length; continue; }
    throw new Error(`알 수 없는 문자 '${ch}'`);
  }
  toks.push({ k: 'eof', v: '', col: src.length });
  return toks;
}

// ------------------------------------------------------------ 파서 (식)
// AST: num/str/const/name/list/pose/un/bin/cmp/and/or/xor/not/call{fn,args,kw}/index/tmp
const KEYWORDS = new Set(['and', 'or', 'xor', 'not', 'if', 'elif', 'else', 'while', 'def', 'end', 'return', 'break', 'continue', 'global', 'local', 'halt', 'thread', 'run', 'join', 'kill', 'pass']);

class P {
  constructor(src) { this.t = tokenize(src); this.i = 0; }
  peek(o = 0) { return this.t[Math.min(this.i + o, this.t.length - 1)]; }
  next() { return this.t[this.i++] ?? this.t[this.t.length - 1]; }
  eof() { return this.peek().k === 'eof'; }
  isOp(v, o = 0) { const t = this.peek(o); return t.k === 'op' && t.v === v; }
  isKw(v, o = 0) { const t = this.peek(o); return t.k === 'id' && t.v === v; }
  op(v) { if (this.isOp(v)) { this.i++; return true; } return false; }
  kw(v) { if (this.isKw(v)) { this.i++; return true; } return false; }
  expect(v) { if (!this.op(v)) throw new Error(`'${v}' 가 필요합니다 (발견: '${this.peek().v || '줄 끝'}')`); }

  expr() { return this.or(); }
  or() {
    let a = this.and();
    for (;;) {
      if (this.kw('or')) a = { t: 'or', a, b: this.and() };
      else if (this.kw('xor')) a = { t: 'xor', a, b: this.and() };
      else return a;
    }
  }
  and() { let a = this.not(); while (this.kw('and')) a = { t: 'and', a, b: this.not() }; return a; }
  not() { if (this.kw('not')) return { t: 'not', a: this.not() }; return this.cmp(); }
  cmp() {
    const first = this.arith();
    const ops = [], items = [first];
    for (;;) {
      const t = this.peek();
      if (!(t.k === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(t.v))) break;
      this.next(); ops.push(t.v); items.push(this.arith());
    }
    return ops.length ? { t: 'cmp', ops, items } : first;
  }
  arith() {
    let a = this.term();
    while (this.isOp('+') || this.isOp('-')) { const op = this.next().v; a = { t: 'bin', op, a, b: this.term() }; }
    return a;
  }
  term() {
    let a = this.factor();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) { const op = this.next().v; a = { t: 'bin', op, a, b: this.factor() }; }
    return a;
  }
  factor() {
    if (this.isOp('-') || this.isOp('+')) { const op = this.next().v; return { t: 'un', op, a: this.factor() }; }
    return this.postfix(this.atom());
  }
  items(close) {
    const out = [];
    while (!this.isOp(close)) { out.push(this.expr()); if (!this.op(',')) break; }
    this.expect(close);
    return out;
  }
  atom() {
    const t = this.next();
    if (t.k === 'num') return { t: 'num', v: t.v };
    if (t.k === 'str') return { t: 'str', v: t.v };
    if (t.k === 'id') {
      if (t.v === 'True') return { t: 'const', v: true };
      if (t.v === 'False') return { t: 'const', v: false };
      if (t.v === 'p' && this.isOp('[')) {
        this.next();
        const items = this.items(']');
        if (items.length !== 6) throw new Error(`자세 p[…] 는 값 6개가 필요합니다 (${items.length}개)`);
        return { t: 'pose', items };
      }
      if (t.v === 'run') {
        const fn = this.next();
        if (fn.k !== 'id') throw new Error('run 뒤에는 스레드 이름이 필요합니다');
        this.expect('(');
        this.expect(')');
        return { t: 'runThread', name: fn.v };
      }
      if (KEYWORDS.has(t.v)) throw new Error(`예상치 못한 키워드 '${t.v}'`);
      return { t: 'name', name: t.v };
    }
    if (t.k === 'op' && t.v === '(') { const e = this.expr(); this.expect(')'); return e; }
    if (t.k === 'op' && t.v === '[') return { t: 'list', items: this.items(']') };
    if (t.k === 'op' && t.v === '{') {
      const entries = [];
      while (!this.isOp('}')) {
        const k = this.next();
        if (k.k !== 'id' && k.k !== 'str') throw new Error(`구조체 필드 이름 오류: '${k.v}'`);
        if (!this.op('=') && !this.op(':')) throw new Error("구조체 필드 뒤에 '=' 또는 ':' 이 필요합니다");
        entries.push([k.v, this.expr()]);
        if (!this.op(',')) break;
      }
      this.expect('}');
      return { t: 'structLit', entries };
    }
    throw new Error(`예상치 못한 '${t.v || '줄 끝'}'`);
  }
  postfix(n) {
    for (;;) {
      if (this.op('(')) {
        const args = [], kw = {};
        while (!this.isOp(')')) {
          if (this.peek().k === 'id' && this.isOp('=', 1)) {
            const k = this.next().v; this.next();
            if (k in kw) throw new Error(`키워드 인수 '${k}' 중복`);
            kw[k] = this.expr();
          } else {
            if (Object.keys(kw).length) throw new Error('키워드 인수 뒤에 위치 인수를 쓸 수 없습니다');
            args.push(this.expr());
          }
          if (!this.op(',')) break;
        }
        this.expect(')');
        n = { t: 'call', fn: n, args, kw };
      } else if (this.op('[')) {
        const idx = this.expr();
        this.expect(']');
        n = { t: 'index', obj: n, idx };
      } else if (this.op('.')) {
        const f = this.next();
        if (f.k !== 'id') throw new Error(`속성 이름이 필요합니다 (발견: '${f.v || '줄 끝'}')`);
        n = { t: 'field', obj: n, field: f.v };
      } else return n;
    }
  }
}

function parseExpr(src) {
  const p = new P(src);
  const e = p.expr();
  if (!p.eof()) throw new Error(`식 뒤에 불필요한 '${p.peek().v}'`);
  return e;
}

// ------------------------------------------------------------ 소스 → 논리 줄 → 블록 트리 (end 로 닫음, 들여쓰기 무관)
function logicalLines(text, file) {
  const src = String(text).replace(/\r\n?/g, '\n');
  const out = [];
  let i = 0, line = 1;
  while (i < src.length) {
    const startLine = line;
    let buf = '', depth = 0;
    for (;;) {
      if (i >= src.length) break;
      const ch = src[i];
      if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (ch === '"' || ch === "'") {
        let k = i + 1;
        for (;;) {
          if (k >= src.length || src[k] === '\n') throw new CompileError('문자열이 닫히지 않았습니다', file, line);
          if (src[k] === '\\') { k += 2; continue; }
          if (src[k] === ch) { k++; break; }
          k++;
        }
        buf += src.slice(i, k); i = k; continue;
      }
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
      if (ch === '\n') { line++; i++; if (depth === 0) break; buf += ' '; continue; }
      buf += ch; i++;
    }
    const t = buf.trim();
    if (t && !t.startsWith('$')) out.push({ line: startLine, text: t });
  }
  return out;
}

// 문장 끝 ':' 위치 → { head, tail }
function splitHeader(text) {
  let t;
  try { t = tokenize(text); } catch { return null; }
  let depth = 0;
  for (const tok of t) {
    if (tok.k !== 'op') continue;
    if ('([{'.includes(tok.v)) depth++;
    else if (')]}'.includes(tok.v)) depth--;
    else if (tok.v === ':' && depth === 0) return { head: text.slice(0, tok.col).trim(), tail: text.slice(tok.col + 1).trim() };
  }
  return null;
}
function splitSemi(text) {
  let t;
  try { t = tokenize(text); } catch { return [text]; }
  const out = [];
  let depth = 0, from = 0;
  for (const tok of t) {
    if (tok.k !== 'op') continue;
    if ('([{'.includes(tok.v)) depth++;
    else if (')]}'.includes(tok.v)) depth--;
    else if (tok.v === ';' && depth === 0) { out.push(text.slice(from, tok.col)); from = tok.col + 1; }
  }
  out.push(text.slice(from));
  return out.map((s) => s.trim()).filter(Boolean);
}

// 트리 노드: { line, text } | { line, kw:'def'|'while', head, body } | { line, kw:'if', branches:[{line, cond, body}], els }
function buildTree(lines, file) {
  let i = 0;
  const kwOf = (t) => /^(def|if|elif|else|while|thread|end)\b/.exec(t)?.[1];
  const header = (L, kw) => {
    const h = splitHeader(L.text);
    if (!h) throw new CompileError(`'${kw}' 문 끝에 ':' 가 필요합니다`, file, L.line);
    return h;
  };
  // stop: 이 블록을 끝내는 키워드들
  const block = (stop) => {
    const out = [];
    while (i < lines.length) {
      const L = lines[i];
      const kw = kwOf(L.text);
      if (kw && stop.includes(kw)) return { out, by: kw };
      i++;
      if (kw === 'end' || kw === 'elif' || kw === 'else') throw new CompileError(`'${kw}' 에 대응하는 블록이 없습니다`, file, L.line);
      if (kw === 'def' || kw === 'while' || kw === 'thread') {
        const h = header(L, kw);
        const r = block(['end']);
        if (r.by !== 'end') throw new CompileError(`'${kw}' 블록을 닫는 end 가 없습니다`, file, L.line);
        i++;
        const body = (h.tail ? splitSemi(h.tail).map((s) => ({ line: L.line, text: s })) : []).concat(r.out);
        out.push({ line: L.line, kw, head: h.head, body });
        continue;
      }
      if (kw === 'if') {
        const node = { line: L.line, kw: 'if', branches: [], els: null };
        let h = header(L, kw), line = L.line;
        for (;;) {
          const cond = h.head.replace(/^(if|elif)\b/, '').trim();
          if (!cond) throw new CompileError('if/elif: 조건이 필요합니다', file, line);
          const r = block(['elif', 'else', 'end']);
          node.branches.push({ line, cond, body: (h.tail ? splitSemi(h.tail).map((s) => ({ line, text: s })) : []).concat(r.out) });
          if (!r.by) throw new CompileError("'if' 블록을 닫는 end 가 없습니다", file, L.line);
          const N = lines[i]; i++;
          if (r.by === 'end') break;
          if (r.by === 'elif') { h = header(N, 'elif'); line = N.line; continue; }
          const he = header(N, 'else');
          if (he.head !== 'else') throw new CompileError("'else' 뒤에는 ':' 만 올 수 있습니다", file, N.line);
          const r2 = block(['end']);
          if (r2.by !== 'end') throw new CompileError("'if' 블록을 닫는 end 가 없습니다", file, L.line);
          i++;
          node.els = (he.tail ? splitSemi(he.tail).map((s) => ({ line: N.line, text: s })) : []).concat(r2.out);
          break;
        }
        out.push(node);
        continue;
      }
      for (const s of splitSemi(L.text)) out.push({ line: L.line, text: s });
    }
    return { out, by: null };
  };
  const r = block([]);
  return r.out;
}

// ------------------------------------------------------------ 평가기 (동기)
function ev(n, c) {
  switch (n.t) {
    case 'num': case 'str': case 'const': return n.v;
    case 'tmp': return c.f.locals.get(n.k);
    case 'name': return readName(n.name, c);
    case 'list': return n.items.map((x) => ev(x, c));
    case 'pose': return mkPose(n.items.map((x) => num(ev(x, c), 'p[…]')));
    case 'structLit': {
      const o = Object.defineProperty({}, '$struct', { value: true, enumerable: false });
      for (const [k, v] of n.entries) o[k] = ev(v, c);
      return o;
    }
    case 'field': {
      const o = ev(n.obj, c);
      if (isPose(o)) throw err(`자세 p[…] 는 속성 .${n.field} 대신 pose[0..5] 인덱스로 접근하세요`);
      if (!o || typeof o !== 'object' || !(n.field in o)) throw err(`구조체에 속성 '${n.field}' 가 없습니다`);
      return o[n.field];
    }
    case 'runThread': return spawnThread(c.vm, c.vm.prog, n.name);
    case 'un': { const a = num(ev(n.a, c)); return n.op === '-' ? -a : a; }
    case 'not': return !truthy(ev(n.a, c));
    case 'and': { const a = ev(n.a, c); return truthy(a) ? truthy(ev(n.b, c)) : false; }
    case 'or': { const a = ev(n.a, c); return truthy(a) ? true : truthy(ev(n.b, c)); }
    case 'xor': return truthy(ev(n.a, c)) !== truthy(ev(n.b, c));
    case 'bin': return binop(n.op, ev(n.a, c), ev(n.b, c));
    case 'cmp': {
      let a = ev(n.items[0], c);
      for (let i = 0; i < n.ops.length; i++) {
        const b = ev(n.items[i + 1], c);
        if (!compare(n.ops[i], a, b)) return false;
        a = b;
      }
      return true;
    }
    case 'index': return indexOf(ev(n.obj, c), ev(n.idx, c));
    case 'call': return callSync(n, c);
  }
  throw err(`평가할 수 없는 식 (${n.t})`);
}

function readName(name, c) {
  const L = c.scope.locals;
  if (L && L.has(name) && !c.scope.globals.has(name)) {
    if (!c.f.locals.has(name)) throw err(`지역 변수 '${name}' 를 값을 넣기 전에 사용했습니다`, 'NAME');
    return c.f.locals.get(name);
  }
  if (c.vm.globals.has(name)) return c.vm.globals.get(name);
  if (name in CONSTS) return CONSTS[name];
  throw err(`정의되지 않은 변수 '${name}'`, 'NAME');
}

function binop(op, a, b) {
  if (op === '+') {
    if (typeof a === 'string' && typeof b === 'string') return a + b;
    if (isPose(a) || isPose(b)) throw err('자세끼리는 + 로 더할 수 없습니다 — pose_add() 또는 pose_trans() 를 쓰세요');
    if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
    if (typeof a === 'string' || typeof b === 'string') throw err('문자열과 숫자는 + 로 붙일 수 없습니다 — str_cat() 또는 to_str() 를 쓰세요');
  }
  const x = num(a, `연산자 ${op}`), y = num(b, `연산자 ${op}`);
  switch (op) {
    case '+': return x + y;
    case '-': return x - y;
    case '*': return x * y;
    case '/': if (y === 0) throw err('0 으로 나누었습니다', 'ZERODIV'); return x / y;
    case '%': if (y === 0) throw err('0 으로 나누었습니다', 'ZERODIV'); return x - y * Math.floor(x / y);
  }
  throw err(`지원하지 않는 연산자 ${op}`);
}

function compare(op, a, b) {
  if (op === '==') return eq(a, b);
  if (op === '!=') return !eq(a, b);
  if (typeof a === 'string' && typeof b === 'string') return op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b;
  const x = num(a, `비교 ${op}`), y = num(b, `비교 ${op}`);
  return op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y;
}

function normIndex(o, i) {
  if (typeof o !== 'string' && !Array.isArray(o)) throw err(`${typeOf(o)} 에는 [] 를 쓸 수 없습니다`);
  const k = int(i);
  if (k < 0 || k >= o.length) throw err(`인덱스 ${k} 가 범위를 벗어났습니다 (길이 ${o.length})`, 'INDEX');
  return k;
}
const indexOf = (o, i) => o[normIndex(o, i)];

// 인수 바인딩: spec = ['q', 'a', 'v', ...]
function bindArgs(fname, spec, args, kw) {
  if (args.length > spec.length) throw err(`${fname}(): 인수가 너무 많습니다 (최대 ${spec.length}개)`);
  const o = {};
  args.forEach((v, i) => { o[spec[i]] = v; });
  for (const [k, v] of Object.entries(kw)) {
    if (!spec.includes(k)) throw err(`${fname}(): 알 수 없는 키워드 인수 '${k}'`);
    if (k in o) throw err(`${fname}(): 인수 '${k}' 가 두 번 지정되었습니다`);
    o[k] = v;
  }
  return o;
}

// ------------------------------------------------------------ 변환 (URScript m·rad ↔ 에뮬레이터 mm·deg)
const asPose = (v, fname) => {
  if (!Array.isArray(v) || v.length !== 6) throw err(`${fname}(): 자세 p[x,y,z,rx,ry,rz] 가 필요합니다 (${typeOf(v)})`);
  return v.map((x) => num(x, fname));
};
const asJoints = (v, fname) => {
  if (!Array.isArray(v) || v.length !== 6 || isPose(v)) throw err(`${fname}(): 관절 위치 [6개, rad] 가 필요합니다 (${typeOf(v)})`);
  return v.map((x) => num(x, fname) * RAD);
};
const toPose = (arr) => fromVendorPose(VENDOR, [arr[0] * 1000, arr[1] * 1000, arr[2] * 1000, arr[3], arr[4], arr[5]]);
const fromPose = (pose) => { const v = toVendorPose(VENDOR, pose); return mkPose([v[0] / 1000, v[1] / 1000, v[2] / 1000, v[3], v[4], v[5]].map((x) => Math.round(x * 1e9) / 1e9)); };
const toRadList = (deg) => deg.map((x) => Math.round(x * DEG * 1e9) / 1e9);

function sigNo(kind, n, fname) {
  const k = int(n);
  const max = kind === 'tool' ? 1 : 7;
  if (k < 0 || k > max) throw err(`${fname}(): 번호 범위 0~${max} 를 벗어났습니다 (${k})`, 'IO');
  return SIG[kind] + k;
}
// 구형(CB) set_digital_out(n): 0~7 표준, 8~9 툴
const legacySig = (n, fname) => (int(n) >= 8 ? sigNo('tool', int(n) - 8, fname) : sigNo('std', n, fname));

// ------------------------------------------------------------ 내장 함수 (동기)
const S = (c) => c.vm.urs;
const ctl = (c) => c.vm.ctrl;
const tcpNow = (c) => ctl(c).tcpPose();
function tcpOf(c, tcp) { return tcp === undefined || tcp === null ? ctl(c).tool : tcpToolOf(tcp); }
const tcpToolOf = (tcp) => toPose(asPose(tcp, 'tcp'));

const SYNC = {
  textmsg: (c, args) => { c.vm.print(args.map(str).join('')); return null; },
  popup: (c, args, kw) => {
    const o = bindArgs('popup', ['s', 'title', 'warning', 'error', 'blocking'], args, kw);
    const lv = truthy(o.error) ? '[오류] ' : truthy(o.warning) ? '[경고] ' : '';
    c.vm.print(`(팝업${o.title !== undefined ? ' ' + str(o.title) : ''}) ${lv}${str(o.s)}`);
    return null;
  },
  to_str: (c, [v]) => str(v),
  str_cat: (c, [a, b]) => str(a) + str(b),
  str_len: (c, [s]) => String(s).length,
  str_sub: (c, [s, i, n]) => { const t = String(s); const k = int(i); return n === undefined ? t.slice(k) : t.slice(k, k + int(n)); },
  str_find: (c, [s, t, start]) => String(s).indexOf(String(t), start === undefined ? 0 : int(start)),
  str_at: (c, [s, i]) => String(s)[int(i)] ?? '',
  str_empty: (c, [s]) => String(s).length === 0,
  str_starts_with: (c, [s, t]) => String(s).startsWith(String(t)),
  str_ends_with: (c, [s, t]) => String(s).endsWith(String(t)),
  str_trim: (c, [s]) => String(s).trim(),
  str_upper: (c, [s]) => String(s).toUpperCase(),
  str_lower: (c, [s]) => String(s).toLowerCase(),
  to_num: (c, [s]) => { const x = Number(String(s).trim()); if (Number.isNaN(x) || !String(s).trim()) throw err(`to_num(): '${s}' 를 숫자로 바꿀 수 없습니다`); return x; },
  length: (c, [v]) => { if (typeof v === 'string' || Array.isArray(v)) return v.length; throw err(`length(): ${typeOf(v)} 에는 길이가 없습니다`); },
  get_list_length: (c, [v]) => { if (Array.isArray(v)) return v.length; throw err('get_list_length(): 리스트가 필요합니다'); },
  floor: (c, [v]) => Math.floor(num(v)),
  ceil: (c, [v]) => Math.ceil(num(v)),
  round: (c, [v]) => Math.round(num(v)),
  fabs: (c, [v]) => Math.abs(num(v)),
  sqrt: (c, [v]) => { const x = num(v); if (x < 0) throw err('sqrt(): 음수'); return Math.sqrt(x); },
  sin: (c, [v]) => Math.sin(num(v)),
  cos: (c, [v]) => Math.cos(num(v)),
  tan: (c, [v]) => Math.tan(num(v)),
  asin: (c, [v]) => Math.asin(num(v)),
  acos: (c, [v]) => Math.acos(num(v)),
  atan: (c, [v]) => Math.atan(num(v)),
  atan2: (c, [y, x]) => Math.atan2(num(y), num(x)),
  pow: (c, [a, b]) => num(a) ** num(b),
  log: (c, [b, f]) => Math.log(num(f)) / Math.log(num(b)),
  d2r: (c, [v]) => num(v) * DEG,
  r2d: (c, [v]) => num(v) * RAD,
  random: () => Math.random(),
  min: (c, args) => Math.min(...(args.length === 1 && Array.isArray(args[0]) ? args[0] : args).map((x) => num(x))),
  max: (c, args) => Math.max(...(args.length === 1 && Array.isArray(args[0]) ? args[0] : args).map((x) => num(x))),
  norm: (c, [v]) => (Array.isArray(v) ? Math.hypot(...v.map((x) => num(x))) : Math.abs(num(v))),
  integer_to_binary_list: (c, [v]) => { const x = int(v) >>> 0; return Array.from({ length: 32 }, (_, i) => ((x >>> i) & 1) === 1); },
  binary_list_to_integer: (c, [l]) => (Array.isArray(l) ? l.reduce((s, b, i) => s + (truthy(b) ? 2 ** i : 0), 0) : 0),

  // 자세 연산 (m, rad)
  pose_trans: (c, [a, b]) => fromPose(poseMul(toPose(asPose(a, 'pose_trans')), toPose(asPose(b, 'pose_trans')))),
  pose_inv: (c, [a]) => fromPose(poseInv(toPose(asPose(a, 'pose_inv')))),
  pose_add: (c, [a, b]) => { const A = toPose(asPose(a, 'pose_add')), B = toPose(asPose(b, 'pose_add')); return fromPose({ p: add(A.p, B.p), R: mul3(A.R, B.R) }); },
  pose_sub: (c, [a, b]) => { const A = toPose(asPose(a, 'pose_sub')), B = toPose(asPose(b, 'pose_sub')); return fromPose({ p: sub(A.p, B.p), R: mul3(A.R, T3(B.R)) }); },
  pose_dist: (c, [a, b]) => { const A = asPose(a, 'pose_dist'), B = asPose(b, 'pose_dist'); return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]); },
  point_dist: (c, [a, b]) => { const A = asPose(a, 'point_dist'), B = asPose(b, 'point_dist'); return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]); },
  interpolate_pose: (c, [a, b, t]) => {
    const A = toPose(asPose(a, 'interpolate_pose')), B = toPose(asPose(b, 'interpolate_pose')), k = num(t, 'interpolate_pose');
    return fromPose({ p: A.p.map((x, i) => x + (B.p[i] - x) * k), R: RfromQuat(quatSlerp(quatFromR(A.R), quatFromR(B.R), k)) });
  },
  rpy2rotvec: (c, [v]) => { const a = asList3(v, 'rpy2rotvec'); return rotvecFromR(RfromZYX(a[2] * RAD, a[1] * RAD, a[0] * RAD)); },
  rotvec2rpy: (c, [v]) => { const [rz, ry, rx] = ZYXfromR(RfromRotvec(asList3(v, 'rotvec2rpy'))); return [rx * DEG, ry * DEG, rz * DEG]; },

  // 현재 상태
  get_actual_tcp_pose: (c) => fromPose(tcpNow(c)),
  get_target_tcp_pose: (c) => fromPose(tcpNow(c)),
  get_actual_joint_positions: (c) => toRadList(ctl(c).joints),
  get_target_joint_positions: (c) => toRadList(ctl(c).joints),
  get_actual_joint_speeds: () => [0, 0, 0, 0, 0, 0],
  get_actual_tcp_speed: () => [0, 0, 0, 0, 0, 0],
  get_tcp_offset: (c) => fromPose(ctl(c).tool),
  get_forward_kin: (c, args, kw) => {
    const o = bindArgs('get_forward_kin', ['q', 'tcp'], args, kw);
    const q = o.q === undefined || o.q === null ? ctl(c).joints : asJoints(o.q, 'get_forward_kin');
    return fromPose(fkTcp(ctl(c).robot, q, tcpOf(c, o.tcp), null));
  },
  get_inverse_kin: (c, args, kw) => {
    const o = bindArgs('get_inverse_kin', ['x', 'qnear', 'maxPositionError', 'maxOrientationError', 'tcp'], args, kw);
    const j = ikOf(c, o.x, o.qnear, o.tcp, 'get_inverse_kin');
    if (!j) throw err('get_inverse_kin(): 도달할 수 없는 자세입니다', 'IK');
    return toRadList(j);
  },
  get_inverse_kin_has_solution: (c, args, kw) => {
    const o = bindArgs('get_inverse_kin_has_solution', ['pose', 'qnear', 'maxPositionError', 'maxOrientationError', 'tcp'], args, kw);
    return !!ikOf(c, o.pose, o.qnear, o.tcp, 'get_inverse_kin_has_solution');
  },
  is_within_safety_limits: (c, args, kw) => {
    const o = bindArgs('is_within_safety_limits', ['pose', 'qnear'], args, kw);
    return !!ikOf(c, o.pose, o.qnear, undefined, 'is_within_safety_limits');
  },
  is_steady: (c) => !!ctl(c).motionIdle,

  // 설정
  set_tcp: (c, args, kw) => { const o = bindArgs('set_tcp', ['pose', 'tcp_name'], args, kw); ctl(c).toolOverride = tcpToolOf(o.pose); return null; },
  set_payload: () => null, set_payload_mass: () => null, set_payload_cog: () => null, set_target_payload: () => null,
  set_gravity: () => null, set_tool_voltage: () => null, set_safety_mode_transition_hardness: () => null,
  set_tool_communication: () => null, set_tool_output_mode: () => null, set_tool_digital_output_mode: () => null,
  set_standard_analog_input_domain: () => null, set_tool_analog_input_domain: () => null, set_analog_outputdomain: () => null,
  set_input_actions_to_default: () => null, set_gp_boolean_input_action: () => null,
  enter_critical: () => null, exit_critical: () => null, stopj: () => null, stopl: () => null, end_force_mode: () => null,
  zero_ftsensor: () => null,

  // 디지털 I/O
  set_standard_digital_out: (c, [n, b]) => { ctl(c).setDO(sigNo('std', n, 'set_standard_digital_out'), truthy(b)); return null; },
  set_configurable_digital_out: (c, [n, b]) => { ctl(c).setDO(sigNo('cfg', n, 'set_configurable_digital_out'), truthy(b)); return null; },
  set_tool_digital_out: (c, [n, b]) => { ctl(c).setDO(sigNo('tool', n, 'set_tool_digital_out'), truthy(b)); return null; },
  set_digital_out: (c, [n, b]) => { ctl(c).setDO(legacySig(n, 'set_digital_out'), truthy(b)); return null; },
  get_standard_digital_in: (c, [n]) => !!ctl(c).getDI(sigNo('std', n, 'get_standard_digital_in')),
  get_configurable_digital_in: (c, [n]) => !!ctl(c).getDI(sigNo('cfg', n, 'get_configurable_digital_in')),
  get_tool_digital_in: (c, [n]) => !!ctl(c).getDI(sigNo('tool', n, 'get_tool_digital_in')),
  get_digital_in: (c, [n]) => !!ctl(c).getDI(legacySig(n, 'get_digital_in')),
  get_standard_digital_out: (c, [n]) => !!ctl(c).getDO(sigNo('std', n, 'get_standard_digital_out')),
  get_configurable_digital_out: (c, [n]) => !!ctl(c).getDO(sigNo('cfg', n, 'get_configurable_digital_out')),
  get_tool_digital_out: (c, [n]) => !!ctl(c).getDO(sigNo('tool', n, 'get_tool_digital_out')),
  get_digital_out: (c, [n]) => !!ctl(c).getDO(legacySig(n, 'get_digital_out')),
  set_standard_analog_out: (c, [n, v]) => { const ch = int(n) + 1; if (ch >= 1 && ch <= 16) ctl(c).setAO(ch, num(v, 'set_standard_analog_out')); return null; },
  set_analog_out: (c, [n, v]) => { const ch = int(n) + 1; if (ch >= 1 && ch <= 16) ctl(c).setAO(ch, num(v, 'set_analog_out')); return null; },
  get_standard_analog_in: (c, [n]) => ctl(c).getAI(int(n) + 1),
  get_tool_analog_in: (c, [n]) => ctl(c).getAI(int(n) + 3),
  get_analog_in: (c, [n]) => ctl(c).getAI(int(n) + 1),
  get_standard_analog_out: (c, [n]) => ctl(c).getAO(int(n) + 1),
  // RTDE 범용 레지스터 (PLC/비전 연동용, ctrl.regs 공유)
  read_input_integer_register: (c, [n]) => Math.trunc(Number(ctl(c).regs.get(`RTDE_IN_I:${int(n)}`) ?? 0)),
  read_input_float_register: (c, [n]) => Number(ctl(c).regs.get(`RTDE_IN_F:${int(n)}`) ?? 0),
  read_input_boolean_register: (c, [n]) => !!ctl(c).regs.get(`RTDE_IN_B:${int(n)}`),
  write_output_integer_register: (c, [n, v]) => { ctl(c).regs.set(`RTDE_OUT_I:${int(n)}`, Math.trunc(num(v, 'write_output_integer_register'))); ctl(c).emitState(); return null; },
  write_output_float_register: (c, [n, v]) => { ctl(c).regs.set(`RTDE_OUT_F:${int(n)}`, num(v, 'write_output_float_register')); ctl(c).emitState(); return null; },
  write_output_boolean_register: (c, [n, v]) => { ctl(c).regs.set(`RTDE_OUT_B:${int(n)}`, truthy(v)); ctl(c).emitState(); return null; },
  read_output_integer_register: (c, [n]) => Math.trunc(Number(ctl(c).regs.get(`RTDE_OUT_I:${int(n)}`) ?? 0)),
  read_output_float_register: (c, [n]) => Number(ctl(c).regs.get(`RTDE_OUT_F:${int(n)}`) ?? 0),
  read_output_boolean_register: (c, [n]) => !!ctl(c).regs.get(`RTDE_OUT_B:${int(n)}`),

  // 소켓 (쓰기·닫기는 즉시)
  struct: (_c, _args, kw) => {
    const o = Object.defineProperty({}, '$struct', { value: true, enumerable: false });
    for (const [k, v] of Object.entries(kw || {})) o[k] = v;
    return o;
  },
  socket_close: (c, args, kw) => { const o = bindArgs('socket_close', ['socket_name'], args, kw); sockClose(c.vm, sockName(o.socket_name)); return null; },
  socket_send_string: (c, args, kw) => { const o = bindArgs('socket_send_string', ['str', 'socket_name'], args, kw); return sockWrite(c.vm, sockName(o.socket_name), str(o.str)); },
  socket_send_line: (c, args, kw) => { const o = bindArgs('socket_send_line', ['str', 'socket_name'], args, kw); return sockWrite(c.vm, sockName(o.socket_name), str(o.str) + '\n'); },
  socket_send_byte: (c, args, kw) => { const o = bindArgs('socket_send_byte', ['value', 'socket_name'], args, kw); return sockWrite(c.vm, sockName(o.socket_name), String.fromCharCode(int(o.value) & 255)); },
};
const asList3 = (v, fname) => { if (!Array.isArray(v) || v.length !== 3) throw err(`${fname}(): 값 3개짜리 리스트가 필요합니다`); return v.map((x) => num(x, fname)); };

function ikOf(c, x, qnear, tcp, fname) {
  const ct = ctl(c);
  const ref = qnear === undefined || qnear === null ? ct.joints : asJoints(qnear, fname);
  return ikNearest(ct.robot, tcpToFlange(toPose(asPose(x, fname)), tcpOf(c, tcp), null), ref);
}

function callSync(n, c) {
  if (n.fn.t !== 'name') throw err('호출할 수 없는 식입니다');
  const name = n.fn.name;
  const fn = SYNC[name];
  if (!fn) {
    if (ASYNC[name]) throw err(`${name}() 을(를) 여기서 호출할 수 없습니다`);
    throw err(`알 수 없는 함수 ${name}()`, 'NAME');
  }
  const args = n.args.map((a) => ev(a, c));
  const kw = {};
  for (const [k, v] of Object.entries(n.kw)) kw[k] = ev(v, c);
  return fn(c, args, kw);
}

// ------------------------------------------------------------ 내장 함수 (대기 — 문장으로 분리해 실행)
function jointFrac(ctrl, j, velDeg, time) {
  const r = ctrl.robot, q0 = ctrl.joints;
  const d = j.map((x, i) => Math.abs(x - q0[i]));
  const need = Math.max(...d.map((x, i) => x / r.maxSpeed[i]));
  const dmax = Math.max(...d);
  const cl = (x) => Math.min(1, Math.max(0.001, x));
  if (time > 0) return cl(need > 0 ? need / time : 1);
  if (dmax < 1e-6) return cl(velDeg / Math.min(...r.maxSpeed));
  return cl(need * velDeg / dmax);
}
const blend = (o) => (o.r === undefined || o.r === null ? 0 : Math.max(0, num(o.r, 'r')) * 1000);
const timeOf = (o) => (o.t === undefined || o.t === null ? 0 : Math.max(0, num(o.t, 't')));

// 목표 해석: movej 는 관절 리스트 또는 자세(IK), movel 류는 자세 또는 관절 리스트(FK)
function jointTarget(vm, v, fname) {
  if (isPose(v)) {
    const ct = vm.ctrl;
    const j = ikNearest(ct.robot, tcpToFlange(toPose(asPose(v, fname)), ct.tool, null), ct.joints);
    if (!j) throw err(`${fname}: 도달할 수 없는 자세입니다`, 'IK');
    return j;
  }
  return asJoints(v, fname);
}
function poseTarget(vm, v, fname) {
  if (Array.isArray(v) && !isPose(v) && v.length === 6) return fkTcp(vm.ctrl.robot, asJoints(v, fname), vm.ctrl.tool, null);
  return toPose(asPose(v, fname));
}
function linSpeed(vm, o, dist) {
  const v = o.v === undefined || o.v === null ? 0.25 : num(o.v, 'v');
  const t = timeOf(o);
  const tcp = t > 0 ? Math.max(1, dist / t) : v * 1000;
  if (!(tcp > 0)) throw err('속도 v 는 0 보다 커야 합니다', 'MOTION');
  return { tcp };
}

async function movej(vm, args, kw) {
  const o = bindArgs('movej', ['q', 'a', 'v', 't', 'r'], args, kw);
  const j = jointTarget(vm, o.q, 'movej');
  const vel = (o.v === undefined || o.v === null ? 1.05 : num(o.v, 'v')) * RAD;
  if (!(vel > 0) && !(timeOf(o) > 0)) throw err('movej: 속도 v 는 0 보다 커야 합니다', 'MOTION');
  await vm.move({ kind: 'J', target: { joints: j }, speed: { frac: jointFrac(vm.ctrl, j, vel, timeOf(o)) }, zone: blend(o) });
}
async function movel(vm, args, kw, fname = 'movel') {
  const o = bindArgs(fname, ['pose', 'a', 'v', 't', 'r'], args, kw);
  const pose = poseTarget(vm, o.pose, fname);
  await vm.move({ kind: 'L', target: { pose }, speed: linSpeed(vm, o, norm(sub(pose.p, vm.ctrl.tcpPose().p))), zone: blend(o) });
}
async function movec(vm, args, kw) {
  const o = bindArgs('movec', ['pose_via', 'pose_to', 'a', 'v', 'r', 'mode'], args, kw);
  const via = poseTarget(vm, o.pose_via, 'movec'), pose = poseTarget(vm, o.pose_to, 'movec');
  const dist = norm(sub(via.p, vm.ctrl.tcpPose().p)) + norm(sub(pose.p, via.p));
  await vm.move({ kind: 'C', via: { pose: via }, target: { pose }, speed: linSpeed(vm, o, dist), zone: blend(o) });
}

const ASYNC = {
  movej, movel, movec,
  movep: (vm, args, kw) => movel(vm, args, kw, 'movep'),
  sleep: async (vm, [t]) => { await vm.wait(Math.max(0, num(t, 'sleep'))); return null; },
  sync: async (vm) => { await vm.wait(0.002); return null; },    // 컨트롤러 한 주기 (UR 500 Hz)
  socket_open: async (vm, args, kw) => { const o = bindArgs('socket_open', ['address', 'port', 'socket_name'], args, kw); return sockOpen(vm, str(o.address), int(o.port), sockName(o.socket_name)); },
  socket_read_line: async (vm, args, kw) => { const o = bindArgs('socket_read_line', ['socket_name', 'timeout'], args, kw); return sockReadLine(vm, sockName(o.socket_name), toTimeout(o.timeout)); },
  socket_read_string: async (vm, args, kw) => {
    const o = bindArgs('socket_read_string', ['socket_name', 'prefix', 'suffix', 'interpret_escape', 'timeout'], args, kw);
    return sockReadString(vm, sockName(o.socket_name), o.prefix === undefined ? '' : str(o.prefix), o.suffix === undefined ? '' : str(o.suffix), toTimeout(o.timeout));
  },
  socket_read_ascii_float: async (vm, args, kw) => {
    const o = bindArgs('socket_read_ascii_float', ['number', 'socket_name', 'timeout'], args, kw);
    return sockReadFloats(vm, int(o.number), sockName(o.socket_name), toTimeout(o.timeout));
  },
};
const toTimeout = (t) => (t === undefined || t === null ? 2 : num(t, 'timeout') <= 0 ? Infinity : num(t, 'timeout'));

// ------------------------------------------------------------ 소켓 (이름으로 관리, 클라이언트만)
const sockName = (n) => (n === undefined || n === null ? 'socket_0' : str(n));
function sockOpen(vm, host, port, name) {
  sockClose(vm, name);
  return new Promise((resolve) => {
    const st = { buf: '', closed: false, sock: null };
    const s = net.connect({ host, port });
    const to = setTimeout(() => { s.destroy(); resolve(false); }, 2000);
    s.once('connect', () => {
      clearTimeout(to);
      st.sock = s;
      s.on('data', (d) => { st.buf += d.toString('latin1'); if (st.buf.length > 1048576) st.buf = st.buf.slice(-1048576); });   // 최대 1MB 유지
      s.on('close', () => { st.closed = true; });
      s.on('error', () => { st.closed = true; });
      vm.urs.socks.set(name, st);
      vm.ctrl.log('comm', `[URScript] 소켓 '${name}' ${host}:${port} 연결`);
      resolve(true);
    });
    s.once('error', (e) => { clearTimeout(to); vm.ctrl.log('comm', `[URScript] 소켓 '${name}' ${host}:${port} 연결 실패 (${e.code || e.message})`); resolve(false); });
  });
}
function sockWrite(vm, name, data) {
  const st = vm.urs.socks.get(name);
  if (!st || st.closed) return false;
  st.sock.write(Buffer.from(data, 'latin1'));
  return true;
}
function sockClose(vm, name) {
  const st = vm.urs?.socks.get(name);
  if (!st) return;
  st.sock?.destroy(); st.closed = true;
  vm.urs.socks.delete(name);
}
async function sockReadLine(vm, name, timeout) {
  const st = vm.urs.socks.get(name);
  if (!st) return '';
  await vm.waitUntil(() => st.closed || st.buf.includes('\n'), timeout);
  const k = st.buf.indexOf('\n');
  if (k < 0) return '';
  const line = st.buf.slice(0, k).replace(/\r$/, '');
  st.buf = st.buf.slice(k + 1);
  return line;
}
async function sockReadString(vm, name, prefix, suffix, timeout) {
  const st = vm.urs.socks.get(name);
  if (!st) return '';
  const ready = () => {
    if (st.closed) return true;
    const a = prefix ? st.buf.indexOf(prefix) : 0;
    if (a < 0) return false;
    return suffix ? st.buf.indexOf(suffix, a + prefix.length) >= 0 : st.buf.length > a + prefix.length;
  };
  if (!(await vm.waitUntil(ready, timeout))) return '';
  const a = prefix ? st.buf.indexOf(prefix) : 0;
  if (a < 0) return '';
  const from = a + prefix.length;
  const e = suffix ? st.buf.indexOf(suffix, from) : st.buf.length;
  if (e < 0) return '';
  const out = st.buf.slice(from, e);
  st.buf = st.buf.slice(e + suffix.length);
  return out;
}
// "(1.0, 2.0, 3.0)" 형식 → [개수, 값…] / 실패 시 [0, 0…]
async function sockReadFloats(vm, n, name, timeout) {
  const fail = [0, ...Array(Math.max(0, n)).fill(0)];
  const st = vm.urs.socks.get(name);
  if (!st) return fail;
  if (!(await vm.waitUntil(() => st.closed || /\([^)]*\)/.test(st.buf), timeout))) return fail;
  const m = /\(([^)]*)\)/.exec(st.buf);
  if (!m) return fail;
  st.buf = st.buf.slice(m.index + m[0].length);
  const vals = m[1].split(',').map((x) => Number(x.trim()));
  if (vals.length !== n || vals.some((x) => !Number.isFinite(x))) return fail;
  return [n, ...vals];
}

// ------------------------------------------------------------ 컴파일
const isScript = (n) => /\.(script|urscript|txt)$/i.test(n);

function spawnThread(vm, prog, name) {
  const td = prog.threads?.get(name);
  if (!td) throw err(`정의되지 않은 스레드 '${name}'`, 'NAME');
  const proc = prog.procs[td.key];
  const id = vm.urs.nextTid++;
  const owner = { threadId: id };
  const thr = { id, name, owner, aborted: false, done: null };
  // 스레드 전용 경량 VM 어댑터: 전역 변수/컨트롤러는 공유하되 대기 소유자(owner)와 중단 상태는 독립
  const tvm = {
    ctrl: vm.ctrl,
    prog,
    globals: vm.globals,
    urs: vm.urs,
    get aborted() { return thr.aborted || vm.aborted || vm.status !== 'running'; },
    print: (msg) => vm.print(msg),
    wait: (sec) => vm.ctrl.sleep(sec, owner),
    waitUntil: (pred, timeoutSec) => vm.ctrl.waitFor(pred, timeoutSec, owner),
  };
  thr.done = (async () => {
    const frames = [{ proc, pc: 0, locals: new Map() }];
    let steps = 0;
    try {
      while (frames.length && !tvm.aborted) {
        while (vm.ctrl.held && !tvm.aborted) await vm.ctrl.sleep(0.02, owner);
        if (tvm.aborted) break;
        const f = frames[frames.length - 1];
        if (f.pc >= f.proc.code.length) { frames.pop(); continue; }
        const ins = f.proc.code[f.pc];
        const r = await ins.run(tvm, f);
        if (tvm.aborted) break;
        if (!r) f.pc++;
        else if (r.goto !== undefined) f.pc = r.goto;
        else if (r.call) { f.pc++; frames.push({ proc: r.call.proc, pc: 0, locals: r.call.locals || new Map(), onReturn: r.call.onReturn }); }
        else if ('ret' in r) { frames.pop(); f.onReturn?.(r.ret); }
        else if (r.halt) break;
        if (++steps % 50 === 0) await vm.ctrl.sleep(0.004, owner);
      }
    } catch (e) {
      if (!e?.aborted && !tvm.aborted) vm.print(`[thread ${name} 오류] ${e?.message ?? e}`);
    } finally {
      vm.urs.threads.delete(id);
    }
  })();
  vm.urs.threads.set(id, thr);
  return id;
}

function compile(files, main, ctrl) {
  if (!files.has(main)) throw new CompileError(`메인 파일이 없습니다: ${main}`, main, 1);
  const prog = { lang: 'urscript', entry: 'MAIN', procs: {}, globals: new Map(), defs: new Map(), threads: new Map() };
  const tree = buildTree(logicalLines(files.get(main), main), main);
  // 다른 .script 파일의 def/thread 도 함께 등록 (공용 함수 라이브러리처럼)
  const libs = [...files.keys()].filter((f) => f !== main && isScript(f)).map((f) => ({ file: f, tree: buildTree(logicalLines(files.get(f), f), f) }));
  // def/thread 수집 (중첩 def/thread 포함 — 전역으로 등록)
  const collect = (nodes, file) => {
    for (const n of nodes) {
      if (n.kw === 'def') {
        const m = /^def\s+([A-Za-z_]\w*)\s*\((.*)\)\s*$/s.exec(n.head);
        if (!m) throw new CompileError('def 형식: def 이름(인수, …):', file, n.line);
        const params = [];
        if (m[2].trim()) {
          for (const part of splitTopComma(m[2])) {
            const pm = /^([A-Za-z_]\w*)\s*(?:=(.+))?$/s.exec(part.trim());
            if (!pm) throw new CompileError(`def ${m[1]}: 인수 형식 오류 '${part.trim()}'`, file, n.line);
            let def = null;
            if (pm[2] !== undefined) { try { def = parseExpr(pm[2]); } catch (e) { throw new CompileError(`def ${m[1]}: 기본값 오류: ${e.message}`, file, n.line); } }
            params.push({ name: pm[1], def });
          }
        }
        const key = `DEF:${m[1]}`;
        prog.procs[key] = { name: m[1], params: [], file, code: [], labels: {} };
        prog.defs.set(m[1], { key, params, node: n, file });
        collect(n.body, file);
      } else if (n.kw === 'thread') {
        const m = /^thread\s+([A-Za-z_]\w*)\s*\(\s*\)\s*$/s.exec(n.head);
        if (!m) throw new CompileError('thread 형식: thread 이름():', file, n.line);
        const key = `THR:${m[1]}`;
        prog.procs[key] = { name: m[1], params: [], file, code: [], labels: {} };
        prog.threads.set(m[1], { key, node: n, file });
        collect(n.body, file);
      } else if (n.kw === 'while') collect(n.body, file);
      else if (n.kw === 'if') { n.branches.forEach((b) => collect(b.body, file)); if (n.els) collect(n.els, file); }
    }
  };
  for (const l of libs) collect(l.tree, l.file);
  collect(tree, main);

  // 맨 위에 def 만 있으면 인수 없는 첫 def 를 프로그램으로 실행 (변수는 전역)
  const topStmts = tree.filter((n) => n.kw !== 'def' && n.kw !== 'thread');
  let progDef = null;
  if (!topStmts.length) {
    const first = tree.find((n) => n.kw === 'def');
    if (!first) throw new CompileError('실행할 내용이 없습니다', main, 1);
    const name = /^def\s+([A-Za-z_]\w*)/.exec(first.head)[1];
    progDef = prog.defs.get(name);
    if (progDef.params.some((p) => !p.def)) throw new CompileError(`프로그램 함수 ${name}() 은(는) 인수 없이 호출할 수 있어야 합니다`, main, first.line);
  }
  prog.procs.MAIN = { name: progDef ? progDef.node.head.match(/^def\s+(\w+)/)[1] : 'main', params: [], file: main, code: [], labels: {} };
  if (progDef) prog.procs[progDef.key] = prog.procs.MAIN;   // 프로그램 def 를 다시 부르면 처음부터
  const env = { file: main };
  if (progDef) compileBody(prog, prog.procs.MAIN, progDef.node.body.filter((n) => n.kw !== 'def' && n.kw !== 'thread'), { locals: null, globals: new Set(), file: main, top: true, fn: prog.procs.MAIN.name, env });
  else compileBody(prog, prog.procs.MAIN, topStmts, { locals: null, globals: new Set(), file: main, top: true, env });
  for (const [name, d] of prog.defs) {
    if (d === progDef) continue;
    const locals = new Set(d.params.map((p) => p.name));
    const globals = new Set();
    collectNames(d.node.body, locals, globals);
    for (const g of globals) locals.delete(g);
    compileBody(prog, prog.procs[d.key], d.node.body.filter((n) => n.kw !== 'def' && n.kw !== 'thread'), { locals, globals, file: d.file, fn: name, env });
  }
  for (const [name, td] of prog.threads) {
    const locals = new Set();
    const globals = new Set();
    collectNames(td.node.body, locals, globals);
    for (const g of globals) locals.delete(g);
    compileBody(prog, prog.procs[td.key], td.node.body.filter((n) => n.kw !== 'def' && n.kw !== 'thread'), { locals, globals, file: td.file, fn: name, env });
  }
  prog.init = (vm) => { vm.urs = { socks: new Map(), threads: new Map(), nextTid: 1 }; };
  prog.cleanup = (vm) => {
    for (const thr of vm.urs?.threads?.values() || []) { thr.aborted = true; vm.ctrl.wakeWaiters?.(thr.owner); }
    vm.urs?.threads?.clear();
    for (const st of vm.urs?.socks.values() || []) { st.sock?.destroy(); st.closed = true; }
    vm.urs?.socks.clear();
  };
  void ctrl;
  return prog;
}

function splitTopComma(s) {
  const out = [];
  let depth = 0, cur = '', q = null;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// 함수 안의 지역 이름: 대입된 이름 (global 선언 제외), local 선언 포함. 중첩 def/thread 는 제외
function collectNames(body, locals, globals) {
  for (const n of body) {
    if (n.kw === 'def' || n.kw === 'thread') continue;
    if (n.kw === 'while') { collectNames(n.body, locals, globals); continue; }
    if (n.kw === 'if') { n.branches.forEach((b) => collectNames(b.body, locals, globals)); if (n.els) collectNames(n.els, locals, globals); continue; }
    let m;
    if ((m = /^global\s+([A-Za-z_]\w*)/.exec(n.text))) { globals.add(m[1]); continue; }
    if ((m = /^local\s+([A-Za-z_]\w*)/.exec(n.text))) { locals.add(m[1]); continue; }
    const a = assignSplit(n.text);
    if (a && /^[A-Za-z_]\w*$/.test(a.target)) locals.add(a.target);
  }
}

// 대입문: "a = expr" / "a[i] = expr" / "a.b = expr" / "a += expr"
function assignSplit(text) {
  let t;
  try { t = tokenize(text); } catch { return null; }
  let depth = 0;
  for (const tok of t) {
    if (tok.k !== 'op') continue;
    if ('([{'.includes(tok.v)) depth++;
    else if (')]}'.includes(tok.v)) depth--;
    else if (depth === 0 && tok.v === '=') return { target: text.slice(0, tok.col).trim(), rhs: text.slice(tok.col + 1).trim() };
    else if (depth === 0 && ['+=', '-=', '*=', '/='].includes(tok.v)) return { aug: tok.v[0], target: text.slice(0, tok.col).trim(), rhs: text.slice(tok.col + 2).trim() };
  }
  return null;
}

function compileBody(prog, proc, body, sc) {
  const file = sc.file;
  const code = proc.code;
  const loops = [];
  let tmpN = 0;
  const emit = (line, run) => { const ins = { line, file, run }; code.push(ins); return ins; };
  const jump = (line, cond) => { const ins = emit(line, (vm, f) => (!cond || cond(vm, f) ? { goto: ins.to } : undefined)); return ins; };
  const ctxOf = (vm, f) => ({ vm, f, scope: sc });
  const parse = (src, line) => { try { return parseExpr(src); } catch (e) { throw new CompileError(`구문 오류: ${e.message}`, file, line); } };

  // 분리 대상 호출(사용자 함수·대기 함수)이 들어 있는지
  const hasHoisted = (n) => {
    if (!n || typeof n !== 'object') return false;
    if (Array.isArray(n)) return n.some(hasHoisted);
    if (n.t === 'call' && n.fn?.t === 'name' && (prog.defs.get(n.fn.name) || ASYNC[n.fn.name])) return true;
    for (const [k, v] of Object.entries(n)) {
      if (k === 'kw') { if (Object.values(v).some(hasHoisted)) return true; }
      else if (v && typeof v === 'object' && hasHoisted(v)) return true;
    }
    return false;
  };
  // and / or 의 오른쪽에 분리 대상 호출이 있으면 조건 점프로 단락 평가를 지킨다 (`ready and pick()` → ready 가 거짓이면 pick 미호출)
  const lowerShortCircuit = (n, line) => {
    const k = `$t${tmpN++}`;
    const a = val(lower(n.a, line));
    emit(line, (vm, f) => { f.locals.set(k, truthy(a(vm, f))); });
    const skip = jump(line, (vm, f) => (n.t === 'and' ? !f.locals.get(k) : f.locals.get(k)));
    const b = val(lower(n.b, line));
    emit(line, (vm, f) => { f.locals.set(k, truthy(b(vm, f))); });
    skip.to = code.length;
    return { t: 'tmp', k };
  };
  // 식 안의 사용자 함수·대기 함수 호출을 앞선 명령으로 분리
  const lower = (n, line) => {
    if (!n || typeof n !== 'object') return n;
    if (Array.isArray(n)) return n.map((x) => lower(x, line));
    if ((n.t === 'and' || n.t === 'or') && hasHoisted(n.b)) return lowerShortCircuit(n, line);
    const out = {};
    for (const [k, v] of Object.entries(n)) {
      if (k === 'kw') out.kw = Object.fromEntries(Object.entries(v).map(([a, b]) => [a, lower(b, line)]));
      else if (v && typeof v === 'object') out[k] = lower(v, line);
      else out[k] = v;
    }
    if (out.t === 'call' && out.fn.t === 'name') {
      const name = out.fn.name;
      const def = prog.defs.get(name);
      if (def || ASYNC[name]) {
        const k = `$t${tmpN++}`;
        const argAst = out.args, kwAst = out.kw;
        const evalArgs = (vm, f) => {
          const c = ctxOf(vm, f);
          return { args: argAst.map((a) => ev(a, c)), kw: Object.fromEntries(Object.entries(kwAst).map(([a, b]) => [a, ev(b, c)])) };
        };
        if (def) {
          emit(line, (vm, f) => {
            const { args, kw } = evalArgs(vm, f);
            return { call: { proc: prog.procs[def.key], locals: bindCall(vm, name, def, args, kw), onReturn: (v) => f.locals.set(k, v === undefined ? null : v) } };
          });
        } else {
          const fn = ASYNC[name];
          emit(line, async (vm, f) => {
            const { args, kw } = evalArgs(vm, f);
            const v = await fn(vm, args, kw);
            f.locals.set(k, v === undefined ? null : v);
          });
        }
        return { t: 'tmp', k };
      }
    }
    return out;
  };
  const checkCallable = (n, line) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach((x) => checkCallable(x, line)); return; }
    if (n.t === 'runThread' && !prog.threads.has(n.name)) {
      throw new CompileError(`정의되지 않은 스레드 '${n.name}'`, file, line);
    }
    if (n.t === 'call' && n.fn.t === 'name') {
      const nm = n.fn.name;
      if (!SYNC[nm] && !ASYNC[nm] && !prog.defs.has(nm))
        throw new CompileError(`알 수 없는 함수 ${nm}() — 에뮬레이터가 지원하지 않는 URScript 함수일 수 있습니다`, file, line);
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === 'kw') Object.values(v).forEach((x) => checkCallable(x, line));
      else if (v && typeof v === 'object') checkCallable(v, line);
    }
  };
  const E = (src, line) => { const a = parse(src, line); checkCallable(a, line); return lower(a, line); };
  const val = (ast) => (vm, f) => ev(ast, ctxOf(vm, f));

  const store = (tAst, line, forceGlobal = false) => {
    if (tAst.t === 'name') {
      const nm = tAst.name;
      if (nm in CONSTS) throw new CompileError(`상수 ${nm} 에는 대입할 수 없습니다`, file, line);
      const local = !forceGlobal && sc.locals && sc.locals.has(nm) && !sc.globals.has(nm);
      return (vm, f, v) => { (local ? f.locals : vm.globals).set(nm, v); };
    }
    if (tAst.t === 'index') {
      const o = val(tAst.obj), i = val(tAst.idx);
      return (vm, f, v) => {
        const arr = o(vm, f);
        if (!Array.isArray(arr)) throw err(`${typeOf(arr)} 의 요소는 바꿀 수 없습니다`);
        arr[normIndex(arr, i(vm, f))] = isPose(arr) ? num(v) : v;
      };
    }
    if (tAst.t === 'field') {
      const o = val(tAst.obj);
      const fld = tAst.field;
      return (vm, f, v) => {
        const obj = o(vm, f);
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw err(`${typeOf(obj)} 의 속성 '${fld}' 는 바꿀 수 없습니다`);
        obj[fld] = v;
      };
    }
    throw new CompileError('대입할 수 없는 대상입니다', file, line);
  };

  const stmt = (n) => {
    const line = n.line;
    if (n.kw === 'while') return whileLoop(n);
    if (n.kw === 'if') return ifChain(n);
    if (n.kw === 'def' || n.kw === 'thread') return;
    let text = n.text;
    let m;
    if (text === 'pass') return;
    if (text === 'break' || text === 'continue') {
      const L = loops[loops.length - 1];
      if (!L) throw new CompileError(`${text} 는 while 안에서만 쓸 수 있습니다`, file, line);
      (text === 'break' ? L.breaks : L.conts).push(jump(line, null));
      return;
    }
    if (text === 'halt') { emit(line, () => ({ halt: true })); return; }
    if ((m = /^return\b\s*(.*)$/s.exec(text))) {
      // 프로그램 본체(MAIN)에서의 return = 프로그램 종료
      const isMain = proc === prog.procs.MAIN;
      if (m[1]) { const v = val(E(m[1], line)); emit(line, (vm, f) => (isMain ? { halt: true } : { ret: v(vm, f) })); }
      else emit(line, () => (isMain ? { halt: true } : { ret: null }));
      return;
    }
    if ((m = /^join\s+(.+)$/s.exec(text))) {
      const hv = val(E(m[1], line));
      emit(line, async (vm, f) => {
        const thr = vm.urs?.threads?.get(hv(vm, f));
        if (thr?.done) await thr.done;
      });
      return;
    }
    if ((m = /^kill\s+(.+)$/s.exec(text))) {
      const hv = val(E(m[1], line));
      emit(line, (vm, f) => {
        const id = hv(vm, f);
        const thr = vm.urs?.threads?.get(id);
        if (thr) { thr.aborted = true; vm.ctrl.wakeWaiters?.(thr.owner); vm.urs.threads.delete(id); }
      });
      return;
    }
    let forceGlobal = false;
    if ((m = /^global\s+(.*)$/s.exec(text))) {
      if (/^[A-Za-z_]\w*$/.test(m[1].trim())) return;   // 선언만
      text = m[1]; forceGlobal = true;
    } else if ((m = /^local\s+(.*)$/s.exec(text))) {
      if (/^[A-Za-z_]\w*$/.test(m[1].trim())) return;
      text = m[1];
    }
    const a = assignSplit(text);
    if (a) {
      const tAst = parse(a.target, line);
      if (!['name', 'index', 'field'].includes(tAst.t)) throw new CompileError('대입할 수 없는 대상입니다', file, line);
      const rhs = val(E(a.rhs, line)), set = store(tAst, line, forceGlobal);
      if (a.aug) { const get = val(tAst); emit(line, (vm, f) => set(vm, f, binop(a.aug, get(vm, f), rhs(vm, f)))); }
      else emit(line, (vm, f) => set(vm, f, rhs(vm, f)));
      return;
    }
    if (forceGlobal) throw new CompileError('global 뒤에는 변수 이름 또는 대입이 와야 합니다', file, line);
    const ast = parse(text, line);
    if (ast.t === 'str' || ast.t === 'num') return;
    checkCallable(ast, line);
    const low = lower(ast, line);
    if (low.t === 'tmp') return;
    const v = val(low);
    emit(line, (vm, f) => { v(vm, f); });
  };

  const whileLoop = (n) => {
    const line = n.line;
    const top = code.length;
    const c = E(n.head.replace(/^while\b/, '').trim() || 'True', line);
    const exit = jump(line, (vm, f) => !truthy(ev(c, ctxOf(vm, f))));
    const L = { breaks: [], conts: [] };
    loops.push(L);
    list(n.body);
    loops.pop();
    jump(line, null).to = top;
    exit.to = code.length;
    L.breaks.forEach((b) => { b.to = code.length; });
    L.conts.forEach((b) => { b.to = top; });
  };
  const ifChain = (n) => {
    const ends = [];
    for (const b of n.branches) {
      const c = E(b.cond, b.line);
      const skip = jump(b.line, (vm, f) => !truthy(ev(c, ctxOf(vm, f))));
      list(b.body);
      ends.push(jump(b.line, null));
      skip.to = code.length;
    }
    if (n.els) list(n.els);
    ends.forEach((e) => { e.to = code.length; });
  };
  const list = (nodes) => { for (const n of nodes) stmt(n); };
  list(body);
}

function bindCall(vm, name, def, args, kw) {
  const L = new Map();
  if (args.length > def.params.length) throw err(`${name}(): 인수가 너무 많습니다 (최대 ${def.params.length}개)`);
  def.params.forEach((p, i) => { if (i < args.length) L.set(p.name, args[i]); });
  for (const [k, v] of Object.entries(kw)) {
    if (!def.params.some((p) => p.name === k)) throw err(`${name}(): 알 수 없는 키워드 인수 '${k}'`);
    if (L.has(k)) throw err(`${name}(): 인수 '${k}' 가 두 번 지정되었습니다`);
    L.set(k, v);
  }
  for (const p of def.params) {
    if (L.has(p.name)) continue;
    if (!p.def) throw err(`${name}(): 인수 '${p.name}' 가 필요합니다`);
    L.set(p.name, ev(p.def, { vm, f: { locals: new Map() }, scope: { locals: null, globals: new Set() } }));
  }
  return L;
}

// ------------------------------------------------------------ 예제 생성
function toolOf(ctrl) { return ctrl.gripper ? ctrl.tool : frameFromXYZRPY([0, 0, 150, 0, 0, 0]); }

function planPickPlace(ctrl) {
  const r = ctrl.robot;
  const tool = toolOf(ctrl);
  const ok = (p) => !!ikNearest(r, tcpToFlange({ p, R: DOWN }, tool, null), r.home);
  const objs = ctrl.objects || [];
  if (!objs.length) return { app: 100, ok: true, pts: [] };
  const s = objs[0].size[2];
  const app = Math.round(Math.max(80, s * 2.5));
  const R = r.reach;
  let fxOk = null;
  for (const fx of [0.38, 0.42, 0.34, 0.46, 0.30, 0.50]) {
    const all = objs.every((o) => {
      const pk = o.pose.p, pl = [Math.round(R * fx), -pk[1], o.size[2] / 2 + 1];
      return ok(pk) && ok([pk[0], pk[1], pk[2] + app]) && ok(pl) && ok([pl[0], pl[1], pl[2] + app]);
    });
    if (all) { fxOk = fx; break; }
  }
  const fx = fxOk ?? 0.4;
  return { app, ok: fxOk !== null, pts: objs.map((o) => ({ id: o.id, pick: [...o.pose.p], place: [Math.round(R * fx), -o.pose.p[1], o.size[2] / 2 + 1] })) };
}

const f5 = (v) => { const x = Math.abs(v) < 5e-6 ? 0 : v; return String(+x.toFixed(5)); };

function defaultFiles(ctrl) {
  const r = ctrl.robot;
  const { app, ok, pts } = planPickPlace(ctrl);
  const pp = (p) => { const v = toVendorPose(VENDOR, { p, R: DOWN }); return `p[${[v[0] / 1000, v[1] / 1000, v[2] / 1000, v[3], v[4], v[5]].map(f5).join(', ')}]`; };
  const main = [
    `# 픽 앤 플레이스 예제 (${r.name}) — 공작물 ${pts[0].id}~${pts[pts.length - 1].id} 를 Y 대칭 위치로 이송`,
    '# 단위: 위치 m, 각도 rad. 자세 p[x, y, z, rx, ry, rz] = 베이스 좌표 + 회전 벡터',
    '# I/O : 표준 DO0 = 그리퍼 닫기, DO1 = 열기, DI0 닫힘 확인, DI1 열림 확인, DI2 공작물 감지',
    '# 에뮬레이터 참고: 맨 위에 def 만 있으면 그 def 를 프로그램으로 실행합니다 (PolyScope 스크립트와 같음)',
    ...(ok ? [] : ['# 경고: 일부 위치가 현재 로봇의 작업영역 밖일 수 있음']),
    'def pick_and_place():',
    `  global home_q = [${r.home.map((d) => f5(d * DEG)).join(', ')}]`,
    `  global approach = p[0, 0, ${f5(app / 1000)}, 0, 0, 0]   # 접근 오프셋 (베이스 Z)`,
    '  global picks = [',
    ...pts.map((q, i) => `    ${pp(q.pick)}${i < pts.length - 1 ? ',' : ''}`),
    '  ]',
    '  global places = [',
    ...pts.map((q, i) => `    ${pp(q.place)}${i < pts.length - 1 ? ',' : ''}`),
    '  ]',
    '',
    '  # 입력이 켜질 때까지 대기 (timeout 초) → True / False',
    '  def wait_input(n, timeout):',
    '    t = 0',
    '    while not get_standard_digital_in(n):',
    '      if t >= timeout:',
    '        return False',
    '      end',
    '      sleep(0.01)',
    '      t = t + 0.01',
    '    end',
    '    return True',
    '  end',
    '',
    '  def grip():',
    '    set_standard_digital_out(1, False)',
    '    set_standard_digital_out(0, True)',
    '    wait_input(0, 3)',
    '    sleep(0.2)',
    '  end',
    '',
    '  def release():',
    '    set_standard_digital_out(0, False)',
    '    set_standard_digital_out(1, True)',
    '    wait_input(1, 3)',
    '    sleep(0.2)',
    '    set_standard_digital_out(1, False)',
    '  end',
    '',
    '  movej(home_q, a=1.4, v=1.05)',
    '  release()',
    '  i = 0',
    '  while i < length(picks):',
    '    pick_up = pose_add(picks[i], approach)',
    '    place_up = pose_add(places[i], approach)',
    '    movej(get_inverse_kin(pick_up), a=1.4, v=1.05, r=0.03)',
    '    movel(picks[i], a=1.2, v=0.2)',
    '    grip()',
    '    if not get_standard_digital_in(2):',
    '      popup("공작물 미검출 — 정지", "오류", False, True)',
    '      release()',
    '      halt',
    '    end',
    '    movel(pick_up, a=1.2, v=0.5, r=0.03)',
    '    movej(get_inverse_kin(place_up), a=1.4, v=1.05, r=0.03)',
    '    movel(places[i], a=1.2, v=0.2)',
    '    release()',
    '    movel(place_up, a=1.2, v=0.5, r=0.03)',
    '    i = i + 1',
    '  end',
    '  movej(home_q, a=1.4, v=1.05)',
    '  textmsg("완료: ", to_str(i), " 개 이송")',
    'end',
    '',
  ].join('\n');
  return { 'main.script': main };
}

// ------------------------------------------------------------ 모듈
function pickMain(names) {
  const d = names.filter(isScript);
  if (!d.length) return names[0] ?? null;
  return d.find((n) => /^main\.script$/i.test(n)) ?? d.sort()[0];
}

function readVar(ctrl, name) {
  const s = String(name).trim();
  const m = /^(DO|DI)(\d+)$/i.exec(s);
  if (m) return (m[1].toUpperCase() === 'DO' ? ctrl.getDO(Number(m[2])) : ctrl.getDI(Number(m[2]))) ? 1 : 0;
  const g = ctrl.vm?.globals ?? ctrl.program?.globals;
  if (!g?.has(s)) return undefined;
  const v = g.get(s);
  return Array.isArray(v) ? [...v] : v;
}

function writeVar(ctrl, name, value) {
  const s = String(name).trim();
  const m = /^(DO|DI)(\d+)$/i.exec(s);
  if (m) { const on = truthy(typeof value === 'string' ? Number(value) : value); if (m[1].toUpperCase() === 'DO') ctrl.setDO(Number(m[2]), on); else ctrl.setDI(Number(m[2]), on); return true; }
  if (!/^[A-Za-z_]\w*$/.test(s) || s in CONSTS) return false;
  const g = ctrl.vm?.globals ?? ctrl.program?.globals;
  if (!g) return false;
  let v = value;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) v = Number(v);
  const old = g.get(s);
  if (isPose(old) && Array.isArray(v) && v.length === 6) v = mkPose(v);
  g.set(s, v);
  return true;
}

export default {
  id: 'urscript', name: 'URScript', exts: ['.script', '.urscript'],
  compile, pickMain, defaultFiles, readVar, writeVar,
};

// 테스트·통신 모듈용
export const _internal = { tokenize, parseExpr, logicalLines, buildTree, str, mkPose, toPose, fromPose };
