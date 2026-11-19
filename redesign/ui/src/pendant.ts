/**
 * 鼠标吊坠窗口（pendant.html，仅 Windows）：缩小的 Aliya 用一根绳子挂在鼠标指针上。
 *
 * - 与主桌宠共存：独立的透明置顶窗口，永久鼠标穿透（Rust setup 设置），不参与互动和聊天。
 * - Rust 光标轮询线程让窗口铺满光标所在显示器，并推送 'pendant-cursor'（光标尾部 + 窗口原点，物理 px）。
 * - 本页只做物理（pendant-physics.ts）与渲染：整体摆动 + 绳子，惯性力再作为
 *   Cubism 物理的风力传给头发、裙摆。绳子末端系在头顶头发的一个网格顶点上，随头部动作移动。
 * - 开关、大小、绳长来自设置（pendantEnabled / pendantScale / pendantRopeLength），
 *   设置页改动经 'settings-changed' 实时生效。
 */

import { CubismFramework } from '@framework/live2dcubismframework';
import { CubismMatrix44 } from '@framework/math/cubismmatrix44';
import { PetModel } from './pet-model';
import { GRAVITY, PendantPhysics, RopeChain, pendantCharHeight } from './pendant-physics';
import { clampPendantRope, clampPendantScale, loadSettings, type PetSettings } from './settings';

const MAX_WIND = 1;
const FPS_ACTIVE = 60;
const FPS_IDLE = 30;
const FRAME_WAKE_LEAD_MS = 6;
const WIND_TAU_SECONDS = 0.08;

const stage = document.getElementById('stage')!;
const glCanvas = document.createElement('canvas');
const ropeCanvas = document.createElement('canvas');
// 绳子画布在下、人物在上：系在身体中心的那段绳子被身体挡住，只露出身体外的部分。
for (const c of [ropeCanvas, glCanvas]) {
  c.style.position = 'absolute';
  c.style.inset = '0';
  c.style.width = '100%';
  c.style.height = '100%';
  stage.appendChild(c);
}
const gl = glCanvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true }) as WebGL2RenderingContext | null;
const ctx2d = ropeCanvas.getContext('2d')!;

let settings: PetSettings = loadSettings();
let model: PetModel | null = null;
let charHeight = pendantCharHeight(clampPendantScale(settings.pendantScale));
const physics = new PendantPhysics({ ropeLength: clampPendantRope(settings.pendantRopeLength) });
const rope = new RopeChain();
/** 系绳顶点（离人物中心最近的网格顶点）；模型加载后选定。 */
let attach: { drawable: number; vertex: number } | null = null;
/** 最近一次光标与窗口原点（CSS px，屏幕坐标）；null = 尚未收到，不绘制。 */
let cursor: { x: number; y: number; wx: number; wy: number } | null = null;
let dpr = 1;
let running = false;
let frameQueued = false;
let timerId: ReturnType<typeof setTimeout> | null = null;
let rafId: number | null = null;
let lastTime = 0;
let prevVx = 0;
let prevVy = 0;
let windX = 0;
let windY = 0;
let reducedMotionQuery: MediaQueryList | null = null;
let tauriWindow: import('@tauri-apps/api/window').Window | null = null;

function resizeCanvases(): void {
  const next = Math.min(window.devicePixelRatio || 1, 2);
  if (next !== dpr) {
    dpr = next;
    // 跨屏 DPI 变化时 CSS 坐标系跳变：直接按当前光标复位，避免一次甩飞。
    if (cursor) resetAt(cursor.x, cursor.y);
  }
  const w = Math.max(1, Math.round(stage.clientWidth * dpr));
  const h = Math.max(1, Math.round(stage.clientHeight * dpr));
  for (const c of [glCanvas, ropeCanvas]) {
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
  }
}

/**
 * 选系绳顶点：离人物中心（静态包围盒中心）最近的可见网格顶点，避开猫耳（可隐藏）。
 * 之后每帧读它的实时位置，绳子跟着身体动；人物也绕这个点旋转。
 */
