import type { SettingsTabId } from './navigation';

/** 桌面宽窗左侧导航栏图标（16×16 线性图标，与暮石克制质感一致）。 */
export const TAB_ICONS: Record<SettingsTabId, string> = {
  stage:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2l1.55 3.7L13.3 7.5l-3.75 1.6L8 12.8l-1.55-3.7L2.7 7.5l3.75-1.6Z"/></svg>',
  character:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="5.25" r="2.45"/><path d="M3.1 13.5c.65-2.3 2.35-3.55 4.9-3.55s4.25 1.25 4.9 3.55"/></svg>',
  window:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.75" width="12" height="10.5" rx="2"/><path d="M2 5.75h12"/></svg>',
  chat:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.2 3.25h9.6A1.45 1.45 0 0 1 14.25 4.7v5.2a1.45 1.45 0 0 1-1.45 1.45H7.2l-3.2 2.2v-2.2H3.2a1.45 1.45 0 0 1-1.45-1.45V4.7a1.45 1.45 0 0 1 1.45-1.45Z"/></svg>',
  about:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.75"/><path d="M8 7.5v3.4"/><circle cx="8" cy="5.1" r=".7" fill="currentColor" stroke="none"/></svg>',
};

export type CardBadgeTone = 'neutral' | 'accent' | 'success' | 'warning';

export interface CardOptions {
  title?: string;
  desc?: string;
  badge?: { text: string; tone?: CardBadgeTone };
}

export interface CardHandle {
  card: HTMLElement;
  body: HTMLElement;
  setBadge(text: string, tone?: CardBadgeTone): void;
}

/** 创建带可选表头与状态徽标的模块化设置卡片。 */
export function createCard(parent: HTMLElement, opts: CardOptions = {}): CardHandle {
  const card = document.createElement('section');
  card.className = 'card';

  let badgeEl: HTMLSpanElement | null = null;
  if (opts.title) {
    const head = document.createElement('header');
    head.className = 'card-head';

    const text = document.createElement('div');
    text.className = 'card-head-text';
    const title = document.createElement('h2');
    title.className = 'card-title';
    title.textContent = opts.title;
    text.appendChild(title);

    if (opts.desc) {
      const desc = document.createElement('p');
      desc.className = 'card-desc';
      desc.textContent = opts.desc;
      text.appendChild(desc);
    }

    badgeEl = document.createElement('span');
    badgeEl.className = 'card-badge';
    badgeEl.hidden = true;
    head.append(text, badgeEl);
    card.appendChild(head);
  }

  const body = document.createElement('div');
  body.className = 'card-body';
  card.appendChild(body);
  parent.appendChild(card);

  const setBadge = (text: string, tone: CardBadgeTone = 'neutral') => {
    if (!badgeEl) return;
    badgeEl.textContent = text;
    badgeEl.dataset.tone = tone;
    badgeEl.hidden = !text;
  };

  if (opts.badge) setBadge(opts.badge.text, opts.badge.tone);

  return { card, body, setBadge };
}

export interface SwitchRowHandle {
  row: HTMLElement;
  input: HTMLInputElement;
}

/** 创建开关行（标签 + 可选副说明 + 右侧开关）。 */
export function createSwitchRow(
  parent: HTMLElement,
  label: string,
  sub: string,
  get: () => boolean,
  set: (v: boolean) => void
): SwitchRowHandle {
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
  sw.append(input, knob);
  row.append(lab, sw);
  parent.appendChild(row);
  return { row, input };
}

export interface SliderRowOptions {
  label: string;
  sub?: string;
  stacked?: boolean;
  withStepButtons?: boolean;
  ariaLabel?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  formatValue?: (value: number) => string;
  onInput: (value: number) => void;
  onStep?: (deltaSign: -1 | 1) => void;
}

export interface SliderRowHandle {
  row: HTMLElement;
  slider: HTMLInputElement;
  val: HTMLSpanElement;
  setDisplay(sliderValue: number, displayText?: string): void;
}

