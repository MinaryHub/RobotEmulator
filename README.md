# 산업용 로봇 에뮬레이터

야스카와 · 카와사키 · 현대로보틱스 · ABB · KUKA · 두산로보틱스 · Universal Robots 로봇을 하나의 가상 컨트롤러로 에뮬레이션합니다.

- 각 제조사 로봇 언어로 작성한 프로그램을 그대로 실행하고, 3D로 동작을 확인할 수 있습니다.
- 각 제조사의 외부 통신 인터페이스를 지원하므로 PLC·PC 상위 프로그램을 실제 로봇 없이 개발하고 시험할 수 있습니다.

**문서**: [사용자 매뉴얼](docs/MANUAL.md) · [SI 현장 대상 개선 로드맵](docs/ROADMAP-SI.md) · [개발 규약](docs/DEV_CONTRACT.md)

## 실행

```bash
npm install
npm start          # http://localhost:3000
npm test           # 기구학 · 5개 언어 · 5개 통신 프로토콜 · 필드버스(Modbus/OPC UA) 테스트
```

- 필요 환경: Node.js 20 이상. **Windows · macOS · Linux 모두 같은 방법으로 설치·실행**합니다 (네이티브 빌드나 OS별 스크립트 없음).
- 외부 의존성: `three`(3D 뷰), `ws`(WebSocket), `node-opcua`(OPC UA 서버), `@anthropic-ai/sdk`(Claude 채팅), `occt-import-js`(STEP·IGES 변환, 브라우저에서 실행되는 WASM · LGPL-2.1 — 수정 없이 별도 파일로 사용). 모두 순수 JavaScript/WASM 패키지라 컴파일러가 필요 없습니다.
- 포트·바인딩 주소 지정:

| 방법 | 예 |
|---|---|
| macOS / Linux | `PORT=3100 HOST=127.0.0.1 npm start` |
| Windows PowerShell | `$env:PORT=3100; $env:HOST="127.0.0.1"; npm start` |
| Windows cmd | `set PORT=3100 && set HOST=127.0.0.1 && npm start` |
| 공통 | 루트의 `config.json` (아래 참고). 우선순위: 기본값 < `config.json` < 환경변수 |

- 테스트는 파일 단위로 병렬 실행합니다(기본: CPU 수, 최대 8). `TEST_JOBS=1` 이면 순차 실행, `node test/run-all.js krl` 처럼 이름으로 골라 실행할 수 있습니다.
- GitHub Actions 에서 Windows · macOS · Linux × Node 20 · 22 조합으로 테스트합니다 (`.github/workflows/test.yml`).

### OS 별 참고

- **1024 미만 포트 (Linux · macOS):** 일반 사용자 권한으로는 Kawasaki AS 23번, Modbus 502번에 바인딩할 수 없습니다. 이때는 자동으로 10023, 1502로 대체되고, 콘솔과 로그에 실제 포트가 표시됩니다. 원래 포트가 꼭 필요하면 관리자 권한으로 실행하거나, Linux에서는 `sudo setcap 'cap_net_bind_service=+ep' "$(command -v node)"` 를 사용하십시오.
- **Windows 방화벽:** 처음 실행할 때 Node.js 네트워크 접근 허용 창이 뜹니다. 다른 PC·PLC에서 접속하려면 허용하십시오. 이 PC에서만 쓸 때는 `HOST=127.0.0.1` 로 실행하면 방화벽 예외가 필요 없습니다.
- **종료:** Ctrl+C (Windows 는 Ctrl+Break 도 가능), 서비스·컨테이너에서는 SIGTERM. 종료할 때 자동 저장과 통신 포트를 정리합니다.

### 보안

웹 UI, `/api/cmd`, `/ws`, 각 통신 인터페이스에는 **인증이 없습니다** (실제 로봇 컨트롤러의 공장 내 통신을 흉내 내기 위함). 접속할 수 있는 사람은 누구나 로봇 이동, 프로그램·프로젝트 파일 변경을 할 수 있습니다.

- 기본값은 `"host": "127.0.0.1"` 로, **이 PC 에서만** 접속됩니다. 이 값은 웹 서버와 모든 통신 인터페이스에 함께 적용되며, 통신 인터페이스별로 `protocols.<키>.host` 로 따로 지정할 수도 있습니다.
- 다른 PC·PLC 에서 접속하려면 `"host": "0.0.0.0"` (또는 `HOST=0.0.0.0`)으로 여십시오. 신뢰할 수 있는 내부망에서만 사용하십시오.
- 사용자가 연 다른 웹사이트가 로봇을 조작하지 못하도록 `/api`, `/ws`, `/mcp` 는 다른 출처(Origin)의 브라우저 요청과 낯선 호스트 이름(DNS 리바인딩)을 거부합니다. `/api/cmd` 는 `Content-Type: application/json` 만 받습니다.
- 웹 UI 를 IP 가 아닌 호스트 이름(예: `robot-pc.local`)으로 열 때는 그 이름을 `"allowedHosts": ["robot-pc.local"]` 에 넣으십시오.

