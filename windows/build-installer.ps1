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
    --no-restore `
    -o $publishDir `
    /p:PublishSingleFile=true `
    /p:IncludeNativeLibrariesForSelfExtract=true `
    /p:DebugType=None `
    /p:DebugSymbols=false

if ($LASTEXITCODE -ne 0) {
    throw "程序发布失败，退出码：$LASTEXITCODE"
}

& $iscc (Join-Path $projectDir "installer.iss")

if ($LASTEXITCODE -ne 0) {
    throw "安装器编译失败，退出码：$LASTEXITCODE"
}
