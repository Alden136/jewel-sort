import { PICTURES, ALBUMS } from './pictures.js';
import { compilePicture, Game, TRAY_CAPACITY } from './engine.js';
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
const mosaic = new MosaicView($('mosaic'), { onZoom: (z) => ($('fitBtn').hidden = !z) });
let viewerMosaic = null;

// Active level.
let pic = null;
let game = null;
let completing = false;
let coach = null;
const pending = mosaic.pending;
const flights = new Set();
const trayEls = new Map();
const slotEls = [];
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
  if (!motion()) return Promise.resolve();
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
  pending.clear();
  $('game').classList.remove('revealed');
  $('completeSheet').hidden = true;
  $('gameTitle').textContent = pic.title;
  for (const el of trayEls.values()) el.remove();
  trayEls.clear();
  buildSupply();
  showScreen('game');
  mosaic.showPreview = save.settings.showPreview;
  mosaic.setPicture(pic, game.filledCells());
  mosaic.resize();
  message('');
  renderTrays();
  renderSupply();
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
  renderGallery();
  showScreen('gallery');
}

function updateStatus() {
  const pct = Math.floor((game.placedTotal() / pic.cellCount) * 100);
  $('progressBar').style.width = `${pct}%`;
  $('progressText').textContent = `${pct}%`;
  $('undoBtn').disabled = !game.canUndo();
  $('hintBtn').disabled = !game.supply.some(Boolean);
  $('rearrangeBtn').disabled = !game.supply.some(Boolean);
}

// Trays ---------------------------------------------------------

function renderTrays() {
  const root = $('trays');
  const active = new Set(game.trays.map((t) => t.color));
  for (const [color, el] of trayEls) {
    if (active.has(color)) continue;
    trayEls.delete(color);
    if (motion()) {
      el.classList.add('leaving');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    } else el.remove();
  }
  for (const t of game.trays) {
    let el = trayEls.get(t.color);
    const p = colorOf(t.color);
    if (!el) {
      el = document.createElement('button');
      el.className = 'tray entering';
      el.dataset.color = t.color;
      colorVars(el, p.color);
      el.innerHTML = `<span class="tray-gem"><span class="label"></span></span><span class="tray-slots"></span>`;
      el.querySelector('.tray-gem').style.backgroundImage = `url(${jewelURL(p.color)})`;
      el.querySelector('.label').textContent = p.label;
      el.addEventListener('click', () => selectTray(t.color));
      el.addEventListener('animationend', () => el.classList.remove('entering'), { once: true });
      trayEls.set(t.color, el);
    }
    if (el.parentNode !== root) root.append(el); // new colors always join at the end
    const cap = game.capacity(t.color);
    const slots = el.querySelector('.tray-slots');
    slots.style.gridTemplateColumns = `repeat(${Math.min(4, cap)}, 7px)`;
    if (slots.children.length !== cap) slots.innerHTML = '<i></i>'.repeat(cap);
    [...slots.children].forEach((d, i) => d.classList.toggle('on', i < t.jewels.length));
    el.classList.toggle('selected', game.selected === t.color);
    el.setAttribute('aria-pressed', String(game.selected === t.color));
    el.setAttribute('aria-label', `Tray ${p.label}, ${p.name}: ${t.jewels.length} of ${cap}, ${game.remaining(t.color)} left in picture`);
  }
  explainPartialBatch();
}

function selectTray(color) {
  if (!game || completing) return;
  sound.select();
  game.select(color);
  renderTrays();
  persist();
  if (coach?.step === 'switch') {
    coach.step = 'done';
    message('');
  }
}

function explainPartialBatch() {
  if (save.seen.partial) return;
  const t = game.trays.find((tr) => game.capacity(tr.color) < TRAY_CAPACITY);
  if (!t) return;
  save.seen.partial = true;
  const p = colorOf(t.color);
  const n = game.capacity(t.color);
  message(`Tray ${p.label} needs only ${n} more — a color's last batch is smaller.`, { coachTone: true, ms: 6000 });
}

// Supply --------------------------------------------------------

