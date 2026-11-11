/**
 * 表演目录：表情、动作、状态三个概念的唯一权威来源（docs/PERFORMANCE.md）。
 *   - 表情：exp3.json 的持续脸，name 与 16.model3.json Expressions 一致
 *   - 动作：播一次就结束。motion = Live2D 动作（与 Motions 一致，上报 MSK）；
 *     procedural = 互动层参数微动（interaction/procedural.ts，不上报）
 *   - 状态：默认表情 + 待机动作池，桌宠自己切换，MSK 不干预
 * hint 写给 AI（随聊天请求上报），label 给设置页。
 */

export interface ExpressionDef {
  name: string;
  label: string;
  hint: string;
}

export type ActionKind = 'motion' | 'procedural';

export interface ActionDef {
  name: string;
  label: string;
  hint: string;
  kind: ActionKind;
  /** 视线类：只在指针静止、视线释放后才从待机池抽取。 */
  gaze?: boolean;
}

export interface StateDef {
  name: string;
  label: string;
  /** 默认表情；null = 中性脸。 */
  expression: string | null;
  /** 待机动作池：动作名 → 抽取权重（只收 motion）。 */
  idle: Record<string, number>;
}

export const EXPRESSIONS: readonly ExpressionDef[] = [
  { name: 'neutral', label: '平静', hint: '平静' },
  { name: 'happy', label: '开心', hint: '开心' },
  { name: 'angry', label: '生气', hint: '生气（黑脸 + 怒气符号）' },
  { name: 'annoyed', label: '不爽', hint: '不爽：只冒怒气符号，轻微皱眉别开脸，不黑脸' },
  { name: 'gloomy', label: '阴沉', hint: '阴沉：只有黑脸低头压眉，没有怒气符号' },
  { name: 'sad', label: '难过', hint: '难过' },
  { name: 'surprised', label: '惊讶', hint: '惊讶' },
  { name: 'shy', label: '害羞', hint: '害羞' },
  { name: 'sleepy', label: '困倦', hint: '困倦' },
  { name: 'smug', label: '得意', hint: '得意' },
  { name: 'speechless', label: '无语', hint: '无语' },
  { name: 'worried', label: '担忧', hint: '担心' },
  { name: 'serious', label: '认真', hint: '认真' },
  { name: 'hit', label: '受击', hint: '受打击' },
];

export const ACTIONS: readonly ActionDef[] = [
  { name: 'nod', label: '点头', hint: '点头附和', kind: 'motion' },
  { name: 'sway', label: '摇摆', hint: '摇摆身体', kind: 'motion' },
  { name: 'shake', label: '摇头', hint: '摇头', kind: 'motion' },
  { name: 'stretch', label: '伸展', hint: '伸懒腰', kind: 'motion' },
  { name: 'wave', label: '挥手', hint: '挥手打招呼', kind: 'motion' },
  { name: 'doubt', label: '疑惑', hint: '歪头疑惑', kind: 'motion' },
  { name: 'fume', label: '气得发抖', hint: '气得发抖', kind: 'motion' },
  { name: 'yawn', label: '哈欠', hint: '打哈欠', kind: 'motion' },
  { name: 'cheerful_bounce', label: '开心雀跃', hint: '开心地轻弹上半身，笑着逐渐收住（不离地跳跃）', kind: 'motion' },
  { name: 'shy_sway', label: '撒娇', hint: '撒娇：小臂内折藏在外套后、低头轻晃，自动渐入脸红并随收尾淡出；不替换当前表情（非手指交握）', kind: 'motion' },
  { name: 'puff', label: '鼓腮', hint: '鼓起腮帮子扭头生闷气，偷瞄一眼后泄气', kind: 'motion' },
  { name: 'kiss', label: '飞吻', hint: '凑近嘟嘴飞吻，弹回后眨单眼笑', kind: 'motion' },
  { name: 'sob', label: '委屈', hint: '委屈得眼泪汪汪抽泣两下，吸鼻子忍住', kind: 'motion' },
  { name: 'deadpan', label: '无语', hint: '愣住后换成无语眼慢慢耷拉，叹口气', kind: 'motion' },
  { name: 'look_around', label: '张望', hint: '左右张望，像在找东西或好奇四周', kind: 'motion', gaze: true },
  { name: 'daydream', label: '发呆', hint: '发呆走神：视线飘向上方、眼皮半垂，最后眨眼回神', kind: 'motion', gaze: true },
  { name: 'notice', label: '回神', hint: '回过神来：轻微一惊、挑眉眨眼后转成微笑', kind: 'motion' },
  { name: 'acknowledge', label: '轻点头', hint: '小幅点头回应', kind: 'procedural' },
  { name: 'tilt', label: '闭眼歪头', hint: '眯眼歪一下头', kind: 'procedural' },
  { name: 'nuzzle', label: '蹭手', hint: '闭眼把头蹭向触点一侧，带一点红晕', kind: 'procedural' },
  { name: 'flinch', label: '缩一下', hint: '被戳得缩头眯眼，再红着脸回来', kind: 'procedural' },
  { name: 'blush', label: '脸红', hint: '只泛起红晕', kind: 'procedural' },
  { name: 'ear_blink', label: '单眼眨', hint: '被碰的一侧眨眼并轻偏头', kind: 'procedural' },
  { name: 'eyes_widen', label: '睁大眼', hint: '吓得睁大眼睛', kind: 'procedural' },
  { name: 'tie_tug', label: '被拽领带', hint: '头被拽得往下一点再抬起', kind: 'procedural' },
  { name: 'leg_pout', label: '扭头', hint: '扭头半眯眼，脸微红', kind: 'procedural' },
  { name: 'look_back', label: '回头看', hint: '朝触点一侧回头看，眨眼再转回', kind: 'procedural' },
  { name: 'landing', label: '落地', hint: '被放下时轻轻一顿', kind: 'procedural' },
];

