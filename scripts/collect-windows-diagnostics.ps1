# =========================================================
# 收集运行诊断：进程状态、日志、窗口截图
# =========================================================
param(
    [string]$PublishDir = 'C:\Users\Administrator\Desktop\AliyaDesktopPet1\build\publish\AliyaPet-win-x64',
    [string]$OutDir = 'C:\Users\Administrator\Desktop\AliyaDesktopPet1\build\test-results\diagnostics',
    [int]$WaitSeconds = 15
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Path (Join-Path $PSScriptRoot '..\build\test-results\Win32Helper.cs')

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Capture-Window($proc, $name) {
    $proc.Refresh()
    if ($proc.HasExited) { Write-Host "[FAIL] $name 已退出 ExitCode=$($proc.ExitCode)"; return $false }
    $deadline = (Get-Date).AddSeconds(30)
    while (-not $proc.MainWindowHandle -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500; $proc.Refresh() }
    if (-not $proc.MainWindowHandle) { Write-Host "[WARN] $name 未找到主窗口"; return $true }
    $h = $proc.MainWindowHandle
    $rect = New-Object RECT
    [Win32Helper]::GetWindowRect($h, [ref]$rect) | Out-Null
    $w = $rect.Right - $rect.Left; $hh = $rect.Bottom - $rect.Top
    Write-Host "[INFO] $name 窗口: ${w}x${hh} at ($($rect.Left),$($rect.Top))"
    if ($w -le 0 -or $hh -le 0) { Write-Host "[WARN] $name 窗口尺寸无效"; return $true }
    $bmp = New-Object System.Drawing.Bitmap($w, $hh)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $hh)))
    $path = Join-Path $OutDir "$name.png"
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Host "[PASS] 截图已保存: $path"
    return $true
}

$exe = Join-Path $PublishDir 'AliyaPet.exe'
Write-Host "启动: $exe"
$proc = Start-Process -FilePath $exe -WorkingDirectory $PublishDir -PassThru
Start-Sleep -Seconds $WaitSeconds
$ok = Capture-Window $proc "aliya-pet-window"

foreach ($logPath in @(
    (Join-Path $PublishDir 'Logs\aliya-pet.log'),
    (Join-Path $PublishDir 'Logs\live2d-native.log')
)) {
    if (Test-Path $logPath) {
        Copy-Item -LiteralPath $logPath -Destination (Join-Path $OutDir (Split-Path $logPath -Leaf)) -Force
        Write-Host "[PASS] 日志已复制: $(Split-Path $logPath -Leaf)"
    } else {
        Write-Host "[WARN] 日志不存在: $logPath"
    }
}

Start-Sleep -Milliseconds 500
$proc.Refresh()
if ($proc.HasExited) { Write-Host "[FAIL] 进程已退出 ExitCode=$($proc.ExitCode)" } else { Write-Host "[PASS] 进程存活 pid=$($proc.Id)" }
Write-Host "关闭进程..."
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$left = Get-Process -Name AliyaPet -ErrorAction SilentlyContinue
if ($left) { Write-Host "[FAIL] 仍有残留进程" } else { Write-Host "[PASS] 无残留进程" }
