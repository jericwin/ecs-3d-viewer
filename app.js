import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// Model data is in mm. Source axes: X width, Y depth (front = 0, back = +160), Z height.
// three.js axes: X width, Y height, Z toward viewer (front).  (x, y, z) -> (x, z, -y)
const CAP = 0.716;
const EXPLODE = {
  rear_cover: [0, 0, -300], panel: [0, 0, 320], modules: [0, 0, 560], side: [200, 0, 0], enclosure: [0, 0, 0],
};
const BOARD_GAP = 750;
const V = (p) => new THREE.Vector3(p[0], p[2], -p[1]);
const $ = (s) => document.querySelector(s);
const fmt = (v) => v.toFixed(1);

// ---------------------------------------------------------------- renderer / scene
const viewer = $('#viewer');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewer.appendChild(renderer.domElement);
const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.className = 'labels';
viewer.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeef1f4);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a96a3, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-600, 1200, 1400);
scene.add(sun);
const fill = new THREE.DirectionalLight(0xffffff, 0.5);
fill.position.set(900, 300, -600);
scene.add(fill);

const persp = new THREE.PerspectiveCamera(35, 1, 1, 30000);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -30000, 30000);
let camera = persp;
let controls = makeControls(camera);
function makeControls(cam) {
  const c = new OrbitControls(cam, renderer.domElement);
  c.enableDamping = true;
  c.dampingFactor = 0.12;
  return c;
}

const grid = new THREE.GridHelper(3000, 60, 0x8f9ba6, 0xcfd6dc);
grid.position.y = -0.5;
scene.add(grid);

const root = new THREE.Group();
scene.add(root);

// ---------------------------------------------------------------- materials
const matCache = new Map();
const allMats = new Set();
function mat(color) {
  if (!matCache.has(color)) {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.08 });
    matCache.set(color, m);
    allMats.add(m);
  }
  return matCache.get(color);
}
const shellMats = [];
const edgeMat = new THREE.LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.35 });
const textMats = [];

// ---------------------------------------------------------------- build model
const boards = {};
const pickables = [];
let model = null;

function addBox(pr, parent, ud) {
  const [x, y, z] = pr.p, [dx, dy, dz] = pr.s;
  const g = new THREE.BoxGeometry(dx, dz, dy);
  const isShell = pr.g === 'rear_cover' || (pr.g === 'enclosure' && pr.n.startsWith('1 - Enclosure /'));
  let m;
  if (isShell) {
    m = new THREE.MeshStandardMaterial({ color: pr.c, roughness: 0.55, metalness: 0.15 });
    shellMats.push(m);
    allMats.add(m);
  } else m = mat(pr.c);
  const mesh = new THREE.Mesh(g, m);
  mesh.position.copy(V([x + dx / 2, y + dy / 2, z + dz / 2]));
  mesh.userData = ud;
  if (dx * dy * dz > 40) {
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(g), edgeMat);
    e.userData.edge = true;
    mesh.add(e);
  }
  parent.add(mesh);
  pickables.push(mesh);
}

function addCyl(pr, parent, ud) {
  const a = new THREE.Vector3(pr.a[0], pr.a[2], -pr.a[1]).normalize();
  const g = new THREE.CylinderGeometry(pr.r, pr.r, pr.L, 28);
  const mesh = new THREE.Mesh(g, mat(pr.c));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), a);
  mesh.position.copy(V(pr.p)).addScaledVector(a, pr.L / 2);
  mesh.userData = ud;
  parent.add(mesh);
  pickables.push(mesh);
}

