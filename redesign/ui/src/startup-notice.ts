/** 启动失败/同步降级提示。使用纯文本，重试失败仍保留提示且允许再次尝试。 */
export function showStartupNotice(
  id: string, message: string, error: unknown, retry: () => Promise<void>
): HTMLElement {
  document.getElementById(id)?.remove();
  const notice = document.createElement('aside');
  notice.id = id;
  notice.className = 'pet-startup-notice';
  notice.setAttribute('role', 'alert');
  const text = document.createElement('p');
  const describe = (cause: unknown) => {
    text.textContent = `${message} 原因：${String(cause)}`;
  };
  describe(error);
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '重试';
  button.onclick = async () => {
    button.disabled = true;
    try {
      await retry();
      notice.remove();
    } catch (cause) {
      console.error('[pet] startup retry failed', cause);
      describe(cause);
    } finally {
      button.disabled = false;
    }
  };
  notice.append(text, button);
  document.body.append(notice);
  return notice;
}
