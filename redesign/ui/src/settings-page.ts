/**
 * 设置窗口页面（独立 webview）：
 * 改动 → 写 localStorage + emitTo('pet', 'settings-changed') 实时生效；
 * 动作/台词/表情/状态按钮 → emitTo('pet', 'tray-action') 触发 pet 窗口行为；
 * 监听 'settings-changed'（托盘改动经 pet 广播）刷新控件、
 * 'pet-state'（pet 状态变化）刷新状态高亮。
 */

import {
  PetSettings,
  clampScale,
  scaleToPercent,
  percentToScale,
  scaleRangeFor,
  loadSettings,
  saveSettings,
  clampPendantScale,
  PENDANT_SCALE_MIN,
  PENDANT_SCALE_MAX,
  clampPendantRope,
  PENDANT_ROPE_MIN,
  PENDANT_ROPE_MAX,
} from './settings';
import {
  platform,
  androidShell,
  isAutoStart,
  setAutoStart,
  openUrl,
  shellAction,
  notifyPetAction,
} from './platform';
import { ACTIONS, EXPRESSIONS, STATES } from './catalog';
import { MSK_TOKEN_KEY, MSK_USER_KEY, mskSessionKey } from './chat/msk/config';
import { MskClient, type MskSession } from './chat/msk/client';
import { mountAgentControls, type AgentControlHandle } from './chat/msk/control-drawer';
import {
  AUTO_BACKGROUND,
  CHAT_SCENES,
  CUSTOM_BACKGROUND,
  NO_BACKGROUND,
  deleteCustomBackground,
  loadCustomBackground,
  resolveAutoScene,
  saveCustomBackground,
  type ChatScene,
} from './chat-background';
import { checkForUpdate } from './update/check';
import { OFFICIAL_SITE_URL } from './update/config';
import { openUpdateModal } from './update/dialog';
import {
  DEFAULT_SETTINGS_TAB,
  getSettingsTabs,
  isExplicitOpenTarget,
  isValidSettingsTab,
  resolveOpenTarget,
  type SettingsTabId,
} from './settings/navigation';
import {
  TAB_ICONS,
  createCard,
  createSwitchRow,
  createSliderRow,
  createWideAction,
  setRowInactive,
  hotkeyFromEvent,
  type SliderRowHandle,
} from './settings/ui';
import './settings.css';
import { showToast } from './toast';

// 平台样式钩子（移动端大字/大行距/顶栏，见 settings.html）
document.body.classList.add(`platform-${platform}`);

type Emit = (event: string, payload: unknown) => void;
type Listen = (event: string, cb: () => void) => void;

let emitToPet: Emit = () => {};
let emitToPendant: Emit = () => {};
let emitToChat: Emit = () => {};
let emitToRecords: Emit = () => {};
let onSettingsChanged: Listen = () => {};
/** pet 窗口推送的状态：manual=null 表示自动。 */
type PetStatePayload = { state: string; manual: string | null };
let onStateChanged: (cb: (s: PetStatePayload) => void) => void = () => {};

// Only the desktop shell owns the Tauri event bus.
if (platform === 'tauri') {
  try {
    const ev = await import('@tauri-apps/api/event');
    emitToPet = (event, payload) => {
      ev.emitTo('pet', event, payload).catch(() => {});
    };
    emitToPendant = (event, payload) => {
      ev.emitTo('pendant', event, payload).catch(() => {});
    };
    emitToChat = (event, payload) => {
      ev.emitTo('chat', event, payload).catch(() => {});
    };
    emitToRecords = (event, payload) => {
      ev.emitTo('records', event, payload).catch(() => {});
    };
    onSettingsChanged = (event, cb) => {
      ev.listen(event, cb).catch(() => {});
    };
    onStateChanged = (cb) => {
      ev
        .listen<PetStatePayload>('pet-state', (e) => {
          if (e.payload && typeof e.payload.state === 'string') cb(e.payload);
        })
        .catch(() => {});
    };
  } catch {
    // 纯浏览器：无跨窗口同步
  }
}

let settings: PetSettings = loadSettings();

function update(patch: Partial<PetSettings>): void {
  settings = { ...settings, ...patch };
  saveSettings(settings);
  emitToPet('settings-changed', settings);
  emitToPendant('settings-changed', settings);
  emitToChat('settings-changed', settings);
  emitToRecords('settings-changed', settings);
  // 安卓：设置页与桌宠页是两个 WebView，经壳桥转发实时生效
  if (platform === 'android') {
    try {
      androidShell()?.notifySettings?.(JSON.stringify(settings));
    } catch {
      // 旧桥无此方法时静默
    }
  }
}

function trayAction(action: string, extra?: Record<string, unknown>): void {
  emitToPet('tray-action', { action, ...extra });
  // Android：设置页与桌宠页是两个 WebView，经壳桥转发到桌宠页执行
  notifyPetAction({ action, ...extra });
}

/**
 * 表演类操作（动作/台词/表情/状态）。Windows 设置是独立窗口，桌宠就在旁边，按钮只 pulse 确认；
 * Android 设置页整屏盖住桌宠，发出后先让按钮确认一拍，再滑回主界面让用户看到表演。
 * 桌宠页在设置页下面持续运行，动作在滑出过程中已开始播放。
 */
const STAGE_AUTO_RETURN_KEY = 'aliya_stage_auto_return';
const SETTINGS_LAST_TAB_KEY = 'aliya_settings_tab';
let stageAutoReturn = (() => {
  try { return localStorage.getItem(STAGE_AUTO_RETURN_KEY) !== '0'; } catch { return true; }
})();

let returning = 0;
function perform(button: HTMLElement, action: string, extra?: Record<string, unknown>): void {
  trayAction(action, extra);
  pulse(button);
  if (platform !== 'android' || !stageAutoReturn || returning) return;
  returning = window.setTimeout(() => {
    returning = 0;
    shellAction('open-main');
  }, 160);
}

/** 触发类按钮的即时反馈：桌宠在另一个窗口执行，按钮本身短暂确认「已发出」。 */
function pulse(button: HTMLElement): void {
  button.classList.remove('sent');
  void button.offsetWidth;
  button.classList.add('sent');
  window.setTimeout(() => button.classList.remove('sent'), 700);
}

/** 破坏性操作二次确认：首次点击切换提示并 3 秒内自动复位，第二次才真正执行。 */
function armTwoStepButton(button: HTMLButtonElement, confirmLabel: string, onConfirm: () => void): void {
  const idleLabel = button.textContent ?? '';
  let timer = 0;
  const disarm = () => {
    if (timer) { clearTimeout(timer); timer = 0; }
    button.dataset.confirm = '';
    button.textContent = idleLabel;
    button.classList.remove('confirming');
  };
  button.addEventListener('click', () => {
    if (button.dataset.confirm !== '1') {
      button.dataset.confirm = '1';
      button.textContent = confirmLabel;
      button.classList.add('confirming');
      if (timer) clearTimeout(timer);
      timer = window.setTimeout(disarm, 3000);
      return;
    }
    disarm();
    onConfirm();
  });
}

// ---------- 页面骨架（左侧导航 / 顶部横向标签 + 模块化卡片容器） ----------

const app = document.getElementById('app')!;
app.classList.add('settings-shell');

// 移动端顶栏：返回（回桌宠页）+ 标题；桌面端是独立窗口，有系统标题栏
if (platform === 'android') {
  const bar = document.createElement('header');
  bar.className = 'mobile-topbar';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'back';
  back.setAttribute('aria-label', '返回');
  back.addEventListener('click', () => shellAction('back'));
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = '设置';
  bar.append(back, title);
  app.appendChild(bar);
}

const tabs = getSettingsTabs(platform);
const tabButtons = new Map<SettingsTabId, HTMLButtonElement>();
const panels = new Map<SettingsTabId, { section: HTMLElement; group: HTMLElement }>();

const nav = document.createElement('nav');
nav.className = 'settings-nav';
nav.setAttribute('aria-label', '设置分组');

const navBrand = document.createElement('div');
navBrand.className = 'nav-brand';
const brandName = document.createElement('span');
brandName.className = 'nav-brand-name';
brandName.textContent = 'Aliya';
const brandSub = document.createElement('span');
brandSub.className = 'nav-brand-sub';
brandSub.textContent = '设置';
navBrand.append(brandName, brandSub);

const navList = document.createElement('div');
navList.className = 'nav-list';
navList.setAttribute('role', 'tablist');

const navFoot = document.createElement('div');
navFoot.className = 'nav-foot';
navFoot.textContent = `v${__APP_VERSION__}`;

nav.append(navBrand, navList, navFoot);

const main = document.createElement('main');
main.className = 'settings-main';
main.tabIndex = -1;

app.append(nav, main);

let activeTab: SettingsTabId = DEFAULT_SETTINGS_TAB;

const syncNavEdges = () => {
  const max = navList.scrollWidth - navList.clientWidth;
  navList.classList.toggle('more-left', navList.scrollLeft > 1);
  navList.classList.toggle('more-right', max - navList.scrollLeft > 1);
};

