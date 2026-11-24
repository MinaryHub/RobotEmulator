// Yaskawa Motoman INFORM (YRC1000 / DX200 .JBI 잡 파일) 인터프리터
//
// 지원 범위
//  파일 구조 : /JOB, //NAME, //POS, ///NPOS, ///TOOL, ///USER, ///POSTYPE PULSE|ROBOT|BASE|USER,
//              ///PULSE, ///RECTAN, ///RCONF, C00000=..., //INST, ///DATE, ///ATTR, ///GROUP1, ///COMM, NOP, END
//              ('/JOB' 헤더가 없는 텍스트는 전체를 명령부로 간주 — 간단한 스니펫 테스트용)
//  위치 데이터 : PULSE → 관절각(deg = pulse / robot.pulsePerDeg), RECTAN(BASE/ROBOT/USER) → X,Y,Z,Rx,Ry,Rz
//                (USER 좌표계 번호와 RCONF 형태 정보는 무시: 베이스 기준, 현재 자세에 가장 가까운 해 사용)
//  이동 : MOVJ/MOVL/MOVC/MOVS <C00000|P000|LP000> [VJ=%|V=mm/s] [VR=deg/s] [PL=n] [NWAIT] [ACC/DEC=]
//         MOVC 는 3점 이상 연속 — 첫 MOVC 는 직선 접근, 이후 각 MOVC 는 원호(시작→중간→끝) 일부를 이동
//         IMOV P000 V=.. [BF|RF|TF|UF#(n)] 증분 이동,  SFTON P000 [BF|TF] / SFTOF 평행이동
//  IO/시간 : TIMER T=s, DOUT OT#(n) ON|OFF|식, DOUT OG#(n) 값, PULSE OT#(n) [T=s],
//            WAIT 조건 [T=s], DIN B000 IN#(n)|IG#(n)
//  흐름 : *LABEL, JUMP *LABEL [IF 조건], JUMP JOB:이름 [IF], CALL JOB:이름 [IF], RET [IF], PAUSE [IF],
//         IFTHEN/ELSEIF/ELSE/ENDIF, WHILEEXP/ENDWHILE (YRC1000 구조화 명령)
//  변수 : SET/ADD/SUB/MUL/DIV/INC/DEC/CLEAR, SETE P (n) 값, GETE 변수 P (n), CNVRT Pd Ps [BF|RF]
//         B(바이트) I(정수) D(배정수) R(실수) S(문자열) P(위치) — ctrl.regs 키 'B:5','P:10' ...
//         LB/LI/LD/LR/LS/LP 로컬 변수는 프레임 로컬
//  기타 : 'comment, MSG "..", TOOLON/TOOLOFF/ARCON/ARCOF/SPEED (로그만)
// 조건식은 expr.js 파서 사용 ('=' 는 비교). IN#(n)/OT#(n)/IG#(n)/OG#(n), ON/OFF 사용 가능.
import { CompileError, RuntimeErr, poseTarget, jointTarget, K } from './common.js';
import { Parser, evaluate, truthy } from './expr.js';
import { toVendorPose, fromVendorPose, frameFromXYZRPY } from '../../shared/poseformat.js';
import { fkTcp, ikNearest, tcpToFlange } from '../../shared/kinematics.js';
import { RfromZYX, mul3, add, sub, scale, norm, cross, dot } from '../../shared/math.js';

// 위치결정 레벨 PL0~PL8 의 근사 반경(mm) — YRC1000 기본 파라미터 값 기준(현장 파라미터에 따라 다름)
const PL_MM = [0, 12.5, 25, 50, 100, 200, 300, 400, 500];
const VENDOR = 'yaskawa';
const DOWN = [[-1, 0, 0], [0, 1, 0], [0, 0, -1]];

// ------------------------------------------------------------ 변수
// 이름 → {local, type, idx, key}
function parseVarName(name) {
  const m = /^(L?)([BIDRSP])(\d+)$/.exec(K(name).trim());
  if (!m) return null;
  const idx = Number(m[3]);
  return { local: !!m[1], type: m[2], idx, key: `${m[1]}${m[2]}:${idx}` };
}

const posVal = (kind, v) => ({ kind, v: v.slice(0, 6).map(Number) });
const clonePos = (p) => ({ kind: p.kind, v: [...p.v] });

function coerce(type, val, name) {
  switch (type) {
    case 'B': { const n = Math.trunc(Number(val)); if (!Number.isFinite(n)) throw new RuntimeErr('VAR', `${name}: 숫자가 아닙니다`); return ((n % 256) + 256) % 256; }
    case 'I': { const n = Math.trunc(Number(val)); if (!(n >= -32768 && n <= 32767)) throw new RuntimeErr('VAR', `${name}: 정수(I) 범위 초과 (${val})`); return n; }
    case 'D': { const n = Math.trunc(Number(val)); if (!(n >= -2147483648 && n <= 2147483647)) throw new RuntimeErr('VAR', `${name}: 배정수(D) 범위 초과 (${val})`); return n; }
    case 'R': { const n = Number(val); if (!Number.isFinite(n)) throw new RuntimeErr('VAR', `${name}: 실수가 아닙니다`); return n; }
    case 'S': return String(val ?? '');
    case 'P': {
      if (Array.isArray(val)) return posVal('pose', val);
      if (val && (val.kind === 'pose' || val.kind === 'joints') && Array.isArray(val.v)) return clonePos(val);
      throw new RuntimeErr('VAR', `${name}: 위치 데이터가 아닙니다`);
    }
  }
  return val;
}
const defVal = (type) => (type === 'S' ? '' : type === 'P' ? undefined : 0);

