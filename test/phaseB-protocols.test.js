// Phase B (v1.5 Milestone 2) 실 백업 호환성 · URScript thread/struct · 핵심 공장 프로토콜 통합 테스트
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import { Controller } from '../server/controller.js';
import { createZip, parseZip, importBackup } from '../server/backup.js';
import { start as startUrRtde, MSG as RTDE_MSG, buildFrame as buildRtde } from '../server/protocols/ur-rtde.js';
import { start as startEip, EIP_CMD, CIP_SVC, buildEncap } from '../server/protocols/ethernet-ip.js';
import { start as startCclink, CCLINK_CMD, buildPacket as buildCc } from '../server/protocols/cclink-ie-basic.js';
import { start as startDrfl } from '../server/protocols/doosan-drfl.js';
import { ProtocolManager, externalView } from '../server/protocols/index.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); failed++; }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function stepUntil(ctrl, pred, maxSec = 3) {
  const steps = Math.ceil(maxSec / 0.02);
  for (let i = 0; i < steps; i++) {
    ctrl._step(0.02);
    await wait(1);
    if (pred()) return true;
  }
  return pred();
}

console.log('\n[Phase B — Real-Backup Compat & Factory Protocols]');

await test('1. URScript thread / run / join / kill (PolyScope background threads)', async () => {
  const c = new Controller();
  c.setRobot('ur-ur5e');
  c.setServo(true);
  c.loadFiles({
    'poly.script': `def my_prog():
  global ticks = 0
  global forever_cnt = 0
  thread worker():
    i = 0
    while i < 3:
      global ticks = ticks + 1
      sleep(0.02)
      i = i + 1
    end
  end
  thread bg():
    while True:
      global forever_cnt = forever_cnt + 1
      sleep(0.02)
    end
  end
  th1 = run worker()
  th2 = run bg()
  join th1
  kill th2
  set_standard_digital_out(0, True)
end`,
  }, true);
  assert.equal(c.compileError, null, `compileError: ${JSON.stringify(c.compileError)}`);
  await c.start();
  await stepUntil(c, () => c.vm.status === 'done', 2);
  assert.equal(c.vm.status, 'done');
  assert.equal(c.vm.globals.get('ticks'), 3, 'worker thread should increment ticks 3 times before join');
  assert.ok(c.vm.globals.get('forever_cnt') >= 1, 'bg thread should run concurrently');
  assert.equal(c.getDO(1), true);
  assert.equal(c.vm.urs.threads.size, 0, 'all threads must be cleaned up after kill & exit');
});

await test('2. URScript struct(...) & {k=v} literals + dot field read/write', async () => {
  const c = new Controller();
  c.setRobot('ur-ur5e');
  c.setServo(true);
  c.loadFiles({
    'st.script': `def main():
  global s = struct(x=10, y=20, tag="ok")
  global lit = {a = 3, b = 4}
  s.x = s.x + lit.a * lit.b
  global out = s.x + s.y
end`,
  }, true);
  assert.equal(c.compileError, null, `compileError: ${JSON.stringify(c.compileError)}`);
  await c.start();
  await stepUntil(c, () => c.vm.status === 'done', 1);
  assert.equal(c.vm.status, 'done');
  assert.equal(c.vm.globals.get('out'), 42);
});

await test('3. Multi-folder ZIP backup import (KUKA KRC/R1 + ABB RAPID + collision-safe pairing)', () => {
  const kukaZip = createZip({
    'KRC/R1/System/$config.dat': 'DEFDAT $CONFIG\nDECL GLOBAL INT gCnt=5\nENDDAT',
    'KRC/R1/Program/main.src': 'DEF main()\n  sub1()\nEND',
    'KRC/R1/Program/main.dat': 'DEFDAT main\nDECL INT x=1\nENDDAT',
    'KRC/R1/TP/sub/main.src': 'DEF sub1()\n  $OUT[1]=TRUE\nEND',
    'KRC/R1/TP/sub/main.dat': 'DEFDAT sub1\nDECL INT x=2\nENDDAT',
    'KRC/R1/readme.txt': 'ignored non-krl file',
  });
  const parsed = parseZip(kukaZip);
  assert.equal(parsed.size, 6);
  const imp = importBackup(kukaZip);
  assert.equal(imp.vendor, 'kuka');
  assert.equal(imp.count, 5);
  assert.ok(imp.files['$config.dat']);
  assert.ok(imp.files['main.src'] && imp.files['main.dat']);
  assert.ok(imp.files['main_1.src'] && imp.files['main_1.dat'], 'colliding .src/.dat pair must keep matching suffix');

  // Compile imported KUKA backup directly on controller!
  const c = new Controller();
  c.setRobot('kuka-kr10-r1100');
  c.loadFiles(imp.files, true);
  assert.equal(c.compileError, null, `imported KUKA backup compile error: ${JSON.stringify(c.compileError)}`);

  // ABB backup
  const abbZip = createZip({
    'RAPID/TASK1/PROGMOD/MainModule.mod': 'MODULE MainModule\nPROC main()\n  SetDO do1, 1;\nENDPROC\nENDMODULE',
    'SYSPAR/EIO.cfg': 'non-rapid config',
  });
  const abbImp = importBackup(abbZip);
  assert.equal(abbImp.vendor, 'abb');
  assert.equal(abbImp.count, 1);
  assert.ok(abbImp.files['MainModule.mod']);
});

