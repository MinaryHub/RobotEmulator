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
  // bundle=true: 셀 레이아웃이 참조하는 3D 모델 파일을 assets 에 base64 로 함께 넣는다 (다른 PC 로 옮길 때)
  serialize(name, { bundle = false } = {}) {
    const p = this._serialize(name);
    if (bundle) {
      const assets = {}, missing = [];
      for (const m of p.cell?.models || []) {
        if (assets[m.asset] || missing.includes(m.asset)) continue;
        const rec = this.ctrl.assets?.pack(m.asset);
        if (rec) assets[m.asset] = rec; else missing.push(m.asset);
      }
      if (Object.keys(assets).length) p.assets = assets;
      if (missing.length) this.ctrl.log('alarm', `내보내기: 서버에 파일이 없는 3D 모델 ${missing.length}개는 묶지 못했습니다 (${missing.join(', ')})`);
    }
    return p;
  }

  _serialize(name) {
    const c = this.ctrl;
    const vendors = { ...(c.vendorStore || {}) };
    vendors[c.vendor] = { files: Object.fromEntries(c.files), main: c.main, regs: [...c.regs], ioNames: c.ioNames, exampleSig: c._exampleSig };
    return {
      format: 'robot-emulator-project', version: VERSION, name: name ?? this.current ?? 'untitled', savedAt: new Date().toISOString(),
      robotId: c.robot.id,
      gripper: c.gripper.custom ? { custom: { ...c.gripper } } : { id: c.gripper.id },
      gripperIO: { ...c.gripperIO },
      settings: { override: c.override, timeScale: c.timeScale, interlock: c.interlock, requireEnable: c.safety.requireEnable, fenceStop: c.safety.fenceStop, mode: c.mode, blendEnabled: c.blendEnabled, collisionMode: c.collisionMode, autoResetScene: c.autoResetScene },
      breakpoints: [...(c.breakpoints || [])],
      sysio: c.sysio.serialize(),
      ioLabels: c.ioLabels,
      vendors,
      cell: c.cell?.getLayout ? c.cell.getLayout() : null,
      cameras: c.cameras.map((x) => ({ ...x })),
    };
  }

  apply(p) {
    if (p?.format !== 'robot-emulator-project') throw new Error('프로젝트 파일 형식이 아닙니다');
    const c = this.ctrl;
    // 묶인 3D 모델을 먼저 저장 (레이아웃 적용 시 간섭 메시를 바로 읽도록). 손상된 모델이 있으면 프로젝트는 적용하지 않음
    const bundled = Object.entries(p.assets || {}), fresh = [];
    if (bundled.length) {
      if (!c.assets) throw new Error('이 서버는 3D 모델 저장소가 없어 묶인 모델을 가져올 수 없습니다');
      for (const [id, rec] of bundled) { if (!c.assets.has(id)) { c.assets.unpack(id, rec); fresh.push(id); } c.cell?._missing?.delete(id); }
      c.log('system', `프로젝트에 묶인 3D 모델 ${bundled.length}개 확인`);
    }
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
    if (st.timeScale) c.setTimeScale(st.timeScale);
    if (st.interlock !== undefined || st.requireEnable !== undefined || st.fenceStop) c.setSafetyOptions({ interlock: st.interlock, requireEnable: st.requireEnable, fenceStop: st.fenceStop });
    c.setIoLabels(p.ioLabels || {});
    c.sysio.configure(p.sysio ? { ...p.sysio } : { enabled: false });
    if (st.mode) c.setMode(st.mode);
    if (st.blendEnabled !== undefined) c.blendEnabled = !!st.blendEnabled;
    if (st.collisionMode) c.setCollisionMode?.(st.collisionMode);
    if (st.autoResetScene !== undefined) c.autoResetScene = !!st.autoResetScene;
    c.breakpoints = new Set(p.breakpoints || []);
    if (p.cell && c.cell?.setLayout) c.cell.setLayout(p.cell);
    for (const id of fresh) c.cell?.refreshModels?.(id);   // 레이아웃이 같아도 새로 생긴 모델 파일을 화면·간섭에 반영
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
  // 변경이 있을 때만 _autosave.json 기록 (종료 처리에서는 동기 호출, 주기 저장은 비동기 원자적 기록)
  saveAutosave({ async: isAsync = false } = {}) {
    if (isAsync && this._autosaving) return;
    try {
      const p = this.serialize();
      const savedAt = p.savedAt;
      p.savedAt = 0;
      const sig = JSON.stringify(p);
      if (sig === this._lastSig) return;
      this._lastSig = sig;
      p.savedAt = savedAt;
      const data = JSON.stringify(p);
      const target = path.join(this.dir, '_autosave.json');
      if (isAsync) {
        this._autosaving = true;
        const tmp = target + '.tmp';
        fs.promises.writeFile(tmp, data)
          .then(() => fs.promises.rename(tmp, target))
          .catch(() => {})
          .finally(() => { this._autosaving = false; });
      } else {
        fs.writeFileSync(target, data);
      }
    } catch (e) { /* 자동 저장 실패는 무시 (다음 주기에 재시도) */ }
  }

  startAutosave() {
    this._timer = setInterval(() => this.saveAutosave({ async: true }), 2000);
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
