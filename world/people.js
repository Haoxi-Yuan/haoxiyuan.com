import * as THREE from 'three';
import { GLTFLoader } from '../assets/vendor/GLTFLoader.js';
import * as SkeletonUtils from '../assets/vendor/SkeletonUtils.js';

// People for the street and for KOMA: Mixamo characters and motions the site owner
// downloaded, prepared by source/folded-city/build_people_v16.py. Every motion drives every
// character, because the build gives all rigs the same bone names; a motion's hip
// translation is rescaled to the character it plays on, since rigs differ in size.
//
// A role asks for motions by preference, so the scene improves as more motions are added:
// seated diners use a seated talking or idle motion if there is one, and so on.

export const ROLES = {
  seated: ['sitting-talking', 'sitting-idle', 'sitting', 'sitting-clap', 'sitting-yell'],
  standing: ['standing-idle', 'idle', 'standing-w-briefcase-idle', 'breathing-idle'],
  talking: ['talking', 'standing-talking', 'having-a-meeting', 'angry', 'standing-idle', 'standing-w-briefcase-idle'],
  walking: ['walking', 'walk', 'female-walk', 'walking-in-place'],
};

// A motion exported from a library often opens with the rig whipping out of its bind pose
// into the first real frame, and it rarely ends where it began. Played on a loop, both are
// seen as a person suddenly throwing their arms up once a cycle. Both are measured here and
// taken out of the clip's own keys: the lead-in is cut off, and the tail is eased back into
// the first frame so the loop closes. A clip that is already clean is left untouched.
const WHIP = 45;        // degrees between two frames that no body could cover
const SEAM = 8;         // degrees between a clip's first and last frame worth blending out
const QUARTER = .25;    // a lead-in is at the head of a clip, never a quarter of the way in

const angleBetween = (a, b, i, j) => {
  let dot = 0;
  for (let k = 0; k < 4; k++) dot += a[i + k] * b[j + k];
  return Math.acos(Math.min(1, Math.abs(dot))) * 2 * 180 / Math.PI;
};

/**
 * The time by which the rig has stopped whipping: 0 when the clip is clean, and -1 when the
 * whipping runs so far in that cutting it would take the motion with it. Fingers are left
 * out of the reckoning; they snap about in library motions and nobody sees it from a street.
 */
function leadIn(clip) {
  let body = 0, all = 0;
  for (const track of clip.tracks) {
    if (!(track instanceof THREE.QuaternionKeyframeTrack)) continue;
    // Only the run at the head counts: once four frames in a row are calm the rig has
    // arrived, and anything after that belongs to the motion.
    let last = 0, calm = 0;
    for (let i = 0; i + 1 < track.times.length && calm < 4; i++) {
      if (angleBetween(track.values, track.values, i * 4, (i + 1) * 4) > WHIP) {
        last = track.times[i + 1];
        calm = 0;
      } else {
        calm++;
      }
    }
    all = Math.max(all, last);
    // Fingers hang the deepest and settle the latest, but a bad finger is not a bad motion.
    if (!track.name.includes('Finger')) body = Math.max(body, last);
  }
  if (body > clip.duration * QUARTER) return -1;
  return Math.min(all, clip.duration * QUARTER);
}

/** Drop every key before a time, and start the clip there, holding the pose it had then. */
function cutBefore(clip, at) {
  for (const track of clip.tracks) {
    const size = track.getValueSize();
    const times = Array.from(track.times);
    const values = Array.from(track.values);
    let first = 0;
    while (first + 1 < times.length && times[first + 1] <= at + 1e-4) first++;
    // A track whose keys straddle the cut is read where the cut falls, not at its last key.
    const head = values.slice(first * size, (first + 1) * size);
    if (first + 1 < times.length && times[first] < at - 1e-4) {
      const span = times[first + 1] - times[first];
      const t = span > 0 ? (at - times[first]) / span : 0;
      if (track instanceof THREE.QuaternionKeyframeTrack) {
        const q = new Float32Array(values.slice(first * size, (first + 2) * size));
        THREE.Quaternion.slerpFlat(q, 0, q, 0, q, 4, t);
        for (let k = 0; k < size; k++) head[k] = q[k];
      } else {
        for (let k = 0; k < size; k++) {
          head[k] += (values[(first + 1) * size + k] - head[k]) * t;
        }
      }
    }
    const keptTimes = [0];
    const keptValues = head.slice();
    for (let i = first + 1; i < times.length; i++) {
      if (times[i] <= at + 1e-4) continue;
      keptTimes.push(times[i] - at);
      for (let k = 0; k < size; k++) keptValues.push(values[i * size + k]);
    }
    track.times = new Float32Array(keptTimes);
    track.values = new Float32Array(keptValues);
  }
  clip.duration -= at;
}

