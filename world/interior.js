import * as THREE from 'three';

// Walking the KOMA interior. The room is the merged rebuild; standing height comes from a
// height field raycast against its real floors, so the raised lounge, the arched bridge
// deck, the descent steps and the stair to the mezzanine are all walked at their true
// heights instead of on a guessed plane.
//
// Blender authored the room with +Y into the restaurant and +Z up; the glTF export is
// y-up, so here +Y is up and the visitor walks from +Z (the street door) toward -Z.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const EYE = 1.62;
const WALK_SPEED = 3.6;
const RUN_SPEED = 6.5;
// Movement feel. Looking is damped rather than applied raw, so a mouse or a thumb does
// not jitter the view; walking accelerates and coasts; the head rises and falls with the
// stride and the body leans a little into a sidestep.
const LOOK_DAMP = 16;
const ACCELERATE = 12.0;
const BRAKE = 12.0;
const BOB_RATE = 8.6;
const BOB_HEIGHT = 0.032;
const BOB_SWAY = 0.012;
const LEAN = 0.035;
const TURN_RATE = 1.9;
// Climbing is limited to a step; dropping is not, so walking off the landing into the
// dining hall works while walking off the mezzanine edge still does not.
const STEP_UP = 0.46;
const STEP_DOWN = 1.25;
const RADIUS = 0.34;
// The v16 walking map is sampled around the body rather than at its centre, so a visitor
// fits between two chairs but not through one. BODY is the radius of that ring.
const BODY = 0.18;
const RING = [[0, 0], ...Array.from({ length: 8 }, (_, i) => [Math.cos(i * Math.PI / 4), Math.sin(i * Math.PI / 4)])];
// Zoom narrows the lens, like raising a pair of opera glasses; inspecting flies the eye
// to an object and circles it.
const FOV = 62, FOV_MIN = 14;
const INSPECT_NEAR = 0.18, INSPECT_FAR = 2.6;
const FLY_TIME = 0.55;
const ARCH_APPROACH = 0.55;
// One pool of lights follows the visitor; the room itself carries 57, far past a frame's
// budget, so the nearest few are seated on the recorded positions each frame.
const LIGHT_POOL = 10;
const AREA_SCALE = 0.0105, POINT_SCALE = 0.055;
const AREA_RANGE = 15, POINT_RANGE = 7;

