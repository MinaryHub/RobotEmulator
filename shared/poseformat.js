// 제조사별 직교좌표 자세 표현 변환
//  yaskawa : X,Y,Z,Rx,Ry,Rz  (R = Rz*Ry*Rx, 고정축 XYZ)
//  hyundai : X,Y,Z,Rx,Ry,Rz  (야스카와와 동일 관례로 가정)
//  kuka    : X,Y,Z,A,B,C     (R = Rz(A)*Ry(B)*Rx(C))
//  kawasaki: X,Y,Z,O,A,T     (ZYZ 오일러: R = Rz(O)*Ry(A)*Rz(T))
//  abb     : x,y,z,q1..q4    (쿼터니언 w,x,y,z)
import { RfromZYX, ZYXfromR, RfromZYZ, ZYZfromR, quatFromR, RfromQuat } from './math.js';

export function toVendorPose(vendor, pose) {
  const [x, y, z] = pose.p;
  switch (vendor) {
    case 'abb': return [x, y, z, ...quatFromR(pose.R)];
    case 'kawasaki': return [x, y, z, ...ZYZfromR(pose.R)];
    case 'kuka': { const [a, b, c] = ZYXfromR(pose.R); return [x, y, z, a, b, c]; }
    default: { const [rz, ry, rx] = ZYXfromR(pose.R); return [x, y, z, rx, ry, rz]; }
  }
}

export function fromVendorPose(vendor, v) {
  const p = [v[0], v[1], v[2]];
  switch (vendor) {
    case 'abb': return { p, R: RfromQuat([v[3], v[4], v[5], v[6]]) };
    case 'kawasaki': return { p, R: RfromZYZ(v[3], v[4], v[5]) };
    case 'kuka': return { p, R: RfromZYX(v[3], v[4], v[5]) };
    default: return { p, R: RfromZYX(v[5], v[4], v[3]) };
  }
}

// 툴/좌표계 정의는 공통으로 [x,y,z,rx,ry,rz] (R = Rz*Ry*Rx) 사용
export const frameFromXYZRPY = (v) => ({ p: [v[0], v[1], v[2]], R: RfromZYX(v[5] || 0, v[4] || 0, v[3] || 0) });
export const xyzrpyFromFrame = (f) => { const [rz, ry, rx] = ZYXfromR(f.R); return [...f.p, rx, ry, rz]; };
