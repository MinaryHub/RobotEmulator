# 변경 기록

버전 번호는 [유의적 버전](https://semver.org/lang/ko/)을 따릅니다.
- **MAJOR:** 설정·프로그램·통신 호환이 깨지는 변경
- **MINOR:** 기능 추가
- **PATCH:** 버그 수정

릴리스 절차는 [README의 버전 관리](README.ko.md#버전-관리와-업데이트) 절을 보십시오.

## [1.5.0] - 2026-11-27

### 추가
- **현장 프로토콜 4종 추가 (총 12개 통신 인터페이스).**
  - **UR RTDE** (`TCP 30004`): 바이너리 버전 협상, 입출력 레시피 설정, 주기적 `DATA_PACKAGE` 및 GP 정수/실수 레지스터 동기화
  - **EtherNet/IP CIP** (`TCP 44818`): `ListServices`, `ListIdentity`, `RegisterSession`, `SendRRData` UCMM Identity(0x01) 및 Input/Output Assembly(100/150)
  - **CC-Link IE Field Basic** (`UDP 61450`): `NODE_SEARCH` 및 사이클릭 RX/RY/RWw/RWr 교환
  - **Doosan DRFL 소켓** (`TCP 12345`): 라인/JSON 프로토콜 기반 상태·좌표·I/O·서보·모드·이동 명령 지원
- **실장비 다중 폴더 ZIP 백업 가져오기 (`POST /api/backup/import`).** KUKA(`KRC/R1/...`), ABB(`RAPID/...`), Yaskawa, Kawasaki, Hyundai, Doosan, UR 백업 ZIP 또는 폴더 JSON을 제조사 자동 판별·충돌 방지 페어링으로 가져옵니다.
- **URScript PolyScope 호환성 확장.** `thread` / `run` / `join` / `kill` 협력 스레드와 `struct(...)` / `{k=v}` 구조체 리터럴 및 `.field` 읽기/쓰기를 지원합니다.
- **공장 IT 보안 · RBAC · 다중 접속 제어권 잠금.**
  - `Bearer` / `X-Auth-Token` / `?token=` 기반 `admin`·`readonly`(관찰자) 토큰 인증 및 IP/CIDR 허용 목록
  - 다중 브라우저 접속 시 단일 제어권(Single-Writer Pendant Lock), 상단 `제어권 가져오기` 버튼, 접속 종료 시 자동 위임
  - `--air-gapped`, `--no-ai`, `--no-update`, `--no-autosave`, `--data-dir`, `--headless`, `--token`, `--readonly-token` CLI·환경변수 지원 및 `0.0.0.0` 공개 시 원격 업데이트 적용 자동 차단
- **Headless HIL/CI 러너 & 프로브 · 배포 템플릿.**
  - `node server/index.js --scenario <json> --junit <xml>` 무인 시나리오 검증 및 JUnit XML 리포트 생성
  - 컨테이너/오케스트레이터용 비인증 `/healthz` · `/readyz` 엔드포인트
  - [Dockerfile](Dockerfile), [docker-compose.yml](docker-compose.yml), [deploy/robot-emulator.service](deploy/robot-emulator.service) 추가

### 수정 · 안정화
- **충돌·티칭·비전 정확도.** 커스텀 STL 그리퍼 바운딩 캡슐 및 파지 공작물 간섭 검사, Direct Teach 활성 Tool Frame(`this.tool`) 반영, Yaskawa `///POSTYPE PULSE` 출력, 비전 지연 시 트리거 시점 스냅샷 좌표 출력, 현대 `{...}` 포즈 및 KRL `;FOLD`/동일 stem `.dat`/`S`,`T` 비트 갱신을 수정했습니다.
- **언어 런타임 · 프로토콜 정합성.** KRL 파일 스코프 `.dat`·`$ANIN`/`$ANOUT`, RAPID `LOCAL` 격리·`AInput`/`GInput`, URScript 아날로그·RTDE GP 레지스터, DRL 아날로그·`get_vision_pos`, INFORM `ARCON`/`ARCOF`, ABB RWS `/rw/mastership`·`elog` 숫자 코드·알람 리셋, Modbus IR[3] 숫자 알람·소켓 상한/유휴 정리, Yaskawa HSE/Kawasaki AS/Hyundai OpenAPI/OPC UA를 보강했습니다.
- **24/7 장기 구동 안정성.** 알람 200건 상한, 신호 번호 범위 클램프, 중단 시 VM 타이머 정리, WebSocket 30s `ping/pong`·2MB 백프레셔, 휘발성 레지스터(`MB:`, `RTDE_`, `aio`) 제외 및 10초 스로틀 비동기 자동 저장을 적용했습니다.

## [1.4.0] - 2026-11-24

### 추가
- **티치 펜던트 워크플로 (Touch-Up · Go To Point · Set PP).** 에디터 커서 줄의 포인트 좌표만 현재 로봇 위치로 덮어쓰기(`✎ 덮어쓰기`), 커서 줄 포인트로 안전 속도 이동(`→ 포인트 이동`), 프로그램 포인터를 커서 줄로 지정(`➤ PP 이동`)을 지원합니다. 7개 제조사 문법을 모두 지원합니다.
- **Tool / User 좌표계 & 3점 User Frame 티칭.** 8개 Tool 프레임과 8개 User 프레임 편집·선택, 지그 3점(원점·+X·+XY) 캡처로 User Frame 자동 산출, `USER` 기준 직교 조그 및 3D 활성 User 축 표시, INFORM `///TOOL`/`///USER` 헤더 반영을 추가했습니다.
- **안전 · 현장 인터록 강화.**
  - ISO 10218-1 T1 규격 `TEACH` 모드 TCP 250 mm/s 속도 상한 옵션(기본 ON)
  - 외부 PLC/REMOTE 연동 시 `×1` 배속 잠금 옵션 및 비×1 배속 `⚠ PLC 타이밍` 경고 배지
  - 프로토콜 제조사 격리(`protocolMode: 'vendor'` 기본값 — 선택 제조사 + 필드버스 포트만 바인딩하여 포트 충돌 방지)
- **그룹 I/O (GI/GO) 및 아날로그 I/O (AI/AO 1..16).** DI/DO 비트 매핑 기반 `GI`/`GO`와 `AI`/`AO` 16채널(Modbus TCP HR 356~387, OPC UA `IO.AI`/`IO.AO`, I/O 탭 실시간 UI)을 추가했습니다.
- **안전 영역(SafeZone) & 간섭 구역(Interference Zone).** 박스·원통형 구역을 3D 뷰에 반투명으로 시각화하고, 진입 시 지정 DO 자동 출력(간섭 구역) 또는 즉시 정지 + `SAFE_ZONE` 알람(안전 영역)을 발생시킵니다.
- **가상 비전 센서 (DO 트리거).** 카메라별 DO 상승 에지(또는 UI `▶ 트리거`)로 카메라 프러스텀 내 공작물을 검출하고 노이즈·지연을 반영해 결과 레지스터(Modbus/R/P)와 완료·검출 DI를 출력합니다.
- **모션 자세 검증 · 가감속/페이로드 · 선독 트리거.**
  - 7개 제조사 `CONFIG` 자세 불일치 알람 코드(ABB `50080`, KUKA `KSS01446`, Yaskawa `4429` 등) 및 직선/원호 끝점 자세 검증
  - 페이로드 질량(kg) 관성 및 전역/명령별 가감속 배율(`AccSet`, KRL `$ACC`/`$ACC_AXIS`·`BAS(#ACC_*)`, INFORM `ACC=`)
  - ABB `ConfL \On/\Off`, `TriggIO`/`TriggL`/`TriggJ`/`TriggC`, `SetAO`/`SetGO` 및 KRL `TRIGGER WHEN DISTANCE/PATH ... DELAY=... DO ...` 선독 트리거 실행
- **홀드 중 수동 이동 & 원경로 복귀 (Path Recovery).** HOLD 상태에서 수동 조그·직접교시 시 이탈 각도를 감지해 상단 경고 배너(`↩ 원경로 복귀`)를 표시하며 `자동 저속 복귀` / `복귀 전 재개 차단` / `끄기` 3가지 복귀 정책을 제공합니다.
- **현장 친화 3D UX & 폐쇄망 모드.**
  - 직접교시 **표면 법선 정렬 (`⟂ 면 정렬`, 단축키 `F`)**: 3D 공작물·테이블 면 클릭으로 TCP `+Z`를 법선 정렬
  - 용접 토치(`torch-22`) DO ON 시 3D 아크 글로우 및 주황색 용접 비드 누적 궤적 표시
  - `config.ai.enabled: false` 및 정보 창 **AI 채팅 패널 숨기기 (폐쇄망 모드)** 토글

## [1.3.0] - 2026-11-23

### 추가
- **통신 트래픽 모니터.** 하단에 `통신 모니터` 탭을 추가해 Modbus TCP, OPC UA, Yaskawa HSE, Kawasaki AS, Hyundai Open API, ABB RWS, KUKA VarProxy, UR Dashboard의 요청/응답·HEX/RAW·응답 시간·접속 클라이언트를 실시간으로 확인하고 인터페이스·오류·검색 필터 및 CSV 내보내기(`/api/traffic`, `/api/traffic.csv`)를 지원합니다.
- **고장 주입(Fault Injection) 및 제조사별 알람 코드.** 왼쪽 `고장` 탭에서 그리퍼 파지 실패, 컨베이어 정지, 피더 걸림, 센서 ON/OFF 고착, 프로토콜 응답 지연·패킷 손실, 서보 트립·모션 강제 정지·제조사 알람 주입을 시험할 수 있으며 상단 헤더에 `FAULT` 배지로 표시됩니다. 7개 제조사별 알람 코드(`shared/alarms.js`)가 알람 로그와 배너에 함께 표시됩니다.
- **스텝 조그.** 조그 탭에서 연속 이동 외에 `0.1` / `1` / `10` (° 또는 mm) 단위 증분 조그와 관절 한계 근접 경고를 지원합니다.
- **신호 타임라인 CSV 내보내기 및 호버 시간 표시.** `/api/timeline.csv` 다운로드와 마우스 위치 시각 표시를 추가했습니다.
- **웹 UI 편의 기능.**
  - 3D 뷰포트 빠른 HUD(등각·상면·정면·측면·TCP 카메라 프리셋, 단축키 `1`–`5`, 궤적·작업영역·간섭 토글)
  - 밝은/어두운 테마 전환, 좌·우·채팅·하단 리사이즈 스플리터(브라우저 자동 저장), 키보드 단축키 안내 창(`?`)
  - 에디터 `Ctrl+F` 찾기 바, `Shift+Tab` 내어쓰기, `Enter` 자동 들여쓰기, `Ln/Col` 커서 표시
  - I/O 번호·이름·ON/이름표 필터, 로그 검색·스크롤 고정·텍스트 저장, 변수 검색, WebSocket 지수 백오프 재연결 배너

### 개선
- **3D 렌더링 · 프런트엔드 성능.** 유휴 시 프레임 렌더링 생략 및 변경 시에만 그림자 맵 갱신, 컨베이어 애니메이션을 메인 루프로 통합, 30Hz 상태 업데이트의 불필요한 DOM/i18n 재계산 및 비활성 탭 갱신 제거, 신호 타임라인 신호별 이진 탐색 최적화.
- **서버 · 연산 성능.** 미접속 시 30Hz 상태 스냅샷 생략, 리비전 카운터 기반 O(1) `stateDelta` 비교, 이벤트 기반 파일 목록 전파, 비동기·원자적 자동저장, BVH 스택 재사용 및 충돌 검사 최적화.

### 수정
- **기구학 · 충돌 · 컨트롤러.** `ZYZfromR` `A=180°` 특이점 부호 오류, OPW/UR 손목 특이점 허용오차 및 `J6` 보존, `rayMesh` `-0` 방향 NaN, 사용자 STL 그리퍼 기본 충돌 캡슐 누락, 블렌딩 종료 구간 중단 판정, `paused+held` 교착, 로봇 교체 시 활성 비상정지 알람 유지, 비정상 `jog` 입력 방어, `SysIO` NC 초기화/펜스 소유권/펄스 연타 반전 수정.
- **보안 · 프로토콜 · 언어 · AI.** 기형적 `Host` 헤더 차단, ABB RWS/Hyundai HTTP·WS `Origin` 검증 및 실행 중 파일 수정 차단, Yaskawa HSE 선형 와일드카드 매칭(ReDoS 방지), KUKA `$MODE_OP` `#EX` 정합성, RAPID `PulseDO \High` 자동 복귀, DRL 반복 상한 및 0 나눗셈 검사, 채팅 `reset()` 경합 수정.
- **웹 화면 · GPU 자원.** 공유 GLB 캐시·STL 그리퍼 지오메트리 오해제 방지 및 `RoomEnvironment`/원본 공유 재질/`depthTexture`/임시 씬/Blob URL 누수 제거, 파일 탭·프로젝트·셀·카메라 패널 XSS 이스케이프, `DirectTeach` 드래그 중 해제 정리 및 macOS `Cmd+Z` 지원, 영문 UI 번역 누락·패턴 수정 및 사용자 데이터 영역 보호.

## [1.2.2] - 2026-11-21

### 변경
- 저장소 정리: `brand/` 의 로고 PNG 는 더 이상 저장소에 넣지 않습니다. 필요하면 `sh brand/render.sh` 로 SVG 에서 만듭니다. 앱 기능 변화는 없습니다.

## [1.2.1] - 2026-11-21

### 추가
- **앱 로고.** 웹 화면(파비콘·머리글), Android 런처 아이콘(적응형 아이콘), README 에 새 로고를 넣었습니다. 원본 SVG 는 `brand/` 에 있고 `sh brand/render.sh` 로 PNG 를 만듭니다.

## [1.2.0] - 2026-11-21

### 추가
- **Windows · macOS · Linux 휴대용 꾸러미.** Node.js 를 설치하지 않아도 됩니다. 압축을 풀고 실행 파일을 더블클릭하면 서버가 뜨고 브라우저가 열립니다.
  - `win-x64`, `darwin-arm64`(Apple Silicon), `darwin-x64`(Intel Mac), `linux-x64`, `linux-arm64`
  - Node.js 22 를 `runtime/` 에 포함합니다.
- **Android 앱 (APK).** 앱 안에서 에뮬레이터 서버가 돌고 화면이 바로 열립니다. Android 7.0 이상, arm64·armv7 기기를 지원합니다.
  - Node 18 기반(nodejs-mobile)이라 OPC UA 서버는 동작하지 않습니다. 나머지 통신 인터페이스는 모두 동작합니다.
  - Android 15 이상의 16 KB 페이지 기기에서는 처음 실행할 때 "호환 모드로 실행" 안내가 한 번 뜰 수 있습니다.
- 꾸러미 만들기: `npm run package:desktop`, `npm run package:android`, 릴리스에 올리기: `npm run package:upload`

## [1.1.1] - 2026-11-21

### 수정
- `npm run release -- --yes` 가 태그를 올린 뒤 GitHub 릴리스를 만들기 전에 오류로 멈추던 문제를 고쳤습니다.

## [1.1.0] - 2026-11-21

### 추가
- **영어 화면.** 브라우저 언어가 한국어가 아니면 영어 화면으로 엽니다. 정보(ⓘ) 창이나 `?lang=en` / `?lang=ko` 로 바꿀 수 있습니다.
  - 영어 화면에서는 예제 프로그램의 주석·메시지와 셀 프리셋 장치 이름도 영어로 만듭니다.
  - 서버 로그·알람 메시지는 아직 한국어입니다.
- **스크린샷:** `screenshots/` 폴더에 영어 화면 스크린샷을 넣었습니다.
- **버전 정보와 자동 업데이트.** 머리글의 ⓘ 정보 창에서 현재 버전과 커밋을 확인할 수 있습니다.
  - 서버가 시작할 때와 하루에 한 번 GitHub 릴리스를 확인해 새 버전을 알립니다.
  - git clone으로 설치했다면 **업데이트 및 재시작** 버튼 한 번으로 내려받기, 의존성 설치, 재시작까지 진행합니다.
  - 업데이트가 실패하면 이전 버전으로 되돌립니다.
- **문의하기.** 정보 창에서 버전, OS, 로봇 모델이 미리 채워진 GitHub 이슈(버그 신고·기능 제안)를 열 수 있습니다.
- **후원하기.** GitHub Sponsors 링크를 추가했습니다.
- `npm start`가 실행기(`server/launcher.js`)를 거쳐 서버를 띄웁니다. 업데이트 후 재시작을 처리하며, 기존처럼 서버만 직접 실행하려면 `npm run serve`를 쓰십시오.
- `npm run release`로 GitHub 릴리스를 만듭니다.

### 변경
- **기본 접속 범위가 이 PC(`127.0.0.1`)로 바뀌었습니다.** 다른 PC나 PLC에서 접속하려면 `config.json`에 `"host": "0.0.0.0"`을 넣으십시오.
- `/api`, `/ws`, `/mcp`는 다른 웹사이트에서 보낸 브라우저 요청을 거부합니다. `/api/cmd`는 `Content-Type: application/json`만 받습니다.
- KRL에서 INT끼리 나누면 소수부를 버립니다(`7/2` → 3).
- WebSocket `state` 메시지에서 바뀌지 않은 큰 항목은 생략합니다. 로그는 묶어서 `logs` 메시지로 보낼 수 있습니다.
- WebSocket 명령의 요청 번호는 `rid` 로 보냅니다. `setRobot`·`setGripper`·셀 프리셋처럼 인자 이름이 `id` 인 명령은 예전 방식(`id`)으로는 응답을 받을 수 없었습니다.

### 수정
- **서버가 멈추거나 죽던 문제**
  - 동작이 없는 반복문이 서버를 멈추던 문제를 고쳤습니다.
  - 무한 재귀가 메모리를 다 쓰던 문제를 고쳤습니다. 이제 알람으로 멈춥니다.
  - 잘못된 URL, 큰 통신 메시지, 잘못된 입력으로 서버가 죽거나 멈추던 문제를 고쳤습니다.
- **DRL·URScript 단락 평가:** `and`, `or`, 조건식에서 앞부분으로 결과가 정해지면 뒷부분의 함수를 호출하지 않습니다.
- **손목 특이점:** J5가 0일 때 J4가 0으로 튀던 문제를 고쳤습니다.
- **언어별 오류**
  - Kawasaki AS에서 지역 변수와 전역 변수가 섞이던 문제를 고쳤습니다.
  - RAPID `StrToVal`이 실제로 값을 변환합니다.
  - 에뮬레이터가 실행하지 않는 문장이 있으면 경고합니다.
  - 오류 위치가 실제로 실패한 줄이나 블록을 여는 줄을 가리킵니다.
- **웹 화면**
  - 연결이 끊기면 대기 중이던 명령이 오류로 끝납니다.
  - 저장하는 동안 입력한 내용이 지워지던 문제를 고쳤습니다.
  - 저장하지 않은 변경이 있으면 창을 닫기 전에 경고합니다.
  - 단축키가 한글 입력 상태에서도 동작합니다.
  - 3D 그래픽 메모리가 계속 늘던 문제를 고쳤습니다.
  - 좁은 화면에서도 쓸 수 있게 배치를 바꿨습니다.

## [1.0.0] - 2026-11-20

첫 릴리스입니다.
- **로봇:** 7개 제조사(Yaskawa, Kawasaki, Hyundai, ABB, KUKA, Doosan, Universal Robots)의 로봇 모델을 지원합니다.
- **로봇 언어:** INFORM, AS, HRScript, RAPID, KRL, DRL, URScript 해석기를 제공합니다.
- **통신:** 제조사별 통신 인터페이스와 공통 Modbus TCP, OPC UA를 지원합니다.
- **화면과 시뮬레이션:**
  - 3D 화면, 프로그램 편집기, 단계 실행, 브레이크포인트, 사이클 타임
  - 셀 주변기기, 3D 모델 가져오기, 간섭 검사
- **Claude 연동:** Claude 채팅과 MCP 서버를 제공합니다. 로봇 이동, 그리퍼, I/O 쓰기는 REMOTE 모드에서만 허용합니다.
