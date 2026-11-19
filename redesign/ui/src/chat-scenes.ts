/**
 * 内置聊天背景场景：自适应 DOM+CSS/SVG 动画场景 + 主题插画背景（样式见 styles/chat-scenes.css）。
 *
 * 场景根是 size 容器（container-type: size），尺寸全部用 cqw/cqh/cqmin：
 * 全屏舞台、记录页、卡片背景与设置页缩略图用同一份构图，在任意宽高比下自动排布。
 * 构图避让：中央留出安静低对比区域衬托 Aliya，顶部 y<22%（避开猫耳）与左右侧边布置景物，
 * 下方 y>=74% 提供稳定地面/廊道承接角色双脚。
 * 动效仅驱动 transform/opacity，省电模式、后台及减少动态时自动暂停。
 */
import './styles/chat-scenes.css';

export type ChatSceneKind = 'animated' | 'illustration';

export interface ChatScene {
  id: string;
  name: string;
  kind: ChatSceneKind;
  /** 插画背景的静态图片资源地址（kind === 'illustration'）。 */
  imageUrl?: string;
  /** 宽屏裁切时的焦点位置（CSS object-position）。 */
  focusPosition?: string;
  build(): HTMLElement;
}

export interface AutoSceneMatch {
  periodId: 'morning' | 'day' | 'dusk' | 'night' | 'deep_night';
  periodName: string;
  scene: ChatScene;
}

/** 固定种子伪随机：主界面与缩略图星点/花瓣/萤火位置一致。 */
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

/** 分组星点辅助：三层各自明灭，避免每颗星独立建合成层。 */
function appendStarLayers(
  target: HTMLElement,
  seed: number,
  perGroup: number,
  maxTopPct: number,
  palette: ('gold' | 'blush' | 'violet')[] = ['gold', 'blush']
): void {
  const rand = seeded(seed);
  for (const group of ['a', 'b', 'c']) {
    const layer = node(`stars ${group}`);
    for (let i = 0; i < perGroup; i++) {
      const size = 0.28 + rand() * 0.44;
      const tint = rand();
      const tintClass =
        tint > 0.91 ? ` ${palette[0]}` :
        tint > 0.83 ? ` ${palette[1] ?? palette[0]}` :
        tint > 0.78 && palette[2] ? ` ${palette[2]}` : '';
      layer.append(node(`star${tintClass}`, {
        left: `${(rand() * 96 + 2).toFixed(2)}%`,
        top: `${(rand() * maxTopPct + 2).toFixed(2)}%`,
        '--sz': `${size.toFixed(2)}cqmin`,
        '--o': (0.35 + rand() * 0.6).toFixed(2),
      }));
    }
    target.append(layer);
  }
}

/* ---------- 1. 星夜（山巅观星石台 + 新月 + 远山薄雾） ---------- */
function starry(): HTMLElement {
  const scene = root('starry');
  scene.append(node('milky-way'), node('moon-glow'));
  appendStarLayers(scene, 7, 15, 62);
  scene.append(node('moon'), node('meteor'));
  scene.append(svg(`<svg class="hills" viewBox="0 0 400 220" preserveAspectRatio="none">
    <path class="far" d="M0 78 C55 46 115 50 175 68 C245 86 315 36 400 58 V220 H0 Z"/>
    <path class="far-rim" d="M0 78 C55 46 115 50 175 68 C245 86 315 36 400 58" fill="none" stroke-width="1.2"/>
    <path class="mid" d="M0 104 C70 82 140 94 210 108 C290 120 345 78 400 94 V220 H0 Z"/>
    <path class="near" d="M0 128 C80 118 160 126 240 130 C320 134 365 116 400 124 V220 H0 Z"/>
    <path class="terrace" d="M0 144 H400 V220 H0 Z"/>
    <path class="terrace-edge" d="M0 144 H400" fill="none" stroke-width="1.4"/>
    <g class="terrace-seams" fill="none" stroke-width="1">
      <line x1="200" y1="144" x2="110" y2="220"/>
      <line x1="200" y1="144" x2="290" y2="220"/>
      <line x1="28" y1="162" x2="372" y2="162"/>
      <line x1="0" y1="186" x2="400" y2="186"/>
    </g>
    <g class="terrace-posts">
      <rect class="wall-wing" x="0" y="130" width="84" height="14" rx="1"/>
      <rect class="wall-wing" x="316" y="130" width="84" height="14" rx="1"/>
      <rect class="lantern-housing" x="16" y="114" width="16" height="16" rx="2"/>
      <rect class="lantern-housing" x="368" y="114" width="16" height="16" rx="2"/>
      <path d="M12 114 H36 L24 106 Z"/>
      <path d="M364 114 H388 L376 106 Z"/>
      <rect x="20" y="118" width="8" height="9" rx="1" class="lantern-core"/>
      <rect x="372" y="118" width="8" height="9" rx="1" class="lantern-core"/>
    </g>
  </svg>`));
  scene.append(node('mist'), node('lantern-halo left'), node('lantern-halo right'));
  return scene;
}

