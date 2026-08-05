using System.Text.RegularExpressions;
using AliyaVoiceIdCreator.Services;

namespace AliyaVoiceIdCreator
{
    public partial class MainForm : Form
    {
        private readonly SiliconFlowVoiceService _voiceService = new();
        private CancellationTokenSource? _cancellationTokenSource;
        private bool _isApiKeyVisible = false;

        public MainForm()
        {
            InitializeComponent();
        }

        private void BtnToggleApiKey_Click(object sender, EventArgs e)
        {
            _isApiKeyVisible = !_isApiKeyVisible;
            txtApiKey.UseSystemPasswordChar = !_isApiKeyVisible;
            btnToggleApiKey.Text = _isApiKeyVisible ? "隐藏" : "显示";
        }

        private void BtnSelectAudio_Click(object sender, EventArgs e)
        {
            using var openFileDialog = new OpenFileDialog
            {
                Title = "选择参考音频文件",
                Filter = "音频文件|*.wav;*.mp3;*.m4a|所有文件|*.*",
                FilterIndex = 1,
                Multiselect = false
            };

            if (openFileDialog.ShowDialog() == DialogResult.OK)
            {
                var filePath = openFileDialog.FileName;
                var fileInfo = new FileInfo(filePath);
                
                // Basic validation
                if (!fileInfo.Exists)
                {
                    ShowError("文件不存在");
                    return;
                }
                if (fileInfo.Length == 0)
                {
                    ShowError("文件为空");
                    return;
                }
                if (fileInfo.Length > 50 * 1024 * 1024)
                {
                    ShowError("文件过大，最大50MB");
                    return;
                }

                txtAudioPath.Text = filePath;
                ShowAudioFileInfo(fileInfo);
                ClearError();
            }
        }

        private void ShowAudioFileInfo(FileInfo fileInfo)
        {
            var sizeInKb = fileInfo.Length / 1024.0;
            var sizeStr = sizeInKb < 1024 ? $"{sizeInKb:F1} KB" : $"{sizeInKb / 1024:F1} MB";
            lblStatus.Text = $"文件: {fileInfo.Name} | 格式: {fileInfo.Extension.ToUpper()} | 大小: {sizeStr}";
        }

        private async void BtnGenerate_Click(object sender, EventArgs e)
        {
            // Validate inputs
            if (string.IsNullOrWhiteSpace(txtApiKey.Text))
            {
                ShowError("请输入 API Key");
                return;
            }
            if (string.IsNullOrWhiteSpace(txtCustomName.Text))
            {
                ShowError("请输入音色名称");
                return;
            }
            if (!Regex.IsMatch(txtCustomName.Text.Trim(), @"^[a-zA-Z0-9_-]{1,32}$"))
            {
                ShowError("音色名称格式不合法，只允许英文字母、数字、下划线和短横线，长度1-32");
                return;
            }
            if (string.IsNullOrWhiteSpace(txtReferenceText.Text))
            {
                ShowError("请输入参考音频文本");
                return;
            }
            if (string.IsNullOrWhiteSpace(txtAudioPath.Text))
            {
                ShowError("请选择参考音频文件");
                return;
            }

            // Disable UI
            SetUIBusy(true);
            ClearError();
            txtVoiceId.Clear();

            try
            {
                _cancellationTokenSource = new CancellationTokenSource();
                var result = await _voiceService.CreateVoiceAsync(
                    txtApiKey.Text.Trim(),
                    txtAudioPath.Text,
                    txtCustomName.Text.Trim(),
                    txtReferenceText.Text.Trim(),
                    _cancellationTokenSource.Token);

                txtVoiceId.Text = result.Uri;
                lblStatus.Text = "生成成功";
            }
            catch (OperationCanceledException)
            {
                ShowError("请求已取消");
                lblStatus.Text = "已取消";
            }
            catch (TimeoutException)
            {
                ShowError("请求超时（60秒）");
                lblStatus.Text = "超时";
            }
            catch (Exception ex)
            {
                ShowError(ex.Message);
                lblStatus.Text = "失败";
            }
            finally
            {
                _cancellationTokenSource?.Dispose();
                _cancellationTokenSource = null;
                SetUIBusy(false);
            }
        }

        private void BtnCopyVoiceId_Click(object sender, EventArgs e)
        {
            if (!string.IsNullOrWhiteSpace(txtVoiceId.Text))
            {
                Clipboard.SetText(txtVoiceId.Text);
                lblStatus.Text = "Voice ID 已复制";
            }
            else
            {
                ShowError("没有可复制的 Voice ID");
            }
        }

        private void BtnClear_Click(object sender, EventArgs e)
        {
            txtApiKey.Clear();
            txtCustomName.Text = "aliya";
            txtReferenceText.Clear();
            txtAudioPath.Clear();
            txtVoiceId.Clear();
            ClearError();
            lblStatus.Text = "";
        }

        private void SetUIBusy(bool busy)
        {
            btnGenerate.Enabled = !busy;
            btnSelectAudio.Enabled = !busy;
            btnToggleApiKey.Enabled = !busy;
            btnCopyVoiceId.Enabled = !busy;
            btnClear.Enabled = !busy;
            txtApiKey.ReadOnly = busy;
            txtCustomName.ReadOnly = busy;
            txtReferenceText.ReadOnly = busy;
            Cursor = busy ? Cursors.WaitCursor : Cursors.Default;
        }

        private void ShowError(string message)
        {
            txtError.Text = message;
            txtError.ForeColor = Color.Red;
        }

        private void ClearError()
        {
            txtError.Clear();
            txtError.ForeColor = SystemColors.ControlText;
        }
    }
}