const measureCtx = document.createElement('canvas').getContext('2d');
function addText(pr, parent, labels) {
  const lines = pr.s.split('\n');
  const px = 72;
  const font = `${pr.b ? 700 : 400} ${px}px Arial, Helvetica, sans-serif`;
  measureCtx.font = font;
  const mmPerPx = (pr.h / CAP) / px;
  const step = (pr.h * pr.ls) / mmPerPx;
  const capPx = CAP * px;
  const pad = 6;
  const wPx = Math.ceil(Math.max(...lines.map((l) => measureCtx.measureText(l).width)) + pad * 2);
  const hPx = Math.ceil((lines.length - 1) * step + capPx * 1.8);
  const cv = document.createElement('canvas');
  cv.width = wPx;
  cv.height = hPx;
  const ctx = cv.getContext('2d');
  ctx.font = font;
  ctx.fillStyle = pr.c;
  ctx.textAlign = pr.ha;
  ctx.textBaseline = 'alphabetic';
  const xa = pr.ha === 'left' ? pad : pr.ha === 'right' ? wPx - pad : wPx / 2;
  const n = lines.length;
  lines.forEach((l, i) => {
    const yc = hPx / 2 - ((n - 1) / 2 - i) * step;
    ctx.fillText(l, xa, yc + capPx / 2);
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const W = wPx * mmPerPx, H = hPx * mmPerPx;
  const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  textMats.push(m);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W, H), m);
  const ex = V(pr.ex).normalize(), ey = V(pr.ey).normalize();
  const nrm = new THREE.Vector3().crossVectors(ex, ey);
  mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(ex, ey, nrm));
  const offx = pr.ha === 'left' ? W / 2 - pad * mmPerPx : pr.ha === 'right' ? -W / 2 + pad * mmPerPx : 0;
  mesh.position.copy(V(pr.p)).addScaledVector(ex, offx).addScaledVector(nrm, 0.15);
  mesh.renderOrder = 2;
  parent.add(mesh);
  labels.push(mesh);
}

function buildBoard(key, data) {
  const bg = new THREE.Group();
  bg.name = 'board-' + key;
  const groups = {};
  for (const g of Object.keys(EXPLODE)) {
    groups[g] = new THREE.Group();
    bg.add(groups[g]);
  }
  const labels = [];
  for (const pr of data.prims) {
    const parent = groups[pr.g] || groups.enclosure;
    const ud = { part: pr.n || 'Enclosure', board: key, group: pr.g };
    if (pr.t === 'box') addBox(pr, parent, ud);
    else if (pr.t === 'cyl') addCyl(pr, parent, ud);
    else addText(pr, parent, labels);
  }
  const dims = buildDims();
  bg.add(dims);
  root.add(bg);
  boards[key] = { group: bg, groups, labels, dims, name: data.name, color: data.color };
}

function arrow(from, to, color) {
  const dir = new THREE.Vector3().subVectors(to, from).normalize();
  const cone = new THREE.Mesh(new THREE.ConeGeometry(3.2, 14, 12), new THREE.MeshBasicMaterial({ color }));
  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  cone.position.copy(to).addScaledVector(dir, -7);
  return cone;
}
function dimLine(a, b, extA, extB, text, color = 0xb71c1c) {
  const g = new THREE.Group();
  const lm = new THREE.LineBasicMaterial({ color });
  const pts = [a, b, extA[0], extA[1], extB[0], extB[1]];
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lm));
  g.add(arrow(b, a, color), arrow(a, b, color));
  const div = document.createElement('div');
  div.className = 'dlabel';
  div.textContent = text;
  const lbl = new CSS2DObject(div);
  lbl.position.copy(a).add(b).multiplyScalar(0.5);
  g.add(lbl);
  return g;
}
function buildDims() {
  const g = new THREE.Group();
  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  g.add(dimLine(v(0, 0, 70), v(450, 0, 70), [v(0, 0, 5), v(0, 0, 80)], [v(450, 0, 5), v(450, 0, 80)], '450 mm'));
  g.add(dimLine(v(-70, 0, 0), v(-70, 650, 0), [v(-5, 0, 0), v(-80, 0, 0)], [v(-5, 650, 0), v(-80, 650, 0)], '650 mm'));
  g.add(dimLine(v(530, 0, 0), v(530, 0, -160), [v(455, 0, 0), v(540, 0, 0)], [v(455, 0, -160), v(540, 0, -160)], '160 mm'));
  return g;
}

// ---------------------------------------------------------------- state
const state = { board: 'A', mode: 'select', explode: 0, selected: null, measA: null };

function layoutBoards() {
  const show = state.board === 'both' ? ['A', 'B'] : [state.board];
  for (const k of Object.keys(boards)) {
    const b = boards[k];
    b.group.visible = show.includes(k);
    b.group.position.x = state.board === 'both' && k === 'B' ? BOARD_GAP : 0;
  }
  setExplode(state.explode);
  renderSensorList();
}

