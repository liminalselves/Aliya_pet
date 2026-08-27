#pragma once

/**
 * 渲染后端统一抽象。
 *
 * 后端选择由编译宏决定（在 CMake 中设置）：
 *   ALIYA_RENDERER_D3D11   —— Windows：DirectX 11 + WIC（默认）
 *   ALIYA_RENDERER_OPENGLES —— Android：OpenGL ES 2.0 + Dart 侧 PNG 解码上传
 *
 * 本头文件提供平台无关的类型别名，上层模块（model/host）只需引用
 * AliyaRenderer / AliyaTextureHandle，不直接依赖具体渲染 API。
 */

#if defined(ALIYA_RENDERER_OPENGLES)
#  define ALIYA_BACKEND_OPENGLES 1
#else
#  define ALIYA_BACKEND_D3D11 1
#endif

#if defined(ALIYA_BACKEND_D3D11)
#  include <d3d11.h>
#  include "Rendering/D3D11/CubismRenderer_D3D11.hpp"
namespace aliya {
using AliyaRenderer = Live2D::Cubism::Framework::Rendering::CubismRenderer_D3D11;
using AliyaTextureHandle = ID3D11ShaderResourceView*;
}
#elif defined(ALIYA_BACKEND_OPENGLES)
#  include <GLES2/gl2.h>
#  include <GLES2/gl2ext.h>
#  include "Rendering/OpenGL/CubismRenderer_OpenGLES2.hpp"
namespace aliya {
using AliyaRenderer = Live2D::Cubism::Framework::Rendering::CubismRenderer_OpenGLES2;
using AliyaTextureHandle = GLuint;
}
#endif
