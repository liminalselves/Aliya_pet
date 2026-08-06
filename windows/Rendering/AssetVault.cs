using System;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;

namespace AliyaPet.Rendering;

/// <summary>
/// Assets 资源保险库：安装包内不保留明文 Assets，仅含 AES 加密包 assets.enc（内容为 Assets 目录的 zip）。
/// 程序首次启动时解密到本地用户缓存目录，运行时所有 Assets 路径指向缓存目录。
/// 密钥由硬编码口令经 SHA256 派生（防普通用户查看/误改，不防专业逆向）。
/// 非发布环境（无 assets.enc）自动回退 BaseDirectory\Assets，不影响开发调试。
/// </summary>
internal static class AssetVault
{
    private const string EncFileName = "assets.enc";
    private const string CacheRootDir = "AliyaDesktopPet";
    private const string CacheAssetsSubDir = "assets-cache";
    private const string Passphrase = "AliyaPet-Assets-Secret-2c6f";

    private static string? _assetsRoot;

    /// <summary>程序资源根目录（解密后的 Assets 目录）。</summary>
    public static string AssetsRoot
    {
        get
        {
            if (_assetsRoot is null)
                _assetsRoot = LocateOrDecrypt();
            return _assetsRoot;
        }
    }

    private static string LocateOrDecrypt()
    {
        string encPath = Path.Combine(AppContext.BaseDirectory, EncFileName);
        string cacheAssets = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            CacheRootDir, CacheAssetsSubDir);
        try
        {
            // 缓存已存在且含模型目录 → 直接复用
            if (Directory.Exists(Path.Combine(cacheAssets, "Live2D")))
                return cacheAssets;

            if (!File.Exists(encPath))
            {
                AppLog.Warn("ASSET_VAULT enc 缺失，回退 BaseDirectory\\Assets: {0}", encPath);
                return Path.Combine(AppContext.BaseDirectory, "Assets");
            }

            byte[] zip = Decrypt(File.ReadAllBytes(encPath));
            string cacheRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), CacheRootDir);
            Directory.CreateDirectory(cacheRoot);
            string tmpDir = Path.Combine(cacheRoot, "assets-extract-" + Environment.CurrentManagedThreadId);
            if (Directory.Exists(tmpDir))
                Directory.Delete(tmpDir, true);
            Directory.CreateDirectory(tmpDir);
            string tmpZip = Path.Combine(tmpDir, "a.zip");
            File.WriteAllBytes(tmpZip, zip);
            ZipFile.ExtractToDirectory(tmpZip, tmpDir);
            File.Delete(tmpZip);
            if (Directory.Exists(cacheAssets))
                Directory.Delete(cacheAssets, true);
            Directory.Move(tmpDir, cacheAssets);
            AppLog.Info("ASSET_VAULT decrypted to {0}", cacheAssets);
            return cacheAssets;
        }
        catch (Exception ex)
        {
            AppLog.Error("ASSET_VAULT 解密失败: {0}", ex.Message);
            return Path.Combine(AppContext.BaseDirectory, "Assets");
        }
    }

    private static byte[] Decrypt(byte[] data)
    {
        using var sha = SHA256.Create();
        using var aes = Aes.Create();
        aes.Mode = CipherMode.CBC;
        aes.Padding = PaddingMode.PKCS7;
        aes.Key = sha.ComputeHash(Encoding.UTF8.GetBytes(Passphrase));
        aes.IV = new byte[16]; // 固定零 IV（与打包脚本一致）
        using var ms = new MemoryStream();
        using (var cs = new CryptoStream(ms, aes.CreateDecryptor(), CryptoStreamMode.Write))
            cs.Write(data, 0, data.Length);
        return ms.ToArray();
    }
}
