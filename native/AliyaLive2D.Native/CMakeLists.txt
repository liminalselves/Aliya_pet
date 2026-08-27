cmake_minimum_required(VERSION 3.16)

# Aliya Live2D Native 模块（Cubism SDK for Native 5-r.5）
# 跨平台双后端：
#   - Windows (MSVC):  DirectX 11 渲染器（默认）
#   - Android (NDK):   OpenGL ES 2.0 渲染器（-DALIYA_RENDERER=OpenGLES）
project(AliyaLive2D.Native LANGUAGES CXX)

# 渲染后端选择：D3D11（Windows）/ OpenGLES（Android）
set(ALIYA_RENDERER "D3D11" CACHE STRING "Render backend: D3D11 (Windows) or OpenGLES (Android)")
if(ANDROID)
  set(ALIYA_RENDERER "OpenGLES")
endif()

option(CORE_CRL_MD "Use Cubism Core that is multithread-specific and DLL-specific version" OFF)

set(SDK_ROOT_PATH ${CMAKE_CURRENT_SOURCE_DIR}/../../third_party/CubismSdkForNative-5-r.5)
set(CORE_PATH ${SDK_ROOT_PATH}/Core)
set(FRAMEWORK_PATH ${SDK_ROOT_PATH}/Framework)

# 输出目录
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}/bin/${PROJECT_NAME})
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}/bin/${PROJECT_NAME})
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}/lib/${PROJECT_NAME})
set(CMAKE_CONFIGURATION_TYPES Debug Release CACHE STRING "Configurations" FORCE)
set(CMAKE_SUPPRESS_REGENERATION ON)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT ANDROID)
  # 架构检测（仅 Windows 需要；Android 由 NDK ABI 决定）
  if(CMAKE_GENERATOR_PLATFORM STREQUAL "x64" OR CMAKE_SIZEOF_VOID_P EQUAL 8)
    set(ARCH x86_64)
  else()
    message(FATAL_ERROR "AliyaLive2D.Native 仅支持 x64 构建。")
  endif()

  # 编译器检测（仅支持 MSVC 2022, toolset 143）
  if(MSVC_VERSION GREATER_EQUAL 1930 AND MSVC_VERSION LESS 1950)
    set(COMPILER 143)
    set(MSVC_YEAR 2022)
  elseif(MSVC)
    message(FATAL_ERROR "Unsupported MSVC version: ${MSVC_VERSION}. 需要 VS2022 (toolset 143)。")
  else()
    message(FATAL_ERROR "Unsupported compiler. 需要 MSVC。")
  endif()
endif()

# Cubism Core 导入库（平台分支；Core 闭源，需从 Live2D 官网 SDK 包获取）
if(ANDROID)
  # 官方 SDK 包：Core/dll/android/<ABI>/libLive2DCubismCore.so（动态库）
  add_library(Live2DCubismCore SHARED IMPORTED)
  set_target_properties(Live2DCubismCore
    PROPERTIES
      IMPORTED_LOCATION ${CORE_PATH}/dll/android/${ANDROID_ABI}/libLive2DCubismCore.so
      INTERFACE_INCLUDE_DIRECTORIES ${CORE_PATH}/include
  )
else()
  # Windows：使用 DLL 导入库（运行时加载 Live2DCubismCore.dll）
  add_library(Live2DCubismCore STATIC IMPORTED)
  set_target_properties(Live2DCubismCore
    PROPERTIES
      IMPORTED_LOCATION ${CORE_PATH}/dll/windows/x86_64/Live2DCubismCore.lib
      INTERFACE_INCLUDE_DIRECTORIES ${CORE_PATH}/include
  )
endif()

# Cubism Framework 渲染器选择
if(ALIYA_RENDERER STREQUAL "OpenGLES")
  set(FRAMEWORK_SOURCE OpenGL)
else()
  set(FRAMEWORK_SOURCE D3D11)
endif()
add_subdirectory(${FRAMEWORK_PATH} ${CMAKE_CURRENT_BINARY_DIR}/Framework)

if(ANDROID)
  target_compile_definitions(Framework PRIVATE CSM_TARGET_ANDROID_ES2)
  target_link_libraries(Framework
    Live2DCubismCore
    android
    log
    GLESv2
    EGL
  )
else()
  target_compile_definitions(Framework PRIVATE CSM_TARGET_WIN_D3D11)
  target_link_libraries(Framework
    Live2DCubismCore
    d3d11.lib
    d3dcompiler.lib
  )
endif()

