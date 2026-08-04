#include "native_log.hpp"

#include <cstdio>
#include <ctime>
#include <chrono>
#include <windows.h>

namespace aliya {

NativeLog& NativeLog::Instance()
{
    static NativeLog instance;
    return instance;
}

void NativeLog::SetBaseDirectory(const std::string& utf8Base)
{
    std::lock_guard<std::mutex> lock(mutex_);
    baseDir_ = utf8Base;
}

void NativeLog::Open()
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (file_)
        return;

    std::string dir = baseDir_;
    if (dir.empty())
        dir = ".";
    std::string logDir = dir + "\\Logs";
    CreateDirectoryA(logDir.c_str(), nullptr);

    std::string path = logDir + "\\live2d-native.log";
    FILE* f = nullptr;
    if (fopen_s(&f, path.c_str(), "ab") == 0)
        file_ = f;
}

void NativeLog::Close()
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (file_)
    {
        std::fclose(static_cast<FILE*>(file_));
        file_ = nullptr;
    }
}

void NativeLog::Write(const char* level, const char* fmt, ...)
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (!file_)
        return;

    auto now = std::chrono::system_clock::now();
    auto tt = std::chrono::system_clock::to_time_t(now);
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count() % 1000;
    struct tm tmv;
    localtime_s(&tmv, &tt);

    char timeBuf[64];
    std::snprintf(timeBuf, sizeof(timeBuf), "%04d-%02d-%02dT%02d:%02d:%02d.%03d",
        tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday,
        tmv.tm_hour, tmv.tm_min, tmv.tm_sec, static_cast<int>(ms));

    DWORD tid = GetCurrentThreadId();

    char msg[2048];
    va_list args;
    va_start(args, fmt);
    std::vsnprintf(msg, sizeof(msg), fmt, args);
    va_end(args);

    FILE* f = static_cast<FILE*>(file_);
    std::fprintf(f, "%s [%lu] [%s] %s\n", timeBuf, static_cast<unsigned long>(tid), level, msg);
    std::fflush(f);
}

void NativeLog::Error(const char* fmt, ...)
{
    char msg[2048];
    va_list args;
    va_start(args, fmt);
    std::vsnprintf(msg, sizeof(msg), fmt, args);
    va_end(args);
    Write("ERROR", "%s", msg);
}

void NativeLog::Warn(const char* fmt, ...)
{
    char msg[2048];
    va_list args;
    va_start(args, fmt);
    std::vsnprintf(msg, sizeof(msg), fmt, args);
    va_end(args);
    Write("WARN", "%s", msg);
}

void NativeLog::Info(const char* fmt, ...)
{
    char msg[2048];
    va_list args;
    va_start(args, fmt);
    std::vsnprintf(msg, sizeof(msg), fmt, args);
    va_end(args);
    Write("INFO", "%s", msg);
}

void NativeLog::Debug(const char* fmt, ...)
{
    char msg[2048];
    va_list args;
    va_start(args, fmt);
    std::vsnprintf(msg, sizeof(msg), fmt, args);
    va_end(args);
    Write("DEBUG", "%s", msg);
}

} // namespace aliya
