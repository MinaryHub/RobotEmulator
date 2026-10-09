.******************************************
.** pickplace.as  — Kawasaki AS 예제 (RS007N)
.** 공작물 4개를 차례로 집어 X=548 열로 옮긴다
.** DO1(OX1)=그리퍼 닫기, DO2(OX2)=열기, DI1(1001)=닫힘, DI2(1002)=열림, DI3(1003)=공작물 감지
.******************************************
.PROGRAM main()
  ; 메인: pick & place 사이클
  ACCURACY 1 ALWAYS
  SPEED 100 ALWAYS
  count = 0
  HOME
  CALL grip_open
  JMOVE #standby
  FOR i = 0 TO n_work-1
    POINT .pk = SHIFT(pick BY 0, i*pitch, 0)
    POINT .pl = SHIFT(place BY 0, i*pitch, 0)
    CALL pick_place(.pk, .pl)
  END
  JMOVE #standby
  HOME
  PRINT $msg, count, " 개 완료"
.END
.PROGRAM pick_place(.src, .dst)
  ; .src 위치의 공작물을 집어 .dst 에 내려놓는다
  JAPPRO .src, appro
  SPEED 30
  LMOVE .src
  BREAK
  CALL grip_close
  IF SIG(-1003) THEN
    PRINT "경고: 공작물이 감지되지 않음"
  END
  SPEED 50
  LDEPART appro
  JAPPRO .dst, appro
  SPEED 30
  LMOVE .dst
  BREAK
  CALL grip_open
  LDEPART appro
  count = count + 1
.END
.PROGRAM grip_close()
  SIGNAL 1, -2      ; 닫기 ON, 열기 OFF
  SWAIT 1001        ; 닫힘 확인
  TWAIT 0.2
.END
.PROGRAM grip_open()
  SIGNAL -1, 2      ; 닫기 OFF, 열기 ON
  SWAIT 1002        ; 열림 확인
  TWAIT 0.1
.END
.TRANS
pick 401.500 -219.000 17.500 0.000 180.000 0.000
place 548.000 -219.000 17.500 0.000 180.000 0.000
.END
.JOINTS
#standby 0.000 24.455 -94.606 0.000 -60.939 0.000
.END
.REALS
n_work = 4
pitch = 146.000
appro = 90
count = 0
.END
.STRINGS
$msg = "PICK&PLACE: "
.END
