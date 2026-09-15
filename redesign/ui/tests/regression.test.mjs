import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,readdirSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const root=new URL('../',import.meta.url);
test('正式模型的纹理、动作、表情及物理参数引用完整',()=>{
 const base=new URL('assets/live2d/aliya/',root);
 const json=file=>JSON.parse(readFileSync(new URL(file,base)));
 const refs=json('16.model3.json').FileReferences;
 const ids=new Set(json(refs.DisplayInfo).Parameters.map(p=>p.Id));
 assert.equal(readFileSync(new URL(refs.Moc,base)).subarray(0,4).toString(),'MOC3');
 assert.equal(Object.keys(refs.Motions).length,9);assert.equal(refs.Expressions.length,12);
 for(const name of refs.Textures){const bytes=readFileSync(new URL(name,base));assert.equal(bytes.readUInt32BE(16),2048);assert.equal(bytes.readUInt32BE(20),2048)}
 for(const motions of Object.values(refs.Motions))for(const motion of motions)for(const curve of json(motion.File).Curves){if(curve.Target==='Parameter')assert.ok(ids.has(curve.Id),curve.Id)}
 for(const expression of refs.Expressions)for(const p of json(expression.File).Parameters)assert.ok(ids.has(p.Id),p.Id);
 for(const group of json(refs.Physics).PhysicsSettings){for(const p of group.Input)assert.ok(ids.has(p.Source.Id),p.Source.Id);for(const p of group.Output)assert.ok(ids.has(p.Destination.Id),p.Destination.Id)}
 for(const id of ['Param30','Param31','Param36'])assert.ok(ids.has(id));
});
function load(name,imports={},globals={}){
 const code=ts.transpileModule(readFileSync(new URL(`src/${name}.ts`,root),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
 const exports={};vm.runInNewContext(code,{exports,require:id=>imports[id]??{},console,setTimeout,clearTimeout,performance,...globals});return exports;
}
const {GazeController}=load('gaze');

const {HandRaiseChannel}=load('overlay');
function waveHarness(native=true){
 const values=new Map();
 const ids=['r1','r2','r3','r4','r5'];
 const channel=new HandRaiseChannel(native?[]:ids,native?{enabled:'Param30',forearm:'Param31',hand:'Param36'}:null);
 const model={setParameterValueById:(id,v)=>values.set(id,v),addParameterValueById:(id,v)=>values.set(id,(values.get(id)??0)+v)};
 return {values,channel,step(dt){values.clear();channel.apply(model,dt)}};
}
test('新版挥手在15/30/60fps均产生摆动并完整复位，不写旧手链',()=>{
 for(const fps of [15,30,60]){
  const h=waveHarness();h.channel.trigger();let min=0,max=0;
  for(let i=0;i<fps*6;i++){
   h.step(1/fps);const v=h.values.get('Param31');min=Math.min(min,v);max=Math.max(max,v);
   assert.ok([0,1].includes(h.values.get('Param30')));
   for(const [id,value] of h.values){assert.ok(['Param30','Param31','Param36'].includes(id));assert.ok(Number.isFinite(value)&&Math.abs(value)<=1)}
  }
  assert.ok(min<-.4&&max>.4);assert.equal(h.channel.raising,0);
  assert.deepEqual([...h.values.values()],[0,0,0]);
 }
});
test('挥手连续重触发和打断后复位，异常时间步不污染状态',()=>{
 const h=waveHarness();h.channel.trigger();for(let i=0;i<30;i++)h.step(1/30);
 h.channel.trigger();h.step(1/30);assert.ok(h.channel.raising>.5);
 for(const dt of [NaN,Infinity,-1]){h.step(dt);for(const value of h.values.values())assert.ok(Number.isFinite(value))}
 h.channel.release();for(let i=0;i<60;i++)h.step(1/30);
 assert.equal(h.channel.raising,0);assert.deepEqual([...h.values.values()],[0,0,0]);
 h.channel.trigger();for(let i=0;i<30;i++)h.step(1/30);assert.equal(h.values.get('Param30'),1);
});
test('当前模型继续抬起旧版五段手链，结束后停止覆盖物理',()=>{
 const h=waveHarness(false);h.channel.trigger();for(let i=0;i<30;i++)h.step(1/30);
 assert.equal(h.values.size,5);for(const v of h.values.values())assert.ok(v<-30);
 for(let i=0;i<180;i++)h.step(1/30);assert.equal(h.values.size,0);
});
test('按优先级播放及随机播放同样触发挥手，被拒绝的动作不影响当前手势',()=>{
 const {PetModel}=load('pet-model',{'@framework/model/cubismusermodel':{CubismUserModel:class{}}});
 const m=Object.create(PetModel.prototype);let triggered=0,released=0;
 Object.assign(m,{_ready:true,_motions:new Map([['wave_0',{}],['nod_0',{}]]),_setting:{getMotionCount:()=>1},_chHand:{trigger(){triggered++},release(){released++}},_motionManager:{getCurrentPriority:()=>0,stopAllMotions(){},startMotionPriority:()=>1}});
 assert.equal(m.startRandomMotion('wave',2),1);assert.equal(triggered,1);
 assert.equal(m.startMotion('nod',0,2),1);assert.equal(released,1);
 assert.equal(m.startMotion('wave',0,0),-1);assert.equal(triggered,1);
 assert.equal(m.startMotion('missing',0,2),-1);assert.equal(released,1);
});
test('受击和无语恢复专用眼型，切换与清除始终互斥且无中间值',()=>{
 const {applyFaceVariant,FACE_VARIANT_PARAMETERS}=load('face-variant');
 const values=new Map();
 const model={setParameterValueById:(id,value)=>values.set(id,value)};
 for(const [expression,want] of [['hit',[1,0,0]],['speechless',[0,0,1]],['sad',[0,1,0]],['hit',[1,0,0]],['hit',[1,0,0]],[null,[0,0,0]],['worried',[0,0,0]],['speechless',[0,0,1]],['neutral',[0,0,0]]]){
  for(const name of FACE_VARIANT_PARAMETERS) values.set(name,.6);
  applyFaceVariant(model,FACE_VARIANT_PARAMETERS,expression);
  assert.deepEqual([...FACE_VARIANT_PARAMETERS].slice(0,3).map(id=>values.get(id)),want);
  if(['hit','speechless','sad'].includes(expression)) {
   assert.deepEqual([...FACE_VARIANT_PARAMETERS].slice(3,7).map(id=>values.get(id)),[1,1,0,0]);
   for(const name of FACE_VARIANT_PARAMETERS.slice(7)) assert.equal(values.get(name),0,`${expression}: ${name} 仍残留普通眼部物理`);
  } else {
   for(const name of FACE_VARIANT_PARAMETERS.slice(3)) assert.equal(values.get(name),.6,'普通表情仍保留眨眼、视线与眼部物理');
  }
 }
});
function gaze(){const values=new Map();return {controller:new GazeController({updateParameters(){}},'x','y'),model:{getParameterValueById:id=>values.get(id)??0,setParameterValueById:(id,v)=>values.set(id,v),addParameterValueById:(id,v)=>values.set(id,(values.get(id)??0)+v)},values}}
test('动作期间持续跟随；交接不会叠加动作残值',()=>{
 const {controller,model,values}=gaze();controller.setTarget(1,.5);
 for(let i=0;i<120;i++){values.set('x',-18);values.set('y',0);controller.update(model,1/30,{motionActive:true,reduction:1})}
 assert.ok(values.get('x')>17);assert.ok(Math.abs(values.get('y'))<.01);
 controller.clearTarget();for(let i=0;i<120;i++){values.set('x',-10);controller.update(model,1/30,{motionActive:true,reduction:1})}
 assert.ok(Math.abs(values.get('x')+10)<.01);
});
test('全部表情角落注视受径向行程限制；非法输入不污染后续帧',()=>{
 for(const name of readdirSync(new URL('assets/live2d/aliya/expressions/',root))){
  const {controller,model,values}=gaze();controller.setExpression(name.split('.')[0]);controller.setTarget(1,0);
  controller.setTarget(NaN,Infinity);controller.update(model,NaN,{motionActive:false,reduction:1});
  for(let i=0;i<120;i++){values.clear();controller.update(model,1/30,{motionActive:false,reduction:1});assert.ok(Math.hypot(values.get('x'),values.get('y'))<=20.000001)}
 }
});
test('表情眼睑保留眨眼的全闭状态',()=>{
 for(const file of readdirSync(new URL('assets/live2d/aliya/expressions/',root))){
  const expression=JSON.parse(readFileSync(new URL(`assets/live2d/aliya/expressions/${file}`,root)));
  for(const p of expression.Parameters.filter(p=>/ParamEye[LR]Open/.test(p.Id))){assert.equal(p.Blend,'Multiply');assert.ok(p.Value>=0&&p.Value<=1);assert.equal(0*p.Value,0)}
  for(const p of expression.Parameters.filter(p=>['Param33','Param34','Param35'].includes(p.Id))) assert.equal(p.Value,0,`${file}: ${p.Id} 不能激活特殊眼睛`);
 }
});

test('动作中的特殊眼睛参数只允许零值复位，哈欠不再叠加哭眼',()=>{
 for(const file of readdirSync(new URL('assets/live2d/aliya/motions/',root))){
  const motion=JSON.parse(readFileSync(new URL(`assets/live2d/aliya/motions/${file}`,root)));
  for(const curve of motion.Curves.filter(c=>['Param33','Param34','Param35'].includes(c.Id))){
   assert.equal(curve.Segments[1],0,`${file}: ${curve.Id}`);
   for(let i=2;i<curve.Segments.length;i+=3){
    assert.equal(curve.Segments[i],0,'特殊眼睛复位必须使用线性零值曲线');
    assert.equal(curve.Segments[i+2],0,`${file}: ${curve.Id}`);
   }
  }
 }
});
test('镜像坐标只翻转一次；拖动时回中，松手后恢复',()=>{
 let target;const {BehaviorService}=load('behavior');const b=new BehaviorService(()=>({setLookTarget:(x,y)=>target=[x,y],clearLookTarget:()=>target=null}));
 b.mirrorX=true;b.updateLookTarget(.8,.25);assert.ok(Math.abs(target[0]-.2)<1e-9);assert.equal(target[1],.75);
 b.isDragging=true;b.updateLookTarget(.8,.25);assert.equal(target,null);b.isDragging=false;b.updateLookTarget(.8,.25);assert.ok(target);
});
test('镜像画布使用可见坐标而非已被CSS反转的offsetX',()=>{
 const {PetApp}=load('pet-app');const app=Object.create(PetApp.prototype);app._wrapWindow=false;app._canvas={getBoundingClientRect:()=>({left:100,top:50,width:200,height:400})};
 const p=app._eventNorm({clientX:260,clientY:150,offsetX:40,offsetY:100});assert.equal(p.nx,.8);assert.equal(p.ny,.25);
});
test('窗口允许越界；开启贴边时仅感应带内吸附（支持副屏负坐标与 DPI）',async()=>{
 for(const [pos,snap,wantMove] of [
  [[-2050,950],false,null],             // 关闭贴边：越界位置原样保留
  [[-1650,12],true,[-1650,0]],         // 顶边 12px：吸附到副屏工作区顶
  [[-2050,950],true,null],              // 开启贴边但远离感应带：仍允许越界
  [[-320,620],true,[-300,640]],         // 右/底边同时吸附（DPI 阈值 48px）
 ]){
  let moved;let saved;const api={currentMonitor:async()=>({scaleFactor:1.5,workArea:{position:{x:-1920,y:0},size:{width:1920,height:1040}}}),PhysicalPosition:class{constructor(x,y){this.x=x;this.y=y}}};
  const {PetApp}=load('pet-app',{'@tauri-apps/api/window':api,'./settings':{saveSettings:s=>{saved={...s}}}});const app=Object.create(PetApp.prototype);
  Object.assign(app,{_tauriWindow:{outerSize:async()=>({width:300,height:400}),setPosition:async p=>{moved=p}},_snapAnimToken:0,_snapHintTimer:null,_windowMoveTask:null,_settings:{snapEdges:snap},_winPhysX:pos[0],_winPhysY:pos[1],_showSnapHint(){}});
  app._onDragFinished();await new Promise(r=>setImmediate(r));
  assert.deepEqual(moved?[moved.x,moved.y]:null,wantMove);assert.deepEqual([saved.posX,saved.posY],wantMove??pos);
 }
});

test('半闭眼收小瞳孔行程，完全闭眼回中',()=>{
 const {controller,model,values}=gaze();controller.setTarget(1,0);
 for(let i=0;i<90;i++){values.clear();controller.update(model,1/30,{motionActive:false,reduction:1,eyeOpenness:.5})}
 assert.ok(Math.hypot(values.get('x'),values.get('y'))<=10.000001);
 controller.update(model,1/30,{motionActive:false,reduction:1,eyeOpenness:0});assert.equal(Math.hypot(values.get('x'),values.get('y')),0);
});

// 普通互动：用可控时钟执行真实控制器，覆盖完整的输入/恢复生命周期。
function interactionHarness() {
 let now = 0;
 const globals = {performance: {now: () => now}};
 const recognizer = load('interaction/petting-recognizer', {}, globals);
 const procedural = load('interaction/procedural', {}, globals);
 const petting = load('interaction/petting-controller', {
  './petting-recognizer': recognizer,
 }, globals);
 const {InteractionService} = load('interaction/interaction', {
  './petting-controller': petting, './procedural': procedural,
 }, globals);
 const writes = {};
 const target = {
  getInteractionParamInfo: () => ({angleXMin:-30,angleXMax:30,angleYMin:-30,angleYMax:30,angleZMin:-30,angleZMax:30,bodyXMin:-10,bodyXMax:10,eyeLMin:0,eyeLMax:1,eyeRMin:0,eyeRMax:1,hasEyes:true}),
  setInteractionOffsets: (...v) => writes.offsets=v,
  setEyeOverride: (...v) => writes.eyes=v,
  setPettingLookAtReduction: v => writes.reduced=v,
  setEarInteraction: (...v) => writes.ears=v,
  setFaceCheek: (...v) => writes.cheek=v,
 };
 let speaking=false;
 const lines=[];
 const service = new InteractionService({
  hitAreas:{isInHeadPetZone:()=>true,hitAreaAt:()=> 'face'},getTarget:()=>target,
  dialogue:{resolveSceneTag:(_scene,tag)=>({entryId:tag,pages:[{text:tag}]})},
  pettingHost:{isDialogueActive:()=>speaking,playPettingDialogue:r=>lines.push(r.entryId)},
  playCharacterAction:()=>true,
 });
 service.playClickDialogue=tag=>lines.push(tag);
 const ctx=(x=400,secondary=true,dt=1/60)=>({normX:.5,normY:.2,pxX:x,pxY:200,dtSeconds:dt,leftPressed:!secondary,isSecondary:secondary});
 return {service,writes,lines,ctx,globals,recognizer,procedural,
  speaking(v){speaking=v},advance(ms){now+=ms;service.tick(ms)},setTime(ms){now=ms},
  stroke(){for(let i=1;i<=90;i++){now+=1000/60;const t=i/60;const x=400+40*Math.sin(t*Math.PI*2);service.onPointerMove(ctx(x));service.tick(1000/60)}}};
}

test('抚摸必须往返：首次坐标无虚假速度，高频/低速采样与普通鼠标均可识别',()=>{
 const h=interactionHarness();
 for(const hz of [30,60,125,240,1000])for(const speed of [80,240]){
  const r=new h.recognizer.PettingGestureRecognizer();r.startGesture(h.ctx());
  let valid=false;let first;
  for(let i=1;i<=hz*3;i++){
   const travel=i/hz*speed;const phase=travel%120;
   const x=400+(phase<=60?phase:120-phase);
   const result=r.update(h.ctx(x,true,1/hz));first??=result;
   valid ||= result.isValid;
  }
  assert.ok(Math.abs(first.smoothedVelX)<=speed+.01,`首次采样 ${hz}/${speed}`);
  assert.ok(valid,`未识别 ${hz}Hz ${speed}px/s`);
 }
 const r=new h.recognizer.PettingGestureRecognizer();r.startGesture(h.ctx());
 for(let i=1;i<=100;i++)assert.equal(r.update(h.ctx(400+i*2)).isValid,false,'单向移动不算抚摸');
});

test('轻按头部不计抚摸，真实抚摸只计一次且结束后释放所有覆盖',()=>{
 const h=interactionHarness();const s=h.service;
 s.onPointerDown(h.ctx());h.advance(1200);s.onPointerUp(h.ctx());
 for(let i=0;i<120;i++)h.advance(1000/60);
 assert.equal(s.petting.dailyState.headPettingCountToday,0);
 assert.equal(s.petting.state,'inactive');
 s.onPointerDown(h.ctx());h.stroke();assert.equal(s.petting.state,'petting');
 s.onPointerUp(h.ctx());s.onPointerUp(h.ctx());
 for(let i=0;i<150;i++)h.advance(1000/60);
 assert.equal(s.petting.state,'inactive');assert.equal(s.petting.dailyState.headPettingCountToday,1);
 assert.deepEqual(h.writes.offsets,[0,0,0,0]);assert.equal(h.writes.eyes[0],false);assert.equal(h.writes.reduced,false);
 s.onPointerDown(h.ctx(400,false));s.onPointerUp(h.ctx(400,false));s.onClick(h.ctx(400,false),false);h.advance(150);
 assert.ok(h.writes.cheek[1]>0,'抚摸结束后的点脸反应正常');
 assert.equal(s.dragReaction.isDragging,false);
});

test('抚摸接管已有点击反应；失焦取消不会产生结束台词或残留拖动',()=>{
 const h=interactionHarness();const s=h.service;
 s.onClick(h.ctx(400,false),false);h.advance(150);assert.equal(s.procedural.isPlaying,true);
 s.onPointerDown(h.ctx());assert.equal(s.procedural.isPlaying,false);h.stroke();
 s.dragReaction.beginDrag();const n=h.lines.length;s.cancel();
 assert.equal(s.petting.state,'inactive');assert.equal(s.isBusy,false);assert.equal(h.lines.length,n);
 assert.equal(h.writes.eyes[0],false);assert.equal(h.writes.cheek[0],false);
});

test('松开无关按钮不终止右键抚摸，正在说话时抚摸台词不抢占',()=>{
 const h=interactionHarness();h.speaking(true);
 h.service.onPointerDown(h.ctx());h.stroke();
 assert.equal(h.service.onPointerUp(h.ctx(400,false)),false);
 assert.equal(h.service.petting.state,'petting');
 h.service.onPointerUp(h.ctx());assert.deepEqual(h.lines,[]);
});

test('连点按3/5/8次递进，冷却期间不累计，下次点击恢复正常',()=>{
 const h=interactionHarness();const {ClickSequenceService,ClickResult}=h.procedural;const c=new ClickSequenceService();
 const got=[];for(let i=0;i<8;i++){h.setTime(i*100);got.push(c.registerClick())}
 assert.equal(got[2],ClickResult.doubt);assert.equal(got[3],ClickResult.doubt);
 assert.equal(got[4],ClickResult.comment);assert.equal(got[7],ClickResult.cooldown);
 for(let i=0;i<20;i++){h.setTime(800+i*100);assert.equal(c.registerClick(),ClickResult.cooldown)}
 h.setTime(3800);assert.equal(c.registerClick(),ClickResult.none);
});

test('拖动与点击独立：取消不回应，快速拖动只回应一次',()=>{
 const h=interactionHarness();const s=h.service;
 s.onPointerDown(h.ctx(400,false));assert.equal(s.dragReaction.isDragging,false);
 s.dragReaction.beginDrag();s.dragReaction.onDragMove(400);s.onClick(h.ctx(),true);s.onClick(h.ctx(),true);
 assert.deepEqual(h.lines,['drag_fast']);
 s.dragReaction.beginDrag();s.dragReaction.onDragMove(500);s.cancel();s.onClick(h.ctx(),true);
 assert.deepEqual(h.lines,['drag_fast']);
});

test('统一调度阻止随机行为抢占互动/说话/暂停，结束后保留安静间隔',()=>{
 let now=0;const state={interacting:false,speaking:false,paused:false};
 const {InteractionCoordinator}=load('interaction/coordination');const c=new InteractionCoordinator(()=>state,()=>now);
 assert.equal(c.canIdle(),true);
 state.interacting=true;assert.equal(c.canIdle(),false);assert.equal(c.canSpeak('interaction'),true);
 state.speaking=true;assert.equal(c.canSpeak('interaction'),false);
 state.speaking=false;state.interacting=false;c.activity();now=2499;assert.equal(c.canIdle(),false);
 now=2500;assert.equal(c.canIdle(),true);state.paused=true;assert.equal(c.canSpeak('interaction'),false);
});

test('闲聊不抽取抚摸/点击反应或其他时段的台词',()=>{
 const {DialogueStore,timeScene}=load('dialogue/dialogue');const d=new DialogueStore();const current=timeScene(new Date());
 for(const scene of ['user_click','interaction','head_petting','morning','deep_night',current])d._files.set(scene,{entries:[{id:scene,text:scene}]});
 for(let i=0;i<100;i++)assert.ok(['user_click',current].includes(d.selectRandom().id));
});

test('气泡取消立即释放说话状态，旧异步回调不影响新会话',async()=>{
 const waits=[];const element={id:'',style:{},textContent:''};
 const {DialogueBubble}=load('dialogue/bubble',{}, {document:{createElement:()=>element},setTimeout:fn=>{waits.push(fn);return waits.length}});
 const b=new DialogueBubble({appendChild(){}});
 const first=b.play({pages:[{text:'第一句'}]});assert.equal(b.isActive,true);
 b.cancel();assert.equal(b.isActive,false);
 const second=b.play({pages:[{text:'第二句'}]});waits.shift()();await first;
 assert.equal(b.isActive,true);assert.equal(element.textContent,'第二句');
 waits.shift()();await second;assert.equal(b.isActive,false);
});

function pointerHarness(touch=false) {
 const h=interactionHarness();const canvasEvents={};const windowEvents={};
 const {PetApp}=load('pet-app',{'./platform':{platform:'browser',isTouchDevice:touch,androidShell:()=>null}},
  {...h.globals,window:{addEventListener:(name,fn)=>windowEvents[name]=fn}});
 const app=Object.create(PetApp.prototype);
 Object.assign(app,{_canvas:{addEventListener:(name,fn)=>canvasEvents[name]=fn,setPointerCapture(){},getBoundingClientRect:()=>({left:0,top:0,width:800,height:800}),width:800},
  _interaction:h.service,_hitAreas:h.service.hitAreas,_coordination:{activity(){}},_behavior:{updateLookTarget(){},clearLookTarget(){},isDragging:false},
  _snapAnimToken:0,_scaleFactor:1,_wrapWindow:false,_leftDown:false,_touchPetting:false,_dragCandidate:false,_dragging:false,
  _syncWindowMetrics(){},_moveWindowBy(){},_onDragFinished(){},_bubble:{cancel(){}}});
 app._wirePointerEvents();
 const event=(overrides={})=>({isPrimary:true,button:touch?0:2,buttons:touch?1:2,clientX:400,clientY:200,screenX:400,screenY:200,pointerType:touch?'touch':'mouse',...overrides});
 return {...h,app,canvasEvents,windowEvents,event};
}

test('真实事件接线：右键失焦可恢复，普通pointerup后的lostcapture不抹掉反馈',()=>{
 const h=pointerHarness();const e=h.canvasEvents;
 e.pointerdown(h.event());assert.equal(h.service.petting.state,'pressed');h.windowEvents.blur();
 assert.equal(h.service.petting.state,'inactive');
 e.pointerdown(h.event({button:0,buttons:1}));e.pointerup(h.event({button:0,buttons:0}));
 assert.equal(h.service.procedural.isPlaying,true);e.lostpointercapture();assert.equal(h.service.procedural.isPlaying,true);
 assert.equal(h.service.dragReaction.isDragging,false);
});

test('触屏头部轻点有反馈，未识别的大幅移动不误报为轻点',()=>{
 const h=pointerHarness(true);const e=h.canvasEvents;
 e.pointerdown(h.event());e.pointerup(h.event({buttons:0}));
 assert.equal(h.lines.length,1);assert.equal(h.service.petting.dailyState.headPettingCountToday,0);
 e.pointerdown(h.event());e.pointermove(h.event({clientX:600,screenX:600}));e.pointerup(h.event({buttons:0,clientX:600,screenX:600}));
 assert.equal(h.lines.length,1);
});

test('自动行为计时器实际遵守调度且不截断现有动作',()=>{
 const timers=new Map();let next=0,actions=0,speech=0;let allowed=false;
 const {BehaviorService}=load('behavior',{}, {setTimeout:fn=>{timers.set(++next,fn);return next},clearTimeout:id=>timers.delete(id)});
 const host={playAction(){actions++;return true},isActionPlaying:false};
 const b=new BehaviorService(()=>host);b.canIdle=()=>allowed;b.randomSpeechEnabled=true;b.onRandomSpeech=()=>speech++;b.start();
 function round(){const pending=[...timers.values()];timers.clear();for(const fn of pending)fn()}
 round();assert.equal(actions,0);assert.equal(speech,0);
 allowed=true;host.isActionPlaying=true;round();assert.equal(actions,0);
 host.isActionPlaying=false;round();assert.equal(actions,1);assert.ok(speech>0);
 b.stop();assert.equal(timers.size,0);
});

// 聊天适配器：受控流可模拟拒绝取消的服务，验证迟到事件隔离。
function streamHarness() {
 const requests=[];
 const provider={label:'测试',reply(request){
  let resolve;const queue=[];
  const state={request,push(event){if(resolve){const r=resolve;resolve=null;r({value:event,done:false})}else queue.push(event)}};
  requests.push(state);
  return {[Symbol.asyncIterator](){return this},next(){return queue.length?Promise.resolve({value:queue.shift(),done:false}):new Promise(r=>resolve=r)},return(){return Promise.resolve({done:true})}};
 }};
 const data=new Map();const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
 const {ChatController}=load('chat/controller',{}, {AbortController});
 const chat=new ChatController(provider,storage);const cues=[];chat.onCue=c=>cues.push(c);
 return {chat,requests,cues,storage,ChatController};
}
const flushChat=()=>new Promise(r=>setImmediate(r));

test('聊天停止保留片段，旧流的迟到文字和动作不能污染新回复',async()=>{
 const h=streamHarness();const first=h.chat.send('第一条');
 h.requests[0].push({type:'segment',id:'1',text:'旧片段',cue:{expression:'happy'}});await flushChat();
 h.chat.stop();assert.equal(h.chat.latest.status,'stopped');assert.equal(h.chat.latest.text,'旧片段');
 const second=h.chat.send('第二条');
 h.requests[0].push({type:'segment',id:'2',text:'迟到内容',cue:{action:'wave'}});await first;
 assert.equal(h.chat.busy,true);assert.equal(h.cues.length,1);
 h.requests[1].push({type:'segment',id:'1',text:'新的回答'});await flushChat();
 h.requests[1].push({type:'done'});await second;
 assert.equal(h.chat.latest.text,'新的回答');assert.equal(h.chat.latest.status,'complete');
 assert.equal(h.chat.busy,false);
});

test('重试替换失败的助手回复，不重复用户消息，重复片段只表演一次',async()=>{
 const h=streamHarness();const first=h.chat.send('问题');h.requests[0].push({type:'done'});await first;
 assert.equal(h.chat.canRetry,true);assert.equal(h.chat.latest.status,'error');
 const retry=h.chat.retry();assert.equal(h.chat.messages.length,2);
 h.requests[1].push({type:'segment',id:'1',text:'回答',cue:{action:'nod'}});await flushChat();
 h.requests[1].push({type:'segment',id:'1',text:'回答',cue:{action:'nod'}});await flushChat();
 h.requests[1].push({type:'done'});await retry;
 assert.equal(h.chat.latest.text,'回答');assert.equal(h.cues.length,1);assert.equal(h.chat.canRetry,false);
});

test('聊天刷新恢复记录但不恢复正在生成状态；空白输入不启动请求',async()=>{
 const h=streamHarness();await h.chat.send('   ');assert.equal(h.requests.length,0);
 const task=h.chat.send('保留的问题');h.requests[0].push({type:'segment',id:'1',text:'部分回答'});await flushChat();
 const restored=new h.ChatController(h.chat.provider,h.storage);
 assert.equal(restored.messages.length,2);assert.equal(restored.latest.text,'部分回答');
 assert.equal(restored.latest.status,'stopped');assert.equal(restored.busy,false);assert.equal(restored.canRetry,true);
 h.chat.stop();h.requests[0].push({type:'done'});await task;
});

test('聊天表演服从触摸，触摸结束恢复表情但不补播过时动作，取消后不复活',()=>{
 const {ChatPerformance}=load('chat/performance');let now=0,busy=false;const calls=[];
 const p=new ChatPerformance({expressions:()=>['happy'],actions:()=>['wave'],express:n=>calls.push(['express',n]),clearExpression:()=>calls.push(['clear']),play:n=>calls.push(['play',n]),busy:()=>busy},()=>now);
 p.cue({expression:'happy',action:'wave'});assert.equal(calls.filter(x=>x[0]==='play').length,1);
 busy=true;p.tick();assert.equal(calls.at(-1)[0],'clear');
 p.cue({expression:'happy',action:'wave'});busy=false;p.tick();
 assert.equal(calls.at(-1)[0],'express');assert.equal(calls.filter(x=>x[0]==='play').length,1);
 p.cancel();const n=calls.length;now=1000;p.tick();assert.equal(calls.length,n);assert.equal(p.active,false);
 p.cue({expression:'arbitrary',action:'arbitrary'});assert.equal(calls.length,n);
});

test('聊天画布按容纳后的角色区域命中，坐标不包含左侧对话面板',()=>{
 const {PetApp}=load('pet-app');const app=Object.create(PetApp.prototype);
 app._wrapWindow=false;app._chatView={isOpen:true};app._model={isReady:()=>true,boundsAspect:.5};
 app._canvas={getBoundingClientRect:()=>({left:300,top:0,width:200,height:600})};
 const center=app._eventNorm({clientX:400,clientY:300});assert.equal(center.nx,.5);assert.equal(center.ny,.5);
 const top=app._eventNorm({clientX:400,clientY:100});assert.equal(top.ny,0);
});

test('MSK 渲染：HTML 转义、链接白名单、MFM 函数、代码块与表格',()=>{
 const {renderMarkdown,renderInline}=load('chat/render');
 assert.ok(!renderMarkdown('<script>alert(1)</script>').includes('<script>'));
 assert.ok(renderMarkdown('[x](javascript:evil)').includes('javascript')===false||!renderMarkdown('[x](javascript:evil)').includes('href'));
 assert.ok(renderMarkdown('[好](https://a.b)').includes('href="https://a.b"'));
 assert.ok(renderMarkdown('https://misskey.example/x，').includes('，')&&!renderMarkdown('https://misskey.example/x，').includes('x，</a>'));
 assert.ok(renderMarkdown('$[x2 大字]').includes('mfm-x2'));
 assert.ok(renderMarkdown('$[fg.color=ff0000 红]').includes('color:#ff0000'));
 assert.ok(renderMarkdown('$[unknown 保留]').includes('保留'));
 assert.ok(renderMarkdown('```js\na<b\n```').includes('language-js')&&renderMarkdown('```\na<b\n```').includes('a&lt;b'));
 assert.ok(renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |').includes('<table>'));
 assert.ok(renderInline('@aliya @a@b #话题 :smile:').includes('mfm-mention'));
 assert.ok(renderMarkdown('**粗** ~~删~~ `码`').includes('<strong>粗</strong>'));
});

test('MSK 展示分段：空行分页、结构整块保留、贴纸独占一页、伪表情不切分',()=>{
 const {splitAgentMessageIntoSegments:split0}=load('chat/rendering/segments');
 // vm 跨 realm 数组不能直接 deepEqual，展开回主 realm
 const splitAgentMessageIntoSegments=(s,e)=>[...split0(s,e)];
 // 空行分页；thematic break 丢弃
 assert.deepEqual(splitAgentMessageIntoSegments('第一句。\n\n第二句。\n---\n第三句。'),['第一句。','第二句。','第三句。']);
 // 代码块跨空行保持完整一段
 assert.deepEqual(splitAgentMessageIntoSegments('说明\n\n```js\na\n\nb\n```\n\n尾巴'),['说明','```js\na\n\nb\n```','尾巴']);
 // 表格与引用各自成段
 assert.deepEqual(splitAgentMessageIntoSegments('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n> 引用一\n> 引用二'),['| a | b |\n| --- | --- |\n| 1 | 2 |','> 引用一\n> 引用二']);
 // 跨行生图占位符不切半
 assert.deepEqual(splitAgentMessageIntoSegments('前文\n\n[[agent_draw\nsize=1:1]]'),['前文','[[agent_draw\nsize=1:1]]']);
 // 单行内有效表情包独占一段；角色贴纸按语法即有效
 assert.deepEqual(splitAgentMessageIntoSegments('看这个 [[agent_sticker key=happy]] 可爱吧'),['看这个','[[agent_sticker key=happy]]','可爱吧']);
 // 全站表情须命中表情表：12:30:45 的 :30: 是伪 token，保持原文不切分
 const realEmoji=name=>name==='smile';
 assert.deepEqual(splitAgentMessageIntoSegments('时间 12:30:45 不变',realEmoji),['时间 12:30:45 不变']);
 assert.deepEqual(splitAgentMessageIntoSegments('好 :smile: 耶',realEmoji),['好',':smile:','耶']);
 // 空消息与纯空白安全兜底
 assert.deepEqual(splitAgentMessageIntoSegments('   '),[]);
 assert.deepEqual(splitAgentMessageIntoSegments('\n\n'),[]);
});

test('GAL 逐字播放间隔：短句慢、长句提速，边界分档稳定',()=>{
 const {typeDelayMs}=load('chat/typewriter');
 assert.equal(typeDelayMs(10),42);assert.equal(typeDelayMs(60),42);
 assert.equal(typeDelayMs(61),28);assert.equal(typeDelayMs(160),28);
 assert.equal(typeDelayMs(161),18);
});

test('MSK 客户端：会话只保留 Aliya 角色，时间线过滤 system 并按时间正序',async()=>{
 const {MskClient,ALIYA_CHARACTER_ID}=load('chat/msk/client',{},{AbortSignal,crypto});
 const calls=[];const fetch=async(url,init)=>{calls.push(JSON.parse(init.body));return {ok:true,status:200,json:async()=>([
  {id:'s1',characterId:ALIYA_CHARACTER_ID,name:'日常'},
  {id:'s2',characterId:'other-character',name:'别人'},
  {id:'s3',characterId:ALIYA_CHARACTER_ID,characterName:'Aliya'},
 ])}};
 const client=new MskClient('tk',fetch);
 const list=await client.listAliyaSessions();
 assert.deepEqual(list.map(s=>s.id),['s1','s3']);assert.equal(calls[0].i,'tk');
 const tl=await client.timeline('s1',30);
});

test('MSK 客户端：401 视为连接失效，send 带 clientRequestId 并读取 assistantText 与消息 id',async()=>{
 const {MskClient}=load('chat/msk/client',{},{AbortSignal,crypto});
 const bad=new MskClient('tk',async()=>({ok:false,status:401,json:async()=>({error:{message:'x'}})}));
 await assert.rejects(()=>bad.validate(),/连接已失效/);
 let sent=null;
 const ok=new MskClient('tk',async(url,init)=>{sent={url,body:JSON.parse(init.body)};return {ok:true,status:200,json:async()=>({assistantText:'我在。',assistantMessageId:'m1'})}});
 const answer=await ok.send('s1','你好');assert.equal(answer.text,'我在。');assert.equal(answer.messageId,'m1');
 assert.ok(sent.url.endsWith('/api/agents/messages/send'));
 assert.equal(sent.body.sessionId,'s1');assert.equal(sent.body.text,'你好');
 assert.equal(typeof sent.body.clientRequestId,'string');assert.ok(sent.body.clientRequestId.length>10);
 // 回执不完整（缺 assistantMessageId）不再直接判失败：轮询时间线取回复（send/timeline 按 URL 分流）
 const now=new Date().toISOString();
 const polled=new MskClient('tk',async(url)=>{
  if(url.endsWith('/api/agents/messages/send'))return{ok:true,status:200,json:async()=>({assistantText:'缺 id'})};
  return{ok:true,status:200,json:async()=>([
   {id:'u1',role:'user',content:'你好',createdAt:now},
   {id:'m9',role:'assistant',content:'轮询到的回复',createdAt:now},
  ])};
 });
 const viaPoll=await polled.send('s1','你好',undefined,'req-1',1);
 assert.equal(viaPoll.text,'轮询到的回复');assert.equal(viaPoll.messageId,'m9');
 // 已知上游错误码翻译成中文
 const pending=new MskClient('tk',async()=>({ok:false,status:409,json:async()=>({error:{code:'AGENT_REPLY_PENDING',message:'pending'}})}));
 await assert.rejects(()=>pending.send('s1','你好'),/稍等/);
 const poor=new MskClient('tk',async()=>({ok:false,status:402,json:async()=>({error:{code:'AGENT_INSUFFICIENT_CREDIT',message:'x'}})}));
 await assert.rejects(()=>poor.send('s1','你好'),/余额不足/);
 // 上游 LLM 临时失败自动有限重试，三次复用同一 clientRequestId
 const llmIds=[];let llmAttempt=0;
 const recovered=new MskClient('tk',async(_url,init)=>{const body=JSON.parse(init.body);llmIds.push(body.clientRequestId);llmAttempt++;return llmAttempt<3
  ?{ok:false,status:500,json:async()=>({error:{code:'AGENTS_LLM_FAILED',message:'Upstream LLM request failed.'}})}
  :{ok:true,status:200,json:async()=>({assistantText:'恢复了',assistantMessageId:'m10'})};});
 assert.equal((await recovered.send('s1','继续',undefined,'stable-id',1)).text,'恢复了');assert.deepEqual(llmIds,['stable-id','stable-id','stable-id']);
 const alwaysFail=new MskClient('tk',async()=>({ok:false,status:500,json:async()=>({error:{code:'AGENTS_LLM_FAILED',message:'Upstream LLM request failed.'}})}));
 await assert.rejects(()=>alwaysFail.send('s1','继续',undefined,'same-id',1),/Aliya 暂时没能生成回复/);
 // 审核拦截给出明确提示
 const audited=new MskClient('tk',async()=>({ok:true,status:200,json:async()=>({auditCategory:'sexual',auditReason:'x'})}));
 await assert.rejects(()=>audited.send('s1','你好'),/审核拦截/);
});

test('MSK 客户端：时间线过滤 system 消息并按 createdAt 升序',async()=>{
 const {MskClient}=load('chat/msk/client',{},{AbortSignal,crypto});
 const client=new MskClient('tk',async()=>({ok:true,status:200,json:async()=>([
  {id:'m2',role:'assistant',content:'晚',createdAt:'2026-01-02T00:00:00Z'},
  {id:'m0',role:'system',content:'内部',createdAt:'2026-01-01T00:00:00Z'},
  {id:'m1',role:'user',content:'早',createdAt:'2026-01-01T12:00:00Z'},
 ])}));
 assert.deepEqual((await client.timeline('s1')).map(m=>m.id),['m1','m2']);
});

test('MSK Provider：整段回复带消息 id 与情绪表情，失败重试复用 clientRequestId，空输入与中止不发请求',async()=>{
 const {localCue,MskChatProvider}=load('chat/msk/provider',{},{crypto});
 assert.equal(localCue('哈哈太好了')?.expression,'happy');
 assert.equal(localCue('今天天气不错'),undefined);
 const ac=new AbortController();
 const provider=new MskChatProvider({send:async()=>({text:'真让人担心你呀。',messageId:'m1'})},'s1');
 const events=[];
 for await(const e of provider.reply({messages:[{role:'user',text:'你好'}],signal:ac.signal}))events.push(e);
 assert.deepEqual(events.map(e=>e.type),['segment','done']);
 assert.equal(events[0].text,'真让人担心你呀。');assert.equal(events[0].messageId,'m1');
 assert.equal(events[0].cue?.expression,'worried');
 // 相同文本的失败重试复用同一 clientRequestId，避免上游产生重复消息
 const seen=[];
 const flaky=new MskChatProvider({send:async(sessionId,text,signal,requestId)=>{seen.push(requestId);if(seen.length===1)throw new Error('网络错误');return {text:'嗯。',messageId:'m2'}}},'s1');
 const run=async()=>{const out=[];for await(const e of flaky.reply({messages:[{role:'user',text:'在吗'}],signal:ac.signal}))out.push(e);return out};
 await assert.rejects(run,/网络错误/);
 const again=await run();
 assert.equal(seen.length,2);assert.equal(seen[0],seen[1]);assert.equal(again.at(-1).type,'done');
 // 空输入不发请求
 let calls=0;const p2=new MskChatProvider({send:async()=>{calls++;return {text:'x',messageId:'m3'}}},'s1');
 for await(const _ of p2.reply({messages:[{role:'user',text:'  '}],signal:ac.signal})){}
 assert.equal(calls,0);
 // 已中止：不产生任何事件也不发请求
 const ac2=new AbortController();ac2.abort();
 const got=[];for await(const e of p2.reply({messages:[{role:'user',text:'hi'}],signal:ac2.signal}))got.push(e);
 assert.equal(got.length,0);assert.equal(calls,0);
});

test('切换 Provider 清空演示消息并停止持久化；replaceHistory 替换外部历史',async()=>{
 const {ChatController}=load('chat/controller',{},{AbortController});
 const writes=[];const storage={_m:{},getItem(k){return this._m[k]??null},setItem(k,v){writes.push([k,v]);this._m[k]=v},removeItem(k){delete this._m[k]}};
 const p1={label:'demo',reply:async function*(){yield{type:'done'}}};
 const p2={label:'msk',reply:async function*(){yield{type:'done'}}};
 const c=new ChatController(p1,storage);await c.send('你好');
 assert.equal(c.messages.length,2);const before=writes.length;
 c.useProvider(p2);assert.equal(c.messages.length,0);assert.equal(c.provider.label,'msk');
 const swapped=writes.length;c.persist=false;await c.send('在吗');assert.equal(writes.length,swapped);
 c.replaceHistory([{id:'a',role:'user',text:'旧',status:'complete'},{id:'b',role:'assistant',text:'旧的回复',status:'complete'}]);
 assert.equal(c.messages.length,2);assert.equal(c.messages[1].text,'旧的回复');assert.equal(c.messages[1].status,'complete');
 assert.equal(c.busy,false);
});

test('MSK 验权：手动 token 验证保存与登出清理，web 整页跳转授权并支持回跳恢复',async()=>{
 const clientModule=load('chat/msk/client',{},{AbortSignal,crypto});
 const location={origin:'https://pet.local',pathname:'/',search:'',assigns:[],assign(u){this.assigns.push(u)}};
 const {MskAuth}=load('chat/msk/auth',{'./client':clientModule,'../../platform':{platform:'web',openUrl:async()=>true}},{URL,URLSearchParams,crypto,AbortSignal,AbortController,location,window:{location},history:{replaceState(){}}});
 const mem={_m:{},getItem(k){return this._m[k]??null},setItem(k,v){this._m[k]=v},removeItem(k){delete this._m[k]}};
 let body=null;const fetch=async(url,init)=>{body=JSON.parse(init.body);return {ok:true,status:200,json:async()=>({id:'u1',username:'w5731'})}};
 const auth=new MskAuth(mem,fetch);
 assert.equal(auth.token,'');
 const result=await auth.loginManual('  abc  ');
 assert.equal(result.user.username,'w5731');assert.equal(auth.token,'abc');assert.equal(body.i,'abc');
 assert.ok((await auth.validateSaved())?.id==='u1');
 // web：整页跳转到 MiAuth 授权页，本地记 pending 供回跳恢复；中止即取消等待
 const ac=new AbortController();
 const pending=auth.loginBrowser(ac.signal);
 await new Promise(r=>setTimeout(r,0));
 assert.equal(location.assigns.length,1);
 const url=location.assigns[0];
 assert.ok(url.includes('/miauth/'));assert.ok(url.includes('callback='));assert.ok(url.includes('permission='));
 assert.ok(mem._m['aliya_miauth_pending']);
 ac.abort(new Error('取消'));
 await assert.rejects(pending,/取消/);
 auth.logout();assert.equal(auth.token,'');assert.equal(auth.savedUser(),null);
 // 回跳恢复：pending 与 location.search 的 session 匹配时直接换 token
 mem.setItem('aliya_miauth_pending',JSON.stringify({session:'sess-1',at:Date.now()}));
 location.search='?session=sess-1';
 const resumeFetch=async u=>{assert.ok(u.includes('/api/miauth/sess-1/check'));return {ok:true,status:200,json:async()=>({ok:true,token:'tk2',user:{id:'u2',username:'aliya_fan'}})}};
 const auth2=new MskAuth(mem,resumeFetch);
 const resumed=await auth2.resumeCallback();
 assert.equal(resumed?.token,'tk2');assert.equal(auth2.token,'tk2');
 assert.equal(mem._m['aliya_miauth_pending'],undefined);
});
