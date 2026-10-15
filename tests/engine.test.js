import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePicture, Game, HOLD_SIZE, MAX_ACTIVE_COLORS, SUPPLY_SIZE } from '../js/engine.js';
import { simulate, validatePicture } from '../js/validate.js';
import { PICTURES, ALBUMS } from '../js/pictures.js';

const byId = (id) => compilePicture(PICTURES.find((p) => p.id === id));

// The color with the most jewels in the supply.
function richest(g) {
  return g.active.reduce((a, b) => (g.available(b).length > g.available(a).length ? b : a));
}

function placeAny(g) {
  const color = g.active.find((c) => g.available(c).length);
  return g.place(color, g.emptyCells(color)[0]);
}

test('every bundled picture passes the level validator', () => {
  for (const def of PICTURES) assert.deepEqual(validatePicture(def), [], def.id);
});

test('library has 20 pictures across four albums with unique ids', () => {
  assert.equal(PICTURES.length, 20);
  assert.equal(new Set(PICTURES.map((p) => p.id)).size, 20);
  for (const a of ALBUMS) assert.equal(PICTURES.filter((p) => p.album === a.id).length, 5, a.id);
});

test('a new game deals a full supply and an empty holding tray', () => {
  const g = Game.create(byId('star'), 7);
  assert.equal(g.supply.filter(Boolean).length, SUPPLY_SIZE);
  assert.equal(g.hold.length, HOLD_SIZE);
  assert.ok(g.hold.every((j) => j === null));
  g.checkInvariants();
});

test('placing a color uses every popped jewel, from the supply and the tray', () => {
  const g = Game.create(byId('moon'), 3);
  const color = richest(g);
  g.stash(color);
  const inHold = g.hold.filter((j) => j && j.color === color).length;
  assert.ok(inHold > 0);
  const ids = g.available(color).map((j) => j.id).sort();
  const r = g.place(color, g.emptyCells(color)[0]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.placements.map((p) => p.id).sort(), ids);
  assert.equal(g.hold.filter((j) => j && j.color === color).length, 0);
  for (const p of r.placements) {
    assert.equal(g.picture.cells[p.cell], color);
    assert.ok(g.isFilled(p.cell));
  }
  assert.equal(new Set(r.placements.map((p) => p.cell)).size, r.placements.length);
  g.checkInvariants();
});

test('placement grows outward from the tapped cell', () => {
  const pic = byId('sunflower');
  const g = Game.create(pic, 5);
  const color = richest(g);
  const empty = g.emptyCells(color);
  const tapped = empty[Math.floor(empty.length / 2)];
  const r = g.place(color, tapped);
  assert.equal(r.placements[0].cell, tapped);
  // Every later cell touches an earlier one, or no untouched neighbor was left.
  const placed = new Set([tapped]);
  const touches = (i) => [i - 1, i + 1, i - pic.w, i + pic.w].some((n) => placed.has(n) && Math.abs((n % pic.w) - (i % pic.w)) <= 1);
  for (const p of r.placements.slice(1)) {
    if (!touches(p.cell)) {
      const frontier = g.emptyCells(color).filter((i) => touches(i));
      assert.deepEqual(frontier, []);
    }
    placed.add(p.cell);
  }
});

test('the wrong cell is rejected without changing anything', () => {
  const g = Game.create(byId('star'), 5);
  const before = JSON.stringify(g.serialize());
  const color = richest(g);
  const other = g.picture.cells.findIndex((c) => c >= 0 && c !== color);
  assert.equal(g.place(color, other).reason, 'cell');
  assert.equal(JSON.stringify(g.serialize()), before);
});

test('repeating a placement does not place any jewel twice', () => {
  const g = Game.create(byId('star'), 5);
  const color = richest(g);
  const empty = g.emptyCells(color);
  const first = g.place(color, empty[0]);
  assert.equal(first.ok, true);
  const again = g.emptyCells(color).filter((c) => !first.placements.some((p) => p.cell === c));
  const before = g.placedTotal();
  // Refill may have dealt more of this color, which a second tap may place;
  // the first jewels never move again.
  const r = g.place(color, again[0]);
  if (r.ok) for (const p of r.placements) assert.ok(!first.placements.some((f) => f.id === p.id));
  assert.ok(g.placedTotal() >= before);
  g.checkInvariants();
});

test('stash fills free tray spots and leaves the rest popped in the supply', () => {
  const g = Game.create(byId('lighthouse'), 4);
  const color = richest(g);
  const n = g.available(color).length;
  const r = g.stash(color);
  assert.equal(r.ok, true);
  assert.equal(r.moves.length, Math.min(n, HOLD_SIZE));
  assert.equal(r.left, Math.max(0, n - HOLD_SIZE));
  g.checkInvariants();
});

