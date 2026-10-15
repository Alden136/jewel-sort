import { PICTURES, ALBUMS } from './pictures.js';
import { compilePicture, Game } from './engine.js';
import { SaveStore } from './storage.js';
import { MosaicView } from './mosaic.js';
import { jewelURL, isLight, mix, renderPicture } from './jewels.js';
import { Sound } from './audio.js';

const $ = (id) => document.getElementById(id);
const pictures = new Map(PICTURES.map((def) => [def.id, compilePicture(def)]));

let storage = null;
try {
  storage = window.localStorage;
} catch {
  storage = null;
}
const store = new SaveStore(storage);
const save = store.load();
if (!save.seen.init) {
  save.settings.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  save.seen.init = true;
}

const sound = new Sound();
const mosaic = new MosaicView($('mosaic'), { onZoom: (z) => ($('fitBtn').hidden = !z), onTap: (x, y) => tapPicture(x, y) });
let viewerMosaic = null;

// Active level.
let pic = null;
let game = null;
let completing = false;
let coach = null;
const pending = mosaic.pending;
const flights = new Set();
const slotEls = { supply: [], hold: [] };
let popped = null; // color picked up from the jewels, waiting for a spot
let messageTimer = 0;
let freshUnlock = null;

// ------------------------------------------------------------ persistence

function persist() {
  if (game && pic && !completing) save.games[pic.id] = game.serialize();
  store.write(save);
}

document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && persist());
window.addEventListener('pagehide', persist);

// A level whose final batch committed just before the app closed is
// recorded as complete on the next launch.
for (const [id, data] of Object.entries(save.games)) {
  const p = pictures.get(id);
  const g = p && Game.restore(p, data);
  if (!g) delete save.games[id];
  else if (g.isComplete()) {
    save.completed[id] ??= Date.now();
    delete save.games[id];
  }
}

// ------------------------------------------------------------ helpers

const motion = () => !save.settings.reducedMotion;

function buzz(pattern) {
  if (save.settings.vibration && navigator.vibrate) {
    try {
      navigator.vibrate(pattern);
    } catch {
      /* unsupported */
    }
  }
}

function colorVars(el, hex) {
  el.style.setProperty('--c', hex);
  el.style.setProperty('--ink', isLight(hex) ? '#1b1838' : '#ffffff');
  el.style.setProperty('--halo', isLight(hex) ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.6)');
}

function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === id);
  window.scrollTo(0, 0);
}

function message(text, { coachTone = false, ms = 3800 } = {}) {
  const el = $('message');
  clearTimeout(messageTimer);
  el.textContent = text;
  el.classList.toggle('coach', coachTone);
  el.classList.toggle('empty', !text);
  if (text && ms) messageTimer = setTimeout(() => el.classList.add('empty'), ms);
}

let toastTimer = 0;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function colorOf(c) {
  return pic.palette[c];
}

// Animates a jewel sprite between two viewport rectangles.
function fly(color, from, to, { duration = 320, delay = 0 } = {}) {
  if (!motion() || !from) return Promise.resolve();
  const el = document.createElement('div');
  el.className = 'flyer';
  el.style.backgroundImage = `url(${jewelURL(color)})`;
  const size = from.width;
  Object.assign(el.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${size}px`, height: `${size}px` });
  document.body.append(el);
  const s = to.width / size;
  const dx = to.left + to.width / 2 - (from.left + size / 2);
  const dy = to.top + to.height / 2 - (from.top + size / 2);
  const anim = el.animate(
    [
      { transform: 'translate(0,0) scale(1)' },
      { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 30}px) scale(${(1 + s) / 2 + 0.15})`, offset: 0.5 },
      { transform: `translate(${dx}px, ${dy}px) scale(${s})` },
    ],
    { duration, delay, easing: 'cubic-bezier(.45,.05,.35,1)', fill: 'both' },
  );
  const done = anim.finished.catch(() => {}).finally(() => el.remove());
  flights.add(done);
  done.finally(() => flights.delete(done));
  return done;
}