const revealNavTab = (tab: HTMLElement) => {
  if (navList.scrollWidth <= navList.clientWidth + 1) return;
  const pad = 20;
  const left = tab.offsetLeft - navList.offsetLeft;
  const target =
    left < navList.scrollLeft + pad
      ? left - pad
      : left + tab.offsetWidth > navList.scrollLeft + navList.clientWidth - pad
        ? left + tab.offsetWidth - navList.clientWidth + pad
        : null;
  if (target !== null) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    navList.scrollTo({ left: Math.max(0, target), behavior: reduce ? 'auto' : 'smooth' });
  }
};

function selectTab(
  id: SettingsTabId,
  options: { animate?: boolean; focusTab?: boolean; persist?: boolean } = {}
): void {
  activeTab = id;
  if (options.persist !== false) {
    try { localStorage.setItem(SETTINGS_LAST_TAB_KEY, id); } catch { /* ignore */ }
  }
  for (const [tabId, btn] of tabButtons) {
    const on = tabId === id;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
  }
  for (const [panelId, { section }] of panels) {
    section.hidden = panelId !== id;
  }
  main.scrollTop = 0;

  const activeBtn = tabButtons.get(id);
  if (activeBtn) {
    if (options.focusTab) activeBtn.focus();
    revealNavTab(activeBtn);
  }

  const panel = panels.get(id)?.section;
  if (panel) {
    panel.classList.remove('enter');
    if (options.animate !== false) {
      void panel.offsetWidth;
      panel.classList.add('enter');
    }
  }
  if (id === 'chat') refs.chatEnter?.();
}

for (const tab of tabs) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'nav-item';
  btn.id = `tab-${tab.id}`;
  btn.dataset.tab = tab.id;
  btn.setAttribute('role', 'tab');
  btn.setAttribute('aria-controls', `panel-${tab.id}`);
  btn.setAttribute('aria-selected', 'false');
  btn.tabIndex = -1;

  const icon = document.createElement('span');
  icon.className = 'nav-icon';
  icon.innerHTML = TAB_ICONS[tab.id];
  const label = document.createElement('span');
  label.className = 'nav-label';
  label.textContent = tab.label;
  btn.append(icon, label);
  btn.addEventListener('click', () => selectTab(tab.id));
  tabButtons.set(tab.id, btn);
  navList.appendChild(btn);

  const section = document.createElement('section');
  section.className = 'settings-panel';
  section.id = `panel-${tab.id}`;
  section.setAttribute('role', 'tabpanel');
  section.setAttribute('aria-labelledby', `tab-${tab.id}`);
  section.hidden = true;

  const head = document.createElement('header');
  head.className = 'panel-head';
  const title = document.createElement('h1');
  title.className = 'panel-title';
  title.textContent = tab.title;
  const desc = document.createElement('p');
  desc.className = 'panel-desc';
  desc.textContent = tab.description;
  head.append(title, desc);

  const group = document.createElement('div');
  group.className = 'card-group';
  section.append(head, group);
  main.appendChild(section);
  panels.set(tab.id, { section, group });
}

navList.addEventListener('scroll', syncNavEdges, { passive: true });
new ResizeObserver(syncNavEdges).observe(navList);
navList.addEventListener(
  'wheel',
  (e) => {
    if (navList.scrollWidth <= navList.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    e.preventDefault();
    navList.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  },
  { passive: false }
);
navList.addEventListener('keydown', (e) => {
  const index = tabs.findIndex((t) => t.id === activeTab);
  if (index < 0) return;
  let nextIndex = -1;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIndex = (index + 1) % tabs.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') nextIndex = (index - 1 + tabs.length) % tabs.length;
  else if (e.key === 'Home') nextIndex = 0;
  else if (e.key === 'End') nextIndex = tabs.length - 1;
  if (nextIndex < 0) return;
  e.preventDefault();
  selectTab(tabs[nextIndex].id, { focusTab: true });
});

// ---------- 控件引用（外部广播时刷新） ----------

const refs: {
  autoActions?: HTMLInputElement;
  randomSpeech?: HTMLInputElement;
  showGeneratedImages?: HTMLInputElement;
  speechMinutes?: HTMLInputElement;
  speechDec?: HTMLButtonElement;
  speechInc?: HTMLButtonElement;
  mirror?: HTMLInputElement;
  showCatEars?: HTMLInputElement;
  showGlasses?: HTMLInputElement;
  showChatButton?: HTMLInputElement;
  alwaysOnTop?: HTMLInputElement;
  snapEdges?: HTMLInputElement;
  pinballMode?: HTMLInputElement;
  autoStart?: HTMLInputElement;
  batterySaver?: HTMLInputElement;
  overlayOnExit?: HTMLInputElement;
  petOpacity?: SliderRowHandle;
  fullClickThrough?: HTMLInputElement;
  pendantEnabled?: HTMLInputElement;
  pendantScale?: SliderRowHandle;
  pendantRope?: SliderRowHandle;
  syncPendantRows?: () => void;
  gameModeHotkeyShow?: () => void;
  pinballModeHotkeyShow?: () => void;
  syncGameMode?: (enabled: boolean) => void;
  syncPinballMode?: () => void;
  scaleControl?: SliderRowHandle;
  chatBgDim?: SliderRowHandle;
  chatBgSync?: () => void;
  chatEnter?: () => void;
} = {};

// 缩放显示域：设备允许的实际范围 [scaleRangeMin, scaleRangeMax] 线性映射到
// 10%~100%（实际范围由屏幕推导，与 pet 窗口的设备钳制同一公式）。
let scaleRangeMin = 0.15;
let scaleRangeMax = 2;

function scalePercent(s: number): number {
  return Math.round(scaleToPercent(s, scaleRangeMin, scaleRangeMax));
}

/** 台词间隔只在随机台词开启时有意义：关闭时整行降透明并禁止交互。 */
let speechRow: HTMLElement | null = null;
function syncSpeechRow(): void {
  setRowInactive(speechRow, !settings.randomSpeech);
}

function refreshControls(): void {
  refs.petOpacity?.setDisplay(settings.petOpacity);
  if (refs.fullClickThrough) refs.fullClickThrough.checked = settings.fullClickThrough;
  if (refs.pendantEnabled) refs.pendantEnabled.checked = settings.pendantEnabled;
  refs.pendantScale?.setDisplay(Math.round(settings.pendantScale * 100));
  refs.pendantRope?.setDisplay(settings.pendantRopeLength);
  refs.syncPendantRows?.();
  if (refs.autoActions) refs.autoActions.checked = settings.autoActions;
  if (refs.randomSpeech) refs.randomSpeech.checked = settings.randomSpeech;
  if (refs.showGeneratedImages) refs.showGeneratedImages.checked = settings.showGeneratedImages;
  if (refs.speechMinutes) refs.speechMinutes.value = String(settings.randomSpeechMinutes);
  if (refs.speechDec) refs.speechDec.disabled = settings.randomSpeechMinutes <= 1;
  if (refs.speechInc) refs.speechInc.disabled = settings.randomSpeechMinutes >= 120;
  syncSpeechRow();
  if (refs.mirror) refs.mirror.checked = settings.mirror;
  if (refs.showCatEars) refs.showCatEars.checked = settings.showCatEars;
  if (refs.showGlasses) refs.showGlasses.checked = settings.showGlasses;
  if (refs.showChatButton) refs.showChatButton.checked = settings.showChatButton;
  if (refs.alwaysOnTop) refs.alwaysOnTop.checked = settings.alwaysOnTop;
  refs.gameModeHotkeyShow?.();
  refs.pinballModeHotkeyShow?.();
  if (refs.snapEdges) refs.snapEdges.checked = settings.snapEdges;
  if (refs.pinballMode) refs.pinballMode.checked = settings.pinballMode;
  refs.syncPinballMode?.();
  refs.scaleControl?.setDisplay(scalePercent(settings.scale));
  if (refs.batterySaver) refs.batterySaver.checked = settings.batterySaver === true;
  refs.chatBgDim?.setDisplay(Math.round(settings.chatBackgroundDim * 100));
  refs.chatBgSync?.();
}

let gameModeEnabled = false;
let gameModeEpoch = 0;

function applyGameModeState(enabled: boolean): void {
  gameModeEnabled = enabled;
  refs.syncGameMode?.(enabled);
}

let hotkeyRecordingActive = false;

/** 全局快捷键录制行：点按钮后按下组合键；Esc 取消，Backspace/Delete 清除。
 *  先经壳注册，成功才保存，被占用或冲突时保留原快捷键并提示。 */
function createHotkeyRow(
  parent: HTMLElement,
  opts: {
    title: string;
    desc: string;
    command: 'set_game_mode_hotkey' | 'set_pinball_mode_hotkey';
    settingKey: 'gameModeHotkey' | 'pinballModeHotkey';
  },
): () => void {
  const row = document.createElement('div');
  row.className = 'row';
  const lab = document.createElement('div');
  lab.className = 'label';
  lab.textContent = opts.title;
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = opts.desc;
  lab.appendChild(sub);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'act';
  let recording = false;
  const show = () => {
    btn.classList.toggle('recording', recording);
    btn.textContent = recording ? '请按下快捷键…' : settings[opts.settingKey] || '未设置';
  };
  const stop = () => {
    recording = false;
    hotkeyRecordingActive = false;
    window.removeEventListener('keydown', onKey, true);
    show();
  };
  const commit = async (hotkey: string) => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const label = await invoke<string>(opts.command, { hotkey });
      update({ [opts.settingKey]: label } as Partial<PetSettings>);
      showToast(label ? `${opts.title}已设为 ${label}` : `已清除${opts.title}`, {
        kind: 'success',
      });
    } catch (error) {
      showToast(`设置失败：${String(error)}`, { kind: 'error' });
    }
    show();
  };
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      stop();
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      stop();
      void commit('');
      return;
    }
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    const hotkey = hotkeyFromEvent(e);
    if (!hotkey) {
      showToast('不支持该按键，请按字母/数字（需搭配 Ctrl/Alt/Shift/Win）或 F1–F24', {
        kind: 'error',
      });
      return;
    }
    stop();
    void commit(hotkey);
  };
  btn.addEventListener('click', () => {
    if (recording) {
      stop();
      return;
    }
    recording = true;
    hotkeyRecordingActive = true;
    window.addEventListener('keydown', onKey, true);
    show();
  });
  btn.addEventListener('blur', () => {
    if (recording) stop();
  });
  show();
  row.append(lab, btn);
  parent.appendChild(row);
  return show;
}

