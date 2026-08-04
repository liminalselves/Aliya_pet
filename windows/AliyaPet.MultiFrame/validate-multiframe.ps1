$ErrorActionPreference = "Stop"

foreach ($character in "Aliya", "Windy") {
    $frames = @(Get-ChildItem -LiteralPath ".\Frames\$character" -Filter "*.png" -File)
    if ($frames.Count -lt 2) {
        throw "$character 至少需要 2 个 PNG 帧，当前只有 $($frames.Count) 个。"
    }
}

if (@(Get-ChildItem -LiteralPath ".\Frames\Aliya\idle" -Filter "*.png" -File).Count -lt 2) {
    throw "Aliya/idle 至少需要 2 个 PNG 帧。"
}

dotnet build .\AliyaPet.csproj -c Release --no-restore
Write-Host "多帧资源与 Release 构建验证通过。"
