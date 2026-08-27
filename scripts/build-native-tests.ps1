# =========================================================
# 构建 Native 测试（aliya_smoke.exe / profile_renderer.exe�?
# Release x64 + PDB，输出到 build\test-results\test-bin
# =========================================================
param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)
$ErrorActionPreference = 'Stop'
$vcvars = 'E:\AliyaLive2DToolchain\VS2022\VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) { throw "找不�?vcvars64.bat: $vcvars" }

$native = Join-Path $ProjectRoot 'native\AliyaLive2D.Native'
$sdk = Join-Path $ProjectRoot 'third_party\CubismSdkForNative-5-r.5'
$release = Join-Path $ProjectRoot 'build\native-x64-release'
$libDir = Join-Path $release 'lib\AliyaLive2D.Native\Release'
$dllDir = Join-Path $release 'bin\AliyaLive2D.Native\Release'
$outDir = Join-Path $ProjectRoot 'build\test-results\test-bin'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$coreImport = Join-Path $sdk 'Core\dll\windows\x86_64\Live2DCubismCore.lib'
$commonLibs = "`"$libDir\AliyaLive2D.Native.lib`" `"$libDir\Framework.lib`" `"$coreImport`" d3d11.lib d3dcompiler.lib user32.lib dbghelp.lib ucrt.lib"
$includes = "/I`"$native\src`" /I`"$sdk\Framework\src`" /I`"$sdk\Core\include`""

foreach ($t in @('aliya_smoke', 'profile_renderer')) {
    $src = Join-Path $native "tests\$t.cpp"
    $exe = Join-Path $outDir "$t.exe"
    cmd /c "`"$vcvars`" >nul 2>&1 && cl /nologo /EHsc /utf-8 /MD /Zi $includes /Fe:`"$exe`" `"$src`" $commonLibs /DEBUG 2>&1"
    if ($LASTEXITCODE -ne 0) { throw "$t 编译失败" }
    Copy-Item -LiteralPath (Join-Path $dllDir 'AliyaLive2D.Native.dll') -Destination $outDir -Force
    Copy-Item -LiteralPath (Join-Path $dllDir 'AliyaLive2D.Native.pdb') -Destination $outDir -Force -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath (Join-Path $dllDir 'Live2DCubismCore.dll') -Destination $outDir -Force
    Write-Host "$t -> $exe"
}
