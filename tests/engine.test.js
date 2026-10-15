import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePicture, Game, TRAY_CAPACITY, MAX_TRAYS, SUPPLY_SIZE } from '../js/engine.js';
import { simulate, validatePicture } from '../js/validate.js';
import { PICTURES, ALBUMS } from '../js/pictures.js';

const byId = (id) => compilePicture(PICTURES.find((p) => p.id === id));

// 64 cells, three colors: 20 / 19 / 25 — every color ends with a partial batch.
const STAR_64 = {
  id: 'proto-star',
  title: 'Prototype Star',
  album: 'night',
  palette: [
    { key: 'Y', name: 'Gold', color: '#ffd23f' },
    { key: 'O', name: 'Amber', color: '#f08a24' },
    { key: 'B', name: 'Night', color: '#2c3e8c' },
  ],
  rows: ['BBBYYBBB', 'BBYYYYBB', 'YYYOOYYY', 'BYOOOOYB', 'BBOOOOBB', 'BYOOOOYB', 'YYOBBOYY', 'YBBBBBBY'],
};

function sortAny(g) {
  const j = g.supply.find(Boolean);
  return g.sort(j.id, j.color);
}

test('every bundled picture passes the level validator', () => {
  for (const def of PICTURES) assert.deepEqual(validatePicture(def), [], def.id);
});

test('library has 20 pictures across four albums with unique ids', () => {
  assert.equal(PICTURES.length, 20);
  assert.equal(new Set(PICTURES.map((p) => p.id)).size, 20);
  for (const a of ALBUMS) assert.equal(PICTURES.filter((p) => p.album === a.id).length, 5, a.id);
});

test('prototype star: 64 cells, three colors, 24-jewel supply, eight-jewel trays', () => {
  const pic = compilePicture(STAR_64);
  assert.equal(pic.cellCount, 64);
  const g = Game.create(pic, 7);
  assert.equal(g.supply.filter(Boolean).length, SUPPLY_SIZE);
  assert.equal(g.trays.length, 3);
  for (const t of g.trays) assert.equal(g.capacity(t.color), TRAY_CAPACITY);
  assert.equal(simulate(pic, 7), 64);
});

test('final batch smaller than eight leaves no extra jewels', () => {
  const pic = compilePicture(STAR_64);
  const g = Game.create(pic, 3);
  const batches = [];
  while (!g.isComplete()) {
    const r = sortAny(g);
    if (r.dispatch) batches.push([r.dispatch.color, r.dispatch.cells.length]);
  }
  for (const c of [0, 1, 2]) {
    const sizes = batches.filter(([col]) => col === c).map(([, n]) => n);
    assert.equal(sizes.reduce((a, b) => a + b, 0), pic.totals[c]);
    assert.equal(sizes.at(-1), pic.totals[c] % TRAY_CAPACITY || TRAY_CAPACITY);
  }
  assert.equal(g.supply.filter(Boolean).length, 0);
  assert.equal(g.trays.length, 0);
});

test('a finished color introduces the next one and the supply stays valid', () => {
  const pic = byId('owl'); // nine colors, six trays at once
  const g = Game.create(pic, 11);
  assert.equal(g.trays.length, MAX_TRAYS);
  let introductions = 0;
  while (!g.isComplete()) {
    const r = sortAny(g);
    if (r.introduced.length) {
      introductions += r.introduced.length;
      const active = new Set(g.trays.map((t) => t.color));
      for (const j of g.supply) if (j) assert.ok(active.has(j.color));
    }
    g.checkInvariants();
  }
  assert.equal(introductions, pic.palette.length - MAX_TRAYS);
});

test('wrong tray is rejected without changing anything', () => {
  const g = Game.create(byId('star'), 5);
  const before = JSON.stringify(g.serialize());
  const jewel = g.supply.find(Boolean);
  const wrong = g.trays.find((t) => t.color !== jewel.color).color;
  const r = g.sort(jewel.id, wrong);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'mismatch');
  assert.equal(JSON.stringify(g.serialize()), before);
});

test('rapidly sorting the same jewel is accepted at most once', () => {
  const g = Game.create(byId('star'), 5);
  const jewel = g.supply.find(Boolean);
  assert.equal(g.sort(jewel.id, jewel.color).ok, true);
  for (let i = 0; i < 5; i++) assert.equal(g.sort(jewel.id, jewel.color).ok, false);
  assert.equal(g.tray(jewel.color).jewels.filter((id) => id === jewel.id).length, 1);
  g.checkInvariants();
});

