// 공용 토크나이저 / 수식 파서(Pratt) / 평가기
// 각 로봇 언어 컴파일러가 문장(statement) 파싱 시 이 Parser 를 사용한다.
//
// AST 노드
//   {t:'num',v} {t:'str',v} {t:'id',name}
//   {t:'bin',op,a,b} {t:'un',op,a}
//   {t:'call',fn:AST,args:[AST],named:{name:AST|true}}
//   {t:'index',obj:AST,idx:[AST]}  {t:'field',obj:AST,name}
//   {t:'agg',items:[AST]}            RAPID [a,b,c]
//   {t:'tuple',items:[AST]}          (a,b,c)
//   {t:'struct',type,fields:[[name,AST]]}   KRL {X 1, Y 2}

export class SyntaxErr extends Error {
  constructor(msg, col) { super(msg); this.col = col; }
}

const OPS = [':=', '==', '<>', '!=', '<=', '>=', '**', '+', '-', '*', '/', '(', ')', '[', ']', '{', '}', ',', '.', ':', ';', '<', '>', '=', '^', '\\', '&', '|', '!', '?', '@'];

// opts.identStart: 식별자 시작 허용 문자 정규식, opts.identSuffix: 식별자 끝에 붙는 형 접미사(%,!,$ 등)
export function tokenize(src, opts = {}) {
  const toks = [];
  const identStart = opts.identStart || /[A-Za-z_$#]/;
  const identPart = /[A-Za-z0-9_$#]/;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue; }
    const col = i;
    // KRL 16진/2진 리터럴 'H1F' 'B0101'
    if (ch === "'" && /[HhBb]/.test(src[i + 1] || '')) {
      const m = /^'([Hh][0-9A-Fa-f]+|[Bb][01]+)'/.exec(src.slice(i));
      if (m) { const base = m[1][0].toUpperCase() === 'H' ? 16 : 2; toks.push({ k: 'num', v: parseInt(m[1].slice(1), base), col }); i += m[0].length; continue; }
    }
    // Kawasaki ^H 16진 / ^B 2진
    if (ch === '^' && /[HhBb]/.test(src[i + 1] || '')) {
      const m = /^\^([Hh][0-9A-Fa-f]+|[Bb][01]+)/.exec(src.slice(i));
      if (m) { const base = m[1][0].toUpperCase() === 'H' ? 16 : 2; toks.push({ k: 'num', v: parseInt(m[1].slice(1), base), col }); i += m[0].length; continue; }
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      toks.push({ k: 'num', v: parseFloat(m[0]), real: /[.eE]/.test(m[0]), col }); i += m[0].length; continue;   // real: 실수 표기(KRL INT/INT 판별용)
    }
    if (ch === '"') {
      let j = i + 1, s = '';
      for (;;) {
        if (j >= src.length) throw new SyntaxErr('문자열이 닫히지 않았습니다 (\" 누락)', col);
        if (src[j] === '"') {
          if (src[j + 1] === '"') { s += '"'; j += 2; continue; }
          break;
        }
        s += src[j++];
      }
      toks.push({ k: 'str', v: s, col }); i = j + 1; continue;
    }
    if (identStart.test(ch)) {
      let j = i + 1;
      while (j < src.length && identPart.test(src[j])) j++;
      if (opts.identSuffix && j < src.length && opts.identSuffix.includes(src[j])) j++;
      toks.push({ k: 'id', v: src.slice(i, j), up: src.slice(i, j).toUpperCase(), col }); i = j; continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) { toks.push({ k: 'op', v: op, col }); i += op.length; continue; }
    throw new SyntaxErr(`알 수 없는 문자 '${ch}'`, col);
  }
  toks.push({ k: 'eof', v: '', col: src.length });
  return toks;
}

const BIN = {
  OR: 1, XOR: 1, EXOR: 1, B_OR: 1, B_EXOR: 1, '|': 1,
  AND: 2, B_AND: 2, '&': 2,
  '=': 4, '==': 4, '<>': 4, '!=': 4, '<': 4, '>': 4, '<=': 4, '>=': 4,
  '+': 5, '-': 5, BOR: 5, BAND: 6,
  '*': 6, '/': 6, MOD: 6, DIV: 6,
  ':': 7,
  '^': 9, '**': 9,
};

export class Parser {
  constructor(src, opts = {}) {
    this.src = src;
    this.opts = opts;
    this.toks = typeof src === 'string' ? tokenize(src, opts) : src;
    this.i = 0;
  }
  peek(o = 0) { return this.toks[Math.min(this.i + o, this.toks.length - 1)]; }
  next() { return this.toks[this.i++] || this.toks[this.toks.length - 1]; }
  eof() { return this.peek().k === 'eof'; }
  isOp(v, o = 0) { const t = this.peek(o); return t.k === 'op' && t.v === v; }
  isKw(v, o = 0) { const t = this.peek(o); return t.k === 'id' && t.up === v; }
  acceptOp(v) { if (this.isOp(v)) { this.i++; return true; } return false; }
  acceptKw(v) { if (this.isKw(v)) { this.i++; return true; } return false; }
  expectOp(v) { if (!this.acceptOp(v)) throw new SyntaxErr(`'${v}' 가 필요합니다 (발견: '${this.peek().v}')`, this.peek().col); }
  expectKw(v) { if (!this.acceptKw(v)) throw new SyntaxErr(`'${v}' 가 필요합니다 (발견: '${this.peek().v}')`, this.peek().col); }
  ident() {
    const t = this.next();
    if (t.k !== 'id') throw new SyntaxErr(`식별자가 필요합니다 (발견: '${t.v}')`, t.col);
    return t.v;
  }
  rest() { const t = this.peek(); return this.src.slice?.(t.col) ?? ''; }

  binPrec(t) {
    if (t.k === 'op') {
      if (t.v === ':' && !this.opts.colonOp) return 0;
      if (t.v === '=' && this.opts.noEqCompare) return 0;
      return BIN[t.v] || 0;
    }
    if (t.k === 'id') return BIN[t.up] || 0;
    return 0;
  }

  expr(minPrec = 0) {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      const p = this.binPrec(t);
      if (!p || p <= minPrec) break;
      this.next();
      const op = t.k === 'id' ? t.up : t.v;
      const right = this.expr(op === '^' || op === '**' ? p - 1 : p);
      left = { t: 'bin', op: op === '==' ? '=' : op === '!=' ? '<>' : op, a: left, b: right };
    }
    return left;
  }

  unary() {
    const t = this.peek();
    if (t.k === 'op' && (t.v === '-' || t.v === '+')) { this.next(); return { t: 'un', op: t.v, a: this.expr(7.5) }; }
    if (t.k === 'op' && t.v === '!') { this.next(); return { t: 'un', op: 'NOT', a: this.expr(3) }; }
    if (t.k === 'id' && (t.up === 'NOT' || t.up === 'B_NOT' || t.up === 'BNOT')) { this.next(); return { t: 'un', op: t.up === 'NOT' ? 'NOT' : 'BNOT', a: this.expr(3) }; }
    return this.postfix(this.primary());
  }

  primary() {
    const t = this.next();
    if (t.k === 'num') return t.real ? { t: 'num', v: t.v, real: true } : { t: 'num', v: t.v };
    if (t.k === 'str') return { t: 'str', v: t.v };
    if (t.k === 'id') return { t: 'id', name: t.v };
    if (t.k === 'op' && t.v === '(') {
      const first = this.expr();
      if (this.acceptOp(',')) {
        const items = [first];
        do { items.push(this.expr()); } while (this.acceptOp(','));
        this.expectOp(')');
        return { t: 'tuple', items };
      }
      this.expectOp(')');
      return first;
    }
    if (t.k === 'op' && t.v === '[') {
      const items = [];
      if (!this.isOp(']')) do { items.push(this.expr()); } while (this.acceptOp(','));
      this.expectOp(']');
      return { t: 'agg', items };
    }
    if (t.k === 'op' && t.v === '{') return this.struct();
    throw new SyntaxErr(`예상치 못한 토큰 '${t.v}'`, t.col);
  }

  // KRL 구조체 리터럴: {E6POS: X 1, Y 2, ...} / {X 1, Y 2}
  struct() {
    let type = null;
    if (this.peek().k === 'id' && this.isOp(':', 1)) { type = this.next().v; this.next(); }
    const fields = [];
    while (!this.isOp('}')) {
      const name = this.ident();
      const save = this.opts.colonOp; this.opts.colonOp = false;
      let v;
      try { v = this.expr(); } finally { this.opts.colonOp = save; }
      fields.push([name.toUpperCase(), v]);
      if (!this.acceptOp(',')) break;
    }
    this.expectOp('}');
    return { t: 'struct', type, fields };
  }

  postfix(node) {
    for (;;) {
      if (this.isOp('(') && node.t === 'id') {
        this.next();
        const { args, named } = this.argList(')');
        this.expectOp(')');
        node = { t: 'call', fn: node, args, named };
      } else if (this.isOp('[')) {
        this.next();
        const idx = [];
        if (!this.isOp(']')) do { idx.push(this.expr()); } while (this.acceptOp(','));
        this.expectOp(']');
        node = { t: 'index', obj: node, idx };
      } else if (this.isOp('.') && this.peek(1).k === 'id') {
        this.next();
        node = { t: 'field', obj: node, name: this.next().v };
      } else return node;
    }
  }

  // 인자 목록. RAPID 선택 인자 \Name 또는 \Name:=expr 지원
  argList(endOp) {
    const args = [], named = {};
    if (this.isOp(endOp) || this.eof()) return { args, named };
    for (;;) {
      while (this.acceptOp('\\')) {
        const n = this.ident();
        named[n.toUpperCase()] = this.acceptOp(':=') ? this.expr() : true;
        if (this.isOp(endOp) || this.eof()) return { args, named };
      }
      if (this.isOp(',')) { this.next(); continue; }
      if (this.isOp(endOp) || this.eof()) return { args, named };
      args.push(this.expr());
      while (this.acceptOp('\\')) {
        const n = this.ident();
        named[n.toUpperCase()] = this.acceptOp(':=') ? this.expr() : true;
      }
      if (!this.acceptOp(',')) return { args, named };
    }
  }
}

