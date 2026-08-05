namespace AliyaVoiceIdCreator
{
    partial class MainForm
    {
        private System.ComponentModel.IContainer components = null;

        protected override void Dispose(bool disposing)
        {
            if (disposing && (components != null))
            {
                components.Dispose();
            }
            base.Dispose(disposing);
        }

        #region Windows Form Designer generated code

        private void InitializeComponent()
        {
            this.lblApiKey = new System.Windows.Forms.Label();
            this.txtApiKey = new System.Windows.Forms.TextBox();
            this.btnToggleApiKey = new System.Windows.Forms.Button();
            this.lblCustomName = new System.Windows.Forms.Label();
            this.txtCustomName = new System.Windows.Forms.TextBox();
            this.lblReferenceText = new System.Windows.Forms.Label();
            this.txtReferenceText = new System.Windows.Forms.TextBox();
            this.lblAudioFile = new System.Windows.Forms.Label();
            this.txtAudioPath = new System.Windows.Forms.TextBox();
            this.btnSelectAudio = new System.Windows.Forms.Button();
            this.btnGenerate = new System.Windows.Forms.Button();
            this.lblStatus = new System.Windows.Forms.Label();
            this.lblVoiceId = new System.Windows.Forms.Label();
            this.txtVoiceId = new System.Windows.Forms.TextBox();
            this.btnCopyVoiceId = new System.Windows.Forms.Button();
            this.btnClear = new System.Windows.Forms.Button();
            this.lblError = new System.Windows.Forms.Label();
            this.txtError = new System.Windows.Forms.TextBox();
            this.SuspendLayout();
            // 
            // lblApiKey
            // 
            this.lblApiKey.AutoSize = true;
            this.lblApiKey.Location = new System.Drawing.Point(20, 20);
            this.lblApiKey.Name = "lblApiKey";
            this.lblApiKey.Size = new System.Drawing.Size(70, 13);
            this.lblApiKey.TabIndex = 0;
            this.lblApiKey.Text = "API Key:";
            // 
            // txtApiKey
            // 
            this.txtApiKey.Location = new System.Drawing.Point(120, 17);
            this.txtApiKey.Name = "txtApiKey";
            this.txtApiKey.Size = new System.Drawing.Size(300, 20);
            this.txtApiKey.TabIndex = 1;
            this.txtApiKey.UseSystemPasswordChar = true;
            // 
            // btnToggleApiKey
            // 
            this.btnToggleApiKey.Location = new System.Drawing.Point(430, 15);
            this.btnToggleApiKey.Name = "btnToggleApiKey";
            this.btnToggleApiKey.Size = new System.Drawing.Size(75, 23);
            this.btnToggleApiKey.TabIndex = 2;
            this.btnToggleApiKey.Text = "显示";
            this.btnToggleApiKey.UseVisualStyleBackColor = true;
            this.btnToggleApiKey.Click += new System.EventHandler(this.BtnToggleApiKey_Click);
            // 
            // lblCustomName
            // 
            this.lblCustomName.AutoSize = true;
            this.lblCustomName.Location = new System.Drawing.Point(20, 50);
            this.lblCustomName.Name = "lblCustomName";
            this.lblCustomName.Size = new System.Drawing.Size(70, 13);
            this.lblCustomName.TabIndex = 3;
            this.lblCustomName.Text = "音色名称:";
            // 
            // txtCustomName
            // 
            this.txtCustomName.Location = new System.Drawing.Point(120, 47);
            this.txtCustomName.Name = "txtCustomName";
            this.txtCustomName.Size = new System.Drawing.Size(300, 20);
            this.txtCustomName.TabIndex = 4;
            this.txtCustomName.Text = "aliya";
            // 
            // lblReferenceText
            // 
            this.lblReferenceText.AutoSize = true;
            this.lblReferenceText.Location = new System.Drawing.Point(20, 80);
            this.lblReferenceText.Name = "lblReferenceText";
            this.lblReferenceText.Size = new System.Drawing.Size(90, 13);
            this.lblReferenceText.TabIndex = 5;
            this.lblReferenceText.Text = "参考音频文本:";
            // 
            // txtReferenceText
            // 
            this.txtReferenceText.Location = new System.Drawing.Point(120, 77);
            this.txtReferenceText.Multiline = true;
            this.txtReferenceText.Name = "txtReferenceText";
            this.txtReferenceText.ScrollBars = System.Windows.Forms.ScrollBars.Vertical;
            this.txtReferenceText.Size = new System.Drawing.Size(300, 60);
            this.txtReferenceText.TabIndex = 6;
            // 
            // lblAudioFile
            // 
            this.lblAudioFile.AutoSize = true;
            this.lblAudioFile.Location = new System.Drawing.Point(20, 150);
            this.lblAudioFile.Name = "lblAudioFile";
            this.lblAudioFile.Size = new System.Drawing.Size(90, 13);
            this.lblAudioFile.TabIndex = 7;
            this.lblAudioFile.Text = "参考音频文件:";
            // 
            // txtAudioPath
            // 
            this.txtAudioPath.Location = new System.Drawing.Point(120, 147);
            this.txtAudioPath.Name = "txtAudioPath";
            this.txtAudioPath.ReadOnly = true;
            this.txtAudioPath.Size = new System.Drawing.Size(300, 20);
            this.txtAudioPath.TabIndex = 8;
            // 
            // btnSelectAudio
            // 
            this.btnSelectAudio.Location = new System.Drawing.Point(430, 145);
            this.btnSelectAudio.Name = "btnSelectAudio";
            this.btnSelectAudio.Size = new System.Drawing.Size(75, 23);
            this.btnSelectAudio.TabIndex = 9;
            this.btnSelectAudio.Text = "选择音频";
            this.btnSelectAudio.UseVisualStyleBackColor = true;
            this.btnSelectAudio.Click += new System.EventHandler(this.BtnSelectAudio_Click);
            // 
            // btnGenerate
            // 
            this.btnGenerate.Location = new System.Drawing.Point(120, 180);
            this.btnGenerate.Name = "btnGenerate";
            this.btnGenerate.Size = new System.Drawing.Size(120, 30);
            this.btnGenerate.TabIndex = 10;
            this.btnGenerate.Text = "生成 Voice ID";
            this.btnGenerate.UseVisualStyleBackColor = true;
            this.btnGenerate.Click += new System.EventHandler(this.BtnGenerate_Click);
            // 
            // lblStatus
            // 
            this.lblStatus.AutoSize = true;
            this.lblStatus.Location = new System.Drawing.Point(250, 187);
            this.lblStatus.Name = "lblStatus";
            this.lblStatus.Size = new System.Drawing.Size(0, 13);
            this.lblStatus.TabIndex = 11;
            // 
            // lblVoiceId
            // 
            this.lblVoiceId.AutoSize = true;
            this.lblVoiceId.Location = new System.Drawing.Point(20, 230);
            this.lblVoiceId.Name = "lblVoiceId";
            this.lblVoiceId.Size = new System.Drawing.Size(130, 13);
            this.lblVoiceId.TabIndex = 12;
            this.lblVoiceId.Text = "Voice ID (SiliconFlow URI):";
            // 
            // txtVoiceId
            // 
            this.txtVoiceId.Location = new System.Drawing.Point(120, 227);
            this.txtVoiceId.Name = "txtVoiceId";
            this.txtVoiceId.ReadOnly = true;
            this.txtVoiceId.Size = new System.Drawing.Size(300, 20);
            this.txtVoiceId.TabIndex = 13;
            // 
            // btnCopyVoiceId
            // 
            this.btnCopyVoiceId.Location = new System.Drawing.Point(430, 225);
            this.btnCopyVoiceId.Name = "btnCopyVoiceId";
            this.btnCopyVoiceId.Size = new System.Drawing.Size(75, 23);
            this.btnCopyVoiceId.TabIndex = 14;
            this.btnCopyVoiceId.Text = "复制";
            this.btnCopyVoiceId.UseVisualStyleBackColor = true;
            this.btnCopyVoiceId.Click += new System.EventHandler(this.BtnCopyVoiceId_Click);
            // 
            // btnClear
            // 
            this.btnClear.Location = new System.Drawing.Point(430, 260);
            this.btnClear.Name = "btnClear";
            this.btnClear.Size = new System.Drawing.Size(75, 23);
            this.btnClear.TabIndex = 15;
            this.btnClear.Text = "清空";
            this.btnClear.UseVisualStyleBackColor = true;
            this.btnClear.Click += new System.EventHandler(this.BtnClear_Click);
            // 
            // lblError
            // 
            this.lblError.AutoSize = true;
            this.lblError.Location = new System.Drawing.Point(20, 300);
            this.lblError.Name = "lblError";
            this.lblError.Size = new System.Drawing.Size(70, 13);
            this.lblError.TabIndex = 16;
            this.lblError.Text = "错误信息:";
            // 
            // txtError
            // 
            this.txtError.Location = new System.Drawing.Point(120, 297);
            this.txtError.Multiline = true;
            this.txtError.Name = "txtError";
            this.txtError.ReadOnly = true;
            this.txtError.ScrollBars = System.Windows.Forms.ScrollBars.Vertical;
            this.txtError.Size = new System.Drawing.Size(380, 100);
            this.txtError.TabIndex = 17;
            // 
            // MainForm
            // 
            this.AutoScaleDimensions = new System.Drawing.SizeF(6F, 13F);
            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
            this.ClientSize = new System.Drawing.Size(520, 420);
            this.Controls.Add(this.txtError);
            this.Controls.Add(this.lblError);
            this.Controls.Add(this.btnClear);
            this.Controls.Add(this.btnCopyVoiceId);
            this.Controls.Add(this.txtVoiceId);
            this.Controls.Add(this.lblVoiceId);
            this.Controls.Add(this.lblStatus);
            this.Controls.Add(this.btnGenerate);
            this.Controls.Add(this.btnSelectAudio);
            this.Controls.Add(this.txtAudioPath);
            this.Controls.Add(this.lblAudioFile);
            this.Controls.Add(this.txtReferenceText);
            this.Controls.Add(this.lblReferenceText);
            this.Controls.Add(this.txtCustomName);
            this.Controls.Add(this.lblCustomName);
            this.Controls.Add(this.btnToggleApiKey);
            this.Controls.Add(this.txtApiKey);
            this.Controls.Add(this.lblApiKey);
            this.Name = "MainForm";
            this.Text = "Aliya Voice ID Creator - SiliconFlow";
            this.ResumeLayout(false);
            this.PerformLayout();

        }

        #endregion

        private System.Windows.Forms.Label lblApiKey;
        private System.Windows.Forms.TextBox txtApiKey;
        private System.Windows.Forms.Button btnToggleApiKey;
        private System.Windows.Forms.Label lblCustomName;
        private System.Windows.Forms.TextBox txtCustomName;
        private System.Windows.Forms.Label lblReferenceText;
        private System.Windows.Forms.TextBox txtReferenceText;
        private System.Windows.Forms.Label lblAudioFile;
        private System.Windows.Forms.TextBox txtAudioPath;
        private System.Windows.Forms.Button btnSelectAudio;
        private System.Windows.Forms.Button btnGenerate;
        private System.Windows.Forms.Label lblStatus;
        private System.Windows.Forms.Label lblVoiceId;
        private System.Windows.Forms.TextBox txtVoiceId;
        private System.Windows.Forms.Button btnCopyVoiceId;
        private System.Windows.Forms.Button btnClear;
        private System.Windows.Forms.Label lblError;
        private System.Windows.Forms.TextBox txtError;
    }
}