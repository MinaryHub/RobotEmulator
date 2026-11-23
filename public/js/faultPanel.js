// 고장 주입 패널 (P1-1): 이상/복구 시퀀스 검증용
//  - 장비 고장: 그리퍼 파지 실패, 컨베이어 정지, 피더 걸림, 센서 고착(ON/OFF)
//  - 통신 고장: 응답 지연(ms), 패킷 드롭(%)
//  - 즉시 발생: 서보 트립, 모션 강제 정지, 제조사별 알람 주입
import { ALARM_CODES, vendorAlarm } from '/shared/alarms.js';
import { escHtml as esc } from './ioLabels.js';

const $ = (s, r = document) => r.querySelector(s);

let ctx = null;
let root = null;
let lastFaultRef = null;
let lastSensorSig = '';
let lastVendor = '';

export function initFaultPanel(opts) {
  ctx = opts;
  root = $('#tFault');
  if (!root) return;
  root.innerHTML = `
    <h3>장비 · 센서 고장 <button id="btnFaultClear" class="danger" style="padding:2px 8px;font-size:11px">모두 해제</button></h3>
    <div class="row fault-list">
      <label class="chk"><input type="checkbox" id="fltGrip"> 그리퍼 파지 실패 (닫혀도 물체 미파지)</label>
      <label class="chk"><input type="checkbox" id="fltConv"> 컨베이어 정지 (벨트 고착)</label>
      <label class="chk"><input type="checkbox" id="fltFeed"> 피더 걸림 (부품 배출 중단)</label>
    </div>
    <h3>센서 고착</h3>
    <div id="fltSensors" class="fault-sensors"></div>
    <h3>통신 고장 (프로토콜 시뮬레이션)</h3>
    <div class="row">
      <label>응답 지연 <b id="fltLatVal">0 ms</b></label>
      <input type="range" id="fltLat" min="0" max="2000" step="20" value="0">
    </div>
    <div class="row">
      <label>패킷 드롭률 <b id="fltDropVal">0%</b></label>
      <input type="range" id="fltDrop" min="0" max="100" step="5" value="0">
    </div>
    <h3>즉시 고장 트리거</h3>
    <div class="row btns">
      <button id="fltServoTrip" class="danger">서보 트립 (OFF + 알람)</button>
      <button id="fltMotionStop" class="warn">모션 강제 정지</button>
    </div>
    <h3>제조사 알람 주입</h3>
    <div class="row safety-row">
      <select id="fltAlarmCode"></select>
      <button id="fltAlarmFire" class="warn">주입</button>
    </div>
    <div class="note" id="fltAlarmPreview"></div>
    <div class="note">고장 주입은 PLC·상위 제어기의 예외 처리와 복구 시퀀스 검증을 위한 기능입니다. 활성 고장은 상단 헤더의 FAULT 표시로 확인할 수 있습니다.</div>`;

  const setPatch = (faults) => ctx.cmd('setFaults', { faults }).catch(() => {});
  $('#btnFaultClear', root).onclick = () => ctx.cmd('clearFaults').catch(() => {});
  $('#fltGrip', root).onchange = (e) => setPatch({ gripperFail: e.target.checked });
  $('#fltConv', root).onchange = (e) => setPatch({ conveyorStall: e.target.checked });
  $('#fltFeed', root).onchange = (e) => setPatch({ feederJam: e.target.checked });

  $('#fltLat', root).oninput = (e) => { $('#fltLatVal', root).textContent = `${e.target.value} ms`; };
  $('#fltLat', root).onchange = (e) => setPatch({ commLatencyMs: Number(e.target.value) });
  $('#fltDrop', root).oninput = (e) => { $('#fltDropVal', root).textContent = `${e.target.value}%`; };
  $('#fltDrop', root).onchange = (e) => setPatch({ commDropPct: Number(e.target.value) });

  $('#fltServoTrip', root).onclick = () => ctx.cmd('injectFault', { kind: 'servoTrip' }).catch(() => {});
  $('#fltMotionStop', root).onclick = () => ctx.cmd('injectFault', { kind: 'motionStop' }).catch(() => {});
  $('#fltAlarmCode', root).onchange = () => updateAlarmPreview(ctx.getState()?.vendor);
  $('#fltAlarmFire', root).onclick = () => {
    const kind = $('#fltAlarmCode', root).value;
    ctx.cmd('injectFault', { kind }).catch(() => {});
  };

  $('#fltSensors', root).addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-sid]');
    if (!sel) return;
    const v = sel.value === 'on' ? 'on' : sel.value === 'off' ? 'off' : null;
    setPatch({ sensorStuck: { [sel.dataset.sid]: v } });
  });
}

