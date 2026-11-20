// 브라우저발 요청 방어 (CSRF · DNS 리바인딩)
//  - 인증이 없는 서버이므로, 사용자가 연 아무 웹페이지가 localhost 로 요청을 보내 로봇을 움직이는 것을 막는다.
//  - Host 헤더: localhost · IP 리터럴 · 설정된 host · config.allowedHosts 만 허용
//    (DNS 리바인딩은 공격자 도메인 이름으로 들어오므로 IP 로 접속하는 정상 사용은 영향 없음)
//  - Origin 헤더: 있으면(=브라우저) 그 호스트가 요청 Host 와 같아야 함 (같은 출처의 웹 UI 만 허용)
//    없으면(PLC·스크립트·curl 등 비브라우저 클라이언트) 허용
import net from 'node:net';

const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '::1']);
let extraHosts = new Set();

// config.host, config.allowedHosts 로 허용 호스트 이름 추가 (예: 'robot-pc.local')
export function configureNetGuard({ host, allowedHosts } = {}) {
  extraHosts = new Set([host, ...(Array.isArray(allowedHosts) ? allowedHosts : [])]
    .filter((h) => typeof h === 'string' && h).map((h) => h.toLowerCase()));
}

// 'host:port' / '[v6]:port' → 소문자 호스트 이름
function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string' || !hostHeader) return null;
  try { return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return null; }
}

export function hostAllowed(req) {
  const h = hostnameOf(req.headers.host);
  if (h == null) return true;   // HTTP/1.0 등 Host 없음 → 브라우저 아님
  return LOCAL_NAMES.has(h) || h.endsWith('.localhost') || net.isIP(h) !== 0 || extraHosts.has(h);
}

export function originAllowed(req) {
  const o = req.headers.origin;
  if (o === undefined) return true;
  if (o === 'null') return false;   // sandbox iframe · file:// 등
  try { return new URL(o).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); } catch { return false; }
}

// 둘 다 통과해야 함. 거부 사유 문자열 또는 null
export function requestRejected(req) {
  if (!hostAllowed(req)) return `허용되지 않은 Host: ${req.headers.host}`;
  if (!originAllowed(req)) return `허용되지 않은 Origin: ${req.headers.origin}`;
  return null;
}
