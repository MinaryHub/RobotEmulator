// Hyundai Robotics HRScript (Hi5 / Hi6 .job 잡 파일) 인터프리터
//
// 파일 : 0001.job, 0002.job ... (CALL 2 → 0002.job). 첫 줄 헤더
//        `Hyundai Robot Job File; { version: 1.6, mech_type: "...", total_axis: 6, aux_axis: 0 }` 는 무시.
//        주석은 ' 이후. 스텝 번호 접두어 `S1  ` 는 선택.
//
// 위치 표현 (이 에뮬레이터의 규약)
//   (x,y,z,rx,ry,rz[,"base"])      직교 포즈 (베이스 좌표, mm/deg, R = Rz*Ry*Rx)
//   Pose(x,y,z,rx,ry,rz)           직교 포즈
//   [j1,...,j6] / Axis(j1,...,j6)  관절각 (deg)
//   P1 / P[n]                      잡 파일의 티칭 포인트 (잡 단위). GP1 / GP[n] = 전역 포즈 (ctrl.regs 'P:n')
//   P1+P2, P1-P2                   요소별 더하기/빼기 (시프트),  P1.X ... P1.RZ (관절은 .J1~.J6) 요소 접근/대입
//   Shift(P, dx,dy,dz[,drx,dry,drz])  베이스 기준 평행이동
//   티칭 포인트 정의: `P1={x,y,z,rx,ry,rz[,"tag"]}` (tag 가 "axis"/"joint" 이면 관절각) — 파일 어디에나 가능.
//     END 이후 영역의 `P1=(...)`/`P1=[...]`/`P1=Pose(..)` 도 정의로 취급. END 이전의 그 외 P 대입은 실행 시 대입.
//
// 명령
//   MOVE P|L|C|S, <위치>, S=60% | S=500mm/sec | S=0.5m/sec, A=n, T=n   (P=관절보간, L/S=직선, C=원호)
//     Hi5 형식 `MOVE P,S=60%,A=0,T=0  (x,y,z,rx,ry,rz)` / `(...)A` (A 접미사 = 관절각) 도 허용
//     C 이동 두 개 연속 = 경유점, 끝점 (첫 C 는 경유점 기록만, 두 번째 C 에서 원호 이동)
//   DELAY 초, DO1=1 / DO[1]=1, WAIT DI1=1 [,T=초] / WAIT DI1, WAITI DI1
//   IF 조건 THEN / ELSEIF / ELSE / ENDIF, 한줄 IF 조건 THEN *L1 | 문장
//   FOR V1%=1 TO 4 [STEP n] / NEXT, WHILE 조건 / ENDWHILE(ENDW, WEND), GOTO *L1, *L1
//   CALL 2 (→ 0002.job), RETURN, END, STOP, PRINT [#0,] 식{,식}, VAR 이름[=식] (잡 로컬 변수)
// 변수
//   V1% 정수, V1! 실수, V1$ 문자열, 그 밖의 V/GV 로 시작하는 이름 → 전역 (ctrl.regs 'V:이름')
//   LV1% 등 L 로 시작하는 V 변수, VAR 로 선언한 이름 → 프레임 로컬
//   DO1, DI1, DO[n], DI[n] → IO (1/0)
import { CompileError, RuntimeErr, poseTarget, jointTarget, K, splitTop, stripComment } from './common.js';
import { Parser, evaluate, truthy } from './expr.js';
import { toVendorPose, fromVendorPose, frameFromXYZRPY } from '../../shared/poseformat.js';
import { ikNearest, tcpToFlange } from '../../shared/kinematics.js';

// 정확도 레벨 A=0~7 의 근사 블렌딩 반경(mm) — 컨트롤러 파라미터에 따라 다름 (추정값)
const ACC_MM = [0, 10, 25, 50, 100, 150, 200, 300];
const VENDOR = 'hyundai';
const DOWN = [[-1, 0, 0], [0, 1, 0], [0, 0, -1]];
const POPTS = { identSuffix: '%!$' };
const POPTS_LHS = { identSuffix: '%!$', noEqCompare: true };
const PF = ['X', 'Y', 'Z', 'RX', 'RY', 'RZ'];
const JF = ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'];

const isPos = (v) => v && typeof v === 'object' && (v.kind === 'pose' || v.kind === 'joints') && Array.isArray(v.v);
const mkPos = (kind, arr) => ({ kind, v: arr.slice(0, 6).map(Number) });
const clonePos = (p) => ({ kind: p.kind, v: [...p.v] });

function toPos(v, what = '위치') {
  if (isPos(v)) return v;
  if (Array.isArray(v)) {
    const nums = v.filter((x) => typeof x === 'number');
    if (nums.length >= 6) return mkPos('pose', nums);
  }
  throw new RuntimeErr('VAR', `${what}: 위치 데이터가 아닙니다`);
}

