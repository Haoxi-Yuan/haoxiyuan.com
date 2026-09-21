import * as THREE from 'three';

// Things a visitor can do inside KOMA: take a menu off a table and read it, order from it
// and see the dish arrive with what reviewers said about it, lift a bottle off the back
// bar and throw it, ring the bell, and sit down. Everything named on the menu is printed
// on the page being read; everything said about a dish is a saved review.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const GRAVITY = -9.2;
const REACH = 3.2;              // metres: how far away a menu, bottle or seat can be taken
const DISH_SLOTS = 3;           // dishes a table holds before the oldest is cleared
const HIGHLIGHT = new THREE.Color(0x4a3418);
const SEAT_EYE = { 'seat-bar': 1.46, 'seat-sushi': 1.40, default: 1.18 };
const TABLE_KINDS = ['dining-table', 'round-table', 'sushi-counter', 'cocktail-table', 'bar-counter'];

/** Blender plan coordinates (x, y, z up) to this scene's y-up axes. */
const toScene = (bx, by, bz) => new THREE.Vector3(bx, bz, -by);

export class KomaInteractions {
  constructor(interior, options) {
    this.interior = interior;
    this.scene = interior.scene;
    this.camera = interior.camera;
    this.options = options;
    this.ready = false;
    this.hovered = null;
    this.menus = [];
    this.bottles = [];
    this.pickables = [];
    this.seats = [];
    this.tables = [];
    this.dishes = new Map();
    this.served = [];
    this.flying = [];
    this.shards = [];
    this.reading = null;
    this.holding = null;
    this.seated = null;
    this.bell = { object: null, angle: 0, velocity: 0, axis: new THREE.Vector3(1, 0, 0) };
    this.sounds = {};
    this.listener = null;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = 40;
    this.textureLoader = new THREE.TextureLoader();
    this.readingDistance = 0.37;
    // The camera carries what the visitor holds, so it has to be in the scene graph.
    if (this.camera.parent !== this.scene) this.scene.add(this.camera);
  }

  async load(loader) {
    const [props, menu] = await Promise.all([
      loader.loadAsync(this.options.propsURL),
      fetch(this.options.menuURL).then(response => {
        if (!response.ok) throw new Error('The KOMA menu could not be loaded.');
        return response.json();
      }),
    ]);
    this.menuData = menu;
    for (const dish of menu.dishes) this.dishes.set(dish.name, dish);
    this.forms = new Map();
    this.shardTemplates = [];
    for (const node of props.scene.children) {
      const name = node.name.replace(/_/g, '-');
      if (name.startsWith('form-')) this.forms.set(name.slice(5), node);
      else if (name.startsWith('shard-')) this.shardTemplates.push(node);
      else if (name === 'prop-menu-closed') this.closedMenu = node;
    }
    this.placeMenus();
    this.buildSeats();
    this.adoptProps();
    this.buildWater();
    this.buildSwitch();
    this.ready = true;
    return { menus: this.menus.length, seats: this.seats.length, dishes: this.dishes.size,
      forms: this.forms.size, bottles: this.bottles.length };
  }

  // --- the room's own objects --------------------------------------------------------
  placeMenus() {
    const anchors = this.interior.data.anchors || [];
    this.tables = anchors.filter(anchor => TABLE_KINDS.includes(anchor.kind)).map(anchor => ({
      ...anchor,
      position: toScene(anchor.centre[0], anchor.centre[1], anchor.top),
      served: [],
    }));
    for (const table of this.tables) {
      // Long counters get a menu at each end; a table gets one.
      const long = Math.max(table.size[0], table.size[1]) > 3;
      const offsets = long ? [-0.32, 0.32] : [0];
      for (const offset of offsets) {
        const menu = this.closedMenu.clone(true);
        menu.traverse(object => { if (object.isMesh) object.material = object.material.clone(); });
        const along = table.size[0] >= table.size[1];
        const shift = long ? offset * Math.max(table.size[0], table.size[1]) : 0;
        menu.position.copy(table.position).add(new THREE.Vector3(
          along ? shift : 0.18, 0.002, along ? -0.14 : -shift));
        menu.rotation.y = (table.index * 0.37 + offset) % 0.5 - 0.25;
        menu.userData = { kind: 'menu', table, home: menu.position.clone(),
          homeRotation: menu.rotation.clone() };
        this.scene.add(menu);
        this.menus.push(menu);
        this.pickables.push(menu);
      }
    }
  }

