/**
 * 更新提示对话框（双端共用）。
 *
 * 两种挂载形态：
 *  - 'window'：Windows 独立 update 窗口（update.html），对话框占满页面；
 *    下载进度/安装由 window.ts 注入的 primary 动作驱动（plugin-updater）。
 *  - 'modal'：Android 页内 <dialog> 模态（主界面/设置页）。
 *    原生返回键由 MainActivity 的 dialog[open] 分发处理：强制更新 preventDefault
 *    吃掉返回，非强制关闭弹窗（等同「稍后」）。
 *
 * 强制更新：隐藏「稍后」「跳过此版本」并展示说明行；关闭行为由宿主
 * （Windows Rust 关窗即退出 / Android cancel 被拦截）兜底。
 */

import './update.css';
import { openUrl } from '../platform';
import type { UpdateCheckResult } from './check';
import { deferUpdateForLaunch, skipVersion } from './check';
import { renderUpdateNotes } from './markdown';

export type UpdateDialogMode = 'window' | 'modal';
export type UpdateDismissReason = 'later' | 'skip';

export interface UpdateDialogActions {
  /** 主按钮（Windows「立即更新」/ Android「前往下载」）。缺省则不显示主按钮。 */
  primary?: (dialog: UpdateDialog) => void;
  primaryLabel?: string;
  /** 对话框被收起后通知宿主（window 形态用于隐藏原生窗口）。 */
  onClose?: (reason: UpdateDismissReason) => void;
}

const MANDATORY_HINT = '当前版本已停止支持，需要更新后继续使用';

/** updater 插件的英文错误转成用户能看懂的说明，未识别的原样保留。 */
export function describeUpdateError(message: string): string {
  if (/signature/i.test(message)) return '安装包校验未通过，可能下载不完整';
  if (/network|connect|timed? ?out|dns|request/i.test(message)) return '网络连接失败，请检查网络后重试';
  return message;
}

export class UpdateDialog {
  readonly root: HTMLElement;
  private readonly modal: HTMLDialogElement | null;
  private readonly primaryBtn: HTMLButtonElement;
  private readonly notesBox: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly progressFill: HTMLElement;
  private readonly progressLabel: HTMLElement;
  private readonly errorBox: HTMLElement;
  private readonly actions: UpdateDialogActions;
  private readonly result: UpdateCheckResult;
  private closed = false;
  private pendingReason: UpdateDismissReason = 'later';

  constructor(result: UpdateCheckResult, mode: UpdateDialogMode, actions: UpdateDialogActions = {}) {
    this.result = result;
    this.actions = actions;

    this.root = document.createElement('div');
    this.root.className = 'update-dialog';

    // ---- 头部：标题 + 当前版本（+ 强制更新说明行）----
    const head = document.createElement('header');
    head.className = 'update-head';
    const title = document.createElement('h1');
    title.textContent = `发现新版本 v${result.latest}`;
    const current = document.createElement('p');
    current.className = 'update-current';
    current.textContent = `当前版本 v${result.current}`;
    head.append(title, current);
    if (result.mandatory) {
      const hint = document.createElement('p');
      hint.className = 'update-mandatory';
      hint.textContent = MANDATORY_HINT;
      head.appendChild(hint);
    }
    this.root.appendChild(head);

    // ---- 更新说明（可滚动，安全 markdown 渲染）----
    this.notesBox = document.createElement('div');
    this.notesBox.className = 'update-notes';
    this.notesBox.innerHTML = result.notes
      ? renderUpdateNotes(result.notes)
      : '<p>优化与问题修复。</p>';
    this.root.appendChild(this.notesBox);

    // ---- 下载进度（默认隐藏，主按钮流程中显示）----
    this.progressFill = document.createElement('i');
    this.progressFill.style.width = '0%';
    const bar = document.createElement('div');
    bar.className = 'update-progress-bar';
    bar.appendChild(this.progressFill);
    this.progressLabel = document.createElement('span');
    this.progressLabel.textContent = '';
    this.progress = document.createElement('div');
    this.progress.className = 'update-progress';
    this.progress.hidden = true;
    this.progress.append(bar, this.progressLabel);
    this.root.appendChild(this.progress);

    // ---- 失败信息：原因 + 重试 + 手动下载回退 ----
    this.errorBox = document.createElement('div');
    this.errorBox.className = 'update-error';
    this.errorBox.hidden = true;
    this.root.appendChild(this.errorBox);

    // ---- 按钮区 ----
    const buttons = document.createElement('div');
    buttons.className = 'update-buttons';
    this.primaryBtn = document.createElement('button');
    this.primaryBtn.type = 'button';
    this.primaryBtn.className = 'update-primary';
    this.primaryBtn.textContent = actions.primaryLabel ?? '立即更新';
    this.primaryBtn.hidden = !actions.primary;
    this.primaryBtn.addEventListener('click', () => this.runPrimary());
    buttons.appendChild(this.primaryBtn);

    if (!result.mandatory) {
      const later = document.createElement('button');
      later.type = 'button';
      later.className = 'update-secondary';
      later.textContent = '稍后';
      later.addEventListener('click', () => this.close('later'));
      const skip = document.createElement('button');
      skip.type = 'button';
      skip.className = 'update-secondary';
      skip.textContent = '跳过此版本';
      skip.addEventListener('click', () => {
        skipVersion(result.latest);
        this.close('skip');
      });
      buttons.append(later, skip);
    }
    this.root.appendChild(buttons);

    if (mode === 'modal') {
      const modal = document.createElement('dialog');
      modal.className = 'update-modal';
      modal.appendChild(this.root);
      // 返回键/ESC：非强制放行（按「稍后」收尾）；强制更新拦截，弹窗不可关。
      modal.addEventListener('cancel', (e) => {
        if (result.mandatory) e.preventDefault();
      });
      modal.addEventListener('close', () => {
        if (result.mandatory) return;
        const reason = this.pendingReason;
        deferUpdateForLaunch();
        this.remove();
        this.actions.onClose?.(reason);
      });
      this.modal = modal;
      document.body.appendChild(modal);
      modal.showModal();
    } else {
      this.modal = null;
    }
  }

