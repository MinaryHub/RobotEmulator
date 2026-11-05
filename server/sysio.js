// 시스템 I/O (전용 입출력) — PLC ↔ 로봇 하드와이어/필드버스 시스템 신호 모사 (docs/ROADMAP-SI.md P0-2)
//
//  범용 DI/DO 중 일부(기본 401번부터)를 제조사 관례에 따른 시스템 신호로 할당한다.
//  입력(PLC → 로봇)은 컨트롤러 명령으로 변환되고 출처는 'ext'(외부) → 모드 인터록·안전 판정을 받는다.
//  출력(로봇 → PLC)은 매 시뮬레이션 스텝마다 컨트롤러 상태에서 계산해 DO 에 쓴다.
//  같은 DI/DO 는 Modbus 코일/이산 입력, OPC UA IO, 제조사 프로토콜 I/O 로도 보이므로 어떤 경로로든 PLC 시퀀스를 시험할 수 있다.
//
//  입력 종류 (kind)
//   servoOn      상승 에지 → 서보 ON              servoOff  레벨(activeLow 가능) → 서보 OFF
//   start        상승 에지 → 시작/재개              startMain 상승 에지 → 처음부터 시작 (ABB Start at Main)
//   hold         레벨 → HOLD (activeLow: 입력 OFF 일 때 HOLD, 예: KUKA $MOVE_ENABLE)
//   stop         상승 에지 → 프로그램 정지          alarmReset 상승 에지 → 알람 리셋
//   estop        레벨(기본 activeLow = NC 접점) → 비상정지
//   fence        레벨(기본 activeLow: 입력 ON = 펜스 닫힘, OFF = 열림) → 안전 펜스
//   enable       레벨 → 인에이블 스위치
//   pgnoBit      프로그램 번호 비트 (index 0 = LSB) pgnoParity 패리티 비트   pgnoStrobe 상승 에지 → 번호 확정·프로그램 선택
//
//  출력 종류 (kind)
//   ready 외부 운전 준비(REMOTE·서보 ON·알람 없음·비상정지 아님)   servoOn   running(실행 중, HOLD 아님)   held
//   alarm   remote   teach   auto(PLAY/REMOTE)   home(홈 자세 ±0.5°)   moving   done(프로그램 정상 종료, 다음 시작까지 유지)
//   pgnoReq(프로그램 번호 요청: ready 이고 실행 중 아님)   pgnoAck(번호 수신 확인 펄스)   pgnoErr(번호 오류, 다음 스트로브까지 유지)
//   estopOk(비상정지 아님) estopActive(비상정지 중) fenceOk(펜스 닫힘)
//
// 프리셋의 신호 이름·논리는 각 제조사 매뉴얼의 일반적인 관례를 따른 근사치다.
// 실제 현장의 신호 번호·논리(NC/NO)·펄스 폭은 컨트롤러 설정마다 다르므로 UI 에서 번호와 논리를 맞춰 쓴다.
import { REJECT } from './controller.js';

const B = (n) => Array.from({ length: n }, (_, i) => i);
const pgnoBits = (n, nameFn) => B(n).map((i) => ({ kind: 'pgnoBit', index: i, name: nameFn(i + 1) }));

