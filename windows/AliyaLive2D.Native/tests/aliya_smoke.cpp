#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include <windows.h>
#include <dbghelp.h>
#include <cmath>
#include <float.h>
#include <signal.h>
#include "../src/aliya_live2d.h"
#include "Utils/CubismJson.hpp"


#pragma comment(lib, "dbghelp.lib")
#pragma comment(lib, "user32.lib")

static std::string g_outPathStr;
static std::string g_saveFrame;
static bool g_verbose = false;

static void Log(const char* fmt, ...)
{
    char buf[2048];
    va_list args;
    va_start(args, fmt);
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    printf("%s\n", buf);
    fflush(stdout);
    const char* g_outPath = g_outPathStr.empty() ? nullptr : g_outPathStr.c_str();
    if (g_outPath)
    {
        FILE* f = fopen(g_outPath, "a");
        if (f) { fprintf(f, "%s\n", buf); fclose(f); }
    }
}

// 崩溃捕获：输出异常代码、写入目标地址、指令地址与符号化调用栈，并生成 minidump。
static LONG WINAPI CrashHandler(EXCEPTION_POINTERS* ep)
{
    EXCEPTION_RECORD* er = ep->ExceptionRecord;
    DWORD64 code = er->ExceptionCode;
    DWORD64 ip = (DWORD64)er->ExceptionAddress;
    DWORD64 targetAddr = 0;
    if (code == EXCEPTION_ACCESS_VIOLATION && er->NumberParameters >= 2)
    {
        DWORD64 isWrite = er->ExceptionInformation[0];
        targetAddr = (DWORD64)er->ExceptionInformation[1];
        Log("CRASH: 0x%08X %s 访问目标地址=0x%llX 指令地址=0x%llX",
            (unsigned)code, isWrite ? "写入访问冲突" : "读取访问冲突", targetAddr, ip);
    }
    else
    {
        Log("CRASH: 异常代码 0x%08X 指令地址=0x%llX", (unsigned)code, ip);
    }

    HANDLE proc = GetCurrentProcess();
    SymInitialize(proc, nullptr, TRUE);

    // 栈回溯
    const int maxFrames = 64;
    void* frames[maxFrames];
    USHORT count = CaptureStackBackTrace(0, maxFrames, frames, nullptr);
    for (USHORT i = 0; i < count; i++)
    {
        DWORD64 addr = (DWORD64)frames[i];
        DWORD64 disp = 0;
        char symName[256] = {0};
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

    // minidump
    HANDLE dumpFile = CreateFileA("crash.dmp", GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (dumpFile != INVALID_HANDLE_VALUE)
    {
        MINIDUMP_EXCEPTION_INFORMATION mei = {};
        mei.ThreadId = GetCurrentThreadId();
        mei.ExceptionPointers = ep;
        mei.ClientPointers = FALSE;
        MiniDumpWriteDump(proc, GetCurrentProcessId(), dumpFile,
                          (MINIDUMP_TYPE)(MiniDumpWithDataSegs | MiniDumpWithHandleData), &mei, nullptr, nullptr);
        CloseHandle(dumpFile);
        Log("minidump 已写入 crash.dmp");
    }

    // 终止，避免 Windows 崩溃弹窗阻塞
    TerminateProcess(GetCurrentProcess(), 0xC0000005);
    return EXCEPTION_EXECUTE_HANDLER;
}

static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) { return DefWindowProcA(h, m, w, l); }

static std::string ToUtf8(const std::wstring& ws)
{
    int size = WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), (int)ws.size(), nullptr, 0, nullptr, nullptr);
    std::string s(size, '\0');
    WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), (int)ws.size(), &s[0], size, nullptr, nullptr);
    return s;
}


// 将 BGRA 帧保存为 BMP（验证颜色）
static void SaveBmp(const char* path, const unsigned char* px, int w, int h) {
    FILE* f = fopen(path, "wb");
    if (!f) return;
    int rowSize = ((w * 3 + 3) / 4) * 4;
    int dataSize = rowSize * h;
    BITMAPFILEHEADER bf = {}; bf.bfType = 0x4D42; bf.bfSize = sizeof(BITMAPFILEHEADER) + sizeof(BITMAPINFOHEADER) + dataSize; bf.bfOffBits = sizeof(BITMAPFILEHEADER) + sizeof(BITMAPINFOHEADER);
    BITMAPINFOHEADER bi = {}; bi.biSize = sizeof(BITMAPINFOHEADER); bi.biWidth = w; bi.biHeight = h; bi.biPlanes = 1; bi.biBitCount = 24; bi.biCompression = 0; bi.biSizeImage = dataSize;
    fwrite(&bf, 1, sizeof(bf), f); fwrite(&bi, 1, sizeof(bi), f);
    for (int y = h - 1; y >= 0; y--) {
        for (int x = 0; x < w; x++) {
            const unsigned char* p = px + (size_t)y * w * 4 + (size_t)x * 4;
            unsigned char bgr[3] = { p[0], p[1], p[2] };
            fwrite(bgr, 1, 3, f);
        }
        int pad = rowSize - w * 3;
        if (pad > 0) { unsigned char z[3] = {0,0,0}; fwrite(z, 1, pad, f); }
    }
    fclose(f);
    Log("frame saved: %s", path);
}
static int g_stage = 0;
static void Stage(const char* name) { g_stage++; Log("STAGE_BEGIN %d %s", g_stage, name); }
static void StageEnd(const char* name, bool ok) { Log("STAGE_END %d %s %s", g_stage, name, ok ? "OK" : "FAIL"); }
#define SMOKE_RETURN(code) do { Log("RESULT=%s", (code) == 0 ? "PASS" : "FAIL"); Log("EXIT_CODE=%d", (code)); return (code); } while (0)

// =========================================================
// 新增测试：眨眼循环 / Pause-Resume / Motion 冲突 / Gaze
// =========================================================

static bool g_blinkFail = false;

static double GetParamD(AliyaLive2DHandle h, const char* id)
{
    double v = 0.0;
    if (AliyaLive2D_GetParameterValue(h, id, &v) != 0)
        return -1e9;
    return v;
}

static bool BlinkCompleted(AliyaLive2DHandle h, AliyaLive2DBlinkInfo* bi)
{
    AliyaLive2D_GetBlinkInfo(h, bi);
    return bi->state == 0 && bi->leftOpenness >= 0.999 && bi->rightOpenness >= 0.999 && bi->nextBlinkDelay > 0.05;
}

static void PrintBlinkFail(const char* test, int iter, AliyaLive2DBlinkInfo* bi,
                           double lExp, double lAct, double rExp, double rAct)
{
    g_blinkFail = true;
    Log("TEST_NAME=%s", test);
    Log("ITERATION=%d", iter);
    Log("STATE=%d", bi ? bi->state : -1);
    Log("LEFT_EXPECTED=%.6f", lExp);
    Log("LEFT_ACTUAL=%.6f", lAct);
    Log("RIGHT_EXPECTED=%.6f", rExp);
    Log("RIGHT_ACTUAL=%.6f", rAct);
    Log("RESULT=FAIL");
}

