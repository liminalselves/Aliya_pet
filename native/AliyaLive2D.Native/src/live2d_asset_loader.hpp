#pragma once

#include <string>
#include <vector>

#include "CubismFramework.hpp"

namespace aliya {

// UTF-8 -> UTF-16（Windows）
std::wstring Utf8ToWide(const std::string& utf8);

// UTF-16 -> UTF-8
std::string WideToUtf8(const std::wstring& wide);

// 读取文件全部字节（支持中文路径）。返回 false 表示失败。
bool ReadFileToBytes(const std::string& utf8Path, std::vector<char>& out);

// Cubism Framework 的 LoadFileFunction（UTF-8 路径，支持相对资源根目录）。
unsigned char* CubismLoadFileFunction(const std::string filePath, Live2D::Cubism::Framework::csmSizeInt* outSize);

// Cubism Framework 的 ReleaseBytesFunction。
void CubismReleaseBytesFunction(unsigned char* byteData);

// 统一资源根目录（应用目录），用于解析相对路径。
void SetAssetRoot(const std::string& utf8Root);
const std::string& GetAssetRoot();

// 将可能相对的路径解析为绝对路径（UTF-8）。
std::string ResolvePath(const std::string& utf8Path);

} // namespace aliya

