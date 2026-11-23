// 통신 트래픽 모니터 · 접속 클라이언트 추적 · 통신 고장 주입 (ROADMAP-SI P0-4, P1-1, P1-5)
//  - 모든 프로토콜(Modbus TCP, Yaskawa HSE, Kawasaki AS, Hyundai Open API, ABB RWS, KUKA VarProxy, UR Dashboard, OPC UA)의
//    요청/응답 원문(텍스트 또는 헥스 덤프)과 해석 요약, 접속 클라이언트 목록을 링 버퍼에 기록한다.
import { EventEmitter } from 'node:events';

const MAX_ENTRIES = 2000;
const MAX_CLIENTS = 200;

export function hexOf(buf, maxBytes = 64) {
  if (!buf) return '';
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const n = Math.min(b.length, maxBytes);
  let out = '';
  for (let i = 0; i < n; i++) {
    if (i) out += ' ';
    out += b[i].toString(16).padStart(2, '0').toUpperCase();
  }
  if (b.length > maxBytes) out += ` …(+${b.length - maxBytes}B)`;
  return out;
}

export function peerOf(sockOrReq) {
  if (!sockOrReq) return 'unknown';
  if (typeof sockOrReq === 'string') return sockOrReq;
  const s = sockOrReq.socket || sockOrReq;
  const addr = s.remoteAddress || sockOrReq.address || '';
  const port = s.remotePort || sockOrReq.port || '';
  const clean = String(addr).replace(/^::ffff:/, '');
  return port ? `${clean}:${port}` : (clean || 'unknown');
}

export class TrafficMonitor extends EventEmitter {
  constructor(ctrl, max = MAX_ENTRIES) {
    super();
    this.ctrl = ctrl;
    this.max = max;
    this._buf = new Array(max);
    this._head = 0;
    this._size = 0;
    this._seq = 0;
    this.clients = new Map(); // `${iface}|${client}` -> info
    this.stats = { total: 0, errors: 0, dropped: 0 };
  }

  _clientKey(iface, client) { return `${iface}|${client}`; }

  _ensureClient(iface, client, active = false) {
    const k = this._clientKey(iface, client);
    let c = this.clients.get(k);
    const now = Date.now();
    if (!c) {
      if (this.clients.size >= MAX_CLIENTS) {
        // 비활성 클라이언트 중 가장 오래된 항목 제거
        let oldest = null;
        for (const [ck, cv] of this.clients) {
          if (!cv.active && (!oldest || cv.lastSeenAt < oldest.v.lastSeenAt)) oldest = { k: ck, v: cv };
        }
        if (oldest) this.clients.delete(oldest.k);
      }
      c = { id: k, iface, client, connectedAt: now, lastSeenAt: now, reqCount: 0, errCount: 0, active };
      this.clients.set(k, c);
    } else {
      c.lastSeenAt = now;
      if (active) c.active = true;
    }
    return c;
  }

  connect(iface, client) {
    const c = this._ensureClient(iface, client, true);
    c.connectedAt = Date.now();
    c.active = true;
    this.emit('client', c);
  }

  disconnect(iface, client) {
    const k = this._clientKey(iface, client);
    const c = this.clients.get(k);
    if (c) { c.active = false; c.lastSeenAt = Date.now(); this.emit('client', c); }
  }

  record(iface, { client = 'unknown', dir = 'req', summary = '', raw = '', hex = '', ok = true, error = null, ms = null } = {}) {
    const now = Date.now();
    const c = this._ensureClient(iface, client, false);
    if (dir === 'req' || dir === 'tx') c.reqCount++;
    if (!ok) { c.errCount++; this.stats.errors++; }
    this.stats.total++;
    const entry = {
      seq: ++this._seq,
      t: now,
      iface,
      client,
      dir,
      summary: String(summary).slice(0, 240),
      raw: raw ? String(raw).slice(0, 400) : '',
      hex: hex ? String(hex).slice(0, 260) : '',
      ok: !!ok,
      error: error ? String(error).slice(0, 160) : null,
      ms: ms != null ? +Number(ms).toFixed(1) : null,
    };
    this._buf[this._head] = entry;
    this._head = (this._head + 1) % this.max;
    if (this._size < this.max) this._size++;
    this.emit('entry', entry);
    return entry;
  }

  // 통신 고장 주입(지연/패킷 손실): true 반환 시 요청을 드롭(무응답)해야 함
  async applyFault(iface, client = 'unknown', summary = '') {
    const f = this.ctrl?.faults;
    if (!f) return false;
    if (f.commLatencyMs > 0) await new Promise((r) => setTimeout(r, f.commLatencyMs));
    if (f.commDropPct > 0 && Math.random() * 100 < f.commDropPct) {
      this.stats.dropped++;
      this.record(iface, { client, dir: 'req', summary: `[DROP] ${summary}`, ok: false, error: `고장 주입 패킷 손실 (${f.commDropPct}%)` });
      return true;
    }
    return false;
  }

  listEntries({ limit = 200, iface = '', errorsOnly = false, search = '' } = {}) {
    const out = [];
    const lim = Math.max(1, Math.min(this.max, Number(limit) || 200));
    const q = String(search || '').trim().toLowerCase();
    for (let i = 0; i < this._size && out.length < lim; i++) {
      const idx = (this._head - 1 - i + this.max) % this.max;
      const e = this._buf[idx];
      if (!e) continue;
      if (iface && e.iface !== iface) continue;
      if (errorsOnly && e.ok) continue;
      if (q && !(e.summary.toLowerCase().includes(q) || e.client.toLowerCase().includes(q) || e.raw.toLowerCase().includes(q) || e.hex.toLowerCase().includes(q) || (e.error || '').toLowerCase().includes(q))) continue;
      out.push(e);
    }
    return out.reverse();
  }

  listClients() {
    return [...this.clients.values()].sort((a, b) => (b.active - a.active) || (b.lastSeenAt - a.lastSeenAt));
  }

  snapshot(opts = {}) {
    return {
      entries: this.listEntries(opts),
      clients: this.listClients(),
      stats: { ...this.stats, buffered: this._size },
    };
  }

  toCSV() {
    const esc = (s) => { const t = String(s ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const lines = ['seq,timestamp,interface,client,dir,ok,ms,summary,error,raw,hex'];
    for (const e of this.listEntries({ limit: this.max })) {
      lines.push([e.seq, new Date(e.t).toISOString(), esc(e.iface), esc(e.client), e.dir, e.ok ? 1 : 0, e.ms ?? '', esc(e.summary), esc(e.error || ''), esc(e.raw), esc(e.hex)].join(','));
    }
    return lines.join('\n') + '\n';
  }

  clear() {
    this._buf = new Array(this.max);
    this._head = 0;
    this._size = 0;
    this.stats = { total: 0, errors: 0, dropped: 0 };
    this.emit('clear');
  }
}
