// 待机动画 / 呼吸 / 物理 诊断测试
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include <cmath>
#include <algorithm>
#include <windows.h>

#include "../src/aliya_live2d.h"

static void Log(const char* fmt, ...)
{
    char buf[2048];
    va_list args;
    va_start(args, fmt);
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    printf("%s\n", buf);
    fflush(stdout);
}

static std::string g_assetDir;

static bool ReadParam(AliyaLive2DHandle h, const char* id, double& out)
{
    double v = 0;
    int rc = AliyaLive2D_GetParameterValue(h, id, &v);
    if (rc != 0) return false;
    out = v;
    return true;
}

// 创建 Host 并加载模型（隐藏窗口用于渲染器绑定，参数演算）
static AliyaLive2DHandle CreateHost(const std::string& assetDir)
{
    AliyaLive2DHandle h = AliyaLive2D_Create();
    if (!h) { Log("FAIL: Create returned null"); return nullptr; }

    std::string modelPath = assetDir + "/Aliya/seethrough_output_15_呼吸完成.model3.json";
    int rc = AliyaLive2D_SetAssetDirectory(h, assetDir.c_str());
    if (rc != 0) { Log("FAIL: SetAssetDirectory rc=%d", rc); AliyaLive2D_Destroy(h); return nullptr; }

    rc = AliyaLive2D_LoadModel(h, modelPath.c_str());
    if (rc != 0) { Log("FAIL: LoadModel rc=%d", rc); AliyaLive2D_Destroy(h); return nullptr; }

    // 创建隐藏窗口用于渲染器绑定
    WNDCLASSEXA wc = {};
    wc.cbSize = sizeof(wc);
    wc.style = CS_OWNDC;
    wc.lpfnWndProc = DefWindowProcA;
    wc.hInstance = GetModuleHandle(nullptr);
    wc.lpszClassName = "DiagTest";
    RegisterClassExA(&wc);
    HWND hwnd = CreateWindowExA(0, "DiagTest", "diag", WS_POPUP, 0, 0, 320, 480, nullptr, nullptr, wc.hInstance, nullptr);
    ShowWindow(hwnd, SW_HIDE);

    rc = AliyaLive2D_AttachWindow(h, hwnd, 320, 480);
    if (rc != 0)
    {
        char err[256] = {0};
        AliyaLive2D_GetLastError(h, err, sizeof(err));
        Log("FAIL: AttachWindow rc=%d err=%s", rc, err);
        DestroyWindow(hwnd);
        AliyaLive2D_Destroy(h);
        return nullptr;
    }

    // 启用视线 + 禁用鼠标目标（测试待机）
    AliyaLive2D_SetState(h, "idle", 0.0);
    AliyaLive2D_SetLookAtEnabled(h, 1);
    // 不设置 LookTarget，模拟鼠标离开

    return h;
}

// ===================== 待机动画测试 =====================
struct IdleTestResult {
    bool ok = true;
    int frames = 0;
    double breathMin = 999, breathMax = -999;
    double breathSum = 0;
    int breathSamples = 0;
    int breathCycles = 0;
    double breathPeriodSum = 0;
    double headXMin = 999, headXMax = -999;
    double headYMin = 999, headYMax = -999;
    double headZMin = 999, headZMax = -999;
    double bodyXMin = 999, bodyXMax = -999;
    double bodyYMin = 999, bodyYMax = -999;
    double bodyZMin = 999, bodyZMax = -999;
    int nanCount = 0;
    int oobCount = 0;
};

