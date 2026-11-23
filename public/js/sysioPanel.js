// 시스템 I/O 탭 — PLC ↔ 로봇 전용 신호(서보 ON·시작·홀드·프로그램 번호 …) 할당·논리·상태 표시와 입력 시뮬레이션
// 서버: server/sysio.js (cmd 'sysio' { op:'presets' | 'set', config })
import { escHtml as esc } from './ioLabels.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const EDGE = new Set(['servoOn', 'start', 'startMain', 'stop', 'alarmReset', 'pgnoStrobe']);
const KIND_DESC = {
  servoOn: '상승 에지 → 서보 ON', servoOff: '레벨 → 서보 OFF', start: '상승 에지 → 시작/재개', startMain: '상승 에지 → 처음부터 시작',
  hold: '레벨 → 홀드', stop: '상승 에지 → 프로그램 정지', alarmReset: '상승 에지 → 알람 리셋', estop: '레벨 → 비상정지',
  fence: '레벨 → 안전 펜스 (기능 활성 = 펜스 열림)', enable: '레벨 → 인에이블 스위치', pgnoParity: '프로그램 번호 패리티 비트',
  pgnoStrobe: '상승 에지 → 프로그램 번호 확정·선택',
  ready: '외부 운전 준비 (REMOTE·서보 ON·알람 없음)', running: '프로그램 실행 중 (홀드 아님)', held: '홀드 중', alarm: '알람 발생',
  remote: 'REMOTE 모드', teach: 'TEACH 모드', auto: '자동 운전 모드 (PLAY/REMOTE)', home: '홈 자세 (±0.5°)', moving: '로봇 이동 중',
  done: '프로그램 정상 종료 (다음 시작까지 유지)', pgnoReq: '프로그램 번호 요청', pgnoAck: '번호 수신 확인 펄스', pgnoErr: '번호 오류 (다음 스트로브까지 유지)',
  estopOk: '비상정지 아님', estopActive: '비상정지 중', fenceOk: '안전 펜스 닫힘',
};
const PARITY = { none: '없음', odd: '홀수', even: '짝수' };

let ctx = null;
let sig = '';
let presets = [];
let lastSysRef = null;
let lastFilesRef = null;
const pulseMap = new Map(); // diPin -> { rest, timer }