/* ---------- 2. 圆窗（月洞廊门 + 高悬明月花枝 + 游廊木阶 + 飘瓣） ---------- */
function moonWindow(): HTMLElement {
  const scene = root('window');
  scene.append(node('wall-wash'));
  const win = node('win');
  win.append(node('win-glow'), node('win-moon'), svg(`<svg class="win-view" viewBox="0 0 100 120" preserveAspectRatio="xMidYMid slice">
    <path class="ridge" d="M0 92 C18 82 36 86 52 91 C70 96 86 80 100 88 V120 H0 Z"/>
    <g class="foliage-side">
      <path d="M0 54 C10 58 14 74 12 96 H0 Z"/>
      <path d="M100 50 C90 54 86 72 88 96 H100 Z"/>
    </g>
    <g class="branch" fill="none" stroke-linecap="round">
      <path d="M104 18 C84 22 68 27 52 34 C44 37 36 38 28 36" stroke-width="1.9"/>
      <path d="M74 25 C72 17 67 12 60 9" stroke-width="1.15"/>
      <path d="M58 31 C56 23 50 18 44 16" stroke-width="1"/>
      <path d="M88 21 C89 29 86 35 81 40" stroke-width=".95"/>
    </g>
    <g class="blossom">
      <circle cx="60" cy="9" r="2.2"/><circle cx="64" cy="13" r="1.5"/><circle cx="44" cy="16" r="2"/>
      <circle cx="71" cy="24" r="2.1"/><circle cx="52" cy="34" r="1.9"/><circle cx="81" cy="40" r="1.8"/><circle cx="28" cy="36" r="2.1"/>
    </g>
    <g class="blossom light">
      <circle cx="62" cy="8" r="1"/><circle cx="46" cy="18" r="1"/><circle cx="73" cy="26" r=".9"/>
      <circle cx="83" cy="42" r=".9"/><circle cx="30" cy="34.5" r=".95"/>
    </g>
  </svg>`));
  scene.append(win);
  scene.append(svg(`<svg class="alcove-frame" viewBox="0 0 400 700" preserveAspectRatio="none">
    <path class="alcove-trim" d="M36 530 V220 C36 96 108 32 200 32 C292 32 364 96 364 220 V530" fill="none" stroke-width="3"/>
    <path class="alcove-lattice" d="M0 155 H36 M364 155 H400 M0 340 H36 M364 340 H400" fill="none" stroke-width="1.6"/>
    <rect class="veranda" x="0" y="520" width="400" height="180"/>
    <line class="veranda-edge" x1="0" y1="520" x2="400" y2="520" stroke-width="2"/>
    <g class="veranda-seams" fill="none" stroke-width="1">
      <line x1="160" y1="520" x2="84" y2="700"/>
      <line x1="240" y1="520" x2="316" y2="700"/>
      <line x1="0" y1="560" x2="400" y2="560"/>
      <line x1="0" y1="615" x2="400" y2="615"/>
    </g>
    <g class="side-lantern">
      <rect class="lantern-base" x="18" y="578" width="26" height="5" rx="1"/>
      <rect class="lantern-paper" x="21" y="548" width="20" height="30" rx="2"/>
      <path class="lantern-cap" d="M16 548 L31 538 L46 548 Z"/>
      <rect class="lantern-base" x="356" y="578" width="26" height="5" rx="1"/>
      <rect class="lantern-paper" x="359" y="548" width="20" height="30" rx="2"/>
      <path class="lantern-cap" d="M354 548 L369 538 L384 548 Z"/>
    </g>
  </svg>`));
  scene.append(node('veranda-glow left'), node('veranda-glow right'));
  const rand = seeded(23);
  for (let i = 0; i < 10; i++) {
    const duration = 15 + rand() * 9;
    scene.append(node('petal', {
      left: `${(rand() * 92).toFixed(1)}%`,
      '--dx': `${(8 + rand() * 18).toFixed(1)}cqw`,
      '--r': `${Math.round(220 + rand() * 300)}deg`,
      '--s': (0.7 + rand() * 0.65).toFixed(2),
      '--o': (0.5 + rand() * 0.35).toFixed(2),
      'animation-duration': `${duration.toFixed(1)}s`,
      'animation-delay': `${(-rand() * duration).toFixed(1)}s`,
    }));
  }
  return scene;
}

