// ── RaceTrack Game ──────────────────────────────────────────────────────────
'use strict';

// ── Constants ───────────────────────────────────────────────────────────────
const TOTAL_LAPS = 3;
const ROAD_WIDTH = 10;
const ROAD_SEGS = 300;
const CAR_ACCEL = 28;
const CAR_BRAKE = 40;
const CAR_DRAG = 0.97;
const CAR_STEER_MAX = 0.4;      // was 1.6
const CAR_STEER_SPEED = 0.6;    // was 3.5
const HANDBRAKE_DRAG = 0.88;
const MAX_SPEED = 60;
const GRAVITY = 20;
const CAMERA_DIST = 9;
const CAMERA_HEIGHT = 3.5;

// ── Three.js setup ───────────────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2035);
scene.fog = new THREE.Fog(0x1a2035, 60, 180);

const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 300);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ── Lighting ────────────────────────────────────────────────────────────────
const ambient = new THREE.AmbientLight(0x334466, 0.8);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xfff5e0, 1.6);
sun.position.set(40, 80, 30);
sun.castShadow = true;
sun.shadow.mapSize.width = 2048;
sun.shadow.mapSize.height = 2048;
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 300;
sun.shadow.camera.left = -100;
sun.shadow.camera.right = 100;
sun.shadow.camera.top = 100;
sun.shadow.camera.bottom = -100;
scene.add(sun);

const fillLight = new THREE.DirectionalLight(0x4488ff, 0.4);
fillLight.position.set(-30, 20, -20);
scene.add(fillLight);

// ── Track Definition ─────────────────────────────────────────────────────────
// Control points forming a fun figure-8 / complex loop
const RAW_PTS = [
  [0,   0,    0],
  [30,  0,   -15],
  [65,  0,   -8],
  [85,  3,    20],
  [80,  6,    50],
  [55,  8,    70],
  [25,  8,    75],
  [0,   6,    65],
  [-25, 4,    50],
  [-40, 0,    25],
  [-40, 0,   -5],
  [-25, 0,   -25],
  [0,   0,   -35],
  [20,  2,   -50],
  [40,  5,   -60],
  [60,  8,   -52],
  [75,  10,  -35],
  [70,  10,  -12],
  [50,  8,    5],
  [28,  4,    12],
  [10,  2,    5],
  [0,   0,    0],
];

const trackPts = RAW_PTS.map(p => new THREE.Vector3(p[0], p[1], p[2]));
const trackCurve = new THREE.CatmullRomCurve3(trackPts, true, 'catmullrom', 0.5);

// Precompute frenet frames along track
const FRAMES = trackCurve.computeFrenetFrames(ROAD_SEGS, true);
const CURVE_PTS = trackCurve.getPoints(ROAD_SEGS);

// Sparse track samples shared between terrain generation and runtime height queries
const TERRAIN_SAMPLES = CURVE_PTS.filter((_, i) => i % 4 === 0);

// Returns terrain surface Y at any world (x, z) — exact same formula as buildGround()
function getTerrainY(x, z) {
  let noise = 0;
  noise += Math.sin(x * 0.038 + 1.3) * Math.cos(z * 0.031 + 0.7) * 5.0;
  noise += Math.sin(x * 0.085 + 0.5) * Math.cos(z * 0.079 - 1.1) * 2.5;
  noise += Math.sin(x * 0.170 - 0.9) * Math.cos(z * 0.155 + 2.3) * 1.2;
  noise += Math.sin(x * 0.340 + 2.1) * Math.cos(z * 0.310 - 0.6) * 0.5;
  noise += Math.sin(x * 0.680 - 1.7) * Math.cos(z * 0.620 + 1.4) * 0.2;

  let minDist = Infinity, nearTrackY = 0;
  for (let j = 0; j < TERRAIN_SAMPLES.length; j++) {
    const dx = x - TERRAIN_SAMPLES[j].x;
    const dz = z - TERRAIN_SAMPLES[j].z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < minDist) { minDist = d; nearTrackY = TERRAIN_SAMPLES[j].y; }
  }

  const blend = Math.min(1, Math.max(0, (minDist - 9) / (26 - 9)));
  const groundY = nearTrackY - 0.4;
  return groundY + noise * blend;
}

