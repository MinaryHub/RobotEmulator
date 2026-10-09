# 산업용 로봇 에뮬레이터

야스카와 · 카와사키 · 현대로보틱스 · ABB · KUKA 산업용 로봇을 하나의 가상 컨트롤러로 에뮬레이션합니다.

- 각 제조사 로봇 언어로 작성한 프로그램을 그대로 실행하고, 3D로 동작을 확인할 수 있습니다.
- 각 제조사의 외부 통신 인터페이스를 지원하므로 PLC·PC 상위 프로그램을 실제 로봇 없이 개발하고 시험할 수 있습니다.

## 실행

```bash
npm install
npm start          # http://localhost:3000
npm test           # 기구학 · 5개 언어 · 5개 통신 프로토콜 · 필드버스(Modbus/OPC UA) 테스트
```

필요 환경: Node.js 20 이상. 외부 의존성은 `three`(3D)와 `ws`(WebSocket)뿐입니다.

## 주요 기능

| 영역 | 내용 |
|---|---|
| 로봇 모델 | 17종: GP7/12/25, RS007N/010N/020N, HH7/HH020/HS220, IRB1200/2600/6700, KR6 R900 sixx·R900-2, KR10 R1100 sixx·R1100-2, KR210 R2700. 데이터시트·치수도·ROS-I/RoboDK 교차 확인 (모델별 출처는 `shared/robots.js`의 `source`) |
| 기구학 | OPW 해석적 역기구학(최대 8해). 제조사별 관절 부호·영점, 자세 표현 관례(Rx·Ry·Rz / O·A·T / 쿼터니언 / A·B·C) 반영 |
| 모션 | 관절보간, 직선보간, 원호보간. 사다리꼴 가감속, 관절 최고속도 제한(특이점 부근 자동 감속), 오버라이드, HOLD, 소프트리밋·도달불가·특이점 알람 |
| 블렌딩 | 경유점 근사: INFORM `PL`, AS `ACCURACY`(+`BREAK`), HRScript `A=`, RAPID zonedata(`z10`…, `\Z`, `fine`), KRL `C_PTP/C_DIS`·인라인 `CONT`. UI에서 ON/OFF 비교 가능 |
| 사이클 타임 | 시뮬레이션 시계 기준(HOLD 제외, PC 부하와 무관) 총 시간과 모션/대기/기타 구분, 라인별 상위 시간, 최근 이력. 시작할 때마다 공작물 자동 초기화(옵션) |
| 간섭 체크 | 로봇 링크·그리퍼를 캡슐로 근사해 테이블·바닥·받침대·공작물과 자기 간섭을 매 틱 검사. 모드: OFF / 경고 / 정지(알람). 3D 하이라이트와 간섭 모델 표시 |
| 프로그램 | 웹 에디터(구문 강조, 실행 라인 표시, 컴파일 오류 위치 표시). 시작·단계 실행·홀드·정지·리셋, 현재 위치 티칭 삽입, 파일 열기·다운로드 |
| 그리퍼 | 15종 형상 라이브러리(아래 표)와 STL 사용자 그리퍼. DO로 개폐하고 DI로 닫힘·열림·감지를 피드백. 공작물 파지·이송·낙하 시뮬레이션 |
| 조작 | 축 조그, 직교 조그(BASE/TOOL), 서보 ON/OFF, 모드 전환, I/O 강제 출력과 입력 시뮬레이션, 작업 영역(손목 중심 도달 범위) 3D 표시 |
| 디버깅 | 에디터 라인 번호 클릭 → 브레이크포인트, 변수 감시(로컬·전역·레지스터, 변경 강조), 신호 타임라인(DO/DI·RUN·MOVING·HOLD·GRIP·ALARM 파형, 두 점 클릭으로 Δt 측정) |
| 프로젝트 | 로봇·그리퍼·설정·제조사별 프로그램/변수·셀 레이아웃을 `projects/<이름>.json` 으로 저장/불러오기, JSON 내보내기·가져오기. 2초마다 자동 저장 → 서버 재시작 시 직전 세션 복원 (`config.json` 의 `"restoreSession": false` 로 끔). 제조사를 바꿨다 돌아와도 이전 프로그램 유지 |
| 셀 레이아웃 | 셀 탭에서 테이블·장애물·공작물과 주변기기(컨베이어, 피더, 센서, 공압 실린더, 배출구, 팔레트) 배치·편집, 프리셋(기본 / 컨베이어 픽 앤 플레이스), JSON 내보내기·가져오기. 장치는 로봇 DI/DO(기본 DO9 컨베이어 운전, DI9 도착 센서)로 연동되어 Modbus·OPC UA 에서도 보임. 장애물·컨베이어 프레임은 간섭 체크 대상 (`server/cell.js`, 예제 `examples/conveyor/`) |

