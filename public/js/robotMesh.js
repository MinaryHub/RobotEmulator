// 6축 수직다관절 로봇의 절차적 3D 형상 (OPW 파라미터 기반, 단위 mm)
//
// 각 링크 그룹 L[i] 의 로컬 좌표계는 shared/kinematics.js jointFrames()[i] 와 동일하다.
//  L0 베이스      : 바닥 원점, +Z 위
//  L1 선회부(J1)  : Z축 회전. J2 축은 (a1, b, c1) 에서 로컬 Y 방향
//  L2 하완(J2)    : 원점 = J2 축, 회전축 Y, 팔은 +Z 로 c2 만큼 → J3 축
//  L3 엘보(J3)    : 원점 = J3 축, 회전축 Y. J4 축은 x = a2 에서 +Z 방향
//  L4 상완(J4)    : 원점 = J4 축 시작점, 회전축 Z, +Z 로 c3 만큼 → 손목 중심
//  L5 손목(J5)    : 원점 = 손목 중심, 회전축 Y, +Z 로 c4 만큼 → 플랜지 면
//  L6 플랜지(J6)  : 원점 = 플랜지 면(z=0), 회전축 Z, 툴은 +Z 쪽에 붙는다
//
// 외형: 회전체(LatheGeometry, 모서리 필렛), 볼록 껍질 측면 윤곽을 베벨 압출한 주물 형상,
// 서보모터(라운드 사각 + 냉각핀 + 엔드캡), 케이블 하네스(관절 축 위의 점끼리 연결 → 어떤 자세에서도 끊기지 않음),
// 대형 모델은 J2 밸런서(매 프레임 두 링크 사이 피벗을 따라감).
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const PI = Math.PI;
const V2 = (x, y) => new THREE.Vector2(x, y);
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

// ------------------------------------------------------------------ 재질
const paint = (color, o = {}) => new THREE.MeshPhysicalMaterial({
  color, roughness: 0.36, metalness: 0.05, clearcoat: 0.55, clearcoatRoughness: 0.22, ...o,
});
const metal = (color, o = {}) => new THREE.MeshStandardMaterial({ color, metalness: 0.85, roughness: 0.3, ...o });
const plastic = (color, o = {}) => new THREE.MeshStandardMaterial({ color, metalness: 0.0, roughness: 0.75, ...o });

// 제조사별 색/형상 성향 (로고·문자 없음 — 색 배치와 비례만 흉내)
function vendorStyle(vendorId, vendor) {
  const body = vendor.color, acc = vendor.accent;
  const S = {
    yaskawa: { base: body, cap: 0x2d3238, seam: 0x16181b, motor: body, motorCap: 0x2a2e33, rearCyl: true, armT: 0.92, bevel: 0.22, fork: true },
    kawasaki: { base: 0x3c3e42, cap: acc, seam: 0x1b1b1b, motor: 0x34373b, motorCap: 0x1e1f21, rearCyl: false, armT: 0.9, bevel: 0.2, fork: true },
    hyundai: { base: body, cap: acc, seam: acc, motor: 0x3a3f46, motorCap: acc, rearCyl: true, armT: 0.9, bevel: 0.2, fork: true },
    abb: { base: body, cap: 0xdcdcd8, seam: 0x2a2c2f, motor: acc, motorCap: 0x34373b, rearCyl: true, armT: 0.8, bevel: 0.24, fork: true },
    kuka: { base: acc, cap: 0x222222, seam: 0x111111, motor: 0x1f2022, motorCap: 0x9da3aa, rearCyl: false, armT: 0.95, bevel: 0.14, fork: true },
  };
  return S[vendorId] || S.abb;
}