// Smooth normals — make them face up-ish
const UP_NORMALS = FRAMES.normals.map((n, i) => {
  const b = FRAMES.binormals[i];
  const t = FRAMES.tangents[i];
  const up = new THREE.Vector3(0, 1, 0);
  // Road normal is perpendicular to tangent and pointing upward
  const right = new THREE.Vector3().crossVectors(t, up).normalize();
  const surfNorm = new THREE.Vector3().crossVectors(right, t).normalize();
  if (surfNorm.y < 0) surfNorm.negate();
  return surfNorm;
});

// ── Road Mesh ────────────────────────────────────────────────────────────────
function buildRoadMesh() {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const N = ROAD_SEGS;

  for (let i = 0; i <= N; i++) {
    const pt = CURVE_PTS[i % (N + 1)];
    const t = FRAMES.tangents[i % (N + 1)];
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(t, up).normalize();
    const norm = new THREE.Vector3().crossVectors(right, t).normalize();
    if (norm.y < 0) norm.negate();

    const halfW = ROAD_WIDTH / 2;
    const u = i / N;

    // Left edge
    positions.push(pt.x - right.x * halfW, pt.y - right.y * halfW, pt.z - right.z * halfW);
    normals.push(norm.x, norm.y, norm.z);
    uvs.push(0, u * 8);

    // Right edge
    positions.push(pt.x + right.x * halfW, pt.y + right.y * halfW, pt.z + right.z * halfW);
    normals.push(norm.x, norm.y, norm.z);
    uvs.push(1, u * 8);
  }

  for (let i = 0; i < N; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    indices.push(a, b, c, b, d, c);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);

  // Road material - dark asphalt with lane line feel
  const mat = new THREE.MeshLambertMaterial({ color: 0x2a2d35 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

// Road markings (center dashes)
function buildMarkings() {
  const group = new THREE.Group();
  const N = ROAD_SEGS;
  for (let i = 0; i < N; i += 6) {
    const pt = CURVE_PTS[i % (N + 1)];
    const t = FRAMES.tangents[i % (N + 1)];
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(t, up).normalize();
    const norm = new THREE.Vector3().crossVectors(right, t).normalize();
    if (norm.y < 0) norm.negate();

    const geo = new THREE.PlaneGeometry(0.25, 1.5);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(pt).addScaledVector(norm, 0.02);
    m.lookAt(pt.clone().add(t));
    m.rotateX(Math.PI / 2);
    group.add(m);
  }
  return group;
}

// Kerb stripes on edges
function buildKerbs() {
  const group = new THREE.Group();
  const N = ROAD_SEGS;
  const kerbW = 0.6;
  for (let i = 0; i <= N; i++) {
    if (i === N) continue;
    const pt0 = CURVE_PTS[i];
    const pt1 = CURVE_PTS[(i + 1) % (N + 1)];
    const t = FRAMES.tangents[i];
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(t, up).normalize();
    const norm = new THREE.Vector3().crossVectors(right, t).normalize();
    if (norm.y < 0) norm.negate();

    const color = (Math.floor(i / 3) % 2 === 0) ? 0xff3333 : 0xffffff;
    const halfW = ROAD_WIDTH / 2;

    for (const side of [-1, 1]) {
      const v = side * (halfW + kerbW / 2);
      const positions = [
        pt0.x + right.x * v - right.x * kerbW/2, pt0.y + right.y * v - right.y * kerbW/2 + 0.01, pt0.z + right.z * v - right.z * kerbW/2,
        pt0.x + right.x * v + right.x * kerbW/2, pt0.y + right.y * v + right.y * kerbW/2 + 0.01, pt0.z + right.z * v + right.z * kerbW/2,
        pt1.x + right.x * v - right.x * kerbW/2, pt1.y + right.y * v - right.y * kerbW/2 + 0.01, pt1.z + right.z * v - right.z * kerbW/2,
        pt1.x + right.x * v + right.x * kerbW/2, pt1.y + right.y * v + right.y * kerbW/2 + 0.01, pt1.z + right.z * v + right.z * kerbW/2,
      ];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setIndex([0,1,2, 1,3,2]);
      geo.computeVertexNormals();
      const mat = new THREE.MeshLambertMaterial({ color });
      group.add(new THREE.Mesh(geo, mat));
    }
  }
  return group;
}

// Procedural terrain
function buildGround() {
  const SIZE = 420;
  const SEGS = 80;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEGS, SEGS);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const colArr = [];

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const finalY = getTerrainY(x, z);
    pos.setY(i, finalY);

    // Color by absolute height
    const t = Math.min(1, Math.max(0, (finalY + 1) / 13));
    let r, g, b;
    if      (t < 0.22) { r = 0.12; g = 0.25; b = 0.10; }   // dark moss
    else if (t < 0.45) { r = 0.17; g = 0.38; b = 0.14; }   // green
    else if (t < 0.65) { r = 0.28; g = 0.46; b = 0.17; }   // light grass
    else if (t < 0.82) { r = 0.42; g = 0.39; b = 0.24; }   // dirt/earth
    else               { r = 0.52; g = 0.50; b = 0.48; }   // rock
    colArr.push(r, g, b);
  }

  geo.setAttribute('color', new THREE.Float32BufferAttribute(colArr, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const m = new THREE.Mesh(geo, mat);
  m.receiveShadow = true;
  return m;
}

// Scenery: trees, rocks
function buildScenery() {
  const group = new THREE.Group();

  // Trees
  const treeMat = new THREE.MeshLambertMaterial({ color: 0x2d6a2d });
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5a3a1a });
  const N = ROAD_SEGS;

  for (let i = 0; i < N; i += 4) {
    const pt = CURVE_PTS[i];
    const t = FRAMES.tangents[i];
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(t, up).normalize();

    for (const side of [-1, 1]) {
      const dist = 8 + Math.random() * 12;
      const pos = pt.clone().addScaledVector(right, side * dist);
      pos.y = Math.max(pos.y, -0.3);

      // Trunk
      const tGeo = new THREE.CylinderGeometry(0.15, 0.2, 1.5, 5);
      const trunk = new THREE.Mesh(tGeo, trunkMat);
      trunk.position.copy(pos).add(new THREE.Vector3(0, 0.75, 0));
      trunk.castShadow = true;
      group.add(trunk);

      // Canopy - low poly cone
      const cGeo = new THREE.ConeGeometry(1.2 + Math.random() * 0.5, 2.5 + Math.random(), 5);
      const canopy = new THREE.Mesh(cGeo, treeMat);
      canopy.position.copy(pos).add(new THREE.Vector3(0, 2.5, 0));
      canopy.rotation.y = Math.random() * Math.PI;
      canopy.castShadow = true;
      group.add(canopy);
    }
  }

  // Rocks
  const rockMat = new THREE.MeshLambertMaterial({ color: 0x666877 });
  for (let i = 0; i < 40; i++) {
    const t = Math.random();
    const pt = trackCurve.getPoint(t);
    const tang = trackCurve.getTangent(t);
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(tang, up).normalize();
    const side = (Math.random() > 0.5 ? 1 : -1) * (10 + Math.random() * 20);
    const pos = pt.clone().addScaledVector(right, side);
    const s = 0.4 + Math.random() * 1.2;
    const geo = new THREE.DodecahedronGeometry(s, 0);
    const mesh = new THREE.Mesh(geo, rockMat);
    mesh.position.copy(pos);
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    mesh.castShadow = true;
    group.add(mesh);
  }

  return group;
}

// Start/Finish line
function buildStartLine() {
  const group = new THREE.Group();
  const pt = CURVE_PTS[0];
  const t = FRAMES.tangents[0];
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(t, up).normalize();
  const norm = new THREE.Vector3().crossVectors(right, t).normalize();
  if (norm.y < 0) norm.negate();

  const geo = new THREE.PlaneGeometry(ROAD_WIDTH, 1.2);
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(pt).addScaledVector(norm, 0.03);
  m.lookAt(pt.clone().add(t));
  m.rotateX(Math.PI / 2);
  group.add(m);

  // Poles
  const poleMat = new THREE.MeshLambertMaterial({ color: 0xff4444 });
  for (const side of [-1, 1]) {
    const poleGeo = new THREE.CylinderGeometry(0.08, 0.08, 3, 6);
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.copy(pt).addScaledVector(right, side * ROAD_WIDTH / 2);
    pole.position.y += 1.5;
    group.add(pole);
  }
  return group;
}

// ── Car Mesh ─────────────────────────────────────────────────────────────────
function buildCar() {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshLambertMaterial({ color: 0x00aaff });
  const wheelMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
  const glassMat = new THREE.MeshLambertMaterial({ color: 0x88ccff, transparent: true, opacity: 0.7 });
  const detailMat = new THREE.MeshLambertMaterial({ color: 0xffffff });

  // Main body
  const bodyGeo = new THREE.BoxGeometry(1.6, 0.45, 3.2);
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = 0.3;
  body.castShadow = true;
  group.add(body);

  // Cabin
  const cabinGeo = new THREE.BoxGeometry(1.3, 0.38, 1.6);
  const cabin = new THREE.Mesh(cabinGeo, bodyMat);
  cabin.position.set(0, 0.67, -0.1);
  cabin.castShadow = true;
  group.add(cabin);

  // Windshield
  const wGeo = new THREE.BoxGeometry(1.2, 0.3, 0.08);
  const windshield = new THREE.Mesh(wGeo, glassMat);
  windshield.position.set(0, 0.7, 0.72);
  windshield.rotation.x = -0.3;
  group.add(windshield);

  // Rear window
  const rwGeo = new THREE.BoxGeometry(1.2, 0.3, 0.08);
  const rearWindow = new THREE.Mesh(rwGeo, glassMat);
  rearWindow.position.set(0, 0.7, -0.92);
  rearWindow.rotation.x = 0.3;
  group.add(rearWindow);

  // Spoiler
  const spoilerGeo = new THREE.BoxGeometry(1.5, 0.08, 0.4);
  const spoiler = new THREE.Mesh(spoilerGeo, bodyMat);
  spoiler.position.set(0, 0.82, -1.7);
  group.add(spoiler);

  // Wheels
  const wheelPositions = [
    [-0.9, 0, 1.1],
    [0.9,  0, 1.1],
    [-0.9, 0, -1.1],
    [0.9,  0, -1.1],
  ];
  const allWheelMeshes = [];
  wheelPositions.forEach((pos, idx) => {
    const geo = new THREE.CylinderGeometry(0.32, 0.32, 0.28, 8);
    const wheel = new THREE.Mesh(geo, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(...pos);

    // Hubcap
    const capGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.3, 6);
    const cap = new THREE.Mesh(capGeo, detailMat);
    cap.rotation.z = Math.PI / 2;
    cap.position.set(pos[0] < 0 ? -0.16 : 0.16, 0, 0);
    wheel.add(cap);

    group.add(wheel);
    allWheelMeshes.push(wheel);
  });

  // Headlights
  const lightMat = new THREE.MeshLambertMaterial({ color: 0xffffcc, emissive: 0xffffcc, emissiveIntensity: 0.5 });
  for (const x of [-0.55, 0.55]) {
    const geo = new THREE.BoxGeometry(0.3, 0.15, 0.08);
    const light = new THREE.Mesh(geo, lightMat);
    light.position.set(x, 0.3, 1.61);
    group.add(light);
  }

  // Tail lights
  const tailMat = new THREE.MeshLambertMaterial({ color: 0xff2200, emissive: 0xff2200, emissiveIntensity: 0.3 });
  for (const x of [-0.55, 0.55]) {
    const geo = new THREE.BoxGeometry(0.3, 0.15, 0.08);
    const tail = new THREE.Mesh(geo, tailMat);
    tail.position.set(x, 0.3, -1.61);
    group.add(tail);
  }

  group.userData.wheels = allWheelMeshes;

  return group;
}

// ── Build Scene ───────────────────────────────────────────────────────────────
const roadMesh = buildRoadMesh();
scene.add(roadMesh);
scene.add(buildMarkings());
// scene.add(buildKerbs()); // skip kerbs for perf
scene.add(buildGround());
scene.add(buildScenery());
scene.add(buildStartLine());

const carMesh = buildCar();
carMesh.visible = false;
scene.add(carMesh);

// Stars / particles
(function buildStars() {
  const count = 800;
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i*3]   = (Math.random() - 0.5) * 400;
    pos[i*3+1] = 20 + Math.random() * 80;
    pos[i*3+2] = (Math.random() - 0.5) * 400;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.4, sizeAttenuation: true });
  scene.add(new THREE.Points(geo, mat));
})();

