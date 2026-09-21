import * as THREE from 'three';
import { GLTFLoader } from '../assets/vendor/GLTFLoader.js';

// The two controls of the world as machines rather than panels: the city selector and the
// clock are modelled in Blender (source/folded-city/build_console_v18.py) and drawn here in
// a screen-space pass over the street, with their own light. Everything that reads moves:
// split-flap units spell the city, the clock's lamps spell the hour, keys go down when
// pressed, a slider runs along a lit bar for the day and the lever springs back after a flick.
//
// The page keeps its HTML controls for the keyboard and for screen readers; this layer
// mirrors them, so the machine is what you see and the controls are what you operate.

const PX_PER_METRE = 1000;           // the selector is 0.34 m, drawn 340 px wide at scale 1
const TILT = 0.10;                   // a little of the top face is seen, as on a desk
const FLIP_TIME = 0.26;              // how long a flap takes to turn over

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/**
 * The rotation that brings face k of an n-face drum to the window. The faces are cut from
 * the top of the drum round, and the window looks at the face three quarters of the way
 * round from there, so face k sits in it at (k + 0.5)/n of a turn less three quarters.
 */
const faceAngle = (k, n) => (k / n - 0.75) * Math.PI * 2;

/** A strip of backlit lettering, drawn to a canvas and used as the strip's own light. */
class Strip {
  constructor(mesh, width = 512, height = 40) {
    this.mesh = mesh;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.context = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.encoding = THREE.sRGBEncoding;
    const material = new THREE.MeshStandardMaterial({
      color: 0x0a0d10, roughness: .5,
      emissive: 0xffffff, emissiveMap: this.texture, emissiveIntensity: 1.25,
      map: this.texture,
    });
    mesh.material = material;
    this.text = null;
  }

  write(text, { size = 21, letterSpacing = 2.4, align = 'center' } = {}) {
    if (text === this.text) return;
    this.text = text;
    const { context, canvas } = this;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#05070a';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = '600 ' + size + 'px "Inter v", Helvetica, Arial, sans-serif';
    context.textBaseline = 'middle';
    context.fillStyle = '#cfe4f6';
    const letters = [...(text || '')];
    const width = letters.reduce((sum, c) => sum + context.measureText(c).width + letterSpacing, 0);
    let x = align === 'center' ? (canvas.width - width) / 2 : 14;
    for (const letter of letters) {
      context.fillText(letter, x, canvas.height / 2 + 1);
      x += context.measureText(letter).width + letterSpacing;
    }
    this.texture.needsUpdate = true;
  }
}

/**
 * The clock's screen: a panel of square lamps, lit from an off-screen drawing of the
 * reading. Letters come out with the steps and gaps a real matrix has, because that is
 * exactly what the panel is - one lamp per cell, on or off.
 */
class Matrix {
  constructor(mesh, columns = 140, rows = 19) {
    this.mesh = mesh;
    this.columns = columns;
    this.rows = rows;
    this.cell = 8;                       // pixels per lamp in the texture
    this.canvas = document.createElement('canvas');
    this.canvas.width = columns * this.cell;
    this.canvas.height = rows * this.cell;
    this.context = this.canvas.getContext('2d');
    this.source = document.createElement('canvas');
    this.source.width = columns;
    this.source.height = rows;
    this.sourceContext = this.source.getContext('2d', { willReadFrequently: true });
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.encoding = THREE.sRGBEncoding;
    mesh.material = new THREE.MeshStandardMaterial({
      color: 0x05070a, roughness: .42,
      emissive: 0xffffff, emissiveMap: this.texture, emissiveIntensity: 1.5, map: this.texture,
    });
    this.text = null;
  }