# 我们自己的 Native 库
add_library(AliyaLive2D.Native SHARED
  src/aliya_live2d.h
  src/render_backend.h
  src/native_log.hpp
  src/native_log.cpp
  src/live2d_asset_loader.hpp
  src/live2d_asset_loader.cpp
  src/live2d_device_manager.hpp
  src/live2d_device_manager.cpp
  src/live2d_parameter_controller.hpp
  src/live2d_parameter_controller.cpp
  src/live2d_action_library.hpp
  src/live2d_action_library.cpp
  src/live2d_action_player.hpp
  src/live2d_action_player.cpp
  src/live2d_model.hpp
  src/live2d_model.cpp
  src/live2d_host.hpp
  src/live2d_host.cpp
  src/native_exports.cpp
)

target_include_directories(AliyaLive2D.Native
  PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CORE_PATH}/include
    ${FRAMEWORK_PATH}/src
)

target_compile_definitions(AliyaLive2D.Native
  PRIVATE
    ALIYA_LIVE2D_NATIVE_EXPORTS
)

if(ANDROID)
  target_compile_definitions(AliyaLive2D.Native
    PRIVATE
      ALIYA_RENDERER_OPENGLES
      CSM_TARGET_ANDROID_ES2
  )
  target_link_libraries(AliyaLive2D.Native
    Framework
    Live2DCubismCore
    android
    log
    GLESv2
    EGL
  )
else()
  target_compile_definitions(AliyaLive2D.Native
    PRIVATE
      NOMINMAX
      WIN32_LEAN_AND_MEAN
      CSM_TARGET_WIN_D3D11
  )
  target_link_libraries(AliyaLive2D.Native
    Framework
    Live2DCubismCore
    d3d11.lib
    d3dcompiler.lib
    dxgi.lib
    windowscodecs.lib
    ole32.lib
  )
  # 源码为 UTF-8（含中文/日文注释），强制 MSVC 按 UTF-8 解析；生成 PDB
  target_compile_options(AliyaLive2D.Native PRIVATE /MP /W3 /utf-8)
  set(CMAKE_CXX_FLAGS_RELEASE "${CMAKE_CXX_FLAGS_RELEASE} /Zi")
  set(CMAKE_SHARED_LINKER_FLAGS_RELEASE "${CMAKE_SHARED_LINKER_FLAGS_RELEASE} /DEBUG")
  set(CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS_DEBUG} /Zi")
  set(CMAKE_SHARED_LINKER_FLAGS_DEBUG "${CMAKE_SHARED_LINKER_FLAGS_DEBUG} /DEBUG")
endif()

# 复制 Live2DCubismCore 到输出目录
if(ANDROID)
  # Android 静态链接，无需复制
else()
  add_custom_command(
    TARGET AliyaLive2D.Native
    POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      ${CORE_PATH}/dll/windows/x86_64/Live2DCubismCore.dll
      $<TARGET_FILE_DIR:AliyaLive2D.Native>/Live2DCubismCore.dll
    COMMENT "复制 Live2DCubismCore.dll"
  )
endif()


# ---- 诊断测试可执行文件（仅 Windows） ----
if(NOT ANDROID)
  # idle_diagnostics_test: 待机动画 / 呼吸 / 物理 测试
  add_executable(idle_diagnostics_test
    tests/idle_diagnostics_test.cpp
  )
  target_include_directories(idle_diagnostics_test
    PRIVATE
      ${CMAKE_CURRENT_SOURCE_DIR}/src
      ${CORE_PATH}/include
  )
  target_compile_definitions(idle_diagnostics_test PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
    target_link_libraries(idle_diagnostics_test
    AliyaLive2D.Native
  )

  # smoke_test: 原有冒烟测试
  add_executable(smoke_test
    tests/aliya_smoke.cpp
  )
  target_include_directories(smoke_test
    PRIVATE
      ${CMAKE_CURRENT_SOURCE_DIR}/src
      ${CORE_PATH}/include
      ${FRAMEWORK_PATH}/src
  )
  target_compile_definitions(smoke_test PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
    target_link_libraries(smoke_test
    AliyaLive2D.Native
  )

  # diag_defaults: 默认参数诊断
  add_executable(diag_defaults
    tests/diag_defaults.cpp
  )
  target_include_directories(diag_defaults
    PRIVATE
      ${CMAKE_CURRENT_SOURCE_DIR}/src
      ${CORE_PATH}/include
  )
  target_compile_definitions(diag_defaults PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
    target_link_libraries(diag_defaults
    AliyaLive2D.Native
  )
endif()
