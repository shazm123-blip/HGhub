import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Feed from "../components/Feed";
import { api } from "../api";
import type { VideoCard } from "../types";
import { useStore } from "../store";
import { ISearch } from "../icons";
import { Empty } from "../components/ui";

export default function Home({ active, bottomInset }: { active: boolean; bottomInset: number }) {
  const { toast, lineVersion } = useStore();
  const [items, setItems] = useState<VideoCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const loadingRef = useRef(false);
  const pageRef = useRef(1);
  const doneRef = useRef(false);
  const mounted = useRef(true);
  const lastLineVersion = useRef(lineVersion);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async (p: number, force = false) => {
    if (loadingRef.current || (doneRef.current && !force)) return;
    loadingRef.current = true;
    setLoading(true);
    setError("");
    const lineAtStart = lastLineVersion.current;
    try {
      const res = await api.feed(p, 10);
      if (!mounted.current || lineAtStart !== lastLineVersion.current) return;
      const list = res?.items || [];
      setItems((prev) => {
        const base = p === 1 && force ? [] : prev;
        const seen = new Set(base.map((x) => x.id));
        return [...base, ...list.filter((x) => !seen.has(x.id))];
      });
      pageRef.current = p;
      const isDone = !list.length || !!(res?.pagination && p >= res.pagination.pages);
      doneRef.current = isDone;
      setDone(isDone);
    } catch (e) {
      if (!mounted.current || lineAtStart !== lastLineVersion.current) return;
      const message = (e as Error).message || "加载失败";
      setError(message);
      toast(message, "info");
    } finally {
      loadingRef.current = false;
      if (mounted.current) setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (!items.length) void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (lastLineVersion.current === lineVersion) return;
    lastLineVersion.current = lineVersion;
    loadingRef.current = false;
    doneRef.current = false;
    pageRef.current = 1;
    setItems([]);
    setDone(false);
    setError("");
    void load(1, true);
  }, [lineVersion, load]);

  const ids = useMemo(() => items.map((v) => v.id), [items]);
  const covers = useMemo(() => {
    const map: Record<number, string> = {};
    for (const v of items) {
      if (v.cover) map[v.id] = v.cover;
    }
    return map;
  }, [items]);
  const handleNearEnd = useCallback(() => {
    if (!loadingRef.current && !doneRef.current) void load(pageRef.current + 1);
  }, [load]);

  return (
    <div className="absolute inset-0 bg-black">
      {items.length ? (
        <Feed key={lineVersion} videoIds={ids} initialCovers={covers} mode="home" active={active} bottomInset={bottomInset}
          onNearEnd={handleNearEnd} />
      ) : !loading && error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg">
          <Empty icon={<ISearch size={26} />} title="首页加载失败" sub={error} action="重试" onAction={() => void load(1, true)} />
        </div>
      ) : !loading && done ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg">
          <Empty icon={<ISearch size={26} />} title="暂无视频" action="重试" onAction={() => void load(1, true)} />
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center"><div className="w-9 h-9 spinner" /></div>
      )}
    </div>
  );
}
