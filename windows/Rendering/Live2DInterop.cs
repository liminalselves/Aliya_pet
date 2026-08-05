using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Reflection;
using System.Collections.Generic;

namespace AliyaPet.Rendering;

// AliyaLive2D.Native.dll 的 C ABI P/Invoke 声明。
internal static class Live2DInterop
{
    public const int OK = 0;
    public const int ErrInvalidArg = -1;
    public const int ErrInitFailed = -2;
    public const int ErrLoadFailed = -3;
    public const int ErrDeviceFailed = -4;
    public const int ErrModelFailed = -5;
    public const int ErrNotReady = -6;
    public const int ErrAlreadyExists = -7;
    public const int ErrD3D9 = -8;
    public const int ErrPhysics = -9;
    public const int ErrState = -10;
    public const int ErrUnsupported = -11;

    [StructLayout(LayoutKind.Sequential)]
    public struct AliyaLive2DModelInfo
    {
        public int ParameterCount;
        public int DrawableCount;
        public int TextureCount;
        public float CanvasWidth;
        public float CanvasHeight;
        public int HasPhysics;
        public int HasEyeBlink;
        public int HasLipSync;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct AliyaLive2DActionInfo
    {
        public int IsPlaying;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string CurrentActionId;
        public double Elapsed;
        public double Duration;
        public int Priority;
    }

    private const string DllName = "AliyaLive2D.Native.dll";

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern IntPtr AliyaLive2D_Create();

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_SetAssetDirectory(IntPtr handle, [MarshalAs(UnmanagedType.LPUTF8Str)] string utf8Root);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_LoadModel(IntPtr handle, [MarshalAs(UnmanagedType.LPUTF8Str)] string utf8ModelJsonPath);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_AttachWindow(IntPtr handle, IntPtr hwnd, int widthPx, int heightPx);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_SetViewport(IntPtr handle, int widthPx, int heightPx);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_Update(IntPtr handle, double deltaSeconds);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_Render(IntPtr handle);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_SetScale(IntPtr handle, double scale);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_SetOpacity(IntPtr handle, double opacity);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_SetState(IntPtr handle, [MarshalAs(UnmanagedType.LPUTF8Str)] string state, double intensity);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_PlayAction(IntPtr handle, [MarshalAs(UnmanagedType.LPUTF8Str)] string action);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_SetLookTarget(IntPtr handle, double x, double y);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_ClearLookTarget(IntPtr handle);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_SetLookAtEnabled(IntPtr handle, int enabled);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_SetLipSyncValue", ExactSpelling = true)]
    public static extern int AliyaLive2D_SetLipSyncValue(IntPtr handle, double value);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_SetMouthOverride", ExactSpelling = true)]
    public static extern int AliyaLive2D_SetMouthOverride(IntPtr handle, int enabled, double openY, double form);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_GetMouthParamInfo", ExactSpelling = true)]
    public static extern int AliyaLive2D_GetMouthParamInfo(IntPtr handle, out AliyaLive2DMouthParamInfo info);

    [StructLayout(LayoutKind.Sequential)]
    public struct AliyaLive2DMouthParamInfo
    {
        public int HasOpenY;
        public int HasForm;
        public float OpenYMin;
        public float OpenYMax;
        public float FormMin;
        public float FormMax;
    }

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_SetInteractionOffsets", ExactSpelling = true)]
    public static extern int AliyaLive2D_SetInteractionOffsets(IntPtr handle, double angleX, double angleY, double angleZ, double bodyAngleX);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_SetEyeOverride", ExactSpelling = true)]
    public static extern int AliyaLive2D_SetEyeOverride(IntPtr handle, int enabled, double leftOpen, double rightOpen);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_SetEarInteraction", ExactSpelling = true)]
    public static extern int AliyaLive2D_SetEarInteraction(IntPtr handle, int enabled, double leftValue, double rightValue);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_SetPettingLookAtReduction", ExactSpelling = true)]
    public static extern int AliyaLive2D_SetPettingLookAtReduction(IntPtr handle, int enabled);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_GetInteractionParamInfo", ExactSpelling = true)]
    public static extern int AliyaLive2D_GetInteractionParamInfo(IntPtr handle, out AliyaLive2DInteractionParamInfo info);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_ListEarParams", ExactSpelling = true)]
    public static extern int AliyaLive2D_ListEarParams(IntPtr handle, StringBuilder buffer, int bufferSize);

