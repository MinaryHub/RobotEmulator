// 카메라 탭: 라이브러리에서 카메라 추가, 장착 위치(플랜지/전완/고정)·오프셋·렌더 모드 편집
// 서버 명령: { cmd:'cameras', list:[…] } — 전체 목록을 보내 교체 (server/controller.js setCameras)
import { t } from './i18n.js';   // 새 카메라 이름은 화면 언어로
import { CAMERAS, CAMERA_MOUNTS, CAMERA_MODES, MAX_CAMERAS, getCamera, defaultMount } from '/shared/cameras.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const KIND = { '2d': '2D', '3d': '3D 깊이', monitor: '모니터링' };

let ctx = null;   // { cmd, view, getState, getModel }
let root = null;
let builtSig = null;
let list = [];

export function initCameraPanel(opts) {
  ctx = opts;
  root = document.getElementById('tCamera');
  root.innerHTML = `
    <h3>카메라 라이브러리</h3>
    <div class="row"><label>장착 위치</label>
      <div class="seg" id="camMount">${Object.entries(CAMERA_MOUNTS).map(([k, v]) => `<button data-v="${k}">${v}</button>`).join('')}<button data-v="" class="active">기본</button></div>
    </div>
    <div id="camLib" class="cards"></div>
    <h3>장착된 카메라 <small id="camCount"></small></h3>
    <div class="row btns">
      <label class="inl"><input type="checkbox" id="camCross" checked> 영상 중심 십자선</label>
      <label class="inl"><input type="checkbox" id="camFrAll" checked> 시야 표시</label>
      <label class="inl"><input type="checkbox" id="camLabels" checked> 3D 이름 표시</label>
    </div>
    <div id="camList"></div>
    <div class="note">카메라 좌표: +Z 광축, +X 영상 오른쪽, +Y 영상 아래. 오프셋은 장착 좌표계 기준 (회전 R = Rz·Ry·Rx).
      <b>플랜지</b>는 플랜지 좌표계(+Z 툴 방향), <b>전완</b>은 J3 축 좌표계(+Z 전완 방향), <b>고정</b>은 로봇 베이스 좌표계입니다.
      영상은 3D 뷰 오른쪽 아래에 표시되며 ⤢ 로 크게 보기, ⭳ 로 카메라 해상도 PNG 저장. 깊이 모드는 가까울수록 빨강, 측정 범위 밖은 검정.</div>`;

  $('#camLib').innerHTML = CAMERAS.map((c) => `
    <div class="card" data-id="${c.id}">
      <div class="t">${c.name}</div>
      <div class="m">${c.maker} · ${KIND[c.kind]} · 기본 ${CAMERA_MOUNTS[c.mount]}</div>
      <div class="d">${c.res[0]}×${c.res[1]} · HFOV ${c.hfov}° · ${c.range[0]}–${c.range[1]}mm · ${c.modes.map((m) => CAMERA_MODES[m]).join('/')}</div>
    </div>`).join('');
  $$('#camMount button').forEach((b) => (b.onclick = () => $$('#camMount button').forEach((x) => x.classList.toggle('active', x === b))));
  $$('#camLib .card').forEach((card) => (card.onclick = () => add(card.dataset.id)));
  $('#camCross').onchange = (e) => (ctx.view.cameras.cross = e.target.checked);
  // 미리보기 ✕ → 해당 카메라 '영상' 표시 끔 (서버 저장 → 프로젝트에 유지)
  ctx.view.cameras.onClose = (id) => send(list.map((c) => (c.id === id ? { ...c, view: false } : c)));
  $('#camLabels').onchange = (e) => (ctx.view.cameras.labels = e.target.checked);
  $('#camFrAll').onchange = (e) => send(list.map((c) => ({ ...c, frustum: e.target.checked })));
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function send(next) { list = next; ctx.cmd('cameras', { list: next }).catch(() => {}); }

function add(typeId) {
  if (list.length >= MAX_CAMERAS) return alert(`카메라는 최대 ${MAX_CAMERAS}대까지 장착할 수 있습니다`);
  const def = getCamera(typeId);
  const st = ctx.getState();
  const mount = $('#camMount button.active')?.dataset.v || def.mount;
  let n = 1;
  while (list.some((c) => c.id === `cam${n}`)) n++;
  const idx = list.length;
  const m = defaultMount(def, mount, st?.scene, ctx.getModel());
  send([...list, {
    id: `cam${n}`, type: typeId, name: `CAM${n} ${t(def.name).split(' (')[0]}`, mount, ...m,
    mode: def.modes[0], view: false, frustum: $('#camFrAll').checked,
    vision: { enabled: true, triggerDO: 20 + idx * 4, doneDI: 20 + idx * 4, foundDI: 21 + idx * 4, regBase: idx * 10, frame: 'base', noiseMm: 0.5, noiseDeg: 0.2, latencyMs: 80 },
  }]);
}

let lastCamsRef = null;
let lastVisSig = '';
export function renderCameraPanel(st) {
  if (!root) return;
  const cams = st.cameras || [];
  ctx.view.cameras.set(cams);
  const vis = st.vision || {};
  const visSig = JSON.stringify(vis);
  const camsChanged = cams !== lastCamsRef || builtSig === null;
  if (!camsChanged && visSig === lastVisSig) return;
  lastCamsRef = cams;
  lastVisSig = visSig;
  const sig = JSON.stringify(cams);
  // 편집 중인 입력이 있으면 목록 재구성은 건너뛰고 검출 결과만 갱신
  const editing = root.contains(document.activeElement) && document.activeElement.matches('#camList input, #camList select');
  if (sig !== builtSig && !editing) {
    builtSig = sig;
    list = cams.map((c, i) => ({
      ...c, pos: [...c.pos], rot: [...c.rot],
      vision: { enabled: false, triggerDO: 20 + i * 4, doneDI: 20 + i * 4, foundDI: 21 + i * 4, regBase: i * 10, frame: 'base', noiseMm: 0.5, noiseDeg: 0.2, latencyMs: 80, ...(c.vision || {}) },
    }));
    $('#camCount').textContent = `${cams.length} / ${MAX_CAMERAS}`;
    const num = (i, k, j, lbl) => `<label>${lbl}<input type="number" step="${k === 'rot' ? 1 : 5}" data-i="${i}" data-k="${k}" data-j="${j}" value="${list[i][k][j]}"></label>`;
    const vnum = (i, vk, lbl, step = 1, min = 0) => `<label>${lbl}<input type="number" step="${step}" min="${min}" data-i="${i}" data-vk="${vk}" value="${list[i].vision[vk]}"></label>`;
    $('#camList').innerHTML = list.length ? list.map((c, i) => {
      const def = getCamera(c.type);
      const v = c.vision;
      return `<div class="cam-item">
        <div class="hd"><input type="text" data-i="${i}" data-k="name" value="${esc(c.name)}" maxlength="40">
          <button data-i="${i}" data-a="reset" title="장착 위치 기본값">↺</button><button data-i="${i}" data-a="del" class="danger" title="제거">✕</button></div>
        <div class="m">${esc(def.maker)} ${esc(def.name)}</div>
        <div class="grid3">
          <label>장착<select data-i="${i}" data-k="mount">${Object.entries(CAMERA_MOUNTS).map(([k, lb]) => `<option value="${k}" ${k === c.mount ? 'selected' : ''}>${lb}</option>`).join('')}</select></label>
          <label>모드<select data-i="${i}" data-k="mode">${def.modes.map((m) => `<option value="${m}" ${m === c.mode ? 'selected' : ''}>${CAMERA_MODES[m]}</option>`).join('')}</select></label>
          <label>표시<span class="chk"><input type="checkbox" data-i="${i}" data-k="view" ${c.view ? 'checked' : ''}>PiP <input type="checkbox" data-i="${i}" data-k="frustum" ${c.frustum ? 'checked' : ''}>시야</span></label>
          ${num(i, 'pos', 0, 'X mm')}${num(i, 'pos', 1, 'Y mm')}${num(i, 'pos', 2, 'Z mm')}
          ${num(i, 'rot', 0, 'Rx°')}${num(i, 'rot', 1, 'Ry°')}${num(i, 'rot', 2, 'Rz°')}
        </div>
        <div class="vis-box">
          <div class="vis-hd">
            <label class="chk"><input type="checkbox" data-i="${i}" data-vk="enabled" ${v.enabled ? 'checked' : ''}> 가상 비전 센서 (DO 트리거)</label>
            <button type="button" class="mini primary" data-i="${i}" data-a="trigger" title="지금 시야 내 공작물 검출 실행">▶ 트리거</button>
          </div>
          <div class="grid3">
            ${vnum(i, 'triggerDO', '트리거 DO')}${vnum(i, 'doneDI', '완료 DI')}${vnum(i, 'foundDI', '검출 DI')}
            ${vnum(i, 'regBase', '레지스터 시작')}${vnum(i, 'noiseMm', '노이즈 ±mm', 0.1)}${vnum(i, 'noiseDeg', '각도 ±°', 0.1)}
            <label>좌표계<select data-i="${i}" data-vk="frame"><option value="base" ${v.frame === 'base' ? 'selected' : ''}>BASE</option><option value="user" ${v.frame === 'user' ? 'selected' : ''}>USER</option></select></label>
            ${vnum(i, 'latencyMs', '지연 ms', 10)}
          </div>
          <div class="vis-res" data-vis="${esc(c.id)}"></div>
        </div></div>`;
    }).join('') : '<div class="note">위 라이브러리에서 카메라를 클릭하면 장착됩니다.</div>';

    $$('#camList [data-k]').forEach((el) => (el.onchange = () => {
      const c = list[Number(el.dataset.i)], k = el.dataset.k;
      if (k === 'pos' || k === 'rot') c[k][Number(el.dataset.j)] = Number(el.value) || 0;
      else if (el.type === 'checkbox') c[k] = el.checked;
      else c[k] = el.value;
      if (k === 'mount') Object.assign(c, defaultMount(getCamera(c.type), c.mount, ctx.getState()?.scene, ctx.getModel()));
      send(list);
    }));
    $$('#camList [data-vk]').forEach((el) => (el.onchange = () => {
      const c = list[Number(el.dataset.i)], vk = el.dataset.vk;
      if (el.type === 'checkbox') c.vision[vk] = el.checked;
      else if (el.tagName === 'SELECT') c.vision[vk] = el.value;
      else c.vision[vk] = Number(el.value) || 0;
      send(list);
    }));
    $$('#camList button[data-a]').forEach((b) => (b.onclick = () => {
      const i = Number(b.dataset.i);
      if (b.dataset.a === 'del') send(list.filter((_, k) => k !== i));
      else if (b.dataset.a === 'trigger') ctx.cmd('visionTrigger', { camId: list[i].id }).catch(() => {});
      else { const c = list[i]; Object.assign(c, defaultMount(getCamera(c.type), c.mount, ctx.getState()?.scene, ctx.getModel())); send(list); }
    }));
  }
  // 마지막 검출 결과 갱신
  for (const c of list) {
    const el = $(`#camList [data-vis="${window.CSS.escape(c.id)}"]`);
    if (!el) continue;
    const r = vis[c.id];
    const txt = !r ? '대기 중 (트리거 DO 상승 에지 또는 ▶ 트리거 클릭)'
      : r.found ? `✔ ${r.objectId} (${r.frame.toUpperCase()}) [${r.pose[0]}, ${r.pose[1]}, ${r.pose[2]} mm, Rz ${r.pose[3]}°] → MB:${r.regBase}..${r.regBase + 4}`
      : '○ 시야 내 공작물 없음';
    if (el.textContent !== txt) el.textContent = txt;
    el.className = `vis-res ${r ? (r.found ? 'ok' : 'none') : ''}`;
  }
}
