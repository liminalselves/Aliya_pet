# =========================================================
# Live2D 资源完整性测试
# 退出码：0=PASS 1=VALIDATION_FAILED 2=SCRIPT_ERROR 3=REQUIRED_FILE_MISSING
# =========================================================
param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$ModelDir = (Join-Path $ProjectRoot 'windows\AliyaPet\Assets\Live2D\Aliya')
)

$ErrorActionPreference = 'Stop'
$failed = $false

function Write-Test($name, $expected, $actual, [bool]$ok) {
    $result = if ($ok) { 'PASS' } else { 'FAIL' }
    Write-Host ("TEST_NAME={0}" -f $name)
    Write-Host ("EXPECTED={0}" -f $expected)
    Write-Host ("ACTUAL={0}" -f $actual)
    Write-Host ("RESULT={0}" -f $result)
    if (-not $ok) { $script:failed = $true }
}

try {
    if (-not (Test-Path $ModelDir)) {
        Write-Test 'model-dir-exists' 'dir exists' 'missing' $false
        Write-Host 'RESULT=FAIL'
        exit 3
    }
    Write-Test 'model-dir-exists' 'dir exists' 'exists' $true

    $modelJson = Join-Path $ModelDir 'seethrough_output_15_呼吸完成.model3.json'
    $exists = Test-Path $modelJson
    Write-Test 'model3.json-exists' 'file exists' ($(if ($exists) { 'exists' } else { 'missing' })) $exists

    if ($exists) {
        $raw = Get-Content -LiteralPath $modelJson -Raw -Encoding UTF8
        $parsed = $null
        try { $parsed = $raw | ConvertFrom-Json } catch { $parsed = $null }
        Write-Test 'model3.json-parseable' 'parses' ($(if ($null -ne $parsed) { 'parses' } else { 'parse error' })) ($null -ne $parsed)
        if ($null -ne $parsed) {
            $refs = @($parsed.FileReferences.Moc, $parsed.FileReferences.Physics, $parsed.FileReferences.DisplayInfo) + @($parsed.FileReferences.Textures)
            foreach ($rel in $refs | Where-Object { $_ }) {
                $p = Join-Path $ModelDir $rel
                $ok = Test-Path $p
                Write-Test ("ref:{0}" -f $rel) 'file exists' ($(if ($ok) { 'exists' } else { 'missing' })) $ok
                if ($ok) {
                    $len = (Get-Item -LiteralPath $p).Length
                    Write-Test ("ref-nonempty:{0}" -f $rel) 'size>0' "$len bytes" ($len -gt 0)
                }
            }
            $groups = @($parsed.Groups | ForEach-Object { $_.Name })
            Write-Test 'eye-blink-group' 'EyeBlink' ($groups -contains 'EyeBlink') ($groups -contains 'EyeBlink')
            Write-Test 'lip-sync-group' 'LipSync' ($groups -contains 'LipSync') ($groups -contains 'LipSync')
        }
    }

    foreach ($name in @('seethrough_output_15_呼吸完成.moc3', 'seethrough_output_15_呼吸完成.physics3.json', 'seethrough_output_15_呼吸完成.cdi3.json')) {
        $p = Join-Path $ModelDir $name
        $ok = Test-Path $p
        Write-Test ("file:{0}" -f $name) 'file exists' ($(if ($ok) { 'exists' } else { 'missing' })) $ok
    }
    $tex = Join-Path $ModelDir 'seethrough_output_15_呼吸完成.1024\texture_00.png'
    $ok = Test-Path $tex
    Write-Test 'texture_00.png' 'file exists' ($(if ($ok) { 'exists' } else { 'missing' })) $ok

    $phys = Join-Path $ModelDir 'seethrough_output_15_呼吸完成.physics3.json'
    if (Test-Path $phys) {
        $p = $null
        try { $p = Get-Content -LiteralPath $phys -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $p = $null }
        Write-Test 'physics3.json-parseable' 'parses' ($(if ($null -ne $p) { 'parses' } else { 'parse error' })) ($null -ne $p)
        if ($null -ne $p) {
            Write-Test 'physics3-has-settings' 'count>0' (@($p.PhysicsSettings).Count.ToString()) (@($p.PhysicsSettings).Count -gt 0)
        }
    }
}
catch {
    Write-Host "SCRIPT_ERROR: $($_.Exception.Message)"
    Write-Host 'RESULT=FAIL'
    exit 2
}

if ($failed) {
    Write-Host 'RESULT=FAIL'
    exit 1
}
Write-Host 'RESULT=PASS'
exit 0


