// 비전 카메라: 목록 정규화, 컨트롤러 상태 반영, 프로젝트 저장/복원
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CAMERAS, normalizeCameras, defaultMount, MAX_CAMERAS } from '../shared/cameras.js';
import { Controller } from '../server/controller.js';
import { ProjectStore } from '../server/project.js';

let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  OK ' : '  NG '} ${m}`); if (!c) fail++; };

// 1) 라이브러리 무결성
ok(new Set(CAMERAS.map((c) => c.id)).size === CAMERAS.length, '카메라 id 중복 없음');
ok(CAMERAS.every((c) => c.res[0] > 0 && c.res[1] > 0 && c.hfov > 0 && c.hfov < 180 && c.range[0] > 0 && c.range[1] > c.range[0] && c.modes.length), '해상도·화각·측정 범위 유효');

// 2) 정규화
const n = normalizeCameras([
  { type: 'zivid2-m70', pos: [1, 'x'], mode: 'mono' },
  { type: '없는-카메라' },
  { id: 'a b', type: 'tof-vga', mount: 'moon' },
  { id: 'ab', type: 'cell-monitor', view: false },
]);
ok(n.length === 3, '알 수 없는 type 제외');
ok(n[0].mode === 'color' && n[0].pos.join() === '1,0,0' && n[0].mount === 'flange', '미지원 모드·잘못된 숫자 → 기본값');
ok(n[1].id === 'ab' && n[1].mount === 'world' && n[2].id === 'ab_', 'id 정리·중복 방지, 잘못된 장착 → 기본 장착');
ok(n[2].view === false && n[2].frustum === true, '표시 옵션 유지');
ok(normalizeCameras(Array.from({ length: 20 }, () => ({ type: 'tof-vga' }))).length === MAX_CAMERAS, `최대 ${MAX_CAMERAS}대`);
ok(normalizeCameras('x').length === 0, '배열 아님 → 빈 목록');

// 3) 기본 장착 위치
const top = defaultMount(CAMERAS.find((c) => c.id === 'cell-monitor'), 'world', { table: { x: 700, y: 50 } });
ok(top.pos[0] === 700 && top.pos[1] === 50 && top.pos[2] > 500 && top.rot[0] === 180, '고정 카메라: 테이블 위에서 아래를 봄');
const hand = defaultMount(CAMERAS.find((c) => c.id === 'realsense-d435'), 'flange');
ok(hand.pos[1] > 0 && hand.rot[0] > 0 && hand.rot[0] < 45, '핸드 카메라: 툴 방향으로 기울어짐');

// 4) 컨트롤러 + 프로젝트
const a = new Controller();
a.setCameras([{ id: 'hand', type: 'realsense-d435', mode: 'depth', pos: [0, 70, 25], rot: [13, 0, 0] }, { id: 'top', type: 'cell-monitor', mount: 'world', pos: [600, 0, 1500], rot: [180, 0, -90] }]);
ok(a.snapshot().cameras.length === 2 && a.snapshot().cameras[0].mode === 'depth', '상태(snapshot)에 카메라 포함');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'robotemu-cam-'));
new ProjectStore(a, dir).save('cam');
const b = new Controller();
new ProjectStore(b, dir).load('cam');
ok(JSON.stringify(b.cameras) === JSON.stringify(a.cameras), '프로젝트 저장 → 불러오기 시 카메라 복원');
const p = JSON.parse(fs.readFileSync(path.join(dir, 'cam.json'), 'utf8'));
delete p.cameras;
const c = new Controller();
c.setCameras([{ type: 'tof-vga' }]);
new ProjectStore(c, dir).apply(p);
ok(c.cameras.length === 0, '카메라 항목 없는 이전 프로젝트 → 카메라 없음');

fs.rmSync(dir, { recursive: true, force: true });
for (const x of [a, b, c]) clearInterval(x._timer);
console.log(fail ? `\n${fail}건 실패` : '\n모두 통과');
process.exit(fail ? 1 : 0);
