// 안전 영역(SafeZone) 및 간섭 구역(Interference / World Zone) 정의·검사 (서버·브라우저 공용)
//  - kind: 'interference' (진입 시 지정 DO 출력 — 프레스/컨베이어 인터록) | 'safe' (진입 금지 구역 — 즉시 정지 + SAFE_ZONE 알람)
//  - shape: 'box' (중심 p[x,y,z], 크기 size[w,d,h] mm) | 'cylinder' (중심 p[x,y,z], 지름 size[0], 높이 size[2] mm)
import { jointFrames, fkTcp } from './kinematics.js';

export const MAX_ZONES = 16;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

export function normalizeZones(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const used = new Set();
  for (const z of list.slice(0, MAX_ZONES)) {
    if (!z || typeof z !== 'object') continue;
    let id = String(z.id || '').replace(/[^\w-]/g, '').slice(0, 24) || `zone${out.length + 1}`;
    while (used.has(id)) id += '_';
    used.add(id);
    const kind = z.kind === 'safe' ? 'safe' : 'interference';
    const shape = z.shape === 'cylinder' ? 'cylinder' : 'box';
    const p = Array.isArray(z.p) ? [num(z.p[0], 400), num(z.p[1], 0), num(z.p[2], 200)] : [num(z.x, 400), num(z.y, 0), num(z.z, 200)];
    const rawSize = Array.isArray(z.size) ? z.size : [z.w, z.d, z.h];
    const size = [
      Math.max(20, Math.min(10000, num(rawSize[0], 300))),
      Math.max(20, Math.min(10000, num(rawSize[1], shape === 'cylinder' ? num(rawSize[0], 300) : 300))),
      Math.max(20, Math.min(10000, num(rawSize[2], 300))),
    ];
    out.push({
      id,
      name: String(z.name || (kind === 'safe' ? `SafeZone ${out.length + 1}` : `Zone ${out.length + 1}`)).trim().slice(0, 32),
      kind,
      shape,
      enabled: z.enabled !== false,
      p,
      size,
      outDO: clampInt(z.outDO, 0, 512, kind === 'interference' ? 30 + out.length : 0),
      invertDO: !!z.invertDO,
    });
  }
  return out;
}

export function pointInZone(pt, z) {
  if (!pt || !z) return false;
  const dx = pt[0] - z.p[0];
  const dy = pt[1] - z.p[1];
  const dz = pt[2] - z.p[2];
  if (Math.abs(dz) > z.size[2] / 2) return false;
  if (z.shape === 'cylinder') {
    const r = z.size[0] / 2;
    return dx * dx + dy * dy <= r * r;
  }
  return Math.abs(dx) <= z.size[0] / 2 && Math.abs(dy) <= z.size[1] / 2;
}

// 로봇 주요 지점(TCP · 플랜지 · 손목 J5 · 팔꿈치 J3) 중 하나라도 구역 안에 들어가면 true
export function robotInZone(robot, joints, tool, z) {
  if (!z?.enabled || !robot || !joints) return false;
  const tcp = fkTcp(robot, joints, tool, null).p;
  if (pointInZone(tcp, z)) return true;
  const F = jointFrames(robot, joints);
  // F[6]=플랜지, F[5]=손목 중심, F[3]=팔꿈치
  return pointInZone(F[6].p, z) || pointInZone(F[5].p, z) || pointInZone(F[3].p, z);
}