// ------------------------------------------------------------ gallery

function pictureState(def) {
  if (save.completed[def.id]) return 'done';
  if (!isUnlocked(def)) return 'locked';
  return save.games[def.id] ? 'progress' : 'new';
}

function isUnlocked(def) {
  if (def.tutorial || save.completed[def.id]) return true;
  const album = PICTURES.filter((p) => p.album === def.album);
  const i = album.indexOf(def);
  return i === 0 || !!save.completed[album[i - 1].id];
}

function drawThumb(canvas, p, state) {
  const px = 160;
  canvas.width = canvas.height = px;
  const ctx = canvas.getContext('2d');
  const cell = Math.floor((px - 16) / Math.max(p.w, p.h));
  const x0 = (px - p.w * cell) / 2;
  const y0 = (px - p.h * cell) / 2;
  let filled = null;
  if (state === 'progress') filled = Game.restore(p, save.games[p.id])?.filledCells() ?? new Set();
  for (let i = 0; i < p.cells.length; i++) {
    const col = p.cells[i];
    if (col < 0) continue;
    const hex = p.palette[col].color;
    const lit = state === 'done' || filled?.has(i);
    let fill;
    if (lit) fill = hex;
    else if (state === 'locked' || !save.settings.showPreview) fill = 'rgba(255,255,255,0.08)';
    else fill = mix(hex, '#1a1f3d', 0.7);
    ctx.fillStyle = fill;
    ctx.fillRect(x0 + (i % p.w) * cell + 0.5, y0 + Math.floor(i / p.w) * cell + 0.5, cell - 1, cell - 1);
  }
}

function renderGallery() {
  const root = $('albums');
  root.textContent = '';
  const done = Object.keys(save.completed).filter((id) => pictures.has(id)).length;
  $('galleryProgress').textContent = `${done} of ${PICTURES.length} pictures complete`;
  for (const album of ALBUMS) {
    const sec = document.createElement('section');
    sec.className = 'album';
    const h = document.createElement('h2');
    h.textContent = album.title;
    const grid = document.createElement('div');
    grid.className = 'album-grid';
    sec.append(h, grid);
    for (const def of PICTURES.filter((p) => p.album === album.id)) {
      const p = pictures.get(def.id);
      const state = pictureState(def);
      const card = document.createElement('button');
      card.className = `card ${state}`;
      if (def.id === freshUnlock) card.classList.add('fresh');
      const canvas = document.createElement('canvas');
      drawThumb(canvas, p, state);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = state === 'locked' ? 'Locked' : p.title;
      const meta = document.createElement('span');
      meta.className = 'meta';
      if (state === 'progress') {
        const g = Game.restore(p, save.games[p.id]);
        meta.textContent = `${Math.floor((g.placedTotal() / p.cellCount) * 100)}% placed`;
      } else if (state === 'locked') {
        const prev = PICTURES[PICTURES.indexOf(def) - 1];
        meta.textContent = `Finish ${prev.title} to unlock`;
      } else {
        meta.textContent = `${p.cellCount} jewels · ${p.palette.length} colors`;
      }
      card.append(canvas, name, meta);
      const badge = document.createElement('span');
      if (state === 'done') {
        badge.className = 'badge done';
        badge.textContent = 'Done';
      } else if (state === 'locked') {
        badge.className = 'badge lock';
        badge.innerHTML = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
      } else if (def.tutorial && state === 'new') {
        badge.className = 'badge';
        badge.textContent = 'Start here';
      } else if (state === 'new') {
        badge.className = 'badge';
        badge.textContent = 'New';
      }
      if (badge.className) card.append(badge);
      card.setAttribute(
        'aria-label',
        state === 'locked' ? `Locked picture. ${meta.textContent}` : `${p.title}, ${state === 'done' ? 'complete' : meta.textContent}`,
      );
      card.addEventListener('click', () => {
        sound.ensure();
        if (state === 'locked') toast(meta.textContent);
        else if (state === 'done') openViewer(p.id);
        else openPicture(p.id);
      });
      grid.append(card);
    }
    root.append(sec);
  }
  freshUnlock = null;
}

