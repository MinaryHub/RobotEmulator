// 모든 테스트(test/*.test.js)를 순차 실행
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js') && (!only || f.includes(only))).sort();
let failed = 0;
for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8', timeout: 300000 });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${f.padEnd(28)} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!ok) console.log((r.stdout + r.stderr).split('\n').slice(-25).join('\n'));
}
console.log(`\n${files.length - failed}/${files.length} 통과`);
process.exit(failed ? 1 : 0);