export const PRESETS = {
  generic: {
    name: '범용',
    note: '제조사 구분 없는 기본 할당. 프로그램 번호 8비트 이진수 + 스트로브.',
    pgno: { bits: 8, type: 'binary', parity: 'none' },
    inputs: [
      { kind: 'servoOn', name: '외부 서보 ON' },
      { kind: 'start', name: '외부 시작' },
      { kind: 'hold', name: '외부 홀드' },
      { kind: 'stop', name: '외부 정지' },
      { kind: 'alarmReset', name: '알람 리셋' },
      { kind: 'estop', name: '외부 비상정지 (NC)', activeLow: true },
      { kind: 'fence', name: '안전 펜스 닫힘', activeLow: true },
      { kind: 'pgnoStrobe', name: '프로그램 번호 스트로브' },
      ...pgnoBits(8, (i) => `프로그램 번호 비트${i}`),
    ],
    outputs: [
      { kind: 'ready', name: '외부 운전 준비' },
      { kind: 'servoOn', name: '서보 ON 중' },
      { kind: 'running', name: '운전 중' },
      { kind: 'held', name: '홀드 중' },
      { kind: 'alarm', name: '알람 발생' },
      { kind: 'remote', name: 'REMOTE 모드' },
      { kind: 'home', name: '홈 위치' },
      { kind: 'done', name: '사이클 완료' },
      { kind: 'pgnoAck', name: '프로그램 번호 확인' },
      { kind: 'pgnoErr', name: '프로그램 번호 오류' },
      { kind: 'estopOk', name: '비상정지 정상' },
      { kind: 'fenceOk', name: '안전 펜스 정상' },
      { kind: 'moving', name: '로봇 이동 중' },
    ],
  },
  yaskawa: {
    name: 'Yaskawa 전용 입출력 (근사)',
    note: '외부 기동은 홀드·정지 위치에서 재개. 잡 번호 선택은 8비트 이진수 + 스트로브.',
    pgno: { bits: 8, type: 'binary', parity: 'none' },
    inputs: [
      { kind: 'servoOn', name: '외부 서보 ON' },
      { kind: 'start', name: '외부 기동' },
      { kind: 'hold', name: '외부 홀드' },
      { kind: 'alarmReset', name: '알람/에러 리셋' },
      { kind: 'estop', name: '외부 비상정지 (NC)', activeLow: true },
      { kind: 'fence', name: '안전 펜스 (NC)', activeLow: true },
      { kind: 'pgnoStrobe', name: '잡 선택 스트로브' },
      ...pgnoBits(8, (i) => `잡 번호 비트${i}`),
    ],
    outputs: [
      { kind: 'running', name: '운전 중' },
      { kind: 'servoOn', name: '서보 ON 중' },
      { kind: 'alarm', name: '알람/에러 발생' },
      { kind: 'held', name: '홀드 중' },
      { kind: 'remote', name: '리모트 모드' },
      { kind: 'auto', name: '플레이 모드' },
      { kind: 'teach', name: '티치 모드' },
      { kind: 'home', name: '작업 원점' },
      { kind: 'done', name: '사이클 종료' },
      { kind: 'pgnoAck', name: '잡 선택 완료' },
      { kind: 'pgnoErr', name: '잡 선택 오류' },
      { kind: 'estopOk', name: '비상정지 정상' },
    ],
  },
  kuka: {
    name: 'KUKA Automatic External (근사)',
    note: '$DRIVES_OFF·$MOVE_ENABLE 은 입력 ON 이어야 운전 가능(NC 논리). PGNO 8비트 이진수 + 홀수 패리티 + PGNO_VALID.',
    pgno: { bits: 8, type: 'binary', parity: 'odd' },
    inputs: [
      { kind: 'servoOn', name: '$DRIVES_ON' },
      { kind: 'servoOff', name: '$DRIVES_OFF (NC)', activeLow: true },
      { kind: 'hold', name: '$MOVE_ENABLE', activeLow: true },
      { kind: 'alarmReset', name: '$CONF_MESS' },
      { kind: 'start', name: '$EXT_START' },
      { kind: 'estop', name: '외부 비상정지 (NC)', activeLow: true },
      { kind: 'fence', name: '운전자 보호 (안전 펜스)', activeLow: true },
      { kind: 'pgnoStrobe', name: 'PGNO_VALID' },
      { kind: 'pgnoParity', name: 'PGNO_PARITY' },
      ...pgnoBits(8, (i) => `PGNO 비트${i}`),
    ],
    outputs: [
      { kind: 'servoOn', name: '$PERI_RDY' },
      { kind: 'estopOk', name: '$ALARM_STOP' },
      { kind: 'fenceOk', name: '$USER_SAF' },
      { kind: 'alarm', name: '$STOPMESS' },
      { kind: 'running', name: '$PRO_ACT' },
      { kind: 'home', name: '$IN_HOME' },
      { kind: 'remote', name: '$EXT' },
      { kind: 'pgnoReq', name: 'PGNO_REQ' },
      { kind: 'pgnoAck', name: 'PGNO 확인' },
      { kind: 'pgnoErr', name: 'PGNO 오류' },
      { kind: 'done', name: '사이클 완료' },
    ],
  },
  abb: {
    name: 'ABB System I/O (근사)',
    note: 'Start 는 정지 위치에서 계속, Start at Main 은 처음부터. 프로그램 번호는 그룹 입력으로 모듈을 선택하는 방식으로 근사.',
    pgno: { bits: 8, type: 'binary', parity: 'none' },
    inputs: [
      { kind: 'servoOn', name: 'Motors On' },
      { kind: 'servoOff', name: 'Motors Off' },
      { kind: 'start', name: 'Start' },
      { kind: 'startMain', name: 'Start at Main' },
      { kind: 'stop', name: 'Stop' },
      { kind: 'alarmReset', name: 'Reset Execution Error' },
      { kind: 'estop', name: '외부 비상정지 (NC)', activeLow: true },
      { kind: 'fence', name: 'Auto Stop (안전 펜스, NC)', activeLow: true },
      { kind: 'pgnoStrobe', name: '프로그램 번호 스트로브' },
      ...pgnoBits(8, (i) => `프로그램 번호 비트${i} (그룹 입력)`),
    ],
    outputs: [
      { kind: 'servoOn', name: 'Motors On State' },
      { kind: 'running', name: 'Cycle On' },
      { kind: 'alarm', name: 'Execution Error' },
      { kind: 'estopActive', name: 'Emergency Stop' },
      { kind: 'auto', name: 'Auto On' },
      { kind: 'fenceOk', name: 'Runchain OK' },
      { kind: 'home', name: '홈 위치' },
      { kind: 'moving', name: 'Mechanical Unit Moving' },
      { kind: 'done', name: '사이클 완료' },
      { kind: 'pgnoAck', name: '프로그램 번호 확인' },
      { kind: 'pgnoErr', name: '프로그램 번호 오류' },
    ],
  },
  kawasaki: {
    name: 'Kawasaki 전용 신호 (근사)',
    note: '외부 프로그램 선택(RPS)은 8비트 이진수 + 스트로브.',
    pgno: { bits: 8, type: 'binary', parity: 'none' },
    inputs: [
      { kind: 'servoOn', name: '외부 모터 전원 ON' },
      { kind: 'start', name: '외부 사이클 시작' },
      { kind: 'hold', name: '외부 홀드' },
      { kind: 'alarmReset', name: '외부 에러 리셋' },
      { kind: 'estop', name: '외부 비상정지 (NC)', activeLow: true },
      { kind: 'fence', name: '안전 펜스 (NC)', activeLow: true },
      { kind: 'pgnoStrobe', name: '외부 프로그램 선택 스트로브' },
      ...pgnoBits(8, (i) => `프로그램 번호 비트${i}`),
    ],
    outputs: [
      { kind: 'servoOn', name: '모터 전원 ON' },
      { kind: 'running', name: '사이클 시작 중' },
      { kind: 'alarm', name: '에러 발생' },
      { kind: 'auto', name: 'REPEAT 모드' },
      { kind: 'teach', name: 'TEACH 모드' },
      { kind: 'remote', name: '외부 운전 모드' },
      { kind: 'home', name: '원점 (HOME1)' },
      { kind: 'held', name: '홀드 중' },
      { kind: 'done', name: '사이클 완료' },
      { kind: 'pgnoAck', name: '프로그램 선택 확인' },
      { kind: 'pgnoErr', name: '프로그램 선택 오류' },
    ],
  },
  hyundai: {
    name: 'Hyundai 원격 신호 (근사)',
    note: '프로그램 번호(작업 번호) 8비트 이진수 + 스트로브. 파일명이 숫자인 작업(0001.job 등)은 자동으로 번호와 연결.',
    pgno: { bits: 8, type: 'binary', parity: 'none' },
    inputs: [
      { kind: 'servoOn', name: '외부 모터 ON' },
      { kind: 'start', name: '외부 기동' },
      { kind: 'stop', name: '외부 정지' },
      { kind: 'hold', name: '외부 일시정지' },
      { kind: 'alarmReset', name: '외부 리셋' },
      { kind: 'estop', name: '외부 비상정지 (NC)', activeLow: true },
      { kind: 'fence', name: '안전 펜스 (NC)', activeLow: true },
      { kind: 'pgnoStrobe', name: '작업 번호 스트로브' },
      ...pgnoBits(8, (i) => `작업 번호 비트${i}`),
    ],
    outputs: [
      { kind: 'servoOn', name: '모터 ON' },
      { kind: 'running', name: '운전 중' },
      { kind: 'alarm', name: '에러' },
      { kind: 'ready', name: '외부 기동 가능' },
      { kind: 'remote', name: '외부 운전 모드' },
      { kind: 'home', name: '원점' },
      { kind: 'done', name: '작업 완료' },
      { kind: 'pgnoAck', name: '작업 번호 확인' },
      { kind: 'pgnoErr', name: '작업 번호 오류' },
      { kind: 'estopOk', name: '비상정지 정상' },
    ],
  },
};