function readV(ctrl, frame, ref) {
  const m = ref.local ? frame?.locals : ctrl.regs;
  const v = m?.get(ref.key);
  return v === undefined ? defVal(ref.type) : v;
}
function writeV(ctrl, frame, ref, val, name) {
  const v = coerce(ref.type, val, name);
  (ref.local ? frame.locals : ctrl.regs).set(ref.key, v);
}

// ------------------------------------------------------------ 위치 헬퍼
function toolOf(ctrl) { return ctrl.gripper ? ctrl.tool : frameFromXYZRPY([0, 0, 150, 0, 0, 0]); }

// 위치값 → TCP pose (베이스 기준)
function poseOf(ctrl, p) {
  if (p.kind === 'joints') return fkTcp(ctrl.robot, p.v, ctrl.tool, ctrl.base);
  return fromVendorPose(VENDOR, p.v);
}
// 시프트량(P 변수, 직교) 적용
function applyShift(ctrl, p, sft) {
  if (!sft) return p;
  const ps = p.kind === 'joints' ? toVendorPose(VENDOR, poseOf(ctrl, p)) : p.v;
  const d = sft.v;
  if (sft.frame === 'TF') {
    const cur = fromVendorPose(VENDOR, ps);
    const dp = fromVendorPose(VENDOR, d);
    const r = { p: add(cur.p, rot(cur.R, dp.p)), R: mul3(cur.R, dp.R) };
    return posVal('pose', toVendorPose(VENDOR, r));
  }
  return posVal('pose', ps.map((v, i) => v + d[i]));
}
const rot = (R, v) => [0, 1, 2].map((i) => R[i][0] * v[0] + R[i][1] * v[1] + R[i][2] * v[2]);

function targetOf(p) {
  return p.kind === 'joints' ? jointTarget(p.v) : poseTarget(VENDOR, p.v);
}

// A→B 원호(세 번째 점 X 를 포함하지 않는 쪽)의 중간점
function arcMid(A, B, X) {
  const ab = sub(B, A), ax = sub(X, A);
  const n = cross(ab, ax);
  const nn = norm(n);
  if (nn < 1e-6) return scale(add(A, B), 0.5);
  const ab2 = dot(ab, ab), ax2 = dot(ax, ax);
  const c = add(A, scale(add(scale(cross(n, ab), ax2), scale(cross(ax, n), ab2)), 1 / (2 * nn * nn)));
  const r = norm(sub(A, c));
  const m = scale(add(A, B), 0.5);
  let u = sub(m, c);
  if (norm(u) < 1e-6) u = cross(n, sub(A, B));
  u = scale(u, 1 / norm(u));
  if (dot(sub(X, m), u) > 0) u = scale(u, -1);
  return add(c, scale(u, r));
}

// ------------------------------------------------------------ JBI 파일 파싱
function jobNameOf(fname, text) {
  const m = /^\s*\/\/NAME\s+(\S+)/m.exec(text || '');
  return K(m ? m[1] : fname.replace(/\.[^.]*$/, ''));
}
const isJbi = (n) => /\.jbi$/i.test(n);

function parseJob(text, file, robot) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const job = { name: null, file, pos: new Map(), inst: [], toolNo: null, userNo: null };
  let section = /^\s*\/JOB\s*$/m.test(text) ? 'head' : 'inst';
  let postype = 'PULSE';
  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1;
    const t = lines[i].trim();
    if (!t) continue;
    const U = K(t);
    if (U === '/JOB') { section = 'head'; continue; }
    if (U.startsWith('//NAME')) { job.name = K(t.slice(6).trim()); continue; }
    if (U === '//POS') { section = 'pos'; continue; }
    if (U === '//INST') { section = 'inst'; continue; }
    if (U.startsWith('///')) {
      const m = /^\/\/\/(\w+)\s*(.*)$/.exec(U);
      const key = m?.[1];
      if (key === 'POSTYPE') postype = m[2].trim();
      else if (key === 'PULSE') postype = 'PULSE';
      else if (key === 'RECTAN' && postype === 'PULSE') postype = 'BASE';
      else if (key === 'TOOL') { const n = Number(m[2].trim()); if (Number.isInteger(n) && n >= 0) job.toolNo = n; }
      else if (key === 'USER') { const n = Number(m[2].trim()); if (Number.isInteger(n) && n >= 0) job.userNo = n; }
      continue; // NPOS, RCONF, DATE, ATTR, GROUP1, COMM, LVARS ... 무시
    }
    if (U.startsWith('//')) continue; // //ALIAS 등
    if (section === 'pos') {
      const m = /^(B?C|EC|BC|P)(\d+)\s*=\s*(.*)$/i.exec(t);
      if (!m) throw new CompileError(`위치 데이터 형식 오류: ${t}`, file, ln);
      if (K(m[1]) !== 'C') continue; // 스테이션/베이스축 데이터 무시
      const nums = m[3].split(',').map((s) => Number(s.trim()));
      if (nums.length < 6 || nums.slice(0, 6).some((v) => !Number.isFinite(v))) throw new CompileError(`위치 데이터는 6개의 숫자가 필요합니다: ${t}`, file, ln);
      let p;
      if (postype === 'PULSE') {
        const ppd = robot.pulsePerDeg || [1000, 1000, 1000, 1000, 1000, 1000];
        p = posVal('joints', nums.slice(0, 6).map((v, k) => v / ppd[k]));
      } else p = posVal('pose', nums);
      job.pos.set(Number(m[2]), { ...p, postype, line: ln });
      continue;
    }
    if (section === 'inst') { job.inst.push({ line: ln, text: lines[i].replace(/^\s+/, '') }); continue; }
    throw new CompileError(`잡 헤더 영역의 알 수 없는 줄: ${t}`, file, ln);
  }
  if (!job.name) job.name = K(file.replace(/\.[^.]*$/, ''));
  return job;
}

