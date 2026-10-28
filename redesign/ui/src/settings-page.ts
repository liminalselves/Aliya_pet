/**
 * 设置窗口页面（独立 webview）：
 * 改动 → 写 localStorage + emitTo('pet', 'settings-changed') 实时生效；
 * 动作/台词/表情/情绪按钮 → emitTo('pet', 'tray-action') 触发 pet 窗口行为；
 * 监听 'settings-changed'（托盘改动经 pet 广播）刷新控件、
 * 'pet-mood'（pet 情绪变化）刷新情绪高亮。
 */

import {
  PetSettings,
  clampScale,
  scaleToPercent,
  percentToScale,
  scaleRangeFor,
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
  notifyPetAction,
} from './platform';
import { ACTION_LIBRARY } from './behavior';
import { MOODS } from './emotion';
import { MSK_TOKEN_KEY, MSK_USER_KEY, mskSessionKey } from './chat/msk/config';
import { mountAgentControls } from './chat/msk/control-drawer';
import { CUSTOM_BACKGROUND, NO_BACKGROUND, PRESET_BACKGROUNDS, deleteCustomBackground, loadCustomBackground, saveCustomBackground } from './chat-background';
import './settings.css';

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
  cheerful_bounce: '开心雀跃',
  shy_sway: '撒娇',
};

/** 表情面板：exp3.json 名 → 中文（与 gen-expressions.py 一一对应）。 */
const EXPRESSION_LABELS: Record<string, string> = {
  happy: '开心',
  angry: '生气',
  sad: '难过',
  surprised: '惊讶',
  shy: '害羞',
  sleepy: '困倦',
  smug: '得意',
  speechless: '无语',
  worried: '担忧',
  serious: '认真',
  hit: '受击',
};

/** 情绪面板：emotion.ts MOODS 键 → 中文。 */
const MOOD_LABELS: Record<string, string> = {
  neutral: '平静',
  happy: '开心',
  cheerful: '愉快',
  angry: '生气',
  sad: '难过',
  shy: '害羞',
  sleepy: '困倦',
  smug: '得意',
  curious: '好奇',
  speechless: '无语',
};

type Emit = (event: string, payload: unknown) => void;
type Listen = (event: string, cb: () => void) => void;

let emitToPet: Emit = () => {};
let emitToSettings: Emit = () => {};
let onSettingsChanged: Listen = () => {};
let onMoodChanged: (cb: (mood: string) => void) => void = () => {};
let invokeCmd: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) =
  () => Promise.resolve(null);