## 지원 로봇 언어

로봇을 선택하면 현재 셀 배치에 맞춘 pick & place 예제가 자동으로 생성됩니다. 같은 예제가 [examples/](examples/)에도 있습니다.

| 제조사 | 언어 | 파일 | 주요 지원 범위 |
|---|---|---|---|
| Yaskawa | INFORM | `.JBI` | MOVJ/L/C/S, IMOV, DOUT, WAIT, JUMP/CALL, B·I·D·R·P 변수, PULSE·RECTAN 위치 |
| Kawasaki | AS | `.as` / `.pg` | JMOVE/LMOVE, APPRO/DEPART, C1/C2MOVE, SIGNAL/SWAIT, IF·WHILE·FOR·CASE, 변환 연산, `.TRANS` / `.JOINTS` |
| Hyundai | HRScript | `.job` | MOVE P/L/C, DO/DI, WAIT, IF·FOR·WHILE, CALL, V 변수, 포즈 연산 |
| ABB | RAPID | `.mod` | MoveJ/L/C/AbsJ, Offs/RelTool, SetDO/WaitDI, PROC/FUNC, TEST, 레코드·배열, confdata |
| KUKA | KRL | `.src` + `.dat` | PTP/LIN/CIRC, 인라인 폼(PDAT/LDAT), `:` 연산자, S/T, $OUT/$IN, SWITCH·LOOP·REPEAT |

언어별 상세 지원 문법은 각 모듈 파일(`server/lang/*.js`) 상단 주석에 있습니다.

## 외부 통신 인터페이스

| 제조사 | 프로토콜 | 기본 포트 | 지원 기능 |
|---|---|---|---|
| Yaskawa | High-Speed Ethernet Server (UDP) | 10040 / 10041 | 상태·위치·알람 조회, IO, B/I/D/R/S/P 변수, 서보·홀드, 잡 선택·시작, 이동 명령(0x8A/0x8B), 파일 전송 |
| Kawasaki | AS 터미널 (Telnet) | 23 (실패 시 10023) | WHERE, ZPOW, EXECUTE, HOLD/CONTINUE, DO, LOAD/SAVE |
| Hyundai | Hi6 Open API 스타일 REST | 8888 | 위치, 상태, IO, 변수, 프로그램 제어, 이동 |
| ABB | Robot Web Services 1.0/2.0 | 8080 | jointtarget·robtarget, RAPID 실행·loadmod·심볼, IO 신호, 파일 서비스, 구독(WebSocket) |
| KUKA | KukaVarProxy / OpenShowVar | 7000 | $AXIS_ACT, $POS_ACT, $OV_PRO, $OUT/$IN, .dat 전역 변수 읽기·쓰기 |
| 공통 | REST / WebSocket | 3000 | `GET /api/state`, `POST /api/cmd`, `ws://…/ws` |
| 공통 (필드버스) | Modbus TCP 서버 | 502 (실패 시 1502) | 코일=DI, 이산 입력=DO, 상태·관절·TCP·사이클 타임 입력 레지스터, 명령/오버라이드/사용자 홀딩 레지스터 |
| 공통 (필드버스) | OPC UA 서버 (node-opcua) | 4840 | `opc.tcp://<host>:4840/UA/RobotEmulator`, 상태·관절·TCP·IO·레지스터 변수, 구독, 제어 메서드 |

- 샘플 클라이언트가 [tools/clients/](tools/clients/)에 있습니다. 예: `node tools/clients/kuka-varproxy-client.js 127.0.0.1`
- 포트는 루트에 `config.json`을 만들어 바꿀 수 있습니다:

