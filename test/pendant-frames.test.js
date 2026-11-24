// Phase 1 (v1.4) 검증 테스트:
//  - 3점 User Frame 계산 & Tool/User 좌표계 관리 & User 기준 조그
//  - INFORM ///TOOL, ///USER 헤더 및 IMOV UF#(n)
//  - Touch-Up (좌표 덮어쓰기) · Go To Point · Set PP to Cursor (7개 제조사 문법)
//  - TEACH(T1) 모드 250 mm/s TCP 속도 상한 & 외부 연동 ×1 배속 잠금
//  - ProtocolManager 제조사 격리 모드 (vendor ↔ all, 로봇 변경 시 자동 전환)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Controller, TEACH_TCP_MAX } from '../server/controller.js';
import { ProjectStore } from '../server/project.js';
import { ProtocolManager } from '../server/protocols/index.js';
import { computeUserFrame3Pt, extractPointAtLine, touchUpAtLine } from '../shared/teachOps.js';
import { fkTcp } from '../shared/kinematics.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  OK  ${m}`); } else { fail++; console.log(`  NG  ${m}`); } };
const near = (a, b, tol = 0.2) => Math.abs(a - b) <= tol;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ 1. 3점 User Frame 수학
console.log('\n■ 1. 3점 User Frame 수학');
{
  // Z축 +90° 회전된 좌표계: 원점 (300,100,200), +X = (300,200,200), +XY = (200,100,200)
  const uf = computeUserFrame3Pt([300, 100, 200], [300, 200, 200], [200, 100, 200]);
  ok(near(uf[0], 300) && near(uf[1], 100) && near(uf[2], 200), `원점 일치: [${uf.slice(0, 3)}]`);
  ok(near(uf[3], 0) && near(uf[4], 0) && near(uf[5], 90), `Z +90° 회전 일치: RPY=[${uf.slice(3)}]`);
  let err1 = false;
  try { computeUserFrame3Pt([0, 0, 0], [0.2, 0, 0], [0, 10, 0]); } catch { err1 = true; }
  ok(err1, '원점~+X 거리 부족 시 오류 발생');
  let err2 = false;
  try { computeUserFrame3Pt([0, 0, 0], [100, 0, 0], [200, 0, 0]); } catch { err2 = true; }
  ok(err2, '세 점이 일직선일 때 오류 발생');
}

// ------------------------------------------------------------ 2. Tool/User 좌표계 + USER 조그 + 프로젝트 저장
console.log('\n■ 2. Tool/User 좌표계 · USER 조그 · 프로젝트 복원');
{
  const c = new Controller();
  c.setRobot('yaskawa-gp7');
  c.setMode('TEACH', 'ui');
  c.setServo(true, 'ui');
  c.setFrame('tool', 2, { name: 'LongGrip', pose: [0, 0, 200, 0, 0, 0] });
  c.setActiveFrames({ activeTool: 2 });
  ok(near(c.tool.p[2], 200, 0.01), `Tool #2 활성화 → tool.p[2]=${c.tool.p[2]}`);
  // User Frame #1: Z축 +90° 회전 (User +X = World +Y)
  c.teachUserFrame3Pt(1, { origin: [300, 0, 200], xPoint: [300, 100, 200], xyPoint: [200, 0, 200], name: 'JigA', activate: true });
  ok(c.frames.activeUser === 1 && c.frames.users[0].name === 'JigA', '3점 티칭 후 User #1 자동 활성화');
  const pBefore = fkTcp(c.robot, c.joints, c.tool, null).p;
  const r = c.stepJog({ type: 'cart', axis: 0, dir: 1, step: 10, frame: 'user' }, 'ui');
  const pAfter = fkTcp(c.robot, c.joints, c.tool, null).p;
  ok(r.ok && near(pAfter[0] - pBefore[0], 0, 0.2) && near(pAfter[1] - pBefore[1], 10, 0.2),
    `USER +X 10mm 스텝 조그 → World dX=${(pAfter[0] - pBefore[0]).toFixed(2)}, dY=${(pAfter[1] - pBefore[1]).toFixed(2)}`);

  // ProjectStore 저장/복원 검증
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'robotemu-p1-'));
  try {
    const ps = new ProjectStore(c, dir);
    c.setSafetyOptions({ teachSpeedLimit: false });
    c.setTimeScaleLock(true);
    const snap = ps.serialize('frame-test');
    const c2 = new Controller();
    const ps2 = new ProjectStore(c2, dir);
    ps2.apply(snap);
    ok(c2.frames.activeTool === 2 && c2.frames.activeUser === 1 && c2.frames.users[0].name === 'JigA' && near(c2.frames.users[0].pose[5], 90),
      '프로젝트 저장/복원 시 Tool/User 좌표계 유지');
    ok(c2.safety.teachSpeedLimit === false && c2.lockTimeScaleOnExt === true,
      '프로젝트 저장/복원 시 teachSpeedLimit · lockTimeScaleOnExt 유지');
    c2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  c.close();
}