// ------------------------------------------------------------------ 형상 유틸
function mesh(geom, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geom, mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

// 압출 형상의 법선을 매끄럽게 (베벨로 모든 모서리가 둥글기 때문에 전체 스무딩이 자연스럽다)
function smooth(g) {
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  const m = mergeVertices(g, 1e-3);
  m.computeVertexNormals();
  g.dispose();
  return m;
}

// 폴리라인 꼭짓점을 2차 베지어 필렛으로 둥글게. pts: [[x, y, filletR?]], 첫/끝 점은 그대로
function roundPoly(pts, defR = 0, seg = 3) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const P = pts[i], rr = P[2] ?? defR;
    if (i === 0 || i === pts.length - 1 || rr <= 0) { out.push([P[0], P[1]]); continue; }
    const A = pts[i - 1], B = pts[i + 1];
    const la = Math.hypot(A[0] - P[0], A[1] - P[1]), lb = Math.hypot(B[0] - P[0], B[1] - P[1]);
    const d = Math.min(rr, la * 0.5, lb * 0.5);
    if (d < 1e-6) { out.push([P[0], P[1]]); continue; }
    const p1 = [P[0] + (A[0] - P[0]) / la * d, P[1] + (A[1] - P[1]) / la * d];
    const p2 = [P[0] + (B[0] - P[0]) / lb * d, P[1] + (B[1] - P[1]) / lb * d];
    for (let s = 0; s <= seg; s++) {
      const t = s / seg, u = 1 - t;
      out.push([u * u * p1[0] + 2 * u * t * P[0] + t * t * p2[0], u * u * p1[1] + 2 * u * t * P[1] + t * t * p2[1]]);
    }
  }
  return out;
}

// 회전체: prof = [[반지름, 축방향 위치, 필렛?]] (축 → 바깥 → 축 순서, 축방향 증가)
function latheY(prof, seg = 48, defR = 0) {
  return new THREE.LatheGeometry(roundPoly(prof, defR).map(([r, h]) => V2(Math.max(0, r), h)), seg);
}
function latheZ(prof, seg = 48, defR = 0) {
  const g = latheY(prof, seg, defR);
  g.rotateX(PI / 2); // 높이(Y) → Z
  return g;
}
// 모서리를 둥글린 원통 (축 Z / Y)
const roundCylZ = (rad, z0, z1, f = 0, seg = 48) => latheZ([[0, z0], [rad, z0, f], [rad, z1, f], [0, z1]], seg);
const roundCylY = (rad, y0, y1, f = 0, seg = 48) => latheY([[0, y0], [rad, y0, f], [rad, y1, f], [0, y1]], seg);

// 여러 원의 볼록 껍질 → Shape (측면 윤곽). circles: [[x, y, r]]
function hullShape(circles, n = 28) {
  const pts = [];
  for (const [cx, cy, r] of circles) for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * PI;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop(); upper.push(p); }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  return new THREE.Shape(hull.map(([x, y]) => V2(x, y)));
}
function rrectShape(w, h, rad, cx = 0, cy = 0) {
  const s = new THREE.Shape();
  const x0 = cx - w / 2, y0 = cy - h / 2, r = Math.min(rad, w / 2, h / 2);
  s.moveTo(x0 + r, y0);
  s.lineTo(x0 + w - r, y0); s.absarc(x0 + w - r, y0 + r, r, -PI / 2, 0, false);
  s.lineTo(x0 + w, y0 + h - r); s.absarc(x0 + w - r, y0 + h - r, r, 0, PI / 2, false);
  s.lineTo(x0 + r, y0 + h); s.absarc(x0 + r, y0 + h - r, r, PI / 2, PI, false);
  s.lineTo(x0, y0 + r); s.absarc(x0 + r, y0 + r, r, PI, 1.5 * PI, false);
  return s;
}

