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

const HEIGHTS = [1.60, 1.66, 1.70, 1.74, 1.78, 1.83];
// Clothes are tinted a little per person, so two copies of one character are not twins.
const TINTS = [[1, 1, 1], [0.72, 0.78, 0.9], [0.9, 0.82, 0.7], [0.62, 0.62, 0.62], [0.95, 0.9, 0.9], [0.7, 0.85, 0.75]];

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
        // A skinned mesh's own bounds are in bind space, not what is drawn; the skeleton is
        // what stands in the room, so height is measured from the bones.
        const box = new THREE.Box3();
        const point = new THREE.Vector3();
        root.traverse(object => { if (object.isBone) box.expandByPoint(object.getWorldPosition(point)); });
        const top = root.getObjectByName('HeadTop_End');
        if (top) box.max.y = Math.max(box.max.y, top.getWorldPosition(point).y + 0.02 * (box.max.y - box.min.y));
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
        return { root, height: box.max.y - box.min.y, floor: box.min.y };
      }));
    }
    return this.templates.get(key);
  }

  async clip(name) {
    if (!this.clips.has(name)) {
      const entry = this.manifest.clips[name];
      this.clips.set(name, this.loader.loadAsync(this.base + entry.file).then(gltf => {
        const clip = gltf.animations[0];
        clip.name = name;
        return clip;
      }));
    }
    return this.clips.get(name);
  }

  /** A motion fitted to one character: hip translation scaled by the ratio of hip heights. */
  async fittedClip(name, key) {
    const id = name + '|' + key;
    if (!this.fitted.has(id)) {
      this.fitted.set(id, this.clip(name).then(source => {
        const ratio = this.manifest.characters[key].hips / this.manifest.clips[name].hips;
        const clip = source.clone();
        clip.tracks = clip.tracks.filter(track => !track.name.endsWith('.scale'));
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
    const entry = { person, body, mixer, action, character: key, motion: options.motion };
    person.userData.person = entry;
    this.crowd.push(entry);
    return entry;
  }

  /** Pick a character, height and tint for the n-th person of a scene, deterministically. */
  look(n) {
    const keys = this.characters;
    return {
      character: keys[n % keys.length],
      height: HEIGHTS[(n * 7 + 3) % HEIGHTS.length],
      tint: n < keys.length ? null : TINTS[(n * 5 + 1) % TINTS.length],
    };
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
