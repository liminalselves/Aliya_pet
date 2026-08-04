$ErrorActionPreference = "Stop"
dotnet publish .\AliyaPet.csproj `
  -c Release `
  -r win-x64 `
  --self-contained true `
  /p:PublishSingleFile=true `
  /p:IncludeNativeLibrariesForSelfExtract=true

Write-Host ""
Write-Host "EXE output:"
Write-Host ".\bin\Release\net8.0-windows\win-x64\publish\AliyaPet.exe"
