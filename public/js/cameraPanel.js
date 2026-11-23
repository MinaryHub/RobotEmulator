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
  const m = defaultMount(def, mount, st?.scene, ctx.getModel());
  send([...list, { id: `cam${n}`, type: typeId, name: `CAM${n} ${t(def.name).split(' (')[0]}`, mount, ...m, mode: def.modes[0], view: true, frustum: $('#camFrAll').checked }]);
}

let lastCamsRef = null;
export function renderCameraPanel(st) {
  if (!root) return;
  const cams = st.cameras || [];
  ctx.view.cameras.set(cams);
  if (cams === lastCamsRef && builtSig !== null) return;
  lastCamsRef = cams;
  const sig = JSON.stringify(cams);
  if (sig === builtSig) return;
  // 편집 중인 입력이 있으면 다시 그리지 않음 (포커스 유지)
  if (root.contains(document.activeElement) && document.activeElement.matches('#camList input, #camList select')) return;
  builtSig = sig;
  list = cams.map((c) => ({ ...c, pos: [...c.pos], rot: [...c.rot] }));
  $('#camCount').textContent = `${cams.length} / ${MAX_CAMERAS}`;
  const num = (i, k, j, lbl) => `<label>${lbl}<input type="number" step="${k === 'rot' ? 1 : 5}" data-i="${i}" data-k="${k}" data-j="${j}" value="${list[i][k][j]}"></label>`;
  $('#camList').innerHTML = list.length ? list.map((c, i) => {
    const def = getCamera(c.type);
    return `<div class="cam-item">
      <div class="hd"><input type="text" data-i="${i}" data-k="name" value="${esc(c.name)}" maxlength="40">
        <button data-i="${i}" data-a="reset" title="장착 위치 기본값">↺</button><button data-i="${i}" data-a="del" class="danger" title="제거">✕</button></div>
      <div class="m">${esc(def.maker)} ${esc(def.name)}</div>
      <div class="grid3">
        <label>장착<select data-i="${i}" data-k="mount">${Object.entries(CAMERA_MOUNTS).map(([k, v]) => `<option value="${k}" ${k === c.mount ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>모드<select data-i="${i}" data-k="mode">${def.modes.map((m) => `<option value="${m}" ${m === c.mode ? 'selected' : ''}>${CAMERA_MODES[m]}</option>`).join('')}</select></label>
        <label>표시<span class="chk"><input type="checkbox" data-i="${i}" data-k="view" ${c.view ? 'checked' : ''}>영상 <input type="checkbox" data-i="${i}" data-k="frustum" ${c.frustum ? 'checked' : ''}>시야</span></label>
        ${num(i, 'pos', 0, 'X mm')}${num(i, 'pos', 1, 'Y mm')}${num(i, 'pos', 2, 'Z mm')}
        ${num(i, 'rot', 0, 'Rx°')}${num(i, 'rot', 1, 'Ry°')}${num(i, 'rot', 2, 'Rz°')}
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
  $$('#camList button[data-a]').forEach((b) => (b.onclick = () => {
    const i = Number(b.dataset.i);
    if (b.dataset.a === 'del') send(list.filter((_, k) => k !== i));
    else { const c = list[i]; Object.assign(c, defaultMount(getCamera(c.type), c.mount, ctx.getState()?.scene, ctx.getModel())); send(list); }
  }));
}
