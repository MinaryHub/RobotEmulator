// OPC UA 서버 (node-opcua) — 기본 포트 4840
//   엔드포인트: opc.tcp://<host>:4840/UA/RobotEmulator
//   보안: None(익명 허용) + Basic256Sha256 Sign / SignAndEncrypt (클라이언트 인증서 자동 신뢰)
//   서버 인증서: 최초 기동 시 프로젝트 루트 .opcua-pki/ 아래 자체 서명 인증서 자동 생성 (gitignore 대상)
//
// 주소 공간 (네임스페이스 "urn:robot-emulator", NodeId = ns=<idx>;s=Robot.<이름>)
//   Objects/Robot
//     Vendor, Model, Controller (String)
//     Servo (Boolean RW → ctrl.setServo), Mode (String RW: TEACH/PLAY/REMOTE), Override (Double RW, %)
//     Moving, Held, AlarmActive (Boolean), Alarms (String[] "[코드] 메시지")
//     ProgramName, ProgramStatus (String), CurrentLine (Int32), CycleCount (UInt32)
//     LastCycleTime, CurrentCycleTime (Double, 초 — ctrl.cycleStats 가 없으면 0)
//     Joints (Double[6], deg), JointNames (String[6])
//     TcpPose (Double[], 제조사 표현 ctrl.vendorPose()), TcpPoseNames (String[])
//     GripperPosition (Double 0..1), HoldingPart (String, 없으면 "")
//     IO/      DO (Boolean[512] 읽기 전용, 인덱스 0 = DO1), DI (Boolean[512] RW)
//              DO_1..DO_64 (Boolean 읽기 전용), DI_1..DI_64 (Boolean RW)
//     Registers/ MB_0..MB_63 (Int16 RW ↔ ctrl.regs 'MB:n', Modbus 사용자 레지스터와 공유)
//     메서드: ServoOn, ServoOff, Start, Stop, Hold, Resume, ResetAlarms, ResetProgram, MoveHome,
//             MoveJoints(Double[6] joints, Double speedFraction), SelectProgram(String name)
//             출력: Ok (Boolean), Message (String)
//   모든 값은 getter 로 바인딩되어 읽을 때마다 최신 값이며, 구독(모니터링)은 샘플링(최소 100ms)으로 변화를 통지한다.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VENDORS } from '../../shared/robots.js';
import { makeLogger, startMove, findFile, progRunning } from './common.js';

const TAG = 'OPCUA';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const NAMESPACE_URI = 'urn:robot-emulator';
export const RESOURCE_PATH = '/UA/RobotEmulator';

