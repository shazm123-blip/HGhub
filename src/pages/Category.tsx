import IosNavigation from "../components/IosNavigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, isIos, isMacos, fmt } from "../api";
import type { Post, VideoCard } from "../types";
import { useStore } from "../store";
import { Masonry, RowCard } from "../components/cards";
import { Empty, Img } from "../components/ui";
import { IBack, IChevR, IClapper, IFileText, IGrid, IRefresh, ISparkF, IStarsF, ITrophy } from "../icons";

export const CHANNELS = [
  { cate: "original", name: "黄果原创", desc: "原创短剧与漫剧" },
  { cate: "ai-duanju", name: "AI成人短剧", desc: "高能反转 · 一口气看完" },
  { cate: "ai-manju", name: "AI成人漫剧", desc: "国创漫剧 · 每周更新" },
] as const;

const CHANNEL_ICON: Record<string, ReactNode> = {
  original: <IStarsF size={19} />,
  "ai-duanju": <IClapper size={19} strokeWidth={1.85} />,
  "ai-manju": <ISparkF size={18} />,
};

function HorizontalRow({ wide, children }: { wide: boolean; children: ReactNode }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const sync = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    sync();
    const el = scrollerRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sync, children]);

  const scrollStep = (dir: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(220, el.clientWidth * 0.78), behavior: "smooth" });
  };

  return (
    <div className="relative group/row">
      <div ref={scrollerRef} onScroll={sync} className="scroll-x scroll-pl-4 flex gap-2.5 px-4 snap-x">
        {children}
      </div>
      {wide && canLeft && (
        <button type="button" aria-label="向左滚动" onClick={() => scrollStep(-1)}
          className="hidden sm:flex absolute left-2 top-[76px] -translate-y-1/2 z-10 w-8 h-8 rounded-full bg-s1/90 backdrop-blur-md text-on items-center justify-center elev-2 opacity-0 group-hover/row:opacity-100 focus:opacity-100 transition-opacity pressable">
          <IBack size={15} />
        </button>
      )}
      {wide && canRight && (
        <button type="button" aria-label="向右滚动" onClick={() => scrollStep(1)}
          className="hidden sm:flex absolute right-2 top-[76px] -translate-y-1/2 z-10 w-8 h-8 rounded-full bg-s1/90 backdrop-blur-md text-on items-center justify-center elev-2 opacity-0 group-hover/row:opacity-100 focus:opacity-100 transition-opacity pressable">
          <IChevR size={15} />
        </button>
      )}
    </div>
  );
}