// ------------------------------------------------------------ 3. INFORM ///TOOL, ///USER 및 IMOV UF#(n)
console.log('\n■ 3. INFORM ///TOOL · ///USER · IMOV UF#(n)');
{
  const c = new Controller();
  c.setRobot('yaskawa-gp7');
  c.setMode('PLAY', 'ui');
  c.setServo(true, 'ui');
  c.setTimeScale(8);
  // Tool #2 (Z=180mm), User #1 (origin=[350, -50, 200], Rz=+90° → User +X = World +Y)
  c.setFrame('tool', 2, { name: 'T2', pose: [0, 0, 180, 0, 0, 0] });
  c.setFrame('user', 1, { name: 'UF1', pose: [350, -50, 200, 0, 0, 90] });
  const jbi = `/JOB
//NAME UFTEST
//POS
///NPOS 1,0,0,0,0,0
///TOOL 2
///USER 1
///POSTYPE USER
///RECTAN
C00000=50.000,0.000,50.000,180.0000,0.0000,0.0000
//INST
NOP
MOVL C00000 V=200.0 PL=0
SETE P000 (1) 20
SETE P000 (2) 0
SETE P000 (3) 0
IMOV P000 V=200.0 UF#(1)
END
`;
  c.loadFiles({ 'UFTEST.JBI': jbi }, true);
  await c.start();
  while (c.vm.status === 'running' || !c.motionIdle) await sleep(20);
  // C00000 in UF1=(50,0,50) + IMOV UF#(1) (+20,0,0) → UF1=(70,0,50) → World=(350, -50+70, 200+50) = (350, 20, 250) with Tool #2
  const tcpT2 = fkTcp(c.robot, c.joints, c.getToolFrame(2), null).p;
  ok(c.vm.status === 'done' && !c.alarms.length, `INFORM ///TOOL + ///USER 잡 정상 완료 (${c.alarms.map((a) => a.msg).join(';')})`);
  ok(near(tcpT2[0], 350, 0.5) && near(tcpT2[1], 20, 0.5) && near(tcpT2[2], 250, 0.5),
    `Tool#2 + User#1 + IMOV UF#(1) 월드 TCP 일치: [${tcpT2.map((v) => v.toFixed(1)).join(', ')}] ≈ [350, 20, 250]`);
  c.close();
}

