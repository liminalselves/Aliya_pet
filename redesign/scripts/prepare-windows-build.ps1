param([Parameter(Mandatory=$true)][string]$TargetDirectory)
$ErrorActionPreference = 'Stop'

# LABEL_SECURITY_INFORMATION changes only integrity labels, not DACLs or audit rules.
Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class AliyaBuildLabels {
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode)]
    static extern uint GetNamedSecurityInfo(string name, int type, uint info,
        out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode)]
    static extern uint SetNamedSecurityInfo(string name, int type, uint info,
        IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    public static bool HasLabel(string path) {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint error = GetNamedSecurityInfo(path, 1, 0x10, out owner, out group, out dacl, out sacl, out descriptor);
        if (error != 0) throw new Win32Exception((int)error, "Cannot read integrity label: " + path);
        try { return sacl != IntPtr.Zero && Marshal.ReadInt16(sacl, 4) != 0; }
        finally { LocalFree(descriptor); }
    }
    public static bool Clear(string path) {
        if (!HasLabel(path)) return false;
        uint error = SetNamedSecurityInfo(path, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (error != 0) throw new Win32Exception((int)error, "Cannot clear integrity label: " + path);
        return true;
    }
}
'@

$root = Get-Item -LiteralPath $TargetDirectory -Force
if (!$root.PSIsContainer -or ($root.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'Cargo output must be a real directory, not a link.'
}
# A non-inheritable root label blocks inherited Low without downgrading executables.
& icacls.exe $root.FullName /setintegritylevel M /Q
if ($LASTEXITCODE -ne 0) { throw 'Cannot block Low inheritance on the Cargo output directory.' }

$directories = [System.Collections.Generic.Stack[string]]::new()
$directories.Push($root.FullName)
$cleared = 0
while ($directories.Count) {
    foreach ($item in (Get-ChildItem -LiteralPath $directories.Pop() -Force)) {
        # Never traverse or relabel junctions/symlinks and their external targets.
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
        if ([AliyaBuildLabels]::Clear($item.FullName)) { $cleared++ }
        if ($item.PSIsContainer) { $directories.Push($item.FullName) }
    }
}
Write-Output "[build] Blocked Low inheritance at output root; cleared $cleared child integrity labels."
