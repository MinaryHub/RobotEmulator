// 티칭 보조 유틸리티 (브라우저 UI · 서버 · 테스트 공용)
//  - computeUserFrame3Pt: 3점(원점, +X, +XY)으로 User Frame [x, y, z, rx, ry, rz] 계산
//  - extractPointAtLine: 커서 줄(또는 참조 심볼)의 목표 위치(pose/joints) 추출 (Go To Point)
//  - touchUpAtLine: 커서 줄(또는 참조 심볼)의 좌표만 현재 로봇 위치로 덮어쓰기 (Touch-Up)
import { sub, cross, norm, scale } from './math.js';
import { xyzrpyFromFrame } from './poseformat.js';
import { toOpw, wristCenter } from './kinematics.js';

const NUM = '-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?';
const fN = (v, d = 3) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);
const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

// ---------------------------------------------------------------- 3점 User Frame 계산
// origin, xPoint, xyPoint: 로봇 베이스 기준 TCP 위치 [x, y, z] (mm)
// 반환: [x, y, z, rx, ry, rz] (mm, deg — frameFromXYZRPY 규약)
export function computeUserFrame3Pt(origin, xPoint, xyPoint) {
  const pts = [origin, xPoint, xyPoint];
  for (const p of pts) {
    if (!Array.isArray(p) || p.length < 3 || !p.slice(0, 3).every(Number.isFinite)) {
      throw new Error('3점 좌표는 각각 [x, y, z] 숫자 3개가 필요합니다');
    }
  }
  const p0 = origin.slice(0, 3).map(Number);
  const px = xPoint.slice(0, 3).map(Number);
  const pxy = xyPoint.slice(0, 3).map(Number);
  const dx = sub(px, p0);
  const lx = norm(dx);
  if (lx < 1) throw new Error('원점과 +X 점의 거리가 너무 가깝습니다 (1 mm 이상 필요)');
  const vx = scale(dx, 1 / lx);
  const dxy = sub(pxy, p0);
  const dz = cross(vx, dxy);
  const lz = norm(dz);
  if (lz < 1e-3) throw new Error('세 점이 일직선상에 있어 평면을 정의할 수 없습니다');
  const vz = scale(dz, 1 / lz);
  const vy = cross(vz, vx);
  const R = [
    [vx[0], vy[0], vz[0]],
    [vx[1], vy[1], vz[1]],
    [vx[2], vy[2], vz[2]],
  ];
  return xyzrpyFromFrame({ p: p0, R }).map((v, i) => Number(fN(v, i < 3 ? 3 : 4)));
}

// ---------------------------------------------------------------- 공통 헬퍼
function splitLines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
}

function parseNums(str) {
  return str.split(',').map((s) => Number(s.trim()));
}

// Yaskawa .JBI 에서 특정 라인까지의 유효 POSTYPE 추적
function yaskawaPostypeAt(lines, targetIdx) {
  let postype = 'PULSE';
  for (let i = 0; i <= targetIdx && i < lines.length; i++) {
    const u = lines[i].trim().toUpperCase();
    if (!u.startsWith('///')) continue;
    const m = /^\/\/\/(\w+)\s*(.*)$/.exec(u);
    if (!m) continue;
    if (m[1] === 'POSTYPE') postype = m[2].trim();
    else if (m[1] === 'PULSE') postype = 'PULSE';
    else if (m[1] === 'RECTAN' && postype === 'PULSE') postype = 'BASE';
  }
  return postype;
}

