// Jewel Mosaic rules engine.
// Pure game logic: no DOM, no timers, no animation. Every jewel is accounted
// for at all times as placed, in a tray, in the supply, or still queued.

export const TRAY_CAPACITY = 8;
export const SUPPLY_SIZE = 24;
export const MAX_TRAYS = 6;
export const REFILL_THRESHOLD = 16;
export const STATE_VERSION = 1;

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
  const order = palette.map((_, c) => placementOrder(cells, w, h, c));
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
    order,
    cellCount: totals.reduce((a, b) => a + b, 0),
  };
}

// Orders a color's cells so each batch lands as a coherent patch: regions are
// visited bottom-up and grown breadth-first from their lowest-left cell.
export function placementOrder(cells, w, h, color) {
  const seen = new Uint8Array(w * h);
  const out = [];
  for (let y = h - 1; y >= 0; y--) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (cells[start] !== color || seen[start]) continue;
      seen[start] = 1;
      const queue = [start];
      for (let qi = 0; qi < queue.length; qi++) {
        const i = queue[qi];
        out.push(i);
        const cx = i % w;
        const cy = (i - cx) / w;
        const next = [
          [cx, cy + 1],
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
        ];
        for (const [nx, ny] of next) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (cells[n] === color && !seen[n]) {
            seen[n] = 1;
            queue.push(n);
          }
        }
      }
    }
  }
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
      placed: new Array(n).fill(0),
      dealt: new Array(n).fill(0),
      trays: [],
      queue: [...Array(n).keys()].filter((c) => picture.totals[c] > 0),
      supply: new Array(SUPPLY_SIZE).fill(null),
      nextId: 1,
      rng: seed | 0,
      undo: [],
      selected: null,
    });
    g.introduceColors();
    g.refill(true);
    g.s.selected = g.s.trays[0]?.color ?? null;
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

  get trays() {
    return this.s.trays;
  }
  get supply() {
    return this.s.supply;
  }
  get selected() {
    return this.s.selected;
  }

  tray(color) {
    return this.s.trays.find((t) => t.color === color) ?? null;
  }

  remaining(color) {
    return this.picture.totals[color] - this.s.placed[color];
  }

  // Size of the color's current batch; shrinks for the final batch.
  capacity(color) {
    return Math.min(TRAY_CAPACITY, this.remaining(color));
  }

  inSupply(color) {
    let n = 0;
    for (const j of this.s.supply) if (j && j.color === color) n++;
    return n;
  }

  // Jewels of a color that exist only as inventory, not yet dealt.
  queued(color) {
    return this.picture.totals[color] - this.s.dealt[color];
  }

  placedTotal() {
    return this.s.placed.reduce((a, b) => a + b, 0);
  }

  isComplete() {
    return this.placedTotal() === this.picture.cellCount;
  }

  // Cells filled so far, derived from the deterministic placement order.
  filledCells() {
    const out = new Set();
    this.s.placed.forEach((count, c) => {
      for (let i = 0; i < count; i++) out.add(this.picture.order[c][i]);
    });
    return out;
  }

  canUndo() {
    return this.s.undo.length > 0;
  }

  // ------------------------------------------------------------ actions

  select(color) {
    if (!this.tray(color)) return false;
    this.s.selected = color;
    return true;
  }

  // Sorts one supply jewel into the tray of `color`. A mismatched or stale
  // request changes nothing, so repeated taps are accepted at most once.
  sort(jewelId, color) {
    const slot = this.s.supply.findIndex((j) => j && j.id === jewelId);
    if (slot < 0) return { ok: false, reason: 'gone' };
    const jewel = this.s.supply[slot];
    const tray = this.tray(color);
    if (!tray) return { ok: false, reason: 'inactive' };
    if (jewel.color !== color) return { ok: false, reason: 'mismatch', jewel };

    this.s.supply[slot] = null;
    tray.jewels.push(jewel.id);
    this.s.undo.push({ id: jewel.id, color, slot });

    const result = { ok: true, jewel, slot, dispatch: null, completedColor: null, introduced: [], dealt: [] };
    if (tray.jewels.length >= this.capacity(color)) {
      result.dispatch = this.dispatch(tray);
      if (this.remaining(color) === 0) {
        result.completedColor = color;
        this.s.trays = this.s.trays.filter((t) => t !== tray);
        result.introduced = this.introduceColors();
        if (this.s.selected === color) this.s.selected = result.introduced[0] ?? this.s.trays[0]?.color ?? null;
      }
    }
    result.dealt = this.refill(!!result.dispatch);
    result.finished = this.isComplete();
    return result;
  }

  // Commits a full tray to the picture before any animation runs.
  dispatch(tray) {
    const color = tray.color;
    const count = tray.jewels.length;
    const start = this.s.placed[color];
    const cells = this.picture.order[color].slice(start, start + count);
    const jewelIds = tray.jewels;
    this.s.placed[color] += count;
    tray.jewels = [];
    this.s.undo = this.s.undo.filter((u) => u.color !== color);
    return { color, cells, jewelIds };
  }

  // Returns the most recently sorted, not yet dispatched jewel to the supply.
  undo() {
    const entry = this.s.undo.pop();
    if (!entry) return { ok: false };
    const tray = this.tray(entry.color);
    tray.jewels = tray.jewels.filter((id) => id !== entry.id);
    let slot = this.s.supply[entry.slot] ? this.s.supply.indexOf(null) : entry.slot;
    // With a full supply the jewel simply goes back to the queued inventory.
    if (slot >= 0) {
      this.s.supply[slot] = { id: entry.id, color: entry.color };
    } else {
      slot = null;
      this.s.dealt[entry.color]--;
    }
    return { ok: true, id: entry.id, color: entry.color, slot };
  }

  // A valid jewel and tray, preferring the selected tray.
  hint() {
    const sel = this.s.selected;
    const match = this.s.supply.find((j) => j && j.color === sel);
    const jewel = match ?? this.s.supply.find((j) => j);
    return jewel ? { jewelId: jewel.id, color: jewel.color } : null;
  }

  // Groups the supply by tray order without changing inventory.
  rearrange() {
    const rank = new Map(this.s.trays.map((t, i) => [t.color, i]));
    const jewels = this.s.supply.filter(Boolean).sort((a, b) => rank.get(a.color) - rank.get(b.color) || a.id - b.id);
    this.s.supply = this.s.supply.map((_, i) => jewels[i] ?? null);
  }

  // ------------------------------------------------------------ internals

  introduceColors() {
    const added = [];
    while (this.s.trays.length < MAX_TRAYS && this.s.queue.length) {
      const color = this.s.queue.shift();
      this.s.trays.push({ color, jewels: [] });
      added.push(color);
    }
    return added;
  }

  // Deals new jewels into empty supply slots from the exact queued inventory
  // of active colors. Runs when the supply is low or after a batch commits.
  refill(force) {
    const count = this.s.supply.filter(Boolean).length;
    if (!force && count > REFILL_THRESHOLD) return [];
    const dealt = [];
    const empties = [];
    this.s.supply.forEach((j, i) => j || empties.push(i));
    const queued = new Map(this.s.trays.map((t) => [t.color, this.queued(t.color)]));
    for (const slot of empties) {
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
    if (s.supply.length !== SUPPLY_SIZE) fail('supply size');
    if (s.placed.length !== p.palette.length || s.dealt.length !== p.palette.length) fail('color count');
    if (s.trays.length > MAX_TRAYS) fail('too many trays');
    const ids = new Set();
    const note = (id) => {
      if (!Number.isInteger(id) || id <= 0 || id >= s.nextId) fail(`bad id ${id}`);
      if (ids.has(id)) fail(`duplicate jewel ${id}`);
      ids.add(id);
    };
    const active = new Set(s.trays.map((t) => t.color));
    for (const j of s.supply) {
      if (!j) continue;
      note(j.id);
      if (!active.has(j.color)) fail(`inactive color ${j.color} in supply`);
    }
    for (const t of s.trays) {
      t.jewels.forEach(note);
      if (t.jewels.length >= this.capacity(t.color)) fail(`tray ${t.color} overfull`);
    }
    for (const u of s.undo) {
      if (!this.tray(u.color)?.jewels.includes(u.id)) fail(`stale undo ${u.id}`);
    }
    p.palette.forEach((_, c) => {
      const placed = s.placed[c];
      if (placed < 0 || placed > p.totals[c]) fail(`placed out of range for ${c}`);
      const dealt = s.dealt[c];
      if (!(dealt >= 0 && dealt <= p.totals[c])) fail(`dealt out of range for ${c}`);
      const inTray = this.tray(c)?.jewels.length ?? 0;
      if (placed + inTray + this.inSupply(c) !== dealt) fail(`inventory mismatch for ${c}`);
      const queuedColor = s.queue.includes(c);
      if (!active.has(c) && !queuedColor && placed !== p.totals[c] && p.totals[c] > 0) fail(`color ${c} lost`);
      if (queuedColor && placed !== 0) fail(`queued color ${c} already placed`);
    });
    if (s.selected !== null && !active.has(s.selected)) fail('selected tray inactive');
    return true;
  }
}