static int RunIdleTest(AliyaLive2DHandle h, int durationSec)
{
    Log("=== IDLE ANIMATION TEST (%ds) ===", durationSec);
    IdleTestResult r;
    const double dt = 1.0 / 60.0;
    int totalFrames = durationSec * 60;

    double prevBreath = 0;
    bool prevBreathValid = false;
    double lastCycleTime = 0;
    double testTime = 0;

    for (int i = 0; i < totalFrames; i++)
    {
        testTime += dt;
        int rc = AliyaLive2D_Update(h, dt);
        if (rc != 0) { Log("FAIL: Update rc=%d at frame %d", rc, i); return 1; }

        double breath = 0, hx = 0, hy = 0, hz = 0, bx = 0, by = 0, bz = 0;
        bool gotBreath = ReadParam(h, "ParamBreath", breath);
        ReadParam(h, "ParamAngleX", hx);
        ReadParam(h, "ParamAngleY", hy);
        ReadParam(h, "ParamAngleZ", hz);
        ReadParam(h, "ParamBodyAngleX", bx);
        ReadParam(h, "ParamBodyAngleY", by);
        ReadParam(h, "ParamBodyAngleZ", bz);

        double vals[] = { breath, hx, hy, hz, bx, by, bz };
        for (int j = 0; j < 7; j++)
        {
            if (!std::isfinite(vals[j])) { r.nanCount++; Log("FAIL: NaN at frame %d idx %d", i, j); }
        }

        if (gotBreath && (breath < -0.001 || breath > 1.001)) { r.oobCount++; }
        if (hx < -30.001 || hx > 30.001) { r.oobCount++; }
        if (bx < -10.001 || bx > 10.001) { r.oobCount++; }

        if (gotBreath)
        {
            r.breathMin = std::min(r.breathMin, breath);
            r.breathMax = std::max(r.breathMax, breath);
            r.breathSum += breath;
            r.breathSamples++;
            if (prevBreathValid)
            {
                double mid = 0.5;
                if (prevBreath < mid && breath >= mid)
                {
                    if (lastCycleTime > 0)
                    {
                        r.breathPeriodSum += (testTime - lastCycleTime);
                        r.breathCycles++;
                    }
                    lastCycleTime = testTime;
                }
            }
            prevBreath = breath;
            prevBreathValid = true;
        }

        r.headXMin = std::min(r.headXMin, hx);
        r.headXMax = std::max(r.headXMax, hx);
        r.headYMin = std::min(r.headYMin, hy);
        r.headYMax = std::max(r.headYMax, hy);
        r.headZMin = std::min(r.headZMin, hz);
        r.headZMax = std::max(r.headZMax, hz);
        r.bodyXMin = std::min(r.bodyXMin, bx);
        r.bodyXMax = std::max(r.bodyXMax, bx);
        r.bodyYMin = std::min(r.bodyYMin, by);
        r.bodyYMax = std::max(r.bodyYMax, by);
        r.bodyZMin = std::min(r.bodyZMin, bz);
        r.bodyZMax = std::max(r.bodyZMax, bz);

        r.frames++;
    }

    double avgPeriod = r.breathCycles > 0 ? r.breathPeriodSum / r.breathCycles : 0;
    double avgBreath = r.breathSamples > 0 ? r.breathSum / r.breathSamples : 0;

    Log("--- IDLE RESULT ---");
    Log("Frames: %d", r.frames);
    Log("NaN count: %d %s", r.nanCount, r.nanCount == 0 ? "[PASS]" : "[FAIL]");
    Log("Out-of-bounds: %d %s", r.oobCount, r.oobCount == 0 ? "[PASS]" : "[FAIL]");
    Log("Breath range: %.4f ~ %.4f (avg %.4f) %s", r.breathMin, r.breathMax, avgBreath,
        (r.breathMax - r.breathMin) > 0.1 ? "[PASS]" : "[FAIL: range too small]");
    Log("Breath cycles: %d (avg period %.2fs) %s", r.breathCycles, avgPeriod,
        r.breathCycles >= 3 ? "[PASS]" : "[FAIL: too few]");
    Log("Head X delta: %.3f", r.headXMax - r.headXMin);
    Log("Head Y delta: %.3f", r.headYMax - r.headYMin);
    Log("Head Z delta: %.3f", r.headZMax - r.headZMin);
    Log("Body X delta: %.3f", r.bodyXMax - r.bodyXMin);
    Log("Body Y delta: %.3f", r.bodyYMax - r.bodyYMin);
    Log("Body Z delta: %.3f", r.bodyZMax - r.bodyZMin);

    bool headMoves = (r.headXMax - r.headXMin) > 0.3 || (r.headYMax - r.headYMin) > 0.2 || (r.headZMax - r.headZMin) > 0.1;
    bool bodyMoves = (r.bodyXMax - r.bodyXMin) > 0.1 || (r.bodyYMax - r.bodyYMin) > 0.05 || (r.bodyZMax - r.bodyZMin) > 0.05;
    Log("Head moves: %s %s", headMoves ? "YES" : "NO", headMoves ? "[PASS]" : "[FAIL]");
    Log("Body moves: %s %s", bodyMoves ? "YES" : "NO", bodyMoves ? "[PASS]" : "[FAIL]");

    if (r.nanCount > 0 || r.oobCount > 0) return 1;
    if ((r.breathMax - r.breathMin) < 0.05) { Log("BREATH_PARAMETER_WEAK_OR_BINDING_WEAK"); return 1; }
    if (r.breathCycles < 2) { Log("BREATH_NOT_CYCLING"); return 1; }
    if (!headMoves) { Log("HEAD_IDLE_NOT_DETECTED"); return 1; }
    if (!bodyMoves) { Log("BODY_IDLE_NOT_DETECTED"); return 1; }

    Log("IDLE_TEST_PASS");
    return 0;
}

