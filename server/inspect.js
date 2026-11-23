// 디버깅 보조: 변수 감시 목록 + 신호 타임라인 기록
import { toVendorPose } from '../shared/poseformat.js';

const r3 = (v) => (Math.abs(v) < 5e-4 ? 0 : +v.toFixed(3));

// 언어마다 다른 런타임 값을 사람이 읽을 문자열로
export function fmtValue(v, vendor, depth = 0) {
  if (v === undefined) return '(미정)';
  if (v === null) return 'null';
  if (typeof v === 'number') return String(r3(v));
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return JSON.stringify(v);
  if (depth > 2) return '…';
  if (Array.isArray(v)) {
    const s = v.slice(0, 12).map((x) => fmtValue(x, vendor, depth + 1)).join(', ');
    return `[${s}${v.length > 12 ? `, … (${v.length})` : ''}]`;
  }
  if (Array.isArray(v.p) && Array.isArray(v.R)) return `POSE(${toVendorPose(vendor, v).map(r3).join(', ')})`;
  if (Array.isArray(v.j)) return `JOINTS(${v.j.map(r3).join(', ')})`;
  if (v.kind === 'pose' && Array.isArray(v.v)) return `POSE(${v.v.map(r3).join(', ')})`;
  if (v.kind === 'joints' && Array.isArray(v.v)) return `JOINTS(${v.v.map(r3).join(', ')})`;
  const keys = Object.keys(v).filter((k) => k !== '$type');
  const body = keys.slice(0, 16).map((k) => `${k} ${fmtValue(v[k], vendor, depth + 1)}`).join(', ');
  const s = `${v.$type ? v.$type + ': ' : ''}{${body}${keys.length > 16 ? ', …' : ''}}`;
  return s.length > 300 ? s.slice(0, 297) + '…' : s;
}

const typeOf = (v) => (v === undefined ? '-' : Array.isArray(v) ? 'array' : v && typeof v === 'object' ? (v.$type || (v.R ? 'pose' : v.j || v.kind === 'joints' ? 'joints' : v.kind || 'struct')) : typeof v);

export function listVars(ctrl, limit = 400) {
  const out = [];
  const vendor = ctrl.vendor;
  const vm = ctrl.vm;
  const frame = vm?.frames?.[vm.frames.length - 1];
  if (frame) for (const [k, v] of frame.locals) if (!String(k).startsWith('$')) out.push({ scope: `로컬 (${frame.proc.name})`, name: k, type: typeOf(v), value: fmtValue(v, vendor) });
  if (vm?.globals) for (const [k, v] of vm.globals) {
    if (typeof v === 'function') continue;
    out.push({ scope: '전역', name: k, type: typeOf(v), value: fmtValue(v, vendor) });
    if (out.length >= limit) break;
  }
  for (const [k, v] of ctrl.regs) {
    out.push({ scope: '레지스터', name: k, type: typeOf(v), value: fmtValue(v, vendor) });
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

// 신호 타임라인: DO/DI 변화 + 로봇 상태(가상 신호) 를 시뮬레이션 시계(ms) 기준으로 기록
export class Timeline {
  constructor(ctrl, max = 20000) {
    this.ctrl = ctrl;
    this.max = max;
    this.events = [];
    this.listeners = new Set();
    this.last = {};
    ctrl.on('io', (e) => this.push(e.type.toUpperCase() + e.n, e.v));
    ctrl.on('state', () => this.sampleStatus());
  }
  push(sig, v) {
    v = !!v;
    if (this.last[sig] === v) return;
    this.last[sig] = v;
    const e = { t: Math.round(this.ctrl.simMs), s: sig, v };
    this.events.push(e);
    if (this.events.length > this.max + 2000) this.events = this.events.slice(-this.max);
    for (const l of this.listeners) l(e);
  }
  sampleStatus() {
    const c = this.ctrl;
    this.push('MOVING', c.segs.length > 0 || !!c.jog);
    this.push('RUN', c.vm?.status === 'running' && !c.held);
    this.push('HOLD', c.held || c.vm?.status === 'paused');
    this.push('ALARM', c.alarms.length > 0);
    this.push('GRIP', !!c.grip?.closed);
    this.push('COLLISION', !!c.collision?.hit);
  }
  snapshot() {
    // 현재 값도 함께 (타임라인 시작 이전 상태 표시용)
    return { now: Math.round(this.ctrl.simMs), events: this.events.slice(-5000), current: { ...this.last } };
  }
  toCSV(ioLabels = {}) {
    const esc = (s) => { const t = String(s ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const lines = ['sim_ms,sim_sec,signal,label,value'];
    for (const e of this.events) {
      const m = /^(DI|DO)(\d+)$/.exec(e.s);
      const lbl = m ? (ioLabels[m[1].toLowerCase()]?.[m[2]]?.name || '') : '';
      lines.push(`${e.t},${(e.t / 1000).toFixed(3)},${esc(e.s)},${esc(lbl)},${e.v ? 1 : 0}`);
    }
    return lines.join('\n') + '\n';
  }
  clear() { this.events = []; }
}
