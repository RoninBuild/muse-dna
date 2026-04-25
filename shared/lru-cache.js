const DEFAULT_MAX_SIZE = 200;

/**
 * A minimal LRU cache backed by a Map.
 * Map insertion order gives us free LRU eviction.
 */
export function createLruCache(maxSize = DEFAULT_MAX_SIZE) {
  const store = new Map();
  const limit = Math.max(1, maxSize);

  return {
    has(key) {
      return store.has(key);
    },

    get(key) {
      if (!store.has(key)) return undefined;

      // Move to end (most recently used)
      const value = store.get(key);
      store.delete(key);
      store.set(key, value);
      return value;
    },

    set(key, value) {
      if (store.has(key)) {
        store.delete(key);
      } else if (store.size >= limit) {
        // Evict the oldest entry (first key in iteration order)
        const oldestKey = store.keys().next().value;
        store.delete(oldestKey);
      }

      store.set(key, value);
    },

    get size() {
      return store.size;
    },

    clear() {
      store.clear();
    }
  };
}
