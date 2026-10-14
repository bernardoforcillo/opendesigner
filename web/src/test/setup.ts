// Node 25+ ships its own `localStorage` global that is `undefined` unless the
// process starts with --localstorage-file. Vitest does not overwrite a global
// that already exists, so under jsdom the tests saw that undefined instead of
// jsdom's Storage and every test touching localStorage failed. Point the
// globals back at jsdom's Storage when the native one is unusable.
for (const name of ["localStorage", "sessionStorage"] as const) {
  let usable = false;
  try { usable = typeof globalThis[name]?.getItem === "function"; } catch { /* getter throws */ }
  if (usable) continue;
  const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;
  const storage = dom?.window[name];
  if (storage) Object.defineProperty(globalThis, name, { value: storage, configurable: true, writable: true });
}