/** Ease a clip's tail back into its first frame, so it comes round without a jump. */
function closeLoop(clip) {
  let seam = 0;
  for (const track of clip.tracks) {
    if (!(track instanceof THREE.QuaternionKeyframeTrack)) continue;
    seam = Math.max(seam, angleBetween(track.values, track.values, 0, track.values.length - 4));
  }
  if (seam < SEAM) return;
  const blend = Math.min(.5, clip.duration * QUARTER);
  const from = clip.duration - blend;
  for (const track of clip.tracks) {
    const size = track.getValueSize();
    const quaternion = track instanceof THREE.QuaternionKeyframeTrack;
    // A motion that travels - a walk with its hips moving - must keep its travel.
    if (!quaternion && track.name.endsWith('.position')) {
      let far = 0;
      for (let k = 0; k < size; k++) {
        far = Math.max(far, Math.abs(track.values[track.values.length - size + k] - track.values[k]));
      }
      if (far > .5) continue;
    }
    for (let i = 0; i < track.times.length; i++) {
      if (track.times[i] <= from) continue;
      const t = (track.times[i] - from) / blend;
      const weight = t * t * (3 - 2 * t);
      if (quaternion) {
        THREE.Quaternion.slerpFlat(track.values, i * size,
                                   track.values, i * size, track.values, 0, weight);
      } else {
        for (let k = 0; k < size; k++) {
          track.values[i * size + k] += (track.values[k] - track.values[i * size + k]) * weight;
        }
      }
    }
    // and the last beat of the loop is the first, so the two ends meet exactly
    const last = track.times.length - 1;
    if (track.times[last] < clip.duration - 1e-4) {
      const times = new Float32Array(last + 2);
      const values = new Float32Array((last + 2) * size);
      times.set(track.times);
      values.set(track.values);
      times[last + 1] = clip.duration;
      for (let k = 0; k < size; k++) values[(last + 1) * size + k] = track.values[k];
      track.times = times;
      track.values = values;
    } else {
      for (let k = 0; k < size; k++) track.values[last * size + k] = track.values[k];
    }
  }
}

const HEIGHTS = [1.60, 1.66, 1.70, 1.74, 1.78, 1.83];
// Clothes are tinted a little per person, so two copies of one character are not twins.
const TINTS = [[.65,.66,.64],[.24,.32,.44],[.57,.43,.29],[.21,.23,.24],[.46,.26,.23],[.27,.36,.28]];

export class People {
  constructor(manifestURL, assetsBase) {
    this.manifestURL = manifestURL;
    this.base = assetsBase;
    this.loader = new GLTFLoader();
    this.manifest = null;
    this.templates = new Map();
    this.clips = new Map();
    this.fitted = new Map();
    this.crowd = [];
  }

  async load() {
    if (this.manifest) return this.manifest;
    const response = await fetch(this.manifestURL);
    if (!response.ok) throw new Error('The people manifest could not be loaded.');
    this.manifest = await response.json();
    return this.manifest;
  }

  get characters() { return Object.keys(this.manifest?.characters || {}); }

  /** The first motion on a role's list that exists, or null. */
  motionFor(role) {
    return this.motionsFor(role)[0] || null;
  }

