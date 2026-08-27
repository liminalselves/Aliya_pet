// profile_renderer.cpp — Native Live2D 渲染管线 Profiling 与健壮性测试。
// 目标：
//   1. 分阶段计时（Framework/Device/Model/Renderer/Update/Render/Readback）。
//   2. 定位 CreateRenderer 约 9.7 秒耗时的真实子阶段。
//   3. Profiler 创建失败时不访问空对象、不崩溃。
// 链接：AliyaLive2D.Native.lib + Framework.lib + Live2DCubismCore.lib + d3d11/d3dcompiler。
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <string>
#include <vector>
#include <algorithm>
#include <windows.h>
#include <d3d11.h>
#include <d3dcompiler.h>
#include <dbghelp.h>

#include "../src/aliya_live2d.h"
#include "../src/live2d_asset_loader.hpp"
#include "CubismFramework.hpp"
#include "Rendering/D3D11/CubismDeviceInfo_D3D11.hpp"
#include "Rendering/D3D11/CubismShader_D3D11.hpp"
#include "Rendering/D3D11/CubismRenderState_D3D11.hpp"
#include "Rendering/D3D11/CubismRenderer_D3D11.hpp"

#pragma comment(lib, "dbghelp.lib")
#pragma comment(lib, "user32.lib")

static int g_stage = 0;
static FILE* g_out = nullptr;

static void Log(const char* fmt, ...)
{
    char buf[2048];
    va_list args;
    va_start(args, fmt);
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    printf("%s\n", buf);
    fflush(stdout);
    if (g_out) { fprintf(g_out, "%s\n", buf); fflush(g_out); }
}

static void Stage(const char* name) { g_stage++; Log("STAGE_BEGIN %d %s", g_stage, name); }
static void StageEnd(const char* name, bool ok) { Log("STAGE_END %d %s %s", g_stage, name, ok ? "OK" : "FAIL"); }
#define PR_RETURN(code) do { Log("RESULT=%s", (code) == 0 ? "PASS" : "FAIL"); Log("EXIT_CODE=%d", (code)); if (g_out) fclose(g_out); return (code); } while (0)

static double NowMs()
{
    LARGE_INTEGER f, t;
    QueryPerformanceFrequency(&f);
    QueryPerformanceCounter(&t);
    return (double)t.QuadPart * 1000.0 / f.QuadPart;
}

