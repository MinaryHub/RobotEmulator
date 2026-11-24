// 제조사 통신 인터페이스 일괄 기동
//  config = {
//    yaskawaHse:   { port: 10040, filePort: 10041 },
//    kawasakiAs:   { port: 23, fallbackPort: 10023 },
//    hyundai:      { port: 8888 },
//    abbRws:       { port: 8080 },
//    kukaVarProxy: { port: 7000 },
//    urDashboard:  { port: 29999 },
//    modbus:       { port: 502, fallbackPort: 1502 },   ← 산업용 필드버스 (제조사 무관)
//    opcua:        { port: 4840 },
//  }  각 항목은 enabled:false 로 비활성화, host 로 바인딩 주소 지정 가능.
//  필드버스(modbus/opcua)는 optional: config 에 해당 키가 있을 때만 기동한다
//  (server/index.js loadConfig 기본값에 포함되어 있으므로 서버 실행 시에는 항상 기동).
//  OPC UA 는 초기화(노드셋 로드/인증서 생성)에 수 초가 걸리므로 목록의 마지막에 둔다.
// 모든 프로토콜은 현재 선택된 제조사와 관계없이 응답한다 (현재 로봇 데이터를 사용). vendor 필드로 "주" 제조사를 표시.
import * as yaskawa from './yaskawa-hse.js';
import * as kawasaki from './kawasaki-as.js';
import * as hyundai from './hyundai-openapi.js';
import * as abb from './abb-rws.js';
import * as kuka from './kuka-varproxy.js';
import * as urDash from './ur-dashboard.js';
import * as modbus from './modbus-tcp.js';
import * as opcua from './opcua.js';
import { TrafficMonitor } from './traffic.js';

export { TrafficMonitor };

export const PROTOCOLS = [
  { key: 'yaskawaHse', mod: yaskawa, vendor: 'yaskawa', defaults: { port: 10040, filePort: 10041 } },
  { key: 'kawasakiAs', mod: kawasaki, vendor: 'kawasaki', defaults: { port: 23, fallbackPort: 10023 } },
  { key: 'hyundai', mod: hyundai, vendor: 'hyundai', defaults: { port: 8888 } },
  { key: 'abbRws', mod: abb, vendor: 'abb', defaults: { port: 8080 } },
  { key: 'kukaVarProxy', mod: kuka, vendor: 'kuka', defaults: { port: 7000 } },
  { key: 'urDashboard', mod: urDash, vendor: 'ur', defaults: { port: 29999 } },
  { key: 'modbus', mod: modbus, vendor: null, optional: true, defaults: { port: 502, fallbackPort: 1502 } },
  { key: 'opcua', mod: opcua, vendor: null, optional: true, defaults: { port: 4840 } },
];