  /** 重新执行主操作（重试按钮同样走这里）。 */
  public runPrimary(): void {
    this.errorBox.hidden = true;
    this.errorBox.textContent = '';
    this.actions.primary?.(this);
  }

  /** 展示下载进度；total<=0 时进入不确定态（无百分比）。 */
  public setProgress(downloaded: number, total: number): void {
    this.progress.hidden = false;
    this.primaryBtn.disabled = true;
    const pct = total > 0 ? Math.min(100, Math.floor((downloaded / total) * 100)) : 0;
    this.progressFill.style.width = `${pct}%`;
    this.progress.classList.toggle('indeterminate', total <= 0);
    this.progressLabel.textContent = total > 0 ? `${pct}%` : '正在下载…';
  }

  /** 下载完成：等待安装器接管（Windows 上应用随后自动退出）。 */
  public setInstalling(): void {
    this.progress.hidden = false;
    this.primaryBtn.disabled = true;
    this.progress.classList.remove('indeterminate');
    this.progressFill.style.width = '100%';
    this.progressLabel.textContent = '正在启动安装程序…';
  }

  /** 安装/下载失败：错误信息 + 重试 + 手动下载回退（打开发布页）。 */
  public showError(message: string): void {
    this.progress.hidden = true;
    // 主按钮改名「重试」承担重试，错误区只留手动下载回退
    this.primaryBtn.disabled = false;
    this.primaryBtn.textContent = '重试';
    this.errorBox.hidden = false;
    this.errorBox.textContent = '';
    const text = document.createElement('p');
    text.textContent = `更新失败：${describeUpdateError(message)}`;
    this.errorBox.append(text);
    if (this.result.releasePage) {
      const manual = document.createElement('button');
      manual.type = 'button';
      manual.className = 'update-secondary';
      manual.textContent = '改为手动下载';
      manual.addEventListener('click', () => {
        void openUrl(this.result.releasePage!);
      });
      this.errorBox.appendChild(manual);
    }
  }

  /** 收起对话框：modal 形态走原生 close（事件里收尾），window 形态交宿主隐藏窗口。 */
  public close(reason: UpdateDismissReason): void {
    if (this.closed) return;
    this.pendingReason = reason;
    if (this.modal) {
      this.modal.close();
      return;
    }
    if (reason === 'later') deferUpdateForLaunch();
    this.remove();
    this.actions.onClose?.(reason);
  }

  public remove(): void {
    this.closed = true;
    this.modal?.close();
    this.modal?.remove();
    this.root.remove();
  }
}

/** Android 页内模态：主按钮打开 APK 下载链接（系统浏览器接管下载与安装）。 */
export function openUpdateModal(result: UpdateCheckResult): UpdateDialog {
  return new UpdateDialog(result, 'modal', {
    primary: () => {
      if (result.downloadUrl) void openUrl(result.downloadUrl);
    },
    primaryLabel: '前往下载',
  });
}
