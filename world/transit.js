import * as THREE from 'three';
import { GLTFLoader } from '../assets/vendor/GLTFLoader.js';
import { DRACOLoader } from '../assets/vendor/DRACOLoader.js';

const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const ease=x=>{x=clamp(x);return x*x*(3-2*x);};
const V=(x,y,z)=>new THREE.Vector3(x,y,z);
/** A self-contained journey, never dependent on the loading scene's render loop.
 * The old street supplies illustrative window scenery; assets are disposed separately.
 * Readiness, minimum story length and arrival are separate gates. No fixed loading delay.
 */
export class Transit {
 constructor(){this.active=false;this.stage='idle';this.progress=0;}
 async run({kind,from,to,model,origin,night,prepare,commit,reduced=false}){
  if(this.active)throw new Error('A journey is already running.');
  this.active=true;this.elapsed=0;this.progress=0;this.kind=kind;this.stage='boarding';this.ready=false;this.skip=reduced;
  this.el=document.createElement('section');this.el.className='transit';this.el.role='dialog';this.el.setAttribute('aria-modal','true');this.el.setAttribute('aria-label',`${kind==='taxi'?'Taxi':'Flight'} to ${to}`);
  this.el.innerHTML='<canvas aria-hidden="true"></canvas><div class="transit-shade"></div><div class="transit-place"><span></span><strong></strong></div><button class="transit-skip">Skip journey ↗</button><p class="transit-status sr-only" role="status"></p><div class="transit-error" hidden><p></p><button>Back to the street</button></div>';
  document.body.append(this.el);this.el.querySelector('span').textContent=from+' →';this.el.querySelector('strong').textContent=to;
  const skip=this.el.querySelector('.transit-skip');skip.onclick=()=>{this.skip=true;skip.textContent=this.ready?'Arriving…':'Waiting for the street…';};skip.focus();
  const key=e=>{if(e.key==='Escape'){e.preventDefault();this.skip=true;}if(e.key==='Tab'){e.preventDefault();(this.el.querySelector('.transit-error:not([hidden]) button')||skip).focus();}};
  this.el.addEventListener('keydown',key);this.el.querySelector('.transit-status').textContent=`${kind==='taxi'?'Taking a taxi':'Flying'} from ${from} to ${to}. Loading the destination.`;
  const readiness=prepare(p=>{this.progress=p;});readiness.catch(()=>{});
  try{
   if(!reduced){await this.setup(kind,model,origin,night);this.begin();}
   const payload=await readiness;this.ready=true;this.progress=1;
   // Cruise can last as long as necessary, but loading never ends it before boarding.
   while(!this.skip&&(this.elapsed||0)<(kind==='taxi'?7.5:10.5))await new Promise(r=>setTimeout(r,80));
   this.stage='arrival';this.arrivalAt=this.elapsed||0;
   this.el.querySelector('.transit-status').textContent='Arriving at '+to+'.';
   if(!this.skip&&!reduced)await new Promise(r=>setTimeout(r,kind==='taxi'?2900:1800));
   this.el.classList.add('covered');await new Promise(r=>setTimeout(r,reduced?0:450));
   cancelAnimationFrame(this.raf);
   // Commit only after the target assets are available. Failed fetches retain the old street.
   await commit(payload);
   this.el.classList.add('revealing');await new Promise(r=>setTimeout(r,reduced?0:600));
   this.stage='complete';return true;
  }catch(error){
   console.error('Journey:',error);this.stage='error';this.el.classList.add('failed');
   const panel=this.el.querySelector('.transit-error');panel.hidden=false;
   panel.querySelector('p').textContent='This street could not be opened. Your current street is still here.';
   skip.hidden=true;await new Promise(r=>{panel.querySelector('button').onclick=r;panel.querySelector('button').focus();});return false;
  }finally{this.dispose();}
 }
 async setup(kind,model,origin,night){
  const canvas=this.el.querySelector('canvas');this.renderer=new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance'});
  this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));this.renderer.outputEncoding=THREE.sRGBEncoding;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=night?.night>.5?.72:1;
  this.scene=new THREE.Scene();this.scene.background=new THREE.Color(kind==='taxi'&&night?.night>.5?0x111c2b:0xa9c7db);this.scene.fog=new THREE.Fog(this.scene.background,80,280);
  this.camera=new THREE.PerspectiveCamera(58,innerWidth/innerHeight,.025,550);
  this.scene.add(new THREE.HemisphereLight(0xe8f1ff,0x514338,1.5));const sun=new THREE.DirectionalLight(0xffe5be,2.3);sun.position.set(-20,30,10);this.scene.add(sun);
  if(kind==='taxi'&&night?.night>.5){sun.intensity=.12;this.scene.children.find(o=>o.isHemisphereLight).intensity=.33;const dash=new THREE.PointLight(0xffcc91,1.1,8);dash.position.set(0,1.4,0);this.scene.add(dash);}
  const decoder=new DRACOLoader().setDecoderPath('../assets/vendor/draco/').setWorkerLimit(1);this.decoder=decoder;
  const loader=new GLTFLoader().setDRACOLoader(decoder),names=kind==='taxi'?['taxi-real-v22']:['aircraft-real-v22','flight-cabin','aircraft-wing-v22'];
  this.assets=await Promise.all(names.map(n=>loader.loadAsync('../assets/folded-city/transit/'+n+'.glb').then(g=>g.scene)));
  this.assets.forEach(a=>this.scene.add(a));[this.vehicle,this.cabin]=this.assets;if(kind==='taxi')this.cabin=this.vehicle;
  this.vehicle.visible=true;this.cabin.visible=kind==='taxi';
  this.vehicle.traverse(o=>{if(o.isMesh)o.frustumCulled=false;});
  if(kind==='taxi'){
   this.door=this.cabin.getObjectByName('taxi-door');
   this.scenery=model.clone(true);this.scenery.traverse(o=>{
    if(!o.isMesh)return;
    o.material=Array.isArray(o.material)?o.material.map(m=>m.clone()):o.material.clone();
    // No bend callback is copied: the transit is a flat, physical street.
    o.customDepthMaterial=undefined;o.customDistanceMaterial=undefined;o.castShadow=false;o.receiveShadow=false;
   });
   this.scenery.position.set(-origin.x,0,-origin.z);this.sceneryBase=this.scenery.position.clone();this.scene.add(this.scenery);
  }else{
   this.scene.fog.near=180;this.scene.fog.far=550;
   this.skyPlate=await new THREE.TextureLoader().loadAsync('../assets/folded-city/transit/cloudscape-v21.jpg');this.skyPlate.encoding=THREE.sRGBEncoding;this.scene.background=this.skyPlate;
   this.clouds=new THREE.Group();this.scene.add(this.clouds);

   // The actual downloaded A350 wing, seen from a physically scaled passenger window.
   this.wing=this.assets[2];this.wing.rotation.y=-Math.PI/2;this.wing.position.set(1,-1.5,.5);this.wing.visible=false;
   this.cabin.scale.setScalar(.25);
  }
  const env=document.createElement('canvas');env.width=512;env.height=256;const ctx=env.getContext('2d'),sky=ctx.createLinearGradient(0,0,0,256);sky.addColorStop(0,'#819bb3');sky.addColorStop(.42,'#d9e2e7');sky.addColorStop(.53,'#a6aaa9');sky.addColorStop(1,'#30343a');ctx.fillStyle=sky;ctx.fillRect(0,0,512,256);ctx.fillStyle='#fff6df';ctx.fillRect(130,55,80,30);this.scene.environment=new THREE.CanvasTexture(env);this.scene.environment.mapping=THREE.EquirectangularReflectionMapping;this.scene.environment.encoding=THREE.sRGBEncoding;
  this.resize=()=>{this.renderer.setSize(innerWidth,innerHeight);this.camera.aspect=innerWidth/innerHeight;this.camera.updateProjectionMatrix();};window.addEventListener('resize',this.resize);this.resize();
 }
 begin(){
  let previous=performance.now();this.elapsed=0;
  const frame=now=>{const dt=document.hidden?0:Math.min((now-previous)/1000,.1);previous=now;this.elapsed+=dt;this.frame(this.elapsed);this.raf=requestAnimationFrame(frame);};this.raf=requestAnimationFrame(frame);
 }
 frame(t){
  this.el.dataset.stage=this.stage;this.el.dataset.elapsed=t.toFixed(2);
  if(this.kind==='taxi'){
   const enter=ease((t-.6)/2.0),leave=this.stage==='arrival'?ease((t-this.arrivalAt-1.2)/1.6):0;
   const ride=Math.max(0,t-3),out=Math.max(1-enter,leave);
   this.camera.position.copy(V(-.42,1.10,.83).lerp(V(-3.0,1.7,1.5),out));
   this.camera.position.y+=Math.sin(t*9)*.007*enter*(1-leave);
   this.camera.lookAt(V(-3,1.25,-1.4).lerp(V(-.1,1.0,.3),out));
   this.camera.fov=58+out*5;this.camera.updateProjectionMatrix();
   this.vehicle.visible=true;
   if(this.door)this.door.rotation.y=-(ease(t/.6)*(1-ease((t-2.0)/.65))+leave)*1.15;
   const braking=this.stage==='arrival'?clamp(t-this.arrivalAt,0,1.2):0;
   const distance=this.stage==='arrival'?Math.max(0,this.arrivalAt-3)*5.7+5.7*(braking-braking*braking/2.4):ride*5.7;
   this.scenery.position.z=this.sceneryBase.z+distance;
   if(this.stage!=='arrival')this.stage=t<2.8?'boarding':this.ready?'cruising':'loading-in-transit';
  }else{
   const inside=ease((t-2.0)/1.1);this.vehicle.visible=inside<.95;this.cabin.visible=inside>.7;this.wing.visible=inside>.7;
   if(inside<.8){this.vehicle.rotation.z=-.08*Math.sin(t);this.vehicle.position.set(0,t*.7,-t*4);this.camera.position.set(-43,17+t,-45-t*2);this.camera.lookAt(this.vehicle.position);}
   else{this.camera.position.set(.005,.32,.125);this.camera.lookAt(.0,.3175,-8);this.camera.rotation.z=Math.sin(t*.4)*.012;}
   this.skyPlate.offset.x=.025*Math.sin(t*.025);this.skyPlate.repeat.set(.94,.94);this.skyPlate.offset.y=.02;
   this.clouds.position.z=(t*9)%120;this.clouds.position.y=-ease((t-1)/5)*8;
   if(this.stage==='arrival'){const p=ease((t-this.arrivalAt)/1.7);this.clouds.position.y+=p*10;this.camera.rotation.z=-p*.09;}
   else this.stage=t<3?'takeoff':this.ready?'cruising':'loading-in-transit';
  }
  this.renderer.render(this.scene,this.camera);
 }
 dispose(){
  cancelAnimationFrame(this.raf);if(this.resize)window.removeEventListener('resize',this.resize);
  // Scenery geometry/textures belong to the old street; never dispose shared resources.
  this.scenery?.traverse(o=>{if(o.isMesh)for(const m of [o.material].flat())m.dispose();});
  const gs=new Set(),ms=new Set(),ts=new Set();
  for(const root of [...(this.assets||[]),this.clouds,this.wing].filter(Boolean))root.traverse(o=>{if(o.geometry)gs.add(o.geometry);for(const m of [o.material].flat().filter(Boolean)){ms.add(m);for(const value of Object.values(m))if(value?.isTexture)ts.add(value);}});
  this.skyPlate?.dispose();this.skyPlate=null;gs.forEach(g=>g.dispose());ms.forEach(m=>m.dispose());ts.forEach(t=>t.dispose());
  this.scene?.environment?.dispose();this.renderer?.dispose();this.renderer?.forceContextLoss();this.decoder?.dispose();this.el?.remove();
  this.active=false;this.assets=null;this.scenery=null;this.clouds=null;this.wing=null;this.renderer=null;
 }
 status(){return {active:this.active,kind:this.kind,stage:this.stage,ready:this.ready,progress:this.progress,elapsed:this.elapsed||0};}
}
