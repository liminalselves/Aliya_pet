#include "live2d_asset_loader.hpp"
#include "native_log.hpp"

#include <fstream>
#include <sstream>

#if defined(_WIN32)
#  include <windows.h>
#endif

namespace aliya {

static std::string g_assetRoot;

#if defined(_WIN32)
std::wstring Utf8ToWide(const std::string& utf8)
{
    if (utf8.empty())
        return std::wstring();
    int size = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), static_cast<int>(utf8.size()), nullptr, 0);
    if (size <= 0)
        return std::wstring();
    std::wstring result(size, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), static_cast<int>(utf8.size()), &result[0], size);
    return result;
}

std::string WideToUtf8(const std::wstring& wide)
{
    if (wide.empty())
        return std::string();
    int size = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), static_cast<int>(wide.size()), nullptr, 0, nullptr, nullptr);
    if (size <= 0)
        return std::string();
    std::string result(size, '\0');
    WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), static_cast<int>(wide.size()), &result[0], size, nullptr, nullptr);
    return result;
}

bool FileExists(const std::string& utf8Path)
{
    std::wstring wide = Utf8ToWide(utf8Path);
    DWORD attr = GetFileAttributesW(wide.c_str());
    return attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY);
}
#else
bool FileExists(const std::string& utf8Path)
{
    std::ifstream f(utf8Path, std::ios::binary);
    return f.is_open();
}
#endif

bool ReadFileToBytes(const std::string& utf8Path, std::vector<char>& out)
{
    out.clear();
#if defined(_WIN32)
    std::wstring wide = Utf8ToWide(utf8Path);
    HANDLE h = CreateFileW(wide.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE)
    {
        NativeLog::Instance().Error("ReadFileToBytes: 无法打开文件 %s (win32=%lu)", utf8Path.c_str(), static_cast<unsigned long>(GetLastError()));
        return false;
    }

    LARGE_INTEGER size;
    if (!GetFileSizeEx(h, &size) || size.QuadPart <= 0)
    {
        CloseHandle(h);
        NativeLog::Instance().Error("ReadFileToBytes: 文件为空或无法获取大小 %s", utf8Path.c_str());
        return false;
    }

    out.resize(static_cast<size_t>(size.QuadPart));
    DWORD read = 0;
    BOOL ok = ReadFile(h, out.data(), static_cast<DWORD>(out.size()), &read, nullptr);
    CloseHandle(h);
    if (!ok || read != out.size())
    {
        NativeLog::Instance().Error("ReadFileToBytes: 读取失败 %s (read=%lu)", utf8Path.c_str(), static_cast<unsigned long>(read));
        out.clear();
        return false;
    }
    return true;
#else
    // Android/Linux：文件系统原生 UTF-8，直接用 ifstream。
    std::ifstream f(utf8Path, std::ios::binary);
    if (!f.is_open())
    {
        NativeLog::Instance().Error("ReadFileToBytes: 无法打开文件 %s", utf8Path.c_str());
        return false;
    }
    f.seekg(0, std::ios::end);
    std::streamoff len = f.tellg();
    if (len <= 0)
    {
        NativeLog::Instance().Error("ReadFileToBytes: 文件为空或无法获取大小 %s", utf8Path.c_str());
        return false;
    }
    f.seekg(0, std::ios::beg);
    out.resize(static_cast<size_t>(len));
    f.read(out.data(), len);
    if (!f)
    {
        NativeLog::Instance().Error("ReadFileToBytes: 读取失败 %s", utf8Path.c_str());
        out.clear();
        return false;
    }
    return true;
#endif
}

unsigned char* CubismLoadFileFunction(const std::string filePath, Live2D::Cubism::Framework::csmSizeInt* outSize)
{
    // 候选位置：assetRoot 拼接 → 直接按进程工作目录解析（FrameworkShaders 等相对路径）。
    std::vector<std::string> candidates;
    const std::string resolved = ResolvePath(filePath);
    candidates.push_back(resolved);
    if (resolved != filePath)
        candidates.push_back(filePath);

    for (const auto& candidate : candidates)
    {
        if (!FileExists(candidate))
            continue;
        std::vector<char> bytes;
        if (!ReadFileToBytes(candidate, bytes))
            break;
        unsigned char* buffer = static_cast<unsigned char*>(::malloc(bytes.size() + 1));
        if (!buffer)
            break;
        memcpy(buffer, bytes.data(), bytes.size());
        buffer[bytes.size()] = '\0';
        if (outSize)
            *outSize = static_cast<int>(bytes.size());
        return buffer;
    }

    if (outSize)
        *outSize = 0;
    NativeLog::Instance().Error("CubismLoadFileFunction: 无法加载 %s（已尝试 %zu 个位置）", filePath.c_str(), candidates.size());
    return nullptr;
}

void CubismReleaseBytesFunction(unsigned char* byteData)
{
    ::free(byteData);
}

void SetAssetRoot(const std::string& utf8Root)
{
    g_assetRoot = utf8Root;
    NativeLog::Instance().SetBaseDirectory(utf8Root);
    NativeLog::Instance().Open();
}

const std::string& GetAssetRoot()
{
    return g_assetRoot;
}

std::string ResolvePath(const std::string& utf8Path)
{
    // 已是绝对路径（Windows 盘符或 UNC）则直接返回
    if (utf8Path.size() >= 2 && utf8Path[1] == ':')
        return utf8Path;
    if (utf8Path.size() >= 2 && utf8Path[0] == '\\' && utf8Path[1] == '\\')
        return utf8Path;

    if (g_assetRoot.empty())
        return utf8Path;

    // 合并根目录 + 相对路径（分隔符按平台：Windows 反斜杠 / 其他正斜杠）
    std::string root = g_assetRoot;
#if defined(_WIN32)
    if (!root.empty() && (root.back() == '\\' || root.back() == '/'))
        root.pop_back();
    std::string rel = utf8Path;
    for (auto& c : rel)
    {
        if (c == '/')
            c = '\\';
    }
    return root + "\\" + rel;
#else
    if (!root.empty() && (root.back() == '\\' || root.back() == '/'))
        root.pop_back();
    std::string rel = utf8Path;
    for (auto& c : rel)
    {
        if (c == '\\')
            c = '/';
    }
    return root + "/" + rel;
#endif
}

} // namespace aliya

