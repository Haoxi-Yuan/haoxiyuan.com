import * as THREE from 'three';

// Time of day for the folded street. The sun and moon are computed for each street's real
// latitude, longitude and compass bearing, so the light that falls on a facade at 07:15 is
// the light that facade actually gets. Sky colour is an authored palette keyed to the
// computed solar elevation, not a measurement.

const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const J2000 = 2451545;
const OBLIQUITY = 23.4397 * RAD;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const span = (x, a, b) => smooth((x - a) / (b - a || 1e-6));

export const SITES = {
  singapore: { timeZone: 'Asia/Singapore' },
  tokyo: { timeZone: 'Asia/Tokyo' },
  london: { timeZone: 'Europe/London' }
};

/** The zone's own short name at this instant, so London reads BST in summer and GMT in winter. */
export function zoneLabel(timeZone, date) {
  for (const part of new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'short' })
    .formatToParts(date)) {
    if (part.type === 'timeZoneName') return part.value;
  }
  return timeZone;
}

/** Minutes that a named zone is ahead of UTC at this instant, DST included. */
export function zoneOffset(timeZone, date) {
  const parts = {};
  for (const part of new Intl.DateTimeFormat('en-GB', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date)) parts[part.type] = part.value;
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day,
    +parts.hour % 24, +parts.minute, +parts.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

/** The UTC instant at which a zone's wall clock reads this date and minute-of-day. */
export function localInstant(timeZone, dayStart, minutes) {
  const guess = new Date(dayStart.getTime() + minutes * 60000);
  let offset = zoneOffset(timeZone, guess);
  let instant = new Date(dayStart.getTime() + (minutes - offset) * 60000);
  // One correction settles the case where the guess straddled a DST boundary.
  const corrected = zoneOffset(timeZone, instant);
  if (corrected !== offset) instant = new Date(dayStart.getTime() + (minutes - corrected) * 60000);
  return instant;
}

function julian(date) { return date.getTime() / 86400000 + 2440587.5; }

/** NOAA solar position: elevation above the horizon and azimuth east of north. */
export function sunPosition(latitude, longitude, date) {
  const jd = julian(date), t = (jd - J2000) / 36525;
  const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const m = (357.52911 + t * (35999.05029 - 0.0001537 * t)) * RAD;
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c = Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t))
    + Math.sin(2 * m) * (0.019993 - 0.000101 * t) + Math.sin(3 * m) * 0.000289;
  const omega = (125.04 - 1934.136 * t) * RAD;
  const lambda = (l0 + c - 0.00569 - 0.00478 * Math.sin(omega)) * RAD;
  const eps0 = (23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60) * RAD;
  const eps = eps0 + 0.00256 * RAD * Math.cos(omega);
  const declination = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const y = Math.tan(eps / 2) ** 2;
  const equation = 4 * DEG * (y * Math.sin(2 * l0 * RAD) - 2 * e * Math.sin(m)
    + 4 * e * y * Math.sin(m) * Math.cos(2 * l0 * RAD)
    - 0.5 * y * y * Math.sin(4 * l0 * RAD) - 1.25 * e * e * Math.sin(2 * m));
  const utcMinutes = (date.getTime() / 60000) % 1440;
  const solarMinutes = utcMinutes + equation + 4 * longitude;
  const hourAngle = (solarMinutes / 4 - 180) * RAD;
  return horizontal(latitude * RAD, declination, hourAngle);
}

