/**
 * 内置聊天背景场景：纯 DOM + CSS 绘制（样式见 styles/chat-scenes.css）。
 *
 * 场景根是 size 容器，尺寸全部用 cqw/cqh/cqmin：主界面全屏与设置页缩略图用同一份
 * 构图，任意宽高比（长屏、平板、横屏）下月亮、圆窗、地平线都相对角色站位重新排布，
 * 不像整张位图那样被裁掉主体。动效只动 transform/opacity，省电模式与减少动态时暂停。
 */
import './styles/chat-scenes.css';

export interface ChatScene {
  id: string;
  name: string;
  build(): HTMLElement;
}

/** 固定种子伪随机：主界面与缩略图星点/花瓣位置一致。 */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function node(className: string, style: Record<string, string> = {}): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  for (const [k, v] of Object.entries(style)) el.style.setProperty(k, v);
  return el;
}

function root(kind: string): HTMLElement {
  const el = node(`bg-scene scene-${kind}`);
  el.setAttribute('aria-hidden', 'true');
  return el;
}

function svg(markup: string): Element {
  const holder = document.createElement('div');
  holder.innerHTML = markup;
  return holder.firstElementChild!;
}

function starry(): HTMLElement {
  const scene = root('starry');
  const rand = seeded(7);
  // 三组星点各自明灭：每组一个合成层，不给每颗星单独建层。
  for (const group of ['a', 'b', 'c']) {
    const layer = node(`stars ${group}`);
    for (let i = 0; i < 14; i++) {
      const size = 0.32 + rand() * 0.42;
      const tint = rand();
      layer.append(node(`star${tint > 0.9 ? ' gold' : tint > 0.84 ? ' blush' : ''}`, {
        left: `${(rand() * 96 + 2).toFixed(2)}%`,
        // 星点集中在上 70%：下方是远山与回复卡。
        top: `${(rand() * 68 + 2).toFixed(2)}%`,
        '--sz': `${size.toFixed(2)}cqmin`,
        '--o': (0.35 + rand() * 0.6).toFixed(2),
      }));
    }
    scene.append(layer);
  }
  scene.append(node('moon'), node('meteor'));
  scene.append(svg(`<svg class="hills" viewBox="0 0 400 120" preserveAspectRatio="none">
    <path class="far" d="M0 30C50 12 110 14 160 26S280 6 400 22V120H0Z"/>
    <path class="mid" d="M0 40C60 28 130 32 200 42S330 26 400 36V120H0Z"/>
    <path class="near" d="M0 54C80 46 170 48 250 54S350 50 400 52V120H0Z"/>
  </svg>`));
  return scene;
}

function moonWindow(): HTMLElement {
  const scene = root('window');
  scene.append(node('floor'));
  const win = node('win');
  win.append(node('win-moon'), svg(`<svg class="win-view" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">
    <path class="ridge" d="M0 78C18 70 30 72 44 77S74 68 100 74V100H0Z"/>
    <g class="branch" fill="none" stroke-linecap="round">
      <path d="M104 30C88 34 78 40 70 50S56 64 46 68" stroke-width="1.8"/>
      <path d="M78 40C76 32 72 27 66 24" stroke-width="1.1"/>
      <path d="M62 58C60 66 62 72 66 78" stroke-width="1"/>
      <path d="M90 33C92 42 90 48 86 54" stroke-width=".9"/>
    </g>
    <g class="blossom">
      <circle cx="66" cy="24" r="2.4"/><circle cx="70.5" cy="28" r="1.6"/><circle cx="74" cy="44" r="2.2"/>
      <circle cx="58" cy="60" r="2"/><circle cx="66" cy="78" r="1.8"/><circle cx="46" cy="68" r="2.3"/>
      <circle cx="86" cy="54" r="1.9"/><circle cx="51" cy="64.5" r="1.3"/><circle cx="82" cy="36" r="1.4"/>
    </g>
    <g class="blossom light">
      <circle cx="68.5" cy="22.5" r="1.1"/><circle cx="76" cy="46.5" r="1"/><circle cx="44" cy="70" r="1.1"/>
      <circle cx="88" cy="56" r=".9"/><circle cx="60" cy="58" r=".9"/>
    </g>
  </svg>`));
  scene.append(win);
  const rand = seeded(23);
  for (let i = 0; i < 8; i++) {
    const duration = 15 + rand() * 9;
    scene.append(node('petal', {
      left: `${(rand() * 92).toFixed(1)}%`,
      '--dx': `${(8 + rand() * 18).toFixed(1)}cqw`,
      '--r': `${Math.round(220 + rand() * 300)}deg`,
      '--s': (0.75 + rand() * 0.6).toFixed(2),
      '--o': (0.5 + rand() * 0.35).toFixed(2),
      'animation-duration': `${duration.toFixed(1)}s`,
      'animation-delay': `${(-rand() * duration).toFixed(1)}s`,
    }));
  }
  return scene;
}

function ripple(): HTMLElement {
  const scene = root('ripple');
  scene.append(node('disc'), node('orbit outer'), node('orbit inner'), node('horizon'), node('ground'));
  for (let i = 0; i < 3; i++) scene.append(node('ring', { 'animation-delay': `${(-i * 10 / 3).toFixed(2)}s` }));
  scene.append(node('orbiter outer'), node('orbiter inner'));
  return scene;
}

/** 预设清单：增删条目即增删设置页选项；id 写进设置存档。 */
export const CHAT_SCENES: ReadonlyArray<ChatScene> = [
  { id: 'starry', name: '星夜', build: starry },
  { id: 'moon-window', name: '圆窗', build: moonWindow },
  { id: 'ripple', name: '涟漪', build: ripple },
];