  /** Draw the reading small, then light one lamp per pixel that came out bright. */
  paint(lines) {
    const key = lines.map(line => line.text).join('|');
    if (key === this.text) return;
    this.text = key;
    this.lines = lines;
    const source = this.sourceContext;
    source.setTransform(1, 0, 0, 1, 0, 0);
    source.clearRect(0, 0, this.columns, this.rows);
    source.fillStyle = '#000';
    source.fillRect(0, 0, this.columns, this.rows);
    source.textBaseline = 'top';
    for (const line of lines) {
      const face = size => (line.weight || 700) + ' ' + size
        + 'px "Inter v", Helvetica, Arial, sans-serif';
      // A panel of lamps cannot scroll, so a long reading is set in a smaller face until
      // it fits between its own left edge and the edge of the panel.
      let size = line.size;
      const room = line.align === 'right' ? this.columns - 1 - (line.x ?? 0)
        : this.columns - 1 - (line.x ?? 1);
      let width = 0;
      for (; size > 4; size--) {
        source.font = face(size);
        width = source.measureText(line.text).width;
        if (width <= room) break;
      }
      source.fillStyle = '#fff';
      const x = line.align === 'right' ? this.columns - 1 - width : (line.x ?? 1);
      source.fillText(line.text, Math.round(x), line.y + (line.size - size) * .5);
    }
    const pixels = source.getImageData(0, 0, this.columns, this.rows).data;
    const context = this.context;
    const cell = this.cell;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = '#05070a';
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    for (let row = 0; row < this.rows; row++) {
      for (let column = 0; column < this.columns; column++) {
        const lit = pixels[(row * this.columns + column) * 4] > 110;
        // An unlit lamp is still a lamp: it sits there, very slightly grey.
        context.fillStyle = lit ? this.colourAt(row) : '#11161c';
        context.fillRect(column * cell + 1, row * cell + 1, cell - 2, cell - 2);
      }
    }
    this.texture.needsUpdate = true;
  }

  /** The lettering is the font's; when the font arrives late, the panel is drawn again. */
  repaint() {
    if (!this.lines) return;
    const lines = this.lines;
    this.text = null;
    this.paint(lines);
  }

  colourAt(row) {
    return row < this.rows * .58 ? '#eef4fb' : '#49e07a';
  }
}

/**
 * The touch bar: a long run of square lamps under the slider. The lamps near the slider
 * are lit, and the light falls away along the bar, so the hand can see where the day
 * stands without reading anything.
 */
class Lamps {
  constructor(mesh, columns = 64, rows = 10) {
    this.columns = columns;
    this.rows = rows;
    this.cell = 8;
    this.canvas = document.createElement('canvas');
    this.canvas.width = columns * this.cell;
    this.canvas.height = rows * this.cell;
    this.context = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.encoding = THREE.sRGBEncoding;
    mesh.material = new THREE.MeshStandardMaterial({
      color: 0x05070a, roughness: .42,
      emissive: 0xffffff, emissiveMap: this.texture, emissiveIntensity: 1.35, map: this.texture,
    });
    this.at = null;
    this.paint(0);
  }

  /** `at` is where the slider stands along the bar, 0 to 1. */
  paint(at) {
    if (this.at !== null && Math.abs(at - this.at) < .002) return;
    this.at = at;
    const { context, cell, columns, rows } = this;
    const here = at * (columns - 1);
    context.fillStyle = '#05070a';
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    for (let column = 0; column < columns; column++) {
      // The light gathers at the slider and falls away behind it, the way a lit strip does.
      const away = Math.abs(column - here) / (columns * .42);
      const glow = Math.exp(-away * away * 4.5);
      for (let row = 0; row < rows; row++) {
        const edge = 1 - Math.abs(row - (rows - 1) / 2) / rows * .7;
        const level = .13 + glow * edge * .87;
        const r = Math.round(34 + level * 146);
        const g = Math.round(36 + level * 136);
        const b = Math.round(48 + level * 207);
        context.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
        context.fillRect(column * cell + 1, row * cell + 1, cell - 2, cell - 2);
      }
    }
    this.texture.needsUpdate = true;
  }
}

/** One character of the split-flap: two fixed cards and a leaf that turns over. */
class Flap {
  constructor(parts, columns, rows) {
    this.top = parts.top;
    this.bottom = parts.bottom;
    this.leaf = parts.leaf;
    this.columns = columns;
    this.rows = rows;
    for (const mesh of [this.top, this.bottom, this.leaf]) {
      mesh.material = mesh.material.clone();
      mesh.material.map = mesh.material.map.clone();
      mesh.material.map.needsUpdate = true;
      mesh.material.roughness = .58;
    }
    this.leaf.visible = false;
    this.cell = 0;
    this.turning = 0;
  }

