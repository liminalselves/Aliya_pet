using System.Net.Http.Headers;
using System.Text.Json;
using AliyaVoiceIdCreator.Models;

namespace AliyaVoiceIdCreator.Services
{
    public class SiliconFlowVoiceService
    {
        private static readonly HttpClient _httpClient = new()
        {
            Timeout = TimeSpan.FromSeconds(60)
        };

        private const string ApiBaseUrl = "https://api.siliconflow.cn/v1";
        private const string UploadEndpoint = "/uploads/audio/voice";
        private const string DefaultModel = "IndexTeam/IndexTTS-2";
        private static readonly HashSet<string> SupportedExtensions = new(StringComparer.OrdinalIgnoreCase)
        {
            ".wav", ".mp3", ".m4a"
        };
        private const long MaxFileSizeBytes = 50 * 1024 * 1024; // 50MB

        public async Task<VoiceUploadResult> CreateVoiceAsync(
            string apiKey,
            string audioFilePath,
            string customName,
            string text,
            CancellationToken cancellationToken = default)
        {
            // Validate inputs
            if (string.IsNullOrWhiteSpace(apiKey))
                throw new ArgumentException("API Key 不能为空", nameof(apiKey));
            if (string.IsNullOrWhiteSpace(audioFilePath))
                throw new ArgumentException("音频文件路径不能为空", nameof(audioFilePath));
            if (string.IsNullOrWhiteSpace(customName))
                throw new ArgumentException("音色名称不能为空", nameof(customName));
            if (string.IsNullOrWhiteSpace(text))
                throw new ArgumentException("参考音频文本不能为空", nameof(text));

            // Validate customName format
            if (!System.Text.RegularExpressions.Regex.IsMatch(customName, @"^[a-zA-Z0-9_-]{1,32}$"))
                throw new ArgumentException("音色名称格式不合法，只允许英文字母、数字、下划线和短横线，长度1-32", nameof(customName));

            // Validate file
            var fileInfo = new FileInfo(audioFilePath);
            if (!fileInfo.Exists)
                throw new FileNotFoundException("音频文件不存在", audioFilePath);
            if (fileInfo.Length == 0)
                throw new ArgumentException("音频文件为空", nameof(audioFilePath));
            if (fileInfo.Length > MaxFileSizeBytes)
                throw new ArgumentException($"音频文件过大，最大允许 {MaxFileSizeBytes / 1024 / 1024}MB", nameof(audioFilePath));
            if (!SupportedExtensions.Contains(fileInfo.Extension))
                throw new ArgumentException($"不支持的音频格式 {fileInfo.Extension}，支持: {string.Join(", ", SupportedExtensions)}", nameof(audioFilePath));

            // Build request
            using var form = new MultipartFormDataContent();
            
            // Add file
            var fileBytes = await File.ReadAllBytesAsync(audioFilePath, cancellationToken);
            var fileContent = new ByteArrayContent(fileBytes);
            fileContent.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
            form.Add(fileContent, "file", Path.GetFileName(audioFilePath));
            
            // Add other fields
            form.Add(new StringContent(DefaultModel), "model");
            form.Add(new StringContent(customName), "customName");
            form.Add(new StringContent(text), "text");

            // Build request message
            var request = new HttpRequestMessage(HttpMethod.Post, $"{ApiBaseUrl}{UploadEndpoint}")
            {
                Content = form
            };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);

            try
            {
                using var response = await _httpClient.SendAsync(request, cancellationToken);
                
                if (!response.IsSuccessStatusCode)
                {
                    var errorContent = await response.Content.ReadAsStringAsync(cancellationToken);
                    var traceId = response.Headers.Contains("x-siliconcloud-trace-id") 
                        ? string.Join(", ", response.Headers.GetValues("x-siliconcloud-trace-id"))
                        : "无";
                    
                    // Sanitize error message
                    var sanitizedError = SanitizeErrorMessage(errorContent);
                    throw new HttpRequestException(
                        $"API 请求失败: {response.StatusCode}\n" +
                        $"错误信息: {sanitizedError}\n" +
                        $"Trace ID: {traceId}");
                }

                var responseJson = await response.Content.ReadAsStringAsync(cancellationToken);
                var result = JsonSerializer.Deserialize<VoiceUploadResult>(responseJson, new JsonSerializerOptions
                {
                    PropertyNameCaseInsensitive = true
                });

                if (result?.Uri == null)
                    throw new InvalidOperationException("API 响应中未找到 uri 字段");

                return result;
            }
            catch (TaskCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw new OperationCanceledException("请求已取消", cancellationToken);
            }
            catch (TaskCanceledException)
            {
                throw new TimeoutException("请求超时（60秒）");
            }
        }

        private static string SanitizeErrorMessage(string error)
        {
            if (string.IsNullOrEmpty(error))
                return "未知错误";
            
            // Try to parse JSON error response
            try
            {
                using var doc = JsonDocument.Parse(error);
                var root = doc.RootElement;
                
                // SiliconFlow error format: { "code": "...", "message": "..." }
                if (root.TryGetProperty("message", out var messageProp))
                {
                    error = messageProp.GetString() ?? error;
                }
                else if (root.TryGetProperty("error", out var errorProp))
                {
                    error = errorProp.GetString() ?? error;
                }
            }
            catch
            {
                // Not JSON, use raw content
            }
            
            // Limit length
            if (error.Length > 500)
                error = error[..500] + "...";
            
            // Remove potential sensitive info
            error = System.Text.RegularExpressions.Regex.Replace(error, @"Bearer\s+\S+", "Bearer [REDACTED]");
            error = System.Text.RegularExpressions.Regex.Replace(error, @"api[_-]?key[=:]\s*\S+", "api_key=[REDACTED]", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            
            return error;
        }
    }
}