  /** Every motion on a role's list that exists, in order of preference. */
  motionsFor(role) {
    return (ROLES[role] || [role]).filter(name => this.manifest?.clips?.[name]);
  }

  async template(key) {
    if (!this.templates.has(key)) {
      const entry = this.manifest.characters[key];
      this.templates.set(key, this.loader.loadAsync(this.base + entry.file).then(gltf => {
        const root = gltf.scene;
        root.updateMatrixWorld(true);
        // Measure the actual skinned sole, not an ankle/toe bone origin.
        const box=new THREE.Box3(),point=new THREE.Vector3();
        root.traverse(object=>{
          if(!object.isMesh)return;
          object.skeleton?.update();
          for(let i=0;i<object.geometry.attributes.position.count;i++){
            object.getVertexPosition(i,point);point.applyMatrix4(object.matrixWorld);box.expandByPoint(point);
          }
        });
        const toes=['LeftToeBase','RightToeBase'].map(n=>root.getObjectByName(n)).filter(Boolean);
        const toeHeight=toes.length?Math.min(...toes.map(b=>b.getWorldPosition(new THREE.Vector3()).y)):box.min.y;
        root.traverse(object => {
          if (!object.isMesh) return;
          object.castShadow = true;
          object.frustumCulled = false;
          const material = object.material;
          if (material.map) material.map.anisotropy = 4;
          // Hair and lashes are cut-outs; clipping keeps them from sorting against the room.
          if (material.transparent || material.alphaTest) {
            material.transparent = false;
            material.alphaTest = 0.4;
            material.depthWrite = true;
          }
          material.envMapIntensity = 0.7;
        });
        return { root, height: box.max.y - box.min.y, floor: box.min.y, toeHeight };
      }));
    }
    return this.templates.get(key);
  }

  async clip(name, key) {
    const cacheKey=name+'|'+(key||'');
    if (!this.clips.has(cacheKey)) {
      const record=this.manifest.clips[name];
      const entry = record.variants?.[key]||record;
      this.clips.set(cacheKey, this.loader.loadAsync(this.base + entry.file).then(gltf => {
        const clip = gltf.animations[0];
        clip.name = name;
        return clip;
      }));
    }
    return this.clips.get(cacheKey);
  }

  /** A motion fitted to one character: hip translation scaled by the ratio of hip heights. */
  async fittedClip(name, key) {
    const id = name + '|' + key;
    if (!this.fitted.has(id)) {
      this.fitted.set(id, this.clip(name,key).then(source => {
        const ratio = this.manifest.characters[key].hips / (this.manifest.clips[name].variants?.[key]||this.manifest.clips[name]).hips;
        const clip = source.clone();
        clip.tracks = clip.tracks.filter(track => !track.name.endsWith('.scale'));
        // A clip whose whipping runs past its opening is left as it was: cutting into the
        // motion, or easing its end into a bad first frame, would only move the fault.
        const settled = leadIn(clip);
        if (settled >= 0) {
          if (settled > 0) cutBefore(clip, settled);
          closeLoop(clip);
        }
        for (const track of clip.tracks) {
          if (track.name === 'Hips.position' && Math.abs(ratio - 1) > 1e-3) {
            for (let i = 0; i < track.values.length; i++) track.values[i] *= ratio;
          }
        }
        return clip;
      }));
    }
    return this.fitted.get(id);
  }

