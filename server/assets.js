// 사용자 3D 모델 자산 저장소
//  - 브라우저가 원본(STL/OBJ/GLB/STEP/IGES)을 변환해 표시용 GLB + 간섭용 메시(.col)를 올린다
//    (서버는 CAD 형식을 해석하지 않음 → 의존성 없음)
//  - 저장: <루트>/assets/models/<id>.glb · <id>.col · <id>.json, id = 내용 SHA-256 앞 16자리 (같은 파일은 1번만 저장)
//  - 셀 레이아웃의 models[].asset 이 id 를 참조. 프로젝트 파일에는 id 만 들어간다
//
// 업로드 본문 (POST /api/assets, application/octet-stream):
//   [u32 헤더 길이][헤더 JSON(UTF-8)][GLB 바이트][COL 바이트]
//   헤더 = { name, format, glbBytes, colBytes, srcTris? }
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { decodeCol, buildBVH } from '../shared/meshcol.js';

export const MAX_UPLOAD = 256 * 1024 * 1024;
const ID = /^[0-9a-f]{16}$/;
export const isAssetId = (s) => typeof s === 'string' && ID.test(s);

export class AssetStore {
  constructor(dir, log = () => {}) {
    this.dir = dir;
    this.log = log;
    fs.mkdirSync(dir, { recursive: true });
    this._bvh = new Map();      // id → BVH (최근 사용 순)
  }

  file(id, ext) {
    if (!isAssetId(id)) throw new Error(`잘못된 모델 id: ${id}`);
    return path.join(this.dir, `${id}.${ext}`);
  }

  has(id) { return isAssetId(id) && fs.existsSync(this.file(id, 'json')); }

  meta(id) {
    if (!this.has(id)) return null;
    try { return JSON.parse(fs.readFileSync(this.file(id, 'json'), 'utf8')); } catch { return null; }
  }

  list() {
    return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).map((f) => this.meta(f.slice(0, -5))).filter(Boolean)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  // 업로드 본문 → 검증·저장 → 메타
  save(body) {
    if (!Buffer.isBuffer(body) || body.length < 8) throw new Error('업로드 본문이 비어 있습니다');
    const hl = body.readUInt32LE(0);
    if (hl > 64 * 1024 || 4 + hl > body.length) throw new Error('업로드 헤더가 잘못되었습니다');
    let h;
    try { h = JSON.parse(body.subarray(4, 4 + hl).toString('utf8')); } catch { throw new Error('업로드 헤더 JSON 오류'); }
    const gl = Number(h.glbBytes), cl = Number(h.colBytes);
    if (!(gl > 12) || !(cl > 16) || 4 + hl + gl + cl !== body.length) throw new Error('업로드 크기가 헤더와 맞지 않습니다');
    const glb = body.subarray(4 + hl, 4 + hl + gl), col = body.subarray(4 + hl + gl);
    if (glb.toString('latin1', 0, 4) !== 'glTF') throw new Error('표시용 모델이 GLB 형식이 아닙니다');
    const mesh = decodeCol(col);                  // 형식·인덱스 검증 (오류 시 throw)
    if (!mesh.indices.length) throw new Error('간섭 메시에 삼각형이 없습니다');
    const bvh = buildBVH(mesh.positions, mesh.indices);
    const id = crypto.createHash('sha256').update(glb).update(col).digest('hex').slice(0, 16);
    const meta = {
      id,
      name: String(h.name ?? 'model').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120),
      format: String(h.format ?? '').toLowerCase().slice(0, 10),
      bbox: bvh.bbox.map((v) => v.map((x) => +x.toFixed(4))),   // 모델 좌표(파일 단위)
      tris: mesh.indices.length / 3,
      srcTris: Number.isFinite(Number(h.srcTris)) ? Number(h.srcTris) : null,
      glbBytes: gl,
      createdAt: new Date().toISOString(),
    };
    if (!this.has(id)) {
      fs.writeFileSync(this.file(id, 'glb'), glb);
      fs.writeFileSync(this.file(id, 'col'), col);
      fs.writeFileSync(this.file(id, 'json'), JSON.stringify(meta, null, 1));
      this.log('system', `3D 모델 저장: ${meta.name} (${meta.tris.toLocaleString()} 삼각형${meta.srcTris && meta.srcTris !== meta.tris ? `, 원본 ${meta.srcTris.toLocaleString()}` : ''})`);
    } else Object.assign(meta, this.meta(id));
    this._bvh.set(id, bvh);
    this._trim();
    return meta;
  }

  // 간섭용 BVH (캐시). 파일 없으면 null
  collider(id) {
    if (this._bvh.has(id)) { const b = this._bvh.get(id); this._bvh.delete(id); this._bvh.set(id, b); return b; }
    if (!this.has(id)) return null;
    try {
      const m = decodeCol(fs.readFileSync(this.file(id, 'col')));
      const b = buildBVH(m.positions, m.indices);
      this._bvh.set(id, b);
      this._trim();
      return b;
    } catch (e) {
      this.log('alarm', `3D 모델 간섭 메시 읽기 실패 (${id}): ${e.message}`);
      return null;
    }
  }

  _trim() { while (this._bvh.size > 32) this._bvh.delete(this._bvh.keys().next().value); }

  remove(id) {
    for (const ext of ['glb', 'col', 'json']) { try { fs.unlinkSync(this.file(id, ext)); } catch { /* 없음 */ } }
    this._bvh.delete(id);
  }
}
