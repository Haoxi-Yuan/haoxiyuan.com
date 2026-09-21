import * as THREE from 'three';
import { GLTFLoader } from '../assets/vendor/GLTFLoader.js';
import { DRACOLoader } from '../assets/vendor/DRACOLoader.js';
import { Daylight, SITES, zoneOffset, zoneLabel, openAt, popularityAt, clockLabel, DAY_NAMES } from './daylight.js';
import { Interior } from './interior.js?v=26';
import { RoomInteractions } from './room-interactions.js?v=25';
import { INTERIOR_REGISTRY } from './interior-registry.js?v=27';
import { KomaInteractions } from './koma-interactions.js?v=24';
import { People } from './people.js?v=28';
import { Console } from './console.js?v=33';
import { Transit } from './transit.js?v=22';
const transit=new Transit();

const $=id=>document.getElementById(id);
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const state={phase:'loading',time:0,distance:0,targetDistance:0,paused:false,loaded:false,skip:false,drag:null,lookX:0,lookY:0};
const CITIES=[
 {id:'singapore',name:'Singapore',district:'Keong Saik Road · Chinatown',model:'keong-saik-street-v20.glb',places:'keong-saik-places-v20.json',people:'keong-saik-people-v20.json',poster:'keong-saik-poster-v20.jpg'},
 {id:'tokyo',name:'Tokyo',district:'Denboin-dori · Asakusa',model:'tokyo-city-v16.glb',places:'tokyo-places.json',poster:'tokyo-poster-v14.jpg'},
 {id:'london',name:'London',district:'Berwick Street · Soho',model:'london-city-v16.glb',places:'london-places.json',poster:'london-poster-v14.jpg'}
];
const SG_STREETS={
 'keong-saik':{...CITIES[0],street:'keong-saik'},
 temple:{id:'singapore',name:'Singapore',street:'temple',district:'Temple Street · Chinatown',model:'singapore-city-v16.glb',places:'singapore-places.json',people:'singapore-people-v16.json',poster:'singapore-poster-v14.jpg'}
};
Object.assign(CITIES[0],SG_STREETS[new URLSearchParams(location.search).get('street')]||SG_STREETS['keong-saik']);
let cityIndex=Math.max(0,CITIES.findIndex(c=>c.id===new URLSearchParams(location.search).get('city')));
const CURVE_START=29, BEND_RADIUS=42, STRIP_STEP=26;let TRAVEL_MAX=124;
const uniform={fold:{value:.22},start:{value:CURVE_START}};
Object.assign(state,{endingTime:0,finished:false,foldTarget:.22,startTarget:CURVE_START});
let journeyExit,stripPosition=cityIndex+9,stripTarget=cityIndex+9,stripVelocity=0;
let streetLayout=null;
for(const id of ['number-strip','tail-strip']){
 const fragment=document.createDocumentFragment();
 for(let i=0;i<24;i++){const cell=document.createElement('span');cell.textContent='0'+(i%3+1);fragment.append(cell);}
 $(id).replaceChildren(fragment);
}

const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
/** Engraved type carries its own text in data-text, for the two colour-fringe layers. */
const engrave=(el,text)=>{el.textContent=text;el.dataset.text=text;};
const smooth=x=>{x=clamp(x,0,1);return x*x*(3-2*x)};
let renderer,city,tunnel,camera,tunnelCamera,exitLight,headLight,lampPool=[],lampSpots=[],labels=[],raf=0,last=0,renderCount=0,machineMoving=false;
let daylight=null,places=[],shopParts=new Map(),nightGlow=[],facadeParts=[],sunlit={},lastShopKey='';
let interior=null,interiorLoad=null,doorSpots=[],interiorKeys={},interiorZone='',interiorId=null;
let landscapeStats=null;
let handling=null,handlingLoad=null,loadingProgress=0;
let machines=null,machinesLoad=null;
let loadVersion=0,modelRoot=null,stats={};
const point=new THREE.Vector3();
const bendGLSL=`
attribute vec2 bendAnchor;
uniform float uFold;
uniform float uBendStart;
float bendAngle(float s){return min(max(s-uBendStart,0.0)/42.0,3.14159265*uFold);}
vec2 groundPoint(float s){
 if(s<=uBendStart)return vec2(s,0.0);
 float a=bendAngle(s);float tail=max(s-uBendStart-42.0*3.14159265*uFold,0.0);
 return vec2(uBendStart+42.0*sin(a)+tail*cos(a),42.0*(1.0-cos(a))+tail*sin(a));
}
vec3 bendPoint(vec3 p){
 // Blender exports texture V flipped; zero here means a rigid surface anchor.
 bool rigid=bendAnchor.y<0.5;float s=rigid?bendAnchor.x:-p.z;
 float a=bendAngle(s);float c=cos(a),sn=sin(a);vec2 g=groundPoint(s);float offset=rigid?-p.z-s:0.0;
 return vec3(p.x,g.y+offset*sn+p.y*c,-(g.x+offset*c-p.y*sn));
}
`;
function bendMaterial(material,depth=false){
 const mat=material.clone();
 mat.onBeforeCompile=shader=>{
  Object.assign(shader.uniforms,{uFold:uniform.fold,uBendStart:uniform.start});
  shader.vertexShader=bendGLSL+shader.vertexShader;
  shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\ntransformed = bendPoint(transformed);');
  if(!depth)shader.vertexShader=shader.vertexShader.replace('#include <beginnormal_vertex>',`#include <beginnormal_vertex>
   float a=bendAngle(bendAnchor.y<0.5?bendAnchor.x:-position.z);
   objectNormal.yz=mat2(cos(a),sin(a),-sin(a),cos(a))*objectNormal.yz;`);
 };
 mat.customProgramCacheKey=()=>depth?'circular-ground-depth-v12':'circular-ground-lit-v12';
 return mat;
}
function updateCurve(dt=0){
 const progress=clamp(state.distance/TRAVEL_MAX,0,1);
 const close=state.phase==='ending'?smooth(state.endingTime/3.2):state.finished?1:0;
 const exitTravel=state.finished?16:state.phase==='ending'?16*smooth(state.endingTime/4.5):0;
 state.foldTarget=.22+.76*smooth(progress)+.02*close;
 state.startTarget=CURVE_START+state.distance*.78+exitTravel;
 uniform.fold.value=reduced.matches?state.foldTarget:THREE.MathUtils.damp(uniform.fold.value,state.foldTarget,2.3,dt);
 uniform.start.value=Math.max(-28+state.distance+exitTravel+18,reduced.matches?state.startTarget:THREE.MathUtils.damp(uniform.start.value,state.startTarget,4,dt));
}
function foldPoint(p,anchor=null){
 const s=anchor??-p.z,offset=anchor===null?0:-p.z-anchor,start=uniform.start.value;if(s<=start)return p;
 const a=Math.min((s-start)/BEND_RADIUS,Math.PI*uniform.fold.value),tail=Math.max(0,s-start-BEND_RADIUS*Math.PI*uniform.fold.value),h=p.y;
 p.z=-(start+BEND_RADIUS*Math.sin(a)+tail*Math.cos(a)+offset*Math.cos(a)-h*Math.sin(a));p.y=BEND_RADIUS*(1-Math.cos(a))+tail*Math.sin(a)+offset*Math.sin(a)+h*Math.cos(a);return p;
}
function announceCity(){
 const c=CITIES[cityIndex];const url=new URL(location.href);url.searchParams.set('city',c.id);if(c.street)url.searchParams.set('street',c.street);else url.searchParams.delete('street');history.replaceState(null,'',url);document.title=c.name+' — Haoxi Yuan';
 engrave($('city-name'),c.name);$('city-district').textContent=c.district;
 machines?.setCity(cityIndex,c.name,c.district);
 // Re-strike the name so a change of city reads as the plate being stamped again.
 const plate=$('city-name');plate.classList.remove('restrike');void plate.offsetWidth;plate.classList.add('restrike');
 $('location-control').setAttribute('aria-label',c.name+', '+c.district+'. Choose a city');
 $('world').setAttribute('aria-label','Walk through '+c.name+'. Scroll to move forward or backward; drag to look around.');
 $('shop-labels').setAttribute('aria-label','Places in '+c.district);
 $('fallback').src='../assets/folded-city/'+c.poster;$('fallback').alt=c.name+' original 3D neighborhood study';
 $('city-mechanism').dataset.city=c.id;
 for(const el of document.querySelectorAll('[data-city]'))if(el.tagName==='BUTTON')el.setAttribute('aria-pressed',String(el.dataset.city===c.id&&(!el.dataset.street||el.dataset.street===c.street)));
 $('city-status').textContent=c.name+' · '+c.district;
}
function animateMechanism(dt){
 if(reduced.matches){stripPosition=stripTarget;stripVelocity=0;}
 else{const force=(stripTarget-stripPosition)*125-stripVelocity*17;stripVelocity+=force*dt;stripPosition+=stripVelocity*dt;}
 if(Math.abs(stripTarget-stripPosition)<.0001&&Math.abs(stripVelocity)<.0001){
  if(stripTarget>17){stripTarget-=9;stripPosition-=9;}
  if(stripTarget<5){stripTarget+=9;stripPosition+=9;}
 }
 for(const id of ['number-strip','tail-strip'])$(id).style.transform=`translate3d(0,${-stripPosition*STRIP_STEP}px,0)`;
 // The paper runs over the spindle; cylinder highlights travel with the belt.
 $('city-mechanism').style.setProperty('--roller-travel',`${stripPosition*STRIP_STEP}px`);
 $('city-mechanism').style.setProperty('--belt-speed',String(Math.min(1,Math.abs(stripVelocity)/6)));
 $('city-mechanism').dataset.stripPosition=stripPosition.toFixed(3);
 $('city-mechanism').dataset.stripTarget=stripTarget.toFixed(3);
 for(const [i,cell] of [...$('number-strip').children].entries()){
  // The reading at the centre of the window is the city you are in; the two either side
  // are where the rocker would take you, and they sit back.
  const d=Math.abs(i-stripPosition);
  cell.style.opacity=String(clamp(1-d*.42,.18,1));
  if(d<.5)cell.dataset.near='';else delete cell.dataset.near;
 }
}
function disposeScene(scene){
 if(!scene)return;const geometries=new Set(),materials=new Set(),textures=new Set();
 scene.traverse(o=>{if(o.geometry)geometries.add(o.geometry);for(const m of [o.material,o.customDepthMaterial].flat().filter(Boolean)){materials.add(m);for(const v of Object.values(m))if(v?.isTexture)textures.add(v);}});
 geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());
 scene.background?.isTexture&&scene.background.dispose();
}
async function prepareDestination(destination,onProgress){
 const manager=new THREE.LoadingManager(),decoder=new DRACOLoader(manager).setDecoderPath('../assets/vendor/draco/').setWorkerLimit(2);
 const loader=new GLTFLoader(manager).setDRACOLoader(decoder);let timer;
 try{return await Promise.race([
  Promise.all([loader.loadAsync('../assets/folded-city/'+destination.model,e=>{if(e.total)onProgress(e.loaded/e.total);}),
   fetch(destination.places).then(r=>{if(!r.ok)throw new Error('Destination records unavailable');return r.json();})]).then(([model,records])=>({model,records})),
  new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Destination loading timed out')),180000);})
 ]);}finally{clearTimeout(timer);decoder.dispose();}
}
async function selectCity(index,street){
 if(transit.active||state.phase==='loading'||state.phase==='switching')return;
 const step=index-cityIndex;index=(index+CITIES.length)%CITIES.length;
 const next=index===0&&street?SG_STREETS[street]:CITIES[index];
 if(!next)return;
 if(index===cityIndex&&next.model===CITIES[cityIndex].model){if(!state.loaded){state.skip=true;await load();}else{picker(false);showCity();}return;}
 const previousIndex=cityIndex,previous={...CITIES[0]},from=CITIES[cityIndex];
 state.targetDistance=state.distance;phase('switching');dust(false);
 $('city-picker').hidden=true;document.querySelector('.world-header').inert=true;$('shop-labels').inert=true;
 $('threshold').hidden=true;$('veil').style.opacity='0';
 let committed=false;
 const ok=await transit.run({kind:from.id===next.id?'taxi':'flight',from:from.district.split(' · ')[0],to:next.district.split(' · ')[0]+' · '+next.name,
  model:modelRoot,origin:camera.position.clone(),night:sunlit,reduced:reduced.matches,
  prepare:progress=>prepareDestination(next,progress),
  commit:async payload=>{
   committed=true;cityIndex=index;if(index===0)Object.assign(CITIES[0],next);stripTarget+=step;
   state.skip=true;await load(payload);
   if(state.phase==='fallback')throw new Error('Destination could not be prepared');
   transit.committing=true;render(0);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));transit.committing=false;
  }
 });
 transit.committing=false;
 document.querySelector('.world-header').inert=false;$('shop-labels').inert=false;
 if(!ok){if(committed){cityIndex=previousIndex;Object.assign(CITIES[0],previous);state.skip=true;await load();}else phase('city');}
 $('world').focus();schedule();
}
window.transitStatus=()=>transit.status();

