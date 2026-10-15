import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePicture, Game, HOLD_SIZE, scatter } from '../js/engine.js';
import { simulate, validatePicture } from '../js/validate.js';
import { PICTURES, ALBUMS } from '../js/pictures.js';

const byId = (id) => compilePicture(PICTURES.find((p) => p.id === id));

// The color with the most jewels out of place.
function richest(g) {
  let best = 0;
  g.picture.palette.forEach((_, c) => {
    if (g.available(c).length > g.available(best).length) best = c;
  });
  return best;
}

function hintMove(g) {
  const h = g.hint();
  return g.place(h.color, h.cell);
}

test('every bundled picture passes the level validator', () => {
  for (const def of PICTURES) assert.deepEqual(validatePicture(def), [], def.id);
});

test('library has 20 pictures across four albums with unique ids', () => {
  assert.equal(PICTURES.length, 20);
  assert.equal(new Set(PICTURES.map((p) => p.id)).size, 20);
  for (const a of ALBUMS) assert.equal(PICTURES.filter((p) => p.album === a.id).length, 5, a.id);
});

test('the scatter covers every spot, keeps inventory, and avoids correct spots', () => {
  for (const def of PICTURES) {
    const pic = compilePicture(def);
    for (let seed = 1; seed <= 5; seed++) {
      const board = scatter(pic, seed);
      const counts = pic.palette.map(() => 0);
      let correct = 0;
      board.forEach((c, i) => {
        if (pic.cells[i] < 0) return assert.equal(c, -1);
        assert.ok(c >= 0, `${def.id} spot ${i} left empty`);
        counts[c]++;
        if (c === pic.cells[i]) correct++;
      });
      assert.deepEqual(counts, pic.totals, def.id);
      // Only a color covering more than half the spots must start partly in place.
      const most = Math.max(...pic.totals);
      assert.equal(correct, Math.max(0, 2 * most - pic.cellCount), def.id);
    }
  }
});

test('a new game has every jewel on the picture and an empty tray', () => {
  const g = Game.create(byId('star'), 7);
  assert.equal(g.emptySpots().length, 0);
  assert.equal(g.hold.length, HOLD_SIZE);
  assert.ok(g.hold.every((c) => c === null));
  g.checkInvariants();
});

test('placing onto occupied spots bumps those jewels into the tray', () => {
  const g = Game.create(byId('butterfly'), 3);
  const color = richest(g);
  const tapped = g.targets(color)[0];
  const sitting = g.board[tapped];
  const r = g.place(color, tapped);
  assert.equal(r.ok, true);
  assert.equal(r.moves[0].to, tapped);
  assert.equal(r.bumps[0].cell, tapped);
  assert.equal(r.bumps[0].color, sitting);
  assert.equal(r.bumps.length, HOLD_SIZE); // tray starts empty with 7 spaces
  assert.equal(r.moves.length, HOLD_SIZE);
  for (const m of r.moves) assert.ok(g.isCorrect(m.to));
  // The jewels that moved left empty spots behind, matching the tray count.
  assert.equal(g.emptySpots().length, g.hold.filter((c) => c !== null).length);
  g.checkInvariants();
});

test('with a full tray, only empty spots are filled; with none, the move is refused', () => {
  const g = Game.create(byId('owl'), 5);
  hintMove(g); // fills the tray with bumped jewels
  assert.equal(g.holdFree(), 0);
  // A color none of whose spots are empty, and with no jewels in the tray.
  const blocked = g.picture.palette
    .map((_, c) => c)
    .find((c) => g.available(c).length && g.targets(c).every((t) => g.board[t] !== -1) && !g.hold.includes(c));
  if (blocked !== undefined) {
    const before = JSON.stringify(g.serialize());
    assert.equal(g.place(blocked, g.targets(blocked)[0]).reason, 'full');
    assert.equal(JSON.stringify(g.serialize()), before);
  }
  // An empty spot can always be filled, and is filled first.
  const empty = new Set(g.emptySpots());
  const r = hintMove(g);
  assert.equal(r.ok, true);
  assert.ok(empty.has(r.moves[0].to));
  // Bumps only use space freed by tray jewels of this color.
  assert.ok(r.bumps.length <= r.moves.filter((m) => m.from.area === 'hold').length);
  g.checkInvariants();
});