function gameModeHotkeyRow(parent: HTMLElement): void {
  refs.gameModeHotkeyShow = createHotkeyRow(parent, {
    title: '游戏模式快捷键',
    desc: '游戏模式下桌宠和聊天窗口完全不接收鼠标，不会抢走游戏的键盘焦点。也可从托盘切换。字母和数字需搭配 Ctrl / Alt / Shift / Win。',
    command: 'set_game_mode_hotkey',
    settingKey: 'gameModeHotkey',
  });
}

function pinballModeHotkeyRow(parent: HTMLElement): void {
  refs.pinballModeHotkeyShow = createHotkeyRow(parent, {
    title: '弹球模式快捷键',
    desc: '随时全局开启/关闭弹球模式（也可从托盘切换）。字母和数字需搭配 Ctrl / Alt / Shift / Win。',
    command: 'set_pinball_mode_hotkey',
    settingKey: 'pinballModeHotkey',
  });
}

// 省电模式（所有平台；移动端收益最大）
function addBatterySaverSwitch(parent: HTMLElement): HTMLInputElement {
  return createSwitchRow(
    parent,
    '省电模式',
    '帧率上限降为 15fps（屏幕常显的悬浮窗建议开启）',
    () => settings.batterySaver === true,
    (v) => update({ batterySaver: v })
  ).input;
}

// ---------- 1. 表演模块（动作与台词 / 表情 / 状态） ----------

const stateButtons = new Map<string, HTMLButtonElement>();
let manualState = '';
let setStateBadge: (text: string, tone?: 'neutral' | 'accent' | 'success' | 'warning') => void = () => {};

function refreshStateHighlight(): void {
  for (const [name, btn] of stateButtons) {
    btn.classList.toggle('active', name === manualState);
  }
  if (!manualState) {
    setStateBadge('自动', 'neutral');
    return;
  }
  const label = STATES.find((s) => s.name === manualState)?.label ?? manualState;
  setStateBadge(label, 'accent');
}

{
  const { group } = panels.get('stage')!;

  // 卡片 1：动作与台词
  const motionCard = createCard(group, {
    title: '动作与台词',
    desc: '点击立即在桌宠窗口播放',
  });
  const motionGrid = document.createElement('div');
  motionGrid.className = 'grid';
  for (const { name, label } of ACTIONS.filter((a) => a.kind === 'motion')) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'act';
    b.textContent = label;
    b.addEventListener('click', () => perform(b, 'play-action', { name }));
    motionGrid.appendChild(b);
  }
  motionCard.body.appendChild(motionGrid);
  createWideAction(motionCard.body, '随机说一句', (b) => perform(b, 'random-speech'));
  if (platform === 'android') {
    createSwitchRow(
      motionCard.body,
      '点击后自动回到主界面',
      '触发动作、表情或状态后自动返回桌宠画面；关闭后可留在设置里连续试放',
      () => stageAutoReturn,
      (v) => {
        stageAutoReturn = v;
        try { localStorage.setItem(STAGE_AUTO_RETURN_KEY, v ? '1' : '0'); } catch { /* ignore */ }
      }
    );
  }

  // 卡片 2：表情
  const exprCard = createCard(group, {
    title: '表情',
    desc: '点击临时预览，8 秒后恢复当前状态的表情',
  });
  const exprGrid = document.createElement('div');
  exprGrid.className = 'grid';
  for (const { name, label } of EXPRESSIONS.filter((e) => e.name !== 'neutral')) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'act';
    b.textContent = label;
    b.addEventListener('click', () => perform(b, 'express', { name, duration: 8 }));
    exprGrid.appendChild(b);
  }
  exprCard.body.appendChild(exprGrid);
  createWideAction(exprCard.body, '恢复默认表情', (b) => perform(b, 'clear-expression'));

  // 卡片 3：状态
  const stateCard = createCard(group, {
    title: '状态',
    desc: '一直保持的表情与待机动作；自动时为平静',
    badge: { text: '自动', tone: 'neutral' },
  });
  setStateBadge = stateCard.setBadge;
  const stateGrid = document.createElement('div');
  stateGrid.className = 'grid';
  for (const { name, label } of [{ name: '', label: '自动' }, ...STATES]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'act';
    b.textContent = label;
    b.addEventListener('click', () => {
      manualState = name;
      refreshStateHighlight();
      perform(b, 'set-state', { name });
    });
    stateButtons.set(name, b);
    stateGrid.appendChild(b);
  }
  stateCard.body.appendChild(stateGrid);
  refreshStateHighlight();
}

// ---------- 2. 角色模块（外观与显示 / 透明度与穿透 / 自主行为） ----------