/* ---------- 3. 涟漪（星轨浑天水镜 + 星柱倒影） ---------- */
function ripple(): HTMLElement {
  const scene = root('ripple');
  appendStarLayers(scene, 37, 10, 66, ['violet', 'blush']);
  scene.append(node('disc'), node('orbit outer'), node('orbit inner'));
  scene.append(svg(`<svg class="astrolabe" viewBox="0 0 400 400" preserveAspectRatio="xMidYMid meet">
    <circle class="astro-ring" cx="200" cy="200" r="186" stroke-dasharray="3 6"/>
    <circle class="astro-ring accent" cx="200" cy="200" r="168"/>
    <circle class="astro-ring" cx="200" cy="200" r="144" stroke-dasharray="14 6 2 6"/>
    <g class="astro-spokes" stroke-width=".9">
      <line x1="200" y1="8" x2="200" y2="36"/><line x1="200" y1="364" x2="200" y2="392"/>
      <line x1="8" y1="200" x2="36" y2="200"/><line x1="364" y1="200" x2="392" y2="200"/>
      <line x1="68" y1="68" x2="86" y2="86"/><line x1="332" y1="68" x2="314" y2="86"/>
      <line x1="68" y1="332" x2="86" y2="314"/><line x1="332" y1="332" x2="314" y2="314"/>
    </g>
    <g class="astro-nodes">
      <circle cx="200" cy="32" r="3.2"/><circle cx="200" cy="368" r="2.6"/>
      <circle cx="32" cy="200" r="2.6"/><circle cx="368" cy="200" r="2.6"/>
      <circle cx="81" cy="81" r="2.2"/><circle cx="319" cy="81" r="2.2"/>
    </g>
  </svg>`));
  scene.append(node('horizon'), node('water-mirror'), node('ground'));
  for (let i = 0; i < 3; i++) scene.append(node('ring', { 'animation-delay': `${(-i * 10 / 3).toFixed(2)}s` }));
  scene.append(node('orbiter outer'), node('orbiter inner'));
  return scene;
}