// ------------------------------------------------------------ 4. Touch-Up & Go To Point (7개 제조사)
console.log('\n■ 4. Touch-Up & Go To Point (7개 제조사 문법)');
{
  const tcp6 = [410.5, -120.25, 250.0, 180.0, 0.0, -90.0];
  const joints6 = [15.5, -20.0, 35.0, 0.0, -75.0, 10.0];
  const robot = { pulsePerDeg: [1000, 1000, 1000, 1000, 1000, 1000] };

  // Yaskawa: MOVL C00001 줄에서 Touch-Up → //POS 의 C00001= 수정 + PULSE 줄 지원
  const ySrc = `/JOB\n//NAME T\n//POS\n///PULSE\nC00000=0,0,0,0,-90000,0\n///POSTYPE BASE\nC00001=300,0,200,180,0,0\n//INST\nNOP\nMOVJ C00000 VJ=50\nMOVL C00001 V=200\nEND`;
  const yt = touchUpAtLine({ vendor: 'yaskawa', text: ySrc, fileName: 'T.JBI', cursorLine: 11, tcp: tcp6, joints: joints6, robot });
  ok(yt.ok && yt.label === 'C00001' && yt.text.includes('C00001=410.500,-120.250,250.000,180.0000,0.0000,-90.0000'), 'Yaskawa: MOVL C00001 → //POS C00001 덮어쓰기');
  const ytp = touchUpAtLine({ vendor: 'yaskawa', text: ySrc, fileName: 'T.JBI', cursorLine: 10, tcp: tcp6, joints: joints6, robot });
  ok(ytp.ok && ytp.kind === 'joints' && ytp.text.includes('C00000=15500,-20000,35000,0,-75000,10000'), 'Yaskawa: PULSE C00000 덮어쓰기');

  // Kawasaki: 심볼 참조 POINT p1 = TRANS(...)
  const kSrc = `.PROGRAM m()\n  POINT p1 = TRANS(100, 200, 300, 0, 180, 0)\n  LMOVE p1\n.END`;
  const kt = touchUpAtLine({ vendor: 'kawasaki', text: kSrc, fileName: 'm.as', cursorLine: 3, tcp: tcp6, joints: joints6 });
  ok(kt.ok && kt.label === 'p1' && kt.text.includes('TRANS(410.500, -120.250, 250.000, 180.000, 0.000, -90.000)'), 'Kawasaki: LMOVE p1 → POINT p1 덮어쓰기');

  // Hyundai: MOVE L,(...)
  const hSrc = `MOVE L,(100,200,300,180,0,0),S=250mm/sec,A=0,T=0`;
  const ht = touchUpAtLine({ vendor: 'hyundai', text: hSrc, fileName: '0001.job', cursorLine: 1, tcp: tcp6, joints: joints6 });
  ok(ht.ok && ht.text.includes('(410.500,-120.250,250.000,180.000,0.000,-90.000)'), 'Hyundai: MOVE L 좌표 덮어쓰기');

  // ABB: MoveL pPick → CONST robtarget pPick := ...
  const abbTcp = [410.5, -120.25, 250.0, 0, 1, 0, 0];
  const aSrc = `MODULE M\n  CONST robtarget pPick := [[300,0,200],[0,1,0,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]];\n  PROC main()\n    MoveL pPick, v200, fine, tool0;\n  ENDPROC\nENDMODULE`;
  const at = touchUpAtLine({ vendor: 'abb', text: aSrc, fileName: 'M.mod', cursorLine: 4, tcp: abbTcp, joints: joints6 });
  ok(at.ok && at.label === 'pPick' && at.text.includes('[[410.500,-120.250,250.000],[0.000000,1.000000,0.000000,0.000000],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]'), 'ABB: MoveL pPick → robtarget 덮어쓰기');

  // KUKA: .src 의 LIN XP1 → .dat 의 DECL E6POS XP1 (S/T/E1 보존)
  const krlSrc = `DEF main()\n  LIN XP1\nEND`;
  const krlDat = `DEFDAT main\n  DECL E6POS XP1={X 300.0,Y 0.0,Z 200.0,A 180.0,B 0.0,C 180.0,S 2,T 10,E1 0.0}\nENDDAT`;
  const kut = touchUpAtLine({ vendor: 'kuka', text: krlSrc, fileName: 'main.src', files: { 'main.src': krlSrc, 'main.dat': krlDat }, cursorLine: 2, tcp: tcp6, joints: joints6 });
  ok(kut.ok && kut.file === 'main.dat' && kut.text.includes('X 410.500,Y -120.250,Z 250.000') && kut.text.includes('S 2,T 10,E1 0.0'), 'KUKA: .src LIN XP1 → .dat XP1 덮어쓰기 (S/T/E1 보존)');

  // Doosan: movel(p1) → p1 = posx(...)
  const dSrc = `p1 = posx(300, 0, 200, 0, 180, 0)\nmovel(p1, vel=250, acc=1000)`;
  const dt = touchUpAtLine({ vendor: 'doosan', text: dSrc, fileName: 'main.drl', cursorLine: 2, tcp: tcp6, joints: joints6 });
  ok(dt.ok && dt.label === 'p1' && dt.text.includes('posx(410.500, -120.250, 250.000'), 'Doosan: movel(p1) → posx 덮어쓰기');

  // URScript: movel(p1) → p[m, m, m, rad, rad, rad] 및 추출 시 m→mm 변환
  const urTcp = [410.5, -120.25, 250.0, 3.14159, 0, 0];
  const uSrc = `p1 = p[0.3, 0.0, 0.2, 3.14, 0.0, 0.0]\nmovel(p1, a=1.2, v=0.25)`;
  const ut = touchUpAtLine({ vendor: 'ur', text: uSrc, fileName: 'main.script', cursorLine: 2, tcp: urTcp, joints: joints6 });
  const ue = extractPointAtLine({ vendor: 'ur', text: ut.text, fileName: 'main.script', cursorLine: 2 });
  ok(ut.ok && ut.text.includes('p[0.4105, -0.12025, 0.25, 3.14159, 0, 0]'), 'UR: movel(p1) → p[...] mm→m 덮어쓰기');
  ok(ue.ok && near(ue.values[0], 410.5, 0.1) && near(ue.values[2], 250.0, 0.1), 'UR: extractPointAtLine m→mm 복원');

  // Go To Point 실제 컨트롤러 이동 검증
  const c = new Controller();
  c.setRobot('yaskawa-gp7');
  c.setMode('TEACH', 'ui');
  c.setServo(true, 'ui');
  c.setTimeScale(8);
  const pt = extractPointAtLine({ vendor: 'yaskawa', text: ySrc, fileName: 'T.JBI', cursorLine: 11, robot: c.robot });
  const gr = await c.goToPoint({ kind: pt.kind, values: pt.values, label: pt.label }, 'ui');
  const tcpNow = c.vendorPose();
  ok(gr.ok && near(tcpNow[0], 300, 0.5) && near(tcpNow[2], 200, 0.5), `Go To Point 실제 이동 완료: [${tcpNow.slice(0, 3).map((v) => v.toFixed(1)).join(', ')}]`);
  c.setMode('PLAY', 'ui');
  const grPlay = await c.goToPoint({ kind: pt.kind, values: pt.values, label: pt.label }, 'ui');
  ok(grPlay.ok === false, 'PLAY 모드에서는 Go To Point 거부 (TEACH 전용)');
  c.close();
}