export function initSysioPanel({ cmd, getState }) {
  ctx = { cmd, getState };
  const root = $('#tSys');
  root.innerHTML = `
    <h3>시스템 I/O <small>PLC ↔ 로봇 전용 신호</small></h3>
    <div class="row sys-top">
      <label class="chk"><input type="checkbox" id="sysEn"> 사용</label>
      <select id="sysPreset" title="제조사 관례에 따른 신호 할당 프리셋"></select>
    </div>
    <div class="note" id="sysNote"></div>
    <div class="grid3 sys-base">
      <label>DI 시작 번호<input type="number" id="sysDiBase" min="1" max="480"></label>
      <label>DO 시작 번호<input type="number" id="sysDoBase" min="1" max="480"></label>
      <label>&nbsp;<button id="sysResetNo" title="개별로 바꾼 DI/DO 번호를 지우고 시작 번호부터 차례로 다시 할당">번호 초기화</button></label>
    </div>
    <div class="note sys-hint" id="sysHint"></div>
    <div id="sysBody">
      <h3>입력 <small>PLC → 로봇 · 램프 클릭: 입력 토글</small></h3>
      <table class="sys-tbl" id="sysIn"></table>
      <h3>출력 <small>로봇 → PLC</small></h3>
      <table class="sys-tbl" id="sysOut"></table>
      <h3>프로그램 번호 <small id="sysLast"></small></h3>
      <table class="sys-tbl" id="sysProg"></table>
      <div class="row btns"><button id="sysProgAdd">＋ 번호 추가</button></div>
      <div class="note">표에 없으면 파일명이 같은 숫자인 프로그램(예: <code>0001.job</code>)을 자동 선택합니다.</div>
    </div>`;

  const send = (config) => cmd('sysio', { op: 'set', config }).catch(() => {});
  const sys = () => getState()?.sysio;
  const pinsIn = () => Object.fromEntries(sys().inputs.map((s) => [s.key, s.n]));
  const pinsOut = () => Object.fromEntries(sys().outputs.map((s) => [s.key, s.n]));
  const setDI = (n, v) => cmd('setDI', { n, v: !!v }).catch(() => {});

  $('#sysEn').onchange = (e) => send({ enabled: e.target.checked });
  $('#sysPreset').onchange = (e) => send({ preset: e.target.value });
  // 시작 번호를 바꾸면 해당 방향의 개별 번호 지정은 초기화 (반대 방향은 현재 번호 유지)
  $('#sysDiBase').onchange = (e) => { const v = Math.round(Number(e.target.value)); if (v >= 1 && v <= 480) send({ diBase: v, assign: { in: {}, out: pinsOut() } }); };
  $('#sysDoBase').onchange = (e) => { const v = Math.round(Number(e.target.value)); if (v >= 1 && v <= 480) send({ doBase: v, assign: { in: pinsIn(), out: {} } }); };
  $('#sysResetNo').onclick = () => send({ assign: { in: {}, out: {} } });

  root.addEventListener('change', (e) => {
    const t = e.target;
    const s = sys();
    if (!s) return;
    if (t.matches('input.num[data-key]')) {
      const v = Math.round(Number(t.value));
      if (!(v >= 1 && v <= 512)) return;
      if (t.dataset.dir === 'out') { const out = pinsOut(); out[t.dataset.key] = v; send({ assign: { in: pinsIn(), out } }); }
      else { const inp = pinsIn(); inp[t.dataset.key] = v; send({ assign: { in: inp, out: pinsOut() } }); }
    } else if (t.matches('input.num[data-pgbase]')) {
      const v = Math.round(Number(t.value));
      if (!(v >= 1 && v <= 512)) return;
      const inp = pinsIn();
      for (const x of s.inputs) if (x.kind === 'pgnoBit') inp[x.key] = Math.min(512, v + Number(x.key.slice(4)));
      send({ assign: { in: inp, out: pinsOut() } });
    } else if (t.id === 'sysPgVal') {
      setPgno(Math.max(0, Math.round(Number(t.value)) || 0));
    } else if (t.closest('#sysProg')) {
      sendPrograms();
    }
  });
  root.addEventListener('click', (e) => {
    const t = e.target;
    const s = sys();
    if (!s) return;
    const key = t.dataset.key;
    const sg = key && s.inputs.find((x) => x.key === key);
    if (t.matches('.lamp[data-key]') && sg) setDI(sg.n, !sg.raw);
    else if (t.matches('button.lg') && sg) {
      const logic = Object.fromEntries(s.inputs.map((x) => [x.key, x.activeLow]));
      logic[key] = !sg.activeLow;
      send({ logic: { in: logic } });
    } else if (t.matches('button.pulse') && sg) {
      // 빠른 연타에도 원래 평상시 상태(rest)로 복귀
      const prev = pulseMap.get(sg.n);
      const rest = prev ? prev.rest : sg.raw;
      if (prev) clearTimeout(prev.timer);
      setDI(sg.n, !rest);
      const timer = setTimeout(() => { pulseMap.delete(sg.n); setDI(sg.n, rest); }, 150);
      pulseMap.set(sg.n, { rest, timer });
    } else if (t.matches('button.del[data-pn]')) {
      t.closest('tr').remove();
      sendPrograms();
    }
  });
  $('#sysProgAdd').onclick = () => {
    const s = sys();
    const files = getState()?.program?.files || [];
    const nums = Object.keys(s.programs).map(Number);
    const n = nums.length ? Math.max(...nums) + 1 : 1;
    send({ programs: { ...s.programs, [n]: files[0] ?? '' } });
  };

  function sendPrograms() {
    const p = {};
    for (const tr of $$('#sysProg tr[data-row]')) {
      const n = Math.round(Number($('input', tr).value));
      const f = $('select', tr).value;
      if (n > 0 && f) p[n] = f;
    }
    send({ programs: p });
  }
  function setPgno(v) {
    const s = sys();
    const bits = s.inputs.filter((x) => x.kind === 'pgnoBit');
    const max = 2 ** bits.length - 1;
    v = Math.min(v, max);
    let ones = 0;
    for (const b of bits) {
      const on = !!(v & (1 << Number(b.key.slice(4))));
      if (on) ones++;
      if (on !== b.raw) setDI(b.n, on);
    }
    const par = s.inputs.find((x) => x.kind === 'pgnoParity');
    if (par && s.pgno.parity !== 'none' && $('#sysPgPar')?.checked) {
      const want = s.pgno.parity === 'odd' ? ones % 2 === 0 : ones % 2 === 1;
      if (want !== par.raw) setDI(par.n, want);
    }
  }

}