/* ================= 分类总览 ================= */
export default function Category({ wide, active }: { wide: boolean; active: boolean }) {
  const { push, lineVersion } = useStore();
  const [rows, setRows] = useState<Record<string, VideoCard[]>>({});
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(false);
  const started = useRef(false);
  const pending = useRef(new Map<string, symbol>());
  const lastLineVersion = useRef(lineVersion);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const loadPreview = useCallback(async (key: string, force = false) => {
    if (!force && pending.current.has(key)) return;
    const request = Symbol(key);
    pending.current.set(key, request);
    const isCurrent = () => mounted.current && pending.current.get(key) === request;
    setLoading(m => ({ ...m, [key]: true }));
    setErrors(m => ({ ...m, [key]: "" }));
    try {
      if (key === "posts") {
        const result = await api.posts(1, 8);
        if (isCurrent()) setPosts(result?.items || []);
      } else {
        const result = await api.category(key, 1, 8);
        if (isCurrent()) setRows(m => ({ ...m, [key]: result?.items || [] }));
      }
    } catch (error) {
      if (isCurrent()) setErrors(m => ({ ...m, [key]: (error as Error).message || "加载失败" }));
    } finally {
      if (isCurrent()) {
        pending.current.delete(key);
        setLoading(m => ({ ...m, [key]: false }));
      }
    }
  }, []);

  const refreshAll = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await Promise.allSettled([
        ...CHANNELS.map((c) => loadPreview(c.cate, true)),
        loadPreview("posts", true),
      ]);
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  };

  useEffect(() => {
    if (lastLineVersion.current === lineVersion) return;
    lastLineVersion.current = lineVersion;
    started.current = false;
    pending.current.clear();
    setRows({});
    setPosts([]);
    setLoading({});
    setErrors({});
  }, [lineVersion]);

  useEffect(() => {
    // 首次打开分类（或切线后再次进入）才加载，避免启动时后台频道请求/封面与首页视频竞争网络。
    if (!active || started.current) return;
    started.current = true;
    CHANNELS.forEach(c => { void loadPreview(c.cate); });
    void loadPreview("posts");
  }, [active, loadPreview, lineVersion]);

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      {isIos ? <IosNavigation title="分类" subtitle={`${CHANNELS.length + 1} 个频道 · 每周持续上新`} action={<button aria-label="刷新分类" disabled={refreshing} onClick={() => void refreshAll()}><IRefresh size={20} className={refreshing ? "animate-spin" : ""} /></button>} /> : (
      <div className="shrink-0 px-4 pb-1 flex items-end justify-between" style={{ paddingTop: isMacos ? 10 : "calc(var(--sat, 0px) + 14px)" }}>
        <div className="flex items-end gap-2.5">
          {!isMacos && <span className="text-[24px] font-bold text-on leading-none">分类</span>}
          <span className={`text-[11.5px] text-mut ${isMacos ? "" : "pb-0.5"}`}>{CHANNELS.length + 1} 个频道 · 每周持续上新</span>
        </div>
        <button
          onClick={() => { void refreshAll(); }}
          disabled={refreshing}
          aria-label="刷新分类"
          title="刷新分类"
          className="shrink-0 w-9 h-9 rounded-full bg-s3 flex items-center justify-center text-mut pressable disabled:opacity-60">
          <IRefresh size={16} className={refreshing ? "animate-spin" : ""} />
        </button>
      </div>
      )}
      <div className="flex-1 scroll-y pt-2" style={{ paddingBottom: "calc(var(--sab, 0px) + 64px)" }}>
        {/* 排行榜入口 */}
        <button onClick={() => push({ kind: "ranks" })}
          className="mx-4 mb-5 w-[calc(100%-2rem)] flex items-center gap-3 rounded-(--r-md) bg-s2 p-3.5 text-left pressable elev-1">
          <span className="w-10 h-10 rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center shrink-0"><ITrophy size={20} /></span>
          <span className="flex-1">
            <span className="block text-[14.5px] font-semibold text-on">排行榜</span>
            <span className="block text-[11px] text-mut mt-0.5">热播榜 · 推荐榜 · 潜力榜</span>
          </span>
          <IChevR size={16} className="shrink-0 text-mut" />
        </button>

        {CHANNELS.map((c, ci) => {
          const list = rows[c.cate] || [];
          const rowCovers = Object.fromEntries(list.map((x) => [x.id, x.cover]));
          return (
            <section key={c.cate} aria-label={c.name} className="mb-5 a-rise" style={{ animationDelay: `${Math.min(ci * 50, 300)}ms` }}>
              <button onClick={() => push({ kind: "channel", cate: c.cate, name: c.name })}
                className="w-full flex items-center gap-2.5 px-4 mb-2.5 text-left pressable group">
                <span className="w-[36px] h-[36px] rounded-(--r-sm) tonal flex items-center justify-center shrink-0 text-primary">
                  {CHANNEL_ICON[c.cate] || <IGrid size={19} strokeWidth={1.9} />}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[15.5px] font-semibold text-on leading-tight">{c.name}</span>
                  <span className="block text-[11px] text-mut mt-0.5 truncate">{c.desc}</span>
                </span>
                <span className="shrink-0 flex items-center gap-0.5 text-[12px] text-mut group-hover:text-primary transition-colors">
                  全部<IChevR size={14} />
                </span>
              </button>
              <HorizontalRow wide={wide}>
                {list.map((v) => (
                  <RowCard key={v.id} v={v} onOpen={() => push({
                    kind: "feed",
                    videoIds: list.map((x) => x.id),
                    index: list.findIndex((x) => x.id === v.id),
                    title: c.name,
                    covers: rowCovers,
                  })} />
                ))}
                {!list.length && <PreviewStatus name={c.name} loading={loading[c.cate] !== false} error={errors[c.cate]} onRetry={() => void loadPreview(c.cate)} />}
              </HorizontalRow>
            </section>
          );
        })}

        {/* 吃瓜 */}
        <section aria-label="黄果吃瓜" className="mb-5 a-rise">
          <button onClick={() => push({ kind: "posts" })}
            className="w-full flex items-center gap-2.5 px-4 mb-2.5 text-left pressable group">
            <span className="w-[36px] h-[36px] rounded-(--r-sm) tonal flex items-center justify-center shrink-0 text-primary">
              <IFileText size={19} strokeWidth={1.9} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[15.5px] font-semibold text-on leading-tight">黄果吃瓜</span>
              <span className="block text-[11px] text-mut mt-0.5 truncate">圈内爆料 · 每日更新</span>
            </span>
            <span className="shrink-0 flex items-center gap-0.5 text-[12px] text-mut group-hover:text-primary transition-colors">
              全部<IChevR size={14} />
            </span>
          </button>
          <HorizontalRow wide={wide}>
            {posts.map((post) => (
              <button key={post.id} onClick={() => push({ kind: "post", id: post.id })}
                className="row-cover w-[108px] shrink-0 text-left snap-start pressable">
                <div className="cover-frame relative w-full aspect-[3/4] rounded-(--r-sm) overflow-hidden bg-s1 elev-1">
                  <Img src={post.cover} eager />
                  <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/75 to-transparent" />
                  <span className="absolute bottom-1.5 right-1.5 text-[10px] font-semibold text-white/90 tsh">{fmt(post.hot)}</span>
                </div>
                <div className="cover-title mt-1.5 text-[12px] font-medium text-on clamp-1 leading-tight">{post.title}</div>
              </button>
            ))}
            {!posts.length && <PreviewStatus name="黄果吃瓜" loading={loading.posts !== false} error={errors.posts} onRetry={() => void loadPreview("posts")} />}
          </HorizontalRow>
        </section>

        <div className="px-4 text-center text-[11px] text-dim pt-1">— 已展示全部频道 —</div>
      </div>
    </div>
  );
}