/** 滑块行程填充：当前值映射到轨道 0%~100%。 */
export function paintSliderFill(slider: HTMLInputElement): void {
  const min = Number(slider.min);
  const max = Number(slider.max);
  const span = max - min;
  const pct = span > 0 ? ((Number(slider.value) - min) / span) * 100 : 0;
  slider.style.setProperty('--fill', `${Math.min(100, Math.max(0, pct))}%`);
}

/** 创建滑块行（支持可选副说明、上下堆叠布局及 −/+ 微调按钮）。 */
export function createSliderRow(parent: HTMLElement, opts: SliderRowOptions): SliderRowHandle {
  const row = document.createElement('div');
  row.className = opts.stacked ? 'row opacity-row' : 'row';

  const lab = document.createElement('div');
  lab.className = 'label';
  lab.textContent = opts.label;
  if (opts.sub) {
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = opts.sub;
    lab.appendChild(sub);
  }

  const wrap = document.createElement('div');
  wrap.className = 'slider-row';
  wrap.style.flex = '1';

  const format = opts.formatValue ?? ((v: number) => `${v}%`);
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.setAttribute('aria-label', opts.ariaLabel ?? opts.label);
  slider.min = String(opts.min);
  slider.max = String(opts.max);
  slider.step = String(opts.step);

  const val = document.createElement('span');
  val.className = 'val';

  const setDisplay = (sliderValue: number, displayText?: string) => {
    slider.value = String(sliderValue);
    val.textContent = displayText ?? format(sliderValue);
    paintSliderFill(slider);
  };

  if (opts.withStepButtons) {
    const minus = document.createElement('button');
    minus.type = 'button';
    minus.textContent = '−';
    minus.setAttribute('aria-label', `减小${opts.label}`);
    minus.addEventListener('click', () => {
      if (opts.onStep) {
        opts.onStep(-1);
        return;
      }
      const next = Math.max(opts.min, Number(slider.value) - opts.step);
      setDisplay(next);
      opts.onInput(next);
    });

    const plus = document.createElement('button');
    plus.type = 'button';
    plus.textContent = '+';
    plus.setAttribute('aria-label', `增大${opts.label}`);
    plus.addEventListener('click', () => {
      if (opts.onStep) {
        opts.onStep(1);
        return;
      }
      const next = Math.min(opts.max, Number(slider.value) + opts.step);
      setDisplay(next);
      opts.onInput(next);
    });

    wrap.append(minus, slider, plus, val);
  } else {
    wrap.append(slider, val);
  }

  slider.addEventListener('input', () => {
    const next = Number(slider.value);
    val.textContent = format(next);
    paintSliderFill(slider);
    opts.onInput(next);
  });

  setDisplay(opts.value);
  row.append(lab, wrap);
  parent.appendChild(row);

  return { row, slider, val, setDisplay };
}

/** 创建卡片底部/列表内的满宽带箭头操作行。 */
export function createWideAction(
  parent: HTMLElement,
  label: string,
  onClick: (button: HTMLButtonElement) => void
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'act wide';
  button.textContent = label;
  button.addEventListener('click', () => onClick(button));
  parent.appendChild(button);
  return button;
}

/** 联动禁用行：视觉降透明并移出 Tab 焦点流，避免依赖设置误操作。 */
export function setRowInactive(row: HTMLElement | null, inactive: boolean): void {
  if (!row) return;
  row.classList.toggle('inactive', inactive);
  if (inactive) row.setAttribute('aria-disabled', 'true');
  else row.removeAttribute('aria-disabled');
  row.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach((el) => {
    el.tabIndex = inactive ? -1 : 0;
  });
}

/** KeyboardEvent → 快捷键文本（与壳侧 parse_hotkey 同格式）；纯修饰键或不支持的键返回 null。 */
export function hotkeyFromEvent(e: KeyboardEvent): string | null {
  const m = /^(?:Key([A-Z])|Digit([0-9])|(F(?:[1-9]|1[0-9]|2[0-4])))$/.exec(e.code);
  if (!m) return null;
  const mods = [
    e.ctrlKey && 'Ctrl',
    e.altKey && 'Alt',
    e.shiftKey && 'Shift',
    e.metaKey && 'Win',
  ].filter(Boolean);
  return [...mods, m[1] ?? m[2] ?? m[3]].join('+');
}
