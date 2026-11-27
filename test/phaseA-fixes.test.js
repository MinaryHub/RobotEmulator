// Phase A (v1.5 Milestone 1) 핵심 버그 수정 · 실용성/안정성 회귀 테스트
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Controller } from '../server/controller.js';
import { checkCollision } from '../shared/collision.js';
import { extractPointAtLine, touchUpAtLine } from '../shared/teachOps.js';
import { fkTcp } from '../shared/kinematics.js';
import { quatFromR } from '../shared/math.js';
import { start as startAbbRws } from '../server/protocols/abb-rws.js';
import { start as startModbus, inputRegisters, alarmCodeNum } from '../server/protocols/modbus-tcp.js';
import { start as startKawasaki } from '../server/protocols/kawasaki-as.js';
import { start as startHyundai } from '../server/protocols/hyundai-openapi.js';
import { ProjectStore } from '../server/project.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); failed++; }
}

function stepSim(ctrl, sec, dt = 0.02) {
  const n = Math.ceil(sec / dt);
  for (let i = 0; i < n; i++) ctrl._step(dt);
}

function httpReq(port, method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

console.log('\n[Phase A — Critical Fixes & Stability]');

await test('1. Custom STL gripper bounds produce collision capsule and detect obstacles', () => {
  const c = new Controller();
  c.setRobot('ur-ur5e');
  c.setCustomGripper({
    name: 'wide_stl.stl',
    kind: 'parallel',
    tcp: [0, 0, 100, 0, 0, 0],
    bounds: { min: [-250, -250, 0], max: [250, 250, 400] },
  });
  assert.ok(c.gripper.geom.bounds, 'bounds must be preserved on custom gripper');
  const tcp = fkTcp(c.robot, c.joints, c.gripperTcp, null);
  const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const obs = [{ id: 'o1', c: [tcp.p[0], tcp.p[1], tcp.p[2]], h: [50, 50, 50], R: I }];
  const res = checkCollision(c.robot, c.joints, c.gripper, c.scene, [], { obstacles: obs });
  assert.equal(res.hit, true, 'custom STL gripper bounds should collide with obstacle at TCP');
});

await test('2. Held workpiece collision is checked against obstacles and table', () => {
  const c = new Controller();
  c.setRobot('ur-ur5e');
  const tcp = fkTcp(c.robot, c.joints, c.gripperTcp, null);
  const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const heldObj = { id: 'wp1', shape: 'box', size: [120, 120, 120], pose: { p: [tcp.p[0] + 100, tcp.p[1], tcp.p[2]], R: I } };
  const obs = [{ id: 'pillar', c: [tcp.p[0] + 140, tcp.p[1], tcp.p[2]], h: [40, 40, 100], R: I }];
  const res = checkCollision(c.robot, c.joints, c.gripper, c.scene, [heldObj], { ignoreObjects: ['wp1'], heldObject: heldObj, obstacles: obs });
  assert.equal(res.hit, true, 'held workpiece must collide with obstacle');
  assert.ok(res.pairs.some((p) => p.a === 'held' || p.b === 'held'), `pair should identify held workpiece, got ${JSON.stringify(res.pairs)}`);
});

await test('3. Direct Teach teachPose uses active Tool Frame (this.tool) without jump', () => {
  const c = new Controller();
  c.setRobot('ur-ur5e');
  c.setMode('TEACH');
  c.setServo(true);
  c.setFrame('tool', 1, { name: 'LongTool', pose: [0, 0, 220, 0, 0, 0] });
  c.setActiveFrames({ activeTool: 1 });
  const before = [...c.joints];
  const tcpWorld = fkTcp(c.robot, c.joints, c.tool, null);
  const r = c.teachPose({ p: tcpWorld.p, q: quatFromR(tcpWorld.R) });
  assert.equal(r.ok, true, `teachPose at current tool TCP should succeed: ${r.reason}`);
  const maxDiff = Math.max(...c.joints.map((v, i) => Math.abs(v - before[i])));
  assert.ok(maxDiff < 0.1, `joints should not jump when active Tool Frame is set (diff=${maxDiff})`);
});

await test('4. Vision latency outputs trigger-time pose snapshot (not future conveyor pose) & RTDE regs', () => {
  const c = new Controller();
  c.setRobot('ur-ur5e');
  c.setCameras([{
    id: 'cam1', type: 'realsense-d435', name: 'TopCam', mount: 'world',
    pos: [400, 0, 900], rot: [180, 0, 0],
    vision: { enabled: true, latencyMs: 200, noiseMm: 0, noiseDeg: 0, regBase: 20, foundDI: 10, doneDI: 11 },
  }]);
  const camId = c.cameras[0].id;
  c.objects = [{ id: 'box1', shape: 'box', size: [40, 40, 40], pose: { p: [400, 0, 320], R: [[1,0,0],[0,1,0],[0,0,1]] } }];
  const t0 = c.triggerVision(camId);
  assert.equal(t0.pending, true);
  // Move object during latency window (simulating moving conveyor)
  c.objects[0].pose.p[0] = 520;
  stepSim(c, 0.25);
  assert.equal(c.regs.get('VISION_X'), 400, 'vision must report trigger-time X=400, not moved X=520');
  assert.equal(c.regs.get('RTDE_IN_I:0'), 1);
  assert.equal(c.regs.get('RTDE_IN_F:0'), 400);
});

await test('5. teachOps: Hyundai curly-brace base/axis & KRL ;FOLD + same-stem .dat + S/T update', () => {
  const hrText = 'P1={450, 10, 300, 180, 0, 0, "base"}\nP2={0, -30, 60, 0, 60, 0, "axis"}\nMOVE L,P1,S=200mm/sec\nMOVE P,P2,S=50%';
  const ex1 = extractPointAtLine({ vendor: 'hyundai', text: hrText, fileName: '0001.job', cursorLine: 3 });
  assert.equal(ex1.ok, true);
  assert.equal(ex1.kind, 'pose');
  assert.deepEqual(ex1.values, [450, 10, 300, 180, 0, 0]);
  const tu1 = touchUpAtLine({ vendor: 'hyundai', text: hrText, fileName: '0001.job', cursorLine: 3, tcp: [500, 20, 350, 180, 0, 90], joints: [1,2,3,4,5,6] });
  assert.equal(tu1.ok, true);
  assert.ok(tu1.text.includes('P1={500.000, 20.000, 350.000, 180.000, 0.000, 90.000, "base"}'));
  const ex2 = extractPointAtLine({ vendor: 'hyundai', text: hrText, fileName: '0001.job', cursorLine: 4 });
  assert.equal(ex2.ok, true);
  assert.equal(ex2.kind, 'joints');
  const tu2 = touchUpAtLine({ vendor: 'hyundai', text: hrText, fileName: '0001.job', cursorLine: 4, tcp: [0,0,0,0,0,0], joints: [10, -20, 40, 0, 50, 0] });
  assert.ok(tu2.text.includes('P2={10.000, -20.000, 40.000, 0.000, 50.000, 0.000, "axis"}'));

  // KRL ;FOLD PTP P1 + same-stem .dat priority + S/T update
  const c = new Controller();
  c.setRobot('kuka-kr10-r1100');
  const files = {
    'other.dat': 'DEFDAT other\nDECL E6POS XP1={X 111,Y 0,Z 0,A 0,B 0,C 0,S 2,T 0}\nENDDAT',
    'job1.src': 'DEF job1()\n;FOLD PTP P1 Vel=100 % PDAT1\nPTP XP1\n;ENDFOLD\nEND',
    'job1.dat': 'DEFDAT job1\nDECL E6POS XP1={X 500,Y 0,Z 600,A 180,B 0,C 180,S 0,T 0}\nENDDAT',
  };
  const kEx = extractPointAtLine({ vendor: 'kuka', text: files['job1.src'], fileName: 'job1.src', files, cursorLine: 2, robot: c.robot });
  assert.equal(kEx.ok, true);
  assert.equal(kEx.file, 'job1.dat', 'must prefer same-stem job1.dat over other.dat');
  assert.equal(kEx.values[0], 500);
  const kTu = touchUpAtLine({
    vendor: 'kuka', text: files['job1.src'], fileName: 'job1.src', files, cursorLine: 2,
    tcp: [550, 10, 620, 180, 0, 180], joints: [-10, -80, 90, 0, -30, 0], robot: c.robot,
  });
  assert.equal(kTu.ok, true);
  assert.equal(kTu.file, 'job1.dat');
  assert.ok(/T 19\b/.test(kTu.text), `T bits for [-10,-80,90,0,-30,0] should be 1+2+16=19, got: ${kTu.text}`);
});

await test('6. KRL file-scoped .dat variables & $ANIN/$ANOUT', async () => {
  const c = new Controller();
  c.setRobot('kuka-kr10-r1100');
  c.setServo(true);
  c.setAI(1, 3.75);
  c.loadFiles({
    'a.dat': 'DEFDAT a\nDECL INT val=10\nENDDAT',
    'b.dat': 'DEFDAT b\nDECL INT val=99\nENDDAT',
    'b.src': 'DEF subB()\n$ANOUT[2] = val / 10.0\nEND',
    'a.src': 'DEF mainA()\nDECL REAL r\nr = $ANIN[1]\n$ANOUT[1] = r + val\nsubB()\nEND',
  }, true);
  c.setMain('a.src');
  await c.start();
  stepSim(c, 0.2);
  assert.equal(c.vm.status, 'done');
  assert.equal(c.getAO(1), 13.75, 'a.src must read a.dat val=10 + AI1=3.75');
  assert.equal(c.getAO(2), 9.9, 'b.src must read b.dat val=99 / 10 = 9.9');
});

await test('7. RAPID AInput/GInput & LOCAL module isolation', async () => {
  const c = new Controller();
  c.setRobot('abb-irb1200');
  c.setServo(true);
  c.setAI(1, 4.5);
  c.setIoGroups([{ id: 'GI1', name: 'giCode', dir: 'in', start: 1, bits: 4 }]);
  c.writeGroupIO('GI1', 11);
  c.loadFiles({
    'ModA.mod': `MODULE ModA
  LOCAL VAR num x := 10;
  LOCAL PROC helper()
    x := x + 1;
  ENDPROC
  PROC runA()
    helper;
    SetAO ao1, x;
  ENDPROC
ENDMODULE`,
    'MainModule.mod': `MODULE MainModule
  LOCAL VAR num x := 20;
  LOCAL PROC helper()
    x := x + 2;
  ENDPROC
  PROC main()
    VAR num a;
    VAR num g;
    helper;
    runA;
    a := AInput(ai1);
    g := GInput(giCode);
    SetAO ao2, x + a + g;
  ENDPROC
ENDMODULE`,
  }, true);
  c.setMain('MainModule.mod');
  await c.start();
  stepSim(c, 0.2);
  assert.equal(c.vm.status, 'done');
  assert.equal(c.getAO(1), 11, 'ModA LOCAL helper should update ModA x to 11');
  assert.equal(c.getAO(2), 22 + 4.5 + 11, 'MainModule LOCAL x=22 + AI1=4.5 + GI1=11');
});

await test('8. URScript analog I/O & RTDE GP registers', async () => {
  const c = new Controller();
  c.setRobot('ur-ur5e');
  c.setServo(true);
  c.setAI(1, 6.25);
  c.regs.set('RTDE_IN_I:0', 42);
  c.regs.set('RTDE_IN_F:1', 1.5);
  c.loadFiles({
    'main.script': `def main():
  a = get_standard_analog_in(0)
  i = read_input_integer_register(0)
  f = read_input_float_register(1)
  set_standard_analog_out(0, a + f)
  write_output_integer_register(0, i + 8)
  write_output_float_register(0, a * 2)
end
main()`,
  }, true);
  await c.start();
  stepSim(c, 0.2);
  assert.equal(c.vm.status, 'done');
  assert.equal(c.getAO(1), 7.75);
  assert.equal(c.regs.get('RTDE_OUT_I:0'), 50);
  assert.equal(c.regs.get('RTDE_OUT_F:0'), 12.5);
});

await test('9. Doosan DRL analog I/O & get_vision_pos', async () => {
  const c = new Controller();
  c.setRobot('doosan-m1013');
  c.setServo(true);
  c.setAI(2, 2.5);
  c.regs.set('VISION_X', 310);
  c.regs.set('VISION_Y', -40);
  c.regs.set('VISION_Z', 120);
  c.regs.set('VISION_RZ', 15);
  c.loadFiles({
    'main.drl': `v = get_analog_input(2)
p = get_vision_pos()
set_analog_output(1, v + p[0] / 100.0)`,
  }, true);
  await c.start();
  stepSim(c, 0.2);
  assert.equal(c.vm.status, 'done');
  assert.equal(c.getAO(1), 5.6);
});

await test('10. Yaskawa INFORM ARCON/ARCOF toggles torch DO', async () => {
  const c = new Controller();
  c.setRobot('yaskawa-gp8');
  c.setGripper('torch-22');
  c.setServo(true);
  c.loadFiles({
    'WELD.JBI': `/JOB\n//NAME WELD\n//POS\n///NPOS 0,0,0,0,0,0\n//INST\nNOP\nARCON\nTIMER T=0.10\nARCOF\nEND`,
  }, true);
  await c.start();
  await new Promise((r) => setTimeout(r, 10));
  stepSim(c, 0.04);
  assert.equal(c.getDO(c.gripperIO.close), true, 'ARCON must energize torch DO');
  stepSim(c, 0.12);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(c.getDO(c.gripperIO.close), false, 'ARCOF must de-energize torch DO');
});

await test('11. ABB RWS /rw/mastership, numeric elog vendorCode, and elog clear -> resetAlarms', async () => {
  const c = new Controller();
  c.setRobot('abb-irb1200');
  const srv = await startAbbRws(c, { port: 0, host: '127.0.0.1' });
  try {
    const r1 = await httpReq(srv.port, 'POST', '/rw/mastership?action=request');
    assert.equal(r1.status, 204);
    const r2 = await httpReq(srv.port, 'GET', '/rw/mastership/rapid?json=1');
    assert.equal(r2.status, 200);
    assert.ok(r2.body.includes('"held"'));
    const r3 = await httpReq(srv.port, 'POST', '/rw/mastership?action=release');
    assert.equal(r3.status, 204);

    c.alarm('COLLISION', 'test col');
    const r4 = await httpReq(srv.port, 'GET', '/rw/elog/0?json=1');
    const j = JSON.parse(r4.body);
    const code = Number(j._embedded._state[0].code);
    assert.notEqual(code, 50000, 'elog code should reflect vendorCode, not hardcoded 50000');

    const r5 = await httpReq(srv.port, 'POST', '/rw/elog/0?action=clear');
    assert.equal(r5.status, 204);
    assert.equal(c.alarms.length, 0, 'elog clear must call ctrl.resetAlarms()');
  } finally { srv.close(); }
});

await test('12. Modbus TCP IR[3] numeric vendorCode & Kawasaki STATUS REMOTE + IO range & Hyundai reg cap', async () => {
  const c = new Controller();
  c.setRobot('yaskawa-gp8');
  c.alarm('COLLISION', 'col');
  const ir = inputRegisters(c, false);
  assert.equal(ir[3], alarmCodeNum(c.alarms[0].vendorCode), 'Modbus IR[3] should use vendorCode');
  c.resetAlarms();

  // Kawasaki AS
  c.setRobot('kawasaki-rs007l');
  c.setMode('REMOTE');
  c.setDO(70, true);
  const ks = await startKawasaki(c, { port: 0, host: '127.0.0.1' });
  try {
    const out = await new Promise((resolve, reject) => {
      const sock = net.connect(ks.port, '127.0.0.1');
      let buf = '', step = 0;
      sock.on('data', (d) => {
        buf += d.toString();
        if (step === 0 && buf.includes('login:')) { step = 1; sock.write('as\r\n'); }
        else if (step === 1 && buf.includes('>')) { step = 2; buf = ''; sock.write('STATUS\r\n'); }
        else if (step === 2 && buf.includes('>')) { step = 3; sock.write('IO 65\r\n'); }
        else if (step === 3 && buf.includes('96-')) { sock.end(); resolve(buf); }
      });
      sock.on('error', reject);
      setTimeout(() => { sock.destroy(); reject(new Error('timeout: ' + buf)); }, 3000);
    });
    assert.ok(out.includes('REMOTE'), 'Kawasaki STATUS must indicate REMOTE');
    assert.ok(out.includes('96-   65'), 'Kawasaki IO 65 must display signals 65..96');
  } finally { ks.close(); }

  // Hyundai OpenAPI vendorCode & 1000-key cap
  c.setRobot('hyundai-hh7');
  c.alarm('COLLISION', 'col');
  const hy = await startHyundai(c, { port: 0, host: '127.0.0.1' });
  try {
    const st = await httpReq(hy.port, 'GET', '/api/alarms');
    const arr = JSON.parse(st.body);
    assert.ok(arr[0].vendorCode, 'Hyundai /api/alarms must include vendorCode');
    for (let i = 0; i < 1000; i++) c.regs.set(`K${i}`, i);
    const over = await httpReq(hy.port, 'PUT', '/api/var/NEW_OVERFLOW_KEY', JSON.stringify({ value: 1 }), { 'Content-Type': 'application/json' });
    assert.equal(over.status, 507, 'Hyundai /api/var must reject beyond 1000 regs');
  } finally { hy.close(); }
});

await test('13. Controller alarm cap (200), signalNo cap (<=512), and VM timer cleanup on abort', () => {
  const c = new Controller();
  for (let i = 0; i < 250; i++) c.alarm('COLLISION', `a${i}`);
  assert.equal(c.alarms.length, 200);
  c.resetAlarms();

  // signalNo with >512 suffix stays in 1..512
  const n = c.signalNo('do', 'doBig9999');
  assert.ok(n >= 1 && n <= 512, `signalNo must clamp to 1..512, got ${n}`);

  // VM-owned after() timer cancelled on wakeWaiters
  let fired = false;
  const fakeVm = { id: 'vm1' };
  c.after(0.1, () => { fired = true; }, fakeVm);
  c.wakeWaiters(fakeVm);
  stepSim(c, 0.2);
  assert.equal(fired, false, 'VM-owned after() timer must not fire after abort/wakeWaiters');
});

await test('14. ProjectStore autosave ignores volatile MB:/RTDE_ regs and throttles writes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emu-proj-'));
  try {
    const c = new Controller();
    const ps = new ProjectStore(c, tmp);
    ps.saveAutosave({ async: false });
    const f = path.join(tmp, '_autosave.json');
    assert.ok(fs.existsSync(f));
    const mtime1 = fs.statSync(f).mtimeMs;
    c.regs.set('MB:0', 123);
    c.regs.set('RTDE_OUT_I:0', 99);
    // Even if forced synchronously, dirty sig ignores volatile regs -> no rewrite
    const sigBefore = ps._lastSig;
    ps.saveAutosave({ async: false });
    assert.equal(ps._lastSig, sigBefore, 'volatile MB:/RTDE_ regs should not dirty autosave signature');
    assert.equal(fs.statSync(f).mtimeMs, mtime1);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

console.log(`\n결과: ${passed} 통과, ${failed} 실패`);
process.exit(failed ? 1 : 0);
