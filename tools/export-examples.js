// 각 제조사 대표 모델용 예제 프로그램을 examples/<vendor>/<model>/ 로 내보낸다
import fs from 'node:fs';
import path from 'node:path';
import { Controller } from '../server/controller.js';

const ctrl = new Controller();
for (const id of ['yaskawa-gp7', 'kawasaki-rs007n', 'hyundai-hh7', 'abb-irb1200', 'kuka-kr6-r900']) {
  ctrl.setRobot(id);
  const dir = path.join('examples', ctrl.vendor, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(ctrl.lang.defaultFiles(ctrl))) fs.writeFileSync(path.join(dir, name), text.replace(/\n/g, '\r\n'));
  console.log(dir, Object.keys(ctrl.lang.defaultFiles(ctrl)).join(', '));
}
process.exit(0);
