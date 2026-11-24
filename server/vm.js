// 공용 로봇 프로그램 가상머신
// 각 언어 컴파일러는 아래 형태의 Program 을 만든다.
//
//  Program = {
//    lang, entry: 'MAIN',                     // 시작 루틴 이름 (대문자 키)
//    procs: { NAME: { name, params:[이름], file, code:[Instr], labels:{} } },
//    globals: Map(),                          // 전역 변수 (키는 언어 규칙에 따라 정규화)
//    init?: (vm) => void,                     // 실행 전 초기화 훅
//  }
//  Instr = { line, file?, run(vm, frame) → undefined | Promise<...> | Ctl }
//  Ctl   = { goto: pc } | { call: {proc, args, onReturn?(value)} } | { ret: value } | { halt: true }
//
// 프레임: { proc, pc, locals: Map }

export class AbortErr extends Error { constructor() { super('aborted'); this.aborted = true; } }

// 동작·대기 없이 도는 반복문(입력 폴링 등)이 Node 이벤트 루프를 독점하지 않도록 이 시간마다 양보한다.
// 양보하는 동안 시뮬레이션 주기·통신·UI(STOP/HOLD 포함)가 처리된다.
const YIELD_MS = 4;
// 호출 깊이 상한 — 무한 재귀가 서버 메모리를 다 쓰기 전에 알람으로 멈춤
export const MAX_CALL_DEPTH = 500;
const yieldNow = () => new Promise((r) => setImmediate(r));

export class VM {
  constructor(ctrl, program) {
    this.ctrl = ctrl;
    this.prog = program;
    this.globals = program.globals || new Map();
    this.frames = [];
    this.status = 'idle'; // idle | running | paused | done | error | aborted
    this.stepMode = false;
    this.aborted = false;
    this.cycle = 0;
    this._resume = null;
    this.current = null; // {file, line, proc}
    this._ppCustom = false;
  }

  get frame() { return this.frames[this.frames.length - 1]; }

  reset() {
    this.frames = [];
    const entry = this.prog.procs[this.prog.entry];
    if (!entry) throw new Error(`시작 루틴 '${this.prog.entry}' 를 찾을 수 없습니다`);
    this.frames.push({ proc: entry, pc: 0, locals: new Map() });
    this.aborted = false;
    this.status = 'idle';
    this._ppCustom = false;
    this.setCurrent();
  }

  // 커서 줄(file, line)로 프로그램 포인터(PP) 이동 — 해당 줄 또는 직후 실행 가능한 명령으로 스냅
  setPointer(file, line) {
    const ln = Math.max(1, Math.trunc(Number(line) || 1));
    const procs = Object.values(this.prog.procs || {});
    let best = null;
    for (const proc of procs) {
      for (let pc = 0; pc < proc.code.length; pc++) {
        const ins = proc.code[pc];
        const f = ins.file ?? proc.file;
        if (file && f !== file) continue;
        if (typeof ins.line !== 'number') continue;
        if (ins.line >= ln) {
          const dist = ins.line - ln;
          if (!best || dist < best.dist) best = { proc, pc, line: ins.line, file: f, dist };
          break;
        }
      }
    }
    // 커서가 파일 끝 주석/빈 줄 아래에 있으면 같은 파일의 마지막 실행 명령으로
    if (!best) {
      for (const proc of procs) {
        for (let pc = proc.code.length - 1; pc >= 0; pc--) {
          const ins = proc.code[pc];
          const f = ins.file ?? proc.file;
          if (file && f !== file) continue;
          if (typeof ins.line === 'number') {
            if (!best || ins.line > best.line) best = { proc, pc, line: ins.line, file: f, dist: ln - ins.line };
            break;
          }
        }
      }
    }
    if (!best) return { ok: false, reason: `${file || '현재 파일'}에서 실행 가능한 명령 줄을 찾을 수 없습니다` };
    this.frames = [{ proc: best.proc, pc: best.pc, locals: new Map() }];
    this.aborted = false;
    this.status = 'idle';
    this._ppCustom = true;
    this.setCurrent();
    return { ok: true, file: best.file, line: best.line, proc: best.proc.name, pc: best.pc };
  }

  setCurrent() {
    const f = this.frame;
    const ins = f?.proc.code[f.pc];
    this.current = f ? { file: ins?.file ?? f.proc.file, line: ins?.line ?? null, proc: f.proc.name } : null;
  }