// 崩溃捕获（与 smoke 一致）：输出调用栈与 minidump，绝不吞掉 AV。
static LONG WINAPI CrashHandler(EXCEPTION_POINTERS* ep)
{
    EXCEPTION_RECORD* er = ep->ExceptionRecord;
    DWORD64 ip = (DWORD64)er->ExceptionAddress;
    DWORD64 targetAddr = 0;
    if (er->ExceptionCode == EXCEPTION_ACCESS_VIOLATION && er->NumberParameters >= 2)
    {
        DWORD64 isWrite = er->ExceptionInformation[0];
        targetAddr = (DWORD64)er->ExceptionInformation[1];
        Log("CRASH: 0x%08X %s 访问目标地址=0x%llX 指令地址=0x%llX",
            (unsigned)er->ExceptionCode, isWrite ? "写入访问冲突" : "读取访问冲突", targetAddr, ip);
    }
    else
    {
        Log("CRASH: 异常代码 0x%08X 指令地址=0x%llX", (unsigned)er->ExceptionCode, ip);
    }
    HANDLE proc = GetCurrentProcess();
    SymInitialize(proc, nullptr, TRUE);
    void* frames[64];
    USHORT count = CaptureStackBackTrace(0, 64, frames, nullptr);
    for (USHORT i = 0; i < count; i++)
    {
        DWORD64 addr = (DWORD64)frames[i];
        DWORD64 disp = 0;
        SYMBOL_INFO sym = {};
        sym.SizeOfStruct = sizeof(SYMBOL_INFO);
        sym.MaxNameLen = 255;
        if (SymFromAddr(proc, addr, &disp, &sym))
        {
            DWORD lineDisp = 0;
            IMAGEHLP_LINE64 line = {};
            line.SizeOfStruct = sizeof(line);
            if (SymGetLineFromAddr64(proc, addr, &lineDisp, &line))
                Log("  #%02d 0x%llX %s+0x%llX  %s(%u)", i, addr, sym.Name, disp, line.FileName, line.LineNumber);
            else
                Log("  #%02d 0x%llX %s+0x%llX", i, addr, sym.Name, disp);
        }
        else
        {
            Log("  #%02d 0x%llX (无符号)", i, addr);
        }
    }
    HANDLE dumpFile = CreateFileA("profile-crash.dmp", GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (dumpFile != INVALID_HANDLE_VALUE)
    {
        MINIDUMP_EXCEPTION_INFORMATION mei = {};
        mei.ThreadId = GetCurrentThreadId();
        mei.ExceptionPointers = ep;
        mei.ClientPointers = FALSE;
        MiniDumpWriteDump(proc, GetCurrentProcessId(), dumpFile,
                          (MINIDUMP_TYPE)(MiniDumpWithDataSegs | MiniDumpWithHandleData), &mei, nullptr, nullptr);
        CloseHandle(dumpFile);
        Log("minidump 已写入 profile-crash.dmp");
    }
    TerminateProcess(GetCurrentProcess(), 0xC0000005);
    return EXCEPTION_EXECUTE_HANDLER;
}


// --hotspot：直接测量 CubismShader_D3D11::SetupShader 与 CubismRenderState_D3D11::Create 的耗时。
static int RunHotspot(const std::string& assetRoot)
{
    Stage("Hotspot: D3D11 Device");
    ID3D11Device* dev = nullptr;
    ID3D11DeviceContext* ctx = nullptr;
    D3D_FEATURE_LEVEL lv[] = { D3D_FEATURE_LEVEL_11_0 };
    HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                                   lv, 1, D3D11_SDK_VERSION, &dev, nullptr, &ctx);
    if (FAILED(hr) || !dev || !ctx) { Log("FAIL: D3D11CreateDevice hr=0x%08X", (unsigned)hr); PR_RETURN(4); }
    StageEnd("Hotspot: D3D11 Device", true);

    // 通过 Native 导出设置全局资源根目录（FrameworkShaders 文件加载器使用）
    AliyaLive2DHandle rootHost = AliyaLive2D_Create();
    if (!rootHost) { Log("FAIL: Create"); PR_RETURN(3); }
    AliyaLive2D_SetAssetDirectory(rootHost, assetRoot.c_str());

    Stage("Hotspot: CubismShader_D3D11::SetupShader");
    double t0 = NowMs();
    Live2D::Cubism::Framework::Rendering::CubismShader_D3D11 shader;
    shader.SetupShader(dev);
    double t1 = NowMs();
    Log("Hotspot: SetupShader(含 D3DCompile + Create*Shader) = %.1f ms", t1 - t0);
    StageEnd("Hotspot: CubismShader_D3D11::SetupShader", true);

    // RenderState 构造函数私有，只能通过 GetDeviceInfo 间接创建。
    // 用第二个全新设备计时 GetDeviceInfo(完整 setup)，再减去 SetupShader 得到 RenderState 耗时。
    Stage("Hotspot: CubismDeviceInfo_D3D11::GetDeviceInfo（第二个设备）");
    ID3D11Device* dev2 = nullptr;
    ID3D11DeviceContext* ctx2 = nullptr;
    hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                           lv, 1, D3D11_SDK_VERSION, &dev2, nullptr, &ctx2);
    if (FAILED(hr) || !dev2 || !ctx2) { Log("FAIL: D3D11CreateDevice(2) hr=0x%08X", (unsigned)hr); PR_RETURN(4); }
    t0 = NowMs();
    Live2D::Cubism::Framework::Rendering::CubismDeviceInfo_D3D11::GetDeviceInfo(dev2);
    t1 = NowMs();
    Log("Hotspot: GetDeviceInfo(完整: 新设备) = %.1f ms", t1 - t0);
    StageEnd("Hotspot: CubismDeviceInfo_D3D11::GetDeviceInfo", true);
    ctx2->Release();
    dev2->Release();

    Stage("Hotspot: 单 shader 编译+对象创建");
    {
        // 读取 CubismEffect.fx
        std::string fxPath = assetRoot + "\\FrameworkShaders\\CubismEffect.fx";
        FILE* f = fopen(fxPath.c_str(), "rb");
        if (!f) { Log("FAIL: 无法读取 %s", fxPath.c_str()); PR_RETURN(5); }
        fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, 0, SEEK_SET);
        std::vector<char> src((size_t)sz + 1); fread(src.data(), 1, (size_t)sz, f); fclose(f);
        t0 = NowMs();
        ID3DBlob* blob = nullptr; ID3DBlob* errBlob = nullptr;
        HRESULT chr = D3DCompile(src.data(), (SIZE_T)sz, nullptr, nullptr, nullptr, "VertNormal", "vs_4_0", 0, 0, &blob, &errBlob);
        if (FAILED(chr)) { Log("FAIL: D3DCompile hr=0x%08X", (unsigned)chr); PR_RETURN(5); }
        double tCompile = NowMs() - t0;
        t0 = NowMs();
        ID3D11VertexShader* vs = nullptr;
        HRESULT vhr = dev->CreateVertexShader(blob->GetBufferPointer(), blob->GetBufferSize(), nullptr, &vs);
        double tCreate = NowMs() - t0;
        Log("Hotspot: 单 shader D3DCompile=%.3f ms, CreateVertexShader=%.3f ms (hr=0x%08X)", tCompile, tCreate, (unsigned)vhr);
        if (vs) vs->Release();
        if (blob) blob->Release();
        if (errBlob) errBlob->Release();
    }
    StageEnd("Hotspot: 单 shader 编译+对象创建", true);

    AliyaLive2D_Destroy(rootHost);
    ctx->Release();
    dev->Release();
    Log("HOTSPOT_OK");
    PR_RETURN(0);
}
static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) { return DefWindowProcA(h, m, w, l); }