/** Meeus low-precision lunar position, plus the illuminated fraction. */
export function moonPosition(latitude, longitude, date) {
  const jd = julian(date), d = jd - J2000;
  const meanLongitude = (218.316 + 13.176396 * d) * RAD;
  const anomaly = (134.963 + 13.064993 * d) * RAD;
  const node = (93.272 + 13.229350 * d) * RAD;
  const lambda = meanLongitude + 6.289 * RAD * Math.sin(anomaly);
  const beta = 5.128 * RAD * Math.sin(node);
  const declination = Math.asin(Math.sin(beta) * Math.cos(OBLIQUITY)
    + Math.cos(beta) * Math.sin(OBLIQUITY) * Math.sin(lambda));
  const rightAscension = Math.atan2(
    Math.sin(lambda) * Math.cos(OBLIQUITY) - Math.tan(beta) * Math.sin(OBLIQUITY),
    Math.cos(lambda));
  // Greenwich mean sidereal time, then the local hour angle.
  const gmst = (280.16 + 360.9856235 * d) * RAD;
  const hourAngle = gmst + longitude * RAD - rightAscension;
  const position = horizontal(latitude * RAD, declination, hourAngle);
  const sunLongitude = ((280.459 + 0.98564736 * d) + 1.915 * Math.sin((357.529 + 0.98560028 * d) * RAD)) * RAD;
  position.illuminated = (1 - Math.cos(lambda - sunLongitude)) / 2;
  return position;
}

function horizontal(latitude, declination, hourAngle) {
  const sinElevation = Math.sin(latitude) * Math.sin(declination)
    + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle);
  const elevation = Math.asin(clamp(sinElevation, -1, 1));
  const azimuth = Math.atan2(Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(latitude) - Math.tan(declination) * Math.cos(latitude));
  return { elevation, azimuth: azimuth + Math.PI, elevationDeg: elevation * DEG };
}

/**
 * A compass direction, expressed in the street's own scene axes. The layout records the
 * street's forward bearing as east/north components; scene -Z follows it and +X is a
 * quarter turn clockwise from it, matching how the geometry was projected.
 */
export function toScene(elevation, azimuth, forwardEN) {
  const [fx, fy] = forwardEN;
  const east = Math.sin(azimuth), north = Math.cos(azimuth), flat = Math.cos(elevation);
  return new THREE.Vector3(
    flat * (east * fy - north * fx),
    Math.sin(elevation),
    -flat * (east * fx + north * fy)
  );
}

// --- palette -------------------------------------------------------------------------
// Four keyed skies, blended on solar elevation. Values are authored, not measured.
const KEYS = [
  { at: -0.30, zenith: [0.008, 0.013, 0.032], horizon: [0.030, 0.042, 0.078], ground: [0.014, 0.016, 0.022] },
  { at: -0.09, zenith: [0.042, 0.055, 0.115], horizon: [0.150, 0.130, 0.190], ground: [0.030, 0.031, 0.038] },
  { at: 0.01, zenith: [0.120, 0.165, 0.330], horizon: [0.720, 0.360, 0.220], ground: [0.105, 0.090, 0.082] },
  { at: 0.13, zenith: [0.150, 0.270, 0.560], horizon: [0.880, 0.620, 0.400], ground: [0.180, 0.165, 0.145] },
  { at: 0.45, zenith: [0.175, 0.360, 0.690], horizon: [0.620, 0.720, 0.830], ground: [0.245, 0.240, 0.225] }
];

function mixRGB(a, b, t) { return a.map((v, i) => v + (b[i] - v) * t); }

export function skyPalette(sinElevation) {
  let lower = KEYS[0], upper = KEYS[KEYS.length - 1];
  for (let i = 1; i < KEYS.length; i++) {
    if (sinElevation <= KEYS[i].at) { lower = KEYS[i - 1]; upper = KEYS[i]; break; }
    if (i === KEYS.length - 1) { lower = upper = KEYS[i]; }
  }
  const t = lower === upper ? 0 : smooth((sinElevation - lower.at) / (upper.at - lower.at));
  return {
    zenith: mixRGB(lower.zenith, upper.zenith, t),
    horizon: mixRGB(lower.horizon, upper.horizon, t),
    ground: mixRGB(lower.ground, upper.ground, t)
  };
}

const SKY_VERTEX = `
varying vec3 vDirection;
void main(){
 vDirection = position;
 gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
}`;

