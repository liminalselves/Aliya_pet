// 诊断: 检查模型参数默认值
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include <windows.h>
#include "../src/aliya_live2d.h"

int main(int argc, char** argv)
{
    if (argc < 2) { printf("usage: diag_defaults <assetDir>\n"); return 1; }
    std::string assetDir = argv[1];
    std::string modelPath = assetDir + "/Aliya/seethrough_output_15_呼吸完成.model3.json";

    AliyaLive2DHandle h = AliyaLive2D_Create();
    if (!h) { printf("FAIL: Create\n"); return 1; }
    AliyaLive2D_SetAssetDirectory(h, assetDir.c_str());
    int rc = AliyaLive2D_LoadModel(h, modelPath.c_str());
    if (rc != 0) { printf("FAIL: LoadModel rc=%d\n", rc); AliyaLive2D_Destroy(h); return 1; }

    // 创建隐藏窗口
    WNDCLASSEXA wc = {};
    wc.cbSize = sizeof(wc);
    wc.style = CS_OWNDC;
    wc.lpfnWndProc = DefWindowProcA;
    wc.hInstance = GetModuleHandle(nullptr);
    wc.lpszClassName = "DiagWnd";
    RegisterClassExA(&wc);
    HWND hwnd = CreateWindowExA(0, "DiagWnd", "", WS_POPUP, 0, 0, 320, 480, nullptr, nullptr, wc.hInstance, nullptr);
    ShowWindow(hwnd, SW_HIDE);
    rc = AliyaLive2D_AttachWindow(h, hwnd, 320, 480);
    if (rc != 0) { printf("FAIL: AttachWindow rc=%d\n", rc); return 1; }

    AliyaLive2D_SetState(h, "idle", 0.0);
    AliyaLive2D_SetLookAtEnabled(h, 1);

    // 读取默认值
    double vals[8] = {};
    const char* ids[] = { "ParamAngleX", "ParamAngleY", "ParamAngleZ", "ParamBodyAngleX", "ParamBodyAngleY", "ParamBodyAngleZ", "ParamBreath", "ParamEyeLOpen" };
    printf("=== BEFORE UPDATE ===\n");
    for (int i = 0; i < 8; i++)
    {
        if (AliyaLive2D_GetParameterValue(h, ids[i], &vals[i]) == 0)
            printf("  %s = %.4f\n", ids[i], vals[i]);
        else
            printf("  %s = (not found)\n", ids[i]);
    }

    // 运行 30 帧
    for (int i = 0; i < 30; i++) AliyaLive2D_Update(h, 1.0 / 60.0);

    printf("=== AFTER 30 FRAMES ===\n");
    for (int i = 0; i < 8; i++)
    {
        if (AliyaLive2D_GetParameterValue(h, ids[i], &vals[i]) == 0)
            printf("  %s = %.4f\n", ids[i], vals[i]);
        else
            printf("  %s = (not found)\n", ids[i]);
    }

    // 运行 120 帧
    for (int i = 0; i < 90; i++) AliyaLive2D_Update(h, 1.0 / 60.0);

    printf("=== AFTER 120 FRAMES ===\n");
    for (int i = 0; i < 8; i++)
    {
        if (AliyaLive2D_GetParameterValue(h, ids[i], &vals[i]) == 0)
            printf("  %s = %.4f\n", ids[i], vals[i]);
        else
            printf("  %s = (not found)\n", ids[i]);
    }

    AliyaLive2D_Destroy(h);
    return 0;
}