// ------------------------------------------------------------ 5. Set PP to Cursor
console.log('\n■ 5. Set PP to Cursor (프로그램 포인터 이동)');
{
  const c = new Controller();
  c.setRobot('yaskawa-gp7');
  c.setMode('PLAY', 'ui');
  c.setServo(true, 'ui');
  const jbi = `/JOB\n//NAME PPTEST\n//POS\n///NPOS 0,0,0,0,0,0\n//INST\nNOP\nSET I000 10\nSET I001 20\nSET I002 30\nEND\n`;
  c.loadFiles({ 'PPTEST.JBI': jbi }, true);
  // 8번 줄(SET I001 20)로 PP 이동 → 7번 줄(SET I000 10)은 건너뛰고 I001, I002만 설정되어야 함
  const pr = c.setPP('PPTEST.JBI', 8);
  ok(pr.ok && pr.line === 8 && c.vm._ppCustom === true, `setPP → PPTEST.JBI:${pr.line}`);
  await c.start();
  while (c.vm.status === 'running') await sleep(20);
  ok(c.regs.get('I:0') === undefined && c.regs.get('I:1') === 20 && c.regs.get('I:2') === 30,
    `커서 줄부터 실행 확인: I000=${c.regs.get('I:0')}, I001=${c.regs.get('I:1')}, I002=${c.regs.get('I:2')}`);
  c.close();
}