function pickAttachVertex(m: PetModel): { drawable: number; vertex: number } | null {
  const core = m.getModel();
  const b = m.getStaticBounds();
  if (!b) return null;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  let best: { drawable: number; vertex: number } | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < core.getDrawableCount(); i++) {
    if (core.getDrawableOpacity(i) < 0.5) continue;
    if (m.isEarDrawable(i)) continue;
    const v = core.getDrawableVertices(i);
    for (let j = 0; j < v.length; j += 2) {
      const d = Math.hypot(v[j] - cx, v[j + 1] - cy);
      if (d < bestDist) { bestDist = d; best = { drawable: i, vertex: j / 2 }; }
    }
  }
  return best;
}

/** 系绳顶点当前的模型坐标（含动作、物理形变）；不可用时退回静态包围盒中心。 */
function attachPoint(): { x: number; y: number } {
  const b = model!.getStaticBounds()!;
  if (attach) {
    const v = model!.getModel().getDrawableVertices(attach.drawable);
    const x = v[attach.vertex * 2], y = v[attach.vertex * 2 + 1];
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  }
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

/** 人物模型矩阵：系绳顶点 (mx, my) 钉在缓冲像素 (px, py)，绕它旋转 angle。 */
function pendantMatrix(px: number, py: number, angle: number, mx: number, my: number): Float32Array {
  const b = model!.getStaticBounds()!;
  const s = (charHeight * dpr) / (b.maxY - b.minY);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const m = new Float32Array(16);
  // 模型 y 向上、屏幕 y 向下：以系绳顶点为原点翻转 y，再旋转，最后放到系绳点。
  m[0] = cos * s; m[1] = sin * s;
  m[4] = sin * s; m[5] = -cos * s;
  m[10] = 1; m[15] = 1;
  m[12] = px - cos * s * mx - sin * s * my;
  m[13] = py - sin * s * mx + cos * s * my;
  return m;
}

function resetAt(x: number, y: number): void {
  physics.reset(x, y);
  rope.reset(x, y, physics.x, physics.y);
  prevVx = prevVy = 0;
  windX = windY = 0;
}

/** 惯性 + 身体倾斜 → Cubism 物理风力（模型坐标，单位为重力倍数）；低通滤波吸收硬截断尖峰。 */
function updatePhysicsWind(dt: number, reduce = false): void {
  if (!model || dt <= 0) return;
  if (reduce) {
    windX = windY = 0;
    model.setPhysicsWind(0, 0);
    return;
  }
  const ax = (physics.vx - prevVx) / dt;
  const ay = (physics.vy - prevVy) / dt;
  prevVx = physics.vx;
  prevVy = physics.vy;
  // 人物感受到的等效重力（屏幕坐标，y 向下）：真实重力减去自身加速度。
  const fx = -ax / GRAVITY;
  const fy = 1 - ay / GRAVITY;
  // 投影到身体坐标：右 = (cos, sin)，下 = (-sin, cos)。
  const cos = Math.cos(physics.angle), sin = Math.sin(physics.angle);
  const bx = fx * cos + fy * sin;
  const bDown = -fx * sin + fy * cos;
  // Cubism 粒子空间 y 向下，粒子受力 = 重力方向(静止时 (0,1)) × 加速度 + 风力；
  // 风力只补与静止竖直悬挂的差值，静止时为 0。
  // 实测（16.physics3.json）：风力 +x 让发丝偏向模型 −x，所以 x 取反。
  let wx = -bx, wy = bDown - 1;
  const mag = Math.hypot(wx, wy);
  if (mag > MAX_WIND) { wx *= MAX_WIND / mag; wy *= MAX_WIND / mag; }
  const k = 1 - Math.exp(-dt / WIND_TAU_SECONDS);
  windX += (wx - windX) * k;
  windY += (wy - windY) * k;
  model.setPhysicsWind(windX, windY);
}

/** 将屏幕空间的锚点方向按 -physics.angle 转入模型局部视线坐标 (0..1)。 */
function anchorLookTarget(): [number, number] {
  if (!cursor) return [0.5, 1];
  const dx = cursor.x - physics.x;
  const dy = cursor.y - physics.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= 1) return [0.5, 1];
  const ux = dx / dist;
  const uy = dy / dist;
  const cos = Math.cos(physics.angle);
  const sin = Math.sin(physics.angle);
  const localX = ux * cos + uy * sin;
  const localY = ux * sin - uy * cos;
  return [
    Math.min(1, Math.max(0, 0.5 + 0.5 * localX)),
    Math.min(1, Math.max(0, 0.5 + 0.5 * localY)),
  ];
}

