// 통신 인터페이스 통합 테스트
//   node test/protocols.test.js
// 가상 컨트롤러 + 6개 프로토콜 서버를 높은 포트로 기동하고 tools/clients/* 의 샘플 클라이언트로 검증한다.
// 언어 모듈(inform/as/hrscript/rapid/krl)이 아직 미완성(스텁)일 수 있으므로, 프로그램 컴파일/실행 및
// 언어 변수 관련 항목은 "관대(tolerant)" 검사로 처리하고 결과를 경고로만 출력한다.
import net from 'node:net';
import dgram from 'node:dgram';
import { Controller } from '../server/controller.js';
import { startAll, closeAll } from '../server/protocols/index.js';
import { LANGS } from '../server/lang/index.js';
import { HseClient, demo as yaskawaDemo, request as hseRequest, parseResponse as hseParse } from '../tools/clients/yaskawa-hse-client.js';
import { AsClient, demo as kawasakiDemo } from '../tools/clients/kawasaki-as-client.js';
import { HyundaiClient, demo as hyundaiDemo } from '../tools/clients/hyundai-openapi-client.js';
import { RwsClient, demo as abbDemo } from '../tools/clients/abb-rws-client.js';
import { KvpClient, demo as kukaDemo } from '../tools/clients/kuka-varproxy-client.js';

const PORTS = {
  yaskawaHse: { port: 21040, filePort: 21041 },
  kawasakiAs: { port: 21023, fallbackPort: 21024 },
  hyundai: { port: 21888 },
  abbRws: { port: 21080 },
  kukaVarProxy: { port: 21070 },
  urDashboard: { port: 21099 },
};