function beginEnding(){
 state.endingTime=0;state.finished=false;phase('ending');$('skip').hidden=false;$('skip').setAttribute('aria-label','Skip ending');schedule();
}
function finishJourney(){
 state.finished=true;$('skip').hidden=true;journeyExit.visible=false;
 $('veil').style.opacity='0';$('veil').style.transition='opacity .8s';picker(true);
 $('back-to-street').textContent='↺ Walk again';
}

function phase(name){state.phase=name;document.body.dataset.phase=name;}
function showCity(){
  if(!state.loaded){state.skip=true;$('loading-status').textContent='Opening '+CITIES[cityIndex].name+'…';return;}
  phase('city');state.paused=false;state.time=0;state.targetDistance=state.distance=streetLayout?.initialDistance||0;state.finished=false;state.endingTime=0;state.lookX=state.lookY=0;uniform.fold.value=.22;uniform.start.value=CURVE_START+state.distance*.78;
  $('city-picker').hidden=true;$('city-mechanism').inert=false;$('shop-labels').inert=false;journeyExit.visible=false;camera.fov=56;camera.updateProjectionMatrix();
  $('threshold').hidden=true;$('city-mechanism').hidden=false;$('time-mechanism').hidden=false;
  $('skip').hidden=true;$('pause').hidden=true;$('veil').style.transition='opacity .75s';$('veil').style.opacity='0';
  schedule();
}

// A slow field of dust and drifting filaments behind the city list, drawn only while the
// list is open and never under reduced motion.
let dustRaf=0,dustPoints=null;
function dust(open){
 const canvas=$('picker-dust');
 cancelAnimationFrame(dustRaf);dustRaf=0;
 if(!open||reduced.matches){canvas.hidden=true;return;}
 canvas.hidden=false;
 const context=canvas.getContext('2d');
 const fit=()=>{const r=Math.min(devicePixelRatio||1,2);canvas.width=innerWidth*r;canvas.height=innerHeight*r;context.setTransform(r,0,0,r,0,0);};
 fit();
 if(!dustPoints){
  dustPoints=[];
  for(let i=0;i<420;i++)dustPoints.push({x:Math.random(),y:Math.random(),z:.25+Math.random()*.75,drift:(Math.random()-.5)*.012});
 }
 let last=performance.now();
 const frame=now=>{
  const dt=Math.min(.05,(now-last)/1000);last=now;
  if(canvas.width!==innerWidth*Math.min(devicePixelRatio||1,2))fit();
  context.clearRect(0,0,innerWidth,innerHeight);
  // filaments: long, slow catenary threads, like the reference's wire loops
  context.lineWidth=.6;
  for(let k=0;k<5;k++){
   const phase=now/9000+k*1.7,sag=.12+.05*Math.sin(phase*.7);
   context.beginPath();
   for(let i=0;i<=40;i++){
    const t=i/40,x=innerWidth*(.32+.72*t+.04*Math.sin(phase+t*4)),
     y=innerHeight*(.18+k*.14+sag*Math.sin(Math.PI*t)+.02*Math.sin(phase*1.3+t*7));
    i?context.lineTo(x,y):context.moveTo(x,y);
   }
   context.strokeStyle='rgba(197,221,241,'+(.05+.03*Math.sin(phase)).toFixed(3)+')';
   context.stroke();
  }
  for(const point of dustPoints){
   point.x+=point.drift*dt;point.y-=point.z*.004*dt;
   if(point.y<-.02)point.y=1.02;if(point.x<-.02)point.x=1.02;if(point.x>1.02)point.x=-.02;
   const x=point.x*innerWidth,y=point.y*innerHeight,r=point.z*1.5;
   context.fillStyle='rgba(226,240,252,'+(point.z*.5).toFixed(3)+')';
   context.fillRect(x,y,r,r);
  }
  dustRaf=requestAnimationFrame(frame);
 };
 dustRaf=requestAnimationFrame(frame);
}

function pickerPlate(id,street){
 const c=street?SG_STREETS[street]:(CITIES.find(city=>city.id===id)||CITIES[cityIndex]);
 const image=$('picker-plate-image'),source='../assets/folded-city/'+c.poster;
 if(!image.src.endsWith(c.poster)){image.dataset.swapping='true';image.src=source;
  image.onload=()=>{delete image.dataset.swapping;};}
 $('picker-plate-street').textContent=c.district.split(' · ')[0];
 $('picker-plate-city').textContent=c.name;
}
// Running the list changes the plate beside it, so the eye sees the street it is choosing.
for(const button of document.querySelectorAll('#city-picker nav>button')){
 button.addEventListener('pointerenter',()=>pickerPlate(button.dataset.city,button.dataset.street));
 button.addEventListener('focus',()=>pickerPlate(button.dataset.city,button.dataset.street));
}
$('city-picker').addEventListener('pointerleave',()=>pickerPlate());
document.querySelector('#city-picker nav')?.addEventListener('pointerleave',()=>pickerPlate());

function picker(open){
  if(open)state.returnFocus=document.activeElement;
  $('city-picker').hidden=!open;
  for(const id of ['city-mechanism','shop-labels'])$(id).inert=open;
  dust(open);if(open)pickerPlate();
  if(open){state.targetDistance=state.distance;phase('picker');$('back-to-street').textContent=state.finished?'↺ Walk again':'← Back to the street';$('back-to-street').focus();}
  else{if(state.finished)showCity();else phase(state.loaded?'city':'fallback');state.returnFocus?.focus();}
  schedule();
}

function stars(rating){
 const el=document.createElement('span');el.className='stars';el.setAttribute('aria-hidden','true');el.textContent='★★★★★';
 const fill=document.createElement('span');fill.textContent='★★★★★';fill.style.width=(clamp(rating,0,5)/5*100)+'%';el.append(fill);return el;
}
function ratingLine(place){
 const line=document.createElement('span');line.className='place-review';
 const number=document.createElement('span');number.textContent=Number(place.rating).toFixed(1);
 const count=document.createElement('span');count.className='review-count';count.textContent='('+Number(place.review_count).toLocaleString('en-SG')+')';
 line.append(number,stars(place.rating),count);line.setAttribute('aria-label',number.textContent+' out of 5, '+place.review_count+' reviews');return line;
}
function externalURL(value){
 try{const url=new URL(value);return url.protocol==='https:'?url.href:null;}catch{return null;}
}
function dateLabel(value){return new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(value));}
function openPlace(place){
 state.reviewFocus=document.activeElement;state.targetDistance=state.distance;phase('review');
 $('place-title').textContent=place.name;$('place-rating').replaceChildren(ratingLine(place));
 $('place-category').textContent=[place.main_category,place.price_range].filter(Boolean).join(' · ');
 $('place-address').textContent=place.full_address;
 const maps=externalURL(place.source_url);$('place-maps').hidden=!maps;if(maps)$('place-maps').href=maps;
 $('place-source').textContent='Google Maps · saved '+dateLabel(place.extracted_at);
 renderHours(place);
 const step=$('place-inside');
 const slot=places.indexOf(place);
 step.hidden=!place.interior;
 if(place.interior){
  const status=shopStatus(place);
  step.textContent=status&&!status.open?'Step inside anyway (closed now)':'Step inside ↗';
  step.onclick=()=>enterInterior(place,slot);
 }
 $('place-placement').textContent=place.placementNote||'The address above is the real location.';
 $('place-reviews').replaceChildren();
 for(const review of place.reviews){
  const article=document.createElement('article');article.className='review';
  const author=document.createElement('div');author.className='review-author';
  const avatar=document.createElement('span');avatar.className='review-avatar';avatar.textContent=(review.reviewer_name||'?').slice(0,1).toUpperCase();avatar.setAttribute('aria-hidden','true');
  const name=document.createElement('a');name.textContent=review.reviewer_name||'Google Maps reviewer';
  const link=externalURL(review.reviewer_link);if(link){name.href=link;name.target='_blank';name.rel='noopener noreferrer';}
  author.append(avatar,name);const meta=document.createElement('div');meta.className='review-meta';
  const date=document.createElement('span');date.textContent=review.published_at_date?dateLabel(review.published_at_date):'';
  meta.append(stars(review.rating),date);meta.setAttribute('aria-label',review.rating+' out of 5, '+date.textContent);
  const text=document.createElement('p');text.textContent=review.review_text;
  if(review.isExcerpt){const note=document.createElement('small');note.className='source-note';note.textContent='Excerpt · full review on Google Maps';article.append(note);}
  article.append(author,meta,text);$('place-reviews').append(article);
 }
 $('place-dialog').showModal();schedule();
}
/** The opening-hours record, as the plate at the door shows it, plus the state right now. */
function renderHours(place){
 const host=$('place-hours');host.replaceChildren();
 const weekly=place.openingHours?.weekly;
 if(!weekly){
  const note=document.createElement('p');note.className='source-note';
  note.textContent='Google recorded no opening hours for this place.';host.append(note);return;
 }
 const status=shopStatus(place);
 if(!status){
  const note=document.createElement('p');note.className='source-note';
  note.textContent='The saved record does not cover this day.';host.append(note);return;
 }
 const line=document.createElement('p');line.className='hours-line';
 const state_=document.createElement('b');
 state_.className=status.open?'hours-open':'hours-shut';
 state_.textContent=status.open?'Open':'Closed';
 line.append(state_,document.createTextNode(' at '+clockLabel(clock.minutes)+' on '+DAY_NAMES[clock.weekday]));
 if(status.open&&status.closesAt!=null)line.append(document.createTextNode(' · closes '+clockLabel(status.closesAt)));
 else if(!status.open&&status.opensAt!=null)line.append(document.createTextNode(' · opens '+clockLabel(status.opensAt)));
 host.append(line);
 const week=document.createElement('div');week.className='hours-week';
 for(let day=0;day<7;day++){
  const entry=weekly[DAY_NAMES[day]];if(!entry)continue;
  const row=document.createElement('div');row.dataset.today=String(day===clock.weekday);
  const name=document.createElement('span');name.textContent=DAY_NAMES[day];
  const value=document.createElement('span');value.textContent=entry.text||'Closed';
  row.append(name,value);week.append(row);
 }
 host.append(week);
 const busy=popularityAt(place,clock.weekday,clock.minutes);
 const note=document.createElement('p');note.className='source-note';
 // A place can have popular times overall and still have nothing recorded for this hour.
 note.textContent=(place.popularTimes
  ?(busy===null||busy===undefined
    ?'Google recorded no popularity for this hour.'
    :'Google popularity now: '+busy+' of 100.')
  :(place.popularTimesNote||'Google did not record popular times for this place.'))
  +' · '+(place.hoursSource||'saved Google Maps record');
 host.append(note);
}

