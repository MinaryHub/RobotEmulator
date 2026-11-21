// nodejs-mobile 의 libnode.so 를 앱 프로세스 안에서 실행하는 JNI 진입점
//  - node::Start(argc, argv) 는 이벤트 루프가 끝날 때까지 돌아오지 않으므로 Java 쪽 별도 스레드에서 호출
//  - Node 의 stdout/stderr 를 logcat 으로 보냄 (태그 RobotEmulator-node)
// 참고: https://github.com/nodejs-mobile/nodejs-mobile (MIT) 샘플의 구조를 따름
#include <jni.h>
#include <cstdlib>
#include <cstring>
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>
#include "node.h"

static const char *TAG = "RobotEmulator-node";
static int pipeOut[2], pipeErr[2];

static void *pump(void *arg) {
  const int fd = static_cast<int>(reinterpret_cast<intptr_t>(arg));
  const int prio = fd == pipeErr[0] ? ANDROID_LOG_ERROR : ANDROID_LOG_INFO;
  char buf[2048];
  ssize_t n;
  while ((n = read(fd, buf, sizeof buf - 1)) > 0) {
    if (buf[n - 1] == '\n') --n;
    buf[n] = 0;
    __android_log_write(prio, TAG, buf);
  }
  return nullptr;
}

static void redirectStdio() {
  setvbuf(stdout, nullptr, _IONBF, 0);
  setvbuf(stderr, nullptr, _IONBF, 0);
  if (pipe(pipeOut) == 0) dup2(pipeOut[1], STDOUT_FILENO);
  if (pipe(pipeErr) == 0) dup2(pipeErr[1], STDERR_FILENO);
  pthread_t t1, t2;
  if (pthread_create(&t1, nullptr, pump, reinterpret_cast<void *>(static_cast<intptr_t>(pipeOut[0]))) == 0) pthread_detach(t1);
  if (pthread_create(&t2, nullptr, pump, reinterpret_cast<void *>(static_cast<intptr_t>(pipeErr[0]))) == 0) pthread_detach(t2);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_minaryhub_robotemulator_MainActivity_startNodeWithArguments(JNIEnv *env, jobject /*thiz*/, jobjectArray arguments) {
  const jsize argc = env->GetArrayLength(arguments);
  // libuv 는 argv 가 연속된 메모리에 있다고 가정하므로 한 버퍼에 이어 붙인다
  size_t total = 0;
  for (jsize i = 0; i < argc; i++) {
    auto s = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
    const char *c = env->GetStringUTFChars(s, nullptr);
    total += strlen(c) + 1;
    env->ReleaseStringUTFChars(s, c);
  }
  char *buffer = static_cast<char *>(calloc(total, 1));
  char **argv = static_cast<char **>(calloc(argc + 1, sizeof(char *)));
  char *p = buffer;
  for (jsize i = 0; i < argc; i++) {
    auto s = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
    const char *c = env->GetStringUTFChars(s, nullptr);
    strcpy(p, c);
    argv[i] = p;
    p += strlen(c) + 1;
    env->ReleaseStringUTFChars(s, c);
  }
  redirectStdio();
  return static_cast<jint>(node::Start(static_cast<int>(argc), argv));
}
