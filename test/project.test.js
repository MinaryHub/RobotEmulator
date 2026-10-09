// 프로젝트 저장/불러오기, 제조사별 프로그램 보관, 자동 저장 복원
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Controller } from '../server/controller.js';
import { ProjectStore } from '../server/project.js';

let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  OK ' : '  NG '} ${m}`); if (!c) fail++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'robotemu-proj-'));

// 1) 제조사 전환 시 프로그램 보관/복원
const a = new Controller();
a.setRobot('yaskawa-gp12');
a.loadFiles({ 'MY.JBI': '/JOB\n//NAME MY\n//INST\nNOP\nTIMER T=0.10\nEND\n' });
a.setMain('MY.JBI');
a.regs.set('I:5', 42);
a.setRobot('kuka-kr6-r900');
ok(a.files.has('pick_place.src'), 'KUKA 선택 → KUKA 예제 로드');
a.loadFiles({ 'mine.src': 'DEF mine()\n  WAIT SEC 0.1\nEND\n' });
a.setMain('mine.src');
a.setRobot('yaskawa-gp12');
ok(a.files.has('MY.JBI') && a.main === 'MY.JBI' && a.regs.get('I:5') === 42, '야스카와로 돌아오면 사용자 프로그램·변수 복원');

// 2) 저장 → 새 컨트롤러에 불러오기
a.setGripper('onrobot-rg6');
a.setOverride(55);
a.blendEnabled = false;
a.setCollisionMode('warn');
const sa = new ProjectStore(a, dir);
sa.save('테스트 셀');
ok(sa.list().some((p) => p.name === '테스트 셀' && p.robotId === 'yaskawa-gp12'), '목록에 저장된 프로젝트 표시');

const b = new Controller();
const sb = new ProjectStore(b, dir);
sb.load('테스트 셀');
ok(b.robot.id === 'yaskawa-gp12' && b.gripper.id === 'onrobot-rg6', `로봇·그리퍼 복원 (${b.robot.id}, ${b.gripper.id})`);
ok(b.files.has('MY.JBI') && b.main === 'MY.JBI' && b.regs.get('I:5') === 42, '현재 제조사 프로그램·변수 복원');
ok(b.override === 55 && b.blendEnabled === false && b.collisionMode === 'warn', '설정 복원 (오버라이드/블렌딩/간섭 모드)');
b.setRobot('kuka-kr10-r1100');
ok(b.files.has('mine.src') && b.main === 'mine.src', '다른 제조사(KUKA) 프로그램도 프로젝트에서 복원');

// 3) 같은 제조사 상태에서 불러오기
const c = new Controller();
c.setRobot('yaskawa-gp7');
const sc = new ProjectStore(c, dir);
sc.load('테스트 셀');
ok(c.robot.id === 'yaskawa-gp12' && c.files.has('MY.JBI'), '같은 제조사 상태에서 불러와도 파일 교체');

// 4) 자동 저장 → 복원
const sd = new ProjectStore(a, dir);
const stop = sd.startAutosave();
await new Promise((r) => setTimeout(r, 2300));
stop();
ok(fs.existsSync(path.join(dir, '_autosave.json')), '자동 저장 파일 생성');
const e = new Controller();
const se = new ProjectStore(e, dir);
ok(se.restoreAutosave() && e.robot.id === 'yaskawa-gp12' && e.files.has('MY.JBI'), '재시작 시 자동 저장 복원');

// 5) 잘못된 이름/형식 거부
let threw = 0;
try { sa.save('../evil'); } catch { threw++; }
try { sa.apply({ hello: 1 }); } catch { threw++; }
ok(threw === 2, '경로 조작 이름·잘못된 형식 거부');

fs.rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exit(fail ? 1 : 0);