## 버전 관리와 업데이트

현재 버전은 머리글의 **ⓘ** 정보 창에서 확인합니다. 버전마다 바뀐 내용은 [CHANGELOG.md](CHANGELOG.md)에 있습니다.

### 자동 업데이트

서버는 시작할 때와 이후 24시간마다 GitHub 릴리스를 확인합니다. 새 버전이 있으면 머리글에 **⬆ vX.Y.Z** 버튼이 나타납니다.

- **업데이트 및 재시작:** git clone 으로 설치한 경우 이 버튼을 누르면 다음 순서로 진행합니다.
  1. 새 릴리스 태그를 내려받습니다 (`git fetch`).
  2. 현재 브랜치를 그 태그로 앞당깁니다 (fast-forward).
  3. 의존성이 바뀌었으면 `npm install` 을 실행합니다.
  4. 서버를 다시 시작합니다. 작업 내용은 자동 저장되었다가 재시작 후 복원되고, 화면은 자동으로 새로고침됩니다.
- **업데이트할 수 없는 경우:** 버튼을 누르면 그 이유를 알려 줍니다. 진행 중에 실패하면 이전 커밋으로 되돌립니다.
  - 프로그램을 실행 중일 때
  - 커밋하지 않은 소스 변경이 있을 때
  - 로컬 커밋 때문에 fast-forward 가 안 될 때
- **압축 파일(ZIP)로 설치한 경우:** 알림과 릴리스 페이지 링크만 표시됩니다. 새 버전을 직접 내려받으십시오.
- **재시작 조건:** 자동 재시작은 `npm start` 로 실행했을 때만 됩니다. `npm start` 는 실행기(`server/launcher.js`)를 거쳐 서버를 띄웁니다. 서버만 직접 실행하려면 `npm run serve` 를 쓰고, 이때 업데이트 후에는 직접 다시 실행하십시오.
- **설정 (`config.json` 의 `update`):**

| 키 | 기본값 | 설명 |
|---|---|---|
| `enabled` | `true` | 새 버전 자동 확인 (끄면 정보 창의 **지금 확인**으로만 확인) |
| `intervalHours` | `24` | 확인 주기 |
| `allowApply` | `true` | `false` 면 화면에서 업데이트 적용 불가 (알림만) |
| `repo` | `package.json` 의 저장소 | 릴리스를 확인할 GitHub 저장소 `owner/name` |
| `sponsorUrl` | `package.json` 의 `funding` | 후원 링크 (빈 문자열이면 후원 버튼 숨김) |

- **비공개 저장소:** `GITHUB_TOKEN` 환경변수에 읽기 권한 토큰을 넣으면 새 버전을 확인할 수 있습니다.
- **보내는 정보:** 확인 요청에는 사용자 정보를 보내지 않습니다.

### 릴리스 만들기 (관리자)

1. **버전 올리기:** 기능 브랜치에서 `package.json` 의 `version` 을 올리고, `CHANGELOG.md` 에 `## [X.Y.Z] - 날짜` 절을 씁니다. 그다음 PR 로 머지합니다.
2. **릴리스 만들기:** `main` 에서 `git pull` 을 한 뒤 `npm run release` 로 확인합니다. 문제가 없으면 `npm run release -- --yes` 로 태그 `vX.Y.Z` 와 GitHub 릴리스를 만듭니다. 릴리스 노트는 CHANGELOG 의 해당 절에서 가져옵니다.

## 문의 · 후원