await test('4. UR RTDE binary protocol: version, setup outputs/inputs, cyclic DATA_PACKAGE exchange', async () => {
  const c = new Controller();
  c.setRobot('ur-ur5e');
  c.setServo(true);
  c.regs.set('RTDE_OUT_I:0', 777);
  const srv = await startUrRtde(externalView(c), { port: 0, host: '127.0.0.1' });
  try {
    assert.ok(srv.port > 0);
    const sock = net.connect(srv.port, '127.0.0.1');
    const frames = [];
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 3) {
        const len = buf.readUInt16BE(0);
        if (buf.length < len) break;
        frames.push({ type: buf[2], payload: Buffer.from(buf.subarray(3, len)) });
        buf = buf.subarray(len);
      }
    });
    const nextFrame = async (wantType) => {
      for (let i = 0; i < 100; i++) {
        const idx = frames.findIndex((f) => !wantType || f.type === wantType);
        if (idx >= 0) return frames.splice(idx, 1)[0];
        await wait(10);
      }
      throw new Error(`RTDE timeout waiting for type=${wantType}`);
    };

    // 1) Protocol version v2
    const v2 = Buffer.alloc(2); v2.writeUInt16BE(2, 0);
    sock.write(buildRtde(RTDE_MSG.REQUEST_PROTOCOL_VERSION, v2));
    const rVer = await nextFrame(RTDE_MSG.REQUEST_PROTOCOL_VERSION);
    assert.equal(rVer.payload[0], 1);

    // 2) Setup outputs (50 Hz): actual_q, output_int_register_0, robot_mode
    const fBuf = Buffer.alloc(8); fBuf.writeDoubleBE(50, 0);
    sock.write(buildRtde(RTDE_MSG.CONTROL_PACKAGE_SETUP_OUTPUTS, Buffer.concat([fBuf, Buffer.from('actual_q,output_int_register_0,robot_mode')])));
    const rOut = await nextFrame(RTDE_MSG.CONTROL_PACKAGE_SETUP_OUTPUTS);
    const outId = rOut.payload[0];
    assert.equal(outId, 1);
    assert.equal(rOut.payload.subarray(1).toString('utf8'), 'VECTOR6D,INT32,INT32');

    // 3) Setup inputs: input_int_register_0, input_double_register_0
    sock.write(buildRtde(RTDE_MSG.CONTROL_PACKAGE_SETUP_INPUTS, Buffer.from('input_int_register_0,input_double_register_0')));
    const rIn = await nextFrame(RTDE_MSG.CONTROL_PACKAGE_SETUP_INPUTS);
    const inId = rIn.payload[0];
    assert.equal(inId, 1);
    assert.equal(rIn.payload.subarray(1).toString('utf8'), 'INT32,DOUBLE');

    // 4) Start streaming and verify DATA_PACKAGE
    sock.write(buildRtde(RTDE_MSG.CONTROL_PACKAGE_START));
    const rStart = await nextFrame(RTDE_MSG.CONTROL_PACKAGE_START);
    assert.equal(rStart.payload[0], 1);
    const dp = await nextFrame(RTDE_MSG.DATA_PACKAGE);
    assert.equal(dp.payload[0], outId);
    const outReg0 = dp.payload.readInt32BE(1 + 48);
    const robotMode = dp.payload.readInt32BE(1 + 48 + 4);
    assert.equal(outReg0, 777);
    assert.equal(robotMode, 7);

    // 5) Write input DATA_PACKAGE -> updates ctrl.regs
    const inPay = Buffer.alloc(1 + 4 + 8);
    inPay[0] = inId;
    inPay.writeInt32BE(1234, 1);
    inPay.writeDoubleBE(3.25, 5);
    sock.write(buildRtde(RTDE_MSG.DATA_PACKAGE, inPay));
    await wait(30);
    assert.equal(c.regs.get('RTDE_IN_I:0'), 1234);
    assert.equal(c.regs.get('RTDE_IN_F:0'), 3.25);

    sock.write(buildRtde(RTDE_MSG.CONTROL_PACKAGE_PAUSE));
    await nextFrame(RTDE_MSG.CONTROL_PACKAGE_PAUSE);
    sock.destroy();
  } finally { srv.close(); }
});

