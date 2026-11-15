// 제조사 → 로봇 언어 모듈 매핑
const MODS = { yaskawa: './inform.js', kawasaki: './as.js', hyundai: './hrscript.js', abb: './rapid.js', kuka: './krl.js', doosan: './drl.js' };

const stub = (id) => ({
  id, name: id, exts: [],
  compile() { throw new Error(`${id} 언어 모듈이 없습니다`); },
  pickMain: (names) => names[0] ?? null,
  defaultFiles: () => ({}),
  readVar: () => undefined,
  writeVar: () => false,
});

export const LANGS = {};
for (const [vendor, path] of Object.entries(MODS)) {
  try {
    LANGS[vendor] = (await import(path)).default;
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND' || !String(e.message).includes(path.slice(2))) console.error(`[lang] ${path} 로드 실패:`, e);
    LANGS[vendor] = stub(vendor);
  }
}
