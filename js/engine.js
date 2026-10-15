// Jewel Mosaic rules engine.
// Pure game logic: no DOM, no timers, no animation.
//
// Every jewel starts on the picture, scattered onto spots of the wrong
// color. The player picks up a color and sets it onto that color's spots;
// wrong jewels already sitting there are bumped into a small holding tray.
// Every jewel is always either on a picture spot or in the tray.

export const HOLD_SIZE = 7;
export const STATE_VERSION = 3;

// ---------------------------------------------------------------- pictures

// Turns an authored picture definition (rows of palette keys, '.' = empty)
// into the compiled form the engine and renderer use.
export function compilePicture(def) {
  const h = def.rows.length;
  const w = Math.max(...def.rows.map((r) => r.length));
  const keyIndex = new Map(def.palette.map((p, i) => [p.key, i]));
  const cells = new Int8Array(w * h).fill(-1);
  for (let y = 0; y < h; y++) {
    const row = def.rows[y];
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '.';
      if (ch === '.' || ch === ' ') continue;
      const idx = keyIndex.get(ch);
      cells[y * w + x] = idx === undefined ? -2 : idx; // -2 flags a bad key for the validator
    }
  }
  const totals = def.palette.map(() => 0);
  for (const c of cells) if (c >= 0) totals[c]++;
  const palette = def.palette.map((p, i) => ({ ...p, label: String(i + 1) }));
  return {
    id: def.id,
    version: def.version ?? 1,
    title: def.title,
    album: def.album,
    tutorial: !!def.tutorial,
    w,
    h,
    palette,
    cells,
    totals,
    cellCount: totals.reduce((a, b) => a + b, 0),
  };
}

function neighbors(i, w, h) {
  const x = i % w;
  const y = (i - x) / w;
  const out = [];
  if (y + 1 < h) out.push(i + w);
  if (x > 0) out.push(i - 1);
  if (x + 1 < w) out.push(i + 1);
  if (y > 0) out.push(i - w);
  return out;
}

// ---------------------------------------------------------------- random