// 변수 이름 분류
function classify(nameU) {
  let m;
  if ((m = /^(DO|DI)(\d+)$/.exec(nameU))) return { k: 'io', io: m[1], n: Number(m[2]) };
  if ((m = /^P(\d+)$/.exec(nameU))) return { k: 'pt', n: Number(m[1]) };
  if ((m = /^GP(\d+)$/.exec(nameU))) return { k: 'gp', n: Number(m[1]) };
  if (/^LV/.test(nameU)) return { k: 'local' };
  if (/^G?V/.test(nameU)) return { k: 'global' };
  return null;
}
const coerceName = (nameU, v) => {
  if (nameU.endsWith('%')) { const n = Math.trunc(Number(v)); if (!Number.isFinite(n)) throw new RuntimeErr('VAR', `${nameU}: 정수가 아닙니다`); return n; }
  if (nameU.endsWith('!')) { const n = Number(v); if (!Number.isFinite(n)) throw new RuntimeErr('VAR', `${nameU}: 실수가 아닙니다`); return n; }
  if (nameU.endsWith('$')) return String(v);
  return v;
};
const defOf = (nameU) => (nameU.endsWith('$') ? '' : 0);

// ------------------------------------------------------------ 실행 컨텍스트
// 프레임 로컬: 'L:<이름>' / 잡 포인트: prog.points[job] Map(n → pos)
function makeEnv(vm, f) {
  const c = vm.ctrl;
  const pts = f.proc.points;
  const ARR = (a) => ({ $arr: a });
  const readName = (nameU) => {
    if (f.locals.has('L:' + nameU)) return f.locals.get('L:' + nameU);
    const cl = classify(nameU);
    if (!cl) throw new RuntimeErr('VAR', `정의되지 않은 변수 ${nameU}`);
    switch (cl.k) {
      case 'io': return (cl.io === 'DO' ? c.getDO(cl.n) : c.getDI(cl.n)) ? 1 : 0;
      case 'pt': { const p = pts.get(cl.n); if (!p) throw new RuntimeErr('VAR', `포인트 P${cl.n} 이(가) 정의되지 않았습니다`); return p; }
      case 'gp': { const p = c.regs.get('P:' + cl.n); if (!p) throw new RuntimeErr('VAR', `전역 포즈 GP${cl.n} 이(가) 설정되지 않았습니다`); return p; }
      case 'local': return defOf(nameU);
      case 'global': { const v = c.regs.get('V:' + nameU); return v === undefined ? defOf(nameU) : v; }
    }
  };
  return {
    get(name) {
      const u = K(name);
      if (u === 'ON' || u === 'TRUE') return 1;
      if (u === 'OFF' || u === 'FALSE') return 0;
      if (u === 'DO' || u === 'DI' || u === 'P' || u === 'GP') return ARR(u);
      return readName(u);
    },
    index(obj, idx) {
      if (!obj?.$arr) throw new RuntimeErr('VAR', '배열이 아닌 값에 [] 사용');
      return readName(obj.$arr + Math.trunc(Number(idx[0])));
    },
    field(obj, name) {
      const p = toPos(obj);
      const i = (p.kind === 'joints' ? JF : PF).indexOf(K(name));
      if (i < 0) throw new RuntimeErr('VAR', `알 수 없는 요소 .${name}`);
      return p.v[i];
    },
    tuple(items) {
      const nums = items.filter((x) => typeof x === 'number');
      if (nums.length >= 6 && items.length <= 7) return mkPos('pose', nums);
      return items;
    },
    agg(items) { return mkPos('joints', items); },
    binop(op, a, b) {
      if (isPos(a) || isPos(b)) {
        const A = toPos(a), B = isPos(b) ? b : Array.isArray(b) ? toPos(b) : null;
        if (B && (op === '+' || op === '-')) return { kind: A.kind, v: A.v.map((x, i) => (op === '+' ? x + B.v[i] : x - B.v[i])) };
        if (op === '=' || op === '<>') { const e = B && A.v.every((x, i) => Math.abs(x - B.v[i]) < 1e-9); return op === '=' ? e : !e; }
        throw new RuntimeErr('VAR', `포즈에 연산자 ${op} 를 사용할 수 없습니다`);
      }
      if (op === '+' && (typeof a === 'string' || typeof b === 'string')) return String(a) + String(b);
      return undefined;
    },
    call(fn, args) {
      const u = K(fn);
      const n = (i) => Number(args[i]);
      switch (u) {
        case 'POSE': return mkPos('pose', args);
        case 'AXIS': case 'JOINT': return mkPos('joints', args);
        case 'SHIFT': { const p = toPos(args[0]); const d = args.slice(1).map(Number); if (p.kind !== 'pose') throw new RuntimeErr('VAR', 'Shift: 직교 포즈가 필요합니다'); return { kind: 'pose', v: p.v.map((x, i) => x + (d[i] || 0)) }; }
        case 'CURPOSE': case 'CPOS': return mkPos('pose', toVendorPose(VENDOR, c.tcpPose()));
        case 'CURAXIS': case 'CAXIS': return mkPos('joints', c.joints);
        case 'ABS': return Math.abs(n(0));
        case 'SQRT': return Math.sqrt(n(0));
        case 'SIN': return Math.sin(n(0) * Math.PI / 180);
        case 'COS': return Math.cos(n(0) * Math.PI / 180);
        case 'TAN': return Math.tan(n(0) * Math.PI / 180);
        case 'ATAN2': case 'ATN2': return Math.atan2(n(0), n(1)) * 180 / Math.PI;
        case 'INT': case 'FIX': return Math.trunc(n(0));
        case 'ROUND': return Math.round(n(0));
        case 'MIN': return Math.min(...args.map(Number));
        case 'MAX': return Math.max(...args.map(Number));
        case 'STR$': case 'STR': return String(args[0]);
        case 'VAL': return Number(args[0]);
        case 'DI': return c.getDI(n(0)) ? 1 : 0;
        case 'DO': return c.getDO(n(0)) ? 1 : 0;
      }
      throw new RuntimeErr('VAR', `알 수 없는 함수 ${fn}`);
    },
  };
}
const ev = (vm, f, ast) => evaluate(ast, makeEnv(vm, f));

