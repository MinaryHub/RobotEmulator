// 로봇 모델 라이브러리
// opw: OPW 기구학 파라미터 (mm) — 제조사 데이터시트/치수도, ROS-Industrial URDF·OPW yaml, RoboDK 라이브러리를
//   교차 확인한 값 (2026-10 조사). 각 모델의 source 필드에 출처 요약.
// offsets/signs: 제조사 관절각 ↔ OPW 내부각 변환 (q_opw = q*sign - offset)
// payload: 최대 가반하중(kg). ratedPayload: 정격 가반하중 — KUKA AGILUS 처럼 최대와 정격을 따로 표기하는 모델만
// limits: 관절 소프트 리밋(deg), maxSpeed: 관절 최대속도(deg/s), maxAccelTime: 최고속 도달 시간(s)
// 2026-11 데이터시트 재대조: 아래 각 모델 source 에 확인 범위와 남은 불일치 기록
// tcpMaxSpeed: 직선보간 최대 속도(mm/s) — 제조사 미공개, 컨트롤러 관례값(추정)

export const VENDORS = {
  yaskawa: {
    name: 'Yaskawa (Motoman)', controller: 'YRC1000', language: 'INFORM', ext: '.JBI',
    jointNames: ['S', 'L', 'U', 'R', 'B', 'T'], poseNames: ['X', 'Y', 'Z', 'Rx', 'Ry', 'Rz'],
    color: 0x1f5fae, accent: 0xe8ecef,
  },
  kawasaki: {
    name: 'Kawasaki', controller: 'F60 / E-controller', language: 'AS', ext: '.as',
    jointNames: ['JT1', 'JT2', 'JT3', 'JT4', 'JT5', 'JT6'], poseNames: ['X', 'Y', 'Z', 'O', 'A', 'T'],
    color: 0xf2f2ee, accent: 0x3a3a3a,
  },
  hyundai: {
    name: 'Hyundai Robotics', controller: 'Hi6', language: 'HRScript', ext: '.job',
    jointNames: ['S', 'H', 'V', 'R2', 'B', 'R1'], poseNames: ['X', 'Y', 'Z', 'Rx', 'Ry', 'Rz'],
    color: 0xe9ecef, accent: 0x183a6b,
  },
  abb: {
    name: 'ABB', controller: 'IRC5 / OmniCore', language: 'RAPID', ext: '.mod',
    jointNames: ['rax_1', 'rax_2', 'rax_3', 'rax_4', 'rax_5', 'rax_6'], poseNames: ['x', 'y', 'z', 'q1', 'q2', 'q3', 'q4'],
    color: 0xf4f4f2, accent: 0x5a5f66,
  },
  kuka: {
    name: 'KUKA', controller: 'KR C4 / KR C5', language: 'KRL', ext: '.src',
    jointNames: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'], poseNames: ['X', 'Y', 'Z', 'A', 'B', 'C'],
    color: 0xf07a12, accent: 0x2b2b2b,
  },
};

// 제조사별 관절 부호/영점 (q_opw = q*sign - offset)
//  Yaskawa : ROS-I motoman URDF 관절축 기준 (컨트롤러 0 = 하완 수직, 상완 수평)
//  Kawasaki: Kawasaki 공식 khi_robot URDF/드라이버 기준 (컨트롤러 0 = 팔 전체 수직)
//  Hyundai : RoboDK 라이브러리의 관절 방향/영점 기준 (H=90 하완 수직, V=0 상완 수평)
//  ABB     : ROS-I abb OPW yaml 규약 (IRB1600 공식 yaml 과 동일 규약)
//  KUKA    : ROS-I kuka_experimental OPW yaml 규약
const Y = { offsets: [0, 0, -90, 0, 0, 0], signs: [1, 1, -1, -1, -1, -1] };
const KW = { offsets: [0, 0, 0, 0, 0, 0], signs: [-1, 1, -1, 1, -1, 1] };
const HY = { offsets: [0, -90, -90, 0, 0, 0], signs: [1, -1, -1, 1, -1, 1] };
const AB = { offsets: [0, 0, -90, 0, 0, 0], signs: [1, 1, 1, 1, 1, 1] };
const KU = { offsets: [0, -90, 0, 0, 0, 0], signs: [-1, 1, 1, -1, 1, -1] };