// Only the desktop shell owns the Tauri event bus.
if (platform === 'tauri') try {
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
  onMoodChanged = (cb) => {
    ev
      .listen<{ mood: string }>('pet-mood', (e) => {
        if (e.payload && typeof e.payload.mood === 'string') {
          cb(e.payload.mood);
        }
      })
      .catch(() => {});
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
  // Android：设置页与桌宠页是两个 WebView，经壳桥转发到桌宠页执行
  notifyPetAction({ action, ...extra });
}

/**
 * 表演类操作（动作/台词/表情/情绪）。Windows 设置是独立窗口，桌宠就在旁边，按钮只 pulse 确认；
 * Android 设置页整屏盖住桌宠，发出后先让按钮确认一拍，再滑回主界面让用户看到表演。
 * 桌宠页在设置页下面持续运行，动作在滑出过程中已开始播放。
 */
let returning = 0;
function perform(button: HTMLElement, action: string, extra?: Record<string, unknown>): void {
  trayAction(action, extra);
  pulse(button);
  if (platform !== 'android' || returning) return;
  returning = window.setTimeout(() => { returning = 0; shellAction('open-main'); }, 160);
}

/** 触发类按钮的即时反馈：桌宠在另一个窗口执行，按钮本身短暂确认「已发出」。 */
function pulse(button: HTMLElement): void {
  button.classList.remove('sent');
  void button.offsetWidth;
  button.classList.add('sent');
  window.setTimeout(() => button.classList.remove('sent'), 700);
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
  back.addEventListener('click', () => shellAction('back'));
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
  box.className = 'card';
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
  showGeneratedImages?: HTMLInputElement;
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

// 缩放显示域：设备允许的实际范围 [scaleRangeMin, scaleRangeMax] 线性映射到
// 10%~100%（实际范围由屏幕推导，与 pet 窗口的设备钳制同一公式）。
// 查询显示器前的回退范围即滑条原始静态范围。
let scaleRangeMin = 0.15;
let scaleRangeMax = 2;

function scalePercent(s: number): number {
  return Math.round(scaleToPercent(s, scaleRangeMin, scaleRangeMax));
}

/** 滑块行程填充：显示百分比 10~100 映射到轨道 0%~100%。 */
function paintSliderFill(slider: HTMLInputElement): void {
  const pct = ((Number(slider.value) - Number(slider.min)) /
    (Number(slider.max) - Number(slider.min))) * 100;
  slider.style.setProperty('--fill', `${pct}%`);
}

/** 台词间隔只在随机台词开启时有意义：关闭时整行降透明并禁止交互。 */
let speechRow: HTMLElement | null = null;
function syncSpeechRow(): void {
  speechRow?.classList.toggle('inactive', !settings.randomSpeech);
  speechRow?.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button').forEach(el => { el.tabIndex = settings.randomSpeech ? 0 : -1; });
}

function refreshControls(): void {
  if (refs.autoActions) refs.autoActions.checked = settings.autoActions;
  if (refs.randomSpeech) refs.randomSpeech.checked = settings.randomSpeech;
  if (refs.showGeneratedImages) refs.showGeneratedImages.checked = settings.showGeneratedImages;
  if (refs.speechMinutes)
    refs.speechMinutes.value = String(settings.randomSpeechMinutes);
  syncSpeechRow();
  if (refs.mirror) refs.mirror.checked = settings.mirror;
  if (refs.alwaysOnTop) refs.alwaysOnTop.checked = settings.alwaysOnTop;
  if (refs.snapEdges) refs.snapEdges.checked = settings.snapEdges;
  if (refs.scaleSlider) {
    refs.scaleSlider.value = String(scalePercent(settings.scale));
    paintSliderFill(refs.scaleSlider);
  }
  if (refs.scaleVal)
    refs.scaleVal.textContent = `${scalePercent(settings.scale)}%`;
  if (refs.batterySaver)
    refs.batterySaver.checked = settings.batterySaver === true;
}

// ---- 互动 ----（动作试放经跨窗口事件；Android 经壳桥转发到桌宠页）
{
  const box = section('互动');
  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const name of ACTION_LIBRARY) {
    const b = document.createElement('button');
    b.className = 'act';
    b.textContent = ACTION_LABELS[name] ?? name;
    b.addEventListener('click', () => perform(b, 'play-action', { name }));
    grid.appendChild(b);
  }
  box.appendChild(grid);
  const speech = document.createElement('button');
  speech.className = 'act wide';
  speech.textContent = '随机说一句';
  speech.addEventListener('click', () => perform(speech, 'random-speech'));
  box.appendChild(speech);
}

// ---- 表情与情绪 ----（表情 = 临时预览；情绪 = 持续心境；Android 经壳桥转发）
// 表情 = 临时预览（8s 后自动回当前情绪的默认表情）；
// 情绪 = 持续心境（默认表情 + 动作选择加权 + 到期自然回落「平静」）。
const moodButtons = new Map<string, HTMLButtonElement>();
let currentMood = 'neutral';

function refreshMoodHighlight(): void {
  for (const [name, btn] of moodButtons) {
    btn.classList.toggle('active', name === currentMood);
  }
}

{
  const box = section('表情与情绪');

  // 表情（临时预览）
  const exprHint = document.createElement('div');
  exprHint.className = 'hint';
  exprHint.textContent = '表情（点击预览，8 秒后自动恢复）';
  box.appendChild(exprHint);
  const exprGrid = document.createElement('div');
  exprGrid.className = 'grid';
  for (const [name, label] of Object.entries(EXPRESSION_LABELS)) {
    const b = document.createElement('button');
    b.className = 'act';
    b.textContent = label;
    b.addEventListener('click', () => perform(b, 'express', { name, duration: 8 }));
    exprGrid.appendChild(b);
  }
  box.appendChild(exprGrid);
  const clearExpr = document.createElement('button');
  clearExpr.className = 'act wide';
  clearExpr.textContent = '恢复默认表情';
  clearExpr.addEventListener('click', () => perform(clearExpr, 'clear-expression'));
  box.appendChild(clearExpr);

  // 情绪（持续心境）
  const moodHint = document.createElement('div');
  moodHint.className = 'hint';
  moodHint.textContent =
    '情绪（持续心境：影响默认表情与自发动作，一段时间后自然平静）';
  box.appendChild(moodHint);
  const moodGrid = document.createElement('div');
  moodGrid.className = 'grid';
  for (const name of Object.keys(MOODS)) {
    const b = document.createElement('button');
    b.className = 'act';
    b.textContent = MOOD_LABELS[name] ?? name;
    b.addEventListener('click', () => {
      currentMood = name;
      refreshMoodHighlight();
      perform(b, 'set-mood', { name });
    });
    moodButtons.set(name, b);
    moodGrid.appendChild(b);
  }
  box.appendChild(moodGrid);
  refreshMoodHighlight();
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
    (v) => { update({ randomSpeech: v }); syncSpeechRow(); }
  );
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
  // 步进器：− 数值 +，避免裸数字框里输错被静默改回
  const stepper = document.createElement('div');
  stepper.className = 'stepper';
  const dec = document.createElement('button');
  dec.type = 'button'; dec.textContent = '−'; dec.setAttribute('aria-label', '减少间隔');
  const inc = document.createElement('button');
  inc.type = 'button'; inc.textContent = '+'; inc.setAttribute('aria-label', '增加间隔');
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
  num.addEventListener('keydown', (e) => { if (e.key === 'Enter') num.blur(); });
  dec.addEventListener('click', () => commitMinutes(settings.randomSpeechMinutes - 1));
  inc.addEventListener('click', () => commitMinutes(settings.randomSpeechMinutes + 1));
  dec.disabled = settings.randomSpeechMinutes <= 1;
  inc.disabled = settings.randomSpeechMinutes >= 120;
  stepper.append(dec, num, inc);
  refs.speechMinutes = num;
  row.appendChild(lab);
  row.appendChild(stepper);
  syncSpeechRow();
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
  // 显示百分比域：10%~100%（实际缩放范围经线性映射，不改实际上下限）
  slider.min = '10';
  slider.max = '100';
  slider.step = '1';
  slider.value = String(scalePercent(settings.scale));
  const val = document.createElement('span');
  val.className = 'val';
  val.textContent = `${scalePercent(settings.scale)}%`;
  refs.scaleSlider = slider;
  refs.scaleVal = val;
  // 实际范围按屏幕尺寸推导（与 pet 窗口的设备钳制同一公式），到位后刷新滑杆位置
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
        const logW = mon.workArea.size.width / mon.scaleFactor;
        const logH = mon.workArea.size.height / mon.scaleFactor;
        const range = scaleRangeFor(logW, logH);
        scaleRangeMin = range.minS;
        scaleRangeMax = range.maxS;
        refreshControls();
      })
      .catch(() => {});
  const commitScale = (v: number) => {
    // 滑杆/加减按钮统一在实际缩放域钳到设备范围，再换算显示百分比
    const s = clampScale(
      Math.min(Math.max(v, scaleRangeMin), scaleRangeMax)
    );
    slider.value = String(scalePercent(s));
    val.textContent = `${scalePercent(s)}%`;
    paintSliderFill(slider);
    update({ scale: s });
  };
  paintSliderFill(slider);
  minus.addEventListener('click', () => commitScale(settings.scale / 1.08));
  plus.addEventListener('click', () => commitScale(settings.scale * 1.08));
  slider.addEventListener('input', () =>
    commitScale(
      percentToScale(Number(slider.value), scaleRangeMin, scaleRangeMax)
    )
  );
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

