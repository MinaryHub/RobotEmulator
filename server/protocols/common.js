// 통신 모듈 공용 헬퍼
//  - 로그 스로틀(고빈도 폴링 시 동일 메시지 반복 억제)
//  - 포트 바인딩(실패 시 예외 대신 null)
//  - 언어 모듈 확장 함수(formatValue/parseValue/executeLine 등) 동적 로드
//  - 반복 사이클 실행기, 자세/관절 헬퍼
import { toVendorPose, fromVendorPose } from '../../shared/poseformat.js';
import { fkTcp } from '../../shared/kinematics.js';

// ------------------------------------------------------------ 로그
// 같은 메시지는 windowMs 안에 한 번만 기록하고, 억제된 횟수를 다음 기록 때 덧붙인다.
export function makeLogger(ctrl, tag, windowMs = 3000) {
  const seen = new Map(); // msg → {t, n}
  return function log(msg, force = false) {
    const now = Date.now();
    const s = seen.get(msg);
    if (!force && s && now - s.t < windowMs) { s.n++; return; }
    const extra = s && s.n ? ` (반복 ${s.n}회 생략)` : '';
    seen.set(msg, { t: now, n: 0 });
    if (seen.size > 300) for (const [k, v] of seen) if (now - v.t > windowMs) seen.delete(k);
    ctrl.log('comm', `[${tag}] ${msg}${extra}`);
  };
}

// ------------------------------------------------------------ 바인딩
// server: net.Server / http.Server / dgram.Socket. 성공 시 실제 포트, 실패 시 { error }
export function bindServer(server, port, host) {
  return new Promise((resolve) => {
    const onErr = (e) => { cleanup(); resolve({ error: e }); };
    const onOk = () => { cleanup(); const a = server.address(); resolve({ port: a?.port ?? port }); };
    const cleanup = () => { server.off('error', onErr); server.off('listening', onOk); };
    server.once('error', onErr);
    server.once('listening', onOk);
    try {
      if (typeof server.bind === 'function') server.bind(port, host);
      else server.listen(port, host);
    } catch (e) { onErr(e); }
  });
}

// ------------------------------------------------------------ 언어 확장
// 다른 에이전트가 작성 중인 언어 모듈의 named export 를 동적으로 가져온다. 없으면 null.
// 성공한 경우만 캐시 (모듈이 나중에 생기면 다시 시도)
const extCache = new Map();
const LANG_FILES = { yaskawa: 'inform', kawasaki: 'as', hyundai: 'hrscript', abb: 'rapid', kuka: 'krl', doosan: 'drl', ur: 'urscript' };
export async function langExt(vendor) {
  if (extCache.has(vendor)) return extCache.get(vendor);
  const file = LANG_FILES[vendor];
  if (!file) return null;
  try {
    const m = await import(`../lang/${file}.js`);
    extCache.set(vendor, m);
    return m;
  } catch {
    return null;
  }
}

// 언어 모듈 readVar/writeVar 안전 호출 (해당 제조사 언어 모듈 기준)
import { LANGS } from '../lang/index.js';
export function langOf(vendor) { return LANGS[vendor]; }
export function safeReadVar(vendor, ctrl, name) {
  try { return LANGS[vendor]?.readVar?.(ctrl, name); } catch { return undefined; }
}
export function safeWriteVar(vendor, ctrl, name, value) {
  try { return !!LANGS[vendor]?.writeVar?.(ctrl, name, value); } catch { return false; }
}

// ------------------------------------------------------------ 반복 실행 (사이클)
// count: 남은 추가 실행 횟수 (-1 = 무한). 프로그램이 정상 종료(done)되면 다시 시작한다.
export function makeCycleRunner(ctrl, log) {
  let remaining = 0, timer = null, lastVm = null, lastCycle = 0;
  const stop = () => { remaining = 0; if (timer) clearInterval(timer); timer = null; };
  const watch = () => {
    const vm = ctrl.vm;
    if (!vm) return;
    if (vm !== lastVm) { lastVm = vm; lastCycle = vm.cycle; }
    if (vm.status === 'done' && vm.cycle > lastCycle) {
      lastCycle = vm.cycle;
      if (remaining === 0) return stop();
      if (remaining > 0) remaining--;
      ctrl.start().then((ok) => { if (!ok) stop(); });
    } else if (vm.status === 'error' || vm.status === 'aborted') stop();
  };
  return {
    set(count) {
      stop();
      if (!count) return;
      remaining = count;
      lastVm = ctrl.vm; lastCycle = ctrl.vm?.cycle ?? 0;
      timer = setInterval(watch, 30);
      timer.unref?.();
      log?.(`반복 실행 설정: ${count < 0 ? '무한' : count + '회 추가'}`);
    },
    get remaining() { return remaining; },
    get active() { return !!timer; },
    stop,
  };
}

// ------------------------------------------------------------ 자세 헬퍼
// 로봇 베이스 기준 TCP (사용자 좌표계 무시)
export const baseTcp = (ctrl) => fkTcp(ctrl.robot, ctrl.joints, ctrl.tool, null);
export const vendorPoseOf = (vendor, ctrl, useBase = true) => toVendorPose(vendor, useBase ? baseTcp(ctrl) : ctrl.tcpPose());
export { toVendorPose, fromVendorPose };

// 이동 명령을 즉시 응답형으로 시작: 계획 단계 오류는 동기적으로 판별해서 돌려준다.
// 반환: null(정상 시작) 또는 Error
export async function startMove(ctrl, cmd, log) {
  let err = null, done = false;
  const p = ctrl.move(cmd);
  p.then(() => { done = true; }, (e) => { err = e; done = true; });
  await new Promise((r) => setImmediate(r));
  if (err) return err;
  if (!done) p.catch((e) => { if (!e.aborted) log?.(`이동 실패: ${e.message}`); });
  return null;
}

export const busy = (ctrl) => !!ctrl.segment || ctrl.vm?.status === 'running' || ctrl.vm?.status === 'paused';
export const progRunning = (ctrl) => ctrl.vm?.status === 'running' || ctrl.vm?.status === 'paused';

// 프로그램 이름(확장자 없이, 대소문자 무시)으로 ctrl.files 파일 찾기
export function findFile(ctrl, name, exts = []) {
  const want = String(name).trim().toUpperCase();
  const keys = [...ctrl.files.keys()];
  return keys.find((k) => k.toUpperCase() === want)
    ?? keys.find((k) => exts.some((e) => k.toUpperCase() === want + e.toUpperCase()))
    ?? keys.find((k) => k.toUpperCase().replace(/\.[^.]*$/, '') === want)
    ?? null;
}

export const stripExt = (n) => String(n).replace(/\.[^.\\/]*$/, '');
export const pad = (s, n) => String(s).padEnd(n);
export const lpad = (s, n) => String(s).padStart(n);
export const fx = (v, d = 3) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);

// HTTP 요청 본문 읽기 (최대 32MB)
export function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
