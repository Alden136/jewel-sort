import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SaveStore, defaultSave, SAVE_VERSION } from '../js/storage.js';

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}

test('fresh storage loads defaults', () => {
  const store = new SaveStore(new MemoryStorage());
  assert.deepEqual(store.load(), defaultSave());
});

test('write then load round-trips and keeps one backup', () => {
  const mem = new MemoryStorage();
  const store = new SaveStore(mem);
  const a = defaultSave();
  a.completed.star = 1;
  store.write(a);
  const b = store.load();
  b.completed.moon = 2;
  store.write(b);
  assert.deepEqual(store.load().completed, { star: 1, moon: 2 });
  assert.deepEqual(JSON.parse(mem.getItem('jewel-mosaic.save.backup')).completed, { star: 1 });
});

test('a corrupted primary falls back to the backup', () => {
  const mem = new MemoryStorage();
  const store = new SaveStore(mem);
  const a = defaultSave();
  a.completed.star = 1;
  store.write(a);
  store.write(a);
  mem.setItem('jewel-mosaic.save', '{"saveVersion":1,"comp');
  assert.deepEqual(store.load().completed, { star: 1 });
});

test('newer save versions are not misread', () => {
  const mem = new MemoryStorage();
  mem.setItem('jewel-mosaic.save', JSON.stringify({ saveVersion: SAVE_VERSION + 1 }));
  assert.deepEqual(new SaveStore(mem).load(), defaultSave());
});

test('missing settings are filled from defaults', () => {
  const mem = new MemoryStorage();
  mem.setItem('jewel-mosaic.save', JSON.stringify({ saveVersion: 1, settings: { sound: false } }));
  const s = new SaveStore(mem).load();
  assert.equal(s.settings.sound, false);
  assert.equal(s.settings.vibration, true);
});

test('failing storage never throws', () => {
  const broken = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('quota');
    },
  };
  const store = new SaveStore(broken);
  assert.deepEqual(store.load(), defaultSave());
  assert.equal(store.write(defaultSave()), false);
});
