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
const slotEls = [];
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
  buildTray();
  showScreen('game');
  mosaic.showPreview = save.settings.showPreview;
  mosaic.highlight = null;
  mosaic.flashes.clear();
  mosaic.setPicture(pic, game.board);
  mosaic.resize();
  message('');
  renderTray();
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
  $('hintBtn').disabled = game.isComplete();
}

// Holding tray ----------------------------------------------------

function buildTray() {
  const root = $('hold');
  root.textContent = '';
  slotEls.length = 0;
  for (let i = 0; i < game.hold.length; i++) {
    const slot = document.createElement('div');
    slot.className = 'slot';
    root.append(slot);
    slotEls.push(slot);
  }
}

function makeJewel(color, slot) {
  const p = colorOf(color);
  const el = document.createElement('button');
  el.className = 'jewel';
  el.dataset.slot = slot;
  el.dataset.color = color;
  colorVars(el, p.color);
  el.style.backgroundImage = `url(${jewelURL(p.color)})`;
  el.setAttribute('aria-label', `Tray jewel ${p.label}, ${p.name}`);
  el.innerHTML = `<span class="label">${p.label}</span>`;
  return el;
}

function trayJewel(slot) {
  return slotEls[slot]?.firstElementChild ?? null;
}

// Syncs the tray with the game and marks the picked-up color everywhere.
function renderTray() {
  game.hold.forEach((c, i) => {
    const el = trayJewel(i);
    if ((el ? Number(el.dataset.color) : null) === c) return;
    slotEls[i].textContent = '';
    if (c !== null) slotEls[i].append(makeJewel(c, i));
  });
  for (const el of $('hold').querySelectorAll('.jewel')) {
    const on = Number(el.dataset.color) === popped;
    el.classList.toggle('popped', on);
    el.setAttribute('aria-pressed', String(on));
  }
  $('hold').classList.toggle('has-pop', popped !== null);
  $('hold').classList.toggle('target', popped !== null && game.holdFree() > 0 && game.available(popped).some((j) => j.area === 'board'));
  mosaic.highlight = popped;
  mosaic.draw();
}

// Slides an element in from a viewport rectangle.
function slideIn(el, from) {
  if (!motion() || !el || !from) return;
  const now = el.getBoundingClientRect();
  el.animate(
    [
      { transform: `translate(${from.left + from.width / 2 - (now.left + now.width / 2)}px, ${from.top + from.height / 2 - (now.top + now.height / 2)}px) scale(${from.width / now.width})` },
      { transform: 'none' },
    ],
    { duration: 380, easing: 'cubic-bezier(.3,.7,.3,1)' },
  );
}

// Picking up -------------------------------------------------------

// Picks up every misplaced jewel of a color, or puts them back down.
function popColor(color) {
  if (!game || completing) return;
  sound.select();
  clearHint();
  if (popped === color) {
    popped = null;
    renderTray();
    message('');
    return;
  }
  popped = color;
  renderTray();
  const p = colorOf(color);
  if (coach?.step === 'pop') {
    coach.step = 'place';
    mosaic.flashes.clear();
    message(`Every color ${p.label} spot now glows. Tap one to set your color ${p.label} jewels there.`, { coachTone: true, ms: 0 });
    return;
  }
  const n = game.available(color).length;
  message(`Picked up ${n} of color ${p.label}. Tap a glowing spot, or the tray to lift them off.`);
}

// Picture taps: pick up the jewel there, or set the picked-up color down.
function tapPicture(x, y) {
  if (!game || completing) return;
  sound.ensure();
  const hit = mosaic.cellAt(x, y);
  const spot = hit >= 0 && pic.cells[hit] >= 0;
  const loose = spot && game.board[hit] >= 0 && !game.isCorrect(hit);
  if (popped === null) {
    if (loose) popColor(game.board[hit]);
    else if (spot && game.board[hit] === -1) message('Tap a jewel first, then a glowing spot for it.');
    return;
  }
  if (spot && pic.cells[hit] === popped && !game.isCorrect(hit)) return placeAt(hit);
  if (loose) return popColor(game.board[hit]); // the same color puts it down; another picks that one up
  if (spot && game.board[hit] === -1) {
    sound.nope();
    buzz(20);
    message(`That spot is for color ${colorOf(pic.cells[hit]).label}. Look for the glowing color ${colorOf(popped).label} spots.`);
    return;
  }
  // A tap on a finished spot or a gap snaps to a glowing spot close by.
  const cell = mosaic.nearestCell(x, y, (i) => pic.cells[i] === popped && !game.isCorrect(i), 1.2);
  if (cell >= 0) placeAt(cell);
}

function sourceRect(from) {
  return from.area === 'hold' ? trayJewel(from.slot)?.getBoundingClientRect() : mosaic.cellRect(from.cell);
}