{
  const { group } = panels.get('character')!;

  // 卡片 1：外观与显示
  const appearanceCard = createCard(group, {
    title: '外观与显示',
    desc: '尺寸、朝向与部件可见性',
  });

  const commitScale = (v: number) => {
    const s = clampScale(Math.min(Math.max(v, scaleRangeMin), scaleRangeMax));
    refs.scaleControl?.setDisplay(scalePercent(s));
    update({ scale: s });
  };
  refs.scaleControl = createSliderRow(appearanceCard.body, {
    label: '缩放',
    min: 10,
    max: 100,
    step: 1,
    value: scalePercent(settings.scale),
    withStepButtons: true,
    onInput: (pct) => commitScale(percentToScale(pct, scaleRangeMin, scaleRangeMax)),
    onStep: (dir) => commitScale(dir < 0 ? settings.scale / 1.08 : settings.scale * 1.08),
  });

  if (platform === 'android') {
    try {
      const m = JSON.parse(androidShell()?.getMetrics() ?? '') as {
        screenW: number;
        screenH: number;
      };
      if (m.screenW > 0 && m.screenH > 0) {
        // 安卓底部系统栏占 88 逻辑像素，从可用高度里扣掉
        const range = scaleRangeFor(m.screenW, m.screenH - 88);
        scaleRangeMin = range.minS;
        scaleRangeMax = range.maxS;
        refreshControls();
      }
    } catch {
      // 保持默认范围
    }
  } else {
    import('@tauri-apps/api/window')
      .then(async (m) => {
        let mon: import('@tauri-apps/api/window').Monitor | null = null;
        try {
          mon = await m.currentMonitor();
        } catch {
          mon = null;
        }
        if (!mon) return;
        const logW = mon.workArea.size.width / mon.scaleFactor;
        const logH = mon.workArea.size.height / mon.scaleFactor;
        const range = scaleRangeFor(logW, logH);
        scaleRangeMin = range.minS;
        scaleRangeMax = range.maxS;
        refreshControls();
      })
      .catch(() => {});
  }

  refs.mirror = createSwitchRow(
    appearanceCard.body,
    '镜像显示',
    '左右翻转角色',
    () => settings.mirror,
    (v) => update({ mirror: v })
  ).input;
  refs.showCatEars = createSwitchRow(
    appearanceCard.body,
    '显示猫耳',
    '关闭后耳朵不再显示，也不会再被戳到',
    () => settings.showCatEars,
    (v) => update({ showCatEars: v })
  ).input;
  refs.showGlasses = createSwitchRow(
    appearanceCard.body,
    '显示黑框眼镜',
    '关闭时不常驻佩戴，播放「划重点」动作时会临时戴上',
    () => settings.showGlasses,
    (v) => update({ showGlasses: v })
  ).input;
  refs.showChatButton = createSwitchRow(
    appearanceCard.body,
    '显示聊天按钮',
    platform === 'android'
      ? '关闭后收起聊天框时不再显示聊天按钮，可从主界面菜单「聊天」重新打开'
      : '关闭后人物脚下不再显示聊天入口，仍可从托盘菜单「打开聊天」进入',
    () => settings.showChatButton,
    (v) => update({ showChatButton: v })
  ).input;

  // 卡片 2：透明度与穿透
  const visibilityCard = createCard(group, {
    title: '透明度与穿透',
    desc: '控制角色可见度与鼠标/触摸穿透',
  });
  const commitOpacity = (v: number) => {
    const n = Math.min(100, Math.max(0, Math.round(v / 5) * 5));
    refs.petOpacity?.setDisplay(n);
    update({ petOpacity: n });
  };
  refs.petOpacity = createSliderRow(visibilityCard.body, {
    label: '人物透明度',
    sub:
      platform === 'android'
        ? '只影响悬浮窗里的人物，不影响 App 主界面'
        : '只影响桌宠显示，不影响聊天与其他窗口',
    stacked: true,
    withStepButtons: true,
    ariaLabel: '人物透明度',
    min: 0,
    max: 100,
    step: 5,
    value: settings.petOpacity,
    onInput: commitOpacity,
    onStep: (dir) => commitOpacity(settings.petOpacity + dir * 5),
  });
  refs.fullClickThrough = createSwitchRow(
    visibilityCard.body,
    '人物完全穿透',
    '关闭：人物可以正常互动，透明区域仍然穿透。开启：整个人物都允许鼠标穿透，聊天窗口仍可正常使用。0% 时自动穿透，请通过托盘或 App 设置恢复。' +
      (platform === 'android'
        ? 'Android 12+ 完全穿透会自动降低人物可见度；独立气泡覆盖处仍受系统触摸安全限制。'
        : ''),
    () => settings.fullClickThrough,
    (v) => update({ fullClickThrough: v })
  ).input;

  // 卡片 3：自主行为
  const behaviorCard = createCard(group, {
    title: '自主行为',
    desc: '未操作时的自动动作与对话频率',
  });
  refs.autoActions = createSwitchRow(
    behaviorCard.body,
    '自动随机动作',
    '角色每隔一段时间自己表演动作',
    () => settings.autoActions,
    (v) => update({ autoActions: v })
  ).input;
  refs.randomSpeech = createSwitchRow(
    behaviorCard.body,
    '随机台词',
    '每隔一段时间主动说一句话',
    () => settings.randomSpeech,
    (v) => {
      update({ randomSpeech: v });
      syncSpeechRow();
    }
  ).input;

  const row = document.createElement('div');
  row.className = 'row';
  speechRow = row;
  const lab = document.createElement('div');
  lab.className = 'label';
  lab.textContent = '台词间隔';
  const labSub = document.createElement('span');
  labSub.className = 'sub';
  labSub.textContent = '单位：分钟，1–120';
  lab.appendChild(labSub);
  const stepper = document.createElement('div');
  stepper.className = 'stepper';
  const dec = document.createElement('button');
  dec.type = 'button';
  dec.textContent = '−';
  dec.setAttribute('aria-label', '减少间隔');
  const inc = document.createElement('button');
  inc.type = 'button';
  inc.textContent = '+';
  inc.setAttribute('aria-label', '增加间隔');
  const num = document.createElement('input');
  num.className = 'num';
  num.type = 'number';
  num.inputMode = 'numeric';
  num.min = '1';
  num.max = '120';
  num.value = String(settings.randomSpeechMinutes);
  num.setAttribute('aria-label', '台词间隔（分钟）');
  const commitMinutes = (v: number) => {
    const clamped = Math.min(Math.max(Math.round(v) || settings.randomSpeechMinutes, 1), 120);
    num.value = String(clamped);
    dec.disabled = clamped <= 1;
    inc.disabled = clamped >= 120;
    if (clamped !== settings.randomSpeechMinutes) update({ randomSpeechMinutes: clamped });
  };
  num.addEventListener('change', () => commitMinutes(Number(num.value)));
  num.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') num.blur();
  });
  dec.addEventListener('click', () => commitMinutes(settings.randomSpeechMinutes - 1));
  inc.addEventListener('click', () => commitMinutes(settings.randomSpeechMinutes + 1));
  dec.disabled = settings.randomSpeechMinutes <= 1;
  inc.disabled = settings.randomSpeechMinutes >= 120;
  stepper.append(dec, num, inc);
  refs.speechMinutes = num;
  refs.speechDec = dec;
  refs.speechInc = inc;
  row.append(lab, stepper);
  behaviorCard.body.appendChild(row);
  syncSpeechRow();
}

// ---------- 3. 窗口 / 悬浮窗模块 ----------