    [StructLayout(LayoutKind.Sequential)]
    public struct AliyaLive2DInteractionParamInfo
    {
        public int HasAngleX;
        public int HasAngleY;
        public int HasAngleZ;
        public int HasBodyAngleX;
        public float AngleXMin;
        public float AngleXMax;
        public float AngleYMin;
        public float AngleYMax;
        public float AngleZMin;
        public float AngleZMax;
        public float BodyXMin;
        public float BodyXMax;
        public int HasEyeL;
        public int HasEyeR;
        public float EyeLMin;
        public float EyeLMax;
        public float EyeRMin;
        public float EyeRMax;
        public int HasLeftEarRoot;
        public int HasRightEarRoot;
        public float LeftEarRootMin;
        public float LeftEarRootMax;
        public float RightEarRootMin;
        public float RightEarRootMax;
        public int EarRootPhysics;
    }

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_SetGazeSpeed(IntPtr handle, double multiplier);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_SetPhysicsStrength", ExactSpelling = true)]
    public static extern int AliyaLive2D_SetPhysicsStrength(IntPtr handle, float strength);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_GetPhysicsStrength", ExactSpelling = true)]
    public static extern int AliyaLive2D_GetPhysicsStrength(IntPtr handle, out float outCurrent, out float outTarget);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_SetMouseIdleTimeout", ExactSpelling = true)]
    public static extern int AliyaLive2D_SetMouseIdleTimeout(IntPtr handle, float seconds);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_GetMouseIdleTimeout", ExactSpelling = true)]
    public static extern int AliyaLive2D_GetMouseIdleTimeout(IntPtr handle, out float outSeconds);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_GetMouseIdleElapsed", ExactSpelling = true)]
    public static extern int AliyaLive2D_GetMouseIdleElapsed(IntPtr handle, out float outSeconds);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_GetGazeActivityState", ExactSpelling = true)]
    public static extern int AliyaLive2D_GetGazeActivityState(IntPtr handle, out int outState);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_SetPhysicsInputGain", ExactSpelling = true)]
    public static extern int AliyaLive2D_SetPhysicsInputGain(IntPtr handle, float headGain, float bodyGain);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_SetPhysicsOutputGain", ExactSpelling = true)]
    public static extern int AliyaLive2D_SetPhysicsOutputGain(IntPtr handle, float gain);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_SetPhysicsOutputAmplitude", ExactSpelling = true)]
    public static extern int AliyaLive2D_SetPhysicsOutputAmplitude(IntPtr handle, float amplitude);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_GetPhysicsOutputAmplitude", ExactSpelling = true)]
    public static extern int AliyaLive2D_GetPhysicsOutputAmplitude(IntPtr handle, out float outCurrent, out float outTarget);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_SetPhysicsEnabled", ExactSpelling = true)]
    public static extern int AliyaLive2D_SetPhysicsEnabled(IntPtr handle, int enabled);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_SetPhysicsTestInput", ExactSpelling = true)]
    public static extern int AliyaLive2D_SetPhysicsTestInput(IntPtr handle, int enabled,
        float angleX, float angleZ, float bodyAngleX, float bodyAngleZ);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_GetPhysicsGains", ExactSpelling = true)]
    public static extern int AliyaLive2D_GetPhysicsGains(IntPtr handle,
        out float outHeadCurrent, out float outHeadTarget,
        out float outBodyCurrent, out float outBodyTarget,
        out float outOutputCurrent, out float outOutputTarget);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_GetPhysicsDriveInfo", ExactSpelling = true)]
    public static extern int AliyaLive2D_GetPhysicsDriveInfo(IntPtr handle, out AliyaLive2DPhysicsDriveInfo info);

