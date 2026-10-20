/**
 * 设置存储（移植自 Flutter SettingsService，逻辑等价）：
 * localStorage 持久化 + Tauri 事件跨窗口同步。
 *
 * 同步拓扑：
 *   设置窗口（settings.html）改设置 → saveSettings + emitTo('pet', 'settings-changed')
 *   托盘（Rust）→ emitTo('pet', 'tray-action', …)
 *   pet 窗口启动时 loadSettings 全量应用（含位置/缩放/置顶恢复）。
 */

export interface PetSettings {
  /** 窗口位置（物理像素；null=未保存，用默认位置） */
  posX: number | null;
  posY: number | null;
  alwaysOnTop: boolean;
  /** 拖动结束后吸附屏幕边缘 */
  snapEdges: boolean;
  /** 窗口缩放（548×796.5 为 1.0，见 BASE_WINDOW_*） */
  scale: number;
  autoActions: boolean;
  mirror: boolean;
  randomSpeech: boolean;
  randomSpeechMinutes: number;
  /** 省电模式：帧率上限降为 15fps（移动端主要收益）。 */
  batterySaver?: boolean;
}

const STORAGE_KEY = 'aliya_pet_settings_v1';

/**
 * 窗口基准尺寸（scale=1.0），与 native ComputeTargetPixelSize 对齐：
 * 高 = 675 × 1.18（动作余量），宽 = 高 × 模型包围盒宽高比（Aliya ≈ 0.688）。
 * pet 窗口按加载后的实测包围盒计算；此处为同一模型的近似值，供设置页钳制用。
 */
export const BASE_WINDOW_W = 548;
export const BASE_WINDOW_H = 796.5;

export const DEFAULT_SETTINGS: PetSettings = {
  posX: null,
  posY: null,
  alwaysOnTop: true,
  snapEdges: true,
  scale: 1.0,
  autoActions: true,
  mirror: false,
  randomSpeech: false,
  randomSpeechMinutes: 5,
  batterySaver: false,
};

/** 绝对缩放范围（对应 Flutter ScalePolicy.clampAbsolute）。 */
export function clampScale(v: number): number {
  if (!Number.isFinite(v)) return 1.0;
  return Math.min(Math.max(v, 0.1), 8.0);
}

/**
 * 显示百分比域：设备允许的实际缩放范围 [minS, maxS] 线性映射到 10%~100%。
 * 实际范围不变（仍由屏幕工作区推导），百分比只是展示/档位的换算域。
 */
export const SCALE_PERCENT_MIN = 10;
export const SCALE_PERCENT_MAX = 100;

/** 实际缩放 → 显示百分比（结果钳制在 [10, 100]）。 */
export function scaleToPercent(
  scale: number,
  minS: number,
  maxS: number
): number {
  if (maxS - minS < 1e-6) return SCALE_PERCENT_MAX;
  const t = (clampScale(scale) - minS) / (maxS - minS);
  const k = Math.min(Math.max(t, 0), 1);
  return SCALE_PERCENT_MIN + (SCALE_PERCENT_MAX - SCALE_PERCENT_MIN) * k;
}

/** 显示百分比 → 实际缩放（结果钳制在 [minS, maxS]）。 */
export function percentToScale(
  percent: number,
  minS: number,
  maxS: number
): number {
  if (maxS - minS < 1e-6) return maxS;
  const t = (percent - SCALE_PERCENT_MIN) / (SCALE_PERCENT_MAX - SCALE_PERCENT_MIN);
  const k = Math.min(Math.max(t, 0), 1);
  return minS + (maxS - minS) * k;
}

/** 尺寸档位（托盘"切换尺寸"循环，百分比域）。 */
export const SIZE_PRESETS = [
  SCALE_PERCENT_MIN,
  (SCALE_PERCENT_MIN + SCALE_PERCENT_MAX) / 2,
  SCALE_PERCENT_MAX,
];

/**
 * 循环到下一个尺寸档位：10% → 55% → 100% → 10%，两次放大的尺寸增量相等。
 * 档位取自设备范围 [minS, maxS] 的百分比域，天然不会越过上下限；
 * 当前值不在档位上时，跳到比它大的下一档（没有更大的则回到最小档）。
 */
export function nextSizePreset(
  current: number,
  minS: number,
  maxS: number
): number {
  const pct = scaleToPercent(current, minS, maxS);
  const next = SIZE_PRESETS.find((p) => p > pct + 0.5) ?? SIZE_PRESETS[0];
  return percentToScale(next, minS, maxS);
}

export function loadSettings(): PetSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<PetSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      scale: clampScale(Number(parsed.scale ?? 1.0)),
      randomSpeechMinutes: Math.min(
        Math.max(Number(parsed.randomSpeechMinutes ?? 5), 1),
        120
      ),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: PetSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // 存储不可用时设置仅本次会话有效
  }
}
