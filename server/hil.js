// Headless HIL (Hardware-in-the-Loop / CI) 시나리오 러너 · CLI 인자 파서 · JUnit XML 리포터
//  사용 예:
//    node server/index.js --scenario scenarios/pick_test.json --junit report.xml
//  시나리오 JSON 형식:
//    { name, cases: [{ name, robot, gripper, mode, servo, collisionMode, files, main, di, ai, regs, run, timeoutSec, expect }] }
import fs from 'node:fs';
import path from 'node:path';
import { Controller } from './controller.js';
import { importBackup } from './backup.js';

export function parseCliArgs(argv = []) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`옵션 값이 필요합니다: ${a}`);
      return argv[++i];
    };
    switch (a) {
      case '--port': out.port = Number(next()); break;
      case '--host': out.host = next(); break;
      case '--config': out.config = next(); break;
      case '--data-dir': out.dataDir = next(); break;
      case '--scenario': out.scenario = next(); break;
      case '--junit': out.junit = next(); break;
      case '--token': out.token = next(); break;
      case '--readonly-token': out.readOnlyToken = next(); break;
      case '--headless': out.headless = true; break;
      case '--no-update': out.noUpdate = true; break;
      case '--no-ai': out.noAi = true; break;
      case '--no-autosave': out.noAutosave = true; break;
      case '--air-gapped': out.airGapped = true; break;
      default: break;
    }
  }
  return out;
}