    [StructLayout(LayoutKind.Sequential)]
    public struct AliyaLive2DPhysicsDriveInfo
    {
        public float VisibleAngleX, VisibleAngleZ, VisibleBodyX, VisibleBodyZ;
        public float PhysicsAngleX, PhysicsAngleZ, PhysicsBodyX, PhysicsBodyZ;
        public float VelocityHeadX, VelocityHeadZ;
        public int EvaluateCount;
        public float OutputMaxDelta;
        public float HeadInputGain, BodyInputGain, OutputGain;
        public float OutputAmplitude, OutputAmplitudeTarget;
        public float OutputFinalMaxDelta;
        public int OutputClampHits;
        public int UniqueOutputCount;
        public int AmplitudeApplyCount;
        public int PhysicsFps;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct AliyaLive2DGazeDiagnostics
    {
        public float HeadMaxX, HeadMaxY, HeadMaxZ;
        public float HeadRangeX, HeadRangeY, HeadRangeZ;
        public float HeadFollowAmount;
        public float HeadFollowAmountTarget;
        public float GazeWeight;
        public float ActionGazeMask;
        public float FinalGazeMultiplier;
        public float HeadTargetX, HeadTargetY, HeadTargetZ;
        public float RawX, RawY, MappedX, MappedY;
        public float BeforeGazeX, AfterGazeX, BeforeModelUpdateX;
        public float BeforeGazeY, AfterGazeY, BeforeModelUpdateY;
    }

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_SetGazeRawInput", ExactSpelling = true)]
    public static extern int AliyaLive2D_SetGazeRawInput(IntPtr handle, double x, double y);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_SetGazeHeadRange", ExactSpelling = true)]
    public static extern int AliyaLive2D_SetGazeHeadRange(IntPtr handle, float rangeX, float rangeY, float rangeZ);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_GetGazeHeadRange", ExactSpelling = true)]
    public static extern int AliyaLive2D_GetGazeHeadRange(IntPtr handle, out float outRangeX, out float outRangeY, out float outRangeZ);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_SetGazeHeadFollowAmount", ExactSpelling = true)]
    public static extern int AliyaLive2D_SetGazeHeadFollowAmount(IntPtr handle, float amount);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_GetGazeHeadFollowAmount", ExactSpelling = true)]
    public static extern int AliyaLive2D_GetGazeHeadFollowAmount(IntPtr handle, out float outCurrent, out float outTarget);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_GetGazeDiagnostics", ExactSpelling = true)]
    public static extern int AliyaLive2D_GetGazeDiagnostics(IntPtr handle, out AliyaLive2DGazeDiagnostics info);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "AliyaLive2D_GetApiVersion", ExactSpelling = true)]
    public static extern int AliyaLive2D_GetApiVersion();

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_HitTest(IntPtr handle, double x, double y);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_Pause(IntPtr handle);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_Resume(IntPtr handle);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_GetInfo(IntPtr handle, out AliyaLive2DModelInfo info);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_GetParameterValue(IntPtr handle, [MarshalAs(UnmanagedType.LPUTF8Str)] string id, out double value);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_SetParameterValue(IntPtr handle, [MarshalAs(UnmanagedType.LPUTF8Str)] string id, double value);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_CopyFramePixels(IntPtr handle, IntPtr dest, int destStride);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern IntPtr AliyaLive2D_GetBackBufferSurface(IntPtr handle);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_GetLastError(IntPtr handle, StringBuilder buffer, int bufferSize);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_ForceBlink(IntPtr handle);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_ListActions(IntPtr handle, StringBuilder buffer, int bufferSize);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_GetActionInfo(IntPtr handle, out AliyaLive2DActionInfo info);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int AliyaLive2D_PollActionEvents(IntPtr handle, StringBuilder buffer, int bufferSize);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern void AliyaLive2D_Destroy(IntPtr handle);

    public const int ExpectedNativeApiVersion = 8;

    public static void CheckApiVersion()
    {
        int version = AliyaLive2D_GetApiVersion();
        if (version != ExpectedNativeApiVersion)
            throw new InvalidOperationException($"NATIVE_ABI_VERSION_MISMATCH: expected {ExpectedNativeApiVersion}, got {version}");
    }

    public static string GetLastError(IntPtr handle)
    {
        var sb = new StringBuilder(2048);
        try
        {
            AliyaLive2D_GetLastError(handle, sb, sb.Capacity);
        }
        catch (Exception)
        {
            // DLL 加载失败等情况
        }
        return sb.ToString();
    }


