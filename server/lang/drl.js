// Doosan Robotics DRL (Doosan Robot Language) 인터프리터 — 파이썬 문법의 부분집합
//
// 파일 : main.drl (+ 다른 .drl/.py 파일은 sub_program_run("이름") 으로 실행). 주석은 #.
// 문법 : 들여쓰기 블록, def(기본값·키워드 인수), return, global, if/elif/else, while, for … in, break, continue, pass,
//        대입(a = …, a[i] = …, a, b = …), 복합 대입(+= -= *= /= //= %=), 한 줄 블록(if x: stmt), ; 구분
// 식   : + - * / // % **, 비교(연쇄 포함), and/or/not, in/not in, is/is not, x if c else y, 리스트·튜플, 인덱스·슬라이스,
//        문자열 '…' "…" b"…" f"…{식}…", True/False/None, 문자열·리스트 메서드 일부 (append, pop, split, strip, format, decode …)
// 에뮬레이터 구현 방식 (파이썬과 다른 점)
//  - 사용자 함수와 기다리는 내장 함수(movej·wait·소켓 읽기 등)는 식 안에서 호출해도 되지만, 그 문장의 다른 부분보다 먼저
//    (왼쪽에서 오른쪽으로) 실행된다. 따라서 `a and f()` 처럼 써도 f() 는 a 와 관계없이 호출된다.
//  - 딕셔너리, 클래스, 예외 처리(try), import 대상 모듈의 함수는 지원하지 않는다 (import / from … import 줄은 무시).
//  - amove* (비동기 이동) 는 동기 이동과 같게 처리하고 mwait() 은 남은 모션을 기다린다.
//  - movejx 의 sol(해 공간) 은 무시하고 현재 자세에서 가장 가까운 해를 쓴다. movec 의 angle, 모든 acc/ra 는 무시한다.
//  - set_tcp / set_tool 은 펜던트에 등록된 이름을 알 수 없으므로 기록만 하고, 툴은 화면에서 고른 그리퍼 TCP 를 쓴다.
//
// 위치 : posj(J1..J6) [deg], posx(X, Y, Z, A, B, C) [mm, deg — ZYZ 오일러, 베이스 좌표]. 6개짜리 리스트도 허용.
// 속도 : movej vel = 관절 속도(deg/s, 가장 오래 걸리는 축 기준), time = 이동 시간(s). movel vel = [mm/s, deg/s] 또는 mm/s
//        radius = 블렌딩 반경(mm). 생략 시 set_velj/set_velx 값.
// I/O  : set_digital_output(n, ON/OFF), get_digital_input(n), wait_digital_input(n, ON, timeout) → 0 / -1(타임아웃)
// 소켓 : server_socket_open(port) (클라이언트 접속까지 대기), client_socket_open(ip, port),
//        *_socket_write(sock, data) → 0/-1, *_socket_read(sock, length=-1, timeout=-1) → (res, data), *_socket_close(sock)
//        res: 받은 바이트 수, -1 연결 끊김, -3 타임아웃. 프로그램이 끝나면 열린 소켓은 모두 닫힌다.
import net from 'node:net';
import { CompileError, RuntimeErr } from './common.js';
import { toVendorPose, fromVendorPose, frameFromXYZRPY } from '../../shared/poseformat.js';
import { ikNearest, tcpToFlange, fkTcp } from '../../shared/kinematics.js';
import { poseMul, mul3, add, sub, norm } from '../../shared/math.js';

const VENDOR = 'doosan';
const DOWN = [[-1, 0, 0], [0, 1, 0], [0, 0, -1]];
const DR_BASE = 0, DR_TOOL = 1, DR_WORLD = 2, MOD_ABS = 0, MOD_REL = 1;
const CONSTS = {
  ON: 1, OFF: 0, True: true, False: false, None: null,
  DR_BASE, DR_TOOL, DR_WORLD, DR_MV_MOD_ABS: MOD_ABS, DR_MV_MOD_REL: MOD_REL,
  DR_MV_RA_DUPLICATE: 0, DR_MV_RA_OVERRIDE: 1, DR_MV_APP_NONE: 0,
  DR_PM_MESSAGE: 0, DR_PM_WARNING: 1, DR_PM_ALARM: 2,
  DR_SSTOP: 2, DR_QSTOP: 1, DR_HOLD: 3, DR_AVOID: 0, DR_TASK_STOP: 1, DR_VAR_VEL: 2,
  DR_PI: Math.PI,
};

// ------------------------------------------------------------ 값
// posj/posx: 배열 + 숨김 속성 kind ('posj'|'posx'). 튜플: 동결 배열
const mkPos = (kind, arr) => { const a = arr.map(Number); Object.defineProperty(a, 'kind', { value: kind, enumerable: false }); return a; };
const isPos = (v, kind) => Array.isArray(v) && (kind ? v.kind === kind : !!v.kind);
const tuple = (arr) => Object.freeze(arr);

function pyType(v) {
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'string') return 'str';
  if (isPos(v)) return v.kind;
  if (Array.isArray(v)) return Object.isFrozen(v) ? 'tuple' : 'list';
  if (v?.$sock) return 'socket';
  return 'object';
}
const err = (msg, code = 'VAR') => new RuntimeErr(code, msg);