const LEVEL_IN = new Set(['servoOff', 'hold', 'estop', 'fence', 'enable']);
const sigKey = (s) => (s.kind === 'pgnoBit' ? `pgno${s.index}` : s.kind);

export class SystemIO {
  constructor(ctrl) {
    this.ctrl = ctrl;
    this.enabled = false;
    this.preset = 'generic';
    this.diBase = 401;
    this.doBase = 401;
    this.assign = { in: {}, out: {} };   // 번호 재지정 { key: n }
    this.logic = { in: {} };             // 입력 논리 재지정 { key: activeLow(boolean) }
    this.programs = {};                  // 프로그램 번호 → 파일명
    this.lastPgno = null;                // 마지막으로 확정된 번호
    this._in = new Map();                // key → 마지막 논리값 (에지 검출)
    this._ack = 0;                       // pgnoAck 펄스 종료 시각 (simMs)
    this._err = false;
    this._done = false;
    this._build();
    ctrl.on('io', (e) => { if (this.enabled && e.type === 'di') this._onDI(e.n); });
  }

  get def() { return PRESETS[this.preset] ?? PRESETS.generic; }

  // 신호 목록(번호 포함) 재구성
  _build() {
    const d = this.def;
    // 기본 번호 = 시작 번호 + 프리셋 내 순서 (개별 재지정해도 다른 신호의 기본 번호는 바뀌지 않음)
    this.inputs = d.inputs.map((s, i) => {
      const key = sigKey(s);
      const activeLow = this.logic.in[key] ?? !!s.activeLow;
      return { ...s, key, dir: 'in', activeLow, n: this.assign.in[key] ?? this.diBase + i };
    });
    this.outputs = d.outputs.map((s, i) => {
      const key = sigKey(s);
      return { ...s, key, dir: 'out', n: this.assign.out[key] ?? this.doBase + i };
    });
    this._byDI = new Map();
    for (const s of this.inputs) { if (!this._byDI.has(s.n)) this._byDI.set(s.n, []); this._byDI.get(s.n).push(s); }
  }