// ── Car Physics State ─────────────────────────────────────────────────────────
const car = {
  position: new THREE.Vector3(),
  velocity: new THREE.Vector3(),
  rotation: 0,
  speed: 0,
  steerAngle: 0,
  trackT: 0,
  trackTLap: 0,
  lap: 1,
  lapTimes: [],
  lapStart: 0,
  raceStart: 0,
  running: false,
  finished: false,
  vertVel: 0,
  wheelRot: 0,
  // Visual-only smoothed values (decoupled from physics)
  visualY: 0,
  smoothTiltX: 0,
  smoothTiltZ: 0,
};

const keys = {};
let camMode = 0;
const CAM_MODE_NAMES = ['CHASE', 'LOW', 'COCKPIT', 'OVERHEAD'];

document.addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'KeyC') {
    camMode = (camMode + 1) % CAM_MODE_NAMES.length;
    const el = document.getElementById('cam-mode');
    if (el) el.textContent = CAM_MODE_NAMES[camMode];
  }
});
document.addEventListener('keyup', e => { keys[e.code] = false; });

// ── Track helpers ─────────────────────────────────────────────────────────────
// Get road surface normal and height at a given t
function getRoadSurface(t) {
  const tClamped = ((t % 1) + 1) % 1;
  const idx = Math.floor(tClamped * ROAD_SEGS);
  const pt = CURVE_PTS[idx];
  const tang = FRAMES.tangents[idx];
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(tang, up).normalize();
  const norm = new THREE.Vector3().crossVectors(right, tang).normalize();
  if (norm.y < 0) norm.negate();
  return { pt, tang, right, norm };
}