// ---- 聊天 ----（偏好开关与下方 Misskey 连接状态共用一张卡片）
const chatBox = section('聊天');
{
  const box = chatBox;
  refs.showGeneratedImages = switchRow(
    box,
    '显示生成配图',
    '显示回复和记录中的配图及生成按钮；更改后对新回复、重新播放或重新打开的记录生效，不影响表情包和用户附图',
    () => settings.showGeneratedImages,
    (v) => update({ showGeneratedImages: v })
  );
  refs.showGeneratedImages.setAttribute('aria-label', '显示生成配图');
}

// ---- 聊天背景（仅 Android 主界面）----
if (platform === 'android') {
  const box = section('聊天背景');
  const grid = document.createElement('div');
  grid.className = 'bg-grid';
  grid.setAttribute('role', 'radiogroup');
  grid.setAttribute('aria-label', '聊天背景');
  box.appendChild(grid);
  const status = document.createElement('p');
  status.className = 'hint bg-status';
  status.setAttribute('role', 'status');
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*';
  picker.hidden = true;
  box.appendChild(picker);
  let customUrl: string | null = null;
  let hasCustom = false;
  const tiles = new Map<string, HTMLButtonElement>();
  const tile = (id: string, name: string, preview: string | null, extraClass = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `bg-tile ${extraClass}`.trim();
    b.setAttribute('role', 'radio');
    const thumb = document.createElement('span');
    thumb.className = 'bg-thumb';
    if (preview) thumb.style.backgroundImage = `url("${preview}")`;
    const label = document.createElement('span');
    label.className = 'bg-name';
    label.textContent = name;
    b.append(thumb, label);
    grid.appendChild(b);
    tiles.set(id, b);
    return b;
  };
  const sync = () => {
    for (const [id, b] of tiles) {
      const on = settings.chatBackground === id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    const custom = tiles.get(CUSTOM_BACKGROUND)!;
    const thumb = custom.querySelector<HTMLElement>('.bg-thumb')!;
    thumb.style.backgroundImage = customUrl ? `url("${customUrl}")` : '';
    custom.classList.toggle('empty', !hasCustom);
    custom.querySelector('.bg-name')!.textContent = hasCustom ? '自定义' : '上传图片';
    actions.hidden = !hasCustom;
    dimRow.classList.toggle('inactive', settings.chatBackground === NO_BACKGROUND);
  };
  tile(NO_BACKGROUND, '无背景', null, 'plain').addEventListener('click', () => { update({ chatBackground: NO_BACKGROUND }); sync(); });
  for (const p of PRESET_BACKGROUNDS) {
    tile(p.id, p.name, p.url).addEventListener('click', () => { update({ chatBackground: p.id }); sync(); });
  }
  tile(CUSTOM_BACKGROUND, '上传图片', null, 'custom').addEventListener('click', () => {
    if (hasCustom) { update({ chatBackground: CUSTOM_BACKGROUND }); sync(); }
    else picker.click();
  });
  const actions = document.createElement('div');
  actions.className = 'bg-actions';
  const replace = document.createElement('button');
  replace.type = 'button';
  replace.className = 'act';
  replace.textContent = '更换自定义图';
  replace.addEventListener('click', () => picker.click());
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'act';
  remove.textContent = '删除自定义图';
  remove.addEventListener('click', async () => {
    try { await deleteCustomBackground(); } catch { /* 已不存在 */ }
    hasCustom = false;
    if (customUrl) URL.revokeObjectURL(customUrl);
    customUrl = null;
    update({ chatBackground: settings.chatBackground === CUSTOM_BACKGROUND ? NO_BACKGROUND : settings.chatBackground,
      chatBackgroundRev: (settings.chatBackgroundRev ?? 0) + 1 });
    status.textContent = '';
    sync();
  });
  actions.append(replace, remove);
  box.appendChild(actions);
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { status.textContent = '请选择图片文件。'; box.appendChild(status); return; }
    status.textContent = '正在处理图片…';
    box.appendChild(status);
    try {
      const saved = await saveCustomBackground(file);
      if (customUrl) URL.revokeObjectURL(customUrl);
      customUrl = URL.createObjectURL(saved);
      hasCustom = true;
      update({ chatBackground: CUSTOM_BACKGROUND, chatBackgroundRev: (settings.chatBackgroundRev ?? 0) + 1 });
      status.textContent = '';
      status.remove();
    } catch (e) {
      status.textContent = e instanceof Error && e.message ? e.message : '图片保存失败，请重试。';
    }
    sync();
  });
  // 遮罩：数值越大背景越暗，角色与对话框越清楚。
  const dimRow = document.createElement('div');
  dimRow.className = 'row';
  const dimLabel = document.createElement('div');
  dimLabel.className = 'label';
  dimLabel.textContent = '背景暗化';
  const dimWrap = document.createElement('div');
  dimWrap.className = 'slider-row';
  dimWrap.style.flex = '1';
  dimWrap.style.marginLeft = '12px';
  const dim = document.createElement('input');
  dim.type = 'range';
  dim.min = '0';
  dim.max = '80';
  dim.step = '5';
  dim.value = String(Math.round(settings.chatBackgroundDim * 100));
  dim.setAttribute('aria-label', '背景暗化');
  const dimVal = document.createElement('span');
  dimVal.className = 'val';
  dimVal.textContent = `${dim.value}%`;
  dim.addEventListener('input', () => {
    dimVal.textContent = `${dim.value}%`;
    paintSliderFill(dim);
    update({ chatBackgroundDim: Number(dim.value) / 100 });
  });
  paintSliderFill(dim);
  dimWrap.append(dim, dimVal);
  dimRow.append(dimLabel, dimWrap);
  box.appendChild(dimRow);
  sync();
  void loadCustomBackground().then(blob => {
    if (!blob) return;
    hasCustom = true;
    customUrl = URL.createObjectURL(blob);
    sync();
  });
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
    '拖动自由跟手，松开后平滑靠边；拖出屏幕也会归位，关闭后可停在屏幕外',
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
          update({ posX: x, posY: y });
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
      '退到后台后显示悬浮窗',
      '悬浮窗支持点击、抚摸和拖动；双击回到主界面聊天，菜单退出会完全关闭',
      () => shell?.getPref('overlayOnExit') !== '0',
      (v) => shell?.setPref('overlayOnExit', v ? '1' : '0')
    );
  }
}