  // 입력의 논리값 (activeLow 반영)
  _val(s) { const raw = this.ctrl.getDI(s.n); return s.activeLow ? !raw : raw; }

  configure(cfg = {}) {
    const c = this.ctrl;
    const wasEnabled = this.enabled;
    if (cfg.preset && PRESETS[cfg.preset] && cfg.preset !== this.preset) { this.preset = cfg.preset; this.assign = { in: {}, out: {} }; this.logic = { in: {} }; }
    if (Number.isInteger(cfg.diBase) && cfg.diBase >= 1 && cfg.diBase <= 480) this.diBase = cfg.diBase;
    if (Number.isInteger(cfg.doBase) && cfg.doBase >= 1 && cfg.doBase <= 480) this.doBase = cfg.doBase;
    if (cfg.assign) this.assign = { in: { ...(cfg.assign.in || {}) }, out: { ...(cfg.assign.out || {}) } };
    if (cfg.logic) this.logic = { in: { ...(cfg.logic.in || {}) } };
    if (cfg.programs) {
      const p = {};
      for (const [k, v] of Object.entries(cfg.programs)) { const n = Number(k); if (Number.isInteger(n) && n > 0 && v) p[n] = String(v); }
      this.programs = p;
    }
    // 이전 할당의 출력은 끔
    const oldOut = this.outputs.map((s) => s.n);
    this._build();
    const newOut = new Set(this.outputs.map((s) => s.n));
    for (const n of oldOut) if (!newOut.has(n) && c.getDO(n)) c.setDO(n, false);
    if (cfg.enabled !== undefined) this.enabled = !!cfg.enabled;
    if (this.enabled && !wasEnabled) {
      // 활성화 시 NC 입력(비상정지·펜스·$DRIVES_OFF·$MOVE_ENABLE)을 정상 상태로 두어 바로 정지하지 않게 함 (PLC 가 배선된 상태와 같음)
      for (const s of this.inputs) if (s.activeLow && LEVEL_IN.has(s.kind) && !c.getDI(s.n)) c.io.di[s.n] = true;
      c.log('system', `시스템 I/O 사용: ${this.def.name} (DI ${this.diBase}~, DO ${this.doBase}~)`);
    }
    if (!this.enabled && wasEnabled) {
      for (const s of this.outputs) if (c.getDO(s.n)) c.setDO(s.n, false);
      c.setEstop(false, 'ext');
      if (c.safety.fenceOpen) c.setFence(false);
      c.log('system', '시스템 I/O 사용 안 함');
    }
    this._in.clear();
    for (const s of this.inputs) this._in.set(s.key, this._val(s));
    if (this.enabled) this._applyLevels();
    this.update();
    c.emitState();
  }

