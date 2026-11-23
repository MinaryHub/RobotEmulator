// 제조사별 알람 코드 매핑 (브라우저/Node 공용, 의존성 없음)
// 내부 표준 알람 코드(ESTOP, FENCE, COLLISION 등)를 각 제조사 컨트롤러의 대표 알람 번호로 매핑한다.
// 참고: 현장 HMI/PLC 알람 테이블 시험용 근사 매핑이며, 모델/컨트롤러 세대에 따라 세부 번호가 다를 수 있다.

const MAP = {
  yaskawa: {
    ESTOP:       { code: '4000', name: 'EMERGENCY STOP' },
    FENCE:       { code: '4005', name: 'SAFETY GUARD OPEN' },
    COLLISION:   { code: '4315', name: 'COLLISION DETECT' },
    UNREACHABLE: { code: '4406', name: 'OUT OF RANGE (ABSO DATA)' },
    SINGULARITY: { code: '4428', name: 'SINGULAR POINT' },
    LIMIT:       { code: '4402', name: 'SOFT LIMIT' },
    PROGRAM:     { code: '4414', name: 'JOB SYNTAX / EXECUTION ERROR' },
    SERVO_TRIP:  { code: '1300', name: 'SERVO AMP FAULT' },
    INTERNAL:    { code: '0100', name: 'SYSTEM ERROR' },
  },
  kawasaki: {
    ESTOP:       { code: 'E0102', name: 'Emergency stop' },
    FENCE:       { code: 'E0107', name: 'Safety fence open' },
    COLLISION:   { code: 'E1123', name: 'Collision detected' },
    UNREACHABLE: { code: 'E1019', name: 'Destination out of motion range' },
    SINGULARITY: { code: 'E1032', name: 'Wrist singularity' },
    LIMIT:       { code: 'E1013', name: 'Joint soft limit exceeded' },
    PROGRAM:     { code: 'P0102', name: 'Program execution error' },
    SERVO_TRIP:  { code: 'E1101', name: 'Servo power off / amp fault' },
    INTERNAL:    { code: 'E0001', name: 'Controller internal error' },
  },
  hyundai: {
    ESTOP:       { code: 'E0010', name: 'Emergency stop' },
    FENCE:       { code: 'E0012', name: 'Safety gate open' },
    COLLISION:   { code: 'E0155', name: 'Collision detection' },
    UNREACHABLE: { code: 'E0104', name: 'Target unreachable' },
    SINGULARITY: { code: 'E0108', name: 'Singularity error' },
    LIMIT:       { code: 'E0102', name: 'Soft limit error' },
    PROGRAM:     { code: 'E0201', name: 'Job execution error' },
    SERVO_TRIP:  { code: 'E0031', name: 'Servo drive fault' },
    INTERNAL:    { code: 'E0999', name: 'Controller system error' },
  },
  abb: {
    ESTOP:       { code: '20206', name: 'Emergency Stop' },
    FENCE:       { code: '20205', name: 'Auto Stop / Guard Open' },
    COLLISION:   { code: '50204', name: 'Motion Supervision' },
    UNREACHABLE: { code: '50050', name: 'Position outside reach' },
    SINGULARITY: { code: '50026', name: 'Close to singularity' },
    LIMIT:       { code: '50027', name: 'Joint out of range' },
    PROGRAM:     { code: '40101', name: 'RAPID execution error' },
    SERVO_TRIP:  { code: '38001', name: 'Drive unit fault' },
    INTERNAL:    { code: '10001', name: 'System failure' },
  },
  kuka: {
    ESTOP:       { code: 'KSS00001', name: 'Emergency Stop' },
    FENCE:       { code: 'KSS00020', name: 'Operator Safety Open' },
    COLLISION:   { code: 'KSS01133', name: 'Collision Detection' },
    UNREACHABLE: { code: 'KSS01442', name: 'Workspace Error' },
    SINGULARITY: { code: 'KSS01447', name: 'Singularity Position' },
    LIMIT:       { code: 'KSS01105', name: 'Software Limit Switch' },
    PROGRAM:     { code: 'KSS01422', name: 'KRL Runtime Error' },
    SERVO_TRIP:  { code: 'KSS26002', name: 'Drive Error / Servo Fault' },
    INTERNAL:    { code: 'KSS00404', name: 'Controller Internal Error' },
  },
  doosan: {
    ESTOP:       { code: '1001', name: 'Emergency Stop' },
    FENCE:       { code: '1002', name: 'Protective Stop (Safeguard)' },
    COLLISION:   { code: '1105', name: 'Collision Detected' },
    UNREACHABLE: { code: '2101', name: 'IK Solution Not Found' },
    SINGULARITY: { code: '2103', name: 'Singularity Area' },
    LIMIT:       { code: '2001', name: 'Joint Limit Exceeded' },
    PROGRAM:     { code: '3001', name: 'DRL Execution Error' },
    SERVO_TRIP:  { code: '1201', name: 'Servo Fault' },
    INTERNAL:    { code: '9000', name: 'System Fault' },
  },
  ur: {
    ESTOP:       { code: 'C153', name: 'Emergency Stop' },
    FENCE:       { code: 'C154', name: 'Safeguard Stop' },
    COLLISION:   { code: 'C157', name: 'Protective Stop: Collision' },
    UNREACHABLE: { code: 'C204', name: 'Inverse Kinematics Failed' },
    SINGULARITY: { code: 'C206', name: 'Near Singularity' },
    LIMIT:       { code: 'C158', name: 'Joint Position Limit' },
    PROGRAM:     { code: 'C300', name: 'URScript Runtime Error' },
    SERVO_TRIP:  { code: 'C150', name: 'Joint Motor Fault' },
    INTERNAL:    { code: 'C100', name: 'Controller Fault' },
  },
};

export function vendorAlarm(vendor, code) {
  const entry = MAP[vendor]?.[code];
  if (entry) return entry;
  return { code: String(code || 'ALARM'), name: String(code || 'Alarm') };
}

export const ALARM_CODES = Object.keys(MAP.yaskawa);