// 프리셋 목록 (WebSocket 연결·재연결 시 호출)
export function loadSysioPresets() {
  if (!ctx) return;
  ctx.cmd('sysio', { op: 'presets' }).then((r) => {
    presets = r.presets || [];
    $('#sysPreset').innerHTML = presets.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    const st = ctx.getState();
    if (st) { sig = ''; renderSysioPanel(st); }
  }).catch(() => {});
}

function inputRows(s) {
  let html = '<tr><th>신호 이름</th><th>DI</th><th>논리</th><th>상태</th><th></th></tr>';
  const bits = s.inputs.filter((x) => x.kind === 'pgnoBit').sort((a, b) => Number(b.key.slice(4)) - Number(a.key.slice(4)));
  let pgDone = false;
  for (const x of s.inputs) {
    if (x.kind === 'pgnoBit') {
      if (pgDone) continue;
      pgDone = true;
      const lsb = bits[bits.length - 1];
      const par = s.pgno.parity !== 'none' && s.inputs.some((y) => y.kind === 'pgnoParity');
      html += `<tr class="pg"><td colspan="5">
        <div class="pg1"><span class="nm" title="${esc(bits.map((b) => `${b.name}: DI${b.n}`).join('\n'))}">프로그램 번호 비트 (${bits.length})</span>
          <span class="dim">${s.pgno.type === 'bcd' ? 'BCD' : '이진수'} · 패리티 ${PARITY[s.pgno.parity] ?? s.pgno.parity}</span>
          <label class="dim">LSB DI <input type="number" class="num" data-pgbase="1" value="${lsb.n}" min="1" max="512"></label></div>
        <div class="pg2"><span class="bits">${bits.map((b) => `<span class="lamp sm" data-key="${b.key}" data-n="${b.n}" title="${esc(b.name)} · DI${b.n}">${Number(b.key.slice(4)) + 1}</span>`).join('')}</span>
          <label class="dim">값 <input type="number" id="sysPgVal" min="0" max="${2 ** bits.length - 1}"></label>
          ${par ? '<label class="dim" title="번호를 입력하면 패리티 비트도 맞춰 설정"><input type="checkbox" id="sysPgPar" checked> 패리티 자동</label>' : ''}</div>
      </td></tr>`;
      continue;
    }
    const logic = x.kind !== 'pgnoParity';
    html += `<tr data-key="${x.key}">
      <td class="nm" title="${esc(KIND_DESC[x.kind] ?? x.kind)}">${esc(x.name)}</td>
      <td><input type="number" class="num" data-dir="in" data-key="${x.key}" value="${x.n}" min="1" max="512"></td>
      <td>${logic ? `<button class="lg ${x.activeLow ? 'nc' : ''}" data-key="${x.key}" title="${x.activeLow ? 'NC (b접점): 입력 OFF 일 때 기능 동작' : 'NO (a접점): 입력 ON 일 때 기능 동작'}">${x.activeLow ? 'NC' : 'NO'}</button>` : ''}</td>
      <td><span class="lamp" data-key="${x.key}" data-n="${x.n}" title="입력 레벨 (클릭: 토글)"></span></td>
      <td>${EDGE.has(x.kind) ? `<button class="pulse" data-key="${x.key}" title="150 ms 펄스">펄스</button>` : ''}</td></tr>`;
  }
  return html;
}

function outputRows(s) {
  return '<tr><th>신호 이름</th><th>DO</th><th>상태</th></tr>' + s.outputs.map((x) => `<tr data-key="${x.key}">
    <td class="nm" title="${esc(KIND_DESC[x.kind] ?? x.kind)}">${esc(x.name)}</td>
    <td><input type="number" class="num" data-dir="out" data-key="${x.key}" value="${x.n}" min="1" max="512"></td>
    <td><span class="lamp out" data-okey="${x.key}"></span></td></tr>`).join('');
}