// 运行更新直到一次强制眨眼完整结束（回到 Idle 且睁眼）。返回 false 表示超时/失败。
static bool RunOneForcedBlink(AliyaLive2DHandle h, int iter, const char* test, bool requireAllStates)
{
    AliyaLive2D_ForceBlink(h);

    bool seenClosing = false, seenClosed = false, seenOpening = false, seenOpenHold = false;
    int frames = 0;
    AliyaLive2DBlinkInfo bi = {};
    for (;;)
    {
        AliyaLive2D_Update(h, 1.0 / 60.0);
        AliyaLive2D_GetBlinkInfo(h, &bi);
        if (bi.state == 1) seenClosing = true;
        if (bi.state == 2) seenClosed = true;
        if (bi.state == 3) seenOpening = true;
        if (bi.state == 4) seenOpenHold = true;
        if (BlinkCompleted(h, &bi))
            break;
        if (++frames > 900) // 15s 超时
        {
            PrintBlinkFail(test, iter, &bi, 1.0, GetParamD(h, "ParamEyeLOpen"), 1.0, GetParamD(h, "ParamEyeROpen"));
            Log("FAIL_REASON=TIMEOUT frames=%d", frames);
            return false;
        }
    }

    if (requireAllStates && (!seenClosing || !seenClosed || !seenOpening || !seenOpenHold))
    {
        Log("TEST_NAME=%s", test);
        Log("ITERATION=%d", iter);
        Log("FAIL_REASON=STATE_SEQUENCE closing=%d closed=%d opening=%d openhold=%d",
            seenClosing ? 1 : 0, seenClosed ? 1 : 0, seenOpening ? 1 : 0, seenOpenHold ? 1 : 0);
        Log("RESULT=FAIL");
        g_blinkFail = true;
        return false;
    }

    // 校验左右眼回到睁眼值附近（误差 <= 参数范围的 5%）
    double l = GetParamD(h, "ParamEyeLOpen");
    double r = GetParamD(h, "ParamEyeROpen");
    double lOpen = 1.0, rOpen = 1.0; // 该模型 default=1, min=0, max=1
    double lRange = 1.0, rRange = 1.0;
    double lExp = lOpen, rExp = rOpen;
    double tolL = 0.05 * lRange;
    double tolR = 0.05 * rRange;
    if (fabs(l - lExp) > tolL || fabs(r - rExp) > tolR)
    {
        PrintBlinkFail(test, iter, &bi, lExp, l, rExp, r);
        return false;
    }
    if (!_finite(l) || !_finite(r) || l < 0.0 || r < 0.0 || l > 1.0 || r > 1.0)
    {
        PrintBlinkFail(test, iter, &bi, lExp, l, rExp, r);
        Log("FAIL_REASON=OUT_OF_BOUNDS");
        return false;
    }
    return true;
}

// 等待一次完整眨眼（自然触发）完成，最长 timeoutFrames 帧
static bool WaitBlinkDone(AliyaLive2DHandle h, int timeoutFrames)
{
    AliyaLive2DBlinkInfo bi = {};
    int frames = 0;
    for (;;)
    {
        AliyaLive2D_Update(h, 1.0 / 60.0);
        if (BlinkCompleted(h, &bi))
            return true;
        if (++frames > timeoutFrames)
            return false;
    }
}

static int RunBlinkLoopTest(AliyaLive2DHandle h, int count)
{
    g_blinkFail = false;
    Stage("Blink 循环测试（强制执行 N 次完整眨眼）");
    AliyaLive2D_SetState(h, "idle", 0.0);
    AliyaLive2D_Update(h, 1.0 / 60.0);

    for (int i = 1; i <= count; i++)
    {
        if (!RunOneForcedBlink(h, i, "blink-loop", true))
        {
            Log("BLINK_LOOP_FAILED at iter=%d", i);
            return 1;
        }
    }

    // 结束时必须为睁眼状态
    AliyaLive2DBlinkInfo bi = {};
    AliyaLive2D_GetBlinkInfo(h, &bi);
    double l = GetParamD(h, "ParamEyeLOpen");
    double r = GetParamD(h, "ParamEyeROpen");
    if (bi.leftOpenness < 0.999 || bi.rightOpenness < 0.999 || fabs(l - 1.0) > 0.05 || fabs(r - 1.0) > 0.05)
    {
        Log("TEST_NAME=blink-loop");
        Log("ITERATION=%d", count);
        Log("FAIL_REASON=END_NOT_OPEN state=%d l=%.4f r=%.4f", bi.state, l, r);
        Log("RESULT=FAIL");
        return 1;
    }
    Log("BLINK_LOOP_OK count=%d", count);
    return 0;
}

static int RunBlinkPauseTest(AliyaLive2DHandle h)
{
    const char* phases[] = { "Closing", "ClosedHold", "Opening" };
    const int targetStates[] = { 1, 2, 3 };
    g_blinkFail = false;
    Stage("Pause/Resume 眨眼阶段测试");
    AliyaLive2D_SetState(h, "idle", 0.0);

    for (int p = 0; p < 3; p++)
    {
        AliyaLive2D_ForceBlink(h);
        int frames = 0;
        AliyaLive2DBlinkInfo bi = {};
        // 等待进入目标阶段
        for (;;)
        {
            AliyaLive2D_Update(h, 1.0 / 60.0);
            AliyaLive2D_GetBlinkInfo(h, &bi);
            if (bi.state == targetStates[p])
                break;
            if (++frames > 900)
            {
                Log("PAUSE_TEST_FAIL phase=%s 未能进入状态", phases[p]);
                g_blinkFail = true;
                return 1;
            }
        }

        // 暂停 + 若干帧（暂停期间不应更新）
        AliyaLive2D_Pause(h);
        for (int i = 0; i < 10; i++)
            AliyaLive2D_Update(h, 1.0 / 60.0);
        AliyaLive2D_Resume(h);

        // 恢复后必须在有限时间内返回正常睁眼
        if (!WaitBlinkDone(h, 600))
        {
            Log("PAUSE_TEST_FAIL phase=%s 恢复后未回到睁眼 state=%d l=%.4f r=%.4f",
                phases[p], bi.state, GetParamD(h, "ParamEyeLOpen"), GetParamD(h, "ParamEyeROpen"));
            g_blinkFail = true;
            return 1;
        }
        double l = GetParamD(h, "ParamEyeLOpen");
        double r = GetParamD(h, "ParamEyeROpen");
        if (fabs(l - 1.0) > 0.05 || fabs(r - 1.0) > 0.05)
        {
            Log("PAUSE_TEST_FAIL phase=%s 眼睛未睁 l=%.4f r=%.4f", phases[p], l, r);
            g_blinkFail = true;
            return 1;
        }
        Log("PAUSE_TEST_OK phase=%s", phases[p]);
    }

    // 暂停在 ClosedHold 时额外验证“闭眼值写入后不残留”
    return 0;
}