  async run({ step = false } = {}) {
    if (!this.frames.length) this.reset();
    if (this.status === 'running') return;
    this.stepMode = step;
    this.status = 'running';
    this.ctrl.emitState();
    // 사이클 타임 측정 (HOLD 시간 제외)
    // 시뮬레이션 시계(ctrl.simMs) 기준: HOLD 중 정지, 호스트 부하와 무관하게 로봇 시간 측정
    const st = { start: this.ctrl.simMs, hold0: 0, motion: 0, wait: 0, logic: 0, lines: new Map(), moves: 0 };
    this.ctrl.cycleStats.current = st;
    let lastYield = performance.now();
    try {
      for (;;) {
        if (performance.now() - lastYield >= YIELD_MS) { await yieldNow(); lastYield = performance.now(); }
        if (this.aborted) throw new AbortErr();
        if (this.ctrl.held) await this.waitResume();
        const f = this.frame;
        if (!f) { this.status = 'done'; break; }
        if (f.pc >= f.proc.code.length) {
          // 루틴 끝 = 암묵적 RETURN
          if (this.ret(undefined)) { this.status = 'done'; break; }
          continue;
        }
        const ins = f.proc.code[f.pc];
        this.current = { file: ins.file ?? f.proc.file, line: ins.line, proc: f.proc.name };
        this.ctrl.emitState();
        // 브레이크포인트: 해당 라인 실행 직전에 일시정지 (재개 직후 같은 명령에서는 다시 멈추지 않음)
        if (this.ctrl.breakpoints?.size > 0 && this._bpSkip !== ins && this.ctrl.breakpoints.has(`${this.current.file}:${this.current.line}`)) {
          this._bpSkip = ins;
          this.status = 'paused';
          this.ctrl.log('program', `브레이크포인트: ${this.current.file}:${this.current.line}`);
          this.ctrl.emitState();
          await new Promise((res) => { this._resume = res; });
          if (this.aborted) throw new AbortErr();
          this.status = 'running';
          continue;
        }
        const t0 = this.ctrl.simMs;
        this._cat = 'logic';
        let r = ins.run(this, f);
        if (r && typeof r.then === 'function') { r = await r; lastYield = performance.now(); }
        const dt = Math.max(0, this.ctrl.simMs - t0);
        st[this._cat] += dt;
        if (this._cat === 'motion') st.moves++;
        const key = `${this.current.file ?? ''}:${this.current.line ?? ''}`;
        const le = st.lines.get(key) || { file: this.current.file, line: this.current.line, time: 0, count: 0, cat: this._cat };
        le.time += dt; le.count++; if (this._cat !== 'logic') le.cat = this._cat;
        st.lines.set(key, le);
        if (this.aborted) throw new AbortErr();
        if (this._bpSkip === ins) this._bpSkip = null;
        if (!r || typeof r !== 'object') f.pc++;
        else if (r.goto !== undefined) f.pc = r.goto;
        else if (r.call) {
          f.pc++;
          const { proc, args = [], onReturn, locals } = r.call;
          if (this.frames.length >= MAX_CALL_DEPTH) throw Object.assign(new Error(`호출 깊이 초과 (${MAX_CALL_DEPTH}단계) — 끝나지 않는 재귀 호출인지 확인하세요`), { code: 'STACK' });
          const lm = locals || new Map();
          proc.params?.forEach((p, i) => lm.set(p, args[i]));
          this.frames.push({ proc, pc: 0, locals: lm, onReturn });
        } else if (r.ret !== undefined || 'ret' in r) {
          if (this.ret(r.ret)) { this.status = 'done'; break; }
        } else if (r.halt) { this.status = 'done'; this.frames = []; break; }
        if (this.stepMode) {
          this.setCurrent();
          this.status = 'paused';
          this.ctrl.emitState();
          await new Promise((res) => { this._resume = res; });
          if (this.aborted) throw new AbortErr();
          this.status = 'running';
        }
      }
    } catch (e) {
      if (e.aborted) { this.status = 'aborted'; }
      else {
        this.status = 'error';
        // 함수(FUNC/DEFFCT) 안에서 난 오류는 언어 모듈이 실제 위치(e.file/e.line)를 붙여 줌 → 그 줄을 표시
        if (typeof e.line === 'number' && this.current) this.current = { ...this.current, file: e.file ?? this.current.file, line: e.line, callLine: this.current.line };
        const where = this.current ? `${this.current.file ?? ''}:${this.current.line ?? '?'} ` : '';
        this.ctrl.alarm(e.code || 'PROGRAM', `${where}${e.message}`);
      }
    }
    if (this.status === 'done') {
      // 프로그램 종료 후 남은 모션(블렌딩 꼬리)까지 포함
      const t0 = this.ctrl.simMs;
      this._finishing = true;
      if (!this.aborted && !this.detached) await this.ctrl.waitFor(() => this.ctrl.motionIdle || this.aborted || this.detached, Infinity, this);
      this._finishing = false;
      if (this.aborted) {
        this.status = 'aborted';
        if (this.ctrl.cycleStats.current === st) this.ctrl.cycleStats.current = null;
      } else {
        st.motion += Math.max(0, this.ctrl.simMs - t0);
        this.cycle++;
        // 꼬리 대기 중 새 실행이 시작되면(detach) 이 사이클 통계는 버림 (새 실행의 통계를 덮지 않게)
        if (!this.detached) this.ctrl.finishCycle(st);
      }
    } else if (this.ctrl.cycleStats.current === st) this.ctrl.cycleStats.current = null;
    try { this.prog.cleanup?.(this); } catch { /* 정리 실패는 무시 */ }
    this.ctrl.emitState();
    this.ctrl.onProgramEnd?.(this);
  }