function buildSupply() {
  const root = $('supply');
  root.textContent = '';
  slotEls.length = 0;
  for (let i = 0; i < game.supply.length; i++) {
    const slot = document.createElement('div');
    slot.className = 'slot';
    root.append(slot);
    slotEls.push(slot);
  }
}

function jewelEl(id) {
  return $('supply').querySelector(`.jewel[data-id="${id}"]`);
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

function renderSupply(dealt = new Set()) {
  game.supply.forEach((j, i) => {
    const slot = slotEls[i];
    const el = slot.firstElementChild;
    if ((el?.dataset.id ?? null) === (j ? String(j.id) : null)) return;
    slot.textContent = '';
    if (j) slot.append(makeJewel(j, dealt.has(j.id)));
  });
}

// Sorting -------------------------------------------------------

function trySort(id, color, fromRect) {
  if (!game || completing || color == null) return false;
  const el = jewelEl(id);
  if (!el) return false;
  const start = fromRect ?? el.getBoundingClientRect();
  const r = game.sort(id, color);
  if (!r.ok) {
    if (r.reason === 'mismatch') rejectJewel(el, r.jewel);
    return false;
  }
  const trayEl = trayEls.get(color);
  const trayRect = trayEl.querySelector('.tray-gem').getBoundingClientRect();
  const fillCount = r.dispatch ? r.dispatch.jewelIds.length : game.tray(color).jewels.length;
  persist();
  sound.click(fillCount - 1);
  buzz(8);

  if (r.dispatch) {
    if (motion()) for (const c of r.dispatch.cells) pending.add(c);
    mosaic.filled = game.filledCells();
  }
  renderSupply(new Set(r.dealt.map((d) => d.jewel.id)));
  renderTrays();
  updateStatus();
  mosaic.draw();

  const landed = fly(colorOf(r.jewel.color).color, start, trayRect, { duration: 260 });
  if (r.dispatch) landed.then(() => dispatchBatch(r.dispatch, trayRect));

  if (coach?.step === 'first') {
    coach.step = 'fill';
    clearCoachMarks();
    message(`Keep going! A full tray of ${game.capacity(color)} sends its jewels into the picture.`, { coachTone: true, ms: 0 });
  }
  if (r.dispatch && coach?.step === 'fill') {
    coach.step = 'switch';
    message('Those jewels found their places! Tap another tray to sort a new color.', { coachTone: true, ms: 7000 });
  }
  if (r.introduced.length) {
    const names = r.introduced.map((c) => colorOf(c).label).join(', ');
    toast(`Color ${colorOf(r.completedColor).label} finished — tray ${names} joins the palette`);
  }
  if (r.finished) {
    completing = true;
    Promise.all([landed, ...flights]).then(() => Promise.all([...flights])).then(finishPicture);
  }
  return true;
}

function dispatchBatch(d, fromRect) {
  const level = pic;
  if (!level) return;
  const color = colorOf(d.color).color;
  sound.cascade(d.cells.length);
  buzz([10, 40, 10]);
  if (!motion()) {
    mosaic.draw();
    return;
  }
  d.cells.forEach((cell, k) => {
    fly(color, fromRect, mosaic.cellRect(cell), { duration: 460, delay: k * 60 }).then(() => {
      if (pic !== level) return;
      pending.delete(cell);
      mosaic.pop(cell);
    });
  });
}

function rejectJewel(el, jewel) {
  const p = colorOf(jewel.color);
  sound.nope();
  buzz(20);
  if (motion()) {
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
  }
  message(`That's a ${p.label} jewel — it goes in tray ${p.label}.`);
}

// Pointer input: tap to sort into the selected tray, or drag onto a tray.
function bindSupplyInput() {
  const root = $('supply');
  let drag = null;

  const trayAt = (x, y) => document.elementFromPoint(x, y)?.closest('.tray');
  const clearDrop = () => document.querySelectorAll('.tray.drop-target').forEach((t) => t.classList.remove('drop-target'));

  root.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.jewel');
    if (!el || completing || drag) return;
    sound.ensure();
    drag = { el, id: Number(el.dataset.id), x: e.clientX, y: e.clientY, pid: e.pointerId, moving: false, ghost: null };
    el.setPointerCapture?.(e.pointerId);
  });

  root.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    const dist = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
    if (!drag.moving && dist > 10 && save.settings.drag) {
      drag.moving = true;
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
      clearDrop();
      trayAt(e.clientX, e.clientY)?.classList.add('drop-target');
    }
  });

  const finish = (e, cancelled) => {
    if (!drag || e.pointerId !== drag.pid) return;
    const d = drag;
    drag = null;
    clearDrop();
    if (!d.moving) {
      if (!cancelled) {
        if (d.el.isConnected) trySort(d.id, game.selected);
      }
      return;
    }
    const ghostRect = d.ghost.getBoundingClientRect();
    d.ghost.remove();
    d.el.classList.remove('dragging');
    const tray = cancelled ? null : trayAt(e.clientX, e.clientY);
    if (tray) {
      const color = Number(tray.dataset.color);
      const ok = trySort(d.id, color, ghostRect);
      if (ok && game && game.tray(color) && game.selected !== color) {
        game.select(color);
        renderTrays();
      }
    } else if (d.el.isConnected) {
      fly(colorOf(Number(d.el.dataset.color)).color, ghostRect, d.el.getBoundingClientRect(), { duration: 200 });
    }
  };
  root.addEventListener('pointerup', (e) => finish(e, false));
  root.addEventListener('pointercancel', (e) => finish(e, true));
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
  trayEls.get(h.color)?.classList.add('hint');
  const p = colorOf(h.color);
  message(game.selected === h.color ? `This ${p.label} jewel fits the selected tray.` : `Select tray ${p.label}, then tap the glowing jewel.`);
  clearTimeout(hintTimer);
  hintTimer = setTimeout(clearHint, 2600);
}

