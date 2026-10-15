// Offline save: a versioned JSON document kept in localStorage with one
// backup copy. setItem replaces a key atomically, so the primary is only
// overwritten once the new document is fully serialized, and the previous
// good copy is kept as the backup.

export const SAVE_VERSION = 1;

export const DEFAULT_SETTINGS = {
  sound: true,
  volume: 0.7,
  vibration: true,
  reducedMotion: false,
  largeJewels: false,
  largeText: false,
  showPreview: true,
  drag: true,
};

export function defaultSave() {
  return {
    saveVersion: SAVE_VERSION,
    settings: { ...DEFAULT_SETTINGS },
    completed: {}, // pictureId -> timestamp of first completion
    games: {}, // pictureId -> serialized unfinished game
    seen: {}, // one-time explanations already shown
  };
}

function parse(text) {
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    return migrate(data);
  } catch {
    return null;
  }
}

// Upgrades older documents and fills fields added since they were written.
export function migrate(data) {
  if (!data || typeof data !== 'object' || !Number.isInteger(data.saveVersion)) return null;
  if (data.saveVersion > SAVE_VERSION) return null;
  const base = defaultSave();
  return {
    ...base,
    ...data,
    saveVersion: SAVE_VERSION,
    settings: { ...base.settings, ...data.settings },
    completed: { ...data.completed },
    games: { ...data.games },
    seen: { ...data.seen },
  };
}

export class SaveStore {
  constructor(storage, key = 'jewel-mosaic.save') {
    this.storage = storage;
    this.key = key;
    this.backupKey = `${key}.backup`;
  }

  load() {
    const get = (k) => {
      try {
        return this.storage?.getItem(k);
      } catch {
        return null;
      }
    };
    return parse(get(this.key)) ?? parse(get(this.backupKey)) ?? defaultSave();
  }

  write(data) {
    if (!this.storage) return false;
    try {
      const json = JSON.stringify(data);
      const previous = this.storage.getItem(this.key);
      if (previous && parse(previous)) this.storage.setItem(this.backupKey, previous);
      this.storage.setItem(this.key, json);
      return true;
    } catch {
      return false;
    }
  }
}
