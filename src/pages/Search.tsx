import IosNavigation from "../components/IosNavigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmt, isIos, isMacos, isMobile } from "../api";
import type { RankItem, VideoCard } from "../types";
import { useStore } from "../store";
import { Masonry, RankRow } from "../components/cards";
import { Empty, Img } from "../components/ui";
import { IBack, IClose, IFireF, IPlayF, IRefresh, ISearch, ITrophy } from "../icons";

const HOT_TAGS = ["都市", "逆袭", "古风", "系统", "后宫", "校园", "仙侠", "职场", "大男主", "御姐", "脑洞", "奇幻"];

export default function Search({ active, wide }: { active: boolean; wide: boolean }) {
  const { push, searchHist, addSearch, removeSearchHist, clearSearchHist, lineVersion, getVideoOrientation } = useStore();
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState(false);
  const [submitted, setSubmitted] = useState("");
  const [items, setItems] = useState<VideoCard[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [recPool, setRecPool] = useState<RankItem[]>([]);
  const [recOffset, setRecOffset] = useState(0);
  const [recLoading, setRecLoading] = useState(false);
  const recLoadedLineRef = useRef(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const reqSeq = useRef(0);
  const mounted = useRef(true);
  const lastLineVersion = useRef(lineVersion);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (active && !isMobile) inputRef.current?.focus();
  }, [active]);

  const loadRecommendations = useCallback(async (force = false) => {
    if (recLoading) return;
    if (!force && recLoadedLineRef.current === lineVersion && recPool.length > 0) return;
    recLoadedLineRef.current = lineVersion;
    setRecLoading(true);
    try {
      const res = await api.rank("recommend");
      if (!mounted.current) return;
      const list = res?.items || [];
      setRecPool(list);
      setRecOffset(0);
    } catch {
      /* 推荐位静默降级，允许下次激活重试 */
      recLoadedLineRef.current = -1;
    } finally {
      if (mounted.current) setRecLoading(false);
    }
  }, [lineVersion, recLoading, recPool.length]);

  useEffect(() => {
    if (active && recLoadedLineRef.current !== lineVersion) {
      void loadRecommendations(true);
    }
  }, [active, lineVersion, loadRecommendations]);

  const run = useCallback(async (keyword: string, p: number) => {
    if (p > 1 && (busy.current || p > pages)) return;
    const seq = ++reqSeq.current;
    busy.current = true;
    setLoading(true);
    setErr(null);
    try {
      const res = await api.search(keyword, p, 20);
      if (!mounted.current || seq !== reqSeq.current) return;
      setItems((prev) => {
        const base = p === 1 ? [] : prev;
        const seen = new Set(base.map((x) => x.id));
        return [...base, ...(res?.items || []).filter((x) => !seen.has(x.id))];
      });
      setPage(p);
      setPages(res?.pagination?.pages || 1);
      if (typeof res?.pagination?.total === "number") setTotal(res.pagination.total);
      setErr(null);
    } catch (e) {
      if (mounted.current && seq === reqSeq.current) {
        setErr((e as Error).message || "搜索失败");
      }
    } finally {
      if (seq === reqSeq.current) {
        busy.current = false;
        if (mounted.current) setLoading(false);
      }
    }
  }, [pages]);

  const submit = (keyword: string) => {
    const k = keyword.trim();
    if (!k) return;
    inputRef.current?.blur();
    setQ(k);
    setSubmitted(k);
    addSearch(k);
    setItems([]);
    setTotal(0);
    setPage(0);
    setPages(1);
    listRef.current?.scrollTo({ top: 0 });
    void run(k, 1);
  };

  function cancelSearch() {
    reqSeq.current++;
    busy.current = false;
    setLoading(false);
    setErr(null);
    setQ("");
    setSubmitted("");
    setItems([]);
    setTotal(0);
    setPage(0);
    setPages(1);
    setEditing(false);
    inputRef.current?.blur();
  }

  useEffect(() => {
    if (lastLineVersion.current === lineVersion) return;
    lastLineVersion.current = lineVersion;
    setRecPool([]);
    setRecOffset(0);
    if (submitted) {
      setItems([]);
      setTotal(0);
      setPage(0);
      setPages(1);
      void run(submitted, 1);
    }
  }, [lineVersion, submitted, run]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !submitted || err || page < 1 || page >= pages) return undefined;
    const io = new IntersectionObserver(
      (es) => { if (es[0].isIntersecting) void run(submitted, page + 1); },
      { root: listRef.current, rootMargin: "220px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [submitted, page, pages, err, run]);

  const querying = submitted.length > 0;
  const visibleRecs = recPool.length
    ? Array.from({ length: Math.min(6, recPool.length) }, (_, idx) => recPool[(recOffset + idx) % recPool.length])
    : [];

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      {isIos && <IosNavigation title="搜索" />}
      <div className="shrink-0 px-4 pb-3 flex items-center gap-2.5" style={{ paddingTop: isIos ? 4 : "calc(var(--sat, 0px) + 12px)" }}>
        <form className="search-field min-w-0 flex-1 flex items-center gap-2 h-11 rounded-(--r-ctl) bg-s3 px-3.5 focus-within:bg-s4 transition-colors"
          onSubmit={(e) => { e.preventDefault(); submit(q); }}>
          <ISearch size={17} className="text-mut shrink-0" />
          <input ref={inputRef} onFocus={() => { if (isIos) setEditing(true); }} type="search" enterKeyHint="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索短剧、作者、题材…"
            className={`flex-1 min-w-0 bg-transparent ${isMobile ? "text-[16px]" : "text-[13.5px]"} text-on placeholder-dim outline-none`} />
          {(q || querying) && (
            <button type="button" aria-label="清除搜索" onClick={cancelSearch}
              className="shrink-0 w-7 h-7 rounded-full bg-s4 flex items-center justify-center text-mut pressable">
              <IClose size={12} />
            </button>
          )}
          {q.trim().length > 0 && (
            <button type="submit" className="shrink-0 h-7 px-3 rounded-full bg-primary text-on-primary text-[11.5px] font-semibold pressable">
              搜索
            </button>
          )}
        </form>
        {isIos && (editing || querying) ? <button onClick={cancelSearch} className="h-11 text-primary text-[16px]">取消</button> : <button onClick={() => push({ kind: "ranks" })} aria-label="排行榜" title="排行榜"
          className="shrink-0 w-11 h-11 rounded-(--r-sm) flex items-center justify-center bg-primary text-on-primary pressable elev-2">
          <ITrophy size={19} />
        </button>}
      </div>

      <div ref={listRef} className="flex-1 scroll-y px-4" style={{ paddingBottom: "calc(var(--sab, 0px) + 64px)" }}>
        {!querying ? (
          <>
            {searchHist.length > 0 && (
              <div className="mt-1 a-rise">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-bold text-on">搜索历史</span>
                  <button onClick={clearSearchHist} className="text-[11.5px] text-dim hover:text-mut pressable">清空</button>
                </div>
                <div className="flex flex-wrap gap-2 mt-2.5">
                  {searchHist.map((h) => (
                    <div key={h} className="inline-flex items-center rounded-(--r-ctl) bg-s3 overflow-hidden">
                      <button onClick={() => submit(h)} className="pl-3.5 pr-1.5 h-8 text-[12px] text-on/85 pressable">{h}</button>
                      <button type="button" aria-label={`删除 ${h}`} onClick={() => removeSearchHist(h)}
                        className="pr-2.5 pl-1 h-8 flex items-center text-dim hover:text-on pressable">
                        <IClose size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-5 rounded-(--r-md) bg-s2 p-3.5 a-rise">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[13px] font-semibold text-on/90"><IFireF size={15} className="text-primary" />热门题材</span>
                <button onClick={() => push({ kind: "ranks" })} className="text-[11.5px] text-primary font-semibold pressable">完整榜单 ›</button>
              </div>
              <div className="flex flex-wrap gap-2 mt-3">
                {HOT_TAGS.map((t) => (
                  <button key={t} onClick={() => submit(t)}
                    className="px-3 h-7 rounded-(--r-ctl) bg-s3 text-[12px] text-on/85 pressable">{t}</button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between mt-6 mb-3">
              <span className="text-[13px] font-bold text-on">为你推荐</span>
              <button
                onClick={() => {
                  if (recPool.length > 6) setRecOffset((n) => (n + 6) % recPool.length);
                  else void loadRecommendations(true);
                }}
                disabled={recLoading}
                className="flex items-center gap-1 text-[11.5px] text-mut hover:text-primary pressable disabled:opacity-60">
                <IRefresh size={13} className={recLoading ? "animate-spin" : ""} />换一批
              </button>
            </div>
            {visibleRecs.length ? (
              <div className={`grid gap-2.5 ${wide ? "grid-cols-6" : "grid-cols-3"}`}>
                {visibleRecs.map((it) => {
                  const ori = getVideoOrientation(it.video_id);
                  return (
                    <button key={it.video_id}
                      onClick={() => push({
                        kind: "feed",
                        videoIds: recPool.map((x) => x.video_id),
                        index: recPool.findIndex((x) => x.video_id === it.video_id),
                        title: "为你推荐",
                        covers: Object.fromEntries(recPool.map((x) => [x.video_id, x.cover])),
                      })}
                      className="text-left pressable">
                      <div className="cover-frame relative w-full aspect-[3/4] rounded-(--r-sm) overflow-hidden bg-s1 elev-1">
                        <Img src={it.cover} />
                        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/75 to-transparent" />
                        {ori && (
                          <span className="absolute top-1.5 right-1.5 px-1 py-0.5 rounded bg-black/65 text-[9.5px] text-white/95 leading-none">
                            {ori.orientation === "landscape" ? "横屏" : "竖屏"}
                          </span>
                        )}
                        <span className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5 text-[10px] font-semibold text-white/90 tsh">
                          <IPlayF size={9} />{fmt(it.metrics?.play ?? it.metric_value)}
                        </span>
                      </div>
                      <div className="cover-title mt-1.5 text-[12px] font-medium text-on clamp-1 leading-tight">{it.title}</div>
                      <div className="text-[10.5px] text-mut clamp-1 mt-0.5">{it.tags?.slice(0, 2).join(" · ")}</div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-[12px] text-dim leading-relaxed">
                输入关键词后按回车搜索，也可以点击上方热门题材快速找剧。
              </p>
            )}
          </>
        ) : (
          <>
            <div className="text-[12px] text-mut mt-1 mb-2.5">
              「{submitted}」共 <span className="text-primary font-bold">{total || items.length}</span> 条结果
            </div>
            {items.length ? (
              <>
                <Masonry videos={items} wide={wide} onOpen={(v) => push({
                  kind: "feed",
                  videoIds: items.map((x) => x.id),
                  index: items.findIndex((x) => x.id === v.id),
                  title: `搜索 · ${submitted}`,
                  covers: Object.fromEntries(items.map((x) => [x.id, x.cover])),
                })} />
                <div ref={sentinelRef} className="h-6" />
                <div className="flex justify-center py-4">
                  {loading ? <div className="w-6 h-6 spinner" />
                    : err ? (
                      <button onClick={() => void run(submitted, page + 1)} className="px-5 h-9 rounded-(--r-ctl) bg-s3 text-[12px] text-primary pressable">加载失败，重试</button>
                    ) : page < pages ? (
                      <button onClick={() => void run(submitted, page + 1)} className="px-5 h-9 rounded-(--r-ctl) bg-s3 text-[12px] text-on/85 pressable">加载更多</button>
                    ) : <span className="text-[11px] text-dim">— 已经到底啦 —</span>}
                </div>
              </>
            ) : loading ? (
              <div className="flex justify-center py-12"><div className="w-8 h-8 spinner" /></div>
            ) : (
              <Empty icon={<ISearch size={26} />} title={err || "没有找到相关内容"}
                sub={err ? "请检查网络或切换线路后重试" : "换个关键词试试，比如「都市」「逆袭」"}
                action={err ? "重试" : "看看热榜"}
                onAction={() => (err ? void run(submitted, 1) : push({ kind: "ranks" }))} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ================= 排行榜 ================= */
const RANK_TABS = [
  { k: "hot", label: "热播榜", desc: "按热力指数排序" },
  { k: "recommend", label: "推荐榜", desc: "按推荐值排序" },
  { k: "potential", label: "潜力榜", desc: "按潜力值排序" },
] as const;

export function RankPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push, toast, lineVersion } = useStore();
  const [tab, setTab] = useState<"hot" | "recommend" | "potential">("hot");
  const [items, setItems] = useState<RankItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api.rank(tab)
      .then((res) => { if (alive) setItems(res?.items || []); })
      .catch((e) => {
        if (alive) {
          const msg = (e as Error).message || "榜单加载失败";
          setItems([]);
          setErr(msg);
          toast(msg, "info");
        }
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tab, toast, reloadTick, lineVersion]);

  const max = Math.max(1, ...items.map((x) => x.metric_value || 0));
  const meta = RANK_TABS.find((t) => t.k === tab)!;

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      {isIos && <IosNavigation title="HG 热榜" subtitle={`${meta.desc} · 每 10 分钟更新`} onBack={onBack} />}
      <div className="shrink-0 relative overflow-hidden bg-s1" style={{ paddingTop: isIos ? 0 : "var(--sat, 0px)" }}>
        {!isIos && !isMacos && <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(90% 120% at 100% 0%, var(--p-pc) 0%, transparent 60%)", opacity: 0.32 }} />}
        <div className={`relative px-3 pt-2 pb-4 ${wide ? "max-w-[780px] mx-auto" : ""}`}>
          {isMacos && <p className="text-xs text-mut">{meta.desc} · 每 10 分钟更新</p>}
          {!isIos && !isMacos && <>
          <button onClick={onBack} aria-label="返回" className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></button>
          <div className="px-2 mt-1 flex items-end justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="shrink-0 w-9 h-9 rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center"><ITrophy size={20} /></span>
                <span className="text-[24px] font-bold tracking-wide text-on">HG 热榜</span>
              </div>
              <div className="text-[11px] text-mut mt-1">{meta.desc} · 每 10 分钟更新</div>
            </div>
          </div>
          </>}
          <div className="segment-control flex bg-s3 rounded-(--r-ctl) p-1 mt-3">
            {RANK_TABS.map((t) => (
              <button aria-pressed={tab === t.k} key={t.k} onClick={() => setTab(t.k)}
                className={`flex-1 h-8 rounded-(--r-ctl) text-[12px] font-semibold transition-all ${tab === t.k ? "tonal elev-1" : "text-mut"}`}
                style={tab === t.k ? { background: "var(--p-sec)", color: "var(--p-primary)" } : undefined}>{t.label}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 scroll-y px-3.5 pt-3" style={{ paddingBottom: "calc(var(--sab, 0px) + 24px)" }}>
        <div className={wide ? "max-w-[780px] mx-auto" : ""}>
          {loading ? (
            <div className="flex justify-center py-12"><div className="w-8 h-8 spinner" /></div>
          ) : items.length ? (
            items.map((it) => (
              <RankRow key={`${it.video_id}-${it.rank}`} item={it} metricMax={max}
                onOpen={() => push({
                  kind: "feed",
                  videoIds: items.map((x) => x.video_id),
                  index: items.findIndex((x) => x.video_id === it.video_id),
                  title: "HG 热榜",
                  covers: Object.fromEntries(items.map((x) => [x.video_id, x.cover])),
                })} />
            ))
          ) : err ? (
            <Empty icon={<ITrophy size={26} />} title="榜单加载失败" sub={err} action="重试" onAction={() => setReloadTick((n) => n + 1)} />
          ) : (
            <Empty icon={<ITrophy size={26} />} title="榜单暂时为空" sub="稍后再来看看，或者去首页刷刷推荐" />
          )}
          {wide && <div className="h-2" />}
        </div>
      </div>
    </div>
  );
}