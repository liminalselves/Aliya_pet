import { loadMskConfig } from './msk-config-helper.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const root = new URL('../', import.meta.url);

function load(name, imports = {}, globals = {}) {
  const code = ts.transpileModule(readFileSync(new URL(`src/${name}.ts`, root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    require: id => {
      if (imports[id]) return imports[id];
      if (['./config', '../msk/config'].includes(id)) return loadMskConfig();
      throw new Error(`unexpected require: ${id}`);
    },
    console, setTimeout, clearTimeout, performance,
    ...globals,
  });
  return exports;
}

const render = load('chat/render');
const esc = load('chat/rendering/esc');
const rulesMod = load('chat/rendering/rules');
const segments = load('chat/rendering/segments');
const tokens = load('chat/rendering/tokens');
const draw = load('chat/rendering/draw');
const emoji = load('chat/rendering/emoji');
const manifest = load('chat/performance-manifest');
const composeMod = load('chat/rendering/compose', {
  '../render': render,
  './esc': esc,
  './emoji': emoji,
  './rules': rulesMod,
  './segments': segments,
  './tokens': tokens,
  '../performance-manifest': manifest,
});
const rendererMod = load('chat/rendering/renderer', {
  './compose': composeMod,
  './draw': draw,
  './esc': esc,
  './emoji': emoji,
  './styles': { ensureMskStyles: () => {} },
}, { AbortController, WeakRef });

// vm 上下文里创建的数组/对象原型不同，deepEqual 前先还原成宿主plain对象。
const plain = value => JSON.parse(JSON.stringify(value));

const { applyDisplayRules, normalizeRegexRules } = rulesMod;
const { splitAgentMessageIntoSegments, agentSegmentDelayMs } = segments;
const { scanAgentTokens } = tokens;
const { composeMessage } = composeMod;
const { MskMessageRenderer } = rendererMod;

test('生成配图设置默认开启，兼容旧设置并持久化开关', () => {
  let stored = JSON.stringify({ scale: 1.2, mirror: true });
  const { loadSettings, saveSettings } = load('settings', {}, {
    localStorage: {
      getItem: () => stored,
      setItem: (_key, value) => { stored = value; },
    },
  });
  assert.equal(loadSettings().showGeneratedImages, true);
  saveSettings({ ...loadSettings(), showGeneratedImages: false });
  assert.equal(loadSettings().showGeneratedImages, false);
  assert.equal(loadSettings().scale, 1.2);
  assert.equal(loadSettings().mirror, true);
  saveSettings({ ...loadSettings(), showGeneratedImages: true });
  assert.equal(loadSettings().showGeneratedImages, true);
  stored = null;
  assert.equal(loadSettings().showGeneratedImages, true);
});

test('隐藏生成配图剥离标记和独立配图页，保留正文、表演、贴纸与用户附图', () => {
  const options = { role: 'assistant', stickersEnabled: true, showGeneratedImages: false,
    resolveSticker: () => ({ url: 'https://files.example/wave.png', type: 'image/png' }),
    resolveEmoji: () => ({ name: 'smile', url: 'https://files.example/smile.png' }) };
  for (const segmented of [false, true]) {
    const hidden = composeMessage('你好\n[[agent_draw tag=秘密提示词]]\n再见', { ...options, segmented });
    assert.equal(hidden.draws.length, 0);
    assert.doesNotMatch(hidden.html, /msk-draw|agent_draw|秘密提示词|\u0000/);
    assert.match(hidden.html, /你好/);
    assert.match(hidden.html, /再见/);
    if (segmented) assert.equal((hidden.html.match(/class="msk-segment"/g) ?? []).length, 2);
    assert.equal(composeMessage('  [[agent_draw tag=only]]  ', { ...options, segmented }).html, '');
    const inline = composeMessage('前[[agent_draw tag=a]]后[[agent_draw tag=b]]末', { ...options, segmented });
    assert.match(inline.html, /前/);
    assert.match(inline.html, /后/);
    assert.match(inline.html, /末/);
    assert.doesNotMatch(inline.html, /msk-draw|agent_draw/);
  }
  const otherMedia = composeMessage('[[agent_cue express=happy]]\n[[agent_sticker key=wave]]\n:smile:\n[[agent_draw tag=a]]', { ...options, segmented: true });
  assert.match(otherMedia.html, /msk-cue/);
  assert.match(otherMedia.html, /msk-sticker msk-zoom/);
  assert.match(otherMedia.html, /msk-emoji-img/);
  const user = composeMessage('[[agent_draw tag=user]]', { ...options, role: 'user',
    file: { type: 'image/png', url: 'https://files.example/user.png' } });
  assert.match(user.html, /agent_draw tag=user/);
  assert.match(user.html, /msk-attachment-img/);
});

test('隐藏生成配图时新消息和历史消息均不请求生图接口，同一渲染器可重新开启', async () => {
  const calls = [];
  let visible = false;
  const renderer = new MskMessageRenderer({
    api: async endpoint => { calls.push(endpoint); return null; },
    autoDraw: false,
    get showGeneratedImages() { return visible; },
  });
  for (const liveArrived of [false, true]) {
    const task = renderer.render({ sessionId: 's1', messageId: 'm1',
      text: '你好\n[[agent_draw tag=hidden]]', role: 'assistant', segmented: true, liveArrived });
    const html = await task.settled;
    assert.match(html, /你好/);
    assert.doesNotMatch(html, /msk-draw|agent_draw|尚未生成|立即生成/);
  }
  assert.equal(calls.length, 0);
  visible = true;
  const html = await renderer.render({ sessionId: 's1', messageId: 'm2',
    text: '[[agent_draw tag=visible]]', role: 'assistant' }).settled;
  assert.deepEqual(calls, ['agents/images/placeholder-status']);
  assert.match(html, /尚未生成/);
  assert.match(html, /立即生成/);
});

test('分页独立表情与贴纸标记为大图页；记录中的行内表情不放大', () => {
  const options = { role: 'assistant', stickersEnabled: true,
    resolveEmoji: () => ({ url: 'https://files.example/smile.png' }),
    resolveSticker: () => ({ url: 'https://files.example/wave.png', type: 'image/png' }) };
  for (const token of [':smile:', '[[agent_sticker key=wave]]']) {
    const paged = composeMessage(token, { ...options, segmented: true }).html;
    assert.match(paged, /class="msk-segment msk-segment-media"><img/);
    assert.doesNotMatch(composeMessage(`早安 ${token}，你好`, options).html, /msk-segment-media/);
  }
  assert.doesNotMatch(composeMessage('普通文字', { ...options, segmented: true }).html, /msk-segment-media/);
});

test('正则显示规则：按角色与 hide 效果过滤、按数组顺序串行、非法规则跳过', () => {
  const rules = normalizeRegexRules([
    { id: 'a', pattern: '\\[内心[^\\]]*\\]', targets: ['assistant'], effects: ['hide', 'aiInvisible'] },
    { id: 'b', pattern: '机密', targets: ['user'], effects: ['hide'] },
    { id: 'c', pattern: '(', targets: ['assistant'], effects: ['hide'] }, // 非法 pattern
    { id: 'd', pattern: 'ai可见', targets: ['assistant'], effects: ['aiInvisible'] }, // 仅 LLM 侧
    { id: 'e', pattern: '第二层', targets: ['assistant'], effects: ['hide'] },
    { id: 'f', pattern: 'x', targets: [], effects: ['hide'] }, // 空 targets
    'garbage',
  ]);
  assert.equal(rules.length, 4); // d 仅 aiInvisible，仍是合法规则，只是客户端不应用
  const text = '[内心独白]你好机密ai可见第二层';
  assert.equal(applyDisplayRules(text, rules, 'assistant'), '你好机密ai可见');
  assert.equal(applyDisplayRules(text, rules, 'user'), '[内心独白]你好ai可见第二层');
  assert.equal(applyDisplayRules(undefined, rules, 'assistant'), '');
});

test('展示分段与 misskey 权威行为一致：代码块/表格/列表/引用/HTML/跨行占位符保持完整', () => {
  const source = [
    '开头',
    '```ts',
    'const value = 1;',
    '```',
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '- one',
    '  continuation',
    '- two',
    '> quote one',
    '> quote two',
    '<div>',
    '<span>content</span>',
    '</div>',
    '[[agent_draw size=portrait tag=girl,',
    'park]]',
    '结尾',
  ].join('\n');
  assert.deepEqual(plain(splitAgentMessageIntoSegments(source)), [
    '开头',
    '```ts\nconst value = 1;\n```',
    '| A | B |\n| --- | --- |\n| 1 | 2 |',
    '- one\n  continuation\n- two',
    '> quote one\n> quote two',
    '<div>\n<span>content</span>\n</div>',
    '[[agent_draw size=portrait tag=girl,\npark]]',
    '结尾',
  ]);
  assert.deepEqual(plain(splitAgentMessageIntoSegments('第一段\n\n第二段')), ['第一段', '第二段']);
  const longProse = '这是第一句，用来确认很长的回复不会继续挤在同一个播放页里。'.repeat(3) + '这是最后一句。';
  const prosePages = plain(splitAgentMessageIntoSegments(longProse));
  assert.ok(prosePages.length > 1);
  assert.equal(prosePages.join(''), longProse);
  assert.ok(prosePages.every(page => page.length <= 72));
  const markdownLine = `请查看 [说明](https://example.com/${'x'.repeat(120)})`;
  assert.deepEqual(plain(splitAgentMessageIntoSegments(markdownLine)), [markdownLine]);
  assert.deepEqual(plain(splitAgentMessageIntoSegments('---\n正文')), ['正文']);
  assert.deepEqual(plain(splitAgentMessageIntoSegments('   \n  ')), []);
  assert.deepEqual(plain(splitAgentMessageIntoSegments('')), []);
  assert.ok(agentSegmentDelayMs('短') >= 1000 && agentSegmentDelayMs('x'.repeat(500)) <= 3000);
});

test('token 扫描：贴纸/表情按条件切分，其余保持字面；draw 跨段连续编号', () => {
  const stickers = { 'wave-cat': { url: 'https://files.example/wave.gif' } };
  const emojis = { smile: { url: 'https://files.example/smile.png' } };
  const opts = (over = {}) => ({
    role: 'assistant',
    stickersEnabled: true,
    drawEnabled: true,
    resolveSticker: key => stickers[key],
    resolveEmoji: name => emojis[name],
    ...over,
  });
  const text = '早安[[agent_sticker key=wave-cat]]现在是12:30:45哦:smile:未知名:zzz:';
  const parts = plain(scanAgentTokens(text, opts()));
  assert.deepEqual(parts.filter(p => p.type !== 'text').map(p => p.type), ['sticker', 'emoji']);
  const sticker = parts.find(p => p.type === 'sticker');
  assert.equal(sticker.key, 'wave-cat');
  const emojiPart = parts.find(p => p.type === 'emoji');
  assert.equal(text.slice(emojiPart.start, emojiPart.end), ':smile:');
  // 字面保留：:zzz: 未命中表情表、12:30:45 不切分
  const textParts = parts.filter(p => p.type === 'text').map(p => text.slice(p.start, p.end));
  assert.ok(textParts.some(t => t.includes('12:30:45')), textParts.join('|'));
  assert.ok(textParts.some(t => t.includes(':zzz:')));
  // 贴纸关闭或用户消息：贴纸记号变回普通文本
  const literal = plain(scanAgentTokens('[[agent_sticker key=wave-cat]]', opts({ stickersEnabled: false })));
  assert.deepEqual(literal.map(p => p.type), ['text']);
  const userScan = plain(scanAgentTokens('[[agent_sticker key=wave-cat]]', opts({ role: 'user' })));
  assert.deepEqual(userScan.map(p => p.type), ['text']);
  // draw 编号带偏移；尺寸缺省回退 portrait
  const d1 = plain(scanAgentTokens('[[agent_draw tag=a]]', opts({ drawIndexOffset: 2 })));
  assert.deepEqual(d1.find(p => p.type === 'draw'), { type: 'draw', start: 0, end: 20, index: 2, size: 'portrait', tag: 'a' });
  const d2 = scanAgentTokens('[[agent_draw size=landscape tag=b]]', opts({ drawIndexOffset: 2 }));
  assert.equal(d2.find(p => p.type === 'draw').index, 2);
  assert.equal(d2.find(p => p.type === 'draw').size, 'landscape');
  // 用户消息不切分 draw（compose 只对 assistant 开启 drawEnabled）
  const userDraw = scanAgentTokens('[[agent_draw tag=a]]', opts({ role: 'user', drawEnabled: false }));
  assert.deepEqual(plain(userDraw).map(p => p.type), ['text']);
});

test('贴纸与附件地址规则：动图保原图、其余优先缩略图；附件要求图片类型或回退', () => {
  const { stickerImageUrl, attachmentImageUrl, normalizeEmojiList, buildEmojiMap } = emoji;
  assert.equal(stickerImageUrl({ type: 'image/gif', url: 'a.gif', thumbnailUrl: 't.webp' }), 'a.gif');
  assert.equal(stickerImageUrl({ type: 'image/apng', url: 'a.png', thumbnailUrl: 't.png' }), 'a.png');
  assert.equal(stickerImageUrl({ type: 'image/png', url: 'a.png', thumbnailUrl: 't.png' }), 't.png');
  assert.equal(stickerImageUrl({ type: 'image/png', thumbnailUrl: 't.png' }), 't.png');
  assert.equal(stickerImageUrl({ type: 'image/png' }), null);
  assert.equal(attachmentImageUrl({ type: 'image/png', url: 'a.png' }), 'a.png');
  assert.equal(attachmentImageUrl({ url: 'a.png' }), 'a.png'); // timeline 可能省略 type
  assert.equal(attachmentImageUrl({ type: 'video/mp4', url: 'a.mp4' }), null);
  assert.equal(attachmentImageUrl(null), null);
  const list = plain(normalizeEmojiList([{ name: 'smile', url: 'u1' }, { name: '' }, null, { name: 'broken' }]));
  assert.deepEqual(list, [{ name: 'smile', url: 'u1' }, { name: 'broken', url: null }]);
  assert.equal(buildEmojiMap(list).get('smile').url, 'u1');
});

test('生图状态与文案：地址回退、封禁识别、错误码中文文案', () => {
  const { drawImageUrl, isDrawBlocked, drawErrorText, drawViewOf, drawStatusText, isDrawUnavailableCode, apiErrorCode } = draw;
  assert.equal(drawImageUrl({ url: 'u', thumbnailUrl: 't' }), 'u');
  assert.equal(drawImageUrl({ thumbnailUrl: 't' }), 't');
  assert.equal(drawImageUrl({ status: 'blocked', url: null }), null);
  assert.equal(drawImageUrl(null), null);
  assert.ok(isDrawBlocked({ status: 'blocked' }));
  assert.ok(isDrawBlocked({ isBlocked: true }));
  assert.equal(drawViewOf({ status: 'succeeded', url: 'u' }), 'image');
  assert.equal(drawViewOf({ status: 'succeeded' }), 'loading');
  assert.equal(drawViewOf({ status: 'failed', errorCode: 'AGENT_IMAGE_INSUFFICIENT_CREDIT' }), 'failed');
  assert.equal(drawViewOf({ status: 'auto_cleaned' }), 'cleaned');
  assert.equal(drawViewOf({ status: 'deleted' }), 'deleted');
  assert.equal(drawStatusText({ status: 'failed', errorCode: 'AGENT_IMAGE_NO_FREE_DRIVE_SPACE' }), '生成失败：网盘空间不足，无法保存生成图片');
  assert.equal(drawStatusText({ status: 'auto_cleaned' }), '图片已自动清理');
  assert.equal(drawErrorText(null), '生成失败');
  assert.equal(drawErrorText('SOMETHING_NEW'), 'SOMETHING_NEW');
  assert.ok(isDrawUnavailableCode('AGENT_IMAGE_DISABLED'));
  assert.ok(isDrawUnavailableCode('AGENT_IMAGE_NOT_CONFIGURED'));
  assert.equal(apiErrorCode(new Error('x')), '');
});

test('组合：规则→心率剥离→分段→卡片骨架，结构化标签全部转义并校验地址', () => {
  const composed = composeMessage(
    '看这个[[agent_draw size=landscape tag=<b>女孩&花</b>]]，开心！[[heart_rate: 90 , 120 ]]',
    {
      role: 'assistant',
      stickersEnabled: false,
      segmented: true,
      regexRules: [{ id: 'r', pattern: '，开心！', targets: ['assistant'], effects: ['hide'] }],
    },
  );
  assert.ok(composed.html.includes('msk-draw-card'));
  assert.ok(!composed.html.includes('<b>女孩'));
  assert.ok(composed.html.includes('&lt;b&gt;女孩&amp;花'));
  assert.ok(!composed.html.includes('heart_rate'));
  assert.ok(!composed.html.includes('，开心！'));
  assert.deepEqual(plain(composed.draws.map(d => d.size)), ['landscape']);
  assert.deepEqual(plain(composed.heartRate), { min: 90, max: 120 });
  // 心率上下限翻转与钳制
  const hr2 = composeMessage('[[heart_rate:400,0]]剩余', { role: 'assistant', stickersEnabled: false });
  assert.deepEqual(plain(hr2.heartRate), { min: 0, max: 300 });
  assert.ok(hr2.html.includes('剩余'));
  // 用户附件图
  const withFile = composeMessage('看看这张图', { role: 'user', stickersEnabled: false, file: { type: 'image/png', url: 'https://f.example/a.png?x=1&y=2' } });
  assert.ok(withFile.html.includes('msk-attachment'));
  assert.ok(withFile.html.includes('src="https://f.example/a.png?x=1&amp;y=2"'));
  const badFile = composeMessage('x', { role: 'user', stickersEnabled: false, file: { type: 'video/mp4', url: 'https://f.example/a.mp4' } });
  assert.ok(!badFile.html.includes('msk-attachment'));
  // 不安全地址被丢弃（附件、贴纸、表情）
  const unsafe = composeMessage('x', { role: 'user', stickersEnabled: false, file: { type: 'image/png', url: 'javascript:alert(1)' } });
  assert.ok(!unsafe.html.includes('javascript:'));
  // 贴纸渲染与缺失占位
  const stickerFile = { key: 'k', file: { type: 'image/png', thumbnailUrl: 'https://f.example/t.png' } };
  const withSticker = composeMessage('[[agent_sticker key=k]]', { role: 'assistant', stickersEnabled: true, resolveSticker: key => (key === 'k' ? stickerFile.file : undefined) });
  assert.ok(withSticker.html.includes('msk-sticker msk-zoom'));
  assert.ok(withSticker.html.includes('src="https://f.example/t.png"'));
  const missing = composeMessage('[[agent_sticker key=missing]]', { role: 'assistant', stickersEnabled: true, resolveSticker: () => undefined });
  assert.ok(missing.html.includes('msk-sticker-missing'));
  // 全站表情命中才渲染，未命中保持字面
  const withEmoji = composeMessage(':smile:', { role: 'assistant', stickersEnabled: false, resolveEmoji: name => (name === 'smile' ? { name, url: 'https://f.example/e.png' } : undefined) });
  assert.ok(withEmoji.html.includes('msk-emoji-img'));
  const noEmoji = composeMessage(':zzz:', { role: 'assistant', stickersEnabled: false });
  assert.ok(noEmoji.html.includes(':zzz:') && !noEmoji.html.includes('msk-emoji-img'));
});

test('表演指令：整段指令成隐藏 cue 页，行内残留与记录屏路径剥离', () => {
  // 分段播放：独占行指令自成一页，承载 data-express/data-play 供 view 翻页派发
  const cued = composeMessage('你好\n[[agent_cue express=happy play=wave]]\n打扰了', { role: 'assistant', stickersEnabled: false, segmented: true });
  assert.ok(cued.html.includes('<div class="msk-segment msk-cue" data-express="happy" data-play="wave"></div>'));
  assert.ok(cued.html.includes('你好') && cued.html.includes('打扰了'));
  // 仅表情 / 仅动作
  const only = composeMessage('[[agent_cue play=nod]]', { role: 'assistant', stickersEnabled: false, segmented: true });
  assert.ok(only.html.includes('<div class="msk-segment msk-cue" data-play="nod"></div>'));
  // 非分段（记录屏）：不生成 cue 页，整条指令剥离
  const flat = composeMessage('你好\n[[agent_cue express=happy]]\n打扰了', { role: 'assistant', stickersEnabled: false });
  assert.ok(!flat.html.includes('agent_cue'));
  assert.ok(flat.html.includes('你好') && flat.html.includes('打扰了'));
  // 行内残留（AI 不守独占一行）：就地剥离
  const inline = composeMessage('开心 [[agent_cue express=happy]] 呀', { role: 'assistant', stickersEnabled: false, segmented: true });
  assert.ok(!inline.html.includes('agent_cue'));
  assert.ok(inline.html.includes('开心') && inline.html.includes('呀'));
  // 畸形指令不成 cue 页，剥成空段
  assert.equal(composeMessage('[[agent_cue express=not valid]]', { role: 'assistant', stickersEnabled: false, segmented: true }).html, '');
  // 清单解析：严格语法、名字小写化、畸形返回 null
  const { parseCueSegment, stripCueTokens } = manifest;
  assert.deepEqual(plain(parseCueSegment('[[agent_cue express=HAPPY play=Wave]]')), { expression: 'happy', action: 'wave' });
  assert.equal(parseCueSegment('你好'), null);
  assert.equal(parseCueSegment('[[agent_cue]]'), null);
  assert.equal(stripCueTokens('a\n[[agent_cue play=wave]]\nb'), 'a\nb');
});

test('表演指令开场归一：首条 cue 提前到页首，其余 cue 与段落配对不动', () => {
  // 模型常输出「开场白 → cue1 → 段1 → cue2 → 段2」：仅 cue1 提到最前（表情持续，
  // 多覆盖开场白而不错位），cue2 与段2 的配对保持原位
  const src = '想看动作呀？那我一个一个给你演。\n\n[[agent_cue express=happy play=wave]]\n这个是打招呼的。\n\n[[agent_cue express=neutral play=nod]]\n这个是点头。';
  const out = composeMessage(src, { role: 'assistant', stickersEnabled: false, segmented: true });
  const order = [...out.html.matchAll(/msk-cue"([^>]*)>|<p>([^<]*)<\/p>/g)]
    .map(m => m[1] != null ? `cue${m[1].trim()}` : m[2]);
  assert.deepEqual(order, [
    'cuedata-express="happy" data-play="wave"',
    '想看动作呀？那我一个一个给你演。',
    '这个是打招呼的。',
    'cuedata-express="neutral" data-play="nod"',
    '这个是点头。',
  ]);
  // cue 已在最前则原样；无 cue 不动；cue 前无文本也不动
  const aligned = composeMessage('[[agent_cue express=happy]]\n你好\n\n[[agent_cue express=shy]]\n再见', { role: 'assistant', stickersEnabled: false, segmented: true });
  assert.ok(aligned.html.indexOf('data-express="happy"') < aligned.html.indexOf('你好'));
  assert.ok(aligned.html.indexOf('data-express="shy"') > aligned.html.indexOf('你好'));
  const noCue = composeMessage('没有指令的回复', { role: 'assistant', stickersEnabled: false, segmented: true });
  assert.ok(!noCue.html.includes('msk-cue'));
});

test('渲染器生命周期：历史查询→待手动，在线自动生成，禁用模型直接待手动', async () => {
  const calls = [];
  const api = async (endpoint, body, signal) => {
    calls.push({ endpoint, body });
    if (endpoint === 'agents/images/placeholder-status') return null;
    return { id: 'img1', status: 'succeeded', url: 'https://img.example/x.png' };
  };
  const renderer = new MskMessageRenderer({ api });
  // 历史消息：只查询，无记录转待手动
  const history = renderer.render({ sessionId: 's1', messageId: 'm1', text: '画[[agent_draw size=portrait tag=a]]好了', role: 'assistant' });
  const historyHtml = await history.settled;
  assert.equal(calls[0].endpoint, 'agents/images/placeholder-status');
  assert.equal(calls[0].body.sessionId, 's1');
  assert.equal(calls[0].body.messageId, 'm1');
  assert.equal(calls[0].body.placeholderIndex, 0);
  assert.ok(historyHtml.includes('尚未生成'));
  assert.ok(historyHtml.includes('data-msk-action="generate"'));
  assert.ok(!historyHtml.includes('[[agent_draw'));
  // 在线消息：自动生成并展示图片
  const live = renderer.render({ sessionId: 's1', messageId: 'm2', text: '[[agent_draw tag=b]]', role: 'assistant', liveArrived: true });
  const liveHtml = await live.settled;
  assert.equal(calls[1].endpoint, 'agents/images/generate-placeholder');
  assert.equal(calls[1].body.regenerate, false);
  assert.equal(calls[1].body.regenerationOfId, null);
  assert.ok(liveHtml.includes('msk-draw-image'));
  assert.ok(liveHtml.includes('src="https://img.example/x.png"'));
  assert.ok(liveHtml.includes('重新生成'));
  // 关闭自动生图：待手动
  const manual = new MskMessageRenderer({ api, autoDraw: false });
  const manualHtml = await manual.render({ sessionId: 's1', messageId: 'm3', text: '[[agent_draw tag=c]]', role: 'assistant' }).settled;
  assert.ok(manualHtml.includes('尚未生成'));
  // drawModelReady=false：不发起任何请求
  calls.length = 0;
  const noModel = new MskMessageRenderer({ api, drawModelReady: false });
  const noModelHtml = await noModel.render({ sessionId: 's1', messageId: 'm4', text: '[[agent_draw tag=d]]', role: 'assistant', liveArrived: true }).settled;
  assert.equal(calls.length, 0);
  assert.ok(noModelHtml.includes('尚未生成'));
});

test('渲染器：禁用生图回退待手动、失败展示错误、封禁隐藏图片、取消后停止更新', async () => {
  const calls = [];
  let failWith = 'AGENT_IMAGE_DISABLED';
  const api = async (endpoint, body) => {
    calls.push({ endpoint, ...body });
    if (endpoint === 'agents/images/generate-placeholder') {
      if (failWith) {
        const e = new Error('生图模型未启用');
        e.code = failWith;
        throw e;
      }
      return { id: 'img2', status: 'blocked', isBlocked: true, url: 'https://img.example/secret.png' };
    }
    return null;
  };
  const renderer = new MskMessageRenderer({ api });
  const task = renderer.render({ sessionId: 's1', messageId: 'm1', text: '[[agent_draw tag=a]]', role: 'assistant', liveArrived: true });
  const html = await task.settled;
  assert.equal(calls[0].endpoint, 'agents/images/generate-placeholder');
  assert.ok(html.includes('尚未生成'), html);
  // 恢复后手动生成得到封禁结果：不展示图片
  failWith = null;
  const task2 = renderer.render({ sessionId: 's1', messageId: 'm2', text: '[[agent_draw tag=a]]', role: 'assistant', liveArrived: true });
  const html2 = await task2.settled;
  assert.ok(html2.includes('图片已被审核封禁'));
  assert.ok(!html2.includes('secret.png'));
  // 普通失败：展示中文错误并可重试
  failWith = 'AGENT_IMAGE_INSUFFICIENT_CREDIT';
  const api2 = async (endpoint) => {
    if (endpoint === 'agents/images/generate-placeholder') {
      const e = new Error('x');
      e.code = failWith;
      throw e;
    }
    return null;
  };
  const r2 = new MskMessageRenderer({ api: api2 });
  const html3 = await r2.render({ sessionId: 's1', messageId: 'm3', text: '[[agent_draw tag=a]]', role: 'assistant', liveArrived: true }).settled;
  assert.ok(html3.includes('生成失败：智能体额度不足'));
  assert.ok(html3.includes('data-msk-action="retry"'));
  // 取消：settled 兑现且不再调用 API
  calls.length = 0;
  const ac = new AbortController();
  const api3 = async (endpoint, body, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
    setTimeout(() => resolve({ status: 'succeeded', url: 'https://img.example/late.png' }), 50);
  });
  const r3 = new MskMessageRenderer({ api: api3 });
  const task4 = r3.render({ sessionId: 's1', messageId: 'm4', text: '画', role: 'assistant', signal: ac.signal, onUpdate: () => { ac.abort(); } });
  const html4 = await task4.settled;
  assert.ok(!html4.includes('late.png'));
  assert.ok(!task4.html.includes('late.png'));
});

test('渲染器：正则规则、表情懒加载缓存、分段占位符编号连续', async () => {
  const calls = [];
  const api = async (endpoint, body) => {
    calls.push({ endpoint, ...body });
    if (endpoint === 'agents/images/placeholder-status') {
      return { status: 'succeeded', url: 'https://img.example/a.png' };
    }
    return null;
  };
  let emojiLoads = 0;
  const renderer = new MskMessageRenderer({
    api,
    regexRules: [{ id: 'r', pattern: '\\[隐藏\\]', targets: ['assistant'], effects: ['hide'] }],
    loadEmojis: async () => { emojiLoads++; return [{ name: 'smile', url: 'https://f.example/s.png' }]; },
  });
  const updates = [];
  const task = renderer.render({
    sessionId: 's1',
    messageId: 'm1',
    text: '[隐藏]早上好:smile:\n\n[[agent_draw tag=a]]\n\n[[agent_draw tag=b]]',
    role: 'assistant',
    segmented: true,
    liveArrived: true,
    onUpdate: html => updates.push(html),
  });
  const html = await task.settled;
  assert.ok(!html.includes('[隐藏]'));
  assert.ok(html.includes('msk-emoji-img'));
  assert.ok(html.includes('msk-draw-card'));
  // 两个占位符各自成卡：placeholder-status 按 0/1 各查一次（在线分支直接生成，无查询）
  assert.ok(updates.length >= 2);
  // 表情表缓存：第二条消息不再触发加载
  await renderer.render({ sessionId: 's1', messageId: 'm2', text: ':smile:', role: 'assistant', liveArrived: true }).settled;
  assert.equal(emojiLoads, 1);
  // 表情加载失败：保持字面
  const r2 = new MskMessageRenderer({ api, loadEmojis: async () => { throw new Error('x'); } });
  const html2 = await r2.render({ sessionId: 's1', messageId: 'm3', text: ':smile:', role: 'assistant' }).settled;
  assert.ok(html2.includes(':smile:'));
  assert.ok(!html2.includes('msk-emoji-img'));
});

test('MSK API 适配器：合并 i 字段、服务端错误带 code、连接失效识别', async () => {
  const client = load('chat/msk/client', {}, { AbortSignal, crypto });
  const { createMskApiCaller } = load('chat/rendering/api', { '../msk/client': client }, { AbortController });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ emojis: [] }) };
  };
  const api = createMskApiCaller({ token: 'tk', fetchImpl });
  assert.equal((await api('emojis', {})).emojis.length, 0);
  assert.equal(calls[0].url, 'https://misskey.liminalselves.top/api/emojis');
  assert.equal(calls[0].body.i, 'tk');
  const bad = createMskApiCaller({
    token: 'tk',
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'x', code: 'AUTHENTICATION_FAILED' } }) }),
  });
  await assert.rejects(() => bad('i', {}), e => e.code === 'CREDENTIAL_REQUIRED' && /重新授权/.test(e.message));
  const err = createMskApiCaller({
    token: 'tk',
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: '没有空间', code: 'AGENT_IMAGE_NO_FREE_DRIVE_SPACE' } }) }),
  });
  await assert.rejects(() => err('x', {}), e => e.code === 'AGENT_IMAGE_NO_FREE_DRIVE_SPACE' && /没有空间/.test(e.message));
});

