// npm start 진입점: 서버(server/index.js)를 자식 프로세스로 실행하고,
// 업데이트 후 재시작 요청(종료 코드 75)이면 새 코드로 다시 실행한다. 그 밖의 종료는 그대로 전달.
//  - Ctrl+C: 터미널이 자식에게도 신호를 보내므로 실행기는 자식이 정리하고 끝나기를 기다린다
//  - SIGTERM(서비스·컨테이너): 자식에게 전달
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RESTART_CODE = 75;
const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
let child = null, stopping = false;

function launch() {
  child = spawn(process.execPath, [...process.execArgv, entry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ROBOT_EMU_LAUNCHER: '1' },
  });
  child.on('exit', (code, signal) => {
    if (code === RESTART_CODE && !stopping) {
      console.log('\n  업데이트 완료 — 서버를 다시 시작합니다...\n');
      setTimeout(launch, 500);
      return;
    }
    process.exit(code ?? (signal ? 1 : 0));
  });
}

for (const sig of ['SIGINT', 'SIGBREAK']) {
  // 터미널 Ctrl+C 는 자식도 받아 스스로 정리·종료한다. 실행기만 신호를 받은 경우(kill -INT 등)를 대비해
  // 자식의 정리 시간(최대 3초)이 지나도 살아 있으면 그때 전달
  try { process.on(sig, () => { stopping = true; setTimeout(() => { if (child && child.exitCode === null) child.kill(sig === 'SIGBREAK' ? 'SIGTERM' : 'SIGINT'); }, 3500).unref(); }); } catch {}
}
try { process.on('SIGTERM', () => { stopping = true; child?.kill('SIGTERM'); }); } catch {}

launch();
