import { useCallback, useSyncExternalStore } from "react";
import { api } from "./api";
import type { Detail, VideoOrientationMeta, VideoSnapshot } from "./types";

const LS_CACHE = "hghub_cache_v1";
const MAX_SNAPSHOTS = 120;
const MAX_ORIENTATIONS = 300;
const MAX_DETAIL_CACHE = 80;

type CachePersist = {
  videoSnapshots: Record<number, VideoSnapshot>;
  videoOrientations: Record<number, VideoOrientationMeta>;
};

let cacheState: CachePersist = loadCachePersist();
let dirty = false;
let saveTimer: number | undefined;

const snapshotListeners = new Set<() => void>();
const orientationListeners = new Map<number, Set<() => void>>();

function notifyOrientation(id: number): void {
  orientationListeners.get(id)?.forEach((fn) => fn());
}

function loadCachePersist(): CachePersist {
  try {
    const raw = localStorage.getItem(LS_CACHE);
    if (!raw) return { videoSnapshots: {}, videoOrientations: {} };
    const parsed = JSON.parse(raw) as Partial<CachePersist>;
    return {
      videoSnapshots: parsed.videoSnapshots && typeof parsed.videoSnapshots === "object" ? parsed.videoSnapshots : {},
      videoOrientations: parsed.videoOrientations && typeof parsed.videoOrientations === "object" ? parsed.videoOrientations : {},
    };
  } catch {
    return { videoSnapshots: {}, videoOrientations: {} };
  }
}

export function flushVideoMetaCache(): void {
  if (typeof window !== "undefined" && saveTimer !== undefined) {
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  if (!dirty) return;
  dirty = false;
  try {
    localStorage.setItem(LS_CACHE, JSON.stringify(cacheState));
  } catch { /* ignore */ }
}

function scheduleSave(): void {
  dirty = true;
  if (typeof window === "undefined") return;
  if (saveTimer !== undefined) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    flushVideoMetaCache();
  }, 2000);
}

let lifecycleBound = false;
export function bindVideoMetaPersistence(): () => void {
  if (typeof window === "undefined" || lifecycleBound) return () => {};
  lifecycleBound = true;
  const onHide = () => {
    if (document.visibilityState === "hidden") flushVideoMetaCache();
  };
  window.addEventListener("pagehide", flushVideoMetaCache);
  document.addEventListener("visibilitychange", onHide);
  return () => {
    lifecycleBound = false;
    window.removeEventListener("pagehide", flushVideoMetaCache);
    document.removeEventListener("visibilitychange", onHide);
    flushVideoMetaCache();
  };
}

/** 从旧版 hghub_app_v1 迁移一次缓存（仅当新版缓存为空时生效） */
export function seedLegacyVideoMetaCache(
  snapshots?: Record<number, VideoSnapshot>,
  orientations?: Record<number, VideoOrientationMeta>,
): boolean {
  let hasNew = false;
  try {
    hasNew = !!localStorage.getItem(LS_CACHE);
  } catch { /* ignore */ }
  if (hasNew) return false;
  if (!snapshots && !orientations) return false;
  cacheState = {
    videoSnapshots: snapshots && typeof snapshots === "object" ? snapshots : cacheState.videoSnapshots,
    videoOrientations: orientations && typeof orientations === "object" ? orientations : cacheState.videoOrientations,
  };
  scheduleSave();
  snapshotListeners.forEach((fn) => fn());
  for (const k of Object.keys(cacheState.videoOrientations)) {
    notifyOrientation(Number(k));
  }
  return true;
}

export function getVideoOrientation(id: number): VideoOrientationMeta | undefined {
  return id ? cacheState.videoOrientations[id] : undefined;
}

export function recordVideoOrientation(id: number, w: number, h: number): void {
  if (!id || w <= 0 || h <= 0) return;
  const orientation: VideoOrientationMeta["orientation"] = w > h ? "landscape" : "portrait";
  const prev = cacheState.videoOrientations[id];
  if (prev && prev.orientation === orientation && prev.w === w && prev.h === h) return;
  const entries = Object.entries(cacheState.videoOrientations);
  const nextOrientations: Record<number, VideoOrientationMeta> =
    entries.length >= MAX_ORIENTATIONS
      ? Object.fromEntries(entries.slice(-(MAX_ORIENTATIONS - 1)))
      : { ...cacheState.videoOrientations };
  nextOrientations[id] = { orientation, w, h };
  cacheState = { ...cacheState, videoOrientations: nextOrientations };
  scheduleSave();
  notifyOrientation(id);
}

