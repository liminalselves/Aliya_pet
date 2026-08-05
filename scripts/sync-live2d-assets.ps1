param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$source = Join-Path $ProjectRoot 'assets\Aliya_Live2D_Runtime'
$targets = @(
    (Join-Path $ProjectRoot 'style-branches\glassmorphism-react\apk\app\src\main\assets\live2d\aliya'),
    (Join-Path $ProjectRoot 'windows\AliyaPet.MultiFrame\Assets\Live2D\Aliya')
)
$models = @(Get-ChildItem -LiteralPath $source -File -Filter '*.model3.json')
if ($models.Count -ne 1) {
    throw "Expected exactly one model3.json in: $source"
}
$modelPath = $models[0].FullName
$modelName = $models[0].Name

$model = Get-Content -LiteralPath $modelPath -Raw -Encoding UTF8 | ConvertFrom-Json
$references = @(
    $model.FileReferences.Moc
    $model.FileReferences.Physics
    $model.FileReferences.DisplayInfo
) + @($model.FileReferences.Textures)

foreach ($relativePath in $references | Where-Object { $_ }) {
    $dependency = Join-Path $source $relativePath
    if (-not (Test-Path -LiteralPath $dependency -PathType Leaf)) {
        throw "Missing Live2D dependency: $dependency"
    }
}

foreach ($target in $targets) {
    if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Recurse -Force
    }
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    Copy-Item -LiteralPath $modelPath -Destination $target

    foreach ($relativePath in $references | Where-Object { $_ }) {
        $sourceFile = Join-Path $source $relativePath
        $targetFile = Join-Path $target $relativePath
        $targetDirectory = Split-Path -Parent $targetFile
        New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
        Copy-Item -LiteralPath $sourceFile -Destination $targetFile
    }

    Write-Output "Live2D assets synced: $target"
}