const SKY_FRAGMENT = `
precision highp float;
varying vec3 vDirection;
uniform vec3 uZenith, uHorizon, uGround, uSunDirection, uMoonDirection, uSunTint;
uniform float uNight, uSunAbove, uMoonPhase, uMoonLight;

float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}

// A fixed star field: cells on the direction's spherical grid, one candidate star each.
float stars(vec3 dir){
 vec2 grid = vec2(atan(dir.z,dir.x)*12.0, asin(clamp(dir.y,-1.0,1.0))*16.0);
 vec2 cell = floor(grid);
 float pick = hash(cell);
 if(pick < 0.86) return 0.0;
 vec2 centre = cell + vec2(hash(cell+11.3), hash(cell+7.7));
 float d = length(grid - centre);
 float magnitude = hash(cell + 3.1);
 return smoothstep(0.42, 0.0, d) * (0.25 + magnitude * magnitude * 0.95);
}

void main(){
 vec3 dir = normalize(vDirection);
 float height = dir.y;
 float band = pow(1.0 - clamp(abs(height),0.0,1.0), 3.4);
 vec3 colour = mix(uZenith, uHorizon, band);
 if(height < 0.0) colour = mix(colour, uGround, smoothstep(0.0,-0.22,height));

 float toSun = max(dot(dir, uSunDirection), 0.0);
 // Forward scattering keeps the sun's half of the sky warm near the horizon.
 colour += uSunTint * pow(toSun, 5.0) * 0.30 * uSunAbove;
 colour += uSunTint * pow(toSun, 220.0) * 1.60 * uSunAbove;
 float disc = smoothstep(0.99955, 0.99985, toSun);
 colour += uSunTint * disc * 9.0 * uSunAbove;

 if(uNight > 0.001){
  float field = stars(dir) * smoothstep(-0.02, 0.16, height) * uNight;
  colour += vec3(0.92, 0.94, 1.0) * field;
  float toMoon = max(dot(dir, uMoonDirection), 0.0);
  float moon = smoothstep(0.99972, 0.99990, toMoon);
  // A terminator across the disc, set by the illuminated fraction.
  vec3 limb = normalize(cross(uMoonDirection, vec3(0.0,1.0,0.0)) + vec3(1e-4));
  float across = dot(normalize(dir - uMoonDirection * toMoon), limb);
  float lit = smoothstep(-0.35, 0.35, across * sign(uMoonPhase - 0.5) + (uMoonPhase - 0.5) * 2.4);
  colour += vec3(1.0, 0.98, 0.92) * moon * (0.18 + lit * 2.4) * uMoonLight;
  colour += vec3(0.70, 0.76, 0.92) * pow(toMoon, 900.0) * 0.55 * uMoonLight;
 }
 gl_FragColor = vec4(colour, 1.0);
}`;

