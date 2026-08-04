# Aliya Desktop Pet - Windows (Live2D)

基于 Live2D Cubism 的 Windows 桌面宠物应用。

## 技术栈

- **框架**: .NET 8.0 + WPF (Windows Presentation Foundation)
- **语言**: C# 12 / TypeScript
- **Live2D 渲染**: 原生 C++ DLL (通过 P/Invoke 调用)
- **Live2D SDK**: Cubism SDK for Native 5 (r.5)
- **Web 子项目**: Vite + TypeScript (AliyaPet.MultiFrame 中的 Live2DWeb)

## 系统要求

- Windows 10 版本 19041 (2004) 或更高
- .NET 8.0 SDK (LTS)
- Visual Studio 2022 或更高版本（推荐）
- CMake 3.20+（用于构建原生 DLL）

## 项目结构

```
windows/
├── AliyaPet/                    # 主 WPF 桌面宠物应用
│   ├── AliyaPet.csproj
│   ├── Assets/                  # 图标、音频、Live2D 模型
│   │   ├── Live2D/Aliya/        # Live2D 模型文件 (.moc3, .model3.json)
│   │   ├── dialogue/            # 对话配置
│   │   └── *.png, *.wav, *.ico
│   ├── FrameworkShaders/        # Live2D 渲染着色器
│   ├── Rendering/               # 渲染层（P/Invoke 封装）
│   ├── MainWindow.xaml(.cs)     # 主窗口
│   └── MainWindow.Live2D.cs     # Live2D 逻辑
├── AliyaLive2D.Native/          # 原生 C++ Live2D 渲染库
│   ├── CMakeLists.txt
│   ├── src/                     # 源码
│   └── tests/                   # 测试工具
└── AliyaPet.MultiFrame/         # 多帧动画版本（实验性）
    ├── AliyaPet.csproj
    ├── Assets/
    ├── Frames/                  # 逐帧动画
    ├── Live2DWeb/               # WebView2 + Live2D Web SDK
    └── Rendering/
```

## 构建命令

### 1. 构建原生 Live2D DLL

```powershell
# 需要先安装 Cubism SDK 到 third_party/CubismSdkForNative-5-r.5/
cd windows/AliyaLive2D.Native
cmake -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release
```

构建产物：
- `build/native-x64-release/bin/AliyaLive2D.Native/Release/AliyaLive2D.Native.dll`
- `build/native-x64-release/bin/AliyaLive2D.Native/Release/Live2DCubismCore.dll`

### 2. 构建 WPF 应用

```powershell
cd windows/AliyaPet
dotnet restore
dotnet build -c Release
```

### 3. 发布

```powershell
dotnet publish -c Release -r win-x64 --self-contained false
```

## 运行命令

```powershell
cd windows/AliyaPet
dotnet run -c Release
```

或直接运行发布后的 EXE：

```powershell
.\bin\Release\net8.0-windows10.0.19041.0\win-x64\publish\AliyaPet.exe
```

## 依赖说明

### 必须手动下载的依赖

1. **Live2D Cubism SDK for Native**
   - 下载地址: https://www.live2d.com/en/sdk/download/native/
   - 解压到: `third_party/CubismSdkForNative-5-r.5/`
   - 许可: Live2D Proprietary Software License（年营收超 1000 万日元的商业用户需获取 Release License）

2. **.NET 8.0 SDK**
   - 下载地址: https://dotnet.microsoft.com/download/dotnet/8.0

### NuGet 包（自动恢复）

- Microsoft.Web.WebView2 (仅 MultiFrame 版本需要)

## 已知问题

1. **原生 DLL 路径**: 项目默认从 `build/native-x64-release/bin/AliyaLive2D.Native/Release/` 加载原生 DLL。如构建路径不同，需修改 `AliyaPet.csproj` 中的 `NativeDllDir` 属性。

2. **MultiFrame 版本**: `AliyaPet.MultiFrame` 为实验性多帧动画版本，Live2DWeb 子项目需要先执行 `npm install` 和 `npm run build:prod`。

3. **TTS 功能**: 应用内置 TTS（文字转语音）功能，API 密钥通过本地配置文件加载，**不得提交到仓库**。

4. **Windows 版本兼容性**: 目标框架为 `net8.0-windows10.0.19041.0`，需要 Windows 10 2004 或更高版本。

## 许可说明

- **Live2D Cubism Core**: Live2D Proprietary Software License
  - [许可协议（英文）](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)
  - [许可协议（中文）](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_cn.html)
- **Live2D Cubism Framework**: Live2D Open Software License
  - [许可协议（英文）](https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html)

## 安全提醒

- **禁止提交** API Key、Access Token、TTS 密钥等敏感信息
- 配置文件使用 `appsettings.example.json` 模板，实际密钥通过环境变量或本地配置加载
- `.gitignore` 已排除 `bin/`、`obj/`、`publish/`、`build/`、`third_party/` 等目录