/* ---------- 4. 永恒黄昏（暮霞海湾 + 沿海栈道栏杆与落日余晖） ---------- */
function eternalDusk(): HTMLElement {
  const scene = root('dusk');
  scene.append(node('sun-halo'), node('sun'));
  appendStarLayers(scene, 79, 8, 28, ['gold', 'blush']);
  scene.append(svg(`<svg class="dusk-clouds" viewBox="0 0 400 180" preserveAspectRatio="none">
    <path class="cloud-a" d="M-20 68 Q45 48 115 64 T260 60 T420 70 V88 H-20 Z"/>
    <path class="cloud-b" d="M-20 104 Q65 88 145 100 T300 94 T420 106 V122 H-20 Z"/>
  </svg>`));
  const sea = node('sea');
  sea.append(node('horizon-glow'));
  const rand = seeded(313);
  for (let i = 0; i < 8; i++) {
    const t = i / 7;
    sea.append(node('glint', {
      top: `${(8 + t * 24).toFixed(1)}%`,
      left: `${(16 + (rand() - 0.5) * 6).toFixed(1)}%`,
      width: `${(13 - t * 6 + rand() * 4).toFixed(1)}%`,
      'animation-duration': `${(3.6 + rand() * 2.8).toFixed(1)}s`,
      'animation-delay': `${(-rand() * 4).toFixed(1)}s`,
    }));
  }
  scene.append(sea);
  // 远岸山岬 + 海岸观景石台步道（让角色站在海岸平台上而非海面）
  scene.append(svg(`<svg class="dusk-shore" viewBox="0 0 400 220" preserveAspectRatio="none">
    <path class="cape" d="M0 44 C38 28 74 36 106 46 H0 Z M400 40 C354 22 308 32 268 46 H400 Z"/>
    <rect class="promenade" x="0" y="96" width="400" height="124"/>
    <line class="promenade-rim" x1="0" y1="96" x2="400" y2="96" stroke-width="1.8"/>
    <g class="promenade-seams" fill="none" stroke-width="1">
      <line x1="150" y1="96" x2="72" y2="220"/>
      <line x1="250" y1="96" x2="328" y2="220"/>
      <line x1="0" y1="136" x2="400" y2="136"/>
      <line x1="0" y1="184" x2="400" y2="184"/>
    </g>
    <g class="shore-rails">
      <rect class="wall-wing" x="0" y="82" width="76" height="14" rx="1"/>
      <rect class="wall-wing" x="324" y="82" width="76" height="14" rx="1"/>
      <rect x="16" y="66" width="14" height="16" rx="2"/>
      <rect x="370" y="66" width="14" height="16" rx="2"/>
      <path d="M12 66 H34 L23 58 Z"/>
      <path d="M366 66 H388 L377 58 Z"/>
      <rect x="20" y="70" width="6" height="8" rx="1" class="bollard-glow"/>
      <rect x="374" y="70" width="6" height="8" rx="1" class="bollard-glow"/>
    </g>
  </svg>`));
  return scene;
}

