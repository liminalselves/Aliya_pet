/**
 * 设置窗口页面（独立 webview）：
 * 改动 → 写 localStorage + emitTo('pet', 'settings-changed') 实时生效；
 * 动作/台词按钮 → emitTo('pet', 'tray-action') 触发 pet 窗口行为；
 * 监听 'settings-changed'（托盘改动经 pet 广播）刷新控件。
 */

import {
  PetSettings,
  BASE_WINDOW_W,
  BASE_WINDOW_H,
  clampScale,
  loadSettings,
  saveSettings,
} from './settings';
import {
  platform,
  androidShell,
  isAutoStart,
  setAutoStart,
  openUrl,
  shellAction,
} from './platform';
import { ACTION_LIBRARY } from './behavior';

// 平台样式钩子（移动端大字/大行距/顶栏，见 settings.html）
document.body.classList.add(`platform-${platform}`);

const ACTION_LABELS: Record<string, string> = {
  nod: '点头',
  sway: '摇摆',
  shake: '摇头',
  stretch: '伸展',
  wave: '挥手',
  doubt: '疑惑',
  angry: '生气',
  yawn: '哈欠',
  walk: '走动',
};

type Emit = (event: string, payload: unknown) => void;
type Listen = (event: string, cb: () => void) => void;

let emitToPet: Emit = () => {};
let emitToSettings: Emit = () => {};
let onSettingsChanged: Listen = () => {};
let invokeCmd: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) =
  () => Promise.resolve(null);

// Tauri 环境探测（浏览器 dev 下降级为纯本地预览）
try {
  const ev = await import('@tauri-apps/api/event');
  const { invoke } = await import('@tauri-apps/api/core');
  emitToPet = (event, payload) => {
    ev.emitTo('pet', event, payload).catch(() => {});
  };
  emitToSettings = (event, payload) => {
    ev.emitTo('settings', event, payload).catch(() => {});
  };
  onSettingsChanged = (event, cb) => {
    ev.listen(event, cb).catch(() => {});
  };
  invokeCmd = (cmd, args): Promise<unknown> =>
    invoke<unknown>(cmd, args).catch((): unknown => null);
} catch {
  // 纯浏览器：无跨窗口同步
}

let settings: PetSettings = loadSettings();

function update(patch: Partial<PetSettings>): void {
  settings = { ...settings, ...patch };
  saveSettings(settings);
  emitToPet('settings-changed', settings);
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
}

// ---------- UI 构建 ----------

const app = document.getElementById('app')!;

// 移动端顶栏：返回（回桌宠页）+ 标题；桌面端是独立窗口，有系统标题栏
if (platform === 'android') {
  const bar = document.createElement('div');
  bar.className = 'mobile-topbar';
  const back = document.createElement('button');
  back.className = 'back';
  back.textContent = '‹';
  back.setAttribute('aria-label', '返回');
  back.addEventListener('click', () => shellAction('open-main'));
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = '设置';
  bar.appendChild(back);
  bar.appendChild(title);
  app.insertBefore(bar, app.firstChild);
}

function section(title: string): HTMLElement {
  const h = document.createElement('h2');
  h.textContent = title;
  app.appendChild(h);
  const box = document.createElement('div');
  app.appendChild(box);
  return box;
}

function switchRow(
  parent: HTMLElement,
  label: string,
  sub: string,
  get: () => boolean,
  set: (v: boolean) => void
): HTMLInputElement {
  const row = document.createElement('div');
  row.className = 'row';
  const lab = document.createElement('div');
  lab.className = 'label';
  lab.textContent = label;
  if (sub) {
    const s = document.createElement('span');
    s.className = 'sub';
    s.textContent = sub;
    lab.appendChild(s);
  }
  const sw = document.createElement('label');
  sw.className = 'sw';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = get();
  input.addEventListener('change', () => set(input.checked));
  const knob = document.createElement('i');
  sw.appendChild(input);
  sw.appendChild(knob);
  row.appendChild(lab);
  row.appendChild(sw);
  parent.appendChild(row);
  return input;
}