// Find closest track T to a world position
function findClosestT(worldPos, hintT) {
  let bestT = hintT;
  let bestDist = Infinity;
  const steps = 30;
  const range = 0.05;
  for (let i = 0; i <= steps; i++) {
    const t = ((hintT - range/2 + (range * i / steps)) + 1) % 1;
    const pt = trackCurve.getPoint(t);
    const d = worldPos.distanceTo(pt);
    if (d < bestDist) { bestDist = d; bestT = t; }
  }
  return bestT;
}

// ── Spawn car at start ─────────────────────────────────────────────────────────
function resetCar(t = 0) {
  const { pt, tang } = getRoadSurface(t);
  car.position.set(pt.x, getTerrainY(pt.x, pt.z) + 0.35, pt.z);
  car.speed = 0;
  car.steerAngle = 0;
  car.vertVel = 0;
  car.trackT = t;
  car.trackTLap = t;
  car.visualY = car.position.y;
  car.smoothTiltX = 0;
  car.smoothTiltZ = 0;
  car.rotation = Math.atan2(tang.x, tang.z);

  carMesh.position.copy(car.position);
  carMesh.rotation.y = car.rotation;
}

// ── HUD Helpers ───────────────────────────────────────────────────────────────
function fmtTime(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000));
  return `${m}:${String(s).padStart(2,'0')}.${String(cs).padStart(3,'0')}`;
}