  buildSeats() {
    const interest = this.interior.data.interest || {};
    const proxy = new THREE.BoxGeometry(1, 1, 1);
    const invisible = new THREE.MeshBasicMaterial({ visible: false });
    for (const [kind, items] of Object.entries(interest)) {
      if (!kind.startsWith('seat-')) continue;
      for (const item of items) {
        const [x, y] = item.centre;
        const [z0, z1] = item.z;
        const box = new THREE.Mesh(proxy, invisible);
        box.position.copy(toScene(x, y, (z0 + z1) / 2));
        box.scale.set(Math.max(0.35, item.size[0]), Math.max(0.4, z1 - z0), Math.max(0.35, item.size[1]));
        box.userData = { kind: 'seat', seat: kind, plan: [x, y], floor: z0 };
        this.scene.add(box);
        this.seats.push(box);
        this.pickables.push(box);
      }
    }
  }

  adoptProps() {
    this.bottles = [];
    // Pointing is tested against a simple stand-in for each prop, carried as a child so it
    // moves and swings with it. The bell alone is some 200,000 triangles; testing that on
    // every frame the visitor looks at it would stall the room.
    const invisible = new THREE.MeshBasicMaterial({ visible: false });
    const proxyFor = (node, radiusScale = 1) => {
      node.updateWorldMatrix(true, true);
      const box = new THREE.Box3().setFromObject(node);
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      const radius = Math.max(size.x, size.z) / 2 * radiusScale;
      const proxy = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, size.y, 12), invisible);
      node.worldToLocal(proxy.position.copy(centre));
      node.add(proxy);
      return proxy;
    };
    for (const [key, node] of this.interior.props) {
      if (key === 'bell') {
        this.bell.object = node;
        node.userData.kind = 'bell';
        this.pickables.push(proxyFor(node, 0.9));
      } else if (key.startsWith('bottle')) {
        node.userData.kind = 'bottle';
        node.userData.state = 'shelf';
        this.bottles.push(node);
        // A little fatter than the glass, so a slender bottle is easy to take.
        this.pickables.push(proxyFor(node, 1.6));
      }
    }
  }

  /** The reflecting pool takes a touch: an invisible sheet over the water catches it. */
  buildWater() {
    const water = (this.interior.data.interest || {}).water?.[0];
    this.ripples = [];
    if (!water) return;
    const [x, y] = water.centre;
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(water.size[0], water.size[1]),
      new THREE.MeshBasicMaterial({ visible: false }));
    sheet.rotation.x = -Math.PI / 2;
    sheet.position.copy(toScene(x, y, water.z[1] + 0.002));
    sheet.userData = { kind: 'water', level: water.z[1] + 0.004 };
    this.scene.add(sheet);
    this.pickables.push(sheet);
    this.waterSheet = sheet;
    this.rippleGeometry = new THREE.RingGeometry(0.92, 1.0, 48);
  }

  /**
   * The light switch: a brass plate on the passage wall a step from the street door. Its
   * position is found by casting against the room itself, so it sits on the real wall.
   */
  buildSwitch() {
    // The visitor arrives 1.4 m inside the passage (Interior.spawn); the switch is a step on.
    const passage = this.interior.data.floors?.passage || { x: [-6.275, -3.725], y: [-28, -8], top: 0.56 };
    // The passage is lined with torii pillars; of several rays across it, the one that
    // reaches furthest has found the wall between two pillars, which is where it goes.
    let hit = null, origin = null;
    for (let step = 0; step <= 40; step++) {
      const from = toScene((passage.x[0] + passage.x[1]) / 2, passage.y[0] + 1.6 + step * 0.1, passage.top + 1.25);
      this.raycaster.set(from, new THREE.Vector3(-1, 0, 0));
      const found = this.raycaster.intersectObject(this.interior.root, true)
        .find(h => h.object.visible && h.object.material?.visible !== false && h.face);
      if (!found) continue;
      // It must also be in plain sight from where the visitor arrives, not behind a pillar.
      const eye = toScene((passage.x[0] + passage.x[1]) / 2, passage.y[0] + 1.4, passage.top + 1.62);
      const toward = found.point.clone().sub(eye);
      const reach = toward.length();
      this.raycaster.set(eye, toward.normalize());
      const blocker = this.raycaster.intersectObject(this.interior.root, true)
        .find(h => h.object.visible && h.object.material?.visible !== false);
      if (blocker && blocker.distance < reach - 0.05) continue;
      if (!hit || found.distance > hit.distance + 0.02) { hit = found; origin = from; }
    }
    origin = origin || toScene((passage.x[0] + passage.x[1]) / 2, passage.y[0] + 2.7, passage.top + 1.25);
    const at = hit ? hit.point.clone() : origin.clone().add(new THREE.Vector3(-1.2, 0, 0));
    const normal = hit ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(1, 0, 0);
    normal.y = 0; normal.normalize();
    const plate = new THREE.Group();
    const brass = new THREE.MeshStandardMaterial({ color: 0x9c7a3a, roughness: 0.35, metalness: 0.85 });
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.18, 0.014), brass);
    const rocker = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.07, 0.02),
      new THREE.MeshStandardMaterial({ color: 0x1a1512, roughness: 0.5 }));
    rocker.position.z = 0.012;
    // A small amber pilot light, so the switch can be found in a dark room.
    this.pilot = new THREE.Mesh(new THREE.CircleGeometry(0.009, 16),
      new THREE.MeshBasicMaterial({ color: 0xffa640, toneMapped: false }));
    this.pilot.position.set(0, -0.062, 0.0075);
    plate.add(back, rocker, this.pilot);
    plate.position.copy(at).addScaledVector(normal, 0.008);
    plate.lookAt(at.clone().add(normal));
    this.switchRocker = rocker;
    // An easier target than the plate itself.
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.26, 0.06), new THREE.MeshBasicMaterial({ visible: false }));
    plate.add(proxy);
    plate.userData = { kind: 'switch' };
    this.scene.add(plate);
    this.switchPlate = plate;
    this.pickables.push(proxy);
    this.showSwitch();
  }

  showSwitch() {
    if (!this.switchPlate) return;
    const on = this.interior.lightsOn;
    this.switchRocker.rotation.x = on ? -0.35 : 0.35;
    this.pilot.material.color.set(on ? 0x3a2a14 : 0xffa640);
  }

  flipSwitch() {
    this.interior.setLights(!this.interior.lightsOn);
    this.showSwitch();
    this.play('clink', { volume: 0.35, rate: 1.9 });
    this.options.onLights?.(this.interior.lightsOn);
  }

  ripple(point) {
    // Three rings from one touch, each a little later and slower than the one before.
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(this.rippleGeometry, new THREE.MeshBasicMaterial({
        color: 0xf4e2c0, transparent: true, opacity: 0, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(point.x, this.waterSheet.userData.level + 0.001 * i, point.z);
      ring.scale.setScalar(0.02);
      this.scene.add(ring);
      this.ripples.push({ ring, age: -i * 0.22, life: 2.2 + i * 0.4, reach: 0.9 + i * 0.35 });
    }
    this.play('water', { at: point, volume: 0.8, rate: 0.9 + Math.random() * 0.25, reach: 4 });
  }

  // --- sound -----------------------------------------------------------------------
  /** Audio has to start inside a gesture, so the listener is created on the first one. */
  wake() {
    if (!this.listener) {
      this.listener = new THREE.AudioListener();
      this.camera.add(this.listener);
    }
    if (this.listener.context.state === 'suspended') this.listener.context.resume();
  }

  async buffer(name) {
    if (this.sounds[name]) return this.sounds[name];
    const loader = new THREE.AudioLoader();
    this.sounds[name] = loader.loadAsync(`${this.options.soundsBase}${name}.m4a`);
    return this.sounds[name];
  }

  async play(name, { at = null, volume = 1, rate = 1, reach = 6 } = {}) {
    if (!this.listener) return;
    try {
      const buffer = await this.buffer(name);
      const sound = at ? new THREE.PositionalAudio(this.listener) : new THREE.Audio(this.listener);
      sound.setBuffer(buffer);
      sound.setVolume(volume);
      sound.setPlaybackRate(rate);
      if (at) {
        sound.setRefDistance(reach);
        sound.setRolloffFactor(1.1);
        const anchor = new THREE.Object3D();
        anchor.position.copy(at);
        this.scene.add(anchor);
        anchor.add(sound);
        sound.onEnded = () => { sound.disconnect(); anchor.removeFromParent(); };
      } else {
        sound.onEnded = () => sound.disconnect();
      }
      sound.play();
    } catch (error) {
      console.warn('KOMA sound', name, error);
    }
  }

  // --- pointing ----------------------------------------------------------------------
  ray(screenX, screenY) {
    this.raycaster.setFromCamera(new THREE.Vector2(
      (screenX / innerWidth) * 2 - 1, -(screenY / innerHeight) * 2 + 1), this.camera);
    return this.raycaster;
  }

  /** What is under the pointer, allowing for reach: a seat across the room is not offered. */
  target(screenX, screenY) {
    const ray = this.ray(screenX, screenY);
    if (this.reading) {
      // The raycaster does not skip hidden meshes, and on a single page the unused face
      // sits behind the one being read.
      const hit = ray.intersectObjects(this.reading.pages.filter(face => face.visible), false)[0];
      return hit ? { kind: 'line', hit } : null;
    }
    const candidates = [...this.pickables, ...this.served.map(s => s.group)];
    // Props are listed by their stand-ins, which have no children, so this stays cheap.
    const hit = ray.intersectObjects(candidates, true)[0];
    if (!hit) return null;
    let object = hit.object;
    // A held bottle is never the thing being pointed at.
    if (this.holding && (object === this.holding || object.parent === this.holding)) return null;
    while (object && !object.userData.kind) object = object.parent;
    if (!object) return null;
    const kind = object.userData.kind;
    const near = hit.distance <= REACH || kind === 'bell' || kind === 'dish' || kind === 'water';
    return near ? { kind, object, hit } : null;
  }

  hover(screenX, screenY) {
    if (!this.ready) return null;
    const found = this.target(screenX, screenY);
    if (this.reading) {
      this.highlightLine(found?.hit || null);
      return found ? 'line' : null;
    }
    const object = found?.object || null;
    if (object !== this.hovered) {
      if (this.hovered) this.tint(this.hovered, false);
      this.hovered = object;
      if (object && object.userData.kind !== 'seat') this.tint(object, true);
    }
    return found?.kind || null;
  }

  tint(object, on) {
    object.traverse(child => {
      if (!child.isMesh || !child.material || child.material.visible === false) return;
      if (!child.userData.ownMaterial) {
        child.material = child.material.clone();
        child.userData.ownMaterial = true;
        child.userData.baseEmissive = child.material.emissive ? child.material.emissive.clone() : null;
      }
      if (!child.material.emissive) return;
      if (on) child.material.emissive.copy(child.userData.baseEmissive || new THREE.Color(0)).add(HIGHLIGHT);
      else if (child.userData.baseEmissive) child.material.emissive.copy(child.userData.baseEmissive);
    });
  }

  /** A click or tap. Returns what happened, for the page to respond to. */
  click(screenX, screenY) {
    if (!this.ready) return null;
    this.wake();
    if (this.holding) { this.throwBottle(); return 'threw'; }
    const found = this.target(screenX, screenY);
    if (this.reading) {
      if (found) {
        const dish = this.lineAt(found.hit);
        if (dish) { this.serve(dish); return 'ordered'; }
      }
      return null;
    }
    if (!found) return null;
    switch (found.kind) {
      case 'menu': this.openMenu(found.object); return 'menu';
      case 'bottle': this.pickBottle(found.object); return 'bottle';
      case 'bell': this.ring(found.hit.point); return 'bell';
      case 'seat': this.sit(found.object); return 'seat';
      case 'water': this.ripple(found.hit.point); return 'water';
      case 'switch': this.flipSwitch(); return 'switch';
      case 'dish': this.options.onDish?.(found.object.userData.dish); return 'dish';
      default: return null;
    }
  }

  // --- the menu -----------------------------------------------------------------------
  openMenu(menu) {
    const pages = this.menuData.pages;
    const book = new THREE.Group();
    const cover = new THREE.Mesh(new THREE.BoxGeometry(0.50, 0.335, 0.010),
      new THREE.MeshStandardMaterial({ color: 0x0e0c10, roughness: 0.55 }));
    cover.position.z = -0.008;
    const spine = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.335, 0.012),
      new THREE.MeshStandardMaterial({ color: 0x9c7a34, roughness: 0.35, metalness: 0.7 }));
    spine.position.z = -0.003;
    book.add(cover, spine);
    book.userData.cover = cover;
    book.userData.spine = spine;
    const faces = [];
    for (const side of [-1, 1]) {
      const card = new THREE.Mesh(new THREE.PlaneGeometry(0.236, 0.318),
        new THREE.MeshStandardMaterial({ color: 0xece8df, roughness: 0.8 }));
      card.position.set(side * 0.123, 0, -0.002);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
      face.position.set(side * 0.123, 0, 0);
      const highlight = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ color: 0xf6c56a, transparent: true, opacity: 0.22,
          depthWrite: false }));
      highlight.visible = false;
      highlight.position.z = 0.001;
      face.add(highlight);
      face.userData.highlight = highlight;
      book.add(card, face);
      face.userData.card = card;
      face.userData.side = side;
      faces.push(face);
    }
    // Held up close in front of the reader, a little below the eye, as a menu is read.
    book.position.set(0, -0.035, -this.readingDistance);
    book.rotation.x = -0.06;
    book.scale.setScalar(0.001);
    this.camera.add(book);
    menu.visible = false;
    this.reading = { menu, book, pages: faces, spread: 0, opened: 0 };
    this.layoutBook();
    this.showSpread(0);
    this.play('page-turn', { volume: 0.55 });
    this.options.onReading?.(true, this.spreadTitle());
  }

  /** A portrait phone sees one page at a time; a wider screen holds the open spread. */
  single() {
    return innerWidth / innerHeight < 0.85;
  }

  perSpread() {
    return this.single() ? 1 : 2;
  }

  layoutBook() {
    if (!this.reading) return;
    const { book, pages } = this.reading;
    const single = this.single();
    book.userData.cover.scale.x = single ? 0.52 : 1;
    book.userData.spine.visible = !single;
    for (const face of pages) {
      const alone = single && face.userData.side > 0;
      face.visible = single ? alone : true;
      face.userData.card.visible = face.visible;
      const x = single ? 0 : face.userData.side * 0.123;
      face.position.x = x;
      face.userData.card.position.x = x;
    }
    // Stand far enough back that the page fits the screen's width with a margin.
    const camera = this.camera;
    const halfWidth = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect;
    const needed = (single ? 0.26 : 0.52) / (2 * halfWidth);
    this.readingDistance = clamp(Math.max(this.readingDistance, needed), 0.22, 0.9);
    book.position.z = -this.readingDistance;
  }

  spreadTitle() {
    const pages = this.menuData.pages;
    const per = this.perSpread();
    const index = this.reading.spread * per;
    return pages.slice(index, index + per).map(p => p.title).join('  ·  ');
  }

  showSpread(spread) {
    const pages = this.menuData.pages;
    const per = this.perSpread();
    const count = Math.ceil(pages.length / per);
    this.reading.spread = (spread + count) % count;
    this.reading.pages.forEach((face, side) => {
      // On a single page the right-hand face carries it.
      const offset = per === 1 ? (side === 1 ? 0 : -1) : side;
      const page = offset < 0 ? null : pages[this.reading.spread * per + offset];
      face.visible = !!page;
      face.userData.card.visible = !!page;
      face.userData.page = page || null;
      if (!page) return;
      // Fit the photograph inside the card without stretching it.
      const aspect = page.size[0] / page.size[1];
      const height = 0.300, width = Math.min(0.226, height * aspect);
      face.scale.set(width, width / aspect, 1);
      face.userData.highlight.visible = false;
      const texture = this.textureLoader.load(this.options.pagesBase + page.file);
      texture.encoding = THREE.sRGBEncoding;
      texture.anisotropy = 8;
      face.material.map?.dispose();
      face.material.map = texture;
      face.material.needsUpdate = true;
    });
  }

  /** Bring the menu nearer or hold it further off; the wheel does this while reading. */
  zoomMenu(delta) {
    if (!this.reading) return;
    this.readingDistance = clamp(this.readingDistance + delta, 0.22, 0.9);
    this.reading.book.position.z = -this.readingDistance;
  }

  turnPage(delta) {
    if (!this.reading) return;
    this.showSpread(this.reading.spread + delta);
    this.play('page-turn', { volume: 0.5, rate: 0.94 + Math.random() * 0.12 });
    this.options.onReading?.(true, this.spreadTitle());
  }

  /** The dish printed at a point on the page, from the page's own hit boxes. */
  lineAt(hit) {
    const page = hit?.object?.userData?.page;
    if (!page || !hit.uv) return null;
    const u = hit.uv.x, v = 1 - hit.uv.y;
    const line = page.lines.find(l => u >= l.box[0] && u <= l.box[2] && v >= l.box[1] && v <= l.box[3]);
    return line ? this.dishes.get(line.dish) || null : null;
  }

  highlightLine(hit) {
    for (const face of this.reading.pages) face.userData.highlight.visible = false;
    if (!hit) return;
    const page = hit.object.userData.page;
    if (!page || !hit.uv) return;
    const u = hit.uv.x, v = 1 - hit.uv.y;
    const line = page.lines.find(l => u >= l.box[0] && u <= l.box[2] && v >= l.box[1] && v <= l.box[3]);
    if (!line) return;
    const highlight = hit.object.userData.highlight;
    const [x0, y0, x1, y1] = line.box;
    highlight.visible = true;
    highlight.scale.set(x1 - x0, y1 - y0, 1);
    highlight.position.set((x0 + x1) / 2 - 0.5, 0.5 - (y0 + y1) / 2, 0.001);
  }

  /** Where a dish's printed line sits on screen, for the automated walk-through. */
  lineOnScreen(name) {
    if (!this.reading) return null;
    for (const face of this.reading.pages) {
      if (!face.visible) continue;
      const page = face.userData.page;
      const line = page?.lines.find(l => l.dish === name);
      if (!line) continue;
      const [x0, y0, x1, y1] = line.box;
      const point = new THREE.Vector3((x0 + x1) / 2 - 0.5, 0.5 - (y0 + y1) / 2, 0);
      face.updateWorldMatrix(true, false);
      face.localToWorld(point);
      point.project(this.camera);
      return { x: (point.x * 0.5 + 0.5) * innerWidth, y: (-point.y * 0.5 + 0.5) * innerHeight,
        page: page.id };
    }
    return null;
  }

  closeMenu() {
    if (!this.reading) return;
    const { menu, book } = this.reading;
    book.traverse(object => {
      object.geometry?.dispose();
      object.material?.map?.dispose();
      object.material?.dispose();
    });
    book.removeFromParent();
    menu.visible = true;
    this.reading = null;
    this.play('page-turn', { volume: 0.35, rate: 0.8 });
    this.options.onReading?.(false);
  }

  // --- dishes -------------------------------------------------------------------------
  nearestTable(from, fallback) {
    let best = null, bestDistance = 4.2;
    for (const table of this.tables) {
      const distance = table.position.distanceTo(from);
      if (distance < bestDistance) { best = table; bestDistance = distance; }
    }
    return best || fallback || this.tables[0];
  }

  makeDish(dish) {
    const group = new THREE.Group();
    const add = (formName, offset) => {
      const form = this.forms.get(formName);
      if (!form) return;
      const copy = form.clone(true);
      copy.traverse(object => {
        if (!object.isMesh) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        const tinted = materials.map(material => {
          const own = material.clone();
          const slot = (material.name || '').replace(/^dish /, '');
          const colour = dish.palette?.[slot];
          if (colour) own.color.setRGB(colour[0], colour[1], colour[2]);
          return own;
        });
        object.material = Array.isArray(object.material) ? tinted : tinted[0];
      });
      copy.position.copy(offset);
      group.add(copy);
    };
    add(dish.form, new THREE.Vector3(0, 0, 0));
    if (dish.side) add(dish.side, new THREE.Vector3(0.21, 0, 0.06));
    group.userData = { kind: 'dish', dish };
    return group;
  }

  serve(dish) {
    const origin = this.reading?.menu?.userData.table;
    const here = this.camera.getWorldPosition(new THREE.Vector3());
    const table = this.nearestTable(here, origin);
    if (table.served.length >= DISH_SLOTS) {
      const oldest = table.served.shift();
      this.removeDish(oldest);
    }
    const group = this.makeDish(dish);
    // The four place settings sit at a table's corners and a lantern at its middle, so
    // dishes go down the long centre line, either side of the lantern. On a long counter
    // they go in front of wherever the visitor is standing.
    const long = table.size[0] >= table.size[1]
      ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, -1);
    const half = Math.max(table.size[0], table.size[1]) / 2;
    const slot = table.served.length;
    let base = table.position.clone();
    let offsets;
    if (half > 1.2) {
      const along = clamp(new THREE.Vector3().subVectors(here, table.position).dot(long), -half + 0.3, half - 0.3);
      base.addScaledVector(long, along);
      offsets = [0, -0.40, 0.40];
    } else {
      const spread = Math.min(1, half / 0.8);
      offsets = [-0.44 * spread, 0.44 * spread, 0.0];
    }
    const target = base.addScaledVector(long, offsets[slot % offsets.length]);
    if (half <= 1.2 && slot % offsets.length === 2) {
      // The third dish on a small table sits nearer the visitor, clear of the lantern.
      const toward = new THREE.Vector3().subVectors(here, table.position).setY(0);
      toward.addScaledVector(long, -toward.dot(long));
      if (toward.lengthSq() > 1e-4) target.addScaledVector(toward.normalize(), 0.16);
    }
    target.y = table.position.y + 0.002;
    const facing = new THREE.Vector3().subVectors(here, target).setY(0);
    group.position.copy(target).add(new THREE.Vector3(0, 0.28, 0));
    group.rotation.y = Math.atan2(facing.x, facing.z);
    group.userData.settle = { target, t: 0 };
    this.scene.add(group);
    const entry = { group, dish, table };
    table.served.push(entry);
    this.served.push(entry);
    this.play('plate', { at: target, volume: 0.8, rate: 0.95 + Math.random() * 0.1, reach: 3 });
    this.options.onDish?.(dish);
  }

  removeDish(entry) {
    if (!entry) return;
    entry.group.removeFromParent();
    entry.group.traverse(object => { if (object.isMesh) object.material.dispose?.(); });
    this.served = this.served.filter(item => item !== entry);
  }

  // --- bottles --------------------------------------------------------------------------
  pickBottle(bottle) {
    if (bottle.userData.state !== 'shelf') return;
    bottle.userData.state = 'held';
    bottle.userData.shelfParent = bottle.parent;
    this.tint(bottle, false);
    this.hovered = null;
    this.camera.attach(bottle);
    bottle.userData.grip = { t: 0, from: bottle.position.clone(), fromQuaternion: bottle.quaternion.clone() };
    this.holding = bottle;
    this.play('clink', { volume: 0.55, rate: 0.9 + Math.random() * 0.2 });
    this.options.onHolding?.(true);
  }

  returnBottle() {
    const bottle = this.holding;
    if (!bottle) return;
    this.holding = null;
    this.scene.attach(bottle);
    bottle.userData.state = 'shelf';
    (bottle.userData.shelfParent || this.interior.root).attach(bottle);
    bottle.position.copy(bottle.userData.home);
    bottle.quaternion.copy(bottle.userData.homeQuaternion);
    this.play('clink', { volume: 0.4, rate: 1.1 });
    this.options.onHolding?.(false);
  }

  throwBottle() {
    const bottle = this.holding;
    if (!bottle) return;
    this.holding = null;
    this.scene.attach(bottle);
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    const velocity = forward.multiplyScalar(6.2).add(new THREE.Vector3(0, 2.2, 0));
    const spin = new THREE.Vector3(Math.random() * 8 - 4, Math.random() * 3, Math.random() * 8 - 4);
    bottle.userData.state = 'flying';
    this.flying.push({ object: bottle, velocity, spin, age: 0 });
    this.options.onHolding?.(false);
  }

  shatter(bottle, point, floor) {
    bottle.visible = false;
    bottle.userData.state = 'broken';
    const templates = this.shardTemplates;
    for (let i = 0; i < 16 && templates.length; i++) {
      const shard = templates[i % templates.length].clone(true);
      shard.position.copy(point).add(new THREE.Vector3(0, 0.05, 0));
      shard.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.8 + Math.random() * 2.2;
      this.scene.add(shard);
      this.shards.push({
        object: shard, floor,
        velocity: new THREE.Vector3(Math.cos(angle) * speed, 1.2 + Math.random() * 2.2, Math.sin(angle) * speed),
        spin: new THREE.Vector3(Math.random() * 14 - 7, Math.random() * 14 - 7, Math.random() * 14 - 7),
        resting: false,
      });
    }
    this.play('glass-break', { at: point, volume: 1.0, rate: 0.92 + Math.random() * 0.16, reach: 5 });
  }

  // --- the bell -----------------------------------------------------------------------
  ring(point) {
    const bell = this.bell;
    if (!bell.object) return;
    // Swing away from whoever struck it.
    const here = this.camera.getWorldPosition(new THREE.Vector3());
    const push = new THREE.Vector3().subVectors(bell.object.getWorldPosition(new THREE.Vector3()), here).setY(0);
    if (push.lengthSq() < 1e-4) push.set(0, 0, -1);
    push.normalize();
    bell.axis.set(push.z, 0, -push.x).normalize();
    bell.velocity += 0.16;
    this.play('bell', { at: point || bell.object.getWorldPosition(new THREE.Vector3()),
      volume: 1.0, reach: 9 });
  }

  // --- sitting down -------------------------------------------------------------------
  sit(seat) {
    const walker = this.interior.walker;
    const [x, y] = seat.userData.plan;
    const table = this.nearestTable(toScene(x, y, seat.userData.floor), null);
    this.seated = {
      seat, returnTo: { x: walker.x, z: walker.z, floor: walker.floor, yaw: walker.yaw, pitch: walker.pitch },
    };
    const eye = SEAT_EYE[seat.userData.seat] || SEAT_EYE.default;
    walker.x = x;
    walker.z = y;
    walker.floor = seat.userData.floor + (eye - 1.62);
    walker.momentum.set(0, 0);
    walker.speed = 0;
    if (table) walker.yaw = Math.atan2(-(table.centre[0] - x), table.centre[1] - y);
    walker.pitch = -0.28;
    walker.pendingYaw = walker.pendingPitch = 0;
    this.interior.place();
    this.options.onSeated?.(true);
  }

  stand() {
    if (!this.seated) return;
    const walker = this.interior.walker;
    Object.assign(walker, this.seated.returnTo);
    walker.momentum.set(0, 0);
    this.seated = null;
    this.interior.place();
    this.options.onSeated?.(false);
  }

  // --- each frame -----------------------------------------------------------------------
  update(dt) {
    let active = false;
    if (this.reading) {
      const book = this.reading.book;
      this.reading.opened = Math.min(1, this.reading.opened + dt * 4.5);
      const s = 1 - Math.pow(1 - this.reading.opened, 3);
      book.scale.setScalar(Math.max(0.001, s));
      active = active || this.reading.opened < 1;
    }
    if (this.holding) {
      const bottle = this.holding;
      const grip = bottle.userData.grip;
      grip.t = Math.min(1, grip.t + dt * 3.2);
      const e = 1 - Math.pow(1 - grip.t, 3);
      bottle.position.lerpVectors(grip.from, new THREE.Vector3(0.20, -0.30, -0.46), e);
      bottle.quaternion.slerpQuaternions(grip.fromQuaternion,
        new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.25, 0.3, -0.18)), e);
      active = active || grip.t < 1;
    }
    for (const entry of this.served) {
      const settle = entry.group.userData.settle;
      if (!settle || settle.t >= 1) continue;
      settle.t = Math.min(1, settle.t + dt * 2.6);
      const e = 1 - Math.pow(1 - settle.t, 4);
      entry.group.position.lerpVectors(
        settle.target.clone().add(new THREE.Vector3(0, 0.28, 0)), settle.target, e);
      active = true;
    }
    const field = this.interior;
    for (const item of this.flying) {
      item.age += dt;
      item.velocity.y += GRAVITY * dt;
      item.object.position.addScaledVector(item.velocity, dt);
      item.object.rotation.x += item.spin.x * dt;
      item.object.rotation.z += item.spin.z * dt;
      const p = item.object.position;
      const floor = field.floorAt(p.x, -p.z);
      const ground = floor === null ? p.y - 1 : floor;
      if (floor === null || p.y <= ground + 0.04 || item.age > 4) {
        const impact = p.clone();
        impact.y = floor === null ? Math.max(0, p.y) : ground;
        this.shatter(item.object, impact, floor === null ? impact.y : ground);
        item.done = true;
      }
      active = true;
    }
    this.flying = this.flying.filter(item => !item.done);
    for (const shard of this.shards) {
      if (shard.resting) continue;
      shard.velocity.y += GRAVITY * dt;
      shard.object.position.addScaledVector(shard.velocity, dt);
      shard.object.rotation.x += shard.spin.x * dt;
      shard.object.rotation.y += shard.spin.y * dt;
      shard.object.rotation.z += shard.spin.z * dt;
      const p = shard.object.position;
      const floor = field.floorAt(p.x, -p.z);
      const ground = floor === null ? shard.floor : floor;
      if (p.y <= ground + 0.004) {
        p.y = ground + 0.004;
        if (Math.abs(shard.velocity.y) < 0.6) {
          shard.resting = true;
          shard.object.rotation.x = 0;
          shard.object.rotation.z = 0;
        } else {
          shard.velocity.y *= -0.32;
          shard.velocity.x *= 0.55;
          shard.velocity.z *= 0.55;
          shard.spin.multiplyScalar(0.5);
        }
      }
      active = true;
    }
    for (const ripple of this.ripples || []) {
      ripple.age += dt;
      if (ripple.age < 0) { active = true; continue; }
      const t = ripple.age / ripple.life;
      ripple.ring.scale.setScalar(0.02 + ripple.reach * Math.sqrt(t));
      ripple.ring.material.opacity = 0.34 * Math.sin(Math.min(1, t) * Math.PI) * (1 - t * 0.5);
      if (t >= 1) {
        ripple.ring.removeFromParent();
        ripple.ring.material.dispose();
        ripple.done = true;
      }
      active = true;
    }
    if (this.ripples) this.ripples = this.ripples.filter(r => !r.done);
    const bell = this.bell;
    if (bell.object && (Math.abs(bell.angle) > 1e-4 || Math.abs(bell.velocity) > 1e-4)) {
      // A heavy pendulum: slow, lightly damped.
      bell.velocity += (-bell.angle * 1.9 - bell.velocity * 0.32) * dt;
      bell.angle += bell.velocity * dt;
      bell.object.quaternion.copy(bell.object.userData.homeQuaternion)
        .multiply(new THREE.Quaternion().setFromAxisAngle(bell.axis, bell.angle));
      active = true;
    }
    return active;
  }

  /** Put back what the visitor left lying about, for the next time they come in. */
  reset() {
    this.closeMenu();
    if (this.holding) this.returnBottle();
    this.stand();
    for (const entry of [...this.served]) this.removeDish(entry);
    for (const table of this.tables) table.served = [];
    for (const shard of this.shards) shard.object.removeFromParent();
    this.shards = [];
    for (const item of this.flying) item.object.visible = false;
    this.flying = [];
    for (const bottle of this.bottles) {
      if (bottle.userData.state === 'shelf') continue;
      bottle.visible = true;
      bottle.userData.state = 'shelf';
      (bottle.userData.shelfParent || this.interior.root).attach(bottle);
      bottle.position.copy(bottle.userData.home);
      bottle.quaternion.copy(bottle.userData.homeQuaternion);
    }
    const bell = this.bell;
    bell.angle = bell.velocity = 0;
    if (bell.object) bell.object.quaternion.copy(bell.object.userData.homeQuaternion);
  }
}