{
  const { group } = panels.get('window')!;

  if (platform === 'android') {
    const shell = androidShell();

    // 卡片 1：权限与后台
    const permCard = createCard(group, {
      title: '权限与后台',
      desc: '悬浮窗授权与后台切出行为',
      badge: { text: '已授予', tone: 'success' },
    });
    const permRow = document.createElement('div');
    permRow.className = 'row';
    const permLab = document.createElement('div');
    permLab.className = 'label';
    permLab.textContent = '悬浮窗权限';
    const permSub = document.createElement('span');
    permSub.className = 'sub';
    permLab.appendChild(permSub);
    const permBtn = document.createElement('button');
    permBtn.type = 'button';
    permBtn.className = 'act';
    permBtn.addEventListener('click', () => shellAction('open-overlay-settings'));
    permRow.append(permLab, permBtn);
    permCard.body.appendChild(permRow);

    const refreshPerm = () => {
      let granted = true;
      try {
        granted = shell?.isOverlayGranted() !== false;
      } catch {
        granted = true;
      }
      permSub.textContent = granted ? '已授予' : '未授予，悬浮窗无法激活';
      permBtn.textContent = granted ? '查看' : '去开启';
      permCard.setBadge(granted ? '已授予' : '未授予', granted ? 'success' : 'warning');
    };
    refreshPerm();
    window.addEventListener('focus', refreshPerm);

    refs.overlayOnExit = createSwitchRow(
      permCard.body,
      '退到后台后显示悬浮窗',
      '悬浮窗支持点击、抚摸和拖动；双击回到主界面聊天，菜单退出会完全关闭',
      () => shell?.getPref('overlayOnExit') !== '0',
      (v) => shell?.setPref('overlayOnExit', v ? '1' : '0')
    ).input;

    // 卡片 2：位置与贴边
    const posCard = createCard(group, {
      title: '位置与贴边',
      desc: '控制悬浮窗拖动吸附与复位',
    });
    const syncAndroidPinballBadge = () => {
      if (settings.pinballMode) posCard.setBadge('弹球模式中', 'accent');
      else posCard.setBadge('', 'neutral');
    };
    refs.syncPinballMode = syncAndroidPinballBadge;
    refs.snapEdges = createSwitchRow(
      posCard.body,
      '屏幕贴边',
      '拖动自由跟手，松开后平滑靠边；拖出屏幕也会归位，关闭后可停在屏幕外',
      () => settings.snapEdges,
      (v) => update({ snapEdges: v })
    ).input;
    refs.pinballMode = createSwitchRow(
      posCard.body,
      '弹球模式',
      '拖动人物用力甩出后，会在屏幕四壁间按重力碰撞弹跳并落到底边停稳；随时可再抓起',
      () => settings.pinballMode,
      (v) => {
        update({ pinballMode: v });
        syncAndroidPinballBadge();
        showToast(v ? '已开启弹球模式' : '已关闭弹球模式');
      }
    ).input;
    syncAndroidPinballBadge();
    createWideAction(posCard.body, '位置重置（移回主屏幕中央）', () => {
      // 贴合模式：petX/petY 是角色原点（非窗口左上角），写屏中心，
      // 悬浮窗下次启动（或服务重建）时在屏幕中央出现
      try {
        if (!shell) throw new Error('shell unavailable');
        const m = JSON.parse(shell.getMetrics()) as { screenW: number; screenH: number };
        const x = Math.round(m.screenW / 2);
        const y = Math.round(m.screenH * 0.45);
        update({ posX: x, posY: y });
        shell.setPref('petX', String(x));
        shell.setPref('petY', String(y));
        showToast('已重置位置，悬浮窗下次显示时会出现在屏幕中央', { kind: 'success' });
      } catch {
        showToast('位置重置失败，请稍后重试', { kind: 'error' });
      }
    });

    // 卡片 3：系统与性能
    const sysCard = createCard(group, {
      title: '系统与性能',
      desc: '自启与悬浮窗帧率控制',
    });
    refs.autoStart = createSwitchRow(
      sysCard.body,
      '开机自启',
      '设备开机后自动显示悬浮窗',
      () => false,
      (v) => {
        void setAutoStart(v).then(async (ok) => {
          if (!ok) {
            if (refs.autoStart) refs.autoStart.checked = (await isAutoStart()) === true;
            showToast('设置开机自启失败，请检查系统权限', { kind: 'error' });
          }
        });
      }
    ).input;
    isAutoStart().then((v) => {
      if (refs.autoStart) refs.autoStart.checked = v === true;
    });
    refs.batterySaver = addBatterySaverSwitch(sysCard.body);
  } else {
    // 卡片 1：窗口行为（桌面端）
    const winCard = createCard(group, {
      title: '窗口行为',
      desc: '置顶层级、边缘吸附与位置复位',
    });
    refs.alwaysOnTop = createSwitchRow(
      winCard.body,
      '置顶显示',
      '让宠物始终显示在其他窗口之上',
      () => settings.alwaysOnTop,
      (v) => update({ alwaysOnTop: v })
    ).input;
    refs.snapEdges = createSwitchRow(
      winCard.body,
      '屏幕贴边',
      '拖动自由跟手，松开后平滑靠边；拖出屏幕也会归位，关闭后可停在屏幕外',
      () => settings.snapEdges,
      (v) => update({ snapEdges: v })
    ).input;
    createWideAction(winCard.body, '位置重置（移回主屏幕中央）', () => {
      trayAction('reset-position');
      showToast('已移回屏幕中央', { kind: 'success' });
    });

    // 卡片 2：鼠标吊坠（仅 Windows）
    if (platform === 'tauri') {
      const pendantCard = createCard(group, {
        title: '鼠标吊坠',
        desc: '挂在鼠标指针上的迷你跟随角色',
        badge: {
          text: settings.pendantEnabled ? '已开启' : '已关闭',
          tone: settings.pendantEnabled ? 'accent' : 'neutral',
        },
      });
      const syncPendantRows = () => {
        const disabled = !settings.pendantEnabled;
        setRowInactive(refs.pendantScale?.row ?? null, disabled);
        setRowInactive(refs.pendantRope?.row ?? null, disabled);
        pendantCard.setBadge(
          settings.pendantEnabled ? '已开启' : '已关闭',
          settings.pendantEnabled ? 'accent' : 'neutral'
        );
      };
      refs.syncPendantRows = syncPendantRows;

      refs.pendantEnabled = createSwitchRow(
        pendantCard.body,
        '鼠标吊坠',
        '缩小的人物用绳子挂在鼠标指针上，随移动甩动；不拦截点击，不影响主桌宠',
        () => settings.pendantEnabled,
        (v) => {
          update({ pendantEnabled: v });
          syncPendantRows();
        }
      ).input;

      const commitPendantScale = (pct: number) => {
        const s = clampPendantScale(Math.round(pct / 5) * 5 / 100);
        refs.pendantScale?.setDisplay(Math.round(s * 100));
        update({ pendantScale: s });
      };
      refs.pendantScale = createSliderRow(pendantCard.body, {
        label: '吊坠大小',
        ariaLabel: '吊坠大小',
        min: Math.round(PENDANT_SCALE_MIN * 100),
        max: Math.round(PENDANT_SCALE_MAX * 100),
        step: 5,
        value: Math.round(settings.pendantScale * 100),
        withStepButtons: true,
        formatValue: (v) => `${v}%`,
        onInput: commitPendantScale,
        onStep: (dir) => commitPendantScale(Math.round(settings.pendantScale * 100) + dir * 10),
      });

      const commitPendantRope = (px: number) => {
        const n = clampPendantRope(Math.round(px / 5) * 5);
        refs.pendantRope?.setDisplay(n);
        update({ pendantRopeLength: n });
      };
      refs.pendantRope = createSliderRow(pendantCard.body, {
        label: '连接线长度',
        ariaLabel: '连接线长度',
        min: PENDANT_ROPE_MIN,
        max: PENDANT_ROPE_MAX,
        step: 5,
        value: settings.pendantRopeLength,
        withStepButtons: true,
        formatValue: (v) => `${v}px`,
        onInput: commitPendantRope,
        onStep: (dir) => commitPendantRope(settings.pendantRopeLength + dir * 10),
      });
      syncPendantRows();
    }

    // 卡片 3：快捷与系统
    const sysCard = createCard(group, {
      title: '快捷与系统',
      desc: '全局快捷键、启动项与帧率控制',
    });
    let gameModeInput: HTMLInputElement | null = null;
    if (platform === 'tauri') {
      const syncSysBadge = () => {
        if (gameModeEnabled) sysCard.setBadge('游戏模式中', 'warning');
        else if (settings.pinballMode) sysCard.setBadge('弹球模式中', 'accent');
        else sysCard.setBadge('', 'neutral');
      };
      const syncGameModeCard = (enabled: boolean) => {
        if (gameModeInput) gameModeInput.checked = enabled;
        syncSysBadge();
      };
      refs.syncGameMode = syncGameModeCard;
      refs.syncPinballMode = syncSysBadge;
      gameModeInput = createSwitchRow(
        sysCard.body,
        '游戏模式',
        '开启后桌宠与聊天完全穿透且自动收起聊天窗，避免打游戏时误点抢焦点',
        () => gameModeEnabled,
        (v) => {
          const opEpoch = ++gameModeEpoch;
          const prev = gameModeEnabled;
          applyGameModeState(v);
          void import('@tauri-apps/api/core')
            .then((m) => m.invoke('set_game_mode_enabled', { enabled: v }))
            .then(() => {
              if (gameModeEpoch === opEpoch) applyGameModeState(v);
              if (gameModeEnabled === v) showToast(v ? '已开启游戏模式' : '已退出游戏模式');
            })
            .catch(() => {
              if (gameModeEpoch === opEpoch) applyGameModeState(prev);
              showToast('切换游戏模式失败', { kind: 'error' });
            });
        }
      ).input;
      syncGameModeCard(gameModeEnabled);
      const initEpoch = gameModeEpoch;
      void import('@tauri-apps/api/core')
        .then((m) => m.invoke<boolean>('get_game_mode'))
        .then((enabled) => {
          if (gameModeEpoch !== initEpoch) return;
          applyGameModeState(Boolean(enabled));
        })
        .catch(() => {});
      gameModeHotkeyRow(sysCard.body);
      refs.pinballMode = createSwitchRow(
        sysCard.body,
        '弹球模式',
        '开启后拖动人物用力甩出时，会在屏幕四壁间像弹球一样碰撞弹跳；保持原大小直立，随时可抓起或按快捷键切换',
        () => settings.pinballMode,
        (v) => {
          update({ pinballMode: v });
          syncSysBadge();
          showToast(v ? '已开启弹球模式' : '已关闭弹球模式');
        }
      ).input;
      pinballModeHotkeyRow(sysCard.body);
      syncSysBadge();
    }
    refs.autoStart = createSwitchRow(
      sysCard.body,
      '开机自启',
      'Windows 登录后自动启动',
      () => false,
      (v) => {
        // 设置失败时回读系统真实状态，避免开关停在未生效的位置。
        void setAutoStart(v).then(async (ok) => {
          if (!ok) {
            if (refs.autoStart) refs.autoStart.checked = (await isAutoStart()) === true;
            showToast('设置开机自启失败，请检查系统权限', { kind: 'error' });
          }
        });
      }
    ).input;
    isAutoStart().then((v) => {
      if (refs.autoStart) refs.autoStart.checked = v === true;
    });
    refs.batterySaver = addBatterySaverSwitch(sysCard.body);
  }
}

// ---------- 4. 聊天模块（账号与会话 / 显示偏好 / Android 聊天背景） ----------

let agentControls!: AgentControlHandle;