  // 반환하면 프레임 pop. 스택이 비면 true
  ret(value) {
    const f = this.frames.pop();
    if (f?.onReturn) f.onReturn(value);
    return this.frames.length === 0;
  }

  // 일시정지 상태에서 단계 실행 재개
  stepResume(step) {
    this.stepMode = step;
    const r = this._resume; this._resume = null;
    r?.();
  }

  // 새 실행으로 교체될 때: 남은 꼬리 대기를 끝냄 (모션은 취소하지 않음)
  detach() {
    if (this.detached) return;
    this.detached = true;
    this.ctrl.wakeWaiters?.(this);
  }

  abort() {
    this.aborted = true;
    if (this.status === 'running' || this.status === 'paused' || this._finishing) this.status = 'aborted';
    this.ctrl.cancelMotion();
    this.ctrl.wakeWaiters?.(this);
    this.stepResume(false);
    this._wakeHold?.();
  }

  waitResume() {
    return new Promise((res) => {
      const check = () => {
        if (this.aborted || !this.ctrl.held) { this.ctrl.off('resume', check); this._wakeHold = null; res(); }
      };
      this._wakeHold = check;
      this.ctrl.on('resume', check);
    });
  }

  // ---- 언어에서 사용하는 런타임 헬퍼 ----
  lookup(name, frame = this.frame) {
    if (frame?.locals.has(name)) return frame.locals;
    if (this.globals.has(name)) return this.globals;
    return null;
  }
  getVar(name, frame) { const m = this.lookup(name, frame); return m ? m.get(name) : undefined; }
  setVar(name, value, frame) { const m = this.lookup(name, frame) || this.globals; m.set(name, value); }

  // move: {kind:'J'|'L'|'C', target:{joints}|{pose,cfg}, via?, speed, tool?, base?}
  async move(cmd) {
    if (this.aborted) throw new AbortErr();
    this._cat = 'motion';
    await this.ctrl.move(cmd);
    if (this.aborted) throw new AbortErr();
  }

  // 일시정지(HOLD) 동안에는 시간이 흐르지 않는 대기 (시뮬레이션 시계 기준 → 배속 적용)
  async wait(sec) {
    this._cat = 'wait';
    if (this.aborted) throw new AbortErr();
    await this.ctrl.sleep(sec, this);
    if (this.aborted) throw new AbortErr();
  }

  // 조건 대기. timeout(s, 시뮬레이션 시간) 초과 시 false 반환
  async waitUntil(fn, timeout = Infinity) {
    if (fn()) return true;
    this._cat = 'wait';
    if (this.aborted) throw new AbortErr();
    const ok = await this.ctrl.waitFor(() => this.aborted || fn(), timeout, this);
    if (this.aborted) throw new AbortErr();
    return ok;
  }

  print(msg) { this.ctrl.log('program', String(msg)); }
}