// ------------------------------------------------------------ level

function openPicture(id, { fresh = false } = {}) {
  pic = pictures.get(id);
  game = (!fresh && Game.restore(pic, save.games[id])) || Game.create(pic);
  completing = false;
  popped = null;
  pending.clear();
  $('game').classList.remove('revealed');
  $('completeSheet').hidden = true;
  $('gameTitle').textContent = pic.title;
  buildAreas();
  showScreen('game');
  mosaic.showPreview = save.settings.showPreview;
  mosaic.highlight = null;
  mosaic.flashes.clear();
  mosaic.setPicture(pic, game.filledCells());
  mosaic.resize();
  message('');
  renderJewels();
  updateStatus();
  persist();
  if (game.isComplete()) {
    finishPicture();
    return;
  }
  startCoach();
}

function leaveGame() {
  if (!$('completeSheet').hidden) return continueToGallery();
  if (completing) return;
  persist();
  game = null;
  pic = null;
  coach = null;
  popped = null;
  renderGallery();
  showScreen('gallery');
}

function updateStatus() {
  const pct = Math.floor((game.placedTotal() / pic.cellCount) * 100);
  $('progressBar').style.width = `${pct}%`;
  $('progressText').textContent = `${pct}%`;
  $('undoBtn').disabled = !game.canUndo();
  const any = game.supply.some(Boolean) || game.hold.some(Boolean);
  $('hintBtn').disabled = !any;
  $('rearrangeBtn').disabled = !game.supply.some(Boolean);
}

// Supply and holding tray -----------------------------------------

function buildAreas() {
  for (const area of ['supply', 'hold']) {
    const root = $(area);
    root.textContent = '';
    slotEls[area] = game[area].map(() => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      root.append(slot);
      return slot;
    });
  }
}

function jewelEl(id) {
  return document.querySelector(`#game .jewel[data-id="${id}"]`);
}

function makeJewel(j, deal) {
  const p = colorOf(j.color);
  const el = document.createElement('button');
  el.className = 'jewel';
  if (deal && motion()) {
    el.classList.add('deal');
    el.style.animationDelay = `${Math.random() * 160}ms`;
  }
  el.dataset.id = j.id;
  el.dataset.color = j.color;
  colorVars(el, p.color);
  el.style.backgroundImage = `url(${jewelURL(p.color)})`;
  el.setAttribute('aria-label', `Jewel ${p.label}, ${p.name}`);
  el.innerHTML = `<span class="label">${p.label}</span>`;
  return el;
}

// Syncs both jewel areas with the game, and marks the popped color.
function renderJewels(dealt = new Set()) {
  for (const area of ['supply', 'hold']) {
    game[area].forEach((j, i) => {
      const slot = slotEls[area][i];
      const el = slot.firstElementChild;
      if ((el?.dataset.id ?? null) === (j ? String(j.id) : null)) return;
      slot.textContent = '';
      if (j) slot.append(makeJewel(j, dealt.has(j.id)));
    });
  }
  for (const el of document.querySelectorAll('#game .jewel')) {
    const on = Number(el.dataset.color) === popped;
    el.classList.toggle('popped', on);
    el.setAttribute('aria-pressed', String(on));
  }
  $('supply').classList.toggle('has-pop', popped !== null);
  $('hold').classList.toggle('has-pop', popped !== null);
  $('hold').classList.toggle('target', popped !== null && game.holdFree() > 0 && game.available(popped).some((j) => j.area === 'supply'));
  mosaic.highlight = popped;
  mosaic.draw();
}

