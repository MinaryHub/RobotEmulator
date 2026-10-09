// 하단 패널: 신호 타임라인(로직 애널라이저) + 변수 감시
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

export function initDebugPanels({ cmd }) {
  const tl = { events: [], now: 0, current: {}, marks: [], hover: null };
  let active = 'pLog';

  // ---- 탭
  $$('#ftabs button').forEach((b) => (b.onclick = () => {
    active = b.dataset.p;
    $$('#ftabs button').forEach((x) => x.classList.toggle('active', x === b));
    $$('footer .fpanel').forEach((p) => p.classList.toggle('active', p.id === active));
    $('.logopts').classList.toggle('hidden', active !== 'pLog');
    $('#btnClearLog').textContent = active === 'pVar' ? '새로고침' : '지우기';
    if (active === 'pTl') { loadTimeline(); draw(); }
    if (active === 'pVar') refreshVars();
  }));
  $('#btnClearLog').addEventListener('click', (e) => {
    if (active === 'pTl') { e.stopImmediatePropagation(); cmd('timelineClear'); tl.events = []; tl.marks = []; draw(); }
    else if (active === 'pVar') { e.stopImmediatePropagation(); refreshVars(); }
  }, true);

  // ---- 타임라인
  const cv = $('#tlCanvas');
  const ctx = cv.getContext('2d');
  async function loadTimeline() {
    const r = await cmd('timeline');
    Object.assign(tl, r.timeline);
  }
  function addEvents(events, now) {
    for (const e of events) { tl.events.push(e); tl.current[e.s] = e.v; }
    if (tl.events.length > 20000) tl.events.splice(0, tl.events.length - 20000);
    tl.now = Math.max(tl.now, now ?? 0);
  }

  const sigOrder = (s) => {
    const m = /^(DO|DI)(\d+)$/.exec(s);
    if (m) return (m[1] === 'DO' ? 1000 : 2000) + Number(m[2]);
    return ['RUN', 'MOVING', 'HOLD', 'GRIP', 'ALARM', 'COLLISION'].indexOf(s);
  };
  function selectedSignals() {
    const txt = $('#tlSigs').value.trim();
    if (!txt) {
      // 자동: 한 번이라도 기록된 신호 (상태 신호 + IO)
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

  function valueAt(sig, t, idxCache) {
    // t 이전 마지막 이벤트 값 (없으면 false)
    let v = false;
    for (const e of idxCache[sig] || []) { if (e.t <= t) v = e.v; else break; }
    return v;
  }

  function draw() {
    if (active !== 'pTl') return;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0f1215'; ctx.fillRect(0, 0, W, H);
    const win = Number($('#tlWin').value);
    const t1 = tl.now, t0 = t1 - win;
    const L = 86, R = 10, top = 4;
    const sigs = selectedSignals();
    const rowH = Math.max(14, Math.min(22, (H - top - 18) / Math.max(1, sigs.length)));
    const X = (t) => L + ((t - t0) / win) * (W - L - R);
    const bySig = {};
    for (const e of tl.events) (bySig[e.s] ||= []).push(e);
    // 시간 눈금
    ctx.font = '10px Consolas, monospace';
    const step = win <= 5000 ? 500 : win <= 10000 ? 1000 : win <= 30000 ? 5000 : 10000;
    ctx.strokeStyle = '#1f252d'; ctx.fillStyle = '#4d5866';
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      const x = X(t);
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, H - 14); ctx.stroke();
      ctx.fillText(`${(t / 1000).toFixed(step < 1000 ? 1 : 0)}s`, x - 10, H - 3);
    }
    sigs.forEach((s, i) => {
      const y = top + i * rowH, hi = y + 3, lo = y + rowH - 3;
      ctx.fillStyle = '#8c96a3';
      ctx.fillText(s, 6, y + rowH / 2 + 3);
      const col = s.startsWith('DO') ? '#f0a020' : s.startsWith('DI') ? '#2fbf71' : s === 'ALARM' || s === 'COLLISION' ? '#e5484d' : '#3d8bfd';
      ctx.strokeStyle = col; ctx.fillStyle = col + '33'; ctx.lineWidth = 1.5;
      let v = valueAt(s, t0, bySig);
      let x = L;
      ctx.beginPath(); ctx.moveTo(x, v ? hi : lo);
      for (const e of bySig[s] || []) {
        if (e.t <= t0) continue;
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
    if (tl.hover != null) { ctx.strokeStyle = '#ffffff55'; ctx.beginPath(); ctx.moveTo(tl.hover, top); ctx.lineTo(tl.hover, H - 14); ctx.stroke(); }
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
  new ResizeObserver(draw).observe($('#tlWrap'));

  // ---- 변수
  let prevVals = {};
  async function refreshVars() {
    const r = await cmd('vars');
    const rows = r.vars.map((v) => {
      const key = `${v.scope}|${v.name}`;
      const chg = prevVals[key] !== undefined && prevVals[key] !== v.value;
      prevVals[key] = v.value;
      return `<tr class="${chg ? 'chg' : ''}"><td>${esc(v.scope)}</td><td>${esc(v.name)}</td><td>${esc(v.type)}</td><td class="v">${esc(v.value)}</td></tr>`;
    }).join('');
    $('#varTable').innerHTML = `<table><tr><th>범위</th><th>이름</th><th>형</th><th>값</th></tr>${rows || '<tr><td colspan="4">변수 없음 (프로그램을 컴파일/실행하면 표시)</td></tr>'}</table>`;
  }
  setInterval(() => { if (active === 'pVar') refreshVars(); }, 700);

  return {
    onTimeline(m) { addEvents(m.events, $('#tlPause').checked ? null : m.now); },
    onState(st) {
      // 실행 중에는 시계를 계속 진행시켜 파형이 흐르도록
      if (!$('#tlPause').checked) { tl.now = Math.max(tl.now, st.simMs ?? tl.now); draw(); }
    },
  };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