await test('5. EtherNet/IP CIP Encapsulation: RegisterSession, Assembly 100 read, Assembly 150 write', async () => {
  const c = new Controller();
  c.setRobot('abb-irb1200');
  c.setMode('REMOTE');
  c.setDO(3, true);
  c.regs.set('MB:0', 55);
  const srv = await startEip(externalView(c), { port: 0, host: '127.0.0.1' });
  try {
    const sock = net.connect(srv.port, '127.0.0.1');
    const frames = [];
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 24) {
        const len = buf.readUInt16LE(2);
        if (buf.length < 24 + len) break;
        frames.push({ cmd: buf.readUInt16LE(0), session: buf.readUInt32LE(4), status: buf.readUInt32LE(8), payload: Buffer.from(buf.subarray(24, 24 + len)) });
        buf = buf.subarray(24 + len);
      }
    });
    const next = async () => {
      for (let i = 0; i < 100; i++) { if (frames.length) return frames.shift(); await wait(10); }
      throw new Error('EIP timeout');
    };
    const sendCip = (session, cipBuf) => {
      const hdr = Buffer.alloc(16);
      hdr.writeUInt16LE(2, 6);
      hdr.writeUInt16LE(0x0000, 8); hdr.writeUInt16LE(0, 10);
      hdr.writeUInt16LE(0x00b2, 12); hdr.writeUInt16LE(cipBuf.length, 14);
      sock.write(buildEncap(EIP_CMD.SEND_RR_DATA, Buffer.concat([hdr, cipBuf]), session));
    };

    // RegisterSession
    const regBody = Buffer.alloc(4); regBody.writeUInt16LE(1, 0);
    sock.write(buildEncap(EIP_CMD.REGISTER_SESSION, regBody));
    const rReg = await next();
    assert.ok(rReg.session > 0);

    // Get Attribute Single: Class 0x04, Instance 100, Attribute 3
    sendCip(rReg.session, Buffer.from([CIP_SVC.GET_ATTR_SINGLE, 3, 0x20, 0x04, 0x24, 100, 0x30, 0x03]));
    const rIn = await next();
    const cipIn = rIn.payload.subarray(16);
    assert.equal(cipIn[2], 0, 'CIP status should be 0 (success)');
    const asmIn = cipIn.subarray(4);
    assert.equal(asmIn.length, 64);
    assert.equal(!!(asmIn[8] & (1 << 2)), true, 'DO3 bit must be set in Assembly 100');
    assert.equal(asmIn.readInt16LE(40), 55, 'MB:0 must be 55 in Assembly 100');

    // Set Attribute Single: Class 0x04, Instance 150, Attribute 3 (servoOn + override=75 + DI2 + MB:16=321)
    const outAsm = Buffer.alloc(64);
    outAsm.writeUInt16LE(1, 0); // cmd=1 servoOn
    outAsm.writeUInt16LE(75, 2); // override=75
    outAsm[8] = 1 << 1; // DI2 = ON
    outAsm.writeInt16LE(321, 16); // MB:16 = 321
    sendCip(rReg.session, Buffer.concat([Buffer.from([CIP_SVC.SET_ATTR_SINGLE, 3, 0x20, 0x04, 0x24, 150, 0x30, 0x03]), outAsm]));
    const rOut = await next();
    assert.equal(rOut.payload[18], 0);
    assert.equal(c.servo, true);
    assert.equal(c.override, 75);
    assert.equal(c.getDI(2), true);
    assert.equal(c.regs.get('MB:16'), 321);
    sock.destroy();
  } finally { srv.close(); }
});

