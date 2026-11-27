// 실제 로봇 컨트롤러 백업(ZIP / 다중 폴더 파일) 가져오기 · 내보내기 유틸리티 (외부 의존성 없음)
//  - KUKA KRC/R1/Program/*.src + *.dat + System/$config.dat
//  - ABB RAPID/TASK1/PROGMOD/*.mod + SYSMOD/*.sys
//  - Yaskawa *.JBI, Kawasaki *.as/*.pg, Hyundai *.job, Doosan *.drl, UR *.script
import zlib from 'node:zlib';

const MAX_ZIP_FILES = 256;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

const EXT_VENDOR = [
  [/\.(src|dat|sub)$/i, 'kuka'],
  [/\.(mod|modx|sys|sysx|prg)$/i, 'abb'],
  [/\.jbi$/i, 'yaskawa'],
  [/\.(as|pg)$/i, 'kawasaki'],
  [/\.job$/i, 'hyundai'],
  [/\.drl$/i, 'doosan'],
  [/\.script$/i, 'ur'],
];

export function isZipBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 22 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05);
}

// 최소 표준 ZIP 리더 (method 0 stored, method 8 deflate 지원, zip-bomb 상한 적용)
export function parseZip(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 22) throw new Error('올바른 ZIP 파일이 아닙니다 (크기 부족)');
  // End of Central Directory (0x06054b50) 탐색
  const minOff = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minOff; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP 중앙 디렉터리 끝(EOCD)을 찾을 수 없습니다');
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (totalEntries > MAX_ZIP_FILES * 4) throw new Error(`ZIP 항목 수가 너무 많습니다 (${totalEntries})`);
  if (cdOff + cdSize > buf.length) throw new Error('ZIP 중앙 디렉터리 범위 오류');

  const entries = new Map();
  let off = cdOff;
  let totalOut = 0;
  for (let i = 0; i < totalEntries && off + 46 <= cdOff + cdSize; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('ZIP 중앙 디렉터리 헤더 손상');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    off += 46 + nameLen + extraLen + commentLen;

    if (!name || name.endsWith('/') || name.includes('..') || name.startsWith('__MACOSX/')) continue;
    if (entries.size >= MAX_ZIP_FILES) throw new Error(`압축 내 파일 수 한도(${MAX_ZIP_FILES}) 초과`);
    if (uncompSize > MAX_FILE_BYTES) throw new Error(`파일 크기 한도 초과: ${name}`);
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`ZIP 로컬 헤더 손상: ${name}`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) throw new Error(`ZIP 데이터 범위 오류: ${name}`);
    const comp = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = zlib.inflateRawSync(comp, { maxOutputLength: MAX_FILE_BYTES });
    else continue; // 미지원 압축 방식(예: 암호화/Deflate64)은 건너뜀

    totalOut += data.length;
    if (totalOut > MAX_TOTAL_BYTES) throw new Error('ZIP 압축 해제 총 크기 한도(32MB) 초과');
    entries.set(name, data);
  }
  return entries;
}

// CRC32 테이블 (ZIP 생성용)
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[i] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 최소 표준 ZIP 빌더 (method 0 stored, 백업 내보내기 및 테스트 공용)
export function createZip(filesObj) {
  const entries = filesObj instanceof Map ? [...filesObj.entries()] : Object.entries(filesObj || {});
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [rawName, rawVal] of entries) {
    const nameBuf = Buffer.from(String(rawName).replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(rawVal) ? rawVal : Buffer.from(String(rawVal ?? ''), 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 8); // stored
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

export function detectVendorOfFile(name) {
  for (const [re, v] of EXT_VENDOR) if (re.test(name)) return v;
  return null;
}

// 백업 파일 묶음(ZIP 버퍼 또는 경로→텍스트 맵)에서 로봇 프로그램 파일만 추출·평탄화
export function importBackup(input, { vendor = null } = {}) {
  let rawEntries;
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    const buf = Buffer.from(input);
    if (!isZipBuffer(buf)) throw new Error('지원되지 않는 바이너리 형식입니다 (ZIP 파일 필요)');
    rawEntries = [...parseZip(buf).entries()].map(([k, v]) => [k, v.toString('utf8')]);
  } else if (input instanceof Map) {
    rawEntries = [...input.entries()];
  } else if (input && typeof input === 'object') {
    rawEntries = Object.entries(input);
  } else {
    throw new Error('백업 입력 데이터가 올바르지 않습니다');
  }

  // 제조사 자동 감지 (지정되지 않은 경우 확장자 최다 빈도)
  let detected = vendor;
  if (!detected) {
    const counts = {};
    for (const [p] of rawEntries) {
      const v = detectVendorOfFile(p);
      if (v) counts[v] = (counts[v] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    detected = sorted[0]?.[0] || null;
  }

  const files = {};
  const skipped = [];
  const usedLower = new Set();

  // KUKA 백업의 경우 KRC/R1/ 아래 파일 우선 정렬
  rawEntries.sort((a, b) => {
    const aPri = /(^|\/)(KRC\/R1|RAPID)\//i.test(a[0]) ? 0 : 1;
    const bPri = /(^|\/)(KRC\/R1|RAPID)\//i.test(b[0]) ? 0 : 1;
    return aPri - bPri || a[0].localeCompare(b[0]);
  });

  // 같은 디렉터리의 .src/.dat 쌍이 이름 충돌 시 같은 접미사를 유지하도록 디렉터리별 접미사 추적
  const dirStemSuffix = new Map();

  for (const [fullPath, content] of rawEntries) {
    const norm = String(fullPath).replace(/\\/g, '/').replace(/^\/+/, '');
    const base = norm.split('/').pop();
    if (!base || base.startsWith('.')) { skipped.push(norm); continue; }
    const fv = detectVendorOfFile(base);
    if (!fv || (detected && fv !== detected)) { skipped.push(norm); continue; }
    // 이진/비텍스트 파일 제외 (NULL 바이트 검사)
    const text = String(content ?? '');
    if (text.includes('\x00')) { skipped.push(norm); continue; }

    const dir = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) : '';
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    const pairKey = `${dir}/${stem.toLowerCase()}`;

    let finalName = base;
    if (dirStemSuffix.has(pairKey)) {
      const suf = dirStemSuffix.get(pairKey);
      finalName = suf ? `${stem}_${suf}${ext}` : base;
    } else if (usedLower.has(base.toLowerCase())) {
      let n = 1;
      while (usedLower.has(`${stem}_${n}${ext}`.toLowerCase())) n++;
      dirStemSuffix.set(pairKey, n);
      finalName = `${stem}_${n}${ext}`;
    } else {
      dirStemSuffix.set(pairKey, 0);
    }

    usedLower.add(finalName.toLowerCase());
    files[finalName] = text.replace(/\r\n?/g, '\n');
  }

  return { vendor: detected, files, count: Object.keys(files).length, skipped };
}