export class Daylight {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.site = null;
    this.uniforms = {
      uZenith: { value: new THREE.Color(0.175, 0.36, 0.69) },
      uHorizon: { value: new THREE.Color(0.62, 0.72, 0.83) },
      uGround: { value: new THREE.Color(0.245, 0.24, 0.225) },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDirection: { value: new THREE.Vector3(0, -1, 0) },
      uSunTint: { value: new THREE.Color(1, 0.93, 0.80) },
      uNight: { value: 0 },
      uSunAbove: { value: 1 },
      uMoonPhase: { value: 0.5 },
      uMoonLight: { value: 0 }
    };
    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(1, 48, 32),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms, vertexShader: SKY_VERTEX, fragmentShader: SKY_FRAGMENT,
        side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false
      })
    );
    this.dome.scale.setScalar(480);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1;
    scene.add(this.dome);

    this.sun = new THREE.DirectionalLight(0xffefda, 1.7);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera,
      { left: -64, right: 64, top: 72, bottom: -54, near: 1, far: 320 });
    this.sun.shadow.bias = -0.00015;
    this.sun.shadow.normalBias = 0.05;
    scene.add(this.sun, this.sun.target);

    this.ambient = new THREE.HemisphereLight(0xd6e8ff, 0x8d806e, 0.42);
    scene.add(this.ambient);
    this.bounce = new THREE.DirectionalLight(0xdbefff, 0.38);
    this.bounce.position.set(0, 30, 65);
    scene.add(this.bounce);

    // The sky is also the image-based light. Regenerated only when the sun has moved.
    this.cubeTarget = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType });
    this.cubeCamera = new THREE.CubeCamera(1, 1000, this.cubeTarget);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileCubemapShader();
    this.environment = null;
    this.environmentAt = null;
    this.state = { minutes: 0, sunAltitude: 0, night: 0 };
  }

  setSite({ latitude, longitude, forwardEN, timeZone }) {
    this.site = { latitude, longitude, forwardEN, timeZone };
    this.environmentAt = null;
  }

  /** Point the sky and the shadow volume at wherever the walker currently stands. */
  follow(position) {
    this.dome.position.copy(position);
    this.sun.target.position.set(position.x, 0, position.z);
    this.sun.position.copy(this.sun.target.position)
      .addScaledVector(this.sunDirection || new THREE.Vector3(0, 1, 0), 150);
    this.bounce.position.set(position.x, position.y + 28, position.z + 60);
  }

  /** Apply a wall-clock time. `dayStart` is UTC midnight of the chosen date. */
  apply(dayStart, minutes) {
    if (!this.site) return this.state;
    const { latitude, longitude, forwardEN, timeZone } = this.site;
    const instant = localInstant(timeZone, dayStart, minutes);
    const sun = sunPosition(latitude, longitude, instant);
    const moon = moonPosition(latitude, longitude, instant);
    this.sunDirection = toScene(sun.elevation, sun.azimuth, forwardEN);
    const moonDirection = toScene(moon.elevation, moon.azimuth, forwardEN);
    const sinEl = Math.sin(sun.elevation);

    const palette = skyPalette(sinEl);
    this.uniforms.uZenith.value.setRGB(...palette.zenith);
    this.uniforms.uHorizon.value.setRGB(...palette.horizon);
    this.uniforms.uGround.value.setRGB(...palette.ground);
    this.uniforms.uSunDirection.value.copy(this.sunDirection);
    this.uniforms.uMoonDirection.value.copy(moonDirection);

    // Sunlight reddens and dims through the last few degrees above the horizon.
    const low = 1 - span(sinEl, -0.02, 0.28);
    this.uniforms.uSunTint.value.setRGB(1, 0.95 - low * 0.33, 0.86 - low * 0.62);
    const above = span(sinEl, -0.028, 0.012);
    this.uniforms.uSunAbove.value = above;
    const night = 1 - span(sinEl, -0.21, -0.035);
    this.uniforms.uNight.value = night;
    this.uniforms.uMoonPhase.value = moon.illuminated;
    this.uniforms.uMoonLight.value = night * span(Math.sin(moon.elevation), -0.03, 0.06);

    this.sun.intensity = 2.05 * span(sinEl, -0.025, 0.22) * (0.42 + 0.58 * span(sinEl, 0, 0.55));
    this.sun.color.setRGB(1, 0.94 - low * 0.30, 0.82 - low * 0.55);

    const moonlight = this.uniforms.uMoonLight.value * (0.25 + 0.75 * moon.illuminated);
    this.ambient.intensity = 0.055 + 0.40 * span(sinEl, -0.16, 0.22) + moonlight * 0.10;
    this.ambient.color.setRGB(
      0.56 + 0.28 * span(sinEl, -0.05, 0.3),
      0.66 + 0.25 * span(sinEl, -0.05, 0.3),
      0.92);
    this.ambient.groundColor.setRGB(0.10 + 0.45 * span(sinEl, -0.05, 0.3),
      0.09 + 0.41 * span(sinEl, -0.05, 0.3), 0.08 + 0.35 * span(sinEl, -0.05, 0.3));
    this.bounce.intensity = 0.06 + 0.34 * span(sinEl, -0.06, 0.30);

    if (this.scene.fog) {
      this.scene.fog.color.setRGB(...palette.horizon);
      this.scene.fog.near = 140 + 90 * span(sinEl, -0.1, 0.3);
      this.scene.fog.far = 330 + 230 * span(sinEl, -0.1, 0.3);
    }
    this.renderer.toneMappingExposure = 1.0 + night * 0.34;

    this.state = {
      minutes, instant, night,
      sunAltitude: sun.elevationDeg,
      moonAltitude: moon.elevation * DEG,
      moonIlluminated: moon.illuminated,
      dark: night > 0.42,
      lampsOn: night > 0.18
    };
    return this.state;
  }

  /** Re-derive the image-based light; cheap enough to run when the sun has visibly moved. */
  refreshEnvironment(force = false) {
    // A degree and a half of solar motion is below the point where the ambient changes
    // visibly, so most scrub frames reuse the light they already have.
    const key = Math.round(this.state.sunAltitude / 1.5);
    if (!force && this.environmentAt === key) return false;
    this.environmentAt = key;
    if (!this.captureScene) this.captureScene = new THREE.Scene();
    const parent = this.dome.parent;
    const previous = this.dome.position.clone();
    const wasVisible = this.dome.visible;
    this.dome.position.set(0, 0, 0);
    this.dome.visible = true;
    this.captureScene.add(this.dome);
    this.cubeCamera.position.set(0, 0, 0);
    this.cubeCamera.update(this.renderer, this.captureScene);
    this.dome.position.copy(previous);
    this.dome.visible = wasVisible;
    (parent || this.scene).add(this.dome);
    const generated = this.pmrem.fromCubemap(this.cubeTarget.texture);
    this.environment?.dispose();
    this.environment = generated;
    this.scene.environment = generated.texture;
    return true;
  }

  /** Put the dome back on the walked scene, whatever a capture left behind. */
  returnDome() {
    if (this.dome.parent !== this.scene) this.scene.add(this.dome);
  }

  dispose() {
    this.environment?.dispose();
    this.cubeTarget.dispose();
    this.pmrem.dispose();
    this.dome.geometry.dispose();
    this.dome.material.dispose();
  }
}