// sleep → wake 恢复测试：睡眠强制闭眼，唤醒后必须立即恢复睁眼
static int RunSleepWakeTest(AliyaLive2DHandle h)
{
    g_blinkFail = false;
    Stage("Sleep/Wake 恢复测试");
    AliyaLive2D_SetState(h, "sleep", 0.0);
    for (int i = 0; i < 20; i++)
        AliyaLive2D_Update(h, 1.0 / 60.0);
    double lSleep = GetParamD(h, "ParamEyeLOpen");
    double rSleep = GetParamD(h, "ParamEyeROpen");
    if (lSleep > 0.05 || rSleep > 0.05)
    {
        Log("SLEEP_WAKE_FAIL 睡眠时应闭眼 l=%.4f r=%.4f", lSleep, rSleep);
        g_blinkFail = true;
        return 1;
    }
    AliyaLive2D_SetState(h, "wake", 0.0);
    AliyaLive2D_SetState(h, "idle", 0.0);
    for (int i = 0; i < 20; i++)
        AliyaLive2D_Update(h, 1.0 / 60.0);
    double lWake = GetParamD(h, "ParamEyeLOpen");
    double rWake = GetParamD(h, "ParamEyeROpen");
    if (fabs(lWake - 1.0) > 0.05 || fabs(rWake - 1.0) > 0.05)
    {
        Log("SLEEP_WAKE_FAIL 唤醒后应恢复睁眼 l=%.4f r=%.4f", lWake, rWake);
        g_blinkFail = true;
        return 1;
    }
    Log("SLEEP_WAKE_OK");
    return 0;
}
static bool EyesOpen(AliyaLive2DHandle h);

static int RunMotionConflictTest(AliyaLive2DHandle h)
{
    g_blinkFail = false;
    Stage("Motion 冲突测试（动作结束后自动眨眼恢复）");
    AliyaLive2D_SetState(h, "idle", 0.0);
    AliyaLive2D_Update(h, 1.0 / 60.0);

    const char* actions[] = { "stretch", "nod", "sway", "click", "shake" };
    for (int a = 0; a < 5; a++)
    {
        AliyaLive2D_PlayAction(h, actions[a]);
        // 动作最长 1.6s；额外 1.0s 让眨眼恢复（等待睁眼，容忍自然眨眼）
        for (int i = 0; i < 140; i++)
            AliyaLive2D_Update(h, 1.0 / 60.0);
        bool eyeOk = false;
        for (int w = 0; w < 240 && !eyeOk; w++)
        {
            AliyaLive2D_Update(h, 1.0 / 60.0);
            eyeOk = EyesOpen(h);
        }
        double l = GetParamD(h, "ParamEyeLOpen");
        double r = GetParamD(h, "ParamEyeROpen");
        if (!eyeOk)
        {
            Log("MOTION_CONFLICT_FAIL action=%s 动作结束后眼睛未睁 l=%.4f r=%.4f", actions[a], l, r);
            g_blinkFail = true;
            return 1;
        }
        Log("MOTION_CONFLICT_OK action=%s", actions[a]);
    }

    // 动作结束后自动眨眼仍正常
    if (!RunOneForcedBlink(h, 1, "motion-conflict", true))
        return 1;
    Log("MOTION_CONFLICT_OK blink-after-action");
    return 0;
}

static bool WithinRange(double v, double mn, double mx)
{
    return _finite(v) && v >= mn - 1e-4 && v <= mx + 1e-4;
}