let bestLapTime = Infinity;

function updateHUD(dt) {
  if (!car.running) return;
  const elapsed = performance.now() - car.lapStart;
  document.getElementById('cur-time').textContent = fmtTime(elapsed);
  const speedKmh = Math.abs(car.speed) * 3.6;
  document.getElementById('speed-val').textContent = Math.round(speedKmh);
  document.getElementById('lap-num').textContent = `${car.lap} / ${TOTAL_LAPS}`;

  // Lap list
  const list = document.getElementById('lap-list');
  list.innerHTML = car.lapTimes.map((lt, i) => {
    const isBest = lt === bestLapTime;
    return `<div class="lap-row"><span>Lap ${i+1}</span><span class="${isBest ? 'best' : ''}">${fmtTime(lt)}</span></div>`;
  }).join('');
}

// ── Mini Map ──────────────────────────────────────────────────────────────────
const miniCanvas = document.getElementById('mini-map');
const miniCtx = miniCanvas.getContext('2d');

// Precompute map bounds
let mapMinX = Infinity, mapMaxX = -Infinity, mapMinZ = Infinity, mapMaxZ = -Infinity;
CURVE_PTS.forEach(p => {
  mapMinX = Math.min(mapMinX, p.x); mapMaxX = Math.max(mapMaxX, p.x);
  mapMinZ = Math.min(mapMinZ, p.z); mapMaxZ = Math.max(mapMaxZ, p.z);
});
const mapPad = 8;