function repr(v) { return typeof v === 'string' ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : str(v); }
function str(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : (Number.isNaN(v) ? 'nan' : (v > 0 ? 'inf' : '-inf'));
  if (typeof v === 'string') return v;
  if (isPos(v)) return `${v.kind}(${v.map((x) => +x.toFixed(3)).join(', ')})`;
  if (Array.isArray(v)) { const t = Object.isFrozen(v); return (t ? '(' : '[') + v.map(repr).join(', ') + (t && v.length === 1 ? ',' : '') + (t ? ')' : ']'); }
  if (v?.$sock) return `<socket ${v.id}>`;
  return String(v);
}
const truthy = (v) => !(v === null || v === undefined || v === false || v === 0 || v === '' || (Array.isArray(v) && v.length === 0));
const num = (v, what = '값') => {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v !== 'number') throw err(`${what}: 숫자가 필요합니다 (${pyType(v)})`);
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
const PUNCT = ['**=', '//=', '**', '//', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '->', '+', '-', '*', '/', '%', '<', '>', '=', '(', ')', '[', ']', '{', '}', ',', ':', '.', ';', '&', '|', '^', '~', '@'];
const ESC = { n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', f: '\f', v: '\v' };

function readString(src, i) {
  const m = /^([rRbBfFuU]{0,2})('''|"""|'|")/.exec(src.slice(i));
  if (!m) return null;
  const pre = m[1].toLowerCase(), q = m[2];
  const raw = pre.includes('r'), fmt = pre.includes('f');
  let j = i + m[0].length, s = '';
  for (;;) {
    if (j >= src.length) throw new Error('문자열이 닫히지 않았습니다');
    if (src.startsWith(q, j)) { j += q.length; break; }
    const ch = src[j];
    if (ch === '\\' && !raw) {
      const n = src[j + 1];
      if (n === 'x' && /^[0-9a-fA-F]{2}/.test(src.slice(j + 2))) { s += String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16)); j += 4; continue; }
      if (n === '\n') { j += 2; continue; }
      if (n in ESC) { s += ESC[n]; j += 2; continue; }
      s += ch; j++; continue;
    }
    if (q.length === 1 && ch === '\n') throw new Error('문자열이 닫히지 않았습니다');
    s += ch; j++;
  }
  return { end: j, tok: fmt ? { k: 'fstr', v: s } : { k: 'str', v: s } };
}

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (' \t\r\n\\\f'.includes(ch)) { i++; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    const col = i;
    if (ch === '"' || ch === "'" || (/[rRbBfFuU]/.test(ch) && /^[rRbBfFuU]{1,2}['"]/.test(src.slice(i, i + 3)))) {
      const r = readString(src, i);
      if (r) { toks.push({ ...r.tok, col }); i = r.end; continue; }
    }
    let m;
    if ((m = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)/.exec(src.slice(i))) && /[0-9.]/.test(ch)) {
      const t = m[0].replace(/_/g, '');
      const v = /^0[xX]/.test(t) ? parseInt(t.slice(2), 16) : /^0[bB]/.test(t) ? parseInt(t.slice(2), 2) : /^0[oO]/.test(t) ? parseInt(t.slice(2), 8) : parseFloat(t);
      toks.push({ k: 'num', v, col }); i += m[0].length; continue;
    }
    if ((m = /^[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*/.exec(src.slice(i)))) { toks.push({ k: 'id', v: m[0], col }); i += m[0].length; continue; }
    const op = PUNCT.find((o) => src.startsWith(o, i));
    if (op) { toks.push({ k: 'op', v: op, col }); i += op.length; continue; }
    throw new Error(`알 수 없는 문자 '${ch}'`);
  }
  toks.push({ k: 'eof', v: '', col: src.length });
  return toks;
}

// ------------------------------------------------------------ 파서 (식)
// AST: num/str/fstr{parts}/name/list/tuple/un/bin/cmp{ops,items}/and/or/not/ifx/call{fn,args,kw}/attr/index/slice/tmp
const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'is', 'if', 'else', 'elif', 'for', 'while', 'def', 'return', 'pass', 'break', 'continue', 'global', 'lambda', 'import', 'from', 'class', 'try', 'except', 'finally', 'with', 'as', 'yield', 'del', 'assert', 'raise', 'nonlocal']);

class P {
  constructor(src) { this.src = src; this.t = tokenize(src); this.i = 0; }
  peek(o = 0) { return this.t[Math.min(this.i + o, this.t.length - 1)]; }
  next() { return this.t[this.i++] ?? this.t[this.t.length - 1]; }
  eof() { return this.peek().k === 'eof'; }
  isOp(v, o = 0) { const t = this.peek(o); return t.k === 'op' && t.v === v; }
  isKw(v, o = 0) { const t = this.peek(o); return t.k === 'id' && t.v === v; }
  op(v) { if (this.isOp(v)) { this.i++; return true; } return false; }
  kw(v) { if (this.isKw(v)) { this.i++; return true; } return false; }
  expect(v) { if (!this.op(v)) throw new Error(`'${v}' 가 필요합니다 (발견: '${this.peek().v || '줄 끝'}')`); }
  name() { const t = this.next(); if (t.k !== 'id' || KEYWORDS.has(t.v)) throw new Error(`이름이 필요합니다 (발견: '${t.v || '줄 끝'}')`); return t.v; }

  // 쉼표로 이어진 식 → 2개 이상이면 튜플
  exprList() {
    const first = this.expr();
    if (!this.isOp(',')) return first;
    const items = [first];
    while (this.op(',')) { if (this.eof() || this.isOp('=') || this.isOp(')')) break; items.push(this.expr()); }
    return { t: 'tuple', items };
  }
  expr() {
    if (this.isKw('lambda')) throw new Error('lambda 는 지원하지 않습니다');
    const a = this.or();
    if (this.kw('if')) { const c = this.or(); if (!this.kw('else')) throw new Error("조건식에 'else' 가 필요합니다"); return { t: 'ifx', c, a, b: this.expr() }; }
    return a;
  }
  or() { let a = this.and(); while (this.kw('or')) a = { t: 'or', a, b: this.and() }; return a; }
  and() { let a = this.not(); while (this.kw('and')) a = { t: 'and', a, b: this.not() }; return a; }
  not() { if (this.kw('not')) return { t: 'not', a: this.not() }; return this.cmp(); }
  cmp() {
    const first = this.bor();
    const ops = [], items = [first];
    for (;;) {
      let op = null;
      const t = this.peek();
      if (t.k === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(t.v)) { this.next(); op = t.v; }
      else if (this.kw('in')) op = 'in';
      else if (this.isKw('not') && this.isKw('in', 1)) { this.i += 2; op = 'not in'; }
      else if (this.kw('is')) op = this.kw('not') ? 'is not' : 'is';
      if (!op) break;
      ops.push(op); items.push(this.bor());
    }
    return ops.length ? { t: 'cmp', ops, items } : first;
  }
  bor() { let a = this.bxor(); while (this.isOp('|')) { this.next(); a = { t: 'bin', op: '|', a, b: this.bxor() }; } return a; }
  bxor() { let a = this.band(); while (this.isOp('^')) { this.next(); a = { t: 'bin', op: '^', a, b: this.band() }; } return a; }
  band() { let a = this.arith(); while (this.isOp('&')) { this.next(); a = { t: 'bin', op: '&', a, b: this.arith() }; } return a; }
  arith() {
    let a = this.term();
    while (this.isOp('+') || this.isOp('-')) { const op = this.next().v; a = { t: 'bin', op, a, b: this.term() }; }
    return a;
  }
  term() {
    let a = this.factor();
    while (['*', '/', '//', '%', '@'].some((o) => this.isOp(o))) { const op = this.next().v; a = { t: 'bin', op, a, b: this.factor() }; }
    return a;
  }
  factor() {
    if (this.isOp('-') || this.isOp('+') || this.isOp('~')) { const op = this.next().v; return { t: 'un', op, a: this.factor() }; }
    return this.power();
  }
  power() {
    const a = this.postfix(this.atom());
    if (this.op('**')) return { t: 'bin', op: '**', a, b: this.factor() };
    return a;
  }
  atom() {
    const t = this.next();
    if (t.k === 'num') return { t: 'num', v: t.v };
    if (t.k === 'str' || t.k === 'fstr') {
      // 인접 문자열 연결
      const parts = [t];
      while (this.peek().k === 'str' || this.peek().k === 'fstr') parts.push(this.next());
      if (parts.every((p) => p.k === 'str')) return { t: 'str', v: parts.map((p) => p.v).join('') };
      const out = [];
      for (const p of parts) if (p.k === 'str') out.push(p.v); else out.push(...fstrParts(p.v));
      return { t: 'fstr', parts: out };
    }
    if (t.k === 'id') {
      if (t.v === 'True') return { t: 'const', v: true };
      if (t.v === 'False') return { t: 'const', v: false };
      if (t.v === 'None') return { t: 'const', v: null };
      if (KEYWORDS.has(t.v)) throw new Error(`예상치 못한 키워드 '${t.v}'`);
      return { t: 'name', name: t.v };
    }
    if (t.k === 'op' && t.v === '(') {
      if (this.op(')')) return { t: 'tuple', items: [] };
      const first = this.expr();
      if (this.op(')')) return first;
      const items = [first];
      while (this.op(',')) { if (this.isOp(')')) break; items.push(this.expr()); }
      this.expect(')');
      return { t: 'tuple', items };
    }
    if (t.k === 'op' && t.v === '[') {
      const items = [];
      while (!this.isOp(']')) {
        items.push(this.expr());
        if (this.isKw('for')) throw new Error('리스트 컴프리헨션은 지원하지 않습니다');
        if (!this.op(',')) break;
      }
      this.expect(']');
      return { t: 'list', items };
    }
    if (t.k === 'op' && t.v === '{') throw new Error('딕셔너리/집합은 지원하지 않습니다');
    throw new Error(`예상치 못한 '${t.v || '줄 끝'}'`);
  }
  postfix(n) {
    for (;;) {
      if (this.op('(')) {
        const args = [], kw = {};
        while (!this.isOp(')')) {
          if (this.isOp('*') || this.isOp('**')) throw new Error('*args / **kwargs 는 지원하지 않습니다');
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
        let idx;
        if (this.isOp(':') || this.isOp(']')) idx = this.slice(null);
        else { const a = this.expr(); idx = this.isOp(':') ? this.slice(a) : a; }
        this.expect(']');
        n = { t: 'index', obj: n, idx };
      } else if (this.isOp('.') && this.peek(1).k === 'id') {
        this.next();
        n = { t: 'attr', obj: n, name: this.next().v };
      } else return n;
    }
  }
  slice(lo) {
    this.expect(':');
    const hi = this.isOp(']') || this.isOp(':') ? null : this.expr();
    let step = null;
    if (this.op(':')) step = this.isOp(']') ? null : this.expr();
    return { t: 'slice', lo, hi, step };
  }
}

function fstrParts(s) {
  const out = [];
  let i = 0, cur = '';
  while (i < s.length) {
    const ch = s[i];
    if (ch === '{' && s[i + 1] === '{') { cur += '{'; i += 2; continue; }
    if (ch === '}' && s[i + 1] === '}') { cur += '}'; i += 2; continue; }
    if (ch === '{') {
      let depth = 1, j = i + 1;
      while (j < s.length && depth) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; if (depth) j++; }
      if (depth) throw new Error("f 문자열의 '{' 가 닫히지 않았습니다");
      let inner = s.slice(i + 1, j), spec = null;
      const c = inner.lastIndexOf(':');
      if (c > 0 && !/[\]\)'"]/.test(inner.slice(c))) { spec = inner.slice(c + 1); inner = inner.slice(0, c); }
      if (cur) out.push(cur);
      cur = '';
      out.push({ ast: parseExpr(inner), spec });
      i = j + 1; continue;
    }
    cur += ch; i++;
  }
  if (cur) out.push(cur);
  return out;
}

function parseExpr(src) {
  const p = new P(src);
  const e = p.exprList();
  if (!p.eof()) throw new Error(`식 뒤에 불필요한 '${p.peek().v}'`);
  return e;
}

// ------------------------------------------------------------ 소스 → 논리 줄 → 블록 트리
// 괄호 안 줄바꿈·역슬래시 연속·여러 줄 문자열을 한 줄로 합치고 주석을 지운다. indent: 첫 물리 줄의 들여쓰기 폭
function logicalLines(text, file) {
  const src = String(text).replace(/\r\n?/g, '\n');
  const out = [];
  let i = 0, line = 1;
  while (i < src.length) {
    // 줄 시작: 들여쓰기 측정
    let indent = 0, j = i;
    while (j < src.length && (src[j] === ' ' || src[j] === '\t')) { indent = src[j] === '\t' ? (Math.floor(indent / 8) + 1) * 8 : indent + 1; j++; }
    const startLine = line;
    let buf = '', depth = 0;
    i = j;
    for (;;) {
      if (i >= src.length) break;
      const ch = src[i];
      if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (ch === '"' || ch === "'") {
        const q = src.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
        let k = i + q.length;
        for (;;) {
          if (k >= src.length) throw new CompileError('문자열이 닫히지 않았습니다', file, startLine);
          if (src[k] === '\\') { if (src[k + 1] === '\n') line++; k += 2; continue; }
          if (src.startsWith(q, k)) { k += q.length; break; }
          if (src[k] === '\n') { if (q.length === 1) throw new CompileError('문자열이 닫히지 않았습니다', file, line); line++; }
          k++;
        }
        buf += src.slice(i, k); i = k; continue;
      }
      if (ch === '\\' && src[i + 1] === '\n') { buf += ' '; i += 2; line++; continue; }
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
      if (ch === '\n') {
        line++; i++;
        if (depth === 0) break;
        buf += ' '; continue;
      }
      buf += ch; i++;
    }
    if (buf.trim()) out.push({ line: startLine, indent, text: buf.trim() });
  }
  return out;
}

// 문장 끝 ':' (블록 시작) 위치 → { head, tail } / 없으면 null
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
// ; 로 나뉜 단순 문장
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

const COMPOUND = /^(if|elif|else|while|for|def|try|except|finally|with|class)\b/;
function buildTree(lines, file) {
  let i = 0;
  const block = (indent) => {
    const out = [];
    while (i < lines.length) {
      const L = lines[i];
      if (L.indent < indent) break;
      if (L.indent > indent) throw new CompileError('들여쓰기가 맞지 않습니다', file, L.line);
      i++;
      const kw = COMPOUND.exec(L.text)?.[1];
      if (kw) {
        const h = splitHeader(L.text);
        if (!h) throw new CompileError(`'${kw}' 문 끝에 ':' 가 필요합니다`, file, L.line);
        const node = { line: L.line, kw, head: h.head, body: [] };
        if (h.tail) node.body = splitSemi(h.tail).map((s) => ({ line: L.line, text: s }));
        else {
          if (i >= lines.length || lines[i].indent <= indent) throw new CompileError(`'${kw}' 블록이 비어 있습니다 (들여쓴 줄 또는 pass 필요)`, file, L.line);
          node.body = block(lines[i].indent);
        }
        out.push(node);
      } else for (const s of splitSemi(L.text)) out.push({ line: L.line, text: s });
    }
    return out;
  };
  const tree = block(lines[0]?.indent ?? 0);
  if (i < lines.length) throw new CompileError('들여쓰기가 맞지 않습니다', file, lines[i].line);
  return tree;
}

// ------------------------------------------------------------ 평가기 (동기)
// ctx: { vm, f, scope } — scope.locals: 함수 지역 이름 집합 (모듈 수준이면 null)
function ev(n, c) {
  switch (n.t) {
    case 'num': case 'str': return n.v;
    case 'const': return n.v;
    case 'tmp': return c.f.locals.get(n.k);
    case 'fstr': return n.parts.map((p) => (typeof p === 'string' ? p : fmtSpec(ev(p.ast, c), p.spec))).join('');
    case 'name': return readName(n.name, c);
    case 'list': return n.items.map((x) => ev(x, c));
    case 'tuple': return tuple(n.items.map((x) => ev(x, c)));
    case 'un': {
      const a = ev(n.a, c);
      if (n.op === '-') return -num(a);
      if (n.op === '+') return num(a);
      return ~int(a);
    }
    case 'not': return !truthy(ev(n.a, c));
    case 'and': { const a = ev(n.a, c); return truthy(a) ? ev(n.b, c) : a; }
    case 'or': { const a = ev(n.a, c); return truthy(a) ? a : ev(n.b, c); }
    case 'ifx': return truthy(ev(n.c, c)) ? ev(n.a, c) : ev(n.b, c);
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
    case 'index': {
      const o = ev(n.obj, c);
      if (n.idx.t === 'slice') return sliceOf(o, n.idx, c);
      return indexOf(o, ev(n.idx, c));
    }
    case 'attr': throw err(`속성 '.${n.name}' 은(는) 지원하지 않습니다`);
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
  throw err(`정의되지 않은 이름 '${name}'`, 'NAME');
}

function fmtSpec(v, spec) {
  if (!spec) return str(v);
  const m = /^([<>^]?)(\d*)(?:\.(\d+))?([dfs%]?)$/.exec(spec);
  if (!m) throw err(`지원하지 않는 서식 지정자 ':${spec}'`);
  let s;
  if (m[4] === 'd') s = String(Math.trunc(num(v)));
  else if (m[4] === 'f' || (m[3] !== undefined && m[4] === '')) s = num(v).toFixed(m[3] !== undefined ? Number(m[3]) : 6);
  else if (m[4] === '%') s = (num(v) * 100).toFixed(m[3] !== undefined ? Number(m[3]) : 6) + '%';
  else s = str(v);
  const w = Number(m[2] || 0);
  if (s.length < w) {
    const al = m[1] || (typeof v === 'number' ? '>' : '<');
    s = al === '<' ? s.padEnd(w) : al === '>' ? s.padStart(w) : s.padStart(Math.floor((w + s.length) / 2)).padEnd(w);
  }
  return s;
}

function binop(op, a, b) {
  if (op === '+') {
    if (typeof a === 'string' && typeof b === 'string') return a + b;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (isPos(a) || isPos(b)) throw err('posj/posx 끼리는 + 로 더할 수 없습니다 — 위치 이동은 trans(pos, [dx,dy,dz,da,db,dc]) 를 쓰세요');
      const r = [...a, ...b]; return Object.isFrozen(a) ? tuple(r) : r;
    }
    if (typeof a === 'string' || typeof b === 'string') throw err(`str 과 ${pyType(typeof a === 'string' ? b : a)} 는 더할 수 없습니다 — str() 로 바꾸세요`);
  }
  if (op === '*') {
    if (typeof a === 'string' && typeof b === 'number') return a.repeat(Math.max(0, int(b)));
    if (Array.isArray(a) && typeof b === 'number' && !isPos(a)) { const r = []; for (let i = 0; i < int(b); i++) r.push(...a); return r; }
  }
  if (op === '%' && typeof a === 'string') return percentFormat(a, b);
  const x = num(a, `연산자 ${op}`), y = num(b, `연산자 ${op}`);
  switch (op) {
    case '+': return x + y;
    case '-': return x - y;
    case '*': return x * y;
    case '/': if (y === 0) throw err('0 으로 나누었습니다', 'ZERODIV'); return x / y;
    case '//': if (y === 0) throw err('0 으로 나누었습니다', 'ZERODIV'); return Math.floor(x / y);
    case '%': if (y === 0) throw err('0 으로 나누었습니다', 'ZERODIV'); return x - y * Math.floor(x / y);
    case '**': return x ** y;
    case '&': return int(x) & int(y);
    case '|': return int(x) | int(y);
    case '^': return int(x) ^ int(y);
  }
  throw err(`지원하지 않는 연산자 ${op}`);
}

function percentFormat(fmt, args) {
  const list = Array.isArray(args) && Object.isFrozen(args) ? [...args] : [args];
  let k = 0;
  const s = fmt.replace(/%([-0]?)(\d*)(?:\.(\d+))?([dfisx%])/g, (_, fl, w, p, t) => {
    if (t === '%') return '%';
    if (k >= list.length) throw err('% 서식의 인수가 부족합니다');
    const v = list[k++];
    let r = t === 'd' || t === 'i' ? String(Math.trunc(num(v))) : t === 'f' ? num(v).toFixed(p !== undefined ? Number(p) : 6) : t === 'x' ? Math.trunc(num(v)).toString(16) : str(v);
    const W = Number(w || 0);
    if (r.length < W) r = fl === '-' ? r.padEnd(W) : r.padStart(W, fl === '0' ? '0' : ' ');
    return r;
  });
  if (k < list.length) throw err('% 서식의 인수가 남습니다');
  return s;
}

function compare(op, a, b) {
  switch (op) {
    case '==': return eq(a, b);
    case '!=': return !eq(a, b);
    case 'is': return a === b || (a == null && b == null);
    case 'is not': return !(a === b || (a == null && b == null));
    case 'in': case 'not in': {
      let r;
      if (typeof b === 'string') { if (typeof a !== 'string') throw err("'in' 왼쪽에는 문자열이 필요합니다"); r = b.includes(a); }
      else if (Array.isArray(b)) r = b.some((x) => eq(x, a));
      else throw err(`${pyType(b)} 에는 'in' 을 쓸 수 없습니다`);
      return op === 'in' ? r : !r;
    }
  }
  if (typeof a === 'string' && typeof b === 'string') return op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b;
  const x = num(a, `비교 ${op}`), y = num(b, `비교 ${op}`);
  return op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y;
}

function normIndex(o, i) {
  if (typeof o !== 'string' && !Array.isArray(o)) throw err(`${pyType(o)} 에는 [] 를 쓸 수 없습니다`);
  let k = int(i);
  if (k < 0) k += o.length;
  if (k < 0 || k >= o.length) throw err(`인덱스 ${int(i)} 가 범위를 벗어났습니다 (길이 ${o.length})`, 'INDEX');
  return k;
}
const indexOf = (o, i) => o[normIndex(o, i)];
function sliceOf(o, s, c) {
  if (typeof o !== 'string' && !Array.isArray(o)) throw err(`${pyType(o)} 에는 슬라이스를 쓸 수 없습니다`);
  const n = o.length;
  const step = s.step ? int(ev(s.step, c)) : 1;
  if (step === 0) throw err('슬라이스 간격은 0 이 될 수 없습니다');
  const fix = (v, d) => { if (v === null) return d; let k = int(v); if (k < 0) k += n; return step > 0 ? Math.min(Math.max(k, 0), n) : Math.min(Math.max(k, -1), n - 1); };
  const lo = fix(s.lo ? ev(s.lo, c) : null, step > 0 ? 0 : n - 1), hi = fix(s.hi ? ev(s.hi, c) : null, step > 0 ? n : -1);
  const out = [];
  for (let k = lo; step > 0 ? k < hi : k > hi; k += step) out.push(o[k]);
  if (typeof o === 'string') return out.join('');
  return isPos(o) && out.length === 6 ? mkPos(o.kind, out) : Object.isFrozen(o) ? tuple(out) : out;
}

// 인수 바인딩: spec = ['pos', 'vel', ...]; alias = { v: 'vel', ... }
function bindArgs(fname, spec, args, kw, alias = {}) {
  if (args.length > spec.length) throw err(`${fname}(): 인수가 너무 많습니다 (최대 ${spec.length}개)`);
  const o = {};
  args.forEach((v, i) => { o[spec[i]] = v; });
  for (const [k0, v] of Object.entries(kw)) {
    const k = alias[k0] || k0;
    if (!spec.includes(k)) throw err(`${fname}(): 알 수 없는 키워드 인수 '${k0}'`);
    if (k in o) throw err(`${fname}(): 인수 '${k}' 가 두 번 지정되었습니다`);
    o[k] = v;
  }
  return o;
}

const MATH1 = { sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, ceil: Math.ceil, floor: Math.floor, exp: Math.exp, log10: Math.log10, fabs: Math.abs };

function toList(v, fname) {
  if (typeof v === 'string') return [...v];
  if (Array.isArray(v)) return [...v];
  throw err(`${fname}(): 반복 가능한 값이 필요합니다 (${pyType(v)})`);
}
function posArgs(kind, args) {
  const a = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  if (a.length !== 6) throw err(`${kind}(): 값 6개가 필요합니다 (${a.length}개)`);
  return mkPos(kind, a.map((x) => num(x, kind)));
}
const asJ = (v, fname) => {
  if (isPos(v, 'posx')) throw err(`${fname}(): posj 가 필요합니다 (posx 는 movejx/movel 사용)`);
  if (!Array.isArray(v) || v.length < 6) throw err(`${fname}(): posj(6개 관절값) 가 필요합니다`);
  return v.slice(0, 6).map((x) => num(x, fname));
};
const asX = (v, fname) => {
  if (isPos(v, 'posj')) throw err(`${fname}(): posx 가 필요합니다 (posj 는 movej 사용)`);
  if (!Array.isArray(v) || v.length < 6) throw err(`${fname}(): posx(X,Y,Z,A,B,C) 가 필요합니다`);
  return v.slice(0, 6).map((x) => num(x, fname));
};
const toPose = (arr) => fromVendorPose(VENDOR, arr);
const toPosx = (pose) => mkPos('posx', toVendorPose(VENDOR, pose).map((x) => Math.round(x * 1e6) / 1e6));

// DRL 상대 위치 해석: ref=DR_TOOL → 현재(또는 기준) 포즈 × delta, mod=REL(베이스) → 위치 더하기·회전 앞곱
function applyDelta(base, delta, ref) {
  if (ref === DR_TOOL) return poseMul(base, delta);
  return { p: add(base.p, delta.p), R: mul3(delta.R, base.R) };
}

function sigNo(v, fname) {
  const n = int(v);
  if (n === 0) throw err(`${fname}(): 신호 번호는 1 이상이어야 합니다`, 'IO');
  return n;
}

function callSync(n, c) {
  if (n.fn.t === 'attr') return callMethod(ev(n.fn.obj, c), n.fn.name, n.args.map((a) => ev(a, c)), n);
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

function callMethod(o, m, args) {
  if (typeof o === 'string') {
    switch (m) {
      case 'upper': return o.toUpperCase();
      case 'lower': return o.toLowerCase();
      case 'strip': return args.length ? o.replace(new RegExp(`^[${esc(args[0])}]+|[${esc(args[0])}]+$`, 'g'), '') : o.trim();
      case 'lstrip': return o.trimStart();
      case 'rstrip': return o.trimEnd();
      case 'split': { if (!args.length || args[0] === null) return o.trim().split(/\s+/).filter(Boolean); return o.split(String(args[0])); }
      case 'replace': return o.split(String(args[0])).join(String(args[1]));
      case 'startswith': return o.startsWith(String(args[0]));
      case 'endswith': return o.endsWith(String(args[0]));
      case 'find': return o.indexOf(String(args[0]));
      case 'join': return toList(args[0], 'join').map((x) => { if (typeof x !== 'string') throw err('join(): 문자열 목록이 필요합니다'); return x; }).join(o);
      case 'encode': case 'decode': return o; // 바이트 = 문자열로 다룸
      case 'format': { let k = 0; return o.replace(/\{(\d*)(?::([^}]*))?\}/g, (_, i, spec) => fmtSpec(args[i === '' ? k++ : Number(i)], spec)); }
      case 'isdigit': return o.length > 0 && /^\d+$/.test(o);
      case 'count': return o.split(String(args[0])).length - 1;
    }
  }
  if (Array.isArray(o)) {
    const frozen = Object.isFrozen(o);
    switch (m) {
      case 'append': if (frozen || isPos(o)) break; o.push(args[0]); return null;
      case 'extend': if (frozen || isPos(o)) break; o.push(...toList(args[0], 'extend')); return null;
      case 'insert': if (frozen || isPos(o)) break; o.splice(int(args[0]) < 0 ? Math.max(0, o.length + int(args[0])) : int(args[0]), 0, args[1]); return null;
      case 'pop': { if (frozen || isPos(o)) break; if (!o.length) throw err('빈 리스트에서 pop()', 'INDEX'); const k = args.length ? normIndex(o, args[0]) : o.length - 1; return o.splice(k, 1)[0]; }
      case 'remove': { if (frozen || isPos(o)) break; const k = o.findIndex((x) => eq(x, args[0])); if (k < 0) throw err('remove(): 값이 리스트에 없습니다'); o.splice(k, 1); return null; }
      case 'index': { const k = o.findIndex((x) => eq(x, args[0])); if (k < 0) throw err('index(): 값이 없습니다'); return k; }
      case 'count': return o.filter((x) => eq(x, args[0])).length;
      case 'clear': if (frozen || isPos(o)) break; o.length = 0; return null;
      case 'reverse': if (frozen) break; o.reverse(); return null;
      case 'sort': if (frozen) break; o.sort((a, b) => (compare('<', a, b) ? -1 : compare('<', b, a) ? 1 : 0)); return null;
      case 'copy': return isPos(o) ? mkPos(o.kind, o) : [...o];
    }
  }
  throw err(`${pyType(o)} 에는 메서드 .${m}() 가 없습니다`);
}
const esc = (s) => String(s).replace(/[\]\\^-]/g, '\\$&');

// ------------------------------------------------------------ 내장 함수 (동기)
const S = (c) => c.vm.drl;
const SYNC = {
  print: (c, args) => { c.vm.print(args.map(str).join(' ')); return null; },
  tp_log: (c, args) => { c.vm.print(str(args[0])); return null; },
  tp_popup: (c, args) => { const lv = ['', '[경고] ', '[알람] '][int(args[1] ?? 0)] ?? ''; c.vm.print(`(팝업) ${lv}${str(args[0])}`); return null; },
  text_popup: (c, args) => { c.vm.print(`(팝업) ${str(args[0])}`); return null; },
  len: (c, [v]) => { if (typeof v === 'string' || Array.isArray(v)) return v.length; throw err(`len(): ${pyType(v)} 에는 길이가 없습니다`); },
  abs: (c, [v]) => Math.abs(num(v)),
  int: (c, [v]) => { if (typeof v === 'string') { const x = Number(v.trim()); if (!Number.isInteger(x)) throw err(`int(): '${v}' 를 정수로 바꿀 수 없습니다`); return x; } return Math.trunc(num(v)); },
  float: (c, [v]) => { if (typeof v === 'string') { const x = Number(v.trim()); if (Number.isNaN(x) || !v.trim()) throw err(`float(): '${v}' 를 실수로 바꿀 수 없습니다`); return x; } return num(v); },
  str: (c, [v]) => str(v),
  bool: (c, [v]) => truthy(v),
  round: (c, [v, d]) => { const k = d === undefined || d === null ? 0 : int(d); const p = 10 ** k; return Math.round(num(v) * p) / p; },
  min: (c, args) => { const a = args.length === 1 ? toList(args[0], 'min') : args; if (!a.length) throw err('min(): 빈 목록'); return a.reduce((x, y) => (compare('<', y, x) ? y : x)); },
  max: (c, args) => { const a = args.length === 1 ? toList(args[0], 'max') : args; if (!a.length) throw err('max(): 빈 목록'); return a.reduce((x, y) => (compare('>', y, x) ? y : x)); },
  sum: (c, [v]) => toList(v, 'sum').reduce((s, x) => s + num(x), 0),
  range: (c, args) => {
    const [a, b, s] = args.length === 1 ? [0, int(args[0]), 1] : [int(args[0]), int(args[1]), args[2] === undefined ? 1 : int(args[2])];
    if (s === 0) throw err('range(): 간격은 0 이 될 수 없습니다');
    const out = [];
    for (let k = a; s > 0 ? k < b : k > b; k += s) { out.push(k); if (out.length > 1e6) throw err('range(): 너무 큽니다'); }
    return out;
  },
  list: (c, [v]) => (v === undefined ? [] : toList(v, 'list')),
  tuple: (c, [v]) => tuple(v === undefined ? [] : toList(v, 'tuple')),
  enumerate: (c, [v, s]) => toList(v, 'enumerate').map((x, i) => tuple([i + (s === undefined ? 0 : int(s)), x])),
  zip: (c, args) => { const ls = args.map((a) => toList(a, 'zip')); const n = Math.min(...ls.map((l) => l.length)); return Array.from({ length: n }, (_, i) => tuple(ls.map((l) => l[i]))); },
  reversed: (c, [v]) => toList(v, 'reversed').reverse(),
  sorted: (c, [v]) => toList(v, 'sorted').sort((a, b) => (compare('<', a, b) ? -1 : compare('<', b, a) ? 1 : 0)),
  type: (c, [v]) => pyType(v),
  pow: (c, [a, b]) => num(a) ** num(b),
  atan2: (c, [y, x]) => Math.atan2(num(y), num(x)),
  log: (c, [v, b]) => (b === undefined ? Math.log(num(v)) : Math.log(num(v)) / Math.log(num(b))),
  d2r: (c, [v]) => num(v) * Math.PI / 180,
  r2d: (c, [v]) => num(v) * 180 / Math.PI,
  ...Object.fromEntries(Object.entries(MATH1).map(([k, f]) => [k, (c, [v]) => f(num(v))])),

  posj: (c, args) => posArgs('posj', args.length ? args : [[0, 0, 0, 0, 0, 0]]),
  posx: (c, args) => posArgs('posx', args.length ? args : [[0, 0, 0, 0, 0, 0]]),

  // I/O (컨트롤러 범용 DI/DO, 1부터)
  set_digital_output: (c, args, kw) => {
    const o = bindArgs('set_digital_output', ['index', 'val'], args, kw);
    let n = int(o.index), on;
    if (o.val === undefined || o.val === null) { on = n > 0; n = Math.abs(n); } else on = truthy(o.val);
    c.vm.ctrl.setDO(sigNo(n, 'set_digital_output'), on);
    return null;
  },
  get_digital_input: (c, [n]) => (c.vm.ctrl.getDI(sigNo(n, 'get_digital_input')) ? 1 : 0),
  get_digital_output: (c, [n]) => (c.vm.ctrl.getDO(sigNo(n, 'get_digital_output')) ? 1 : 0),

  // 현재 위치
  get_current_posj: (c) => mkPos('posj', c.vm.ctrl.joints.map((x) => Math.round(x * 1e6) / 1e6)),
  get_current_posx: (c) => tuple([toPosx(c.vm.ctrl.tcpPose()), 2]),
  get_current_pose: (c) => toPosx(c.vm.ctrl.tcpPose()),
  fkin: (c, args, kw) => {
    const o = bindArgs('fkin', ['pos', 'ref'], args, kw);
    return toPosx(fkTcp(c.vm.ctrl.robot, asJ(o.pos, 'fkin'), c.vm.ctrl.tool, null));
  },
  ikin: (c, args, kw) => {
    const o = bindArgs('ikin', ['pos', 'sol_space', 'ref'], args, kw);
    const ct = c.vm.ctrl;
    const j = ikNearest(ct.robot, tcpToFlange(toPose(asX(o.pos, 'ikin')), ct.tool, null), ct.joints);
    if (!j) throw err('ikin(): 도달할 수 없는 위치입니다', 'IK');
    return mkPos('posj', j);
  },
  trans: (c, args, kw) => {
    const o = bindArgs('trans', ['pos', 'delta', 'ref', 'ref_out'], args, kw);
    const r = applyDelta(toPose(asX(o.pos, 'trans')), toPose(asX(o.delta, 'trans')), o.ref === undefined ? DR_BASE : int(o.ref));
    return toPosx(r);
  },

  // 속도·좌표 설정
  set_velj: (c, [v]) => { S(c).velj = num(v, 'set_velj'); return null; },
  set_accj: (c, [v]) => { S(c).accj = num(v, 'set_accj'); return null; },
  set_velx: (c, args) => { S(c).velx = [num(args[0], 'set_velx'), args[1] === undefined ? null : num(args[1])]; return null; },
  set_accx: (c, args) => { S(c).accx = num(args[0], 'set_accx'); return null; },
  set_ref_coord: (c, [v]) => { S(c).ref = int(v); return null; },
  set_tcp: (c, [v]) => { c.vm.print(`set_tcp("${str(v)}") — 에뮬레이터는 화면에서 고른 그리퍼 TCP 를 사용합니다`); return null; },
  set_tool: (c, [v]) => { c.vm.print(`set_tool("${str(v)}") — 에뮬레이터는 툴 무게를 반영하지 않습니다`); return null; },
  set_singular_handling: () => null,
  set_palletizing_operation: () => null,
  drl_report_line: () => null,
  check_motion: (c) => (c.vm.ctrl.motionIdle ? 0 : 2),

  // 소켓 (쓰기·닫기는 즉시)
  server_socket_write: (c, [s, d]) => sockWrite(c, s, d),
  client_socket_write: (c, [s, d]) => sockWrite(c, s, d),
  server_socket_close: (c, [s]) => { sockClose(c, s); return null; },
  client_socket_close: (c, [s]) => { sockClose(c, s); return null; },
  server_socket_state: (c, [s]) => (sockOf(s).closed ? -1 : 0),
  client_socket_state: (c, [s]) => (sockOf(s).closed ? -1 : 0),
};

// ------------------------------------------------------------ 내장 함수 (대기 — 문장으로 분리해 실행)
const MOVE_ALIAS = { v: 'vel', a: 'acc', t: 'time', r: 'radius' };

function jointFrac(ctrl, j, vel, time) {
  const r = ctrl.robot, q0 = ctrl.joints;
  const d = j.map((x, i) => Math.abs(x - q0[i]));
  const need = Math.max(...d.map((x, i) => x / r.maxSpeed[i]));   // 최고속으로 걸리는 시간(s)
  const dmax = Math.max(...d);
  const cl = (x) => Math.min(1, Math.max(0.001, x));
  if (time > 0) return cl(need > 0 ? need / time : 1);
  if (!(vel > 0)) throw err('movej: 속도(vel)가 필요합니다 — vel= 을 주거나 set_velj() 로 설정하세요', 'MOTION');
  if (dmax < 1e-6) return cl(vel / Math.min(...r.maxSpeed));
  return cl(need * vel / dmax);
}
const radiusOf = (o) => (o.radius === undefined || o.radius === null ? 0 : Math.max(0, num(o.radius, 'radius')));

async function doMoveJ(vm, j, o) {
  const S0 = vm.drl;
  const vel = o.vel === undefined ? S0.velj : num(Array.isArray(o.vel) ? o.vel[0] : o.vel, 'vel');
  const time = o.time === undefined ? 0 : num(o.time, 'time');
  const frac = jointFrac(vm.ctrl, j, vel, time);
  await vm.move({ kind: 'J', target: { joints: j }, speed: { frac }, zone: radiusOf(o) });
}
function linSpeed(vm, o, dist) {
  const S0 = vm.drl;
  let v, r = null;
  if (o.vel === undefined) [v, r] = S0.velx;
  else if (Array.isArray(o.vel)) { v = num(o.vel[0], 'vel'); r = o.vel[1] === undefined ? null : num(o.vel[1], 'vel'); }
  else v = num(o.vel, 'vel');
  const time = o.time === undefined ? 0 : num(o.time, 'time');
  if (time > 0) v = Math.max(1, dist / time);
  if (!(v > 0)) throw err('movel: 속도(vel)가 필요합니다 — vel= 을 주거나 set_velx() 로 설정하세요', 'MOTION');
  return r ? { tcp: v, rot: r } : { tcp: v };
}
function resolveX(vm, val, o, fname) {
  const ref = o.ref === undefined ? vm.drl.ref : int(o.ref);
  const mod = o.mod === undefined ? MOD_ABS : int(o.mod);
  const P = toPose(asX(val, fname));
  if (ref === DR_TOOL || mod === MOD_REL) return applyDelta(vm.ctrl.tcpPose(), P, ref);
  return P;
}

async function movej(vm, args, kw) {
  const o = bindArgs('movej', ['pos', 'vel', 'acc', 'time', 'radius', 'mod', 'ra'], args, kw, MOVE_ALIAS);
  let j = asJ(o.pos, 'movej');
  if (o.mod !== undefined && int(o.mod) === MOD_REL) j = j.map((x, i) => x + vm.ctrl.joints[i]);
  await doMoveJ(vm, j, o);
}
async function movejx(vm, args, kw) {
  const o = bindArgs('movejx', ['pos', 'vel', 'acc', 'time', 'radius', 'ref', 'mod', 'ra', 'sol'], args, kw, MOVE_ALIAS);
  const ct = vm.ctrl;
  const pose = resolveX(vm, o.pos, o, 'movejx');
  const j = ikNearest(ct.robot, tcpToFlange(pose, ct.tool, null), ct.joints);
  if (!j) throw err('movejx: 도달할 수 없는 위치입니다', 'IK');
  await doMoveJ(vm, j, o);
}
async function movel(vm, args, kw) {
  const o = bindArgs('movel', ['pos', 'vel', 'acc', 'time', 'radius', 'ref', 'mod', 'ra', 'app_type'], args, kw, MOVE_ALIAS);
  const pose = resolveX(vm, o.pos, o, 'movel');
  const speed = linSpeed(vm, o, norm(sub(pose.p, vm.ctrl.tcpPose().p)));
  await vm.move({ kind: 'L', target: { pose }, speed, zone: radiusOf(o) });
}
async function movec(vm, args, kw) {
  const o = bindArgs('movec', ['pos1', 'pos2', 'vel', 'acc', 'time', 'radius', 'ref', 'mod', 'angle', 'ra', 'ori', 'app_type'], args, kw, { ...MOVE_ALIAS, an: 'angle' });
  const via = resolveX(vm, o.pos1, o, 'movec'), pose = resolveX(vm, o.pos2, o, 'movec');
  const dist = norm(sub(via.p, vm.ctrl.tcpPose().p)) + norm(sub(pose.p, via.p));
  await vm.move({ kind: 'C', via: { pose: via }, target: { pose }, speed: linSpeed(vm, o, dist), zone: radiusOf(o) });
}
// 스플라인 → 경유점 블렌딩 근사 (마지막 점만 정위치)
async function movesj(vm, args, kw) {
  const o = bindArgs('movesj', ['pos_list', 'vel', 'acc', 'time', 'mod'], args, kw, MOVE_ALIAS);
  const list = toList(o.pos_list, 'movesj');
  if (!list.length) return;
  const each = o.time === undefined ? undefined : num(o.time) / list.length;
  for (let i = 0; i < list.length; i++) {
    let j = asJ(list[i], 'movesj');
    if (o.mod !== undefined && int(o.mod) === MOD_REL) j = j.map((x, k) => x + vm.ctrl.joints[k]);
    await doMoveJ(vm, j, { vel: o.vel, time: each, radius: i < list.length - 1 ? 20 : 0 });
  }
}
async function movesx(vm, args, kw) {
  const o = bindArgs('movesx', ['pos_list', 'vel', 'acc', 'time', 'ref', 'mod', 'vel_opt'], args, kw, MOVE_ALIAS);
  const list = toList(o.pos_list, 'movesx');
  const each = o.time === undefined ? undefined : num(o.time) / Math.max(1, list.length);
  for (let i = 0; i < list.length; i++) {
    const pose = resolveX(vm, list[i], o, 'movesx');
    const speed = linSpeed(vm, { vel: o.vel, time: each }, norm(sub(pose.p, vm.ctrl.tcpPose().p)));
    await vm.move({ kind: 'L', target: { pose }, speed, zone: i < list.length - 1 ? 20 : 0 });
  }
}

const ASYNC = {
  movej, movejx, movel, movec, movesj, movesx,
  amovej: movej, amovejx: movejx, amovel: movel, amovec: movec, amovesj: movesj, amovesx: movesx,
  wait: async (vm, [t]) => { await vm.wait(Math.max(0, num(t, 'wait'))); return null; },
  mwait: async (vm) => { await vm.waitUntil(() => vm.ctrl.motionIdle); return 0; },
  wait_digital_input: async (vm, args, kw) => {
    const o = bindArgs('wait_digital_input', ['sig_num', 'val', 'timeout'], args, kw);
    const n = sigNo(o.sig_num, 'wait_digital_input');
    const want = o.val === undefined ? true : truthy(o.val);
    const to = o.timeout === undefined || num(o.timeout) < 0 ? Infinity : num(o.timeout);
    const ok = await vm.waitUntil(() => vm.ctrl.getDI(n) === want, to);
    if (!ok) vm.print(`wait_digital_input(${n}) 타임아웃 (${to}s)`);
    return ok ? 0 : -1;
  },
  server_socket_open: (vm, args, kw) => { const o = bindArgs('server_socket_open', ['port'], args, kw); return serverOpen(vm, int(o.port)); },
  client_socket_open: (vm, args, kw) => { const o = bindArgs('client_socket_open', ['ip', 'port'], args, kw); return clientOpen(vm, str(o.ip), int(o.port)); },
  server_socket_read: (vm, args, kw) => sockRead(vm, bindArgs('server_socket_read', ['sock', 'length', 'timeout'], args, kw)),
  client_socket_read: (vm, args, kw) => sockRead(vm, bindArgs('client_socket_read', ['sock', 'length', 'timeout'], args, kw)),
};

// ------------------------------------------------------------ 소켓
let sockSeq = 0;
const sockOf = (s) => { if (!s?.$sock) throw err(`소켓이 아닙니다 (${pyType(s)})`, 'SOCKET'); return s.$sock; };
function track(vm, st) { vm.drl.socks.add(st); return { $sock: st, id: st.id }; }
function attach(vm, st, sock) {
  st.sock = sock; st.closed = false;
  sock.on('data', (d) => { st.buf = Buffer.concat([st.buf, d]); });
  sock.on('close', () => { st.closed = true; });
  sock.on('error', () => { st.closed = true; });
}
async function serverOpen(vm, port) {
  const st = { id: ++sockSeq, buf: Buffer.alloc(0), closed: true, sock: null, server: null, error: null };
  const server = net.createServer((s) => {
    if (st.sock && !st.closed) { s.destroy(); return; }   // 한 번에 클라이언트 하나
    attach(vm, st, s);
    vm.ctrl.log('comm', `[DRL] 서버 소켓 ${port}: 클라이언트 접속 ${s.remoteAddress}:${s.remotePort}`);
   
  });
  st.server = server;
  const h = track(vm, st);
  await new Promise((res) => {
    server.once('error', (e) => { st.error = e; res(); });
    server.listen(port, vm.ctrl.netHost || undefined, () => res());
  });
  if (st.error) { vm.drl.socks.delete(st); throw err(`server_socket_open(${port}): ${st.error.code === 'EADDRINUSE' ? '포트가 이미 사용 중입니다' : st.error.message}`, 'SOCKET'); }
  vm.ctrl.log('comm', `[DRL] 서버 소켓 ${port} 대기 중`);
  await vm.waitUntil(() => st.sock && !st.closed);
  return h;
}
async function clientOpen(vm, ip, port) {
  const st = { id: ++sockSeq, buf: Buffer.alloc(0), closed: true, sock: null, server: null };
  const h = track(vm, st);
  for (let tries = 0; ; tries++) {
    const r = await new Promise((res) => {
      const s = net.connect({ host: ip, port });
      s.once('connect', () => res(s));
      s.once('error', (e) => { s.destroy(); res(e); });
    });
    if (!(r instanceof Error)) { attach(vm, st, r); vm.ctrl.log('comm', `[DRL] 클라이언트 소켓 ${ip}:${port} 연결`); return h; }
    if (tries === 0) vm.ctrl.log('comm', `[DRL] ${ip}:${port} 연결 실패 (${r.code || r.message}) — 재시도 중`);
    await vm.wait(0.5);
  }
}
function sockWrite(c, s, d) {
  const st = sockOf(s);
  if (st.closed || !st.sock) return -1;
  const data = typeof d === 'string' ? Buffer.from(d, 'latin1') : Array.isArray(d) ? Buffer.from(d.map(int)) : null;
  if (!data) throw err(`소켓 쓰기: 문자열/바이트가 필요합니다 (${pyType(d)})`, 'SOCKET');
  st.sock.write(data);
  return 0;
}
async function sockRead(vm, o) {
  const st = sockOf(o.sock);
  const len = o.length === undefined ? -1 : int(o.length);
  const to = o.timeout === undefined || num(o.timeout) < 0 ? Infinity : num(o.timeout);
  const ready = () => st.closed || (len > 0 ? st.buf.length >= len : st.buf.length > 0);
  const ok = await vm.waitUntil(ready, to);
  if (!st.buf.length) return tuple([ok ? -1 : -3, null]);
  const n = len > 0 ? Math.min(len, st.buf.length) : st.buf.length;
  const out = st.buf.subarray(0, n);
  st.buf = st.buf.subarray(n);
  return tuple([n, out.toString('latin1')]);
}
function sockClose(c, s) {
  const st = sockOf(s);
  st.sock?.destroy(); st.server?.close();
  st.closed = true;
  c.vm.drl.socks.delete(st);
}

// ------------------------------------------------------------ 컴파일
const isDrl = (n) => /\.(drl|py)$/i.test(n);
const baseName = (n) => n.replace(/\.(drl|py)$/i, '');

function compile(files, main, ctrl) {
  if (!files.has(main)) throw new CompileError(`메인 파일이 없습니다: ${main}`, main, 1);
  const prog = { lang: 'drl', entry: null, procs: {}, globals: new Map(), defs: new Map() };
  const pending = [];
  const modules = new Map();   // 파일 → 모듈 proc 키
  const needModule = (fname) => {
    if (modules.has(fname)) return modules.get(fname);
    const key = `MOD:${fname}`;
    modules.set(fname, key);
    prog.procs[key] = { name: baseName(fname), params: [], file: fname, code: [], labels: {} };
    pending.push(fname);
    return key;
  };
  const findFile = (ref) => {
    const s = String(ref);
    for (const fn of files.keys()) if (fn === s || baseName(fn) === s || baseName(fn).toLowerCase() === s.toLowerCase()) return fn;
    return null;
  };
  prog.entry = needModule(main);
  // 1단계: 모든 파일의 트리와 def 이름 수집 (호출 순서와 무관하게 이름 해석)
  const trees = new Map();
  const getTree = (fname) => {
    if (!trees.has(fname)) trees.set(fname, buildTree(logicalLines(files.get(fname), fname), fname));
    return trees.get(fname);
  };
  while (pending.length) {
    const fname = pending.shift();
    compileModule(prog, fname, getTree(fname), { needModule, findFile, files, getTree });
  }
  prog.init = (vm) => { vm.drl = { velj: 0, accj: 0, velx: [0, null], accx: 0, ref: DR_BASE, socks: new Set() }; };
  prog.cleanup = (vm) => {
    for (const st of vm.drl?.socks || []) { st.sock?.destroy(); st.server?.close(); st.closed = true; }
    vm.drl?.socks.clear();
  };
  void ctrl;
  return prog;
}

// 파일 하나: 최상위 코드 → 모듈 proc, def → 함수 proc
function compileModule(prog, file, tree, env) {
  // def 를 먼저 등록 (같은 이름이 여러 파일에 있으면 나중 것이 이김 — 파이썬 import * 와 비슷)
  for (const n of tree) {
    if (n.kw !== 'def') continue;
    const m = /^def\s+([A-Za-z_]\w*)\s*\((.*)\)\s*(?:->.*)?$/s.exec(n.head);
    if (!m) throw new CompileError('def 형식: def 이름(인수, …):', file, n.line);
    const params = [];
    if (m[2].trim()) {
      for (const part of splitTopComma(m[2])) {
        const pm = /^([A-Za-z_]\w*)\s*(?::[^=]+)?(?:=(.+))?$/s.exec(part.trim());
        if (!pm) throw new CompileError(`def ${m[1]}: 인수 형식 오류 '${part.trim()}'`, file, n.line);
        let def = null;
        if (pm[2] !== undefined) { try { def = parseExpr(pm[2]); } catch (e) { throw new CompileError(`def ${m[1]}: 기본값 오류: ${e.message}`, file, n.line); } }
        else if (params.some((p) => p.def)) throw new CompileError(`def ${m[1]}: 기본값 있는 인수 뒤에 기본값 없는 인수`, file, n.line);
        params.push({ name: pm[1], def });
      }
    }
    const key = `DEF:${m[1]}`;
    prog.procs[key] = { name: m[1], params: [], file, code: [], labels: {} };
    prog.defs.set(m[1], { key, params, node: n, file });
  }
  const modKey = `MOD:${file}`;
  compileBody(prog, prog.procs[modKey], tree, { locals: null, globals: new Set(), env, file, top: true });
  for (const [name, d] of prog.defs) {
    if (d.file !== file || d.done) continue;
    d.done = true;
    const locals = new Set(d.params.map((p) => p.name));
    const globals = new Set();
    collectNames(d.node.body, locals, globals, file);
    for (const g of globals) locals.delete(g);
    compileBody(prog, prog.procs[d.key], d.node.body, { locals, globals, env, file, fn: name });
  }
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

// 함수 안에서 대입되는 이름 = 지역 변수 (global 선언 제외)
function collectNames(body, locals, globals, file) {
  for (const n of body) {
    if (n.kw) {
      if (n.kw === 'def') throw new CompileError('함수 안의 def 는 지원하지 않습니다', file, n.line);
      if (n.kw === 'for') { const m = /^for\s+(.+?)\s+in\s+/s.exec(n.head); if (m) for (const v of m[1].split(',')) if (v.trim()) locals.add(v.trim().replace(/[()]/g, '')); }
      collectNames(n.body, locals, globals, file);
      continue;
    }
    let m;
    if ((m = /^global\s+(.+)$/.exec(n.text))) { m[1].split(',').forEach((x) => globals.add(x.trim())); continue; }
    const a = assignSplit(n.text);
    if (a) for (const t of a.targets) for (const nm of targetNames(t)) locals.add(nm);
  }
}

// 대입문 분해: "a = b = expr" / "a, b = expr" / "a += expr"
function assignSplit(text) {
  let t;
  try { t = tokenize(text); } catch { return null; }
  let depth = 0;
  const eqs = [];
  let aug = null;
  for (const tok of t) {
    if (tok.k !== 'op') continue;
    if ('([{'.includes(tok.v)) depth++;
    else if (')]}'.includes(tok.v)) depth--;
    else if (depth === 0 && tok.v === '=') eqs.push(tok.col);
    else if (depth === 0 && ['+=', '-=', '*=', '/=', '//=', '%=', '**='].includes(tok.v) && !aug) aug = tok;
  }
  if (aug) return { aug: aug.v.slice(0, -1), targets: [text.slice(0, aug.col).trim()], rhs: text.slice(aug.col + aug.v.length).trim() };
  if (!eqs.length) return null;
  const parts = [];
  let from = 0;
  for (const c of eqs) { parts.push(text.slice(from, c).trim()); from = c + 1; }
  return { targets: parts, rhs: text.slice(from).trim() };
}
function targetNames(t) {
  return t.replace(/^\(|\)$/g, '').split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z_]\w*$/.test(s));
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

  // 식 안의 사용자 함수·대기 함수 호출을 앞선 명령으로 분리 (왼쪽→오른쪽, 안쪽 먼저)
  const lower = (n, line) => {
    if (!n || typeof n !== 'object') return n;
    if (Array.isArray(n)) return n.map((x) => lower(x, line));
    const out = {};
    for (const [k, v] of Object.entries(n)) {
      if (k === 'parts') out.parts = v.map((p) => (typeof p === 'string' ? p : { ...p, ast: lower(p.ast, line) }));
      else if (k === 'kw') out.kw = Object.fromEntries(Object.entries(v).map(([a, b]) => [a, lower(b, line)]));
      else if (v && typeof v === 'object') out[k] = lower(v, line);
      else out[k] = v;
    }
    if (out.t === 'call' && out.fn.t === 'name') {
      const name = out.fn.name;
      const shadow = sc.locals?.has(name);
      const def = !shadow && prog.defs.get(name);
      if (def || (!shadow && (ASYNC[name] || name === 'sub_program_run'))) {
        const k = `$t${tmpN++}`;
        const argAst = out.args, kwAst = out.kw;
        const evalArgs = (vm, f) => {
          const c = ctxOf(vm, f);
          return { args: argAst.map((a) => ev(a, c)), kw: Object.fromEntries(Object.entries(kwAst).map(([a, b]) => [a, ev(b, c)])) };
        };
        if (def) {
          emit(line, (vm, f) => {
            const { args, kw } = evalArgs(vm, f);
            const locals = bindCall(vm, def, args, kw);
            return { call: { proc: prog.procs[def.key], locals, onReturn: (v) => f.locals.set(k, v === undefined ? null : v) } };
          });
        } else if (name === 'sub_program_run') {
          if (argAst.length !== 1 || argAst[0].t !== 'str') throw new CompileError('sub_program_run("파일 이름") — 이름은 문자열 상수여야 합니다', file, line);
          const fn = sc.env.findFile(argAst[0].v);
          if (!fn) throw new CompileError(`sub_program_run: 파일 '${argAst[0].v}' 을(를) 찾을 수 없습니다`, file, line);
          const key = sc.env.needModule(fn);
          emit(line, (vm, f) => ({ call: { proc: prog.procs[key], locals: new Map(), onReturn: () => f.locals.set(k, null) } }));
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
  const E = (src, line) => { const a = parse(src, line); checkCallable(a, line); return lower(a, line); };
  const val = (ast) => (vm, f) => ev(ast, ctxOf(vm, f));

  // 대입 대상 쓰기
  const store = (tAst, line) => {
    if (tAst.t === 'name') {
      const nm = tAst.name;
      if (nm in CONSTS && !/^[a-z]/.test(nm)) throw new CompileError(`상수 ${nm} 에는 대입할 수 없습니다`, file, line);
      const local = sc.locals && sc.locals.has(nm) && !sc.globals.has(nm);
      return (vm, f, v) => { (local ? f.locals : vm.globals).set(nm, v); };
    }
    if (tAst.t === 'index') {
      if (tAst.idx.t === 'slice') throw new CompileError('슬라이스 대입은 지원하지 않습니다', file, line);
      const o = val(tAst.obj), i = val(tAst.idx);
      return (vm, f, v) => {
        const arr = o(vm, f);
        if (!Array.isArray(arr) || Object.isFrozen(arr)) throw err(`${pyType(arr)} 의 요소는 바꿀 수 없습니다`);
        arr[normIndex(arr, i(vm, f))] = isPos(arr) ? num(v) : v;
      };
    }
    if (tAst.t === 'tuple' || tAst.t === 'list') {
      const subs = tAst.items.map((x) => store(x, line));
      return (vm, f, v) => {
        if (!Array.isArray(v) && typeof v !== 'string') throw err(`${pyType(v)} 값은 풀어서 대입할 수 없습니다`);
        if (v.length !== subs.length) throw err(`값 ${v.length}개를 변수 ${subs.length}개에 풀어 넣을 수 없습니다`);
        subs.forEach((s, i) => s(vm, f, v[i]));
      };
    }
    throw new CompileError('대입할 수 없는 대상입니다', file, line);
  };

  const stmt = (n) => {
    const line = n.line;
    if (n.kw) return compound(n);
    const text = n.text;
    let m;
    if (/^(import|from)\b/.test(text)) return;   // DRCF 등 — 무시
    if (text === 'pass') { emit(line, () => {}); return; }
    if (text === 'break' || text === 'continue') {
      const L = loops[loops.length - 1];
      if (!L) throw new CompileError(`${text} 는 반복문 안에서만 쓸 수 있습니다`, file, line);
      (text === 'break' ? L.breaks : L.conts).push(jump(line, null));
      return;
    }
    if ((m = /^return\b\s*(.*)$/s.exec(text))) {
      if (!sc.fn) throw new CompileError('return 은 함수 안에서만 쓸 수 있습니다', file, line);
      if (m[1]) { const v = val(E(m[1], line)); emit(line, (vm, f) => ({ ret: v(vm, f) })); }
      else emit(line, () => ({ ret: null }));
      return;
    }
    if (/^global\s+/.test(text)) return;   // collectNames 에서 처리
    if (/^(del|assert|raise|yield|nonlocal|lambda)\b/.test(text)) throw new CompileError(`'${text.split(/\s/)[0]}' 문은 지원하지 않습니다`, file, line);
    if (/^exit\s*\(\s*\)$/.test(text)) { emit(line, () => ({ halt: true })); return; }
    const a = assignSplit(text);
    if (a) {
      if (a.aug) {
        const tAst = parse(a.targets[0], line);
        if (!['name', 'index'].includes(tAst.t)) throw new CompileError('복합 대입 대상 오류', file, line);
        const rhs = E(a.rhs, line);
        const get = val(tAst), set = store(tAst, line), r = val(rhs);
        const op = a.aug;
        emit(line, (vm, f) => set(vm, f, binop(op, get(vm, f), r(vm, f))));
        return;
      }
      const rhs = val(E(a.rhs, line));
      const sets = a.targets.map((t) => store(parse(t, line), line));
      emit(line, (vm, f) => { const v = rhs(vm, f); sets.forEach((s) => s(vm, f, v)); });
      return;
    }
    // 식 문장 (docstring 은 무시)
    const ast = parse(text, line);
    if (ast.t === 'str' || ast.t === 'num' || ast.t === 'fstr') return;
    checkCallable(ast, line);
    const low = lower(ast, line);
    if (low.t === 'tmp') return;   // 분리된 호출 자체
    const v = val(low);
    emit(line, (vm, f) => { v(vm, f); });
  };

  // 알 수 없는 함수 이름은 컴파일 시 오류
  const checkCallable = (n, line) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach((x) => checkCallable(x, line)); return; }
    if (n.t === 'call' && n.fn.t === 'name') {
      const nm = n.fn.name;
      if (!SYNC[nm] && !ASYNC[nm] && !prog.defs.has(nm) && nm !== 'sub_program_run' && !sc.locals?.has(nm))
        throw new CompileError(`알 수 없는 함수 ${nm}() — 에뮬레이터가 지원하지 않는 DRL 함수일 수 있습니다`, file, line);
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === 'parts') v.forEach((p) => typeof p !== 'string' && checkCallable(p.ast, line));
      else if (k === 'kw') Object.values(v).forEach((x) => checkCallable(x, line));
      else if (v && typeof v === 'object') checkCallable(v, line);
    }
  };

  const compound = (n) => {
    const line = n.line;
    switch (n.kw) {
      case 'def': if (!sc.top) throw new CompileError('함수 안의 def 는 지원하지 않습니다', file, line); return;
      case 'while': {
        const top = code.length;
        const c = E(n.head.replace(/^while\s*/, ''), line);
        const exit = jump(line, (vm, f) => !truthy(ev(c, ctxOf(vm, f))));
        const L = { breaks: [], conts: [] };
        loops.push(L);
        list(n.body);
        loops.pop();
        jump(line, null).to = top;
        exit.to = code.length;
        L.breaks.forEach((b) => { b.to = code.length; });
        L.conts.forEach((b) => { b.to = top; });
        return;
      }
      case 'for': {
        const m = /^for\s+(.+?)\s+in\s+(.+)$/s.exec(n.head);
        if (!m) throw new CompileError('for 형식: for 변수 in 반복값:', file, line);
        const target = store(parse(m[1], line), line);
        const itAst = E(m[2], line);
        const itK = `$it${tmpN}`, ixK = `$ix${tmpN++}`;
        emit(line, (vm, f) => {
          const v = ev(itAst, ctxOf(vm, f));
          f.locals.set(itK, toList(v, 'for'));
          f.locals.set(ixK, 0);
        });
        const top = code.length;
        const exit = jump(line, (vm, f) => f.locals.get(ixK) >= f.locals.get(itK).length);
        emit(line, (vm, f) => { const i = f.locals.get(ixK); f.locals.set(ixK, i + 1); target(vm, f, f.locals.get(itK)[i]); });
        const L = { breaks: [], conts: [] };
        loops.push(L);
        list(n.body);
        loops.pop();
        jump(line, null).to = top;
        exit.to = code.length;
        L.breaks.forEach((b) => { b.to = code.length; });
        L.conts.forEach((b) => { b.to = top; });
        return;
      }
      default: throw new CompileError(`'${n.kw}' 문은 지원하지 않습니다`, file, line);
    }
  };

  // 블록 목록: if/elif/else 체인 묶기
  const list = (nodes) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.kw === 'elif' || n.kw === 'else') {
        if (n.kw === 'else' && n.head !== 'else') throw new CompileError("'else' 뒤에는 ':' 만 올 수 있습니다", file, n.line);
        throw new CompileError(`${n.kw} 에 대응하는 if 가 없습니다`, file, n.line);
      }
      if (n.kw !== 'if') { stmt(n); continue; }
      const ends = [];
      let cur = n;
      for (;;) {
        const condSrc = cur.head.replace(/^(if|elif)\s*/, '');
        if (!condSrc) throw new CompileError(`${cur.kw}: 조건이 필요합니다`, file, cur.line);
        const c = E(condSrc, cur.line);
        const skip = jump(cur.line, (vm, f) => !truthy(ev(c, ctxOf(vm, f))));
        list(cur.body);
        const nx = nodes[i + 1];
        if (nx && (nx.kw === 'elif' || nx.kw === 'else')) {
          ends.push(jump(nx.line, null));
          skip.to = code.length;
          i++;
          if (nx.kw === 'elif') { cur = nx; continue; }
          if (nx.head !== 'else') throw new CompileError("'else' 뒤에는 ':' 만 올 수 있습니다", file, nx.line);
          list(nx.body);
        } else skip.to = code.length;
        break;
      }
      ends.forEach((e) => { e.to = code.length; });
    }
  };

  list(body);
}

function bindCall(vm, def, args, kw) {
  const L = new Map();
  if (args.length > def.params.length) throw err(`${def.node ? def.key.slice(4) : ''}(): 인수가 너무 많습니다 (최대 ${def.params.length}개)`);
  def.params.forEach((p, i) => { if (i < args.length) L.set(p.name, args[i]); });
  for (const [k, v] of Object.entries(kw)) {
    if (!def.params.some((p) => p.name === k)) throw err(`${def.key.slice(4)}(): 알 수 없는 키워드 인수 '${k}'`);
    if (L.has(k)) throw err(`${def.key.slice(4)}(): 인수 '${k}' 가 두 번 지정되었습니다`);
    L.set(k, v);
  }
  for (const p of def.params) {
    if (L.has(p.name)) continue;
    if (!p.def) throw err(`${def.key.slice(4)}(): 인수 '${p.name}' 가 필요합니다`);
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
  const objs = ctrl.objects;
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

const f3 = (v) => { const x = Math.abs(v) < 5e-4 ? 0 : v; return x.toFixed(3); };

function defaultFiles(ctrl) {
  const r = ctrl.robot;
  const { app, ok, pts } = planPickPlace(ctrl);
  const px = (p) => `posx(${toVendorPose(VENDOR, { p, R: DOWN }).map(f3).join(', ')})`;
  const main = [
    `# 픽 앤 플레이스 예제 (${r.name}) — 공작물 ${pts[0].id}~${pts[pts.length - 1].id} 를 Y 대칭 위치로 이송`,
    '# 위치: posx(X, Y, Z, A, B, C) = 베이스 좌표 mm, ZYZ 오일러 deg / posj(J1..J6) deg',
    '# I/O : DO1 ON = 그리퍼 닫기, DO2 ON = 그리퍼 열기, DI1 닫힘 확인, DI2 열림 확인, DI3 공작물 감지',
    '# 에뮬레이터 참고: movejx 의 sol 은 무시하고 현재 자세에서 가장 가까운 해를 씁니다',
    ...(ok ? [] : ['# 경고: 일부 위치가 현재 로봇의 작업영역 밖일 수 있음']),
    '',
    `HOME = posj(${r.home.map(f3).join(', ')})`,
    `APPROACH = [0, 0, ${f3(app)}, 0, 0, 0]   # 접근 오프셋 (베이스 Z)`,
    'PICKS = [',
    ...pts.map((q) => `    ${px(q.pick)},`),
    ']',
    'PLACES = [',
    ...pts.map((q) => `    ${px(q.place)},`),
    ']',
    '',
    'def grip():',
    '    set_digital_output(2, OFF)',
    '    set_digital_output(1, ON)',
    '    wait_digital_input(1, ON, 3)',
    '    wait(0.2)',
    '',
    'def release():',
    '    set_digital_output(1, OFF)',
    '    set_digital_output(2, ON)',
    '    wait_digital_input(2, ON, 3)',
    '    wait(0.2)',
    '    set_digital_output(2, OFF)',
    '',
    'set_velj(60)',
    'set_accj(100)',
    'set_velx(250, 80)',
    'set_accx(1000, 200)',
    '',
    'movej(HOME, vel=60, acc=100)',
    'release()',
    'count = 0',
    'for i in range(len(PICKS)):',
    '    pick_up = trans(PICKS[i], APPROACH)',
    '    place_up = trans(PLACES[i], APPROACH)',
    '    movejx(pick_up, vel=60, acc=100, radius=30)',
    '    movel(PICKS[i], vel=200, acc=500)',
    '    grip()',
    '    if get_digital_input(3) == OFF:',
    '        tp_popup("공작물 미검출 — 정지", DR_PM_ALARM)',
    '        release()',
    '        exit()',
    '    movel(pick_up, vel=500, acc=1000, radius=30)',
    '    movejx(place_up, vel=60, acc=100, radius=30)',
    '    movel(PLACES[i], vel=200, acc=500)',
    '    release()',
    '    movel(place_up, vel=500, acc=1000, radius=30)',
    '    count += 1',
    '',
    'movej(HOME, vel=60, acc=100)',
    'tp_log("완료: " + str(count) + " 개 이송")',
    '',
  ].join('\n');
  return { 'main.drl': main };
}

// ------------------------------------------------------------ 모듈
function pickMain(names) {
  const d = names.filter(isDrl);
  if (!d.length) return names[0] ?? null;
  return d.find((n) => /^main\.(drl|py)$/i.test(n)) ?? d.sort()[0];
}

// 통신 인터페이스용 변수: 실행 중(또는 마지막) 프로그램의 전역 변수, DO1/DI1
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
  if (isPos(old) && Array.isArray(v) && v.length === 6) v = mkPos(old.kind, v);
  g.set(s, v);
  return true;
}

export default {
  id: 'drl', name: 'Doosan DRL', exts: ['.drl', '.py'],
  compile, pickMain, defaultFiles, readVar, writeVar,
};

// 테스트용
export const _internal = { tokenize, parseExpr, logicalLines, buildTree, str };