function makeLabel(place){
 const el=document.createElement('a');el.className='place-card';el.href=externalURL(place.source_url)||'city.html?city=singapore';
 el.setAttribute('aria-label',place.name+', '+place.rating+' stars, '+place.review_count+' reviews');el.setAttribute('aria-haspopup','dialog');
 const pin=document.createElement('span');pin.className='place-pin';pin.setAttribute('aria-hidden','true');
 pin.innerHTML='<svg width="19" height="24" viewBox="0 0 24 30" fill="none"><path d="M12 29s10-12 10-18A10 10 0 0 0 2 11c0 6 10 18 10 18Z" fill="#ea4335"/><circle cx="12" cy="11" r="4" fill="white"/></svg>';
 const body=document.createElement('span');body.className='place-copy';
 const title=document.createElement('strong');title.textContent=place.name;
 const category=document.createElement('small');category.textContent=place.main_category;
 body.append(title,ratingLine(place),category);el.append(pin,body);$('shop-labels').append(el);
 el.addEventListener('click',event=>{if(event.metaKey||event.ctrlKey||event.shiftKey)return;event.preventDefault();openPlace(place);});
 return {el,position:new THREE.Vector3(...place.scenePosition),anchor:place.buildingAnchor??null,building:place.buildingId};
}


// --- time of day ---------------------------------------------------------------------
// One clock drives the sun, the sky, the street lamps, the lit windows and, where Google
// recorded them, each shop's real opening hours. Scrubbing it moves all of them together.
const clock={minutes:720,weekday:0,dayStart:null,live:true,zone:'UTC'};
const DAY_LETTERS=['S','M','T','W','T','F','S'];

function citySite(){
 const layout=streetLayout||{};
 const [latitude,longitude]=layout.origin||[1.283578,103.8429491];
 return {latitude,longitude,forwardEN:layout.forwardEN||[0,1],
  timeZone:(SITES[CITIES[cityIndex].id]||{}).timeZone||'UTC'};
}

/** Set the clock to the real wall time in the city being walked. */
function syncClockToNow(){
 const site=citySite();
 const now=new Date();
 const offset=zoneOffset(site.timeZone,now);
 const local=new Date(now.getTime()+offset*60000);
 clock.minutes=local.getUTCHours()*60+local.getUTCMinutes();
 clock.weekday=local.getUTCDay();
 clock.dayStart=new Date(Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate()));
 clock.zone=zoneLabel(site.timeZone,now);
 clock.live=true;
}

function startClock(){
 daylight.setSite(citySite());
 syncClockToNow();
 buildDayButtons();
 $('time-slider').value=String(Math.round(clock.minutes));
 $('time-mechanism').hidden=false;
 applyTime(true);
}

function buildDayButtons(){
 if($('time-days').children.length===7)return;
 const fragment=document.createDocumentFragment();
 for(let day=0;day<7;day++){
  const button=document.createElement('button');
  button.type='button';button.setAttribute('role','radio');
  button.textContent=DAY_NAMES[day].slice(0,3).toUpperCase();
  button.setAttribute('aria-label',DAY_NAMES[day]);
  button.onclick=()=>{clock.weekday=day;clock.live=false;applyTime();};
  fragment.append(button);
 }
 $('time-days').replaceChildren(fragment);
}

/** Bucket the model's time-driven objects once, by the names the build gives them. */
function registerTimedParts(root){
 shopParts=new Map();nightGlow=[];facadeParts=[];lastShopKey='';
 root.traverse(object=>{
  if(!object.isMesh)return;
  // GLTFLoader turns the spaces in authored object names into underscores.
  const label=object.name.replace(/_/g,' ');
  const shop=/^shop-(\d+)-(open|shut|glow|door|plate)(?:\s|$)/.exec(label);
  if(shop){
   const slot=Number(shop[1]);
   if(!shopParts.has(slot))shopParts.set(slot,{open:[],shut:[],glow:[],door:[],plate:[]});
   shopParts.get(slot)[shop[2]].push(object);
   if(shop[2]==='glow')nightGlow.push({object,gain:1.15});
   return;
  }
  if(label.startsWith('nightshops'))nightGlow.push({object,gain:1.0});
  else if(label.startsWith('streetlamps'))nightGlow.push({object,gain:1.35,lamp:true});
  else if(/ mapped facade$/.test(label))facadeParts.push(object);
 });
 for(const {object} of nightGlow)for(const material of materialsOf(object))material.emissiveIntensity=0;
 for(const object of facadeParts)for(const material of materialsOf(object))material.emissiveIntensity=0;
}

function materialsOf(object){return Array.isArray(object.material)?object.material:[object.material];}
function setVisible(list,visible){for(const object of list)object.visible=visible;}

/**
 * Whether a place is serving at the clock's day and minute. Returns null when Google
 * recorded no hours for it, so the caller can say so instead of inventing an answer.
 */
function shopStatus(place){
 return place?openAt(place,clock.weekday,clock.minutes):null;
}

const DAY_INTERIOR=.3;
function applyTime(force=false){
 if(!daylight||!state.loaded)return;
 if(!clock.dayStart)syncClockToNow();
 const light=daylight.apply(clock.dayStart,clock.minutes);
 daylight.refreshEnvironment(force);
 daylight.returnDome();
 sunlit=light;
 const dark=1-Math.min(1,Math.max(0,(light.sunAltitude+5.5)/9));
 for(const object of facadeParts)
  for(const material of materialsOf(object))material.emissiveIntensity=dark*1.0;
 // A shop interior is still seen through the glass by day, only dimmer than the street;
 // lamps alone are dark until dusk.
 for(const entry of nightGlow)
  for(const material of materialsOf(entry.object))material.emissiveIntensity=(entry.lamp?dark:Math.max(dark,DAY_INTERIOR))*entry.gain*(entry.lamp?1:.85);
 applyShopStates(dark);
 placeLampLights(light.night);
 updateTimeReadout(light,dark);
 schedule();
}

function applyShopStates(dark){
 const key=clock.weekday+':'+Math.floor(clock.minutes/5)+':'+(dark>.4?1:0);
 if(key===lastShopKey)return;
 lastShopKey=key;
 for(const [slot,group] of shopParts){
  const place=places[slot];
  const status=shopStatus(place);
  // Without a saved record the frontage follows the street's own rhythm, and the place
  // card says the hours are not recorded rather than implying these are its real ones.
  const open=status?status.open:(clock.minutes>=8*60&&clock.minutes<22*60);
  setVisible(group.open,open);
  setVisible(group.shut,!open);
  setVisible(group.door,open);
  setVisible(group.glow,open&&dark>.12);
  setVisible(group.plate,true);
 }
}

function openCount(){
 let open=0,known=0;
 for(const place of places){
  const status=shopStatus(place);
  if(!status)continue;
  known++;if(status.open)open++;
 }
 return {open,known};
}

function updateTimeReadout(light,dark){
 engrave($('time-clock'),clockLabel(clock.minutes));
 $('time-zone').textContent=clock.zone;
 for(const [day,button] of [...$('time-days').children].entries())
  button.setAttribute('aria-checked',String(day===clock.weekday));
 $('time-now').disabled=clock.live;
 const {open,known}=openCount();
 const sun=light.sunAltitude;
 const sky=sun>0.5?'sun '+sun.toFixed(0)+'° up':sun>-6?'twilight':
  light.moonAltitude>0?'night · moon '+Math.round(light.moonIlluminated*100)+'% lit':'night';
 const trade=known?`${open} of ${known} recorded places open`:'opening hours not recorded for this street';
 $('time-status').textContent=`${DAY_NAMES[clock.weekday]} · ${sky} · ${trade}`;
 // The moon disc beside the reading is drawn from the real phase and altitude.
 const moonUp=light.moonAltitude>0;
 $('time-moon').style.setProperty('--lit',String(Math.round(light.moonIlluminated*100)/100));
 $('time-moon').dataset.up=String(moonUp);
 $('world').dataset.minutes=String(Math.round(clock.minutes));
 $('world').dataset.weekday=String(clock.weekday);
 machines?.setWeekday(clock.weekday);
 machines?.setClock(clock.minutes,clock.zone,$('time-status').textContent,light.moonIlluminated,
  light.moonAltitude>0,clock.live);
 $('world').dataset.sunAltitude=sun.toFixed(2);
 $('world').dataset.dark=dark.toFixed(3);
}

// The lamp lenses in the model are emissive geometry; these few lights are what actually
// falls on the road. They are re-seated each frame onto the nearest mapped lamp posts,
// at the same positions and height the build uses, carried through the same fold.
const LAMP_LIGHTS=4;
let lampPosts=[],lampLights=[];

function buildLampRig(){
 for(const light of lampLights){light.shadow?.map?.dispose();light.parent?.remove(light);light.target?.removeFromParent();}
 lampLights=[];lampPosts=[];if(!streetLayout)return;
 const authored=streetLayout.lights;
 if(authored?.length)lampPosts=authored;
 else for(let y=-15;y<streetLayout.travelMax+5;y+=28){
  const {x}=sampleStreetPath(streetLayout.walkPath,y);
  for(const side of [-1,1])lampPosts.push({x:x+side*(streetLayout.roadWidth/2+.42),y,height:4.55,kind:'street',strength:1.55});
 }
 for(let i=0;i<(authored?.length?8:4);i++){
  const light=new THREE.SpotLight(0xffd7a5,0,24,Math.PI*.37,.75,2);
  light.castShadow=i<2;light.shadow.mapSize.set(1024,1024);light.shadow.bias=-.0001;light.shadow.normalBias=.025;
  light.visible=false;city.add(light,light.target);lampLights.push(light);
 }
}
function placeLampLights(night){
 if(!lampLights.length)return;
 if(night<.08){for(const light of lampLights)light.visible=false;return;}
 const here=state.streetPosition?.[1]??-28+state.distance;
 const available=lampPosts.filter(post=>{
  if(post.kind!=='shop')return true;
  const status=shopStatus(places[post.slot]);return status?status.open:clock.minutes>=480&&clock.minutes<1320;
 }).map(post=>({post,gap:Math.abs(post.y-here)}));
 const streets=available.filter(v=>v.post.kind==='street').sort((a,b)=>a.gap-b.gap).slice(0,3);
 const shops=available.filter(v=>v.post.kind==='shop').sort((a,b)=>a.gap-b.gap).slice(0,5);
 // Fixed light count: street fixtures keep the first two shadow-map slots.
 const selected=streetLayout.lights?.length?[...streets,...shops]:available.sort((a,b)=>a.gap-b.gap).slice(0,4);
 for(const [i,light] of lampLights.entries()){
  const entry=selected[i];light.visible=!!entry&&entry.gap<38;if(!light.visible)continue;
  const p=entry.post,anchor=p.anchor??p.y;
  light.color.set(p.color||'#ffdbad');light.position.copy(foldPoint(new THREE.Vector3(p.x,p.height,-p.y),anchor));
  const n=p.normal||[0,0],reach=p.kind==='shop'?1.4:0;
  light.target.position.copy(foldPoint(new THREE.Vector3(p.x+n[0]*reach,.12,-p.y-n[1]*reach),anchor));
  light.distance=p.kind==='shop'?9:24;light.angle=p.kind==='shop'?1.02:1.18;
  light.intensity=night*(p.strength||1.55)*smooth((38-entry.gap)/10);
 }
}
// --- stepping inside -----------------------------------------------------------------
// The interior is a separate scene, loaded the first time someone goes in. The street
// geometry is folded by a vertex shader, so a CPU ray would miss it; the door is instead
// an HTML hotspot placed at the door's folded screen position, which is also focusable.

const INTERIOR_MODEL='../assets/folded-city/koma-interior-v15.glb';
const INTERIOR_DATA='koma-interior-v15.json';
const INTERIOR_COLLISION='koma-collision-v16.json';

function makeDoorSpot(place,slot){
 const el=document.createElement('button');
 el.type='button';el.className='door-spot';
 const dot=document.createElement('i');dot.setAttribute('aria-hidden','true');
 const label=document.createElement('span');label.textContent='Step inside';
 const note=document.createElement('small');
 el.append(dot,label,note);
 el.onclick=()=>enterInterior(place,slot);
 $('door-hotspots').append(el);
 // The door sits at the shopfront the place resolved to, at handle height.
 return {el,label,note,place,slot,
  position:new THREE.Vector3(place.scenePosition[0],1.75,place.scenePosition[2]),
  anchor:place.buildingAnchor??null,building:place.buildingId};
}

