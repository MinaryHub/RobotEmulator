// 언어 컴파일러 공용 헬퍼
import { fromVendorPose } from '../../shared/poseformat.js';

export class CompileError extends Error {
  constructor(msg, file, line) { super(msg); this.file = file; this.line = line; }
}

// 구문 오류에 파일/라인 정보 부여
export function at(file, line, fn) {
  try { return fn(); } catch (e) {
    if (e instanceof CompileError) throw e;
    throw new CompileError(e.message, file, line);
  }
}

// 런타임 오류에 코드 부여
export class RuntimeErr extends Error { constructor(code, msg) { super(msg); this.code = code; } }

export const poseTarget = (vendor, arr, cfgFilter) => ({ pose: fromVendorPose(vendor, arr), cfgFilter });
export const jointTarget = (arr) => ({ joints: arr.slice(0, 6).map(Number) });

// 이름 대소문자 정규화 (대부분의 로봇 언어는 대소문자 구분 없음)
export const K = (s) => String(s).toUpperCase();

// 문자열/주석 밖의 위치에서 sep 로 분할
export function splitTop(s, sep = ',') {
  const out = [];
  let depth = 0, cur = '', inStr = false;
  for (const ch of s) {
    if (ch === '"') inStr = !inStr;
    if (!inStr) {
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      else if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// 문자열 밖의 주석 제거
export function stripComment(line, marks) {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inStr = !inStr;
    if (!inStr) for (const m of marks) if (line.startsWith(m, i)) return line.slice(0, i);
  }
  return line;
}
