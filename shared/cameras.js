// 비전 카메라 라이브러리 + 장착 설정 정규화 (서버·브라우저 공용)
// 사양(해상도·화각·측정 거리·외형)은 각 제조사 공개 데이터시트의 대략적인 값이다.
// 렌더링은 핀홀 모델(왜곡 없음)이며 화각은 수평 기준.
//
// 라이브러리 항목
//   res    : [폭, 높이] 픽셀 — 화면 비율과 스냅샷 해상도에 사용
//   hfov   : 수평 화각 (deg)
//   range  : [near, far] mm — 측정 범위. 깊이 모드에서 이 범위 밖은 무효(검정). 컬러/흑백 영상은 범위와 무관하게 가까운 물체도 보임
//   modes  : 지원 렌더 모드 color | mono | depth (첫 항목이 기본)
//   body   : 외형 상자 { w, h, d } (mm, 카메라 좌표 x·y·z), lens: { d, l } 렌즈 원통 (없으면 생략)
//   mount  : 기본 장착 위치 flange | forearm | world
//
// 카메라 좌표계(장착 오프셋 기준): +Z = 광축(바라보는 방향), +X = 영상 오른쪽, +Y = 영상 아래 (OpenCV 관례)
// 장착 오프셋 pos/rot 는 툴 정의와 같은 관례 [x,y,z] mm, [rx,ry,rz] deg (R = Rz·Ry·Rx)
//   flange  : 로봇 플랜지 좌표계 (+Z = 툴 방향) — 아이 인 핸드
//   forearm : J3 축 좌표계 (+Z = 전완 방향, J4 회전 영향 없음)
//   world   : 로봇 베이스 좌표계 (고정 카메라, 아이 투 핸드)

export const CAMERAS = [
  {
    id: 'mv-2d-8mm', name: '2D 머신비전 (5MP, 8mm 렌즈)', maker: 'Generic', kind: '2d',
    res: [2448, 2048], hfov: 58, range: [60, 3000], modes: ['mono', 'color'], mass: 0.15, mount: 'flange',
    body: { w: 29, h: 29, d: 42 }, lens: { d: 30, l: 35 },
  },
  {
    id: 'mv-2d-16mm', name: '2D 머신비전 (5MP, 16mm 렌즈)', maker: 'Generic', kind: '2d',
    res: [2448, 2048], hfov: 31, range: [100, 4000], modes: ['mono', 'color'], mass: 0.18, mount: 'flange',
    body: { w: 29, h: 29, d: 42 }, lens: { d: 32, l: 45 },
  },
  {
    id: 'smart-cam', name: '스마트 카메라 (1.6MP, 일체형 조명)', maker: 'Generic', kind: '2d',
    res: [1440, 1080], hfov: 42, range: [50, 2000], modes: ['mono', 'color'], mass: 0.3, mount: 'flange',
    body: { w: 60, h: 45, d: 55 }, lens: { d: 36, l: 8 },
  },
  {
    id: 'realsense-d435', name: 'RealSense D435 (스테레오 깊이)', maker: 'Intel', kind: '3d',
    res: [1280, 720], hfov: 87, range: [280, 3000], modes: ['color', 'depth'], mass: 0.072, mount: 'flange',
    body: { w: 90, h: 25, d: 25 },
  },
  {
    id: 'zivid2-m70', name: 'Zivid 2+ M70 (구조광 3D)', maker: 'Zivid', kind: '3d',
    res: [1944, 1200], hfov: 58, range: [300, 1100], modes: ['color', 'depth'], mass: 0.75, mount: 'flange',
    body: { w: 165, h: 60, d: 86 },
  },
  {
    id: 'tof-vga', name: 'ToF 깊이 카메라 (VGA)', maker: 'Generic', kind: '3d',
    res: [640, 480], hfov: 70, range: [200, 5000], modes: ['depth', 'mono'], mass: 0.2, mount: 'world',
    body: { w: 70, h: 55, d: 40 }, lens: { d: 20, l: 5 },
  },
  {
    id: 'cell-monitor', name: '셀 모니터링 카메라 (광각)', maker: 'Generic', kind: 'monitor',
    res: [1920, 1080], hfov: 100, range: [100, 20000], modes: ['color', 'mono'], mass: 0.4, mount: 'world',
    body: { w: 60, h: 60, d: 110 }, lens: { d: 45, l: 15 },
  },
];