function updateAlarmPreview(vendor) {
  if (!root || !vendor) return;
  const code = $('#fltAlarmCode', root)?.value || 'SERVO_TRIP';
  const va = vendorAlarm(vendor, code);
  const el = $('#fltAlarmPreview', root);
  if (el) el.textContent = va ? `${vendor.toUpperCase()} [${va.code}] ${va.name}` : code;
}

export function hasActiveFaults(f) {
  if (!f) return false;
  if (f.gripperFail || f.conveyorStall || f.feederJam) return true;
  if ((f.commLatencyMs || 0) > 0 || (f.commDropPct || 0) > 0) return true;
  if (f.sensorStuck && Object.keys(f.sensorStuck).length > 0) return true;
  return false;
}

export function renderFaultPanel(st) {
  if (!root || !st) return;
  const f = st.faults || {};
  const active = hasActiveFaults(f);
  const pill = $('#stFault');
  if (pill) pill.classList.toggle('hidden', !active);

  if (!root.classList.contains('active')) return;

  // 제조사 알람 드롭다운 (제조사 바뀔 때 갱신)
  if (st.vendor && st.vendor !== lastVendor) {
    lastVendor = st.vendor;
    const sel = $('#fltAlarmCode', root);
    const cur = sel.value || 'SERVO_TRIP';
    sel.innerHTML = ALARM_CODES.map((code) => {
      const va = vendorAlarm(st.vendor, code);
      return `<option value="${esc(code)}"${code === cur ? ' selected' : ''}>${esc(code)}${va ? ` (${esc(va.code)})` : ''}</option>`;
    }).join('');
    updateAlarmPreview(st.vendor);
  }

  const sensors = (st.cell?.layout?.devices || []).filter((d) => d.type === 'sensor');
  const sensorSig = sensors.map((d) => `${d.id}:${d.name}:${d.di}:${f.sensorStuck?.[d.id] ?? ''}`).join('|');

  if (f === lastFaultRef && sensorSig === lastSensorSig) return;
  lastFaultRef = f;
  lastSensorSig = sensorSig;

  const focus = document.activeElement;
  if (focus !== $('#fltGrip', root)) $('#fltGrip', root).checked = !!f.gripperFail;
  if (focus !== $('#fltConv', root)) $('#fltConv', root).checked = !!f.conveyorStall;
  if (focus !== $('#fltFeed', root)) $('#fltFeed', root).checked = !!f.feederJam;
  if (focus !== $('#fltLat', root)) {
    const lat = Math.round(f.commLatencyMs || 0);
    $('#fltLat', root).value = lat;
    $('#fltLatVal', root).textContent = `${lat} ms`;
  }
  if (focus !== $('#fltDrop', root)) {
    const drop = Math.round(f.commDropPct || 0);
    $('#fltDrop', root).value = drop;
    $('#fltDropVal', root).textContent = `${drop}%`;
  }

  const sEl = $('#fltSensors', root);
  if (!sensors.length) {
    sEl.innerHTML = '<div class="note">현재 셀에 센서가 없습니다.</div>';
  } else {
    sEl.innerHTML = sensors.map((d) => {
      const stVal = f.sensorStuck?.[d.id];
      const cur = stVal === 'on' ? 'on' : stVal === 'off' ? 'off' : '';
      return `<div class="fault-srow"><span>${esc(d.name || d.id)} <small class="dim">DI${d.di}</small></span>
        <select data-sid="${esc(d.id)}">
          <option value=""${cur === '' ? ' selected' : ''}>정상</option>
          <option value="on"${cur === 'on' ? ' selected' : ''}>고착 ON</option>
          <option value="off"${cur === 'off' ? ' selected' : ''}>고착 OFF</option>
        </select></div>`;
    }).join('');
  }
}
