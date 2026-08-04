$ErrorActionPreference = "Stop"
dotnet publish .\AliyaPet.csproj `
  -c Release `
  -r win-x64 `
  --no-restore `
  --self-contained true `
  /p:PublishSingleFile=true `
  /p:IncludeNativeLibrariesForSelfExtract=true

if ($LASTEXITCODE -ne 0) {
  throw "EXE 发布失败，dotnet 退出码：$LASTEXITCODE"
}

Write-Host ""
Write-Host "EXE output:"
Write-Host ".\bin\Release\net8.0-windows10.0.17763.0\win-x64\publish\AliyaPet.MultiFrame.exe"