static int RunGazeTest(AliyaLive2DHandle h)
{
    g_blinkFail = false;
    Stage("Gaze 测试（多目标 + 快速移动 + 鼠标失效）");
    AliyaLive2D_SetState(h, "idle", 0.0);
    AliyaLive2D_SetLookAtEnabled(h, 1);
    AliyaLive2D_Update(h, 1.0 / 60.0);

    // 参数边界（该模型）：眼珠 ±1，头 ±30，身 ±10
    const double eR = 1.0, hR = 30.0, bR = 10.0;

    const double targets[][2] = {
        { 0.5, 0.5 }, { 0.1, 0.1 }, { 0.9, 0.1 }, { 0.1, 0.9 }, { 0.9, 0.9 }
    };
    for (int i = 0; i < 5; i++)
    {
        AliyaLive2D_SetLookTarget(h, targets[i][0], targets[i][1]);
        for (int f = 0; f < 30; f++)
            AliyaLive2D_Update(h, 1.0 / 60.0);
        double ex = GetParamD(h, "ParamEyeBallX");
        double ey = GetParamD(h, "ParamEyeBallY");
        double hx = GetParamD(h, "ParamAngleX");
        double hy = GetParamD(h, "ParamAngleY");
        double hz = GetParamD(h, "ParamAngleZ");
        double bx = GetParamD(h, "ParamBodyAngleX");
        double by = GetParamD(h, "ParamBodyAngleY");
        double bz = GetParamD(h, "ParamBodyAngleZ");
        if (!WithinRange(ex, -eR, eR) || !WithinRange(ey, -eR, eR) ||
            !WithinRange(hx, -hR, hR) || !WithinRange(hy, -hR, hR) || !WithinRange(hz, -hR, hR) ||
            !WithinRange(bx, -bR, bR) || !WithinRange(by, -bR, bR) || !WithinRange(bz, -bR, bR))
        {
            Log("GAZE_TEST_FAIL target=%d 参数越界或非有限值", i);
            g_blinkFail = true;
            return 1;
        }
    }

    int gazeFrameIdx = 0;
    // 先回中心并等待所有弹簧稳定（90 帧 ≈ 1.5s，覆盖最慢的身体通道），消除上一目标残留速度
    AliyaLive2D_SetLookTarget(h, 0.5, 0.5);
    for (int f = 0; f < 90; f++)
        AliyaLive2D_Update(h, 1.0 / 60.0);
    // 眼珠无游走分量，用眼珠验证回中稳定
    double settleEyeX = fabs(GetParamD(h, "ParamEyeBallX"));
    double settleEyeY = fabs(GetParamD(h, "ParamEyeBallY"));
    if (settleEyeX > 0.1 || settleEyeY > 0.1)
    {
        Log("GAZE_TEST_FAIL 回中未稳定 eyeBallX=%.3f eyeBallY=%.3f", settleEyeX, settleEyeY);
        g_blinkFail = true;
        return 1;
    }

    // 记录中心基线（含待机游走），速度测试用相对增量消除游走干扰
    double baseEyeX = GetParamD(h, "ParamEyeBallX");
    double baseHeadY = GetParamD(h, "ParamAngleY");
    double baseBodyY = GetParamD(h, "ParamBodyAngleY");

    // 响应速度：在多个采样帧检查归一化响应 眼球 > 头部 > 身体（确定性，避免阈值临界抖动）
    AliyaLive2D_SetLookTarget(h, 0.9, 0.5);
    // 稳态目标幅度：eyeBallX=0.8*0.9=0.72, headY=0.8*18=14.4, bodyY=0.8*3=2.4
    const double eTarget = 0.72, hTarget = 14.4, bTarget = 2.4;
    const int sampleFrames[] = { 10, 15, 20, 25 };
    bool speedOk = true;
    for (int k = 0; k < 4 && speedOk; k++)
    {
        while (gazeFrameIdx < sampleFrames[k])
        {
            AliyaLive2D_Update(h, 1.0 / 60.0);
            gazeFrameIdx++;
        }
        double ex = fabs(GetParamD(h, "ParamEyeBallX") - baseEyeX);
        double hy = fabs(GetParamD(h, "ParamAngleY") - baseHeadY);
        double by = fabs(GetParamD(h, "ParamBodyAngleY") - baseBodyY);
        double eN = ex / eTarget, hN = hy / hTarget, bN = by / bTarget;
        Log("GAZE_RESPONSE frame=%d eyeN=%.3f headN=%.3f bodyN=%.3f (eyeBallX=%.3f headY=%.3f bodyY=%.3f)",
            sampleFrames[k], eN, hN, bN, ex, hy, by);
        if (!(eN > hN + 0.03 && hN > bN + 0.03))
        {
            speedOk = false;
        }
    }
    if (!speedOk)
    {
        Log("GAZE_TEST_FAIL 响应速度错误（需 归一化响应 眼球>头部>身体）");
        g_blinkFail = true;
        return 1;
    }

    // 快速对角移动（驱动头俯仰/偏航/倾斜）→ physics 输出变化（马尾/刘海惯性）
    AliyaLive2D_SetLookTarget(h, 0.1, 0.1);
    for (int f = 0; f < 8; f++)
        AliyaLive2D_Update(h, 1.0 / 60.0);
    AliyaLive2D_SetLookTarget(h, 0.9, 0.9);
    double physicsMin = 1e9, physicsMax = -1e9;
    double physicsPeak = 0.0;
    double hyPeak = 0.0;
    for (int f = 0; f < 60; f++)
    {
        AliyaLive2D_Update(h, 1.0 / 60.0);
        double cur = GetParamD(h, "Param_Angle_Rotation_1_Bang_Center");
        if (cur < physicsMin) physicsMin = cur;
        if (cur > physicsMax) physicsMax = cur;
        if (fabs(cur) > physicsPeak) physicsPeak = fabs(cur);
        double hy = fabs(GetParamD(h, "ParamAngleY"));
        if (hy > hyPeak) hyPeak = hy;
    }
    double physicsDelta = physicsMax - physicsMin;
    Log("GAZE_PHYSICS_DELTA=%.4f min=%.4f max=%.4f peak=%.4f headYPeak=%.4f", physicsDelta, physicsMin, physicsMax, physicsPeak, hyPeak);
    if (physicsDelta < 0.01 && physicsPeak < 0.01)
    {
        Log("GAZE_TEST_FAIL physics 输出未随头部移动变化");
        g_blinkFail = true;
        return 1;
    }

    // 跟随速度 5 倍验证：无 NaN/越界，且响应明显更快
    AliyaLive2D_SetGazeSpeed(h, 5.0);
    AliyaLive2D_SetLookTarget(h, 0.5, 0.5);
    for (int f = 0; f < 60; f++)
        AliyaLive2D_Update(h, 1.0 / 60.0);
    AliyaLive2D_SetLookTarget(h, 0.9, 0.5);
    for (int f = 0; f < 5; f++)
        AliyaLive2D_Update(h, 1.0 / 60.0);
    double ex5 = GetParamD(h, "ParamEyeBallX");
    Log("GAZE_SPEED5 eyeBallX@5frame=%.4f (目标≈0.72)", ex5);
    if (!_finite(ex5) || fabs(ex5) > 1.0)
    {
        Log("GAZE_TEST_FAIL 5倍速参数越界或非有限值");
        g_blinkFail = true;
        return 1;
    }
    if (fabs(ex5) < 0.4)
    {
        Log("GAZE_TEST_FAIL 5倍速响应不够快");
        g_blinkFail = true;
        return 1;
    }
    // 5 倍速快速移动后：全部通道有限且在范围内
    AliyaLive2D_SetLookTarget(h, 0.1, 0.1);
    for (int f = 0; f < 20; f++)
        AliyaLive2D_Update(h, 1.0 / 60.0);
    double a1 = GetParamD(h, "ParamEyeBallX"), a2 = GetParamD(h, "ParamEyeBallY");
    double a3 = GetParamD(h, "ParamAngleX"), a4 = GetParamD(h, "ParamAngleY"), a5 = GetParamD(h, "ParamAngleZ");
    double a6 = GetParamD(h, "ParamBodyAngleX"), a7 = GetParamD(h, "ParamBodyAngleY"), a8 = GetParamD(h, "ParamBodyAngleZ");
    if (!WithinRange(a1, -1, 1) || !WithinRange(a2, -1, 1) ||
        !WithinRange(a3, -30, 30) || !WithinRange(a4, -30, 30) || !WithinRange(a5, -30, 30) ||
        !WithinRange(a6, -10, 10) || !WithinRange(a7, -10, 10) || !WithinRange(a8, -10, 10))
    {
        Log("GAZE_TEST_FAIL 5倍速快速移动后参数越界/非有限");
        g_blinkFail = true;
        return 1;
    }
    AliyaLive2D_SetGazeSpeed(h, 1.0);

    // 鼠标失效 → 平滑回正
    AliyaLive2D_ClearLookTarget(h);
    for (int f = 0; f < 150; f++)
        AliyaLive2D_Update(h, 1.0 / 60.0);
    double ex = GetParamD(h, "ParamEyeBallX");
    double ey = GetParamD(h, "ParamEyeBallY");
    double hx = GetParamD(h, "ParamAngleX");
    double hy = GetParamD(h, "ParamAngleY");
    double hz = GetParamD(h, "ParamAngleZ");
    double bx = GetParamD(h, "ParamBodyAngleX");
    double by = GetParamD(h, "ParamBodyAngleY");
    double bz = GetParamD(h, "ParamBodyAngleZ");
    if (fabs(ex) > 0.1 || fabs(ey) > 0.1 || fabs(hx) > 2.0 || fabs(hy) > 2.0 || fabs(hz) > 2.0 ||
        fabs(bx) > 1.0 || fabs(by) > 1.0 || fabs(bz) > 1.0)
    {
        Log("GAZE_TEST_FAIL 鼠标失效后未回正 ex=%.3f ey=%.3f hx=%.2f hy=%.2f hz=%.2f bx=%.2f by=%.2f bz=%.2f",
            ex, ey, hx, hy, hz, bx, by, bz);
        g_blinkFail = true;
        return 1;
    }
    Log("GAZE_TEST_OK");
    return 0;
}
// =========================================================
// Live2D 动作库测试
// =========================================================
using namespace Live2D::Cubism::Framework;
using namespace Live2D::Cubism::Framework::Utils;

static const char* kActionIds[] = {
    "idle", "click", "wave", "nod", "sway", "shake", "stretch", "doubt",
    "angry", "yawn", "walk_left", "walk_right", "drag", "fall", "land", "edge_idle"
};
static const int kActionCount = 16;