  // 레벨 입력의 현재 값 적용 (활성화 직후·설정 변경 후)
  _applyLevels() {
    for (const s of this.inputs) if (LEVEL_IN.has(s.kind)) this._level(s, this._val(s), true);
  }

  _onDI(n) {
    const list = this._byDI.get(n);
    if (!list) return;
    for (const s of list) {
      const v = this._val(s);
      const prev = this._in.get(s.key) ?? false;
      if (v === prev) continue;
      this._in.set(s.key, v);
      if (LEVEL_IN.has(s.kind)) this._level(s, v, false);
      else if (v && !prev) this._rise(s);
    }
  }

  _level(s, active, initial) {
    const c = this.ctrl;
    switch (s.kind) {
      case 'estop': c.setEstop(active, 'ext'); break;
      case 'fence': c.setFence(active); break;    // 기능 활성 = 펜스 열림 (NC: 입력 OFF = 열림)
      case 'enable': c.setEnableSwitch(active); break;
      case 'servoOff': if (active && c.servo) { c.setServo(false); c.log('system', `${s.name}: 서보 OFF`); } break;
      case 'hold':
        if (active && !initial) { if (c.segment || c.vm?.status === 'running') c.hold(); }
        break;
    }
  }

  async _rise(s) {
    const c = this.ctrl;
    switch (s.kind) {
      case 'servoOn':
        if (this._active('servoOff')) return c.reject('servoOn', 'ext', REJECT.SERVO_OFF_INPUT);
        c.setServo(true, 'ext');
        break;
      case 'start':
        if (this._active('hold')) return c.reject('start', 'ext', REJECT.HOLD_INPUT);
        await this._start(false);
        break;
      case 'startMain': await this._start(true); break;
      case 'stop': c.stopProgram(); break;
      case 'alarmReset': c.resetAlarms(); break;
      case 'pgnoStrobe': this._strobe(); break;
    }
  }

  // 해당 기능 입력이 현재 요구 중인지 (activeLow 반영, 신호가 없으면 false)
  _active(kind) {
    const s = this.inputs.find((x) => x.kind === kind);
    return s ? this._val(s) : false;
  }

  async _start(fromMain) {
    const c = this.ctrl;
    if (!c.allow('start', 'ext')) return;
    if (fromMain && (c.vm?.status === 'running' || c.vm?.status === 'paused')) c.stopProgram();
    this._done = false;
    const ok = await c.start({ source: 'ext' });
    if (!ok && !c.lastReject) c.log('system', '외부 시작 실패');
  }

  _readPgno() {
    const d = this.def.pgno;
    let n = 0, ones = 0;
    for (const s of this.inputs) if (s.kind === 'pgnoBit' && this.ctrl.getDI(s.n)) { n |= 1 << s.index; ones++; }
    if (d.type === 'bcd') {
      let v = 0, mul = 1;
      for (let i = 0; i < d.bits; i += 4) { const nib = (n >> i) & 0xf; if (nib > 9) return { n: -1, ones }; v += nib * mul; mul *= 10; }
      n = v;
    }
    return { n, ones };
  }

