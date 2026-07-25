# 桌面宠物 · Glassmorphism React 风格分支

该目录是独立的 React + Tailwind CSS 移动端界面，不修改现有 Android 或 Windows 实现。

```powershell
npm install
npm run dev
```

生产构建：

```powershell
npm run build
```

Android APK：

```powershell
npm run build:apk
```

APK 使用独立包名 `com.miqi.aliyapet.glass`，可与原生版同时安装，并通过 WebView 原生桥接
控制悬浮窗服务；角色展示区支持左右滑动切换 Aliya/Windy。