function PreviewStatus({ name, loading, error, onRetry }: { name: string; loading: boolean; error?: string; onRetry: () => void }) {
  return <div className="h-[176px] flex flex-col justify-center items-start gap-2 text-[11.5px] text-dim px-1">
    <span>{loading ? "加载中…" : error || "暂无内容"}</span>
    {!loading && error && <button aria-label={`重试${name}`} onClick={onRetry} className="text-primary pressable">重试</button>}
  </div>;
}

/* ================= 频道详情页 ================= */
export function ChannelPage({ cate, name, onBack, wide }: { cate: string; name: string; onBack: () => void; wide: boolean }) {
  const { push, lineVersion } = useStore();
  const [sort, setSort] = useState<"new" | "hot">("new");
  const [onlyFinished, setOnlyFinished] = useState(false);
  const [items, setItems] = useState<VideoCard[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const pageRef = useRef(0);
  const pagesRef = useRef(1);
  const reqSeq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const loadMore = async (reset = false, overrideSort = sort) => {
    if (!reset && (busy.current || pageRef.current >= pagesRef.current)) return;
    const seq = ++reqSeq.current;
    busy.current = true;
    setLoading(true);
    if (reset) setRefreshing(true);
    try {
      const next = reset ? 1 : pageRef.current + 1;
      const res = await api.category(cate, next, 20, overrideSort);
      if (!mounted.current || seq !== reqSeq.current) return;
      setItems((prev) => {
        const base = reset ? [] : prev;
        const seen = new Set(base.map((x) => x.id));
        return [...base, ...(res?.items || []).filter((x) => !seen.has(x.id))];
      });
      pageRef.current = next;
      const totalPages = res?.pagination?.pages || next;
      pagesRef.current = totalPages;
      setPage(next);
      setPages(totalPages);
      if (typeof res?.pagination?.total === "number") setTotal(res.pagination.total);
      setErr(null);
    } catch (e) {
      if (mounted.current && seq === reqSeq.current) {
        setErr((e as Error).message || "加载失败");
      }
    } finally {
      if (seq === reqSeq.current) {
        busy.current = false;
        if (mounted.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }
  };

  useEffect(() => {
    setItems([]);
    setTotal(0);
    pageRef.current = 0;
    pagesRef.current = 1;
    setPage(0);
    setPages(1);
    setErr(null);
    busy.current = false;
    listRef.current?.scrollTo({ top: 0 });
    void loadMore(true, sort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cate, sort, lineVersion]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || err || page < 1 || page >= pages) return undefined;
    const io = new IntersectionObserver(
      (es) => { if (es[0].isIntersecting) void loadMore(); },
      { root: listRef.current, rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pages, err, sort]);

  const displayed = useMemo(
    () => (onlyFinished ? items.filter((v) => v.is_finished) : items),
    [items, onlyFinished],
  );
  const subtitleText = `共 ${total || items.length} 部 · 已加载 ${page}/${Math.max(pages, 1)} 页`;

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      {isIos && (
        <IosNavigation
          title={name}
          subtitle={subtitleText}
          onBack={onBack}
          action={
            <button aria-label="刷新频道" disabled={refreshing} onClick={() => { listRef.current?.scrollTo({ top: 0, behavior: "smooth" }); void loadMore(true); }}>
              <IRefresh size={20} className={refreshing ? "animate-spin" : ""} />
            </button>
          }
        />
      )}
      <div className="shrink-0 bg-s1" style={{ paddingTop: isIos || isMacos ? 0 : "var(--sat, 0px)" }}>
        {!isIos && (
          <div className="px-3 pt-2 pb-2.5 flex items-center gap-2.5">
            {!isMacos && <>
              <button onClick={onBack} aria-label="返回" className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></button>
              <span className="shrink-0 w-[40px] h-[40px] rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center">
                {CHANNEL_ICON[cate] || <IGrid size={21} strokeWidth={1.9} />}
              </span>
            </>}
            <div className="flex-1 min-w-0">
              {!isMacos && <div className="text-[17px] font-bold text-on leading-tight truncate">{name}</div>}
              <div className="text-[11px] text-mut">{subtitleText}</div>
            </div>
            <button
              onClick={() => {
                listRef.current?.scrollTo({ top: 0, behavior: "smooth" });
                void loadMore(true);
              }}
              disabled={refreshing}
              aria-label="刷新频道"
              title="刷新频道"
              className="shrink-0 w-9 h-9 rounded-full bg-s3 flex items-center justify-center text-mut pressable disabled:opacity-60">
              <IRefresh size={16} className={refreshing ? "animate-spin" : ""} />
            </button>
          </div>
        )}
        <div className={isIos ? "flex items-center gap-2 mx-4 my-2.5" : "px-4 pb-3 flex items-center gap-2"}>
          <div className={isIos ? "segment-control flex flex-1" : "flex gap-2"}>
            {([["new", "最新"], ["hot", "最热"]] as const).map(([k, label]) => (
              <button aria-pressed={sort === k} key={k} onClick={() => setSort(k)}
                className={`${isIos ? "flex-1" : "px-4"} h-8 rounded-(--r-ctl) text-[12px] font-semibold pressable ${sort === k ? "tonal text-on-sec" : "bg-s3 text-mut"}`}
                style={sort === k ? { background: "var(--p-sec)", color: "var(--p-primary)" } : undefined}>{label}</button>
            ))}
          </div>
          <button
            type="button"
            aria-pressed={onlyFinished}
            onClick={() => setOnlyFinished((v) => !v)}
            className={`ml-auto px-3 h-8 rounded-(--r-ctl) text-[12px] font-semibold pressable transition-colors ${onlyFinished ? "bg-primary text-on-primary" : "bg-s3 text-mut"}`}>
            仅看已完结
          </button>
        </div>
      </div>
      <div ref={listRef} className="flex-1 scroll-y px-4 pt-3" style={{ paddingBottom: "calc(var(--sab, 0px) + 24px)" }}>
        {displayed.length ? (
          <Masonry videos={displayed} wide={wide} onOpen={(v) => push({
            kind: "feed",
            videoIds: displayed.map((x) => x.id),
            index: displayed.findIndex((x) => x.id === v.id),
            title: name,
            covers: Object.fromEntries(displayed.map((x) => [x.id, x.cover])),
          })} />
        ) : items.length > 0 && onlyFinished ? (
          <Empty
            icon={<IGrid size={26} />}
            title={`已加载的 ${items.length} 部中暂无已完结剧集`}
            sub={page < pages ? "可以继续加载更多分集查看，或关闭「仅看已完结」" : "该频道当前全部内容均未完结"}
            action={page < pages ? "加载下一页" : "查看全部"}
            onAction={() => (page < pages ? void loadMore() : setOnlyFinished(false))}
          />
        ) : err ? (
          <Empty icon={<IGrid size={26} />} title="加载失败" sub={err} action="重试" onAction={() => void loadMore(true)} />
        ) : loading ? (
          <div className="flex justify-center py-10"><div className="w-8 h-8 spinner" /></div>
        ) : (
          <Empty icon={<IGrid size={26} />} title="暂无内容" sub="稍后再来看看，或点击右上角刷新" action="刷新" onAction={() => void loadMore(true)} />
        )}
        <div ref={sentinel} className="h-10" />
        {loading && !refreshing && <div className="flex justify-center py-3"><div className="w-6 h-6 spinner" /></div>}
        {!loading && err && items.length > 0 && (
          <div className="flex flex-col items-center gap-2 py-3 text-[11.5px] text-mut">
            <span>{err}</span>
            <button onClick={() => void loadMore()} className="px-4 h-7 rounded-(--r-ctl) bg-s3 text-primary pressable">重试加载</button>
          </div>
        )}
        {!loading && !err && page >= pages && displayed.length > 0 && (
          <div className="text-center text-[11px] text-dim py-3">— 已经到底啦 —</div>
        )}
      </div>
    </div>
  );
}
