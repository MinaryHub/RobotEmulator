// I/O 이름 표시 공용 함수 — 시스템 I/O 신호 이름 > 사용자 이름표 > 로봇 언어 신호 이름 순으로 사용
// type: 'do' | 'di'
export function ioLabelMap(st, type) {
  const out = {};
  const lang = st?.io?.names?.[type] || {};
  for (const [n, nm] of Object.entries(lang)) if (nm) out[n] = { name: String(nm), desc: '', src: 'lang' };
  const user = st?.ioLabels?.[type] || {};
  for (const [n, l] of Object.entries(user)) {
    if (!l) continue;
    out[n] = { name: l.name || out[n]?.name || '', desc: l.desc || '', src: 'user', user: l };
  }
  const sys = st?.sysio;
  if (sys?.enabled) {
    const list = type === 'do' ? sys.outputs : sys.inputs;
    for (const s of list || []) {
      const prev = out[s.n];
      out[s.n] = { name: s.name, desc: prev?.desc || '', src: 'sys', user: prev?.user, other: prev?.name };
    }
  }
  return out;
}

export const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// CSV (type,n,name,desc) — Excel 호환: UTF-8 BOM, 따옴표 이스케이프
const csvCell = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function labelsToCsv(labels) {
  const rows = [['type', 'n', 'name', 'desc']];
  for (const t of ['do', 'di']) {
    for (const [n, l] of Object.entries(labels?.[t] || {}).sort((a, b) => a[0] - b[0])) rows.push([t.toUpperCase(), n, l.name ?? '', l.desc ?? '']);
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}
// CSV → { do:{}, di:{} } (헤더 행은 자동 건너뜀). 잘못된 행 수를 함께 반환
export function csvToLabels(text) {
  const labels = { do: {}, di: {} };
  let bad = 0, count = 0;
  for (const r of parseCsv(text)) {
    const t = String(r[0] ?? '').trim().toLowerCase();
    if (t === 'type') continue;
    const n = Number(String(r[1] ?? '').trim());
    if ((t !== 'do' && t !== 'di') || !Number.isInteger(n) || n < 1 || n > 512) { bad++; continue; }
    const name = String(r[2] ?? '').trim(), desc = String(r[3] ?? '').trim();
    if (!name && !desc) continue;
    labels[t][n] = { name, desc };
    count++;
  }
  return { labels, count, bad };
}