// Picks up every jewel of a color, or puts them back down.
function popColor(color) {
  if (!game || completing) return;
  sound.select();
  clearHint();
  if (popped === color) {
    popped = null;
    renderJewels();
    message('');
    return;
  }
  popped = color;
  renderJewels();
  const p = colorOf(color);
  const n = game.available(color).length;
  if (coach?.step === 'pop') {
    coach.step = 'place';
    clearCoachMarks();
    message(`Now tap a glowing spot in the picture to set every color ${p.label} jewel in place.`, { coachTone: true, ms: 0 });
    return;
  }
  message(`Picked up ${n} of color ${p.label}. Tap a glowing spot or the tray.`);
}

function placeAt(cell) {
  const color = popped;
  const level = pic;
  const from = new Map(game.available(color).map((j) => [j.id, jewelEl(j.id)?.getBoundingClientRect()]));
  const r = game.place(color, cell);
  if (!r.ok) return;
  persist();
  if (motion()) for (const p of r.placements) pending.add(p.cell);
  mosaic.filled = game.filledCells();
  popped = null;
  renderJewels(new Set(r.dealt.map((d) => d.jewel.id)));
  updateStatus();
  sound.cascade(Math.min(r.placements.length, 10));
  buzz([10, 40, 10]);

  const hex = colorOf(color).color;
  r.placements.forEach((p, k) => {
    fly(hex, from.get(p.id), mosaic.cellRect(p.cell), { duration: 480, delay: k * 45 }).then(() => {
      if (pic !== level) return;
      pending.delete(p.cell);
      mosaic.pop(p.cell);
    });
  });

  if (coach?.step === 'place') {
    coach.step = 'done';
    message('Nice! The tray at the bottom holds jewels while you gather more of a color.', { coachTone: true, ms: 7000 });
  } else {
    message('');
  }
  if (r.introduced.length) {
    const names = r.introduced.map((c) => colorOf(c).label).join(', ');
    toast(`Color ${colorOf(r.completedColor).label} finished — color ${names} joins the jewels`);
  } else if (r.completedColor !== null && !r.finished) {
    toast(`Color ${colorOf(r.completedColor).label} finished`);
  }
  if (r.finished) {
    completing = true;
    Promise.all([...flights]).then(finishPicture);
  }
}

function stashPopped() {
  if (!game || completing || popped === null) return;
  const before = new Map();
  for (const j of game.available(popped)) before.set(j.id, jewelEl(j.id)?.getBoundingClientRect());
  const r = game.stash(popped);
  if (!r.ok) {
    sound.nope();
    message(r.reason === 'full' ? 'The tray is full. Place some jewels in the picture first.' : 'Those jewels are already in the tray.');
    return;
  }
  persist();
  sound.click(r.moves.length);
  buzz(8);
  renderJewels(new Set(r.dealt.map((d) => d.jewel.id)));
  updateStatus();
  animateFrom(r.moves.map((m) => [m.id, before.get(m.id)]));
  if (r.left) message(`The tray is full. ${r.left} more stay picked up in the jewels above.`);
}

// Slides re-rendered jewels from where they used to be.
function animateFrom(pairs, scale = 1) {
  if (!motion()) return;
  for (const [id, old] of pairs) {
    const el = jewelEl(id);
    if (!el || !old) continue;
    const now = el.getBoundingClientRect();
    el.animate(
      [
        { transform: `translate(${old.left - now.left}px, ${old.top - now.top}px) scale(${scale})` },
        { transform: 'none' },
      ],
      { duration: 320, easing: 'cubic-bezier(.3,.7,.3,1)' },
    );
  }
}

