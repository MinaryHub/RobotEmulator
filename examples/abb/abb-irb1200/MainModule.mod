MODULE MainModule
  !=====================================================================
  ! IRB 1200-5/0.9 픽 앤 플레이스 예제 (RobotEmulator 자동 생성)
  ! 그리퍼: Robotiq 2F-85 Adaptive
  ! IO: DO1=그리퍼 닫기, DO2=그리퍼 열기, DI1=닫힘 확인, DI2=열림 확인
  !=====================================================================
  PERS tooldata tGripper:=[TRUE,[[0,0,150],[1,0,0,0]],[0.93,[0,0,75],[1,0,0,0],0,0,0]];
  CONST jointtarget jHome:=[[0,0,0,0,90,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];
  CONST num nParts:=4;
  CONST num nApproach:=100;
  ! 공작물 집는 위치 (TCP, 공작물 중심)
  CONST robtarget pPick{4}:=[
    [[495.55,-270.3,20],[0,0,1,0],[-1,0,-1,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]],
    [[495.55,-90.1,20],[0,0,1,0],[-1,0,-1,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]],
    [[495.55,90.1,20],[0,0,1,0],[0,0,0,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]],
    [[495.55,270.3,20],[0,0,1,0],[0,0,0,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]]];
  ! 공작물 내려놓는 위치
  CONST robtarget pPlace{4}:=[
    [[648.72,-270.3,20],[0,0,1,0],[-1,0,-1,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]],
    [[648.72,-90.1,20],[0,0,1,0],[-1,0,-1,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]],
    [[648.72,90.1,20],[0,0,1,0],[0,0,0,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]],
    [[648.72,270.3,20],[0,0,1,0],[0,0,0,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]]];
  CONST speeddata vApproach:=[200,500,5000,1000];
  VAR num nCount:=0;

  PROC main()
    rInit;
    FOR i FROM 1 TO nParts DO
      rPick pPick{i};
      rPlace pPlace{i};
      Incr nCount;
      TPWrite "완료된 공작물 수: "\Num:=nCount;
    ENDFOR
    MoveAbsJ jHome, v1000, fine, tGripper;
    TPWrite "사이클 완료";
  ENDPROC

  PROC rInit()
    ConfJ \On;
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
