// 프로젝트 저장/불러오기 + 자동 저장
//  - 프로젝트 = 로봇/그리퍼/카메라/설정 + 제조사별 프로그램 파일·변수 + 셀 레이아웃 (JSON 1개)
//  - 저장 위치: <프로젝트 루트>/projects/<이름>.json
//  - 자동 저장: 변경 후 2초 뒤 projects/_autosave.json → 서버 재시작 시 복원
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 1;
const SAFE = /^[\w가-힣\-. ()]{1,80}$/;

export class ProjectStore {
  constructor(ctrl, dir) {
    this.ctrl = ctrl;
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this._timer = null;
    this._lastSig = '';
    this.current = null; // 마지막으로 저장/불러온 프로젝트 이름
  }

  // ---------------------------------------------------------------- 직렬화
  serialize(name) {
    const c = this.ctrl;
    const vendors = { ...(c.vendorStore || {}) };
    vendors[c.vendor] = { files: Object.fromEntries(c.files), main: c.main, regs: [...c.regs], ioNames: c.ioNames, exampleSig: c._exampleSig };
    return {
      format: 'robot-emulator-project', version: VERSION, name: name ?? this.current ?? 'untitled', savedAt: new Date().toISOString(),
      robotId: c.robot.id,
      gripper: c.gripper.custom ? { custom: { ...c.gripper } } : { id: c.gripper.id },
      gripperIO: { ...c.gripperIO },
      settings: { override: c.override, mode: c.mode, blendEnabled: c.blendEnabled, collisionMode: c.collisionMode, autoResetScene: c.autoResetScene },
      breakpoints: [...(c.breakpoints || [])],
      vendors,
      cell: c.cell?.getLayout ? c.cell.getLayout() : null,
      cameras: c.cameras.map((x) => ({ ...x })),
    };
  }

  apply(p) {
    if (p?.format !== 'robot-emulator-project') throw new Error('프로젝트 파일 형식이 아닙니다');
    const c = this.ctrl;
    c.stopProgram();
    // 다른 제조사 저장분을 먼저 넣고, 대상 로봇의 제조사는 setRobot 이 복원
    c.vendorStore = {};
    for (const [v, s] of Object.entries(p.vendors || {})) c.vendorStore[v] = s;
    const target = p.robotId;
    // setRobot 은 제조사가 바뀔 때만 vendorStore 에서 복원하므로, 같은 제조사면 직접 적용
    const sameVendor = c.robot && target.split('-')[0] === c.vendor;
    if (p.gripper?.custom) c.setCustomGripper(p.gripper.custom); else c.setGripper(p.gripper?.id ?? 'robotiq-2f85');
    c.setRobot(target);
    // setRobot 이 현재(이전) 제조사 파일을 보관함에 넣으므로, 보관함은 프로젝트 내용으로 다시 맞춤
    c.vendorStore = { ...(p.vendors || {}) };
    delete c.vendorStore[c.vendor];
    if (sameVendor) {
      const s = p.vendors?.[c.vendor];
      if (s) {
        c.regs = new Map(s.regs ?? []);
        c.ioNames = s.ioNames ?? { do: {}, di: {} };
        c._exampleSig = s.exampleSig;
        c.main = s.main;
        c.loadFiles(s.files || {}, true);
      }
    }
    Object.assign(c.gripperIO, p.gripperIO || {});
    const st = p.settings || {};
    if (st.override) c.setOverride(st.override);
    if (st.mode) c.setMode(st.mode);
    if (st.blendEnabled !== undefined) c.blendEnabled = !!st.blendEnabled;
    if (st.collisionMode) c.setCollisionMode?.(st.collisionMode);
    if (st.autoResetScene !== undefined) c.autoResetScene = !!st.autoResetScene;
    c.breakpoints = new Set(p.breakpoints || []);
    if (p.cell && c.cell?.setLayout) c.cell.setLayout(p.cell);
    c.setCameras(p.cameras || []);
    this.current = p.name ?? null;
    c.log('system', `프로젝트 불러옴: ${p.name ?? '(이름 없음)'}`);
    c.emitState();
  }

  // ---------------------------------------------------------------- 파일
  fileOf(name) {
    if (!SAFE.test(name) || name.startsWith('_')) throw new Error(`사용할 수 없는 프로젝트 이름: ${name}`);
    return path.join(this.dir, `${name}.json`);
  }

  list() {
    return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')).map((f) => {
      const full = path.join(this.dir, f);
      let meta = {};
      try { const p = JSON.parse(fs.readFileSync(full, 'utf8')); meta = { robotId: p.robotId, savedAt: p.savedAt }; } catch { /* 손상 파일 */ }
      return { name: f.slice(0, -5), ...meta };
    }).sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  }

  save(name) {
    const p = this.serialize(name);
    fs.writeFileSync(this.fileOf(name), JSON.stringify(p, null, 1));
    this.current = name;
    this.ctrl.log('system', `프로젝트 저장: ${name}`);
    return p;
  }

  load(name) { this.apply(JSON.parse(fs.readFileSync(this.fileOf(name), 'utf8'))); }
  remove(name) { fs.unlinkSync(this.fileOf(name)); this.ctrl.log('system', `프로젝트 삭제: ${name}`); }

  // ---------------------------------------------------------------- 자동 저장
  // 변경이 있을 때만 _autosave.json 기록 (종료 처리에서도 호출)
  saveAutosave() {
    try {
      const p = this.serialize();
      const sig = JSON.stringify({ ...p, savedAt: 0 });
      if (sig !== this._lastSig) { this._lastSig = sig; fs.writeFileSync(path.join(this.dir, '_autosave.json'), JSON.stringify(p)); }
    } catch (e) { /* 자동 저장 실패는 무시 (다음 주기에 재시도) */ }
  }

  startAutosave() {
    this._timer = setInterval(() => this.saveAutosave(), 2000);
    return () => clearInterval(this._timer);
  }

  restoreAutosave() {
    const f = path.join(this.dir, '_autosave.json');
    if (!fs.existsSync(f)) return false;
    try {
      const p = JSON.parse(fs.readFileSync(f, 'utf8'));
      this.apply(p);
      this._lastSig = JSON.stringify({ ...this.serialize(), savedAt: 0 });
      this.ctrl.log('system', '이전 세션 복원 (자동 저장)');
      return true;
    } catch (e) {
      this.ctrl.log('alarm', `자동 저장 복원 실패: ${e.message}`);
      return false;
    }
  }
}