// KRL 구조체 {X ..., Y ..., Z ..., A ..., B ..., C ...} 또는 {A1 ..., ..., A6 ...}
function matchKrlStruct(line) {
  const re = /\{([^{}]+)\}/g;
  let m;
  while ((m = re.exec(line))) {
    const body = m[1];
    const fields = {};
    const fre = /\b([A-Za-z_]\w*)\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
    let fm;
    while ((fm = fre.exec(body))) fields[fm[1].toUpperCase()] = Number(fm[2]);
    if (['X', 'Y', 'Z', 'A', 'B', 'C'].every((k) => k in fields)) {
      return { kind: 'pose', match: m, fields, values: [fields.X, fields.Y, fields.Z, fields.A, fields.B, fields.C] };
    }
    if (['A1', 'A2', 'A3', 'A4', 'A5', 'A6'].every((k) => k in fields)) {
      return { kind: 'joints', match: m, fields, values: [fields.A1, fields.A2, fields.A3, fields.A4, fields.A5, fields.A6] };
    }
  }
  return null;
}

function krlStatusTurn(robot, joints) {
  if (!Array.isArray(joints) || joints.length < 6) return null;
  let T = 0;
  for (let i = 0; i < 6; i++) if (joints[i] < 0) T |= 1 << i;
  let S = null;
  if (robot?.opw) {
    const q = toOpw(robot, joints);
    const wc = wristCenter(robot, joints);
    const x1 = wc[0] * Math.cos(q[0]) + wc[1] * Math.sin(q[0]);
    const e = (q[2] + Math.atan2(robot.opw.a2, robot.opw.c3)) * RAD_TO_DEG;
    S = (x1 < 0 ? 1 : 0) | (e >= 0 ? 2 : 0) | (joints[4] <= 0 ? 4 : 0);
  }
  return { S, T };
}

function replaceKrlStruct(line, info, vals, { joints = null, robot = null } = {}) {
  const keys = info.kind === 'pose' ? ['X', 'Y', 'Z', 'A', 'B', 'C'] : ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'];
  const map = Object.fromEntries(keys.map((k, i) => [k, fN(vals[i], 3)]));
  if (info.kind === 'pose' && joints && robot?.opw) {
    const st = krlStatusTurn(robot, joints);
    if (st) {
      if (st.S !== null && 'S' in info.fields) map.S = String(st.S);
      if ('T' in info.fields) map.T = String(st.T);
    }
  }
  const oldBlock = info.match[0];
  const newBlock = oldBlock.replace(/\b([A-Za-z_]\w*)\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (full, k) => {
    const uk = k.toUpperCase();
    return uk in map ? `${k} ${map[uk]}` : full;
  });
  return line.slice(0, info.match.index) + newBlock + line.slice(info.match.index + oldBlock.length);
}

