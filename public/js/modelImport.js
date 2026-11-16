// 사용자 3D 모델 가져오기 (브라우저): 원본 파일 → 표시용 GLB + 간섭용 메시(.col) → 서버 업로드
//  - STL / OBJ / GLB·glTF(단일 파일) : three.js 로더
//  - STEP / IGES : occt-import-js (OpenCascade WASM, Web Worker 에서 변환 → UI 멈춤 없음)
//  - 간섭 메시는 shared/meshcol.js simplifyMesh 로 최대 COL_MAX_TRIS 삼각형으로 줄여 올린다 (표시용 GLB 는 원본 해상도)
//  - 업로드 형식·저장 위치: server/assets.js
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { simplifyMesh, encodeCol, COL_MAX_TRIS } from '/shared/meshcol.js';

export const MODEL_ACCEPT = '.stl,.obj,.glb,.gltf,.step,.stp,.iges,.igs';
const DEFAULT_MAT = () => new THREE.MeshStandardMaterial({ color: 0xb4bcc6, metalness: 0.35, roughness: 0.55 });

// file: File. onStatus(text): 진행 표시. 반환: 서버 메타 { id, name, format, bbox, tris, srcTris }
export async function importModelFile(file, onStatus = () => {}) {
  const ext = (file.name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
  const format = { stp: 'step', igs: 'iges' }[ext] || ext;
  if (!['stl', 'obj', 'glb', 'gltf', 'step', 'iges'].includes(format)) throw new Error(`지원하지 않는 형식입니다: .${ext} (STL·OBJ·GLB·glTF·STEP·IGES)`);
  onStatus('파일 읽는 중…');
  const buf = await file.arrayBuffer();
  let root;
  if (format === 'stl') root = parseStl(buf);
  else if (format === 'obj') root = new OBJLoader().parse(new TextDecoder().decode(buf));
  else if (format === 'glb' || format === 'gltf') {
    try { root = (await new GLTFLoader().parseAsync(buf, '')).scene; } catch (e) { throw new Error(`glTF 읽기 실패: ${e.message || e} (외부 .bin·텍스처 파일을 참조하는 .gltf 는 GLB 로 내보내 주세요)`); }
  } else {
    onStatus(`${format.toUpperCase()} 변환 중… (큰 파일은 수십 초 걸릴 수 있음)`);
    root = buildOcctGroup(await occtRead(format, buf));
  }

  onStatus('간섭 메시 생성 중…');
  await idle();
  const tri = collectTriangles(root);
  if (!tri.count) throw new Error('모델에 삼각형(면)이 없습니다');
  const s = simplifyMesh(tri.positions, tri.indices, COL_MAX_TRIS);
  const col = encodeCol(s.positions, s.indices);

  onStatus('표시용 모델 변환 중…');
  await idle();
  const glb = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true });

  onStatus(`업로드 중… (${((glb.byteLength + col.byteLength) / 1048576).toFixed(1)} MB)`);
  const header = new TextEncoder().encode(JSON.stringify({ name: file.name, format, glbBytes: glb.byteLength, colBytes: col.byteLength, srcTris: tri.count }));
  const pre = new Uint8Array(4);
  new DataView(pre.buffer).setUint32(0, header.length, true);
  const res = await fetch('/api/assets', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Blob([pre, header, glb, col]) });
  const out = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || out.error) throw new Error(out.error || `업로드 실패 (HTTP ${res.status})`);
  return out;
}

const idle = () => new Promise((r) => setTimeout(r, 0));

function parseStl(buf) {
  const geo = new STLLoader().parse(buf);
  const mat = DEFAULT_MAT();
  if (geo.hasColors) { mat.vertexColors = true; mat.color.setHex(0xffffff); }
  return new THREE.Mesh(geo, mat);
}

// STEP/IGES → occt 결과 JSON (Web Worker)
function occtRead(format, buf) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker('/vendor/occt/occt-import-js-worker.js'); } catch (e) { reject(new Error(`변환 엔진을 시작할 수 없습니다: ${e.message}`)); return; }
    w.onmessage = (e) => {
      w.terminate();
      if (e.data?.success && e.data.meshes?.length) resolve(e.data);
      else reject(new Error(`${format.toUpperCase()} 변환 실패 — 손상되었거나 형상(솔리드·면)이 없는 파일입니다`));
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(`변환 엔진 오류: ${e.message || '알 수 없음'} (메모리 부족일 수 있음)`)); };
    w.postMessage({ format, buffer: new Uint8Array(buf), params: { linearUnit: 'millimeter' } });
  });
}

// occt 결과 → THREE.Group (메시별 색 / B-rep 면별 색 반영). 좌표는 mm
function buildOcctGroup(res) {
  const g = new THREE.Group();
  const matOf = new Map();
  const mat = (c) => {
    if (!c) return DEFAULT_MAT();
    const key = c.map((v) => v.toFixed(3)).join();
    if (!matOf.has(key)) matOf.set(key, new THREE.MeshStandardMaterial({ color: new THREE.Color(c[0], c[1], c[2]), metalness: 0.3, roughness: 0.6 }));
    return matOf.get(key);
  };
  for (const m of res.meshes) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
    if (m.attributes.normal) geo.setAttribute('normal', new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
    geo.setIndex(new THREE.Uint32BufferAttribute(Uint32Array.from(m.index.array), 1));
    if (!m.attributes.normal) geo.computeVertexNormals();
    let material;
    const faces = m.brep_faces || [];
    if (faces.some((f) => f.color)) {
      // 면별 색: 같은 색 면끼리 재질 1개
      const mats = [], idxOf = new Map();
      for (const f of faces) {
        const c = f.color || m.color || null, key = c ? c.join() : '-';
        if (!idxOf.has(key)) { idxOf.set(key, mats.length); mats.push(mat(c)); }
        geo.addGroup(f.first * 3, (f.last - f.first + 1) * 3, idxOf.get(key));
      }
      material = mats;
    } else material = mat(m.color);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = m.name || '';
    g.add(mesh);
  }
  return g;
}

// 모든 메시 삼각형을 루트 좌표로 모음 (간섭 메시 원본)
function collectTriangles(root) {
  root.updateMatrixWorld(true);
  const pos = [], idx = [];
  let base = 0, count = 0;
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const p = o.geometry.attributes.position, ind = o.geometry.index;
    for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); pos.push(v.x, v.y, v.z); }
    if (ind) for (let i = 0; i + 2 < ind.count; i += 3) idx.push(base + ind.getX(i), base + ind.getX(i + 1), base + ind.getX(i + 2));
    else for (let i = 0; i + 2 < p.count; i += 3) idx.push(base + i, base + i + 1, base + i + 2);
    base += p.count;
  });
  count = idx.length / 3;
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx), count };
}