function rearrange() {
  if (!game || completing) return;
  const before = new Map();
  for (const el of $('supply').querySelectorAll('.jewel')) before.set(el.dataset.id, el.getBoundingClientRect());
  game.rearrange();
  persist();
  renderSupply();
  if (motion()) {
    for (const el of $('supply').querySelectorAll('.jewel')) {
      const old = before.get(el.dataset.id);
      if (!old) continue;
      const now = el.getBoundingClientRect();
      el.animate([{ transform: `translate(${old.left - now.left}px, ${old.top - now.top}px)` }, { transform: 'none' }], {
        duration: 380,
        easing: 'cubic-bezier(.3,.7,.3,1)',
      });
    }
  }
  sound.cascade(4);
}

function undo() {
  if (!game || completing) return;
  const trayRect = trayEls.get(game.s.undo.at(-1)?.color)?.querySelector('.tray-gem').getBoundingClientRect();
  const r = game.undo();
  if (!r.ok) return;
  persist();
  renderSupply();
  renderTrays();
  updateStatus();
  sound.select();
  const el = jewelEl(r.id);
  if (el && trayRect && motion()) {
    const now = el.getBoundingClientRect();
    el.animate(
      [
        { transform: `translate(${trayRect.left - now.left}px, ${trayRect.top - now.top}px) scale(0.6)` },
        { transform: 'none' },
      ],
      { duration: 280, easing: 'ease-out' },
    );
  }
  if (r.slot === null) message('Returned to the jewel bag — it will be dealt again.');
}

// Tutorial ------------------------------------------------------

function clearCoachMarks() {
  document.querySelectorAll('.coach').forEach((el) => el.classList.remove('coach'));
}

function startCoach() {
  coach = null;
  clearCoachMarks();
  if (!pic.tutorial || save.seen.tutorial || game.placedTotal() > 0) return;
  coach = { step: 'first' };
  const color = game.selected;
  const j = game.supply.find((x) => x && x.color === color);
  trayEls.get(color)?.classList.add('coach');
  if (j) jewelEl(j.id)?.classList.add('coach');
  message('Tap the glowing jewel to sort it into the highlighted tray.', { coachTone: true, ms: 0 });
}

// Completion ----------------------------------------------------

function finishPicture() {
  completing = true;
  coach = null;
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
  ['drag', 'Drag to sort', 'toggle', 'Tapping always works too'],
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
bindSupplyInput();
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
window.jewelMosaic = { get game() { return game; }, save };