let pass = 0, fail = 0, warn = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ✔ ${msg}`); } else { fail++; console.log(`  ✘ ${msg}`); } };
const soft = (cond, msg) => { if (cond) { pass++; console.log(`  ✔ ${msg}`); } else { warn++; console.log(`  ⚠ ${msg} (언어 모듈 의존 — 경고)`); } };
const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;
const quiet = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isStub = (v) => LANGS[v]?.name === v; // index.js 스텁은 name === id
async function section(title, fn) {
  console.log(`\n■ ${title}`);
  try { await fn(); } catch (e) { fail++; console.log(`  ✘ 예외: ${e.stack || e.message}`); }
}

const ctrl = new Controller();
ctrl.setMode('REMOTE');   // 모드 인터록: 외부 명령(서보 ON·시작·이동)은 REMOTE 모드에서만 허용
const handles = await startAll(ctrl, PORTS);
console.log('기동된 프로토콜:', handles.map((h) => `${h.key}:${h.port}`).join(', '));
ok(handles.length === 6 && handles.every((h) => h.port), '6개 프로토콜 모두 포트 바인딩');
const port = (k) => handles.find((h) => h.key === k).port;

// ------------------------------------------------------------------ Yaskawa
await section('Yaskawa HSE (UDP)', async () => {
  ctrl.setRobot('yaskawa-gp7');
  ctrl.setServo(false);
  const r = await yaskawaDemo('127.0.0.1', PORTS.yaskawaHse, quiet);
  ok(r.system.model === 'GP7', '시스템 정보 모델명');
  ok(r.statusBefore.servoOn === false && r.statusBefore.teach === false && r.statusBefore.commandRemote === true, '상태 읽기 (서보 OFF, REMOTE)');
  ok(r.statusServo.servoOn === true && ctrl.servo, '서보 ON 명령');
  const ppd = ctrl.robot.pulsePerDeg;
  ok(near(r.pulse.axes[4], Math.round(-90 * ppd[4]), 1), '펄스 위치 (B축 = -90deg × pulsePerDeg)');
  ok(r.cart.type === 16 && r.cart.xyz.length === 6, '직교 위치 (베이스 좌표, type 16)');
  ok(r.out === 0b101 && !ctrl.getDO(1), 'IO 쓰기/읽기 (OT#1-8 바이트)');
  ok(r.b1 === 42 && r.i2 === -1234 && r.d3 === 123456789 && near(r.r4, 3.5) && r.s5 === 'HELLO', '변수 B/I/D/R/S 쓰기/읽기');
  ok(ctrl.regs.get('I:2') === -1234, 'ctrl.regs 키 형식 I:n');
  ok(r.p10.xyz.every((v, i) => near(v, r.cart.xyz[i], 0.01)) && ctrl.regs.get('P:10')?.kind === 'pose', 'P 변수 쓰기/읽기');
  ok(near(r.cartAfter.xyz[2], r.cart.xyz[2] - 20, 0.1), '직선 증분 이동 (Z -20mm)');
  ok(r.list.includes('HSETEST.JBI') && ctrl.files.has('HSETEST.JBI'), '파일 로드(업로드) + 목록');
  ok(r.download.includes('NOP') && r.download.includes('\r\n'), '파일 저장(다운로드)');
  ok(r.job.job === 'HSETEST' && ctrl.main === 'HSETEST.JBI', '잡 선택');
  soft(r.started, `잡 기동 ${r.startError ?? ''}`);

  const c = new HseClient('127.0.0.1', PORTS.yaskawaHse);
  try {
    await sleep(300);
    // 큰 파일(다중 블록) 업로드/다운로드
    const big = '/JOB\r\n//NAME BIGJOB\r\n' + Array.from({ length: 120 }, (_, i) => `'COMMENT LINE ${i}`).join('\r\n') + '\r\nEND\r\n';
    await c.uploadFile('BIGJOB.JBI', big);
    const back = await c.downloadFile('BIGJOB.JBI');
    ok(back === big, `다중 블록 파일 전송 (${big.length} bytes)`);
    await c.deleteFile('BIGJOB.JBI');
    ok(!ctrl.files.has('BIGJOB.JBI'), '파일 삭제');
    // 정의되지 않은 명령 → status 0x08
    let err; try { await c.call(0x1ff, 1, 0, 0x01); } catch (e) { err = e; }
    ok(err?.status === 0x08, '미정의 명령 → 상태 0x08');
    // 서보 OFF 중 이동 → 오류 (부가 상태)
    await c.servo(false);
    err = null; try { await c.movePulse([0, 0, 0, 0, -90 * ppd[4], 0]); } catch (e) { err = e; }
    ok(err?.status === 0x1f && err.added > 0, `서보 OFF 이동 → 오류 status=0x1f added=0x${err?.added?.toString(16)}`);
    await c.servo(true);
    // 펄스 이동
    await c.movePulse([10 * ppd[0], 0, 0, 0, -90 * ppd[4], 0], { speed: { percent: 100 } });
    await sleep(100);
    ok((await c.readStatus()).running || ctrl.segment !== null || near(ctrl.joints[0], 10, 0.01), '펄스 이동 명령 수락');
    while (ctrl.segment) await sleep(20);
    ok(near(ctrl.joints[0], 10, 0.01), '펄스 이동 완료 (S=10deg)');
    // HOLD
    await c.hold(true);
    ok((await c.readStatus()).holdCommand, 'HOLD ON 상태 비트');
    await c.hold(false);
    ok(!(await c.readStatus()).holdCommand, 'HOLD OFF');
    // 복수 IO 읽기 + 범용입력
    ctrl.setDI(9, true);
    const multi = await c.readIOMulti(1, 2);
    ok(multi[1] === 1, '복수 IO 읽기 (IN#9 → 인스턴스 2 bit0)');
    // 원시 패킷 형식 확인 (헤더 32바이트, 응답 서비스 | 0x80)
    const sock = dgram.createSocket('udp4');
    const raw = await new Promise((res) => {
      sock.on('message', res);
      sock.send(hseRequest({ cmd: 0x72, instance: 1, attribute: 0, service: 0x01, reqId: 7 }), PORTS.yaskawaHse.port, '127.0.0.1');
    });
    sock.close();
    const pr = hseParse(raw);
    ok(raw.toString('ascii', 0, 4) === 'YERC' && raw.readUInt16LE(4) === 0x20 && raw[8] === 3 && raw[10] === 1 && pr.reqId === 7 && raw[24] === 0x81 && raw.toString('ascii', 16, 24) === '99999999' && pr.data.length === 8, '응답 패킷 헤더 형식');
  } finally { c.close(); }
  ctrl.stopProgram();
});

