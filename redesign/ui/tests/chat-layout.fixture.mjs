// Browser regression fixture: node tests/chat-layout.fixture.mjs, then open the generated
// chat-layout.fixture.html through the screenshot tool or a local static server.
// Uses real ChatView, Typewriter and CSS; only the renderer/network are stubbed. Native window height is fixed (330).
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
const compile = name => ts.transpileModule(readFileSync(new URL(`../src/chat/${name}.ts`, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
}).outputText;
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="./src/chat/chat.css">
<style>
@font-face{font-family:'Aliya Serif';src:url('./assets/fonts/NotoSerifSC-var.ttf')}
html,body{min-height:100vh}body{margin:0;background:#21352f}#chat-ui{top:auto;bottom:0;height:330px}
#chat-ui .msk-draw-card{border:1px solid #76595c}
</style><body><script>
(async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const frames = async n => { while (n--) await new Promise(requestAnimationFrame); };
  const events = [], samples = [], errors = [];
  let root, view;
  const invoke = async () => {};
  // 卡片可见总高（面板 + 间距 + 输入框）：外窗固定，卡片在 DOM 内伸缩。
  const cardHeight = () => Math.round((view.panel.hidden ? 0 : view.panel.getBoundingClientRect().height + 8) + view.composer.getBoundingClientRect().height + 6);
  const load = (code, imports) => { const exports = {}; new Function('exports','require',code)(exports,id => imports[id] || {}); return exports; };
  const { Typewriter } = load(${JSON.stringify(compile('typewriter'))}, {});
  const { ChatView } = load(${JSON.stringify(compile('view'))}, {
    './typewriter': {Typewriter}, '../platform': {platform:'tauri'},
    '@tauri-apps/api/core': {invoke}, './msk/control-bridge': {readControlRequest:() => null},
  });
  ChatView.prototype.bootstrap = async () => {};
  document.body.classList.add('chat-window');
  const controller = {busy:false, error:null, onCue(){}, onCancelPerformance(){}};
  view = new ChatView(controller, {}, () => {});
  root = view.root; view.screen = 'ready'; view.setOpen(true);
  let phase = 'composer';
  await document.fonts.ready; // 排除字体迟到造成的测量噪声。
  const sample = () => {
    samples.push({phase, nativeHeight:cardHeight(), panel:view.panel.hidden?0:view.panel.getBoundingClientRect().height,
      typing:!!view.typewriter?.typing, playing:view.playing});
    if (!document.documentElement.dataset.reviewReady) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  await frames(6);
  const assertComposer = label => {
    const host = root.getBoundingClientRect(), input = view.input.getBoundingClientRect(), composer = view.composer.getBoundingClientRect();
    for (const el of [view.input, view.get('.send'), view.status, view.get('.stop')]) {
      if (el.hidden || !el.getBoundingClientRect().height) continue;
      const r=el.getBoundingClientRect();
      if(r.top<host.top-1 || r.bottom>host.bottom+1) errors.push(label+' 控件被原生窗裁切: '+el.className);
    }
    if(composer.top<host.top-1 || input.height>64.5) errors.push(label+' 输入自然高度未容纳: '+composer.height);
  };
  phase='composer-normal';assertComposer(phase);
  phase='composer-long';view.input.value=Array.from({length:20},()=> '多行输入文字不会被窗口顶边裁掉。').join('\\n');view.input.oninput();await frames(8);assertComposer(phase);
  controller.busy=true;view.showPending();view.changed();view.hideReply();
  for(let i=0;!view.panel.hidden && i<120;i++)await frames(1);
  phase='composer-wait';await frames(8);assertComposer(phase);
  controller.busy=false;controller.error='真实错误消息';view.changed();view.hideReply();
  for(let i=0;!view.panel.hidden && i<120;i++)await frames(1);
  phase='composer-error';await frames(8);assertComposer(phase);
  controller.error=null;view.input.value='';view.input.oninput();view.changed();await frames(8);assertComposer('composer-restored');
  phase = 'pending'; controller.busy = true; view.showPending(); view.changed();
  await frames(8);
  let settle, renderInput;
  const settled = new Promise(resolve => {settle=resolve;});
  const paragraphs = Array.from({length:7}, (_, i) => '<div class="msk-segment"><p>' + ('这是第'+(i+1)+'页的完整回复，内容要先分页再测量。').repeat(7) + '</p></div>').join('');
  const svg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="140" height="100"><rect width="140" height="100" fill="#d595a1"/></svg>');
  const markup = paragraphs + '<div class="msk-segment msk-segment-media"><img class="msk-emoji-img" src="'+svg+'"></div>'
    + '<div class="msk-segment"><section class="msk-draw-card"><div class="msk-draw-state">等待生成图片</div><button>生成</button></section></div>';
  view.activeSession = {id:'local-fixture'};
  view.renderer = {render(input) {renderInput=input;return {settled,bind(el){el.innerHTML=markup;},cancel(){}};}};
  phase = 'staging'; controller.busy = false; view.lastBusy = true;
  controller.latest = {id:'reply-fixture',role:'assistant',status:'complete',text:'fixture'};
  view.changed();
  renderInput.onUpdate(); // A real renderer emits all segments before its network work settles.
  await frames(12);
  const stagingHeights = samples.filter(s => s.phase === 'staging').map(s => s.nativeHeight);
  if (Math.max(...stagingHeights) > 200) errors.push('隐藏的整条回复撑高了等待框: '+Math.max(...stagingHeights));
  phase = 'text'; settle(''); await frames(12);
  const textPanels = [];
  for(let i=0;i<12;i++){await frames(1);textPanels.push(view.panel.getBoundingClientRect().height);}
  view.typewriter?.finish(); await frames(6);
  textPanels.push(view.panel.getBoundingClientRect().height);
  if (Math.max(...textPanels)-Math.min(...textPanels)>2) errors.push('逐字播放期间面板高度改变: '+JSON.stringify(textPanels));
  phase = 'emoji'; view.showPage(7,true); await frames(12); view.typewriter?.finish(); await frames(6);
  await sleep(260); const emojiHeight = cardHeight();
  if (emojiHeight > 280 || emojiHeight < 170) errors.push('独立表情页高度异常: '+emojiHeight);
  phase = 'card'; view.showPage(8,true); await frames(10); view.typewriter?.finish(); await frames(6);
  phase = 'short';
  view.segments[0].innerHTML='<p>短句回复。</p>';view.showPage(0,true);await frames(8);view.typewriter?.finish();await sleep(260);
  if(cardHeight()>210) errors.push('短句仍保留大面积空白: '+cardHeight());
  await sleep(260); const expected = cardHeight();
  for(let i=0;i<8;i++){view.reportLayout();await frames(3);}
  if(cardHeight()!==expected) errors.push('重复测量产生反馈漂移: '+expected+' -> '+cardHeight());
  phase = 'pending-again'; view.showPending(); controller.busy=true;view.changed();await sleep(260);
  if(cardHeight()>200)errors.push('重复等待被旧页撑高: '+cardHeight());
  window.review = {errors,events,samples,emojiHeight};
  document.documentElement.dataset.reviewReady='true';
  document.documentElement.dataset.reviewResult=errors.length?'fail':'pass';
  if(errors.length) throw new Error(JSON.stringify(window.review));
  console.log('CHAT_LAYOUT_PASS '+JSON.stringify({events,emojiHeight,frames:samples.length}));
})();
</script>`;
writeFileSync(new URL('../chat-layout.fixture.html', import.meta.url), html);
console.log('chat-layout.fixture.html: real asynchronous rendering/typing/resize cycle, no network or chat messages');
