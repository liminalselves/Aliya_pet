param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$SourceDirectory = (Join-Path $ProjectRoot 'assets\Aliya')
)

$ErrorActionPreference = 'Stop'

$source = (Resolve-Path -LiteralPath $SourceDirectory).Path
$projectDir = Join-Path $ProjectRoot 'windows\AliyaPet'
$destination = Join-Path $projectDir 'Assets\Live2D\Aliya'
$required = @(
    'seethrough_output_15_呼吸完成.model3.json',
    'seethrough_output_15_呼吸完成.moc3',
    'seethrough_output_15_呼吸完成.physics3.json',
    'seethrough_output_15_呼吸完成.cdi3.json',
    'seethrough_output_15_呼吸完成.1024\texture_00.png'
)

# 校验 model3.json 引用关系
$modelJson = Join-Path $source 'seethrough_output_15_呼吸完成.model3.json'
$model = Get-Content -LiteralPath $modelJson -Raw -Encoding UTF8 | ConvertFrom-Json
$references = @($model.FileReferences.Moc, $model.FileReferences.Physics, $model.FileReferences.DisplayInfo) +
    @($model.FileReferences.Textures)
foreach ($rel in $references | Where-Object { $_ }) {
    $p = Join-Path $source $rel
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) {
        throw "缺少 Live2D 引用文件: $p"
    }
}

foreach ($relativePath in $required) {
    $sourcePath = Join-Path $source $relativePath
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "缺少 Live2D 资源：$sourcePath"
    }
}

New-Item -ItemType Directory -Force -Path $destination | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'seethrough_output_15_呼吸完成.model3.json') -Destination $destination -Force
Copy-Item -LiteralPath (Join-Path $source 'seethrough_output_15_呼吸完成.moc3') -Destination $destination -Force
Copy-Item -LiteralPath (Join-Path $source 'seethrough_output_15_呼吸完成.physics3.json') -Destination $destination -Force
Copy-Item -LiteralPath (Join-Path $source 'seethrough_output_15_呼吸完成.cdi3.json') -Destination $destination -Force
Copy-Item -LiteralPath (Join-Path $source 'seethrough_output_15_呼吸完成.1024') -Destination $destination -Recurse -Force

# FrameworkShaders（Cubism D3D11 渲染器运行时时序）
$shaderSrc = Join-Path $ProjectRoot 'third_party\CubismSdkForNative-5-r.5\Framework\src\Rendering\D3D11\Shaders'
$shaderDst = Join-Path $projectDir 'FrameworkShaders'
if (Test-Path $shaderSrc) {
    New-Item -ItemType Directory -Force -Path $shaderDst | Out-Null
    Copy-Item -Path (Join-Path $shaderSrc '*') -Destination $shaderDst -Force
}

Write-Host "Live2D Windows 资源已同步到：$destination"
Write-Host "FrameworkShaders 已同步到：$shaderDst"


