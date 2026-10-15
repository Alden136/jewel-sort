// Level validator: confirms a picture definition can be played to completion
// with every jewel accounted for.

import { compilePicture, Game } from './engine.js';

export const MAX_COLORS = 12;

export function validatePicture(def) {
  const errors = [];
  const err = (m) => errors.push(`${def.id ?? '?'}: ${m}`);

  if (!def.id || !def.title || !def.album) err('missing id, title, or album');
  if (!Array.isArray(def.rows) || def.rows.length === 0) {
    err('no rows');
    return errors;
  }
  const w = def.rows[0].length;
  def.rows.forEach((r, i) => r.length !== w && err(`row ${i} has width ${r.length}, expected ${w}`));

  const keys = def.palette.map((p) => p.key);
  if (new Set(keys).size !== keys.length) err('duplicate palette keys');
  if (keys.includes('.')) err("'.' is reserved for empty cells");
  const names = def.palette.map((p) => p.name);
  if (new Set(names).size !== names.length) err('palette names are not unique');
  const colors = def.palette.map((p) => p.color.toLowerCase());
  if (new Set(colors).size !== colors.length) err('palette colors are not unique');
  if (def.palette.length > MAX_COLORS) err(`more than ${MAX_COLORS} colors`);

  const pic = compilePicture(def);
  if (pic.cells.includes(-2)) err('rows reference a key missing from the palette');
  pic.totals.forEach((t, c) => t === 0 && err(`palette color ${def.palette[c].key} is never used`));
  if (errors.length) return errors;

  // Play the level through automatically and check inventory at every step.
  try {
    simulate(pic, 1);
  } catch (e) {
    err(e.message);
  }
  return errors;
}

// Plays a level to completion with seeded choices: usually placing a random
// color at a random spot, sometimes lifting jewels into the tray or undoing
// that. When the tray has no room, it falls back to the hint, which always
// makes progress. Returns the number of placements.
export function simulate(pic, seed, onStep) {
  const g = Game.create(pic, seed);
  let rnd = seed;
  const pick = (n) => {
    rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
    return rnd % n;
  };
  let placements = 0;
  let steps = 0;
  g.checkInvariants();
  while (!g.isComplete()) {
    if (++steps > pic.cellCount * 20) throw new Error('no progress');
    const colors = pic.palette.map((_, c) => c).filter((c) => g.available(c).length);
    if (!colors.length) throw new Error('nothing to pick up before completion');
    const color = colors[pick(colors.length)];
    const roll = pick(20);
    let r;
    if (roll < 2) r = g.stash(color);
    else if (roll < 3) r = g.undo();
    else {
      const before = g.placedTotal();
      const targets = g.targets(color);
      r = g.place(color, targets[pick(targets.length)]);
      if (!r.ok) {
        if (r.reason !== 'full') throw new Error(`place rejected: ${r.reason}`);
        const h = g.hint();
        r = g.place(h.color, h.cell);
        if (!r.ok) throw new Error(`hint move rejected: ${r.reason}`);
      }
      if (g.placedTotal() <= before) throw new Error('placement made no progress');
      placements++;
    }
    g.checkInvariants();
    onStep?.(g, r);
  }
  if (g.hold.some((c) => c !== null)) throw new Error('jewels left in the tray after completion');
  if (g.filledCells().size !== pic.cellCount) throw new Error('not every spot correct');
  return placements;
}