// mulberry32: small seeded generator whose state is a single integer.
function makeRandom(seed) {
  let s = seed | 0;
  return () => {
    let t = (s = (s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Places every jewel on a spot of another color wherever that is possible.
// A color covering more than half the spots cannot be fully scattered, so
// only the unavoidable minimum of it starts in place.
export function scatter(pic, seed) {
  const rand = makeRandom(seed);
  const board = Array.from(pic.cells, (c) => (c >= 0 ? c : -1));
  const spots = [];
  pic.cells.forEach((c, i) => c >= 0 && spots.push(i));
  const n = spots.length;
  const shuffle = (a) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const most = pic.totals.indexOf(Math.max(...pic.totals));
  const forced = Math.max(0, 2 * pic.totals[most] - n);
  const fixed = new Set(shuffle(spots.filter((i) => pic.cells[i] === most)).slice(0, forced));
  const free = shuffle(spots.filter((i) => !fixed.has(i)));

  // Group spots by color, then rotate the jewels by the largest group size:
  // no group is larger than half, so every jewel lands outside its group.
  free.sort((a, b) => pic.cells[a] - pic.cells[b]);
  const counts = new Map();
  for (const i of free) counts.set(pic.cells[i], (counts.get(pic.cells[i]) ?? 0) + 1);
  const shift = Math.max(0, ...counts.values());
  free.forEach((cell, k) => {
    board[cell] = pic.cells[free[(k + shift) % free.length]];
  });

  // Mix further with swaps that keep every jewel off its own color.
  for (let k = 0; k < free.length * 30; k++) {
    const a = free[Math.floor(rand() * free.length)];
    const b = free[Math.floor(rand() * free.length)];
    if (board[a] === board[b] || board[a] === pic.cells[b] || board[b] === pic.cells[a]) continue;
    [board[a], board[b]] = [board[b], board[a]];
  }
  return board;
}

// ---------------------------------------------------------------- game

export class Game {
  constructor(picture, state) {
    this.picture = picture;
    this.s = state;
  }

  static create(picture, seed = (Math.random() * 2 ** 31) | 0) {
    return new Game(picture, {
      v: STATE_VERSION,
      pictureId: picture.id,
      pictureVersion: picture.version,
      board: scatter(picture, seed),
      hold: new Array(HOLD_SIZE).fill(null),
      undo: [],
    });
  }

  // Restores a saved state; returns null when it does not match this picture
  // or fails the inventory checks, so the caller can start fresh.
  static restore(picture, saved) {
    if (!saved || saved.v !== STATE_VERSION) return null;
    if (saved.pictureId !== picture.id || saved.pictureVersion !== picture.version) return null;
    const g = new Game(picture, structuredClone(saved));
    try {
      g.checkInvariants();
    } catch {
      return null;
    }
    return g;
  }

  serialize() {
    return structuredClone(this.s);
  }

  // ------------------------------------------------------------ queries

  get board() {
    return this.s.board;
  }
  get hold() {
    return this.s.hold;
  }

  isCorrect(cell) {
    return this.picture.cells[cell] >= 0 && this.s.board[cell] === this.picture.cells[cell];
  }

  // Cells whose jewel matches the picture.
  filledCells() {
    const out = new Set();
    for (let i = 0; i < this.s.board.length; i++) if (this.isCorrect(i)) out.add(i);
    return out;
  }

  placedTotal() {
    let n = 0;
    for (let i = 0; i < this.s.board.length; i++) if (this.isCorrect(i)) n++;
    return n;
  }

  isComplete() {
    return this.placedTotal() === this.picture.cellCount;
  }

  remaining(color) {
    return this.targets(color).length;
  }

  // Jewels of a color that can be picked up: off their color, or in the tray.
  available(color) {
    const out = [];
    this.s.hold.forEach((c, slot) => c === color && out.push({ area: 'hold', slot }));
    this.s.board.forEach((c, cell) => c === color && !this.isCorrect(cell) && out.push({ area: 'board', cell }));
    return out;
  }

  // Spots of a color that do not hold their own color yet.
  targets(color) {
    const out = [];
    this.picture.cells.forEach((c, i) => c === color && this.s.board[i] !== color && out.push(i));
    return out;
  }

  emptySpots() {
    const out = [];
    this.picture.cells.forEach((c, i) => c >= 0 && this.s.board[i] === -1 && out.push(i));
    return out;
  }

  holdFree() {
    return this.s.hold.filter((c) => c === null).length;
  }

  canUndo() {
    return this.s.undo.length > 0;
  }

  // ------------------------------------------------------------ actions

  // Sets the picked-up jewels of `color` onto that color's spots, growing
  // outward from the tapped one. A wrong jewel already on a spot is bumped
  // into the tray; spots that would need a bump are skipped when the tray
  // is full. Nothing changes when the request cannot move any jewel.
  place(color, cell) {
    const { cells, w, h } = this.picture;
    if (cells[cell] !== color || this.s.board[cell] === color) return { ok: false, reason: 'cell' };
    const popped = this.available(color);
    if (!popped.length) return { ok: false, reason: 'none' };
    // Tray jewels go first so their slots free up for bumps; then the
    // closest picture jewels.
    const cx = cell % w;
    const cy = (cell - cx) / w;
    const dist = (i) => (i % w - cx) ** 2 + (Math.floor(i / w) - cy) ** 2;
    popped.sort((a, b) => (a.area === b.area ? (a.area === 'board' ? dist(a.cell) - dist(b.cell) : a.slot - b.slot) : a.area === 'hold' ? -1 : 1));

    const board = this.s.board;
    const hold = this.s.hold;
    const moves = [];
    const bumps = [];
    for (const t of this.growFrom(color, cell, w, h)) {
      if (!popped.length) break;
      const occupied = board[t] !== -1;
      const room = hold.includes(null) || popped[0].area === 'hold';
      if (occupied && !room) continue;
      const p = popped.shift();
      if (p.area === 'hold') hold[p.slot] = null;
      else board[p.cell] = -1;
      if (occupied) {
        const slot = hold.indexOf(null);
        hold[slot] = board[t];
        bumps.push({ cell: t, color: board[t], slot });
      }
      board[t] = color;
      moves.push({ from: p, to: t });
    }
    if (!moves.length) return { ok: false, reason: 'full' };
    this.pruneUndo();
    const done = this.remaining(color) === 0;
    return { ok: true, color, moves, bumps, completedColor: done ? color : null, finished: this.isComplete() };
  }

  // Spots for a color, starting at `cell` and spreading to touching spots;
  // when a region runs out, it continues from the nearest remaining spot.
  growFrom(color, cell, w, h) {
    const left = new Set(this.targets(color));
    const out = [];
    const sx = cell % w;
    const sy = (cell - sx) / w;
    let seed = cell;
    while (left.size) {
      if (!left.has(seed)) {
        let bestD = Infinity;
        for (const i of left) {
          const d = (i % w - sx) ** 2 + (Math.floor(i / w) - sy) ** 2;
          if (d < bestD) [seed, bestD] = [i, d];
        }
      }
      const queue = [seed];
      left.delete(seed);
      for (let qi = 0; qi < queue.length; qi++) {
        out.push(queue[qi]);
        for (const n of neighbors(queue[qi], w, h)) {
          if (left.has(n)) {
            left.delete(n);
            queue.push(n);
          }
        }
      }
    }
    return out;
  }

  // Lifts the picked-up color's jewels off the picture into free tray spaces.
  stash(color) {
    const free = [];
    this.s.hold.forEach((c, i) => c === null && free.push(i));
    if (!free.length) return { ok: false, reason: 'full' };
    const jewels = this.available(color).filter((j) => j.area === 'board');
    if (!jewels.length) return { ok: false, reason: 'none' };
    const moves = jewels.slice(0, free.length).map((j, k) => ({ cell: j.cell, slot: free[k], color }));
    for (const m of moves) {
      this.s.hold[m.slot] = color;
      this.s.board[m.cell] = -1;
    }
    this.s.undo.push({ moves });
    return { ok: true, color, moves, left: jewels.length - moves.length };
  }

  // Puts the most recent tray move back where those jewels came from.
  undo() {
    this.pruneUndo();
    const entry = this.s.undo.pop();
    if (!entry) return { ok: false };
    for (const m of entry.moves) {
      this.s.hold[m.slot] = null;
      this.s.board[m.cell] = m.color;
    }
    return { ok: true, moves: entry.moves };
  }

  // Drops undo steps whose jewels or spots have since been used.
  pruneUndo() {
    this.s.undo = this.s.undo
      .map((u) => ({ moves: u.moves.filter((m) => this.s.hold[m.slot] === m.color && this.s.board[m.cell] === -1) }))
      .filter((u) => u.moves.length);
  }

  // A move that always works: fill an empty spot from the tray or picture,
  // or, with nothing empty, the color with the most jewels out of place.
  hint() {
    for (const cell of this.emptySpots()) {
      const color = this.picture.cells[cell];
      const from = this.available(color)[0];
      if (from) return { color, cell, from };
    }
    let best = null;
    this.picture.palette.forEach((_, c) => {
      const jewels = this.available(c);
      if (jewels.length && (!best || jewels.length > best.jewels.length)) best = { color: c, jewels };
    });
    if (!best) return null;
    return { color: best.color, cell: this.targets(best.color)[0], from: best.jewels[0] };
  }

  // Throws if any jewel is duplicated, missing, or off the picture.
  checkInvariants() {
    const p = this.picture;
    const s = this.s;
    const fail = (msg) => {
      throw new Error(`invariant: ${msg}`);
    };
    if (!Array.isArray(s.board) || s.board.length !== p.cells.length) fail('board size');
    if (!Array.isArray(s.hold) || s.hold.length !== HOLD_SIZE) fail('tray size');
    const counts = p.palette.map(() => 0);
    let empty = 0;
    s.board.forEach((c, i) => {
      if (p.cells[i] < 0) {
        if (c !== -1) fail(`jewel outside the picture at ${i}`);
        return;
      }
      if (c === -1) empty++;
      else if (Number.isInteger(c) && c >= 0 && c < counts.length) counts[c]++;
      else fail(`bad jewel at ${i}`);
    });
    let held = 0;
    for (const c of s.hold) {
      if (c === null) continue;
      if (!Number.isInteger(c) || c < 0 || c >= counts.length) fail('bad tray jewel');
      counts[c]++;
      held++;
    }
    counts.forEach((n, c) => n !== p.totals[c] && fail(`color ${c} has ${n} jewels, expected ${p.totals[c]}`));
    if (empty !== held) fail('empty spots do not match tray jewels');
    for (const u of s.undo) for (const m of u.moves) if (s.hold[m.slot] !== m.color || s.board[m.cell] !== -1) fail('stale undo');
    return true;
  }
}