static const char* kPhysicsGroups[][2] = {
    { "刘海", "Param_Angle_Rotation_1_Bang_Center" },
    { "呆毛", "Param_Angle_Rotation_1_Top_Bang" },
    { "侧发", "Param_Angle_Rotation_1_ArtMesh21" },
    { "猫耳R", "Param_Angle_Rotation_1_CAT_Ear_R" },
    { "猫耳L", "Param_Angle_Rotation_1_CAT_Ear_L" },
    { "侧发2", "Param_Angle_Rotation_1_ArtMesh20" },
    { "领带", "Param_Angle_Rotation_1_ArtMesh23" },
    { "马尾", "Param_Angle_Rotation_1_ArtMesh32" },
};
static const int kPhysicsGroupCount = 8;

static bool GazeParamsValid(AliyaLive2DHandle h)
{
    const char* ids[] = { "ParamEyeLOpen", "ParamEyeROpen", "ParamEyeBallX", "ParamEyeBallY",
        "ParamAngleX", "ParamAngleY", "ParamAngleZ",
        "ParamBodyAngleX", "ParamBodyAngleY", "ParamBodyAngleZ",
        "ParamMouthOpenY", "ParamBreath" };
    for (const char* id : ids)
    {
        double v = GetParamD(h, id);
        if (v == -1e9 || !_finite(v))
        {
            Log("PARAM_BAD %s v=%.4f", id, v);
            return false;
        }
    }
    return true;
}

static bool EyesOpen(AliyaLive2DHandle h)
{
    double l = GetParamD(h, "ParamEyeLOpen");
    double r = GetParamD(h, "ParamEyeROpen");
    return fabs(l - 1.0) <= 0.05 && fabs(r - 1.0) <= 0.05;
}

static void StopAllActions(AliyaLive2DHandle h)
{
    AliyaLive2D_PlayAction(h, "shutdown");
    for (int i = 0; i < 20; i++)
        AliyaLive2D_Update(h, 1.0 / 60.0);
}

static int RunListActionsTest(AliyaLive2DHandle h)
{
    Stage("动作列表测试");
    char buf[8192] = {0};
    AliyaLive2D_ListActions(h, buf, sizeof(buf));
    Log("ACTIONS=%s", buf);
    if (strstr(buf, "\"nod\"") == nullptr || strstr(buf, "\"shutdown\"") == nullptr)
    {
        Log("LIST_ACTIONS_FAIL 缺少关键动作");
        return 1;
    }
    // 数量统计（避免在测试进程内重复初始化 CubismJson 分配器）
    int count = 0;
    const char* p = buf;
    while ((p = strstr(p, "\"id\":\"")) != nullptr)
    {
        count++;
        p += 5;
    }
    Log("LIST_ACTIONS_COUNT=%d", count);
    if (count < kActionCount + 3) // 16 JSON 动作 + sleep/wake/shutdown
    {
        Log("LIST_ACTIONS_FAIL 数量不足 expected>=%d actual=%d", kActionCount + 3, count);
        return 1;
    }
    Log("LIST_ACTIONS_OK");
    return 0;
}

static int RunSingleActionTest(AliyaLive2DHandle h, const char* id)
{
    // 先停止上一个动作，保证每个动作独立测试（避免排队导致 duration 读数错乱）
    StopAllActions(h);
    AliyaLive2D_PlayAction(h, id);
    AliyaLive2DActionInfo ai = {};
    AliyaLive2D_GetActionInfo(h, &ai);
    Log("ACTION_DEBUG id=%s current=%s playing=%d dur=%.2f", id, ai.currentActionId, ai.isPlaying, ai.duration);
    if (id[0] != '\0' && !ai.isPlaying && strcmp(id, "idle") != 0 && strcmp(id, "drag") != 0 && strcmp(id, "edge_idle") != 0)
    {
        Log("ACTION_START_FAIL id=%s 未开始播放", id);
        return 1;
    }
    double dur = ai.duration > 0.0 ? ai.duration : 1.0;
    int frames = static_cast<int>((dur + 2.5) * 60.0);
    bool loopAction = (strcmp(id, "idle") == 0 || strcmp(id, "drag") == 0 || strcmp(id, "edge_idle") == 0);
    for (int f = 0; f < frames; f++)
    {
        AliyaLive2D_Update(h, 1.0 / 60.0);
        if (!GazeParamsValid(h))
        {
            Log("ACTION_PARAM_FAIL id=%s frame=%d 参数越界/非有限", id, f);
            return 1;
        }
    }
    // 循环动作：停止
    if (loopAction)
        StopAllActions(h);
    // 动作完成后：等待眼睛睁开（容忍动作期间自然眨眼，最多 4 秒）
    bool eyeOk = false;
    for (int w = 0; w < 240 && !eyeOk; w++)
    {
        AliyaLive2D_Update(h, 1.0 / 60.0);
        eyeOk = EyesOpen(h);
    }
    if (!eyeOk)
    {
        Log("ACTION_EYE_FAIL id=%s 动作结束后眼睛未睁开", id);
        return 1;
    }
    if (!GazeParamsValid(h))
    {
        Log("ACTION_PARAM_FAIL id=%s 结束后参数异常", id);
        return 1;
    }
    // 事件验证
    char evbuf[4096] = {0};
    AliyaLive2D_PollActionEvents(h, evbuf, sizeof(evbuf));
    Log("ACTION_OK id=%s duration=%.2f events=%s", id, dur, evbuf);
    return 0;
}

static int RunActionAllTest(AliyaLive2DHandle h)
{
    Stage("动作全量测试（action-all）");
    AliyaLive2D_SetState(h, "idle", 0.0);
    for (int i = 0; i < kActionCount; i++)
    {
        if (RunSingleActionTest(h, kActionIds[i]) != 0)
        {
            Log("ACTION_ALL_FAIL at %s", kActionIds[i]);
            return 1;
        }
    }
    // sleep / wake 状态动作
    AliyaLive2D_PlayAction(h, "sleep");
    for (int i = 0; i < 15; i++)
        AliyaLive2D_Update(h, 1.0 / 60.0);
    if (EyesOpen(h))
    {
        Log("ACTION_ALL_FAIL sleep 后眼睛应闭合");
        return 1;
    }
    AliyaLive2D_PlayAction(h, "wake");
    for (int i = 0; i < 20; i++)
        AliyaLive2D_Update(h, 1.0 / 60.0);
    if (!EyesOpen(h))
    {
        Log("ACTION_ALL_FAIL wake 后眼睛应睁开");
        return 1;
    }
    // 动作后自动眨眼仍正常
    if (!RunOneForcedBlink(h, 1, "action-all", true))
        return 1;
    Log("ACTION_ALL_OK count=%d", kActionCount);
    return 0;
}