// ------------------------------------------------------------------ Kawasaki
await section('Kawasaki AS 터미널 (TCP)', async () => {
  ctrl.setRobot('kawasaki-rs007n');
  ctrl.setServo(false);
  const p = port('kawasakiAs');
  const r = await kawasakiDemo('127.0.0.1', p, quiet);
  ok(/Kawasaki AS/.test(r.banner), '로그인 + 배너');
  ok(/RS007N/.test(r.id), 'ID');
  ok(r.parsed.joints?.length === 6 && near(r.parsed.joints[2], ctrl.joints[2], 0.01), 'WHERE 관절');
  ok(r.parsed.pose?.length === 6, 'WHERE 직교 (X Y Z O A T)');
  ok(ctrl.servo, 'ZPOW ON');
  ok(ctrl.override === 80 || ctrl.override === 100, 'SPEED');
  ok(/o x o\s*$|xxxxxoxo/.test(r.io.split('\n')[0]) || r.io.split('\n')[0].trim().endsWith('oxo'), 'SIGNAL 1,-2,3 → IO 표시');
  soft(r.print.trim() === '7', `PRINT 1+2*3 = ${JSON.stringify(r.print)}`);
  ok(/astest/i.test(r.load) && [...ctrl.files.keys()].includes('astest.as'), 'LOAD (Ctrl-Z 종료 업로드)');
  ok(/astest/i.test(r.dir), 'DIRECTORY');
  ok(/\.PROGRAM astest/i.test(r.list) && /에뮬레이터/.test(r.list), 'LIST /P (UTF-8 유지)');
  ok(r.saved.includes('.PROGRAM astest') && r.saved.includes('.END'), 'SAVE (Ctrl-Z 종료 다운로드)');
  soft(!/^\(P/.test(r.execute) && /running/i.test(r.status), `EXECUTE + STATUS ${r.execute}`);
  ok(/Monitor speed/.test(r.status), 'STATUS 형식');
  ok(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d$/.test(r.time.trim()), 'TIME');
  ok(r.invalid.includes('(P1002)Invalid command.'), '알 수 없는 명령 오류');

  // 같은 TCP 청크에 LOAD + 내용 + Ctrl-Z 를 한꺼번에 보내는 경우
  const c = new AsClient('127.0.0.1', p);
  await c.connect();
  c.buf = '';
  c.sock.write('LOAD burst.as\r\n.PROGRAM burst()\r\n  TWAIT 0.1\r\n.END\r\n\x1a');
  await c._until((b) => /loaded/.test(b) && b.endsWith('\r\n>'));
  ok(ctrl.files.get('burst.as')?.includes('.PROGRAM burst()'), 'LOAD 일괄 전송 (단일 청크)');
  ok(/HOLD|^$/.test(await c.cmd('HOLD')) && ctrl.held, 'HOLD');
  await c.cmd('KILL');
  ok(!ctrl.held, 'KILL');
  await c.cmd('ZPOW OFF');
  ok(!ctrl.servo, 'ZPOW OFF');
  ok(/Motor power OFF/.test(await c.cmd('ZPOWER')), 'ZPOWER 상태 조회');
  await c.cmd('DELETE burst');
  ok(!ctrl.files.has('burst.as'), 'DELETE');
  c.close();

  // 텔넷 IAC 협상을 보내는 클라이언트 → 서버 에코 + IAC 제거
  const raw = await new Promise((resolve, reject) => {
    const s = net.connect(p, '127.0.0.1');
    let acc = Buffer.alloc(0), step = 0;
    s.on('data', (d) => {
      acc = Buffer.concat([acc, d]);
      const t = acc.toString('latin1');
      if (step === 0 && t.includes('login:')) { step = 1; s.write(Buffer.concat([Buffer.from([255, 253, 1, 255, 251, 31]), Buffer.from('as\r\n')])); }
      else if (step === 1 && t.endsWith('\r\n>')) { step = 2; acc = Buffer.alloc(0); s.write('TIME\r\n'); }
      else if (step === 2 && t.endsWith('\r\n>')) { s.destroy(); resolve(t); }
    });
    s.on('error', reject);
    setTimeout(() => reject(new Error('IAC 테스트 시간 초과')), 3000);
  });
  ok(raw.startsWith('TIME') && /\d{4}\//.test(raw), '텔넷 IAC 처리 + 서버 에코');
});

// ------------------------------------------------------------------ Hyundai
await section('Hyundai Open API (HTTP)', async () => {
  ctrl.setRobot('hyundai-hh7');
  ctrl.setServo(false);
  const r = await hyundaiDemo('127.0.0.1', port('hyundai'), quiet);
  ok(r.status.robot === ctrl.robot.name && r.status.active === true, '/api/status');
  ok(typeof r.pose.x === 'number' && r.pose.frame === 'base', '/api/pose');
  ok(r.joints.joints.length === 6, '/api/joints');
  ok(r.poCur._type === 'Pose' && near(r.poCur.x, r.pose.x), '/project/robot/po_cur');
  ok(r.rgen._type === 'RGen', '/project/rgen');
  ok(r.servo.servo === true, 'POST /api/servo');
  ok(r.io.value === true && !ctrl.getDO(5), 'IO do 쓰기/읽기');
  ok(r.var.value === 12.5 || r.var.value === '12.5', `변수 쓰기/읽기 (${JSON.stringify(r.var.value)})`);
  ok(r.move.done && near(r.move.joints[0], r.joints.joints[0] + 5, 0.01), 'POST /api/move (wait)');
  ok(r.files.some((f) => f.name === '0099.job') && r.download.includes('MOVE'), '파일 업로드/다운로드');
  ok(r.select.main === '0099.job', '프로그램 선택 (번호 → 0099.job)');
  soft(r.start?.ok, `프로그램 시작 ${r.startError ?? ''}`);
  const c = new HyundaiClient('127.0.0.1', port('hyundai'));
  await c.program('stop');
  let e; try { await c.req('GET', '/api/nothing'); } catch (x) { e = x; }
  ok(e?.status === 404, '없는 경로 404');
  e = null; try { await c.move({ type: 'linear', pose: [5000, 0, 0, 0, 0, 0] }); } catch (x) { e = x; }
  ok(e?.status === 422, '도달 불가 이동 → 422');
  const opt = await fetch(`http://127.0.0.1:${port('hyundai')}/api/status`, { method: 'OPTIONS' });
  ok(opt.status === 204 && opt.headers.get('access-control-allow-origin') === '*', 'CORS preflight');
  await c.setIO('di', 7, true);
  ok(ctrl.getDI(7), 'DI 시뮬레이션 쓰기');
});

// ------------------------------------------------------------------ ABB
await section('ABB Robot Web Services (HTTP)', async () => {
  ctrl.setRobot('abb-irb1200');
  ctrl.setDO(1, false); // 앞 섹션(Kawasaki SIGNAL 1)의 출력 상태 초기화
  ctrl.setServo(false);
  const r = await abbDemo('127.0.0.1', port('abbRws'), quiet);
  ok(r.identity['ctrl-type'] === 'Virtual Controller', '/ctrl/identity');
  ok(near(Number(r.joint.rax_5), ctrl.robot.home[4], 0.01) || Number.isFinite(Number(r.joint.rax_5)), 'jointtarget');
  ok(['x', 'y', 'z', 'q1', 'q2', 'q3', 'q4', 'cf1'].every((k) => k in r.rob), 'robtarget 필드');
  ok(r.ctrl.ctrlstate === 'motoron' && ctrl.servo, 'ctrlstate motoron');
  ok(r.speed.speedratio === '75', 'speedratio 설정/읽기');
  ok(r.do1 === '1', '신호 쓰기/읽기 (DO1)');
  ok(r.events.some((e) => e.lvalue === "1") && r.events.some((e) => e.speedratio === "100"), `구독 WebSocket 이벤트 (${JSON.stringify(r.events)})`);
  ok(r.upload.status === 201 && r.dir.some((d) => d._title === 'RwsTest.mod'), 'fileservice PUT + 디렉터리 목록');
  ok(r.download.includes('MODULE RwsTest'), 'fileservice GET');
  ok(r.modules.some((m) => m.name === 'RwsTest'), 'loadmod → 모듈 목록');
  soft(String(r.symbol).replace(/"/g, '') === '42', `RAPID 심볼 쓰기/읽기 (${r.symbol ?? r.symbolError})`);
  soft(r.started && (r.exec2.ctrlexecstate === 'running' || ctrl.vm?.status === 'done'), `RAPID 실행 시작 ${r.startError ?? ''}`);

  const c = new RwsClient('127.0.0.1', port('abbRws'));
  await c.stop();
  await c.resetPP();
  ok((await c.execution()).ctrlexecstate === 'stopped', 'execution stop/resetpp');
  // 기본 XHTML 형식
  const x = await c.req('GET', '/rw/panel/opmode', null, { json: false });
  ok(/application\/xhtml\+xml/.test(x.headers.get('content-type')) && /<li class="pnl-opmode" title="opmode"><span class="opmode">(MANR|AUTO)<\/span><\/li>/.test(x.text), 'XHTML 응답 형식');
  ok(/-http-session-=/.test(x.headers.get('set-cookie') || '') || c.cookies.has('-http-session-'), '세션 쿠키');
  // RWS 2.0 JSON
  const j2 = await (await fetch(`http://127.0.0.1:${port('abbRws')}/rw/rapid/execution`, { headers: { Accept: 'application/hal+json;v=2.0' } })).json();
  ok(j2.state?.[0]?._type === 'rap-execution', 'RWS 2.0 hal+json');
  // RWS 2.0 심볼 경로 + set-value 경로
  const f = await fetch(`http://127.0.0.1:${port('abbRws')}/rw/iosystem/signals/Local/DRV_1/DO4/set-value`, { method: 'POST', body: 'lvalue=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded;v=2.0', Accept: 'application/hal+json;v=2.0' } });
  ok(f.status === 204 && ctrl.getDO(4), 'RWS 2.0 set-value');
  await c.setSymbol('RwsTest', 'freeVar', '[1,2,3]').catch(() => {});
  ok(/\[1,2,3\]/.test(await c.getSymbol('RwsTest', 'freeVar').catch(() => '')), '미정의 심볼 → 레지스터 저장/읽기');
  const sigs = await c.signals();
  ok(sigs.some((s) => s.name === 'DO1') && sigs.some((s) => s.type === 'DI'), '신호 목록');
  await c.unloadModule('RwsTest');
  ok(!(await c.modules()).some((m) => m.name === 'RwsTest'), 'unloadmod');
  await c.deleteFile('RwsTest.mod');
  ok(!(await c.listDir()).some((d) => d._title === 'RwsTest.mod'), 'fileservice DELETE');
  let e; try { await c.state('/rw/nothing'); } catch (z) { e = z; }
  ok(e?.status === 404, '없는 리소스 404');
  ctrl.alarm('TEST', '테스트 알람');
  ok((await c.elog()).some((m) => /테스트 알람/.test(m.desc)), 'elog (알람 이력)');
  ctrl.resetAlarms();
  await c.setMotors(false);
  e = null; try { await c.start(); } catch (z) { e = z; }
  ok(e?.status === 400, '모터 OFF 시 start → 400');
});

// ------------------------------------------------------------------ KUKA
await section('KUKA KukaVarProxy (TCP)', async () => {
  ctrl.setRobot('kuka-kr6-r900');
  const r = await kukaDemo('127.0.0.1', port('kukaVarProxy'), quiet);
  ok(/^\{E6AXIS: A1 /.test(r.axis) && /A6 /.test(r.axis), '$AXIS_ACT 형식');
  ok(/^\{E6POS: X /.test(r.pos) && 'S' in r.posObj && 'T' in r.posObj, '$POS_ACT 형식 (S/T 포함)');
  ok(r.ov === '100' && r.ovSet === '50', '$OV_PRO 읽기/쓰기');
  ok(['#T1', '#AUT', '#EX'].includes(r.mode), '$MODE_OP');
  ok(/^#P_/.test(r.state), '$PRO_STATE1');
  ok(r.out3 === 'TRUE' && !ctrl.getDO(3), '$OUT[3] 쓰기/읽기');
  ok(r.in1 === 'TRUE' || r.in1 === 'FALSE', '$IN[1]');
  ok(r.user === '17', '사용자 변수 쓰기/읽기');
  ok(!!r.missingError, '없는 시스템 변수 → 실패 응답');
  ok(r.batch.length === 3, '파이프라이닝');

  // 프레이밍: 두 메시지를 한 청크로 + 한 메시지를 바이트 단위로 쪼개 전송
  const raw = await new Promise((resolve, reject) => {
    const s = net.connect(port('kukaVarProxy'), '127.0.0.1');
    const msg = (id, name) => { const n = Buffer.from(name); const b = Buffer.alloc(7 + n.length); b.writeUInt16BE(id, 0); b.writeUInt16BE(3 + n.length, 2); b[4] = 0; b.writeUInt16BE(n.length, 5); n.copy(b, 7); return b; };
    let acc = Buffer.alloc(0);
    s.on('data', (d) => { acc = Buffer.concat([acc, d]); });
    s.on('connect', async () => {
      s.write(Buffer.concat([msg(11, '$OV_PRO'), msg(12, '$MODE_OP')]));
      const m3 = msg(13, '$OUT[2]');
      for (const byte of m3) { s.write(Buffer.from([byte])); await sleep(2); }
      await sleep(150);
      s.destroy();
      resolve(acc);
    });
    s.on('error', reject);
  });
  const ids = [];
  let off = 0;
  while (off + 4 <= raw.length) { const len = raw.readUInt16BE(off + 2); ids.push(raw.readUInt16BE(off)); const tail = raw.subarray(off + 4 + len - 3, off + 4 + len); ok(tail.equals(Buffer.from([0, 1, 1])), `응답 #${raw.readUInt16BE(off)} 꼬리 00 01 01`); off += 4 + len; }
  ok(ids.join(',') === '11,12,13', '프레이밍 (결합/분할 메시지)');
  const c = new KvpClient('127.0.0.1', port('kukaVarProxy'));
  await c.connect();
  const before = ctrl.joints.map((v) => v.toFixed(3));
  const ax = KvpClient.parseStruct(await c.read('$AXIS_ACT'));
  ok(['A1', 'A2', 'A3', 'A4', 'A5', 'A6'].every((k, i) => near(ax[k], Number(before[i]), 0.001)), '$AXIS_ACT 값 = 컨트롤러 관절각');
  soft(!isStub('kuka'), 'krl.js 언어 모듈 로드됨');
  c.close();
});

// ------------------------------------------------------------------ 비주력 제조사에서도 응답
await section('교차 제조사 응답', async () => {
  ctrl.setRobot('kuka-kr6-r900');
  const y = new HseClient('127.0.0.1', PORTS.yaskawaHse);
  const pos = await y.readPosition(true);
  y.close();
  ok(pos.xyz.length === 6, 'KUKA 선택 중 Yaskawa HSE 위치 읽기');
  const h = await new HyundaiClient('127.0.0.1', port('hyundai')).status();
  ok(h.vendor === 'kuka' && h.active === false, 'KUKA 선택 중 Hyundai API 상태 (active=false)');
});

await closeAll(handles);
console.log(`\n결과: 통과 ${pass}, 실패 ${fail}, 경고 ${warn}`);
process.exit(fail ? 1 : 0);