// Shape(XY) 를 Z 방향 [z0, z1] 로 베벨 압출
function extrudeZ(shape, z0, z1, bevel, curveSegments = 5) {
  const bt = Math.max(0.01, Math.min(bevel, (z1 - z0) * 0.45));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.01, z1 - z0 - 2 * bt), bevelEnabled: true, bevelThickness: bt, bevelSize: bt,
    bevelOffset: -bt, bevelSegments: 3, curveSegments,
  });
  g.translate(0, 0, z0 + bt);
  return g;
}
// Shape(XZ 평면: shape.x → x, shape.y → z) 를 Y 방향 [y0, y1] 로 베벨 압출. taper(z) → y 두께 배율(안쪽 면 yFix 고정)
function slabY(shape, y0, y1, bevel, taper, yFix = (y0 + y1) / 2) {
  const g = extrudeZ(shape, 0, y1 - y0, bevel);
  g.rotateX(PI / 2);            // (x, y, z) → (x, -z, y)
  g.translate(0, y1, 0);        // y ∈ [y0, y1]
  if (taper) {
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, yFix + (p.getY(i) - yFix) * taper(p.getZ(i)));
  }
  return smooth(g);
}

// 축 방향 회전(+Z → dir)을 적용한 그룹
function along(dir, obj, pos) {
  const g = new THREE.Group();
  g.quaternion.setFromUnitVectors(V3(0, 0, 1), dir.clone().normalize());
  if (pos) g.position.copy(pos);
  g.add(obj);
  return g;
}

// 서보모터: 로컬 +Z 로 [0, len], 단면 w×w. 라운드 사각 몸체 + 냉각핀 + 엔드캡 + 커넥터
function motor(len, w, M) {
  const g = new THREE.Group();
  const lb = len * 0.78;
  g.add(mesh(smooth(extrudeZ(rrectShape(w, w, w * 0.24), 0, lb, w * 0.06)), M.motor));
  const nf = 3;
  for (let i = 0; i < nf; i++) {
    const z = lb * (0.25 + 0.55 * i / (nf - 1));
    g.add(mesh(smooth(extrudeZ(rrectShape(w * 1.08, w * 1.08, w * 0.27), z, z + w * 0.045, w * 0.015, 3)), M.motor));
  }
  g.add(mesh(latheZ([[0, lb - 0.01], [w * 0.47, lb - 0.01], [w * 0.47, lb + (len - lb) * 0.55, w * 0.04], [w * 0.4, len, w * 0.08], [0, len]], 40), M.motorCap));
  // 커넥터 (몸체 +X 면)
  const cz = lb * 0.7;
  g.add(mesh(smooth(extrudeZ(rrectShape(w * 0.26, w * 0.34, w * 0.06, w * 0.6, 0), cz - w * 0.17, cz + w * 0.17, w * 0.03)), M.dark));
  g.add(along(V3(1, 0, 0), mesh(roundCylZ(w * 0.09, 0, w * 0.16, w * 0.02, 16), M.metal), V3(w * 0.72, 0, cz)));
  return g;
}

// 육각 볼트 머리 (축 Z, 아래면 z0)
function bolt(rad, z0, M, x, y) {
  const g = new THREE.CylinderGeometry(rad, rad, rad * 0.7, 6);
  g.rotateX(PI / 2);
  return mesh(g, M.metal, x, y, z0 + rad * 0.35);
}

function cable(points, rad, M) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  return mesh(new THREE.TubeGeometry(curve, 40, rad, 8, false), M.cable);
}