function updateDoorSpots(){
 for(const spot of doorSpots){
  point.copy(spot.position);foldPoint(point,spot.anchor);
  const distance=point.distanceTo(camera.position);point.project(camera);
  const status=shopStatus(spot.place);
  // A portrait phone sees about 28 degrees across, so a door beside the street leaves the
  // frame as it gets close; there it is offered from further off, as the place cards are.
  const narrow=innerWidth<700;
  const visible=state.phase==='city'&&distance<(narrow?48:26)&&distance>1.5&&point.z>-1&&point.z<1
   &&Math.abs(point.x)<(narrow?.98:.92)&&Math.abs(point.y)<.8&&!markerOccluded(spot);
  spot.el.dataset.shown=String(visible);
  spot.el.dataset.open=String(status?status.open:true);
  if(!visible)continue;
  const x=clamp((point.x*.5+.5)*innerWidth,120,innerWidth-120);
  const y=(-point.y*.5+.5)*innerHeight;
  spot.el.style.transform=`translate(${x}px,${y}px) translate(-50%,-50%)`;
  spot.note.textContent=status?(status.open
   ?(status.closesAt!=null?'Open · closes '+clockLabel(status.closesAt):'Open')
   :(status.opensAt!=null?'Closed · opens '+clockLabel(status.opensAt):'Closed now'))
   :'';
  spot.el.setAttribute('aria-label',
   'Step inside '+spot.place.name+(status?(status.open?', open now':', closed now'):''));
 }
}

async function enterInterior(place,slot){
 if(state.phase!=='city'&&state.phase!=='review')return;
 $('place-dialog').open&&$('place-dialog').close();
 phase('entering');
 $('veil').style.transition='opacity .5s';$('veil').style.background='#07050a';$('veil').style.opacity='1';
 $('interior-status').textContent='Opening '+place.name+'…';
 try{
  const descriptor=typeof place.interior==='object'?place.interior:{id:'koma'};
  const id=descriptor.id||'koma';
  if(interiorId!==id){await releaseInterior();interiorId=id;}
  if(!interior){
   interior=new Interior(renderer);
   const decoder=new DRACOLoader().setDecoderPath('../assets/vendor/draco/').setWorkerLimit(2);
   const loader=new GLTFLoader().setDRACOLoader(decoder);
   interiorLoad=interior.load(loader,descriptor.model||INTERIOR_MODEL,descriptor.data||INTERIOR_DATA,descriptor.collision||INTERIOR_COLLISION).finally(()=>decoder.dispose());
  }
  await interiorLoad;
  if(!handling){
   if(id==='koma'){
    handling=new KomaInteractions(interior,{
     propsURL:'../assets/folded-city/koma-props-v15.glb',menuURL:'koma-menu-v15.json',
     pagesBase:'../assets/folded-city/koma-menu/',soundsBase:'../assets/folded-city/koma-sounds/',
     onReading:reading,onHolding:holding=>{document.body.dataset.holding=String(holding);},
     onSeated:seated=>{document.body.dataset.seated=String(seated);},onDish:showDish,
    });
    const decoder=new DRACOLoader().setDecoderPath('../assets/vendor/draco/').setWorkerLimit(2);
    handlingLoad=handling.load(new GLTFLoader().setDRACOLoader(decoder)).finally(()=>decoder.dispose());
    handlingLoad.catch(error=>console.error('Interior props:',error));
   }else{handling=new RoomInteractions(interior);handlingLoad=Promise.resolve();}
  }
 }catch(error){
  console.error('KOMA interior:',error);
  await releaseInterior();
  $('interior-status').textContent='The interior could not be loaded.';
  phase('city');$('veil').style.opacity='0';schedule();return;
 }
 interior.resize(innerWidth,innerHeight);
 // The room answers to the same clock as the street: closed means the lights are down.
 const trading=shopStatus(place);
 interior.setTrading(trading?trading.open:true);
 handling?.showSwitch?.();
 populateKoma(trading?trading.open:true);
 interior.spawn();
 interiorKeys={};state.interiorMoved=false;state.stick=null;
 $('interior-hint').textContent=WALK_HINT;$('interior-hint').hidden=false;
 state.touches=new Map();state.pinch=null;state.lastTap=null;
 state.interiorPlace=place;
 $('interior-name').textContent=place.name;
 $('interior-trading').textContent=trading?(trading.open?'Open now':'Closed now'):'';
 $('interior-hud').hidden=false;
 phase('interior');
 interiorZone='';
 $('veil').style.transition='opacity .7s';$('veil').style.opacity='0';
 $('interior-status').textContent=place.name+'. '+interior.zone()+'. '+WALK_HINT+'.';
 $('world').focus({preventScroll:true});
 schedule();
}

let interiorRelease=Promise.resolve();
async function releaseInterior(){
 if(!interior){await interiorRelease;return;}
 const old=interior,oldHandling=handling,pending=handlingLoad;
 komaPeopleKey='';PEOPLE.remove(komaPeople);komaPeople=[];
 interior=null;interiorLoad=null;handling=null;handlingLoad=null;interiorId=null;
 interiorRelease=(async()=>{try{await pending;}catch{}try{oldHandling?.reset();}catch{}old.dispose();})();
 await interiorRelease;
}

function leaveInterior(){
 if(state.phase!=='interior')return;
 phase('leaving');
 $('veil').style.transition='opacity .45s';$('veil').style.background='#07050a';$('veil').style.opacity='1';
 if(pointerLocked)document.exitPointerLock?.();
 handling?.reset();
 $('dish-panel').hidden=true;$('menu-turn').hidden=true;$('crosshair').hidden=true;document.body.dataset.dish='false';
 document.body.dataset.reading='false';document.body.dataset.holding='false';document.body.dataset.seated='false';
 setTimeout(()=>{
  $('interior-hud').hidden=true;
  interiorKeys={};
  phase('city');
  $('veil').style.transition='opacity .7s';$('veil').style.opacity='0';
  $('interior-status').textContent='Back on '+(streetLayout?.street||'the street')+'.';
  releaseInterior();resize();schedule();
 },reduced.matches?0:460);
}

// --- people in KOMA ----------------------------------------------------------------------
// While the restaurant is serving, diners sit at a share of its tables and staff stand at
// the host stand and the bar; when it is closed the room is empty. Who sits where is fixed
// for a given day, so walking out and back in finds the same room.
const PEOPLE=new People('people-v21.json','../assets/folded-city/');
let komaPeople=[],komaPeopleKey='';
const DINER_SEATS=['seat-dining','seat-island','seat-bridge','seat-alcove','seat-mezzanine'];
const MAX_DINERS=22;
function seeded(seed){return()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};}
async function populateKoma(open){
 const key=interiorId+':'+open+':'+clock.weekday;
 if(key===komaPeopleKey)return;
 komaPeopleKey=key;
 PEOPLE.remove(komaPeople);komaPeople=[];
 if(!open||!interior?.ready)return;
 try{await PEOPLE.load();}catch(error){console.warn('KOMA people:',error);return;}
 if(!PEOPLE.characters.length||komaPeopleKey!==key)return;
 const data=interior.data,rand=seeded(4099+clock.weekday*131);
 const tables=(data.anchors||[]).filter(a=>/table|counter/.test(a.kind));
 const seats=DINER_SEATS.flatMap(kind=>(data.interest?.[kind]||[]).map(seat=>({...seat,kind})));
 const chosen=seats.filter(()=>rand()<.42).slice(0,MAX_DINERS);
 const seatedMotions=PEOPLE.motionsFor('seated'),standing=PEOPLE.motionFor('standing');
 const jobs=[];
 chosen.forEach((seat,n)=>{
  if(!seatedMotions.length)return;
  const [x,y]=seat.centre,floor=seat.z[0]+Math.max(0,(seat.seatHeight||.46)-.46);
  const table=tables.reduce((best,t)=>{const d=Math.hypot(t.centre[0]-x,t.centre[1]-y);return d<best.d?{t,d}:best;},{t:null,d:9}).t;
  // Blender plan (x, y) is scene (x, -z); face the table across the plan.
  const yaw=seat.yaw??(table?Math.atan2(table.centre[0]-x,-(table.centre[1]-y)):0);
  jobs.push({look:PEOPLE.look(n),motion:seatedMotions[n%seatedMotions.length],position:new THREE.Vector3(x,floor,-y),yaw});
 });
 if(standing){
  const staffSpots=(data.anchors||[]).filter(a=>a.kind==='host-stand'||a.kind==='bar-counter').slice(0,2);
  staffSpots.forEach((spot,k)=>{
   // Behind the counter, facing the room's entrance end.
   const [x,y]=spot.centre;
   jobs.push({look:PEOPLE.look(40+k),motion:standing,position:new THREE.Vector3(x,interior.floorAt(x,y+.75)??0,-(y+.75)),yaw:0});
  });
 }
 const made=await Promise.all(jobs.map(job=>PEOPLE.spawn({...job.look,motion:job.motion,phase:rand(),walkSpeed:job.walker?job.speed:undefined}).then(entry=>{
  entry.person.position.copy(job.position);entry.person.rotation.y=job.yaw;return entry;
 }).catch(error=>{console.warn('KOMA person:',error);return null;})));
 if(komaPeopleKey!==key){PEOPLE.remove(made.filter(Boolean));return;}
 for(const entry of made)if(entry){interior.scene.add(entry.person);komaPeople.push(entry);}
 schedule();
}

