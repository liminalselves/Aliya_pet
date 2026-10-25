param([Parameter(Mandatory=$true)][string]$TargetDirectory)
$ErrorActionPreference = 'Stop'

# LABEL_SECURITY_INFORMATION changes only integrity labels, not DACLs or audit rules.
Add-Type @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using FILETIME = System.Runtime.InteropServices.ComTypes.FILETIME;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class AliyaBuildLabels {
    const uint LabelInfo = 0x10; // LABEL_SECURITY_INFORMATION, never DACL or audit SACL.
    const uint ReparsePoint = 0x400;
    [StructLayout(LayoutKind.Sequential)]
    struct FileInfo {
        public uint Attributes;
        public FILETIME Created, Accessed, Written;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security,
        uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfo info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint size, uint flags);
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityInfo(SafeFileHandle file, int type, uint info,
        out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")]
    static extern uint SetSecurityInfo(SafeFileHandle file, int type, uint info,
        IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision,
        out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool GetSecurityDescriptorSacl(IntPtr descriptor, out bool present, out IntPtr sacl, out bool defaulted);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    static SafeFileHandle Open(string path) {
        // READ_CONTROL | WRITE_OWNER | FILE_READ_ATTRIBUTES; no FILE_SHARE_DELETE.
        // OPEN_REPARSE_POINT makes a replaced leaf a link handle, never its target.
        SafeFileHandle file = CreateFile(path, 0x000A0080, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (file.IsInvalid) {
            int error = Marshal.GetLastWin32Error();
            file.Dispose();
            throw new Win32Exception(error, "Cannot open Cargo output without following links: " + path);
        }
        return file;
    }
    static FileInfo Info(SafeFileHandle file) {
        FileInfo info;
        if (!GetFileInformationByHandle(file, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return info;
    }
    static string FinalPath(SafeFileHandle file) {
        StringBuilder path = new StringBuilder(512);
        while (true) {
            uint size = GetFinalPathNameByHandle(file, path, (uint)path.Capacity, 0);
            if (size == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (size >= path.Capacity) { path = new StringBuilder((int)size + 1); continue; }
            string value = path.ToString();
            if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) value = @"\\" + value.Substring(8);
            else if (value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) value = value.Substring(4);
            return value.TrimEnd('\\');
        }
    }
    public static SafeFileHandle OpenRoot(string path) {
        SafeFileHandle file = Open(path);
        try {
            uint attributes = Info(file).Attributes;
            if ((attributes & ReparsePoint) != 0 || (attributes & 0x10) == 0
                || !String.Equals(FinalPath(file), Path.GetFullPath(path).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Cargo output root changed or resolves through a link: " + path);
            return file;
        } catch { file.Dispose(); throw; }
    }
    static bool HasLabel(SafeFileHandle file) {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint error = GetSecurityInfo(file, 1, LabelInfo, out owner, out group, out dacl, out sacl, out descriptor);
        if (error != 0) throw new Win32Exception((int)error, "Cannot read Cargo output integrity label.");
        try { return sacl != IntPtr.Zero && Marshal.ReadInt16(sacl, 4) != 0; }
        finally { LocalFree(descriptor); }
    }
    static void SetLabel(SafeFileHandle file, IntPtr sacl) {
        uint error = SetSecurityInfo(file, 1, LabelInfo, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
        if (error != 0) throw new Win32Exception((int)error, "Cannot set Cargo output integrity label.");
    }
    public static void BlockLow(SafeFileHandle root) {
        IntPtr descriptor;
        uint size;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;;NW;;;ME)", 1, out descriptor, out size))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            bool present, defaulted;
            IntPtr sacl;
            if (!GetSecurityDescriptorSacl(descriptor, out present, out sacl, out defaulted) || !present)
                throw new Win32Exception(Marshal.GetLastWin32Error());
            SetLabel(root, sacl);
        } finally { LocalFree(descriptor); }
    }
    public static bool Clear(SafeFileHandle root, string path) {
        using (SafeFileHandle file = Open(path)) {
            FileInfo info = Info(file);
            if ((info.Attributes & ReparsePoint) != 0) return false;
            if (!FinalPath(file).StartsWith(FinalPath(root) + "\\", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Cargo output escaped the verified root: " + path);
            if (!HasLabel(file)) return false;
            if (info.Links > 1) throw new InvalidOperationException("Refusing to relabel multiply-linked Cargo output: " + path);
            SetLabel(file, IntPtr.Zero);
            return true;
        }
    }
}
'@

function Assert-RealDirectory([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    $current = [System.IO.Path]::GetPathRoot($full)
    # Inspect every component before accessing anything below it, not just the leaf.
    foreach ($part in @('') + $full.Substring($current.Length).Split([char]'\')) {
        if ($part) { $current = [System.IO.Path]::Combine($current, $part) }
        $item = Get-Item -LiteralPath $current -Force
        if (!$item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw 'Cargo output must be a real directory, with no link ancestors.'
        }
    }
}

Assert-RealDirectory $TargetDirectory
$root = Get-Item -LiteralPath $TargetDirectory -Force
$rootHandle = [AliyaBuildLabels]::OpenRoot($root.FullName)
try {
# Includes redirected/localized user folders, which may not live below USERPROFILE.
foreach ($folder in [System.Enum]::GetValues([System.Environment+SpecialFolder])) {
    $known = [System.Environment]::GetFolderPath($folder)
    if ($known -and $root.FullName.TrimEnd('\') -ieq $known.TrimEnd('\')) {
        throw 'Refusing a Windows user/system folder as Cargo output.'
    }
}
# The JS caller verifies Cargo scope before mkdir. Recheck existing contents before labels.
$entries = @(Get-ChildItem -LiteralPath $root.FullName -Force)
if ($entries.Count) {
    $tag = Get-Item -LiteralPath (Join-Path $root.FullName 'CACHEDIR.TAG') -Force
    if ($tag.PSIsContainer -or ($tag.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
        !([System.IO.File]::ReadAllText($tag.FullName).StartsWith('Signature: 8a477f597d28d172789f06886806bc55'))) {
        throw 'Refusing non-Cargo output contents.'
    }
    foreach ($entry in $entries) {
        if ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
        if (!$entry.PSIsContainer -and $entry.Name -notin @('CACHEDIR.TAG', '.rustc_info.json')) {
            throw 'Refusing non-Cargo output contents.'
        }
    }
}
# A non-inheritable root label blocks inherited Low without downgrading executables.
[AliyaBuildLabels]::BlockLow($rootHandle)

$directories = [System.Collections.Generic.Stack[string]]::new()
$directories.Push($root.FullName)
$cleared = 0
while ($directories.Count) {
    $directory = $directories.Pop()
    Assert-RealDirectory $directory
    foreach ($item in (Get-ChildItem -LiteralPath $directory -Force)) {
        # Never traverse or relabel junctions/symlinks and their external targets.
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
        if ([AliyaBuildLabels]::Clear($rootHandle, $item.FullName)) { $cleared++ }
        if ($item.PSIsContainer) { $directories.Push($item.FullName) }
    }
}
Write-Output "[build] Blocked Low inheritance at output root; cleared $cleared child integrity labels."
} finally {
    $rootHandle.Dispose()
}