// ===================== 呼吸测试 =====================
static int RunBreathTest(AliyaLive2DHandle h, int minCycles)
{
    Log("=== BREATH TEST (min %d cycles) ===", minCycles);
    const double dt = 1.0 / 60.0;
    int maxFrames = minCycles * 7 * 60;

    double globalMin = 999, globalMax = -999;
    double prevBreath = 0;
    bool prevValid = false;
    double lastPeakTime = 0;
    int peakCount = 0;
    double periodSum = 0;
    bool reachedInhale = false, reachedExhale = false;

    for (int i = 0; i < maxFrames; i++)
    {
        AliyaLive2D_Update(h, dt);
        double breath = 0;
        if (!ReadParam(h, "ParamBreath", breath)) continue;

        if (breath < globalMin) globalMin = breath;
        if (breath > globalMax) globalMax = breath;
        if (breath > 0.7) reachedInhale = true;
        if (breath < 0.3) reachedExhale = true;

        if (prevValid && prevBreath > 0.5)
        {
            // 检测上升沿过中点
            static double prevPrev = 0;
            static bool ppValid = false;
            if (ppValid && prevBreath > prevPrev && breath < prevBreath && prevBreath > 0.55)
            {
                if (lastPeakTime > 0)
                {
                    double period = (i * dt) - lastPeakTime;
                    if (period > 2.0 && period < 8.0) { periodSum += period; peakCount++; }
                }
                lastPeakTime = i * dt;
            }
            prevPrev = prevBreath;
            ppValid = true;
        }

        prevBreath = breath;
        prevValid = true;

        if (peakCount >= minCycles) break;
    }

    double avgPeriod = peakCount > 0 ? periodSum / peakCount : 0;

    Log("--- BREATH RESULT ---");
    Log("Cycles: %d %s", peakCount, peakCount >= minCycles ? "[PASS]" : "[FAIL]");
    Log("Avg period: %.2fs (target 3.8-5.5) %s", avgPeriod,
        (avgPeriod > 3.5 && avgPeriod < 6.0) ? "[PASS]" : "[FAIL]");
    Log("Value range: %.4f ~ %.4f", globalMin, globalMax);
    Log("Inhale reached: %s", reachedInhale ? "YES" : "NO");
    Log("Exhale reached: %s", reachedExhale ? "YES" : "NO");

    if (peakCount < minCycles) { Log("BREATH_TEST_FAIL: too few cycles"); return 1; }
    if (avgPeriod < 3.5 || avgPeriod > 6.0) { Log("BREATH_TEST_FAIL: period out of range"); return 1; }
    if ((globalMax - globalMin) < 0.1) { Log("BREATH_PARAMETER_ACTIVE_MODEL_BINDING_WEAK"); return 1; }
    Log("BREATH_TEST_PASS");
    return 0;
}

