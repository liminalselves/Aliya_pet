import { loadMskConfig } from './msk-config-helper.mjs';
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
 assert.equal(Object.keys(refs.Motions).length,10);assert.equal(refs.Expressions.length,12);
 for(const name of refs.Textures){const bytes=readFileSync(new URL(name,base));assert.equal(bytes.readUInt32BE(16),2048);assert.equal(bytes.readUInt32BE(20),2048)}
 for(const motions of Object.values(refs.Motions))for(const motion of motions)for(const curve of json(motion.File).Curves){if(curve.Target==='Parameter')assert.ok(ids.has(curve.Id),curve.Id)}
 for(const expression of refs.Expressions)for(const p of json(expression.File).Parameters)assert.ok(ids.has(p.Id),p.Id);
 for(const group of json(refs.Physics).PhysicsSettings){for(const p of group.Input)assert.ok(ids.has(p.Source.Id),p.Source.Id);for(const p of group.Output)assert.ok(ids.has(p.Destination.Id),p.Destination.Id)}
 for(const id of ['Param30','Param31','Param36'])assert.ok(ids.has(id));
});
function load(name,imports={},globals={}){
 const code=ts.transpileModule(readFileSync(new URL(`src/${name}.ts`,root),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
 const exports={};vm.runInNewContext(code,{exports,require:id=>imports[id]??(['./config','../msk/config'].includes(id)?loadMskConfig():{}),console,setTimeout,clearTimeout,performance,...globals});return exports;
}
const {GazeController}=load('gaze');
const newActionNames=['cheerful_bounce','shy_sway'];
const modelBase=new URL('assets/live2d/aliya/',root);
const asset=file=>JSON.parse(readFileSync(new URL(file,modelBase)));

test('动作注册、元数据、AI 能力清单集合一致且资源可解析',()=>{
 const {ACTION_LIBRARY}=load('behavior');
 const {PERFORMANCE_ACTIONS,performanceRequestPayload}=load('chat/performance-manifest');
 const refs=asset('16.model3.json').FileReferences;
 const meta=asset('actions.json').actions;
 const sorted=xs=>Array.from(xs).sort();
 assert.ok(!ACTION_LIBRARY.includes('walk'),'walk 不应出现在动作库');
 assert.ok(!readdirSync(new URL('motions/',modelBase)).includes('walk.motion3.json'),'walk 资源应已删除');
 for(const names of [Object.keys(refs.Motions),meta.map(a=>a.name),PERFORMANCE_ACTIONS.map(a=>a.name),performanceRequestPayload().actions.map(a=>a.name)]){
  assert.equal(new Set(names).size,names.length,'动作不应重复');
  assert.ok(!names.includes('walk'),'walk 不应出现在正式动作或 AI 能力清单');
  assert.deepEqual(sorted(names),sorted(ACTION_LIBRARY));
 }
 for(const name of newActionNames){
  const entry=meta.find(a=>a.name===name);
  assert.ok(['idle','emotion','reaction'].includes(entry.category));
  assert.ok(entry.weight>0&&entry.weight<1,'新动作应低频进入日常抽样');
  assert.ok(Object.values(entry.moods).every(v=>Number.isFinite(v)&&v>0));
  assert.ok(PERFORMANCE_ACTIONS.find(a=>a.name===name)?.hint);
  assert.equal(refs.Motions[name].length,1);
  assert.ok(asset(refs.Motions[name][0].File).Curves.length>0);
 }
});

test('全部动作遵守参数所有权、完整默认复位和淡出尾垫；新曲线无退时与越界',()=>{
 const refs=asset('16.model3.json').FileReferences;
 const resetIds=['ParamMouthForm','ParamMouthOpenY','ParamEyeLSmile','ParamEyeRSmile',
  'ParamBrowLY','ParamBrowRY','ParamBrowLX','ParamBrowRX','ParamBrowLAngle','ParamBrowRAngle','ParamBrowLForm','ParamBrowRForm',
  'Param32','Param33','Param34','Param35','ParamAngleX','ParamAngleY','ParamAngleZ',
  'ParamBodyAngleX','ParamBodyAngleY','ParamBodyAngleZ','ParamEyeBallX','ParamEyeBallY','ParamEyeLOpen','ParamEyeROpen',
  'ParamArmL01','ParamArmL02','ParamArmR01','ParamArmR02'];
 const limits=id=>/^(ParamEye[LR](Open|Smile)|ParamMouthOpenY|Param3[2-5])$/.test(id)?[0,1]:
  /^Param(BodyAngle|Arm)/.test(id)?[-10,10]:/^Param(Angle|EyeBall)/.test(id)?[-30,30]:[-1,1];
 for(const [name,entries] of Object.entries(refs.Motions))for(const entry of entries){
  const motion=asset(entry.File),{Meta,Curves}=motion;
  assert.equal(Meta.Loop,false);assert.equal(Meta.CurveCount,Curves.length);
  assert.deepEqual(Curves.map(c=>c.Id).sort(),[...resetIds].sort(),`${name}: 公共复位集/所有权`);
  let segments=0,points=0;
  for(const {Target,Id,Segments:s} of Curves){
   assert.equal(Target,'Parameter');
   assert.ok(!/^(ParamCheek|ParamBreath|Param(?:[7-9]|1[0-4]|30|31|36)|Param_Angle_Rotation_.*)$/.test(Id),`${name}: ${Id} 所有权`);
   assert.ok(s.every(Number.isFinite));
   const neutral=/^ParamEye[LR]Open$/.test(Id)?1:0;
   assert.equal(s[0],0);assert.equal(s[1],neutral,`${name}: ${Id} 起点`);
   if(/^ParamArm/.test(Id)&&!['shy_sway','cheerful_bounce'].includes(name))assert.deepEqual(s,[0,0,0,Meta.Duration,0],`${name}: 不改变既有手臂表演，只主动复位`);
   let t=s[0],v=s[1],lastChangingTime=0;points++;
   const [min,max]=limits(Id);
   for(let i=2;i<s.length;){
    const type=s[i++];assert.ok(type===0||type===1);
    const count=type===1?3:1;
    let changed=false;
    for(let j=0;j<count;j++){
     const nextT=s[i++],nextV=s[i++];
     assert.ok(nextT>=t&&nextT<=Meta.Duration,`${name}: ${Id} 时间顺序`);
     if(newActionNames.includes(name))assert.ok(nextT>t,`${name}: ${Id} 零长曲线段`);
     assert.ok(nextV>=min&&nextV<=max,`${name}: ${Id} 越界 ${nextV}`);
     changed ||= nextV!==v;t=nextT;v=nextV;points++;
    }
    if(changed)lastChangingTime=t;
    segments++;
   }
   assert.equal(v,neutral,`${name}: ${Id} 末值`);
   assert.ok(Meta.Duration-lastChangingTime>=entry.FadeOutTime-1e-6,`${name}: ${Id} 复位尾垫不足`);
  }
  assert.equal(Meta.TotalSegmentCount,segments,name);assert.equal(Meta.TotalPointCount,points,name);
 }
 assert.equal(new Set(newActionNames.map(name=>asset(refs.Motions[name][0].File).Meta.Duration)).size,newActionNames.length,'新动作节奏不应完全相同');
});

test('新动作通过 AI 指令和 PetAI 单次播放，互动限频、未知动作无副作用',()=>{
 const {parseCueSegment}=load('chat/performance-manifest');
 const {ChatPerformance}=load('chat/performance');
 const events=[],calls=[];
 const {PetAI}=load('pet-ai',{},{window:{dispatchEvent:e=>events.push(e)},CustomEvent:class{constructor(type,init){this.type=type;this.detail=init.detail}}});
 const {ACTION_LIBRARY}=load('behavior');
 const ai=new PetAI({model:()=>({actionManifest:asset('actions.json').actions,getExpressionNames:()=>[],getCurrentExpression:()=>null}),moodEngine:()=>null,playAction:name=>{if(!ACTION_LIBRARY.includes(name))return false;calls.push(name);return true}});
 let now=0,busy=false;
 const p=new ChatPerformance({expressions:()=>[],actions:()=>ai.state().actions,express(){},clearExpression(){},play:name=>ai.play(name),busy:()=>busy},()=>now);
 for(const name of newActionNames){
  now+=4000;const cue=parseCueSegment(`[[agent_cue play=${name}]]`);assert.equal(cue.action,name);
  const before=calls.length;p.cue(cue);assert.equal(calls.length,before+1);assert.equal(calls.at(-1),name);
  p.cue(cue);assert.equal(calls.length,before+1,'限频不能重播');
  now+=4000;busy=true;p.cue(cue);busy=false;p.tick();assert.equal(calls.length,before+1,'互动后不补播');
 }
 assert.deepEqual(calls,newActionNames);assert.deepEqual(events.map(e=>e.detail.action),newActionNames);
 p.cue({action:'not_an_action'});assert.equal(ai.play('not_an_action'),false);
 assert.equal(calls.length,newActionNames.length);assert.equal(events.length,newActionNames.length);
});

test('shy_sway 的害羞表情联动走既有 cue，取消和互动不补播动作',()=>{
 const {parseCueSegment}=load('chat/performance-manifest');
 const {ChatPerformance}=load('chat/performance');
 const events=[];let busy=false;
 const p=new ChatPerformance({expressions:()=>['shy'],actions:()=>asset('actions.json').actions.map(a=>a.name),
  express:name=>events.push(['express',name]),clearExpression:()=>events.push(['clear']),play:name=>events.push(['play',name]),busy:()=>busy},()=>0);
 const cue=parseCueSegment('[[agent_cue express=shy play=shy_sway]]');
 assert.equal(cue.expression,'shy');assert.equal(cue.action,'shy_sway');p.cue(cue);
 assert.deepEqual(events,[['play','shy_sway'],['express','shy']]);
 busy=true;p.tick();busy=false;p.tick();p.cancel();
 assert.deepEqual(events,[['play','shy_sway'],['express','shy'],['clear'],['express','shy'],['clear']]);
 assert.ok(!asset('actions.json').actions.some(a=>a.name==='sajiao'),'不注册第二个调用名');
 const meta=asset('actions.json').actions.find(a=>a.name==='shy_sway');
 assert.ok(meta.moods.shy>1&&meta.moods.happy>1);
 const physicsOutputs=new Set(asset('16.physics3.json').PhysicsSettings.flatMap(s=>s.Output.map(o=>o.Destination.Id)));
 for(const c of asset('motions/shy_sway.motion3.json').Curves)assert.ok(!physicsOutputs.has(c.Id),`${c.Id} 是物理输出，不能由动作接管`);
});

test('设置页全部动作使用中文标签，资源目录与正式清单一致',()=>{
 const source=readFileSync(new URL('src/settings-page.ts',root),'utf8');
 const labels=source.match(/const ACTION_LABELS[^=]*=\s*\{([\s\S]*?)\n\};/)[1];
 const entries=new Map([...labels.matchAll(/(\w+):\s*'([^']+)'/g)].map(m=>[m[1],m[2]]));
 const {ACTION_LIBRARY}=load('behavior');
 for(const name of ACTION_LIBRARY)assert.match(entries.get(name)??'以ID回退',/[\u4e00-\u9fff]/,name);
 assert.equal(entries.get('shy_sway'),'撒娇');
 assert.deepEqual(readdirSync(new URL('motions/',modelBase)).filter(n=>n.endsWith('.motion3.json')).sort(),Array.from(ACTION_LIBRARY,n=>`${n}.motion3.json`).sort());
});

const {CheekChannel}=load('overlay');
function cheekHarness(){
 const channel=new CheekChannel('ParamCheek');let visible=0;
 const model={getParameterValueById:()=>visible,setParameterValueById:(id,v)=>{assert.equal(id,'ParamCheek');visible=v}};
 return {channel,step(dt=1/60,expression=0){visible=expression;channel.apply(model,dt);assert.ok(Number.isFinite(visible)&&visible>=0&&visible<=1);return visible}};
}
test('撒娇脸红按动作时长渐入、保持、自然淡出，重播不中断当前红晕',()=>{
 for(const fps of [15,30,60]){
  const h=cheekHarness();h.channel.triggerAction(5.4);let last=0;
  for(let i=0;i<fps;i++){const v=h.step(1/fps);assert.ok(v>=last);last=v}
  assert.ok(last>.99);h.channel.triggerAction(5.4);assert.ok(h.step(1/fps)>.99,'重播不能清零');
  for(let i=0;i<fps*3;i++)assert.ok(h.step(1/fps)>.99,'主体不能提前退红');
  for(let i=0;i<fps*3;i++){const v=h.step(1/fps);assert.ok(v<=last+1e-4);last=v}
  assert.equal(last,0,'尾垫后不保留动作脸红');
 }
});

test('点击、原表情与撒娇脸红取较强值，打断只撤回自己并平滑恢复',()=>{
 const h=cheekHarness();h.channel.enabled=true;h.channel.value=.85;
 for(let i=0;i<60;i++)assert.equal(h.step(1/60,1),1,'点击不能减弱已饱和shy表情');
 h.channel.triggerAction(5.4);for(let i=0;i<60;i++)h.step();
 const before=h.step();h.channel.releaseAction();const next=h.step();
 assert.ok(next<before&&next>.85,'打断需从当前值渐退，不能跳清零');
 for(let i=0;i<90;i++)h.step();assert.ok(Math.abs(h.step()-.85)<1e-4,'保留仍激活的点击来源');
 assert.equal(h.channel.enabled,true);assert.equal(h.channel.value,.85,'不清除互动状态');
 h.channel.enabled=false;let previous=h.step(1/60,.4);
 for(let i=0;i<90;i++){const value=h.step(1/60,.4);assert.ok(value<=previous&&value>=.4);previous=value}
 assert.equal(previous,.4,'恢复原有表情，而非强制清脸');
 for(const dt of [NaN,Infinity,-1])h.step(dt,.4);
});

test('所有成功动作入口联动撒娇脸红，未知/被拒请求不干扰当前状态与原表情',()=>{
 const {PetModel}=load('pet-model',{'@framework/model/cubismusermodel':{CubismUserModel:class{}}});
 const m=Object.create(PetModel.prototype),events=[];let result=1;
 Object.assign(m,{_ready:true,_currentExpression:'worried',_motions:new Map([['shy_sway_0',{getDuration:()=>5.4}],['nod_0',{}]]),_setting:{getMotionCount:()=>1},
  _chHand:{trigger(){},release(){}},_chCheek:{triggerAction:t=>events.push(['on',t]),releaseAction:()=>events.push(['off'])},
  _motionManager:{getCurrentPriority:()=>0,startMotionPriority:()=>result}});
 assert.equal(m.playAction('shy_sway'),true);assert.equal(m.startMotion('shy_sway',0,2),1);assert.equal(m.startRandomMotion('shy_sway',2),1);
 assert.deepEqual(events,[['on',5.4],['on',5.4],['on',5.4]]);
 result=-1;assert.equal(m.playAction('shy_sway'),false);assert.equal(m.startMotion('shy_sway',0,2),-1);assert.equal(m.playAction('missing'),false);
 assert.equal(events.length,3);result=1;m.playAction('nod');assert.deepEqual(events.at(-1),['off']);
 assert.equal(m._currentExpression,'worried','不能借用表情切换实现动作脸红');
});

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
   assert.ok(h.values.get('Param30')>=0&&h.values.get('Param30')<=1);
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
 h.channel.trigger();for(let i=0;i<30;i++)h.step(1/30);assert.ok(h.values.get('Param30')>.99);
});
test('当前模型继续抬起旧版五段手链，结束后停止覆盖物理',()=>{
 const h=waveHarness(false);h.channel.trigger();for(let i=0;i<30;i++)h.step(1/30);
 assert.equal(h.values.size,5);for(const v of h.values.values())assert.ok(v<-30);
 for(let i=0;i<180;i++)h.step(1/30);assert.equal(h.values.size,0);
});
test('按优先级播放及随机播放同样触发挥手，被拒绝的动作不影响当前手势',()=>{
 const {PetModel}=load('pet-model',{'@framework/model/cubismusermodel':{CubismUserModel:class{}}});
 const m=Object.create(PetModel.prototype);let triggered=0,released=0;
 Object.assign(m,{_ready:true,_motions:new Map([['wave_0',{}],['nod_0',{}]]),_setting:{getMotionCount:()=>1},_chHand:{trigger(){triggered++},release(){released++}},_chCheek:{releaseAction(){}},_motionManager:{getCurrentPriority:()=>0,stopAllMotions(){},startMotionPriority:()=>1}});
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
 for(const file of readdirSync(new URL('assets/live2d/aliya/motions/',root)).filter(name=>name.endsWith('.motion3.json'))){
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
const settleWindow=()=>new Promise(r=>setImmediate(r));
function snapHarness(pos=[40,300],snap=true) {
 let now=0,rafQ=[],reduced=false;
 const positions=[],saved=[],animations=[];
 const mon={scaleFactor:1.5,workArea:{position:{x:-1920,y:0},size:{width:1920,height:1040}}};
 const body={dataset:{},classList:{remove(){},add(){}},offsetWidth:1};
 class KeyframeEffect {
  constructor(target,keyframes,options){this.options=options}
  getComputedTiming(){return {progress:Math.min(1,(now-this.started)/this.options.duration)}}
 }
 class Animation {
  constructor(effect){this.effect=effect;animations.push(this)}
  play(){this.effect.started=now}
  cancel(){this.cancelled=true}
 }
 const api={currentMonitor:async()=>mon,PhysicalPosition:class{constructor(x,y){this.x=x;this.y=y}}};
 const {PetApp}=load('pet-app',{'@tauri-apps/api/window':api,'./settings':{saveSettings:s=>saved.push({...s})}},{
  KeyframeEffect,Animation,document:{body,documentElement:{},timeline:{}},
  window:{matchMedia:()=>({matches:reduced})},getComputedStyle:()=>({getPropertyValue:()=> 'cubic-bezier(0.22, 0.8, 0.32, 1)'}),
  requestAnimationFrame:fn=>rafQ.push(fn),
 });
 const app=Object.create(PetApp.prototype);
 Object.assign(app,{_tauriWindow:{outerPosition:async()=>({x:pos[0],y:pos[1]}),scaleFactor:async()=>1.5,
  outerSize:async()=>({width:300,height:400}),setPosition:async p=>{pos[0]=p.x;pos[1]=p.y;positions.push([...pos])}},
  _snapAnimToken:0,_snapAnimation:null,_snapHintTimer:null,_windowMoveTask:null,_settings:{snapEdges:snap},
  _winPhysX:pos[0],_winPhysY:pos[1],_scaleFactor:1.5,_metricsSynced:true,_syncChatAnchor(){},_showSnapHint(){}});
 return {app,positions,saved,animations,pos,mon,PetApp,
  reduce(){reduced=true},
  async frame(ms=16){now+=ms;const q=rafQ;rafQ=[];for(const fn of q)fn(now);await settleWindow()},
  async finish(){for(let guard=0;rafQ.length&&guard<30;guard++)await this.frame(32);assert.equal(rafQ.length,0)},
 };
}
test('松手贴边：副屏负坐标、DPI、越界归位与关闭贴边',async()=>{
 for(const [pos,snap,want] of [
  [[-2050,950],false,[-2050,950]],
  [[-1650,12],true,[-1650,0]],
  [[-5000,950],true,[-1920,640]],
  [[-1000,300],true,[-1000,300]],
  [[-320,620],true,[-300,640]],
  [[-1848,300],true,[-1920,300]], // 48 CSS px = 72 physical px
  [[-1847,300],true,[-1847,300]],
 ]){
  const h=snapHarness([...pos],snap);h.app._onDragFinished();await settleWindow();await h.finish();
  assert.deepEqual([h.saved.at(-1).posX,h.saved.at(-1).posY],want,`pos=${pos} snap=${snap}`);
  if(want.join()!==pos.join()) assert.deepEqual(h.positions.at(-1),want);
 }
});
test('贴边开启时拖动仍完全跟手：从边缘拉开无阻力，越界不钳制，小数位移不丢失',async()=>{
 const h=snapHarness([-1920,300]);
 h.app._moveWindowBy(1,0);await settleWindow();assert.deepEqual(h.pos,[-1918,300]);
 h.app._moveWindowBy(1,0);await settleWindow();assert.deepEqual(h.pos,[-1917,300]);
 h.app._moveWindowBy(-200,10);await settleWindow();assert.deepEqual(h.pos,[-2217,315]);
 assert.equal(h.animations.length,0);assert.equal(h.saved.length,0);
});
test('归位执行多帧位置过渡，末帧真正提交前不保存目标位置',async()=>{
 const h=snapHarness([-1880,300]);h.app._onDragFinished();await settleWindow();
 assert.equal(h.positions.length,0);assert.equal(h.saved.length,0);
 await h.frame(60);assert.ok(h.pos[0]<-1880&&h.pos[0]>-1920);assert.equal(h.saved.length,0);
 const realSet=h.app._tauriWindow.setPosition;let release;
 h.app._tauriWindow.setPosition=p=>new Promise(resolve=>{release=async()=>{await realSet(p);resolve()}});
 await h.frame(220);assert.equal(h.saved.length,0);
 await release();await settleWindow();assert.deepEqual(h.pos,[-1920,300]);assert.equal(h.saved.at(-1).posX,-1920);
 assert.ok(h.positions.length>1);
});
test('再次抓取可立即中断旧动画，少动态效果下直接归位',async()=>{
 const h=snapHarness([-1880,300]);h.app._onDragFinished();await settleWindow();await h.frame(60);
 h.app._cancelSnapAnimation();const before=h.pos[0];h.app._moveWindowBy(10,0);await settleWindow();await h.finish();
 assert.equal(h.pos[0],Math.round(before+15));assert.equal(h.saved.length,0);assert.equal(h.animations[0].cancelled,true);
 const reduced=snapHarness([-1880,300]);reduced.reduce();reduced.app._onDragFinished();await settleWindow();
 assert.deepEqual(reduced.pos,[-1920,300]);assert.equal(reduced.animations.length,0);assert.equal(reduced.saved.length,1);
});
test('窄屏感应带重叠时选最近边，窗口大于工作区时不产生反向边界',()=>{
 const {PetApp}=load('pet-app');
 assert.equal(PetApp._snapAxis(70,0,80,48).v,80);
 assert.equal(PetApp._snapAxis(100,0,-40,48).v,0);
});

test('半闭眼收小瞳孔行程，完全闭眼回中',()=>{
 const {controller,model,values}=gaze();controller.setTarget(1,0);
 for(let i=0;i<90;i++){values.clear();controller.update(model,1/30,{motionActive:false,reduction:1,eyeOpenness:.5})}
 assert.ok(Math.hypot(values.get('x'),values.get('y'))<=10.000001);
 controller.update(model,1/30,{motionActive:false,reduction:1,eyeOpenness:0});assert.equal(Math.hypot(values.get('x'),values.get('y')),0);
});

test('单眼覆盖不写另一眼，按实际秒平滑接管/释放，低帧率一致',()=>{
 const {EyeOverrideChannel}=load('overlay');
 for(const fps of [15,30,60])for(const side of ['left','right']){
  const c=new EyeOverrideChannel({left:'L',right:'R'}),values=new Map(),writes=[];
  const m={getParameterValueById:id=>values.get(id),setParameterValueById:(id,v)=>{values.set(id,v);writes.push(id)}};
  const step=()=>{values.set('L',.8);values.set('R',.9);writes.length=0;c.apply(m,1/fps)};
  const eye=side==='left'?'L':'R',other=side==='left'?'R':'L';
  c.side=side;c.enabled=true;c.left=c.right=0;
  step();assert.ok(values.get(eye)>0&&values.get(eye)<1);assert.ok(!writes.includes(other));
  for(let i=0;i<Math.ceil(fps*.12);i++){step();assert.ok(!writes.includes(other))}
  assert.equal(values.get(eye),0);c.enabled=false;step();assert.ok(values.get(eye)>0&&values.get(eye)<.8);
  for(let i=0;i<Math.ceil(fps*.2);i++)step();
  assert.equal(values.get(eye),side==='left'?.8:.9);assert.ok(!writes.includes(eye));assert.ok(!writes.includes(other));
 }
});

test('单眼切边及点击→抚摸同帧交接从可见值继续，最终释放旧侧',()=>{
 const {EyeOverrideChannel}=load('overlay');const c=new EyeOverrideChannel({left:'L',right:'R'});
 const values=new Map(),writes=[];const m={getParameterValueById:id=>values.get(id),setParameterValueById:(id,v)=>{values.set(id,v);writes.push(id)}};
 const step=()=>{values.set('L',1);values.set('R',1);writes.length=0;c.apply(m,1/60)};
 c.side='left';c.enabled=true;c.left=c.right=0;for(let i=0;i<10;i++)step();assert.equal(values.get('L'),0);
 c.enabled=false;c.enabled=true;c.side='both';c.left=c.right=1;step();
 assert.ok(values.get('L')>0&&values.get('L')<.1,'同帧控制源交接不能0→1跳变');
 c.side='right';c.left=c.right=0;for(let i=0;i<20;i++)step();
 assert.equal(values.get('L'),1);assert.equal(values.get('R'),0);assert.ok(!writes.includes('L'));
});

test('动作与表情请求不提前清空旧队列，SDK负责交叉淡化',()=>{
 const {PetModel}=load('pet-model',{'@framework/model/cubismusermodel':{CubismUserModel:class{}}});
 const m=Object.create(PetModel.prototype),starts=[];let clears=0;
 const manager={getCurrentPriority:()=>0,stopAllMotions(){clears++},startMotionPriority:(...args)=>{starts.push(args);return 1},startMotion:(...args)=>starts.push(args)};
 Object.assign(m,{_ready:true,_motions:new Map([['nod_0',{}]]),_setting:{getMotionCount:()=>1},_chHand:{release(){}},_chCheek:{releaseAction(){}},_motionManager:manager,_expressionManager:manager,_expressions:new Map([['happy',{}],['neutral',{}]]),_gaze:{setExpression(){}},_currentExpression:null});
 m.startMotion('nod',0,2);m.playAction('nod');m.startExpression('happy');m.startExpression(null);
 assert.equal(starts.length,4);assert.equal(clears,0);
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
 const lines=[],actions=[],reactions=[];
 const service = new InteractionService({
  hitAreas:{isInHeadPetZone:()=>true,hitAreaAt:()=> 'face'},getTarget:()=>target,
  dialogue:{resolveSceneTag:(_scene,tag)=>({entryId:tag,pages:[{text:tag}]})},
  pettingHost:{isDialogueActive:()=>speaking,playPettingDialogue:r=>lines.push(r.entryId)},
  playCharacterAction:action=>{actions.push(action);return true},
 });
 const apply=service.procedural.apply.bind(service.procedural);
 service.procedural.apply=reaction=>{reactions.push({...reaction});apply(reaction)};
 service.playClickDialogue=tag=>lines.push(tag);
 const ctx=(x=400,secondary=true,dt=1/60)=>({normX:.5,normY:.2,pxX:x,pxY:200,dtSeconds:dt,leftPressed:!secondary,isSecondary:secondary});
 return {service,writes,lines,actions,reactions,ctx,globals,recognizer,procedural,
  speaking(v){speaking=v},advance(ms){now+=ms;service.tick(ms)},setTime(ms){now=ms},
  stroke(){for(let i=1;i<=90;i++){now+=1000/60;const t=i/60;const x=400+40*Math.sin(t*Math.PI*2);service.onPointerMove(ctx(x));service.tick(1000/60)}}};
}

test('实际点击脸红曲线峰值为0.85且保留完整恢复和取消流程',()=>{
 const h=interactionHarness();h.service.procedural.apply({type:'blush',strength:1});
 let peak=0;for(let i=0;i<150;i++){h.advance(16);peak=Math.max(peak,h.writes.cheek?.[1]??0);assert.equal(h.writes.eyes?.[0],false)}
 assert.equal(peak,.85);assert.equal(h.writes.cheek[0],false);assert.equal(h.writes.cheek[1],0);
 h.service.procedural.apply({type:'blush',strength:.5});for(let i=0;i<40;i++)h.advance(16);
 assert.ok(Math.abs(h.writes.cheek[1]-.425)<1e-6);
 h.service.procedural.cancelAll();for(let i=0;i<30;i++)h.advance(16);assert.equal(h.writes.cheek[1],0);
});

test('耳朵连点仅同侧眨眼并偏头，不写耳动、不升级双眼疑惑；脸红不接管眼睛',()=>{
 for(const area of ['ear_left','ear_right']){
  const h=interactionHarness(),s=h.service;s.hitAreas.hitAreaAt=()=>area;
  let minEye=1,maxTilt=0;for(let i=0;i<8;i++){
   s.onClick(h.ctx(400,false),false);
   for(let j=0;j<30;j++){h.advance(16);if(h.writes.eyes[0]){assert.equal(h.writes.eyes[3],area==='ear_left'?'right':'left');minEye=Math.min(minEye,h.writes.eyes[1])}maxTilt=Math.max(maxTilt,Math.abs(h.writes.offsets[2]));assert.equal(h.writes.ears[1],0);assert.equal(h.writes.ears[2],0)}
  }
  assert.equal(minEye,0);assert.ok(maxTilt>0);assert.ok(h.lines.every(tag=>tag===area));assert.equal(h.writes.eyes[0],false);
 }
 const h=interactionHarness();h.service.onClick(h.ctx(400,false),false);h.advance(16);assert.equal(h.writes.eyes[0],false);
});

test('普通与耳朵交替保留普通3/5/8次递进，耳朵不计入疑惑也不能重置历史',()=>{
 const h=interactionHarness(),s=h.service;
 const normal=['face','face','click_doubt','click_doubt','click_comment','click_comment','click_comment'];
 for(let i=0;i<8;i++){
  h.setTime(i*500);s.hitAreas.hitAreaAt=()=> 'face';
  const before=h.lines.length;assert.equal(s.onClick(h.ctx(400,false),false),true);
  if(i<7){assert.equal(h.lines.length,before+1);assert.equal(h.lines.at(-1),normal[i])}
  else {assert.equal(h.lines.length,before);assert.equal(s.clickSequence.isInCooldown,true)}
  h.setTime(i*500+100);const area=i%2?'ear_right':'ear_left';s.hitAreas.hitAreaAt=()=>area;
  const earBefore=h.lines.length;s.onClick(h.ctx(400,false),false);
  if(i<7){assert.equal(h.lines.length,earBefore+1);assert.equal(h.lines.at(-1),area);assert.equal(h.reactions.at(-1).type,'earBlink')}
  else assert.equal(h.lines.length,earBefore,'第八次普通点击后的耳朵也必须服从全局冷却');
 }
 assert.deepEqual(h.actions,Array(5).fill('doubt'));
});

test('左右耳高频点击不重复台词或动作启动，节流结束仍保留另一侧单眼反馈',()=>{
 const h=interactionHarness(),s=h.service;s.hitAreas.hitAreaAt=()=> 'ear_left';
 s.onClick(h.ctx(400,false),false);
 for(let i=1;i<=25;i++){
  h.advance(16);s.hitAreas.hitAreaAt=()=>i%2?'ear_right':'ear_left';
  assert.equal(s.onClick(h.ctx(400,false),false),true);
  assert.equal(h.writes.eyes[3],'right','被节流的另一侧不能切换眼睛');
 }
 assert.deepEqual(h.lines,['ear_left']);
 assert.deepEqual(h.reactions,[{type:'earBlink',strength:.8,areaId:'ear_left'}]);
 assert.deepEqual(h.actions,[]);
 for(let i=0;i<7;i++)h.advance(16);
 s.hitAreas.hitAreaAt=()=> 'ear_right';s.onClick(h.ctx(400,false),false);h.advance(16);
 assert.deepEqual(h.lines,['ear_left','ear_right']);assert.equal(h.reactions.length,2);
 assert.equal(h.writes.eyes[3],'left');assert.equal(s.clickSequence.isInCooldown,false);
});

test('全局冷却期间左右耳与普通点击只给低幅反馈，不解除或延长冷却，到期后重新计数',()=>{
 const h=interactionHarness(),s=h.service;
 for(let i=0;i<8;i++){h.setTime(i*100);s.onClick(h.ctx(400,false),false)}
 assert.equal(s.clickSequence.isInCooldown,true);
 const lines=[...h.lines],starts=h.reactions.length,actions=[...h.actions];
 for(const time of [800,950,2000,3699])for(const area of ['ear_left','ear_right','face']){
  h.setTime(time);s.hitAreas.hitAreaAt=()=>area;
  assert.equal(s.onClick(h.ctx(400,false),false),true);
  assert.equal(s.clickSequence.isInCooldown,true,`${area}不能提前解除冷却`);
  assert.deepEqual(h.lines,lines);assert.deepEqual(h.actions,actions);
   for(const reaction of h.reactions.slice(starts)){assert.equal(reaction.type,'acknowledge');assert.equal(reaction.strength,.35)}
 }
 h.setTime(3700);s.hitAreas.hitAreaAt=()=> 'ear_right';s.onClick(h.ctx(400,false),false);
 assert.equal(s.clickSequence.isInCooldown,false);assert.equal(h.lines.at(-1),'ear_right');
 assert.equal(h.reactions.at(-1).type,'earBlink');assert.equal(h.reactions.length,starts+4);
 for(let i=0;i<3;i++){
  h.setTime(3700+i*100);s.hitAreas.hitAreaAt=()=> 'face';s.onClick(h.ctx(400,false),false);
  assert.equal(h.lines.at(-1),i===2?'click_doubt':'face','冷却内点击和耳朵均不能计入新一轮普通计数');
 }
});

test('连续耳朵反馈不累积普通疑惑，已有台词不重启，生命周期清理释放耳朵节流',()=>{
 const h=interactionHarness(),s=h.service;
 for(let i=0;i<10;i++){h.setTime(i*500);s.hitAreas.hitAreaAt=()=>i%2?'ear_right':'ear_left';s.onClick(h.ctx(400,false),false)}
 assert.equal(h.reactions.length,10);assert.deepEqual(h.actions,[]);
 s.hitAreas.hitAreaAt=()=> 'face';s.onClick(h.ctx(400,false),false);assert.equal(h.lines.at(-1),'face');
 h.setTime(5000);s.hitAreas.hitAreaAt=()=> 'ear_left';s.isDialogueActive=()=>true;
 const before=h.lines.length;s.onClick(h.ctx(400,false),false);
 assert.equal(h.lines.length,before,'已有台词播放时不能重新请求耳朵台词');
 s.isDialogueActive=()=>false;
 for(const reset of ['cancel','onModelReloaded','onWindowClosed']){
  const starts=h.reactions.length;s[reset]();s.onClick(h.ctx(400,false),false);
  assert.equal(h.reactions.length,starts+1,`${reset}之后首次耳朵点击不能被旧节流阻挡`);
  assert.equal(h.lines.at(-1),'ear_left');
 }
});

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
 assert.equal(s.petting.state,'finishing');assert.equal(s.isBusy,true);assert.equal(h.lines.length,n);
 h.advance(1000/60);assert.equal(h.writes.eyes[0],true);assert.ok(h.writes.eyes[1]<.2,'取消后不瞬间睁眼');
 for(let i=0;i<180;i++)h.advance(1000/60);
 assert.equal(s.petting.state,'inactive');assert.equal(s.isBusy,false);
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

function randomSpeechHarness() {
 const {PetApp}=load('pet-app');
 const {InteractionCoordinator}=load('interaction/coordination');
 const {DialogueStore}=load('dialogue/dialogue');
 const app=Object.create(PetApp.prototype),played=[];
 const state={interacting:false,speaking:false,paused:false};let now=0,draws=0;
 const dialogue=new DialogueStore();dialogue._files.set('user_click',{entries:[{id:'manual-line',text:'预设台词'}]});
 const resolveRandom=dialogue.resolveRandom.bind(dialogue);
 dialogue.resolveRandom=()=>{draws++;return resolveRandom()};
  Object.assign(app,{_remoteChat:{open:false},_chatView:{isOpen:false},_touchPetting:false,_running:true,_shellActionsReady:true,_pendingShellActions:[],
  _interaction:{cancel(){}},_dialogue:dialogue,_coordination:new InteractionCoordinator(()=>state,()=>now),
  _bubble:{play(resolved){played.push(resolved);state.speaking=true}}});
 return {app,state,played,get draws(){return draws},setNow(value){now=value}};
}

test('设置窗口手动随机台词绕过失焦静默期，自动闲聊仍等待',()=>{
 const h=randomSpeechHarness();
 h.app._cancelInteraction();h.setNow(400);
 h.app._playRandom();assert.equal(h.draws,0,'自动闲聊仍在静默期');
 h.app.onShellAction({action:'random-speech'});
 assert.equal(h.played.length,1,'手动按钮不能被失焦产生的静默期吞掉');
 assert.equal(h.played[0].pages[0].text,'预设台词');
 h.app.onShellAction({action:'random-speech'});assert.equal(h.draws,1,'连点不抽取或覆盖正在播放的气泡');
 h.state.speaking=false;h.setNow(2500);h.app._playRandom();assert.equal(h.played.length,2);
});

test('手动随机台词保留暂停、互动和聊天防抢话规则，不积压请求',()=>{
  const h=randomSpeechHarness();
  for(const key of ['paused','speaking','interacting']){
  h.state[key]=true;h.app.onShellAction({action:'random-speech'});h.state[key]=false;
 }
 h.app._remoteChat.open=true;h.app.onShellAction({action:'random-speech'});h.app._remoteChat.open=false;
 h.app._chatView.isOpen=true;h.app.onShellAction({action:'random-speech'});h.app._chatView.isOpen=false;
 assert.equal(h.draws,0);assert.equal(h.played.length,0);
  h.app._dialogue._files.clear();h.app.onShellAction({action:'random-speech'});assert.equal(h.played.length,0,'空资源不显示空泡');
 });

test('模型与台词尚未加载时手动随机台词不丢失且只补发一次',()=>{
  const h=randomSpeechHarness(); let calls=0;
  Object.assign(h.app,{_bubble:null,_interaction:null,_running:false,_shellActionsReady:false,
    _playRandom:source=>{calls++;assert.equal(source,'manual')}});
  h.app.onShellAction({action:'random-speech'});
  assert.equal(h.app._pendingShellActions.length,1);
  assert.equal(calls,0);
  Object.assign(h.app,{_bubble:{},_interaction:{},_running:true});
  h.app._flushPendingShellActions();
  h.app._flushPendingShellActions();
  assert.equal(calls,1);
 });

test('跨窗口tray-action在模型fetch、moc与台词加载期间均排队，监听IPC完成先于fetch',async()=>{
 const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
 const ipc=deferred(),fetchGate=deferred(),modelGate=deferred(),dialogueGate=deferred(),hitGate=deferred();
 const listening=deferred(),fetchStarted=deferred(),modelStarted=deferred(),dialogueStarted=deferred();
 const listeners=new Map(),calls=[],applied=[];let registrations=0;
 const events={
  async listen(name,handler){registrations++;if(registrations===3)listening.resolve();await ipc.promise;listeners.set(name,handler);return ()=>listeners.delete(name)},
  async emitTo(target,name,payload){assert.equal(target,'pet');listeners.get(name)?.({payload})},
 };
 class Model{async loadFromSetting(){modelStarted.resolve();await modelGate.promise}isReady(){return true}actionManifest=[]}
 class Behavior{setActionMeta(){}start(){}}
 class Mood{onMoodChanged(){}}
 class AI{play(name){calls.push(name)}express(name){calls.push(name)}clearExpression(){}setMood(name){calls.push(name)}}
 const {PetApp}=load('pet-app',{
  './platform':{platform:'tauri'},'@tauri-apps/api/event':events,'./pet-model':{PetModel:Model},
  './dialogue/bubble':{DialogueBubble:class{}},'./interaction/interaction':{InteractionService:class{}},
  './behavior':{BehaviorService:Behavior},'./emotion':{MoodEngine:Mood},'./pet-ai':{PetAI:AI},
 },{document:{getElementById:()=>({})},window:{},fetch:async()=>{fetchStarted.resolve();await fetchGate.promise;return {arrayBuffer:async()=>new ArrayBuffer(0)}}});
 const app=Object.create(PetApp.prototype);
 Object.assign(app,{_pendingShellActions:[],_shellActionsReady:false,_settingsSyncTask:null,_settings:{mirror:false},
  _dialogue:{loadAll:()=>{dialogueStarted.resolve();return dialogueGate.promise}},_hitAreas:{load:()=>hitGate.promise},
  _initializeChat(){this._chatView={setOpen:()=>calls.push('open-chat')}},_wirePointerEvents(){},_startLoop(){this._running=true},
  applySettings(settings,initial){this._settings=settings;applied.push(initial)},
  _playRandom(source){assert.ok(this._bubble&&this._interaction&&this._running);assert.equal(source,'manual');calls.push('random-speech')},
 });
 const loading=app.loadModel('/model/16.model3.json');await listening.promise;
 assert.equal(app._model,undefined,'IPC注册未完成时不能进入资源加载');
 ipc.resolve();await fetchStarted.promise;
 await events.emitTo('pet','tray-action',{action:'random-speech'});
 await events.emitTo('pet','tray-action',{action:'play-action',name:'cheerful_bounce'});
 await events.emitTo('pet','settings-changed',{mirror:true});assert.equal(app._settings.mirror,true);
 assert.deepEqual(calls,[]);fetchGate.resolve();await modelStarted.promise;
 await events.emitTo('pet','tray-action',{action:'random-speech'});
 await events.emitTo('pet','tray-action',{action:'express',name:'shy'});
 modelGate.resolve();await dialogueStarted.promise;
 await events.emitTo('pet','tray-action',{action:'set-mood',name:'happy'});
 dialogueGate.resolve();await Promise.resolve();
 await events.emitTo('pet','tray-action',{action:'open-chat'});
 assert.deepEqual(calls,[],'命中区域尚未就绪也不能提前补发');
 hitGate.resolve();await loading;
 assert.deepEqual(calls,['random-speech','cheerful_bounce','shy','happy','open-chat']);
 assert.deepEqual(applied,[false,true]);assert.equal(app._settings.mirror,true);
 assert.equal(app._pendingShellActions.length,0);
 await app._wireSettingsSync();await app._wireSettingsSync();assert.equal(registrations,3,'重载不重复监听');
 await events.emitTo('pet','tray-action',{action:'random-speech'});assert.equal(calls.length,6);
});

test('Tauri监听失败降级加载模型，可见提示重试只补装失败项且不重建模型',async()=>{
 const attempts=new Map(),listeners=new Map(),notices=[],errors=[];let failing=true,fetches=0,clicks=0,random=0;
 const notice={remove(){this.removed=true}};
 class Model{async loadFromSetting(){}isReady(){return true}actionManifest=[]}
 const {PetApp}=load('pet-app',{
  './platform':{platform:'tauri'},'@tauri-apps/api/event':{async listen(name,handler){
   attempts.set(name,(attempts.get(name)??0)+1);
   if(name==='tray-action'&&failing)throw new Error('listen IPC failed');
   assert.equal(listeners.has(name),false,'成功项不能重复注册');listeners.set(name,handler);return ()=>{};
  }},
  './startup-notice':{showStartupNotice(...args){notices.push(args);return notice}},
  './pet-model':{PetModel:Model},'./dialogue/bubble':{DialogueBubble:class{}},
  './interaction/interaction':{InteractionService:class{onClick(){clicks++}}},
  './behavior':{BehaviorService:class{setActionMeta(){}start(){}}},
  './emotion':{MoodEngine:class{onMoodChanged(){}}},'./pet-ai':{PetAI:class{}},
 },{console:{...console,error:(...args)=>errors.push(args)},document:{getElementById:()=>({})},window:{},
  fetch:async()=>{fetches++;return {arrayBuffer:async()=>new ArrayBuffer(0)}}});
 const app=Object.create(PetApp.prototype);
 Object.assign(app,{_pendingShellActions:[],_settingsSyncTask:null,_settings:{},
  _dialogue:{async loadAll(){}},_hitAreas:{async load(){}},_initializeChat(){},_wirePointerEvents(){},
  _startLoop(){this._running=true},applySettings(s){this._settings=s},_playRandom(){random++}});
 await app.loadModel('/model.json');
 assert.equal(fetches,1);assert.equal(app._model.isReady(),true);assert.equal(app._running,true);
 app._interaction.onClick();assert.equal(clicks,1,'本地互动服务仍可使用');
 assert.equal(app._shellActionsReady,true);assert.equal(app._settingsSyncTask,null,'失败的Promise不缓存');
 assert.equal(notices.length,1);assert.match(String(notices[0][2]),/tray-action: Error: listen IPC failed/);
 assert.equal(errors.length,1);assert.equal(app._shellSyncNotice,notice);
 listeners.get('settings-changed')({payload:{mirror:true}});assert.equal(app._settings.mirror,true,'成功项在降级期间仍工作');
 await assert.rejects(notices[0][3](),/listen IPC failed/);assert.equal(app._shellSyncNotice,notice);
 failing=false;await notices[0][3]();assert.equal(app._shellSyncNotice,null);assert.equal(fetches,1);
 assert.equal(attempts.get('settings-changed'),1);assert.equal(attempts.get('global-mouse'),1);assert.equal(attempts.get('tray-action'),3);
 listeners.get('tray-action')({payload:{action:'random-speech'}});assert.equal(random,1);
 await app._wireSettingsSync();assert.equal(attempts.get('tray-action'),3,'成功任务复用');
});

test('监听并发重试共享任务且等待全部注册结束，模块导入失败后也可恢复',async()=>{
 let available=false,release;const gate=new Promise(resolve=>release=resolve);const attempts=[];
 const imports={'./platform':{platform:'tauri'}};
 Object.defineProperty(imports,'@tauri-apps/api/event',{get(){
  if(!available)throw new Error('event module unavailable');
  return {async listen(name){attempts.push(name);await gate;return ()=>{}}};
 }});
 const {PetApp}=load('pet-app',imports);const app=Object.create(PetApp.prototype);
 await assert.rejects(app._wireSettingsSync(),/event module unavailable/);assert.equal(app._settingsSyncTask,null);
 available=true;const first=app._wireSettingsSync(),second=app._wireSettingsSync();assert.equal(first,second);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(attempts.length,3);
 release();await Promise.all([first,second]);await app._wireSettingsSync();assert.equal(attempts.length,3);
});

function noticeDocument(){
 const nodes=[];
 return {nodes,body:{append(node){nodes.push(node)}},getElementById:id=>nodes.find(n=>n.id===id&&!n.removed),
  createElement:tag=>({tag,children:[],setAttribute(name,value){this[name]=value},append(...children){this.children.push(...children)},remove(){this.removed=true}})};
}

test('启动提示以纯文本展示错误，重试时禁用按钮，失败可再试且成功移除',async()=>{
 const document=noticeDocument(),errors=[];let release,fail=true;
 const {showStartupNotice}=load('startup-notice',{}, {document,console:{...console,error:(...args)=>errors.push(args)}});
 const notice=showStartupNotice('sync','同步暂不可用',new Error('<img src=x onerror=alert(1)>'),
  async()=>{await new Promise(resolve=>release=resolve);if(fail)throw new Error('again')});
 assert.equal(notice.role,'alert');const [text,button]=notice.children;
 assert.match(text.textContent,/<img src=x/);assert.equal(text.innerHTML,undefined);
 const first=button.onclick();assert.equal(button.disabled,true);release();await first;
 assert.equal(button.disabled,false);assert.equal(notice.removed,undefined);assert.match(text.textContent,/again/);assert.equal(errors.length,1);
 fail=false;const second=button.onclick();release();await second;assert.equal(notice.removed,true);
});

for(const failure of ['construct','initialize-throw','initialize-false','load'])test(`入口捕获${failure}失败并提供重新加载，桥接入口先于模型加载`,async()=>{
 const notices=[],errors=[],window={location:{reload(){this.reloaded=true}}};
 class App{
  constructor(){if(failure==='construct')throw new Error('construct failed')}
  initialize(){if(failure==='initialize-throw')throw new Error('initialize failed');return failure!=='initialize-false'}
  async loadModel(){assert.equal(window.__pet,this);assert.equal(typeof window.__applySettingsFromAndroid,'function');throw new Error('load failed')}
 }
 load('main',{'./pet-app':{PetApp:App},'./startup-notice':{showStartupNotice:(...args)=>notices.push(args)}},
  {window,console:{...console,log(){},error:(...args)=>errors.push(args)},Live2DCubismCore:{Version:{csmGetLatestMocVersion(){},csmGetMocVersion(){},csmGetVersion:()=>6}}});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(notices.length,1);assert.equal(errors.length,1);
 assert.equal(notices[0][0],'pet-startup-error');assert.match(String(notices[0][2]),/failed|WebGL2/);
 await notices[0][3]();assert.equal(window.location.reloaded,true);
});

test('闲聊不抽取抚摸/点击反应或其他时段的台词',()=>{
 const {DialogueStore,timeScene}=load('dialogue/dialogue');const d=new DialogueStore();const current=timeScene(new Date());
 for(const scene of ['user_click','interaction','head_petting','morning','deep_night',current])d._files.set(scene,{entries:[{id:scene,text:scene}]});
 for(let i=0;i<100;i++)assert.ok(['user_click',current].includes(d.selectRandom().id));
});

test('气泡取消立即释放说话状态，旧异步回调不影响新会话',async()=>{
 const waits=[];const element={id:'',style:{},textContent:'',classList:{add(){},remove(){}}};
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
  _syncWindowMetrics(){},_moveWindowBy(){},_onDragFinished(){},_cancelSnapAnimation(){this._snapAnimToken++},_bubble:{cancel(){}}});
 app._wirePointerEvents();
 const event=(overrides={})=>({isPrimary:true,button:touch?0:2,buttons:touch?1:2,clientX:400,clientY:200,screenX:400,screenY:200,pointerType:touch?'touch':'mouse',...overrides});
 return {...h,app,canvasEvents,windowEvents,event};
}

test('真实事件接线：右键失焦可恢复，普通pointerup后的lostcapture不抹掉反馈',()=>{
 const h=pointerHarness();const e=h.canvasEvents;
 e.pointerdown(h.event());assert.equal(h.service.petting.state,'pressed');h.advance(1000/60);h.windowEvents.blur();
 assert.equal(h.service.petting.state,'finishing');
 for(let i=0;i<180;i++)h.advance(1000/60);
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

test('聊天停止保留片段，旧流的迟到文字不能污染新回复',async()=>{
 const h=streamHarness();const first=h.chat.send('第一条');
 h.requests[0].push({type:'segment',id:'1',text:'旧片段'});await flushChat();
 h.chat.stop();assert.equal(h.chat.latest.status,'stopped');assert.equal(h.chat.latest.text,'旧片段');
 const second=h.chat.send('第二条');
 h.requests[0].push({type:'segment',id:'2',text:'迟到内容'});await first;
 assert.equal(h.chat.busy,true);
 h.requests[1].push({type:'segment',id:'1',text:'新的回答'});await flushChat();
 h.requests[1].push({type:'done'});await second;
 assert.equal(h.chat.latest.text,'新的回答');assert.equal(h.chat.latest.status,'complete');
 assert.equal(h.chat.busy,false);
});

test('重试替换失败的助手回复，不重复用户消息，重复片段只取一次',async()=>{
 const h=streamHarness();const first=h.chat.send('问题');h.requests[0].push({type:'done'});await first;
 assert.equal(h.chat.canRetry,true);assert.equal(h.chat.latest.status,'error');
 const retry=h.chat.retry();assert.equal(h.chat.messages.length,2);
 h.requests[1].push({type:'segment',id:'1',text:'回答'});await flushChat();
 h.requests[1].push({type:'segment',id:'1',text:'回答'});await flushChat();
 h.requests[1].push({type:'done'});await retry;
 assert.equal(h.chat.latest.text,'回答');assert.equal(h.chat.canRetry,false);
});

test('聊天刷新恢复记录但不恢复正在生成状态；空白输入不启动请求',async()=>{
 const h=streamHarness();await h.chat.send('   ');assert.equal(h.requests.length,0);
 const task=h.chat.send('保留的问题');h.requests[0].push({type:'segment',id:'1',text:'部分回答'});await flushChat();
 const restored=new h.ChatController(h.chat.provider,h.storage);
 assert.equal(restored.messages.length,2);assert.equal(restored.latest.text,'部分回答');
 assert.equal(restored.latest.status,'stopped');assert.equal(restored.busy,false);assert.equal(restored.canRetry,true);
 h.chat.stop();h.requests[0].push({type:'done'});await task;
});

test('聊天表演：表情持久到下一个指令或取消，动作一次限频，触摸让位后恢复且不补播',()=>{
 const {ChatPerformance}=load('chat/performance');let now=0,busy=false;const calls=[];
 const p=new ChatPerformance({expressions:()=>['happy','shy'],actions:()=>['wave'],express:n=>calls.push(['express',n]),clearExpression:()=>calls.push(['clear']),play:n=>calls.push(['play',n]),busy:()=>busy},()=>now);
 p.cue({expression:'happy',action:'wave'});assert.equal(calls.filter(x=>x[0]==='play').length,1);
 busy=true;p.tick();assert.equal(calls.at(-1)[0],'clear');
 p.cue({expression:'happy',action:'wave'});busy=false;p.tick();
 assert.equal(calls.at(-1)[0],'express');assert.equal(calls.filter(x=>x[0]==='play').length,1);
 // 持久语义：远超旧 3.5s 临时窗口后表情仍保持
 now=60000;p.tick();assert.equal(p.active,true);assert.equal(calls.filter(x=>x[0]==='express').length,2);
 // 下一个表情指令覆盖
 p.cue({expression:'shy'});assert.equal(calls.at(-1)[0],'express');assert.equal(calls.at(-1)[1],'shy');
 p.cancel();const n=calls.length;now=1000;p.tick();assert.equal(calls.length,n);assert.equal(p.active,false);
 p.cue({expression:'arbitrary',action:'arbitrary'});assert.equal(calls.length,n);
});

test('聊天表演：情绪引擎覆盖表情后逐帧拿回（host.expression 实际值比对）',()=>{
 const {ChatPerformance}=load('chat/performance');let current=null;
 const p=new ChatPerformance({expressions:()=>['happy'],actions:()=>[],expression:()=>current,express:n=>{current=n},clearExpression:()=>{current=null},play:()=>{},busy:()=>false});
 p.cue({expression:'happy'});assert.equal(current,'happy');
 current='sad'; // 模拟情绪引擎/设置面板预览覆盖聊天表情
 p.tick();assert.equal(current,'happy');
 p.cancel();assert.equal(current,null);
});

test('聊天表演：重复切换保持中的表情不重放 express',()=>{
 const {ChatPerformance}=load('chat/performance');let count=0;
 const p=new ChatPerformance({expressions:()=>['happy','shy'],actions:()=>[],express:n=>{count++},clearExpression:()=>{},play:()=>{},busy:()=>false});
 p.cue({expression:'happy'});p.cue({expression:'happy'});p.cue({expression:'happy'});
 assert.equal(count,1);
 p.cue({expression:'shy'});assert.equal(count,2);
 p.cue({expression:'shy'});assert.equal(count,2);
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
 // 表演指令行天然独立成段（独占一行协议；compose 据此识别 cue 页）
 assert.deepEqual(splitAgentMessageIntoSegments('你好\n[[agent_cue express=happy]]\n打扰了\n[[agent_cue express=shy]]'),['你好','[[agent_cue express=happy]]','打扰了','[[agent_cue express=shy]]']);
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

test('MSK Provider：整段回复带消息 id（无请求期 cue），请求携带表演清单，失败重试复用 clientRequestId',async()=>{
 const manifest=load('chat/performance-manifest');
 const {MskChatProvider}=load('chat/msk/provider',{'../performance-manifest':manifest},{crypto});
 let perfArg;
 const ac=new AbortController();
 const provider=new MskChatProvider({send:async(sessionId,text,signal,requestId,poll,performance)=>{perfArg=performance;return {text:'真让人担心你呀。',messageId:'m1'}}},'s1');
 const events=[];
 for await(const e of provider.reply({messages:[{role:'user',text:'你好'}],signal:ac.signal}))events.push(e);
 assert.deepEqual(events.map(e=>e.type),['segment','done']);
 assert.equal(events[0].text,'真让人担心你呀。');assert.equal(events[0].messageId,'m1');
 assert.equal(events[0].cue,undefined);
 // 请求携带 name+hint 表演清单 = 桌宠环境标记
 assert.ok(perfArg&&perfArg.expressions.some(i=>i.name==='happy'&&i.hint==='开心')&&perfArg.actions.some(i=>i.name==='wave'&&i.hint));
 for(const name of newActionNames)assert.ok(perfArg.actions.some(i=>i.name===name&&i.hint),name);
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
