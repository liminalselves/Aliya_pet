param(
    [string]$NativeDllDir = ""
)
$ErrorActionPreference = "Stop"

$projectDir = $PSScriptRoot
$publishDir = Join-Path $projectDir "installer-publish"
$isccCandidates = @(
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
)
$iscc = $isccCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not $iscc) {
    throw "未找到 Inno Setup 6，请先安装后重新运行。"
}

dotnet publish (Join-Path $projectDir "AliyaPet.csproj") `
    -c Release `
    -r win-x64 `
    --self-contained true `
    -o $publishDir `
    /p:PublishSingleFile=true `
    /p:IncludeNativeLibrariesForSelfExtract=true `
    /p:DebugType=None `
    /p:DebugSymbols=false

if ($LASTEXITCODE -ne 0) {
    throw "程序发布失败，退出码：$LASTEXITCODE"
}

# 兜底复制 Native DLL 到发布目录（全新工作树无 ..\build 时 csproj 的
# CopyNativeDllsToPublish 不执行，导致安装包缺 AliyaLive2D.Native.dll，Live2D 无法加载）。
if (-not $NativeDllDir -or -not (Test-Path (Join-Path $NativeDllDir "AliyaLive2D.Native.dll"))) {
    $NativeDllDir = Join-Path $projectDir "..\build\native-x64-release\bin\AliyaLive2D.Native\Release"
}
if (Test-Path (Join-Path $NativeDllDir "AliyaLive2D.Native.dll")) {
    Copy-Item (Join-Path $NativeDllDir "AliyaLive2D.Native.dll") $publishDir -Force
    Copy-Item (Join-Path $NativeDllDir "Live2DCubismCore.dll") $publishDir -Force
    Write-Host "已复制 Native DLL 到 $publishDir"
} else {
    Write-Host "警告: 未找到 Native DLL 目录 $NativeDllDir"
}

# 加密 Assets → assets.enc 并删除明文（安装包内不保留明文资源）。
# 注意：单文件 publish（PublishSingleFile）会丢失 Assets\Live2D\Aliya\16.1024 纹理目录，
# 故加密打包改用完整源 Assets 目录（windows\Assets），再删除 publish 输出的残缺明文。
$encryptScript = Join-Path (Split-Path -Parent $PSScriptRoot) "scripts\encrypt-assets.ps1"
if (-not (Test-Path $encryptScript)) {
    throw "未找到加密脚本: $encryptScript"
}
& $encryptScript `
    -AssetsDir (Join-Path $projectDir "Assets") `
    -OutputFile (Join-Path $publishDir "assets.enc")
if ($LASTEXITCODE -ne 0) {
    throw "资源加密失败，退出码：$LASTEXITCODE"
}
# 删除 publish 输出的明文 Assets（程序运行时从 assets.enc 解密，不留明文）
$publishAssets = Join-Path $publishDir "Assets"
if (Test-Path $publishAssets) {
    Remove-Item $publishAssets -Recurse -Force
    Write-Host "已删除明文: $publishAssets"
}

& $iscc (Join-Path $projectDir "installer.iss")

if ($LASTEXITCODE -ne 0) {
    throw "安装器编译失败，退出码：$LASTEXITCODE"
}
