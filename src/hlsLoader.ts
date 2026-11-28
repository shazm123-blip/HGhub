import type Hls from "hls.js";

export type HlsCtor = typeof Hls;

let cachedHls: HlsCtor | null = null;
let loadingPromise: Promise<HlsCtor> | null = null;

export function getLoadedHls(): HlsCtor | null {
  return cachedHls;
}

export function loadHls(): Promise<HlsCtor> {
  if (cachedHls) return Promise.resolve(cachedHls);
  if (!loadingPromise) {
    loadingPromise = import("hls.js")
      .then((mod) => {
        cachedHls = mod.default;
        return mod.default;
      })
      .catch((err) => {
        loadingPromise = null;
        throw err;
      });
  }
  return loadingPromise;
}