// --- people on the street -------------------------------------------------------------------
// Standing groups in conversation, at spots the build chose clear of every street object,
// and walkers along the pavements once a walking motion has been downloaded. How many are
// out follows the street's saved Google popular times where there are any (Singapore), and
// the ordinary rhythm of a day where there are none (Tokyo, London).
let streetCrowd=[],streetCrowdCity='',crowdLoadVersion=0;
const STREET_REACH=90;
const personEuler=new THREE.Euler(0,0,0,'XYZ');
function clearStreetPeople(){crowdLoadVersion++;PEOPLE.remove(streetCrowd.map(item=>item.entry));streetCrowd=[];streetCrowdCity='';}
async function populateStreet(){
 const id=CITIES[cityIndex].id;
 if(streetCrowdCity===id)return;
 clearStreetPeople();streetCrowdCity=id;const crowdVersion=crowdLoadVersion;
 let spots;
 try{
  await PEOPLE.load();
  const response=await fetch(CITIES[cityIndex].people||id+'-people-v16.json');
  if(!response.ok)return;
  spots=await response.json();
 }catch(error){console.warn('Street people:',error);return;}
 if(crowdVersion!==crowdLoadVersion||streetCrowdCity!==id||!PEOPLE.characters.length)return;
 const talking=PEOPLE.motionsFor('talking'),standing=PEOPLE.motionsFor('standing'),walking=PEOPLE.motionFor('walking');
 const rand=seeded(id.length*977+17),jobs=[];let n=0;
 spots.groups.forEach((group,g)=>{
  const rank=rand();
  group.members.forEach(([x,y,yaw],k)=>{
   const motion=k===0?'talking':'listening';
   if(!motion)return;
   // Plan yaw faces along plan (sin, cos); the scene's forward is -z for plan +y.
   jobs.push({look:PEOPLE.look(n++,true),motion,s:y,x,yaw:Math.atan2(Math.sin(yaw),-Math.cos(yaw)),rank,ground:spots.groundZ});
  });
 });
 const activityProfile={singapore:['phone','looking-around','drinking','standing-idle'],tokyo:['looking-around','phone','standing-idle','looking-around'],london:['drinking','looking-around','phone','standing-idle']}[id];
 spots.groups.forEach((group,i)=>{
  const [x,y,yaw]=group.members[0],motion=activityProfile[i%activityProfile.length];
  const slot=places.reduce((best,p,k)=>{const sy=-(p.scenePosition?.[2]||0);return Math.abs(sy-y)<best.gap?{slot:k,gap:Math.abs(sy-y)}:best;},{slot:-1,gap:Infinity});
  jobs.push({look:PEOPLE.look(n++,true),motion,s:y+2.5,x,yaw:Math.atan2(Math.sin(yaw),-Math.cos(yaw)),rank:rand()*.6,ground:spots.groundZ,activity:true,shop:slot.gap<20?slot.slot:null});
 });
 if(walking){
  for(const lane of spots.lanes){
   const count=Math.round(spots.travelMax/24);
   for(let i=0;i<count;i++){
    jobs.push({look:PEOPLE.look(n++,true),motion:walking,s:-24+rand()*(spots.travelMax-8),lane,rank:rand(),
     dir:lane.side>0?1:-1,speed:1.15+rand()*.35,ground:spots.groundZ,walker:true});
   }
  }
 }
 const made=await Promise.all(jobs.map(job=>PEOPLE.spawn({...job.look,motion:job.motion,phase:rand(),walkSpeed:job.walker?job.speed:undefined})
  .then(entry=>({...job,entry})).catch(error=>{console.warn('Street person:',error);return null;})));
 if(crowdVersion!==crowdLoadVersion||streetCrowdCity!==id){PEOPLE.remove(made.filter(Boolean).map(item=>item.entry));return;}
 for(const item of made){if(!item)continue;item.entry.person.visible=false;city.add(item.entry.person);streetCrowd.push(item);}
 schedule();
}
function crowdDensity(){
 const values=places.map(place=>popularityAt(place,clock.weekday,clock.minutes)).filter(v=>v!==null&&v!==undefined);
 if(values.length)return clamp(.12+values.reduce((a,b)=>a+b,0)/values.length/100*.95,.1,1);
 const h=((clock.minutes??720)/60)%24;
 return h<5.5?.08:h<8?.08+(h-5.5)*.25:h<21?.85:.85-(h-21)*.22;
}
function foldAngle(s){const start=uniform.start.value;return s<=start?0:Math.min((s-start)/BEND_RADIUS,Math.PI*uniform.fold.value);}
function sampleStreetPath(path,s){
 if(!path?.length)return {x:0,slope:0,y:s};
 let i=path.findIndex((p,j)=>j>0&&s<=p[1]);if(i<1)i=path.length-1;
 const [xa,ya]=path[Math.max(0,i-1)],[xb,yb]=path[i];
 const slope=(xb-xa)/Math.max(.001,yb-ya),y=clamp(s,ya,yb);
 return {x:xa+(y-ya)*slope,slope,y};
}
function updateStreetPeople(dt){
 if(!streetCrowd.length)return;
 const density=crowdDensity(),here=state.streetPosition?.[1]??0;
 for(const item of streetCrowd){
  const person=item.entry.person;let x=item.x,yaw=item.yaw,groundY=item.s;
  if(item.walker){
   const path=item.lane.points||streetLayout?.walkPath||[];
   const sample=sampleStreetPath(path,item.s);
   // A steady world speed along a curved lane, synchronized to the planted foot cycle.
   const obstacle=streetCrowd.some(other=>other!==item&&other.walker&&other.lane.side===item.lane.side&&other.rank<density&&
       (other.s-item.s)*item.dir>0&&(other.s-item.s)*item.dir<1.05);
   item.velocity=THREE.MathUtils.damp(item.velocity??item.speed,obstacle?0:item.speed,5,dt);
   const step=item.velocity*dt/Math.hypot(1,sample.slope);
   item.s+=item.dir*step;
   const lo=path[0]?.[1]??-24,hi=path.at(-1)?.[1]??TRAVEL_MAX;
   if(item.s>hi)item.s=lo;else if(item.s<lo)item.s=hi;
   const next=sampleStreetPath(path,item.s);x=next.x;
   if(!item.lane.points)x+=item.lane.side*item.lane.offset;
   groundY=next.y;yaw=Math.atan2(next.slope*item.dir,-item.dir);
   item.entry.action.timeScale=item.entry.gaitRate*(item.velocity/item.speed);
  }
  const activityOpen=item.shop==null||openAt(places[item.shop],clock.weekday,clock.minutes)!==false;
  const show=item.rank<density&&Math.abs(groundY-here)<STREET_REACH&&activityOpen;
  person.visible=show;if(!show)continue;
  let ground=item.ground;
  for(const road of streetLayout?.walkSurfaces||[]){
   const [ax,ay]=road.a,[bx,by]=road.b,dx=bx-ax,dy=by-ay;
   const u=clamp(((x-ax)*dx+(groundY-ay)*dy)/(dx*dx+dy*dy||1),0,1);
   if(Math.hypot(x-ax-u*dx,groundY-ay-u*dy)<road.halfWidth){ground=road.z;break;}
  }
  person.position.copy(foldPoint(point.set(x,ground,-groundY),groundY));
  const target=new THREE.Quaternion().setFromEuler(personEuler.set(foldAngle(groundY),yaw,0));
  if(item.wasVisible)person.quaternion.slerp(target,1-Math.exp(-8*dt));else person.quaternion.copy(target);
  item.wasVisible=true;PEOPLE.step(item.entry,reduced.matches?0:dt);
 }
}

function interiorFrame(dt){
 const walker=interior.walker;
 walker.forward=clamp((interiorKeys.forward?1:0)-(interiorKeys.back?1:0)+(interiorKeys.stickY||0),-1,1);
 walker.strafe=clamp((interiorKeys.right?1:0)-(interiorKeys.left?1:0)+(interiorKeys.stickX||0),-1,1);
 walker.turn=(interiorKeys.turnRight?1:0)-(interiorKeys.turnLeft?1:0);
 walker.boost=!!interiorKeys.boost;
 // Walking stands a seated visitor up again, and steps back out of a close look.
 if(handling?.seated&&(walker.forward||walker.strafe)){handling.stand();}
 if(interior.inspecting&&(walker.forward||walker.strafe||walker.turn))leaveInspect();
 const moved=(handling?.seated||handling?.reading)&&!interior.flight?false:interior.step(dt);
 if(moved&&interior.atExit()){leaveInterior();return false;}
 const handled=handling?.ready?handling.update(dt):false;
 for(const entry of komaPeople)entry.mixer.update(dt);
 if(handling?.ready&&pointerLocked){
  const over=handling.hover(innerWidth/2,innerHeight/2);
  $('crosshair').dataset.over=String(!!over);
 }
 const zone=interior.zone();
 if(zone!==interiorZone){
  interiorZone=zone;$('interior-zone').textContent=zone;
  $('interior-status').textContent=zone;
 }
 // The controls line is an instruction, not a caption; it goes once you are moving.
 if(walker.speed>.4&&!state.interiorMoved&&!interior.inspecting){state.interiorMoved=true;$('interior-hint').hidden=true;}
 interior.render();
 $('world').dataset.interiorZone=zone;
 $('world').dataset.interiorPosition=[walker.x.toFixed(2),walker.floor.toFixed(2),walker.z.toFixed(2)].join(',');
 return moved||komaPeople.length>0||Math.abs(walker.momentum.x)>1e-3||Math.abs(walker.momentum.y)>1e-3;
}

// --- handling things inside ------------------------------------------------------------
function reading(open){
 document.body.dataset.reading=String(open);
 $('menu-turn').hidden=!open;
 // Reading needs a cursor to point at a line on the page.
 if(open&&pointerLocked)document.exitPointerLock?.();
 $('crosshair').hidden=open||!pointerLocked;
 schedule();
}

function showDish(dish){
 $('dish-name').textContent=dish.name;
 const where=({small:'small plates',big:'big plates',maki:'maki',signatures:'signature cocktails'})[dish.page]||'';
 $('dish-meta').textContent=[dish.price!=null?'$'+dish.price:null,where].filter(Boolean).join(' · ');
 $('dish-detail').textContent=dish.detail||'';
 const rating=$('dish-rating');rating.replaceChildren();
 if(dish.mentionCount){
  const value=document.createElement('span');value.textContent=Number(dish.meanRatingOfMentioningReviews).toFixed(1);
  const count=document.createElement('span');count.className='muted';
  count.textContent=dish.mentionCount+(dish.mentionCount===1?' review mentions it':' reviews mention it');
  rating.append(value,stars(dish.meanRatingOfMentioningReviews),count);
  rating.setAttribute('aria-label',value.textContent+' out of 5, the average of '+dish.mentionCount+' reviews that mention this dish');
 }else{
  const none=document.createElement('span');none.className='muted';
  none.textContent='No saved review mentions this dish.';rating.append(none);
 }
 const quotes=$('dish-quotes');quotes.replaceChildren();
 for(const quote of dish.quotes||[]){
  const article=document.createElement('article');article.className='review';
  const author=document.createElement('div');author.className='review-author';
  const avatar=document.createElement('span');avatar.className='review-avatar';avatar.setAttribute('aria-hidden','true');
  avatar.textContent=(quote.reviewer||'?').slice(0,1).toUpperCase();
  const name=document.createElement('a');name.textContent=quote.reviewer||'Google Maps reviewer';
  const link=externalURL(quote.reviewer_link);if(link){name.href=link;name.target='_blank';name.rel='noopener noreferrer';}
  author.append(avatar,name);
  const meta=document.createElement('div');meta.className='review-meta';
  const date=document.createElement('span');date.textContent=quote.date?dateLabel(quote.date):'';
  meta.append(stars(quote.rating),date);
  const text=document.createElement('p');text.textContent=quote.quote;
  article.append(author,meta,text);quotes.append(article);
 }
 $('dish-panel').hidden=false;document.body.dataset.dish='true';
 $('interior-status').textContent=dish.name+(dish.mentionCount?', '+dish.mentionCount+' reviews mention it':'');
}
$('dish-close').onclick=()=>{$('dish-panel').hidden=true;document.body.dataset.dish='false';};
$('menu-previous').onclick=()=>handling?.turnPage(-1);
$('menu-next').onclick=()=>handling?.turnPage(1);
$('menu-close').onclick=()=>handling?.closeMenu();

/** A press that did not travel is a click on whatever is under it. */
function interiorClick(x,y){
 if(!handling?.ready)return null;
 const point=pointerLocked?[innerWidth/2,innerHeight/2]:[x,y];
 const result=handling.click(point[0],point[1]);
 schedule();
 return result;
}

function walkCamera(){
  // Forward movement and a delayed rolling fold are separate, coupled motions.
  const end=state.finished?1:state.phase==='ending'?smooth(state.endingTime/4.5):0;
  const s=-28+state.distance+end*16,a=Math.min(Math.max(s-uniform.start.value,0)/BEND_RADIUS,Math.PI*uniform.fold.value);
  const path=streetLayout?.walkPath||[];
  const current=sampleStreetPath(path,s),ahead=sampleStreetPath(path,s+6);
  const pathX=current.x,pathSlope=(ahead.x-current.x)/Math.max(.1,ahead.y-current.y);
  state.streetPosition=[pathX,s];camera.position.copy(foldPoint(new THREE.Vector3(pathX,streetLayout?.eyeHeight||2.2,-s)));
  const up=new THREE.Vector3(0,Math.cos(a),Math.sin(a));
  const forward=new THREE.Vector3(pathSlope,Math.sin(a),-Math.cos(a)).normalize();
  camera.up.copy(up);
  const target=camera.position.clone().addScaledVector(forward,12).addScaledVector(up,(streetLayout?.eyeHeight?0:1.75)+state.lookY*5);
  target.x+=state.lookX*8*(1-end);camera.lookAt(target);
  camera.fov=56+end*13;camera.updateProjectionMatrix();
  daylight?.follow(camera.position);
  if(sunlit.night>.08)placeLampLights(sunlit.night);
  if(state.phase==='ending'){journeyExit.visible=true;journeyExit.position.copy(camera.position).addScaledVector(forward,25-end*21);journeyExit.quaternion.copy(camera.quaternion);journeyExit.material.opacity=smooth(state.endingTime/1.8);}
}