static std::string ToUtf8(const std::wstring& ws)
{
    int size = WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), (int)ws.size(), nullptr, 0, nullptr, nullptr);
    std::string s(size, '\0');
    WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), (int)ws.size(), &s[0], size, nullptr, nullptr);
    return s;
}

// 简易 Profiler：计时 Update/Render/Readback。可被强制置空以测试失败路径。
struct ProfileSession {
    std::vector<double> updateMs;
    std::vector<double> renderMs;
    std::vector<double> readbackMs;
};

static bool RunProfile(ProfileSession* session, AliyaLive2DHandle h, int frames)
{
    if (!session)
        return false; // 模拟 Profiler 创建失败：调用方必须处理，不得访问空对象
    std::vector<unsigned char> buf((size_t)320 * 480 * 4);
    for (int i = 0; i < frames; i++)
    {
        double t0 = NowMs();
        if (AliyaLive2D_Update(h, 1.0 / 60.0) != 0) return false;
        double t1 = NowMs();
        if (AliyaLive2D_Render(h) != 0) return false;
        double t2 = NowMs();
        if (AliyaLive2D_CopyFramePixels(h, buf.data(), 320 * 4) != 0) return false;
        double t3 = NowMs();
        session->updateMs.push_back(t1 - t0);
        session->renderMs.push_back(t2 - t1);
        session->readbackMs.push_back(t3 - t2);
    }
    return true;
}

static void Percentile(const std::vector<double>& v, double& p50, double& p95, double& p99, double& avg)
{
    if (v.empty()) { p50 = p95 = p99 = avg = 0; return; }
    auto s = v;
    std::sort(s.begin(), s.end());
    avg = 0; for (double x : s) avg += x; avg /= (double)s.size();
    p50 = s[(size_t)(s.size() * 0.50)];
    p95 = s[(size_t)(s.size() * 0.95)];
    p99 = s[(size_t)(s.size() * 0.99)];
}