{
  const { group } = panels.get('chat')!;

  // 卡片 1：账号与会话
  const accountCard = createCard(group, {
    title: '账号与会话',
    desc: '连接状态、当前会话与高级配置',
    badge: { text: '未连接', tone: 'neutral' },
  });

  const statusRow = document.createElement('div');
  statusRow.className = 'row';
  const statusLab = document.createElement('div');
  statusLab.className = 'label';
  statusLab.textContent = 'Misskey 连接';
  const statusSub = document.createElement('span');
  statusSub.className = 'sub';
  statusLab.appendChild(statusSub);
  const logoutBtn = document.createElement('button');
  logoutBtn.type = 'button';
  logoutBtn.className = 'act';
  logoutBtn.textContent = '退出登录';
  statusRow.append(statusLab, logoutBtn);
  accountCard.body.appendChild(statusRow);

  const sessionRow = document.createElement('div');
  sessionRow.className = 'row session-row';
  const sessionLab = document.createElement('div');
  sessionLab.className = 'label';
  sessionLab.textContent = '当前会话';
  const sessionSub = document.createElement('span');
  sessionSub.className = 'sub';
  sessionLab.appendChild(sessionSub);

  const sessionControls = document.createElement('div');
  sessionControls.className = 'session-controls';
  sessionControls.hidden = true;
  const sessionSelect = document.createElement('select');
  sessionSelect.className = 'session-select';
  sessionSelect.setAttribute('aria-label', '选择当前会话');
  const renameSessionBtn = document.createElement('button');
  renameSessionBtn.type = 'button';
  renameSessionBtn.className = 'act';
  renameSessionBtn.textContent = '重命名';
  const refreshSessionsBtn = document.createElement('button');
  refreshSessionsBtn.type = 'button';
  refreshSessionsBtn.className = 'act';
  refreshSessionsBtn.textContent = '刷新';
  const createSessionBtn = document.createElement('button');
  createSessionBtn.type = 'button';
  createSessionBtn.className = 'act';
  createSessionBtn.textContent = '新建会话';
  sessionControls.append(sessionSelect, renameSessionBtn, refreshSessionsBtn, createSessionBtn);

  const renameRow = document.createElement('form');
  renameRow.className = 'session-rename-row';
  renameRow.hidden = true;
  const renameInput = document.createElement('input');
  renameInput.type = 'text';
  renameInput.className = 'session-rename-input';
  renameInput.maxLength = 80;
  renameInput.placeholder = '输入新的会话名称';
  renameInput.setAttribute('aria-label', '新的会话名称');
  const renameSaveBtn = document.createElement('button');
  renameSaveBtn.type = 'submit';
  renameSaveBtn.className = 'act';
  renameSaveBtn.textContent = '保存';
  const renameCancelBtn = document.createElement('button');
  renameCancelBtn.type = 'button';
  renameCancelBtn.className = 'act';
  renameCancelBtn.textContent = '取消';
  renameRow.append(renameInput, renameSaveBtn, renameCancelBtn);

  sessionRow.append(sessionLab, sessionControls, renameRow);
  accountCard.body.appendChild(sessionRow);

  type SavedSessionMeta = {
    id?: string;
    name?: string;
    characterId?: string;
    characterName?: string;
  };
  let cachedSessionKey = '';
  let sessionList: MskSession[] = [];
  let loadingSessions = false;
  let creatingSession = false;
  let renamingSession = false;
  let renameOpen = false;
  let renameTargetId = '';
  let sessionFetchError = false;
  let sessionFetchAbort: AbortController | null = null;
  let sessionFetchEpoch = 0;
  let lastSessionFetchAt = 0;

  const readAuthAndSession = (): {
    token: string;
    user: { id?: string; username?: string; name?: string } | null;
    saved: SavedSessionMeta | null;
  } => {
    let token = '';
    let user: { id?: string; username?: string; name?: string } | null = null;
    let saved: SavedSessionMeta | null = null;
    try {
      token = localStorage.getItem(MSK_TOKEN_KEY) ?? '';
      user = JSON.parse(localStorage.getItem(MSK_USER_KEY) ?? 'null');
      if (user?.id) {
        saved = JSON.parse(localStorage.getItem(mskSessionKey(user.id)) ?? 'null') as SavedSessionMeta | null;
      }
    } catch {
      // 存储不可用时按未连接显示
    }
    return { token, user, saved };
  };

  const persistSelectedSession = (userId: string, session: MskSession): string => {
    const displayName = session.name || session.characterName || 'Aliya';
    try {
      localStorage.setItem(
        mskSessionKey(userId),
        JSON.stringify({
          id: session.id,
          name: displayName,
          characterId: session.characterId,
          characterName: session.characterName || 'Aliya',
        })
      );
    } catch {
      // 存储受限时保留内存状态
    }
    return displayName;
  };

  const closeRenameRow = () => {
    renameOpen = false;
    renameTargetId = '';
    renameRow.hidden = true;
    renameInput.value = '';
  };

  const renderSessionSelect = (saved: SavedSessionMeta | null, connected: boolean) => {
    sessionSelect.replaceChildren();
    if (!connected) {
      sessionSelect.disabled = true;
      return;
    }
    const sorted = [...sessionList].sort((a, b) =>
      (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '')
    );
    const savedId = typeof saved?.id === 'string' ? saved.id : '';
    const hasSavedInList = Boolean(savedId && sorted.some((s) => s.id === savedId));

    if (!sorted.length) {
      if (savedId) {
        const opt = document.createElement('option');
        opt.value = savedId;
        opt.textContent = saved?.name || 'Aliya';
        sessionSelect.appendChild(opt);
        sessionSelect.value = savedId;
        sessionSelect.disabled = creatingSession || renamingSession;
      } else {
        const opt = document.createElement('option');
        opt.value = '';
        opt.disabled = true;
        opt.selected = true;
        opt.textContent = loadingSessions ? '正在读取会话…' : sessionFetchError ? '读取失败，请点刷新' : '暂无会话（可点击新建）';
        sessionSelect.appendChild(opt);
        sessionSelect.disabled = true;
      }
      return;
    }

    if (!hasSavedInList) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.disabled = true;
      placeholder.selected = true;
      placeholder.textContent = savedId
        ? `${saved?.name || '原会话'}（已失效，请重选）`
        : '请选择会话…';
      sessionSelect.appendChild(placeholder);
    }

    for (const s of sorted) {
      const opt = document.createElement('option');
      opt.value = s.id;
      const title = s.name || s.characterName || 'Aliya';
      opt.textContent = s.hasUnread ? `${title} · 未读` : title;
      sessionSelect.appendChild(opt);
    }
    if (hasSavedInList) sessionSelect.value = savedId;
    sessionSelect.disabled = creatingSession || renamingSession;
  };

  const refreshChatInfo = () => {
    const { token, user, saved } = readAuthAndSession();
    const name = user?.name || user?.username || '';
    const connected = Boolean(token && user?.id && name);
    const key = connected ? `${token}:${user!.id}` : '';
    if (key !== cachedSessionKey) {
      sessionFetchAbort?.abort();
      sessionFetchAbort = null;
      sessionFetchEpoch++;
      cachedSessionKey = key;
      sessionList = [];
      loadingSessions = false;
      sessionFetchError = false;
      lastSessionFetchAt = 0;
      closeRenameRow();
    }

    const activeId = typeof saved?.id === 'string' ? saved.id : '';
    const canRename = connected && Boolean(activeId) && !creatingSession && !renamingSession;
    if (renameOpen && (!connected || !activeId || (renameTargetId && renameTargetId !== activeId))) {
      closeRenameRow();
    }

    statusSub.textContent = connected ? `已连接：${name}` : '未连接（在聊天窗口中授权）';
    logoutBtn.hidden = !token;
    accountCard.setBadge(connected ? '已连接' : '未连接', connected ? 'success' : 'neutral');
    sessionControls.hidden = !connected;
    renameSessionBtn.disabled = !canRename;
    refreshSessionsBtn.disabled = !connected || loadingSessions || creatingSession || renamingSession;
    createSessionBtn.disabled = !connected || creatingSession || renamingSession;
    renameInput.disabled = renamingSession;
    renameSaveBtn.disabled = renamingSession;
    renameCancelBtn.disabled = renamingSession;

    const sessionName = typeof saved?.name === 'string' ? saved.name : '';
    if (!connected) {
      sessionSub.textContent = token ? '用户信息缺失，请重新授权' : '—';
    } else if (loadingSessions && !sessionList.length) {
      sessionSub.textContent = sessionName ? `${sessionName}（同步列表中…）` : '正在读取会话…';
    } else if (sessionFetchError && !sessionList.length) {
      sessionSub.textContent = sessionName ? `${sessionName}（列表读取失败，可点刷新）` : '列表读取失败，请点击刷新';
    } else {
      sessionSub.textContent = sessionName || '未选择';
    }
    renderSessionSelect(saved, connected);
    agentControls?.sync();
  };

  const fetchSessions = async (force = false) => {
    const { token, user } = readAuthAndSession();
    const userId = user?.id;
    const name = user?.name || user?.username || '';
    if (!token || !userId || !name) return;
    const key = `${token}:${userId}`;
    if (!force && key === cachedSessionKey && (loadingSessions || (lastSessionFetchAt > 0 && Date.now() - lastSessionFetchAt < 15_000))) {
      return;
    }
    sessionFetchAbort?.abort();
    const controller = new AbortController();
    sessionFetchAbort = controller;
    const epoch = ++sessionFetchEpoch;
    cachedSessionKey = key;
    loadingSessions = true;
    sessionFetchError = false;
    refreshChatInfo();
    try {
      const list = await new MskClient(token).listAliyaSessions(controller.signal);
      if (epoch !== sessionFetchEpoch || controller.signal.aborted) return;
      sessionList = list;
      lastSessionFetchAt = Date.now();
      sessionFetchError = false;
    } catch (e) {
      if (epoch !== sessionFetchEpoch || controller.signal.aborted) return;
      sessionFetchError = true;
      if (force) {
        showToast(e instanceof Error && e.message ? e.message : '读取会话列表失败', { kind: 'error' });
      }
    } finally {
      if (epoch === sessionFetchEpoch) {
        loadingSessions = false;
        if (sessionFetchAbort === controller) sessionFetchAbort = null;
        refreshChatInfo();
      }
    }
  };

  refs.chatEnter = () => {
    refreshChatInfo();
    void fetchSessions(false);
  };

  sessionSelect.addEventListener('change', () => {
    const id = sessionSelect.value;
    const { user } = readAuthAndSession();
    const chosen = sessionList.find((s) => s.id === id);
    if (!chosen || !user?.id) return;
    closeRenameRow();
    const displayName = persistSelectedSession(user.id, chosen);
    refreshChatInfo();
    showToast(`已切换会话：${displayName}`, { kind: 'success' });
  });

  renameSessionBtn.addEventListener('click', () => {
    if (renamingSession || creatingSession) return;
    const { saved } = readAuthAndSession();
    const targetId = typeof saved?.id === 'string' ? saved.id : '';
    if (!targetId) return;
    if (renameOpen) {
      closeRenameRow();
      return;
    }
    const existing = sessionList.find((s) => s.id === targetId);
    const currentName = existing?.name || saved?.name || existing?.characterName || 'Aliya';
    renameOpen = true;
    renameTargetId = targetId;
    renameRow.hidden = false;
    renameInput.value = currentName;
    renameInput.focus();
    renameInput.select();
  });

  renameCancelBtn.addEventListener('click', () => {
    if (!renamingSession) closeRenameRow();
  });

  renameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      if (!renamingSession) closeRenameRow();
    }
  });

  renameRow.addEventListener('submit', (e) => {
    e.preventDefault();
    if (renamingSession) return;
    const { token, user, saved } = readAuthAndSession();
    const targetId = renameTargetId || (typeof saved?.id === 'string' ? saved.id : '');
    if (!token || !user?.id || !targetId) return;
    const trimmed = renameInput.value.trim();
    if (!trimmed) {
      renameInput.focus();
      showToast('请输入会话名称。', { kind: 'error' });
      return;
    }
    const existing = sessionList.find((s) => s.id === targetId);
    const currentName = existing?.name || saved?.name || '';
    if (trimmed === currentName) {
      closeRenameRow();
      return;
    }
    renamingSession = true;
    renameSaveBtn.textContent = '保存中…';
    refreshChatInfo();
    void new MskClient(token)
      .renameSession(targetId, trimmed)
      .then((updatedName) => {
        const latest = readAuthAndSession();
        if (latest.token !== token || latest.user?.id !== user.id) return;
        const idx = sessionList.findIndex((s) => s.id === targetId);
        const updatedSession: MskSession = idx >= 0
          ? { ...sessionList[idx], name: updatedName }
          : {
              id: targetId,
              name: updatedName,
              characterId: typeof saved?.characterId === 'string' ? saved.characterId : '',
              characterName: typeof saved?.characterName === 'string' ? saved.characterName : 'Aliya',
            };
        if (idx >= 0) sessionList[idx] = updatedSession;
        if (latest.saved?.id === targetId) {
          persistSelectedSession(user.id, updatedSession);
        }
        closeRenameRow();
        showToast(`已重命名为：${updatedName}`, { kind: 'success' });
      })
      .catch((err) => {
        showToast(err instanceof Error && err.message ? err.message : '重命名会话失败', { kind: 'error' });
      })
      .finally(() => {
        renamingSession = false;
        renameSaveBtn.textContent = '保存';
        refreshChatInfo();
      });
  });

  refreshSessionsBtn.addEventListener('click', () => {
    void fetchSessions(true);
  });

  createSessionBtn.addEventListener('click', () => {
    const { token, user } = readAuthAndSession();
    if (!token || !user?.id || creatingSession) return;
    creatingSession = true;
    createSessionBtn.textContent = '创建中…';
    refreshChatInfo();
    void new MskClient(token)
      .createSession()
      .then((created) => {
        const latest = readAuthAndSession();
        if (latest.token !== token || latest.user?.id !== user.id) return;
        sessionList = [created, ...sessionList.filter((s) => s.id !== created.id)];
        cachedSessionKey = `${token}:${user.id}`;
        lastSessionFetchAt = Date.now();
        sessionFetchError = false;
        const displayName = persistSelectedSession(user.id, created);
        showToast(`已新建并切换到会话：${displayName}`, { kind: 'success' });
      })
      .catch((e) => {
        showToast(e instanceof Error && e.message ? e.message : '新建会话失败', { kind: 'error' });
      })
      .finally(() => {
        creatingSession = false;
        createSessionBtn.textContent = '新建会话';
        refreshChatInfo();
      });
  });

  armTwoStepButton(logoutBtn, '再点一次确认', () => {
    sessionFetchAbort?.abort();
    sessionFetchAbort = null;
    sessionFetchEpoch++;
    cachedSessionKey = '';
    sessionList = [];
    loadingSessions = false;
    sessionFetchError = false;
    lastSessionFetchAt = 0;
    closeRenameRow();
    try {
      localStorage.removeItem(MSK_TOKEN_KEY);
      localStorage.removeItem(MSK_USER_KEY);
    } catch {
      // 存储不可用时本就没有持久登录
    }
    agentControls.close();
    refreshChatInfo();
    showToast('已退出登录。', { kind: 'success' });
  });

  refreshChatInfo();
  window.addEventListener('focus', () => {
    refreshChatInfo();
    if (activeTab === 'chat') void fetchSessions(false);
  });
  window.addEventListener('storage', () => {
    refreshChatInfo();
    if (activeTab === 'chat') void fetchSessions(false);
  });

  const openRecords = async () => {
    if (platform === 'tauri') {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('show_records');
    } else if (platform === 'android') {
      shellAction('open-records');
    } else {
      window.location.assign('/chat.html');
    }
  };
  if (platform === 'android') {
    createWideAction(accountCard.body, '打开聊天', () => shellAction('open-chat'));
  }
  agentControls = mountAgentControls(accountCard.body, openRecords, refreshChatInfo);

  // 卡片 2：显示偏好
  const prefCard = createCard(group, {
    title: '显示偏好',
    desc: '控制聊天回复与记录中的附加内容',
  });
  refs.showGeneratedImages = createSwitchRow(
    prefCard.body,
    '显示生成配图',
    '显示回复和记录中的配图及生成按钮；更改后对新回复、重新播放或重新打开的记录生效，不影响表情包和用户附图',
    () => settings.showGeneratedImages,
    (v) => update({ showGeneratedImages: v })
  ).input;
  refs.showGeneratedImages.setAttribute('aria-label', '显示生成配图');

  // 卡片 3：聊天背景（全端通用：Android 主界面/记录页、Windows 对话面板/记录窗、Web 舞台/记录页）
  {
    const bgDesc =
      platform === 'android'
        ? '主界面与记录页内置场景、插画、自定义图及暗化强度'
        : platform === 'tauri'
          ? '对话面板与记录窗口内置场景、插画、自定义图及暗化强度'
          : '舞台与记录页内置场景、插画、自定义图及暗化强度';
    const bgCard = createCard(group, {
      title: '聊天背景',
      desc: bgDesc,
    });
    const groupsWrap = document.createElement('div');
    groupsWrap.setAttribute('role', 'radiogroup');
    groupsWrap.setAttribute('aria-label', '聊天背景');
    bgCard.body.appendChild(groupsWrap);

    const addSectionGrid = (heading: string, extraClass = '') => {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = heading;
      const grid = document.createElement('div');
      grid.className = `bg-grid ${extraClass}`.trim();
      groupsWrap.append(hint, grid);
      return grid;
    };

    const baseGrid = addSectionGrid('模式与自定义', 'bg-grid-base');
    const autoNote = document.createElement('p');
    autoNote.className = 'bg-auto-note';
    autoNote.hidden = true;
    groupsWrap.appendChild(autoNote);

    const actions = document.createElement('div');
    actions.className = 'bg-actions';
    groupsWrap.appendChild(actions);

    const animatedGrid = addSectionGrid('动态场景', 'bg-grid-animated');
    const illusGrid = addSectionGrid('主题插画', 'bg-grid-illus');

    const status = document.createElement('p');
    status.className = 'hint bg-status';
    status.setAttribute('role', 'status');

    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/*';
    picker.hidden = true;
    bgCard.body.appendChild(picker);

    let customUrl: string | null = null;
    let hasCustom = false;
    let lastAutoSceneId = '';
    const tiles = new Map<string, HTMLButtonElement>();

    const sceneThumbnail = (scene: ChatScene): HTMLElement => {
      if (scene.kind === 'illustration' && scene.imageUrl) {
        const img = document.createElement('img');
        img.className = 'bg-thumb-img';
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = scene.imageUrl;
        if (scene.focusPosition) img.style.objectPosition = scene.focusPosition;
        return img;
      }
      return scene.build();
    };

    const tile = (
      targetGrid: HTMLElement,
      id: string,
      name: string,
      preview: HTMLElement | null,
      extraClass = ''
    ) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `bg-tile ${extraClass}`.trim();
      b.setAttribute('role', 'radio');
      const thumb = document.createElement('span');
      thumb.className = 'bg-thumb';
      if (preview) thumb.append(preview);
      const label = document.createElement('span');
      label.className = 'bg-name';
      label.textContent = name;
      b.append(thumb, label);
      targetGrid.appendChild(b);
      tiles.set(id, b);
      return b;
    };

    const replace = document.createElement('button');
    replace.type = 'button';
    replace.className = 'act';
    replace.textContent = '更换自定义图';
    replace.addEventListener('click', () => picker.click());
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'act';
    remove.textContent = '删除自定义图';

    let dimHandle!: SliderRowHandle;
    const sync = () => {
      const autoMatch = resolveAutoScene();
      const autoTile = tiles.get(AUTO_BACKGROUND);
      if (autoTile) {
        const autoThumb = autoTile.querySelector<HTMLElement>('.bg-thumb')!;
        autoThumb.dataset.autoBadge = autoMatch.periodName;
        if (autoMatch.scene.id !== lastAutoSceneId) {
          lastAutoSceneId = autoMatch.scene.id;
          autoThumb.replaceChildren(sceneThumbnail(autoMatch.scene));
        }
      }
      const isAuto = settings.chatBackground === AUTO_BACKGROUND;
      autoNote.hidden = !isAuto;
      if (isAuto) {
        autoNote.textContent = `当前时段为「${autoMatch.periodName}」，已匹配「${autoMatch.scene.name}」（清晨·轨道晨晓 / 昼间·深空培育室 / 黄昏·永恒黄昏 / 夜航·星舰观测室 / 深夜·星海月湾）`;
      }

      for (const [id, b] of tiles) {
        const on = settings.chatBackground === id;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
        b.querySelector('.bg-scene')?.classList.toggle('still', !on);
      }
      const custom = tiles.get(CUSTOM_BACKGROUND)!;
      const thumb = custom.querySelector<HTMLElement>('.bg-thumb')!;
      thumb.style.backgroundImage = customUrl ? `url("${customUrl}")` : '';
      custom.classList.toggle('empty', !hasCustom);
      custom.querySelector('.bg-name')!.textContent = hasCustom ? '自定义' : '上传图片';
      actions.hidden = !hasCustom;
      setRowInactive(dimHandle.row, settings.chatBackground === NO_BACKGROUND);
    };
    refs.chatBgSync = sync;

    tile(baseGrid, NO_BACKGROUND, '无背景', null, 'plain').addEventListener('click', () => {
      update({ chatBackground: NO_BACKGROUND });
      sync();
    });
    tile(baseGrid, AUTO_BACKGROUND, '随时间流转', null, 'auto').addEventListener('click', () => {
      update({ chatBackground: AUTO_BACKGROUND });
      sync();
    });
    tile(baseGrid, CUSTOM_BACKGROUND, '上传图片', null, 'custom').addEventListener('click', () => {
      if (hasCustom) {
        update({ chatBackground: CUSTOM_BACKGROUND });
        sync();
      } else {
        picker.click();
      }
    });

    for (const p of CHAT_SCENES) {
      const targetGrid = p.kind === 'illustration' ? illusGrid : animatedGrid;
      tile(targetGrid, p.id, p.name, sceneThumbnail(p)).addEventListener('click', () => {
        update({ chatBackground: p.id });
        sync();
      });
    }

    armTwoStepButton(remove, '再点一次删除', () => {
      void (async () => {
        try {
          await deleteCustomBackground();
        } catch {
          /* 已不存在 */
        }
        hasCustom = false;
        if (customUrl) URL.revokeObjectURL(customUrl);
        customUrl = null;
        update({
          chatBackground:
            settings.chatBackground === CUSTOM_BACKGROUND ? NO_BACKGROUND : settings.chatBackground,
          chatBackgroundRev: (settings.chatBackgroundRev ?? 0) + 1,
        });
        status.textContent = '';
        sync();
        showToast('已删除自定义背景');
      })();
    });
    actions.append(replace, remove);

    picker.addEventListener('change', async () => {
      const file = picker.files?.[0];
      picker.value = '';
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        showToast('请选择图片文件', { kind: 'error' });
        return;
      }
      status.textContent = '正在处理图片…';
      bgCard.body.appendChild(status);
      try {
        const saved = await saveCustomBackground(file);
        if (customUrl) URL.revokeObjectURL(customUrl);
        customUrl = URL.createObjectURL(saved);
        hasCustom = true;
        update({
          chatBackground: CUSTOM_BACKGROUND,
          chatBackgroundRev: (settings.chatBackgroundRev ?? 0) + 1,
        });
        status.textContent = '';
        status.remove();
        showToast('已应用自定义背景', { kind: 'success' });
      } catch (e) {
        status.remove();
        showToast(e instanceof Error && e.message ? e.message : '图片保存失败，请重试', {
          kind: 'error',
        });
      }
      sync();
    });

    dimHandle = createSliderRow(bgCard.body, {
      label: '背景暗化',
      ariaLabel: '背景暗化',
      min: 0,
      max: 80,
      step: 5,
      value: Math.round(settings.chatBackgroundDim * 100),
      withStepButtons: false,
      onInput: (v) => update({ chatBackgroundDim: v / 100 }),
    });
    refs.chatBgDim = dimHandle;

    sync();
    window.addEventListener('focus', sync);
    void loadCustomBackground().then((blob) => {
      if (!blob) return;
      hasCustom = true;
      customUrl = URL.createObjectURL(blob);
      sync();
    });
  }
}