function setExplode(f) {
  state.explode = f;
  for (const b of Object.values(boards)) {
    for (const [g, vec] of Object.entries(EXPLODE)) b.groups[g].position.set(vec[0] * f, vec[1] * f, vec[2] * f);
    b.dims.visible = $('#tDims').checked && f < 0.02;
    b.dims.traverse((o) => { if (o.isCSS2DObject) o.visible = b.dims.visible && b.group.visible; });
  }
  $('#explode').value = Math.round(f * 100);
  $('#explodeVal').textContent = Math.round(f * 100) + '%';
}

// ---------------------------------------------------------------- camera views
function visibleBox() {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const b of Object.values(boards)) if (b.group.visible) box.expandByObject(b.group);
  if (box.isEmpty()) box.set(new THREE.Vector3(0, 0, -160), new THREE.Vector3(450, 650, 0));
  return box;
}
const VIEWS = {
  iso: [0.9, 0.55, 1.25], front: [0, 0, 1], right: [1, 0, 0], left: [-1, 0, 0], top: [0, 1, 0.0001], back: [0, 0, -1],
};
function setView(name, box = visibleBox()) {
  const c = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const r = size.length() / 2;
  const dist = r / Math.tan(THREE.MathUtils.degToRad(persp.fov / 2)) * 1.05;
  const d = new THREE.Vector3(...VIEWS[name]).normalize();
  persp.position.copy(c).addScaledVector(d, dist);
  persp.up.set(0, 1, 0);
  controls.target.copy(c);
  if (camera === ortho) syncOrtho(r * 1.15);
  camera.lookAt(c);
  controls.update();
}
function syncOrtho(halfH) {
  const dist = persp.position.distanceTo(controls.target);
  const h = halfH ?? dist * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2));
  const asp = viewer.clientWidth / viewer.clientHeight;
  ortho.left = -h * asp; ortho.right = h * asp; ortho.top = h; ortho.bottom = -h;
  ortho.zoom = 1;
  ortho.position.copy(persp.position);
  ortho.up.copy(persp.up);
  ortho.updateProjectionMatrix();
}
function setOrtho(on) {
  const target = controls.target.clone();
  if (on) {
    persp.position.copy(camera.position);
    syncOrtho();
    camera = ortho;
  } else {
    if (camera === ortho) {
      const dir = new THREE.Vector3().subVectors(ortho.position, target).normalize();
      const h = (ortho.top - ortho.bottom) / 2 / ortho.zoom;
      const dist = h / Math.tan(THREE.MathUtils.degToRad(persp.fov / 2));
      persp.position.copy(target).addScaledVector(dir, dist);
    }
    camera = persp;
  }
  controls.dispose();
  controls = makeControls(camera);
  controls.target.copy(target);
  camera.lookAt(target);
  controls.update();
}

function resize() {
  const w = viewer.clientWidth, h = viewer.clientHeight;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  persp.aspect = w / h;
  persp.updateProjectionMatrix();
  if (camera === ortho) {
    const half = (ortho.top - ortho.bottom) / 2;
    ortho.left = -half * w / h; ortho.right = half * w / h;
    ortho.updateProjectionMatrix();
  }
}
new ResizeObserver(resize).observe(viewer);

// ---------------------------------------------------------------- picking
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 80);

function pick(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(pickables.filter(visibleDeep), false);
  for (const h of hits) {
    if (renderer.clippingPlanes.length && clipPlane.distanceToPoint(h.point) < 0) continue;
    return h;
  }
  return null;
}
function visibleDeep(o) {
  for (let p = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}
function toScreen(p) {
  const v = p.clone().project(camera);
  return new THREE.Vector2((v.x + 1) / 2 * viewer.clientWidth, (1 - v.y) / 2 * viewer.clientHeight);
}
// Snap to the nearest vertex of the hit object (box corners, cylinder rims) within 14 px.
function snapPoint(hit, ev) {
  if (!$('#snap').checked || ev.shiftKey) return { p: hit.point.clone(), snapped: false };
  const pos = hit.object.geometry.attributes.position;
  const r = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(ev.clientX - r.left, ev.clientY - r.top);
  let best = null, bd = 14;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(hit.object.matrixWorld);
    const d = toScreen(v).distanceTo(mouse);
    if (d < bd) { bd = d; best = v.clone(); }
  }
  return best ? { p: best, snapped: true } : { p: hit.point.clone(), snapped: false };
}
// world -> board-local coordinates (mm): X from left edge, Y up from base, Z depth from front face
function local(p) {
  const bx = state.board === 'both' && p.x > BOARD_GAP - 100 ? BOARD_GAP : 0;
  return { x: p.x - bx, y: p.y, z: -p.z };
}