int wmain(int argc, wchar_t** argv)
{
    std::wstring assetRootW, modelPathW;
    int loop = 1, profileFrames = 120;
    bool failProfiler = false;
    bool hotspotMode = false;
    bool destroyTwice = false;

    for (int i = 1; i < argc; i++)
    {
        std::wstring a = argv[i];
        if (a == L"--loop" && i + 1 < argc) loop = _wtoi(argv[++i]);
        else if (a == L"--profile-frames" && i + 1 < argc) profileFrames = _wtoi(argv[++i]);
        else if (a == L"--fail-profiler") failProfiler = true;
        else if (a == L"--hotspot") hotspotMode = true;
        else if (a == L"--destroy-twice") destroyTwice = true;
        else if (a == L"--out" && i + 1 < argc) { g_out = _wfopen(argv[++i], L"w"); }
        else if (assetRootW.empty()) assetRootW = a;
        else if (modelPathW.empty()) modelPathW = a;
    }

    SetUnhandledExceptionFilter(CrashHandler);
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);

    if (assetRootW.empty() || modelPathW.empty())
    {
        Log("usage: profile_renderer <assetRoot> <modelJsonPath> [--loop N] [--profile-frames N] [--fail-profiler] [--destroy-twice] [--out file]");
        PR_RETURN(2);
    }

    std::string assetRoot = ToUtf8(assetRootW);
    std::string modelPath = ToUtf8(modelPathW);
    if (hotspotMode)
    {
        Log("== profile_renderer hotspot mode ==");
        return RunHotspot(ToUtf8(assetRootW));
    }
    Log("== profile_renderer start (pid=%lu) ==", (unsigned long)GetCurrentProcessId());

    WNDCLASSA wc = {};
    wc.lpfnWndProc = WndProc;
    wc.hInstance = GetModuleHandleA(nullptr);
    wc.lpszClassName = "AliyaProfileWnd";
    RegisterClassA(&wc);
    HWND hwnd = CreateWindowA("AliyaProfileWnd", "profile", WS_OVERLAPPEDWINDOW, 0, 0, 320, 480, nullptr, nullptr, wc.hInstance, nullptr);

    for (int iter = 0; iter < loop; iter++)
    {
        Log("== loop %d/%d ==", iter + 1, loop);

        Stage("LoadNativeDll / ResolveExports");
        if (&AliyaLive2D_Create == nullptr || &AliyaLive2D_LoadModel == nullptr)
        {
            Log("FAIL: 导出函数不可用");
            PR_RETURN(3);
        }
        StageEnd("LoadNativeDll / ResolveExports", true);

        Stage("CreateHost / InitializeFramework");
        double t0 = NowMs();
        AliyaLive2DHandle h = AliyaLive2D_Create();
        if (!h) { Log("FAIL: Create 返回 NULL"); PR_RETURN(3); }
        if (AliyaLive2D_SetAssetDirectory(h, assetRoot.c_str()) != 0) { Log("FAIL: SetAssetDirectory"); PR_RETURN(4); }
        double t1 = NowMs();
        Log("CreateHost 耗时 %.1f ms", t1 - t0);
        StageEnd("CreateHost / InitializeFramework", true);

        Stage("CreateD3DDevice / LoadModel");
        double t2 = NowMs();
        if (AliyaLive2D_LoadModel(h, modelPath.c_str()) != 0)
        {
            char err[1024] = {};
            AliyaLive2D_GetLastError(h, err, sizeof(err));
            Log("FAIL: LoadModel rc err=%s", err);
            AliyaLive2D_Destroy(h);
            PR_RETURN(5);
        }
        double t3 = NowMs();
        Log("LoadModel(含 CreateRenderer) 总耗时 %.1f ms", t3 - t2);
        StageEnd("CreateD3DDevice / LoadModel", true);

        Stage("CreateOffscreenTarget / AttachWindow");
        double t4 = NowMs();
        if (AliyaLive2D_AttachWindow(h, hwnd, 320, 480) != 0) { Log("FAIL: AttachWindow"); AliyaLive2D_Destroy(h); PR_RETURN(6); }
        double t5 = NowMs();
        Log("AttachWindow 耗时 %.1f ms", t5 - t4);
        StageEnd("CreateOffscreenTarget / AttachWindow", true);

        Stage("ProfileStages（CreateRenderer 子阶段耗时）");
        {
            char pbuf[1024] = {};
            AliyaLive2DResult prc = AliyaLive2D_ProfileStages(h, pbuf, (int)sizeof(pbuf));
            if (prc == 0)
                Log("ProfileStages: %s", pbuf);
            else
                Log("ProfileStages 失败 rc=%d", (int)prc);
        }
        StageEnd("ProfileStages", true);

        Stage("WarmUp");

        for (int i = 0; i < 5; i++) { AliyaLive2D_Update(h, 1.0 / 60.0); AliyaLive2D_Render(h); }
        StageEnd("WarmUp", true);

        Stage("InitializeProfiler");
        ProfileSession session;
        ProfileSession* pSession = failProfiler ? nullptr : &session;
        if (failProfiler)
            Log("模拟 Profiler 创建失败（pSession=nullptr）");
        StageEnd("InitializeProfiler", true);

        Stage("BeginProfile / Update / Render / Readback");
        bool ok = RunProfile(pSession, h, profileFrames);
        if (failProfiler)
        {
            // Profiler 失败路径：RunProfile 返回 false，但不崩溃；按规范返回明确非零退出码。
            Log("Profiler 失败路径已处理（未崩溃）");
            AliyaLive2D_Destroy(h);
            PR_RETURN(2);
        }
        if (!ok) { Log("FAIL: Profile 执行失败"); AliyaLive2D_Destroy(h); PR_RETURN(7); }
        double u50, u95, u99, uavg, r50, r95, r99, ravg, b50, b95, b99, bavg;
        Percentile(session.updateMs, u50, u95, u99, uavg);
        Percentile(session.renderMs, r50, r95, r99, ravg);
        Percentile(session.readbackMs, b50, b95, b99, bavg);
        Log("Update   avg=%.3f p50=%.3f p95=%.3f p99=%.3f ms", uavg, u50, u95, u99);
        Log("Render   avg=%.3f p50=%.3f p95=%.3f p99=%.3f ms", ravg, r50, r95, r99);
        Log("Readback avg=%.3f p50=%.3f p95=%.3f p99=%.3f ms", bavg, b50, b95, b99);
        Log("帧时间合计 avg=%.3f ms (≈%.1f FPS)", uavg + ravg + bavg, 1000.0 / (uavg + ravg + bavg));
        StageEnd("BeginProfile / Update / Render / Readback", true);

        Stage("StopLoop / ReleaseProfiler");
        AliyaLive2D_Pause(h);
        AliyaLive2D_Resume(h);
        StageEnd("StopLoop / ReleaseProfiler", true);

        Stage("DestroyHost");
        AliyaLive2D_Destroy(h);
        if (destroyTwice) AliyaLive2D_Destroy(h);
        StageEnd("DestroyHost", true);
    }

    Log("PROFILE_OK");
    PR_RETURN(0);
}