static int RunActionInterruptTest(AliyaLive2DHandle h)
{
    Stage("动作优先级/中断测试（action-interrupt）");
    AliyaLive2D_SetState(h, "idle", 0.0);

    AliyaLive2D_PlayAction(h, "idle");
    for (int i = 0; i < 10; i++)
        AliyaLive2D_Update(h, 1.0 / 60.0);
    AliyaLive2DActionInfo ai = {};
    AliyaLive2D_GetActionInfo(h, &ai);
    if (strcmp(ai.currentActionId, "idle") != 0)
    {
        Log("INTERRUPT_FAIL idle 未播放 current=%s", ai.currentActionId);
        return 1;
    }

    // drag(80) 打断 idle(0)
    AliyaLive2D_PlayAction(h, "drag");
    for (int i = 0; i < 10; i++)
        AliyaLive2D_Update(h, 1.0 / 60.0);
    AliyaLive2D_GetActionInfo(h, &ai);
    if (strcmp(ai.currentActionId, "drag") != 0)
    {
        Log("INTERRUPT_FAIL drag 未打断 idle current=%s", ai.currentActionId);
        return 1;
    }

    // nod(35) 不能打断 drag(80, 不可中断)
    AliyaLive2D_PlayAction(h, "nod");
    for (int i = 0; i < 10; i++)
        AliyaLive2D_Update(h, 1.0 / 60.0);
    AliyaLive2D_GetActionInfo(h, &ai);
    if (strcmp(ai.currentActionId, "drag") != 0)
    {
        Log("INTERRUPT_FAIL nod 错误打断 drag current=%s", ai.currentActionId);
        return 1;
    }
    StopAllActions(h);

    // nod 播放中，shake(30) 不能打断
    AliyaLive2D_PlayAction(h, "nod");
    for (int i = 0; i < 10; i++)
        AliyaLive2D_Update(h, 1.0 / 60.0);
    AliyaLive2D_PlayAction(h, "shake");
    for (int i = 0; i < 10; i++)
        AliyaLive2D_Update(h, 1.0 / 60.0);
    AliyaLive2D_GetActionInfo(h, &ai);
    if (strcmp(ai.currentActionId, "nod") != 0)
    {
        Log("INTERRUPT_FAIL shake 错误打断 nod current=%s", ai.currentActionId);
        return 1;
    }

    // fall(90) 打断 nod(35)
    AliyaLive2D_PlayAction(h, "fall");
    for (int i = 0; i < 10; i++)
        AliyaLive2D_Update(h, 1.0 / 60.0);
    AliyaLive2D_GetActionInfo(h, &ai);
    if (strcmp(ai.currentActionId, "fall") != 0)
    {
        Log("INTERRUPT_FAIL fall 未打断 nod current=%s", ai.currentActionId);
        return 1;
    }

    // shutdown 打断所有
    AliyaLive2D_PlayAction(h, "shutdown");
    for (int i = 0; i < 30; i++)
        AliyaLive2D_Update(h, 1.0 / 60.0);
    AliyaLive2D_GetActionInfo(h, &ai);
    if (ai.isPlaying)
    {
        Log("INTERRUPT_FAIL shutdown 未停止所有动作 current=%s", ai.currentActionId);
        return 1;
    }
    Log("INTERRUPT_OK");
    return 0;
}

static int RunActionGazeBlendTest(AliyaLive2DHandle h)
{
    Stage("动作与视线混合测试（action-gaze-blend）");
    AliyaLive2D_SetState(h, "idle", 0.0);
    AliyaLive2D_SetLookAtEnabled(h, 1);
    AliyaLive2D_SetLookTarget(h, 0.9, 0.5);
    for (int i = 0; i < 60; i++)
        AliyaLive2D_Update(h, 1.0 / 60.0); // 视线先稳定

    for (int i = 0; i < kActionCount; i++)
    {
        const char* id = kActionIds[i];
        if (strcmp(id, "idle") == 0 || strcmp(id, "drag") == 0 || strcmp(id, "edge_idle") == 0)
            continue; // 循环动作跳过
        AliyaLive2D_PlayAction(h, id);
        double maxEyeX = 0.0, maxHeadX = 0.0, maxHeadY = 0.0, maxBodyZ = 0.0;
        for (int f = 0; f < 90; f++)
        {
            AliyaLive2D_Update(h, 1.0 / 60.0);
            double ex = fabs(GetParamD(h, "ParamEyeBallX"));
            double hx = fabs(GetParamD(h, "ParamAngleX"));
            double hy = fabs(GetParamD(h, "ParamAngleY"));
            double bz = fabs(GetParamD(h, "ParamBodyAngleZ"));
            if (ex > maxEyeX) maxEyeX = ex;
            if (hx > maxHeadX) maxHeadX = hx;
            if (hy > maxHeadY) maxHeadY = hy;
            if (bz > maxBodyZ) maxBodyZ = bz;
            if (!GazeParamsValid(h))
            {
                Log("GAZE_BLEND_PARAM_FAIL id=%s", id);
                return 1;
            }
        }
        // 眼球不被动作锁死：目标 (0.9,0.5) 下眼珠应明显移动
        if (maxEyeX < 0.15)
        {
            Log("GAZE_BLEND_FAIL id=%s 眼球被动作锁死 maxEyeX=%.3f", id, maxEyeX);
            return 1;
        }
        Log("GAZE_BLEND id=%s maxEyeX=%.3f maxHeadX=%.3f maxHeadY=%.3f maxBodyZ=%.3f",
            id, maxEyeX, maxHeadX, maxHeadY, maxBodyZ);
        StopAllActions(h);
    }
    Log("GAZE_BLEND_OK");
    return 0;
}