// 控件引用（外部广播时刷新）
const refs: {
  autoActions?: HTMLInputElement;
  randomSpeech?: HTMLInputElement;
  speechMinutes?: HTMLInputElement;
  mirror?: HTMLInputElement;
  alwaysOnTop?: HTMLInputElement;
  snapEdges?: HTMLInputElement;
  autoStart?: HTMLInputElement;
  batterySaver?: HTMLInputElement;
  overlayOnExit?: HTMLInputElement;
  scaleSlider?: HTMLInputElement;
  scaleVal?: HTMLSpanElement;
} = {};

function refreshControls(): void {
  if (refs.autoActions) refs.autoActions.checked = settings.autoActions;
  if (refs.randomSpeech) refs.randomSpeech.checked = settings.randomSpeech;
  if (refs.speechMinutes)
    refs.speechMinutes.value = String(settings.randomSpeechMinutes);
  if (refs.mirror) refs.mirror.checked = settings.mirror;
  if (refs.alwaysOnTop) refs.alwaysOnTop.checked = settings.alwaysOnTop;
  if (refs.snapEdges) refs.snapEdges.checked = settings.snapEdges;
  if (refs.scaleSlider) refs.scaleSlider.value = String(settings.scale);
  if (refs.scaleVal)
    refs.scaleVal.textContent = `${Math.round(settings.scale * 100)}%`;
  if (refs.batterySaver)
    refs.batterySaver.checked = settings.batterySaver === true;
}

// ---- 互动 ----（动作试放依赖跨窗口事件，Android 单 WebView 下不可用）
if (platform !== 'android') {
  const box = section('互动');
  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const name of ACTION_LIBRARY) {
    const b = document.createElement('button');
    b.className = 'act';
    b.textContent = ACTION_LABELS[name] ?? name;
    b.addEventListener('click', () => trayAction('play-action', { name }));
    grid.appendChild(b);
  }
  box.appendChild(grid);
  const speech = document.createElement('button');
  speech.className = 'act wide';
  speech.textContent = '随机说一句';
  speech.addEventListener('click', () => trayAction('random-speech'));
  box.appendChild(speech);
}

// 省电模式（所有平台；移动端收益最大）
function addBatterySaverSwitch(parent: HTMLElement): HTMLInputElement {
  return switchRow(
    parent,
    '省电模式',
    '帧率上限降为 15fps（屏幕常显的悬浮窗建议开启）',
    () => settings.batterySaver === true,
    (v) => update({ batterySaver: v })
  );
}

// ---- 行为 ----
{
  const box = section('行为');
  refs.autoActions = switchRow(
    box,
    '自动随机动作',
    '角色每隔一段时间自己表演动作',
    () => settings.autoActions,
    (v) => update({ autoActions: v })
  );
  refs.randomSpeech = switchRow(
    box,
    '随机台词',
    '每隔一段时间主动说一句话',
    () => settings.randomSpeech,
    (v) => update({ randomSpeech: v })
  );
  const row = document.createElement('div');
  row.className = 'row';
  const lab = document.createElement('div');
  lab.className = 'label';
  lab.textContent = '台词间隔（分钟）';
  const num = document.createElement('input');
  num.className = 'num';
  num.type = 'number';
  num.min = '1';
  num.max = '120';
  num.value = String(settings.randomSpeechMinutes);
  num.addEventListener('change', () => {
    const v = Math.min(Math.max(Number(num.value) || 5, 1), 120);
    num.value = String(v);
    update({ randomSpeechMinutes: v });
  });
  refs.speechMinutes = num;
  row.appendChild(lab);
  row.appendChild(num);
  box.appendChild(row);
}

