// 그리퍼(엔드이펙터) 라이브러리
// 외형 치수는 각 제조사 공개 카탈로그/데이터시트의 대략적인 값을 기반으로 한 형상 모델이다.
// (정밀 CAD 가 필요하면 UI 에서 STL 파일을 불러와 사용자 그리퍼로 등록 가능)
//
// 공통 필드
//   tcp      : 플랜지 기준 TCP [x,y,z,rx,ry,rz] (mm, deg)
//   mass     : kg
//   kind     : parallel | adaptive2f | threefinger | vacuum | magnet | torch | spindle | none
//   stroke   : 손가락 전체 개폐량 (mm)
//   grip     : 파지 판정 반경(mm) — 이 거리 안의 공작물을 닫힘 시 집음
//   geom     : 형상 파라미터 (렌더러가 해석)
// 그리퍼 동작 신호(DO 번호)는 컨트롤러 설정에서 지정 (기본: DO1=닫기, DO2=열기 / 진공은 DO1=흡착)

export const GRIPPERS = [
  { id: 'none', name: '없음 (플랜지만)', maker: '-', kind: 'none', tcp: [0, 0, 0, 0, 0, 0], mass: 0, geom: {} },

  {
    id: 'robotiq-2f85', name: '2F-85 Adaptive', maker: 'Robotiq', kind: 'adaptive2f',
    tcp: [0, 0, 150, 0, 0, 0], mass: 0.925, stroke: 85, force: '20-235 N', grip: 30,
    geom: { coupling: { d: 75, h: 13 }, body: { w: 75, d: 56, h: 85 }, finger: { l: 62, w: 22, t: 10, pad: 38 } },
  },
  {
    id: 'robotiq-2f140', name: '2F-140 Adaptive', maker: 'Robotiq', kind: 'adaptive2f',
    tcp: [0, 0, 222, 0, 0, 0], mass: 1.025, stroke: 140, force: '10-125 N', grip: 45,
    geom: { coupling: { d: 75, h: 13 }, body: { w: 75, d: 56, h: 85 }, finger: { l: 125, w: 27, t: 12, pad: 50 } },
  },
  {
    id: 'robotiq-hande', name: 'Hand-E', maker: 'Robotiq', kind: 'parallel',
    tcp: [0, 0, 146, 0, 0, 0], mass: 1.0, stroke: 50, force: '60-130 N', grip: 22,
    geom: { coupling: { d: 75, h: 8 }, body: { w: 75, d: 70, h: 100 }, finger: { l: 38, w: 20, t: 9 } },
  },
  {
    id: 'robotiq-3f', name: '3-Finger Adaptive', maker: 'Robotiq', kind: 'threefinger',
    tcp: [0, 0, 220, 0, 0, 0], mass: 2.3, stroke: 155, force: '30-70 N', grip: 55,
    geom: { coupling: { d: 75, h: 15 }, body: { w: 150, d: 110, h: 110 }, finger: { l: 110, w: 30, t: 22 } },
  },
  {
    id: 'onrobot-rg2', name: 'RG2', maker: 'OnRobot', kind: 'adaptive2f',
    tcp: [0, 0, 213, 0, 0, 0], mass: 0.65, stroke: 110, force: '3-40 N', grip: 35,
    geom: { coupling: { d: 70, h: 10 }, body: { w: 52, d: 40, h: 150 }, finger: { l: 70, w: 18, t: 8, pad: 25 } },
  },
  {
    id: 'onrobot-rg6', name: 'RG6', maker: 'OnRobot', kind: 'adaptive2f',
    tcp: [0, 0, 262, 0, 0, 0], mass: 1.25, stroke: 160, force: '25-120 N', grip: 50,
    geom: { coupling: { d: 70, h: 10 }, body: { w: 65, d: 50, h: 175 }, finger: { l: 95, w: 22, t: 10, pad: 30 } },
  },
  {
    id: 'schunk-pgn100', name: 'PGN-plus-P 100-1 (공압)', maker: 'SCHUNK', kind: 'parallel',
    tcp: [0, 0, 165, 0, 0, 0], mass: 1.05, stroke: 20, force: '1,350 N', grip: 15,
    geom: { coupling: { d: 90, h: 15 }, body: { w: 100, d: 70, h: 72 }, finger: { l: 75, w: 26, t: 14 } },
  },
  {
    id: 'schunk-egp40', name: 'EGP 40 (소형 전동)', maker: 'SCHUNK', kind: 'parallel',
    tcp: [0, 0, 120, 0, 0, 0], mass: 0.32, stroke: 12, force: '140 N', grip: 8,
    geom: { coupling: { d: 60, h: 12 }, body: { w: 40, d: 32, h: 68 }, finger: { l: 40, w: 12, t: 8 } },
  },
  {
    id: 'zimmer-gep2016', name: 'GEP2016IO (전동 평행)', maker: 'Zimmer', kind: 'parallel',
    tcp: [0, 0, 135, 0, 0, 0], mass: 0.6, stroke: 32, force: '210 N', grip: 16,
    geom: { coupling: { d: 70, h: 12 }, body: { w: 64, d: 46, h: 78 }, finger: { l: 45, w: 16, t: 10 } },
  },
  {
    id: 'vacuum-single', name: '진공 컵 Ø40 (벨로즈)', maker: 'Generic (Schmalz/SMC 형)', kind: 'vacuum',
    tcp: [0, 0, 128, 0, 0, 0], mass: 0.25, grip: 25,
    geom: { coupling: { d: 63, h: 15 }, stem: { d: 22, h: 85 }, cups: [{ x: 0, y: 0, d: 40, h: 28 }] },
  },
  {
    id: 'vacuum-2x2', name: '진공 패드 어레이 2x2', maker: 'Generic (Schmalz FXP 형)', kind: 'vacuum',
    tcp: [0, 0, 145, 0, 0, 0], mass: 1.4, grip: 90,
    geom: {
      coupling: { d: 63, h: 15 }, stem: { d: 40, h: 60 }, plate: { w: 220, d: 160, t: 12 },
      cups: [{ x: 75, y: 50, d: 50, h: 30 }, { x: -75, y: 50, d: 50, h: 30 }, { x: 75, y: -50, d: 50, h: 30 }, { x: -75, y: -50, d: 50, h: 30 }],
    },
  },
  {
    id: 'onrobot-vgc10', name: 'VGC10 (전동 진공 4컵)', maker: 'OnRobot', kind: 'vacuum',
    tcp: [0, 0, 138, 0, 0, 0], mass: 0.81, grip: 45,
    geom: {
      coupling: { d: 70, h: 10 }, stem: { d: 0, h: 0 }, box: { w: 100, d: 100, h: 85 },
      cups: [{ x: 32, y: 32, d: 30, h: 25 }, { x: -32, y: 32, d: 30, h: 25 }, { x: 32, y: -32, d: 30, h: 25 }, { x: -32, y: -32, d: 30, h: 25 }],
    },
  },
  {
    id: 'onrobot-mg10', name: 'MG10 (전자석)', maker: 'OnRobot', kind: 'magnet',
    tcp: [0, 0, 152, 0, 0, 0], mass: 1.0, grip: 40,
    geom: { coupling: { d: 70, h: 10 }, body: { d: 88, h: 115 }, face: { d: 70, h: 27 } },
  },
  {
    id: 'torch-22', name: '용접 토치 22° (MIG)', maker: 'Generic (Binzel/Fronius 형)', kind: 'torch',
    tcp: [0, 118, 392, -22, 0, 0], mass: 1.6, grip: 0,
    geom: { coupling: { d: 80, h: 70 }, neck: { d: 26, l: 330, angle: 22 }, nozzle: { d: 18, l: 60 } },
  },
  {
    id: 'spindle', name: '스핀들 / 디버링 공구', maker: 'Generic', kind: 'spindle',
    tcp: [0, 0, 260, 0, 0, 0], mass: 4.5, grip: 0,
    geom: { coupling: { d: 90, h: 20 }, body: { d: 80, h: 180 }, tool: { d: 10, h: 60 } },
  },
];

export const getGripper = (id) => GRIPPERS.find((g) => g.id === id) || GRIPPERS[0];