// ------------------------------------------------------------ 6. TEACH 250 mm/s 제한 & 외부 ×1 배속 잠금
console.log('\n■ 6. TEACH 250 mm/s 속도 상한 & ×1 배속 잠금');
{
  const c = new Controller();
  c.setRobot('yaskawa-gp7');
  c.setMode('TEACH', 'ui');
  c.setServo(true, 'ui');
  c.setTimeScale(8);
  const p0 = c.tcpPose();
  const tgt = { p: [p0.p[0], p0.p[1] + 200, p0.p[2]], R: p0.R };
  const s0 = c.simMs;
  await c.move({ kind: 'L', target: { pose: tgt }, speed: { tcp: 1000 } });
  const dtTeach = (c.simMs - s0) / 1000;
  // 200 mm / 250 mm/s = 0.8s + accel >= 0.8s
  ok(dtTeach >= 0.8, `TEACH 모드(제한 ON): v=1000 → ${TEACH_TCP_MAX}mm/s 캡 적용 (${dtTeach.toFixed(2)}s >= 0.8s)`);

  c.setMode('PLAY', 'ui');
  const s1 = c.simMs;
  await c.move({ kind: 'L', target: { pose: p0 }, speed: { tcp: 1000 } });
  const dtPlay = (c.simMs - s1) / 1000;
  ok(dtPlay < dtTeach * 0.65, `PLAY 모드: v=1000 정상 속도 복원 (${dtPlay.toFixed(2)}s < ${dtTeach.toFixed(2)}s)`);

  // 외부/REMOTE ×1 배속 잠금
  c.setTimeScale(5);
  c.setTimeScaleLock(true);
  c.setMode('REMOTE', 'ui');
  ok(c.timeScale === 1, 'REMOTE 전환 + ×1 잠금 → 배속 자동 1 복원');
  c.setTimeScale(4);
  ok(c.timeScale === 1, 'REMOTE + ×1 잠금 상태에서 4배속 변경 차단');
  c.close();
}

// ------------------------------------------------------------ 7. ProtocolManager 제조사 격리
console.log('\n■ 7. ProtocolManager 제조사 격리 (vendor ↔ all)');
{
  const c = new Controller();
  c.setRobot('yaskawa-gp7');
  const mgr = new ProtocolManager(c, {
    yaskawaHse: { port: 23040, filePort: 23041, host: '127.0.0.1' },
    abbRws: { port: 23080, host: '127.0.0.1' },
    kukaVarProxy: { port: 23070, host: '127.0.0.1' },
    kawasakiAs: { enabled: false },
    hyundai: { enabled: false },
    urDashboard: { enabled: false },
  }, { mode: 'vendor' });
  try {
    const l1 = await mgr.sync();
    const y1 = l1.find((x) => x.key === 'yaskawaHse');
    const a1 = l1.find((x) => x.key === 'abbRws');
    ok(y1?.active && y1.port === 23040 && a1?.standby && a1.port === null,
      `vendor 모드(yaskawa): yaskawaHse 활성(${y1?.port}), abbRws 대기(${a1?.port})`);

    // 로봇 제조사를 ABB로 전환 → yaskawaHse 닫고 abbRws 자동 바인딩
    c.setRobot('abb-irb1200');
    await mgr.sync();
    const l2 = mgr.list();
    const y2 = l2.find((x) => x.key === 'yaskawaHse');
    const a2 = l2.find((x) => x.key === 'abbRws');
    ok(y2?.standby && y2.port === null && a2?.active && a2.port === 23080,
      `로봇 ABB 전환 후: yaskawaHse 대기(${y2?.port}), abbRws 활성(${a2?.port})`);

    // 'all' 모드 전환 → 3개 모두 활성
    const l3 = await mgr.setMode('all');
    ok(l3.every((x) => x.active && x.port > 0), `all 모드 전환: 3개 모두 활성 (${l3.map((x) => `${x.key}:${x.port}`).join(', ')})`);
  } finally {
    await mgr.closeAll();
    c.close();
  }
}

console.log(`\n결과: 통과 ${pass}, 실패 ${fail}`);
process.exit(fail ? 1 : 0);