function worldToMap(x, z) {
  const W = miniCanvas.width - mapPad * 2;
  const H = miniCanvas.height - mapPad * 2;
  const mx = mapPad + ((x - mapMinX) / (mapMaxX - mapMinX)) * W;
  const mz = mapPad + ((z - mapMinZ) / (mapMaxZ - mapMinZ)) * H;
  return [mx, mz];
}

function drawMiniMap() {
  miniCtx.clearRect(0, 0, miniCanvas.width, miniCanvas.height);
  miniCtx.fillStyle = 'rgba(0,0,0,0.5)';
  miniCtx.fillRect(0, 0, miniCanvas.width, miniCanvas.height);

  // Track
  miniCtx.strokeStyle = '#555';
  miniCtx.lineWidth = 3;
  miniCtx.beginPath();
  CURVE_PTS.forEach((p, i) => {
    const [mx, mz] = worldToMap(p.x, p.z);
    i === 0 ? miniCtx.moveTo(mx, mz) : miniCtx.lineTo(mx, mz);
  });
  miniCtx.closePath();
  miniCtx.stroke();

  // Car dot
  const [cx, cz] = worldToMap(car.position.x, car.position.z);
  miniCtx.fillStyle = '#4eff91';
  miniCtx.beginPath();
  miniCtx.arc(cx, cz, 3.5, 0, Math.PI * 2);
  miniCtx.fill();
}

// ── Camera ────────────────────────────────────────────────────────────────────
const camPos = new THREE.Vector3();
const camTarget = new THREE.Vector3();

function updateCamera() {
  const fwd = new THREE.Vector3(Math.sin(car.rotation), 0, Math.cos(car.rotation));
  const carEye = car.position.clone().add(new THREE.Vector3(0, car.visualY - car.position.y + 1, 0));

  let desiredPos, desiredTarget, lerpPos, lerpTgt;

  if (camMode === 0) {
    // Standard chase — behind and above
    desiredPos = car.position.clone()
      .addScaledVector(fwd, -CAMERA_DIST)
      .add(new THREE.Vector3(0, CAMERA_HEIGHT, 0));
    desiredTarget = carEye;
    lerpPos = 0.10; lerpTgt = 0.14;

  } else if (camMode === 1) {
    // Low bumper cam — tight and dramatic
    desiredPos = car.position.clone()
      .addScaledVector(fwd, -4.5)
      .add(new THREE.Vector3(0, 1.2, 0));
    desiredTarget = car.position.clone()
      .addScaledVector(fwd, 8)
      .add(new THREE.Vector3(0, 0.5, 0));
    lerpPos = 0.14; lerpTgt = 0.18;

  } else if (camMode === 2) {
    // Cockpit — first-person from driver's seat
    desiredPos = car.position.clone()
      .addScaledVector(fwd, 0.6)
      .add(new THREE.Vector3(0, 1.15, 0));
    desiredTarget = car.position.clone()
      .addScaledVector(fwd, 20)
      .add(new THREE.Vector3(0, 0.8, 0));
    lerpPos = 0.22; lerpTgt = 0.22;

  } else {
    // Overhead bird's-eye
    desiredPos = car.position.clone().add(new THREE.Vector3(0, 28, 0));
    desiredTarget = car.position.clone();
    lerpPos = 0.07; lerpTgt = 0.10;
  }

  camPos.lerp(desiredPos, lerpPos);
  camTarget.lerp(desiredTarget, lerpTgt);

  camera.position.copy(camPos);
  camera.lookAt(camTarget);
}

