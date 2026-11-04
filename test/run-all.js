// 모든 테스트(test/*.test.js)를 별도 프로세스로 실행 (OS 무관)
//   node test/run-all.js [이름필터]
//   TEST_JOBS=n  동시 실행 개수 (기본: CPU 수, 최대 8). 1 이면 순차 실행.
// 각 테스트는 고정된 서로 다른 포트를 쓰므로 병렬 실행해도 충돌하지 않는다.
// 모션 테스트는 실시간으로 동작하므로 대부분의 시간이 대기 → 병렬 실행으로 전체 시간이 크게 줄어든다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js') && (!only || f.includes(only))).sort();
const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
const jobs = Math.max(1, Number(process.env.TEST_JOBS) || Math.min(8, cpus));
const TIMEOUT_MS = 300000;

function runOne(f) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [path.join(dir, f)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => { out += `\n[타임아웃 ${TIMEOUT_MS / 1000}s]`; child.kill(); }, TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      const ok = code === 0;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${f.padEnd(28)} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      if (!ok) console.log(out.split(/\r?\n/).slice(-25).join('\n'));
      resolve(ok);
    });
  });
}

const t0 = Date.now();
const queue = [...files];
let failed = 0;
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  while (queue.length) if (!(await runOne(queue.shift()))) failed++;
}));
console.log(`\n${files.length - failed}/${files.length} 통과  (${((Date.now() - t0) / 1000).toFixed(1)}s, 동시 ${jobs})`);
process.exit(failed ? 1 : 0);