test('tray jewels are placed first and free their space for bumps', () => {
  const g = Game.create(byId('lantern'), 2);
  hintMove(g);
  const color = g.hold.find((c) => c !== null);
  const fromTray = g.hold.filter((c) => c === color).length;
  const r = g.place(color, g.targets(color)[0]);
  assert.equal(r.ok, true);
  assert.equal(r.moves.filter((m) => m.from.area === 'hold').length, Math.min(fromTray, r.moves.length));
  assert.equal(r.moves[0].from.area, 'hold');
  g.checkInvariants();
});

test('a spot of another color, or one already correct, is rejected', () => {
  const g = Game.create(byId('star'), 5);
  const before = JSON.stringify(g.serialize());
  const color = richest(g);
  const other = g.picture.cells.findIndex((c) => c >= 0 && c !== color);
  assert.equal(g.place(color, other).reason, 'cell');
  hintMove(g);
  const done = [...g.filledCells()].find((i) => g.picture.cells[i] === color);
  if (done !== undefined) assert.equal(g.place(color, done).reason, 'cell');
  assert.notEqual(JSON.stringify(g.serialize()), before);
});

test('stash lifts misplaced jewels into the tray, and undo puts them back', () => {
  const g = Game.create(byId('cat'), 12);
  const color = richest(g);
  const before = JSON.stringify(g.board);
  const r = g.stash(color);
  assert.equal(r.ok, true);
  assert.equal(r.moves.length, HOLD_SIZE);
  for (const m of r.moves) assert.equal(g.board[m.cell], -1);
  g.checkInvariants();
  assert.equal(g.undo().ok, true);
  assert.equal(JSON.stringify(g.board), before);
  assert.ok(g.hold.every((c) => c === null));
  assert.equal(g.stash(color).ok, true);
  assert.equal(g.stash(richest(g)).reason, 'full');
});

test('undo forgets tray moves whose jewels or spots were used', () => {
  const g = Game.create(byId('heart'), 9);
  const color = richest(g);
  const r = g.stash(color);
  // Filling one of the vacated spots makes that part of the undo stale.
  const spot = r.moves[0].cell;
  const need = g.picture.cells[spot];
  const p = g.place(need, spot);
  assert.equal(p.ok, true);
  g.checkInvariants();
  const u = g.undo();
  if (u.ok) for (const m of u.moves) assert.notEqual(m.cell, spot);
  g.checkInvariants();
});

test('the hint always describes a move that succeeds', () => {
  for (const id of ['star', 'moon', 'owl', 'umbrella']) {
    const g = Game.create(byId(id), 4);
    while (!g.isComplete()) {
      const h = g.hint();
      assert.ok(g.available(h.color).length);
      assert.equal(g.picture.cells[h.cell], h.color);
      assert.equal(hintMove(g).ok, true);
      g.checkInvariants();
    }
    assert.ok(g.hold.every((c) => c === null));
  }
});

test('save and restore mid-game resumes the exact state', () => {
  const pic = byId('lighthouse');
  const g = Game.create(pic, 21);
  for (let i = 0; i < 6; i++) hintMove(g);
  g.stash(richest(g));
  const saved = JSON.parse(JSON.stringify(g.serialize()));
  const r = Game.restore(pic, saved);
  assert.ok(r);
  assert.deepEqual(r.serialize(), g.serialize());
  while (!g.isComplete()) assert.deepEqual(hintMove(g).moves, hintMove(r).moves);
  assert.ok(r.isComplete());
});

test('restore rejects corrupted, mismatched, or old-format saves', () => {
  const pic = byId('star');
  const g = Game.create(pic, 1);
  hintMove(g);
  const s = g.serialize();
  assert.equal(Game.restore(byId('heart'), s), null);
  assert.equal(Game.restore({ ...pic, version: 2 }, s), null);
  assert.equal(Game.restore(pic, { ...s, v: 2 }), null);
  const extra = structuredClone(s);
  assert.ok(g.emptySpots().length > 0);
  extra.board[g.emptySpots()[0]] = 0; // a jewel out of nowhere
  assert.equal(Game.restore(pic, extra), null);
  const lost = structuredClone(s);
  lost.board[lost.board.findIndex((c) => c >= 0)] = -1;
  assert.equal(Game.restore(pic, lost), null);
});

test('every picture completes from many seeds with every jewel accounted for', () => {
  for (const def of PICTURES) {
    const pic = compilePicture(def);
    for (let seed = 1; seed <= 15; seed++) assert.ok(simulate(pic, seed) > 0, `${def.id} seed ${seed}`);
  }
});
