// Jewel Mosaic rules engine.
// Pure game logic: no DOM, no timers, no animation. Every jewel is accounted
// for at all times as placed in the picture, in the supply, in the holding
// tray, or still queued.

export const SUPPLY_SIZE = 24;
export const HOLD_SIZE = 7;
export const MAX_ACTIVE_COLORS = 6;
export const REFILL_THRESHOLD = 16;
export const STATE_VERSION = 2;

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

// mulberry32: small seeded generator whose state is a single integer, so it
// can be saved and resumed exactly.
function nextRandom(state) {
  let t = (state.rng = (state.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- game

export class Game {
  constructor(picture, state) {
    this.picture = picture;
    this.s = state;
  }

  static create(picture, seed = (Math.random() * 2 ** 31) | 0) {
    const n = picture.palette.length;
    const g = new Game(picture, {
      v: STATE_VERSION,
      pictureId: picture.id,
      pictureVersion: picture.version,
      filled: '0'.repeat(picture.cells.length),
      dealt: new Array(n).fill(0),
      active: [],
      queue: [...Array(n).keys()].filter((c) => picture.totals[c] > 0),
      supply: new Array(SUPPLY_SIZE).fill(null),
      hold: new Array(HOLD_SIZE).fill(null),
      nextId: 1,
      rng: seed | 0,
      undo: [],
    });
    g.introduceColors();
    g.refill(true);
    return g;
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

  get supply() {
    return this.s.supply;
  }
  get hold() {
    return this.s.hold;
  }
  get active() {
    return this.s.active;
  }

  isFilled(cell) {
    return this.s.filled[cell] === '1';
  }

  filledCells() {
    const out = new Set();
    for (let i = 0; i < this.s.filled.length; i++) if (this.s.filled[i] === '1') out.add(i);
    return out;
  }

  placed(color) {
    let n = 0;
    const { cells } = this.picture;
    for (let i = 0; i < cells.length; i++) if (cells[i] === color && this.s.filled[i] === '1') n++;
    return n;
  }

  placedTotal() {
    let n = 0;
    for (const ch of this.s.filled) if (ch === '1') n++;
    return n;
  }

  remaining(color) {
    return this.picture.totals[color] - this.placed(color);
  }

  isComplete() {
    return this.placedTotal() === this.picture.cellCount;
  }

  // Jewels of a color that exist only as inventory, not yet dealt.
  queued(color) {
    return this.picture.totals[color] - this.s.dealt[color];
  }

  // Every jewel of a color the player can pick up right now.
  available(color) {
    const out = [];
    this.s.supply.forEach((j, slot) => j && j.color === color && out.push({ ...j, area: 'supply', slot }));
    this.s.hold.forEach((j, slot) => j && j.color === color && out.push({ ...j, area: 'hold', slot }));
    return out;
  }

  emptyCells(color) {
    const out = [];
    const { cells } = this.picture;
    for (let i = 0; i < cells.length; i++) if (cells[i] === color && this.s.filled[i] !== '1') out.push(i);
    return out;
  }

  holdFree() {
    return this.s.hold.filter((j) => !j).length;
  }

  canUndo() {
    return this.s.undo.length > 0;
  }

  // ------------------------------------------------------------ actions

  // Places every available jewel of `color` into that color's empty cells,
  // growing outward from the tapped cell. Repeated requests find nothing
  // left to place, so a jewel is never placed twice.
  place(color, cell) {
    const { cells, w, h } = this.picture;
    if (cells[cell] !== color || this.isFilled(cell)) return { ok: false, reason: 'cell' };
    const jewels = this.available(color);
    if (!jewels.length) return { ok: false, reason: 'none' };

    const targets = this.growFrom(color, cell, jewels.length, w, h);
    const placements = jewels.map((j, k) => ({ id: j.id, area: j.area, slot: j.slot, cell: targets[k] }));
    const filled = this.s.filled.split('');
    for (const p of placements) {
      this.s[p.area][p.slot] = null;
      filled[p.cell] = '1';
    }
    this.s.filled = filled.join('');
    // Jewels that left the holding tray can no longer be undone.
    const placedIds = new Set(placements.map((p) => p.id));
    this.s.undo = this.s.undo
      .map((u) => ({ moves: u.moves.filter((m) => !placedIds.has(m.id)) }))
      .filter((u) => u.moves.length);

    const result = { ok: true, color, placements, completedColor: null, introduced: [], dealt: [] };
    if (this.remaining(color) === 0) {
      result.completedColor = color;
      this.s.active = this.s.active.filter((c) => c !== color);
      result.introduced = this.introduceColors();
    }
    result.dealt = this.refill(true);
    result.finished = this.isComplete();
    return result;
  }

  // Empty cells of one color, starting at `cell` and spreading to touching
  // cells; when a region runs out, it continues from the nearest empty cell.
  growFrom(color, cell, count, w, h) {
    const empty = new Set(this.emptyCells(color));
    const out = [];
    let seed = cell;
    while (out.length < count && empty.size) {
      if (!empty.has(seed)) {
        const sx = cell % w;
        const sy = (cell - sx) / w;
        let best = -1;
        let bestD = Infinity;
        for (const i of empty) {
          const d = (i % w - sx) ** 2 + (Math.floor(i / w) - sy) ** 2;
          if (d < bestD) [best, bestD] = [i, d];
        }
        seed = best;
      }
      const queue = [seed];
      empty.delete(seed);
      for (let qi = 0; qi < queue.length && out.length < count; qi++) {
        const i = queue[qi];
        out.push(i);
        for (const n of neighbors(i, w, h)) {
          if (empty.has(n)) {
            empty.delete(n);
            queue.push(n);
          }
        }
      }
      // Cells queued but not used go back to the pool.
      for (const i of queue) if (!out.includes(i)) empty.add(i);
    }
    return out;
  }

  // Moves the supply's jewels of `color` into free holding-tray spots.
  stash(color) {
    const free = [];
    this.s.hold.forEach((j, i) => j || free.push(i));
    if (!free.length) return { ok: false, reason: 'full' };
    const jewels = this.available(color).filter((j) => j.area === 'supply');
    if (!jewels.length) return { ok: false, reason: 'none' };
    const moves = jewels.slice(0, free.length).map((j, k) => ({ id: j.id, color, from: j.slot, to: free[k] }));
    for (const m of moves) {
      this.s.hold[m.to] = this.s.supply[m.from];
      this.s.supply[m.from] = null;
    }
    this.s.undo.push({ moves });
    const dealt = this.refill(false);
    return { ok: true, color, moves, dealt, left: jewels.length - moves.length };
  }

  // Returns the most recent move into the holding tray to the supply.
  undo() {
    const entry = this.s.undo.pop();
    if (!entry) return { ok: false };
    const back = [];
    for (const m of entry.moves) {
      const at = this.s.hold.findIndex((j) => j && j.id === m.id);
      if (at < 0) continue;
      let slot = m.from >= 0 && !this.s.supply[m.from] ? m.from : this.s.supply.indexOf(null);
      if (slot < 0) {
        // A full supply sends the jewel back to the queued inventory.
        slot = null;
        this.s.dealt[m.color]--;
      } else {
        this.s.supply[slot] = this.s.hold[at];
      }
      this.s.hold[at] = null;
      back.push({ id: m.id, color: m.color, from: at, slot });
    }
    return { ok: true, back };
  }

  // The color with the most jewels ready, one of its jewels, and a cell for it.
  hint() {
    let best = null;
    for (const c of this.s.active) {
      const jewels = this.available(c);
      if (jewels.length && (!best || jewels.length > best.jewels.length)) best = { color: c, jewels };
    }
    if (!best) return null;
    return { color: best.color, jewelId: best.jewels[0].id, cell: this.emptyCells(best.color)[0] };
  }

  // Groups the supply by color without changing inventory.
  rearrange() {
    const rank = new Map(this.s.active.map((c, i) => [c, i]));
    const jewels = this.s.supply.filter(Boolean).sort((a, b) => rank.get(a.color) - rank.get(b.color) || a.id - b.id);
    this.s.supply = this.s.supply.map((_, i) => jewels[i] ?? null);
    // Undo slots refer to old positions; returning jewels use any free slot.
    for (const u of this.s.undo) for (const m of u.moves) m.from = -1;
  }

  // ------------------------------------------------------------ internals

  introduceColors() {
    const added = [];
    while (this.s.active.length < MAX_ACTIVE_COLORS && this.s.queue.length) {
      const color = this.s.queue.shift();
      this.s.active.push(color);
      added.push(color);
    }
    return added;
  }

  // Deals new jewels into empty supply slots from the exact queued inventory
  // of active colors. Runs when the supply is low or after a placement.
  refill(force) {
    const count = this.s.supply.filter(Boolean).length;
    if (!force && count > REFILL_THRESHOLD) return [];
    const dealt = [];
    const queued = new Map(this.s.active.map((c) => [c, this.queued(c)]));
    for (let slot = 0; slot < this.s.supply.length; slot++) {
      if (this.s.supply[slot]) continue;
      let total = 0;
      for (const q of queued.values()) total += q;
      if (total === 0) break;
      let r = nextRandom(this.s) * total;
      let color = null;
      for (const [c, q] of queued) {
        if (r < q) {
          color = c;
          break;
        }
        r -= q;
      }
      if (color === null) color = [...queued].find(([, q]) => q > 0)[0];
      queued.set(color, queued.get(color) - 1);
      this.s.dealt[color]++;
      const jewel = { id: this.s.nextId++, color };
      this.s.supply[slot] = jewel;
      dealt.push({ slot, jewel });
    }
    return dealt;
  }

  // Throws if any jewel is duplicated, missing, or of an inactive color.
  checkInvariants() {
    const p = this.picture;
    const s = this.s;
    const fail = (msg) => {
      throw new Error(`invariant: ${msg}`);
    };
    if (s.supply.length !== SUPPLY_SIZE || s.hold.length !== HOLD_SIZE) fail('area size');
    if (typeof s.filled !== 'string' || s.filled.length !== p.cells.length || /[^01]/.test(s.filled)) fail('filled');
    if (s.dealt.length !== p.palette.length) fail('color count');
    if (s.active.length > MAX_ACTIVE_COLORS) fail('too many colors');
    for (let i = 0; i < p.cells.length; i++) if (p.cells[i] < 0 && s.filled[i] === '1') fail(`empty cell ${i} filled`);
    const ids = new Set();
    const active = new Set(s.active);
    const counts = p.palette.map(() => 0);
    for (const j of [...s.supply, ...s.hold]) {
      if (!j) continue;
      if (!Number.isInteger(j.id) || j.id <= 0 || j.id >= s.nextId) fail(`bad id ${j.id}`);
      if (ids.has(j.id)) fail(`duplicate jewel ${j.id}`);
      ids.add(j.id);
      if (!active.has(j.color)) fail(`inactive color ${j.color} in play`);
      counts[j.color]++;
    }
    for (const u of s.undo) for (const m of u.moves) if (!s.hold.some((j) => j && j.id === m.id)) fail(`stale undo ${m.id}`);
    p.palette.forEach((_, c) => {
      const placed = this.placed(c);
      const dealt = s.dealt[c];
      if (!(dealt >= 0 && dealt <= p.totals[c])) fail(`dealt out of range for ${c}`);
      if (placed + counts[c] !== dealt) fail(`inventory mismatch for ${c}`);
      const queuedColor = s.queue.includes(c);
      if (queuedColor && dealt !== 0) fail(`queued color ${c} already dealt`);
      if (!active.has(c) && !queuedColor && placed !== p.totals[c] && p.totals[c] > 0) fail(`color ${c} lost`);
      if (active.has(c) && placed === p.totals[c]) fail(`finished color ${c} still active`);
    });
    return true;
  }
}