// --- opening hours --------------------------------------------------------------------
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Is this place open at `minutes` on `weekday`? Sessions run in minutes after midnight and
 * may pass 1440, so yesterday's late session is checked too. Real records only: a place
 * with no saved hours returns null rather than a guess.
 */
export function openAt(place, weekday, minutes) {
  const weekly = place.openingHours?.weekly;
  if (!weekly) return null;
  const today = weekly[DAY_NAMES[weekday]];
  const yesterday = weekly[DAY_NAMES[(weekday + 6) % 7]];
  if (!today) return null;
  for (const [from, to] of today.sessions) {
    if (minutes >= from && minutes < to) return { open: true, closesAt: to, session: [from, to] };
  }
  for (const [from, to] of yesterday?.sessions || []) {
    if (to > 1440 && minutes < to - 1440) {
      return { open: true, closesAt: to - 1440, session: [from - 1440, to - 1440], overnight: true };
    }
  }
  let next = null;
  for (const [from] of today.sessions) if (from > minutes && (next === null || from < next)) next = from;
  return { open: false, opensAt: next, text: today.text };
}

/** Google's recorded 0-100 popularity for this weekday and hour, or null when unrecorded. */
export function popularityAt(place, weekday, minutes) {
  const weekly = place.popularTimes?.weekly;
  if (!weekly) return null;
  const day = weekly[DAY_NAMES[weekday]];
  if (!day) return null;
  const value = day[String(Math.floor(minutes / 60))];
  return value === undefined ? null : value;
}

export function clockLabel(minutes) {
  const total = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}

export { DAY_NAMES };
