// Level validator: confirms a picture definition can be played to completion
// with every jewel accounted for.

import { compilePicture, Game, MAX_TRAYS } from './engine.js';

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
  pic.order.forEach((o, c) => {
    if (o.length !== pic.totals[c]) err(`placement order for ${def.palette[c].key} misses cells`);
  });
  if (errors.length) return errors;

  // Play the level through automatically and check inventory at every step.
  try {
    simulate(pic, 1);
  } catch (e) {
    err(e.message);
  }
  return errors;
}

// Plays a level to completion, sorting supply jewels in a seeded order.
// Returns the number of sort actions taken.
export function simulate(pic, seed, onStep) {
  const g = Game.create(pic, seed);
  let actions = 0;
  let rnd = seed;
  const pick = (n) => {
    rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
    return rnd % n;
  };
  g.checkInvariants();
  while (!g.isComplete()) {
    const jewels = g.supply.filter(Boolean);
    if (!jewels.length) throw new Error('supply ran dry before completion');
    const j = jewels[pick(jewels.length)];
    const active = new Set(g.trays.map((t) => t.color));
    if (g.trays.length > MAX_TRAYS) throw new Error('too many trays');
    if (!active.has(j.color)) throw new Error('inactive color in supply');
    const r = g.sort(j.id, j.color);
    if (!r.ok) throw new Error(`sort rejected: ${r.reason}`);
    actions++;
    g.checkInvariants();
    onStep?.(g, r);
    if (actions > pic.cellCount) throw new Error('more actions than cells');
  }
  if (g.supply.some(Boolean)) throw new Error('jewels left in supply after completion');
  if (g.trays.length) throw new Error('trays left after completion');
  if (g.filledCells().size !== pic.cellCount) throw new Error('not every cell filled');
  return actions;
}
