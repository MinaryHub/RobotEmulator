// 하단 패널: 신호 타임라인(로직 애널라이저) + 변수 감시 + 통신 모니터(P0-4)
import { ioLabelMap } from './ioLabels.js';
import { t } from './i18n.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// 정렬된 배열에서 t 이하 마지막 인덱스 (이진 탐색)
function lastIdxLe(arr, time) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= time) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

export function initDebugPanels({ cmd, isConnected = () => true }) {
  const tl = { events: [], bySig: Object.create(null), now: 0, current: {}, marks: [], hover: null };
  let active = 'pLog';
  let lastSt = null;

  // ---- 탭
  $$('#ftabs button').forEach((b) => (b.onclick = () => {
    active = b.dataset.p;
    $$('#ftabs button').forEach((x) => x.classList.toggle('active', x === b));
    $$('footer .fpanel').forEach((p) => p.classList.toggle('active', p.id === active));
    $('.logopts').classList.toggle('hidden', active !== 'pLog');
    $('#btnClearLog').textContent = active === 'pVar' ? '새로고침' : '지우기';
    if (active === 'pTl') { loadTimeline(); draw(); }
    if (active === 'pVar') refreshVars();
    if (active === 'pTraffic') loadTraffic();
  }));
  $('#btnClearLog').addEventListener('click', (e) => {
    if (active === 'pTl') {
      e.stopImmediatePropagation();
      cmd('timelineClear').catch(() => {});
      tl.events = []; tl.bySig = Object.create(null); tl.marks = [];
      draw();
    } else if (active === 'pVar') {
      e.stopImmediatePropagation();
      refreshVars();
    } else if (active === 'pTraffic') {
      e.stopImmediatePropagation();
      cmd('trafficClear').catch(() => {});
      trEntries = [];
      renderTraffic();
    }
  }, true);

  // ---- 타임라인
  const cv = $('#tlCanvas');
  const ctx = cv.getContext('2d');
  function rebuildBySig() {
    const map = Object.create(null);
    for (const e of tl.events) (map[e.s] ||= []).push(e);
    tl.bySig = map;
  }
  async function loadTimeline() {
    if (!isConnected()) return;
    const r = await cmd('timeline').catch(() => null);
    if (!r?.timeline) return;
    tl.events = r.timeline.events || [];
    tl.now = r.timeline.now ?? 0;
    tl.current = r.timeline.current || {};
    rebuildBySig();
    draw();
  }
  function addEvents(events, now) {
    for (const e of events) {
      tl.events.push(e);
      (tl.bySig[e.s] ||= []).push(e);
      tl.current[e.s] = e.v;
    }
    if (tl.events.length > 22000) {
      tl.events = tl.events.slice(-20000);
      rebuildBySig();
    }
    if (now != null) tl.now = Math.max(tl.now, now);
    if (active === 'pTl') draw();
  }

  const sigOrder = (s) => {
    const m = /^(DO|DI)(\d+)$/.exec(s);
    if (m) return (m[1] === 'DO' ? 1000 : 2000) + Number(m[2]);
    return ['RUN', 'MOVING', 'HOLD', 'GRIP', 'ALARM', 'COLLISION'].indexOf(s);
  };
  function selectedSignals() {
    const txt = $('#tlSigs').value.trim();
    if (!txt) {
      const set = new Set(Object.keys(tl.current));
      return [...set].sort((a, b) => sigOrder(a) - sigOrder(b)).slice(0, 24);
    }
    const out = [];
    for (const part of txt.split(/[,\s]+/).filter(Boolean)) {
      const m = /^(DO|DI)(\d+)(?:-(\d+))?$/i.exec(part);
      if (m) { for (let n = Number(m[2]); n <= Number(m[3] ?? m[2]); n++) out.push(m[1].toUpperCase() + n); }
      else out.push(part.toUpperCase());
    }
    return out.slice(0, 40);
  }

  // 그리기는 화면 프레임당 한 번으로 묶고, 비활성 탭에서는 예약하지 않음
  let drawQueued = false;
  function draw() {
    if (active !== 'pTl' || drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; drawNow(); });
  }
  function drawNow() {
    if (active !== 'pTl') return;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const light = document.documentElement.dataset.theme === 'light';
    ctx.fillStyle = light ? '#f4f6f9' : '#0f1215';
    ctx.fillRect(0, 0, W, H);
    const win = Number($('#tlWin').value);
    const t1 = tl.now, t0 = t1 - win;
    const sigs = selectedSignals();
    // 트랙 이름: DO7 → 'DO7 CLAMP' (시스템 I/O 신호 이름 > 사용자 이름표 > 프로그램 신호 이름)
    const lbl = { do: ioLabelMap(lastSt, 'do'), di: ioLabelMap(lastSt, 'di') };
    const names = sigs.map((s) => {
      const m = /^(DO|DI)(\d+)$/.exec(s);
      const l = m && lbl[m[1].toLowerCase()][m[2]];
      return l?.name ? `${s} ${l.name}` : s;
    });
    ctx.font = '10px Consolas, monospace';
    const L = Math.min(170, Math.max(86, ...names.map((n) => ctx.measureText(n).width + 14))), R = 10, top = 4;
    const rowH = Math.max(14, Math.min(22, (H - top - 18) / Math.max(1, sigs.length)));
    const X = (time) => L + ((time - t0) / win) * (W - L - R);
    // 시간 눈금
    const step = win <= 5000 ? 500 : win <= 10000 ? 1000 : win <= 30000 ? 5000 : 10000;
    ctx.strokeStyle = light ? '#d5dce4' : '#1f252d';
    ctx.fillStyle = light ? '#5d6875' : '#4d5866';
    for (let tm = Math.ceil(t0 / step) * step; tm <= t1; tm += step) {
      const x = X(tm);
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, H - 14); ctx.stroke();
      ctx.fillText(`${(tm / 1000).toFixed(step < 1000 ? 1 : 0)}s`, x - 10, H - 3);
    }
    sigs.forEach((s, i) => {
      const y = top + i * rowH, hi = y + 3, lo = y + rowH - 3;
      ctx.fillStyle = light ? '#343c46' : '#8c96a3';
      ctx.fillText(t(names[i]), 6, y + rowH / 2 + 3, L - 10);
      const col = s.startsWith('DO') ? '#f0a020' : s.startsWith('DI') ? '#2fbf71' : s === 'ALARM' || s === 'COLLISION' ? '#e5484d' : '#3d8bfd';
      ctx.strokeStyle = col; ctx.fillStyle = col + '33'; ctx.lineWidth = 1.5;
      const arr = tl.bySig[s] || [];
      const startIdx = lastIdxLe(arr, t0);
      let v = startIdx >= 0 ? arr[startIdx].v : false;
      let x = L;
      ctx.beginPath(); ctx.moveTo(x, v ? hi : lo);
      for (let k = startIdx + 1; k < arr.length; k++) {
        const e = arr[k];
        if (e.t > t1) break;
        const xe = X(e.t);
        if (v) ctx.fillRect(x, hi, xe - x, lo - hi);
        ctx.lineTo(xe, v ? hi : lo); ctx.lineTo(xe, e.v ? hi : lo);
        x = xe; v = e.v;
      }
      if (v) ctx.fillRect(x, hi, W - R - x, lo - hi);
      ctx.lineTo(W - R, v ? hi : lo); ctx.stroke();
    });
    // 측정 마커
    ctx.strokeStyle = '#ffd36b'; ctx.lineWidth = 1;
    for (const m of tl.marks) { const x = X(m); if (x >= L) { ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, H - 14); ctx.stroke(); ctx.setLineDash([]); } }
    if (tl.hover != null && tl.hover >= L && tl.hover <= W - R) {
      ctx.strokeStyle = light ? '#00000044' : '#ffffff55';
      ctx.beginPath(); ctx.moveTo(tl.hover, top); ctx.lineTo(tl.hover, H - 14); ctx.stroke();
      const ht = t0 + ((tl.hover - L) / (W - L - R)) * win;
      const label = `${(ht / 1000).toFixed(3)}s`;
      const tw = ctx.measureText(label).width + 8;
      const bx = Math.min(W - R - tw, Math.max(L, tl.hover + 4));
      ctx.fillStyle = light ? 'rgba(255,255,255,0.9)' : 'rgba(15,18,21,0.9)';
      ctx.fillRect(bx, top, tw, 14);
      ctx.fillStyle = light ? '#111' : '#ffd36b';
      ctx.fillText(label, bx + 4, top + 10);
    }
    tl.geom = { L, R, W, t0, win };
  }
  const tAt = (px) => { const g = tl.geom; return g.t0 + ((px - g.L) / (g.W - g.L - g.R)) * g.win; };
  cv.addEventListener('mousemove', (e) => { tl.hover = e.offsetX; draw(); });
  cv.addEventListener('mouseleave', () => { tl.hover = null; draw(); });
  cv.addEventListener('click', (e) => {
    if (!tl.geom || e.offsetX < tl.geom.L) return;
    $('#tlPause').checked = true;
    tl.marks.push(tAt(e.offsetX));
    if (tl.marks.length > 2) tl.marks = tl.marks.slice(-1);
    $('#tlMeas').textContent = tl.marks.length === 2
      ? `Δt = ${Math.abs(tl.marks[1] - tl.marks[0]).toFixed(0)} ms  (${(tl.marks[0] / 1000).toFixed(3)}s → ${(tl.marks[1] / 1000).toFixed(3)}s)`
      : `기준 ${(tl.marks[0] / 1000).toFixed(3)}s — 한 번 더 클릭`;
    draw();
  });
  $('#tlWin').onchange = draw;
  $('#tlSigs').oninput = draw;
  $('#tlPause').onchange = () => { if (!$('#tlPause').checked) { tl.marks = []; $('#tlMeas').textContent = '클릭 2번: 두 시점 간격 측정'; } };
  const tlCsv = $('#tlCsv');
  if (tlCsv) tlCsv.onclick = () => { location.href = '/api/timeline.csv'; };
  new ResizeObserver(draw).observe($('#tlWrap'));

  // ---- 변수
  let prevVals = {};
  let lastVarSig = '';
  let lastVars = [];
  function renderVars(vars) {
    const q = ($('#varSearch')?.value || '').trim().toLowerCase();
    const filtered = q ? vars.filter((v) => `${v.scope} ${v.name} ${v.type} ${v.value}`.toLowerCase().includes(q)) : vars;
    const sig = q + '\n' + filtered.map((v) => `${v.scope}|${v.name}|${v.type}|${v.value}`).join('\n');
    if (sig === lastVarSig) return;
    lastVarSig = sig;
    const rows = filtered.map((v) => {
      const key = `${v.scope}|${v.name}`;
      const chg = prevVals[key] !== undefined && prevVals[key] !== v.value;
      prevVals[key] = v.value;
      return `<tr class="${chg ? 'chg' : ''}"><td>${esc(v.scope)}</td><td>${esc(v.name)}</td><td>${esc(v.type)}</td><td class="v">${esc(v.value)}</td></tr>`;
    }).join('');
    $('#varTable').innerHTML = `<table><tr><th>범위</th><th>이름</th><th>형</th><th>값</th></tr>${rows || '<tr><td colspan="4">변수 없음 (프로그램을 컴파일/실행하면 표시)</td></tr>'}</table>`;
  }
  async function refreshVars() {
    if (!isConnected()) return;
    const r = await cmd('vars').catch(() => null);
    if (!r?.vars) return;
    lastVars = r.vars;
    renderVars(lastVars);
  }
  const varSearch = $('#varSearch');
  if (varSearch) varSearch.oninput = () => renderVars(lastVars);
  setInterval(() => { if (active === 'pVar' && isConnected()) refreshVars(); }, 700);

  // ---- 통신 모니터 (P0-4)
  let trEntries = [];
  let trClients = [];
  let trQueued = false;
  function queueTrafficRender() {
    if (active !== 'pTraffic' || trQueued) return;
    trQueued = true;
    requestAnimationFrame(() => { trQueued = false; renderTraffic(); });
  }
  async function loadTraffic() {
    if (!isConnected()) return;
    const r = await cmd('traffic', { limit: 300 }).catch(() => null);
    if (!r?.traffic) return;
    trEntries = r.traffic.entries || [];
    trClients = r.traffic.clients || [];
    renderTraffic();
  }
  function renderTraffic() {
    const tbl = $('#trafficTable');
    if (!tbl) return;
    const cliEl = $('#trClients');
    if (cliEl) {
      const activeClients = trClients.filter((c) => c.active);
      cliEl.textContent = activeClients.length
        ? activeClients.map((c) => `${c.iface}(${c.client})`).join(', ')
        : '연결된 클라이언트 없음';
    }
    const iface = $('#trIface')?.value || '';
    const errOnly = !!$('#trErrOnly')?.checked;
    const q = ($('#trSearch')?.value || '').trim().toLowerCase();
    const list = [];
    for (let i = trEntries.length - 1; i >= 0 && list.length < 300; i--) {
      const e = trEntries[i];
      if (iface && e.iface !== iface) continue;
      if (errOnly && e.ok !== false) continue;
      if (q && !`${e.iface} ${e.client} ${e.summary} ${e.error || ''} ${e.raw || ''} ${e.hex || ''}`.toLowerCase().includes(q)) continue;
      list.push(e);
    }
    if (!list.length) {
      tbl.innerHTML = '<table><tr><th>시각</th><th>인터페이스</th><th>클라이언트</th><th>결과</th><th>ms</th><th>요약</th></tr><tr><td colspan="6" class="dim">수신된 통신 패킷이 없습니다</td></tr></table>';
      return;
    }
    const rows = list.map((e) => {
      const ts = new Date(e.t).toTimeString().slice(0, 8) + '.' + String(e.t % 1000).padStart(3, '0');
      const raw = [e.hex && `HEX: ${e.hex}`, e.raw && `RAW:\n${e.raw}`, e.error && `ERR: ${e.error}`].filter(Boolean).join('\n');
      return `<tr class="${e.ok === false ? 'err' : ''}" title="${esc(raw)}">
        <td class="ts">${ts}</td>
        <td><span class="tr-if">${esc(e.iface)}</span></td>
        <td class="dim">${esc(e.client)}</td>
        <td class="${e.ok === false ? 'bad' : 'ok'}">${e.ok === false ? 'ERR' : 'OK'}</td>
        <td class="ms">${e.ms != null ? e.ms.toFixed(1) : '-'}</td>
        <td class="sum">${esc(e.summary)}${e.error ? ` <span class="bad">(${esc(e.error)})</span>` : ''}${raw ? `<details class="tr-raw"><summary>HEX/RAW</summary><pre>${esc(raw)}</pre></details>` : ''}</td>
      </tr>`;
    }).join('');
    tbl.innerHTML = `<table><tr><th>시각</th><th>인터페이스</th><th>클라이언트</th><th>결과</th><th>ms</th><th>요약</th></tr>${rows}</table>`;
  }
  for (const id of ['#trIface', '#trErrOnly']) {
    const el = $(id);
    if (el) el.onchange = () => renderTraffic();
  }
  const trSearch = $('#trSearch');
  if (trSearch) trSearch.oninput = () => renderTraffic();
  const trCsv = $('#trCsv');
  if (trCsv) trCsv.onclick = () => {
    const iface = $('#trIface')?.value || '';
    const errOnly = $('#trErrOnly')?.checked ? '1' : '';
    const qs = new URLSearchParams();
    if (iface) qs.set('iface', iface);
    if (errOnly) qs.set('errorsOnly', '1');
    location.href = `/api/traffic.csv${qs.toString() ? `?${qs}` : ''}`;
  };

  return {
    onTimeline(m) { addEvents(m.events, $('#tlPause').checked ? null : m.now); },
    onTraffic(m) {
      if ($('#trPause')?.checked) return;
      if (Array.isArray(m.entries)) {
        for (const e of m.entries) trEntries.push(e);
        if (trEntries.length > 2000) trEntries = trEntries.slice(-1500);
      }
      if (Array.isArray(m.clients)) trClients = m.clients;
      queueTrafficRender();
    },
    onTrafficClear() { trEntries = []; renderTraffic(); },
    onState(st) {
      lastSt = st;
      if (!$('#tlPause').checked) {
        tl.now = Math.max(tl.now, st.simMs ?? tl.now);
        if (active === 'pTl') draw();
      }
    },
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