// ---------- 5. 关于模块（应用信息 / 更新与链接） ----------

{
  const { group } = panels.get('about')!;

  // 卡片 1：应用信息
  const infoCard = createCard(group);
  const div = document.createElement('div');
  div.className = 'about';
  const aboutHead = document.createElement('div');
  aboutHead.className = 'about-head';
  const brand = document.createElement('b');
  brand.textContent = 'Aliya Pet';
  const meta = document.createElement('span');
  meta.className = 'about-meta';
  meta.textContent = `v${__APP_VERSION__} · ${platform === 'android' ? 'Android' : 'Windows'}`;
  aboutHead.append(brand, meta);
  const copy = document.createElement('p');
  copy.className = 'about-copy';
  copy.innerHTML =
    '本程序为二创桌宠，人物原创为《彼方的她》。<br>Live2D Cubism SDK for Web © Live2D Inc.';
  div.append(aboutHead, copy);
  infoCard.body.appendChild(div);

  // 卡片 2：更新与链接
  const updateCard = createCard(group, {
    title: '更新与链接',
    desc: '检查新版本或前往官方发布页',
  });
  const checkRow = document.createElement('div');
  checkRow.className = 'row';
  const checkLab = document.createElement('div');
  checkLab.className = 'label';
  checkLab.textContent = '软件更新';
  const checkBtn = document.createElement('button');
  checkBtn.className = 'act';
  checkBtn.type = 'button';
  checkBtn.textContent = '检查更新';
  checkBtn.addEventListener('click', async () => {
    if (checkBtn.disabled) return;
    checkBtn.disabled = true;
    checkBtn.textContent = '正在检查…';
    try {
      const result = await checkForUpdate(
        platform === 'android' ? 'android' : 'windows',
        __APP_VERSION__
      );
      if (result.updateAvailable) {
        showToast(`发现新版本 v${result.latest}`);
        if (platform === 'tauri') {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('show_update', { payload: result });
        } else {
          openUpdateModal(result);
        }
      } else {
        showToast(`已是最新版本 v${result.latest}`, { kind: 'success' });
      }
    } catch {
      showToast('检查更新失败，请稍后重试', { kind: 'error' });
    } finally {
      checkBtn.disabled = false;
      checkBtn.textContent = '检查更新';
    }
  });
  checkRow.append(checkLab, checkBtn);
  updateCard.body.appendChild(checkRow);

  createWideAction(updateCard.body, '打开官网', () => openUrl(OFFICIAL_SITE_URL));
}

