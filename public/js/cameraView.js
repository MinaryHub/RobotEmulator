// 비전 카메라: 3D 형상·시야(프러스텀) 표시 + 카메라 시점 렌더링 (화면 우하단 PiP)
//  - 카메라 정의/장착 관례: shared/cameras.js
//  - 각 카메라를 렌더 타깃(색 + 깊이 텍스처)에 그린 뒤, 후처리 셰이더로 컬러/흑백/깊이(컬러맵) 영상을 만들어
//    메인 캔버스의 PiP 프레임 위치(scissor)에 출력. 스냅샷은 카메라 해상도로 다시 렌더링해 PNG 저장.
//  - 보조 표시(궤적·TCP 축·프러스텀·작업 영역·간섭 캡슐)는 레이어 1 → 카메라 영상에는 나오지 않음
import * as THREE from 'three';
import { getCamera, CAMERA_MODES } from '/shared/cameras.js';
import { box, cylZ } from './gripperMesh.js';

export const HELPER_LAYER = 1;
const DEG = Math.PI / 180;
const CLIP_NEAR = 0.01, CLIP_FAR = 30; // 카메라 영상 렌더링 클리핑 (m)
const FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI); // 카메라 +Z 광축 → three.js -Z 시선

const POST_VS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const POST_FS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tColor; uniform sampler2D tDepth;
uniform float near; uniform float far; uniform float rmin; uniform float rmax; uniform int mode; uniform float cross;
vec3 toSRGB(vec3 c){ c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
// Turbo 컬러맵 근사 (Google, Apache-2.0 다항식)
vec3 turbo(float x){
  x = clamp(x, 0.0, 1.0);
  const vec4 kR = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
  const vec4 kG = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
  const vec4 kB = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
  const vec2 kR2 = vec2(-152.94239396, 59.28637943);
  const vec2 kG2 = vec2(4.27729857, 2.82956604);
  const vec2 kB2 = vec2(-89.90310912, 27.34824973);
  vec4 v4 = vec4(1.0, x, x * x, x * x * x); vec2 v2 = v4.zw * v4.z;
  return vec3(dot(v4, kR) + dot(v2, kR2), dot(v4, kG) + dot(v2, kG2), dot(v4, kB) + dot(v2, kB2));
}
void main(){
  vec3 c;
  if (mode == 2) {
    float d = texture2D(tDepth, vUv).x;
    float dist = (near * far) / (far - d * (far - near));  // 광축 방향 거리 (m)
    // 측정 범위(rmin~rmax) 밖은 실제 깊이 카메라처럼 무효(검정). 가까울수록 빨강
    c = (d >= 1.0 || dist < rmin || dist > rmax) ? vec3(0.0) : turbo(1.0 - (dist - rmin) / (rmax - rmin));
  } else {
    c = toSRGB(texture2D(tColor, vUv).rgb);
    if (mode == 1) c = vec3(dot(c, vec3(0.299, 0.587, 0.114)));
  }
  if (cross > 0.5) {
    vec2 p = abs(vUv - 0.5);
    float w = 0.0025;
    if ((p.x < w && p.y < 0.06) || (p.y < w * 2.0 && p.x < 0.045)) c = vec3(0.1, 1.0, 0.3);
  }
  gl_FragColor = vec4(c, 1.0);
}`;

export class CameraRig {
  // view: RobotView, host: PiP 프레임을 넣을 요소 (#view)
  constructor(view, host) {
    this.view = view;
    this.mounts = new THREE.Group();     // 카메라 형상 + 프러스텀 (월드 mm 그룹 안)
    view.world.add(this.mounts);
    this.cams = new Map();               // id → { cfg, def, group, frustum, cam, rt, frame }
    this.sig = '';
    this.cross = true;

    this.host = host;
    this.labels = true;                  // 3D 뷰에 카메라 이름 표시
    this._v = new THREE.Vector3();
    this.wrap = document.createElement('div');
    this.wrap.className = 'camviews';
    host.appendChild(this.wrap);

    this.post = new THREE.ShaderMaterial({
      vertexShader: POST_VS, fragmentShader: POST_FS, depthTest: false, depthWrite: false,
      uniforms: { tColor: { value: null }, tDepth: { value: null }, near: { value: 0.1 }, far: { value: 1 }, rmin: { value: 0.1 }, rmax: { value: 1 }, mode: { value: 0 }, cross: { value: 1 } },
    });
    this.postScene = new THREE.Scene();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.post);
    quad.frustumCulled = false;
    this.postScene.add(quad);
    this.postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3();
  }

  // cameras: 컨트롤러 state.cameras
  set(cameras) {
    if (cameras === this._lastCameras) return;
    this._lastCameras = cameras;
    const sig = JSON.stringify(cameras || []);
    if (sig === this.sig) return;
    this.sig = sig;
    const keep = new Set();
    for (const cfg of cameras || []) {
      const def = getCamera(cfg.type);
      if (!def) continue;
      keep.add(cfg.id);
      let c = this.cams.get(cfg.id);
      if (!c || c.def !== def) {
        if (c) this._dispose(c);
        c = this._create(cfg, def);
        this.cams.set(cfg.id, c);
      }
      c.cfg = cfg;
      c.offset = new THREE.Matrix4().compose(
        new THREE.Vector3(...cfg.pos),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(cfg.rot[0] * DEG, cfg.rot[1] * DEG, cfg.rot[2] * DEG, 'ZYX')),
        new THREE.Vector3(1, 1, 1));
      c.frustum.visible = cfg.frustum;
      c.frame.hidden = !cfg.view;
      c.frame.querySelector('.nm').textContent = cfg.name;
      c.label.textContent = cfg.name;
      c.frame.querySelector('.inf').textContent = `${def.res[0]}×${def.res[1]} · ${def.hfov}° · ${CAMERA_MODES[cfg.mode]}`;
      const lg = c.frame.querySelector('.legend');
      lg.hidden = cfg.mode !== 'depth';
      lg.innerHTML = `<span>${def.range[0]}</span><i></i><span>${def.range[1]} mm</span>`;
    }
    for (const [id, c] of this.cams) if (!keep.has(id)) { this._dispose(c); this.cams.delete(id); }
    if (this._frames) this.update(this._frames, this._mat4); // 로봇이 정지 중이어도 즉시 배치
    // 프레임 순서를 목록 순서와 맞춤
    for (const cfg of cameras || []) { const c = this.cams.get(cfg.id); if (c) this.wrap.appendChild(c.frame); }
    this.view.markDirty?.(true);
  }

  _create(cfg, def) {
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    const b = def.body;
    const bodyMat = new THREE.MeshStandardMaterial({ color: def.kind === '3d' ? 0x3a3f46 : def.kind === 'monitor' ? 0xe6e8ea : 0x2f6fb5, metalness: 0.3, roughness: 0.5 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0b0d10, metalness: 0.9, roughness: 0.15 });
    // 원점 = 렌즈 앞면(광학 중심 근사). 렌즈는 -Z 로 lens.l, 몸체는 그 뒤로 body.d
    const ll = def.lens?.l ?? 0;
    group.add(box(b.w, b.h, b.d, bodyMat, 0, 0, -ll - b.d));
    if (def.lens) group.add(cylZ(def.lens.d / 2, ll, glass, -ll, 24));
    else if (def.kind === '3d') {
      // 스테레오/구조광: 전면 창 2개(+프로젝터)
      const sx = b.w * 0.33;
      for (const x of [-sx, sx]) group.add(cylZ(Math.min(b.h, b.w) * 0.16, 2, glass, -1.5, 20).translateX(x));
      group.add(cylZ(Math.min(b.h, b.w) * 0.1, 2, glass, -1.5, 16));
    }
    group.traverse((m) => { if (m.isMesh) m.castShadow = true; });
    // 시야 프러스텀 (far 는 최대 1.5m 로 잘라 표시)
    const frustum = this._frustumLines(def);
    group.add(frustum);
    this.mounts.add(group);

    // 렌더링 클리핑은 측정 범위와 분리: near 를 측정 최소 거리로 두면 그보다 가까운 물체가 잘려 메시 너머가 비쳐 보임.
    // 실제 카메라처럼 가까운 물체도 가리도록 near = 10mm, far = 측정 최대 거리와 30m 중 큰 값 (24bit 깊이에서 30m 오차 ≈ 5mm)
    const cam = new THREE.PerspectiveCamera(this._vfov(def), def.res[0] / def.res[1], CLIP_NEAR, Math.max(CLIP_FAR, def.range[1] / 1000));
    cam.layers.set(0);
    const rt = new THREE.WebGLRenderTarget(4, 4, { depthTexture: new THREE.DepthTexture(4, 4), samples: 0 });

    const frame = document.createElement('div');
    frame.className = 'camframe';
    frame.innerHTML = `<div class="rz" title="드래그: 크기 조절 · 더블클릭: 기본 크기"></div>
      <div class="hd"><span class="nm"></span><span class="inf"></span>
      <button data-a="snap" title="카메라 해상도로 PNG 저장">⭳</button><button data-a="big" title="크게 보기 / 기본 크기">⤢</button><button data-a="close" title="미리보기 닫기 (카메라 탭의 '영상' 체크로 다시 열기)">✕</button></div>
      <div class="img" style="aspect-ratio:${def.res[0]} / ${def.res[1]}"><div class="legend" hidden></div></div>`;
    const id = cfg.id;
    frame.querySelector('[data-a="big"]').onclick = () => {
      if (frame.style.width) this._setWidth(frame, id, null); else frame.classList.toggle('big');
    };
    frame.querySelector('[data-a="snap"]').onclick = () => this.snapshot(id);
    frame.querySelector('[data-a="close"]').onclick = () => this.onClose?.(id);
    this._bindResize(frame, id, def);
    try { const w = Number(localStorage.getItem(`camW:${id}`)); if (w > 0) this._setWidth(frame, id, w); } catch { /* 저장소 사용 불가 */ }
    // 3D 뷰 이름표 (HTML — 확대/축소와 무관하게 같은 크기, 카메라 영상에는 나오지 않음)
    const label = document.createElement('div');
    label.className = 'camlabel';
    this.host.appendChild(label);
    return { cfg, def, group, frustum, cam, rt, frame, label };
  }

  // 미리보기 폭 지정 (null → 기본 크기). 높이는 카메라 화면비로 따라감. 폭은 브라우저에 기억
  _setWidth(frame, id, w) {
    frame.classList.remove('big');
    frame.style.width = w ? `${Math.round(w)}px` : '';
    frame.style.maxWidth = w ? '100%' : '';
    try { w ? localStorage.setItem(`camW:${id}`, String(Math.round(w))) : localStorage.removeItem(`camW:${id}`); } catch { /* 무시 */ }
  }

  // 왼쪽 위 모서리 드래그로 크기 조절 (프레임은 오른쪽 아래 기준이라 왼쪽·위로 끌면 커짐)
  _bindResize(frame, id, def) {
    const h = frame.querySelector('.rz');
    const aspect = def.res[0] / def.res[1];
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      h.setPointerCapture(e.pointerId);
      const x0 = e.clientX, y0 = e.clientY, w0 = frame.getBoundingClientRect().width;
      const maxW = Math.min(this.host.clientWidth - 16, (this.host.clientHeight - 16 - 26) * aspect); // 26 = 제목줄
      frame.classList.add('resizing');
      const move = (ev) => {
        const byX = w0 - (ev.clientX - x0), byY = w0 - (ev.clientY - y0) * aspect;
        const w = Math.abs(byX - w0) >= Math.abs(byY - w0) ? byX : byY;
        this._setWidth(frame, id, Math.max(160, Math.min(maxW, w)));
      };
      const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); frame.classList.remove('resizing'); };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
      h.addEventListener('pointercancel', up);
    });
    h.addEventListener('dblclick', () => this._setWidth(frame, id, null));
  }

  _vfov(def) { return 2 * Math.atan(Math.tan(def.hfov * DEG / 2) * def.res[1] / def.res[0]) / DEG; }

  _frustumLines(def) {
    const tx = Math.tan(def.hfov * DEG / 2), ty = tx * def.res[1] / def.res[0];
    const n = def.range[0], f = Math.min(def.range[1], 1500);
    const c = (z) => [[-tx * z, -ty * z, z], [tx * z, -ty * z, z], [tx * z, ty * z, z], [-tx * z, ty * z, z]];
    const N = c(n), F = c(f), pts = [];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      pts.push([0, 0, 0], F[i], N[i], N[j], F[i], F[j]);
    }
    // 영상 위쪽(-Y) 표시용 삼각형
    pts.push([-tx * f * 0.25, -ty * f * 1.05, f], [0, -ty * f * 1.3, f], [0, -ty * f * 1.3, f], [tx * f * 0.25, -ty * f * 1.05, f]);
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.7 }));
    lines.layers.set(HELPER_LAYER);
    return lines;
  }

  _dispose(c) {
    this.mounts.remove(c.group);
    c.group.traverse((m) => {
      m.geometry?.dispose?.();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mt of mats) mt.dispose?.();
    });
    c.rt.depthTexture?.dispose?.();
    c.rt.dispose();
    c.frame.remove();
    c.label.remove();
  }

  // 카메라 몸체 위치를 메인 뷰 화면 좌표로 투영해 이름표 배치
  _placeLabels() {
    const vc = this.view.camera, el = this.view.renderer.domElement;
    const w = el.clientWidth, h = el.clientHeight;
    for (const c of this.cams.values()) {
      const v = this._v.setFromMatrixPosition(c.group.matrixWorld).project(vc);
      const show = this.labels && v.z < 1 && Math.abs(v.x) <= 1.05 && Math.abs(v.y) <= 1.05;
      c.label.hidden = !show;
      if (show) c.label.style.transform = `translate(${((v.x + 1) / 2 * w).toFixed(1)}px, ${((1 - v.y) / 2 * h).toFixed(1)}px) translate(-50%, -150%)`;
    }
  }

  // frames: jointFrames() 결과 (로봇 베이스 기준, mm)
  update(frames, mat4) {
    this._frames = frames; this._mat4 = mat4;
    for (const c of this.cams.values()) {
      if (c.cfg.mount === 'flange') {
        c.group.matrix.multiplyMatrices(mat4(frames[6]), c.offset);
      } else if (c.cfg.mount === 'forearm') {
        c.group.matrix.multiplyMatrices(mat4(frames[3]), c.offset);
      } else {
        c.group.matrix.copy(c.offset);
      }
    }
  }

  // 월드(mm) 그룹 안 장착 행렬 → 장면(m) 좌표의 카메라 자세
  _place(c) {
    c.group.matrixWorld.decompose(this._p, this._q, this._s);
    c.cam.position.copy(this._p);
    c.cam.quaternion.copy(this._q).multiply(FLIP);
    c.cam.updateMatrixWorld(true);
  }

  _renderTo(c, w, h) {
    const r = this.view.renderer;
    if (c.rt.width !== w || c.rt.height !== h) c.rt.setSize(w, h);
    this._place(c);
    r.setRenderTarget(c.rt);
    r.render(this.view.scene, c.cam);
    const u = this.post.uniforms;
    u.tColor.value = c.rt.texture; u.tDepth.value = c.rt.depthTexture;
    u.near.value = c.cam.near; u.far.value = c.cam.far;
    u.rmin.value = c.def.range[0] / 1000; u.rmax.value = c.def.range[1] / 1000;
    u.mode.value = { color: 0, mono: 1, depth: 2 }[c.cfg.mode] ?? 0;
  }

  // 메인 렌더 직후 호출: 보이는 PiP 프레임마다 카메라 시점 렌더
  render() {
    if (!this.cams.size) return;
    const r = this.view.renderer;
    const boxes = [];
    for (const c of this.cams.values()) {
      if (!c.cfg.view) continue;
      c._img ??= c.frame.querySelector('.img');
      boxes.push([c, c._img.getBoundingClientRect()]);
    }
    const canvas = boxes.length ? r.domElement.getBoundingClientRect() : null;
    this._placeLabels();
    if (!boxes.length) return;
    const dpr = r.getPixelRatio();
    const autoClear = r.autoClear;
    for (const [c, box] of boxes) {
      if (box.width < 4 || box.height < 4) continue;
      this._renderTo(c, Math.round(box.width * dpr), Math.round(box.height * dpr));
      this.post.uniforms.cross.value = this.cross ? 1 : 0;
      const x = box.left - canvas.left, y = canvas.bottom - box.bottom;
      r.setRenderTarget(null);
      r.setViewport(x, y, box.width, box.height);
      r.setScissor(x, y, box.width, box.height);
      r.setScissorTest(true);
      r.autoClear = false;
      r.render(this.postScene, this.postCam);
      r.autoClear = autoClear;
      r.setScissorTest(false);
    }
    r.setViewport(0, 0, canvas.width, canvas.height);
  }

  // 카메라 해상도(최대 폭 2048)로 렌더링해 PNG 다운로드
  snapshot(id) {
    const c = this.cams.get(id);
    if (!c) return;
    const r = this.view.renderer;
    const w = Math.min(2048, c.def.res[0]), h = Math.round(w * c.def.res[1] / c.def.res[0]);
    this.view.scene.updateMatrixWorld();
    this._renderTo(c, w, h);
    this.post.uniforms.cross.value = 0;
    const out = new THREE.WebGLRenderTarget(w, h);
    r.setRenderTarget(out);
    r.render(this.postScene, this.postCam);
    const px = new Uint8Array(w * h * 4);
    r.readRenderTargetPixels(out, 0, 0, w, h, px);
    r.setRenderTarget(null);
    out.dispose();
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4); // 상하 반전
    ctx.putImageData(img, 0, 0);
    cv.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${c.cfg.name.replace(/[^\w가-힣-]+/g, '_')}_${c.cfg.mode}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
  }
}
