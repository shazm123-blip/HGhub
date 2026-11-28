import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Feed from "../components/Feed";
import { api, cover } from "../api";
import type { VideoCard } from "../types";
import { useStoreActions, useDataVersion } from "../store";
import { IRefresh } from "../icons";
import { Empty } from "../components/ui";

const HOME_FEED_STORAGE_KEY = "hghub_home_feed_v1";
const HOME_SNAPSHOT_KEY = "hghub_home_snapshot_v1";
const MAX_SEEN_IDS = 200;
const PRIMARY_RANDOM_WINDOW = 60;
const MAX_PICK_ATTEMPTS = 3;

type HomeSnapshot = { id: number; title: string; cover: string; author?: string };

function loadHomeSnapshot(): HomeSnapshot | null {
  try {
    const raw = localStorage.getItem(HOME_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<HomeSnapshot>;
    if (typeof parsed?.id === "number" && typeof parsed?.title === "string") {
      return { id: parsed.id, title: parsed.title, cover: typeof parsed.cover === "string" ? parsed.cover : "", author: typeof parsed.author === "string" ? parsed.author : undefined };
    }
  } catch { /* ignore */ }
  return null;
}

function saveHomeSnapshot(card: VideoCard | undefined) {
  try {
    if (!card) return;
    localStorage.setItem(HOME_SNAPSHOT_KEY, JSON.stringify({
      id: card.id,
      title: card.title,
      cover: card.cover || "",
      author: card.author?.name,
    } satisfies HomeSnapshot));
  } catch { /* ignore */ }
}

type HomeFeedPersist = {
  totalPages: number;
  seenIds: number[];
};

function loadFeedState(): HomeFeedPersist {
  try {
    const raw = localStorage.getItem(HOME_FEED_STORAGE_KEY);
    if (!raw) return { totalPages: 1, seenIds: [] };
    const parsed = JSON.parse(raw) as Partial<HomeFeedPersist>;
    const totalPages = typeof parsed.totalPages === "number" && parsed.totalPages > 0 ? Math.floor(parsed.totalPages) : 1;
    const seenIds = Array.isArray(parsed.seenIds)
      ? parsed.seenIds.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).slice(0, MAX_SEEN_IDS)
      : [];
    return { totalPages, seenIds };
  } catch {
    return { totalPages: 1, seenIds: [] };
  }
}

