# nodejs-mobile libnode.so (android/libnode — tools/package.js android 가 내려받아 풀어 둠)
LOCAL_PATH := $(call my-dir)
LIBNODE := $(LOCAL_PATH)/../../../../libnode

include $(CLEAR_VARS)
LOCAL_MODULE := node
LOCAL_SRC_FILES := $(LIBNODE)/bin/$(TARGET_ARCH_ABI)/libnode.so
LOCAL_EXPORT_C_INCLUDES := $(LIBNODE)/include/node
include $(PREBUILT_SHARED_LIBRARY)

include $(CLEAR_VARS)
LOCAL_MODULE := native-lib
LOCAL_SRC_FILES := native-lib.cpp
LOCAL_SHARED_LIBRARIES := node
LOCAL_LDLIBS := -llog
LOCAL_CPPFLAGS := -std=c++17 -fexceptions
include $(BUILD_SHARED_LIBRARY)