    /// <summary>在调用 Native 前校验模型包完整性（JSON 可解析 + 引用文件存在）。损坏时抛出异常。</summary>
    public static void ValidateModelBundle(string modelJsonPath)
    {
        if (!File.Exists(modelJsonPath))
            throw new FileNotFoundException("model3.json 不存在: " + modelJsonPath);

        using var doc = JsonDocument.Parse(File.ReadAllText(modelJsonPath));
        if (!doc.RootElement.TryGetProperty("FileReferences", out var fr))
            throw new InvalidDataException("model3.json 缺少 FileReferences");

        string dir = Path.GetDirectoryName(modelJsonPath)!;
        string[] refs =
        {
            fr.TryGetProperty("Moc", out var moc) ? moc.GetString()! : "",
            fr.TryGetProperty("Physics", out var ph) ? ph.GetString() ?? "" : "",
            fr.TryGetProperty("DisplayInfo", out var di) ? di.GetString() ?? "" : ""
        };
        if (fr.TryGetProperty("Textures", out var tex))
        {
            foreach (var t in tex.EnumerateArray())
                refs = refs.Append(t.GetString() ?? "").ToArray();
        }
        foreach (var rel in refs)
        {
            if (string.IsNullOrWhiteSpace(rel)) continue;
            if (!File.Exists(Path.Combine(dir, rel.Replace('/', Path.DirectorySeparatorChar))))
                throw new FileNotFoundException("模型引用文件缺失: " + rel);
        }
    }

    public static string ModelJsonPath
    {
        get
        {
            return Path.Combine(AppContext.BaseDirectory, "Assets", "Live2D", "Aliya", "16.model3.json");
        }
    }

    /// <summary>启动时预检所有必需的 Native 导出符号。缺失时返回缺失列表。</summary>
    public static List<string> PrefetchNativeExports(out string dllPath, out string dllVersion)
    {
        var missing = new List<string>();
        dllPath = "";
        dllVersion = "unknown";
        IntPtr lib = IntPtr.Zero;
        try
        {
            dllPath = Path.Combine(AppContext.BaseDirectory, "AliyaLive2D.Native.dll");
            if (!File.Exists(dllPath))
            {
                missing.Add("AliyaLive2D.Native.dll (文件不存在)");
                return missing;
            }
            var versionInfo = System.Diagnostics.FileVersionInfo.GetVersionInfo(dllPath);
            dllVersion = versionInfo.FileVersion ?? "unknown";
            lib = NativeLibrary.Load(dllPath);

            string[] required =
            {
                "AliyaLive2D_Create",
                "AliyaLive2D_Destroy",
                "AliyaLive2D_LoadModel",
                "AliyaLive2D_Update",
                "AliyaLive2D_Render",
                "AliyaLive2D_CopyFramePixels",
                "AliyaLive2D_AttachWindow",
                "AliyaLive2D_SetLookTarget",
                "AliyaLive2D_SetGazeRawInput",
                "AliyaLive2D_SetGazeHeadRange",
                "AliyaLive2D_GetGazeHeadRange",
                "AliyaLive2D_SetGazeHeadFollowAmount",
                "AliyaLive2D_GetGazeHeadFollowAmount",
                "AliyaLive2D_GetGazeDiagnostics",
                "AliyaLive2D_SetLookAtEnabled",
                "AliyaLive2D_SetLipSyncValue",
"AliyaLive2D_SetPhysicsStrength",
        "AliyaLive2D_GetPhysicsStrength",
        "AliyaLive2D_SetPhysicsInputGain",
        "AliyaLive2D_SetPhysicsOutputGain",
        "AliyaLive2D_SetPhysicsOutputAmplitude",
        "AliyaLive2D_GetPhysicsOutputAmplitude",
        "AliyaLive2D_SetPhysicsEnabled",
        "AliyaLive2D_SetPhysicsTestInput",
                "AliyaLive2D_GetPhysicsGains",
                "AliyaLive2D_GetPhysicsDriveInfo",
                "AliyaLive2D_SetMouseIdleTimeout",
                "AliyaLive2D_GetApiVersion"
            };
            foreach (var name in required)
            {
                if (!NativeLibrary.TryGetExport(lib, name, out _))
                    missing.Add(name);
            }
            string[] optional =
            {
                "AliyaLive2D_GetPhysicsStrength",
                "AliyaLive2D_GetMouseIdleTimeout",
                "AliyaLive2D_GetMouseIdleElapsed",
                "AliyaLive2D_GetGazeActivityState",
                "AliyaLive2D_ForceBlink",
                "AliyaLive2D_GetInfo",
                "AliyaLive2D_GetLastError"
            };
            foreach (var name in optional)
            {
                if (!NativeLibrary.TryGetExport(lib, name, out _))
                    AppLog.Warn("可选 Native 符号缺失（功能将禁用）: {0}", name);
            }
        }
        catch (Exception ex)
        {
            missing.Add($"Native DLL 加载异常: {ex.Message}");
        }
        finally
        {
            if (lib != IntPtr.Zero)
                NativeLibrary.Free(lib);
        }
        return missing;
    }

/// <summary>校验 Native ABI 版本是否匹配。</summary>
    public static bool CheckApiVersionStrict()
    {
        try
        {
            int version = AliyaLive2D_GetApiVersion();
            if (version != ExpectedNativeApiVersion)
            {
                AppLog.Error($"NATIVE_ABI_VERSION_MISMATCH: expected {ExpectedNativeApiVersion}, got {version}");
                return false;
            }
            return true;
        }
        catch (Exception ex)
        {
            AppLog.Error($"ABI 版本检查异常: {ex.Message}");
            return false;
        }
    }