// ---- 显示 ----
{
  const box = section('显示');
  const row = document.createElement('div');
  row.className = 'row';
  const lab = document.createElement('div');
  lab.className = 'label';
  lab.textContent = '缩放';
  const wrap = document.createElement('div');
  wrap.className = 'slider-row';
  wrap.style.flex = '1';
  wrap.style.marginLeft = '12px';
  const minus = document.createElement('button');
  minus.textContent = '−';
  const plus = document.createElement('button');
  plus.textContent = '+';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0.15';
  slider.max = '2';
  slider.step = '0.05';
  slider.value = String(settings.scale);
  // 滑块上限按屏幕尺寸收敛（与 pet 窗口的设备钳制一致）
  if (platform === 'android') {
    try {
      const m = JSON.parse(androidShell()?.getMetrics() ?? '') as {
        screenW: number;
        screenH: number;
      };
      if (m.screenW > 0) {
        const maxS = Math.max(
          0.5,
          Math.min(m.screenW / BASE_WINDOW_W, m.screenH / BASE_WINDOW_H)
        );
        slider.max = String(Math.min(2, Math.floor(maxS * 20) / 20));
      }
    } catch {
      // 保持默认上限
    }
  } else
  import('@tauri-apps/api/window')
    .then(async (m) => {
      let mon: import('@tauri-apps/api/window').Monitor | null = null;
      try {
        mon = await m.currentMonitor();
      } catch {
        mon = null;
      }
      if (!mon) return;
      const logW = mon.size.width / mon.scaleFactor;
      const logH = mon.size.height / mon.scaleFactor;
      const maxS = Math.max(
        0.5,
        Math.min(logW / BASE_WINDOW_W, logH / BASE_WINDOW_H)
      );
      slider.max = String(Math.min(2, Math.floor(maxS * 20) / 20));
    })
    .catch(() => {});
  const val = document.createElement('span');
  val.className = 'val';
  val.textContent = `${Math.round(settings.scale * 100)}%`;
  const applyScale = (v: number) => {
    // 加减按钮与滑杆同域：钳到 [min, max]（上限按屏幕尺寸动态收敛过）
    const lo = Number(slider.min);
    const hi = Number(slider.max);
    const s = clampScale(
      Math.min(Math.max(Math.round(v * 100) / 100, lo), hi)
    );
    slider.value = String(s);
    val.textContent = `${Math.round(s * 100)}%`;
    update({ scale: s });
  };
  minus.addEventListener('click', () => applyScale(settings.scale / 1.08));
  plus.addEventListener('click', () => applyScale(settings.scale * 1.08));
  slider.addEventListener('input', () => applyScale(Number(slider.value)));
  refs.scaleSlider = slider;
  refs.scaleVal = val;
  wrap.appendChild(minus);
  wrap.appendChild(slider);
  wrap.appendChild(plus);
  wrap.appendChild(val);
  row.appendChild(lab);
  row.appendChild(wrap);
  box.appendChild(row);

  refs.mirror = switchRow(
    box,
    '镜像显示',
    '左右翻转角色',
    () => settings.mirror,
    (v) => update({ mirror: v })
  );
  refs.batterySaver = addBatterySaverSwitch(box);
}

