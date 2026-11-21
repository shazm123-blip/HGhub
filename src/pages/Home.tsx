import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Feed from "../components/Feed";
import { api } from "../api";
import type { VideoCard } from "../types";
import { useStore } from "../store";
import { ISearch } from "../icons";
import { Empty } from "../components/ui";

const HOME_FEED_STORAGE_KEY = "hghub_home_feed_v1";
const MAX_SEEN_IDS = 200;
const PRIMARY_RANDOM_WINDOW = 60;
const MAX_PICK_ATTEMPTS = 3;

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
  const { toast, lineVersion, homeRefresh, history } = useStore();
  const initialPersist = useMemo(loadFeedState, []);
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
  const historyIdsRef = useRef<Set<number>>(new Set(history.map((h) => h.id)));
  historyIdsRef.current = new Set(history.map((h) => h.id));

  const visitedPagesRef = useRef<Set<number>>(new Set());
  const itemsRef = useRef<VideoCard[]>([]);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

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
          saveFeedState(totalPagesRef.current, seenIdsRef.current);
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

        const seenSet = new Set(seenIdsRef.current);
        const unseen = shuffle(deduped.filter((item) => !seenSet.has(item.id) && !historyIdsRef.current.has(item.id)));
        const seen = shuffle(deduped.filter((item) => seenSet.has(item.id) || historyIdsRef.current.has(item.id)));

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
        saveFeedState(totalPagesRef.current, []);
        toCommit = fallbackBatch;
      }

      if (toCommit.length) {
        const nextItems = reset ? toCommit : [...itemsRef.current, ...toCommit];
        itemsRef.current = nextItems;
        setItems(nextItems);
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
  }, [toast]);

  useEffect(() => {
    void load(true, false);
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
    saveFeedState(totalPagesRef.current, next);
  }, []);

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
          <Empty icon={<ISearch size={26} />} title="首页加载失败" sub={error} action="重试" onAction={() => void load(true, false)} />
        </div>
      ) : !loading && done ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg">
          <Empty icon={<ISearch size={26} />} title="暂无视频" action="重试" onAction={() => void load(true, false)} />
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center"><div className="w-9 h-9 spinner" /></div>
      )}
    </div>
  );
}
