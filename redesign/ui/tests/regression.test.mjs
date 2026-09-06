import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,readdirSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const root=new URL('../',import.meta.url);
function load(name,imports={}){
 const code=ts.transpileModule(readFileSync(new URL(`src/${name}.ts`,root),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
 const exports={};vm.runInNewContext(code,{exports,require:id=>imports[id]??{},console,setTimeout,clearTimeout});return exports;
}
const {GazeController}=load('gaze');
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
