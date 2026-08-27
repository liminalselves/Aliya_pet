#pragma once

#include <string>
#include <mutex>
#include <cstdarg>

namespace aliya {

// 简化版原生日志：写入 Logs/live2d-native.log（相对当前工作目录或资源根目录）。
class NativeLog {
public:
    static NativeLog& Instance();

    void SetBaseDirectory(const std::string& utf8Base);

    // 打开日志文件（追加模式）。UTF-8 内容。
    void Open();
    void Close();

    void Write(const char* level, const char* fmt, ...);
    void Error(const char* fmt, ...);
    void Warn(const char* fmt, ...);
    void Info(const char* fmt, ...);
    void Debug(const char* fmt, ...);

private:
    NativeLog() = default;
    std::mutex mutex_;
    std::string baseDir_;
    void* file_ = nullptr; // FILE*
};

} // namespace aliya
