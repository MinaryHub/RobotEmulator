// 제조사 통신 인터페이스 일괄 기동
//  config = {
//    yaskawaHse:   { port: 10040, filePort: 10041 },
//    kawasakiAs:   { port: 23, fallbackPort: 10023 },
//    hyundai:      { port: 8888 },
//    abbRws:       { port: 8080 },
//    kukaVarProxy: { port: 7000 },
//    modbus:       { port: 502, fallbackPort: 1502 },   ← 산업용 필드버스 (제조사 무관)
//    opcua:        { port: 4840 },
//  }  각 항목은 enabled:false 로 비활성화, host 로 바인딩 주소 지정 가능.
//  필드버스(modbus/opcua)는 optional: config 에 해당 키가 있을 때만 기동한다
//  (server/index.js loadConfig 기본값에 포함되어 있으므로 서버 실행 시에는 항상 기동).
//  OPC UA 는 초기화(노드셋 로드/인증서 생성)에 수 초가 걸리므로 목록의 마지막에 둔다.
// 모든 프로토콜은 현재 선택된 제조사와 관계없이 응답한다 (현재 로봇 데이터를 사용). vendor 필드로 "주" 제조사를 표시.
import * as yaskawa from './yaskawa-hse.js';
import * as kawasaki from './kawasaki-as.js';
import * as hyundai from './hyundai-openapi.js';
import * as abb from './abb-rws.js';
import * as kuka from './kuka-varproxy.js';
import * as modbus from './modbus-tcp.js';
import * as opcua from './opcua.js';

export const PROTOCOLS = [
  { key: 'yaskawaHse', mod: yaskawa, vendor: 'yaskawa', defaults: { port: 10040, filePort: 10041 } },
  { key: 'kawasakiAs', mod: kawasaki, vendor: 'kawasaki', defaults: { port: 23, fallbackPort: 10023 } },
  { key: 'hyundai', mod: hyundai, vendor: 'hyundai', defaults: { port: 8888 } },
  { key: 'abbRws', mod: abb, vendor: 'abb', defaults: { port: 8080 } },
  { key: 'kukaVarProxy', mod: kuka, vendor: 'kuka', defaults: { port: 7000 } },
  { key: 'modbus', mod: modbus, vendor: null, optional: true, defaults: { port: 502, fallbackPort: 1502 } },
  { key: 'opcua', mod: opcua, vendor: null, optional: true, defaults: { port: 4840 } },
];

export async function startAll(ctrl, config = {}) {
  const out = [];
  for (const p of PROTOCOLS) {
    if (p.optional && !config[p.key]) continue;
    const cfg = { ...p.defaults, ...(config[p.key] || {}) };
    if (cfg.enabled === false) continue;
    try {
      const h = await p.mod.start(ctrl, cfg);
      out.push({ key: p.key, vendor: p.vendor, ...h, close: h.close });
    } catch (e) {
      ctrl.log('comm', `[${p.key}] 기동 실패: ${e.message}`);
      out.push({ key: p.key, vendor: p.vendor, name: p.key, proto: '?', port: null, error: e.message, close() {} });
    }
  }
  return out;
}

export async function closeAll(list) {
  for (const h of list || []) { try { await h.close(); } catch {} }
}