// 통신 모듈에 넘기는 컨트롤러 뷰: 운전 관련 명령에 출처 'ext'(외부)를 붙여 모드 인터록·안전 판정을 받게 한다.
//  ctrl.allow(op) / ctrl.checkCommand(op) 도 기본 출처가 'ext' → 각 프로토콜이 자체 오류 형식으로 거부 사유를 응답할 수 있음.
export function externalView(ctrl) {
  const wrap = {
    start: (o = {}) => ctrl.start({ ...o, source: 'ext' }),
    setServo: (on) => ctrl.setServo(on, on ? 'ext' : 'internal'),
    resume: () => ctrl.resume('ext'),
    setMode: (m) => ctrl.setMode(m, 'ext'),
    move: (cmd) => ctrl.move({ ...cmd, source: 'ext' }),
    allow: (op, src = 'ext') => ctrl.allow(op, src),
    checkCommand: (op, src = 'ext') => ctrl.checkCommand(op, src),
  };
  return new Proxy(ctrl, {
    get(t, k) {
      if (Object.prototype.hasOwnProperty.call(wrap, k)) return wrap[k];
      const v = Reflect.get(t, k, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t, k, v) { return Reflect.set(t, k, v, t); },
  });
}

const DISPLAY_NAME = {
  yaskawaHse: { name: 'Yaskawa HSE (UDP)', proto: 'UDP' },
  kawasakiAs: { name: 'Kawasaki AS 터미널', proto: 'TCP' },
  hyundai: { name: 'Hyundai Hi6 Open API', proto: 'HTTP' },
  abbRws: { name: 'ABB RWS', proto: 'HTTP' },
  kukaVarProxy: { name: 'KukaVarProxy / OpenShowVar', proto: 'TCP' },
  urDashboard: { name: 'UR Dashboard', proto: 'TCP' },
  modbus: { name: 'Modbus TCP', proto: 'TCP' },
  opcua: { name: 'OPC UA', proto: 'TCP' },
};

export async function startAll(ctrl0, config = {}) {
  if (!ctrl0.traffic) ctrl0.traffic = new TrafficMonitor(ctrl0);
  const ctrl = externalView(ctrl0);
  const out = [];
  for (const p of PROTOCOLS) {
    if (p.optional && !config[p.key]) continue;
    const cfg = { ...p.defaults, ...(config[p.key] || {}) };
    if (cfg.enabled === false) continue;
    try {
      const h = await p.mod.start(ctrl, cfg);
      out.push({ key: p.key, vendor: p.vendor, ...h, close: h.close });
    } catch (e) {
      ctrl.log('comm', `[${p.key}] 기동 실패: ${e.message}`);
      out.push({ key: p.key, vendor: p.vendor, name: p.key, proto: '?', port: null, error: e.message, close() {} });
    }
  }
  return out;
}

export async function closeAll(list) {
  for (const h of list || []) { try { await h.close(); } catch {} }
}

// 프로토콜 수명 주기 관리자:
//  - mode='vendor'(기본): 현재 선택된 제조사 프로토콜 + 공용 필드버스(Modbus/OPC UA)만 포트 바인딩 (포트 충돌 방지)
//  - mode='all': 설정된 모든 제조사 프로토콜 동시 오픈 (교차 테스트용)
export class ProtocolManager {
  constructor(ctrl0, config = {}, { mode = 'vendor', onChange = null } = {}) {
    if (!ctrl0.traffic) ctrl0.traffic = new TrafficMonitor(ctrl0);
    this.ctrl0 = ctrl0;
    this.ctrl = externalView(ctrl0);
    this.config = config || {};
    this.mode = mode === 'all' ? 'all' : 'vendor';
    this.onChange = onChange;
    this.running = new Map(); // key → handle
    this._queue = Promise.resolve();
    this._closed = false;
    this._lastVendor = ctrl0.vendor;
    this._onRobot = () => {
      if (this._closed || this.mode !== 'vendor') return;
      if (this.ctrl0.vendor === this._lastVendor) return;
      this._lastVendor = this.ctrl0.vendor;
      this.sync().catch(() => {});
    };
    ctrl0.on('robot', this._onRobot);
  }

  _configured(p) {
    if (p.optional && !this.config[p.key]) return null;
    const cfg = { ...p.defaults, ...(this.config[p.key] || {}) };
    if (cfg.enabled === false) return null;
    return cfg;
  }

  _shouldRun(p) {
    if (!this._configured(p)) return false;
    if (this.mode === 'all') return true;
    return p.vendor === null || p.vendor === this.ctrl0.vendor;
  }

  list() {
    const out = [];
    for (const p of PROTOCOLS) {
      const cfg = this._configured(p);
      if (!cfg) continue;
      const h = this.running.get(p.key);
      if (h) {
        out.push({ key: p.key, vendor: p.vendor, name: h.name, proto: h.proto, port: h.port, active: true, standby: false, error: h.error });
      } else {
        const meta = DISPLAY_NAME[p.key] || { name: p.key, proto: '?' };
        out.push({ key: p.key, vendor: p.vendor, name: meta.name, proto: meta.proto, port: null, configuredPort: cfg.port, active: false, standby: true });
      }
    }
    return out;
  }

  sync() {
    this._queue = this._queue.then(() => this._syncNow());
    return this._queue;
  }

  async _syncNow() {
    if (this._closed) return this.list();
    this._lastVendor = this.ctrl0.vendor;
    // 1) 중지 대상 먼저 닫아 포트 반환
    for (const p of PROTOCOLS) {
      if (this.running.has(p.key) && !this._shouldRun(p)) {
        const h = this.running.get(p.key);
        this.running.delete(p.key);
        try { await h.close?.(); } catch {}
      }
    }
    // 2) 기동 대상 시작
    for (const p of PROTOCOLS) {
      if (this.running.has(p.key) || !this._shouldRun(p)) continue;
      const cfg = this._configured(p);
      if (!cfg) continue;
      try {
        const h = await p.mod.start(this.ctrl, cfg);
        this.running.set(p.key, { key: p.key, vendor: p.vendor, ...h, close: h.close });
      } catch (e) {
        this.ctrl.log('comm', `[${p.key}] 기동 실패: ${e.message}`);
        this.running.set(p.key, { key: p.key, vendor: p.vendor, name: DISPLAY_NAME[p.key]?.name || p.key, proto: DISPLAY_NAME[p.key]?.proto || '?', port: null, error: e.message, close() {} });
      }
    }
    const items = this.list();
    this.onChange?.(items, this.mode);
    return items;
  }

  async setMode(mode) {
    const next = mode === 'all' ? 'all' : 'vendor';
    if (next === this.mode) return this.list();
    this.mode = next;
    this.ctrl0.log('comm', `프로토콜 모드 전환: ${next === 'vendor' ? '선택 제조사만 활성화' : '모든 제조사 동시 오픈'}`);
    return this.sync();
  }

  async closeAll() {
    this._closed = true;
    this.ctrl0.off('robot', this._onRobot);
    const list = [...this.running.values()];
    this.running.clear();
    await closeAll(list);
  }
}