const xmlEsc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function toJUnitXml(report) {
  const casesXml = report.cases.map((tc) => {
    const time = (tc.durationMs / 1000).toFixed(3);
    if (tc.ok) return `    <testcase name="${xmlEsc(tc.name)}" classname="${xmlEsc(report.name)}" time="${time}"/>`;
    const msg = tc.errors.join('; ');
    return `    <testcase name="${xmlEsc(tc.name)}" classname="${xmlEsc(report.name)}" time="${time}">\n      <failure message="${xmlEsc(msg)}">${xmlEsc(tc.errors.join('\n'))}</failure>\n    </testcase>`;
  }).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites tests="${report.total}" failures="${report.failed}" time="${(report.durationMs / 1000).toFixed(3)}">`,
    `  <testsuite name="${xmlEsc(report.name)}" tests="${report.total}" failures="${report.failed}" time="${(report.durationMs / 1000).toFixed(3)}">`,
    casesXml,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}

async function runCase(tc, baseDir) {
  const t0 = performance.now();
  const errors = [];
  const ctrl = new Controller();
  try {
    if (tc.robot) ctrl.setRobot(tc.robot);
    if (tc.gripper) ctrl.setGripper(tc.gripper);
    if (tc.collisionMode) ctrl.setCollisionMode(tc.collisionMode);
    if (tc.mode) ctrl.setMode(tc.mode);
    if (tc.override !== undefined) ctrl.setOverride(tc.override);
    if (tc.backupZip) {
      const zp = path.resolve(baseDir || process.cwd(), tc.backupZip);
      const imp = importBackup(fs.readFileSync(zp), { vendor: tc.vendor || null });
      ctrl.loadFiles(imp.files, true);
    } else if (tc.files && typeof tc.files === 'object') {
      ctrl.loadFiles(tc.files, true);
    }
    if (tc.main) ctrl.setMain(tc.main);
    if (tc.di) for (const [k, v] of Object.entries(tc.di)) ctrl.setDI(Number(k), !!v);
    if (tc.ai) for (const [k, v] of Object.entries(tc.ai)) ctrl.setAI(Number(k), Number(v));
    if (tc.regs) for (const [k, v] of Object.entries(tc.regs)) ctrl.regs.set(k, v);
    if (tc.servo !== false) ctrl.setServo(true);

    if (ctrl.compileError && tc.expect?.compileError !== true) {
      errors.push(`컴파일 오류: ${ctrl.compileError.msg} (${ctrl.compileError.file}:${ctrl.compileError.line})`);
    } else if (tc.run !== false) {
      const ok = await ctrl.start();
      if (!ok) errors.push(`프로그램 시작 실패 (${ctrl.lastReject?.reason || 'unknown'})`);
      else {
        const timeoutSec = Number(tc.timeoutSec) > 0 ? Number(tc.timeoutSec) : 30;
        const dt = 0.02;
        const maxSteps = Math.ceil(timeoutSec / dt);
        for (let i = 0; i < maxSteps; i++) {
          ctrl._step(dt);
          await new Promise((r) => setImmediate(r));
          const st = ctrl.vm?.status;
          if (st === 'done' || st === 'error' || st === 'aborted') break;
        }
      }
    }

    const exp = tc.expect || {};
    if (exp.status !== undefined && ctrl.vm?.status !== exp.status) {
      errors.push(`vm.status 기대=${exp.status}, 실제=${ctrl.vm?.status}`);
    }
    if (exp.alarms !== undefined && ctrl.alarms.length !== exp.alarms) {
      errors.push(`alarms 개수 기대=${exp.alarms}, 실제=${ctrl.alarms.length} (${ctrl.alarms.map((a) => a.code).join(',')})`);
    }
    if (exp.do) {
      for (const [k, v] of Object.entries(exp.do)) {
        const got = ctrl.getDO(Number(k));
        if (got !== !!v) errors.push(`DO${k} 기대=${!!v}, 실제=${got}`);
      }
    }
    if (exp.ao) {
      for (const [k, v] of Object.entries(exp.ao)) {
        const got = ctrl.getAO(Number(k));
        if (Math.abs(got - Number(v)) > (exp.tol ?? 0.05)) errors.push(`AO${k} 기대=${v}, 실제=${got}`);
      }
    }
    if (exp.regs) {
      for (const [k, v] of Object.entries(exp.regs)) {
        const got = ctrl.regs.get(k);
        if (typeof v === 'number' ? Math.abs(Number(got) - v) > (exp.tol ?? 1e-3) : got !== v) {
          errors.push(`reg[${k}] 기대=${v}, 실제=${got}`);
        }
      }
    }
    if (exp.maxCycleSec !== undefined) {
      const cyc = ctrl.cycleStats?.last?.total ?? (ctrl.simMs / 1000);
      if (cyc > exp.maxCycleSec) errors.push(`사이클 타임 초과: ${cyc.toFixed(3)}s > ${exp.maxCycleSec}s`);
    }
    if (exp.holding !== undefined) {
      const holding = !!ctrl.grip?.holding;
      if (holding !== !!exp.holding) errors.push(`holding 기대=${!!exp.holding}, 실제=${holding}`);
    }
    return {
      name: tc.name || 'unnamed',
      ok: errors.length === 0,
      durationMs: performance.now() - t0,
      errors,
      stats: { status: ctrl.vm?.status ?? 'idle', alarms: ctrl.alarms.length, simSec: +(ctrl.simMs / 1000).toFixed(3), cycleSec: ctrl.cycleStats?.last?.total ?? null },
    };
  } catch (e) {
    errors.push(`예외: ${e.message}`);
    return { name: tc.name || 'unnamed', ok: false, durationMs: performance.now() - t0, errors, stats: {} };
  } finally {
    ctrl.close();
  }
}

export async function runScenario(scenarioOrPath, { baseDir = null } = {}) {
  let sc = scenarioOrPath;
  let dir = baseDir;
  if (typeof scenarioOrPath === 'string') {
    const abs = path.resolve(scenarioOrPath);
    dir = dir || path.dirname(abs);
    sc = JSON.parse(fs.readFileSync(abs, 'utf8'));
  }
  const t0 = performance.now();
  const casesList = Array.isArray(sc.cases) ? sc.cases : [sc];
  const results = [];
  for (const tc of casesList) results.push(await runCase(tc, dir));
  const failed = results.filter((r) => !r.ok).length;
  return {
    ok: failed === 0,
    name: sc.name || 'HIL Scenario',
    total: results.length,
    passed: results.length - failed,
    failed,
    durationMs: performance.now() - t0,
    cases: results,
  };
}
