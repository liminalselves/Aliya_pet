import { readFileSync } from 'node:fs';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Tauri uses JSON Merge Patch (RFC 7396): arrays replace, objects recurse,
// null removes a key. Never concatenate windows/icons or merge them by index.
export function mergeConfig(base, patch) {
  if (!isObject(patch)) return structuredClone(patch);
  const result = isObject(base) ? structuredClone(base) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else Object.defineProperty(result, key, {
      value: mergeConfig(Object.hasOwn(result, key) ? result[key] : undefined, value),
      enumerable: true, writable: true, configurable: true,
    });
  }
  return result;
}

export function readMacosConfig() {
  const read = (name) => JSON.parse(readFileSync(new URL(`../src-tauri/${name}`, import.meta.url), 'utf8'));
  return mergeConfig(read('tauri.conf.json'), read('tauri.macos.conf.json'));
}