// 대입 (lhs AST)
function assign(vm, f, lhs, val) {
  const c = vm.ctrl;
  const env = makeEnv(vm, f);
  const writeName = (nameU, v) => {
    if (f.locals.has('L:' + nameU)) return f.locals.set('L:' + nameU, coerceName(nameU, v));
    const cl = classify(nameU);
    if (!cl) throw new RuntimeErr('VAR', `정의되지 않은 변수 ${nameU}`);
    switch (cl.k) {
      case 'io': if (cl.io !== 'DO') throw new RuntimeErr('IO', `입력 ${nameU} 에는 대입할 수 없습니다`); c.setDO(cl.n, truthy(v)); return;
      case 'pt': f.proc.points.set(cl.n, clonePos(toPos(v, nameU))); return;
      case 'gp': c.regs.set('P:' + cl.n, clonePos(toPos(v, nameU))); return;
      case 'local': f.locals.set('L:' + nameU, coerceName(nameU, v)); return;
      case 'global': c.regs.set('V:' + nameU, coerceName(nameU, v)); return;
    }
  };
  const nameOf = (n) => {
    if (n.t === 'id') return K(n.name);
    if (n.t === 'index' && n.obj.t === 'id') return K(n.obj.name) + Math.trunc(Number(evaluate(n.idx[0], env)));
    throw new RuntimeErr('VAR', '대입할 수 없는 대상');
  };
  if (lhs.t === 'field') {
    const nm = nameOf(lhs.obj);
    const p = clonePos(toPos(evaluate(lhs.obj, env), nm));
    const i = (p.kind === 'joints' ? JF : PF).indexOf(K(lhs.name));
    if (i < 0) throw new RuntimeErr('VAR', `알 수 없는 요소 .${lhs.name}`);
    p.v[i] = Number(val);
    return writeName(nm, p);
  }
  writeName(nameOf(lhs), val);
}

// ------------------------------------------------------------ 컴파일
const isJob = (n) => /\.job$/i.test(n);
const jobNo = (n) => { const m = /^(\d+)\.job$/i.exec(n); return m ? Number(m[1]) : null; };

function parseExprStr(src) {
  const p = new Parser(src, POPTS);
  const e = p.expr();
  if (!p.eof()) throw new Error(`식 뒤에 불필요한 토큰 '${p.peek().v}'`);
  return e;
}

// AST 정적 검사 (정의되지 않은 이름 → 컴파일 오류)
function checkAst(n, locals) {
  if (!n) return;
  switch (n.t) {
    case 'id': {
      const u = K(n.name);
      if (['ON', 'OFF', 'TRUE', 'FALSE', 'DO', 'DI', 'P', 'GP'].includes(u) || locals.has(u) || classify(u)) return;
      throw new Error(`정의되지 않은 이름 '${n.name}'`);
    }
    case 'call': n.args.forEach((a) => checkAst(a, locals)); return;
    case 'bin': checkAst(n.a, locals); checkAst(n.b, locals); return;
    case 'un': checkAst(n.a, locals); return;
    case 'index': checkAst(n.obj, locals); n.idx.forEach((a) => checkAst(a, locals)); return;
    case 'field': checkAst(n.obj, locals); return;
    case 'tuple': case 'agg': n.items.forEach((a) => checkAst(a, locals)); return;
    case 'num': case 'str': return;
    default: throw new Error('지원하지 않는 식 형식');
  }
}

