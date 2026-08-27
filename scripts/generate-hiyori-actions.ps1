# 生成 Hiyori 模型的 16 个动作（自定义 keyframes 格式，含手臂/手/腿）
# 用法: powershell -File scripts/generate-hiyori-actions.ps1
# 输出: flutter/assets/live2d/Hiyori/Actions/*.json
$ErrorActionPreference = 'Stop'

$outDir = Join-Path $PSScriptRoot '..\flutter\assets\live2d\Hiyori\Actions'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

# keyframes 辅助: t=时间 v=值 e=easing
function K($t, $v, $e = 'easeInOut') { @{ time = $t; value = $v; easing = $e } }

# 通道辅助: p=参数名 w=权重 k=关键帧数组
function C($p, $w, $k) { @{ parameter = $p; blendMode = 'override'; weight = $w; keyframes = $k } }

# 动作定义: name = @(通道...)
$actions = [ordered]@{
  idle = @(
    (C 'ParamBreath' 0.3 @(K 0 0 'easeOut'; K 2 1 'easeInOut'; K 4 0 'easeOut')),
    (C 'ParamBodyAngleZ' 0.2 @(K 0 0; K 2 -2; K 4 2; K 6 0)),
    (C 'ParamEyeLOpen' 0.8 @(K 0 1; K 1.5 1; K 1.7 0.1 'easeInOut'; K 1.9 1; K 4 1)),
    (C 'ParamEyeROpen' 0.8 @(K 0 1; K 1.5 1; K 1.7 0.1 'easeInOut'; K 1.9 1; K 4 1))
  ),
  wave = @(
    (C 'ParamArmRA' 0.9 @(K 0 0 'easeOut'; K 0.3 -25 'easeInOut'; K 1.6 -25; K 2.2 0 'easeOut')),
    (C 'ParamArmRB' 0.9 @(K 0.3 0; K 0.6 20 'easeInOut'; K 1.0 -20 'easeInOut'; K 1.4 20 'easeInOut'; K 1.8 -20 'easeInOut'; K 2.2 0)),
    (C 'ParamHandR' 0.7 @(K 0.3 0; K 0.6 15; K 1.4 -15; K 2.2 0)),
    (C 'ParamAngleZ' 0.4 @(K 0 0; K 0.6 -6; K 1.2 5; K 1.8 -4; K 2.2 0)),
    (C 'ParamBrowLY' 0.4 @(K 0 0; K 0.4 0.3; K 1.8 0.2; K 2.2 0))
  ),
  nod = @(
    (C 'ParamAngleY' 0.9 @(K 0 0; K 0.25 -14 'easeInOut'; K 0.5 4 'easeInOut'; K 0.75 -14 'easeInOut'; K 1.0 4 'easeInOut'; K 1.2 -10 'easeInOut'; K 1.4 0 'easeOut')),
    (C 'ParamBrowLY' 0.4 @(K 0 0; K 0.3 0.2; K 1.2 0.15; K 1.4 0)),
    (C 'ParamBrowRY' 0.4 @(K 0 0; K 0.3 0.2; K 1.2 0.15; K 1.4 0))
  ),
  stretch = @(
    (C 'ParamShoulder' 0.8 @(K 0 0; K 0.4 15 'easeInOut'; K 1.4 15; K 2.0 0 'easeOut')),
    (C 'ParamArmLA' 0.8 @(K 0 0; K 0.5 -25 'easeInOut'; K 1.6 -25; K 2.2 0 'easeOut')),
    (C 'ParamArmRA' 0.8 @(K 0 0; K 0.5 -25 'easeInOut'; K 1.6 -25; K 2.2 0 'easeOut')),
    (C 'ParamArmLB' 0.8 @(K 0 0; K 0.6 -20 'easeInOut'; K 1.6 -20; K 2.2 0 'easeOut')),
    (C 'ParamArmRB' 0.8 @(K 0 0; K 0.6 -20 'easeInOut'; K 1.6 -20; K 2.2 0 'easeOut')),
    (C 'ParamMouthOpenY' 0.7 @(K 0 0; K 0.5 0.6 'easeInOut'; K 1.4 0.3; K 2.2 0)),
    (C 'ParamEyeLOpen' 0.5 @(K 0 1; K 0.5 0.3 'easeInOut'; K 1.6 0.5; K 2.2 1)),
    (C 'ParamEyeROpen' 0.5 @(K 0 1; K 0.5 0.3 'easeInOut'; K 1.6 0.5; K 2.2 1))
  ),
  yawn = @(
    (C 'ParamMouthOpenY' 0.9 @(K 0 0; K 0.5 0.9 'easeInOut'; K 1.3 0.7; K 2.0 0.2; K 2.6 0 'easeOut')),
    (C 'ParamEyeLOpen' 0.6 @(K 0 1; K 0.5 0.3 'easeInOut'; K 1.6 0.4; K 2.6 1)),
    (C 'ParamEyeROpen' 0.6 @(K 0 1; K 0.5 0.3 'easeInOut'; K 1.6 0.4; K 2.6 1)),
    (C 'ParamBodyAngleX' 0.4 @(K 0 0; K 0.8 5 'easeInOut'; K 1.8 4; K 2.6 0)),
    (C 'ParamArmRA' 0.4 @(K 0 0; K 0.6 12 'easeInOut'; K 1.6 10; K 2.6 0))
  ),
  shake = @(
    (C 'ParamAngleZ' 0.9 @(K 0 0; K 0.15 -15 'easeInOut'; K 0.3 15 'easeInOut'; K 0.45 -15 'easeInOut'; K 0.6 15 'easeInOut'; K 0.75 -15 'easeInOut'; K 0.9 15 'easeInOut'; K 1.05 -10 'easeInOut'; K 1.2 0 'easeOut')),
    (C 'ParamBrowLAngle' 0.5 @(K 0 0; K 0.2 -12; K 1.0 -12; K 1.2 0)),
    (C 'ParamBrowRAngle' 0.5 @(K 0 0; K 0.2 -12; K 1.0 -12; K 1.2 0))
  ),
  sway = @(
    (C 'ParamBodyAngleZ' 0.8 @(K 0 0; K 0.4 10 'easeInOut'; K 0.8 -10 'easeInOut'; K 1.2 8 'easeInOut'; K 1.6 -8 'easeInOut'; K 2.0 0 'easeOut')),
    (C 'ParamArmLA' 0.5 @(K 0 0; K 0.4 -8; K 1.2 8; K 2.0 0)),
    (C 'ParamArmRA' 0.5 @(K 0 0; K 0.4 8; K 1.2 -8; K 2.0 0)),
    (C 'ParamHairBack' 0.4 @(K 0 0; K 0.4 8; K 1.2 -8; K 2.0 0)),
    (C 'ParamEyeLSmile' 0.5 @(K 0 0; K 0.4 1; K 1.6 0.8; K 2.0 0)),
    (C 'ParamEyeRSmile' 0.5 @(K 0 0; K 0.4 1; K 1.6 0.8; K 2.0 0))
  ),
  angry = @(
    (C 'ParamBrowLAngle' 0.9 @(K 0 0; K 0.3 -25 'easeInOut'; K 1.4 -25; K 2.0 0 'easeOut')),
    (C 'ParamBrowRAngle' 0.9 @(K 0 0; K 0.3 -25 'easeInOut'; K 1.4 -25; K 2.0 0 'easeOut')),
    (C 'ParamBrowLForm' 0.7 @(K 0 0; K 0.3 -1; K 1.4 -1; K 2.0 0)),
    (C 'ParamBrowRForm' 0.7 @(K 0 0; K 0.3 -1; K 1.4 -1; K 2.0 0)),
    (C 'ParamMouthForm' 0.7 @(K 0 0; K 0.3 0.8 'easeInOut'; K 1.4 0.6; K 2.0 0)),
    (C 'ParamCheek' 0.6 @(K 0 0; K 0.3 0.8 'easeInOut'; K 1.4 0.7; K 2.0 0)),
    (C 'ParamAngleZ' 0.4 @(K 0 0; K 0.4 -6; K 1.4 -5; K 2.0 0))
  ),
  doubt = @(
    (C 'ParamAngleZ' 0.8 @(K 0 0; K 0.4 12 'easeInOut'; K 1.6 12; K 2.2 0 'easeOut')),
    (C 'ParamBrowLY' 0.8 @(K 0 0; K 0.4 0.8 'easeInOut'; K 1.6 0.7; K 2.2 0)),
    (C 'ParamBrowRY' 0.8 @(K 0 0; K 0.4 0.8 'easeInOut'; K 1.6 0.7; K 2.2 0)),
    (C 'ParamEyeLOpen' 0.6 @(K 0 1; K 0.4 0.8; K 1.6 0.8; K 2.2 1)),
    (C 'ParamEyeROpen' 0.6 @(K 0 1; K 0.4 0.8; K 1.6 0.8; K 2.2 1)),
    (C 'ParamMouthOpenY' 0.5 @(K 0 0; K 0.4 0.3; K 1.6 0.2; K 2.2 0))
  ),
  click = @(
    (C 'ParamBodyAngleY' 0.8 @(K 0 0; K 0.12 -6 'easeOut'; K 0.24 0 'easeIn'; K 0.36 -4 'easeOut'; K 0.48 0 'easeIn')),
    (C 'ParamEyeLOpen' 0.8 @(K 0 1; K 0.1 0.2 'easeInOut'; K 0.2 1; K 0.3 0.3 'easeInOut'; K 0.4 1)),
    (C 'ParamEyeROpen' 0.8 @(K 0 1; K 0.1 0.2 'easeInOut'; K 0.2 1; K 0.3 0.3 'easeInOut'; K 0.4 1)),
    (C 'ParamMouthOpenY' 0.6 @(K 0 0; K 0.1 0.4 'easeInOut'; K 0.3 0.3; K 0.5 0)),
    (C 'ParamCheek' 0.5 @(K 0 0; K 0.15 0.6; K 0.45 0.4; K 0.6 0))
  ),
  drag = @(
    (C 'ParamBodyAngleX' 0.8 @(K 0 0; K 0.4 -12 'easeInOut'; K 1.6 -12; K 2.2 0 'easeOut')),
    (C 'ParamAngleX' 0.6 @(K 0 0; K 0.4 10 'easeInOut'; K 1.6 9; K 2.2 0)),
    (C 'ParamArmLA' 0.6 @(K 0 0; K 0.5 15 'easeInOut'; K 1.6 13; K 2.2 0)),
    (C 'ParamArmRA' 0.6 @(K 0 0; K 0.5 15 'easeInOut'; K 1.6 13; K 2.2 0)),
    (C 'ParamEyeLOpen' 0.5 @(K 0 1; K 0.5 0.5; K 1.6 0.6; K 2.2 1)),
    (C 'ParamEyeROpen' 0.5 @(K 0 1; K 0.5 0.5; K 1.6 0.6; K 2.2 1))
  ),
  fall = @(
    (C 'ParamBodyAngleX' 0.9 @(K 0 0; K 0.3 -28 'easeIn'; K 1.0 -28; K 1.4 0 'easeOut')),
    (C 'ParamArmLA' 0.7 @(K 0 0; K 0.3 20 'easeIn'; K 0.9 15; K 1.4 0)),
    (C 'ParamArmRA' 0.7 @(K 0 0; K 0.3 -20 'easeIn'; K 0.9 -15; K 1.4 0)),
    (C 'ParamArmLB' 0.6 @(K 0 0; K 0.35 18 'easeIn'; K 0.9 12; K 1.4 0)),
    (C 'ParamArmRB' 0.6 @(K 0 0; K 0.35 -18 'easeIn'; K 0.9 -12; K 1.4 0)),
    (C 'ParamEyeLOpen' 0.6 @(K 0 1; K 0.25 0.2 'easeIn'; K 1.0 0.3; K 1.4 1)),
    (C 'ParamEyeROpen' 0.6 @(K 0 1; K 0.25 0.2 'easeIn'; K 1.0 0.3; K 1.4 1)),
    (C 'ParamMouthOpenY' 0.5 @(K 0 0; K 0.3 0.5 'easeIn'; K 1.0 0.4; K 1.4 0))
  ),
  land = @(
    (C 'ParamBodyAngleY' 0.8 @(K 0 -8 'easeOut'; K 0.15 0 'easeIn'; K 0.3 -5 'easeOut'; K 0.45 0 'easeIn')),
    (C 'ParamBodyAngleX' 0.6 @(K 0 -15; K 0.15 0; K 0.4 0)),
    (C 'ParamArmLA' 0.6 @(K 0 12; K 0.2 0; K 0.5 0)),
    (C 'ParamArmRA' 0.6 @(K 0 -12; K 0.2 0; K 0.5 0)),
    (C 'ParamEyeLOpen' 0.6 @(K 0 0.3; K 0.2 1; K 0.5 1)),
    (C 'ParamEyeROpen' 0.6 @(K 0 0.3; K 0.2 1; K 0.5 1))
  ),
  edge_idle = @(
    (C 'ParamAngleZ' 0.5 @(K 0 0; K 1.5 8 'easeInOut'; K 3.0 8; K 4.5 0 'easeOut')),
    (C 'ParamBodyAngleZ' 0.4 @(K 0 0; K 1.5 5 'easeInOut'; K 3.0 5; K 4.5 0)),
    (C 'ParamBreath' 0.3 @(K 0 0; K 2 1; K 4 0)),
    (C 'ParamEyeLOpen' 0.8 @(K 0 1; K 2 1; K 2.2 0.1 'easeInOut'; K 2.4 1; K 4.5 1)),
    (C 'ParamEyeROpen' 0.8 @(K 0 1; K 2 1; K 2.2 0.1 'easeInOut'; K 2.4 1; K 4.5 1))
  ),
  walk_left = @(
    (C 'ParamLeg' 0.9 @(K 0 0; K 0.2 20 'easeInOut'; K 0.4 0 'easeInOut'; K 0.6 -20 'easeInOut'; K 0.8 0 'easeInOut'; K 1.0 20 'easeInOut'; K 1.2 0)),
    (C 'ParamBodyAngleX' 0.6 @(K 0 0; K 0.3 -6; K 0.6 6; K 0.9 -6; K 1.2 0)),
    (C 'ParamArmLA' 0.6 @(K 0 0; K 0.2 12; K 0.6 -12; K 1.0 12; K 1.2 0)),
    (C 'ParamArmRA' 0.6 @(K 0 0; K 0.2 -12; K 0.6 12; K 1.0 -12; K 1.2 0)),
    (C 'ParamHairBack' 0.5 @(K 0 0; K 0.3 10; K 0.9 -10; K 1.2 0))
  ),
  walk_right = @(
    (C 'ParamLeg' 0.9 @(K 0 0; K 0.2 -20 'easeInOut'; K 0.4 0 'easeInOut'; K 0.6 20 'easeInOut'; K 0.8 0 'easeInOut'; K 1.0 -20 'easeInOut'; K 1.2 0)),
    (C 'ParamBodyAngleX' 0.6 @(K 0 0; K 0.3 6; K 0.6 -6; K 0.9 6; K 1.2 0)),
    (C 'ParamArmLA' 0.6 @(K 0 0; K 0.2 -12; K 0.6 12; K 1.0 -12; K 1.2 0)),
    (C 'ParamArmRA' 0.6 @(K 0 0; K 0.2 12; K 0.6 -12; K 1.0 12; K 1.2 0)),
    (C 'ParamHairBack' 0.5 @(K 0 0; K 0.3 -10; K 0.9 10; K 1.2 0))
  )
}

# 每个动作生成 JSON 文件
foreach ($entry in $actions.GetEnumerator()) {
  $name = $entry.Key
  $channels = $entry.Value
  $duration = 0.0
  foreach ($ch in $channels) {
    foreach ($kf in $ch.keyframes) { if ($kf.time -gt $duration) { $duration = $kf.time } }
  }
  $doc = @{
    id = $name
    duration = [math]::Round($duration, 2)
    priority = 40
    interruptible = $true
    blendIn = 0.1
    blendOut = 0.2
    tags = @($name)
    channels = $channels
  }
  $json = $doc | ConvertTo-Json -Depth 10
  $path = Join-Path $outDir "$name.json"
  [System.IO.File]::WriteAllText($path, $json, [System.Text.Encoding]::UTF8)
  Write-Output "生成: $name.json (duration=$($doc.duration)s, channels=$($channels.Count))"
}
Write-Output "完成: $($actions.Count) 个动作 -> $outDir"