function markerOccluded(marker){
 const a=state.streetPosition||[0,-28],b=[marker.position.x,-marker.position.z],rx=b[0]-a[0],ry=b[1]-a[1];
 for(const building of streetLayout?.occluders||[]){
  if(building.id===marker.building)continue;
  const p=building.points;
  for(let i=0;i<p.length;i++){
   const c=p[i],d=p[(i+1)%p.length],sx=d[0]-c[0],sy=d[1]-c[1],cross=rx*sy-ry*sx;
   if(Math.abs(cross)<1e-8)continue;
   const qx=c[0]-a[0],qy=c[1]-a[1],t=(qx*sy-qy*sx)/cross,u=(qx*ry-qy*rx)/cross;
   if(t>.005&&t<.985&&u>=0&&u<=1)return true;
  }
 }
 return false;
}

function init(){
  releaseInterior();landscapeStats=null;tunnel?.environment?.dispose();clearStreetPeople();disposeScene(city);disposeScene(tunnel);daylight?.dispose();daylight=null;renderer?.dispose();state.loaded=false;
  renderer=new THREE.WebGLRenderer({canvas:$('world'),antialias:true,alpha:false,powerPreference:'high-performance'});
  renderer.outputEncoding=THREE.sRGBEncoding;renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure=.9;
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  labels=[];$('shop-labels').replaceChildren();
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));
  renderer.setClearColor(0x030305);
  city=new THREE.Scene();city.background=null;
  city.fog=new THREE.Fog(0xb9c2c7,200,530);
  camera=new THREE.PerspectiveCamera(56,innerWidth/innerHeight,.1,700);
  camera.position.set(0,2.2,28);camera.lookAt(0,14,-45);
  // Sun, moon, sky and the image-based light all follow one clock.
  daylight=new Daylight(renderer,city);
  uniform.fold.value=.22;uniform.start.value=CURVE_START;state.foldTarget=.22;state.startTarget=CURVE_START;
  journeyExit=new THREE.Mesh(new THREE.RingGeometry(2.6,2.68,128),new THREE.MeshBasicMaterial({color:0xffe9c6,transparent:true,opacity:0,side:THREE.DoubleSide}));
  journeyExit.visible=false;city.add(journeyExit);
  tunnel=new THREE.Scene();tunnel.background=new THREE.Color(0x050505);
  tunnel.fog=new THREE.FogExp2(0x0d0c0b,.018);
  tunnelCamera=new THREE.PerspectiveCamera(66,innerWidth/innerHeight,.05,200);
  headLight=new THREE.PointLight(0xaab4bd,.35,9,2);tunnel.add(headLight);
  exitLight=new THREE.PointLight(0xe6edf2,.6,24,1.2);exitLight.position.set(0,4.2,-83);tunnel.add(exitLight);
  tunnel.add(new THREE.HemisphereLight(0x3a424b,0x15110d,.18));
  // The GLB lists every bulkhead lamp; a fixed pool of point lights follows the camera to the nearest ones.
  lampPool=[];lampSpots=[];
  for(let i=0;i<10;i++){const lamp=new THREE.PointLight(0xffc27e,0,6.5,2);tunnel.add(lamp);lampPool.push(lamp);}
  const glow=new THREE.Mesh(new THREE.PlaneGeometry(18,18),new THREE.ShaderMaterial({
    transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
    vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader:'varying vec2 vUv;void main(){float d=length(vUv-.5)*2.;float a=pow(max(0.,1.-d),4.)*.35;gl_FragColor=vec4(.95,.93,.88,a);}'
  }));glow.position.set(0,3.35,-86.2);tunnel.add(glow);
  if(!machines){
   machines=new Console(renderer);
   machines.onCity=delta=>selectCity(cityIndex+delta);
   machines.onWeekday=day=>{clock.weekday=day;clock.live=false;applyTime();};
   machines.onMinutes=minutes=>{clock.live=false;$('time-slider').value=String(Math.round(minutes));
    clock.minutes=Math.round(minutes);applyTime();};
   machines.onNow=()=>$('time-now').click();
   machines.onPicker=()=>picker(true);
   machinesLoad=machines.load('../assets/folded-city/console-v18.glb?v=20','console-v18.json?v=20')
    .then(()=>{machines.resize(innerWidth,innerHeight);document.body.dataset.machines='on';
     announceCity();applyTime(true);schedule();})
    .catch(error=>{console.warn('Console:',error);machines=null;});
  }
  resize();
}

async function detailLandscape(root,scene,slug,version,folded=true){
 const decoder=new DRACOLoader().setDecoderPath('../assets/vendor/draco/').setWorkerLimit(1);
 try{
  const gltf=await new GLTFLoader().setDRACOLoader(decoder).loadAsync('../assets/folded-city/landscape-v23/'+slug+'.glb?v=3');
  if(version!==loadVersion){disposeScene(gltf.scene);return;}
  let meshes=0,triangles=0;
  gltf.scene.traverse(o=>{if(!o.isMesh)return;meshes++;triangles+=(o.geometry.index?.count||o.geometry.attributes.position.count)/3;
   o.castShadow=false;o.receiveShadow=true;
   if(!folded){o.material.fog=false;if(o.material.name!=='portal backdrop')o.material.emissive.copy(o.material.color).multiplyScalar(.35);}
   if(folded){o.frustumCulled=false;o.geometry.setAttribute('bendAnchor',o.geometry.attributes.uv2);o.material=bendMaterial(o.material);}
  });
  if(!folded)root.traverse(o=>{if(o.isMesh&&o.material?.name==='daylight sky')o.visible=false;});
  scene.add(gltf.scene);if(folded)landscapeStats={slug,meshes,triangles};
  const loader=new THREE.TextureLoader();
  loader.load('../assets/folded-city/landscape-v23/ground.webp',texture=>{
   if(version!==loadVersion){texture.dispose();return;}
   texture.encoding=THREE.sRGBEncoding;texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.repeat.set(2,2);texture.anisotropy=4;
   let used=false;root.traverse(o=>{if(!o.isMesh)return;for(const mat of materialsOf(o))if(mat.name==='mapped green'||mat.name==='exterior daylight grass'){
    mat.map=texture;mat.color.setRGB(.5,.54,.4);mat.needsUpdate=true;used=true;
   }});if(!used)texture.dispose();schedule();
  });schedule();
 }catch(error){console.warn('Optional landscape layer:',error.message);}finally{decoder.dispose();}
}

async function load(prepared=null){
  const direct=!!prepared||state.skip||reduced.matches||new URLSearchParams(location.search).has('street');
  const version=++loadVersion;announceCity();$('retry').hidden=true;phase('loading');$('threshold').hidden=false;$('threshold').style.opacity='1';$('city-mechanism').hidden=false;$('city-mechanism').setAttribute('aria-busy','true');$('location-control').disabled=true;$('city-previous').disabled=$('city-next').disabled=true;
  $('loading-status').textContent='Opening '+CITIES[cityIndex].name+'…';
  loadingProgress=0;state.holding=false;
  try{
    init();
    const manager=new THREE.LoadingManager();
    const decoder=new DRACOLoader(manager).setDecoderPath('../assets/vendor/draco/').setWorkerLimit(2);
    const loader=new GLTFLoader(manager).setDRACOLoader(decoder);
    // The tunnel is small and the city is not, so the ride starts as soon as the tunnel is
    // in and the city keeps downloading behind it; the ride waits at the mouth if it must.
    const cityName=CITIES[cityIndex].name;
    // The tunnel gets the connection to itself first, so the ride can begin within a couple
    // of seconds; the city starts downloading the moment the tunnel is in.
    let cityDownload=null;
    const startCity=()=>{
      cityDownload=cityDownload||(prepared?Promise.resolve(prepared.model):loader.loadAsync('../assets/folded-city/'+CITIES[cityIndex].model,event=>{
        if(!event.total||version!==loadVersion)return;
        loadingProgress=event.loaded/event.total;
        if(state.phase==='loading'||state.holding)$('loading-status').textContent='Opening '+cityName+'… '+Math.round(loadingProgress*100)+'%';
      }));
      cityDownload.catch(()=>{});
      return cityDownload;
    };
    let timer;
    const result=await Promise.race([
      Promise.all([
        (direct?Promise.resolve({scene:new THREE.Group()}):loader.loadAsync('../assets/folded-city/portal-tunnel-v16.glb')).then(gltf=>{startCity();return gltf;}),
        null,
        prepared?Promise.resolve(prepared.records):CITIES[cityIndex].places?fetch(CITIES[cityIndex].places).then(response=>{if(!response.ok)throw new Error('Place records could not be loaded.');return response.json();}):Promise.resolve({places:[]})
      ]),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('The 3D scene took too long to load.')),60000)})
    ]).finally(()=>clearTimeout(timer));
    if(version!==loadVersion)return;
    tunnel.add(result[0].scene);
    if(!direct)detailLandscape(result[0].scene,tunnel,'portal',version,false);
    result[0].scene.traverse(o=>{
      if(o.userData.tunnelLamps)for(const p of JSON.parse(o.userData.tunnelLamps))lampSpots.push(new THREE.Vector3(...p));
      if(!o.isMesh)return;
      if(/^(daylight|exterior)/.test(o.material.name))o.material.fog=false;
      o.material.envMapIntensity=/puddle|water/.test(o.material.name)?1:.35;
      // A puddle darkens the floor a little and mirrors the lamps; it is not a black hole.
      if(o.material.name==='floor puddle'){o.material.color.setScalar(2.6);o.material.opacity=.55;o.material.transparent=true;o.material.depthWrite=false;o.material.envMapIntensity=1.6;}
      for(const t of [o.material.map,o.material.normalMap,o.material.roughnessMap])if(t)t.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
    });
    // One-off reflection probe of the tunnel itself (lamp lenses, the daylit mouth) for wet floor and metal.
    if(!direct){const probe=new THREE.PMREMGenerator(renderer);tunnel.environment=probe.fromScene(tunnel,.04,.1,200).texture;probe.dispose();}
    if(!direct){phase('tunnel');state.time=0;state.holding=false;$('loading-status').textContent='';$('pause').hidden=false;schedule();}
    const cityResult=await Promise.race([
      startCity(),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('The 3D scene took too long to load.')),180000)})
    ]).finally(()=>{clearTimeout(timer);decoder.dispose();});
    if(version!==loadVersion)return;
    modelRoot=cityResult.scene;
    modelRoot.traverse(o=>{
      if(!o.isMesh)return;
      o.frustumCulled=false;o.castShadow=!materialsOf(o).some(m=>m.transparent);o.receiveShadow=true;
      if(!o.geometry.attributes.uv2)throw new Error('The city model is missing its bend anchors.');
      o.geometry.setAttribute('bendAnchor',o.geometry.attributes.uv2);
      const prepare=original=>{
       for(const texture of [original.map,original.normalMap,original.roughnessMap])if(texture)texture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
       original.envMapIntensity=.6;
       {
        if(['street asphalt','mapped road'].includes(original.name))original.color.setRGB(.48,.48,.48);
        if(['paving','mapped paving'].includes(original.name))original.color.setRGB(.48,.47,.44);
        if(['stone','mapped stone'].includes(original.name))original.color.setRGB(.72,.70,.65);
       }
       return bendMaterial(original);
      };
      o.material=Array.isArray(o.material)?o.material.map(prepare):prepare(o.material);
      o.customDepthMaterial=bendMaterial(new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking,map:o.material.map,alphaTest:o.material.alphaTest,side:o.material.side}),true);
      o.customDistanceMaterial=bendMaterial(new THREE.MeshDistanceMaterial({map:o.material.map,alphaTest:o.material.alphaTest}),true);
    });
    city.add(modelRoot);state.loaded=true;
    const detailSlug=CITIES[cityIndex].street==='keong-saik'?'keong-saik':CITIES[cityIndex].id;
    setTimeout(()=>{if(version===loadVersion)detailLandscape(modelRoot,city,detailSlug,version);},600);$('city-mechanism').setAttribute('aria-busy','false');$('location-control').disabled=false;$('city-previous').disabled=$('city-next').disabled=false;
    streetLayout=result[2].layout||null;TRAVEL_MAX=streetLayout?.travelMax||124;
    places=(result[2].places||[]).map(place=>INTERIOR_REGISTRY[place.place_id]?{...place,interior:INTERIOR_REGISTRY[place.place_id]}:place);labels=places.map(makeLabel);
    $('door-hotspots').replaceChildren();
    doorSpots=places.map((place,slot)=>place.interior?makeDoorSpot(place,slot):null).filter(Boolean);
    registerTimedParts(modelRoot);buildLampRig();startClock();
    setTimeout(()=>{if(version===loadVersion)populateStreet();},450);
    stats={meshes:0,triangles:0};modelRoot.traverse(o=>{if(o.isMesh){stats.meshes++;stats.triangles+=(o.geometry.index?.count||o.geometry.attributes.position.count)/3;}});
    state.holding=false;
    if(direct||state.skip)showCity();
    else schedule();
  }catch(error){
    if(version!==loadVersion)return;
    console.error('Folded City:',error);fallback(error.message);
  }
}