function saveFeedState(totalPages: number, seenIds: number[]) {
  try {
    localStorage.setItem(HOME_FEED_STORAGE_KEY, JSON.stringify({
      totalPages: Math.max(1, Math.floor(totalPages)),
      seenIds: seenIds.slice(0, MAX_SEEN_IDS),
    }));
  } catch { /* ignore */ }
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function pickRandomPage(visited: Set<number>, totalPages: number): number | null {
  const maxPages = Math.max(1, Math.floor(totalPages));
  if (maxPages <= 1) return visited.has(1) ? null : 1;
  const primaryCap = Math.min(maxPages, PRIMARY_RANDOM_WINDOW);
  const primaryPool: number[] = [];
  for (let p = 1; p <= primaryCap; p++) {
    if (!visited.has(p)) primaryPool.push(p);
  }
  if (primaryPool.length > 0) {
    return primaryPool[Math.floor(Math.random() * primaryPool.length)];
  }
  const restPool: number[] = [];
  for (let p = primaryCap + 1; p <= maxPages; p++) {
    if (!visited.has(p)) restPool.push(p);
  }
  if (restPool.length > 0) {
    return restPool[Math.floor(Math.random() * restPool.length)];
  }
  return null;
}

export default function Home({ active, bottomInset }: { active: boolean; bottomInset: number }) {
  const { toast, setLinePickerOpen, getHistoryIds } = useStoreActions();
  const { lineVersion, homeRefresh } = useDataVersion();
  const initialPersist = useMemo(loadFeedState, []);
  const [snapshot, setSnapshot] = useState<HomeSnapshot | null>(loadHomeSnapshot);
  const [items, setItems] = useState<VideoCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [feedSession, setFeedSession] = useState(0);

  const loadingRef = useRef(false);
  const doneRef = useRef(false);
  const mounted = useRef(true);
  const lastLineVersion = useRef(lineVersion);
  const lastHomeRefresh = useRef(homeRefresh);

  const totalPagesRef = useRef(initialPersist.totalPages);
  const seenIdsRef = useRef<number[]>(initialPersist.seenIds);

  const visitedPagesRef = useRef<Set<number>>(new Set());
  const itemsRef = useRef<VideoCard[]>([]);
  const requestSeqRef = useRef(0);
  const feedSaveTimerRef = useRef<number | undefined>(undefined);
  const feedDirtyRef = useRef(false);

  const flushFeedState = useCallback(() => {
    if (feedSaveTimerRef.current !== undefined) {
      window.clearTimeout(feedSaveTimerRef.current);
      feedSaveTimerRef.current = undefined;
    }
    if (!feedDirtyRef.current) return;
    feedDirtyRef.current = false;
    saveFeedState(totalPagesRef.current, seenIdsRef.current);
  }, []);

  const scheduleFeedStateSave = useCallback((immediate = false) => {
    feedDirtyRef.current = true;
    if (immediate) {
      flushFeedState();
      return;
    }
    if (feedSaveTimerRef.current !== undefined) window.clearTimeout(feedSaveTimerRef.current);
    feedSaveTimerRef.current = window.setTimeout(() => {
      feedSaveTimerRef.current = undefined;
      flushFeedState();
    }, 1500);
  }, [flushFeedState]);

  useEffect(() => {
    mounted.current = true;
    const onHide = () => {
      if (document.visibilityState === "hidden") flushFeedState();
    };
    window.addEventListener("pagehide", flushFeedState);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", flushFeedState);
      document.removeEventListener("visibilitychange", onHide);
      flushFeedState();
    };
  }, [flushFeedState]);

  const load = useCallback(async (reset = false, notify = false) => {
    if (!reset && (loadingRef.current || doneRef.current)) return;
    const reqSeq = ++requestSeqRef.current;
    loadingRef.current = true;
    setLoading(true);
    setError("");

    if (reset) {
      visitedPagesRef.current = new Set();
      doneRef.current = false;
      setDone(false);
      itemsRef.current = [];
      setItems([]);
      setFeedSession((s) => s + 1);
    }

    const lineAtStart = lastLineVersion.current;
    try {
      const existingIds = new Set(reset ? [] : itemsRef.current.map((x) => x.id));
      let chosen: VideoCard[] = [];
      let fallbackBatch: VideoCard[] = [];

      for (let attempt = 0; attempt < MAX_PICK_ATTEMPTS; attempt++) {
        const p = pickRandomPage(visitedPagesRef.current, totalPagesRef.current);
        if (p == null) break;
        visitedPagesRef.current.add(p);

        const res = await api.feed(p, 10);
        if (!mounted.current || reqSeq !== requestSeqRef.current || lineAtStart !== lastLineVersion.current) return;

        if (res?.pagination?.pages && res.pagination.pages > 0) {
          totalPagesRef.current = res.pagination.pages;
          scheduleFeedStateSave();
        }

        const deduped: VideoCard[] = [];
        const batchSeenIds = new Set(existingIds);
        for (const item of res?.items || []) {
          if (!batchSeenIds.has(item.id)) {
            batchSeenIds.add(item.id);
            deduped.push(item);
          }
        }
        if (!deduped.length) continue;

        const historyIds = getHistoryIds();
        const seenSet = new Set(seenIdsRef.current);
        const unseen = shuffle(deduped.filter((item) => !seenSet.has(item.id) && !historyIds.has(item.id)));
        const seen = shuffle(deduped.filter((item) => seenSet.has(item.id) || historyIds.has(item.id)));

        if (unseen.length > 0) {
          chosen = unseen.length >= 3 ? unseen : [...unseen, ...seen];
          break;
        }
        if (!fallbackBatch.length) fallbackBatch = seen;
      }

      if (!mounted.current || reqSeq !== requestSeqRef.current || lineAtStart !== lastLineVersion.current) return;

      let toCommit = chosen;
      if (!toCommit.length && fallbackBatch.length) {
        seenIdsRef.current = [];
        scheduleFeedStateSave(true);
        toCommit = fallbackBatch;
      }

      if (toCommit.length) {
        const nextItems = reset ? toCommit : [...itemsRef.current, ...toCommit];
        itemsRef.current = nextItems;
        setItems(nextItems);
        if (reset) {
          saveHomeSnapshot(nextItems[0]);
          setSnapshot(nextItems[0] ? {
            id: nextItems[0].id,
            title: nextItems[0].title,
            cover: nextItems[0].cover || "",
            author: nextItems[0].author?.name,
          } : null);
        }
        if (notify) toast("已为你换一批", "info");
      }

      const exhausted = visitedPagesRef.current.size >= Math.max(1, totalPagesRef.current) || !toCommit.length;
      doneRef.current = exhausted;
      setDone(exhausted);
    } catch (e) {
      if (!mounted.current || reqSeq !== requestSeqRef.current || lineAtStart !== lastLineVersion.current) return;
      const message = (e as Error).message || "加载失败";
      setError(message);
      toast(message, "info");
    } finally {
      if (reqSeq === requestSeqRef.current) {
        loadingRef.current = false;
        if (mounted.current) setLoading(false);
      }
    }
  }, [toast, scheduleFeedStateSave, getHistoryIds]);

  useEffect(() => {
    if (!loadingRef.current && !itemsRef.current.length && !doneRef.current) {
      void load(true, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (lastLineVersion.current === lineVersion) return;
    lastLineVersion.current = lineVersion;
    void load(true, false);
  }, [lineVersion, load]);

  useEffect(() => {
    if (lastHomeRefresh.current === homeRefresh) return;
    lastHomeRefresh.current = homeRefresh;
    void load(true, true);
  }, [homeRefresh, load]);

  const handleView = useCallback((id: number) => {
    if (!id) return;
    const cur = seenIdsRef.current;
    if (cur[0] === id) return;
    const next = [id, ...cur.filter((x) => x !== id)].slice(0, MAX_SEEN_IDS);
    seenIdsRef.current = next;
    scheduleFeedStateSave();
  }, [scheduleFeedStateSave]);

  const ids = useMemo(() => items.map((v) => v.id), [items]);
  const covers = useMemo(() => {
    const map: Record<number, string> = {};
    for (const v of items) {
      if (v.cover) map[v.id] = v.cover;
    }
    return map;
  }, [items]);
  const handleNearEnd = useCallback(() => {
    if (!loadingRef.current && !doneRef.current) void load(false, false);
  }, [load]);

  return (
    <div className="absolute inset-0 bg-black">
      {items.length ? (
        <Feed key={`${lineVersion}-${feedSession}`} videoIds={ids} initialCovers={covers} mode="home" active={active} bottomInset={bottomInset}
          onNearEnd={handleNearEnd} onView={handleView} />
      ) : !loading && error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg">
          <Empty
            icon={<IRefresh size={26} />}
            title="首页加载失败"
            sub={error}
            action="重试"
            onAction={() => void load(true, false)}
            secondaryAction="切换线路"
            onSecondaryAction={() => setLinePickerOpen(true)}
          />
        </div>
      ) : !loading && done ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg">
          <Empty icon={<IRefresh size={26} />} title="暂无视频" action="重试" onAction={() => void load(true, false)} />
        </div>
      ) : (
        <div className="absolute inset-0 overflow-hidden bg-black flex flex-col items-center justify-center">
          {snapshot?.cover && (
            <>
              <img
                src={cover(snapshot.cover, 720)}
                alt=""
                decoding="async"
                className="absolute inset-0 w-full h-full object-cover opacity-45 pointer-events-none"
              />
              <div
                className="absolute inset-0 pointer-events-none"
                style={{ background: "linear-gradient(180deg, rgba(0,0,0,.45) 0%, rgba(0,0,0,.35) 45%, rgba(0,0,0,.92) 100%)" }}
              />
            </>
          )}
          <div className="relative z-10 flex flex-col items-center gap-3 px-6 text-center">
            <div className="w-9 h-9 spinner" />
            <div className="rounded-full hg-chip-strong px-4 py-1.5 text-[12px] font-medium text-white/85">
              正在准备推荐短剧…
            </div>
            {snapshot?.title && (
              <div className="max-w-[260px] text-[12px] text-white/55 truncate">{snapshot.title}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