  _strobe() {
    const c = this.ctrl;
    this._err = false;
    const { n, ones } = this._readPgno();
    const fail = (r, extra = '') => { this._err = true; c.reject('select', 'ext', { code: r.code, reason: r.reason + extra }); this.update(); };
    if (this.def.pgno.parity !== 'none') {
      const ps = this.inputs.find((s) => s.kind === 'pgnoParity');
      const total = ones + (ps && c.getDI(ps.n) ? 1 : 0);
      if ((this.def.pgno.parity === 'odd') !== (total % 2 === 1)) return fail(REJECT.PGNO_PARITY, ` (번호 ${n})`);
    }
    if (c.vm?.status === 'running' || c.vm?.status === 'paused') return fail(REJECT.BUSY);
    const file = this.programFor(n);
    if (!file) return fail(REJECT.PGNO_INVALID, ` (번호 ${n})`);
    try { c.setMain(file); } catch (e) { return fail(REJECT.PGNO_INVALID, ` (${e.message})`); }
    this.lastPgno = n;
    this._done = false;
    this._ack = c.simMs + 300;
    c.log('system', `프로그램 번호 ${n} → ${file} 선택`);
    this.update();
  }

  // 번호 → 파일: 표에 있으면 그 파일, 없으면 파일명(확장자 제외)이 같은 숫자인 파일 (예: 0001.job → 1)
  programFor(n) {
    if (!(n > 0)) return null;
    const c = this.ctrl;
    const t = this.programs[n];
    if (t && c.files.has(t)) return t;
    for (const f of c.files.keys()) {
      const base = f.replace(/\.[^.]+$/, '');
      if (/^\d+$/.test(base) && Number(base) === n && c.lang.pickMain([f], c.files) === f) return f;
    }
    return null;
  }

  // 출력 계산 → DO 반영 (매 스텝 호출, 바뀐 것만 씀)
  update() {
    if (!this.enabled) return;
    const c = this.ctrl;
    const st = c.vm?.status;
    if (st === 'running' || st === 'paused') this._done = false;
    else if (st === 'done' && c.motionIdle) this._done = true;
    const ready = c.mode === 'REMOTE' && c.servo && !c.alarms.length && !c.estopActive;
    const running = (st === 'running' || st === 'paused') && !c.held;
    const home = c.joints.every((v, i) => Math.abs(v - c.robot.home[i]) < 0.5);
    const val = {
      ready, servoOn: c.servo, running, held: c.held, alarm: c.alarms.length > 0,
      remote: c.mode === 'REMOTE', teach: c.mode === 'TEACH', auto: c.autoMode, home,
      moving: c.segs.length > 0 || !!c.jog, done: this._done,
      pgnoReq: ready && !running && !c.held, pgnoAck: c.simMs < this._ack, pgnoErr: this._err,
      estopOk: !c.estopActive, estopActive: c.estopActive, fenceOk: !c.safety.fenceOpen,
    };
    for (const s of this.outputs) {
      const v = !!val[s.kind];
      if (c.getDO(s.n) !== v) c.setDO(s.n, v);
    }
  }

  snapshot() {
    const c = this.ctrl;
    return {
      enabled: this.enabled, preset: this.preset, presetName: this.def.name, note: this.def.note, pgno: this.def.pgno,
      diBase: this.diBase, doBase: this.doBase, programs: this.programs, lastPgno: this.lastPgno,
      inputs: this.inputs.map((s) => ({ key: s.key, kind: s.kind, name: s.name, n: s.n, activeLow: s.activeLow, raw: c.getDI(s.n), active: this.enabled ? this._val(s) : false })),
      outputs: this.outputs.map((s) => ({ key: s.key, kind: s.kind, name: s.name, n: s.n, on: c.getDO(s.n) })),
    };
  }

  serialize() {
    return { enabled: this.enabled, preset: this.preset, diBase: this.diBase, doBase: this.doBase, assign: this.assign, logic: this.logic, programs: this.programs };
  }

  static presetList() { return Object.entries(PRESETS).map(([id, p]) => ({ id, name: p.name, note: p.note })); }
}