// ---- 窗口 ----
{
  const box = section(platform === 'android' ? '悬浮窗' : '窗口');
  if (platform !== 'android') {
    refs.alwaysOnTop = switchRow(
      box,
      '置顶显示',
      '让宠物始终显示在其他窗口之上',
      () => settings.alwaysOnTop,
      (v) => update({ alwaysOnTop: v })
    );
  }
  refs.snapEdges = switchRow(
    box,
    '屏幕贴边',
    '拖动后自动吸附屏幕边缘',
    () => settings.snapEdges,
    (v) => update({ snapEdges: v })
  );
  const reset = document.createElement('button');
  reset.className = 'act wide';
  reset.textContent = '位置重置（移回主屏幕中央）';
  reset.addEventListener('click', () => {
    if (platform === 'android') {
      // 贴合模式：petX/petY 是角色原点（非窗口左上角），写屏中心，
      // 悬浮窗下次启动（或服务重建）时在屏幕中央出现
      const shell = androidShell();
      if (shell) {
        try {
          const m = JSON.parse(shell.getMetrics()) as {
            screenW: number;
            screenH: number;
          };
          const x = Math.round(m.screenW / 2);
          const y = Math.round(m.screenH * 0.45);
          settings = { ...settings, posX: x, posY: y };
          saveSettings(settings);
          shell.setPref('petX', String(x));
          shell.setPref('petY', String(y));
        } catch {
          // 忽略
        }
      }
      return;
    }
    trayAction('reset-position');
  });
  box.appendChild(reset);

  refs.autoStart = switchRow(
    box,
    '开机自启',
    platform === 'android'
      ? '设备开机后自动显示悬浮窗'
      : 'Windows 登录后自动启动',
    () => settings.autoActions, // 占位，立即被真实值覆盖
    (v) => {
      setAutoStart(v);
    }
  );
  isAutoStart().then((v) => {
    if (refs.autoStart) refs.autoStart.checked = v === true;
  });

  if (platform === 'android') {
    const shell = androidShell();
    // 悬浮窗权限状态行：MIUI 等 ROM 默认拒绝，未授予时悬浮窗根本无法激活
    const permRow = document.createElement('div');
    permRow.className = 'row';
    const permLab = document.createElement('div');
    permLab.className = 'label';
    permLab.textContent = '悬浮窗权限';
    const permSub = document.createElement('span');
    permSub.className = 'sub';
    permLab.appendChild(permSub);
    const permBtn = document.createElement('button');
    permBtn.className = 'act';
    permBtn.style.flex = '0 0 auto';
    permBtn.style.padding = '8px 18px';
    permBtn.addEventListener('click', () => shellAction('open-overlay-settings'));
    permRow.appendChild(permLab);
    permRow.appendChild(permBtn);
    box.appendChild(permRow);
    const refreshPerm = () => {
      let granted = true;
      try {
        granted = shell?.isOverlayGranted() !== false;
      } catch {
        granted = true;
      }
      permSub.textContent = granted ? '已授予' : '未授予，悬浮窗无法激活';
      permBtn.textContent = granted ? '查看' : '去开启';
    };
    refreshPerm();
    // 从系统授权页返回时刷新状态
    window.addEventListener('focus', refreshPerm);

    refs.overlayOnExit = switchRow(
      box,
      '退出 App 后显示悬浮窗',
      'App 切到后台时，宠物以悬浮窗形式继续待在桌面上',
      () => shell?.getPref('overlayOnExit') !== '0',
      (v) => shell?.setPref('overlayOnExit', v ? '1' : '0')
    );
  }
}

// ---- 关于 ----
{
  const box = section('关于');
  const div = document.createElement('div');
  div.className = 'about';
  div.innerHTML =
    '<b>Aliya Pet</b> v0.1.0（Tauri 重写版）<br>' +
    '本程序为二创桌宠，人物原创为《彼方的她》。<br>' +
    'Live2D Cubism SDK for Web © Live2D Inc.';
  box.appendChild(div);
  const repo = document.createElement('button');
  repo.className = 'act wide';
  repo.textContent = '打开项目仓库';
  repo.addEventListener('click', () => {
    openUrl('https://github.com/w5731/Aliya_pet');
  });
  box.appendChild(repo);
}

// 托盘改动经 pet 窗口广播 → 刷新控件
onSettingsChanged('settings-changed', () => {
  settings = loadSettings();
  refreshControls();
});

// 托盘"关于"入口：滚动到底部的关于区
if (location.hash === '#about') {
  requestAnimationFrame(() => {
    app.scrollTop = app.scrollHeight;
  });
}