    // ---------- 自动化测试：导出审计 ----------

    /// <summary>解析 PE 导出表，返回全部导出名称（通配名，含 C++ 修饰名原样返回）。</summary>
    public static List<string> ParseNativeExports(string dllPath)
    {
        var names = new List<string>();
        try
        {
            using var fs = new FileStream(dllPath, FileMode.Open, FileAccess.Read);
            using var br = new BinaryReader(fs);
            if (fs.Length < 0x40) return names;
            fs.Seek(0x3C, SeekOrigin.Begin);
            int peOffset = br.ReadInt32();
            if (peOffset < 0 || peOffset + 24 > fs.Length) return names;
            fs.Seek(peOffset, SeekOrigin.Begin);
            if (br.ReadUInt32() != 0x00004550) return names; // "PE\0\0"
            fs.Seek(peOffset + 4 + 2, SeekOrigin.Begin);
            ushort numSections = br.ReadUInt16();
            fs.Seek(peOffset + 4 + 16, SeekOrigin.Begin);
            ushort optSize = br.ReadUInt16();
            fs.Seek(peOffset + 4 + 20, SeekOrigin.Begin);
            uint magic = br.ReadUInt16();
            int dataDirOffset = (magic == 0x20B) ? peOffset + 4 + 20 + 112 : peOffset + 4 + 20 + 96;
            if (dataDirOffset + 8 > fs.Length) return names;
            fs.Seek(dataDirOffset, SeekOrigin.Begin);
            int exportRva = br.ReadInt32();
            if (exportRva == 0) return names;

            // 读取节表，建立 RVA -> 文件偏移 映射
            int sectionTable = peOffset + 4 + 20 + optSize;
            var sections = new List<(int va, int vsize, int raw, int rawSize)>();
            fs.Seek(sectionTable, SeekOrigin.Begin);
            for (int i = 0; i < numSections && fs.Position + 40 <= fs.Length; i++)
            {
                fs.Seek(8, SeekOrigin.Current); // 节名(8 字节)
                int vsize = br.ReadInt32();
                int va = br.ReadInt32();
                int rawSize = br.ReadInt32();
                int raw = br.ReadInt32();
                sections.Add((va, vsize, raw, rawSize));
                fs.Seek(16, SeekOrigin.Current);
            }

            long RvaToOffset(int rva)
            {
                foreach (var (va, vsize, raw, rawSize) in sections)
                {
                    int size = Math.Max(vsize, rawSize);
                    if (rva >= va && rva < va + size)
                        return raw + (rva - va);
                }
                return -1;
            }

            byte[] ReadBytes(long offset, int count)
            {
                if (offset < 0 || offset + count > fs.Length) return Array.Empty<byte>();
                fs.Seek(offset, SeekOrigin.Begin);
                return br.ReadBytes(count);
            }

            string ReadCString(long offset)
            {
                var sb = new StringBuilder();
                int maxLen = 4096;
                while (maxLen-- > 0 && offset < fs.Length)
                {
                    fs.Seek(offset, SeekOrigin.Begin);
                    byte b = br.ReadByte();
                    if (b == 0) break;
                    sb.Append((char)b);
                    offset++;
                }
                return sb.ToString();
            }

            long expOffset = RvaToOffset(exportRva);
            if (expOffset < 0) return names;
            byte[] exp = ReadBytes(expOffset, 40);
            if (exp.Length < 40) return names;
            int numNames = BitConverter.ToInt32(exp, 24);
            int addressOfNames = BitConverter.ToInt32(exp, 32);
            long nameTableOff = RvaToOffset(addressOfNames);
            for (int i = 0; i < numNames; i++)
            {
                long ptrOff = nameTableOff + i * 4;
                if (ptrOff + 4 > fs.Length) break;
                fs.Seek(ptrOff, SeekOrigin.Begin);
                int rva = br.ReadInt32();
                long sOff = RvaToOffset(rva);
                string n = ReadCString(sOff);
                if (n.Length > 0) names.Add(n);
            }
        }
        catch
        {
            // 解析失败返回已收集名称
        }
        return names;
    }

