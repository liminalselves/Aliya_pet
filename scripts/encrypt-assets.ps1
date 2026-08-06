param(
    [Parameter(Mandatory = $true)][string]$AssetsDir,
    [string]$OutputFile = "assets.enc",
    [switch]$RemoveSource
)
# 加密 Assets 目录为 AES 加密包 assets.enc（与 AssetVault.cs 密钥/IV/算法一致）。
# zip 内含 Assets 目录内容（Live2D/, dialogue/, interaction/...），AES-CBC + PKCS7 + SHA256(key) + 零 IV。
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Security

if (-not (Test-Path $AssetsDir)) { throw "Assets 目录不存在: $AssetsDir" }

$pass = "AliyaPet-Assets-Secret-2c6f"
$tmpZip = Join-Path ([IO.Path]::GetTempPath()) ("assets-" + [guid]::NewGuid().ToString("N") + ".zip")
try {
    [IO.Compression.ZipFile]::CreateFromDirectory($AssetsDir, $tmpZip)
    $in = [IO.File]::ReadAllBytes($tmpZip)
    $sha = [Security.Cryptography.SHA256]::Create()
    $key = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($pass))
    $aes = [Security.Cryptography.Aes]::Create()
    $aes.Mode = [Security.Cryptography.CipherMode]::CBC
    $aes.Padding = [Security.Cryptography.PaddingMode]::PKCS7
    $aes.Key = $key
    $aes.IV = New-Object byte[] 16
    $enc = $aes.CreateEncryptor()
    $out = $enc.TransformFinalBlock($in, 0, $in.Length)
    $outDir = Split-Path -Parent $OutputFile
    if ($outDir) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
    [IO.File]::WriteAllBytes($OutputFile, $out)
    Write-Host "已加密: $OutputFile ($($out.Length) bytes)"
} finally {
    if (Test-Path $tmpZip) { Remove-Item $tmpZip -Force }
    if ($RemoveSource -and (Test-Path $AssetsDir)) {
        Remove-Item $AssetsDir -Recurse -Force
        Write-Host "已删除明文: $AssetsDir"
    }
}