// 파일 목록에서 심볼 정의 줄 찾기 (현재 파일 → 동명 .dat 쌍 → 나머지 보조 파일 순)
function findDefAcross(fileName, text, files, matcher) {
  const searchOne = (fn, src) => {
    const lines = splitLines(src);
    for (let i = 0; i < lines.length; i++) {
      const hit = matcher(lines[i], i, lines);
      if (hit) return { file: fn, lines, lineIdx: i, hit };
    }
    return null;
  };
  const primary = searchOne(fileName, text);
  if (primary) return primary;
  if (files && typeof files === 'object') {
    const stem = String(fileName || '').replace(/\.[^.]+$/, '').toLowerCase();
    const entries = Object.entries(files).filter(([fn, src]) => fn !== fileName && typeof src === 'string');
    entries.sort((a, b) => {
      const aMatch = stem && a[0].toLowerCase() === `${stem}.dat` ? 0 : 1;
      const bMatch = stem && b[0].toLowerCase() === `${stem}.dat` ? 0 : 1;
      return aMatch - bMatch;
    });
    for (const [fn, src] of entries) {
      const found = searchOne(fn, src);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------- 포인트 위치 해석 (공통)
function locatePoint({ vendor, text, fileName = '', files = null, cursorLine, robot = null }) {
  const lines = splitLines(text);
  const idx = Math.max(0, Math.min(lines.length - 1, (Number(cursorLine) || 1) - 1));
  const line = lines[idx] ?? '';
  const ppd = robot?.pulsePerDeg || [1000, 1000, 1000, 1000, 1000, 1000];

  switch (vendor) {
    case 'yaskawa': {
      // 1) 커서가 직접 C00000=... 줄에 있는 경우
      const direct = /^(\s*C(\d+)\s*=\s*)(.+)$/i.exec(line);
      let targetIdx = idx, label = null;
      if (direct) {
        label = `C${direct[2]}`;
      } else {
        // 2) 커서가 MOVJ/MOVL/MOVC/MOVS C00000 줄에 있는 경우 → //POS 에서 찾기
        const mv = /\bMOV[JLCS]\s+(C\d+)\b/i.exec(line);
        if (!mv) return { ok: false, reason: '커서 줄에 수정 가능한 C 포인트(MOVJ/MOVL Cxxxxx 또는 Cxxxxx=)가 없습니다' };
        label = mv[1].toUpperCase();
        const re = new RegExp(`^\\s*${label}\\s*=\\s*(.+)$`, 'i');
        targetIdx = lines.findIndex((l) => re.test(l));
        if (targetIdx < 0) return { ok: false, reason: `//POS 영역에서 ${label} 정의를 찾을 수 없습니다` };
      }
      const m = /^(\s*C\d+\s*=\s*)(.+)$/i.exec(lines[targetIdx]);
      const nums = parseNums(m[2]);
      if (nums.length < 6 || nums.slice(0, 6).some((v) => !Number.isFinite(v))) {
        return { ok: false, reason: `${label} 좌표 숫자 6개를 읽을 수 없습니다` };
      }
      const postype = yaskawaPostypeAt(lines, targetIdx);
      const isPulse = postype === 'PULSE';
      return {
        ok: true, file: fileName, lines, lineIdx: targetIdx, label,
        kind: isPulse ? 'joints' : 'pose',
        values: isPulse ? nums.slice(0, 6).map((v, i) => v / ppd[i]) : nums.slice(0, 6),
        formatUpdate: ({ tcp, joints }) => {
          const vals = isPulse
            ? joints.map((d, i) => String(Math.round(d * ppd[i])))
            : tcp.map((v, i) => fN(v, i < 3 ? 3 : 4));
          return `${m[1]}${vals.join(',')}`;
        },
      };
    }

    case 'kawasaki': {
      const parseLine = (l) => {
        const tm = new RegExp(`(TRANS\\s*\\()([^)]*)(\\))`, 'i').exec(l);
        if (tm) {
          const nums = parseNums(tm[2]);
          if (nums.length >= 6 && nums.slice(0, 6).every(Number.isFinite)) {
            return { kind: 'pose', values: nums.slice(0, 6), replace: (tcp) => l.slice(0, tm.index) + `${tm[1]}${tcp.slice(0, 6).map((v) => fN(v, 3)).join(', ')}${tm[3]}` + l.slice(tm.index + tm[0].length) };
          }
        }
        const jm = new RegExp(`(#\\s*\\()([^)]*)(\\))`).exec(l);
        if (jm) {
          const nums = parseNums(jm[2]);
          if (nums.length >= 6 && nums.slice(0, 6).every(Number.isFinite)) {
            return { kind: 'joints', values: nums.slice(0, 6), replace: (_tcp, j) => l.slice(0, jm.index) + `${jm[1]}${j.slice(0, 6).map((v) => fN(v, 3)).join(', ')}${jm[3]}` + l.slice(jm.index + jm[0].length) };
          }
        }
        return null;
      };
      const direct = parseLine(line);
      if (direct) {
        return { ok: true, file: fileName, lines, lineIdx: idx, label: `Ln ${idx + 1}`, kind: direct.kind, values: direct.values, formatUpdate: ({ tcp, joints }) => direct.replace(tcp, joints) };
      }
      const ref = /\b(?:JMOVE|LMOVE|JAPPRO|LAPPRO|JDEPART|LDEPART|C1MOVE|C2MOVE)\s+(#?[A-Za-z_]\w*)/i.exec(line);
      if (ref) {
        const sym = ref[1];
        const escSym = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const found = findDefAcross(fileName, text, files, (l) => {
          const def = new RegExp(`^\\s*(?:POINT\\s+)?${escSym}\\s*=\\s*(.+)$`, 'i').exec(l);
          if (def) return parseLine(l);
          // .TRANS 섹션: sym x y z o a t
          const tr = new RegExp(`^(\\s*${escSym}\\s+)(${NUM}(?:\\s+${NUM}){5})(.*)$`, 'i').exec(l);
          if (tr) {
            const nums = tr[2].trim().split(/\s+/).map(Number);
            if (nums.length === 6 && nums.every(Number.isFinite)) {
              const isJ = sym.startsWith('#');
              return { kind: isJ ? 'joints' : 'pose', values: nums, replace: (tcp, j) => `${tr[1]}${(isJ ? j : tcp).slice(0, 6).map((v) => fN(v, 3)).join(' ')}${tr[3]}` };
            }
          }
          return null;
        });
        if (found) {
          return { ok: true, file: found.file, lines: found.lines, lineIdx: found.lineIdx, label: sym, kind: found.hit.kind, values: found.hit.values, formatUpdate: ({ tcp, joints }) => found.hit.replace(tcp, joints) };
        }
      }
      return { ok: false, reason: '커서 줄에 TRANS(...) / #(...) 또는 포인트 정의를 찾을 수 없습니다' };
    }

    case 'hyundai': {
      const parseLine = (l) => {
        // 1) 중괄호 포즈/관절: P1={450, 0, 300, 180, 0, 0, "base"} 또는 {0, -30, 60, 0, 60, 0, "axis"}
        const bm = new RegExp(`(\\{\\s*)(${NUM}\\s*(?:,\\s*${NUM}\\s*){5})([^}]*)(\\})`).exec(l);
        if (bm) {
          const nums = parseNums(bm[2]);
          if (nums.length === 6 && nums.every(Number.isFinite)) {
            const tail = bm[3] || '';
            const isAxis = /["']axis["']/i.test(tail);
            return {
              kind: isAxis ? 'joints' : 'pose',
              values: nums,
              replace: (tcp, joints) => {
                const v = isAxis ? joints : tcp;
                return l.slice(0, bm.index) + `${bm[1]}${v.slice(0, 6).map((x) => fN(x, 3)).join(', ')}${tail}${bm[4]}` + l.slice(bm.index + bm[0].length);
              },
            };
          }
        }
        // 2) 괄호 인라인 포즈: MOVE L,(450,0,300,180,0,0),S=250mm/sec
        const m = new RegExp(`(\\(\\s*)(${NUM}\\s*(?:,\\s*${NUM}\\s*){5})(\\))`).exec(l);
        if (m) {
          const nums = parseNums(m[2]);
          if (nums.length === 6 && nums.every(Number.isFinite)) {
            return { kind: 'pose', values: nums, replace: (tcp) => l.slice(0, m.index) + `${m[1]}${tcp.slice(0, 6).map((v) => fN(v, 3)).join(',')}${m[3]}` + l.slice(m.index + m[0].length) };
          }
        }
        return null;
      };
      const direct = parseLine(line);
      if (direct) return { ok: true, file: fileName, lines, lineIdx: idx, label: `Ln ${idx + 1}`, kind: direct.kind, values: direct.values, formatUpdate: ({ tcp, joints }) => direct.replace(tcp, joints) };
      const ref = /\bMOVE\s+[PLCS]\s*,\s*([A-Za-z_]\w*)/i.exec(line);
      if (ref) {
        const sym = ref[1];
        const found = findDefAcross(fileName, text, files, (l) => {
          if (new RegExp(`^\\s*(?:VAR\\s+)?${sym}\\s*=`, 'i').test(l)) return parseLine(l);
          return null;
        });
        if (found) return { ok: true, file: found.file, lines: found.lines, lineIdx: found.lineIdx, label: sym, kind: found.hit.kind, values: found.hit.values, formatUpdate: ({ tcp, joints }) => found.hit.replace(tcp, joints) };
      }
      return { ok: false, reason: '커서 줄에 (X,Y,Z,Rx,Ry,Rz) 또는 {X,Y,Z,Rx,Ry,Rz,"base"} 좌표를 찾을 수 없습니다' };
    }

    case 'abb': {
      const parseLine = (l) => {
        // robtarget: [[x,y,z],[q1,q2,q3,q4],[cf1,cf4,cf6,cfx],[e1..e6]]
        const rm = /\[\s*\[([^\]]+)\]\s*,\s*\[([^\]]+)\]\s*,\s*\[([^\]]+)\]\s*,\s*\[([^\]]+)\]\s*\]/.exec(l);
        if (rm) {
          const p = parseNums(rm[1]), q = parseNums(rm[2]);
          if (p.length === 3 && q.length === 4 && [...p, ...q].every(Number.isFinite)) {
            return {
              kind: 'pose',
              values: [...p, ...q],
              replace: (tcp, joints) => {
                const cf = [0, 3, 5].map((i) => Math.floor(joints[i] / 90));
                const rep = `[[${tcp.slice(0, 3).map((v) => fN(v, 3)).join(',')}],[${tcp.slice(3, 7).map((v) => fN(v, 6)).join(',')}],[${cf.join(',')},0],[${rm[4]}]]`;
                return l.slice(0, rm.index) + rep + l.slice(rm.index + rm[0].length);
              },
            };
          }
        }
        // jointtarget: [[j1..j6],[e1..e6]]
        const jm = /\[\s*\[([^\]]+)\]\s*,\s*\[([^\]]+)\]\s*\]/.exec(l);
        if (jm) {
          const j = parseNums(jm[1]);
          if (j.length === 6 && j.every(Number.isFinite)) {
            return {
              kind: 'joints',
              values: j,
              replace: (_tcp, joints) => {
                const rep = `[[${joints.slice(0, 6).map((v) => fN(v, 3)).join(',')}],[${jm[2]}]]`;
                return l.slice(0, jm.index) + rep + l.slice(jm.index + jm[0].length);
              },
            };
          }
        }
        return null;
      };
      const direct = parseLine(line);
      if (direct) return { ok: true, file: fileName, lines, lineIdx: idx, label: `Ln ${idx + 1}`, kind: direct.kind, values: direct.values, formatUpdate: ({ tcp, joints }) => direct.replace(tcp, joints) };
      // MoveL pPick, ... (Offs/RelTool 은 베이스 타깃 보호를 위해 제외)
      const ref = /\b(?:MoveJ|MoveL|MoveAbsJ|MoveC)\s+([A-Za-z_]\w*)\s*,/i.exec(line);
      if (ref && !/^(Offs|RelTool)$/i.test(ref[1])) {
        const sym = ref[1];
        const found = findDefAcross(fileName, text, files, (l) => {
          if (new RegExp(`\\b${sym}\\s*:=`, 'i').test(l)) return parseLine(l);
          return null;
        });
        if (found) return { ok: true, file: found.file, lines: found.lines, lineIdx: found.lineIdx, label: sym, kind: found.hit.kind, values: found.hit.values, formatUpdate: ({ tcp, joints }) => found.hit.replace(tcp, joints) };
      }
      return { ok: false, reason: '커서 줄에 robtarget/jointtarget 좌표를 찾을 수 없습니다 (Offs/RelTool 식은 원본 포인트 줄에서 수정)' };
    }

    case 'kuka': {
      const direct = matchKrlStruct(line);
      if (direct) {
        return {
          ok: true, file: fileName, lines, lineIdx: idx, label: `Ln ${idx + 1}`,
          kind: direct.kind, values: direct.values,
          formatUpdate: ({ tcp, joints }) => replaceKrlStruct(line, direct, direct.kind === 'pose' ? tcp : joints, { joints, robot }),
        };
      }
      // 1) KSS 인라인 폼 ;FOLD PTP P1 ... / ;FOLD LIN P2 ... → XP1 (또는 P1) 조회
      const fold = /^\s*;\s*FOLD\s+(?:S?PTP|S?LIN|S?CIRC)\s+([A-Za-z_]\w*)\b/i.exec(line);
      const ref = fold ? null : /\b(?:S?PTP|S?LIN|S?CIRC)\s+([A-Za-z_]\w*)\b/i.exec(line);
      const rawSym = fold?.[1] || ref?.[1];
      if (rawSym && !/^(HOME)$/i.test(rawSym)) {
        const candidates = fold ? [`X${rawSym}`, rawSym] : [rawSym];
        for (const sym of candidates) {
          const found = findDefAcross(fileName, text, files, (l) => {
            if (new RegExp(`\\b${sym}\\s*=\\s*\\{`, 'i').test(l)) return matchKrlStruct(l);
            return null;
          });
          if (found) {
            return {
              ok: true, file: found.file, lines: found.lines, lineIdx: found.lineIdx, label: sym,
              kind: found.hit.kind, values: found.hit.values,
              formatUpdate: ({ tcp, joints }) => replaceKrlStruct(found.lines[found.lineIdx], found.hit, found.hit.kind === 'pose' ? tcp : joints, { joints, robot }),
            };
          }
        }
      }
      return { ok: false, reason: '커서 줄에 KRL 좌표 구조체 {X..,Y..,Z..,A..,B..,C..} 또는 {A1..A6}를 찾을 수 없습니다' };
    }

    case 'doosan': {
      const parseLine = (l) => {
        const pm = /(posx\s*\()([^)]*)(\))/i.exec(l);
        if (pm) {
          const nums = parseNums(pm[2]);
          if (nums.length >= 6 && nums.slice(0, 6).every(Number.isFinite)) {
            return { kind: 'pose', values: nums.slice(0, 6), replace: (tcp) => l.slice(0, pm.index) + `${pm[1]}${tcp.slice(0, 6).map((v) => fN(v, 3)).join(', ')}${pm[3]}` + l.slice(pm.index + pm[0].length) };
          }
        }
        const jm = /(posj\s*\()([^)]*)(\))/i.exec(l);
        if (jm) {
          const nums = parseNums(jm[2]);
          if (nums.length >= 6 && nums.slice(0, 6).every(Number.isFinite)) {
            return { kind: 'joints', values: nums.slice(0, 6), replace: (_tcp, j) => l.slice(0, jm.index) + `${jm[1]}${j.slice(0, 6).map((v) => fN(v, 3)).join(', ')}${jm[3]}` + l.slice(jm.index + jm[0].length) };
          }
        }
        return null;
      };
      const direct = parseLine(line);
      if (direct) return { ok: true, file: fileName, lines, lineIdx: idx, label: `Ln ${idx + 1}`, kind: direct.kind, values: direct.values, formatUpdate: ({ tcp, joints }) => direct.replace(tcp, joints) };
      const ref = /\b(?:movel|movej|movejx|amovel|amovej)\s*\(\s*([A-Za-z_]\w*)\b/i.exec(line);
      if (ref && !/^(posx|posj|trans)$/i.test(ref[1])) {
        const sym = ref[1];
        const found = findDefAcross(fileName, text, files, (l) => {
          if (new RegExp(`^\\s*${sym}\\s*=`, 'i').test(l)) return parseLine(l);
          return null;
        });
        if (found) return { ok: true, file: found.file, lines: found.lines, lineIdx: found.lineIdx, label: sym, kind: found.hit.kind, values: found.hit.values, formatUpdate: ({ tcp, joints }) => found.hit.replace(tcp, joints) };
      }
      return { ok: false, reason: '커서 줄에 posx(...) 또는 posj(...) 좌표를 찾을 수 없습니다' };
    }

    case 'ur': {
      const parseLine = (l) => {
        // URScript p[x_m, y_m, z_m, rx_rad, ry_rad, rz_rad]
        const pm = /(p\s*\[)([^\]]*)(\])/.exec(l);
        if (pm) {
          const nums = parseNums(pm[2]);
          if (nums.length === 6 && nums.every(Number.isFinite)) {
            // st.tcp (mm, rad) 규약으로 변환하여 반환
            const valsMm = [nums[0] * 1000, nums[1] * 1000, nums[2] * 1000, nums[3], nums[4], nums[5]];
            return {
              kind: 'pose', values: valsMm,
              replace: (tcp) => {
                const urVals = tcp.slice(0, 6).map((v, i) => (i < 3 ? +fN(v / 1000, 5) : +fN(v, 5)));
                return l.slice(0, pm.index) + `${pm[1]}${urVals.join(', ')}${pm[3]}` + l.slice(pm.index + pm[0].length);
              },
            };
          }
        }
        // movej([j1_rad..j6_rad], ...) 또는 var = [j1..j6]
        const jm = /(\[)([^\]]*)(\])/.exec(l);
        if (jm && !/p\s*\[/.test(l.slice(Math.max(0, jm.index - 2), jm.index + 2))) {
          const nums = parseNums(jm[2]);
          if (nums.length === 6 && nums.every(Number.isFinite)) {
            return {
              kind: 'joints', values: nums.map((r) => r * RAD_TO_DEG),
              replace: (_tcp, j) => {
                const rads = j.slice(0, 6).map((d) => +fN(d * DEG_TO_RAD, 5));
                return l.slice(0, jm.index) + `${jm[1]}${rads.join(', ')}${jm[3]}` + l.slice(jm.index + jm[0].length);
              },
            };
          }
        }
        return null;
      };
      const direct = parseLine(line);
      if (direct) return { ok: true, file: fileName, lines, lineIdx: idx, label: `Ln ${idx + 1}`, kind: direct.kind, values: direct.values, formatUpdate: ({ tcp, joints }) => direct.replace(tcp, joints) };
      const ref = /\b(?:movel|movej|movep)\s*\(\s*([A-Za-z_]\w*)\b/.exec(line);
      if (ref) {
        const sym = ref[1];
        const found = findDefAcross(fileName, text, files, (l) => {
          if (new RegExp(`^\\s*(?:global\\s+|local\\s+)?${sym}\\s*=`).test(l)) return parseLine(l);
          return null;
        });
        if (found) return { ok: true, file: found.file, lines: found.lines, lineIdx: found.lineIdx, label: sym, kind: found.hit.kind, values: found.hit.values, formatUpdate: ({ tcp, joints }) => found.hit.replace(tcp, joints) };
      }
      return { ok: false, reason: '커서 줄에 p[...] 또는 관절 배열 [j1..j6] 좌표를 찾을 수 없습니다' };
    }

    default:
      return { ok: false, reason: `지원하지 않는 제조사: ${vendor}` };
  }
}

export function extractPointAtLine(opts) {
  const r = locatePoint(opts);
  if (!r.ok) return r;
  return { ok: true, file: r.file, line: r.lineIdx + 1, label: r.label, kind: r.kind, values: r.values };
}

export function touchUpAtLine(opts) {
  const { tcp, joints } = opts;
  if (!Array.isArray(tcp) || !Array.isArray(joints) || joints.length < 6) {
    return { ok: false, reason: '현재 로봇 위치 정보가 없습니다' };
  }
  const r = locatePoint(opts);
  if (!r.ok) return r;
  const nextLines = [...r.lines];
  nextLines[r.lineIdx] = r.formatUpdate({ tcp, joints });
  return {
    ok: true,
    file: r.file,
    line: r.lineIdx + 1,
    label: r.label,
    kind: r.kind,
    text: nextLines.join('\n'),
  };
}