/** 绳子：两端分别是指针尾部与人物头顶的系绳顶点，中间是 Verlet 链的平滑折线。 */
function drawRope(toLocal: (x: number, y: number) => number[]): void {
  ctx2d.clearRect(0, 0, ropeCanvas.width, ropeCanvas.height);
  const pts = rope.points.map(p => toLocal(p.x, p.y));
  if (pts.length < 2) return;
  ctx2d.lineCap = 'round';
  ctx2d.lineJoin = 'round';
  ctx2d.lineWidth = Math.max(1, 3.5 * dpr);
  ctx2d.strokeStyle = 'rgba(92, 64, 51, 0.9)';
  ctx2d.beginPath();
  ctx2d.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx2d.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  const last = pts[pts.length - 1];
  ctx2d.lineTo(last[0], last[1]);
  ctx2d.stroke();
}

function render(): void {
  if (!gl || gl.isContextLost()) return;
  gl.viewport(0, 0, glCanvas.width, glCanvas.height);
  gl.clearColor(0, 0, 0, 0);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.clearDepth(1.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  if (!model?.isReady() || !cursor) {
    ctx2d.clearRect(0, 0, ropeCanvas.width, ropeCanvas.height);
    return;
  }
  // 屏幕 CSS 坐标 → 窗口内缓冲像素。
  const toLocal = (x: number, y: number) => [(x - cursor!.wx) * dpr, (y - cursor!.wy) * dpr];
  const [px, py] = toLocal(physics.x, physics.y);
  const a = attachPoint();

  model.getModelMatrix().setMatrix(pendantMatrix(px, py, physics.angle, a.x, a.y));
  const projection = new CubismMatrix44();
  projection.scale(2.0 / glCanvas.width, -2.0 / glCanvas.height);
  projection.translate(-1.0, 1.0);
  model.draw(projection);
  drawRope(toLocal);
}

function isReducedMotion(): boolean {
  reducedMotionQuery ??= window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
  return reducedMotionQuery?.matches ?? false;
}

function frameIntervalMs(): number {
  return 1000 / (!isReducedMotion() && !physics.settled ? FPS_ACTIVE : FPS_IDLE);
}

function scheduleFrame(): void {
  if (!running || document.hidden || frameQueued) return;
  frameQueued = true;
  const now = performance.now();
  const wait = lastTime + frameIntervalMs() - now - FRAME_WAKE_LEAD_MS;
  const due = wait > 1;
  const run = () => {
    timerId = null;
    rafId = requestAnimationFrame((t) => {
      rafId = null;
      frameQueued = false;
      frame(t, due);
    });
  };
  if (due) timerId = setTimeout(run, wait);
  else run();
}

function frame(t: number, due = false): void {
  if (!running || document.hidden) return;
  const interval = frameIntervalMs();
  if (!due && t - lastTime < interval - 1) {
    scheduleFrame();
    return;
  }
  const dt = Math.min(0.05, Math.max(0.001, (t - lastTime) / 1000));
  lastTime = t;
  resizeCanvases();
  const reduce = isReducedMotion();
  if (cursor) {
    if (reduce) {
      // 少动态效果：保持竖直垂挂于光标下方，不做甩动摆荡与物理风。
      resetAt(cursor.x, cursor.y);
    } else if (physics.step(cursor.x, cursor.y, dt)) {
      rope.step(physics.anchorX, physics.anchorY, physics.x, physics.y, physics.config.ropeLength, dt);
    } else {
      resetAt(cursor.x, cursor.y);
    }
  }
  updatePhysicsWind(dt, reduce);
  if (model?.isReady()) {
    const [lx, ly] = anchorLookTarget();
    model.setLookTarget(lx, ly);
    model.update(dt);
  }
  render();
  scheduleFrame();
}

function start(): void {
  if (running) return;
  running = true;
  lastTime = performance.now();
  scheduleFrame();
}

function stop(): void {
  running = false;
  frameQueued = false;
  if (timerId !== null) { clearTimeout(timerId); timerId = null; }
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  cursor = null;
  windX = windY = 0;
  prevVx = prevVy = 0;
  // 清掉最后一帧，重新显示时不闪出旧位置。
  ctx2d.clearRect(0, 0, ropeCanvas.width, ropeCanvas.height);
  if (gl && !gl.isContextLost()) {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
}

/** 首次开启时才加载模型：默认关闭，窗口预创建但不占模型与贴图内存。 */
let loading: Promise<void> | null = null;
function ensureModel(): Promise<void> {
  loading ??= (async () => {
    const url = '/live2d/aliya/16.model3.json';
    const buffer = await (await fetch(url)).arrayBuffer();
    const m = new PetModel();
    await m.loadFromSetting(buffer, buffer.byteLength, url.substring(0, url.lastIndexOf('/') + 1), {
      gl: gl!,
      frameBuffer: gl!.getParameter(gl!.FRAMEBUFFER_BINDING),
      shaderPath: '/shaders/',
    });
    // 猫耳显隐跟主桌宠一致。
    m.setCatEarsVisible(settings.showCatEars, true);
    m.update(0);
    attach = pickAttachVertex(m);
    model = m;
  })().catch((error) => {
    loading = null;
    throw error;
  });
  return loading;
}

/** 按设置显示/隐藏吊坠并调整窗口大小。 */
async function applySettings(s: PetSettings): Promise<void> {
  settings = s;
  charHeight = pendantCharHeight(clampPendantScale(s.pendantScale));
  physics.config.ropeLength = clampPendantRope(s.pendantRopeLength);
  if (!tauriWindow) return;
  if (s.pendantEnabled && !model) await ensureModel();
  if (!s.pendantEnabled || !model?.isReady()) {
    stop();
    await tauriWindow.hide().catch(() => {});
    return;
  }
  model.setCatEarsVisible(s.showCatEars);
  // 窗口尺寸与位置由 Rust 光标线程管理（铺满光标所在显示器）。
  await tauriWindow.show().catch(() => {});
  start();
}

async function main(): Promise<void> {
  if (!gl) throw new Error('WebGL2 初始化失败');
  while (!coreReady()) await new Promise(r => setTimeout(r, 50));
  CubismFramework.startUp();
  CubismFramework.initialize();

  const winMod = await import('@tauri-apps/api/window');
  tauriWindow = winMod.getCurrentWindow();
  const ev = await import('@tauri-apps/api/event');
  await ev.listen<{ x: number; y: number; wx: number; wy: number }>('pendant-cursor', (e) => {
    const p = e.payload;
    if (![p?.x, p?.y, p?.wx, p?.wy].every(Number.isFinite)) return;
    const k = window.devicePixelRatio || 1;
    const first = cursor === null;
    cursor = { x: p.x / k, y: p.y / k, wx: p.wx / k, wy: p.wy / k };
    if (first) resetAt(cursor.x, cursor.y);
  });
  await ev.listen<PetSettings>('settings-changed', (e) => {
    if (e.payload && typeof e.payload === 'object') {
      applySettings({ ...settings, ...e.payload }).catch(error => console.error('[pendant] apply failed', error));
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && running) {
      lastTime = performance.now();
      scheduleFrame();
    }
  });

  await applySettings(loadSettings());
}

function coreReady(): boolean {
  try {
    Live2DCubismCore.Version.csmGetLatestMocVersion();
    const b = new ArrayBuffer(64);
    Live2DCubismCore.Version.csmGetMocVersion(new Uint8Array(b), b.byteLength);
    return true;
  } catch {
    return false;
  }
}

main().catch(error => console.error('[pendant] startup failed', error));