// ---------- 外部路由与跨窗口状态同步 ----------

const openTarget = (target: string) => {
  if (!isExplicitOpenTarget(target)) {
    agentControls.close();
    return;
  }
  const plan = resolveOpenTarget(target);
  selectTab(plan.tab, { animate: true });
  if (plan.openSessionControl) {
    requestAnimationFrame(() => agentControls.open());
    return;
  }
  agentControls.close();
};

const initialTab = (() => {
  try {
    const saved = localStorage.getItem(SETTINGS_LAST_TAB_KEY);
    return isValidSettingsTab(saved) ? saved : DEFAULT_SETTINGS_TAB;
  } catch {
    return DEFAULT_SETTINGS_TAB;
  }
})();
selectTab(initialTab, { animate: platform !== 'tauri', persist: false });

if (platform === 'tauri') {
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen<{ target?: string }>('settings-open', (event) =>
      openTarget(event.payload?.target ?? '')
    );
    await listen<{ enabled?: boolean }>('game-mode-changed', (event) => {
      gameModeEpoch += 1;
      applyGameModeState(Boolean(event.payload?.enabled));
    });
  } catch {
    /* Browser preview has no Tauri event bus. */
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.isComposing && !hotkeyRecordingActive && !document.querySelector('dialog[open]')) {
      void import('@tauri-apps/api/window').then((m) => m.getCurrentWindow().hide()).catch(() => {});
    }
  });
}
window.addEventListener('hashchange', () => openTarget(location.hash.slice(1)));
if (location.hash) openTarget(location.hash.slice(1));

// 托盘改动经 pet 窗口广播 → 刷新控件
onSettingsChanged('settings-changed', () => {
  settings = loadSettings();
  refreshControls();
});

// pet 窗口状态变化（petAI/设置）→ 刷新状态高亮
onStateChanged((s) => {
  manualState = s.manual ?? '';
  refreshStateHighlight();
});

// 桌宠页把状态存进共享 localStorage：打开本页即按存档高亮；Android 跨 WebView 无事件总线，
// 另在回到本页/收到 storage 事件时刷新
{
  const readState = () => {
    try {
      const s = JSON.parse(localStorage.getItem('aliya_pet_state') ?? 'null') as PetStatePayload | null;
      if (s && typeof s.state === 'string') {
        manualState = s.manual ?? '';
        refreshStateHighlight();
      }
    } catch {
      // 存储不可用或内容损坏则保持当前高亮
    }
  };
  window.addEventListener('focus', readState);
  window.addEventListener('storage', (e) => {
    if (e.key === 'aliya_pet_state') readState();
  });
  readState();
}
