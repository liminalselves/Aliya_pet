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
function load(name,imports={}){
 const code=ts.transpileModule(readFileSync(new URL(`src/${name}.ts`,root),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
 const exports={};vm.runInNewContext(code,{exports,require:id=>imports[id]??{},console,setTimeout,clearTimeout});return exports;
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
test('副屏负坐标、任务栏、关闭吸附及超大窗口的边界',async()=>{
 for(const [pos,size,snap,want] of [
  [[-2050,950],[300,400],false,[-1920,640]],
  [[-1650,12],[300,400],true,[-1650,0]],
  [[200,500],[2500,1600],false,[-1920,0]],
 ]){
  let moved;const api={currentMonitor:async()=>({scaleFactor:1,workArea:{position:{x:-1920,y:0},size:{width:1920,height:1040}}}),PhysicalPosition:class{constructor(x,y){this.x=x;this.y=y}}};
  const {PetApp}=load('pet-app',{'@tauri-apps/api/window':api,'./settings':{saveSettings(){}}});const app=Object.create(PetApp.prototype);
  Object.assign(app,{_tauriWindow:{outerSize:async()=>({width:size[0],height:size[1]}),setPosition:async p=>{moved=p}},_snapAnimToken:0,_windowMoveTask:null,_settings:{snapEdges:snap},_winPhysX:pos[0],_winPhysY:pos[1]});
  app._onDragFinished();await new Promise(r=>setImmediate(r));assert.deepEqual([moved.x,moved.y],want);
 }
});

test('半闭眼收小瞳孔行程，完全闭眼回中',()=>{
 const {controller,model,values}=gaze();controller.setTarget(1,0);
 for(let i=0;i<90;i++){values.clear();controller.update(model,1/30,{motionActive:false,reduction:1,eyeOpenness:.5})}
 assert.ok(Math.hypot(values.get('x'),values.get('y'))<=10.000001);
 controller.update(model,1/30,{motionActive:false,reduction:1,eyeOpenness:0});assert.equal(Math.hypot(values.get('x'),values.get('y')),0);
});