test('undo returns the last undispatched jewel, but not dispatched ones', () => {
  const pic = byId('heart');
  const g = Game.create(pic, 9);
  const color = g.trays[0].color;
  const pick = () => g.supply.find((j) => j && j.color === color);
  const first = pick();
  g.sort(first.id, color);
  const u = g.undo();
  assert.equal(u.ok, true);
  assert.equal(u.id, first.id);
  assert.ok(g.supply.some((j) => j && j.id === first.id));
  assert.equal(g.tray(color).jewels.length, 0);
  g.checkInvariants();

  let dispatched = false;
  while (!dispatched) dispatched = !!g.sort(pick().id, color).dispatch;
  assert.equal(g.canUndo(), false);
  assert.equal(g.undo().ok, false);
  assert.equal(g.filledCells().size, TRAY_CAPACITY);
});

test('undo with a full supply returns the jewel to queued inventory', () => {
  const g = Game.create(byId('moon'), 2);
  const j = g.supply.find(Boolean);
  g.sort(j.id, j.color);
  // Fill the vacated slot so the supply is full again.
  g.refill(true);
  assert.equal(g.supply.filter(Boolean).length, SUPPLY_SIZE);
  const u = g.undo();
  assert.equal(u.ok, true);
  assert.equal(u.slot, null);
  g.checkInvariants();
});

test('hint points at a valid jewel for the selected tray', () => {
  const g = Game.create(byId('cupcake'), 4);
  const h = g.hint();
  const jewel = g.supply.find((j) => j && j.id === h.jewelId);
  assert.equal(jewel.color, h.color);
  assert.ok(g.tray(h.color));
  assert.equal(g.sort(h.jewelId, h.color).ok, true);
});

test('rearrange keeps inventory and groups colors', () => {
  const g = Game.create(byId('umbrella'), 8);
  for (let i = 0; i < 5; i++) sortAny(g);
  const ids = g.supply.filter(Boolean).map((j) => j.id).sort();
  g.rearrange();
  assert.deepEqual(g.supply.filter(Boolean).map((j) => j.id).sort(), ids);
  const colors = g.supply.filter(Boolean).map((j) => j.color);
  const order = g.trays.map((t) => t.color);
  for (let i = 1; i < colors.length; i++) assert.ok(order.indexOf(colors[i - 1]) <= order.indexOf(colors[i]));
  g.checkInvariants();
});

test('save and restore mid-game resumes the exact state', () => {
  const pic = byId('lighthouse');
  const g = Game.create(pic, 21);
  for (let i = 0; i < 60; i++) sortAny(g);
  const saved = JSON.parse(JSON.stringify(g.serialize()));
  const r = Game.restore(pic, saved);
  assert.ok(r);
  assert.deepEqual(r.serialize(), g.serialize());
  // Both continue identically, including the random deal.
  while (!g.isComplete()) {
    const a = sortAny(g);
    const b = sortAny(r);
    assert.deepEqual(a.dealt, b.dealt);
  }
  assert.ok(r.isComplete());
});

test('restore rejects corrupted or mismatched saves', () => {
  const pic = byId('star');
  const g = Game.create(pic, 1);
  sortAny(g);
  const s = g.serialize();
  assert.equal(Game.restore(byId('heart'), s), null);
  assert.equal(Game.restore({ ...pic, version: 2 }, s), null);
  const dup = structuredClone(s);
  const j = dup.supply.find(Boolean);
  dup.supply[dup.supply.indexOf(null)] = { ...j };
  assert.equal(Game.restore(pic, dup), null);
  const extra = structuredClone(s);
  extra.placed[0] += 1;
  assert.equal(Game.restore(pic, extra), null);
});

test('every picture completes from many seeds with every jewel accounted for', () => {
  for (const def of PICTURES) {
    const pic = compilePicture(def);
    for (let seed = 1; seed <= 15; seed++) assert.equal(simulate(pic, seed), pic.cellCount, `${def.id} seed ${seed}`);
  }
});

test('placement order grows each region from cells already placed', () => {
  for (const def of PICTURES) {
    const pic = compilePicture(def);
    pic.order.forEach((order, color) => {
      const placed = new Set();
      const touches = (i) => {
        const x = i % pic.w;
        const y = (i - x) / pic.w;
        return [
          [x + 1, y],
          [x - 1, y],
          [x, y + 1],
          [x, y - 1],
        ].some(([nx, ny]) => nx >= 0 && ny >= 0 && nx < pic.w && ny < pic.h && placed.has(ny * pic.w + nx));
      };
      for (const i of order) {
        if (placed.size && !touches(i)) {
          // A new region may start only once no unplaced cell of this color
          // borders the cells already placed.
          const frontier = order.filter((j) => !placed.has(j) && touches(j));
          assert.deepEqual(frontier, [], `${def.id} color ${color}`);
        }
        placed.add(i);
      }
    });
  }
});