// ---------------------------------------------------------------- selection
const hlMats = new Map();
function highlight(mesh, on) {
  if (on) {
    if (!mesh.userData.base) mesh.userData.base = mesh.material;
    const base = mesh.userData.base;
    if (!hlMats.has(base)) {
      const m = base.clone();
      m.emissive = new THREE.Color(0x2f81f7);
      m.emissiveIntensity = 0.55;
      hlMats.set(base, m);
      allMats.add(m);
    }
    mesh.material = hlMats.get(base);
  } else if (mesh.userData.base) mesh.material = mesh.userData.base;
}
function partMeshes(board, part) {
  return pickables.filter((m) => m.userData.board === board && m.userData.part === part);
}
function select(board, part, focus = false) {
  if (state.selected) partMeshes(state.selected.board, state.selected.part).forEach((m) => highlight(m, false));
  state.selected = part ? { board, part } : null;
  document.querySelectorAll('#sensorList li').forEach((li) => li.classList.toggle('on', !!part && part.startsWith(li.dataset.code + ' ')));
  if (!part) {
    $('#selBody').innerHTML = 'Nothing selected. Use the Select tool, or pick a sensor from the list below.';
    $('#selBody').className = 'hint';
    return;
  }
  root.updateMatrixWorld(true);
  const meshes = partMeshes(board, part);
  meshes.forEach((m) => highlight(m, true));
  const box = new THREE.Box3();
  meshes.forEach((m) => box.expandByObject(m));
  const s = box.getSize(new THREE.Vector3());
  const lo = local(box.min), hi = local(box.max);
  const b = boards[board];
  $('#selBody').className = '';
  $('#selBody').innerHTML = `<div class="name">${part}</div>
    <dl><dt>Board</dt><dd><span class="dot" style="background:${b.color}"></span> ${b.name}</dd>
    <dt>Size W×H×D</dt><dd>${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)} mm</dd>
    <dt>X range</dt><dd>${fmt(lo.x)} → ${fmt(hi.x)} mm</dd>
    <dt>Y range</dt><dd>${fmt(lo.y)} → ${fmt(hi.y)} mm</dd>
    <dt>Depth</dt><dd>${fmt(Math.min(lo.z, hi.z))} → ${fmt(Math.max(lo.z, hi.z))} mm</dd>
    <dt>Pieces</dt><dd>${meshes.length} solid(s)</dd></dl>`;
  if (focus && meshes.length) {
    const c = box.getCenter(new THREE.Vector3());
    const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
    if (dir.z < 0.3) dir.set(0.35, 0.25, 1).normalize();
    const dist = Math.max(260, s.length() * 3);
    controls.target.copy(c);
    persp.position.copy(c).addScaledVector(dir, dist);
    if (camera === ortho) syncOrtho(dist * 0.32);
    camera.lookAt(c);
    controls.update();
  }
}

// ---------------------------------------------------------------- measuring
const measures = [];
const markerGeo = new THREE.SphereGeometry(3.2, 16, 12);
const markerMat = new THREE.MeshBasicMaterial({ color: 0xffb703, depthTest: false });
const cursor = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: 0x2f81f7, depthTest: false, transparent: true, opacity: 0.9 }));
cursor.renderOrder = 10;
cursor.visible = false;
scene.add(cursor);
let rubber = null;

