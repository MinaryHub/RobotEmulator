import { ROBOTS } from '../shared/robots.js';
import { fkFlange, ikFlangeAll, ikNearest, jointFrames } from '../shared/kinematics.js';
import { norm, sub, rotAngle } from '../shared/math.js';

let fail = 0;
for (const m of ROBOTS) {
  let ok = 0, n = 300;
  for (let t = 0; t < n; t++) {
    const j = m.limits.map(([lo, hi]) => lo + Math.random() * (hi - lo));
    const f = fkFlange(m, j);
    // jointFrames 마지막 프레임 = fk 와 일치해야 함
    const fr = jointFrames(m, j).at(-1);
    if (norm(sub(fr.p, f.p)) > 1e-6 || rotAngle(fr.R, f.R) > 1e-6) { console.log('frames mismatch', m.id, fr.p, f.p); fail++; break; }
    const sols = ikFlangeAll(m, f);
    const match = sols.some((s) => s.every((v, i) => { const d = ((v - j[i]) % 360 + 540) % 360 - 180; return Math.abs(d) < 1e-4; }));
    const near = ikNearest(m, f, j);
    const nearOk = near && near.every((v, i) => Math.abs(v - j[i]) < 1e-4);
    if (match && nearOk) ok++;
  }
  console.log(m.id.padEnd(20), `${ok}/${n}`, 'home flange', fkFlange(m, m.home).p.map((v) => v.toFixed(1)).join(','));
  if (ok < n * 0.97) fail++;
}
// 공개 도달거리 vs 치수 계산값 (a1 + c2·max sin(J2) + sqrt(c3² + a2²)) — 손목중심 기준
//  J2(하완) 관절 한계 안에서 하완이 앞으로 가장 많이 기울어진 각도를 사용 (예: Yaskawa GP180 L 상한 +76°, KUKA KR210 A2 -5°)
const DEG_ = Math.PI / 180;
function lowerArmMaxSin(m) {
  // OPW 내부각 q2: 0 = 하완 수직, + = 전방
  const [lo, hi] = m.limits[1].map((v) => v * m.signs[1] - m.offsets[1]).sort((x, y) => x - y);
  if (lo <= 90 && hi >= 90) return 1;
  return Math.max(Math.sin(lo * DEG_), Math.sin(hi * DEG_));
}
console.log('\n도달거리 검산 (공개값 / 치수계산 / 차이)');
for (const m of ROBOTS) {
  const k = m.opw, calc = k.a1 + k.c2 * lowerArmMaxSin(m) + Math.hypot(k.c3, k.a2), d = calc - m.reach;
  console.log(m.id.padEnd(20), String(m.reach).padStart(6), calc.toFixed(1).padStart(8), d.toFixed(1).padStart(7), Math.abs(d) > 25 ? ' ← 확인 필요' : '');
  if (Math.abs(d) > 40) fail++;
}
process.exit(fail ? 1 : 0);
