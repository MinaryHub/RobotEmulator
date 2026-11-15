// 로봇 모델 라이브러리
// opw: OPW 기구학 파라미터 (mm) — 제조사 데이터시트/치수도, ROS-Industrial URDF·OPW yaml, RoboDK 라이브러리를
//   교차 확인한 값 (2026-10 조사). 각 모델의 source 필드에 출처 요약.
// offsets/signs: 제조사 관절각 ↔ OPW 내부각 변환 (q_opw = q*sign - offset)
// payload: 최대 가반하중(kg). ratedPayload: 정격 가반하중 — KUKA AGILUS 처럼 최대와 정격을 따로 표기하는 모델만
// limits: 관절 소프트 리밋(deg), maxSpeed: 관절 최대속도(deg/s), maxAccelTime: 최고속 도달 시간(s)
// 2026-11 데이터시트 재대조: 아래 각 모델 source 에 확인 범위와 남은 불일치 기록
// a2 부호: 0점 자세에서 손목 중심 높이 = c1 - a2 → 손목이 J3 축보다 위면 음수, 아래면 양수 (KUKA KR 16-2·QUANTEC extra/ultra 는 양수)
// reachRef: 'flange' — 공개 도달거리가 손목 중심이 아니라 플랜지 면까지 (두산). 생략 시 손목 중심 기준
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
  doosan: {
    name: 'Doosan Robotics', controller: 'CS-01 (DART-Platform)', language: 'DRL', ext: '.drl',
    jointNames: ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'], poseNames: ['X', 'Y', 'Z', 'A', 'B', 'C'],
    color: 0xf3f4f5, accent: 0x2b6cb0,
  },
};