// 정적 포인트 정의 파싱 (P1={...} 등)
function parsePointDef(rhs) {
  const s = rhs.trim();
  let m;
  if ((m = /^\{(.*)\}$/.exec(s)) || (m = /^\((.*)\)\s*([A-Za-z]?)$/.exec(s))) {
    const parts = splitTop(m[1], ',').map((x) => x.trim()).filter((x) => x !== '');
    const tag = parts.find((x) => /^"/.test(x))?.replace(/"/g, '') || '';
    const nums = parts.filter((x) => !/^"/.test(x)).map(Number);
    if (nums.length < 6 || nums.slice(0, 6).some((v) => !Number.isFinite(v))) throw new Error('포인트는 6개의 숫자가 필요합니다');
    const joints = /axis|joint/i.test(tag) || K(m[2] || '') === 'A';
    return mkPos(joints ? 'joints' : 'pose', nums);
  }
  if ((m = /^\[(.*)\]$/.exec(s)) || (m = /^(?:AXIS|JOINT)\s*\((.*)\)$/i.exec(s))) {
    const nums = splitTop(m[1], ',').map((x) => Number(x.trim()));
    if (nums.length < 6 || nums.slice(0, 6).some((v) => !Number.isFinite(v))) throw new Error('관절각은 6개의 숫자가 필요합니다');
    return mkPos('joints', nums);
  }
  if ((m = /^POSE\s*\((.*)\)$/i.exec(s))) {
    const nums = splitTop(m[1], ',').map((x) => Number(x.trim()));
    if (nums.length < 6 || nums.slice(0, 6).some((v) => !Number.isFinite(v))) throw new Error('포즈는 6개의 숫자가 필요합니다');
    return mkPos('pose', nums);
  }
  return null;
}

function compile(files, main, ctrl) {
  if (!files.has(main)) throw new CompileError(`메인 잡 파일이 없습니다: ${main}`, main, 1);
  const procs = {};
  const pending = [];
  const need = (fname) => {
    const N = K(fname);
    if (!procs[N]) { procs[N] = { name: N, params: [], file: fname, code: [], labels: {}, points: new Map() }; pending.push(N); }
    return N;
  };
  const findJob = (ref) => {
    const n = Number(ref);
    if (Number.isFinite(n)) for (const fn of files.keys()) if (jobNo(fn) === n) return fn;
    const s = String(ref).replace(/"/g, '');
    for (const fn of files.keys()) if (K(fn) === K(s) || K(fn) === K(s + '.job')) return fn;
    return null;
  };
  const prog = { lang: 'hrscript', entry: need(main), procs, globals: new Map() };
  while (pending.length) {
    const N = pending.shift();
    compileJob(prog, procs[N], files.get(procs[N].file), (ref, file, line) => {
      const fn = findJob(ref);
      if (!fn) throw new CompileError(`CALL 대상 잡 '${ref}' 을(를) 찾을 수 없습니다`, file, line);
      return need(fn);
    }, ctrl);
  }
  // 포인트 초기값 보관 (실행 시작마다 재컴파일되므로 그대로 사용)
  prog.points = Object.fromEntries(Object.values(procs).map((p) => [p.name, p.points]));
  return prog;
}

function compileJob(prog, proc, text, needJob, ctrl) {
  const file = proc.file;
  const code = proc.code;
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  const fixups = [];
  const locals = new Set();
  let afterEnd = false;

  const emit = (line, run) => { const ins = { line, file, run }; code.push(ins); return ins; };
  const gotoIns = (line, cond) => { const ins = emit(line, (vm, f) => (!cond || cond(vm, f) ? { goto: ins.to } : undefined)); return ins; };
  const E = (src, line) => {
    try { const a = parseExprStr(src); checkAst(a, locals); return a; } catch (e) { throw new CompileError(`식 오류: ${e.message}`, file, line); }
  };
  const condFn = (src, line) => { const a = E(src, line); return (vm, f) => truthy(ev(vm, f, a)); };
  const valFn = (src, line) => { const a = E(src, line); return (vm, f) => ev(vm, f, a); };

  // 문장 하나 컴파일 (한 줄 IF 의 THEN 부분 재사용)
  const statement = (st, line) => {
    const U = K(st);
    const kw = /^([A-Za-z]+)/.exec(st)?.[1]?.toUpperCase() || '';
    let m;

    if (st.startsWith('*')) {
      const lbl = K(st.slice(1).trim().split(/[\s:]/)[0]);
      if (!lbl) throw new CompileError('라벨 이름이 없습니다', file, line);
      if (proc.labels[lbl] !== undefined) throw new CompileError(`라벨 중복: *${lbl}`, file, line);
      proc.labels[lbl] = code.length;
      emit(line, () => {});
      return;
    }

    switch (kw) {
      case 'MOVE': return moveStmt(st.slice(4).trim(), line);
      case 'DELAY': { const v = valFn(st.slice(5), line); emit(line, (vm, f) => vm.wait(Math.max(0, Number(v(vm, f))))); return; }
      case 'WAIT': case 'WAITI': {
        let src = st.slice(kw.length).trim();
        let timeout = Infinity;
        const mt = /,\s*T\s*=\s*([\d.]+)\s*$/i.exec(src);
        if (mt) { timeout = Number(mt[1]); src = src.slice(0, mt.index); }
        if (!src) throw new CompileError(`${kw}: 조건이 필요합니다`, file, line);
        const c = condFn(src, line);
        emit(line, async (vm, f) => {
          const ok = await vm.waitUntil(() => c(vm, f), timeout);
          if (!ok) vm.print(`WAIT 타임아웃 (${timeout}s): ${src}`);
        });
        return;
      }
      case 'GOTO': {
        const lbl = /^GOTO\s*\*(\w+)/i.exec(st)?.[1];
        if (!lbl) throw new CompileError('GOTO *라벨 형식이 필요합니다', file, line);
        fixups.push({ label: K(lbl), line, ins: gotoIns(line, null) });
        return;
      }
      case 'CALL': {
        const ref = st.slice(4).trim().split(/[\s,]+/)[0];
        if (!ref) throw new CompileError('CALL: 잡 번호가 필요합니다', file, line);
        const N = needJob(ref, file, line);
        emit(line, () => ({ call: { proc: prog.procs[N] } }));
        return;
      }
      case 'RETURN': case 'END': emit(line, () => ({ ret: undefined })); return;
      case 'STOP': case 'HALT': emit(line, () => ({ halt: true })); return;
      case 'PRINT': {
        const rest = st.slice(5).replace(/^\s*#\d+\s*,/, '').trim();
        const parts = rest ? splitTop(rest, ',').map((p) => valFn(p, line)) : [];
        emit(line, (vm, f) => vm.print(parts.map((p) => {
          const v = p(vm, f);
          if (isPos(v)) return `(${v.v.map((x) => +x.toFixed(3)).join(',')})`;
          return typeof v === 'number' ? String(+v.toFixed(6)) : String(v);
        }).join('')));
        return;
      }
      case 'VAR': {
        const body = st.slice(3).trim();
        for (const part of splitTop(body, ',')) {
          const mm = /^([A-Za-z_]\w*[%!$]?)\s*(?:=\s*(.+))?$/.exec(part.trim());
          if (!mm) throw new CompileError('VAR 선언 형식 오류', file, line);
          const nm = K(mm[1]);
          locals.add(nm);
          const v = mm[2] !== undefined ? valFn(mm[2], line) : null;
          emit(line, (vm, f) => { f.locals.set('L:' + nm, v ? coerceName(nm, v(vm, f)) : defOf(nm)); });
        }
        return;
      }
      case 'NOP': case 'REM': emit(line, () => {}); return;
    }

    // 대입
    if ((m = /^([A-Za-z_]\w*!)\s*=(?!=)(.*)$/.exec(st) || /^(.*?[^<>!=])=(?!=)(.*)$/.exec(st)) && !/^(IF|FOR|WHILE|ELSEIF)\b/i.test(U)) {
      let lhs;
      try {
        const p = new Parser(m[1].trim(), POPTS_LHS);
        lhs = p.expr();
        if (!p.eof()) throw new Error(`대입 대상 뒤에 불필요한 토큰 '${p.peek().v}'`);
        if (!['id', 'index', 'field'].includes(lhs.t)) throw new Error('대입할 수 없는 대상');
        if (lhs.t === 'id' && !locals.has(K(lhs.name)) && !classify(K(lhs.name))) throw new Error(`알 수 없는 변수 이름 '${lhs.name}' (V1%, LV1%, P1, GP1, DO1 형식 또는 VAR 선언 필요)`);
        if (lhs.t === 'id' && classify(K(lhs.name))?.io === 'DI') throw new Error('입력 신호에는 대입할 수 없습니다');
      } catch (e) { throw new CompileError(`대입문 오류: ${e.message}`, file, line); }
      const v = valFn(m[2].trim(), line);
      emit(line, (vm, f) => assign(vm, f, lhs, v(vm, f)));
      return;
    }
    throw new CompileError(`알 수 없는 명령: ${st}`, file, line);
  };

  // MOVE
  const moveStmt = (rest, line) => {
    const items = splitTop(rest, ',').map((x) => x.trim());
    const interp = K(items.shift() || '');
    if (!['P', 'L', 'C', 'S', 'SP'].includes(interp)) throw new CompileError(`MOVE: 보간 종류는 P/L/C/S 중 하나 (발견: ${interp})`, file, line);
    let posSrc = null, posSuffix = '', speedSrc = null, accSrc = null;
    for (const it of items) {
      if (!it) continue;
      const mm = /^([A-Za-z]+)\s*=\s*(\S+?)(?:\s+(\(.*\)|\[.*\])\s*([A-Za-z]?))?$/.exec(it);
      if (mm && ['S', 'A', 'T', 'H', 'MS', 'CONF', 'ACC', 'DEC', 'R'].includes(K(mm[1]))) {
        if (K(mm[1]) === 'S') speedSrc = mm[2];
        if (K(mm[1]) === 'A') accSrc = mm[2];
        if (mm[3]) { posSrc = mm[3]; posSuffix = K(mm[4] || ''); }
      } else {
        if (posSrc) throw new CompileError(`MOVE: 위치가 두 번 지정되었습니다 (${it})`, file, line);
        posSrc = it;
      }
    }
    if (!posSrc) throw new CompileError('MOVE: 목표 위치가 필요합니다', file, line);
    let posFn;
    const lit = (() => { try { return parsePointDef(posSrc + (posSuffix ? '' : '')); } catch (e) { throw new CompileError(`MOVE: ${e.message}`, file, line); } })();
    if (lit && posSuffix === 'A') lit.kind = 'joints';
    if (lit) posFn = () => lit;
    else { const a = E(posSrc, line); posFn = (vm, f) => toPos(ev(vm, f, a), posSrc); }

    // 속도
    const joint = interp === 'P';
    let speedFn;
    if (!speedSrc) speedFn = () => (joint ? { frac: 0.5 } : { tcp: 250 });
    else {
      const sm = /^([\d.]+)\s*(%|MM\/SEC|MM\/S|M\/SEC|M\/S|CM\/MIN)?$/i.exec(speedSrc);
      if (sm) {
        const v = Number(sm[1]);
        const u = K(sm[2] || (joint ? '%' : 'MM/SEC'));
        if (!(v > 0)) throw new CompileError('MOVE: 속도는 양수여야 합니다', file, line);
        if (u === '%') { if (v > 100) throw new CompileError('MOVE: 속도 % 는 100 이하', file, line); speedFn = joint ? () => ({ frac: v / 100 }) : (vm) => ({ tcp: v / 100 * vm.ctrl.robot.tcpMaxSpeed }); }
        else {
          const mm = u.startsWith('MM') ? v : u.startsWith('M/') ? v * 1000 : v * 10 / 60;
          speedFn = () => ({ tcp: mm });
        }
      } else {
        const a = E(speedSrc, line);
        speedFn = (vm, f) => { const v = Number(ev(vm, f, a)); return joint ? { frac: Math.max(0.001, Math.min(1, v / 100)) } : { tcp: v }; };
      }
    }
    // A=n (정확도 레벨) → 블렌딩 반경. A=0 은 정위치. 반경은 Hi6 기본 파라미터 근사값
    const accLv = accSrc === null || Number.isNaN(Number(accSrc)) ? 0 : Number(accSrc); // 변수식은 0(정위치)로 처리
    if (!(accLv >= 0 && accLv <= 7) || !Number.isFinite(accLv)) throw new CompileError(`MOVE: A= 는 0~7 이어야 합니다 (${accSrc})`, file, line);
    const zone = ACC_MM[Math.round(accLv)];
    const tgt = (p) => (p.kind === 'joints' ? jointTarget(p.v) : poseTarget(VENDOR, p.v));
    if (interp === 'C') {
      emit(line, async (vm, f) => {
        const p = posFn(vm, f);
        const via = f.locals.get('$CVIA');
        if (!via) { f.locals.set('$CVIA', clonePos(p)); return; }
        f.locals.delete('$CVIA');
        await vm.move({ kind: 'C', via: tgt(via), target: tgt(p), speed: speedFn(vm, f), zone });
      });
      return;
    }
    emit(line, async (vm, f) => {
      const p = posFn(vm, f);
      if (f.locals.has('$CVIA')) { // 짝이 없는 원호 경유점 → 직선으로 통과
        const via = f.locals.get('$CVIA'); f.locals.delete('$CVIA');
        await vm.move({ kind: 'L', target: tgt(via), speed: { tcp: 250 } });
      }
      await vm.move({ kind: joint ? 'J' : 'L', target: tgt(p), speed: speedFn(vm, f), zone });
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    let st = stripComment(lines[i], ["'"]).trim();
    if (!st) continue;
    if (/^Hyundai Robot Job File/i.test(st)) continue;
    st = st.replace(/^S\d+\s+(?=[A-Za-z*])/i, '');
    const U = K(st);

    // 포인트 정의
    const pm = /^P(\d+)\s*=\s*(.+)$/i.exec(st);
    if (pm && (afterEnd || /^\{/.test(pm[2].trim()))) {
      let p;
      try { p = parsePointDef(pm[2]); } catch (e) { throw new CompileError(`포인트 정의 오류: ${e.message}`, file, line); }
      if (!p) throw new CompileError('포인트 정의 형식 오류 (예: P1={x,y,z,rx,ry,rz})', file, line);
      proc.points.set(Number(pm[1]), p);
      continue;
    }

    let m;
    if ((m = /^IF\s+(.+?)\s+THEN\s*(.*)$/i.exec(st))) {
      const c = condFn(m[1], line);
      const tail = m[2].trim();
      if (tail) { // 한 줄 IF
        if (tail.startsWith('*')) { fixups.push({ label: K(tail.slice(1).trim()), line, ins: gotoIns(line, c) }); continue; }
        const skip = gotoIns(line, (vm, f) => !c(vm, f));
        statement(tail, line);
        skip.to = code.length;
        continue;
      }
      blocks.push({ kind: 'IF', line, next: gotoIns(line, (vm, f) => !c(vm, f)), ends: [] });
      continue;
    }
    if ((m = /^ELSEIF\s+(.+?)(?:\s+THEN)?\s*$/i.exec(st)) || /^ELSE$/i.test(st)) {
      const b = blocks[blocks.length - 1];
      if (!b || b.kind !== 'IF' || b.hasElse) throw new CompileError(`${m ? 'ELSEIF' : 'ELSE'} 에 대응하는 IF 가 없습니다`, file, line);
      b.ends.push(gotoIns(line, null));
      b.next.to = code.length;
      if (m) { const c = condFn(m[1], line); b.next = gotoIns(line, (vm, f) => !c(vm, f)); }
      else { b.hasElse = true; b.next = null; emit(line, () => {}); }
      continue;
    }
    if (/^ENDIF$|^END\s+IF$/i.test(st)) {
      const b = blocks.pop();
      if (!b || b.kind !== 'IF') throw new CompileError('ENDIF 에 대응하는 IF 가 없습니다', file, line);
      emit(line, () => {});
      const pc = code.length - 1;
      if (b.next) b.next.to = pc;
      b.ends.forEach((e) => { e.to = pc; });
      continue;
    }
    if ((m = /^FOR\s+(.+?)\s*=\s*(.+?)\s+TO\s+(.+?)(?:\s+STEP\s+(.+))?$/i.exec(st))) {
      let lhs;
      try { const p = new Parser(m[1], POPTS_LHS); lhs = p.expr(); if (!p.eof() || lhs.t !== 'id') throw new Error('FOR 변수는 단순 변수여야 합니다'); } catch (e) { throw new CompileError(e.message, file, line); }
      const vn = K(lhs.name);
      if (!locals.has(vn) && !classify(vn)) throw new CompileError(`FOR 변수 이름 오류: ${lhs.name}`, file, line);
      const from = valFn(m[2], line), to = valFn(m[3], line), stepF = m[4] ? valFn(m[4], line) : () => 1;
      const vAst = { t: 'id', name: vn };
      emit(line, (vm, f) => assign(vm, f, lhs, from(vm, f)));
      const top = code.length;
      const exit = gotoIns(line, (vm, f) => {
        const v = Number(ev(vm, f, vAst)), lim = Number(to(vm, f)), s = Number(stepF(vm, f));
        return s >= 0 ? v > lim : v < lim;
      });
      blocks.push({ kind: 'FOR', line, top, exit, lhs, vAst, stepF });
      continue;
    }
    if (/^NEXT\b/i.test(st)) {
      const b = blocks.pop();
      if (!b || b.kind !== 'FOR') throw new CompileError('NEXT 에 대응하는 FOR 가 없습니다', file, line);
      emit(line, (vm, f) => assign(vm, f, b.lhs, Number(ev(vm, f, b.vAst)) + Number(b.stepF(vm, f))));
      gotoIns(line, null).to = b.top;
      b.exit.to = code.length;
      continue;
    }
    if ((m = /^WHILE\s+(.+)$/i.exec(st))) {
      const c = condFn(m[1], line);
      const top = code.length;
      blocks.push({ kind: 'WHILE', line, top, exit: gotoIns(line, (vm, f) => !c(vm, f)) });
      continue;
    }
    if (/^(ENDWHILE|ENDW|WEND|END\s+WHILE)$/i.test(st)) {
      const b = blocks.pop();
      if (!b || b.kind !== 'WHILE') throw new CompileError('ENDWHILE 에 대응하는 WHILE 이 없습니다', file, line);
      gotoIns(line, null).to = b.top;
      b.exit.to = code.length;
      continue;
    }
    statement(st, line);
    if (U === 'END' && !blocks.length) afterEnd = true;
  }
  if (blocks.length) {
    const b = blocks[blocks.length - 1];
    throw new CompileError(`${b.kind} 블록이 닫히지 않았습니다 (${b.kind === 'IF' ? 'ENDIF' : b.kind === 'FOR' ? 'NEXT' : 'ENDWHILE'} 누락)`, file, b.line);
  }
  for (const fx of fixups) {
    const pc = proc.labels[fx.label];
    if (pc === undefined) throw new CompileError(`라벨 *${fx.label} 이(가) 없습니다`, file, fx.line);
    fx.ins.to = pc;
  }
  void ctrl;
}

// ------------------------------------------------------------ 예제 잡 생성
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
const HDR = (r) => `Hyundai Robot Job File; { version: 1.6, mech_type: "${r.name}", total_axis: 6, aux_axis: 0 }`;

function defaultFiles(ctrl) {
  const r = ctrl.robot;
  const { app, ok, pts } = planPickPlace(ctrl);
  const vp = (p) => toVendorPose(VENDOR, { p, R: DOWN }).map(f3).join(',');
  const pad = '     ';
  const main = [
    HDR(r),
    `${pad}' 픽 앤 플레이스 예제 — 공작물 ${pts[0].id}~${pts[pts.length - 1].id} 를 Y 대칭 위치로 이송`,
    `${pad}' P1~P4: 픽 위치, P11~P14: 플레이스 위치, P99: 접근 오프셋, P100: 대기 위치(관절)`,
    ...(ok ? [] : [`${pad}' 경고: 일부 위치가 현재 로봇의 작업영역 밖일 수 있음`]),
    `${pad}S1   MOVE P,P100,S=50%,A=0,T=0`,
    `${pad}CALL 3                          ' 그리퍼 열기`,
    `${pad}V1%=0`,
    `${pad}FOR V2%=1 TO ${pts.length}`,
    `${pad}  P90=P[V2%]+P99                ' 픽 접근점`,
    `${pad}  P91=P[V2%+10]+P99             ' 플레이스 접근점`,
    `${pad}S2   MOVE P,P90,S=60%,A=3,T=0`,
    `${pad}S3   MOVE L,P[V2%],S=200mm/sec,A=0,T=0`,
    `${pad}  CALL 2                        ' 그리퍼 닫기`,
    `${pad}  IF DI3=0 THEN *NOPART`,
    `${pad}S4   MOVE L,P90,S=500mm/sec,A=3,T=0`,
    `${pad}S5   MOVE P,P91,S=60%,A=3,T=0`,
    `${pad}S6   MOVE L,P[V2%+10],S=200mm/sec,A=0,T=0`,
    `${pad}  CALL 3`,
    `${pad}S7   MOVE L,P91,S=500mm/sec,A=3,T=0`,
    `${pad}  V1%=V1%+1`,
    `${pad}NEXT`,
    `${pad}S8   MOVE P,P100,S=50%,A=0,T=0`,
    `${pad}PRINT "완료: ", V1%, " 개 이송"`,
    `${pad}GOTO *FIN`,
    `${pad}*NOPART`,
    `${pad}PRINT "공작물 미검출 — 정지"`,
    `${pad}CALL 3`,
    `${pad}STOP`,
    `${pad}*FIN`,
    `${pad}END`,
    ...pts.map((q, i) => `P${i + 1}={${vp(q.pick)},"base"}`),
    ...pts.map((q, i) => `P${i + 11}={${vp(q.place)},"base"}`),
    `P99={0.000,0.000,${f3(app)},0.000,0.000,0.000,"base"}`,
    `P100={${r.home.map(f3).join(',')},"axis"}`,
    '',
  ].join('\n');
  const close = [HDR(r), `${pad}' 그리퍼 닫기`, `${pad}DO2=0`, `${pad}DO1=1`, `${pad}WAIT DI1=1,T=3`, `${pad}DELAY 0.2`, `${pad}END`, ''].join('\n');
  const open = [HDR(r), `${pad}' 그리퍼 열기`, `${pad}DO1=0`, `${pad}DO2=1`, `${pad}WAIT DI2=1,T=3`, `${pad}DELAY 0.2`, `${pad}DO2=0`, `${pad}END`, ''].join('\n');
  return { '0001.job': main, '0002.job': close, '0003.job': open };
}

// ------------------------------------------------------------ 모듈
function pickMain(names) {
  const jobs = names.filter(isJob);
  if (!jobs.length) return names[0] ?? null;
  const one = jobs.find((n) => jobNo(n) === 1);
  if (one) return one;
  const num = jobs.filter((n) => jobNo(n) !== null).sort((a, b) => jobNo(a) - jobNo(b));
  return num[0] ?? jobs[0];
}

function readVar(ctrl, name) {
  const u = K(name).trim();
  const cl = classify(u);
  if (!cl) return undefined;
  switch (cl.k) {
    case 'io': return (cl.io === 'DO' ? ctrl.getDO(cl.n) : ctrl.getDI(cl.n)) ? 1 : 0;
    case 'gp': return ctrl.regs.get('P:' + cl.n);
    case 'pt': return ctrl.program?.points?.[K(ctrl.main)]?.get(cl.n);
    case 'global': { const v = ctrl.regs.get('V:' + u); return v === undefined ? defOf(u) : v; }
  }
  return undefined;
}

function writeVar(ctrl, name, value) {
  const u = K(name).trim();
  const cl = classify(u);
  if (!cl) return false;
  try {
    switch (cl.k) {
      case 'io': if (cl.io === 'DO') ctrl.setDO(cl.n, truthy(Number(value))); else ctrl.setDI(cl.n, truthy(Number(value))); return true;
      case 'gp': ctrl.regs.set('P:' + cl.n, clonePos(toPos(value))); return true;
      case 'pt': { const m = ctrl.program?.points?.[K(ctrl.main)]; if (!m) return false; m.set(cl.n, clonePos(toPos(value))); return true; }
      case 'global': ctrl.regs.set('V:' + u, coerceName(u, value)); return true;
    }
  } catch { return false; }
  return false;
}

export default {
  id: 'hrscript', name: 'Hyundai HRScript', exts: ['.job'],
  compile, pickMain, defaultFiles, readVar, writeVar,
};

