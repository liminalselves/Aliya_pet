# =========================================================
# 验证发布目录完整性（Release x64）
# 退出码：0=PASS 1=VALIDATION_FAILED 2=SCRIPT_ERROR 3=REQUIRED_FILE_MISSING 4=ARCHITECTURE_MISMATCH
# =========================================================
param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$PublishDir = (Join-Path $ProjectRoot 'build\publish\AliyaPet-win-x64')
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
    Write-Host "发布目录: $PublishDir"
    if (-not (Test-Path $PublishDir)) {
        Write-Test 'publish-dir-exists' 'dir exists' 'missing' $false
        Write-Host 'RESULT=FAIL'
        exit 3
    }
    Write-Test 'publish-dir-exists' 'dir exists' 'exists' $true

    $exe = Join-Path $PublishDir 'AliyaPet.exe'
    $native = Join-Path $PublishDir 'AliyaLive2D.Native.dll'
    $core = Join-Path $PublishDir 'Live2DCubismCore.dll'
    $modelJson = Join-Path $PublishDir 'Assets\Live2D\Aliya\seethrough_output_15_呼吸完成.model3.json'
    $moc = Join-Path $PublishDir 'Assets\Live2D\Aliya\seethrough_output_15_呼吸完成.moc3'
    $texture = Join-Path $PublishDir 'Assets\Live2D\Aliya\seethrough_output_15_呼吸完成.1024\texture_00.png'
    $physics = Join-Path $PublishDir 'Assets\Live2D\Aliya\seethrough_output_15_呼吸完成.physics3.json'
    $shaderFx = Join-Path $PublishDir 'FrameworkShaders\CubismEffect.fx'
    $shaderBlend = Join-Path $PublishDir 'FrameworkShaders\CubismBlendMode.fx'

    foreach ($t in @(
        @{ n='exe'; p=$exe }, @{ n='native-dll'; p=$native }, @{ n='core-dll'; p=$core },
        @{ n='model3.json'; p=$modelJson }, @{ n='moc3'; p=$moc }, @{ n='texture'; p=$texture },
        @{ n='physics3.json'; p=$physics }, @{ n='CubismEffect.fx'; p=$shaderFx }, @{ n='CubismBlendMode.fx'; p=$shaderBlend }
    )) {
        $ok = Test-Path $t.p
        Write-Test $t.n 'file exists' ($(if ($ok) { 'exists' } else { 'missing' })) $ok
    }

    # 文件非空
    foreach ($p in @($exe, $native, $core, $modelJson, $moc, $texture, $physics)) {
        if (Test-Path $p) {
            $len = (Get-Item -LiteralPath $p).Length
            Write-Test ("non-empty:{0}" -f (Split-Path $p -Leaf)) 'size>0' "$len bytes" ($len -gt 0)
        }
    }

    # 架构检查
    function Get-PEMachine($path) {
        $fs = [System.IO.File]::OpenRead($path)
        try {
            $br = New-Object System.IO.BinaryReader($fs)
            $fs.Seek(0x3C, 'Begin') | Out-Null
            $peOff = $br.ReadInt32()
            $fs.Seek($peOff + 4, 'Begin') | Out-Null
            return ('0x{0:X}' -f $br.ReadUInt16())
        } finally { $fs.Dispose() }
    }
    foreach ($dll in @($native, $core)) {
        if (Test-Path $dll) {
            $m = Get-PEMachine $dll
            Write-Test ("arch:{0}" -f (Split-Path $dll -Leaf)) '0x8664' $m ($m -eq '0x8664')
        }
    }
    if (Test-Path $exe) {
        $m = Get-PEMachine $exe
        Write-Test 'arch:exe' '0x8664' $m ($m -eq '0x8664')
    }

    # 禁止绝对开发路径
    $absMarkers = @('C:\Users\Administrator\Desktop\AliyaDesktopPet1', 'E:\AliyaLive2DToolchain', 'D:\Windows Kits')
    foreach ($marker in $absMarkers) {
        $hits = Get-ChildItem $PublishDir -Recurse -File -Include '*.json', '*.config', '*.runtimeconfig.json' -ErrorAction SilentlyContinue |
            Select-String -Pattern ([regex]::Escape($marker)) -SimpleMatch -ErrorAction SilentlyContinue
        Write-Test ("no-dev-path:{0}" -f $marker) 'not found' ($(if ($hits) { 'found' } else { 'not found' })) (-not $hits)
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