// ---- 聊天（Misskey 连接状态；鉴权与会话选择仍在聊天窗口内完成）----
{
  const box = chatBox;
  const statusRow = document.createElement('div');
  statusRow.className = 'row';
  const statusLab = document.createElement('div');
  statusLab.className = 'label';
  statusLab.textContent = 'Misskey 连接';
  const statusSub = document.createElement('span');
  statusSub.className = 'sub';
  statusLab.appendChild(statusSub);
  statusRow.appendChild(statusLab);
  box.appendChild(statusRow);

  const sessionRow = document.createElement('div');
  sessionRow.className = 'row';
  const sessionLab = document.createElement('div');
  sessionLab.className = 'label';
  sessionLab.textContent = '当前会话';
  const sessionSub = document.createElement('span');
  sessionSub.className = 'sub';
  sessionLab.appendChild(sessionSub);
  sessionRow.appendChild(sessionLab);
  box.appendChild(sessionRow);

  const refreshChatInfo = () => {
    let token = '';
    let user: { id?: string; username?: string; name?: string } | null = null;
    try {
      token = localStorage.getItem(MSK_TOKEN_KEY) ?? '';
      user = JSON.parse(localStorage.getItem(MSK_USER_KEY) ?? 'null');
    } catch {
      // 存储不可用时按未连接显示
    }
    const name = user?.name || user?.username || '';
    statusSub.textContent = token && name ? `已连接：${name}` : '未连接（在聊天窗口中授权）';
    let sessionName = '';
    if (user?.id) {
      try {
        const saved = JSON.parse(
          localStorage.getItem(mskSessionKey(user.id)) ?? 'null'
        ) as { name?: string } | null;
        sessionName = saved?.name ?? '';
      } catch {
        // 无记录
      }
    }
    sessionSub.textContent = sessionName || (token ? '未选择' : '—');
  };
  refreshChatInfo();
  // 聊天窗口里的登录/选会话改动经 localStorage 落盘，回本窗口时刷新
  window.addEventListener('focus', refreshChatInfo);
  window.addEventListener('storage', refreshChatInfo);

  const openRecords = async () => {
    if (platform === 'tauri') {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('show_records');
    } else if (platform === 'android') shellAction('open-records');
    else window.location.assign('/chat.html');
  };
  if (platform === 'android') {
    const openChat = document.createElement('button');
    openChat.className = 'act wide';
    openChat.textContent = '打开聊天';
    openChat.addEventListener('click', () => shellAction('open-chat'));
    box.appendChild(openChat);
  }
  const agentControls = mountAgentControls(box, openRecords, refreshChatInfo);
  /** 入场动画（settings.css .enter）：重放前先移除再强制 reflow，连续打开也能重新触发。 */
  const playEnter = () => {
    app.classList.remove('enter');
    void app.offsetWidth;
    app.classList.add('enter');
  };
  const openTarget = (target: string) => {
    if (target === 'session-control') {
      playEnter();
      requestAnimationFrame(() => agentControls.open());
      return;
    }
    agentControls.close();
    playEnter();
    requestAnimationFrame(() => {
      app.scrollTo({ top: target === 'about' ? app.scrollHeight : 0, behavior: 'smooth' });
    });
  };
  if (platform === 'tauri') {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      await listen<{ target?: string }>('settings-open', event => openTarget(event.payload?.target ?? ''));
    } catch { /* Browser preview has no Tauri event bus. */ }
  } else {
    playEnter();
  }
  window.addEventListener('hashchange', () => openTarget(location.hash.slice(1)));
  if (location.hash) openTarget(location.hash.slice(1));
}

