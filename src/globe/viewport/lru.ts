export interface LruCache<K, V> {
  get(key: K): V | undefined
  set(key: K, value: V): void
  delete(key: K): void
  size(): number
}

/** 简单 LRU（Map 插入序）：命中/写入时移到末尾，超容量淘汰最久未用。视口 Primitive 缓存用。 */
export function createLru<K, V>(capacity: number): LruCache<K, V> {
  const map = new Map<K, V>()
  return {
    get(key) {
      if (!map.has(key)) return undefined
      const value = map.get(key) as V
      map.delete(key)
      map.set(key, value)
      return value
    },
    set(key, value) {
      if (map.has(key)) map.delete(key)
      map.set(key, value)
      if (map.size > capacity) {
        const oldest = map.keys().next().value as K
        map.delete(oldest)
      }
    },
    delete(key) {
      map.delete(key)
    },
    size() {
      return map.size
    },
  }
}

/** 把视口 envelope 量化成缓存 key（网格化，避免相机微动导致缓存失效）。 */
export function viewportCacheKey(env: { west: number; south: number; east: number; north: number }, grid = 0.5): string {
  const wx = Math.round(env.west / grid)
  const sy = Math.round(env.south / grid)
  const ex = Math.round(env.east / grid)
  const ny = Math.round(env.north / grid)
  return wx + ',' + sy + ',' + ex + ',' + ny
}
