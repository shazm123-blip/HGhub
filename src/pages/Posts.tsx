import IosNavigation from "../components/IosNavigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, isIos, isMacos, cover, fmt, isMobile } from "../api";
import type { Comment, Post } from "../types";
import { useStore } from "../store";
import { Avatar, Empty, Img } from "../components/ui";
import Player from "../components/Player";
import { pushBackHandler } from "../back";
import { IBack, IClose, IComment, IFireF, IHeart, IHeartF, IPlayF, IRefresh, IStar, IStarF } from "../icons";
import { handleArticleClick, sanitizeHtml } from "../html";

/* ================= 吃瓜列表 ================= */
export function PostsPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push, lineVersion } = useStore();
  const [items, setItems] = useState<Post[]>([]);
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

  const loadMore = async (reset = false) => {
    if (!reset && (busy.current || pageRef.current >= pagesRef.current)) return;
    const seq = ++reqSeq.current;
    busy.current = true;
    setLoading(true);
    if (reset) setRefreshing(true);
    try {
      const next = reset ? 1 : pageRef.current + 1;
      const res = await api.posts(next, 20);
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
      setErr(null);
    } catch (e) {
      if (mounted.current && seq === reqSeq.current) setErr((e as Error).message || "加载失败");
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
    pageRef.current = 0;
    pagesRef.current = 1;
    setPage(0);
    setPages(1);
    setErr(null);
    busy.current = false;
    void loadMore(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineVersion]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || err || page < 1 || page >= pages) return undefined;
    const io = new IntersectionObserver(
      (es) => { if (es[0].isIntersecting) void loadMore(); },
      { root: listRef.current, rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pages, err]);

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      {isIos ? (
        <IosNavigation
          title="黄果吃瓜"
          subtitle="圈内爆料"
          onBack={onBack}
          action={
            <button aria-label="刷新" disabled={refreshing} onClick={() => { listRef.current?.scrollTo({ top: 0, behavior: "smooth" }); void loadMore(true); }}>
              <IRefresh size={20} className={refreshing ? "animate-spin" : ""} />
            </button>
          }
        />
      ) : (
        <div className="shrink-0 bg-s1" style={{ paddingTop: isMacos ? 0 : "var(--sat, 0px)" }}>
          <div className="h-11 flex items-center gap-2 px-3">
            {!isMacos && (
              <>
                <button onClick={onBack} aria-label="返回" className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={19} /></button>
                <span className="text-[14px] font-bold text-on">黄果吃瓜</span>
              </>
            )}
            <span className="text-[11px] text-mut ml-1">圈内爆料</span>
            <button
              onClick={() => { listRef.current?.scrollTo({ top: 0, behavior: "smooth" }); void loadMore(true); }}
              disabled={refreshing}
              aria-label="刷新"
              title="刷新"
              className="ml-auto shrink-0 w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-mut pressable disabled:opacity-60">
              <IRefresh size={15} className={refreshing ? "animate-spin" : ""} />
            </button>
          </div>
        </div>
      )}
      <div ref={listRef} className="flex-1 scroll-y px-3 pt-3" style={{ paddingBottom: "calc(var(--sab, 0px) + 24px)" }}>
        {items.length ? (
          <div className={`grid ${wide ? "grid-cols-3 xl:grid-cols-4" : "grid-cols-2"} gap-2`}>
            {items.map((p) => (
              <button key={p.id} onClick={() => push({ kind: "post", id: p.id })}
                className="cover-frame w-full aspect-[4/5] relative rounded-(--r-sm) overflow-hidden bg-s1 elev-1 pressable block text-left">
                <Img src={p.cover} />
                <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/90 via-black/40 to-transparent" />
                <div className="absolute inset-x-0 bottom-0 p-2">
                  <div className="text-[12px] font-medium text-white clamp-2 leading-snug tsh">{p.title}</div>
                  <div className="flex items-center gap-1 mt-1 text-[10px] text-white/75">
                    <IFireF size={10} className="text-white/75" />{fmt(p.hot)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        ) : loading ? (
          <div className="flex justify-center py-12"><div className="w-8 h-8 spinner" /></div>
        ) : err ? (
          <Empty icon={<IFireF size={26} />} title="加载失败" sub={err} action="重试" onAction={() => void loadMore(true)} />
        ) : (
          <Empty icon={<IFireF size={26} />} title="暂无吃瓜内容" sub="稍后再来看看" />
        )}
        <div ref={sentinel} className="h-10" />
        {loading && !refreshing && <div className="flex justify-center py-2"><div className="w-6 h-6 spinner" /></div>}
        {!loading && err && items.length > 0 && (
          <div className="flex flex-col items-center gap-2 py-3 text-[11.5px] text-mut">
            <span>{err}</span>
            <button onClick={() => void loadMore()} className="px-4 h-7 rounded-(--r-ctl) bg-s3 text-primary pressable">重试加载</button>
          </div>
        )}
        {!loading && !err && page >= pages && items.length > 0 && (
          <div className="text-center text-[11px] text-dim py-3">— 已经到底啦 —</div>
        )}
      </div>
    </div>
  );
}

const isHtml = (s: string) => /<(p|div|br|img|h[1-6]|ul|ol|li|blockquote|span|strong|em)\b/i.test(s);

function validPostCounts(raw: Post["counts"]): NonNullable<Post["counts"]> {
  const counts: NonNullable<Post["counts"]> = {};
  for (const key of ["like", "collect", "comment", "share", "hot"] as const) {
    const value = raw?.[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) counts[key] = value;
  }
  return counts;
}

/* ================= 吃瓜详情（网页式浏览） ================= */
export function PostDetail({ id, onBack, active = true }: { id: number; onBack: () => void; active?: boolean }) {
  const { toast, strictSecurity, muted, setMuted, volume, user, isLiked, isFav, changeInteraction, setLoginOpen, lineVersion } = useStore();
  const [post, setPost] = useState<(Post & { content?: string; video_url?: string }) | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [play, setPlay] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [countsRetry, setCountsRetry] = useState(0);
  const [countsStatus, setCountsStatus] = useState<"idle" | "refreshing" | "failed">("idle");
  const liked = !!user && isLiked(id, true);
  const collected = !!user && isFav(id, true);
  const detailKey = JSON.stringify([lineVersion, id, reloadTick]);
  const loadedDetailKey = useRef<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState("");
  const [comments, setComments] = useState<Comment[]>([]);
  const [cPage, setCPage] = useState(0);
  const [cPages, setCPages] = useState(1);
  const [cLoading, setCLoading] = useState(false);
  const [cErr, setCErr] = useState<string | null>(null);
  const cSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const content = post?.content || "";
  const safeHtml = useMemo(() => sanitizeHtml(content), [content, strictSecurity]);
  const openSafeLink = (url: string) => {
    api.openUrl(url).catch(() => {
      navigator.clipboard?.writeText(url).then(() => toast("链接已复制", "ok")).catch(() => {});
    });
  };

  useEffect(() => {
    if (!lightboxUrl) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLightboxUrl(""); };
    window.addEventListener("keydown", onKey);
    const releaseBack = pushBackHandler(() => { setLightboxUrl(""); return true; });
    return () => {
      window.removeEventListener("keydown", onKey);
      releaseBack();
    };
  }, [lightboxUrl]);

  useEffect(() => {
    let alive = true;
    const refreshCounts = loadedDetailKey.current === detailKey;
    if (refreshCounts) {
      setCountsStatus("refreshing");
    } else {
      setCountsStatus("idle");
      setErr(null);
      setPost(null);
      setPlay(false);
    }
    api.post(id)
      .then((data) => {
        if (!alive) return;
        if (!data) throw new Error("加载失败");
        const counts = validPostCounts(data.counts);
        const complete = counts.like !== undefined && counts.collect !== undefined && counts.comment !== undefined;
        setCountsStatus(complete ? "idle" : "failed");
        if (refreshCounts) {
          setPost(current => current ? { ...current, counts: { ...current.counts, ...counts } } : current);
        } else {
          loadedDetailKey.current = detailKey;
          setPost({ ...data, counts });
        }
      })
      .catch((e) => {
        if (!alive) return;
        if (refreshCounts) setCountsStatus("failed");
        else setErr((e as Error).message || "加载失败");
      });
    return () => { alive = false; };
  }, [id, detailKey, liked, collected, countsRetry]);

  const loadComments = async (p: number) => {
    const seq = ++cSeqRef.current;
    setCLoading(true);
    setCErr(null);
    try {
      const res = await api.postComments(id, p, 20);
      if (!mountedRef.current || seq !== cSeqRef.current) return;
      setComments((prev) => {
        const base = p === 1 ? [] : prev;
        const seen = new Set(base.map((x) => x.id));
        return [...base, ...(res?.items || []).filter((x) => !seen.has(x.id))];
      });
      setCPage(p);
      setCPages(res?.pagination?.pages || 1);
    } catch (e) {
      if (mountedRef.current && seq === cSeqRef.current) setCErr((e as Error).message || "评论加载失败");
    } finally {
      if (mountedRef.current && seq === cSeqRef.current) setCLoading(false);
    }
  };

  useEffect(() => {
    setComments([]);
    setCPage(0);
    setCPages(1);
    setCErr(null);
    void loadComments(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, lineVersion]);

  const togglePostInteraction = async (field: "likes" | "favs") => {
    if (!user) { setLoginOpen(true); return; }
    try {
      const on = await changeInteraction(field, id, { post: true });
      if (on === null || !mountedRef.current) return;
      if (field === "likes") toast(on ? "已点赞" : "已取消点赞", on ? "heart" : "info");
      else toast(on ? "已收藏" : "已取消收藏", on ? "star" : "info");
    } catch (error) {
      if (mountedRef.current) toast((error as Error).message || "操作失败，请重试", "info");
    }
  };

  const likeCount = post?.counts?.like;
  const collectCount = post?.counts?.collect;

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      {isIos ? <IosNavigation title="吃瓜详情" onBack={onBack} /> : !isMacos && (
      <div className="shrink-0 flex items-center gap-2 px-2 bg-s1" style={{ paddingTop: isMobile ? "var(--sat, 0px)" : 0, height: isMobile ? "calc(44px + var(--sat, 0px))" : 44 }}>
        <button onClick={onBack} aria-label="返回" className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={19} /></button>
        <span className="text-[13.5px] font-semibold text-on">吃瓜详情</span>
      </div>
      )}
      <div className="flex-1 scroll-y" style={{ paddingBottom: "calc(var(--sab, 0px) + 28px)" }}>
        {err ? (
          <Empty icon={<IFireF size={26} />} title="加载失败" sub={err} action="重试" onAction={() => setReloadTick((n) => n + 1)} />
        ) : !post ? (
          <div className="flex justify-center py-12"><div className="w-8 h-8 spinner" /></div>
        ) : (
          <div className="max-w-[760px] mx-auto">
            {post.video_url ? (
              <div className="relative w-full bg-black md:rounded-(--r-md) md:mt-3 overflow-hidden" style={{ height: "min(44dvh, 400px)" }}>
                {play ? (
                  <Player src={post.video_url} poster={cover(post.cover)} autoPlay active={active} controls muted={muted} volume={volume}
                    onToggleMute={() => setMuted((m) => !m)} diagnosticContext={{ video_id: id, active }} className="w-full h-full" />
                ) : (
                  <button onClick={() => setPlay(true)} aria-label="播放视频" className="absolute inset-0">
                    <Img src={post.cover} eager />
                    <span className="absolute inset-0 flex items-center justify-center">
                      <span className="w-14 h-14 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center elev-2">
                        <IPlayF size={24} className="text-white ml-0.5" />
                      </span>
                    </span>
                  </button>
                )}
              </div>
            ) : post.cover ? (
              <button
                type="button"
                aria-label="查看大图"
                onClick={() => setLightboxUrl(cover(post.cover, 1200))}
                className="relative block w-full bg-s1 md:rounded-(--r-md) md:mt-3 overflow-hidden cursor-zoom-in"
                style={{ height: "min(36dvh, 320px)" }}>
                <Img src={post.cover} eager />
              </button>
            ) : null}

            <div className="px-4 pt-3.5">
              <h1 className="select-text text-[17.5px] font-bold text-on leading-snug">{post.title}</h1>
              <div className="flex items-center gap-2.5 mt-2 text-[11px] text-mut">
                <span>{post.publish_time || post.created_at}</span>
                <span className="flex items-center gap-1"><IFireF size={11} />{fmt(post.hot)}</span>
              </div>
              {!!post.tags?.length && (
                <div className="flex flex-wrap gap-1.5 mt-2.5">
                  {post.tags.slice(0, 8).map((t) => (
                    <span key={t} className="px-2.5 py-0.5 rounded-(--r-ctl) bg-s3 text-[11px] text-on/75">#{t}</span>
                  ))}
                </div>
              )}
              {post.content && (
                (isHtml(post.content) || (!strictSecurity && /<[a-z][\s\S]*>/i.test(post.content)))
                  ? (
                    <div
                      className="article-body mt-4"
                      onClick={(e) => {
                        const target = e.target;
                        if (target instanceof HTMLImageElement && target.src) {
                          e.preventDefault();
                          e.stopPropagation();
                          setLightboxUrl(target.src);
                          return;
                        }
                        handleArticleClick(e, openSafeLink);
                      }}
                      dangerouslySetInnerHTML={{ __html: safeHtml }}
                    />
                  )
                  : <div className="select-text mt-4 rounded-(--r-md) bg-s2 p-3.5 text-[13px] leading-relaxed text-on/85 whitespace-pre-wrap">{post.content}</div>
              )}

              {/* 互动栏 */}
              <div className="flex items-center gap-3 mt-6 pt-4 border-t border-s3">
                <button type="button" onClick={() => void togglePostInteraction("likes")} aria-pressed={liked}
                  className={`flex items-center gap-1.5 px-4 h-9 rounded-full text-[12.5px] font-semibold pressable ${liked ? "bg-neon/15 text-neon" : "bg-s3 text-on/85"}`}>
                  {liked ? <IHeartF size={15} /> : <IHeart size={15} />}
                  <span>点赞 {likeCount === undefined ? "—" : fmt(likeCount)}</span>
                </button>
                <button type="button" onClick={() => void togglePostInteraction("favs")} aria-pressed={collected}
                  className={`flex items-center gap-1.5 px-4 h-9 rounded-full text-[12.5px] font-semibold pressable ${collected ? "bg-amber/15 text-amber" : "bg-s3 text-on/85"}`}>
                  {collected ? <IStarF size={15} /> : <IStar size={15} />}
                  <span>收藏 {collectCount === undefined ? "—" : fmt(collectCount)}</span>
                </button>
              </div>

              {countsStatus !== "idle" && (
                <div role="status" className="mt-2 flex items-center gap-2 text-[11.5px] text-mut">
                  {countsStatus === "refreshing" ? "正在刷新计数…" : "计数未能全部更新"}
                  {countsStatus === "failed" && (
                    <button type="button" onClick={() => setCountsRetry((n) => n + 1)}
                      className="text-primary pressable">重试刷新计数</button>
                  )}
                </div>
              )}

              {/* 评论区 */}
              <div className="mt-6 pt-4 border-t border-s3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[14px] font-bold text-on">评论</span>
                  <span className="text-[11.5px] text-mut">{post.counts?.comment === undefined ? "—" : fmt(post.counts.comment)}</span>
                </div>
                {comments.length ? (
                  <>
                    {comments.map((c) => (
                      <div key={c.id} className="flex gap-2.5 py-3 border-b border-s3 last:border-0">
                        <Avatar size={32} name={c.nickname} hue={(c.user_id * 37) % 360} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[12px] font-semibold text-on/90">{c.nickname}</span>
                            <span className="text-[10.5px] text-dim">{c.time}</span>
                          </div>
                          <p className="select-text text-[12.5px] text-on/85 mt-1 leading-relaxed whitespace-pre-wrap">{c.text}</p>
                        </div>
                      </div>
                    ))}
                    <div className="flex justify-center py-4">
                      {cLoading ? <div className="w-5 h-5 spinner" />
                        : cErr ? <button onClick={() => void loadComments(cPage + 1)} className="px-4 h-8 rounded-(--r-ctl) bg-s3 text-[12px] text-primary pressable">重试加载评论</button>
                        : cPage < cPages ? <button onClick={() => void loadComments(cPage + 1)} className="px-4 h-8 rounded-(--r-ctl) bg-s3 text-[12px] text-on/85 pressable">查看更多评论</button>
                        : <span className="text-[11px] text-dim">— 到底啦 —</span>}
                    </div>
                  </>
                ) : cLoading ? (
                  <div className="flex justify-center py-8"><div className="w-6 h-6 spinner" /></div>
                ) : cErr ? (
                  <Empty icon={<IComment size={22} />} title="评论加载失败" sub={cErr} action="重试" onAction={() => void loadComments(1)} />
                ) : (
                  <p className="text-[12px] text-dim py-6 text-center">暂无评论</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {lightboxUrl && (
        <div role="dialog" aria-label="图片预览" className="fixed inset-0 z-[70] bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 a-fade"
          onClick={() => setLightboxUrl("")}>
          <button type="button" aria-label="关闭预览" onClick={() => setLightboxUrl("")}
            className="absolute right-4 w-10 h-10 rounded-full bg-white/15 text-white flex items-center justify-center pressable"
            style={{ top: "calc(var(--sat, 0px) + 12px)" }}>
            <IClose size={18} />
          </button>
          <img src={lightboxUrl} alt="" onClick={(e) => e.stopPropagation()}
            className="max-w-full max-h-[86dvh] object-contain rounded-lg select-none" />
        </div>
      )}
    </div>
  );
}
