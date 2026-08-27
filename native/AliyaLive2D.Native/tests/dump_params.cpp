// 参数表转储工具：读取 moc3，输出全部参数 ID / Min / Default / Max。
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include <windows.h>

#include "CubismFramework.hpp"
#include "Model/CubismMoc.hpp"
#include "Model/CubismModel.hpp"
#include "Type/csmString.hpp"

using namespace Live2D::Cubism::Framework;

static std::vector<char> ReadFile(const wchar_t* path)
{
    std::vector<char> bytes;
    FILE* f = _wfopen(path, L"rb");
    if (!f) return bytes;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    bytes.resize(n > 0 ? (size_t)n : 0);
    if (n > 0) fread(bytes.data(), 1, (size_t)n, f);
    fclose(f);
    return bytes;
}

class Alloc : public ICubismAllocator
{
public:
    void* Allocate(const csmSizeType size) override { return ::malloc(size); }
    void Deallocate(void* memory) override { ::free(memory); }
    void* AllocateAligned(const csmSizeType size, const csmUint32 alignment) override
    {
        const size_t align = (alignment == 0) ? 1 : static_cast<size_t>(alignment);
        const size_t offset = (align - 1) + sizeof(void*);
        void* p1 = ::malloc(size + offset);
        if (!p1) return nullptr;
        void** p2 = reinterpret_cast<void**>((reinterpret_cast<size_t>(p1) + offset) & ~(align - 1));
        p2[-1] = p1;
        return p2;
    }
    void DeallocateAligned(void* alignedMemory) override
    {
        if (!alignedMemory) return;
        void** p2 = reinterpret_cast<void**>(alignedMemory);
        ::free(p2[-1]);
    }
};

int wmain(int argc, wchar_t** argv)
{
    if (argc < 2)
    {
        printf("usage: dump_params <moc3 path>\n");
        return 2;
    }
    std::vector<char> bytes = ReadFile(argv[1]);
    if (bytes.empty() || bytes.size() < 8 || memcmp(bytes.data(), "MOC3", 4) != 0)
    {
        printf("无法读取 moc3: %ls\n", argv[1]);
        return 2;
    }

    Alloc alloc;
    CubismFramework::StartUp(&alloc);
    CubismFramework::Initialize();

    CubismMoc* moc = CubismMoc::Create(reinterpret_cast<const csmByte*>(bytes.data()), static_cast<csmSizeInt>(bytes.size()));
    if (!moc)
    {
        printf("CubismMoc::Create 失败\n");
        return 3;
    }
    CubismModel* model = moc->CreateModel();
    if (!model)
    {
        printf("CubismModel::Create 失败\n");
        return 3;
    }

    const int count = model->GetParameterCount();
    printf("PARAM_COUNT=%d\n", count);
    for (int i = 0; i < count; i++)
    {
        CubismIdHandle id = model->GetParameterId(static_cast<csmUint32>(i));
        const char* idStr = id ? id->GetString().GetRawString() : "(null)";
        float min = model->GetParameterMinimumValue(static_cast<csmUint32>(i));
        float def = model->GetParameterDefaultValue(static_cast<csmUint32>(i));
        float max = model->GetParameterMaximumValue(static_cast<csmUint32>(i));
        printf("%d\t%s\t%.6f\t%.6f\t%.6f\n", i, idStr, min, def, max);
    }


    CubismMoc::Delete(moc);
    CubismFramework::Dispose();
    CubismFramework::CleanUp();
    return 0;
}