```json
{ "httpPort": 3000, "robot": "kuka-kr6-r900", "gripper": "robotiq-2f85",
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
| Input Reg | 0 | 상태 비트: b0 서보 ON, b1 프로그램 실행 중, b2 HOLD, b3 알람, b4 이동 중, b5 TEACH, b6 PLAY, b7 REMOTE, b8 프로그램 완료, b9 프로그램 오류, b10 충돌 | R |
| Input Reg | 1 | 오버라이드 % | R |
| Input Reg | 2 | 알람 개수 | R |
| Input Reg | 3 | 마지막 알람 코드 (숫자 코드 또는 16bit 해시, 없으면 0) | R |
| Input Reg | 4-5 | 프로그램 사이클 횟수 (u32) | R |
| Input Reg | 6 | 제조사 코드 1 Yaskawa, 2 Kawasaki, 3 Hyundai, 4 ABB, 5 KUKA | R |
| Input Reg | 10..21 | J1..J6 (int32, deg × 1000) | R |
| Input Reg | 30..43 | TCP 자세 `vendorPose()` int32 × 7: X,Y,Z (mm × 1000), 각도 3개 (deg × 1000); ABB 는 q1..q4 (× 1,000,000, 36..43), 그 외 42-43 = 0 | R |
| Input Reg | 50-51 | 마지막 사이클 시간 ms (u32) | R |
| Input Reg | 52-53 | 현재 사이클 경과 ms (u32) | R |
| Input Reg | 60 | 그리퍼 위치 % (0 열림 ~ 100 닫힘) | R |
| Input Reg | 61 | 공작물 파지 중 (1/0) | R |
| Holding Reg | 0 | 명령: 1 서보 ON, 2 서보 OFF, 3 시작, 4 HOLD, 5 재개, 6 정지, 7 알람 리셋, 8 프로그램 리셋, 9 HOME 이동 (쓰면 1회 실행, 읽으면 마지막 코드) | R/W |
| Holding Reg | 1 | 오버라이드 % (1~100) | R/W |
| Holding Reg | 2 | 마지막 명령 결과 (0 정상, 1 거부) | R |
| Holding Reg | 100..355 | 사용자 레지스터 `ctrl.regs` 의 `MB:<n>` (n = 주소-100), int16 — 로봇 프로그램·OPC UA 와 공유 | R/W |

Input Reg 의 0..99 중 미정의 주소는 0, Holding 3..99 는 예약(쓰기 시 예외 02).

### OPC UA 주소 공간

`server/protocols/opcua.js` — 엔드포인트 `opc.tcp://<host>:4840/UA/RobotEmulator`, 보안 None + 익명 허용 (Basic256Sha256 Sign/SignAndEncrypt 도 가능, 클라이언트 인증서 자동 신뢰).
자체 서명 서버 인증서는 최초 기동 시 `.opcua-pki/` 에 자동 생성됩니다. 네임스페이스 `urn:robot-emulator`, NodeId `ns=<idx>;s=Robot.<이름>`.

| 노드 (Objects/Robot/…) | 형식 | 접근 |
|---|---|---|
| Vendor, Model, Controller | String | R |
| Servo | Boolean | R/W (`setServo`) |
| Mode | String (TEACH/PLAY/REMOTE) | R/W |
| Override | Double (%) | R/W |
| Moving, Held, AlarmActive | Boolean | R |
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
- **블렌딩:** 앞 구간의 감속과 다음 구간의 가속을 관절 공간에서 겹치는 방식입니다. 코너 궤적은 실제 컨트롤러와 다소 다를 수 있습니다.
  - 레벨→반경 환산값은 기본 파라미터 기준 추정입니다. INFORM PL1~8은 12.5~500 mm, HRScript A1~7은 10~300 mm로 잡았습니다. 현장 파라미터에 맞게 `server/lang/inform.js`의 `PL_MM`, `hrscript.js`의 `ACC_MM`을 수정하십시오.
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
server/lang/ 언어 컴파일러: inform, as, hrscript, rapid, krl (+ 공용 수식 파서 expr.js)
server/protocols/  통신 서버 5종 + 필드버스(Modbus TCP, OPC UA)
public/      웹 UI (Three.js 3D 뷰, 에디터, 패널)
tools/       샘플 통신 클라이언트, 예제 내보내기
test/        자동 테스트
docs/DEV_CONTRACT.md  언어·통신 모듈 개발 규약 (새 제조사·언어 추가 시 참고)
```
