# Aliya Voice ID Creator

用于创建硅基流动自定义音色的独立工具。

## 功能

- 上传参考音频到硅基流动 SiliconFlow API
- 生成自定义音色 Voice ID
- 复制 Voice ID 到剪贴板

## 使用说明

1. 输入硅基流动 API Key
2. 输入音色名称（默认 aliya）
3. 输入参考音频对应的文本
4. 选择参考音频文件（支持 WAV、MP3、M4A）
5. 点击 "生成 Voice ID"
6. 复制生成的 Voice ID

## 参考音频要求

- 8～10秒左右的清晰语音
- 单人说话
- 无背景音乐
- 无明显环境噪声
- 无明显混响
- 不使用唱歌、尖叫或耳语录音
- 音频时长不得超过30秒

## 音色名称规则

- 只允许英文字母、数字、下划线和短横线
- 长度 1-32 字符
- 默认值：aliya

## 构建

```bash
dotnet restore
dotnet build -c Release
```

## 发布

```bash
dotnet publish -c Release -r win-x64 --self-contained false
```

发布输出目录：`publish\AliyaVoiceIdCreator\`

## 在 Aliya Pet 中使用

1. 复制生成的 Voice ID（格式：`speech:aliya:xxx:xxx`）
2. 在 Aliya Pet TTS 配置中填写：

```json
{
  "provider": "SiliconFlow",
  "apiBaseUrl": "https://api.siliconflow.cn/v1",
  "model": "IndexTeam/IndexTTS-2",
  "voiceId": "speech:aliya:xxx:xxx"
}
```

3. TTS 请求使用：

```json
{
  "model": "IndexTeam/IndexTTS-2",
  "input": "需要朗读的台词",
  "voice": "speech:aliya:xxx:xxx",
  "response_format": "wav",
  "sample_rate": 24000
}
```

## 注意事项

- API Key 仅保存在内存中，程序关闭后不会保存
- 生成 Voice ID 时使用的模型必须与后续 TTS 合成使用的模型一致
- 不要删除 `speech:` 前缀