  /** Move a card's UVs to a cell of the atlas; the cards were cut on cell 0. */
  place(mesh, cell) {
    // The cards were cut on cell 0; glTF's v runs down the sheet, so a later row is +v.
    mesh.material.map.offset.set((cell % this.columns) / this.columns,
                                 Math.floor(cell / this.columns) / this.rows);
    mesh.material.map.needsUpdate = true;
  }

  show(cell, animate) {
    if (cell === this.cell) return;
    const previous = this.cell;
    this.cell = cell;
    if (!animate) {
      this.place(this.top, cell);
      this.place(this.bottom, cell);
      return;
    }
    // The leaf carries the old top over, and the new top is already behind it.
    this.place(this.leaf, previous);
    this.place(this.top, cell);
    this.leaf.visible = true;
    this.leaf.rotation.x = 0;
    this.turning = FLIP_TIME;
    this.pending = cell;
  }

  update(dt) {
    if (!this.turning) return false;
    this.turning = Math.max(0, this.turning - dt);
    const t = 1 - this.turning / FLIP_TIME;
    this.leaf.rotation.x = -Math.PI * t;
    if (t >= .5 && this.leafSwapped !== this.pending) {
      this.leafSwapped = this.pending;
      this.place(this.leaf, this.pending);
    }
    if (!this.turning) {
      this.leaf.visible = false;
      this.place(this.bottom, this.cell);
      this.leafSwapped = null;
    }
    return true;
  }
}

