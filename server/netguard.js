// 브라우저발 요청 방어 (CSRF · DNS 리바인딩)
//  - 인증이 없는 서버이므로, 사용자가 연 아무 웹페이지가 localhost 로 요청을 보내 로봇을 움직이는 것을 막는다.
//  - Host 헤더: localhost · IP 리터럴 · 설정된 host · config.allowedHosts 만 허용
//    (DNS 리바인딩은 공격자 도메인 이름으로 들어오므로 IP 로 접속하는 정상 사용은 영향 없음)
//  - Origin 헤더: 있으면(=브라우저) 그 호스트가 요청 Host 와 같아야 함 (같은 출처의 웹 UI 만 허용)
//    없으면(PLC·스크립트·curl 등 비브라우저 클라이언트) 허용
import net from 'node:net';
import crypto from 'node:crypto';

const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '::1']);
let extraHosts = new Set();
let secCfg = { token: '', readOnlyToken: '', ipAllowlist: [] };

// config.host, config.allowedHosts, config.security 설정 반영
export function configureNetGuard({ host, allowedHosts, security } = {}) {
  extraHosts = new Set([host, ...(Array.isArray(allowedHosts) ? allowedHosts : [])]
    .filter((h) => typeof h === 'string' && h).map((h) => h.toLowerCase()));
  const s = security && typeof security === 'object' ? security : {};
  secCfg = {
    token: typeof s.token === 'string' ? s.token.trim() : '',
    readOnlyToken: typeof s.readOnlyToken === 'string' ? s.readOnlyToken.trim() : '',
    ipAllowlist: Array.isArray(s.ipAllowlist) ? s.ipAllowlist.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [],
  };
}

function normIp(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}
function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}
function ipMatchesRule(ip, rule) {
  const r = normIp(rule);
  if (ip === r) return true;
  if (r.includes('/')) {
    const [netIp, prefixStr] = r.split('/');
    const prefix = Number(prefixStr);
    const a = ipv4ToInt(ip), b = ipv4ToInt(netIp);
    if (a !== null && b !== null && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32) {
      const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
      return (a & mask) === (b & mask);
    }
  }
  return false;
}

export function ipAllowed(req) {
  if (!secCfg.ipAllowlist.length) return true;
  const ip = normIp(req.socket?.remoteAddress || '');
  if (!ip) return false;
  return secCfg.ipAllowlist.some((rule) => ipMatchesRule(ip, rule));
}

function safeEq(a, b) {
  if (!a || !b) return false;
  const ba = Buffer.from(a, 'utf8'), bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function extractToken(req) {
  const auth = String(req.headers?.authorization || '');
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const hdr = req.headers?.['x-auth-token'];
  if (typeof hdr === 'string' && hdr.trim()) return hdr.trim();
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    const q = u.searchParams.get('token');
    if (q) return q.trim();
  } catch {}
  return '';
}

export function authConfigured() {
  return !!(secCfg.token || secCfg.readOnlyToken);
}

// 반환: 'admin' | 'readonly' | null (토큰 미설정 시 항상 'admin')
export function authRole(req) {
  if (!secCfg.token && !secCfg.readOnlyToken) return 'admin';
  const got = extractToken(req);
  if (!got) return null;
  if (secCfg.token && safeEq(got, secCfg.token)) return 'admin';
  if (secCfg.readOnlyToken && safeEq(got, secCfg.readOnlyToken)) return 'readonly';
  return null;
}

// 'host:port' / '[v6]:port' → 소문자 호스트 이름
function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string' || !hostHeader) return null;
  try { return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return null; }
}

export function hostAllowed(req) {
  if (req.headers.host === undefined) return true;   // HTTP/1.0 등 Host 없음 → 브라우저 아님
  const h = hostnameOf(req.headers.host);
  if (h == null) return false;
  return LOCAL_NAMES.has(h) || h.endsWith('.localhost') || net.isIP(h) !== 0 || extraHosts.has(h);
}

export function originAllowed(req) {
  const o = req.headers.origin;
  if (o === undefined) return true;
  if (o === 'null') return false;   // sandbox iframe · file:// 등
  try { return new URL(o).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); } catch { return false; }
}

// Host · Origin · IP 허용목록 통과 여부. 거부 사유 문자열 또는 null
export function requestRejected(req) {
  if (!hostAllowed(req)) return `허용되지 않은 Host: ${req.headers.host}`;
  if (!originAllowed(req)) return `허용되지 않은 Origin: ${req.headers.origin}`;
  if (!ipAllowed(req)) return `허용되지 않은 IP: ${normIp(req.socket?.remoteAddress)}`;
  return null;
}
