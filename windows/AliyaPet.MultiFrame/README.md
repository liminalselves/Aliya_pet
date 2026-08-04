# Aliya 多帧桌宠

这是与原版并列的独立 Windows WPF 项目，不会修改 `windows/AliyaPet`。

## 帧目录

程序按状态子目录中的文件名顺序播放透明 PNG：

```text
Frames/Aliya/idle/001.png
Frames/Aliya/idle/002.png
Frames/Windy/001.png
Frames/Windy/002.png
```

拖动时序列帧暂停，人物只向当前水平拖动方向轻微倾斜，松开后恢复待机。
待机每轮第 1 帧停留 1200 ms，其余帧各停留 160 ms。没有 `idle` 目录的角色会继续使用角色根目录帧。

## 构建

```powershell
dotnet build .\AliyaPet.csproj -c Release
.\build-exe.ps1
```

发布产物位于：

```text
bin/Release/net8.0-windows/win-x64/publish/AliyaPet.MultiFrame.exe
```

发布目录中的 `Frames` 可替换为自己的序列帧；即使该目录丢失，程序也会使用 EXE 内置的两帧素材。