  /**
   * One person, standing on the origin of the returned group, facing +z.
   * options: { character, motion, height, tint, phase, speed }
   */
  async spawn(options) {
    const key = options.character;
    const available=name=>{const r=this.manifest.clips[name];return !!(r?.variants?.[key]||(!this.manifest.characters[key].family&&r?.file));};
    if(!available(options.motion))options={...options,motion:(this.manifest.characters[key].family==='rocketbox'?'standing-idle':'standing-w-briefcase-idle')};
    const template = await this.template(key);
    const clip = await this.fittedClip(options.motion, key);
    const body = SkeletonUtils.clone(template.root);
    const scale = (options.height || 1.72) / template.height;
    body.scale.multiplyScalar(scale);
    body.position.y = -template.floor * scale;
    if (options.tint) {
      body.traverse(object => {
        if (!object.isMesh || !/top|bottom|hoodie|pants|shirt|jacket/i.test(object.material.name + object.name)) return;
        object.material = object.material.clone();
        object.material.color.multiply(new THREE.Color(...options.tint));
      });
    }
    const person = new THREE.Group();
    person.add(body);
    const mixer = new THREE.AnimationMixer(body);
    const action = mixer.clipAction(clip);
    action.play();
    action.time = (options.phase ?? Math.random()) * clip.duration;
    action.timeScale = options.speed ?? 1;
    const record=this.manifest.clips[options.motion],motion=record.variants?.[key]||record,ratio=this.manifest.characters[key].hips/motion.hips;
    if(options.walkSpeed&&motion.referenceSpeed)action.timeScale=options.walkSpeed/(motion.referenceSpeed*ratio*scale);
    const entry = { person, body, mixer, action, character: key, motion: options.motion,
      gaitRate:action.timeScale,baseY:body.position.y,soleToToe:(template.toeHeight-template.floor)*scale,
      toes:['LeftToeBase','RightToeBase'].map(n=>body.getObjectByName(n)).filter(Boolean) };
    mixer.update(0);
    if(this.manifest.characters[key].family==='rocketbox'&&['phone','drinking'].includes(options.motion)){
      const hand=body.getObjectByName('RightHand');
      if(hand){
        const prop=new THREE.Group();prop.name='activity-'+options.motion;
        const material=new THREE.MeshStandardMaterial({color:options.motion==='phone'?0x20282c:0xeee4cc,roughness:.55});
        const object=new THREE.Mesh(options.motion==='phone'?new THREE.BoxGeometry(6,11,.7):new THREE.CylinderGeometry(3.1,2.3,8,20),material);prop.add(object);
        if(options.motion==='phone'){
          const screen=new THREE.Mesh(new THREE.PlaneGeometry(5.2,9.8),new THREE.MeshStandardMaterial({color:0x779097,emissive:0x253a42,emissiveIntensity:.25,roughness:.3}));screen.position.z=.37;prop.add(screen);
        }
        prop.position.set(5,-1,1);prop.rotation.set(Math.PI/2,0,Math.PI/2);hand.add(prop);
      }
    }
    person.userData.person = entry;
    this.crowd.push(entry);
    return entry;
  }

  /** Pick a character, height and tint for the n-th person of a scene, deterministically. */
  look(n,street=false) {
    const keys = street&&this.manifest.streetCharacters?.length?this.manifest.streetCharacters:this.characters.filter(k=>!this.manifest.characters[k].family);
    return {
      character: keys[n % keys.length],
      height: HEIGHTS[(n * 7 + 3) % HEIGHTS.length],
      tint: n < keys.length ? null : TINTS[(n * 5 + 1) % TINTS.length],
    };
  }

  step(entry,dt){
    entry.body.position.y=entry.baseY;entry.mixer.update(dt);
    if(!['walking','talking','listening','phone','drinking','standing-idle','looking-around'].includes(entry.motion)||!entry.toes.length)return;
    entry.person.updateMatrixWorld(true);
    const inverse=entry.person.matrixWorld.clone().invert();
    const footY=Math.min(...entry.toes.map(b=>b.getWorldPosition(new THREE.Vector3()).applyMatrix4(inverse).y));
    entry.body.position.y-=THREE.MathUtils.clamp(footY-entry.soleToToe,-.09,.09);
    entry.body.updateMatrixWorld(true);
  }

  update(dt) {
    for (const entry of this.crowd) if (entry.person.visible && entry.person.parent) entry.mixer.update(dt);
  }

  remove(entries) {
    const gone = new Set(entries);
    for (const entry of entries) {
      entry.mixer.stopAllAction();
      entry.person.removeFromParent();
    }
    this.crowd = this.crowd.filter(entry => !gone.has(entry));
  }
}
