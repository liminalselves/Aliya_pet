cmake_minimum_required(VERSION 3.16)

# Aliya Live2D Native 模块（Cubism SDK for Native 5-r.5 + DirectX 11）
project(AliyaLive2D.Native LANGUAGES CXX)

option(CORE_CRL_MD "Use Cubism Core that is multithread-specific and DLL-specific version" OFF)

set(SDK_ROOT_PATH ${CMAKE_CURRENT_SOURCE_DIR}/../../third_party/CubismSdkForNative-5-r.5)
set(CORE_PATH ${SDK_ROOT_PATH}/Core)
set(FRAMEWORK_PATH ${SDK_ROOT_PATH}/Framework)
set(FRAMEWORK_SHADER_PATH ${FRAMEWORK_PATH}/src/Rendering/D3D11/Shaders)

# 输出目录
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}/bin/${PROJECT_NAME})
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}/bin/${PROJECT_NAME})
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}/lib/${PROJECT_NAME})
set(CMAKE_CONFIGURATION_TYPES Debug Release CACHE STRING "Configurations" FORCE)
set(CMAKE_SUPPRESS_REGENERATION ON)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# 生成调试符号（PDB）以便崩溃分析
set(CMAKE_CXX_FLAGS_RELEASE "${CMAKE_CXX_FLAGS_RELEASE} /Zi")
set(CMAKE_SHARED_LINKER_FLAGS_RELEASE "${CMAKE_SHARED_LINKER_FLAGS_RELEASE} /DEBUG")
set(CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS_DEBUG} /Zi")
set(CMAKE_SHARED_LINKER_FLAGS_DEBUG "${CMAKE_SHARED_LINKER_FLAGS_DEBUG} /DEBUG")

# 源码为 UTF-8（含中文/日文注释），强制 MSVC 按 UTF-8 解析
if(MSVC)
  add_compile_options(/utf-8)
endif()

# 架构检测
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

if(CORE_CRL_MD)
  set(CRT MD)
else()
  set(CRT MT)
endif()

# Cubism Core：使用 DLL 导入库（运行时加载 Live2DCubismCore.dll）
add_library(Live2DCubismCore STATIC IMPORTED)
set_target_properties(Live2DCubismCore
  PROPERTIES
    IMPORTED_LOCATION ${CORE_PATH}/dll/windows/x86_64/Live2DCubismCore.lib
    INTERFACE_INCLUDE_DIRECTORIES ${CORE_PATH}/include
)

# Cubism Framework（D3D11 渲染器）
set(FRAMEWORK_SOURCE D3D11)
add_subdirectory(${FRAMEWORK_PATH} ${CMAKE_CURRENT_BINARY_DIR}/Framework)

target_link_libraries(Framework
  Live2DCubismCore
  d3d11.lib
  d3dcompiler.lib
)

# 我们的 Native DLL
add_library(AliyaLive2D.Native SHARED
  src/aliya_live2d.h
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
    NOMINMAX
    WIN32_LEAN_AND_MEAN
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

target_compile_options(AliyaLive2D.Native PRIVATE /MP /W3)

# 复制 Live2DCubismCore.dll 到输出目录
add_custom_command(
  TARGET AliyaLive2D.Native
  POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    ${CORE_PATH}/dll/windows/x86_64/Live2DCubismCore.dll
    $<TARGET_FILE_DIR:AliyaLive2D.Native>/Live2DCubismCore.dll
  COMMENT "复制 Live2DCubismCore.dll"
)






# ---- 诊断测试可执行文件 ----
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