// ── Lap Detection ─────────────────────────────────────────────────────────────
let prevT = 0;
function checkLap(newT, prevT) {
  // Detect crossing t=0 boundary
  const crossed = (prevT > 0.85 && newT < 0.15);
  return crossed;
}

// ── Game Loop ─────────────────────────────────────────────────────────────────
let lastTime = 0;

function update(ts) {
  const dt = Math.min((ts - lastTime) / 1000, 0.05);
  lastTime = ts;

  if (!car.running || car.finished) {
    if (car.running) updateCamera();
    return;
  }

  // ── Input ─────────────────────────────────────────────────────────────────
  const accel   = keys['KeyW'] || keys['ArrowUp'];
  const brake   = keys['KeyS'] || keys['ArrowDown'];
  const left    = keys['KeyA'] || keys['ArrowLeft'];
  const right   = keys['KeyD'] || keys['ArrowRight'];
  const handbrake = keys['Space'];
  const reset   = keys['KeyR'];

  if (reset) { resetCar(car.trackT); return; }

  // ── Steering ──────────────────────────────────────────────────────────────
  // Steering authority shrinks at higher speeds for stability
  const speedFactor = Math.abs(car.speed);
  const maxSteer = CAR_STEER_MAX / (1 + speedFactor * 0.05);

  if (left)  car.steerAngle = Math.min(car.steerAngle + CAR_STEER_SPEED * dt,  maxSteer);
  else if (right) car.steerAngle = Math.max(car.steerAngle - CAR_STEER_SPEED * dt, -maxSteer);
  // Frame-rate independent return to center
  else car.steerAngle *= Math.pow(0.80, dt * 60);

  // ── Acceleration ──────────────────────────────────────────────────────────
  if (accel) {
    car.speed += CAR_ACCEL * dt;
  } else if (brake) {
    if (car.speed > 0.5) car.speed -= CAR_BRAKE * dt;
    else if (car.speed > -8) car.speed -= (CAR_ACCEL * 0.6) * dt;
  }

  // Drag & max speed
  const drag = handbrake ? HANDBRAKE_DRAG : CAR_DRAG;
  car.speed *= Math.pow(drag, dt * 60);
  car.speed = Math.max(-15, Math.min(MAX_SPEED, car.speed));

  // ── Rotation ─────────────────────────────────────────────────────────────
  if (Math.abs(car.speed) > 0.5) {
    const steerEffect = (car.speed > 0 ? 1 : -1) * car.steerAngle;
    // 0.028 instead of 0.045 — less twitchy
    const turnRate = steerEffect * Math.abs(car.speed) * 0.028;
    car.rotation += turnRate * dt * 60;
  }

  // ── Movement ──────────────────────────────────────────────────────────────
  const fwd = new THREE.Vector3(Math.sin(car.rotation), 0, Math.cos(car.rotation));
  car.position.addScaledVector(fwd, car.speed * dt);

  // ── Ground collision via terrain height function ──────────────────────────
  car.trackT = findClosestT(car.position, car.trackT);
  const surf = getRoadSurface(car.trackT);          // still needed for tilt
  const roadY = getTerrainY(car.position.x, car.position.z) + 0.35;

  if (car.position.y > roadY + 0.5) {
    car.vertVel -= GRAVITY * dt;
    car.position.y += car.vertVel * dt;
    if (car.position.y < roadY) {
      car.position.y = roadY;
      car.vertVel = 0;
    }
  } else {
    car.position.y = roadY;
    car.vertVel = 0;
  }

  // ── Lap tracking ─────────────────────────────────────────────────────────
  const prevLapT = ((car.trackTLap % 1) + 1) % 1;
  const newT = car.trackT;

  if (checkLap(newT, prevLapT)) {
    const lapTime = performance.now() - car.lapStart;
    car.lapTimes.push(lapTime);
    if (lapTime < bestLapTime) bestLapTime = lapTime;

    if (car.lap >= TOTAL_LAPS) {
      // Race finished
      car.finished = true;
      car.running = false;
      showFinish();
    } else {
      car.lap++;
      car.lapStart = performance.now();
    }
  }
  car.trackTLap = car.trackT;

  // ── Car mesh update (smooth visuals) ─────────────────────────────────────
  // Suspension: visual Y lerps toward physics Y with a slight bounce
  car.visualY += (car.position.y - car.visualY) * Math.min(1, dt * 14);
  carMesh.position.set(car.position.x, car.visualY, car.position.z);
  carMesh.rotation.y = car.rotation;

  // Pitch tilt from slope
  const targetTiltX = Math.asin(Math.max(-1, Math.min(1, surf.norm.z * 0.6)));
  car.smoothTiltX += (targetTiltX - car.smoothTiltX) * Math.min(1, dt * 8);
  carMesh.rotation.x = car.smoothTiltX;

  // Roll tilt from cornering
  const targetTiltZ = -car.steerAngle * Math.min(1, Math.abs(car.speed) / 20) * 0.15;
  car.smoothTiltZ += (targetTiltZ - car.smoothTiltZ) * Math.min(1, dt * 10);
  carMesh.rotation.z = car.smoothTiltZ;

  // Wheel spin
  car.wheelRot += car.speed * dt * 3;
  const wheels = carMesh.userData.wheels;
  if (wheels) {
    wheels.forEach(w => { w.rotation.x = car.wheelRot; });
  }

  // ── Camera & HUD ──────────────────────────────────────────────────────────
  updateCamera();
  updateHUD(dt);
  drawMiniMap();
}