function marker(p) {
  const m = new THREE.Mesh(markerGeo, markerMat);
  m.position.copy(p);
  m.renderOrder = 10;
  return m;
}
function addMeasure(a, b) {
  const g = new THREE.Group();
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]),
    new THREE.LineBasicMaterial({ color: 0xffb703, depthTest: false }));
  line.renderOrder = 9;
  g.add(line, marker(a), marker(b));
  const d = a.distanceTo(b);
  const div = document.createElement('div');
  div.className = 'mlabel';
  div.textContent = `${fmt(d)} mm`;
  const lbl = new CSS2DObject(div);
  lbl.position.copy(a).add(b).multiplyScalar(0.5);
  g.add(lbl);
  scene.add(g);
  measures.push({ g, a, b, d });
  renderMeasures();
}
function renderMeasures() {
  const ol = $('#measList');
  if (!measures.length) { ol.innerHTML = '<li class="empty">No measurements yet.</li>'; return; }
  ol.innerHTML = measures.map((m, i) => {
    const dx = Math.abs(m.b.x - m.a.x), dy = Math.abs(m.b.y - m.a.y), dz = Math.abs(m.b.z - m.a.z);
    return `<li><span class="d">#${i + 1} &nbsp;${fmt(m.d)} mm</span><br>
      <span class="dx">ΔX ${fmt(dx)} · ΔY ${fmt(dy)} · ΔZ ${fmt(dz)}</span></li>`;
  }).join('');
  ol.scrollTop = ol.scrollHeight;
}
function clearMeasures() {
  for (const m of measures) {
    m.g.traverse((o) => { if (o.isCSS2DObject) o.element.remove(); });
    scene.remove(m.g);
  }
  measures.length = 0;
  cancelMeasure();
  renderMeasures();
}
function cancelMeasure() {
  if (state.measA) { scene.remove(state.measA.marker); state.measA = null; }
  if (rubber) { scene.remove(rubber); rubber = null; }
}

// ---------------------------------------------------------------- pointer events
let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || e.button !== 0) return;
  const hit = pick(e);
  if (state.mode === 'select') {
    if (hit) select(hit.object.userData.board, hit.object.userData.part);
    else select(null, null);
    return;
  }
  if (!hit) return;
  const { p } = snapPoint(hit, e);
  if (!state.measA) {
    const mk = marker(p);
    scene.add(mk);
    state.measA = { p, marker: mk };
  } else {
    const a = state.measA.p;
    cancelMeasure();
    addMeasure(a, p);
  }
});
let pending = null;
renderer.domElement.addEventListener('pointermove', (e) => {
  if (pending) return;
  pending = requestAnimationFrame(() => {
    pending = null;
    const hit = pick(e);
    if (!hit) {
      $('#hud').textContent = 'X —   Y —   Z —';
      cursor.visible = false;
      return;
    }
    const { p, snapped } = state.mode === 'measure' ? snapPoint(hit, e) : { p: hit.point, snapped: false };
    const l = local(p);
    let t = `X ${fmt(l.x)}   Y ${fmt(l.y)}   Z(depth) ${fmt(l.z)} mm`;
    if (state.mode === 'measure') {
      cursor.visible = true;
      cursor.position.copy(p);
      cursor.material.color.set(snapped ? 0x3fb950 : 0x2f81f7);
      if (state.measA) {
        const d = state.measA.p.distanceTo(p);
        t += `   |  live ${fmt(d)} mm`;
        if (rubber) scene.remove(rubber);
        rubber = new THREE.Line(new THREE.BufferGeometry().setFromPoints([state.measA.p, p]),
          new THREE.LineDashedMaterial({ color: 0xffb703, dashSize: 6, gapSize: 4, depthTest: false }));
        rubber.computeLineDistances();
        rubber.renderOrder = 9;
        scene.add(rubber);
      }
    } else cursor.visible = false;
    $('#hud').textContent = t + (snapped ? '  (snap)' : '');
  });
});
renderer.domElement.addEventListener('pointerleave', () => { cursor.visible = false; });

function setMode(m) {
  state.mode = m;
  document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  viewer.classList.toggle('measure', m === 'measure');
  $('#modeHint').textContent = m === 'measure'
    ? 'Click a first point, then a second point. Green cursor = snapped to a corner. Hold Shift to disable snapping.'
    : 'Click any part to see its name and size.';
  cursor.visible = false;
  cancelMeasure();
}
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'Escape') { cancelMeasure(); select(null, null); }
  if (e.key === 'm' || e.key === 'M') setMode('measure');
  if (e.key === 's' || e.key === 'S') setMode('select');
});