function placeAt(cell) {
  const color = popped;
  const level = pic;
  const rects = new Map(game.available(color).map((j) => [`${j.area}:${j.slot ?? j.cell}`, sourceRect(j)]));
  const r = game.place(color, cell);
  if (!r.ok) {
    if (r.reason === 'full') {
      sound.nope();
      message('The tray is full. Put a tray jewel on an empty spot of its color to make room.');
    }
    return;
  }
  persist();
  if (motion()) for (const m of r.moves) pending.add(m.to);
  // Each placement puts the color back down; any left over stay where they are.
  const left = game.available(color).filter((j) => j.area === 'board').length;
  popped = null;
  renderTray();
  updateStatus();
  sound.cascade(Math.min(r.moves.length, 10));
  buzz([10, 40, 10]);

  const hex = colorOf(color).color;
  r.moves.forEach((m, k) => {
    fly(hex, rects.get(`${m.from.area}:${m.from.slot ?? m.from.cell}`), mosaic.cellRect(m.to), { duration: 480, delay: k * 45 }).then(() => {
      if (pic !== level) return;
      pending.delete(m.to);
      mosaic.pop(m.to);
    });
  });
  for (const b of r.bumps) slideIn(trayJewel(b.slot), mosaic.cellRect(b.cell));

  const fromTray = r.moves.some((m) => m.from.area === 'hold');
  if (coach?.step === 'place') {
    coach.step = r.bumps.length ? 'tray' : 'done';
    if (r.bumps.length) message('The jewels that were in the way went to the tray. Tap one, then an empty spot of its color.', { coachTone: true, ms: 0 });
    else message('');
  } else if (coach?.step === 'tray' && fromTray) {
    coach.step = 'done';
    message('That is the whole game. Keep going until every jewel is home!', { coachTone: true, ms: 5000 });
  } else if (left) {
    message(`The tray filled up, so ${left} color ${colorOf(color).label} jewel${left === 1 ? '' : 's'} stayed put. Put tray jewels on empty spots to make room.`);
  } else if (r.bumps.length) {
    message(`${r.bumps.length} jewel${r.bumps.length === 1 ? '' : 's'} moved to the tray.`);
  } else {
    message('');
  }
  if (r.completedColor !== null && !r.finished) toast(`Color ${colorOf(r.completedColor).label} is finished`);
  if (r.finished) {
    completing = true;
    Promise.all([...flights]).then(finishPicture);
  }
}

// Lifts the picked-up color off the picture into the tray.
function stashPopped() {
  if (!game || completing || popped === null) return;
  const r = game.stash(popped);
  if (!r.ok) {
    sound.nope();
    message(r.reason === 'full' ? 'The tray is full. Put a tray jewel on an empty spot first.' : 'Those jewels are already in the tray.');
    return;
  }
  persist();
  sound.click(r.moves.length);
  buzz(8);
  renderTray();
  updateStatus();
  for (const m of r.moves) slideIn(trayJewel(m.slot), mosaic.cellRect(m.cell));
  message(r.left ? `The tray is full. ${r.left} more stay on the picture.` : '');
}

// Tray input: tap a jewel to pick up its color, or drag it onto the picture.
function bindTrayInput() {
  const root = $('hold');
  let drag = null;

  root.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.jewel');
    if (!el || completing || drag) return;
    sound.ensure();
    drag = { el, color: Number(el.dataset.color), x: e.clientX, y: e.clientY, pid: e.pointerId, moving: false, ghost: null };
    el.setPointerCapture?.(e.pointerId);
  });

  root.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    if (!drag.moving && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 10 && save.settings.drag) {
      drag.moving = true;
      if (popped !== drag.color) {
        popped = drag.color;
        renderTray();
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
  });

  const finish = (e, cancelled) => {
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
    if (document.elementFromPoint(e.clientX, e.clientY) === $('mosaic')) {
      const r = $('mosaic').getBoundingClientRect();
      tapPicture(e.clientX - r.left, e.clientY - r.top);
    }
  };
  root.addEventListener('pointerup', (e) => finish(e, false));
  root.addEventListener('pointercancel', (e) => finish(e, true));
  // Tapping the tray itself (not one of its jewels) lifts the picked-up color into it.
  root.addEventListener('click', (e) => {
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
  if (h.from.area === 'hold') trayJewel(h.from.slot)?.classList.add('hint');
  else mosaic.flash([h.from.cell]);
  mosaic.flash([h.cell]);
  const p = colorOf(h.color);
  message(popped === h.color ? `Tap the flashing spot to set your color ${p.label} jewels.` : `Tap a flashing color ${p.label} jewel, then the flashing spot.`);
  clearTimeout(hintTimer);
  hintTimer = setTimeout(clearHint, 2600);
}

function undo() {
  if (!game || completing) return;
  const rects = game.hold.map((_, i) => trayJewel(i)?.getBoundingClientRect());
  const r = game.undo();
  if (!r.ok) return;
  persist();
  const level = pic;
  renderTray();
  updateStatus();
  sound.select();
  for (const m of r.moves) {
    if (motion()) pending.add(m.cell);
    fly(colorOf(m.color).color, rects[m.slot], mosaic.cellRect(m.cell), { duration: 320 }).then(() => {
      if (pic !== level) return;
      pending.delete(m.cell);
      mosaic.draw();
    });
  }
}

// Tutorial ------------------------------------------------------

function clearCoachMarks() {
  document.querySelectorAll('.coach').forEach((el) => el.classList.remove('coach'));
  mosaic.flashes.clear();
}

function startCoach() {
  coach = null;
  clearCoachMarks();
  if (!pic.tutorial || save.seen.tutorial || game.emptySpots().length || game.placedTotal() > pic.cellCount * 0.2) return;
  coach = { step: 'pop' };
  const h = game.hint();
  if (h?.from.area === 'board') mosaic.flash([h.from.cell], 600000);
  message('The jewels are scattered on spots of the wrong color. Tap the flashing jewel to pick up its whole color.', { coachTone: true, ms: 0 });
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
  mosaic.board = game.board;
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
  viewerMosaic.setPicture(p, Array.from(p.cells));
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
  mosaic.largeJewels = s.largeJewels;
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
$('undoBtn').addEventListener('click', undo);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('settings').hidden) closeSettings();
  else if (!$('viewer').hidden) $('viewer').hidden = true;
});
bindTrayInput();
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
window.jewelMosaic = { get game() { return game; }, save, cellRect: (c) => mosaic.cellRect(c), mosaicHighlight: () => popped };