function gameLoop(ts) {
  update(ts);
  renderer.render(scene, camera);
  requestAnimationFrame(gameLoop);
}

// ── UI Logic ──────────────────────────────────────────────────────────────────
function startRace() {
  car.lap = 1;
  car.lapTimes = [];
  car.lapStart = performance.now();
  car.raceStart = performance.now();
  car.finished = false;
  car.running = true;

  resetCar(0);
  carMesh.visible = true;
  camPos.copy(car.position).add(new THREE.Vector3(0, 5, -10));
  camTarget.copy(car.position);

  document.getElementById('overlay').style.display = 'none';
}

function showFinish() {
  const total = car.lapTimes.reduce((a,b) => a+b, 0);
  const best = Math.min(...car.lapTimes);
  let html = '';
  car.lapTimes.forEach((lt, i) => {
    const isBest = lt === best;
    html += `Lap ${i+1}: <strong style="color:${isBest ? '#4eff91':'#fff'}">${fmtTime(lt)}${isBest ? ' ★' : ''}</strong><br>`;
  });
  html += `<br>Total: <strong style="color:#ffe04e">${fmtTime(total)}</strong>`;
  if (best < Infinity) html += `<br>Best Lap: <strong style="color:#4eff91">${fmtTime(best)}</strong>`;

  document.getElementById('finish-times').innerHTML = html;
  document.getElementById('start-screen').style.display = 'none';
  document.getElementById('finish-msg').style.display = 'flex';
  document.getElementById('overlay').style.display = 'flex';
}

document.getElementById('start-btn').addEventListener('click', startRace);
document.getElementById('restart-btn').addEventListener('click', () => {
  bestLapTime = Infinity;
  startRace();
});

// Initial camera position
camera.position.set(20, 15, 20);
camera.lookAt(0, 0, 0);

// Start render loop
requestAnimationFrame(gameLoop);