/* ---------- 5. 月海初雪（清冷月轮、雪顶远山、雪夜栈桥与飘雪） ---------- */
function snowfallMoon(): HTMLElement {
  const scene = root('snow');
  scene.append(node('snow-moon-halo'), node('snow-moon'));
  appendStarLayers(scene, 97, 10, 48, ['violet']);
  scene.append(svg(`<svg class="snow-hills" viewBox="0 0 400 100" preserveAspectRatio="none">
    <path class="far" d="M0 58 C60 32 125 44 185 56 C245 66 315 28 400 46 V100 H0 Z"/>
    <path class="crest" d="M0 58 C60 32 125 44 185 56 C245 66 315 28 400 46" fill="none" stroke-width="1.6"/>
    <path class="near" d="M0 74 C75 62 150 68 230 74 C300 78 350 60 400 68 V100 H0 Z"/>
  </svg>`));
  const sea = node('snow-sea');
  sea.append(node('snow-reflect'));
  scene.append(sea);
  scene.append(svg(`<svg class="snow-pier" viewBox="0 0 400 200" preserveAspectRatio="none">
    <!-- 延伸入星海的透视木质栈桥（两侧留出月影水波） -->
    <polygon class="pier-deck" points="116,46 284,46 370,200 30,200"/>
    <line class="pier-rim" x1="116" y1="46" x2="284" y2="46" stroke-width="1.8"/>
    <g class="pier-rails" fill="none" stroke-width="1.6">
      <line x1="116" y1="46" x2="30" y2="200"/>
      <line x1="284" y1="46" x2="370" y2="200"/>
      <line x1="116" y1="26" x2="30" y2="152"/>
      <line x1="284" y1="26" x2="370" y2="152"/>
    </g>
    <g class="pier-planks" fill="none" stroke-width="1">
      <line x1="162" y1="46" x2="122" y2="200"/>
      <line x1="238" y1="46" x2="278" y2="200"/>
      <line x1="94" y1="86" x2="306" y2="86"/>
      <line x1="68" y1="132" x2="332" y2="132"/>
      <line x1="42" y1="178" x2="358" y2="178"/>
    </g>
    <g class="snow-bank">
      <path d="M112 48 Q138 40 164 49 Q136 56 112 52 Z"/>
      <path d="M288 48 Q262 40 236 49 Q264 56 288 52 Z"/>
    </g>
    <g class="pier-posts">
      <rect x="110" y="24" width="10" height="24" rx="1"/>
      <rect x="280" y="24" width="10" height="24" rx="1"/>
      <rect x="64" y="96" width="12" height="44" rx="1"/>
      <rect x="324" y="96" width="12" height="44" rx="1"/>
      <rect x="112" y="18" width="6" height="6" rx="1" class="warm-lamp"/>
      <rect x="282" y="18" width="6" height="6" rx="1" class="warm-lamp"/>
      <rect x="66" y="88" width="8" height="8" rx="1" class="warm-lamp"/>
      <rect x="326" y="88" width="8" height="8" rx="1" class="warm-lamp"/>
    </g>
  </svg>`));
  const rand = seeded(409);
  for (let i = 0; i < 26; i++) {
    const far = i % 3 === 0;
    const duration = (far ? 16 : 10) + rand() * 6;
    scene.append(node(`flake${far ? ' far' : ''}`, {
      left: `${(rand() * 98).toFixed(1)}%`,
      '--sz': `${(far ? 0.58 + rand() * 0.35 : 0.95 + rand() * 0.75).toFixed(2)}cqmin`,
      '--dx': `${((rand() - 0.35) * 16).toFixed(1)}cqw`,
      '--o': (far ? 0.42 + rand() * 0.25 : 0.68 + rand() * 0.3).toFixed(2),
      'animation-duration': `${duration.toFixed(1)}s`,
      'animation-delay': `${(-rand() * duration).toFixed(1)}s`,
    }));
  }
  return scene;
}

/* ---------- 6-9. 主题插画背景（图片 + 轻微动态微粒） ---------- */
function buildIllustration(
  id: string,
  imageUrl: string,
  focusPosition: string,
  ambientKind: 'stars' | 'spores' | 'motes' | 'moon'
): HTMLElement {
  const scene = root(`illus scene-${id}`);
  const img = document.createElement('img');
  img.className = 'illus-img';
  img.alt = '';
  img.draggable = false;
  img.decoding = 'async';
  img.src = imageUrl;
  img.style.objectPosition = focusPosition;
  scene.append(img);

  if (ambientKind === 'stars') {
    appendStarLayers(scene, 503, 5, 34, ['gold', 'blush']);
  } else if (ambientKind === 'spores') {
    const rand = seeded(521);
    for (let i = 0; i < 10; i++) {
      const dur = 8 + rand() * 7;
      scene.append(node('ambient-spore', {
        left: `${(rand() > 0.5 ? 4 + rand() * 24 : 72 + rand() * 24).toFixed(1)}%`,
        top: `${(36 + rand() * 52).toFixed(1)}%`,
        '--sz': `${(0.45 + rand() * 0.55).toFixed(2)}cqmin`,
        '--dy': `${(-6 - rand() * 8).toFixed(1)}cqh`,
        'animation-duration': `${dur.toFixed(1)}s`,
        'animation-delay': `${(-rand() * dur).toFixed(1)}s`,
      }));
    }
  } else if (ambientKind === 'motes') {
    const rand = seeded(547);
    for (let i = 0; i < 8; i++) {
      const dur = 11 + rand() * 7;
      scene.append(node('ambient-mote', {
        left: `${(10 + rand() * 80).toFixed(1)}%`,
        top: `${(22 + rand() * 44).toFixed(1)}%`,
        '--sz': `${(0.35 + rand() * 0.45).toFixed(2)}cqmin`,
        '--dx': `${(4 + rand() * 10).toFixed(1)}cqw`,
        'animation-duration': `${dur.toFixed(1)}s`,
        'animation-delay': `${(-rand() * dur).toFixed(1)}s`,
      }));
    }
  } else {
    appendStarLayers(scene, 577, 5, 36, ['blush', 'violet']);
  }
  return scene;
}