export class Interior {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05040a);
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.05, 160);
    this.ready = false;
    this.data = null;
    this.root = null;
    this.props = new Map();
    this.lightSources = [];
    this.lights = [];
    this.environment = null;
    this.raycaster = new THREE.Raycaster();
    this.walker = {
      x: 0, z: 0, floor: 0, yaw: 0, pitch: 0,
      forward: 0, strafe: 0, turn: 0, boost: false, glide: 0,
      momentum: new THREE.Vector2(), pendingYaw: 0, pendingPitch: 0,
      bob: 0, lean: 0, speed: 0,
    };
    this.stats = {};
    this.fovTarget = this.defaultFov || FOV;
    this.inspecting = null;
    this.flight = null;
  }

  /** Load once; the street keeps running while this happens. */
  async load(loader, modelURL, dataURL, collisionURL) {
    if (this.ready) return this.stats;
    const [gltf, data, collision] = await Promise.all([
      loader.loadAsync(modelURL),
      fetch(dataURL).then(response => {
        if (!response.ok) throw new Error('The interior data could not be loaded.');
        return response.json();
      }),
      collisionURL ? Interior.readCollision(collisionURL) : Promise.resolve(null),
    ]);
    this.map = collision;
    this.data = data;
    this.defaultFov = data.viewFov || FOV;
    if(data.exteriorColor!==undefined)this.scene.background=new THREE.Color(data.exteriorColor);
    this.root = gltf.scene;
    this.root.traverse(object => {
      if (!object.isMesh) return;
      object.frustumCulled = true;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        material.envMapIntensity = 0.55;
        // Glass and water read wrong at full roughness in a room this dark.
        if (/glass|water|pool/i.test(material.name)) material.envMapIntensity = 1.1;
      }
    });
    // Props are whole glTF nodes. A node with several materials loads as a Group, so the
    // node is registered rather than its primitives, and it can be moved as one thing.
    for (const node of this.root.children) {
      const prop = /^prop-(bell|bottle)(?:[-_](\d+))?$/.exec(node.name);
      if (!prop) continue;
      this.props.set(prop[2] ? `${prop[1]}-${prop[2]}` : prop[1], node);
      node.userData.prop = prop[2] ? `${prop[1]}-${prop[2]}` : prop[1];
      node.userData.home = node.position.clone();
      node.userData.homeQuaternion = node.quaternion.clone();
    }
    this.scene.add(this.root);

    this.buildLights();
    this.buildEnvironment();
    this.field = data.walkable;
    this.ramps = data.ramps || [];
    this.arch = data.arch || null;
    this.obstacles = (data.obstacles || []).map(entry => ({
      x0: entry.x[0] - RADIUS, x1: entry.x[1] + RADIUS,
      y0: entry.y[0] - RADIUS, y1: entry.y[1] + RADIUS,
      top: entry.top, kind: entry.kind,
    }));

    let meshes = 0, triangles = 0;
    this.root.traverse(object => {
      if (!object.isMesh) return;
      meshes++;
      const geometry = object.geometry;
      triangles += (geometry.index?.count || geometry.attributes.position.count) / 3;
    });
    this.lightLevel = 1;
    this.trading = true;
    this.credit = data.credit || '';
    this.stats = { meshes, triangles, props: this.props.size, lights: this.lightSources.length };
    this.ready = true;
    return this.stats;
  }

  /** The v16 walking map: standing heights and body clearance at 10 cm, zlib-packed. */
  static async readCollision(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error('The interior walking map could not be loaded.');
    const meta = await response.json();
    const packed = Uint8Array.from(atob(meta.data), c => c.charCodeAt(0));
    const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate'));
    const buffer = await new Response(stream).arrayBuffer();
    const cells = meta.columns * meta.rows;
    return {
      ...meta, data: undefined,
      ground: new Int16Array(buffer, 0, cells),
      upper: new Int16Array(buffer, cells * 2, cells),
      flags: new Uint8Array(buffer, cells * 4, cells),
    };
  }

  buildLights() {
    this.lightSources = (this.data.lights || []).map(light => ({
      // Blender +Y into the room becomes -Z here.
      position: new THREE.Vector3(light.position[0], light.position[2], -light.position[1]),
      color: new THREE.Color(light.color[0], light.color[1], light.color[2]),
      intensity: light.energy * (light.kind === 'AREA' ? AREA_SCALE : POINT_SCALE),
      range: light.kind === 'AREA' ? AREA_RANGE : POINT_RANGE,
      kind: light.kind,
    }));
    for (let i = 0; i < LIGHT_POOL; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 10, 2);
      light.visible = false;
      this.scene.add(light);
      this.lights.push(light);
    }
    // A low fill so the walnut and lacquer never go fully black between pools of light.
    this.fill = new THREE.HemisphereLight(0x3a2a20, 0x120c08, 0.30);
    this.scene.add(this.fill);
  }

  /** A small warm gradient stands in for the room's own bounce light in reflections. */
  buildEnvironment() {
    const size = 32;
    const pixels = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      const t = y / (size - 1);
      // Warm near the ceiling, deep and neutral toward the floor.
      const r = 46 + 92 * (1 - t), g = 30 + 56 * (1 - t), b = 22 + 30 * (1 - t);
      for (let x = 0; x < size; x++) {
        const index = (y * size + x) * 4;
        pixels[index] = r; pixels[index + 1] = g; pixels[index + 2] = b; pixels[index + 3] = 255;
      }
    }
    const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.needsUpdate = true;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromEquirectangular(texture);
    this.scene.environment = this.environment.texture;
    pmrem.dispose();
    texture.dispose();
  }

  // --- the floor ----------------------------------------------------------------------
  /**
   * Standing height at a point on the plan, or null where there is no floor.
   *
   * Two things make this more than a lookup. The mezzanine sits over the sushi counter,
   * so each cell carries a lower and an upper surface and the one nearer the walker's
   * feet wins. And the stair to the mezzanine has open risers, which a sampled field
   * reads as holes down to the floor below, so that flight is a fitted ramp instead.
   */
  floorAt(bx, by) {
    if (this.map) {
      const special = this.special(bx, by);
      return special !== null ? special : this.mapFloor(bx, by).height;
    }
    // The bridge deck spans the pool, which has the dining foundation under it; inside the
    // deck's own footprint its sampled arch is the only floor that counts.
    const arch = this.arch;
    if (arch) {
      const span = arch.step * (arch.columns - 1);
      if (bx >= arch.x0 - RADIUS && bx <= arch.x0 + span + RADIUS
          && by >= arch.y[0] - RADIUS && by <= arch.y[1] + RADIUS) {
        const at = clamp((bx - arch.x0) / arch.step, 0, arch.columns - 1);
        const index = Math.floor(at), fraction = at - index;
        const a = arch.heights[index];
        const b = arch.heights[Math.min(index + 1, arch.columns - 1)];
        return a + (b - a) * fraction;
      }
    }
    for (const ramp of this.ramps) {
      if (bx < ramp.x[0] - RADIUS || bx > ramp.x[1] + RADIUS) continue;
      if (by < ramp.y[0] || by > ramp.y[1]) continue;
      // Inside a flight, the fitted climb replaces the sampled field entirely.
      return clamp(ramp.slope * by + ramp.intercept, ramp.z[0], ramp.z[1]);
    }
    if (this.map) return this.mapFloor(bx, by).height;
    const field = this.field;
    if (!field) return 0;
    const fx = (bx - field.origin[0]) / field.step;
    const fy = (by - field.origin[1]) / field.step;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    let best = null, bestGap = Infinity;
    // Each cell holds every surface found there, so a landing over the dining foundation
    // offers both. Nearest to the feet wins, rather than a blend: averaging across a step
    // edge would sink the visitor into the tread below.
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const x = x0 + dx, y = y0 + dy;
      if (x < 0 || y < 0 || x >= field.columns || y >= field.rows) continue;
      const cell = y * field.columns + x;
      for (let i = field.offsets[cell]; i < field.offsets[cell + 1]; i++) {
        const height = field.surfaces[i];
        const gap = Math.abs(height - this.walker.floor);
        if (gap < bestGap) { bestGap = gap; best = height; }
      }
    }
    return best;
  }

  /** Standing height and clearance at a point, from the v16 map; the level nearer the feet. */
  mapFloor(bx, by, near = this.walker.floor) {
    const map = this.map;
    const column = Math.round((bx - map.origin[0]) / map.step);
    const row = Math.round((by - map.origin[1]) / map.step);
    if (column < 0 || row < 0 || column >= map.columns || row >= map.rows) {
      return { height: null, blocked: true };
    }
    const cell = row * map.columns + column;
    const ground = map.ground[cell], upper = map.upper[cell];
    const none = map.none;
    let level = null;
    if (ground !== none && upper !== none) {
      level = Math.abs(ground / 1000 - near) <= Math.abs(upper / 1000 - near) ? 0 : 1;
    } else if (ground !== none) level = 0;
    else if (upper !== none) level = 1;
    if (level === null) return { height: null, blocked: true };
    return {
      height: (level ? upper : ground) / 1000,
      blocked: (map.flags[cell] & (level ? 2 : 1)) !== 0,
    };
  }

  /**
   * Whether the body fits at a point: every sample on a ring round it must stand on a
   * floor within a step of the feet, clear of anything between knee and head.
   */
  fits(bx, by, floor) {
    for (const [cx, cy] of RING) {
      const sample = this.special(bx + cx * BODY, by + cy * BODY);
      if (sample !== null) {
        if (sample - floor > STEP_UP || floor - sample > STEP_DOWN) return false;
        const clear = this.mapFloor(bx + cx * BODY, by + cy * BODY, sample);
        if (clear.height !== null && clear.blocked && Math.abs(clear.height - sample) < 0.2) return false;
        continue;
      }
      const at = this.mapFloor(bx + cx * BODY, by + cy * BODY, floor);
      if (at.height === null || at.blocked) return false;
      if (at.height - floor > STEP_UP || floor - at.height > STEP_DOWN) return false;
    }
    return true;
  }

  /** The bridge deck and the stair flight, which are fitted rather than sampled. */
  special(bx, by) {
    const arch = this.arch;
    if (arch) {
      const span = arch.step * (arch.columns - 1);
      // The deck's end treads stop half a metre short of the landings, over the pool's
      // coping; the approach is carried on at the end height so the bridge can be mounted.
      if (bx >= arch.x0 - ARCH_APPROACH && bx <= arch.x0 + span + ARCH_APPROACH
          && by >= arch.y[0] && by <= arch.y[1]) {
        const at = clamp((bx - arch.x0) / arch.step, 0, arch.columns - 1);
        const index = Math.floor(at), fraction = at - index;
        const a = arch.heights[index];
        const b = arch.heights[Math.min(index + 1, arch.columns - 1)];
        return a + (b - a) * fraction;
      }
    }
    for (const ramp of this.ramps) {
      if (bx < ramp.x[0] || bx > ramp.x[1] || by < ramp.y[0] || by > ramp.y[1]) continue;
      return clamp(ramp.slope * by + ramp.intercept, ramp.z[0], ramp.z[1]);
    }
    return null;
  }

  blocked(bx, by, floor) {
    for (const box of this.obstacles) {
      if (bx < box.x0 || bx > box.x1 || by < box.y0 || by > box.y1) continue;
      // A plinth you can stand on is not an obstacle; a counter at chest height is.
      if (box.top > floor + 0.35) return true;
    }
    return false;
  }

  /** Put the visitor at the street door, facing into the passage. */
  spawn() {
    const passage = this.data.floors?.passage;
    const bx = this.data.spawn?.[0] ?? (passage ? (passage.x[0] + passage.x[1]) / 2 : -3.7);
    const by = this.data.spawn?.[1] ?? (passage ? passage.y[0] + 1.4 : -28.0);
    this.walker.x = bx;
    this.walker.z = by;
    this.walker.floor = this.floorAt(bx, by) ?? 0.56;
    this.walker.yaw = 0;
    this.walker.pitch = 0;
    this.walker.momentum.set(0, 0);
    this.walker.glide = 0;
    this.walker.pendingYaw = 0;
    this.walker.pendingPitch = 0;
    this.walker.turn = 0;
    this.walker.bob = 0;
    this.walker.lean = 0;
    this.walker.speed = 0;
    this.inspecting = null;
    this.flight = null;
    this.fovTarget = this.defaultFov || FOV;
    this.camera.fov = this.defaultFov || FOV;
    this.camera.near = 0.05;
    this.camera.updateProjectionMatrix();
    this.place();
  }

  /** True once the visitor has walked back out through the street door. */
  atExit() {
    const passage = this.data.floors?.passage;
    const limit = passage ? passage.y[0] + 0.5 : -28.9;
    return this.walker.z < limit;
  }

  place() {
    const walker = this.walker;
    // Stride: the head rises twice per step and sways once, which is what reads as walking.
    const settle = Math.min(1, walker.speed / WALK_SPEED);
    const rise = Math.sin(walker.bob) * BOB_HEIGHT * settle;
    const sway = Math.cos(walker.bob * 0.5) * BOB_SWAY * settle;
    this.camera.position.set(
      walker.x + Math.cos(walker.yaw) * sway,
      walker.floor + EYE + rise,
      -walker.z - Math.sin(walker.yaw) * sway);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(walker.yaw);
    this.camera.rotateX(walker.pitch);
    this.camera.rotateZ(walker.lean);
  }

  step(dt) {
    const walker = this.walker;
    const zooming = this.easeLens(dt);
    if (this.inspecting || this.flight) return this.stepInspect(dt) || zooming;
    // Looking: consume the pending delta over a few frames instead of snapping to it.
    if (walker.pendingYaw || walker.pendingPitch) {
      const take = clamp(dt * LOOK_DAMP, 0, 1);
      walker.yaw += walker.pendingYaw * take;
      walker.pitch = clamp(walker.pitch + walker.pendingPitch * take, -0.95, 0.78);
      walker.pendingYaw *= 1 - take;
      walker.pendingPitch *= 1 - take;
      if (Math.abs(walker.pendingYaw) < 1e-5) walker.pendingYaw = 0;
      if (Math.abs(walker.pendingPitch) < 1e-5) walker.pendingPitch = 0;
    }
    if (walker.turn) walker.yaw -= walker.turn * TURN_RATE * dt;

    const speed = walker.boost ? RUN_SPEED : WALK_SPEED;
    const wish = new THREE.Vector2(walker.strafe, walker.forward);
    if (wish.lengthSq() > 1) wish.normalize();
    // A wheel nudge glides for about a second, for anyone not using the keys.
    if (walker.glide) {
      wish.y = clamp(wish.y + walker.glide, -1, 1);
      walker.glide *= Math.max(0, 1 - dt * 1.9);
      if (Math.abs(walker.glide) < 0.01) walker.glide = 0;
    }
    wish.multiplyScalar(speed);
    // Accelerating feels different from stopping, so the two use different rates.
    const rate = wish.lengthSq() > walker.momentum.lengthSq() ? ACCELERATE : BRAKE;
    walker.momentum.lerp(wish, clamp(dt * rate, 0, 1));
    if (walker.momentum.lengthSq() < 4e-4) walker.momentum.set(0, 0);

    const moving = walker.momentum.lengthSq() > 1e-4;
    if (moving) {
      // The camera's own axes on the plan: rotateY(yaw) turns -Z into (-sin, 0, -cos),
      // so forward is (-sin yaw, cos yaw) and right is (cos yaw, sin yaw).
      const sin = Math.sin(walker.yaw), cos = Math.cos(walker.yaw);
      const stepX = (walker.momentum.x * cos - walker.momentum.y * sin) * dt;
      const stepY = (walker.momentum.x * sin + walker.momentum.y * cos) * dt;
      // Axes are tried separately, so meeting a wall slides along it instead of stopping.
      let went = false;
      // Standing up from a chair can leave the body overlapping the table; any step that
      // does not end inside furniture is then allowed, so the visitor can walk out.
      const stuck = this.map && !this.fits(walker.x, walker.z, walker.floor);
      // Meeting a round table head-on, a turn of 30 or 60 degrees usually clears it, so
      // the walk curves around furniture rather than stopping dead against it.
      const tries = [[stepX, stepY]];
      for (const angle of [0.52, -0.52, 1.05, -1.05]) {
        const c = Math.cos(angle), s = Math.sin(angle);
        tries.push([(stepX * c - stepY * s) * c, (stepX * s + stepY * c) * c]);
      }
      tries.push([stepX, 0], [0, stepY]);
      for (const [dx, dy] of tries) {
        if (!dx && !dy) continue;
        const nx = walker.x + dx, ny = walker.z + dy;
        const floor = this.floorAt(nx, ny);
        if (floor === null) continue;
        const rise = floor - walker.floor;
        if (rise > STEP_UP || rise < -STEP_DOWN) continue;
        if (this.map) {
          if (stuck ? this.mapFloor(nx, ny, floor).blocked && this.special(nx, ny) === null
            : !this.fits(nx, ny, floor)) continue;
        } else if (this.blocked(nx, ny, floor)) continue;
        walker.x = nx;
        walker.z = ny;
        walker.floor += (floor - walker.floor) * clamp(dt * 12, 0, 1);
        went = true;
        break;
      }
      // Walking into something should stop the push, not grind against it.
      if (!went) walker.momentum.multiplyScalar(Math.max(0, 1 - dt * 14));
    }

    walker.speed = walker.momentum.length();
    walker.bob += walker.speed * BOB_RATE * dt;
    const target = clamp(-walker.momentum.x / Math.max(1, speed), -1, 1) * LEAN;
    walker.lean += (target - walker.lean) * clamp(dt * 6, 0, 1);
    this.place();
    return moving || walker.pendingYaw !== 0 || walker.pendingPitch !== 0
      || walker.turn !== 0 || walker.glide !== 0 || zooming;
  }

  // --- zoom and inspection ------------------------------------------------------------
  /** Narrow or widen the lens; positive steps zoom in. */
  zoom(steps) {
    if (this.inspecting) {
      const view = this.inspecting;
      view.distanceTarget = clamp(view.distanceTarget * Math.pow(0.88, steps),
        view.near, view.far);
      return;
    }
    this.fovTarget = clamp(this.fovTarget * Math.pow(0.9, steps), FOV_MIN, this.defaultFov || FOV);
  }

  easeLens(dt) {
    const camera = this.camera;
    if (Math.abs(camera.fov - this.fovTarget) < 0.01) return false;
    camera.fov += (this.fovTarget - camera.fov) * clamp(dt * 10, 0, 1);
    if (Math.abs(camera.fov - this.fovTarget) < 0.01) camera.fov = this.fovTarget;
    camera.updateProjectionMatrix();
    return true;
  }

  /** How far a drag should turn the view: less when zoomed in, so aiming stays steady. */
  get lookScale() { return this.camera.fov / (this.defaultFov || FOV); }

  /**
   * Fly the eye to a point and circle it. `size` is the object's radius when it is known
   * (a dish, a bottle), so it is framed whole; a point on the merged room gets a close view.
   */
  inspect(point, size = 0.18) {
    const camera = this.camera;
    const from = camera.position.clone();
    const offset = from.clone().sub(point);
    const distance = clamp(size * 3.2, INSPECT_NEAR + 0.12, 1.2);
    const flat = Math.hypot(offset.x, offset.z) || 1;
    this.inspecting = {
      target: point.clone(),
      azimuth: Math.atan2(offset.x, offset.z),
      elevation: clamp(Math.atan2(offset.y, flat), -0.2, 1.25),
      distance, distanceTarget: distance,
      near: Math.max(INSPECT_NEAR, size * 1.1), far: Math.max(INSPECT_FAR, size * 6),
      pendingAzimuth: 0, pendingElevation: 0,
    };
    this.fovTarget = this.defaultFov || FOV;
    camera.near = 0.01;
    camera.updateProjectionMatrix();
    this.flight = { t: 0, fromPosition: from, fromQuaternion: camera.quaternion.clone(), back: false };
  }

  /** Leave inspection; the eye flies back to where the visitor stood. */
  endInspect() {
    if (!this.inspecting) return;
    this.flight = { t: 0, fromPosition: this.camera.position.clone(),
      fromQuaternion: this.camera.quaternion.clone(), back: true };
    this.inspecting = null;
  }

  /** Turn around the inspected thing: a drag circles it rather than turning the head. */
  orbit(dx, dy) {
    if (!this.inspecting) return;
    this.inspecting.pendingAzimuth -= dx;
    this.inspecting.pendingElevation += dy;
  }

  orbitPose(view, position, quaternion) {
    const r = view.distance;
    position.set(
      view.target.x + Math.sin(view.azimuth) * Math.cos(view.elevation) * r,
      view.target.y + Math.sin(view.elevation) * r,
      view.target.z + Math.cos(view.azimuth) * Math.cos(view.elevation) * r);
    const look = new THREE.Matrix4().lookAt(position, view.target, new THREE.Vector3(0, 1, 0));
    quaternion.setFromRotationMatrix(look);
  }

  stepInspect(dt) {
    const camera = this.camera;
    const view = this.inspecting;
    let active = false;
    if (view) {
      const take = clamp(dt * LOOK_DAMP, 0, 1);
      view.azimuth += view.pendingAzimuth * take;
      view.elevation = clamp(view.elevation + view.pendingElevation * take, -0.35, 1.45);
      view.pendingAzimuth *= 1 - take;
      view.pendingElevation *= 1 - take;
      if (Math.abs(view.pendingAzimuth) < 1e-5) view.pendingAzimuth = 0;
      if (Math.abs(view.pendingElevation) < 1e-5) view.pendingElevation = 0;
      const before = view.distance;
      view.distance += (view.distanceTarget - view.distance) * clamp(dt * 9, 0, 1);
      active = view.pendingAzimuth !== 0 || view.pendingElevation !== 0
        || Math.abs(before - view.distance) > 1e-4;
    }
    const position = new THREE.Vector3(), quaternion = new THREE.Quaternion();
    if (view) this.orbitPose(view, position, quaternion);
    else {
      // Flying home: the pose the walker would have now.
      this.place();
      position.copy(camera.position);
      quaternion.copy(camera.quaternion);
    }
    const flight = this.flight;
    if (flight) {
      flight.t = Math.min(1, flight.t + dt / FLY_TIME);
      const e = flight.t < 0.5 ? 4 * flight.t ** 3 : 1 - (-2 * flight.t + 2) ** 3 / 2;
      camera.position.lerpVectors(flight.fromPosition, position, e);
      camera.quaternion.slerpQuaternions(flight.fromQuaternion, quaternion, e);
      if (flight.t >= 1) {
        this.flight = null;
        if (flight.back) {
          camera.near = 0.05;
          camera.updateProjectionMatrix();
        }
      }
      return true;
    }
    camera.position.copy(position);
    camera.quaternion.copy(quaternion);
    return active;
  }

  /** Queue a look delta in radians - positive dx turns right, positive dy tilts up;
   *  step() eases it in. */
  look(dx, dy) {
    this.walker.pendingYaw -= dx;
    this.walker.pendingPitch += dy;
  }

  /**
   * Trading state, taken from the place's real opening hours. A restaurant that is closed
   * has its house lights down, so entering outside service hours shows a dark room with
   * only the concealed strips and a lantern or two, rather than a full house.
   */
  setTrading(open) {
    this.trading = open;
    this.setLights(open);
  }

  /**
   * The house lights. They follow the trading state on arrival; the switch by the door
   * then puts them on or off by hand, so a closed room can be lit to look around it.
   */
  setLights(on) {
    this.lightsOn = on;
    this.lightLevel = on ? 1 : 0.12;
    this.fill.intensity = on ? (this.data.fillIntensity ?? 0.30) : 0.07;
    // Emissive fittings keep a glow when the house is dark; they are left on overnight.
    this.root?.traverse(object => {
      if (!object.isMesh) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material.userData.baseEmissive === undefined) {
          material.userData.baseEmissive = material.emissiveIntensity ?? 1;
        }
        material.emissiveIntensity = material.userData.baseEmissive * (on ? 1 : 0.45);
      }
    });
  }

  /** Seat the nearest recorded lights on the pool. */
  placeLights() {
    const here = this.camera.position;
    const near = this.lightSources
      .map(source => ({ source, distance: source.position.distanceTo(here) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, LIGHT_POOL);
    for (const [index, light] of this.lights.entries()) {
      const entry = near[index];
      if (!entry) { light.visible = false; continue; }
      light.visible = true;
      light.position.copy(entry.source.position);
      light.color.copy(entry.source.color);
      light.intensity = entry.source.intensity * (this.lightLevel ?? 1);
      light.distance = entry.source.range;
    }
  }

  resize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.placeLights();
    const exposure=this.renderer.toneMappingExposure;
    this.renderer.toneMappingExposure=this.data.exposure??exposure;
    this.renderer.render(this.scene, this.camera);
    this.renderer.toneMappingExposure=exposure;
  }

  /** What the visitor is pointing at, among the objects given. */
  pick(clientX, clientY, targets) {
    this.raycaster.setFromCamera(
      new THREE.Vector2((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1),
      this.camera);
    return this.raycaster.intersectObjects(targets, true);
  }

  zone() {
    const y = this.walker.z;
    if(this.data.zones)return this.data.zones.find(zone=>y>=zone.y[0]&&y<=zone.y[1]&&(!zone.x||(this.walker.x>=zone.x[0]&&this.walker.x<=zone.x[1])))?.name||'entrance';
    if (y < -8.2) return 'entrance passage';
    if (y < -0.9) return 'lounge and bar';
    if (y < 4.2) return 'bell bridge';
    if (this.walker.floor > 2.5) return 'mezzanine';
    if (y < 19.9) return 'dining hall';
    return 'sushi counter';
  }

  /** Face a point in the room, plan x/y and height. Used by the automated walk-through. */
  aimAt(bx, by, bz) {
    const dx = bx - this.walker.x, dy = by - this.walker.z;
    this.walker.yaw = Math.atan2(-dx, dy);
    this.walker.pitch = Math.atan2(bz - (this.walker.floor + EYE), Math.hypot(dx, dy));
    this.walker.pendingYaw = this.walker.pendingPitch = 0;
    this.place();
  }

  /** Face a point on the plan. Used by the automated walk-through. */
  aim(bx, by) {
    this.walker.yaw = Math.atan2(-(bx - this.walker.x), by - this.walker.z);
    this.place();
  }

  dispose() {
    this.environment?.dispose();
    const geometries = new Set(), materials = new Set(), textures = new Set();
    this.scene.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      for (const material of [object.material].flat().filter(Boolean)){materials.add(material);for(const v of Object.values(material))if(v?.isTexture)textures.add(v);}
    });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
    textures.forEach(texture => texture.dispose());
    this.ready = false;
  }
}