export const parseExpr = (src, opts) => {
  const p = new Parser(src, opts);
  const e = p.expr();
  if (!p.eof()) throw new SyntaxErr(`수식 뒤에 불필요한 토큰 '${p.peek().v}'`, p.peek().col);
  return e;
};

// ---------------- 평가기 ----------------
// env: { get(name), setter 불필요, call(name,args,named,node), binop?(op,a,b), field?(obj,name), index?(obj,idx), struct?(type,fields), tuple?(items), agg?(items) }
export function evaluate(n, env) {
  switch (n.t) {
    case 'num': return n.v;
    case 'str': return n.v;
    case 'id': return env.get(n.name, n);
    case 'un': {
      const a = evaluate(n.a, env);
      if (n.op === '-') return env.neg ? env.neg(a) : -a;
      if (n.op === '+') return a;
      if (n.op === 'NOT') return typeof a === 'number' && env.numericBool ? (a ? 0 : -1) : !truthy(a);
      if (n.op === 'BNOT') return ~a;
      break;
    }
    case 'bin': {
      if (n.op === 'AND') { const a = evaluate(n.a, env); if (!truthy(a)) return env.numericBool ? 0 : false; return env.numericBool ? (truthy(evaluate(n.b, env)) ? -1 : 0) : truthy(evaluate(n.b, env)); }
      if (n.op === 'OR') { const a = evaluate(n.a, env); if (truthy(a)) return env.numericBool ? -1 : true; return env.numericBool ? (truthy(evaluate(n.b, env)) ? -1 : 0) : truthy(evaluate(n.b, env)); }
      const a = evaluate(n.a, env), b = evaluate(n.b, env);
      if (env.binop) { const r = env.binop(n.op, a, b, n); if (r !== undefined) return r; }
      return binop(n.op, a, b, env.numericBool);
    }
    case 'call': {
      const args = n.args.map((x) => evaluate(x, env));
      const named = {};
      for (const [k, v] of Object.entries(n.named || {})) named[k] = v === true ? true : evaluate(v, env);
      return env.call(n.fn.name, args, named, n);
    }
    case 'index': {
      const obj = evaluate(n.obj, env);
      const idx = n.idx.map((x) => evaluate(x, env));
      if (env.index) return env.index(obj, idx, n);
      let v = obj;
      for (const k of idx) v = v?.[k - 1];
      return v;
    }
    case 'field': {
      const obj = evaluate(n.obj, env);
      if (env.field) return env.field(obj, n.name, n);
      return obj?.[n.name.toUpperCase()] ?? obj?.[n.name];
    }
    case 'agg': { const items = n.items.map((x) => evaluate(x, env)); return env.agg ? env.agg(items) : items; }
    case 'tuple': { const items = n.items.map((x) => evaluate(x, env)); return env.tuple ? env.tuple(items) : items; }
    case 'struct': {
      const obj = {};
      for (const [k, v] of n.fields) obj[k] = evaluate(v, env);
      return env.struct ? env.struct(n.type, obj) : obj;
    }
  }
  throw new Error(`평가할 수 없는 식 (${n.t})`);
}

export const truthy = (v) => (typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : !!v);

export function binop(op, a, b, numericBool) {
  const B = (x) => (numericBool ? (x ? -1 : 0) : x);
  if (typeof a === 'boolean' && typeof b === 'number') a = a ? 1 : 0;
  if (typeof b === 'boolean' && typeof a === 'number') b = b ? 1 : 0;
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': if (b === 0) throw new Error('0 으로 나눔'); return a / b;
    case 'DIV': if (b === 0) throw new Error('0 으로 나눔'); return Math.trunc(a / b);
    case 'MOD': if (b === 0) throw new Error('0 으로 나눔'); return a % b;
    case '^': case '**': return a ** b;
    case '=': return B(eq(a, b));
    case '<>': return B(!eq(a, b));
    case '<': return B(a < b);
    case '>': return B(a > b);
    case '<=': return B(a <= b);
    case '>=': return B(a >= b);
    case 'XOR': case 'EXOR': return B(truthy(a) !== truthy(b));
    case 'B_AND': case 'BAND': case '&': return a & b;
    case 'B_OR': case 'BOR': case '|': return a | b;
    case 'B_EXOR': return a ^ b;
  }
  throw new Error(`지원하지 않는 연산자 ${op}`);
}
const eq = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b);
