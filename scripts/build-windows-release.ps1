# =========================================================
# Aliya Pet Windows Release x64 干净构建脚本
#  1. 清理构建目录
#  2. 构建 Native Live2D 模块 (Release x64)
#  3. 同步 Live2D 模型资源 + FrameworkShaders
#  4. 发布主程序 (dotnet publish, win-x64)
#  5. 复制 Native DLL / Core DLL / 资源到发布目录
#  6. 输出清单
# =========================================================
param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$SkipClean,
    [switch]$SkipNative
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Stage($msg) { Write-Host "`n==== $msg ====" -ForegroundColor Cyan }
function Fail($msg) { Write-Error $msg; exit 1 }

$logDir = Join-Path $ProjectRoot 'build\logs'
$nativeBuildDir = Join-Path $ProjectRoot 'build\native-x64-release'
$publishDir = Join-Path $ProjectRoot 'build\publish\AliyaPet-win-x64'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$vcvars = 'E:\AliyaLive2DToolchain\VS2022\VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) { Fail "找不到 vcvars64.bat: $vcvars" }

$nativeSrc = Join-Path $ProjectRoot 'windows\AliyaLive2D.Native'
$managedProj = Join-Path $ProjectRoot 'windows\AliyaPet\AliyaPet.csproj'

# ---------- 1. 清理 ----------
if (-not $SkipClean) {
    Write-Stage '清理旧构建产物'
    $cleanTargets = @(
        (Join-Path $managedProj '..\bin'),
        (Join-Path $managedProj '..\obj'),
        $publishDir
    )
    if (-not $SkipNative) { $cleanTargets += $nativeBuildDir }
    foreach ($p in $cleanTargets) {
        if (Test-Path $p) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }
    }
    Write-Host "已清理: $publishDir"
}

# ---------- 2. Native 构建 ----------
if (-not $SkipNative) {
    Write-Stage '构建 Native Live2D 模块 (Release x64)'
    $nativeLog = Join-Path $logDir 'cmake-configure-native.log'
    & cmd /c "`"$vcvars`" >nul 2>&1 && cmake -S `"$nativeSrc`" -B `"$nativeBuildDir`" -G `"Visual Studio 17 2022`" -A x64 -DCMAKE_CONFIGURATION_TYPES=Release 2>&1" | Tee-Object -FilePath $nativeLog
    if ($LASTEXITCODE -ne 0) { Fail "CMake 配置失败，日志: $nativeLog" }

    $buildLog = Join-Path $logDir 'cmake-build-native.log'
    & cmd /c "`"$vcvars`" >nul 2>&1 && cmake --build `"$nativeBuildDir`" --config Release 2>&1" | Tee-Object -FilePath $buildLog
    if ($LASTEXITCODE -ne 0) { Fail "Native 构建失败，日志: $buildLog" }
    Write-Host "Native DLL: $nativeBuildDir\bin\AliyaLive2D.Native\Release\AliyaLive2D.Native.dll"
}

# ---------- 3. 同步资源 ----------
Write-Stage '同步 Live2D 模型资源与 FrameworkShaders'
& (Join-Path $PSScriptRoot 'sync-live2d-windows.ps1') -ProjectRoot $ProjectRoot

# ---------- 4. 发布主程序 ----------
Write-Stage '发布主程序 (dotnet publish win-x64)'
$publishLog = Join-Path $logDir 'dotnet-publish.log'
& dotnet restore $managedProj -r win-x64 -p:RestoreSources="$env:USERPROFILE\.nuget\packages" -p:NuGetAudit=false 2>&1 | Tee-Object -FilePath (Join-Path $logDir 'dotnet-restore.log')
if ($LASTEXITCODE -ne 0) { Fail 'dotnet restore 失败' }

& dotnet publish $managedProj -c Release -r win-x64 --self-contained false -p:NuGetAudit=false --no-restore 2>&1 | Tee-Object -FilePath $publishLog
if ($LASTEXITCODE -ne 0) { Fail "dotnet publish 失败，日志: $publishLog" }

# 定位 publish 输出
$publishOut = Get-ChildItem (Join-Path $managedProj '..\bin\Release') -Recurse -Directory -Filter 'publish' |
    Sort-Object FullName -Descending | Select-Object -First 1
if (-not $publishOut) { Fail '未找到 dotnet publish 输出目录' }

# ---------- 5. 组装发布目录 ----------
Write-Stage "组装发布目录 -> $publishDir"
if (Test-Path $publishDir) { Remove-Item -LiteralPath $publishDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $publishDir | Out-Null
Copy-Item -Path (Join-Path $publishOut.FullName '*') -Destination $publishDir -Recurse -Force

$nativeBin = Join-Path $nativeBuildDir 'bin\AliyaLive2D.Native\Release'
Copy-Item -LiteralPath (Join-Path $nativeBin 'AliyaLive2D.Native.dll') -Destination $publishDir -Force
Copy-Item -LiteralPath (Join-Path $nativeBin 'Live2DCubismCore.dll') -Destination $publishDir -Force

# 资源（模型 + FrameworkShaders）由 csproj Content 复制，这里仅做清理
Remove-Item -Path (Join-Path $publishDir 'Assets\Live2D\Aliya\Aliya') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path $publishDir 'FrameworkShaders\FrameworkShaders') -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path $publishDir -Recurse -Filter '*.pdb' -File | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path $publishDir -Recurse -Filter '*.bak' -File | Remove-Item -Force -ErrorAction SilentlyContinue

Write-Host "`n发布目录: $publishDir"
Write-Host '构建完成。'