// ------------------------------------------------------------ 조건식/값
const PARSE_OPTS = {};
function parseCond(src) {
  const p = new Parser(src, PARSE_OPTS);
  const e = p.expr();
  if (!p.eof()) throw new Error(`식 뒤에 불필요한 토큰 '${p.peek().v}'`);
  checkAst(e);
  return e;
}
const IOFN = new Set(['IN#', 'OT#', 'IG#', 'OG#', 'SIN#', 'SOUT#']);
function checkAst(n) {
  if (!n) return;
  switch (n.t) {
    case 'id': {
      const u = K(n.name);
      if (u === 'ON' || u === 'OFF' || parseVarName(u)) return;
      throw new Error(`알 수 없는 이름 '${n.name}'`);
    }
    case 'call': if (!IOFN.has(K(n.fn.name))) throw new Error(`알 수 없는 함수 '${n.fn.name}'`); n.args.forEach(checkAst); return;
    case 'bin': checkAst(n.a); checkAst(n.b); return;
    case 'un': checkAst(n.a); return;
    case 'num': case 'str': return;
    default: throw new Error('지원하지 않는 식 형식');
  }
}
function makeEnv(vm, frame) {
  const c = vm.ctrl;
  const grp = (get, n) => { let v = 0; for (let b = 0; b < 8; b++) if (get((n - 1) * 8 + 1 + b)) v |= 1 << b; return v; };
  return {
    get(name) {
      const u = K(name);
      if (u === 'ON') return 1;
      if (u === 'OFF') return 0;
      const r = parseVarName(u);
      if (r) return readV(c, frame, r);
      throw new RuntimeErr('VAR', `알 수 없는 이름 ${name}`);
    },
    call(fn, args) {
      const n = Number(args[0]);
      switch (K(fn)) {
        case 'IN#': case 'SIN#': return c.getDI(n) ? 1 : 0;
        case 'OT#': case 'SOUT#': return c.getDO(n) ? 1 : 0;
        case 'IG#': return grp((k) => c.getDI(k), n);
        case 'OG#': return grp((k) => c.getDO(k), n);
      }
      throw new RuntimeErr('VAR', `알 수 없는 함수 ${fn}`);
    },
  };
}
const ev = (vm, frame, ast) => evaluate(ast, makeEnv(vm, frame));