export const STATES: readonly StateDef[] = [
  { name: 'neutral', label: '平静', expression: null, idle: {
    nod: 1, sway: 1.2, shake: 0.8, stretch: 0.9, wave: 0.7, doubt: 0.8, fume: 0.6, yawn: 0.7,
    cheerful_bounce: 0.45, shy_sway: 0.4, puff: 0.35, kiss: 0.25, sob: 0.2, deadpan: 0.3,
    look_around: 1, daydream: 0.9,
  } },
  { name: 'happy', label: '开心', expression: 'happy', idle: {
    nod: 1.5, sway: 1.9, wave: 1.75, stretch: 0.9, doubt: 0.8, cheerful_bounce: 1.35, shy_sway: 0.8,
    kiss: 0.6, look_around: 1.3, daydream: 0.5,
  } },
  { name: 'shy', label: '害羞', expression: 'shy', idle: {
    nod: 2.5, sway: 1.2, wave: 0.85, shy_sway: 1.6, puff: 0.5, kiss: 0.5,
    look_around: 1, daydream: 0.9,
  } },
  { name: 'angry', label: '生气', expression: 'angry', idle: {
    shake: 2, fume: 2.1, puff: 1.05, sway: 1.2, nod: 1, deadpan: 0.35,
    look_around: 1, daydream: 0.3,
  } },
  { name: 'sad', label: '难过', expression: 'sad', idle: {
    sway: 2.4, sob: 0.8, nod: 1, stretch: 0.9, look_around: 1, daydream: 1.6,
  } },
  { name: 'sleepy', label: '困倦', expression: 'sleepy', idle: {
    yawn: 2.45, stretch: 2.25, sway: 1.2, nod: 1, look_around: 0.4, daydream: 2.25,
  } },
  { name: 'smug', label: '得意', expression: 'smug', idle: {
    sway: 2.4, nod: 1, cheerful_bounce: 0.7, kiss: 0.5, wave: 0.7, puff: 0.35,
    look_around: 1, daydream: 0.9,
  } },
  { name: 'curious', label: '好奇', expression: null, idle: {
    doubt: 2.4, nod: 1, sway: 1.2, cheerful_bounce: 0.45,
    look_around: 2.5, daydream: 0.9,
  } },
  { name: 'speechless', label: '无语', expression: 'speechless', idle: {
    deadpan: 1.2, doubt: 1.6, puff: 0.5, shake: 0.8, sway: 1.2, nod: 1,
    look_around: 1, daydream: 0.9,
  } },
];

const byName = <T extends { name: string }>(list: readonly T[]) =>
  new Map(list.map(item => [item.name, item]));

export const EXPRESSION_BY_NAME = byName(EXPRESSIONS);
export const ACTION_BY_NAME = byName(ACTIONS);
export const STATE_BY_NAME = byName(STATES);

/** Live2D 动作名（= 16.model3.json Motions 组名）。 */
export const MOTION_NAMES: readonly string[] = ACTIONS.filter(a => a.kind === 'motion').map(a => a.name);
export const PROCEDURAL_NAMES: readonly string[] = ACTIONS.filter(a => a.kind === 'procedural').map(a => a.name);

export function isMotion(name: string): boolean {
  return ACTION_BY_NAME.get(name)?.kind === 'motion';
}

export function isGazeAction(name: string): boolean {
  return ACTION_BY_NAME.get(name)?.gaze === true;
}
