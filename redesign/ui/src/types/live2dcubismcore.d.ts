/**
 * 【过渡占位】Cubism Core for Web 类型声明。
 *
 * 官方完整版 live2dcubismcore.d.ts 随 CubismSdkForWeb（官网 zip）发布于
 * Core/dll/ 目录；GitHub 仓库因许可原因不含此文件。
 * 本文件仅声明 Framework 引用到的符号（宽松 any），保证 tsc 可编译。
 * 拿到官方 SDK zip 后请用官方 .d.ts 覆盖本文件，恢复严格类型检查。
 */
declare namespace Live2DCubismCore {
  // ---- 核心类（值 + 类型双声明） ----
  const Moc: any;
  type Moc = any;
  const Model: any;
  type Model = any;
  const Utils: any;
  type Utils = any;
  const Version: any;
  type Version = any;
  const Memory: any;
  type Memory = any;
  const Logging: any;
  type Logging = any;

  // ---- 函数/枚举类型 ----
  type csmLogFunction = (message: string) => void;
  type csmParameterType = any;

  // ---- 混合模式枚举常量 ----
  const ColorBlendType_Normal: number;
  const ColorBlendType_Add: number;
  const ColorBlendType_AddCompatible: number;
  const ColorBlendType_AddGlow: number;
  const ColorBlendType_Multiply: number;
  const ColorBlendType_MultiplyCompatible: number;
  const ColorBlendType_Screen: number;
  const ColorBlendType_Overlay: number;
  const ColorBlendType_Darken: number;
  const ColorBlendType_Lighten: number;
  const ColorBlendType_ColorDodge: number;
  const ColorBlendType_ColorBurn: number;
  const ColorBlendType_HardLight: number;
  const ColorBlendType_SoftLight: number;
  const ColorBlendType_Hue: number;
  const ColorBlendType_Color: number;
  const ColorBlendType_LinearBurn: number;
  const ColorBlendType_LinearLight: number;
}