// ---- 关于 ----
{
  const box = section('关于');
  const div = document.createElement('div');
  div.className = 'about';
  div.innerHTML =
    `<b>Aliya Pet</b> v${__APP_VERSION__}（${platform === 'android' ? 'Android' : 'Windows'}）<br>` +
    '本程序为二创桌宠，人物原创为《彼方的她》。<br>' +
    'Live2D Cubism SDK for Web © Live2D Inc.';
  box.appendChild(div);
  const repo = document.createElement('button');
  repo.className = 'act wide';
  repo.textContent = '打开项目仓库';
  repo.addEventListener('click', () => {
    openUrl('https://github.com/liminalselves/Aliya_pet');
  });
  box.appendChild(repo);
}

// 托盘改动经 pet 窗口广播 → 刷新控件
onSettingsChanged('settings-changed', () => {
  settings = loadSettings();
  refreshControls();
});

// pet 窗口情绪变化（petAI/托盘/自然回落）→ 刷新情绪高亮
onMoodChanged((mood: string) => {
  currentMood = mood;
  refreshMoodHighlight();
});

// Android：桌宠页把情绪写入共享 localStorage（跨 WebView 无事件总线），
// 回到本页/收到 storage 事件时刷新高亮
if (platform === 'android') {
  const readMood = () => {
    let mood = '';
    try {
      mood = localStorage.getItem('aliya_pet_mood') ?? '';
    } catch {
      // 存储不可用则保持当前高亮
    }
    if (mood) {
      currentMood = mood;
      refreshMoodHighlight();
    }
  };
  window.addEventListener('focus', readMood);
  window.addEventListener('storage', (e) => {
    if (e.key === 'aliya_pet_mood') readMood();
  });
  readMood();
}