function fallback(message){
  phase('fallback');$('threshold').hidden=false;$('threshold').style.opacity='1';
  $('loading-status').textContent=message;$('retry').hidden=false;
  $('skip').hidden=true;$('pause').hidden=true;$('city-mechanism').hidden=false;$('time-mechanism').hidden=true;$('city-previous').disabled=$('city-next').disabled=false;$('city-mechanism').setAttribute('aria-busy','false');$('location-control').disabled=false;$('veil').style.opacity='0';
}

function render(dt){
  if(!renderer||(transit.active&&!transit.committing))return;
  renderCount++;
  if(state.phase==='interior'){renderCount++;interiorFrame(dt);return;}
  animateMechanism(dt);
  if(state.phase==='tunnel'){
    // Until the city has arrived the ride stops short of the mouth and says how far along it is.
    const HOLD=.8*9.5;
    if(!state.paused)state.time+=dt;
    state.holding=!state.loaded&&state.time>=HOLD;
    if(state.holding){state.time=HOLD;$('loading-status').textContent='Opening '+CITIES[cityIndex].name+'… '+Math.round(loadingProgress*100)+'%';}
    const p=clamp(state.time/9.5,0,1),travel=smooth(p);
    tunnelCamera.position.set(Math.sin(p*Math.PI*2)*.22*(1-p),2.25+Math.sin(p*Math.PI)*.35,4-travel*86);
    tunnelCamera.lookAt(0,3,-90);tunnelCamera.rotation.z=Math.sin(p*Math.PI)*.07;
    tunnelCamera.fov=66+Math.sin(p*Math.PI)*13;tunnelCamera.updateProjectionMatrix();
    headLight.position.copy(tunnelCamera.position);headLight.position.z-=2;
    exitLight.intensity=.6+p*1.6;
    const cz=tunnelCamera.position.z,near=lampSpots.filter(s=>s.z<cz+4&&s.z>cz-26).sort((a,b)=>b.z-a.z);
    lampPool.forEach((lamp,i)=>{const s=near[i];lamp.intensity=s?4.5*clamp((26-(cz-s.z))/6,0,1)*clamp((cz+4-s.z)/2,0,1):0;if(s)lamp.position.copy(s);});
    $('threshold').style.opacity=state.holding?'1':String(1-smooth((p-.12)/.2));
    $('veil').style.background=p>.84?'#e9ede6':'#020205';
    $('veil').style.opacity=String(p<.22?(1-smooth(p/.22))*.96:smooth((p-.88)/.12));
    renderer.render(tunnel,tunnelCamera);
    if(p===1)showCity();
  }else if(state.loaded){
    if(!state.paused&&state.phase==='city')state.distance=reduced.matches?state.targetDistance:THREE.MathUtils.damp(state.distance,state.targetDistance,7,dt);
    if(state.phase==='city'&&state.distance>TRAVEL_MAX-.06&&state.targetDistance===TRAVEL_MAX)reduced.matches?finishJourney():beginEnding();
    if(state.phase==='ending'){
      state.endingTime+=dt;
      $('veil').style.background='#e7e9e5';$('veil').style.transition='none';$('veil').style.opacity=String(smooth((state.endingTime-3.3)/1.2));
      if(state.endingTime>=4.6)finishJourney();
    }
    updateCurve(dt);walkCamera();updateStreetPeople(dt);renderer.render(city,camera);
    if(machines){machines.setVisible(state.phase==='city',state.phase==='city');machineMoving=machines.update(dt);machines.render();}
    $('world').dataset.camera=camera.position.toArray().join(',');
    $('world').dataset.cameraUp=camera.up.toArray().join(',');
    $('world').dataset.cameraQuaternion=camera.quaternion.toArray().join(',');
    $('world').dataset.fold=uniform.fold.value.toFixed(4);
    $('world').dataset.bendStart=uniform.start.value.toFixed(2);$('world').dataset.city=CITIES[cityIndex].id;
    $('world').dataset.ending=state.finished?'complete':state.phase==='ending'?state.endingTime.toFixed(2):'idle';
    $('world').dataset.distance=state.distance.toFixed(2);
    $('world').dataset.triangles=String(stats.triangles);
    $('world').dataset.drawCalls=String(renderer.info.render.calls);
    const candidates=[];
    for(const marker of labels){
      point.copy(marker.position);foldPoint(point,marker.anchor);
      const distance=point.distanceTo(camera.position);point.project(camera);
      marker.screen={x:clamp((point.x*.5+.5)*innerWidth,innerWidth<700?108:126,innerWidth-(innerWidth<700?108:126)),y:(-point.y*.5+.5)*innerHeight};
      marker.el.style.opacity='0';marker.el.style.pointerEvents='none';marker.el.tabIndex=-1;marker.el.setAttribute('aria-hidden','true');
      if(state.phase==='city'&&distance<(innerWidth<700?82:58)&&distance>4&&point.z>-1&&point.z<1&&Math.abs(point.x)<(innerWidth<700?.98:.80)&&Math.abs(point.y)<.65&&!markerOccluded(marker))candidates.push({marker,distance});
    }
    updateDoorSpots();
    const shown=[];
    for(const {marker} of candidates.sort((a,b)=>a.distance-b.distance)){
      if(shown.length>=(innerWidth<700?1:2))break;
      if(shown.some(other=>Math.abs(other.x-marker.screen.x)<210&&Math.abs(other.y-marker.screen.y)<112))continue;
      marker.el.style.opacity='1';marker.el.style.pointerEvents='auto';marker.el.tabIndex=0;marker.el.removeAttribute('aria-hidden');
      marker.el.style.transform=`translate(${marker.screen.x}px,${marker.screen.y}px) translate(-50%,-100%)`;shown.push(marker.screen);
    }
  }
}

function loop(now){raf=0;const dt=clamp((now-last)/1000||.016,0,.05);last=now;render(dt);
 if(!document.hidden&&(state.phase==='interior'||machineMoving||(state.phase==='city'&&streetCrowd.length>0)||state.phase==='tunnel'&&!state.paused||state.phase==='ending'||state.phase==='switching'||Math.abs(state.distance-state.targetDistance)>.005||Math.abs(uniform.fold.value-state.foldTarget)>.0001||Math.abs(uniform.start.value-state.startTarget)>.005||Math.abs(stripPosition-stripTarget)>.001||Math.abs(stripVelocity)>.001))schedule();
}
function schedule(){if(!raf&&!document.hidden){if(!last||performance.now()-last>250)last=performance.now();raf=requestAnimationFrame(loop);}}
function resize(){if(!renderer)return;renderer.setSize(innerWidth,innerHeight,false);machines?.resize(innerWidth,innerHeight);for(const c of [camera,tunnelCamera]){c.aspect=innerWidth/innerHeight;c.updateProjectionMatrix();}interior?.resize(innerWidth,innerHeight);if(handling?.reading){handling.layoutBook();handling.showSpread(handling.reading.spread);}schedule();}
function move(value){state.targetDistance=clamp(value,0,TRAVEL_MAX);schedule();}

$('skip').onclick=()=>state.phase==='ending'?finishJourney():showCity();$('retry').onclick=()=>{state.skip=true;load();};
$('pause').onclick=()=>{state.paused=!state.paused;$('pause').setAttribute('aria-pressed',String(state.paused));$('pause').setAttribute('aria-label',state.paused?'Resume journey':'Pause journey');schedule();};
$('location-control').onclick=()=>picker(true);
$('city-previous').onclick=()=>selectCity(cityIndex-1);$('city-next').onclick=()=>selectCity(cityIndex+1);
for(const el of document.querySelectorAll('button[data-city]'))el.onclick=()=>selectCity(CITIES.findIndex(c=>c.id===el.dataset.city),el.dataset.street);$('back-to-street').onclick=()=>picker(false);
$('close-place').onclick=()=>$('place-dialog').close();
$('place-dialog').addEventListener('close',()=>{if(state.phase==='review'){phase('city');state.reviewFocus?.focus();schedule();}});
$('time-slider').addEventListener('input',event=>{clock.minutes=Number(event.target.value);clock.live=false;applyTime();});
$('time-now').onclick=()=>{syncClockToNow();$('time-slider').value=String(Math.round(clock.minutes));applyTime(true);};
// While the clock is live it keeps real time, at one minute of resolution.
setInterval(()=>{
 if(!clock.live||state.phase!=='city'||document.hidden)return;
 const before=Math.round(clock.minutes);
 syncClockToNow();
 if(Math.round(clock.minutes)!==before){$('time-slider').value=String(Math.round(clock.minutes));applyTime();}
},20000);
window.addEventListener('wheel',e=>{
 if(state.phase==='interior'&&handling?.reading){
  e.preventDefault();
  handling.zoomMenu((e.deltaMode===1?e.deltaY*16:e.deltaY)*.0004);schedule();return;
 }
 if(state.phase==='interior'){
  e.preventDefault();
  const delta=e.deltaMode===1?e.deltaY*16:e.deltaMode===2?e.deltaY*innerHeight:e.deltaY;
  // The wheel zooms: the lens narrows while walking, the eye moves in while inspecting.
  interior.zoom(clamp(-delta/100,-3,3));
  schedule();return;
 }
 if(state.phase!=='city'||e.target.closest?.('#city-mechanism'))return;
 e.preventDefault();const delta=e.deltaMode===1?e.deltaY*16:e.deltaMode===2?e.deltaY*innerHeight:e.deltaY;
 move(state.targetDistance+delta*.022);},{passive:false});
function capture(id){
 // Capture is refused while a pointer-lock request is in flight; dragging still works.
 try{$('world').setPointerCapture(id);}catch{}
}
$('world').addEventListener('pointerdown',e=>{
 if(state.phase==='city'&&machines){
  const kind=machines.press(e.clientX,e.clientY);
  if(kind&&kind!=='body'){state.machine=true;capture(e.pointerId);schedule();return;}
 }
 if(state.phase==='interior'){
  if(e.pointerType==='touch'){
   state.touches.set(e.pointerId,{x:e.clientX,y:e.clientY});
   if(state.touches.size===2){
    // Two fingers pinch to zoom; they no longer walk or turn.
    const [a,b]=[...state.touches.values()];
    state.pinch=Math.hypot(a.x-b.x,a.y-b.y);state.stick=null;state.drag=null;state.press=null;
    interiorKeys.stickX=0;interiorKeys.stickY=0;capture(e.pointerId);return;
   }
   state.press={x:e.clientX,y:e.clientY,t:performance.now(),id:e.pointerId};
   // Left of the frame is a thumb stick for walking; the rest turns the view.
   if(e.clientX<innerWidth*.45&&!handling?.reading&&!interior.inspecting)state.stick={id:e.pointerId,x:e.clientX,y:e.clientY};
   else state.drag={x:e.clientX,y:e.clientY,id:e.pointerId,touch:true,inside:true};
   capture(e.pointerId);return;
  }
  state.press={x:e.clientX,y:e.clientY,t:performance.now(),id:e.pointerId};
  if(pointerLocked){
   // Captured: a press is a click at the crosshair.
   return;
  }
  state.drag={x:e.clientX,y:e.clientY,id:e.pointerId,inside:true};
  return;
 }
 if(state.phase!=='city')return;
 state.drag={x:e.clientX,y:e.clientY,distance:state.targetDistance,touch:e.pointerType==='touch'};
 capture(e.pointerId);});