// Picture taps place the popped color at the tapped spot.
function tapPicture(x, y) {
  if (!game || completing) return;
  sound.ensure();
  if (popped === null) {
    const cell = mosaic.cellAt(x, y);
    if (cell >= 0 && pic.cells[cell] >= 0 && !game.isFilled(cell)) message('Tap a jewel first, then tap the spot where it goes.');
    return;
  }
  const hit = mosaic.cellAt(x, y);
  const emptyHit = hit >= 0 && pic.cells[hit] >= 0 && !game.isFilled(hit);
  if (emptyHit && pic.cells[hit] !== popped) {
    sound.nope();
    buzz(20);
    message(`That spot is for color ${colorOf(pic.cells[hit]).label}. Look for the glowing color ${colorOf(popped).label} spots.`);
    return;
  }
  // A tap on a filled cell or a gap snaps to a matching spot close by.
  const cell = emptyHit ? hit : mosaic.nearestCell(x, y, (i) => pic.cells[i] === popped && !game.isFilled(i));
  if (cell >= 0) placeAt(cell);
}

// Jewel input: tap to pick up a color; drag a jewel onto the picture or tray.
function bindJewelInput() {
  let drag = null;
  const areas = [$('supply'), $('hold')];

  const onDown = (e) => {
    const el = e.target.closest('.jewel');
    if (!el || completing || drag) return;
    sound.ensure();
    drag = { el, color: Number(el.dataset.color), x: e.clientX, y: e.clientY, pid: e.pointerId, moving: false, ghost: null };
    el.setPointerCapture?.(e.pointerId);
  };

  const onMove = (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    const dist = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
    if (!drag.moving && dist > 10 && save.settings.drag) {
      drag.moving = true;
      if (popped !== drag.color) {
        popped = drag.color;
        renderJewels();
      }
      const r = drag.el.getBoundingClientRect();
      const g = drag.el.cloneNode(true);
      g.className = 'drag-ghost';
      Object.assign(g.style, { width: `${r.width * 1.15}px`, height: `${r.height * 1.15}px` });
      document.body.append(g);
      drag.ghost = g;
      drag.size = r.width * 1.15;
      drag.el.classList.add('dragging');
    }
    if (drag.moving) {
      drag.ghost.style.left = `${e.clientX - drag.size / 2}px`;
      drag.ghost.style.top = `${e.clientY - drag.size * 0.9}px`;
    }
  };

  const onUp = (e, cancelled) => {
    if (!drag || e.pointerId !== drag.pid) return;
    const d = drag;
    drag = null;
    if (!d.moving) {
      if (!cancelled && d.el.isConnected) popColor(d.color);
      return;
    }
    d.ghost.remove();
    d.el.classList.remove('dragging');
    if (cancelled) return;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    if (under?.closest('#hold')) stashPopped();
    else if (under === $('mosaic')) {
      const r = $('mosaic').getBoundingClientRect();
      tapPicture(e.clientX - r.left, e.clientY - r.top);
    }
  };

  for (const root of areas) {
    root.addEventListener('pointerdown', onDown);
    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerup', (e) => onUp(e, false));
    root.addEventListener('pointercancel', (e) => onUp(e, true));
  }
  // Tapping the tray itself (not one of its jewels) parks the popped color.
  $('hold').addEventListener('click', (e) => {
    if (!e.target.closest('.jewel')) stashPopped();
  });
}

// Helpers -------------------------------------------------------

let hintTimer = 0;
function clearHint() {
  document.querySelectorAll('.hint').forEach((el) => el.classList.remove('hint'));
}

function showHint() {
  if (!game || completing) return;
  const h = game.hint();
  if (!h) return;
  clearHint();
  jewelEl(h.jewelId)?.classList.add('hint');
  mosaic.flash([h.cell]);
  const p = colorOf(h.color);
  message(popped === h.color ? `Tap the flashing spot to place your color ${p.label} jewels.` : `Tap this color ${p.label} jewel, then the flashing spot in the picture.`);
  clearTimeout(hintTimer);
  hintTimer = setTimeout(clearHint, 2600);
}

function rearrange() {
  if (!game || completing) return;
  const before = [];
  for (const el of $('supply').querySelectorAll('.jewel')) before.push([el.dataset.id, el.getBoundingClientRect()]);
  game.rearrange();
  persist();
  renderJewels();
  animateFrom(before);
  sound.cascade(4);
}