export function useVideoOrientation(id: number): VideoOrientationMeta | undefined {
  const subscribe = useCallback(
    (fn: () => void) => {
      if (!id) return () => {};
      let set = orientationListeners.get(id);
      if (!set) {
        set = new Set();
        orientationListeners.set(id, set);
      }
      set.add(fn);
      return () => {
        const cur = orientationListeners.get(id);
        if (!cur) return;
        cur.delete(fn);
        if (cur.size === 0) orientationListeners.delete(id);
      };
    },
    [id],
  );
  const getSnapshot = useCallback(
    () => (id ? cacheState.videoOrientations[id] : undefined),
    [id],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function getVideoSnapshots(): Record<number, VideoSnapshot> {
  return cacheState.videoSnapshots;
}

export function upsertVideoSnapshot(snap: Omit<VideoSnapshot, "updatedAt">): void {
  if (!snap.id || !snap.title) return;
  const cur = cacheState.videoSnapshots[snap.id];
  const nextEntry: VideoSnapshot = { ...cur, ...snap, updatedAt: Date.now() };
  const map: Record<number, VideoSnapshot> = { ...cacheState.videoSnapshots, [snap.id]: nextEntry };
  const keys = Object.keys(map);
  let finalMap = map;
  if (keys.length > MAX_SNAPSHOTS) {
    const sorted = keys
      .map((k) => map[Number(k)])
      .filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SNAPSHOTS);
    const trimmed: Record<number, VideoSnapshot> = {};
    for (const item of sorted) trimmed[item.id] = item;
    finalMap = trimmed;
  }
  cacheState = { ...cacheState, videoSnapshots: finalMap };
  scheduleSave();
  snapshotListeners.forEach((fn) => fn());
}

const subscribeSnapshots = (fn: () => void) => {
  snapshotListeners.add(fn);
  return () => { snapshotListeners.delete(fn); };
};

export function useVideoSnapshots(): Record<number, VideoSnapshot> {
  return useSyncExternalStore(subscribeSnapshots, getVideoSnapshots);
}

/* ── 跨页共享短剧详情 LRU 缓存（按 lineVersion 隔离） + 并发受控批量请求 ── */

const detailLru = new Map<string, Detail>();
const detailInflight = new Map<string, Promise<Detail>>();

function detailKey(lineVersion: number, id: number): string {
  return `${lineVersion}:${id}`;
}

export function getCachedVideoDetail(lineVersion: number, id: number): Detail | undefined {
  const k = detailKey(lineVersion, id);
  const hit = detailLru.get(k);
  if (!hit) return undefined;
  detailLru.delete(k);
  detailLru.set(k, hit);
  return hit;
}

function putCachedVideoDetail(lineVersion: number, detail: Detail): void {
  const k = detailKey(lineVersion, detail.id);
  if (detailLru.has(k)) detailLru.delete(k);
  detailLru.set(k, detail);
  while (detailLru.size > MAX_DETAIL_CACHE) {
    const oldest = detailLru.keys().next().value;
    if (oldest === undefined) break;
    detailLru.delete(oldest);
  }
}

export function clearVideoDetailCache(): void {
  detailLru.clear();
  detailInflight.clear();
}

export function fetchVideoDetailCached(lineVersion: number, id: number): Promise<Detail> {
  const cached = getCachedVideoDetail(lineVersion, id);
  if (cached) return Promise.resolve(cached);
  const k = detailKey(lineVersion, id);
  const existing = detailInflight.get(k);
  if (existing) return existing;
  const req = api.video(id)
    .then((d) => {
      putCachedVideoDetail(lineVersion, d);
      upsertVideoSnapshot({
        id: d.id,
        title: d.title,
        cover: d.cover,
        score: d.score,
        episode_count: d.episode_count,
        is_finished: d.is_finished,
      });
      return d;
    })
    .finally(() => {
      detailInflight.delete(k);
    });
  detailInflight.set(k, req);
  return req;
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (!items.length) return [];
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  const workers = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const runWorker = async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = { status: "fulfilled", value: await fn(items[idx]) };
      } catch (reason) {
        results[idx] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, runWorker));
  return results;
}