export class Console {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(0, 1, 0, -1, 1, 4000);
    this.camera.position.z = 2000;   // in front of the machines, which face +z
    this.raycaster = new THREE.Raycaster();
    this.parts = new Map();
    this.flaps = [];
    this.ready = false;
    this.hovered = null;
    this.pressed = null;
    this.dragging = null;
    this.keyLift = new Map();
    this.tilt = { x: 0, y: 0, tx: 0, ty: 0 };
    this.onCity = null;        // (delta) => void
    this.onWeekday = null;     // (day) => void
    this.onMinutes = null;     // (minutes, live) => void
    this.onNow = null;         // () => void
    this.onPicker = null;      // () => void
  }

  async load(modelURL, layoutURL) {
    const [gltf, layout] = await Promise.all([
      new GLTFLoader().loadAsync(modelURL),
      fetch(layoutURL).then(r => r.json()),
    ]);
    this.layout = layout;
    this.root = gltf.scene;
    this.root.traverse(object => {
      if (!object.isMesh) return;
      object.frustumCulled = false;
      this.parts.set(object.name, object);
      const material = object.material;
      if (material.map) material.map.anisotropy = 4;
      material.envMapIntensity = 1.1;
    });
    // Two machines, positioned on the screen independently.
    this.selector = new THREE.Group();
    this.clock = new THREE.Group();
    for (const [name, mesh] of this.parts) {
      (name.startsWith('sel-') ? this.selector : this.clock).add(mesh);
    }
    // The clock was modelled below the selector; bring it back to its own origin.
    const box = new THREE.Box3().setFromObject(this.clock);
    this.clockOffset = box.getCenter(new THREE.Vector3());
    for (const child of this.clock.children) child.position.y -= this.clockOffset.y;
    this.selectorScale = new THREE.Group();
    this.clockScale = new THREE.Group();
    this.selectorScale.add(this.selector);
    this.clockScale.add(this.clock);
    this.scene.add(this.selectorScale, this.clockScale);

    for (let i = 0; i < 9; i++) {
      const parts = {
        top: this.parts.get('sel-flap-top-' + i),
        bottom: this.parts.get('sel-flap-bottom-' + i),
        leaf: this.parts.get('sel-flap-leaf-' + i),
      };
      if (parts.top && parts.bottom && parts.leaf) {
        this.flaps.push(new Flap(parts, 6, 5));
      }
    }
    this.strips = { district: new Strip(this.parts.get('sel-strip-district'), 640, 36) };
    this.matrix = new Matrix(this.parts.get('clk-screen'));
    this.drums = { index: this.parts.get('sel-drum-index') };
    this.rocker = this.parts.get('sel-rocker');
    // The bar is read in the machine's own coordinates, so a pointer is turned into a time
    // by where it falls between the bar's two ends.
    const bar = this.parts.get('clk-bar');
    bar.geometry.computeBoundingBox();
    this.bar = { lamps: new Lamps(bar), left: bar.geometry.boundingBox.min.x,
                 right: bar.geometry.boundingBox.max.x };
    this.thumb = this.parts.get('clk-bar-thumb');
    this.thumb.geometry.computeBoundingBox();
    this.thumbHome = this.thumb.geometry.boundingBox.getCenter(new THREE.Vector3()).x;
    // The lever's shape is cut at the machine's own coordinates, so it would swing about
    // the machine's centre. Its pivot is moved to its lower end, where the hinge is.
    this.lever = this.parts.get('clk-lever');
    if (this.lever) {
      this.lever.geometry.computeBoundingBox();
      const bounds = this.lever.geometry.boundingBox;
      const pivot = new THREE.Vector3(
        (bounds.min.x + bounds.max.x) / 2, bounds.min.y,
        (bounds.min.z + bounds.max.z) / 2);
      this.lever.geometry.translate(-pivot.x, -pivot.y, -pivot.z);
      this.lever.position.add(pivot);
    }
    // A key goes down from where it was built, and its lettering and lamp go with it. The
    // lettering is a separate mesh with its own place on the face, so each part is moved
    // from its own rest height rather than toward a shared one.
    this.dayKeys = [0, 1, 2, 3, 4, 5, 6].map(i => {
      const entry = {
        key: this.parts.get('clk-day-' + i),
        legend: this.parts.get('clk-day-legend-' + i),
        lamp: this.parts.get('clk-day-lamp-' + i),
      };
      entry.home = ['key', 'legend', 'lamp'].map(part => entry[part]?.position.y ?? 0);
      // The seven lamps are one material in the model; each needs its own to light alone.
      if (entry.lamp) entry.lamp.material = entry.lamp.material.clone();
      return entry;
    });
    this.led = this.parts.get('sel-led');
    document.fonts?.ready.then(() => { this.matrix.repaint(); this.strips.district.text = null; });
    this.buildLight();
    this.ready = true;
    return { parts: this.parts.size, flaps: this.flaps.length };
  }

  /** The machines carry their own light, so they read the same at any hour of the street. */
  buildLight() {
    const key = new THREE.DirectionalLight(0xf2f7ff, 1.45);
    key.position.set(-.6, .9, 1.4);
    const fill = new THREE.DirectionalLight(0x9fb8d6, .55);
    fill.position.set(1.1, -.3, .8);
    const rim = new THREE.DirectionalLight(0xbcd6f5, .8);
    rim.position.set(.2, 1.2, -.9);
    this.scene.add(key, fill, rim, new THREE.AmbientLight(0x2c3542, 1.0));
    const size = 16;
    const pixels = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      const t = y / (size - 1);
      const v = 26 + 150 * Math.pow(1 - t, 1.4);
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        pixels[i] = v * .92; pixels[i + 1] = v * .96; pixels[i + 2] = v; pixels[i + 3] = 255;
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

  /** Lay the two machines out on the screen, in CSS pixels. */
  resize(width, height) {
    this.width = width;
    this.height = height;
    if (!this.ready) return;          // laid out again the moment the machines arrive
    this.camera.left = 0;
    this.camera.right = width;
    this.camera.top = 0;
    this.camera.bottom = -height;
    this.camera.updateProjectionMatrix();
    const narrow = width < 760;
    const selectorWidth = narrow ? Math.min(300, width - 32) : 330;
    const clockWidth = narrow ? Math.min(width - 24, 560) : Math.min(560, width - 80);
    this.selectorScale.scale.setScalar(selectorWidth / 0.34);
    this.clockScale.scale.setScalar(clockWidth / 0.58);
    this.selectorScale.position.set(24 + selectorWidth / 2, -(narrow ? 66 : 26) - selectorWidth * .086 / .34 / 2, 0);
    this.clockScale.position.set(width / 2, -height + 26 + clockWidth * .1 / .58 / 2, 0);
    for (const group of [this.selector, this.clock]) group.rotation.x = TILT;
  }

  // --- what the machines show ----------------------------------------------------------
  setCity(index, name, district) {
    if (!this.ready) return;
    const glyphs = this.layout.glyphs.name;
    const text = (name || '').toUpperCase().slice(0, 9);
    const padded = text.padEnd(9, ' ');
    this.flaps.forEach((flap, i) => {
      const cell = Math.max(0, glyphs.indexOf(padded[i]));
      flap.show(cell, this.shown);
    });
    this.indexTarget = index;
    this.strips.district.write((district || '').toUpperCase(), { size: 19, letterSpacing: 3 });
    this.shown = true;
  }

  setClock(minutes, zone, status, moonPhase, moonUp, live) {
    if (!this.ready) return;
    const total = Math.round(minutes);
    const reading = String(Math.floor(total / 60)).padStart(2, '0') + ':'
      + String(total % 60).padStart(2, '0');
    // A panel of lamps has room for a reading, not for a sentence: the page's own wording
    // is cut down to what the panel can hold at a size that can still be read across a room.
    const short = (status || '').toUpperCase()
      .replace(/^(\w{3})\w+/, '$1')
      .replace(/(\d+)% LIT/, '$1%')
      .replace(/(\d+) OF (\d+) RECORDED PLACES OPEN/, '$1\/$2 OPEN');
    this.matrix.paint([
      { text: reading, size: 13, y: -1, x: 2, weight: 800 },
      { text: (zone || '').toUpperCase(), size: 7, y: 3, x: 48, align: 'right', weight: 600 },
      { text: short, size: 7, y: 12, x: 2, weight: 600 },
    ]);
    // The slider stands where the clock stands along the day, and the bar lights with it.
    const at = clamp(minutes / 1440, 0, 1);
    this.barAt = at;
    this.bar.lamps.paint(at);
    this.thumbTarget = this.bar.left + (this.bar.right - this.bar.left) * at;
    for (const [day, entry] of this.dayKeys.entries()) {
      entry.lamp.material.emissiveIntensity = day === this.weekday ? 4.5 : .04;
    }
    this.lastMinutes = minutes;
    this.liveNow = live;
    if (this.lever) this.leverTarget = live ? 0 : .5;
    if (this.led) this.led.material.emissiveIntensity = live ? 5 : 1.2;
    void moonPhase; void moonUp;
  }

  setWeekday(day) {
    this.weekday = day;
    if (!this.ready) return;
    for (const [index, entry] of this.dayKeys.entries()) {
      entry.lamp.material.emissiveIntensity = index === day ? 4.5 : .04;
    }
  }

  // --- pointing at them ------------------------------------------------------------------
  pick(x, y) {
    if (!this.ready) return null;
    this.raycaster.setFromCamera(
      new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1), this.camera);
    const hit = this.raycaster.intersectObject(this.scene, true)[0];
    if (!hit) return null;
    const name = hit.object.name;
    if (name.startsWith('sel-rocker')) {
      // Which half of the paddle was pressed, in the paddle's own space.
      const local = hit.object.worldToLocal(hit.point.clone());
      return { kind: local.y >= 0 ? 'city-previous' : 'city-next', object: hit.object, hit };
    }
    if (name.startsWith('sel-flap') || name.startsWith('sel-drum') || name.startsWith('sel-strip')
        || name.startsWith('sel-bezel') || name === 'sel-glass') return { kind: 'picker', hit };
    const day = /^clk-day(?:-legend|-lamp)?-(\d)$/.exec(name);
    if (day) return { kind: 'weekday', day: Number(day[1]), hit };
    if (name.startsWith('clk-lever')) return { kind: 'now', hit };
    if (name.startsWith('clk-bar')) return { kind: 'bar', hit };
    return { kind: 'body', hit };
  }

  hover(x, y) {
    const found = this.pick(x, y);
    this.hovered = found?.kind || null;
    // The machine leans a little toward the hand, which is most of what makes it feel real.
    if (found) {
      const nx = (x / this.width) * 2 - 1, ny = (y / this.height) * 2 - 1;
      this.tilt.tx = clamp(-ny * .06, -.06, .06);
      this.tilt.ty = clamp(nx * .05, -.05, .05);
    } else {
      this.tilt.tx = 0;
      this.tilt.ty = 0;
    }
    return this.hovered;
  }

  press(x, y) {
    const found = this.pick(x, y);
    if (!found) return null;
    this.pressed = found;
    switch (found.kind) {
      case 'city-previous': this.rockerTarget = .20; this.onCity?.(-1); break;
      case 'city-next': this.rockerTarget = -.20; this.onCity?.(1); break;
      case 'weekday': this.keyLift.set(found.day, .0045); this.onWeekday?.(found.day); break;
      case 'now': this.leverKick = .6; this.onNow?.(); break;
      case 'bar': this.dragging = true; this.dragTo(x); break;
      case 'picker': this.onPicker?.(); break;
      default: break;
    }
    return found.kind;
  }

  /** Running the bar: where the hand is along it is the time, from midnight to midnight. */
  dragTo(x) {
    const local = this.clock.worldToLocal(new THREE.Vector3(x, 0, 0));
    const t = clamp((local.x - this.bar.left) / (this.bar.right - this.bar.left), 0, 1);
    this.onMinutes?.(t * 1440);
  }

  move(x, y) {
    if (this.dragging) { this.dragTo(x); return 'bar'; }
    return this.hover(x, y);
  }

  release() {
    this.dragging = null;
    this.pressed = null;
    this.rockerTarget = 0;
  }

  /** Turn a drum toward an angle the short way round, so 9 to 0 rolls on. */
  turn(current, target, dt, rate) {
    let delta = target - current;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    return current + delta * clamp(dt * rate, 0, 1);
  }

  // --- each frame ---------------------------------------------------------------------
  update(dt) {
    if (!this.ready) return false;
    let moving = false;
    for (const flap of this.flaps) moving = flap.update(dt) || moving;

    const ease = (value, target, rate) => value + (target - value) * clamp(dt * rate, 0, 1);

    if (this.drums.index && this.indexTarget !== undefined) {
      const drum = this.drums.index;
      const before = drum.rotation.x;
      drum.rotation.x = this.turn(drum.rotation.x, faceAngle(this.indexTarget % 3, 12), dt, 7);
      moving = moving || Math.abs(before - drum.rotation.x) > 1e-4;
    }
    if (this.thumb && this.thumbTarget !== undefined) {
      const before = this.thumb.position.x;
      this.thumb.position.x = ease(this.thumb.position.x, this.thumbTarget - this.thumbHome, 14);
      moving = moving || Math.abs(before - this.thumb.position.x) > 1e-5;
    }
    if (this.lever) {
      const want = (this.leverTarget || 0) + (this.leverKick || 0);
      const before = this.lever.rotation.x;
      this.lever.rotation.x = ease(this.lever.rotation.x, want, 13);
      if (this.leverKick) this.leverKick = Math.max(0, this.leverKick - dt * 3.4);
      moving = moving || Math.abs(before - this.lever.rotation.x) > 1e-4 || this.leverKick > 0;
    }
    if (this.rocker) {
      const before = this.rocker.rotation.x;
      this.rocker.rotation.x = ease(this.rocker.rotation.x, this.rockerTarget || 0, 16);
      moving = moving || Math.abs(before - this.rocker.rotation.x) > 1e-4;
    }
    for (const [index, entry] of this.dayKeys.entries()) {
      const depth = this.keyLift.get(index) || 0;
      const before = entry.key.position.y;
      ['key', 'legend', 'lamp'].forEach((part, k) => {
        const mesh = entry[part];
        if (mesh) mesh.position.y = ease(mesh.position.y, entry.home[k] - depth, 14);
      });
      if (depth && Math.abs(entry.key.position.y - entry.home[0] + depth) < .0004) {
        this.keyLift.set(index, 0);
      }
      moving = moving || Math.abs(before - entry.key.position.y) > 1e-5;
    }

    // the lean toward the hand
    this.tilt.x = ease(this.tilt.x, this.tilt.tx, 6);
    this.tilt.y = ease(this.tilt.y, this.tilt.ty, 6);
    for (const group of [this.selector, this.clock]) {
      group.rotation.x = TILT + this.tilt.x;
      group.rotation.y = this.tilt.y;
    }
    moving = moving || Math.abs(this.tilt.x - this.tilt.tx) > 1e-4 || Math.abs(this.tilt.y - this.tilt.ty) > 1e-4;
    return moving;
  }

  render() {
    if (!this.ready) return;
    // Drawn over the street: keep what is already in the colour buffer, and give the
    // machines their own depth so they always sit in front.
    const cleared = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.camera);
    this.renderer.autoClear = cleared;
  }

  setVisible(selector, clock) {
    if (!this.ready) return;
    this.selectorScale.visible = selector;
    this.clockScale.visible = clock;
  }
}