- **문의하기:** 정보 창의 **🐞 버그 신고**·**💡 기능 제안**을 누르면 GitHub 이슈가 열립니다. 버전·OS·로봇 모델이 미리 채워지며, GitHub 계정이 필요합니다. [이슈 목록](https://github.com/knoxxr/RobotEmulator/issues)에서 직접 열 수도 있습니다.
- **후원하기:** 이 프로젝트가 도움이 되었다면 [GitHub Sponsors](https://github.com/sponsors/knoxxr)로 개발을 응원해 주세요.

## 주요 기능

| 영역 | 내용 |
|---|---|
| 로봇 모델 | 7개 제조사 93종 — Yaskawa 21 (GP4~GP250, AR 아크용, 협동 HC20DTP), Kawasaki 14 (RS003N~RS080N, RS015X), Hyundai 15 (HDF·HH·HDR 시리즈 4~300 kg), ABB 9 (IRB 120~IRB 7600), KUKA 18 (AGILUS·CYBERTECH·IONTEC·QUANTEC 3~240 kg), Doosan 8 (협동로봇 M0609·M0617·M1013·M1509·H2017·H2515·A0509·A0912), Universal Robots 8 (UR3e·UR5e·UR7e·UR10e·UR12e·UR16e·UR20·UR30). 데이터시트·치수도·ROS-I/RoboDK 교차 확인 (모델별 출처는 `shared/robots.js`의 `source`) |
| 기구학 | OPW 해석적 역기구학(최대 8해), UR 은 손목 축이 한 점에서 만나지 않는 구조라 표준 DH 해석해(최대 8해)를 따로 사용. 제조사별 관절 부호·영점, 자세 표현 관례(Rx·Ry·Rz / O·A·T / 쿼터니언 / A·B·C / 두산 ZYZ A·B·C / UR 회전 벡터) 반영 |
| 모션 | 관절보간, 직선보간, 원호보간. 사다리꼴 가감속, 관절 최고속도 제한(특이점 부근 자동 감속), 오버라이드, HOLD, 소프트리밋·도달불가·특이점 알람 |
| 블렌딩 | 경유점 근사: INFORM `PL`, AS `ACCURACY`(+`BREAK`), HRScript `A=`, RAPID zonedata(`z10`…, `\Z`, `fine`), KRL `C_PTP/C_DIS`·인라인 `CONT`, DRL `radius=`(mm), URScript `r=`(m). UI에서 ON/OFF 비교 가능 |
| 배속 | 실행 버튼 옆 ×0.1 ~ ×10 (단축키 `-` / `+`). 모션·대기·타이머·펄스·주변기기 모두 시뮬레이션 시계로 동작하므로 배속을 바꿔도 궤적·블렌딩·사이클 타임은 1배속과 같음. 조그는 항상 실시간. REST/WS 명령 `{"cmd":"timeScale","value":4}` |
| 사이클 타임 | 시뮬레이션 시계 기준(HOLD 제외, PC 부하와 무관) 총 시간과 모션/대기/기타 구분, 라인별 상위 시간, 최근 이력. 시작할 때마다 공작물 자동 초기화(옵션) |
| 간섭 체크 | 로봇 링크·그리퍼를 캡슐로 근사해 테이블·바닥·받침대·공작물과 자기 간섭을 매 틱 검사. 모드: OFF / 경고 / 정지(알람). 3D 하이라이트와 간섭 모델 표시 |
| 3D 모델 가져오기 | 장비·지그·펜스 CAD(STEP·IGES·STL·OBJ·GLB)를 셀에 배치. 삼각형 단위 정밀 간섭(BVH), 모델 윗면에 공작물 안착, 위치·회전·배율·단위·위쪽 축·투명도 편집. 프로젝트에 저장 ([매뉴얼 10.1](docs/MANUAL.md#101-3d-모델-가져오기-실제-장비-배치)) |
| 프로그램 | 웹 에디터(구문 강조, 실행 라인 표시, 컴파일 오류 위치 표시). 시작·단계 실행·홀드·정지·리셋 (Space: 시작·홀드·재개), 현재 위치 티칭 삽입, 파일 열기·다운로드 |
| 그리퍼 | 15종 형상 라이브러리(아래 표)와 STL 사용자 그리퍼. DO로 개폐하고 DI로 닫힘·열림·감지를 피드백. 공작물 파지·이송·낙하 시뮬레이션 |
| 직접교시 | 3D 화면에서 TCP 핸들을 끌어 이동·회전(BASE/TOOL, 스냅), 링크를 끌어 관절 회전, 되돌리기, 그리퍼 토글, `Enter` 로 위치 기록. 도달 불가·특이점·간섭(정지 모드)은 거부하고 사유 표시 (`T` 키) |
| 조작 | 축 조그, 직교 조그(BASE/TOOL), 서보 ON/OFF, 모드 전환, I/O 강제 출력과 입력 시뮬레이션, I/O 이름표(CSV 가져오기·내보내기), 작업 영역(손목 중심 도달 범위) 3D 표시 |
| 모드 인터록 · 안전 | 외부(PLC·PC) 명령은 REMOTE 에서만, REMOTE 에서는 화면 시작 불가, 모드는 화면에서만 변경. 비상정지(정지 범주 0), 안전 펜스(범주 1/2), 인에이블 스위치. 거부 사유 코드를 Modbus·OPC UA·각 프로토콜 오류로 응답 |
| 시스템 I/O | 제조사별 전용 입출력 프리셋(범용, Yaskawa, KUKA Automatic External, ABB System I/O, Kawasaki, Hyundai, Doosan, UR): 외부 서보 ON·시작·홀드·정지·리셋, 프로그램 번호(8비트+스트로브+패리티), 운전 중·알람·홈·사이클 완료 출력 |
| 디버깅 | 에디터 라인 번호 클릭 → 브레이크포인트, 변수 감시(로컬·전역·레지스터, 변경 강조), 신호 타임라인(DO/DI·RUN·MOVING·HOLD·GRIP·ALARM 파형, 두 점 클릭으로 Δt 측정) |
| 프로젝트 | 로봇·그리퍼·설정·제조사별 프로그램/변수·셀 레이아웃을 `projects/<이름>.json` 으로 저장/불러오기, JSON 내보내기·가져오기. 2초마다 자동 저장 → 서버 재시작 시 직전 세션 복원 (`config.json` 의 `"restoreSession": false` 로 끔). 제조사를 바꿨다 돌아와도 이전 프로그램 유지 |
| 비전 카메라 | 카메라 탭에서 7종(2D 머신비전·스마트 카메라·RealSense D435·Zivid 2+ M70·ToF·셀 모니터링)을 플랜지·전완(J3)·고정 위치에 장착. 3D 뷰 우하단에 카메라 시점을 실시간 렌더링(컬러/흑백/깊이 컬러맵), 시야 프러스텀 표시, 카메라 해상도 PNG 저장. 프로젝트에 저장 (`shared/cameras.js`, `public/js/cameraView.js`) |
| Claude 연동 | 오른쪽 ✦ Claude 채팅으로 현재 로봇·셀에 맞는 프로그램 생성·수정·컴파일·가상 실행 검증, 대화로 서보·이동·그리퍼·I/O 직접 조작. 같은 기능을 MCP 서버(`/mcp`)로 제공 → Claude Code·Claude Desktop 에서 사용 (아래 참고) |
| 셀 레이아웃 | 셀 탭에서 테이블·장애물·공작물과 주변기기(컨베이어, 피더, 센서, 공압 실린더, 배출구, 팔레트) 배치·편집, 프리셋 6종(기본 / 컨베이어 픽 앤 플레이스 / 머신 텐딩(CNC) / 2테이블 이송 / 출하 컨베이어 / 안전펜스 셀), JSON 내보내기·가져오기. 장치는 로봇 DI/DO(기본 DO9 컨베이어 운전, DI9 도착 센서)로 연동되어 Modbus·OPC UA 에서도 보임. 장애물·컨베이어 프레임은 간섭 체크 대상 (`server/cell.js`, 예제 `examples/conveyor/`) |

## 지원 로봇 언어

로봇을 선택하면 현재 셀 배치에 맞춘 pick & place 예제가 자동으로 생성됩니다. 같은 예제가 [examples/](examples/)에도 있습니다.

| 제조사 | 언어 | 파일 | 주요 지원 범위 |
|---|---|---|---|
| Yaskawa | INFORM | `.JBI` | MOVJ/L/C/S, IMOV, DOUT, WAIT, JUMP/CALL, B·I·D·R·P 변수, PULSE·RECTAN 위치 |
| Kawasaki | AS | `.as` / `.pg` | JMOVE/LMOVE, APPRO/DEPART, C1/C2MOVE, SIGNAL/SWAIT, IF·WHILE·FOR·CASE, 변환 연산, `.TRANS` / `.JOINTS` |
| Hyundai | HRScript | `.job` | MOVE P/L/C, DO/DI, WAIT, IF·FOR·WHILE, CALL, V 변수, 포즈 연산 |
| ABB | RAPID | `.mod` | MoveJ/L/C/AbsJ, Offs/RelTool, SetDO/WaitDI, PROC/FUNC, TEST, 레코드·배열, confdata |
| KUKA | KRL | `.src` + `.dat` | PTP/LIN/CIRC, 인라인 폼(PDAT/LDAT), `:` 연산자, S/T, $OUT/$IN, SWITCH·LOOP·REPEAT |
| Doosan | DRL (파이썬 문법) | `.drl` / `.py` | movej/movel/movec/movejx/movesx, posj·posx·trans·fkin·ikin, set_digital_output·wait_digital_input, def·if·while·for, 리스트·f 문자열, sub_program_run, TCP 소켓(server/client_socket_*) |
| Universal Robots | URScript | `.script` | movej/movel/movep/movec(m·rad, a·v·t·r), p[…] 자세·pose_trans·pose_add·get_inverse_kin·get_forward_kin, set_tcp, 표준·구성·툴 디지털 I/O, def·if·elif·while … end, global/local, textmsg·popup, socket_* |

언어별 상세 지원 문법은 각 모듈 파일(`server/lang/*.js`) 상단 주석에 있습니다.

## Claude 연동 (채팅 · MCP)

같은 도구 11개를 웹 UI 채팅과 MCP 서버가 공유합니다 (`server/ai/tools.js`).

| 도구 | 기능 |
|---|---|
| `get_context` | 로봇·언어·그리퍼 I/O·현재 자세·셀 배치(공작물·테이블·주변기기 좌표)·카메라·프로그램 상태 |
| `get_language_guide` | 해당 제조사 언어의 지원 문법 요약 + 현재 셀에 맞춰 생성한 동작하는 예제 |
| `read_program` / `write_program` | 가상 컨트롤러 파일 읽기 / 저장·컴파일 (에디터에 즉시 반영, 컴파일 오류 반환) |
| `run_program` | start·step·stop·reset·reset_alarms·status — 실행 후 사이클 타임·알람·간섭·공작물 위치·로그 반환 (가상 로봇만 움직임) |
| `get_logs` | 컨트롤러 로그 |
| `set_servo` | 서보 ON/OFF (옵션: 알람 리셋 후 ON) |
| `move_robot` | 가상 로봇 직접 이동: 홈 / 관절각 / 관절 상대값 / TCP 절대 위치(제조사 표기) / TCP 상대 이동(BASE·TOOL), 관절·직선 보간, 속도 %. 도착까지 기다린 뒤 관절각·TCP·알람·간섭 반환 |
| `gripper` | 그리퍼 열기·닫기 (그리퍼 DO 구동 → 피드백 DI·공작물 파지 반영) |
| `set_io` | DO 출력, DI 입력 시뮬레이션 |
| `stop_robot` | hold · resume · stop(이동 취소 + 프로그램 정지) · status |

Claude 가 로봇을 움직이는 명령(서보 ON, `move_robot`, `run_program` 의 start·step, `stop_robot` 의 resume, `gripper`, `set_io`)은 PLC·상위 PC 와 같은 **외부 명령**으로 처리하므로 **운전 모드가 REMOTE 일 때만** 허용됩니다 (모드는 화면에서만 바꿀 수 있음, 모드 인터록을 끄면 제한 없음). 비상정지·안전 펜스는 항상 적용되고, 프로그램 실행 중에는 직접 이동을 거부합니다. 프로그램 작성·컴파일, 상태·I/O 조회, 정지·HOLD, 서보 OFF 는 모드와 관계없이 쓸 수 있습니다. 채팅 예: "서보 켜고 Z 로 50mm 올려", "W1 위로 가서 그리퍼 닫아".

**웹 UI 채팅** (헤더의 ✦ Claude): 두 가지 방식 중 하나로 Claude 에 연결합니다. 기본값(`"backend": "auto"`)은 API 키 환경변수가 있으면 Claude API, 없으면 Claude Code 를 사용합니다.

| 백엔드 | 인증 | 설정 |
|---|---|---|
| Claude Code (`claude-code`) | 이 PC 에 설치된 Claude Code 의 로그인(Claude Pro·Max 등 구독 계정). **API 키 불필요** | Claude Code 설치 → 터미널에서 `claude` 실행해 로그인 → `npm start` |
| Claude API (`api`) | `ANTHROPIC_API_KEY` 또는 `ant auth login` | 아래 표 |

강제로 고르려면 `config.json` 의 `"ai": { "backend": "claude-code" }` 또는 환경변수 `AI_BACKEND=claude-code` / `AI_BACKEND=api`. Claude Code 방식은 요청마다 `claude -p` 를 실행하고 이 서버의 `/mcp` 도구만 쓰게 합니다(파일·셸 도구 없음). 모델은 `"cliModel"`(생략 시 Claude Code 기본 모델), 노력 수준은 `"effort"` 를 따릅니다.

Claude API 방식의 인증:

| 방법 | 예 |
|---|---|
| macOS / Linux | `ANTHROPIC_API_KEY=sk-ant-... npm start` |
| Windows PowerShell | `$env:ANTHROPIC_API_KEY="sk-ant-..."; npm start` |
| Anthropic CLI 프로필 | `ant auth login` 후 `npm start` (환경변수 불필요) |

모델은 `config.json` 의 `"ai": { "model": "claude-opus-5-5", "effort": "high" }` 로 바꿀 수 있습니다. 거절 응답 시 서버 측 대체 모델로 자동 재시도(`fallbacks: "default"`)하며, `"fallbacks": false` 로 끌 수 있습니다. 대화는 브라우저 탭(WebSocket 연결)마다 따로 유지되고 서버 재시작·재연결 시 새로 시작합니다.

**MCP 서버**: 에뮬레이터를 실행해 두고 MCP 클라이언트에 등록합니다. 인증 정보는 필요 없습니다 (Claude 는 클라이언트 쪽에서 실행).

```bash
# Claude Code (Streamable HTTP)
claude mcp add --transport http robot-emulator http://localhost:3000/mcp
```

stdio 만 지원하는 클라이언트(예: Claude Desktop)는 브리지를 사용합니다 — `claude_desktop_config.json`:

```json
{ "mcpServers": { "robot-emulator": { "command": "node", "args": ["C:/경로/RobotEmulator/tools/mcp-stdio.js", "http://localhost:3000/mcp"] } } }
```

`/mcp` 도 인증이 없으므로 위 [보안](#보안) 항목과 같이 신뢰할 수 있는 네트워크에서만 사용하십시오 (브라우저발 요청은 Origin 검사로 차단).

## 외부 통신 인터페이스

| 제조사 | 프로토콜 | 기본 포트 | 지원 기능 |
|---|---|---|---|
| Yaskawa | High-Speed Ethernet Server (UDP) | 10040 / 10041 | 상태·위치·알람 조회, IO, B/I/D/R/S/P 변수, 서보·홀드, 잡 선택·시작, 이동 명령(0x8A/0x8B), 파일 전송 |
| Kawasaki | AS 터미널 (Telnet) | 23 (실패 시 10023) | WHERE, ZPOW, EXECUTE, HOLD/CONTINUE, DO, LOAD/SAVE |
| Hyundai | Hi6 Open API 스타일 REST | 8888 | 위치, 상태, IO, 변수, 프로그램 제어, 이동 |
| ABB | Robot Web Services 1.0/2.0 | 8080 | jointtarget·robtarget, RAPID 실행·loadmod·심볼, IO 신호, 파일 서비스, 구독(WebSocket) |
| KUKA | KukaVarProxy / OpenShowVar | 7000 | $AXIS_ACT, $POS_ACT, $OV_PRO, $OUT/$IN, .dat 전역 변수 읽기·쓰기 |
| Universal Robots | Dashboard Server (TCP 텍스트) | 29999 | load·play·stop·pause·programState·robotmode·power on·brake release·unlock protective stop·safetystatus·get robot model 등 (응답 문구 UR 형식) |
| Doosan | DRL 소켓 (프로그램이 직접 엶) | 프로그램에서 지정 | `server_socket_open(port)` / `client_socket_open(ip, port)` 로 PC·비전과 TCP 통신. 바인딩 주소는 `host` 설정을 따름. 그 밖의 연동은 공통 Modbus TCP·OPC UA 사용 |
| 공통 | REST / WebSocket | 3000 | `GET /api/state`, `POST /api/cmd`, `ws://…/ws` |
| 공통 (AI) | MCP (Streamable HTTP) | 3000 | `http://<host>:3000/mcp` — 로봇 프로그램 생성·검증 · 직접 제어 도구 (위 Claude 연동) |
| 공통 (필드버스) | Modbus TCP 서버 | 502 (실패 시 1502) | 코일=DI, 이산 입력=DO, 상태·관절·TCP·사이클 타임 입력 레지스터, 명령/오버라이드/사용자 홀딩 레지스터 |
| 공통 (필드버스) | OPC UA 서버 (node-opcua) | 4840 | `opc.tcp://<host>:4840/UA/RobotEmulator`, 상태·관절·TCP·IO·레지스터 변수, 구독, 제어 메서드 |

- 샘플 클라이언트가 [tools/clients/](tools/clients/)에 있습니다. 예: `node tools/clients/kuka-varproxy-client.js 127.0.0.1`
- 포트는 루트에 `config.json`을 만들어 바꿀 수 있습니다 (지정하지 않은 항목은 기본값 유지):

```json
{ "httpPort": 3000, "host": "127.0.0.1", "robot": "kuka-kr6-r900", "gripper": "robotiq-2f85",
  "protocols": { "abbRws": { "port": 80 }, "kawasakiAs": { "enabled": false }, "opcua": { "enabled": false } } }
```

### Modbus TCP 주소 맵

`server/protocols/modbus-tcp.js` — 외부 의존성 없는 Modbus TCP 서버. Unit ID 는 무시(요청 값 그대로 응답), 다중 클라이언트 지원.
기능 코드 01·02·03·04·05·06·15·16·23, 예외 01(기능)/02(주소)/03(값). 주소는 **0 기준** (5자리 표기 40001 = 홀딩 0).
32bit 값은 레지스터 2개, **상위 워드 먼저**, int32 는 부호 있음.

| 영역 | 주소 | 내용 | 접근 |
|---|---|---|---|
| Coil | 0..511 | 로봇 DI 1..512 (PLC → 로봇 입력, `ctrl.setDI/getDI`) | R/W |
| Discrete Input | 0..511 | 로봇 DO 1..512 | R |
| Input Reg | 0 | 상태 비트: b0 서보 ON, b1 프로그램 실행 중, b2 HOLD, b3 알람, b4 이동 중, b5 TEACH, b6 PLAY, b7 REMOTE, b8 프로그램 완료, b9 프로그램 오류, b10 충돌, b11 비상정지, b12 안전 펜스 열림, b13 모드 인터록 ON, b14 시스템 I/O 사용 | R |
| Input Reg | 1 | 오버라이드 % | R |
| Input Reg | 2 | 알람 개수 | R |
| Input Reg | 3 | 마지막 알람 코드 (숫자 코드 또는 16bit 해시, 없으면 0) | R |
| Input Reg | 4-5 | 프로그램 사이클 횟수 (u32) | R |
| Input Reg | 6 | 제조사 코드 1 Yaskawa, 2 Kawasaki, 3 Hyundai, 4 ABB, 5 KUKA, 6 Doosan, 7 UR (UR 자세 각도는 회전 벡터 rad × 1000) | R |
| Input Reg | 7 | 마지막 명령 거부 사유 코드 (0 없음, 1 REMOTE 아님, 3 비상정지 … — [매뉴얼 9.2절](docs/MANUAL.md#92-안전--모드-인터록)) | R |
| Input Reg | 8 | 마지막으로 확정된 프로그램 번호 (시스템 I/O) | R |
| Input Reg | 10..21 | J1..J6 (int32, deg × 1000) | R |
| Input Reg | 30..43 | TCP 자세 `vendorPose()` int32 × 7: X,Y,Z (mm × 1000), 각도 3개 (deg × 1000); ABB 는 q1..q4 (× 1,000,000, 36..43), 그 외 42-43 = 0 | R |
| Input Reg | 50-51 | 마지막 사이클 시간 ms (u32) | R |
| Input Reg | 52-53 | 현재 사이클 경과 ms (u32) | R |
| Input Reg | 60 | 그리퍼 위치 % (0 열림 ~ 100 닫힘) | R |
| Input Reg | 61 | 공작물 파지 중 (1/0) | R |
| Holding Reg | 0 | 명령: 1 서보 ON, 2 서보 OFF, 3 시작, 4 HOLD, 5 재개, 6 정지, 7 알람 리셋, 8 프로그램 리셋, 9 HOME 이동 (쓰면 1회 실행, 읽으면 마지막 코드) | R/W |
| Holding Reg | 1 | 오버라이드 % (1~100) | R/W |
| Holding Reg | 2 | 마지막 명령 결과 (0 정상, 1 거부 — 사유는 Input Reg 7) | R |
| Holding Reg | 100..355 | 사용자 레지스터 `ctrl.regs` 의 `MB:<n>` (n = 주소-100), int16 — 로봇 프로그램·OPC UA 와 공유 | R/W |

Input Reg 의 0..99 중 미정의 주소는 0, Holding 3..99 는 예약(쓰기 시 예외 02).

### OPC UA 주소 공간

`server/protocols/opcua.js` — 엔드포인트 `opc.tcp://<host>:4840/UA/RobotEmulator`, 보안 None + 익명 허용 (Basic256Sha256 Sign/SignAndEncrypt 도 가능, 클라이언트 인증서 자동 신뢰).
자체 서명 서버 인증서는 최초 기동 시 `.opcua-pki/` 에 자동 생성됩니다. 네임스페이스 `urn:robot-emulator`, NodeId `ns=<idx>;s=Robot.<이름>`.

| 노드 (Objects/Robot/…) | 형식 | 접근 |
|---|---|---|
| Vendor, Model, Controller | String | R |
| Servo | Boolean | R/W (`setServo`) |
| Mode | String (TEACH/PLAY/REMOTE) | R (모드 인터록 OFF 일 때만 W) |
| Override | Double (%) | R/W |
| Moving, Held, AlarmActive | Boolean | R |
| EStop, FenceOpen, Interlock | Boolean | R |
| LastRejectCode / LastRejectReason | Int32 / String | R |
| ProgramNumber | Int32 (시스템 I/O 로 확정된 번호) | R |
| Alarms | String[] | R |
| ProgramName, ProgramStatus | String | R |
| CurrentLine / CycleCount | Int32 / UInt32 | R |
| LastCycleTime, CurrentCycleTime | Double (초) | R |
| Joints / JointNames | Double[6] (deg) / String[6] | R |
| TcpPose / TcpPoseNames | Double[] (제조사 표현) / String[] | R |
| GripperPosition / HoldingPart | Double 0..1 / String | R |
| IO/DO, IO/DI | Boolean[512] (인덱스 0 = 1번) | R / R/W |
| IO/DO_1..DO_64, IO/DI_1..DI_64 | Boolean | R / R/W |
| Registers/MB_0..MB_63 | Int16 (`ctrl.regs` `MB:n`, Modbus 홀딩 100..163 과 동일) | R/W |
| 메서드 ServoOn, ServoOff, Start, Stop, Hold, Resume, ResetAlarms, ResetProgram, MoveHome, MoveJoints(Double[6] joints, Double speedFraction), SelectProgram(String name) | 출력 Ok(Boolean), Message(String) | Call |

모든 변수는 getter 바인딩(실시간 값)이며 구독 시 최소 100ms 샘플링으로 변화가 통지됩니다.
샘플: `node tools/clients/modbus-client.js 127.0.0.1 502`, `node tools/clients/opcua-client.js opc.tcp://127.0.0.1:4840/UA/RobotEmulator`

## 그리퍼 라이브러리

각 제조사 공개 사양의 외형 치수와 TCP를 기반으로 만든 형상 모델입니다([shared/grippers.js](shared/grippers.js)).

- **Robotiq:** 2F-85, 2F-140, Hand-E, 3-Finger
- **OnRobot:** RG2, RG6, VGC10, MG10
- **SCHUNK:** PGN-plus-P 100, EGP 40
- **Zimmer:** GEP2016
- **범용:** 진공컵 Ø40, 진공 2×2 어레이, 22° MIG 토치, 스핀들

이 밖에 STL 파일을 불러와 TCP를 지정할 수 있습니다.

기본 I/O 규약 (UI에서 변경 가능):

| 신호 | 의미 |
|---|---|
| DO1 ON | 닫기 / 흡착 |
| DO1 OFF 또는 DO2 ON | 열기 |
| DI1 | 닫힘 확인 |
| DI2 | 열림 확인 |
| DI3 | 공작물 감지 |

## 정확도에 관한 주의

- **로봇 치수·속도:** 로봇 치수(OPW 파라미터), 관절 한계, 속도는 공개 카탈로그 기반 근사값입니다. 실제 장비와 동일한 궤적이 필요하면 제조사 치수도의 값으로 [shared/robots.js](shared/robots.js)를 수정하십시오.
  - 특히 카와사키·현대 모델의 치수와 관절 부호·영점(`offsets`/`signs`)은 반드시 확인이 필요합니다.
  - 야스카와 `pulsePerDeg`는 컨트롤러 파라미터에 따라 다릅니다.
  - 두산 모델은 공식 URDF 치수를 그대로 썼습니다. 다만 반복정밀도와 A 시리즈 가반하중은 매뉴얼 사양표의 열 정렬이 불분명해 확인이 필요합니다.
  - UR 모델은 UR 공식 DH 표와 데이터시트(2026-10, UR3e·UR7e·UR12e·UR20·UR30)를 썼습니다. UR5e·UR10e·UR16e 의 관절·TCP 속도는 같은 팔 모델 값으로 추정했습니다. 손목 3 무한 회전(UR3e)은 ±360° 로 제한합니다.
- **블렌딩:** 앞 구간의 감속과 다음 구간의 가속을 관절 공간에서 겹치는 방식입니다. 코너 궤적은 실제 컨트롤러와 다소 다를 수 있습니다.
  - 레벨→반경 환산값은 기본 파라미터 기준 추정입니다. INFORM PL1~8은 12.5~500 mm, HRScript A1~7은 10~300 mm로 잡았습니다. 현장 파라미터에 맞게 `server/lang/inform.js`의 `PL_MM`, `hrscript.js`의 `ACC_MM`을 수정하십시오.
- **URScript:** 스레드(thread/run/join), 구조체·행렬, RTDE 레지스터 함수, 힘 제어는 지원하지 않습니다. 가속도 `a` 는 반영하지 않고 `movep` 는 `movel` 로 처리합니다. PolyScope 프로그램(`.urp`)은 읽지 않으므로 Dashboard `load x.urp` 는 같은 이름의 `.script` 를 고릅니다. RTDE(30004)·Primary/Secondary(30001~30003) 인터페이스는 아직 없습니다.
- **DRL:** 파이썬 전체가 아니라 로봇 프로그램에 쓰는 부분집합입니다. 딕셔너리·클래스·try·외부 모듈은 지원하지 않습니다.
  - 식 안의 사용자 함수와 대기 함수(`movel`, `wait_digital_input` 등)는 같은 식의 다른 부분보다 먼저 실행됩니다. `and`/`or`/조건식의 단락 평가는 지킵니다.
  - `amove*`(비동기 이동)는 동기 이동으로, `movejx` 의 `sol` 은 가장 가까운 해로, `movesx`/`movesj` 는 경유점 블렌딩으로 근사합니다. `acc` 는 반영하지 않습니다.
- **가반하중:** 가반하중에 따른 가감속 변화는 모델링하지 않습니다.
- **간섭 체크:** 캡슐 근사이므로 실제 외형과 수 mm~수십 mm 차이가 납니다.
  - 파지를 위해 그리퍼↔공작물, TCP 끝 5 mm 이내는 검사에서 제외합니다.
- **통신 프로토콜:** 매뉴얼을 기반으로 구현했지만, 오프라인 환경에서 원문과 대조하지 못한 부분이 있습니다.
  - 현대 Hi6 Open API 경로와 야스카와 HSE 부가 상태 코드는 실제 매뉴얼로 검증하십시오.
  - 실제와 다른 점은 각 프로토콜 파일 상단 주석에 정리했습니다.

## 구조

```
shared/      기구학(OPW), 수학, 로봇·그리퍼 라이브러리, 자세 표현 변환 (서버·브라우저 공용)
server/      controller.js(가상 컨트롤러), motion.js(궤적), vm.js(프로그램 VM), index.js(HTTP/WS)
server/lang/ 언어 컴파일러: inform, as, hrscript, rapid, krl, drl (+ 공용 수식 파서 expr.js. drl 은 자체 파이썬 파서)
server/protocols/  통신 서버 5종 + 필드버스(Modbus TCP, OPC UA)
public/      웹 UI (Three.js 3D 뷰, 에디터, 패널)
tools/       샘플 통신 클라이언트, 예제 내보내기
test/        자동 테스트 (run-all.js 가 *.test.js 를 병렬 실행)
docs/MANUAL.md        사용자 매뉴얼
docs/ROADMAP-SI.md    SI 현장(PLC·상위 PC 개발자) 대상 개선 로드맵
docs/DEV_CONTRACT.md  언어·통신 모듈 개발 규약 (새 제조사·언어 추가 시 참고)
```