test('同步门面保持原有安全与格式化行为，链接带 msk-link 标记', () => {
  assert.ok(!render.renderMarkdown('<script>alert(1)</script>').includes('<script>'));
  assert.ok(render.renderMarkdown('[好](https://a.b)').includes('class="msk-link" href="https://a.b"'));
  assert.ok(render.renderMarkdown('https://misskey.example/x').includes('class="msk-link"'));
  assert.ok(render.renderMarkdown('$[x2 大字]').includes('mfm-x2'));
  assert.ok(render.renderMarkdown('```js\na<b\n```').includes('language-js'));
  assert.equal(typeof render.renderInto, 'function');
});

test('字面 <br> 还原为换行（与 MSK marked 放行一致），代码围栏内保持字面', () => {
  // 段落内的 <br> 各形态（大小写/自闭合）都成行
  const html = render.renderMarkdown('第一行<br>第二行<BR/>第三行<br />第四行');
  assert.ok(html.includes('第一行<br>第二行<br>第三行<br>第四行'));
  // <br> 还原出的空行成为段落边界（与真实换行存储的消息一致）
  const paras = render.renderMarkdown('甲<br><br>乙');
  assert.ok(paras.includes('<p>甲</p>') && paras.includes('<p>乙</p>'));
  // 代码围栏内是代码内容，保持字面
  const fenced = render.renderMarkdown('```\na<br>b\n```');
  assert.ok(fenced.includes('a&lt;br&gt;b'));
  // 其他 HTML 依旧转义，不放行
  assert.ok(!render.renderMarkdown('<div>x</div>').includes('<div>'));
});
