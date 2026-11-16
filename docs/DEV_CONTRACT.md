# 내부 개발 계약 (언어 모듈 / 통신 모듈)

프로젝트: Node.js 20+(ESM, 의존성 `ws`, `three`, `node-opcua`, `@anthropic-ai/sdk`, `occt-import-js`(브라우저 전용 WASM). 모두 순수 JS/WASM, OS 무관) 기반 다제조사 산업용 로봇 에뮬레이터.
사용자 3D 모델: 서버는 CAD 형식을 해석하지 않는다 — 브라우저가 GLB(표시) + `.col`(간섭 메시, `shared/meshcol.js`)로 변환해 `POST /api/assets` 로 올린다 (`server/assets.js`).
단위: 위치 mm, 각도 deg. 좌표계: 로봇 베이스 원점, Z 위쪽. 플랜지/툴 Z축 = 툴 진행 방향.

## 핵심 파일 (반드시 먼저 읽을 것)
- `shared/math.js`, `shared/kinematics.js`, `shared/robots.js`, `shared/poseformat.js`, `shared/grippers.js`
- `server/controller.js` — 가상 컨트롤러 (모든 조작은 여기로)
- `server/vm.js` — 공용 VM. Program/Instr 형식이 주석에 정의됨
- `server/lang/expr.js` — 공용 토크나이저/Pratt 파서/평가기 (`Parser`, `evaluate`, `binop`, `truthy`)
- `server/lang/common.js` — `CompileError`, `at()`, `RuntimeErr`, `poseTarget`, `jointTarget`, `splitTop`, `stripComment`

## 언어 모듈 계약 (`server/lang/<id>.js`, default export)
```js
export default {
  id: 'krl', name: 'KUKA KRL', exts: ['.src', '.dat'],
  compile(files /* Map<filename,text> */, main /* filename */, ctrl) → Program,  // 오류 시 CompileError(msg, file, line)
  pickMain(names, files) → filename | null,
  defaultFiles(ctrl) → { filename: text },    // 현재 ctrl.robot 에서 실제로 도달 가능한 예제 프로그램
  readVar(ctrl, name) → value | undefined,     // 통신 인터페이스용 변수 읽기
  writeVar(ctrl, name, value) → boolean,
}
```
- Instr.run(vm, frame) 안에서 사용하는 런타임 API:
  - `await vm.move({kind:'J'|'L'|'C', target, via?, speed, tool?, base?})`
    - target: `{joints:[6 deg]}` 또는 `{pose:{p:[x,y,z],R:3x3}, cfgFilter?(sol)→penalty}` (TCP pose, base 좌표계)
    - `poseTarget(vendor, arr)` 로 제조사 표현 배열 → target 변환 (`shared/poseformat.js` 관례)
    - speed: 관절이동 `{frac:0~1}`, 직선/원호 `{tcp: mm/s, rot?: deg/s}`
    - tool: pose `{p,R}` (생략 시 선택된 그리퍼 TCP), base: pose 또는 null
  - `await vm.wait(sec)`, `await vm.waitUntil(()=>bool, timeoutSec)` (false=타임아웃)
  - `vm.ctrl.setDO(n,bool)`, `vm.ctrl.getDO(n)`, `vm.ctrl.getDI(n)`, `vm.ctrl.signalNo('do'|'di', name)`
  - `vm.print(msg)`, `vm.ctrl.joints`(현재 관절각), `vm.ctrl.tcpPose()`(현재 TCP pose), `vm.ctrl.vendorPose()`
  - `vm.ctrl.toolOverride = pose|null`, `vm.ctrl.base = pose|null` (프로그램에서 툴/좌표계 변경 시)
  - 변수: `vm.getVar/setVar(name, value, frame)`, `vm.globals`(Map), `frame.locals`(Map), `vm.ctrl.regs`(Map, 컨트롤러 전역 레지스터)
- 제어 흐름: `return {goto: pc}`, `{call:{proc, args, onReturn(value)}}`, `{ret: value}`, `{halt:true}`; undefined → 다음 명령.
- 구조적 언어(IF/WHILE/FOR)는 컴파일 시 평탄화해 goto 로 변환.
- `line` 은 1부터 시작하는 원본 파일 라인 번호, `file` 은 파일명. UI 가 현재 실행 라인을 하이라이트한다.
- 기본 IO 규약: DO1 ON = 그리퍼 닫기/흡착, DO2 ON = 그리퍼 열기, DI1 = 닫힘 확인, DI2 = 열림 확인, DI3 = 공작물 감지.
- 예제(defaultFiles)는 `ctrl.objects`(공작물 W1~W4, `pose.p`, `size`)를 집어 다른 위치에 내려놓는 pick & place.
  툴 자세는 아래 방향(`R = [[-1,0,0],[0,1,0],[0,0,-1]]`). 생성 시 `ikNearest(ctrl.robot, tcpToFlange(pose, ctrl.tool, null), ctrl.robot.home)` 로 도달 가능성 검증.
  관절 이동 HOME 위치는 `ctrl.robot.home`.

## 속도 매핑
- INFORM: `MOVJ VJ=50.00` → frac 0.5, `MOVL V=200` → tcp 200 mm/s (`VR=` 자세 deg/s)
- AS: `SPEED n` (%; 관절=frac, 직선=n% × robot.tcpMaxSpeed), `SPEED n MM/S`, `ALWAYS` 옵션
- HRScript: `MOVE P,S=60%` → frac 0.6, `MOVE L,S=500mm/sec` → tcp 500
- RAPID: speeddata `v100` → tcp 100, rot 500 ; MoveJ frac = min(1, v/1500); `vmax`=tcpMaxSpeed
- KRL: `PTP P1 Vel=100 % PDAT1` 또는 `$VEL_AXIS[i]`/`BAS(#VEL_PTP,n)` → frac ; `LIN P2 Vel=2 m/s CPDAT1` 또는 `$VEL.CP=2.0` (m/s) → tcp

## 통신 모듈 계약 (`server/protocols/<name>.js`)
```js
export function start(ctrl, opts) → Promise<{ name, proto, port, close() }>
```
- 로그는 `ctrl.log('comm', '[YASKAWA-HSE] ...')` 형식.
- 포트 바인딩 실패 시 예외 대신 `ctrl.log` 로 알리고 `port: null` 반환.

## 플랫폼 무관 규칙 (Windows · macOS · Linux)
- 파일 경로는 `path.join` / `path.resolve` 로 만들고, 기준 경로는 `import.meta.url` 에서 구한다 (현재 작업 디렉터리에 의존하지 않음).
- 셸 명령·OS 전용 도구(`rm`, `cp`, PowerShell 등)를 호출하지 않는다. 네이티브 빌드가 필요한 패키지는 추가하지 않는다.
- 텍스트 입력은 CRLF / LF / CR 모두 허용한다 (`text.replace(/\r\n?/g, '\n')`).
- 1024 미만 포트는 Linux/macOS 에서 권한이 필요하므로 `fallbackPort` 를 둔다. 바인딩 주소는 `opts.host` 를 따른다.
- 테스트는 `test/<이름>.test.js`, 종료 코드 0/1. 병렬 실행되므로 다른 테스트와 겹치지 않는 고정 포트(또는 0)를 쓴다.