function undo() {
  if (!game || completing) return;
  const before = [];
  for (const el of $('hold').querySelectorAll('.jewel')) before.push([el.dataset.id, el.getBoundingClientRect()]);
  const r = game.undo();
  if (!r.ok) return;
  persist();
  renderJewels();
  updateStatus();
  sound.select();
  animateFrom(before);
  if (r.back.some((b) => b.slot === null)) message('Some jewels went back to the bag. They will be dealt again.');
}

// Tutorial ------------------------------------------------------

function clearCoachMarks() {
  document.querySelectorAll('.coach').forEach((el) => el.classList.remove('coach'));
}

function startCoach() {
  coach = null;
  clearCoachMarks();
  if (!pic.tutorial || save.seen.tutorial || game.placedTotal() > 0) return;
  coach = { step: 'pop' };
  const color = game.active.reduce((a, b) => (game.available(b).length > game.available(a).length ? b : a));
  const j = game.available(color)[0];
  if (j) jewelEl(j.id)?.classList.add('coach');
  message('Tap the glowing jewel to pick up every jewel of its color.', { coachTone: true, ms: 0 });
}

// Completion ----------------------------------------------------

function finishPicture() {
  completing = true;
  coach = null;
  popped = null;
  mosaic.highlight = null;
  clearCoachMarks();
  pending.clear();
  const first = !save.completed[pic.id];
  save.completed[pic.id] ??= Date.now();
  delete save.games[pic.id];
  if (pic.tutorial) save.seen.tutorial = true;
  store.write(save);

  const def = PICTURES.find((p) => p.id === pic.id);
  const album = PICTURES.filter((p) => p.album === def.album);
  const next = album[album.indexOf(def) + 1];
  freshUnlock = first && next && !save.completed[next.id] ? next.id : null;

  $('game').classList.add('revealed');
  mosaic.filled = game.filledCells();
  requestAnimationFrame(() => {
    mosaic.resize();
    mosaic.fit();
    if (motion()) mosaic.sparkle();
  });
  sound.sparkle();
  buzz([20, 60, 20]);
  $('completeTitle').textContent = `${pic.title} complete!`;
  $('completeText').textContent =
    `${pic.cellCount} jewels placed.` + (freshUnlock ? ` ${pictures.get(freshUnlock).title} is now unlocked.` : '');
  $('completeSheet').hidden = false;
  $('continueBtn').focus({ preventScroll: true });
}

function continueToGallery() {
  completing = false;
  game = null;
  pic = null;
  renderGallery();
  showScreen('gallery');
}
$('continueBtn').addEventListener('click', continueToGallery);

// ------------------------------------------------------------ viewer

let viewerId = null;
function openViewer(id) {
  viewerId = id;
  const p = pictures.get(id);
  $('viewerTitle').textContent = p.title;
  $('viewer').hidden = false;
  if (!viewerMosaic) viewerMosaic = new MosaicView($('viewerCanvas'));
  const all = new Set();
  p.cells.forEach((c, i) => c >= 0 && all.add(i));
  viewerMosaic.setPicture(p, all);
  viewerMosaic.resize();
  if (motion()) viewerMosaic.sparkle(20);
}

