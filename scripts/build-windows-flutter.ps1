# =========================================================
# Aliya Pet 一键构建脚本（Windows）
# 用法：.\scripts\build-windows-flutter.ps1 [-Release]
# 前置：third_party/CubismSdkForNative-5-r.5/Core 已放置（官网下载）
# =========================================================
param(
    [switch]$SkipInstaller,
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)
$ErrorActionPreference = 'Stop'

Write-Host "==> [1/4] 构建 Live2D Native 内核 (D3D11) ..."
$cmake = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
if (-not (Test-Path $cmake)) {
    $cmake = 'cmake'
}
$native = Join-Path $ProjectRoot 'native\AliyaLive2D.Native'
$nativeBuild = Join-Path $ProjectRoot 'build\native-x64-release'
& $cmake -S $native -B $nativeBuild -G "Visual Studio 17 2022" -A x64 -DCMAKE_CONFIGURATION_TYPES=Release 2>&1 | Out-Host
& $cmake --build $nativeBuild --config Release 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { throw "Native 构建失败" }

Write-Host "==> [2/4] 构建 Flutter Windows 应用 ..."
& flutter build windows --release 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { throw "Flutter 构建失败" }

Write-Host "==> [3/4] 复制 Native DLL 到发布目录 ..."
$flutterRelease = Join-Path $ProjectRoot 'flutter\build\windows\x64\runner\Release'
$dllDir = Join-Path $nativeBuild 'bin\AliyaLive2D.Native\Release'
Copy-Item -Force (Join-Path $dllDir 'AliyaLive2D.Native.dll') $flutterRelease
Copy-Item -Force (Join-Path $dllDir 'Live2DCubismCore.dll') $flutterRelease
Write-Host "DLL 已复制到 $flutterRelease"

if ($SkipInstaller) {
    Write-Host "==> 跳过安装包构建"
    exit 0
}

Write-Host "==> [4/4] 构建安装包 (Inno Setup) ..."
$iscc = 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe'
if (-not (Test-Path $iscc)) { throw "未找到 ISCC.exe，请安装 Inno Setup 6" }
Push-Location (Join-Path $ProjectRoot 'installer')
& $iscc 'aliya_pet.iss' 2>&1 | Out-Host
Pop-Location
if ($LASTEXITCODE -ne 0) { throw "安装包构建失败" }

Write-Host "==> 完成：installer\installer-output\AliyaDesktopPet-Setup-*.exe"