test('a full holding tray refuses more jewels', () => {
  const g = Game.create(byId('umbrella'), 2);
  let guard = 0;
  while (g.holdFree() && guard++ < 20) {
    const c = g.active.find((col) => g.available(col).some((j) => j.area === 'supply'));
    g.stash(c);
  }
  assert.equal(g.holdFree(), 0);
  const c = g.active.find((col) => g.available(col).some((j) => j.area === 'supply'));
  assert.equal(g.stash(c).reason, 'full');
  g.checkInvariants();
});

test('undo returns the last tray move to the supply', () => {
  const g = Game.create(byId('heart'), 9);
  const color = richest(g);
  const r = g.stash(color);
  const u = g.undo();
  assert.equal(u.ok, true);
  assert.equal(u.back.length, r.moves.length);
  assert.ok(g.hold.every((j) => !j));
  for (const m of r.moves) assert.ok(g.supply.some((j) => j && j.id === m.id) || u.back.find((b) => b.id === m.id).slot === null);
  assert.equal(g.undo().ok, false);
  g.checkInvariants();
});

test('jewels placed into the picture cannot be undone', () => {
  const g = Game.create(byId('heart'), 9);
  const color = richest(g);
  g.stash(color);
  g.place(color, g.emptyCells(color)[0]);
  assert.equal(g.canUndo(), false);
  g.checkInvariants();
});

test('undo after rearrange still returns jewels to free slots', () => {
  const g = Game.create(byId('cat'), 12);
  const color = richest(g);
  g.stash(color);
  g.rearrange();
  assert.equal(g.undo().ok, true);
  g.checkInvariants();
});

test('a finished color introduces the next one and play stays within six colors', () => {
  const pic = byId('owl'); // nine colors
  const g = Game.create(pic, 11);
  assert.equal(g.active.length, MAX_ACTIVE_COLORS);
  let introductions = 0;
  while (!g.isComplete()) {
    const r = placeAny(g);
    introductions += r.introduced.length;
    for (const j of [...g.supply, ...g.hold]) if (j) assert.ok(g.active.includes(j.color));
    g.checkInvariants();
  }
  assert.equal(introductions, pic.palette.length - MAX_ACTIVE_COLORS);
});

test('hint names a color with jewels ready and a matching empty cell', () => {
  const g = Game.create(byId('cupcake'), 4);
  const h = g.hint();
  assert.ok(g.available(h.color).some((j) => j.id === h.jewelId));
  assert.equal(g.picture.cells[h.cell], h.color);
  assert.equal(g.place(h.color, h.cell).ok, true);
});

test('rearrange keeps inventory and groups colors', () => {
  const g = Game.create(byId('umbrella'), 8);
  for (let i = 0; i < 3; i++) placeAny(g);
  const ids = g.supply.filter(Boolean).map((j) => j.id).sort();
  g.rearrange();
  assert.deepEqual(g.supply.filter(Boolean).map((j) => j.id).sort(), ids);
  const colors = g.supply.filter(Boolean).map((j) => j.color);
  for (let i = 1; i < colors.length; i++) assert.ok(g.active.indexOf(colors[i - 1]) <= g.active.indexOf(colors[i]));
  g.checkInvariants();
});

test('save and restore mid-game resumes the exact state', () => {
  const pic = byId('lighthouse');
  const g = Game.create(pic, 21);
  g.stash(richest(g));
  for (let i = 0; i < 6; i++) placeAny(g);
  const saved = JSON.parse(JSON.stringify(g.serialize()));
  const r = Game.restore(pic, saved);
  assert.ok(r);
  assert.deepEqual(r.serialize(), g.serialize());
  while (!g.isComplete()) assert.deepEqual(placeAny(g).dealt, placeAny(r).dealt);
  assert.ok(r.isComplete());
});

test('restore rejects corrupted, mismatched, or old-format saves', () => {
  const pic = byId('star');
  const g = Game.create(pic, 1);
  placeAny(g);
  const s = g.serialize();
  assert.equal(Game.restore(byId('heart'), s), null);
  assert.equal(Game.restore({ ...pic, version: 2 }, s), null);
  assert.equal(Game.restore(pic, { ...s, v: 1 }), null);
  const dup = structuredClone(s);
  const j = dup.supply.find(Boolean);
  dup.supply[dup.supply.indexOf(null) >= 0 ? dup.supply.indexOf(null) : 0] = { ...j };
  dup.hold[0] = { ...j };
  assert.equal(Game.restore(pic, dup), null);
  const extra = structuredClone(s);
  const cell = pic.cells.findIndex((c, i) => c >= 0 && extra.filled[i] === '0');
  extra.filled = extra.filled.slice(0, cell) + '1' + extra.filled.slice(cell + 1);
  assert.equal(Game.restore(pic, extra), null);
});

test('every picture completes from many seeds with every jewel accounted for', () => {
  for (const def of PICTURES) {
    const pic = compilePicture(def);
    for (let seed = 1; seed <= 15; seed++) assert.ok(simulate(pic, seed) > 0, `${def.id} seed ${seed}`);
  }
});