$('viewerClose').addEventListener('click', () => ($('viewer').hidden = true));
$('replayBtn').addEventListener('click', () => {
  $('viewer').hidden = true;
  openPicture(viewerId, { fresh: true });
});
$('exportBtn').addEventListener('click', () => {
  const p = pictures.get(viewerId);
  const canvas = renderPicture(p, 40);
  canvas.toBlob((blob) => {
    if (!blob) return toast('Could not create the image');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jewel-mosaic-${p.id}.png`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Image saved');
  }, 'image/png');
});

// ------------------------------------------------------------ settings

const SETTINGS = [
  ['sound', 'Sound effects'],
  ['volume', 'Volume', 'range'],
  ['vibration', 'Vibration'],
  ['reducedMotion', 'Reduced motion', 'toggle', 'Jewels appear in place instead of flying'],
  ['largeJewels', 'Larger jewels'],
  ['largeText', 'Larger text'],
  ['showPreview', 'Show picture preview', 'toggle', 'Turn off to discover each picture as you sort'],
  ['drag', 'Drag jewels', 'toggle', 'Drag a jewel onto the picture or the tray. Tapping always works too'],
];

function applySettings() {
  const s = save.settings;
  const root = document.documentElement;
  root.classList.toggle('large-text', s.largeText);
  root.classList.toggle('large-jewels', s.largeJewels);
  root.classList.toggle('reduced-motion', s.reducedMotion);
  sound.enabled = s.sound;
  sound.volume = s.volume;
  mosaic.showPreview = s.showPreview;
  mosaic.draw();
}

function buildSettings() {
  const list = $('settingsList');
  list.textContent = '';
  for (const [key, label, type = 'toggle', help] of SETTINGS) {
    const row = document.createElement('label');
    row.className = 'setting';
    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.innerHTML = `<b></b>${help ? '<small></small>' : ''}`;
    txt.querySelector('b').textContent = label;
    if (help) txt.querySelector('small').textContent = help;
    const input = document.createElement('input');
    if (type === 'range') {
      Object.assign(input, { type: 'range', min: 0, max: 1, step: 0.05, value: save.settings[key] });
      input.addEventListener('input', () => {
        save.settings[key] = Number(input.value);
        applySettings();
      });
      input.addEventListener('change', () => {
        sound.click(3);
        persist();
      });
    } else {
      Object.assign(input, { type: 'checkbox', className: 'switch', checked: !!save.settings[key] });
      input.setAttribute('role', 'switch');
      input.addEventListener('change', () => {
        save.settings[key] = input.checked;
        applySettings();
        persist();
        if (key === 'vibration' && input.checked) buzz(15);
      });
    }
    row.append(txt, input);
    list.append(row);
  }
}

let restartArmed = false;
function openSettings() {
  buildSettings();
  const inGame = !!game && !completing;
  $('restartBtn').hidden = !inGame;
  $('restartBtn').textContent = 'Restart this picture';
  restartArmed = false;
  $('settings').hidden = false;
}

function closeSettings() {
  $('settings').hidden = true;
  if ($('gallery').classList.contains('active')) renderGallery();
}

$('settingsClose').addEventListener('click', closeSettings);
$('settings').addEventListener('click', (e) => e.target === $('settings') && closeSettings());
$('restartBtn').addEventListener('click', () => {
  if (!restartArmed) {
    restartArmed = true;
    $('restartBtn').textContent = 'Tap again to restart';
    return;
  }
  $('settings').hidden = true;
  delete save.games[pic.id];
  openPicture(pic.id, { fresh: true });
});

// ------------------------------------------------------------ wiring

$('gallerySettings').addEventListener('click', openSettings);
$('gameSettings').addEventListener('click', openSettings);
$('backBtn').addEventListener('click', leaveGame);
$('fitBtn').addEventListener('click', () => mosaic.fit());
$('hintBtn').addEventListener('click', showHint);
$('rearrangeBtn').addEventListener('click', rearrange);
$('undoBtn').addEventListener('click', undo);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('settings').hidden) closeSettings();
  else if (!$('viewer').hidden) $('viewer').hidden = true;
});
bindJewelInput();
applySettings();
renderGallery();

// The very first launch goes straight into the tutorial picture.
if (!save.seen.opened) {
  save.seen.opened = true;
  openPicture(PICTURES.find((p) => p.tutorial).id);
} else {
  store.write(save);
}

if ('serviceWorker' in navigator && location.protocol.startsWith('http') && window.top === window) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Exposed for automated checks.
window.jewelMosaic = { get game() { return game; }, save, cellRect: (c) => mosaic.cellRect(c) };