    /// <summary>完整导出审计：Managed 声明 vs Native 实际导出。</summary>
    public static NativeExportAudit AuditExports()
    {
        var audit = new NativeExportAudit();
        string dllPath = Path.Combine(AppContext.BaseDirectory, "AliyaLive2D.Native.dll");
        if (!File.Exists(dllPath))
        {
            audit.Error = "DLL 不存在: " + dllPath;
            return audit;
        }
        audit.DllPath = dllPath;
        audit.NativeExports = ParseNativeExports(dllPath);
        var nativeSet = new HashSet<string>(audit.NativeExports, StringComparer.Ordinal);

        foreach (var name in ManagedExportNames)
        {
            if (nativeSet.Contains(name))
                audit.ExactMatch.Add(name);
            else
                audit.ManagedOnly.Add(name); // 缺失导出
        }
        audit.NativeOnly.AddRange(audit.NativeExports.Where(n => !ManagedExportNames.Contains(n)));
        return audit;
    }

    /// <summary>Managed 层声明的全部 Native 入口名称。</summary>
    public static readonly string[] ManagedExportNames =
    {
        "AliyaLive2D_Create",
        "AliyaLive2D_SetAssetDirectory",
        "AliyaLive2D_LoadModel",
        "AliyaLive2D_AttachWindow",
        "AliyaLive2D_SetViewport",
        "AliyaLive2D_Update",
        "AliyaLive2D_Render",
        "AliyaLive2D_SetScale",
        "AliyaLive2D_SetOpacity",
        "AliyaLive2D_SetState",
        "AliyaLive2D_PlayAction",
        "AliyaLive2D_SetLookTarget",
        "AliyaLive2D_SetGazeRawInput",
        "AliyaLive2D_SetGazeHeadRange",
        "AliyaLive2D_GetGazeHeadRange",
        "AliyaLive2D_SetGazeHeadFollowAmount",
        "AliyaLive2D_GetGazeHeadFollowAmount",
        "AliyaLive2D_GetGazeDiagnostics",
        "AliyaLive2D_ClearLookTarget",
        "AliyaLive2D_SetLookAtEnabled",
        "AliyaLive2D_SetLipSyncValue",
        "AliyaLive2D_SetMouthOverride",
        "AliyaLive2D_GetMouthParamInfo",
        "AliyaLive2D_SetInteractionOffsets",
        "AliyaLive2D_SetEyeOverride",
        "AliyaLive2D_SetEarInteraction",
        "AliyaLive2D_GetInteractionParamInfo",
        "AliyaLive2D_ListEarParams",
        "AliyaLive2D_SetGazeSpeed",
        "AliyaLive2D_SetPhysicsStrength",
        "AliyaLive2D_GetPhysicsStrength",
        "AliyaLive2D_SetPhysicsOutputAmplitude",
        "AliyaLive2D_GetPhysicsOutputAmplitude",
        "AliyaLive2D_SetMouseIdleTimeout",
        "AliyaLive2D_GetMouseIdleTimeout",
        "AliyaLive2D_GetMouseIdleElapsed",
        "AliyaLive2D_GetGazeActivityState",
        "AliyaLive2D_GetApiVersion",
        "AliyaLive2D_HitTest",
        "AliyaLive2D_Pause",
        "AliyaLive2D_Resume",
        "AliyaLive2D_GetInfo",
        "AliyaLive2D_CopyFramePixels",
        "AliyaLive2D_GetBackBufferSurface",
        "AliyaLive2D_GetLastError",
        "AliyaLive2D_ForceBlink",
        "AliyaLive2D_ListActions",
        "AliyaLive2D_GetActionInfo",
        "AliyaLive2D_PollActionEvents",
        "AliyaLive2D_Destroy",
        "AliyaLive2D_SetGazeIdleTimeout"
    };
}

/// <summary>导出审计结果。</summary>
public sealed class NativeExportAudit
{
    public string DllPath = "";
    public string Error = "";
    public List<string> NativeExports = new();
    public List<string> ExactMatch = new();
    public List<string> ManagedOnly = new();
    public List<string> NativeOnly = new();
    public List<string> SignatureMismatch = new();
}




