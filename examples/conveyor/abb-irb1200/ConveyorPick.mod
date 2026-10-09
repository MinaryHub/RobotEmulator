MODULE ConveyorPick
  !=====================================================================
  ! 컨베이어 픽 앤 플레이스 예제 — IRB 1200-5/0.9 + Robotiq 2F-85
  ! 셀 탭에서 프리셋 "컨베이어 픽 앤 플레이스" 를 적용한 뒤 실행하십시오.
  !  - 피더가 컨베이어 시작점에 공작물을 배출, 컨베이어가 끝단 스토퍼까지 이송
  !  - 스토퍼 도착 센서(DI9) ON 을 기다렸다가 집어서 테이블 위 2열 격자(팔레트 PL1)에 적재
  ! IO: DO1=그리퍼 닫기, DO2=그리퍼 열기, DI1=닫힘 확인, DI2=열림 확인
  !     DO9=컨베이어 운전, DI9=스토퍼 도착 센서
  !=====================================================================
  PERS tooldata tGripper:=[TRUE,[[0,0,150],[1,0,0,0]],[0.93,[0,0,75],[1,0,0,0],0,0,0]];
  CONST jointtarget jHome:=[[0,0,0,0,90,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];
  CONST num nParts:=4;
  CONST num nCols:=2;
  CONST num nPitch:=135.15;
  CONST num nApproach:=100;
  ! 스토퍼에 닿은 공작물 중심 (벨트 윗면 z=0, 공작물 40mm)
  CONST robtarget pPick:=[[450.5,-398.42,20],[0,0,1,0],[0,0,0,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];
  ! 적재 격자 첫 슬롯 (1mm 위에서 놓음)
  CONST robtarget pPlace0:=[[450.5,0,21],[0,0,1,0],[0,0,0,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];
  CONST speeddata vApproach:=[200,500,5000,1000];
  VAR num nCount:=0;
  VAR num nCol:=0;
  VAR num nRow:=0;
  VAR robtarget pPlace;

  PROC main()
    rInit;
    SetDO DO9, 1;
    FOR i FROM 0 TO nParts - 1 DO
      WaitDI DI9, 1\MaxTime:=30;
      rPick pPick;
      nCol:=i MOD nCols;
      nRow:=i DIV nCols;
      pPlace:=Offs(pPlace0, nCol * nPitch, nRow * nPitch, 0);
      rPlace pPlace;
      Incr nCount;
      TPWrite "적재 완료: "\Num:=nCount;
    ENDFOR
    SetDO DO9, 0;
    MoveAbsJ jHome, v1000, fine, tGripper;
    TPWrite "컨베이어 사이클 완료";
  ENDPROC

  PROC rInit()
    ConfJ \Off;
    ConfL \Off;
    VelSet 100, 7000;
    nCount:=0;
    rGripOpen;
    MoveAbsJ jHome, v1000, fine, tGripper;
  ENDPROC

  PROC rPick(robtarget pTarget)
    MoveJ Offs(pTarget,0,0,nApproach), v1000, z50, tGripper\WObj:=wobj0;
    MoveL pTarget, vApproach, fine, tGripper\WObj:=wobj0;
    rGripClose;
    MoveL Offs(pTarget,0,0,nApproach), v500, z10, tGripper\WObj:=wobj0;
  ENDPROC

  PROC rPlace(robtarget pTarget)
    MoveJ Offs(pTarget,0,0,nApproach), v1000, z50, tGripper\WObj:=wobj0;
    MoveL pTarget, vApproach, fine, tGripper\WObj:=wobj0;
    rGripOpen;
    MoveL Offs(pTarget,0,0,nApproach), v500, z10, tGripper\WObj:=wobj0;
  ENDPROC

  PROC rGripClose()
    SetDO DO2, 0;
    SetDO DO1, 1;
    WaitDI DI1, 1\MaxTime:=5;
    WaitTime 0.2;
  ENDPROC

  PROC rGripOpen()
    SetDO DO1, 0;
    SetDO DO2, 1;
    WaitDI DI2, 1\MaxTime:=5;
    SetDO DO2, 0;
    WaitTime 0.2;
  ENDPROC
ENDMODULE