function programRows(s, files) {
  const ents = Object.entries(s.programs).sort((a, b) => a[0] - b[0]);
  if (!ents.length) return '<tr><td class="dim" colspan="3">할당 없음 — ＋ 번호 추가</td></tr>';
  return '<tr><th>번호</th><th>프로그램 파일</th><th></th></tr>' + ents.map(([n, f]) => {
    const opts = (files.includes(f) ? files : [f, ...files]).map((x) => `<option value="${esc(x)}"${x === f ? ' selected' : ''}>${esc(x)}${files.includes(x) ? '' : ' (없음)'}</option>`).join('');
    return `<tr data-row="1"><td><input type="number" min="1" max="65535" value="${n}"></td><td>→ <select>${opts}</select></td><td><button class="del" data-pn="${n}" title="삭제">✕</button></td></tr>`;
  }).join('');
}

export function renderSysioPanel(st) {
  const s = st?.sysio;
  if (!s || !ctx) return;
  const root = $('#tSys');
  if (!root.classList.contains('active')) return;
  const files = st.program?.files || [];
  if (s === lastSysRef && files === lastFilesRef && sig) return;
  lastSysRef = s;
  lastFilesRef = files;
  const focus = document.activeElement;
  const editing = focus && root.contains(focus) && focus.matches('input[type=number], select');
  if (focus !== $('#sysEn')) $('#sysEn').checked = s.enabled;
  if (focus !== $('#sysPreset') && presets.length) $('#sysPreset').value = s.preset;
  const noteTxt = s.note || '';
  if ($('#sysNote').textContent !== noteTxt) $('#sysNote').textContent = noteTxt;
  if (focus !== $('#sysDiBase')) $('#sysDiBase').value = s.diBase;
  if (focus !== $('#sysDoBase')) $('#sysDoBase').value = s.doBase;
  const nsig = JSON.stringify([s.preset, s.enabled, s.pgno, s.inputs.map((x) => [x.key, x.n, x.activeLow, x.name]), s.outputs.map((x) => [x.key, x.n, x.name]), s.programs, files]);
  if (nsig !== sig && !editing) {
    sig = nsig;
    $('#sysIn').innerHTML = inputRows(s);
    $('#sysOut').innerHTML = outputRows(s);
    $('#sysProg').innerHTML = programRows(s, files);
    $('#sysBody').classList.toggle('off', !s.enabled);
    $('#sysHint').classList.toggle('hidden', s.enabled);
    $('#sysHint').innerHTML = `시스템 I/O 를 켜면 선택한 프리셋의 전용 신호가 <b>DI ${s.diBase}~ / DO ${s.doBase}~</b> 번에 할당됩니다.
      PLC 는 DI 를 켜서 서보 ON·시작·홀드·프로그램 번호 선택을 요청하고, 로봇 상태(운전 중·알람·홈 위치 등)는 DO 로 돌려받습니다.
      같은 번호는 <b>Modbus</b> 코일(DI)·이산 입력(DO), <b>OPC UA</b> IO, 제조사 프로토콜 I/O 로도 보이므로 실제 PLC 시퀀스를 그대로 시험할 수 있습니다.
      외부 입력은 '외부' 출처로 처리되어 모드 인터록(REMOTE 에서만 시작)을 받습니다.`;
  }
  // 램프 (매 상태)
  const byKey = new Map(s.inputs.map((x) => [x.key, x]));
  for (const el of $$('#sysIn .lamp[data-key]')) {
    const x = byKey.get(el.dataset.key);
    if (!x) continue;
    el.classList.toggle('on', x.raw);
    el.closest('tr:not(.pg)')?.classList.toggle('act', s.enabled && x.active);
  }
  const outKey = new Map(s.outputs.map((x) => [x.key, x]));
  for (const el of $$('#sysOut .lamp[data-okey]')) el.classList.toggle('on', !!outKey.get(el.dataset.okey)?.on);
  const pv = $('#sysPgVal');
  if (pv && focus !== pv) {
    let v = 0;
    for (const x of s.inputs) if (x.kind === 'pgnoBit' && x.raw) v |= 1 << Number(x.key.slice(4));
    pv.value = v;
  }
  const lastTxt = s.lastPgno != null ? `마지막 선택: ${s.lastPgno} → ${st.program?.main ?? '-'}` : '';
  if ($('#sysLast').textContent !== lastTxt) $('#sysLast').textContent = lastTxt;
}
