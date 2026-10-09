#!/usr/bin/env node
// OPC UA 샘플 클라이언트 (node-opcua) — 로봇 에뮬레이터 OPC UA 서버용
// 주소 공간은 server/protocols/opcua.js 헤더 / README 참고.
//
// 사용법:  node tools/clients/opcua-client.js [endpointUrl]
//   기본 endpoint: opc.tcp://127.0.0.1:4840/UA/RobotEmulator
//   데모: Robot 폴더 탐색 → Joints 읽기 → Override 쓰기 → ServoOn 호출 → Joints 3초 구독
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as ua from 'node-opcua';

const {
  OPCUAClient, OPCUACertificateManager, AttributeIds, DataType, MessageSecurityMode, SecurityPolicy,
  ClientSubscription, ClientMonitoredItem, TimestampsToReturn, StatusCodes,
} = ua;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const NAMESPACE_URI = 'urn:robot-emulator';
export const DEFAULT_ENDPOINT = 'opc.tcp://127.0.0.1:4840/UA/RobotEmulator';

// 접속 → { client, session, ns, id(name), close() }
//   security: 'none' | 'sign' | 'encrypt'
export async function connect(endpointUrl = DEFAULT_ENDPOINT, { security = 'none' } = {}) {
  const mode = { none: MessageSecurityMode.None, sign: MessageSecurityMode.Sign, encrypt: MessageSecurityMode.SignAndEncrypt }[security];
  const client = OPCUAClient.create({
    applicationName: 'RobotEmulatorSampleClient',
    applicationUri: 'urn:robot-emulator:sample-client',
    endpointMustExist: false,
    securityMode: mode,
    securityPolicy: security === 'none' ? SecurityPolicy.None : SecurityPolicy.Basic256Sha256,
    connectionStrategy: { maxRetry: 2, initialDelay: 200, maxDelay: 1000 },
    clientCertificateManager: new OPCUACertificateManager({ rootFolder: path.join(ROOT, '.opcua-pki', 'client'), automaticallyAcceptUnknownCertificate: true }),
  });
  await client.connect(endpointUrl);
  const session = await client.createSession(); // 익명
  const nsArr = await session.readNamespaceArray();
  const ns = nsArr.indexOf(NAMESPACE_URI);
  if (ns < 0) { await session.close(); await client.disconnect(); throw new Error(`네임스페이스 없음: ${NAMESPACE_URI}`); }
  const id = (name) => `ns=${ns};s=Robot${name ? '.' + name : ''}`;
  return {
    client, session, ns, id,
    async close() { try { await session.close(); } catch {} try { await client.disconnect(); } catch {} },
  };
}

// Robot 폴더(및 하위 폴더) 탐색 → [{name, nodeClass}]
export async function browseRobot(c, sub = '') {
  const r = await c.session.browse(c.id(sub));
  return r.references.map((x) => ({ name: x.browseName.name, nodeClass: String(x.nodeClass), nodeId: x.nodeId.toString() }));
}

export async function read(c, name) {
  const dv = await c.session.read({ nodeId: c.id(name), attributeId: AttributeIds.Value });
  if (dv.statusCode !== StatusCodes.Good) throw new Error(`${name} 읽기 실패: ${dv.statusCode.toString()}`);
  const v = dv.value.value;
  return ArrayBuffer.isView(v) ? Array.from(v) : v;
}
export const readJoints = (c) => read(c, 'Joints');

// 쓰기 → StatusCode 문자열 ("Good" 등)
export async function write(c, name, dataType, value) {
  const st = await c.session.write({ nodeId: c.id(name), attributeId: AttributeIds.Value, value: { value: { dataType: DataType[dataType], value } } });
  return st.name;
}
export const writeOverride = (c, pct) => write(c, 'Override', 'Double', pct);

// 메서드 호출 → { ok, message, status }
export async function call(c, method, inputArguments = []) {
  const r = await c.session.call({ objectId: c.id(), methodId: c.id(method), inputArguments });
  return { status: r.statusCode.name, ok: r.outputArguments?.[0]?.value, message: r.outputArguments?.[1]?.value };
}
export const moveJoints = (c, joints, speedFraction = 0.3) => call(c, 'MoveJoints', [
  { dataType: DataType.Double, arrayType: ua.VariantArrayType.Array, value: joints },
  { dataType: DataType.Double, value: speedFraction },
]);

// 변수 구독: ms 동안 변화값을 모아 반환. onStart() 는 모니터링 시작 직후 호출 (테스트용)
export async function subscribe(c, name, ms = 3000, { onChange, onStart } = {}) {
  const sub = ClientSubscription.create(c.session, {
    requestedPublishingInterval: 100, requestedLifetimeCount: 100, requestedMaxKeepAliveCount: 10,
    maxNotificationsPerPublish: 100, publishingEnabled: true, priority: 1,
  });
  const values = [];
  const item = ClientMonitoredItem.create(sub, { nodeId: c.id(name), attributeId: AttributeIds.Value },
    { samplingInterval: 100, discardOldest: true, queueSize: 10 }, TimestampsToReturn.Both);
  item.on('changed', (dv) => {
    const v = dv.value.value;
    const val = ArrayBuffer.isView(v) ? Array.from(v) : v;
    values.push(val);
    onChange?.(val);
  });
  await new Promise((resolve) => { item.once('initialized', resolve); setTimeout(resolve, 2000); });
  await onStart?.();
  await new Promise((r) => setTimeout(r, ms));
  await sub.terminate();
  return values;
}
export const subscribeJoints = (c, ms, opts) => subscribe(c, 'Joints', ms, opts);

export async function demo(endpointUrl = DEFAULT_ENDPOINT, out = console.log) {
  const c = await connect(endpointUrl);
  try {
    const res = {};
    res.browse = await browseRobot(c);
    out('Robot 노드:', res.browse.map((x) => x.name).join(', '));
    res.joints = await readJoints(c);
    out('Joints(deg):', res.joints.map((v) => v.toFixed(3)).join(', '));
    res.override = await writeOverride(c, 60);
    out('Override = 60 쓰기 →', res.override, '/ 읽기', await read(c, 'Override'));
    res.servo = await call(c, 'ServoOn');
    out('ServoOn 호출 →', JSON.stringify(res.servo), '/ Servo', await read(c, 'Servo'));
    out('Joints 3초 구독...');
    res.changes = await subscribeJoints(c, 3000, { onChange: (v) => out('  변화:', v.map((x) => x.toFixed(2)).join(', ')) });
    out(`구독 통지 ${res.changes.length}건`);
    return res;
  } finally { await c.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  demo(process.argv[2] || DEFAULT_ENDPOINT).then(() => process.exit(0), (e) => { console.error('오류:', e.message); process.exit(1); });
}