/** 预设清单：增删条目即增删设置页选项；id 写进设置存档。 */
export const CHAT_SCENES: ReadonlyArray<ChatScene> = [
  { id: 'starry', name: '星夜', kind: 'animated', build: starry },
  { id: 'moon-window', name: '圆窗', kind: 'animated', build: moonWindow },
  { id: 'ripple', name: '涟漪', kind: 'animated', build: ripple },
  { id: 'eternal-dusk', name: '永恒黄昏', kind: 'animated', build: eternalDusk },
  { id: 'snowfall-moon', name: '月海初雪', kind: 'animated', build: snowfallMoon },
  {
    id: 'illus-cabin',
    name: '星舰观测室',
    kind: 'illustration',
    imageUrl: '/backgrounds/cabin.webp',
    focusPosition: '50% 44%',
    build: () => buildIllustration('illus-cabin', '/backgrounds/cabin.webp', '50% 44%', 'stars'),
  },
  {
    id: 'illus-greenhouse',
    name: '深空培育室',
    kind: 'illustration',
    imageUrl: '/backgrounds/greenhouse.webp',
    focusPosition: '50% 42%',
    build: () => buildIllustration('illus-greenhouse', '/backgrounds/greenhouse.webp', '50% 42%', 'spores'),
  },
  {
    id: 'illus-spaceport',
    name: '轨道晨晓',
    kind: 'illustration',
    imageUrl: '/backgrounds/spaceport.webp',
    focusPosition: '50% 44%',
    build: () => buildIllustration('illus-spaceport', '/backgrounds/spaceport.webp', '50% 44%', 'motes'),
  },
  {
    id: 'illus-moonsea',
    name: '星海月湾',
    kind: 'illustration',
    imageUrl: '/backgrounds/moonsea.webp',
    focusPosition: '50% 44%',
    build: () => buildIllustration('illus-moonsea', '/backgrounds/moonsea.webp', '50% 44%', 'moon'),
  },
];

/** 随时间流转：按本地时段自动匹配贴合当下氛围的场景。 */
export function resolveAutoScene(now: Date = new Date()): AutoSceneMatch {
  const m = now.getHours() * 60 + now.getMinutes();
  let periodId: AutoSceneMatch['periodId'];
  let periodName: string;
  let sceneId: string;
  if (m >= 300 && m < 540) {
    periodId = 'morning';
    periodName = '清晨';
    sceneId = 'illus-spaceport';
  } else if (m >= 540 && m < 1020) {
    periodId = 'day';
    periodName = '昼间';
    sceneId = 'illus-greenhouse';
  } else if (m >= 1020 && m < 1200) {
    periodId = 'dusk';
    periodName = '黄昏';
    sceneId = 'eternal-dusk';
  } else if (m >= 1200 && m < 1380) {
    periodId = 'night';
    periodName = '夜航';
    sceneId = 'illus-cabin';
  } else {
    periodId = 'deep_night';
    periodName = '深夜';
    sceneId = 'illus-moonsea';
  }
  const scene = CHAT_SCENES.find((p) => p.id === sceneId) ?? CHAT_SCENES[0]!;
  return { periodId, periodName, scene };
}

/** 根据配置 id（含 'auto'）解析实际场景；'none'/'custom'/未知返回 null。 */
export function resolveChatScene(id: string, now: Date = new Date()): ChatScene | null {
  if (id === 'auto') return resolveAutoScene(now).scene;
  return CHAT_SCENES.find((p) => p.id === id) ?? null;
}