export async function start(ctrl, opts = {}) {
  const port = opts.port ?? 4840;
  const log = makeLogger(ctrl, TAG);
  const pkiDir = opts.pkiDir ?? path.join(ROOT, '.opcua-pki');

  // node-opcua 는 무거우므로 필요할 때만 로드
  let ua;
  try { ua = await import('node-opcua'); }
  catch (e) {
    ctrl.log('comm', `[${TAG}] node-opcua 로드 실패 (npm install 필요): ${e.message}`);
    return { name: 'OPC UA Server', proto: 'opcua', port: null, close() {} };
  }
  const { OPCUAServer, OPCUACertificateManager, Variant, DataType, VariantArrayType, StatusCodes, SecurityPolicy, MessageSecurityMode, nodesets } = ua;

  fs.mkdirSync(pkiDir, { recursive: true });
  const serverCertificateManager = new OPCUACertificateManager({
    rootFolder: path.join(pkiDir, 'server'),
    automaticallyAcceptUnknownCertificate: true,
  });

  const server = new OPCUAServer({
    port,
    resourcePath: RESOURCE_PATH,
    serverCertificateManager,
    nodeset_filename: [nodesets.standard],
    allowAnonymous: true,
    alternateHostname: ['127.0.0.1', 'localhost'], // 로컬 접속 시 엔드포인트 호스트 불일치 경고 방지
    securityModes: [MessageSecurityMode.None, MessageSecurityMode.Sign, MessageSecurityMode.SignAndEncrypt],
    securityPolicies: [SecurityPolicy.None, SecurityPolicy.Basic256Sha256],
    buildInfo: { productName: 'RobotEmulator OPC UA', manufacturerName: 'RobotEmulator', softwareVersion: '1.0.0', buildNumber: '1' },
    serverInfo: { applicationUri: 'urn:robot-emulator:server', productUri: 'urn:robot-emulator', applicationName: { text: 'RobotEmulator' } },
  });

  try {
    await server.initialize();
  } catch (e) {
    ctrl.log('comm', `[${TAG}] 서버 초기화 실패: ${e.message}`);
    try { await server.shutdown(0); } catch {}
    return { name: 'OPC UA Server', proto: 'opcua', port: null, close() {} };
  }

  // ------------------------------------------------------------ 주소 공간
  try { // 주소 공간 구성 오류 시 서버를 정리하고 port:null 반환
    const addressSpace = server.engine.addressSpace;
    const ns = addressSpace.registerNamespace(NAMESPACE_URI);
    const robot = ns.addObject({ organizedBy: addressSpace.rootFolder.objects, browseName: 'Robot', nodeId: 's=Robot' });
    const ioFolder = ns.addObject({ organizedBy: robot, typeDefinition: 'FolderType', browseName: 'IO', nodeId: 's=Robot.IO' });
    const regFolder = ns.addObject({ organizedBy: robot, typeDefinition: 'FolderType', browseName: 'Registers', nodeId: 's=Robot.Registers' });

    const vendorInfo = () => VENDORS[ctrl.vendor] ?? {};
    const G = StatusCodes.Good;

    // 변수 추가: get() → JS 값, set(value) → StatusCode (없으면 읽기 전용)
    const addVar = (parent, id, browseName, dataType, get, set, { array = false, dims, desc } = {}) => {
      const access = set ? 'CurrentRead | CurrentWrite' : 'CurrentRead';
      const value = {
        get: () => {
          try {
            return new Variant({ dataType: DataType[dataType], arrayType: array ? VariantArrayType.Array : VariantArrayType.Scalar, value: get() });
          } catch (e) {
            log(`${browseName} 읽기 오류: ${e.message}`);
            return new Variant({ dataType: DataType[dataType], arrayType: array ? VariantArrayType.Array : VariantArrayType.Scalar, value: array ? [] : null });
          }
        },
      };
      if (set) {
        value.set = (variant) => {
          try {
            const st = set(variant.value);
            if (st === G) log(`쓰기 ${browseName} = ${fmt(variant.value)}`, true);
            return st;
          } catch (e) { log(`${browseName} 쓰기 오류: ${e.message}`, true); return StatusCodes.BadInternalError; }
        };
      }
      return ns.addVariable({
        componentOf: parent, browseName, nodeId: `s=${id}`, dataType,
        valueRank: array ? 1 : -1, arrayDimensions: dims ? [dims] : undefined,
        accessLevel: access, userAccessLevel: access, minimumSamplingInterval: 100,
        description: desc, value,
      });
    };
    const fmt = (v) => { const s = Array.isArray(v) || ArrayBuffer.isView(v) ? `[${Array.from(v).slice(0, 8).join(',')}${v.length > 8 ? ',…' : ''}]` : String(v); return s; };
    const isBool = (v) => typeof v === 'boolean';
    const R = 'Robot.';

    // --- 기본 정보 / 상태
    addVar(robot, R + 'Vendor', 'Vendor', 'String', () => vendorInfo().name ?? ctrl.vendor);
    addVar(robot, R + 'Model', 'Model', 'String', () => ctrl.robot.name);
    addVar(robot, R + 'Controller', 'Controller', 'String', () => vendorInfo().controller ?? '');
    addVar(robot, R + 'Servo', 'Servo', 'Boolean', () => !!ctrl.servo, (v) => {
      if (!isBool(v)) return StatusCodes.BadTypeMismatch;
      return ctrl.setServo(v) === false ? StatusCodes.BadInvalidState : G;
    });
    addVar(robot, R + 'Mode', 'Mode', 'String', () => ctrl.mode, (v) => {
      const m = String(v ?? '').trim().toUpperCase();
      if (!['TEACH', 'PLAY', 'REMOTE'].includes(m)) return StatusCodes.BadOutOfRange;
      ctrl.setMode(m); return G;
    });
    addVar(robot, R + 'Override', 'Override', 'Double', () => Number(ctrl.override), (v) => {
      const x = Number(v);
      if (!Number.isFinite(x) || x < 1 || x > 100) return StatusCodes.BadOutOfRange;
      ctrl.setOverride(x); return G;
    }, { desc: '속도 오버라이드 % (1~100)' });
    addVar(robot, R + 'Moving', 'Moving', 'Boolean', () => !!(ctrl.segment || ctrl.jog));
    addVar(robot, R + 'Held', 'Held', 'Boolean', () => !!ctrl.held);
    addVar(robot, R + 'AlarmActive', 'AlarmActive', 'Boolean', () => !!ctrl.alarms?.length);
    addVar(robot, R + 'Alarms', 'Alarms', 'String', () => (ctrl.alarms ?? []).map((a) => `[${a.code}] ${a.msg}`), null, { array: true });
    addVar(robot, R + 'ProgramName', 'ProgramName', 'String', () => ctrl.main ?? '');
    addVar(robot, R + 'ProgramStatus', 'ProgramStatus', 'String', () => ctrl.vm?.status ?? 'idle');
    addVar(robot, R + 'CurrentLine', 'CurrentLine', 'Int32', () => Number(ctrl.vm?.current?.line) || 0);
    addVar(robot, R + 'CycleCount', 'CycleCount', 'UInt32', () => Math.max(0, Number(ctrl.vm?.cycle) || 0));
    addVar(robot, R + 'LastCycleTime', 'LastCycleTime', 'Double', () => Number(ctrl.cycleStats?.last?.total) || 0, null, { desc: '마지막 사이클 시간 (초)' });
    addVar(robot, R + 'CurrentCycleTime', 'CurrentCycleTime', 'Double', () => Number(ctrl.cycleStats?.current?.elapsed) || 0, null, { desc: '현재 사이클 경과 시간 (초)' });
    addVar(robot, R + 'Joints', 'Joints', 'Double', () => ctrl.joints.slice(0, 6).map(Number), null, { array: true, dims: 6, desc: '관절각 (deg)' });
    addVar(robot, R + 'JointNames', 'JointNames', 'String', () => vendorInfo().jointNames ?? ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'], null, { array: true, dims: 6 });
    addVar(robot, R + 'TcpPose', 'TcpPose', 'Double', () => ctrl.vendorPose().map(Number), null, { array: true, desc: 'TCP 자세 (제조사 표현, mm/deg 또는 쿼터니언)' });
    addVar(robot, R + 'TcpPoseNames', 'TcpPoseNames', 'String', () => vendorInfo().poseNames ?? [], null, { array: true });
    addVar(robot, R + 'GripperPosition', 'GripperPosition', 'Double', () => Math.max(0, Math.min(1, Number(ctrl.grip?.pos) || 0)), null, { desc: '0 = 열림, 1 = 닫힘' });
    addVar(robot, R + 'HoldingPart', 'HoldingPart', 'String', () => String(ctrl.grip?.holding?.id ?? ''));

    // --- IO
    const NIO = 512;
    addVar(ioFolder, R + 'IO.DO', 'DO', 'Boolean', () => { const a = []; for (let i = 1; i <= NIO; i++) a.push(ctrl.getDO(i)); return a; }, null, { array: true, dims: NIO, desc: '로봇 출력 DO1..512 (인덱스 0 = DO1)' });
    addVar(ioFolder, R + 'IO.DI', 'DI', 'Boolean', () => { const a = []; for (let i = 1; i <= NIO; i++) a.push(ctrl.getDI(i)); return a; }, (v) => {
      if (!v || typeof v.length !== 'number' || v.length > NIO) return StatusCodes.BadOutOfRange;
      for (let i = 0; i < v.length; i++) if (ctrl.getDI(i + 1) !== !!v[i]) ctrl.setDI(i + 1, !!v[i]);
      return G;
    }, { array: true, dims: NIO, desc: '로봇 입력 DI1..512 (인덱스 0 = DI1)' });
    for (let n = 1; n <= 64; n++) addVar(ioFolder, `${R}IO.DO_${n}`, `DO_${n}`, 'Boolean', () => ctrl.getDO(n));
    for (let n = 1; n <= 64; n++) {
      addVar(ioFolder, `${R}IO.DI_${n}`, `DI_${n}`, 'Boolean', () => ctrl.getDI(n), (v) => {
        if (!isBool(v)) return StatusCodes.BadTypeMismatch;
        ctrl.setDI(n, v); return G;
      });
    }

    // --- 레지스터 (Modbus 사용자 레지스터와 공유)
    const toInt16 = (v) => ((Math.round(Number(v) || 0) & 0xFFFF) << 16) >> 16;
    for (let n = 0; n < 64; n++) {
      addVar(regFolder, `${R}Registers.MB_${n}`, `MB_${n}`, 'Int16', () => toInt16(ctrl.regs.get(`MB:${n}`)), (v) => {
        if (!Number.isFinite(Number(v))) return StatusCodes.BadTypeMismatch;
        ctrl.regs.set(`MB:${n}`, toInt16(v)); ctrl.emitState(); return G;
      });
    }

    // ------------------------------------------------------------ 메서드
    const OUT_ARGS = [
      { name: 'Ok', dataType: DataType.Boolean, description: { text: '수행 여부' } },
      { name: 'Message', dataType: DataType.String, description: { text: '결과 메시지' } },
    ];
    const addMethod = (name, inputArguments, fn) => {
      const m = ns.addMethod(robot, { browseName: name, nodeId: `s=Robot.${name}`, inputArguments, outputArguments: OUT_ARGS });
      // 주의: node-opcua 는 인자 개수(2)로 async 형식을 판별하므로 context 인자를 반드시 선언
      m.bindMethod(async (args, _context) => {
        let ok = true, msg = 'OK';
        try {
          const r = await fn(...args.map((a) => a.value));
          if (r !== true && r !== undefined) { ok = false; msg = typeof r === 'string' ? r : '거부됨'; }
        } catch (e) { ok = false; msg = e.message; }
        log(`메서드 ${name} → ${ok ? '정상' : '거부: ' + msg}`, true);
        return {
          statusCode: StatusCodes.Good,
          outputArguments: [{ dataType: DataType.Boolean, value: ok }, { dataType: DataType.String, value: msg }],
        };
      });
      return m;
    };
    const canMove = () => {
      if (!ctrl.servo) return '서보 OFF 상태';
      if (ctrl.alarms.length) return '알람 상태';
      if (ctrl.segment || progRunning(ctrl)) return '로봇 동작 중';
      return null;
    };
    addMethod('ServoOn', [], () => (ctrl.setServo(true) === false ? '알람 상태에서는 서보 ON 불가' : true));
    addMethod('ServoOff', [], () => { ctrl.setServo(false); return true; });
    addMethod('Start', [], async () => {
      if (ctrl.alarms.length) return '알람 상태 — 알람 리셋 필요';
      if (!ctrl.servo) return '서보 OFF 상태';
      return (await ctrl.start({ step: false })) ? true : (ctrl.compileError ? `컴파일 오류: ${ctrl.compileError.msg}` : '프로그램 시작 실패');
    });
    addMethod('Stop', [], () => { ctrl.stopProgram(); return true; });
    addMethod('Hold', [], () => {
      if (!(ctrl.segment || progRunning(ctrl))) return '실행 중인 동작 없음';
      ctrl.hold(); return true;
    });
    addMethod('Resume', [], () => { if (!ctrl.held) return 'HOLD 상태 아님'; ctrl.resume(); return true; });
    addMethod('ResetAlarms', [], () => { ctrl.resetAlarms(); return true; });
    addMethod('ResetProgram', [], () => { ctrl.resetProgram(); return true; });
    addMethod('MoveHome', [], async () => {
      const why = canMove(); if (why) return why;
      const err = await startMove(ctrl, { kind: 'J', target: { joints: [...ctrl.robot.home] }, speed: { frac: 0.3 }, base: null }, log);
      return err ? err.message : true;
    });
    addMethod('MoveJoints', [
      { name: 'joints', dataType: DataType.Double, valueRank: 1, arrayDimensions: [6], description: { text: '목표 관절각 6개 (deg)' } },
      { name: 'speedFraction', dataType: DataType.Double, description: { text: '관절 속도 비율 0~1' } },
    ], async (joints, speed) => {
      const j = Array.from(joints ?? []).map(Number);
      if (j.length !== 6 || j.some((v) => !Number.isFinite(v))) return 'joints 는 Double[6] 이어야 함';
      const why = canMove(); if (why) return why;
      const frac = Math.max(0.01, Math.min(1, Number(speed) || 0.3));
      const err = await startMove(ctrl, { kind: 'J', target: { joints: j }, speed: { frac }, base: null }, log);
      return err ? err.message : true;
    });
    addMethod('SelectProgram', [
      { name: 'name', dataType: DataType.String, description: { text: '프로그램(파일) 이름, 확장자 생략 가능' } },
    ], (name) => {
      if (!name) return '이름 필요';
      if (progRunning(ctrl)) return '프로그램 실행 중';
      const ext = vendorInfo().ext ?? '';
      const f = findFile(ctrl, String(name), [ext, ext.toLowerCase(), ext.toUpperCase()]);
      if (!f) return `프로그램 없음: ${name}`;
      ctrl.setMain(f);
      return ctrl.compileError ? `선택됨, 컴파일 오류: ${ctrl.compileError.msg}` : true;
    });
  } catch (e) {
    ctrl.log('comm', `[${TAG}] 주소 공간 구성 실패: ${e.message}`);
    try { await server.shutdown(0); } catch {}
    return { name: 'OPC UA Server', proto: 'opcua', port: null, close() {} };
  }

  // ------------------------------------------------------------ 기동
  try {
    await server.start();
  } catch (e) {
    ctrl.log('comm', `[${TAG}] TCP ${port} 바인딩 실패: ${e.message}`);
    try { await server.shutdown(0); } catch {}
    return { name: 'OPC UA Server', proto: 'opcua', port: null, close() {} };
  }
  const url = server.getEndpointUrl?.() ?? `opc.tcp://localhost:${port}${RESOURCE_PATH}`;
  ctrl.log('comm', `[${TAG}] OPC UA 서버 대기: ${url} (보안 None/익명 허용, Basic256Sha256 Sign·SignAndEncrypt)`);
  return {
    name: 'OPC UA Server', proto: 'opcua', port, endpointUrl: url,
    async close() { try { await server.shutdown(0); } catch {} },
  };
}