await test('6. CC-Link IE Field Basic UDP: NodeSearch & Cyclic RX/RY/RWw/RWr exchange', async () => {
  const c = new Controller();
  c.setRobot('yaskawa-gp8');
  c.setDO(5, true);
  c.regs.set('MB:32', 888);
  const srv = await startCclink(externalView(c), { port: 0, host: '127.0.0.1' });
  const cli = dgram.createSocket('udp4');
  try {
    const ask = (pkt) => new Promise((resolve, reject) => {
      cli.once('message', resolve);
      cli.send(pkt, srv.port, '127.0.0.1', (e) => { if (e) reject(e); });
    });
    const rSearch = await ask(buildCc(false, CCLINK_CMD.NODE_SEARCH, 1, 1));
    assert.equal(rSearch.readUInt16LE(0), 0x00d7);
    assert.equal(rSearch.readUInt16LE(10), 0);

    const reqPay = Buffer.alloc(72);
    reqPay[0] = 1 << 3; // RY bit 3 -> DI4 = ON
    reqPay.writeInt16LE(4321, 8); // RWw[0] -> MB:0 = 4321
    const rCyc = await ask(buildCc(false, CCLINK_CMD.CYCLIC_DATA, 2, 1, reqPay));
    assert.equal(rCyc.readUInt16LE(10), 0);
    assert.equal(c.getDI(4), true);
    assert.equal(c.regs.get('MB:0'), 4321);
    const respPay = rCyc.subarray(20);
    assert.equal(!!(respPay[0] & (1 << 4)), true, 'RX bit 4 must reflect DO5');
    assert.equal(respPay.readInt16LE(40), 888, 'RWr[16] must reflect MB:32');
  } finally { cli.close(); srv.close(); }
});

await test('7. Doosan DRFL Socket TCP: GET_POSJ/POSX, IO, SERVO, JSON command', async () => {
  const c = new Controller();
  c.setRobot('doosan-m1013');
  c.setMode('REMOTE');
  const srv = await startDrfl(externalView(c), { port: 0, host: '127.0.0.1' });
  try {
    const sock = net.connect(srv.port, '127.0.0.1');
    let buf = '';
    const lines = [];
    sock.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    });
    const ask = async (cmd) => {
      sock.write(cmd + '\n');
      for (let i = 0; i < 100; i++) { if (lines.length) return lines.shift(); await wait(10); }
      throw new Error('DRFL timeout: ' + cmd);
    };
    assert.equal(await ask('PING'), 'OK PONG');
    assert.equal(await ask('SERVO ON'), 'OK ON');
    assert.equal(c.servo, true);
    assert.equal(await ask('SET_DO 2 1'), 'OK');
    assert.equal(await ask('GET_DO 2'), 'OK 1');
    assert.equal(await ask('SET_AO 1 5.5'), 'OK');
    assert.equal(c.getAO(1), 5.5);
    const pj = await ask(JSON.stringify({ cmd: 'GET_POSJ' }));
    assert.ok(pj.startsWith('OK ['));
    sock.destroy();
  } finally { srv.close(); }
});

await test('8. ProtocolManager activates vendor-specific urRtde / doosanDrfl and always-on EIP / CC-Link', async () => {
  const c = new Controller();
  c.setRobot('ur-ur5e');
  const pm = new ProtocolManager(c, {
    yaskawaHse: { enabled: false }, kawasakiAs: { enabled: false }, hyundai: { enabled: false },
    abbRws: { enabled: false }, kukaVarProxy: { enabled: false }, urDashboard: { enabled: false },
    urRtde: { port: 0, host: '127.0.0.1' },
    doosanDrfl: { port: 0, host: '127.0.0.1' },
    ethernetIp: { port: 0, host: '127.0.0.1' },
    cclinkIeBasic: { port: 0, host: '127.0.0.1' },
  }, { mode: 'vendor' });
  try {
    const list1 = await pm.sync();
    assert.equal(list1.find((x) => x.key === 'urRtde')?.active, true);
    assert.equal(list1.find((x) => x.key === 'doosanDrfl')?.active, false);
    assert.equal(list1.find((x) => x.key === 'ethernetIp')?.active, true);
    assert.equal(list1.find((x) => x.key === 'cclinkIeBasic')?.active, true);

    c.setRobot('doosan-m1013');
    const list2 = await pm.sync();
    assert.equal(list2.find((x) => x.key === 'urRtde')?.active, false);
    assert.equal(list2.find((x) => x.key === 'doosanDrfl')?.active, true);
  } finally { await pm.closeAll(); }
});

console.log(`\n결과: ${passed} 통과, ${failed} 실패`);
process.exit(failed ? 1 : 0);