// ------------------------------------------------------------------ 메인
// 반환: { links: Group[7], update() } — update 는 링크 행렬 갱신 후 호출 (밸런서 등 링크 사이 부품)
export function buildRobotLinks(model, vendor) {
  const k = model.opw;
  const R = model.reach;
  const r = Math.max(36, Math.min(250, R * 0.072));
  const st = vendorStyle(model.vendor, vendor);
  const M = {
    body: paint(vendor.color),
    base: st.base === vendor.color ? paint(vendor.color) : paint(st.base, { roughness: 0.45, clearcoat: 0.3 }),
    cap: paint(st.cap, { roughness: 0.4 }),
    seam: plastic(st.seam, { roughness: 0.6 }),
    motor: st.motor === vendor.color ? paint(st.motor) : paint(st.motor, { metalness: 0.35, roughness: 0.42, clearcoat: 0.2 }),
    motorCap: paint(st.motorCap, { metalness: 0.4, roughness: 0.4, clearcoat: 0.2 }),
    dark: plastic(0x232528),
    metal: metal(0x9aa0a7),
    flange: metal(0xc3c8ce, { roughness: 0.22 }),
    cable: plastic(0x1b1c1e, { roughness: 0.62 }),
    sleeve: plastic(0x3a3d42, { roughness: 0.55 }),
  };
  const L = [];
  for (let i = 0; i < 7; i++) { const g = new THREE.Group(); g.matrixAutoUpdate = false; L.push(g); }

  // 공통 치수 (r 배수)
  const hb = Math.min(k.c1 * 0.38, r * 2.2);                // 베이스 높이 (J1 베어링 면)
  const zc = Math.max(hb + r * 0.45, k.c1 - r * 0.9);        // 선회 칼럼 상단
  const we = r * 0.6;                                         // 엘보/상완 반폭 (Y)
  const tA = r * st.armT;                                     // 하완 두께 (Y)
  const yIn = r * 0.36, yOut = yIn + tA;                      // 하완은 +Y 쪽으로 치우친 편측 구조
  const yS0 = -r * 0.82, yS1 = yIn - r * 0.03;                // 선회부 어깨 블록 Y 범위
  const yC = yOut + r * 0.14;                                 // 케이블 하네스 Y
  const bev = r * st.bevel;

  // ================= L0 베이스: 라운드 사각 설치판 + 앵커 볼트 + 플레어 받침 + 후면 커넥터 박스
  {
    const tp = r * 0.16, hw = r * 1.55;
    L[0].add(mesh(smooth(extrudeZ(rrectShape(hw * 2, hw * 2, r * 0.38), 0, tp, r * 0.03)), M.base));
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const bx = sx * (hw - r * 0.24), by = sy * (hw - r * 0.24);
      L[0].add(mesh(roundCylZ(r * 0.13, tp - 1, tp + r * 0.02, r * 0.01, 24), M.metal, bx, by, 0)); // 와셔
      L[0].add(bolt(r * 0.085, tp + r * 0.02, M, bx, by));
    }
    L[0].add(mesh(latheZ([[0, tp - 1], [r * 1.42, tp - 1], [r * 1.42, tp + r * 0.07, r * 0.03], [r * 1.24, tp + r * 0.32, r * 0.18], [r * 1.2, hb - r * 0.05, r * 0.03], [0, hb - r * 0.05]], 56), M.base));
    // 후면 커넥터 패널 (−X)
    const ch = Math.min(hb - tp - r * 0.1, r * 0.75);
    L[0].add(mesh(smooth(extrudeZ(rrectShape(r * 0.55, r * 0.9, r * 0.1, -r * 1.25, 0), tp, tp + ch, r * 0.05)), M.base));
    for (const sy of [-1, 1]) {
      L[0].add(along(V3(-1, 0, 0), mesh(roundCylZ(r * 0.13, 0, r * 0.22, r * 0.03, 24), M.metal), V3(-r * 1.5, sy * r * 0.22, tp + ch * 0.55)));
      L[0].add(along(V3(-1, 0, 0), mesh(roundCylZ(r * 0.1, 0, r * 0.32, r * 0.02, 16), M.dark), V3(-r * 1.62, sy * r * 0.22, tp + ch * 0.55)));
    }
    // J1 베어링 이음 (어두운 링)
    L[0].add(mesh(roundCylZ(r * 1.13, hb - r * 0.06, hb + r * 0.02, 0, 56), M.seam));
  }

  // ================= L1 선회부: 원통 칼럼 + 어깨 블록(측면 껍질 압출) + J2 감속기/모터 + J1 모터
  {
    L[1].add(mesh(latheZ([[0, hb + r * 0.02], [r * 1.2, hb + r * 0.02, r * 0.03], [r * 1.2, hb + r * 0.2, r * 0.06], [r * 1.08, hb + r * 0.34, r * 0.12], [r * 1.04, zc, r * 0.3], [0, zc]], 56), M.body));
    // 어깨 블록: 칼럼 상단 ~ J2 축을 감싸는 주물
    const sh = hullShape([[-r * 0.1, zc - r * 0.3, r * 1.0], [k.a1, k.c1, r * 0.86], [k.a1 * 0.5, zc - r * 0.55, r * 0.9]]);
    L[1].add(mesh(slabY(sh, yS0, yS1, bev), M.body));
    // J2 감속기 커버 + 모터 (−Y 쪽, J2 와 동축)
    L[1].add(mesh(roundCylY(r * 0.72, yS0 - r * 0.1, yS0 + r * 0.05, r * 0.04), M.cap, k.a1, 0, k.c1));
    L[1].add(mesh(roundCylY(r * 0.52, yS0 - r * 0.2, yS0 - r * 0.08, r * 0.02), M.seam, k.a1, 0, k.c1));
    L[1].add(along(V3(0, -1, 0), motor(r * 0.85, r * 0.72, M), V3(k.a1, yS0 - r * 0.18, k.c1)));
    // J2 축 반대편(하완 바깥쪽 아래) 스러스트 링
    L[1].add(mesh(roundCylY(r * 0.5, yS1 - r * 0.02, yIn + r * 0.02, 0), M.seam, k.a1, 0, k.c1));
    // J1 모터: 어깨 블록 뒤쪽에 수직 (커넥터 쪽이 위)
    L[1].add(along(V3(0, 0, 1), motor(r * 0.95, r * 0.66, M), V3(-r * 1.02, yS0 * 0.45, zc - r * 0.7)));
    // 하네스: 칼럼 뒤 → J2 축 위의 하완 바깥 면 (축 위 점이므로 J2 회전과 무관하게 이어짐)
    L[1].add(cable(R > 1500
      ? [V3(r * 0.45, r * 1.05, hb + r * 0.4), V3(k.a1 * 0.6 + r * 0.3, yC + r * 0.12, zc - r * 0.2), V3(k.a1 + r * 0.1, yC, k.c1 - r * 0.55), V3(k.a1, yC, k.c1)] // 밸런서 브래킷을 피해 앞쪽으로
      : [V3(-r * 1.1, r * 0.35, hb + r * 0.35), V3(-r * 1.32, r * 0.75, zc - r * 0.2), V3(k.a1 - r * 1.05, yC + r * 0.12, k.c1 + r * 0.2), V3(k.a1 - r * 0.25, yC, k.c1 + r * 0.04), V3(k.a1, yC, k.c1)], r * 0.11, M));
  }

  // ================= L2 하완: J2 → J3 테이퍼진 측면 주물 (+Y 편측)
  const R2 = r * 0.82, R3 = r * 0.62;
  {
    const sh = hullShape([[0, 0, R2], [0, k.c2, R3], [r * 0.08, k.c2 * 0.45, (R2 + R3) * 0.5]]);
    const taper = (z) => 1 - 0.18 * Math.max(0, Math.min(1, z / k.c2));
    L[2].add(mesh(slabY(sh, yIn, yOut, bev, taper, yIn), M.body));
    // 양 끝 허브 캡 (바깥 면)
    L[2].add(mesh(roundCylY(r * 0.6, yOut - r * 0.05, yOut + r * 0.06, r * 0.04), M.cap));
    L[2].add(mesh(roundCylY(r * 0.36, yOut, yOut + r * 0.1, r * 0.03), M.seam));
    const yOutT = yIn + tA * 0.82;
    L[2].add(mesh(roundCylY(r * 0.46, yOutT - r * 0.05, yOutT + r * 0.06, r * 0.04), M.cap, 0, 0, k.c2));
    // 하네스 (J2 축 점 → J3 축 점, 앞쪽으로 휘어 지나감) + 클램프
    const yc3 = yOutT + r * 0.14;
    const pts = [V3(0, yC, 0), V3(r * 0.55, yC + r * 0.06, k.c2 * 0.3), V3(r * 0.5, (yC + yc3) / 2 + r * 0.06, k.c2 * 0.7), V3(0, yc3, k.c2)];
    L[2].add(cable(pts, r * 0.11, M));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    for (const t of [0.35, 0.65]) {
      const p = curve.getPoint(t), tg = curve.getTangent(t);
      L[2].add(along(tg, mesh(roundCylZ(r * 0.15, -r * 0.07, r * 0.07, r * 0.02, 20), M.sleeve), p));
      const yb0 = yIn + tA * 0.7, yb1 = p.y;
      L[2].add(mesh(new THREE.BoxGeometry(r * 0.1, yb1 - yb0, r * 0.14), M.sleeve, p.x, (yb0 + yb1) / 2, p.z));
    }
  }

  // ================= L3 엘보: J3 허브 + 후방 하우징(J4~J6 모터) + J3 모터
  const a2 = k.a2;
  const zF = r * 0.3 + Math.max(0, r * 0.62 - Math.abs(a2)) * 0.6; // 엘보 앞면 (J4 회전면)
  const zB = -r * 1.42;                                            // 후방 끝
  {
    const yE0 = -we, yE1 = yIn - r * 0.03;
    L[3].add(mesh(roundCylY(r * 0.62, yE0, yE1, r * 0.1), M.body));
    const front = r * 0.5;
    const sh = hullShape([[0, 0, r * 0.6], [a2, zB + r * 0.45, r * 0.45], [a2 - front + r * 0.12, zF - r * 0.12, r * 0.12], [a2 + front - r * 0.12, zF - r * 0.12, r * 0.12]]);
    L[3].add(mesh(slabY(sh, yE0, yE1, bev), M.body));
    if (st.rearCyl) {
      // 원통형 후방 하우징 (J4 축과 동축)
      L[3].add(mesh(latheZ([[0, zB], [r * 0.44, zB, r * 0.08], [r * 0.52, zB + r * 0.3, r * 0.15], [r * 0.54, zF - r * 0.05, r * 0.05], [0, zF - r * 0.05]], 48), M.body, a2, (yE0 + yE1) / 2 + r * 0.0));
    }
    // 후방 엔드캡 + 손목 모터 2개(J5/J6) 캡 + 냉각 핀
    L[3].add(mesh(roundCylZ(r * 0.4, zB - r * 0.06, zB + r * 0.02, r * 0.03), M.motorCap, a2, (yE0 + yE1) / 2, 0));
    for (const s of [-1, 1]) L[3].add(mesh(roundCylZ(r * 0.13, zB - r * 0.12, zB - r * 0.04, r * 0.03, 24), M.dark, a2 + s * r * 0.18, (yE0 + yE1) / 2, 0));
    for (let i = 0; i < 3; i++) {
      const z = zB + r * (0.12 + i * 0.1);
      L[3].add(mesh(roundCylZ(r * (st.rearCyl ? 0.56 : 0.5), z, z + r * 0.035, r * 0.01, 40), M.motor, a2, (yE0 + yE1) / 2, 0));
    }
    // J3 모터 (−Y, J3 동축)
    L[3].add(mesh(roundCylY(r * 0.48, yE0 - r * 0.08, yE0 + r * 0.04, r * 0.03), M.cap));
    L[3].add(along(V3(0, -1, 0), motor(r * 0.7, r * 0.58, M), V3(0, yE0 - r * 0.06, 0)));
    // J4 회전면 이음 링
    L[3].add(mesh(roundCylZ(r * 0.46, zF - r * 0.06, zF + r * 0.02, 0, 48), M.seam, a2, 0, 0));
    // 하네스: J3 축 점 → 후방 하우징 상면
    const yc3 = yIn + tA * 0.82 + r * 0.14;
    L[3].add(cable([V3(0, yc3, 0), V3(a2 * 0.4 - r * 0.45, yc3 - r * 0.05, -r * 0.5), V3(a2 - r * 0.45, yE1 + r * 0.15, zB + r * 0.55), V3(a2 - r * 0.3, yE1 - r * 0.1, zB + r * 0.35)], r * 0.1, M));
  }

  // ================= L4 상완(전완): 테이퍼진 원통 + 손목 포크
  const c3 = k.c3, yi = r * 0.3, yo = r * 0.46;
  {
    const zs = zF + r * 0.02, zt = c3 - r * 0.62;
    L[4].add(mesh(latheZ([[0, zs], [r * 0.54, zs, r * 0.03], [r * 0.54, zs + r * 0.22, r * 0.06], [r * 0.5, zs + r * 0.34, r * 0.1], [r * 0.4, Math.max(zs + r * 0.45, zt - r * 0.1), r * 0.3], [r * 0.4, zt + r * 0.05, r * 0.2], [0, zt + r * 0.25]], 48), M.body));
    // 포크 (양쪽 판) — 손목 J5 하우징을 감싼다
    const sh = hullShape([[0, zt, r * 0.4], [0, c3, r * 0.38]]);
    for (const s of [-1, 1]) {
      const [y0, y1] = s > 0 ? [yi, yo] : [-yo, -yi];
      L[4].add(mesh(slabY(sh, y0, y1, r * 0.06), M.body));
      // 바깥쪽 돔형 커버 + 중앙 플러그
      const dome = latheY([[0, 0], [r * 0.33, 0], [r * 0.31, r * 0.04, r * 0.02], [r * 0.2, r * 0.08, r * 0.05], [0, r * 0.09]], 36);
      if (s < 0) dome.rotateX(PI);
      L[4].add(mesh(dome, M.body, 0, s * (yo - r * 0.01), c3));
      L[4].add(mesh(roundCylY(r * 0.1, s > 0 ? yo + r * 0.06 : -yo - r * 0.1, s > 0 ? yo + r * 0.1 : -yo - r * 0.06, r * 0.015, 20), M.dark, 0, 0, c3));
    }
    // 포크 뿌리 블록
    L[4].add(mesh(smooth(extrudeZ(rrectShape(r * 0.8, yo * 2, r * 0.2), zt - r * 0.2, zt + r * 0.05, r * 0.06)), M.body));
  }

  // ================= L5 손목: J5 하우징 + 넥 (중공 손목 느낌의 어두운 링)
  const tf = Math.max(4, r * 0.14), rf = r * 0.3;
  {
    L[5].add(mesh(roundCylY(r * 0.34, -yi + r * 0.02, yi - r * 0.02, r * 0.06, 40), M.body));
    const zn = Math.max(r * 0.1, k.c4 - tf);
    L[5].add(mesh(latheZ([[0, 0], [r * 0.29, 0], [r * 0.29, zn - r * 0.06, r * 0.04], [r * 0.32, zn - r * 0.03, r * 0.01], [r * 0.32, zn, r * 0.01], [0, zn]], 40), M.body));
    L[5].add(mesh(roundCylZ(r * 0.33, zn - r * 0.1, zn - r * 0.07, 0, 40), M.seam));
  }

  // ================= L6 플랜지: 가공 금속 원판 + 볼트 구멍 + 위치결정 핀 구멍 + 중심 보어
  {
    L[6].add(mesh(latheZ([[0, -tf], [rf, -tf], [rf, -tf * 0.2, tf * 0.15], [rf * 0.92, 0, tf * 0.1], [0, 0]], 48), M.flange));
    L[6].add(mesh(roundCylZ(rf * 0.32, -tf * 0.5, 0.3, 0, 24), M.dark)); // 중심 보어
    for (let i = 0; i < 4; i++) {
      const a = PI / 4 + i * PI / 2;
      L[6].add(mesh(roundCylZ(rf * 0.085, -tf * 0.4, 0.25, 0, 12), M.dark, Math.cos(a) * rf * 0.68, Math.sin(a) * rf * 0.68, 0));
    }
    L[6].add(mesh(roundCylZ(rf * 0.06, -tf * 0.4, 0.25, 0, 12), M.dark, 0, rf * 0.68, 0)); // 핀 구멍
    const mark = new THREE.Mesh(new THREE.BoxGeometry(Math.max(4, rf * 0.18), Math.max(3, rf * 0.1), 3), plastic(0xff3b30));
    mark.position.set(rf * 0.97, 0, -tf * 0.5); // 플랜지 +X 마크
    L[6].add(mark);
  }

  // ================= 밸런서 (대형 모델): L1 피벗의 실린더 ↔ L2 러그의 로드
  let update = () => {};
  if (R > 1500) {
    const yb = yOut + r * 0.32;
    const P1 = V3(k.a1 - r * 2.0, yb, k.c1 + r * 0.35);   // L1
    const P2 = V3(-r * 0.62, yb, r * 0.45);              // L2
    // L1 브래킷 (어깨 블록 뒤 → 바깥쪽 피벗)
    L[1].add(mesh(slabY(hullShape([[P1.x, P1.z, r * 0.24], [P1.x + r * 0.35, zc - r * 0.15, r * 0.4]]), yS1 - r * 0.5, yb + r * 0.26, r * 0.08), M.body));
    L[1].add(mesh(roundCylY(r * 0.14, yb - r * 0.34, yb + r * 0.34, r * 0.03, 24), M.metal, P1.x, 0, P1.z));
    // L2 러그
    L[2].add(mesh(slabY(hullShape([[P2.x, P2.z, r * 0.2], [0, r * 0.1, r * 0.4]]), yOut - r * 0.1, yb + r * 0.22, r * 0.05), M.body));
    L[2].add(mesh(roundCylY(r * 0.12, yb - r * 0.3, yb + r * 0.3, r * 0.03, 24), M.metal, P2.x, 0, P2.z));
    // 실린더 몸체 (L1) / 로드 (L2 피벗 위치를 따라 L1 안에서 갱신)
    const bodyLen = r * 1.35, rodLen = r * 1.45;
    const cyl = new THREE.Group();
    cyl.add(mesh(latheZ([[0, -r * 0.18], [r * 0.2, -r * 0.18, r * 0.08], [r * 0.24, r * 0.15, r * 0.05], [r * 0.24, bodyLen - r * 0.1, r * 0.05], [r * 0.18, bodyLen, r * 0.04], [0, bodyLen]], 36), M.cap));
    cyl.add(mesh(roundCylZ(r * 0.255, r * 0.3, r * 0.36, r * 0.01, 36), M.seam));
    cyl.add(mesh(roundCylZ(r * 0.255, bodyLen - r * 0.3, bodyLen - r * 0.24, r * 0.01, 36), M.seam));
    const rod = new THREE.Group();
    rod.add(mesh(roundCylZ(r * 0.08, 0, rodLen, r * 0.02, 20), M.flange));
    rod.add(mesh(roundCylZ(r * 0.16, -r * 0.16, r * 0.16, r * 0.06, 24), M.metal)); // 로드 엔드
    cyl.position.copy(P1);
    L[1].add(cyl, rod);
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), d = new THREE.Vector3(), Z = V3(0, 0, 1);
    update = () => {
      m.copy(L[1].matrix).invert().multiply(L[2].matrix);
      p.copy(P2).applyMatrix4(m);
      d.copy(p).sub(P1).normalize();
      cyl.quaternion.setFromUnitVectors(Z, d);
      rod.position.copy(p);
      rod.quaternion.setFromUnitVectors(Z, d.negate());
    };
  }

  return { links: L, update };
}