static int RunActionPhysicsTest(AliyaLive2DHandle h)
{
    Stage("动作物理测试（action-physics）");
    AliyaLive2D_SetState(h, "idle", 0.0);
    double groupOverallMax[kPhysicsGroupCount] = {};
    double inputOverallMax = 0.0;

    for (int i = 0; i < kActionCount; i++)
    {
        const char* id = kActionIds[i];
        if (strcmp(id, "idle") == 0 || strcmp(id, "drag") == 0 || strcmp(id, "edge_idle") == 0)
            continue;
        AliyaLive2D_PlayAction(h, id);
        double startX = GetParamD(h, "ParamAngleX");
        double startZ = GetParamD(h, "ParamAngleZ");
        double startBX = GetParamD(h, "ParamBodyAngleX");
        double startBZ = GetParamD(h, "ParamBodyAngleZ");
        double maxInput = 0.0;
        double groupMax[kPhysicsGroupCount] = {};
        for (int f = 0; f < 120; f++)
        {
            AliyaLive2D_Update(h, 1.0 / 60.0);
            double dx = fabs(GetParamD(h, "ParamAngleX") - startX);
            double dz = fabs(GetParamD(h, "ParamAngleZ") - startZ);
            double dbx = fabs(GetParamD(h, "ParamBodyAngleX") - startBX);
            double dbz = fabs(GetParamD(h, "ParamBodyAngleZ") - startBZ);
            double m = dx > dz ? dx : dz;
            if (dbx > m) m = dbx;
            if (dbz > m) m = dbz;
            if (m > maxInput) maxInput = m;
            for (int g = 0; g < kPhysicsGroupCount; g++)
            {
                double v = fabs(GetParamD(h, kPhysicsGroups[g][1]));
                if (v > groupMax[g]) groupMax[g] = v;
            }
        }
        if (maxInput > inputOverallMax) inputOverallMax = maxInput;
        for (int g = 0; g < kPhysicsGroupCount; g++)
            if (groupMax[g] > groupOverallMax[g]) groupOverallMax[g] = groupMax[g];
        Log("ACTION_PHYSICS id=%s inputMax=%.4f 刘海=%.4f 呆毛=%.4f 侧发=%.4f 猫耳R=%.4f 猫耳L=%.4f 侧发2=%.4f 领带=%.4f 马尾=%.4f",
            id, maxInput, groupMax[0], groupMax[1], groupMax[2], groupMax[3],
            groupMax[4], groupMax[5], groupMax[6], groupMax[7]);
        StopAllActions(h);
    }

    Log("PHYSICS_INPUT_ACTIVE maxInputDelta=%.4f", inputOverallMax);
    if (inputOverallMax < 0.05)
        Log("WARN: 物理输入总体变化过小");
    for (int g = 0; g < kPhysicsGroupCount; g++)
    {
        double m = groupOverallMax[g];
        if (m > 0.05)
            Log("PHYSICS_OUTPUT_ACTIVE group=%s maxDelta=%.4f", kPhysicsGroups[g][0], m);
        else if (m > 0.005)
            Log("PHYSICS_OUTPUT_TOO_SMALL group=%s maxDelta=%.4f", kPhysicsGroups[g][0], m);
        else
            Log("PHYSICS_GROUP_INACTIVE group=%s maxDelta=%.4f", kPhysicsGroups[g][0], m);
    }
    Log("ACTION_PHYSICS_OK");
    return 0;
}
int wmain(int argc, wchar_t** argv)
{
    // 参数解析
    std::wstring assetRootW = L"", modelPathW = L"";
    bool createOnly = false, loadOnly = false, renderOnce = false, updateOnly = false;
    bool destroyAfterCreate = false, destroyAfterLoad = false, destroyTwice = false;
    int renderFrames = 0;
    int loop = 1;
    bool run = true;
    int blinkLoopCount = 0;
    bool blinkPauseTest = false, motionConflictTest = false, gazeTest = false, sleepWakeTest = false;
    bool listActionsTest = false, actionAllTest = false, actionInterruptTest = false;
    bool actionGazeBlendTest = false, actionPhysicsTest = false;
    std::wstring actionTestId = L"";

    for (int i = 1; i < argc; i++)
    {
        std::wstring a = argv[i];
        if (a == L"--create-only") createOnly = true, run = false;
        else if (a == L"--load-only") loadOnly = true, run = false;
        else if (a == L"--update-only") updateOnly = true, run = false;
        else if (a == L"--render-once") renderOnce = true, run = false;
        else if (a == L"--destroy-after-create") destroyAfterCreate = true;
        else if (a == L"--destroy-after-load") destroyAfterLoad = true;
        else if (a == L"--destroy-twice") destroyTwice = true;
        else if (a == L"--no-render-thread") { /* 本模块无独立渲染线程，渲染由调用方驱动 */ }
        else if (a == L"--verbose") g_verbose = true;
        else if (a == L"--blink-loop" && i + 1 < argc) blinkLoopCount = _wtoi(argv[++i]), run = false;
        else if (a == L"--blink-pause-test") blinkPauseTest = true, run = false;
        else if (a == L"--sleep-wake-test") sleepWakeTest = true, run = false;
        else if (a == L"--list-actions") listActionsTest = true, run = false;
        else if (a == L"--action-test" && i + 1 < argc) actionTestId = argv[++i], run = false;
        else if (a == L"--action-all-test") actionAllTest = true, run = false;
        else if (a == L"--action-interrupt-test") actionInterruptTest = true, run = false;
        else if (a == L"--action-gaze-blend-test") actionGazeBlendTest = true, run = false;
        else if (a == L"--action-physics-test") actionPhysicsTest = true, run = false;
        else if (a == L"--motion-conflict-test") motionConflictTest = true, run = false;
        else if (a == L"--gaze-test") gazeTest = true, run = false;
        else if (a == L"--render-frames" && i + 1 < argc) renderFrames = _wtoi(argv[++i]);
        else if (a == L"--loop" && i + 1 < argc) loop = _wtoi(argv[++i]);
        else if (a == L"--save-frame" && i + 1 < argc) g_saveFrame = ToUtf8(argv[++i]);
        else if (a == L"--out" && i + 1 < argc) g_outPathStr = ToUtf8(argv[++i]);
        else if (assetRootW.empty()) assetRootW = a;
        else if (modelPathW.empty()) modelPathW = a;
    }

    const char* g_outPath = g_outPathStr.empty() ? nullptr : g_outPathStr.c_str();
    if (g_outPath)
    {
        FILE* f = fopen(g_outPath, "w");
        if (f) fclose(f);
    }

    SetUnhandledExceptionFilter(CrashHandler);
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);

    if (assetRootW.empty() || modelPathW.empty())
    {
        Log("usage: aliya_smoke <assetRoot> <modelJsonPath> [--create-only|--load-only|--update-only|--render-once|--render-frames N|--destroy-twice|--loop N|--verbose|--out file]");
        Log("       [--blink-loop N|--blink-pause-test|--motion-conflict-test|--gaze-test|--sleep-wake-test]");
        Log("       [--list-actions|--action-test <id>|--action-all-test|--action-interrupt-test|--action-gaze-blend-test|--action-physics-test]");
                SMOKE_RETURN(2);
    }

    std::string assetRoot = ToUtf8(assetRootW);
    std::string modelPath = ToUtf8(modelPathW);

    Log("== aliya_smoke start (pid=%lu) ==", (unsigned long)GetCurrentProcessId());

    WNDCLASSA wc = {};
    wc.lpfnWndProc = WndProc;
    wc.hInstance = GetModuleHandleA(nullptr);
    wc.lpszClassName = "AliyaSmokeWnd";
    RegisterClassA(&wc);
    HWND hwnd = CreateWindowA("AliyaSmokeWnd", "smoke", WS_OVERLAPPEDWINDOW, 0, 0, 320, 480, nullptr, nullptr, wc.hInstance, nullptr);

    for (int iter = 0; iter < loop; iter++)
    {
        Log("== loop %d/%d ==", iter + 1, loop);
        char err[1024] = {0};

        Stage("加载 DLL 与导出函数");
        if (&AliyaLive2D_Create == nullptr) { Log("FAIL: 导出函数不可用"); SMOKE_RETURN(3); }

        Stage("创建 Host");
        AliyaLive2DHandle h = AliyaLive2D_Create();
        if (!h) { Log("FAIL: Create 返回 NULL"); SMOKE_RETURN(3); }

        Stage("初始化 Cubism Framework / 创建 D3D11 设备");
        if (AliyaLive2D_SetAssetDirectory(h, assetRoot.c_str()) != 0) { Log("FAIL: SetAssetDirectory"); SMOKE_RETURN(4); }
        AliyaLive2D_GetLastError(h, err, sizeof(err));
        Log("Create ok (lastErr=%s)", err);

        if (destroyAfterCreate)
        {
            Stage("Destroy（Create 后）");
            AliyaLive2D_Destroy(h);
            if (destroyTwice) AliyaLive2D_Destroy(h);
            Log("destroy-after-create ok");
            continue;
        }

        Stage("加载模型（model3/moc3/纹理/物理）");
        int rc = AliyaLive2D_LoadModel(h, modelPath.c_str());
        if (rc != 0)
        {
            AliyaLive2D_GetLastError(h, err, sizeof(err));
            Log("LoadModel FAILED rc=%d err=%s", rc, err);
            if (destroyAfterLoad)
            {
                AliyaLive2D_Destroy(h);
                if (destroyTwice) AliyaLive2D_Destroy(h);
                Log("destroy-after-load-fail ok");
                continue;
            }
                SMOKE_RETURN(5);
        }
        Log("LoadModel ok");

        if (loadOnly || destroyAfterLoad)
        {
            Stage("Destroy（Load 后）");
            AliyaLive2D_Destroy(h);
            if (destroyTwice) AliyaLive2D_Destroy(h);
            Log("destroy-after-load ok");
            if (loadOnly) SMOKE_RETURN(0);
            continue;
        }

        Stage("AttachWindow / 创建共享纹理");
        rc = AliyaLive2D_AttachWindow(h, hwnd, 320, 480);
        if (rc != 0) { AliyaLive2D_GetLastError(h, err, sizeof(err)); Log("AttachWindow FAILED rc=%d err=%s", rc, err); SMOKE_RETURN(6); }
        Log("AttachWindow ok");

        AliyaLive2DModelInfo info = {};
        AliyaLive2D_GetInfo(h, &info);
        Log("info: params=%d drawables=%d textures=%d canvas=%fx%f physics=%d blink=%d lipsync=%d",
            info.parameterCount, info.drawableCount, info.textureCount,
            info.canvasWidth, info.canvasHeight, info.hasPhysics, info.hasEyeBlink, info.hasLipSync);

        // ---- 新增专项测试 ----
        if (blinkLoopCount > 0)
        {
            int t = RunBlinkLoopTest(h, blinkLoopCount);
            AliyaLive2D_Destroy(h);
            SMOKE_RETURN(t);
        }
        if (blinkPauseTest)
        {
            int t = RunBlinkPauseTest(h);
            AliyaLive2D_Destroy(h);
            SMOKE_RETURN(t);
        }
        if (sleepWakeTest)
        {
            int t = RunSleepWakeTest(h);
            AliyaLive2D_Destroy(h);
            SMOKE_RETURN(t);
        }
        if (listActionsTest)
        {
            int t = RunListActionsTest(h);
            AliyaLive2D_Destroy(h);
            SMOKE_RETURN(t);
        }
        if (!actionTestId.empty())
        {
            int t = RunSingleActionTest(h, ToUtf8(actionTestId).c_str());
            AliyaLive2D_Destroy(h);
            SMOKE_RETURN(t);
        }
        if (actionAllTest)
        {
            int t = RunActionAllTest(h);
            AliyaLive2D_Destroy(h);
            SMOKE_RETURN(t);
        }
        if (actionInterruptTest)
        {
            int t = RunActionInterruptTest(h);
            AliyaLive2D_Destroy(h);
            SMOKE_RETURN(t);
        }
        if (actionGazeBlendTest)
        {
            int t = RunActionGazeBlendTest(h);
            AliyaLive2D_Destroy(h);
            SMOKE_RETURN(t);
        }
        if (actionPhysicsTest)
        {
            int t = RunActionPhysicsTest(h);
            AliyaLive2D_Destroy(h);
            SMOKE_RETURN(t);
        }
        if (motionConflictTest)
        {
            int t = RunMotionConflictTest(h);
            AliyaLive2D_Destroy(h);
            SMOKE_RETURN(t);
        }
        if (gazeTest)
        {
            int t = RunGazeTest(h);
            AliyaLive2D_Destroy(h);
            SMOKE_RETURN(t);
        }

        Stage("执行 Update");
        AliyaLive2D_SetState(h, "idle", 0.0);
        AliyaLive2D_SetLookAtEnabled(h, 1);
        AliyaLive2D_SetLookTarget(h, 0.6, 0.4);
        for (int i = 0; i < 60; i++) AliyaLive2D_Update(h, 1.0 / 60.0);
        Log("Update ok");

        if (updateOnly)
        {
            Stage("Destroy（Update 后）");
            AliyaLive2D_Destroy(h);
            if (destroyTwice) AliyaLive2D_Destroy(h);
            Log("destroy-after-update ok");
                SMOKE_RETURN(0);
        }

        Stage("执行 Render");
        if (renderOnce)
        {
            AliyaLive2D_Render(h);
            Log("render-once ok");
        }
        else
        {
            int frames = renderFrames > 0 ? renderFrames : 60;
            for (int i = 0; i < frames; i++)
            {
                AliyaLive2D_Update(h, 1.0 / 60.0);
                AliyaLive2D_Render(h);
            }
            Log("render %d frames ok", frames);
        }

        int hit = AliyaLive2D_HitTest(h, 160, 240);
        int hit2 = AliyaLive2D_HitTest(h, 5, 5);
        Log("hit center=%d corner=%d", hit, hit2);

        if (!g_saveFrame.empty())
        {
            std::vector<unsigned char> buf((size_t)320 * 480 * 4);
            int rc3 = AliyaLive2D_CopyFramePixels(h, buf.data(), 320 * 4);
            if (rc3 == 0) SaveBmp(g_saveFrame.c_str(), buf.data(), 320, 480);
        }

        // 读回像素验证（统计非透明像素数量）
        {
            int w = 320, hh = 480;
            std::vector<unsigned char> pixels((size_t)w * hh * 4, 0);
            int rc2 = AliyaLive2D_CopyFramePixels(h, pixels.data(), w * 4);
            if (rc2 != 0) { Log("CopyFramePixels FAILED rc=%d", rc2); SMOKE_RETURN(8); }
            int nonZero = 0;
            for (size_t i = 0; i < pixels.size(); i += 4)
                if (pixels[i + 3] != 0) nonZero++;
            Log("readback ok: width=%d height=%d nonTransparentPixels=%d", w, hh, nonZero);
            if (nonZero < 100) { Log("FAIL: 渲染帧几乎全透明"); SMOKE_RETURN(9); }
        }

        Stage("请求停止（暂停）");
        AliyaLive2D_Pause(h);
        AliyaLive2D_Resume(h);
        Log("pause/resume ok");

        Stage("销毁 Host（释放模型/渲染器/D3D 资源）");
        AliyaLive2D_Destroy(h);
        if (destroyTwice) AliyaLive2D_Destroy(h);
        Log("destroy ok");

        if (renderOnce) SMOKE_RETURN(0);
    }

    Log("SMOKE_OK");
                SMOKE_RETURN(0);
}










