import { useEffect, useMemo, useRef, useState } from "react";
import { api, dur, fmt, isMobile, cover as imageCover } from "../api";
import { handleArticleClick, sanitizeHtml } from "../html";
import type { Comment, CommentPage, Episode } from "../types";
import { useStore } from "../store";
import { Avatar, Empty } from "./ui";
import { IClose, IComment, IHeart, ISendF } from "../icons";

/* ================= 选集 ================= */
export function EpisodesPanel({ videoId, episodes, current, onPick, onClose, bare = false }: {
  videoId: number; episodes: Episode[]; current: number; onPick: (ep: number) => void; onClose: () => void;
  /** 嵌在双栏抽屉里时，隐藏自带的标题栏与底注 */
  bare?: boolean;
}) {
  const [asc, setAsc] = useState(true);
  const activeEpRef = useRef<HTMLButtonElement>(null);
  const list = asc ? episodes : [...episodes].reverse();

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      activeEpRef.current?.scrollIntoView({ block: "center", behavior: "auto" });
    });
    return () => cancelAnimationFrame(raf);
  }, [videoId, current, episodes.length, asc]);

  return (
    <div className="flex flex-col h-full">
      {bare ? (
        <div className="shrink-0 flex items-center gap-2 px-4 pb-2">
          <span className="text-[11px] text-mut">共 {episodes.length} 集</span>
          <button onClick={() => setAsc((v) => !v)} className="ml-auto text-[11.5px] text-primary pressable">{asc ? "倒序" : "正序"}</button>
        </div>
      ) : (
        <div className="shrink-0 flex items-center gap-2 px-4 h-12">
          <span className="text-[14px] font-bold text-on">选集</span>
          <span className="text-[11px] text-mut">共 {episodes.length} 集</span>
          <button onClick={() => setAsc((v) => !v)} className="ml-auto text-[11.5px] text-primary pressable">{asc ? "倒序" : "正序"}</button>
          <button onClick={onClose} aria-label="关闭" className="w-7 h-7 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
            <IClose size={13} />
          </button>
        </div>
      )}
      <div className="flex-1 scroll-y px-4 pb-4">
        <div className="grid grid-cols-4 gap-2">
          {list.map((e) => {
            const selected = e.ep_num === current;
            return (
              <button
                ref={selected ? activeEpRef : undefined}
                key={e.ep_num}
                onClick={() => onPick(e.ep_num)}
                className={`min-h-[44px] py-1.5 px-1 rounded-(--r-sm) flex flex-col items-center justify-center pressable ${selected ? "bg-primary text-on-primary" : "bg-s3 text-on/85"}`}>
                <span className="text-[12.5px] font-semibold leading-tight tabular-nums">{e.ep_num}</span>
                {e.duration > 0 && (
                  <span className={`text-[9.5px] leading-tight mt-0.5 tabular-nums ${selected ? "opacity-80" : "text-dim"}`}>
                    {dur(e.duration)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {!episodes.length && <div className="text-center text-[12px] text-dim py-8">暂无剧集</div>}
      </div>
      {!bare && <div className="shrink-0 px-4 py-2.5 text-[11px] text-dim bg-s2/60">共 {episodes.length} 集 · 当前第 {current} 集</div>}
    </div>
  );
}

/* ================= 评论 ================= */
export function CommentsPanel({ videoId, ep, total, kind = "video", onClose }: {
  videoId: number; ep: number; total: number; kind?: "video" | "post"; onClose: () => void;
}) {
  const { user, handleSessionError, setLoginOpen, toast } = useStore();
  const [items, setItems] = useState<Comment[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [replyTarget, setReplyTarget] = useState<{ id: number; nickname: string } | null>(null);
  const [expandedReplies, setExpandedReplies] = useState<Record<number, boolean>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const reqSeq = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = async (p: number) => {
    const seq = ++reqSeq.current;
    setLoading(true);
    setErr(null);
    try {
      const res: CommentPage | null = kind === "post"
        ? await api.postComments(videoId, p, 20)
        : await api.comments(videoId, ep, p, 20);
      if (!mounted.current || seq !== reqSeq.current) return;
      setItems((prev) => {
        const base = p === 1 ? [] : prev;
        const seen = new Set(base.map((x) => x.id));
        return [...base, ...(res?.items || []).filter((x) => !seen.has(x.id))];
      });
      setPage(p);
      setPages(res?.pagination?.pages || 1);
      setErr(null);
    } catch (e) {
      if (mounted.current && seq === reqSeq.current) {
        if (p === 1) setItems([]);
        setErr((e as Error).message || "评论加载失败");
      }
    } finally {
      if (mounted.current && seq === reqSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    setItems([]);
    setPage(0);
    setPages(1);
    setErr(null);
    setReplyTarget(null);
    setExpandedReplies({});
    void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, ep, kind]);

  const send = async () => {
    if (kind === "post") return;
    const t = text.trim();
    if (!t) return;
    if (!user) { setLoginOpen(true); return; }
    setSending(true);
    try {
      await api.commentSend(videoId, ep, t, replyTarget?.id);
      if (!mounted.current) return;
      setText("");
      setReplyTarget(null);
      toast("评论已提交，审核通过后展示", "ok");
      void load(1);
    } catch (e) {
      const msg = (e as Error).message || "评论失败";
      handleSessionError(e);
      toast(msg, "info");
    } finally {
      if (mounted.current) setSending(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-2 px-4 h-12">
        <span className="text-[14px] font-bold text-on">评论</span>
        <span className="text-[11px] text-mut">
          {kind === "post" ? `${fmt(total)} 条` : `${fmt(total)} · 第 ${ep} 集`}
        </span>
        <button onClick={onClose} aria-label="关闭" className="ml-auto w-7 h-7 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
          <IClose size={13} />
        </button>
      </div>

      <div className="flex-1 scroll-y px-4">
        {items.length ? items.map((c) => {
          const replies = c.reply_list || [];
          const expanded = !!expandedReplies[c.id];
          return (
            <div key={c.id} className="flex gap-2.5 py-3 border-b border-s3 last:border-0">
              <Avatar size={32} name={c.nickname} hue={(c.user_id * 37) % 360} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center flex-wrap gap-1.5">
                  <span className="text-[12px] font-semibold text-on/90">{c.nickname}</span>
                  {c.is_pinned && <span className="px-1.5 py-0.5 rounded bg-primary/15 text-[9.5px] font-semibold text-primary leading-none">置顶</span>}
                  <span className="text-[10.5px] text-dim">{c.time}</span>
                  {!!c.ip_region && <span className="text-[10px] text-dim">· {c.ip_region}</span>}
                </div>
                <p className="select-text text-[12.5px] text-on/85 mt-1 leading-relaxed whitespace-pre-wrap">{c.text}</p>
                <div className="flex items-center gap-3.5 mt-1.5 text-[11px] text-dim">
                  <span className="flex items-center gap-1"><IHeart size={11} />{c.like_count || 0}</span>
                  {kind === "video" && (
                    <button type="button"
                      onClick={() => {
                        if (!user) { setLoginOpen(true); return; }
                        setReplyTarget({ id: c.id, nickname: c.nickname });
                        requestAnimationFrame(() => inputRef.current?.focus());
                      }}
                      className="hover:text-primary transition-colors pressable">
                      回复
                    </button>
                  )}
                  {(c.reply_count > 0 || replies.length > 0) && (
                    <button type="button"
                      onClick={() => setExpandedReplies((m) => ({ ...m, [c.id]: !m[c.id] }))}
                      className="text-primary/90 pressable">
                      {expanded ? "收起回复" : `${c.reply_count || replies.length} 条回复`}
                    </button>
                  )}
                </div>
                {expanded && replies.length > 0 && (
                  <div className="mt-2 rounded-(--r-sm) bg-s2/80 p-2.5 space-y-2">
                    {replies.map((r) => (
                      <div key={r.id} className="text-[11.5px] leading-relaxed">
                        <span className="font-semibold text-on/90">{r.nickname}</span>
                        <span className="text-[10px] text-dim ml-1.5">{r.time}</span>
                        <p className="select-text text-on/80 mt-0.5 whitespace-pre-wrap">{r.text}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        }) : loading ? (
          <div className="flex justify-center py-10"><div className="w-7 h-7 spinner" /></div>
        ) : err ? (
          <Empty icon={<IComment size={22} />} title="评论加载失败" sub={err} action="重试" onAction={() => void load(1)} />
        ) : (
          <Empty icon={<IHeart size={22} />} title="还没有评论" sub="来抢第一个沙发" />
        )}
        {items.length > 0 && (
          <div className="flex justify-center py-4">
            {loading ? <div className="w-5 h-5 spinner" />
              : err ? (
                <button onClick={() => void load(page + 1)} className="px-4 h-8 rounded-(--r-ctl) bg-s3 text-[11.5px] text-primary pressable">加载失败，点击重试</button>
              ) : page < pages ? (
                <button onClick={() => void load(page + 1)} className="px-4 h-8 rounded-(--r-ctl) bg-s3 text-[11.5px] text-on/80 pressable">查看更多</button>
              ) : <span className="text-[11px] text-dim">— 到底啦 —</span>}
          </div>
        )}
      </div>

      {kind === "post" ? (
        <div className="shrink-0 px-4 py-2.5 text-[11.5px] text-dim bg-s2/70 text-center">
          吃瓜帖请前往详情页查看评论
        </div>
      ) : (
        <div className="shrink-0 bg-s2/70">
          {replyTarget && (
            <div className="flex items-center justify-between px-3.5 pt-2 text-[11px] text-mut">
              <span>回复 <b className="text-on">@{replyTarget.nickname}</b></span>
              <button type="button" onClick={() => setReplyTarget(null)} className="text-dim hover:text-on pressable">取消</button>
            </div>
          )}
          <form className="flex items-center gap-2 px-3 py-2.5" onSubmit={(e) => { e.preventDefault(); void send(); }}>
            <Avatar size={30} name={user?.nickname || "我"} hue={322} />
            <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)}
              readOnly={!user}
              onFocus={(e) => { if (!user) { e.currentTarget.blur(); setLoginOpen(true); } }}
              placeholder={user ? (replyTarget ? `回复 @${replyTarget.nickname}…` : "说点什么…") : "登录后参与评论"}
              className={`flex-1 min-w-0 h-9 rounded-(--r-ctl) bg-s4 px-3.5 ${isMobile ? "text-[16px]" : "text-[12.5px]"} text-on placeholder-dim outline-none focus:bg-s3`} />
            <button type="submit" aria-label="发送评论" disabled={!text.trim() || sending}
              className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center pressable ${text.trim() ? "brand-grad glow-neon" : "bg-s3 text-dim"}`}>
              {sending ? <span className="w-4 h-4 spinner" /> : <ISendF size={16} />}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
/* ================= 图文正文（吃瓜） ================= */
export function ArticlePanel({ title, html, cover, hot, onClose }: {
  title: string; html: string; cover?: string; hot?: number; onClose: () => void;
}) {
  const { toast, strictSecurity } = useStore();
  const safeHtml = useMemo(() => sanitizeHtml(html), [html, strictSecurity]);
  const openSafeLink = (url: string) => {
    api.openUrl(url).catch(() => {
      navigator.clipboard?.writeText(url).then(() => toast("链接已复制", "ok")).catch(() => {});
    });
  };
  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-2 px-4 h-12">
        <span className="text-[13.5px] font-bold text-on">图文详情</span>
        {hot ? <span className="text-[10.5px] text-mut">{fmt(hot)} 热度</span> : null}
        <button onClick={onClose} aria-label="关闭" className="ml-auto w-7 h-7 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
          <IClose size={13} />
        </button>
      </div>
      <div className="flex-1 scroll-y px-4 pb-6">
        {cover && <img src={imageCover(cover)} alt="" className="w-full rounded-(--r-md) mb-3 object-cover" />}
        <h2 className="text-[16px] font-bold text-on leading-snug">{title}</h2>
        <div className="article-body mt-3" onClick={(e) => handleArticleClick(e, openSafeLink)} dangerouslySetInnerHTML={{ __html: safeHtml }} />
        {!safeHtml && <p className="text-[12px] text-dim mt-4">这篇内容没有正文，可能只有图片或视频。</p>}
      </div>
    </div>
  );
}
