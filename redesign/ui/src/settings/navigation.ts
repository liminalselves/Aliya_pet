import type { PlatformKind } from '../platform';

export type SettingsTabId = 'stage' | 'character' | 'window' | 'chat' | 'about';

export const DEFAULT_SETTINGS_TAB: SettingsTabId = 'stage';

export interface SettingsTabMeta {
  id: SettingsTabId;
  label: string;
  title: string;
  description: string;
}

export function getSettingsTabs(platform: PlatformKind): readonly SettingsTabMeta[] {
  const isAndroid = platform === 'android';
  return [
    {
      id: 'stage',
      label: '表演',
      title: '表演',
      description: '试放动作、预览表情或切换常驻待机状态',
    },
    {
      id: 'character',
      label: '角色',
      title: '角色',
      description: '调整体型显示、透明度穿透与自主互动',
    },
    {
      id: 'window',
      label: isAndroid ? '悬浮窗' : '窗口',
      title: isAndroid ? '悬浮窗' : '窗口',
      description: isAndroid
        ? '悬浮窗权限、位置行为与系统性能'
        : '桌面窗口行为、鼠标吊坠与快捷设置',
    },
    {
      id: 'chat',
      label: '聊天',
      title: '聊天',
      description: isAndroid
        ? 'Misskey 会话连接、展示偏好与主界面背景'
        : 'Misskey 会话连接、展示偏好与聊天背景',
    },
    {
      id: 'about',
      label: '关于',
      title: '关于',
      description: '版本信息、更新检查与官方发布页',
    },
  ];
}

export interface OpenTargetPlan {
  tab: SettingsTabId;
  openSessionControl: boolean;
}

const VALID_TABS = new Set<SettingsTabId>(['stage', 'character', 'window', 'chat', 'about']);

export function isValidSettingsTab(id: unknown): id is SettingsTabId {
  return typeof id === 'string' && VALID_TABS.has(id as SettingsTabId);
}

/** 外部唤醒目标是否指定了具体页签或抽屉（'' / 'main' 视作通用打开，可沿用上次页签）。 */
export function isExplicitOpenTarget(target: string | null | undefined): boolean {
  const normalized = (target ?? '').trim().replace(/^#+/, '').toLowerCase();
  return normalized === 'session-control' || VALID_TABS.has(normalized as SettingsTabId);
}

/** 将外部唤醒目标（Tauri settings-open target / Android URL hash）解析为页签切换与抽屉动作。 */
export function resolveOpenTarget(target: string | null | undefined): OpenTargetPlan {
  const normalized = (target ?? '').trim().replace(/^#+/, '').toLowerCase();
  if (normalized === 'session-control') {
    return { tab: 'chat', openSessionControl: true };
  }
  if (VALID_TABS.has(normalized as SettingsTabId)) {
    return { tab: normalized as SettingsTabId, openSessionControl: false };
  }
  return { tab: DEFAULT_SETTINGS_TAB, openSessionControl: false };
}