export const ROBOTS = [
  // ---------- Yaskawa ----------
  {
    id: 'yaskawa-gp7', vendor: 'yaskawa', name: 'MOTOMAN-GP7', payload: 7, reach: 927, repeatability: 0.01, ...Y,
    opw: { a1: 40, a2: -40, b: 0, c1: 330, c2: 445, c3: 440, c4: 80 },
    limits: [[-170, 170], [-65, 145], [-70, 190], [-190, 190], [-135, 135], [-360, 360]],
    maxSpeed: [375, 315, 410, 550, 550, 1000], home: [0, 0, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    // 펄스/deg — 미공개(컨트롤러 파라미터). JBI 펄스 데이터 해석용 임시값
    pulsePerDeg: [1341.0, 1341.0, 1341.0, 1023.0, 1023.0, 568.9],
    source: 'Motoman GP7/GP8 데이터시트 + ROS-I gp7_macro.xacro (치수는 URDF, 도달거리 검산 일치)',
  },
  {
    id: 'yaskawa-gp12', vendor: 'yaskawa', name: 'MOTOMAN-GP12', payload: 12, reach: 1440, repeatability: 0.02, ...Y,
    opw: { a1: 155, a2: -200, b: 0, c1: 450, c2: 614, c3: 640, c4: 100 },
    limits: [[-170, 170], [-90, 155], [-85, 150], [-200, 200], [-150, 150], [-455, 455]],
    maxSpeed: [260, 230, 260, 470, 470, 700], home: [0, 0, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    pulsePerDeg: [1100.0, 1100.0, 1100.0, 800.0, 800.0, 480.0],
    source: 'Motoman GP12 데이터시트(치수도) + ROS-I gp12_macro.xacro — 일치. 단 U 상한: 유럽 데이터시트 C-03-2024 는 +155, 미주 DS-700-F·URDF 는 +150 (보수적으로 +150 유지)',
  },
  {
    id: 'yaskawa-gp25', vendor: 'yaskawa', name: 'MOTOMAN-GP25', payload: 25, reach: 1730, repeatability: 0.02, ...Y,
    opw: { a1: 150, a2: -200, b: 0, c1: 505, c2: 760, c3: 795, c4: 100 },
    limits: [[-180, 180], [-105, 155], [-86, 160], [-200, 200], [-150, 150], [-455, 455]],
    maxSpeed: [210, 210, 265, 420, 420, 885], home: [0, 0, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    pulsePerDeg: [1000.0, 1000.0, 1000.0, 750.0, 750.0, 450.0],
    source: 'Motoman GP25 데이터시트(유럽 05_2022) + ROS-I gp25_macro.xacro — 사양 일치 (a1·a2·c1~c3 은 URDF 기준)',
  },
  // ---------- Kawasaki ----------
  {
    id: 'kawasaki-rs007n', vendor: 'kawasaki', name: 'RS007N', payload: 7, reach: 730, repeatability: 0.02, ...KW,
    opw: { a1: 0, a2: 0, b: 0, c1: 360, c2: 355, c3: 375, c4: 78 },
    limits: [[-180, 180], [-135, 135], [-155, 155], [-200, 200], [-125, 125], [-360, 360]],
    maxSpeed: [470, 380, 520, 550, 550, 1000], home: [0, 0, -90, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'Kawasaki RS007N-B 데이터시트 + 공식 khi_robot rs007n URDF',
  },
  {
    id: 'kawasaki-rs010n', vendor: 'kawasaki', name: 'RS010N', payload: 10, reach: 1450, repeatability: 0.03, ...KW,
    opw: { a1: 100, a2: 0, b: 0, c1: 430, c2: 650, c3: 700, c4: 88 },
    limits: [[-180, 180], [-105, 145], [-163, 150], [-270, 270], [-145, 145], [-360, 360]],
    maxSpeed: [250, 250, 215, 365, 380, 700], home: [0, 0, -90, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'Kawasaki RS010N-A 표준 사양서 90151-0045DEC — 사양 일치. 링크 치수는 공식 수치 미확인 (a1+c2+c3 = 공식 도달거리 1450 일치, a2·c4 추정)',
  },
  {
    id: 'kawasaki-rs020n', vendor: 'kawasaki', name: 'RS020N', payload: 20, reach: 1725, repeatability: 0.04, ...KW,
    opw: { a1: 150, a2: 0, b: 0, c1: 465, c2: 770, c3: 805, c4: 95 },
    limits: [[-180, 180], [-105, 155], [-163, 150], [-270, 270], [-145, 145], [-360, 360]],
    maxSpeed: [190, 205, 210, 400, 360, 610], home: [0, 0, -90, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'Kawasaki RS020N 데이터시트·카탈로그 치수도 + 공식 khi_robot rs020n URDF — 일치',
  },
  // ---------- Hyundai ----------
  {
    id: 'hyundai-hh7', vendor: 'hyundai', name: 'HH7 (HDF7-9)', payload: 7, reach: 932, repeatability: 0.02, ...HY,
    opw: { a1: 40, a2: -40, b: 0, c1: 446, c2: 445, c3: 445, c4: 86.5 },
    limits: [[-170, 170], [-55, 180], [-70, 213], [-190, 190], [-135, 135], [-360, 360]],
    maxSpeed: [375, 315, 410, 550, 550, 1000], home: [0, 90, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'HD현대로보틱스 HH7(HDF7-9) 제품 페이지 + 공식 매뉴얼 2.3 사양·2.4 치수도 — 사양·치수 모두 일치',
  },
  {
    id: 'hyundai-hh020', vendor: 'hyundai', name: 'HH020', payload: 20, reach: 1742, repeatability: 0.08, ...HY,
    opw: { a1: 160, a2: -140, b: 0, c1: 446.6, c2: 770, c3: 800, c4: 112 },
    limits: [[-185, 185], [-70, 195], [-80, 180], [-195, 195], [-135, 135], [-360, 360]],
    maxSpeed: [190, 180, 190, 380, 380, 600], home: [0, 90, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'HD현대로보틱스 HH020 공식 매뉴얼 2.3 사양·2.4 치수도 (현행 라인업에 없음 — 단종 추정)',
  },
  {
    id: 'hyundai-hs220', vendor: 'hyundai', name: 'HS220 (HDR220-26)', payload: 220, reach: 2666, repeatability: 0.04, ...HY,
    opw: { a1: 312, a2: -230, b: 0, c1: 608, c2: 1100, c3: 1250, c4: 220 },
    limits: [[-180, 180], [10, 155], [-80, 190], [-360, 360], [-128, 128], [-360, 360]],
    maxSpeed: [120, 105, 110, 145, 145, 220], home: [0, 90, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'HD현대로보틱스 HS220(HDR220-26) 제품 페이지 + 공식 매뉴얼 치수도 — 일치. 도달거리 2666 은 H 하한 +10°(수직에서 전방 80°)로 제한된 값 (완전 수평 가정 시 2683). 반복정밀도: 제품 페이지 ±0.04, 2023 매뉴얼 ±0.11',
  },
  // ---------- ABB ----------
  {
    id: 'abb-irb1200', vendor: 'abb', name: 'IRB 1200-5/0.9', payload: 5, reach: 901, repeatability: 0.025, ...AB,
    opw: { a1: 0, a2: -42, b: 0, c1: 399.1, c2: 448, c3: 451, c4: 82 },
    limits: [[-170, 170], [-100, 130], [-200, 70], [-270, 270], [-130, 130], [-400, 400]],
    maxSpeed: [288, 240, 300, 400, 405, 600], home: [0, 0, 0, 0, 90, 0], tcpMaxSpeed: 7000,
    source: 'ABB IRB1200 데이터시트(9AKK106103A6066) + ROS-I irb1200_5_90 URDF',
  },
  {
    id: 'abb-irb2600', vendor: 'abb', name: 'IRB 2600-12/1.65', payload: 12, reach: 1650, repeatability: 0.04, ...AB,
    opw: { a1: 150, a2: -115, b: 0, c1: 445, c2: 700, c3: 795, c4: 85 },
    limits: [[-180, 180], [-95, 155], [-180, 75], [-400, 400], [-120, 120], [-400, 400]],
    maxSpeed: [175, 175, 175, 360, 360, 500], home: [0, 0, 0, 0, 90, 0], tcpMaxSpeed: 7000,
    source: 'ABB IRB2600 데이터시트(IRC5) + ROS-I irb2600_12_165 URDF — 일치. 축4 범위는 ABB 자료끼리 ±400 / ±175 로 상충 (±400 유지, 제품 사양서 3HAC035959 로 확인 필요)',
  },
  {
    id: 'abb-irb6700', vendor: 'abb', name: 'IRB 6700-200/2.60', payload: 200, reach: 2600, repeatability: 0.05, ...AB,
    opw: { a1: 320, a2: -200, b: 0, c1: 780, c2: 1125, c3: 1142.5, c4: 200 },
    limits: [[-170, 170], [-65, 85], [-180, 70], [-300, 300], [-130, 130], [-360, 360]],
    maxSpeed: [110, 110, 110, 190, 150, 210], home: [0, 0, 0, 0, 90, 0], tcpMaxSpeed: 7000,
    source: 'ABB IRB6700 데이터시트 ROB0252EN Rev.J (IRC5) + ROS-I irb6700_200_260 URDF — 일치 (OmniCore 속도표 미확인)',
  },
  // ---------- KUKA ----------
  {
    id: 'kuka-kr6-r900', vendor: 'kuka', name: 'KR 6 R900 sixx (AGILUS)', payload: 6, ratedPayload: 3, reach: 901.5, repeatability: 0.03, ...KU,
    opw: { a1: 25, a2: -35, b: 0, c1: 400, c2: 455, c3: 420, c4: 80 },
    limits: [[-170, 170], [-190, 45], [-120, 156], [-185, 185], [-120, 120], [-350, 350]],
    maxSpeed: [360, 300, 360, 381, 388, 615], home: [0, -90, 90, 0, 0, 0], tcpMaxSpeed: 2000,
    source: 'KUKA AGILUS sixx 사양 + ROS-I kr6r900sixx URDF / KUKA 공식 ROS2 description',
  },
  {
    id: 'kuka-kr6-r900-2', vendor: 'kuka', name: 'KR 6 R900-2 (AGILUS)', payload: 6.7, ratedPayload: 3, reach: 901, repeatability: 0.02, ...KU,
    opw: { a1: 25, a2: -25, b: 0, c1: 400, c2: 455, c3: 420, c4: 90 },
    limits: [[-170, 170], [-190, 45], [-120, 156], [-185, 185], [-120, 120], [-350, 350]],
    maxSpeed: [360, 300, 360, 450, 450, 540], home: [0, -90, 90, 0, 0, 0], tcpMaxSpeed: 2000,
    source: 'KUKA 데이터시트 0000-290-001 V14.1 + KUKA 공식 ROS2 opw yaml — 일치. A6 속도: ROS2 540, 2017 판매 자료 547.5 (데이터시트에 속도표 없음)',
  },
  {
    id: 'kuka-kr10-r1100', vendor: 'kuka', name: 'KR 10 R1100 sixx (AGILUS)', payload: 10, ratedPayload: 5, reach: 1101, repeatability: 0.03, ...KU,
    opw: { a1: 25, a2: -35, b: 0, c1: 400, c2: 560, c3: 515, c4: 80 },
    limits: [[-170, 170], [-190, 45], [-120, 156], [-185, 185], [-120, 120], [-350, 350]],
    maxSpeed: [300, 225, 225, 381, 311, 492], home: [0, -90, 90, 0, 0, 0], tcpMaxSpeed: 2000,
    source: 'ROS-I kr10r1100sixx URDF (KUKA 사양 V12 인용)',
  },
  {
    id: 'kuka-kr10-r1100-2', vendor: 'kuka', name: 'KR 10 R1100-2 (AGILUS)', payload: 11.1, ratedPayload: 5, reach: 1101, repeatability: 0.02, ...KU,
    opw: { a1: 25, a2: -25, b: 0, c1: 400, c2: 560, c3: 515, c4: 90 },
    limits: [[-170, 170], [-190, 45], [-120, 156], [-185, 185], [-120, 120], [-350, 350]],
    maxSpeed: [300, 225, 330, 360, 360, 433], home: [0, -90, 90, 0, 0, 0], tcpMaxSpeed: 2000,
    source: 'KUKA 데이터시트 0000-290-003 V14.1 (최대 11.1 kg) + KUKA 공식 ROS2 description — 일치. A6 속도: ROS2 433, 2017 판매 자료 438',
  },
  {
    id: 'kuka-kr210-r2700', vendor: 'kuka', name: 'KR 210 R2700 extra (QUANTEC)', payload: 210, reach: 2696, repeatability: 0.06, ...KU,
    opw: { a1: 350, a2: -41, b: 0, c1: 675, c2: 1150, c3: 1200, c4: 215 },
    limits: [[-185, 185], [-140, -5], [-120, 155], [-350, 350], [-125, 125], [-350, 350]],
    maxSpeed: [123, 115, 112, 179, 172, 219], home: [0, -90, 90, 0, 0, 0], tcpMaxSpeed: 2000,
    source: 'KUKA 데이터시트 0000182736 + KUKA 공식 ROS2 kr210_r2700_extra URDF — 일치. 도달거리 2696 은 A2 상한 -5° 로 제한된 값 (치수상 2700.7)',
  },
];

for (const r of ROBOTS) r.maxAccelTime ??= r.payload > 100 ? 0.45 : 0.25;

export const getRobot = (id) => ROBOTS.find((r) => r.id === id);