export const CAMERA_MOUNTS = { flange: '플랜지 (핸드)', forearm: '전완 (J3)', world: '고정 (월드)' };
export const CAMERA_MODES = { color: '컬러', mono: '흑백', depth: '깊이' };
export const MAX_CAMERAS = 8;

export const getCamera = (id) => CAMERAS.find((c) => c.id === id);

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const vec3 = (v, d = [0, 0, 0]) => [0, 1, 2].map((i) => num(Array.isArray(v) ? v[i] : undefined, d[i]));

const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const clampNum = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

export function normalizeVision(v, idx = 0) {
  const s = v && typeof v === 'object' ? v : {};
  return {
    enabled: !!s.enabled,
    triggerDO: clampInt(s.triggerDO, 0, 512, 20 + idx * 4),
    doneDI: clampInt(s.doneDI, 0, 512, 20 + idx * 4),
    foundDI: clampInt(s.foundDI, 0, 512, 21 + idx * 4),
    regBase: clampInt(s.regBase, 0, 240, idx * 10),
    frame: s.frame === 'user' ? 'user' : 'base',
    noiseMm: clampNum(s.noiseMm, 0, 50, 0.5),
    noiseDeg: clampNum(s.noiseDeg, 0, 45, 0.2),
    latencyMs: clampInt(s.latencyMs, 0, 5000, 80),
  };
}

// 외부(UI·프로젝트 파일)에서 받은 카메라 목록을 검증·보정. 모르는 type 은 제외
export function normalizeCameras(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const used = new Set();
  for (const c of list.slice(0, MAX_CAMERAS)) {
    const def = getCamera(c?.type);
    if (!def) continue;
    let id = String(c.id || '').replace(/[^\w-]/g, '').slice(0, 24) || `cam${out.length + 1}`;
    while (used.has(id)) id += '_';
    used.add(id);
    const entry = {
      id,
      type: def.id,
      name: String(c.name || def.name).slice(0, 40),
      mount: CAMERA_MOUNTS[c.mount] ? c.mount : def.mount,
      pos: vec3(c.pos),
      rot: vec3(c.rot),
      mode: def.modes.includes(c.mode) ? c.mode : def.modes[0],
      view: c.view !== false,
      frustum: c.frustum !== false,
    };
    if (c.vision && typeof c.vision === 'object') entry.vision = normalizeVision(c.vision, out.length);
    out.push(entry);
  }
  return out;
}

// 새 카메라의 기본 장착 위치 (scene: 컨트롤러 scene 정보, model: 로봇 모델)
export function defaultMount(def, mount, scene, model) {
  // 카메라 원점은 렌즈 앞면 → 몸체 뒷면이 장착면(z=0)에 닿도록
  const lensZ = (def.body?.d ?? 40) + (def.lens?.l ?? 0);
  switch (mount) {
    case 'flange': {
      // 플랜지 측면에 붙이고 툴 방향으로 약 300mm 앞을 보도록 기울임
      const y = Math.max(60, (def.body?.h ?? 30) / 2 + 45);
      return { pos: [0, y, lensZ], rot: [+(Math.atan2(y, 300) * 180 / Math.PI).toFixed(1), 0, 0] };
    }
    case 'forearm': {
      // 전완 위(J3 축 좌표계 -X 쪽)에서 앞쪽 아래를 봄
      const r = Math.max(36, Math.min(250, (model?.reach ?? 900) * 0.072));
      return { pos: [-(r * 1.6 + (def.body?.h ?? 30) / 2), 0, Math.round((model?.opw?.c3 ?? 600) * 0.35)], rot: [0, 35, 0] };
    }
    default: {
      // 작업 테이블 중앙 위에서 수직 아래를 봄 (영상 위쪽 = 로봇 반대 방향)
      const t = scene?.table || { x: 600, y: 0 };
      const h = Math.min(2500, Math.max(900, (def.range?.[0] ?? 300) + 700));
      return { pos: [t.x, t.y, h], rot: [180, 0, -90] };
    }
  }
}