// ===================== 物理待机测试 =====================
static int RunPhysicsTest(AliyaLive2DHandle h, int durationSec)
{
    Log("=== IDLE PHYSICS TEST (%ds) ===", durationSec);
    const double dt = 1.0 / 60.0;
    int totalFrames = durationSec * 60;

    struct GroupDef { const char* param; const char* label; };
    GroupDef groups[] = {
        { "Param_Angle_Rotation_3_Bang_Center", "刘海" },
        { "Param_Angle_Rotation_9_Top_Bang",    "呆毛" },
        { "Param_Angle_Rotation_4_ArtMesh21",    "侧发" },
        { "Param_Angle_Rotation_2_CAT_Ear_R",    "右猫耳" },
        { "Param_Angle_Rotation_2_CAT_Ear_L",    "左猫耳" },
        { "Param_Angle_Rotation_3_ArtMesh20",    "侧发2" },
        { "Param_Angle_Rotation_5_ArtMesh23",    "领带" },
        { "Param_Angle_Rotation_15_ArtMesh32",   "马尾" },
    };
    const int nGroups = sizeof(groups) / sizeof(groups[0]);
    double maxVal[8] = {-999,-999,-999,-999,-999,-999,-999,-999};
    double minVal[8] = {999,999,999,999,999,999,999,999};
    double maxDelta[8] = {0,0,0,0,0,0,0,0};
    double avgDelta[8] = {0,0,0,0,0,0,0,0};
    int samples[8] = {0,0,0,0,0,0,0,0};
    double prevVal[8] = {0,0,0,0,0,0,0,0};
    bool prevValid[8] = {false,false,false,false,false,false,false,false};

    for (int i = 0; i < totalFrames; i++)
    {
        AliyaLive2D_Update(h, dt);
        for (int g = 0; g < nGroups; g++)
        {
            double v = 0;
            if (!ReadParam(h, groups[g].param, v)) continue;
            if (v > maxVal[g]) maxVal[g] = v;
            if (v < minVal[g]) minVal[g] = v;
            samples[g]++;
            if (prevValid[g])
            {
                double d = std::abs(v - prevVal[g]);
                if (d > maxDelta[g]) maxDelta[g] = d;
                avgDelta[g] += d;
            }
            prevVal[g] = v;
            prevValid[g] = true;
        }
    }

    Log("--- PHYSICS RESULT ---");
    int passCount = 0;
    for (int g = 0; g < nGroups; g++)
    {
        const char* classification = "INACTIVE";
        if (samples[g] == 0) classification = "PARAM_NOT_FOUND";
        else if (maxVal[g] - minVal[g] < 0.001) classification = "INACTIVE";
        else if (maxDelta[g] > 0.05) classification = "ACTIVE_VISIBLE_RANGE";
        else classification = "ACTIVE_TOO_SMALL";
        if (strcmp(classification, "ACTIVE_VISIBLE_RANGE") == 0 || strcmp(classification, "ACTIVE_TOO_SMALL") == 0) passCount++;

        Log("%-12s min=%.4f max=%.4f maxDelta=%.5f avgDelta=%.5f -> %s",
            groups[g].label, minVal[g], maxVal[g], maxDelta[g], samples[g] > 0 ? avgDelta[g] / samples[g] : 0, classification);
    }

    Log("Active groups: %d/%d", passCount, nGroups);
    if (passCount < 3) { Log("PHYSICS_TEST_FAIL: too few active groups"); return 1; }
    Log("PHYSICS_TEST_PASS");
    return 0;
}

// ===================== main =====================
int main(int argc, char** argv)
{
    bool idleTest = false, breathTest = false, physicsTest = false;
    int durationSec = 60;
    int minCycles = 15;
    std::string assetDir = "flutter/assets/live2d"; // 默认项目根下的 Flutter assets；也可通过命令行参数传入模型资源目录

    for (int i = 1; i < argc; i++)
    {
        if (strcmp(argv[i], "--idle-test") == 0) idleTest = true;
        else if (strcmp(argv[i], "--breath-test") == 0) breathTest = true;
        else if (strcmp(argv[i], "--physics-test") == 0) physicsTest = true;
        else if (strcmp(argv[i], "--duration") == 0 && i + 1 < argc) durationSec = atoi(argv[++i]);
        else if (strcmp(argv[i], "--min-cycles") == 0 && i + 1 < argc) minCycles = atoi(argv[++i]);
        else if (argv[i][0] != '-') assetDir = argv[i];
    }

    if (!idleTest && !breathTest && !physicsTest) { idleTest = true; breathTest = true; physicsTest = true; }

    Log("Asset dir: %s", assetDir.c_str());
    AliyaLive2DHandle h = CreateHost(assetDir);
    if (!h) return 1;

    int rc = 0;
    if (idleTest) rc |= RunIdleTest(h, durationSec);
    if (breathTest) rc |= RunBreathTest(h, minCycles);
    if (physicsTest) rc |= RunPhysicsTest(h, durationSec);

    AliyaLive2D_Destroy(h);

    Log("=== FINAL: %s ===", rc == 0 ? "ALL PASS" : "SOME FAILED");
    return rc;
}