$('world').addEventListener('pointermove',e=>{
 if(state.phase==='city'&&machines&&!state.drag){
  const over=machines.move(e.clientX,e.clientY);
  $('world').style.cursor=over&&over!=='body'?'pointer':'';
  schedule();
  if(state.machine)return;
 }
 if(state.phase==='interior'){
  if(e.pointerType==='touch'&&state.touches?.has(e.pointerId)){
   state.touches.set(e.pointerId,{x:e.clientX,y:e.clientY});
   if(state.pinch&&state.touches.size>=2){
    const [a,b]=[...state.touches.values()];const span=Math.hypot(a.x-b.x,a.y-b.y);
    interior.zoom(Math.log(span/state.pinch)/Math.log(1/.9));state.pinch=span;schedule();return;
   }
  }
  if(state.stick&&state.stick.id===e.pointerId){
   // Thumb stick: offset from where the touch began, out to about 70 px.
   interiorKeys.stickX=clamp((e.clientX-state.stick.x)/70,-1,1);
   interiorKeys.stickY=clamp((state.stick.y-e.clientY)/70,-1,1);
   schedule();return;
  }
  if(!pointerLocked&&handling?.ready&&!state.drag){
   const over=handling.hover(e.clientX,e.clientY);
   $('world').style.cursor=over?'pointer':'';
  }
  // Once the pointer is locked the mousemove handler owns looking; dragging would
  // otherwise apply the same movement twice.
  if(!pointerLocked&&state.drag&&state.drag.id===e.pointerId&&!handling?.reading){
   const dx=e.clientX-state.drag.x,dy=e.clientY-state.drag.y;
   if(interior.inspecting)interior.orbit(dx*.0065,dy*.005);
   // A mouse drag turns the head the way the mouse goes; a finger drags the room, as a
   // photo sphere is swiped. Both ease off when zoomed in, so aiming stays steady.
   else if(state.drag.touch)interior.look(dx*-.0042*interior.lookScale,dy*.0035*interior.lookScale);
   else interior.look(dx*.0042*interior.lookScale,-dy*.0035*interior.lookScale);
   state.drag.x=e.clientX;state.drag.y=e.clientY;schedule();return;
  }
  return;
 }
 if(!state.drag)return;
 if(state.phase!=='city')return;
 if(state.drag.touch)move(state.drag.distance+(state.drag.y-e.clientY)*.065);
 else{state.lookX=clamp((e.clientX-state.drag.x)*-.006,-.55,.55);state.lookY=clamp((e.clientY-state.drag.y)*.005,-.35,.35);schedule();}
});
function endPointer(e){
 if(state.machine){machines?.release();state.machine=false;schedule();}
 if(state.phase==='interior'&&state.press&&e&&e.type==='pointerup'&&state.press.id===e.pointerId){
  const press=state.press;state.press=null;
  const travelled=Math.hypot(e.clientX-press.x,e.clientY-press.y);
  if(travelled<7&&performance.now()-press.t<450){
   const now=performance.now(),last=state.lastTap;
   // A second tap close in time and place is a double tap: look closer at that spot.
   if(e.pointerType==='touch'&&last&&now-last.t<320&&Math.hypot(e.clientX-last.x,e.clientY-last.y)<30){
    state.lastTap=null;inspectAt(e.clientX,e.clientY);
   }else{
    state.lastTap={t:now,x:e.clientX,y:e.clientY};
    if(!(state.stick&&state.stick.id===e.pointerId))interiorClick(e.clientX,e.clientY);
   }
  }
 }
 if(e&&e.pointerType==='touch'&&state.touches){
  state.touches.delete(e.pointerId);
  if(state.touches.size<2)state.pinch=null;
 }
 if(state.stick&&(!e||state.stick.id===e.pointerId)){
  state.stick=null;interiorKeys.stickX=0;interiorKeys.stickY=0;schedule();
 }
 if(state.drag&&(!e||state.drag.id===undefined||state.drag.id===e.pointerId))state.drag=null;
}
$('world').addEventListener('pointerup',endPointer);
$('world').addEventListener('pointercancel',endPointer);
$('world').addEventListener('dblclick',e=>{if(state.phase==='interior'&&!handling?.reading)inspectAt(e.clientX,e.clientY);});

// --- looking closer -----------------------------------------------------------------
const WALK_HINT='W A S D or arrow keys to walk · drag to look · scroll to zoom · double-click to look closer';
const INSPECT_HINT='Drag to turn around it · scroll to move closer · Esc to step back';
const LOOKABLE=new Set(['dish','menu','bottle','bell']);
/** Fly the eye to whatever is at a screen point, framing it whole if it is one thing. */
function inspectAt(x,y){
 if(state.phase!=='interior'||!interior?.ready)return false;
 const targets=[interior.root,...(handling?.served||[]).map(entry=>entry.group),...(handling?.menus||[])];
 // Stand-ins for picking are invisible; only what can be seen can be looked at.
 const hit=interior.pick(x,y,targets).find(h=>h.object.visible&&h.object.material?.visible!==false&&h.distance<14);
 if(!hit)return false;
 let object=hit.object,size=.18;
 while(object&&!LOOKABLE.has(object.userData?.kind))object=object.parent;
 let point=hit.point;
 if(object){
  const box=new THREE.Box3().setFromObject(object);
  point=box.getCenter(new THREE.Vector3());size=Math.max(.06,box.getSize(new THREE.Vector3()).length()/2);
 }
 interior.inspect(point,size);
 $('interior-hint').textContent=INSPECT_HINT;$('interior-hint').hidden=false;
 $('interior-status').textContent='Looking closer. Esc to step back.';
 schedule();return true;
}
function leaveInspect(){
 if(!interior?.inspecting)return;
 interior.endInspect();
 $('interior-hint').textContent=WALK_HINT;$('interior-hint').hidden=state.interiorMoved;
 schedule();
}
// Arrows move exactly as W A S D do; Q and E turn on the spot for keyboard-only visitors.
const INTERIOR_KEYS={KeyW:'forward',ArrowUp:'forward',KeyS:'back',ArrowDown:'back',
 KeyA:'left',ArrowLeft:'left',KeyD:'right',ArrowRight:'right',
 KeyQ:'turnLeft',KeyE:'turnRight'};
document.addEventListener('keyup',e=>{
 if(state.phase!=='interior')return;
 const action=INTERIOR_KEYS[e.code];
 if(action){interiorKeys[action]=false;schedule();}
 if(e.key==='Shift'){interiorKeys.boost=false;schedule();}
});
$('interior-leave').onclick=()=>leaveInterior();

// Looking indoors is a drag. Pointer lock is no longer requested, since a captured mouse
// hid the cursor that points at menus and dishes; if a browser grants one anyway (an
// extension, a console), the view still follows the mouse and clicks go to the centre.
const LOOK_SENSITIVITY=.0022;
let pointerLocked=false;
document.addEventListener('pointerlockchange',()=>{
 pointerLocked=document.pointerLockElement===$('world');
 document.body.dataset.pointerLock=String(pointerLocked);
 $('crosshair').hidden=!pointerLocked||state.phase!=='interior'||!!handling?.reading;
});
document.addEventListener('mousemove',e=>{
 if(!pointerLocked||state.phase!=='interior')return;
 interior.look(e.movementX*LOOK_SENSITIVITY,-e.movementY*LOOK_SENSITIVITY);
 schedule();
});
document.addEventListener('keydown',e=>{
 if(transit.active)return;
 if(state.phase==='interior'){
  // Escape unwinds one thing at a time: the mouse, the menu, the bottle, the seat, the
  // dish panel, and only then the room.
  if(e.key==='Escape'){
   if(pointerLocked)return;
   if(interior?.inspecting){leaveInspect();return;}
   if(handling?.reading){handling.closeMenu();return;}
   if(handling?.holding){handling.returnBottle();return;}
   if(handling?.seated){handling.stand();return;}
   if(!$('dish-panel').hidden){$('dish-panel').hidden=true;document.body.dataset.dish='false';return;}
   leaveInterior();return;
  }
  if(handling?.reading){
   if(e.key==='ArrowRight'||e.key==='PageDown'){e.preventDefault();handling.turnPage(1);return;}
   if(e.key==='ArrowLeft'||e.key==='PageUp'){e.preventDefault();handling.turnPage(-1);return;}
  }
  const action=INTERIOR_KEYS[e.code];
  if(action){e.preventDefault();interiorKeys[action]=true;schedule();}
  if(e.key==='Shift'){interiorKeys.boost=true;schedule();}
  if(e.target.matches?.('input,button,a'))return;
  if(e.key==='='||e.key==='+'){e.preventDefault();interior.zoom(1.5);schedule();}
  if(e.key==='-'||e.key==='_'){e.preventDefault();interior.zoom(-1.5);schedule();}
  if(e.code==='KeyF'&&!handling?.reading){
   e.preventDefault();
   if(interior.inspecting)leaveInspect();else inspectAt(innerWidth/2,innerHeight/2);
  }
  return;
 }
 if(state.phase==='review')return;
 if(state.phase==='picker'){
  if(e.key==='Escape'){picker(false);return;}
  if(e.key==='Tab'){
   const focusables=[...$('city-picker').querySelectorAll('button,a[href],summary')];const visible=focusables.filter(el=>el.getClientRects().length);const first=visible[0],last=visible.at(-1);
   if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
  }return;
 }
 if(e.target.matches('input,button,a'))return;
 if(state.phase==='city'&&['ArrowDown','ArrowUp','PageDown','PageUp'].includes(e.key)){e.preventDefault();move(state.targetDistance+(['ArrowDown','PageDown'].includes(e.key)?1:-1)*(e.key.startsWith('Page')?12:2));}
 if(e.key==='Escape')location.href='../';
});
document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(raf);raf=0;}else schedule();});
window.addEventListener('resize',resize);
reduced.addEventListener('change',()=>{if(reduced.matches&&state.phase==='tunnel')showCity();schedule();});
$('world').addEventListener('webglcontextlost',e=>{e.preventDefault();cancelAnimationFrame(raf);raf=0;fallback('The 3D view was interrupted.');});
// Read-only diagnostics for local visual QA; no hidden shortcuts change the scene.
window.foldedCityStatus=()=>({phase:state.phase,tunnelProgress:Math.min(1,state.time/9.5),minutes:clock.minutes,weekday:clock.weekday,live:clock.live,sunAltitude:sunlit.sunAltitude,moonAltitude:sunlit.moonAltitude,night:sunlit.night,openNow:openCount(),fold:uniform.fold.value,bendStart:uniform.start.value,city:CITIES[cityIndex].id,distance:state.distance,targetDistance:state.targetDistance,camera:camera?.position.toArray(),...stats,drawCalls:renderer?.info.render.calls,renderCount});
load();


window.streetModelStatus=()=>({street:streetLayout?.street,model:CITIES[cityIndex].model,
 people:streetCrowd.length,visiblePeople:streetCrowd.filter(p=>p.entry.person.visible).length,
 walkers:streetCrowd.filter(p=>p.walker).length,activities:[...new Set(streetCrowd.map(p=>p.motion))],characters:[...new Set(streetCrowd.map(p=>p.entry.character))],activeLights:lampLights.filter(l=>l.visible).length,
 visibleOpenMeshes:[...shopParts.values()].reduce((n,g)=>n+g.open.filter(o=>o.visible).length,0),
 visibleShutMeshes:[...shopParts.values()].reduce((n,g)=>n+g.shut.filter(o=>o.visible).length,0),
 landscape:landscapeStats,sourceFootprints:streetLayout?.occluders.length});

window.interiorStatus=()=>({id:interiorId,ready:interior?.ready||false,phase:state.phase,position:interior?[interior.walker.x,interior.walker.floor,interior.walker.z]:null,stats:interior?.stats,lightsOn:interior?.lightsOn});