// 태그 (KEY=값 / 단독 키워드) 분리
function parseTags(words) {
  const tags = {};
  for (const w of words) {
    const m = /^([A-Z#()0-9]+?)=(.*)$/.exec(K(w));
    if (m) tags[m[1]] = m[2];
    else tags[K(w)] = true;
  }
  return tags;
}
function numTag(tags, k, file, line) {
  if (tags[k] === undefined) return undefined;
  const v = Number(tags[k]);
  if (!Number.isFinite(v)) throw new CompileError(`${k}= 값이 숫자가 아닙니다`, file, line);
  return v;
}

// 문자열 밖의 ' IF ' 로 조건 분리
function splitIf(s) {
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') inStr = !inStr;
    if (!inStr && /\s/.test(s[i]) && /^\s+IF\s/i.test(s.slice(i))) {
      const m = /^\s+IF\s+/i.exec(s.slice(i));
      return [s.slice(0, i), s.slice(i + m[0].length)];
    }
  }
  return [s, null];
}

// IO 지정 "OT#(3)" → {kind:'OT', n:3}
function parseIO(s) {
  const m = /^(OT|OG|IN|IG)#\((\d+)\)$/i.exec(s.trim());
  return m ? { kind: K(m[1]), n: Number(m[2]) } : null;
}

// ------------------------------------------------------------ 컴파일
function compile(files, main, ctrl) {
  const robot = ctrl.robot;
  const index = new Map(); // 잡 이름 → 파일명
  for (const [fn, text] of files) if (isJbi(fn)) index.set(jobNameOf(fn, text), fn);
  if (!files.has(main)) throw new CompileError(`메인 잡 파일이 없습니다: ${main}`, main, 1);
  if (!isJbi(main)) index.set(jobNameOf(main, files.get(main)), main);

  const procs = {};
  const pending = [];
  const need = (name, file, line) => {
    const N = K(name);
    if (!index.has(N)) throw new CompileError(`잡 '${name}' 을(를) 찾을 수 없습니다`, file, line);
    if (!procs[N]) { procs[N] = { name: N, params: [], file: index.get(N), code: [], labels: {} }; pending.push(N); }
    return N;
  };
  const prog = { lang: 'inform', entry: null, procs, globals: new Map() };
  prog.entry = need(jobNameOf(main, files.get(main)), main, 1);
  while (pending.length) {
    const N = pending.shift();
    const fn = index.get(N);
    compileJob(prog, procs[N], parseJob(files.get(fn), fn, robot), need);
  }
  return prog;
}

function compileJob(prog, proc, job, need) {
  const { file } = job;
  const code = proc.code;
  const fixups = []; // {label, line, set(pc)}
  const blocks = []; // IFTHEN/WHILEEXP 구조 스택
  // MOVC 연속 구간 추적
  let movcRun = null;

  const emit = (line, run) => { const ins = { line, file, run }; code.push(ins); return ins; };
  const gotoTo = (line, cond) => {
    const ins = emit(line, (vm, f) => (cond === null || cond(vm, f) ? { goto: ins.to } : undefined));
    return ins;
  };
  const condFn = (src, line) => {
    let ast;
    try { ast = parseCond(src); } catch (e) { throw new CompileError(`조건식 오류: ${e.message}`, file, line); }
    return (vm, f) => truthy(ev(vm, f, ast));
  };
  const valFn = (src, line) => {
    const s = src.trim();
    if (/^"/.test(s)) { const str = s.replace(/^"|"$/g, ''); return () => str; }
    let ast;
    try { ast = parseCond(s); } catch (e) { throw new CompileError(`값 오류: ${e.message}`, file, line); }
    return (vm, f) => ev(vm, f, ast);
  };
  const varRef = (name, line) => {
    const r = parseVarName(name);
    if (!r) throw new CompileError(`변수 이름 오류: ${name}`, file, line);
    return r;
  };
  // 위치 지정 (C00000 / P000 / LP000) → (vm,f) => posVal
  const posRef = (tok, line) => {
    const u = K(tok);
    const mc = /^C(\d+)$/.exec(u);
    if (mc) {
      const p = job.pos.get(Number(mc[1]));
      if (!p) throw new CompileError(`위치 데이터 ${u} 가 //POS 에 정의되지 않았습니다`, file, line);
      return () => p;
    }
    const r = parseVarName(u);
    if (r && r.type === 'P') {
      return (vm, f) => {
        const v = readV(vm.ctrl, f, r);
        if (!v) throw new RuntimeErr('VAR', `위치 변수 ${u} 가 설정되지 않았습니다`);
        return v;
      };
    }
    throw new CompileError(`위치 지정 오류: ${tok}`, file, line);
  };

  for (const { line, text } of job.inst) {
    const raw = text.trim();
    if (raw.startsWith("'")) { emit(line, () => {}); continue; } // 주석 줄도 하이라이트 위해 NOP
    if (raw.startsWith('*')) {
      const lbl = K(raw.slice(1).split(/\s+/)[0]);
      if (!lbl) throw new CompileError('라벨 이름이 없습니다', file, line);
      if (proc.labels[lbl] !== undefined) throw new CompileError(`라벨 중복: *${lbl}`, file, line);
      proc.labels[lbl] = code.length;
      emit(line, () => {});
      movcRun = null;
      continue;
    }
    const [body, ifSrc] = splitIf(raw);
    const words = body.trim().split(/\s+/);
    const op = K(words[0]);
    const args = words.slice(1);
    const cond = ifSrc !== null ? condFn(ifSrc, line) : null;
    const guarded = (fn) => (cond ? (vm, f) => (cond(vm, f) ? fn(vm, f) : undefined) : fn);
    if (op !== 'MOVC') movcRun = null;

    switch (op) {
      case 'NOP': emit(line, () => {}); break;
      case 'END': emit(line, () => ({ ret: undefined })); break;

      case 'MOVJ': case 'MOVL': case 'MOVS': case 'MOVC': {
        if (!args.length) throw new CompileError(`${op}: 위치가 필요합니다`, file, line);
        const pos = posRef(args[0], line);
        const tags = parseTags(args.slice(1).filter((w) => !/^(B?C|EC|BC)\d+$/i.test(w)));
        if (tags.UNTIL || tags.ENWAIT) { /* 미지원 옵션은 무시 */ }
        let speed;
        if (op === 'MOVJ') {
          const vj = numTag(tags, 'VJ', file, line) ?? 25;
          if (!(vj > 0 && vj <= 100)) throw new CompileError('VJ 는 0~100 (%) 범위여야 합니다', file, line);
          speed = { frac: vj / 100 };
        } else {
          const v = numTag(tags, 'V', file, line);
          const vr = numTag(tags, 'VR', file, line);
          const vj = numTag(tags, 'VJ', file, line);
          speed = v !== undefined ? { tcp: v } : vj !== undefined ? { frac: vj / 100 } : { tcp: 66 };
          if (vr !== undefined) speed.rot = vr;
          if (v !== undefined && !(v > 0)) throw new CompileError('V= 속도는 양수여야 합니다', file, line);
        }
        // PL (위치결정 레벨) → 블렌딩 반경. YRC1000 기본 파라미터값(PL1~8). 미지정/PL=0 은 정위치
        const pl = numTag(tags, 'PL', file, line);
        if (pl !== undefined && !(pl >= 0 && pl <= 8)) throw new CompileError('PL 은 0~8 이어야 합니다', file, line);
        const zone = pl ? PL_MM[Math.round(pl)] : 0;
        const resolveMoveFrames = (ctrl, rawPos) => {
          const out = {};
          if (job.toolNo > 0 && ctrl.getToolFrame) out.tool = ctrl.getToolFrame(job.toolNo);
          if (rawPos?.postype === 'USER') {
            if (job.userNo > 0 && ctrl.getUserFrame) out.base = ctrl.getUserFrame(job.userNo);
          } else if (rawPos?.postype === 'BASE' || rawPos?.postype === 'ROBOT') {
            out.base = null;
          }
          return out;
        };
        if (op === 'MOVC') {
          if (!movcRun) movcRun = { pts: [], first: line };
          const run = movcRun;
          const k = run.pts.length;
          run.pts.push(pos);
          const ins = emit(line, guarded(async (vm, f) => {
            const n = run.pts.length;
            const rawP = pos(vm, f);
            const frames = resolveMoveFrames(vm.ctrl, rawP);
            const cur = applyShift(vm.ctrl, rawP, f.locals.get('$SFT'));
            if (k === 0) return void await vm.move({ kind: 'L', target: targetOf(cur), speed, zone, ...frames });
            const tri = k + 1 < n ? [k - 1, k, k + 1] : [k - 2, k - 1, k];
            const P = tri.map((j) => poseOf(vm.ctrl, applyShift(vm.ctrl, run.pts[j](vm, f), f.locals.get('$SFT'))));
            const [A, B, X] = k + 1 < n ? P : [P[1], P[2], P[0]];
            const mid = arcMid(A.p, B.p, X.p);
            await vm.move({ kind: 'C', via: { pose: { p: mid, R: B.R } }, target: targetOf(cur), speed, zone, ...frames });
          }));
          ins.movcRun = run;
          break;
        }
        emit(line, guarded(async (vm, f) => {
          const rawP = pos(vm, f);
          const frames = resolveMoveFrames(vm.ctrl, rawP);
          const p = applyShift(vm.ctrl, rawP, f.locals.get('$SFT'));
          await vm.move({ kind: op === 'MOVJ' ? 'J' : 'L', target: targetOf(p), speed, zone, ...frames });
        }));
        break;
      }

      case 'IMOV': {
        const r = parseVarName(args[0] || '');
        if (!r || r.type !== 'P') throw new CompileError('IMOV: P 변수가 필요합니다 (예: IMOV P000 V=100 BF)', file, line);
        const ufArg = args.slice(1).find((w) => /^UF#\(\d+\)$/i.test(w));
        const ufNo = ufArg ? Number(/\d+/.exec(ufArg)[0]) : null;
        const tags = parseTags(args.slice(1).filter((w) => w !== ufArg));
        const v = numTag(tags, 'V', file, line) ?? 66;
        const speed = { tcp: v };
        if (tags.VR !== undefined) speed.rot = numTag(tags, 'VR', file, line);
        const tf = !!tags.TF;
        const bf = !!tags.BF || !!tags.RF;
        emit(line, guarded(async (vm, f) => {
          const d = readV(vm.ctrl, f, r);
          if (!d) throw new RuntimeErr('VAR', `위치 변수 ${args[0]} 가 설정되지 않았습니다`);
          const dv = d.kind === 'joints' ? null : d.v;
          if (!dv) { // 관절 증분
            const j = vm.ctrl.joints.map((q, i) => q + d.v[i]);
            return void await vm.move({ kind: 'J', target: jointTarget(j), speed: { frac: Math.min(1, v / vm.ctrl.robot.tcpMaxSpeed) } });
          }
          const tool = job.toolNo > 0 && vm.ctrl.getToolFrame ? vm.ctrl.getToolFrame(job.toolNo) : vm.ctrl.tool;
          const base = ufNo !== null ? (vm.ctrl.getUserFrame?.(ufNo) ?? null) : bf ? null : vm.ctrl.effectiveBase;
          const cur = fkTcp(vm.ctrl.robot, vm.ctrl.joints, tool, base);
          const dp = fromVendorPose(VENDOR, dv);
          const next = tf ? { p: add(cur.p, rot(cur.R, dp.p)), R: mul3(cur.R, dp.R) } : { p: add(cur.p, dp.p), R: mul3(dp.R, cur.R) };
          await vm.move({ kind: 'L', target: { pose: next }, speed, tool, base });
        }));
        break;
      }

      case 'SFTON': {
        const r = parseVarName(args[0] || '');
        if (!r || r.type !== 'P') throw new CompileError('SFTON: P 변수가 필요합니다', file, line);
        const tf = args.some((w) => K(w) === 'TF');
        emit(line, guarded((vm, f) => {
          const d = readV(vm.ctrl, f, r);
          if (!d || d.kind !== 'pose') throw new RuntimeErr('VAR', `SFTON: ${args[0]} 는 직교 위치 변수여야 합니다`);
          f.locals.set('$SFT', { v: [...d.v], frame: tf ? 'TF' : 'BF' });
        }));
        break;
      }
      case 'SFTOF': emit(line, guarded((vm, f) => { f.locals.delete('$SFT'); })); break;

      case 'TIMER': {
        const t = numTag(parseTags(args), 'T', file, line);
        if (t === undefined || t < 0) throw new CompileError('TIMER T=초 가 필요합니다', file, line);
        emit(line, guarded((vm) => vm.wait(t)));
        break;
      }

      case 'DOUT': {
        const io = parseIO(args[0] || '');
        if (!io || (io.kind !== 'OT' && io.kind !== 'OG')) throw new CompileError('DOUT: OT#(n) 또는 OG#(n) 이 필요합니다', file, line);
        if (args.length < 2) throw new CompileError('DOUT: 출력 값이 필요합니다', file, line);
        const val = valFn(args.slice(1).join(' '), line);
        emit(line, guarded((vm, f) => {
          const v = Number(val(vm, f));
          if (io.kind === 'OT') vm.ctrl.setDO(io.n, !!v);
          else for (let b = 0; b < 8; b++) vm.ctrl.setDO((io.n - 1) * 8 + 1 + b, (v >> b) & 1);
        }));
        break;
      }

      case 'PULSE': {
        const io = parseIO(args[0] || '');
        if (!io || io.kind !== 'OT') throw new CompileError('PULSE: OT#(n) 이 필요합니다', file, line);
        const t = numTag(parseTags(args.slice(1)), 'T', file, line) ?? 0.3;
        emit(line, guarded(async (vm) => { vm.ctrl.setDO(io.n, true); await vm.wait(t); vm.ctrl.setDO(io.n, false); }));
        break;
      }

      case 'WAIT': {
        let src = body.trim().slice(4).trim();
        let timeout = Infinity;
        const mt = /\s+T=([\d.]+)\s*$/i.exec(src);
        if (mt) { timeout = Number(mt[1]); src = src.slice(0, mt.index); }
        if (!src) throw new CompileError('WAIT: 조건이 필요합니다', file, line);
        const c = condFn(src, line);
        emit(line, guarded(async (vm, f) => {
          const ok = await vm.waitUntil(() => c(vm, f), timeout);
          vm.ctrl.regs.set('$B:WAIT_TIMEOUT', ok ? 0 : 1);
          if (!ok) vm.print(`WAIT 타임아웃 (${timeout}s): ${src}`);
        }));
        break;
      }

      case 'DIN': {
        const r = varRef(args[0] || '', line);
        const io = parseIO(args[1] || '');
        if (!io || (io.kind !== 'IN' && io.kind !== 'IG')) throw new CompileError('DIN: IN#(n) 또는 IG#(n) 이 필요합니다', file, line);
        const ast = parseCond(`${io.kind}#(${io.n})`);
        emit(line, guarded((vm, f) => writeV(vm.ctrl, f, r, ev(vm, f, ast), args[0])));
        break;
      }

      case 'JUMP': {
        const tgt = args[0] || '';
        if (/^JOB:/i.test(tgt)) {
          const N = need(tgt.slice(4), file, line);
          emit(line, guarded((vm, f) => { f.pc = f.proc.code.length; return { call: { proc: prog.procs[N] } }; }));
          break;
        }
        if (!tgt.startsWith('*')) throw new CompileError('JUMP: *라벨 또는 JOB:이름 이 필요합니다', file, line);
        const ins = gotoTo(line, cond);
        fixups.push({ label: K(tgt.slice(1)), line, ins });
        break;
      }

      case 'CALL': {
        const tgt = args[0] || '';
        if (!/^JOB:/i.test(tgt)) throw new CompileError('CALL: JOB:이름 이 필요합니다', file, line);
        const N = need(tgt.slice(4), file, line);
        emit(line, guarded(() => ({ call: { proc: prog.procs[N] } })));
        break;
      }

      case 'RET': emit(line, guarded(() => ({ ret: undefined }))); break;
      case 'PAUSE': emit(line, guarded((vm) => { vm.print('PAUSE'); vm.ctrl.hold(); })); break;

      case 'SET': case 'ADD': case 'SUB': case 'MUL': case 'DIV': {
        if (args.length < 2) throw new CompileError(`${op}: 변수와 값이 필요합니다`, file, line);
        const r = varRef(args[0], line);
        const name = K(args[0]);
        const srcV = args.slice(1).join(' ');
        const srcRef = parseVarName(srcV);
        if (r.type === 'P') {
          if (!srcRef || srcRef.type !== 'P') throw new CompileError(`${op}: P 변수끼리만 연산할 수 있습니다`, file, line);
          emit(line, guarded((vm, f) => {
            const b = readV(vm.ctrl, f, srcRef);
            if (!b) throw new RuntimeErr('VAR', `위치 변수 ${srcV} 가 설정되지 않았습니다`);
            if (op === 'SET') return writeV(vm.ctrl, f, r, b, name);
            const a = readV(vm.ctrl, f, r);
            if (!a) throw new RuntimeErr('VAR', `위치 변수 ${name} 가 설정되지 않았습니다`);
            if (op !== 'ADD' && op !== 'SUB') throw new RuntimeErr('VAR', `${op} 는 P 변수에 사용할 수 없습니다`);
            writeV(vm.ctrl, f, r, { kind: a.kind, v: a.v.map((x, i) => (op === 'ADD' ? x + b.v[i] : x - b.v[i])) }, name);
          }));
          break;
        }
        const val = valFn(srcV, line);
        emit(line, guarded((vm, f) => {
          const b = val(vm, f);
          if (op === 'SET') return writeV(vm.ctrl, f, r, b, name);
          const a = Number(readV(vm.ctrl, f, r));
          const nb = Number(b);
          let res;
          if (op === 'ADD') res = a + nb;
          else if (op === 'SUB') res = a - nb;
          else if (op === 'MUL') res = a * nb;
          else { if (nb === 0) throw new RuntimeErr('VAR', `${name}: 0 으로 나눔`); res = r.type === 'R' ? a / nb : Math.trunc(a / nb); }
          writeV(vm.ctrl, f, r, res, name);
        }));
        break;
      }

      case 'INC': case 'DEC': {
        const r = varRef(args[0] || '', line);
        if (r.type === 'P' || r.type === 'S') throw new CompileError(`${op}: 숫자 변수가 필요합니다`, file, line);
        emit(line, guarded((vm, f) => writeV(vm.ctrl, f, r, Number(readV(vm.ctrl, f, r)) + (op === 'INC' ? 1 : -1), args[0])));
        break;
      }

      case 'CLEAR': {
        const r = varRef(args[0] || '', line);
        const cnt = K(args[1] || '1') === 'ALL' ? Infinity : Number(args[1] || 1);
        emit(line, guarded((vm, f) => {
          const m = r.local ? f.locals : vm.ctrl.regs;
          const pre = `${r.local ? 'L' : ''}${r.type}:`;
          for (const k of [...m.keys()]) {
            if (!k.startsWith(pre)) continue;
            const i = Number(k.slice(pre.length));
            if (i >= r.idx && i < r.idx + cnt) m.delete(k);
          }
        }));
        break;
      }

      case 'SETE': case 'GETE': {
        // SETE P000 (3) 100.0   /  GETE D000 P000 (3)
        const m = op === 'SETE'
          ? /^SETE\s+(\S+)\s*\(\s*(\d+)\s*\)\s*(.+)$/i.exec(body.trim())
          : /^GETE\s+(\S+)\s+(\S+)\s*\(\s*(\d+)\s*\)\s*$/i.exec(body.trim());
        if (!m) throw new CompileError(`${op} 형식 오류`, file, line);
        if (op === 'SETE') {
          const r = varRef(m[1], line);
          if (r.type !== 'P') throw new CompileError('SETE: P 변수가 필요합니다', file, line);
          const el = Number(m[2]);
          if (!(el >= 1 && el <= 6)) throw new CompileError('SETE: 요소 번호는 1~6', file, line);
          const val = valFn(m[3], line);
          emit(line, guarded((vm, f) => {
            const p = readV(vm.ctrl, f, r) || posVal('pose', [0, 0, 0, 0, 0, 0]);
            const q = clonePos(p);
            q.v[el - 1] = Number(val(vm, f)); // 단위: mm / deg
            writeV(vm.ctrl, f, r, q, m[1]);
          }));
        } else {
          const dst = varRef(m[1], line);
          const src = varRef(m[2], line);
          if (src.type !== 'P') throw new CompileError('GETE: P 변수가 필요합니다', file, line);
          const el = Number(m[3]);
          if (!(el >= 1 && el <= 6)) throw new CompileError('GETE: 요소 번호는 1~6', file, line);
          emit(line, guarded((vm, f) => {
            const p = readV(vm.ctrl, f, src);
            if (!p) throw new RuntimeErr('VAR', `위치 변수 ${m[2]} 가 설정되지 않았습니다`);
            writeV(vm.ctrl, f, dst, p.v[el - 1], m[1]);
          }));
        }
        break;
      }

      case 'CNVRT': {
        const d = varRef(args[0] || '', line), s = varRef(args[1] || '', line);
        if (d.type !== 'P' || s.type !== 'P') throw new CompileError('CNVRT: P 변수 두 개가 필요합니다', file, line);
        emit(line, guarded((vm, f) => {
          const p = readV(vm.ctrl, f, s);
          if (!p) throw new RuntimeErr('VAR', `위치 변수 ${args[1]} 가 설정되지 않았습니다`);
          writeV(vm.ctrl, f, d, posVal('pose', toVendorPose(VENDOR, poseOf(vm.ctrl, p))), args[0]);
        }));
        break;
      }

      case 'MSG': {
        const m = /^MSG\s+(.*)$/i.exec(body.trim());
        const txt = m ? m[1].trim().replace(/^"|"$/g, '') : '';
        emit(line, guarded((vm) => vm.print(txt)));
        break;
      }

      case 'TOOLON': case 'TOOLOF': case 'TOOLOFF': case 'ARCON': case 'ARCOF': case 'ARCOFF': case 'SPEED':
        emit(line, guarded((vm) => vm.print(`${op} ${args.join(' ')}`.trim())));
        break;

      // ---- YRC1000 구조화 명령 ----
      case 'IFTHEN': {
        const c = condFn(body.trim().slice(6), line);
        const j = gotoTo(line, (vm, f) => !c(vm, f));
        blocks.push({ kind: 'IF', line, next: j, ends: [] });
        break;
      }
      case 'ELSEIF': case 'ELSE': {
        const b = blocks[blocks.length - 1];
        if (!b || b.kind !== 'IF' || b.hasElse) throw new CompileError(`${op} 에 대응하는 IFTHEN 이 없습니다`, file, line);
        b.ends.push(gotoTo(line, null));
        b.next.to = code.length;
        if (op === 'ELSE') { b.hasElse = true; b.next = null; emit(line, () => {}); }
        else { const c = condFn(body.trim().slice(6), line); b.next = gotoTo(line, (vm, f) => !c(vm, f)); }
        break;
      }
      case 'ENDIF': {
        const b = blocks.pop();
        if (!b || b.kind !== 'IF') throw new CompileError('ENDIF 에 대응하는 IFTHEN 이 없습니다', file, line);
        emit(line, () => {});
        const pc = code.length - 1;
        if (b.next) b.next.to = pc;
        b.ends.forEach((e) => { e.to = pc; });
        break;
      }
      case 'WHILEEXP': {
        const c = condFn(body.trim().slice(8), line);
        const top = code.length;
        const j = gotoTo(line, (vm, f) => !c(vm, f));
        blocks.push({ kind: 'WHILE', line, top, exit: j });
        break;
      }
      case 'ENDWHILE': {
        const b = blocks.pop();
        if (!b || b.kind !== 'WHILE') throw new CompileError('ENDWHILE 에 대응하는 WHILEEXP 가 없습니다', file, line);
        gotoTo(line, null).to = b.top;
        b.exit.to = code.length;
        break;
      }

      default:
        throw new CompileError(`알 수 없는 명령: ${words[0]}`, file, line);
    }
  }
  if (blocks.length) { const b = blocks[blocks.length - 1]; throw new CompileError(`${b.kind === 'IF' ? 'ENDIF' : 'ENDWHILE'} 가 없습니다`, file, b.line); }
  for (const fx of fixups) {
    const pc = proc.labels[fx.label];
    if (pc === undefined) throw new CompileError(`라벨 *${fx.label} 이(가) 없습니다`, file, fx.line);
    fx.ins.to = pc;
  }
  // MOVC 연속 구간 검사 (3점 이상)
  const seen = new Set();
  for (const ins of code) {
    const run = ins.movcRun;
    if (!run || seen.has(run)) continue;
    seen.add(run);
    if (run.pts.length < 3) throw new CompileError('MOVC 는 3점 이상 연속으로 지정해야 합니다 (시작/중간/끝)', file, run.first);
  }
}

// ------------------------------------------------------------ 예제 잡 생성
function planPickPlace(ctrl) {
  const r = ctrl.robot;
  const tool = toolOf(ctrl);
  const ok = (p) => !!ikNearest(r, tcpToFlange({ p, R: DOWN }, tool, null), r.home);
  const objs = ctrl.objects || [];
  if (!objs.length) return { pts: [], ok: true };
  const s = objs[0].size[2];
  const app = Math.round(Math.max(80, s * 2.5));
  const R = r.reach;
  for (const fx of [0.38, 0.42, 0.34, 0.46, 0.30, 0.50]) {
    const pts = objs.map((o) => {
      const pick = [o.pose.p[0], o.pose.p[1], o.pose.p[2]];
      const place = [Math.round(R * fx), -o.pose.p[1], o.size[2] / 2 + 1];
      return { id: o.id, pick, pickApp: [pick[0], pick[1], pick[2] + app], place, placeApp: [place[0], place[1], place[2] + app] };
    });
    if (pts.every((q) => ok(q.pick) && ok(q.pickApp) && ok(q.place) && ok(q.placeApp))) return { pts, ok: true };
  }
  const pts = objs.map((o) => {
    const pick = [...o.pose.p];
    const place = [Math.round(R * 0.4), -o.pose.p[1], o.size[2] / 2 + 1];
    return { id: o.id, pick, pickApp: [pick[0], pick[1], pick[2] + app], place, placeApp: [place[0], place[1], place[2] + app] };
  });
  return { pts, ok: false };
}

const pad5 = (n) => String(n).padStart(5, '0');
const f3 = (v) => (Math.abs(v) < 5e-4 ? 0 : v).toFixed(3);
const f4 = (v) => (Math.abs(v) < 5e-5 ? 0 : v).toFixed(4);
function dateStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function subJob(name, comm, body) {
  return [
    '/JOB', `//NAME ${name}`, '//POS', '///NPOS 0,0,0,0,0,0', '//INST', `///DATE ${dateStr()}`,
    `///COMM ${comm}`, '///ATTR SC,RW', ...body, '',
  ].join('\n');
}

function defaultFiles(ctrl) {
  const r = ctrl.robot;
  const { pts, ok } = planPickPlace(ctrl);
  const ppd = r.pulsePerDeg || [1000, 1000, 1000, 1000, 1000, 1000];
  const homePulse = r.home.map((d, i) => Math.round(d * ppd[i]));
  const rect = (p) => toVendorPose(VENDOR, { p, R: DOWN });
  const C = [];
  const posLines = [];
  const addPos = (p) => { const i = C.length; C.push(p); posLines.push(`C${pad5(i)}=${rect(p).map((v, k) => (k < 3 ? f3(v) : f4(v))).join(',')}`); return `C${pad5(i)}`; };
  C.push('home');
  const order = pts.map((q) => ({ id: q.id, pa: addPos(q.pickApp), pk: addPos(q.pick), la: addPos(q.placeApp), lp: addPos(q.place) }));

  const inst = [
    'NOP',
    `'픽 앤 플레이스: 공작물 ${pts[0].id}~${pts[pts.length - 1].id} 를 Y 대칭 위치로 이송`,
    ...(ok ? [] : ["'경고: 일부 위치가 현재 로봇의 작업영역 밖일 수 있음"]),
    'SET I000 0',
    'CALL JOB:HAND_OPEN',
    'MOVJ C00000 VJ=25.00',
  ];
  for (const o of order) {
    inst.push(
      `'---- ${o.id} ----`,
      `MOVJ ${o.pa} VJ=50.00 PL=3`,
      `MOVL ${o.pk} V=200.0 PL=0`,
      'CALL JOB:HAND_CLOSE',
      'JUMP *NOPART IF IN#(3)=OFF',
      `MOVL ${o.pa} V=500.0 PL=3`,
      `MOVJ ${o.la} VJ=50.00 PL=3`,
      `MOVL ${o.lp} V=200.0 PL=0`,
      'CALL JOB:HAND_OPEN',
      `MOVL ${o.la} V=500.0 PL=3`,
      'INC I000',
    );
  }
  inst.push(
    'MOVJ C00000 VJ=25.00',
    'MSG "PICK & PLACE COMPLETE"',
    'JUMP *FIN',
    '*NOPART',
    'MSG "WORKPIECE NOT DETECTED"',
    'CALL JOB:HAND_OPEN',
    'PAUSE',
    '*FIN',
    'END',
  );

  const master = [
    '/JOB',
    '//NAME MASTER',
    '//POS',
    `///NPOS ${C.length},0,0,0,0,0`,
    '///TOOL 0',
    '///POSTYPE PULSE',
    '///PULSE',
    `C00000=${homePulse.join(',')}`,
    '///TOOL 0',
    '///POSTYPE BASE',
    '///RECTAN',
    '///RCONF 0,0,0,0,0,0,0,0',
    ...posLines,
    '//INST',
    `///DATE ${dateStr()}`,
    '///COMM PICK AND PLACE W1-W4',
    '///ATTR SC,RW',
    '///GROUP1 RB1',
    ...inst,
    '',
  ].join('\n');

  return {
    'MASTER.JBI': master,
    'HAND_CLOSE.JBI': subJob('HAND_CLOSE', 'GRIPPER CLOSE', ['NOP', 'DOUT OT#(2) OFF', 'DOUT OT#(1) ON', 'WAIT IN#(1)=ON T=3.00', 'TIMER T=0.20', 'END']),
    'HAND_OPEN.JBI': subJob('HAND_OPEN', 'GRIPPER OPEN', ['NOP', 'DOUT OT#(1) OFF', 'DOUT OT#(2) ON', 'WAIT IN#(2)=ON T=3.00', 'TIMER T=0.20', 'DOUT OT#(2) OFF', 'END']),
  };
}

// ------------------------------------------------------------ 모듈
function pickMain(names, files) {
  const jbi = names.filter(isJbi);
  if (!jbi.length) return names[0] ?? null;
  const master = jbi.find((n) => jobNameOf(n, files?.get?.(n)) === 'MASTER');
  return master ?? jbi[0];
}

function readVar(ctrl, name) {
  const r = parseVarName(name);
  if (!r || r.local) return undefined;
  const v = ctrl.regs.get(r.key);
  return v === undefined ? defVal(r.type) : v;
}

function writeVar(ctrl, name, value) {
  const r = parseVarName(name);
  if (!r || r.local) return false;
  try { ctrl.regs.set(r.key, coerce(r.type, value, K(name))); return true; } catch { return false; }
}

export default {
  id: 'inform', name: 'Yaskawa INFORM', exts: ['.JBI'],
  compile, pickMain, defaultFiles, readVar, writeVar,
};

export { arcMid, parseVarName };