// ---------------------------------------------------------------- UI wiring
document.querySelectorAll('#boardSeg button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#boardSeg button').forEach((x) => x.classList.toggle('on', x === b));
  state.board = b.dataset.board;
  select(null, null);
  clearMeasures();
  layoutBoards();
  setView('iso');
}));
document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
$('#clearMeas').addEventListener('click', clearMeasures);
$('#explode').addEventListener('input', (e) => setExplode(e.target.value / 100));
let anim = null;
function animateExplode(to) {
  cancelAnimationFrame(anim);
  const from = state.explode, t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 900);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    setExplode(from + (to - from) * e);
    if (k < 1) anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}
$('#explodeAnim').addEventListener('click', () => animateExplode(state.explode > 0.5 ? 0 : 1));
$('#explodeReset').addEventListener('click', () => animateExplode(0));

function updateSection() {
  const on = $('#secOn').checked;
  const v = +$('#section').value;
  $('#section').disabled = !on;
  $('#secVal').textContent = v;
  renderer.clippingPlanes = on ? [clipPlane] : [];
}
// keeps geometry whose depth from the front face is >= v  (plane: n·p + c >= 0 is kept)
function sectionPlane() {
  const v = +$('#section').value;
  clipPlane.normal.set(0, 0, -1);
  clipPlane.constant = -v;
}
$('#secOn').addEventListener('change', () => { updateSection(); sectionPlane(); });
$('#section').addEventListener('input', () => { updateSection(); sectionPlane(); });

$('#tLabels').addEventListener('change', (e) => Object.values(boards).forEach((b) => b.labels.forEach((l) => (l.visible = e.target.checked))));
$('#tDims').addEventListener('change', () => setExplode(state.explode));
$('#tGrid').addEventListener('change', (e) => (grid.visible = e.target.checked));
$('#tEdges').addEventListener('change', (e) => (edgeMat.visible = e.target.checked));
$('#tXray').addEventListener('change', (e) => shellMats.forEach((m) => {
  m.transparent = e.target.checked; m.opacity = e.target.checked ? 0.18 : 1; m.depthWrite = !e.target.checked; m.needsUpdate = true;
}));
$('#tWire').addEventListener('change', (e) => allMats.forEach((m) => { m.wireframe = e.target.checked; }));
$('#tOrtho').addEventListener('change', (e) => setOrtho(e.target.checked));
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('#shot').addEventListener('click', () => {
  renderer.render(scene, camera);
  const a = document.createElement('a');
  a.download = `ECS_board_${state.board}_view.png`;
  a.href = renderer.domElement.toDataURL('image/png');
  a.click();
});
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
}));

function renderSensorList() {
  if (!model) return;
  const key = state.board === 'both' ? 'A' : state.board;
  const ul = $('#sensorList');
  ul.innerHTML = '';
  for (const [code, name, abbr, grp, gas, dsl] of model.components) {
    const onBoard = state.board === 'both' ? (gas || dsl) : (key === 'A' ? gas : dsl);
    const li = document.createElement('li');
    li.dataset.code = code;
    li.className = onBoard ? '' : 'off';
    li.innerHTML = `<span class="code">${code}</span><span class="chip" style="background:${model.groups[grp][1]}"></span>
      <span class="nm">${name}</span><span class="ab">${abbr}</span>`;
    if (onBoard) li.addEventListener('click', () => {
      const b = state.board === 'both' ? (gas ? 'A' : 'B') : key;
      const m = pickables.find((x) => x.userData.board === b && x.userData.part.startsWith(code + ' '));
      if (m) select(b, m.userData.part, true);
    });
    ul.appendChild(li);
  }
}
function renderBom() {
  $('#bomTable').innerHTML = '<tr><th>No.</th><th>Part</th><th>Qty</th><th>Spec</th></tr>' +
    model.parts.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td></tr>`).join('');
}

// ---------------------------------------------------------------- start
function loop() {
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  requestAnimationFrame(loop);
}

fetch('model.json').then((r) => r.json()).then((data) => {
  model = data;
  for (const [k, b] of Object.entries(data.boards)) buildBoard(k, b);
  layoutBoards();
  renderBom();
  setExplode(0);
  resize();
  setView('iso');
  $('#loading').remove();
  loop();
}).catch((err) => {
  $('#loading').textContent = 'Could not load model: ' + err.message;
});