// 제조사별 관절 부호/영점 (q_opw = q*sign - offset)
//  Yaskawa : ROS-I motoman URDF 관절축 기준 (컨트롤러 0 = 하완 수직, 상완 수평)
//  Kawasaki: Kawasaki 공식 khi_robot URDF/드라이버 기준 (컨트롤러 0 = 팔 전체 수직)
//  Hyundai : RoboDK 라이브러리의 관절 방향/영점 기준 (H=90 하완 수직, V=0 상완 수평)
//  ABB     : ROS-I abb OPW yaml 규약 (IRB1600 공식 yaml 과 동일 규약)
//  KUKA    : ROS-I kuka_experimental OPW yaml 규약
//  Doosan  : 두산 공식 doosan-robot2 URDF 와 동일 (변환 없음, 0 = 팔 전체 수직). 무작위 자세 FK 대조로 확인
const Y = { offsets: [0, 0, -90, 0, 0, 0], signs: [1, 1, -1, -1, -1, -1] };
const KW = { offsets: [0, 0, 0, 0, 0, 0], signs: [-1, 1, -1, 1, -1, 1] };
const HY = { offsets: [0, -90, -90, 0, 0, 0], signs: [1, -1, -1, 1, -1, 1] };
const AB = { offsets: [0, 0, -90, 0, 0, 0], signs: [1, 1, 1, 1, 1, 1] };
const KU = { offsets: [0, -90, 0, 0, 0, 0], signs: [-1, 1, 1, -1, 1, -1] };
const DS = { offsets: [0, 0, 0, 0, 0, 0], signs: [1, 1, 1, 1, 1, 1] };

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
  {
    id: 'yaskawa-gp4', vendor: 'yaskawa', name: 'MOTOMAN-GP4', payload: 4, reach: 550, repeatability: 0.01, ...Y,
    opw: { a1: 0, a2: -15, b: 0, c1: 330, c2: 260, c3: 290, c4: 72 },
    limits: [[-170, 170], [-110, 130], [-65, 200], [-200, 200], [-123, 123], [-455, 455]],
    maxSpeed: [465, 465, 525, 565, 565, 1000], home: [0, 0, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    pulsePerDeg: [1341.0, 1341.0, 1341.0, 1023.0, 1023.0, 568.9], // 임시값(미공개)
    source: 'Motoman GP4 데이터시트(미주, 2024-12, 치수도 330/260/15/290/72) + ROS-I gp4_macro.xacro — 일치',
  },
  {
    id: 'yaskawa-gp8', vendor: 'yaskawa', name: 'MOTOMAN-GP8', payload: 8, reach: 727, repeatability: 0.01, ...Y,
    opw: { a1: 40, a2: -40, b: 0, c1: 330, c2: 345, c3: 340, c4: 80 },
    limits: [[-170, 170], [-65, 145], [-70, 190], [-190, 190], [-135, 135], [-360, 360]],
    maxSpeed: [455, 385, 520, 550, 550, 1000], home: [0, 0, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    pulsePerDeg: [1341.0, 1341.0, 1341.0, 1023.0, 1023.0, 568.9], // 임시값(미공개)
    source: 'Motoman GP7/GP8 데이터시트 DS-866 + ROS-I gp8_macro.xacro — 일치 (치수도의 385 = c2 345 + 40)',
  },
  {
    id: 'yaskawa-gp8l', vendor: 'yaskawa', name: 'MOTOMAN-GP8L', payload: 8, reach: 1636, repeatability: 0.02, ...Y,
    opw: { a1: 155, a2: -200, b: 0, c1: 450, c2: 714, c3: 740, c4: 80 },
    limits: [[-170, 170], [-90, 155], [-85, 150], [-200, 200], [-135, 135], [-360, 360]],
    maxSpeed: [260, 230, 260, 470, 550, 1000], home: [0, 0, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    pulsePerDeg: [1100.0, 1100.0, 1100.0, 800.0, 800.0, 480.0], // 임시값(미공개)
    source: 'Motoman GP8L 데이터시트(미주, 치수도 450/155/714/200/740/80) + ROS-I gp8l_macro.xacro — 일치',
  },
  {
    id: 'yaskawa-gp20hl', vendor: 'yaskawa', name: 'MOTOMAN-GP20HL', payload: 20, reach: 3124, repeatability: 0.07, ...Y,
    opw: { a1: 145, a2: -250, b: 0, c1: 540, c2: 1150, c3: 1812, c4: 100 },
    limits: [[-180, 180], [-90, 135], [-80, 206], [-200, 200], [-150, 150], [-455, 455]],
    maxSpeed: [180, 180, 180, 400, 430, 630], home: [0, 0, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    pulsePerDeg: [1000.0, 1000.0, 1000.0, 750.0, 750.0, 450.0], // 임시값(미공개)
    source: 'Motoman GP20HL 데이터시트(미주) + ROS-I gp20hl_macro.xacro — 사양 일치 (c3=1812 는 URDF 기준, 치수도에서 540/1150/250/100 확인)',
  },
  {
    id: 'yaskawa-gp35l', vendor: 'yaskawa', name: 'MOTOMAN-GP35L', payload: 35, reach: 2538, repeatability: 0.07, ...Y,
    opw: { a1: 145, a2: -210, b: 0, c1: 540, c2: 1150, c3: 1225, c4: 175 },
    limits: [[-180, 180], [-90, 135], [-80, 206], [-360, 360], [-125, 125], [-360, 360]],
    maxSpeed: [180, 140, 178, 250, 250, 360], home: [0, 0, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    pulsePerDeg: [800.0, 800.0, 800.0, 600.0, 600.0, 400.0], // 임시값(미공개)
    source: 'Motoman GP35L 데이터시트(미주, 치수도 540/145/1150/210/1225/175) + ROS-I gp35l_macro.xacro — 일치',
  },
  {
    id: 'yaskawa-gp50', vendor: 'yaskawa', name: 'MOTOMAN-GP50', payload: 50, reach: 2061, repeatability: 0.03, ...Y,
    opw: { a1: 145, a2: -210, b: 0, c1: 540, c2: 870, c3: 1025, c4: 175 },
    limits: [[-180, 180], [-90, 135], [-80, 206], [-360, 360], [-125, 125], [-360, 360]],
    maxSpeed: [180, 178, 178, 250, 250, 360], home: [0, 0, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    pulsePerDeg: [800.0, 800.0, 800.0, 600.0, 600.0, 400.0], // 임시값(미공개)
    source: 'Motoman GP50 데이터시트(미주, 치수도 540/145/870/210/1025/175) + ROS-I gp50_macro.xacro — 일치',
  },
  {
    id: 'yaskawa-gp70l', vendor: 'yaskawa', name: 'MOTOMAN-GP70L', payload: 70, reach: 2732, repeatability: 0.05, ...Y,
    opw: { a1: 320, a2: -235, b: 0, c1: 540, c2: 1165, c3: 1225, c4: 175 },
    limits: [[-180, 180], [-90, 155], [-80, 90], [-360, 360], [-125, 125], [-360, 360]],
    maxSpeed: [180, 123, 160, 230, 230, 350], home: [0, 0, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    pulsePerDeg: [700.0, 700.0, 700.0, 500.0, 500.0, 350.0], // 임시값(미공개)
    source: 'Motoman GP70L 데이터시트(미주, 치수도 540/320/1165/235/1225/175) + ROS-I gp70l_macro.xacro — 일치',
  },
  {
    id: 'yaskawa-gp88', vendor: 'yaskawa', name: 'MOTOMAN-GP88', payload: 88, reach: 2236, repeatability: 0.03, ...Y,
    opw: { a1: 320, a2: -210, b: 0, c1: 540, c2: 870, c3: 1025, c4: 175 },
    limits: [[-180, 180], [-90, 155], [-80, 90], [-360, 360], [-125, 125], [-360, 360]],
    maxSpeed: [170, 140, 160, 230, 230, 350], home: [0, 0, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    pulsePerDeg: [700.0, 700.0, 700.0, 500.0, 500.0, 350.0], // 임시값(미공개)
    source: 'Motoman GP88 데이터시트(미주, 치수도 540/320/870/210/1025/175) + ROS-I gp88_macro.xacro — 일치',
  },
  {
    id: 'yaskawa-gp110', vendor: 'yaskawa', name: 'MOTOMAN-GP110', payload: 110, reach: 2236, repeatability: 0.03, ...Y,
    opw: { a1: 320, a2: -235, b: 0, c1: 540, c2: 870, c3: 1020, c4: 200 },
    limits: [[-180, 180], [-90, 155], [-80, 90], [-360, 360], [-125, 125], [-360, 360]],
    maxSpeed: [140, 110, 130, 175, 175, 255], home: [0, 0, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    pulsePerDeg: [700.0, 700.0, 700.0, 500.0, 500.0, 350.0], // 임시값(미공개)
    source: 'Motoman GP110 데이터시트(미주, 치수도 540/320/870/235/1020/200) + ROS-I gp110_macro.xacro — 일치',
  },
  {
    id: 'yaskawa-gp180', vendor: 'yaskawa', name: 'MOTOMAN-GP180', payload: 180, reach: 2702, repeatability: 0.05, ...Y,
    opw: { a1: 325, a2: -300, b: 0, c1: 650, c2: 1150, c3: 1225, c4: 225 },
    limits: [[-180, 180], [-60, 76], [-86, 90], [-360, 360], [-130, 130], [-360, 360]],
    maxSpeed: [125, 115, 125, 182, 175, 265], home: [0, 0, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    pulsePerDeg: [600.0, 600.0, 600.0, 450.0, 450.0, 300.0], // 임시값(미공개)
    source: 'Motoman GP180 데이터시트(미주, 치수도 650/325/1150/300/1225/225) + ROS-I gp180_macro.xacro — 일치. 공개 도달거리 2702 는 L 상한 +76° 기준 (a1+c2·sin76°+√(c3²+a2²)=2702.0), 단순식은 +34',
  },
  {
    id: 'yaskawa-gp215', vendor: 'yaskawa', name: 'MOTOMAN-GP215', payload: 215, reach: 2912, repeatability: 0.05, ...Y,
    opw: { a1: 285, a2: -250, b: 0, c1: 650, c2: 1150, c3: 1490, c4: 250 },
    limits: [[-180, 180], [-60, 76], [-77.8, 197], [-360, 360], [-125, 125], [-360, 360]],
    maxSpeed: [100, 90, 97, 120, 120, 190], home: [0, 0, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    pulsePerDeg: [600.0, 600.0, 600.0, 450.0, 450.0, 300.0], // 임시값(미공개)
    source: 'Motoman GP215 데이터시트(미주, 치수도 650/285/1150/250/1490/250) + ROS-I gp215_macro.xacro — 일치. 공개 도달거리 2912 는 L 상한 +76° 기준 (계산 2911.7), 단순식은 +34',
  },
  {
    id: 'yaskawa-gp250', vendor: 'yaskawa', name: 'MOTOMAN-GP250', payload: 250, reach: 2710, repeatability: 0.05, ...Y,
    opw: { a1: 285, a2: -250, b: 0, c1: 650, c2: 1150, c3: 1285, c4: 250 },
    limits: [[-180, 180], [-60, 76], [-77.8, 197], [-360, 360], [-125, 125], [-360, 360]],
    maxSpeed: [100, 90, 97, 120, 120, 190], home: [0, 0, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    pulsePerDeg: [600.0, 600.0, 600.0, 450.0, 450.0, 300.0], // 임시값(미공개)
    source: 'Motoman GP250 데이터시트(미주, 치수도 650/285/1150/250/1285/250) + ROS-I gp250_macro.xacro — 일치. 공개 도달거리 2710 은 L 상한 +76° 기준 (계산 2709.9), 단순식은 +34',
  },
  {
    id: 'yaskawa-ar1440', vendor: 'yaskawa', name: 'MOTOMAN-AR1440', payload: 12, reach: 1440, repeatability: 0.02, ...Y,
    opw: { a1: 155, a2: -200, b: 0, c1: 450, c2: 614, c3: 640, c4: 100 },
    limits: [[-170, 170], [-90, 155], [-85, 140], [-150, 150], [-135, 90], [-210, 210]],
    maxSpeed: [260, 230, 260, 470, 470, 700], home: [0, 0, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    pulsePerDeg: [1100.0, 1100.0, 1100.0, 800.0, 800.0, 480.0], // 임시값(미공개)
    source: 'Motoman AR1440 데이터시트(미주, 치수도 450/155/614/200/640/100). ROS-I 패키지 없음 — 치수가 GP12 xacro 와 동일함을 확인',
  },
  {
    id: 'yaskawa-ar2010', vendor: 'yaskawa', name: 'MOTOMAN-AR2010', payload: 12, reach: 2010, repeatability: 0.03, ...Y,
    opw: { a1: 150, a2: -200, b: 0, c1: 505, c2: 760, c3: 1082, c4: 100 },
    limits: [[-180, 180], [-105, 155], [-86, 160], [-150, 150], [-135, 90], [-210, 210]],
    maxSpeed: [210, 210, 220, 435, 435, 700], home: [0, 0, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    pulsePerDeg: [1000.0, 1000.0, 1000.0, 750.0, 750.0, 450.0], // 임시값(미공개)
    source: 'Motoman AR2010 데이터시트(미주, 치수도 505/150/760/200/1082/100) + ROS-I ar2010_macro.xacro(DH 형식) · ma2010_macro.xacro — 일치',
  },
  {
    id: 'yaskawa-gp180-120', vendor: 'yaskawa', name: 'MOTOMAN-GP180-120', payload: 120, reach: 3058, repeatability: 0.05, ...Y,
    opw: { a1: 325, a2: -300, b: 0, c1: 650, c2: 1150, c3: 1590, c4: 225 },
    limits: [[-180, 180], [-60, 76], [-86, 90], [-360, 360], [-130, 130], [-360, 360]],
    maxSpeed: [125, 115, 125, 182, 175, 265], home: [0, 0, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    pulsePerDeg: [600.0, 600.0, 600.0, 450.0, 450.0, 300.0], // 임시값(미공개)
    source: 'Motoman GP180-120 데이터시트(미주, 치수도 650/325/1150/300/1590/225) + ROS-I gp180_120_macro.xacro — 일치. 공개 도달거리 3058 은 L 상한 +76° 기준 (계산 3058.9), 단순식은 +35',
  },
  {
    id: 'yaskawa-gp225', vendor: 'yaskawa', name: 'MOTOMAN-GP225', payload: 225, reach: 2702, repeatability: 0.05, ...Y,
    opw: { a1: 325, a2: -300, b: 0, c1: 650, c2: 1150, c3: 1225, c4: 250 },
    limits: [[-180, 180], [-60, 76], [-86, 90], [-360, 360], [-125, 125], [-360, 360]],
    maxSpeed: [120, 97, 115, 145, 145, 220], home: [0, 0, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    pulsePerDeg: [600.0, 600.0, 600.0, 450.0, 450.0, 300.0], // 임시값(미공개)
    source: 'Motoman GP225 데이터시트(미주) + ROS-I gp225_macro.xacro — c3: 치수도 1223 vs URDF 1225 (URDF 채택, L+76° 기준 도달거리 2702.0 과 일치). 단순식은 +34',
  },
  {
    id: 'yaskawa-ar1730', vendor: 'yaskawa', name: 'MOTOMAN-AR1730', payload: 25, reach: 1730, repeatability: 0.02, ...Y,
    opw: { a1: 150, a2: -200, b: 0, c1: 505, c2: 760, c3: 795, c4: 100 },
    limits: [[-180, 180], [-105, 155], [-86, 160], [-150, 150], [-135, 90], [-210, 210]],
    maxSpeed: [210, 210, 265, 420, 420, 885], home: [0, 0, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    pulsePerDeg: [1000.0, 1000.0, 1000.0, 750.0, 750.0, 450.0], // 임시값(미공개)
    source: 'Motoman AR1730 데이터시트(미주, 치수도 505/150/760/200/795/100). ROS-I 패키지 없음 — 치수가 GP25 xacro 와 동일함을 확인',
  },
  {
    id: 'yaskawa-hc20dtp', vendor: 'yaskawa', name: 'MOTOMAN-HC20DTP (협동)', payload: 20, reach: 1700, repeatability: 0.05, ...Y,
    opw: { a1: 0, a2: 0, b: 0, c1: 380, c2: 820, c3: 880, c4: 200 },
    limits: [[-210, 210], [-180, 180], [-67, 247], [-210, 210], [-180, 180], [-210, 210]],
    maxSpeed: [80, 80, 120, 130, 180, 180], home: [0, 0, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'Yaskawa HC20DTP 데이터시트 YR-1-06VXCP20-B00 (사양·축범위·속도) + ROS-I motoman_hc20_support opw_parameters_hc20dtp.yaml / hc20dtp_macro.xacro — 일치. 유효 도달거리 1700(점P), 절대 1900 = 1700 + 플랜지 200. TCP 속도: 협동모드 1000 / 비협동 2000 mm/s. pulsePerDeg 미지정(기본값)',
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
  {
    id: 'kawasaki-rs003n', vendor: 'kawasaki', name: 'RS003N', payload: 3, reach: 620, repeatability: 0.02, ...KW,
    opw: { a1: 120, a2: 0, b: 0, c1: 250, c2: 250, c3: 250, c4: 80 },
    limits: [[-160, 160], [-60, 150], [-150, 120], [-360, 360], [-135, 135], [-360, 360]],
    maxSpeed: [360, 250, 225, 540, 225, 540], home: [0, 0, -90, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'Kawasaki R시리즈 카탈로그(2505 KRI) RS003N 사양표·치수도 — 링크 치수는 치수도 판독 (URDF 없음), 도달거리 검산 일치',
  },
  {
    id: 'kawasaki-rs005n', vendor: 'kawasaki', name: 'RS005N', payload: 5, reach: 705, repeatability: 0.02, ...KW,
    opw: { a1: 105, a2: -80, b: 0, c1: 295, c2: 280, c3: 310, c4: 78 },
    limits: [[-180, 180], [-80, 135], [-172, 118], [-360, 360], [-145, 145], [-360, 360]],
    maxSpeed: [360, 360, 410, 460, 460, 740], home: [0, 0, -90, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'Kawasaki R시리즈 카탈로그(2505 KRI) RS005N 사양표·치수도 — 링크 치수는 치수도 판독 (URDF 없음), 전완 80mm 오프셋(a2), 도달거리 검산 일치',
  },
  {
    id: 'kawasaki-rs005l', vendor: 'kawasaki', name: 'RS005L', payload: 5, reach: 903, repeatability: 0.03, ...KW,
    opw: { a1: 105, a2: -80, b: 0, c1: 295, c2: 380, c3: 410, c4: 78 },
    limits: [[-180, 180], [-80, 135], [-172, 118], [-360, 360], [-145, 145], [-360, 360]],
    maxSpeed: [300, 300, 300, 460, 460, 740], home: [0, 0, -90, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'Kawasaki R시리즈 카탈로그(2505 KRI) RS005L 사양표·치수도 — 링크 치수는 치수도 판독 (URDF 없음), 전완 80mm 오프셋(a2), 도달거리 검산 일치',
  },
  {
    id: 'kawasaki-rs006l', vendor: 'kawasaki', name: 'RS006L', payload: 6, reach: 1650, repeatability: 0.03, ...KW,
    opw: { a1: 100, a2: 0, b: 0, c1: 430, c2: 650, c3: 900, c4: 88 },
    limits: [[-180, 180], [-105, 145], [-163, 150], [-270, 270], [-145, 145], [-360, 360]],
    maxSpeed: [250, 250, 215, 365, 380, 700], home: [0, 0, -90, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'Kawasaki R시리즈 카탈로그(2505 KRI) RS006L 사양표·치수도 — 링크 치수는 치수도 판독 (URDF 없음), 도달거리 검산 일치',
  },
  {
    id: 'kawasaki-rs007l', vendor: 'kawasaki', name: 'RS007L', payload: 7, reach: 930, repeatability: 0.03, ...KW,
    opw: { a1: 0, a2: 0, b: 0, c1: 360, c2: 455, c3: 475, c4: 78 },
    limits: [[-180, 180], [-135, 135], [-157, 157], [-200, 200], [-125, 125], [-360, 360]],
    maxSpeed: [370, 310, 410, 550, 550, 1000], home: [0, 0, -90, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'Kawasaki R시리즈 카탈로그(2505 KRI) RS007L 사양표·치수도 + 공식 khi_robot rs007l URDF — 일치',
  },
  {
    id: 'kawasaki-rs013n', vendor: 'kawasaki', name: 'RS013N', payload: 13, reach: 1460, repeatability: 0.03, ...KW,
    opw: { a1: 0, a2: 0, b: 0, c1: 505, c2: 700, c3: 760, c4: 78 },
    limits: [[-180, 180], [-105, 138], [-159, 135], [-200, 200], [-125, 125], [-360, 360]],
    maxSpeed: [265, 250, 265, 475, 475, 730], home: [0, 0, -90, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'Kawasaki R시리즈 카탈로그(2505 KRI) RS013N 사양표·치수도 + 공식 khi_robot rs013n URDF — 일치',
  },
  {
    id: 'kawasaki-rs015x', vendor: 'kawasaki', name: 'RS015X', payload: 15, reach: 3150, repeatability: 0.06, ...KW,
    opw: { a1: 150, a2: 0, b: 0, c1: 680, c2: 1150, c3: 1850, c4: 95 },
    limits: [[-180, 180], [-105, 140], [-155, 135], [-360, 360], [-145, 145], [-360, 360]],
    maxSpeed: [180, 180, 200, 410, 360, 610], home: [0, 0, -90, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'Kawasaki R시리즈 카탈로그(2505 KRI) RS015X 사양표·치수도 — 링크 치수는 치수도 판독 (URDF 없음), 도달거리 검산 일치',
  },
  {
    id: 'kawasaki-rs025n', vendor: 'kawasaki', name: 'RS025N', payload: 25, reach: 1885, repeatability: 0.04, ...KW,
    opw: { a1: 0, a2: 0, b: 0, c1: 580, c2: 885, c3: 1000, c4: 100 },
    limits: [[-180, 180], [-100, 131], [-161, 145], [-270, 270], [-145, 145], [-360, 360]],
    maxSpeed: [215, 215, 270, 420, 420, 780], home: [0, 0, -90, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'Kawasaki R시리즈 카탈로그(2505 KRI) RS025N 사양표·치수도 + 공식 khi_robot rs025n URDF — 일치',
  },
  {
    id: 'kawasaki-rs030n', vendor: 'kawasaki', name: 'RS030N', payload: 30, reach: 2100, repeatability: 0.06, ...KW,
    opw: { a1: 150, a2: 0, b: 0, c1: 680, c2: 870, c3: 1080, c4: 165 },
    limits: [[-180, 180], [-105, 140], [-155, 135], [-360, 360], [-145, 145], [-360, 360]],
    maxSpeed: [180, 180, 185, 260, 260, 360], home: [0, 0, -90, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'Kawasaki R시리즈 카탈로그(2505 KRI) RS030N/050N/080N 사양표·치수도 + 공식 khi_robot rs030n URDF — 일치 (단 rs030n_macro.xacro 는 j1 오프셋 150 을 z 축에 둠; moveit gazebo_khi_rs030n.urdf·치수도는 수평 150 → 수평 채택)',
  },
  {
    id: 'kawasaki-rs050n', vendor: 'kawasaki', name: 'RS050N', payload: 50, reach: 2100, repeatability: 0.06, ...KW,
    opw: { a1: 150, a2: 0, b: 0, c1: 680, c2: 870, c3: 1080, c4: 165 },
    limits: [[-180, 180], [-105, 140], [-155, 135], [-360, 360], [-145, 145], [-360, 360]],
    maxSpeed: [180, 180, 185, 260, 260, 360], home: [0, 0, -90, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'Kawasaki R시리즈 카탈로그(2505 KRI) RS030N/050N/080N 공통 사양표·치수도 (URDF 없음, RS030N/RS080N URDF 와 동일 치수), 도달거리 검산 일치',
  },
  {
    id: 'kawasaki-rs080n', vendor: 'kawasaki', name: 'RS080N', payload: 80, reach: 2100, repeatability: 0.06, ...KW,
    opw: { a1: 150, a2: 0, b: 0, c1: 680, c2: 870, c3: 1080, c4: 165 },
    limits: [[-180, 180], [-105, 140], [-155, 135], [-360, 360], [-145, 145], [-360, 360]],
    maxSpeed: [180, 180, 160, 185, 165, 280], home: [0, 0, -90, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'Kawasaki R시리즈 카탈로그(2505 KRI) RS030N/050N/080N 사양표·치수도 + 공식 khi_robot rs080n URDF — 일치',
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
  {
    id: 'hyundai-hdf4-5', vendor: 'hyundai', name: 'HDF4-5 (HH4)', payload: 4, reach: 581, repeatability: 0.02, ...HY,
    opw: { a1: 20, a2: -25, b: 0, c1: 347, c2: 275, c3: 285, c4: 86.5 },
    limits: [[-170, 170], [-55, 167], [-67, 200], [-190, 190], [-125, 125], [-360, 360]],
    maxSpeed: [480, 460, 520, 550, 550, 1000], home: [0, 90, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'HD현대로보틱스 HDF4-5(HH4) 제품 페이지 + 공식 매뉴얼(HH4/HH4E) 2.3 사양·2.4 치수도 + RoboDK HH4 — 치수 일치 (RoboDK c1 347.5 vs 치수도 347; 치수도 높이 908.09 로 347 확인). H 상한: 매뉴얼 +167° / 제품 페이지 +170° (매뉴얼 값 사용)',
  },
  {
    id: 'hyundai-hdf4l-11', vendor: 'hyundai', name: 'HDF4L-11 (HH4L)', payload: 4, reach: 1131, repeatability: 0.03, ...HY,
    opw: { a1: 40, a2: -40, b: 0, c1: 446, c2: 445, c3: 645, c4: 86.5 },
    limits: [[-170, 170], [-55, 180], [-70, 213], [-190, 190], [-135, 135], [-360, 360]],
    maxSpeed: [300, 230, 360, 550, 550, 1000], home: [0, 90, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'HD현대로보틱스 HDF4L-11(HH4L) 제품 페이지 + 공식 매뉴얼(HH4L/HH7/HH7E/HH8) 2.3 사양·2.4 치수도 + RoboDK HH4L — 사양·치수 모두 일치',
  },
  {
    id: 'hyundai-hdf8-8', vendor: 'hyundai', name: 'HDF8-8 (HH8)', payload: 8, reach: 832, repeatability: 0.02, ...HY,
    opw: { a1: 40, a2: -40, b: 0, c1: 446, c2: 445, c3: 345, c4: 86.5 },
    limits: [[-170, 170], [-55, 180], [-70, 213], [-190, 190], [-135, 135], [-360, 360]],
    maxSpeed: [455, 385, 520, 550, 550, 1000], home: [0, 90, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'HD현대로보틱스 HDF8-8(HH8) 제품 페이지 + 공식 매뉴얼 2.3 사양·2.4 치수도 + 공식 hdr_description hdf8_8 URDF + RoboDK HH8 — 모두 일치 (제품 페이지 H 하한 "55°" 는 -55° 의 부호 누락)',
  },
  {
    id: 'hyundai-hh010l', vendor: 'hyundai', name: 'HH010L', payload: 10, reach: 1964, repeatability: 0.04, ...HY,
    opw: { a1: 160, a2: -140, b: 0, c1: 446.6, c2: 770, c3: 1025, c4: 112 },
    limits: [[-185, 185], [-70, 195], [-80, 180], [-195, 195], [-135, 135], [-360, 360]],
    maxSpeed: [190, 180, 190, 380, 380, 600], home: [0, 90, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'HD현대로보틱스 HH010L 제품 페이지 + 공식 매뉴얼(HH020/HH020T/HH010L) 2.3 사양·2.4 치수도 + RoboDK HH010L — 치수 일치. 반복정밀도: 제품 페이지 ±0.04, 매뉴얼 ±0.08. (HDR10L-19 는 UH010L 후속 모델로 치수 다름 — 별개)',
  },
  {
    id: 'hyundai-hh012a', vendor: 'hyundai', name: 'HH012A', payload: 12, reach: 1425, repeatability: 0.04, ...HY,
    opw: { a1: 200, a2: -140, b: 0, c1: 358.5, c2: 560, c3: 650, c4: 105 },
    limits: [[-172, 172], [-78, 180], [-82, 180], [-180, 180], [-135, 135], [-360, 360]],
    maxSpeed: [230, 230, 230, 360, 410, 640], home: [0, 90, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'HD현대로보틱스 HH012A 제품 페이지 + 공식 매뉴얼 2.3 사양·2.4 치수도 + RoboDK HH012A — 일치 (치수도 c3 649.99 → 650). 같은 팔 구조인 HA006B 공식 URDF 와도 동일. 반복정밀도: 제품 페이지 ±0.04, 매뉴얼 ±0.08',
  },
  {
    id: 'hyundai-hh020l', vendor: 'hyundai', name: 'HH020L', payload: 20, reach: 3281, repeatability: 0.03, ...HY,
    opw: { a1: 320, a2: -200, b: 0, c1: 480, c2: 1150, c3: 1800, c4: 112 },
    limits: [[-180, 180], [-65, 180], [-160, 260], [-195, 195], [-135, 135], [-360, 360]],
    maxSpeed: [175, 175, 180, 360, 380, 600], home: [0, 90, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'HD현대로보틱스 HH020L 제품 페이지 + 공식 매뉴얼 2.3 사양·2.4 치수도 + RoboDK HH020L — 치수 일치 (치수도 도달 3281.08·높이 3441.08 정확히 재현). V 범위: 매뉴얼 +260~-160° / 제품 페이지 +180~-80° 상충 (매뉴얼 값 사용). 반복정밀도: 제품 페이지 ±0.03, 매뉴얼 ±0.08',
  },
  {
    id: 'hyundai-hdr30l-25', vendor: 'hyundai', name: 'HDR30L-25 (HH030L)', payload: 30, reach: 2535, repeatability: 0.05, ...HY,
    opw: { a1: 320, a2: -200, b: 0, c1: 480, c2: 870, c3: 1330, c4: 185 },
    limits: [[-180, 180], [-65, 170], [-80, 180], [-360, 360], [-125, 125], [-360, 360]],
    maxSpeed: [150, 140, 150, 250, 250, 350], home: [0, 90, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'HD현대로보틱스 HDR30L-25(HH030L) 제품 페이지 + 공식 매뉴얼(YS080/HH050/HH030L) 2.3 사양 + RoboDK HH030L 치수 — 사양 일치, RoboDK 치수로 계산한 도달 2534.95 = 공개 2535. 단, 매뉴얼의 HH030L 치수도(그림 2.6)는 HH050 도면(1030/2239)과 동일하게 실려 있어 치수도로는 확인 불가. 반복정밀도: 제품 페이지 ±0.05, 매뉴얼 ±0.1',
  },
  {
    id: 'hyundai-hdr50-22', vendor: 'hyundai', name: 'HDR50-22 (HH050)', payload: 50, reach: 2239, repeatability: 0.05, ...HY,
    opw: { a1: 320, a2: -200, b: 0, c1: 480, c2: 870, c3: 1030, c4: 185 },
    limits: [[-180, 180], [-65, 170], [-80, 180], [-360, 360], [-125, 125], [-360, 360]],
    maxSpeed: [175, 175, 175, 250, 250, 350], home: [0, 90, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'HD현대로보틱스 HDR50-22(HH050) 제품 페이지 + 공식 매뉴얼(YS080/HH050) 2.3 사양·2.4.2 치수도 + 공식 hdr_description hdr50_22 URDF + RoboDK HH050 — 모두 일치. 반복정밀도: 제품 페이지 ±0.05, 매뉴얼 ±0.1',
  },
  {
    id: 'hyundai-hdr160l-30', vendor: 'hyundai', name: 'HDR160L-30 (HS160L)', payload: 160, reach: 3036, repeatability: 0.05, ...HY,
    opw: { a1: 312, a2: -230, b: 0, c1: 608, c2: 1100, c3: 1625, c4: 220 },
    limits: [[-180, 180], [10, 155], [-80, 190], [-360, 360], [-128, 128], [-360, 360]],
    maxSpeed: [120, 115, 115, 174, 172, 260], home: [0, 90, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'HD현대로보틱스 HDR160L-30(HS160L) 제품 페이지 + 공식 매뉴얼(HS180/HS220/HS160L) 2.3 사양·2.4 치수도 + RoboDK HS160L — 모두 일치. 도달거리 3036 은 H 하한 +10° 로 제한된 값 (완전 수평 가정 시 3053). 반복정밀도: 제품 페이지 ±0.05, 매뉴얼 ±0.15',
  },
  {
    id: 'hyundai-hdr150l-31', vendor: 'hyundai', name: 'HDR150L-31 (HH150L)', payload: 150, reach: 3100, repeatability: 0.05, ...HY,
    opw: { a1: 376, a2: -230, b: 0, c1: 668, c2: 1100, c3: 1625, c4: 238.5 },
    limits: [[-180, 180], [10, 155], [-80, 190], [-360, 360], [-125, 125], [-360, 360]],
    maxSpeed: [120, 115, 115, 170, 155, 280], home: [0, 90, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'HD현대로보틱스 HDR150L-31(HH150L) 제품 페이지 + 공식 매뉴얼(HH150L/HH130SL) 2.3 사양·2.4 치수도(영/한) — 일치. 도달거리 3100 은 H 하한 +10° 제한값 (완전 수평 3117). RoboDK HH150L 은 다른 치수(a1 346, c3 1655, c4 220.5) — 치수도 우선. 반복정밀도: 제품 페이지 ±0.05, 매뉴얼 ±0.15',
  },
  {
    id: 'hyundai-hdr200l-30', vendor: 'hyundai', name: 'HDR200L-30 (HS200L)', payload: 200, reach: 3070, repeatability: 0.04, ...HY,
    opw: { a1: 346, a2: -230, b: 0, c1: 646, c2: 1100, c3: 1625, c4: 220 },
    limits: [[-180, 180], [10, 155], [-80, 190], [-360, 360], [-128, 128], [-360, 360]],
    maxSpeed: [95, 85, 85, 120, 120, 190], home: [0, 90, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'HD현대로보틱스 HDR200L-30(HS200L) 제품 페이지 + 공식 매뉴얼(HS200L/HS260/HH300) 2.3 사양·2.4 치수도(영/한) — 사양 일치, 치수도로 도달 3070.5 재현 (H 하한 +10° 제한, 완전 수평 3087). RoboDK HS200L 은 c1 653·c3 1637 로 상충 (도달 3082 로 불일치) — 치수도 우선. c1 646 은 저해상도 도면 판독값',
  },
  {
    id: 'hyundai-hdr300-26', vendor: 'hyundai', name: 'HDR300-26 (HH300)', payload: 300, reach: 2666, repeatability: 0.05, ...HY,
    opw: { a1: 346, a2: -230, b: 0, c1: 648, c2: 1100, c3: 1215, c4: 263 },
    limits: [[-180, 180], [10, 155], [-80, 190], [-360, 360], [-125, 125], [-360, 360]],
    maxSpeed: [95, 85, 85, 115, 110, 190], home: [0, 90, 0, 0, -90, 0], tcpMaxSpeed: 2000,
    source: 'HD현대로보틱스 HDR300-26(HH300) 제품 페이지 + 공식 매뉴얼(HS200L/HS260/HH300) 2.3 사양·2.4 치수도 + RoboDK HH300 — 일치 (도달 2666 = H 하한 +10° 제한값, 완전 수평 2683). 반복정밀도: 제품 페이지 ±0.05, 매뉴얼 ±0.3',
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
  {
    id: 'abb-irb120', vendor: 'abb', name: 'IRB 120-3/0.6', payload: 3, reach: 580, repeatability: 0.01, ...AB,
    opw: { a1: 0, a2: -70, b: 0, c1: 290, c2: 270, c3: 302, c4: 72 },
    limits: [[-165, 165], [-110, 110], [-110, 70], [-160, 160], [-120, 120], [-400, 400]],
    maxSpeed: [250, 250, 250, 320, 320, 420], home: [0, 0, 0, 0, 90, 0], tcpMaxSpeed: 7000,
    source: 'ABB IRB120 데이터시트 ROBO149EN_D Rev.J (2019) + ROS-I irb120_3_58 URDF — 일치 (축6 기본 ±400, 최대 ±242회전)',
  },
  {
    id: 'abb-irb1600-10', vendor: 'abb', name: 'IRB 1600-10/1.45', payload: 10, reach: 1450, repeatability: 0.05, ...AB,
    opw: { a1: 150, a2: 0, b: 0, c1: 486.5, c2: 700, c3: 600, c4: 65 },
    limits: [[-180, 180], [-90, 120], [-245, 65], [-200, 200], [-115, 115], [-400, 400]],
    maxSpeed: [180, 180, 185, 385, 400, 460], home: [0, 0, 0, 0, 90, 0], tcpMaxSpeed: 7000,
    source: 'ABB IRB1600 데이터시트(독문 Datenblatt, 10kg 판) + ROS-I opw_parameters_irb1600_10_145.yaml / irb1600_10_145 URDF — 일치. 축2 +150 은 축1 ±95° 제한 시에만 (표준 +120 사용)',
  },
  {
    id: 'abb-irb2400-16', vendor: 'abb', name: 'IRB 2400/16', payload: 16, reach: 1550, repeatability: 0.03, ...AB,
    opw: { a1: 100, a2: -135, b: 0, c1: 615, c2: 705, c3: 755, c4: 85 },
    limits: [[-180, 180], [-100, 110], [-60, 65], [-200, 200], [-120, 120], [-400, 400]],
    maxSpeed: [150, 150, 150, 360, 360, 450], home: [0, 0, 0, 0, 90, 0], tcpMaxSpeed: 7000,
    source: 'ABB IRB2400 데이터시트 PR10034EN Rev.F (2019) + ROS-I irb2400 / irb2400_12_155 URDF — 범위·속도 일치. 도달거리 계산 1572 vs 공개 1550 (+22mm, URDF 치수 그대로 유지). 2005판 반복정밀도 0.06 → 2019판 0.03',
  },
  {
    id: 'abb-irb4600-60', vendor: 'abb', name: 'IRB 4600-60/2.05', payload: 60, reach: 2050, repeatability: 0.06, ...AB,
    opw: { a1: 175, a2: -175, b: 0, c1: 495, c2: 900, c3: 960, c4: 135 },
    limits: [[-180, 180], [-90, 150], [-180, 75], [-400, 400], [-125, 120], [-400, 400]],
    maxSpeed: [175, 175, 175, 250, 250, 360], home: [0, 0, 0, 0, 90, 0], tcpMaxSpeed: 7000,
    source: 'ABB IRB4600 데이터시트 ROB0109EN (IRC5) + ROS-I irb4600_60_205 URDF — 일치 (OmniCore 속도표 미확인)',
  },
  {
    id: 'abb-irb6640-185', vendor: 'abb', name: 'IRB 6640-185/2.80', payload: 185, reach: 2800, repeatability: 0.05, ...AB,
    opw: { a1: 320, a2: -200, b: 0, c1: 780, c2: 1075, c3: 1392, c4: 200 },
    limits: [[-170, 170], [-65, 85], [-180, 70], [-300, 300], [-120, 120], [-360, 360]],
    maxSpeed: [100, 90, 90, 170, 120, 190], home: [0, 0, 0, 0, 90, 0], tcpMaxSpeed: 7000,
    source: 'ABB IRB6640 제품 사양서 3HAC028284-001 Rev.Y + ROS-I irb6640_185_280 URDF — 일치. 반복정밀도: 2010 데이터시트 ROB0001EN_E 0.07, 사양서 Rev.Y 0.05 (최신값 사용)',
  },
  {
    id: 'abb-irb7600-150', vendor: 'abb', name: 'IRB 7600-150/3.50', payload: 150, reach: 3500, repeatability: 0.19, ...AB,
    opw: { a1: 410, a2: -165, b: 0, c1: 780, c2: 1075, c3: 2012, c4: 250 },
    limits: [[-180, 180], [-60, 85], [-180, 60], [-300, 300], [-100, 100], [-360, 360]],
    maxSpeed: [100, 60, 60, 100, 100, 190], home: [0, 0, 0, 0, 90, 0], tcpMaxSpeed: 7000,
    source: 'ABB IRB7600 데이터시트 PR10074EN (2021) + ROS-I irb7600_150_350 URDF — 일치. 2010판(R9)은 축2 +80, 축6 ±300 으로 상이 (2021판·URDF 값 사용)',
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
    opw: { a1: 350, a2: 41, b: 0, c1: 675, c2: 1150, c3: 1200, c4: 215 },
    limits: [[-185, 185], [-140, -5], [-120, 155], [-350, 350], [-125, 125], [-350, 350]],
    maxSpeed: [123, 115, 112, 179, 172, 219], home: [0, -90, 90, 0, 0, 0], tcpMaxSpeed: 2000,
    source: 'KUKA 데이터시트 0000182736 + KUKA 공식 ROS2 kr210_r2700_extra URDF — 일치. 도달거리 2696 은 A2 상한 -5° 로 제한된 값 (치수상 2700.7). a2=+41: URDF 상 손목이 A3 축보다 41 mm 아래 (2026-11 부호 수정, 이전 -41 은 0점 자세 손목 높이 82 mm 오차)',
  },
  {
    id: 'kuka-kr3-r540', vendor: 'kuka', name: 'KR 3 R540 (AGILUS)', payload: 3, ratedPayload: 2, reach: 541, repeatability: 0.02, ...KU,
    opw: { a1: 20, a2: -20, b: 0, c1: 345, c2: 260, c3: 260, c4: 75 },
    limits: [[-170, 170], [-170, 50], [-110, 155], [-175, 175], [-120, 120], [-350, 350]],
    maxSpeed: [530, 529, 538, 600, 600, 800], home: [0, -90, 90, 0, 0, 0], tcpMaxSpeed: 2000,
    source: 'KUKA 데이터시트 0000-270-971 V36.1 + ROS-I kuka_experimental kr3r540 URDF — 동작범위 일치. 속도: 데이터시트에 속도표 없음 → ROS-I URDF 값',
  },
  {
    id: 'kuka-kr4-r600', vendor: 'kuka', name: 'KR 4 R600 (AGILUS)', payload: 4.63, ratedPayload: 3, reach: 601, repeatability: 0.015, ...KU,
    opw: { a1: 0, a2: -20, b: 0, c1: 330, c2: 290, c3: 310, c4: 75 },
    limits: [[-170, 170], [-195, 40], [-115, 150], [-185, 185], [-120, 120], [-350, 350]],
    maxSpeed: [336, 336, 487.5, 600, 529.1, 800], home: [0, -90, 90, 0, 0, 0], tcpMaxSpeed: 2000,
    source: 'KUKA 데이터시트 0000-356-043 V6.1 + KUKA 공식 ROS2 kr4_r600 URDF — 동작범위 일치. a1=0 (A1-A2 오프셋 없음). 속도: 데이터시트에 속도표 없음 → ROS2 값. 반복정밀도: 데이터시트 ±0.015, KUKA 브로셔 ±0.02',
  },
  {
    id: 'kuka-kr6-r700', vendor: 'kuka', name: 'KR 6 R700 sixx (AGILUS)', payload: 6, ratedPayload: 3, reach: 706.7, repeatability: 0.03, ...KU,
    opw: { a1: 25, a2: -35, b: 0, c1: 400, c2: 315, c3: 365, c4: 80 },
    limits: [[-170, 170], [-190, 45], [-120, 156], [-185, 185], [-120, 120], [-350, 350]],
    maxSpeed: [360, 300, 360, 381, 388, 615], home: [0, -90, 90, 0, 0, 0], tcpMaxSpeed: 2000,
    source: 'KUKA 데이터시트 0000-210-361 V23.1 + ROS-I opw_kinematics_kr6r700sixx.yaml / KUKA 공식 ROS2 kr6_r700_sixx — 일치. 속도: ROS2/ROS-I URDF 값 (데이터시트에 속도표 없음)',
  },
  {
    id: 'kuka-kr6-r700-2', vendor: 'kuka', name: 'KR 6 R700-2 (AGILUS)', payload: 6.8, reach: 726, repeatability: 0.02, ...KU,
    opw: { a1: 25, a2: -25, b: 0, c1: 400, c2: 335, c3: 365, c4: 90 },
    limits: [[-170, 170], [-190, 45], [-120, 156], [-185, 185], [-120, 120], [-350, 350]],
    maxSpeed: [360, 300, 360, 450, 450, 540], home: [0, -90, 90, 0, 0, 0], tcpMaxSpeed: 2000,
    source: 'KUKA 공식 ROS2 kr6_r700_2 URDF (형상·동작범위·속도) + KUKA AGILUS 브로셔 (최대 6.8 kg, 726 mm, ±0.02) / RoboDK 일치. 개별 데이터시트 미확보 — 브로셔의 정격 6 kg 은 R900-2 데이터시트(정격 3 kg)와 상충해 ratedPayload 생략',
  },
  {
    id: 'kuka-kr10-r900-2', vendor: 'kuka', name: 'KR 10 R900-2 (AGILUS)', payload: 11.1, ratedPayload: 5, reach: 901, repeatability: 0.02, ...KU,
    opw: { a1: 25, a2: -25, b: 0, c1: 400, c2: 455, c3: 420, c4: 90 },
    limits: [[-170, 170], [-190, 45], [-120, 156], [-185, 185], [-120, 120], [-350, 350]],
    maxSpeed: [300, 225, 330, 360, 360, 433], home: [0, -90, 90, 0, 0, 0], tcpMaxSpeed: 2000,
    source: 'KUKA 데이터시트 0000-290-002 V10.1 + KUKA 공식 ROS2 kr10_r900_2 / ROS-I kr10r900_2 URDF — 일치. 속도: ROS2 값 (데이터시트에 속도표 없음). 브로셔는 최대 11.3 kg 표기',
  },
  {
    id: 'kuka-kr16-2', vendor: 'kuka', name: 'KR 16-2', payload: 16, reach: 1611, repeatability: 0.05, ...KU,
    opw: { a1: 260, a2: 35, b: 0, c1: 675, c2: 680, c3: 670, c4: 158 },
    limits: [[-185, 185], [-155, 35], [-130, 154], [-350, 350], [-130, 130], [-350, 350]],
    maxSpeed: [156, 156, 156, 330, 330, 615], home: [0, -90, 90, 0, 0, 0], tcpMaxSpeed: 2000,
    source: 'KUKA KR 6-2/KR 16-2 브로셔 PF0033/E/1/0809 + ROS-I kuka_experimental kr16_2 URDF — 일치. a2=+35: URDF 상 손목이 A3 축보다 35 mm 아래 (브로셔 홈자세 높이 1320 = 675+680-35 로 확인)',
  },
  {
    id: 'kuka-kr16-r1610-2', vendor: 'kuka', name: 'KR 16 R1610-2 (CYBERTECH)', payload: 20, ratedPayload: 16, reach: 1612, repeatability: 0.04, ...KU,
    opw: { a1: 160, a2: -150, b: 0, c1: 520, c2: 780, c3: 655, c4: 153 },
    limits: [[-185, 185], [-185, 65], [-138, 175], [-350, 350], [-130, 130], [-350, 350]],
    maxSpeed: [200, 175, 190, 430, 430, 630], home: [0, -90, 90, 0, 0, 0], tcpMaxSpeed: 2000,
    source: 'KUKA 데이터시트 0000-321-015 V21.1 + KUKA 공식 ROS2 kr16_r1610_2 URDF — 일치',
  },
  {
    id: 'kuka-kr20-r1810-2', vendor: 'kuka', name: 'KR 20 R1810-2 (CYBERTECH)', payload: 23.9, ratedPayload: 20, reach: 1813, repeatability: 0.04, ...KU,
    opw: { a1: 160, a2: -150, b: 0, c1: 520, c2: 780, c3: 860, c4: 153 },
    limits: [[-185, 185], [-185, 65], [-138, 175], [-350, 350], [-130, 130], [-350, 350]],
    maxSpeed: [200, 175, 190, 430, 430, 630], home: [0, -90, 90, 0, 0, 0], tcpMaxSpeed: 2000,
    source: 'KUKA 데이터시트 0000-321-012 V12.1 + KUKA 공식 ROS2 kr20_r1810_2 URDF — 일치. A2 속도: 데이터시트 175, ROS2 171.6',
  },
  {
    id: 'kuka-kr30-r2100', vendor: 'kuka', name: 'KR 30 R2100 (IONTEC)', payload: 36.5, ratedPayload: 30, reach: 2101, repeatability: 0.05, ...KU,
    opw: { a1: 175, a2: -50, b: 0, c1: 575, c2: 890, c3: 1035, c4: 185 },
    limits: [[-185, 185], [-175, 60], [-120, 165], [-180, 180], [-125, 125], [-350, 350]],
    maxSpeed: [180, 165, 180, 250, 250, 360], home: [0, -90, 90, 0, 0, 0], tcpMaxSpeed: 2000,
    source: 'KUKA 데이터시트 0000-332-113 V6.1 + KUKA 공식 ROS2 kr30_r2100 URDF — 일치',
  },
  {
    id: 'kuka-kr120-r2700-2', vendor: 'kuka', name: 'KR 120 R2700-2 (QUANTEC)', payload: 167, ratedPayload: 120, reach: 2701, repeatability: 0.05, ...KU,
    opw: { a1: 330, a2: -115, b: 0, c1: 645, c2: 1150, c3: 1220, c4: 215 },
    limits: [[-185, 185], [-140, -5], [-120, 168], [-350, 350], [-125, 125], [-350, 350]],
    maxSpeed: [120, 115, 120, 190, 180, 260], home: [0, -90, 90, 0, 0, 0], tcpMaxSpeed: 2000,
    source: 'KUKA 데이터시트 0000-346-518 V6.1 (KR 120 R2700-2 F) + KUKA 공식 ROS2 kr120_r2700_2 URDF — 형상·범위 일치. A1~A3 속도: 데이터시트 120/115/120, ROS2 116.8/111.5/119.4',
  },
  {
    id: 'kuka-kr150-r3100-2', vendor: 'kuka', name: 'KR 150 R3100-2 (QUANTEC)', payload: 220, ratedPayload: 150, reach: 3100, repeatability: 0.05, ...KU,
    opw: { a1: 330, a2: -115, b: 0, c1: 645, c2: 1350, c3: 1420, c4: 215 },
    limits: [[-185, 185], [-140, -5], [-120, 168], [-350, 350], [-125, 125], [-350, 350]],
    maxSpeed: [105, 107, 114, 190, 180, 260], home: [0, -90, 90, 0, 0, 0], tcpMaxSpeed: 2000,
    source: 'KUKA 데이터시트 0000-325-902 V9.1 + ROS-I opw_parameters_kr150r3100_2.yaml / KUKA 공식 ROS2 kr150_r3100_2 URDF — 일치',
  },
  {
    id: 'kuka-kr240-r2900-2', vendor: 'kuka', name: 'KR 240 R2900-2 (QUANTEC)', payload: 319, ratedPayload: 240, reach: 2900, repeatability: 0.05, ...KU,
    opw: { a1: 330, a2: -115, b: 0, c1: 645, c2: 1350, c3: 1220, c4: 240 },
    limits: [[-185, 185], [-140, -5], [-120, 168], [-350, 350], [-122.5, 122.5], [-350, 350]],
    maxSpeed: [103, 94, 100, 170, 129, 206], home: [0, -90, 90, 0, 0, 0], tcpMaxSpeed: 2000,
    source: 'KUKA 데이터시트 0000-325-896 V8.1 + KUKA 공식 ROS2 kr240_r2900_2 URDF — 일치',
  },
  {
    id: 'kuka-kr210-r3100', vendor: 'kuka', name: 'KR 210 R3100 ultra (QUANTEC)', payload: 210, reach: 3095, repeatability: 0.06, ...KU,
    opw: { a1: 350, a2: 41, b: 0, c1: 675, c2: 1350, c3: 1400, c4: 240 },
    limits: [[-185, 185], [-140, -5], [-120, 155], [-350, 350], [-122.5, 122.5], [-350, 350]],
    maxSpeed: [105, 101, 107, 136, 129, 206], home: [0, -90, 90, 0, 0, 0], tcpMaxSpeed: 2000,
    source: 'KUKA 공식 ROS2 kr210_r3100_ultra URDF (형상·범위·속도, rad/s→°/s 반올림) + RoboDK (210 kg, 3095 mm, ±0.06). 데이터시트 원본 미확보. a2=+41: URDF 상 손목이 A3 축보다 41 mm 아래. 도달거리 3095 는 A2 상한 -5° 로 제한된 값 (치수상 3100.6)',
  },
  // ---------- Doosan (협동로봇) ----------
  {
    id: 'doosan-m0609', vendor: 'doosan', reachRef: 'flange', name: 'M0609', payload: 6, reach: 900, repeatability: 0.03, ...DS,
    opw: { a1: 0, a2: 0, b: 6.2, c1: 134.5, c2: 411, c3: 368, c4: 121 },
    limits: [[-360, 360], [-360, 360], [-150, 150], [-360, 360], [-360, 360], [-360, 360]],
    maxSpeed: [150, 150, 180, 225, 225, 225], home: [0, 0, 90, 0, 90, 0], tcpMaxSpeed: 1000,
    source: 'doosan-robot2 URDF(m0609) — 치수·관절 한계·속도. 매뉴얼 3.5.0 사양표와 관절 범위·속도 일치. 반복정밀도는 사양표 열 정렬이 불분명해 열 순서대로 읽은 값(확인 필요)',
  },
  {
    id: 'doosan-m0617', vendor: 'doosan', reachRef: 'flange', name: 'M0617', payload: 6, reach: 1700, repeatability: 0.1, ...DS,
    opw: { a1: 0, a2: 0, b: 34.5, c1: 153, c2: 845, c3: 734, c4: 121 },
    limits: [[-360, 360], [-360, 360], [-165, 165], [-360, 360], [-360, 360], [-360, 360]],
    maxSpeed: [100, 100, 150, 225, 225, 225], home: [0, 0, 90, 0, 90, 0], tcpMaxSpeed: 1000,
    source: 'doosan-robot2 URDF(m0617) — 치수·관절 한계·속도. 매뉴얼 3.5.0 사양표와 관절 범위·속도 일치. 반복정밀도는 사양표 열 정렬이 불분명해 열 순서대로 읽은 값(확인 필요)',
  },
  {
    id: 'doosan-m1013', vendor: 'doosan', reachRef: 'flange', name: 'M1013', payload: 10, reach: 1300, repeatability: 0.05, ...DS,
    opw: { a1: 0, a2: 0, b: 34.5, c1: 152.5, c2: 620, c3: 559, c4: 121 },
    limits: [[-360, 360], [-360, 360], [-160, 160], [-360, 360], [-360, 360], [-360, 360]],
    maxSpeed: [120, 120, 180, 225, 225, 225], home: [0, 0, 90, 0, 90, 0], tcpMaxSpeed: 1000,
    source: 'doosan-robot2 URDF(m1013) — 치수·관절 한계·속도. 매뉴얼 3.5.0 사양표와 관절 범위·속도 일치. 반복정밀도 ±0.05 (매뉴얼 2.9; 구 브로슈어는 ±0.1)',
  },
  {
    id: 'doosan-m1509', vendor: 'doosan', reachRef: 'flange', name: 'M1509', payload: 15, reach: 900, repeatability: 0.03, ...DS,
    opw: { a1: 0, a2: 0, b: 34.5, c1: 153, c2: 411, c3: 368, c4: 121 },
    limits: [[-360, 360], [-360, 360], [-150, 150], [-360, 360], [-360, 360], [-360, 360]],
    maxSpeed: [150, 150, 180, 225, 225, 225], home: [0, 0, 90, 0, 90, 0], tcpMaxSpeed: 1000,
    source: 'doosan-robot2 URDF(m1509) — 치수·관절 한계·속도. 매뉴얼 3.5.0 사양표와 관절 범위·속도 일치. 반복정밀도는 사양표 열 정렬이 불분명해 열 순서대로 읽은 값(확인 필요)',
  },
  {
    id: 'doosan-h2017', vendor: 'doosan', reachRef: 'flange', name: 'H2017', payload: 20, reach: 1700, repeatability: 0.1, ...DS,
    opw: { a1: 0, a2: 0, b: 9.9, c1: 344.3, c2: 845, c3: 734, c4: 121 },
    limits: [[-360, 360], [-125, 125], [-160, 160], [-360, 360], [-360, 360], [-360, 360]],
    maxSpeed: [100, 80, 100, 180, 180, 180], home: [0, 0, 90, 0, 90, 0], tcpMaxSpeed: 1000,
    source: 'doosan-robot2 URDF(h2017) — 치수·관절 한계·속도. 매뉴얼 3.5.0 사양표와 관절 범위·속도 일치. 반복정밀도는 사양표 열 정렬이 불분명해 열 순서대로 읽은 값(확인 필요)',
  },
  {
    id: 'doosan-h2515', vendor: 'doosan', reachRef: 'flange', name: 'H2515', payload: 25, reach: 1500, repeatability: 0.1, ...DS,
    opw: { a1: 0, a2: 0, b: 9.9, c1: 344.3, c2: 759.5, c3: 619.5, c4: 121 },
    limits: [[-360, 360], [-125, 125], [-160, 160], [-360, 360], [-360, 360], [-360, 360]],
    maxSpeed: [100, 80, 100, 180, 180, 180], home: [0, 0, 90, 0, 90, 0], tcpMaxSpeed: 1000,
    source: 'doosan-robot2 URDF(h2515) — 치수·관절 한계·속도. 매뉴얼 3.5.0 사양표와 관절 범위·속도 일치. 반복정밀도는 사양표 열 정렬이 불분명해 열 순서대로 읽은 값(확인 필요)',
  },
  {
    id: 'doosan-a0509', vendor: 'doosan', reachRef: 'flange', name: 'A0509', payload: 5, reach: 900, repeatability: 0.03, ...DS,
    opw: { a1: 0, a2: 0, b: 0, c1: 156, c2: 409, c3: 367, c4: 124 },
    limits: [[-360, 360], [-360, 360], [-160, 160], [-360, 360], [-360, 360], [-360, 360]],
    maxSpeed: [180, 180, 180, 360, 360, 360], home: [0, 0, 90, 0, 90, 0], tcpMaxSpeed: 1000,
    source: 'doosan-robot2 URDF(a0509) — 치수. 관절 범위·속도는 매뉴얼 3.5.0 A 시리즈 사양표(URDF J4~J6 속도 360 일치). 가반하중·반복정밀도는 사양표 열 정렬이 불분명해 모델명 기준(확인 필요)',
  },
  {
    id: 'doosan-a0912', vendor: 'doosan', reachRef: 'flange', name: 'A0912', payload: 9, reach: 1200, repeatability: 0.05, ...DS,
    opw: { a1: 0, a2: 0, b: 39, c1: 195, c2: 560, c3: 516, c4: 124 },
    limits: [[-360, 360], [-360, 360], [-160, 160], [-360, 360], [-360, 360], [-360, 360]],
    maxSpeed: [180, 180, 180, 360, 360, 360], home: [0, 0, 90, 0, 90, 0], tcpMaxSpeed: 1000,
    source: 'doosan-robot2 URDF(a0912) — 치수. 관절 범위·속도는 매뉴얼 3.5.0 A 시리즈 사양표. 가반하중·반복정밀도는 사양표 열 정렬이 불분명해 모델명 기준(확인 필요)',
  },
];

for (const r of ROBOTS) r.maxAccelTime ??= r.payload > 100 ? 0.45 : 0.25;

export const getRobot = (id) => ROBOTS.find((r) => r.id === id);
