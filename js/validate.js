// Level validator: confirms a picture definition can be played to completion
// with every jewel accounted for.

import { compilePicture, Game, MAX_ACTIVE_COLORS } from './engine.js';

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

// Plays a level to completion with seeded choices: usually placing a
// random available color at a random empty cell, sometimes parking jewels in
// the holding tray or undoing that. Returns the number of placements.
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
    if (++steps > pic.cellCount * 4) throw new Error('no progress');
    const colors = g.active.filter((c) => g.available(c).length);
    if (!colors.length) throw new Error('nothing available before completion');
    for (const j of [...g.supply, ...g.hold]) if (j && !g.active.includes(j.color)) throw new Error('inactive color in play');
    if (g.active.length > MAX_ACTIVE_COLORS) throw new Error('too many colors in play');
    const color = colors[pick(colors.length)];
    const roll = pick(10);
    let r;
    if (roll < 2) r = g.stash(color);
    else if (roll < 3) r = g.undo();
    else {
      const empty = g.emptyCells(color);
      const before = g.available(color).length;
      r = g.place(color, empty[pick(empty.length)]);
      if (!r.ok) throw new Error(`place rejected: ${r.reason}`);
      if (r.placements.length !== before) throw new Error('not every available jewel placed');
      placements++;
    }
    g.checkInvariants();
    onStep?.(g, r);
  }
  if (g.supply.some(Boolean) || g.hold.some(Boolean)) throw new Error('jewels left after completion');
  if (g.active.length) throw new Error('colors left after completion');
  if (g.filledCells().size !== pic.cellCount) throw new Error('not every cell filled');
  return placements;
}
