import IosNavigation from "../components/IosNavigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { isIos, isMacos, APP_VERSION, fmt, fmtTime, isMobile, platform } from "../api";
import type { Detail } from "../types";
import { useDataVersion, useHistoryState, useInteractions, useSessionUser, useStoreActions } from "../store";
import { fetchVideoDetailCached, getCachedVideoDetail, getVideoOrientation, mapWithConcurrency, useVideoSnapshots } from "../videoMeta";
import { Avatar, CardGridSkeleton, Empty, Img, Modal, SegmentedControl } from "../components/ui";
import { IChevR, IClock, IClose, IHeart, ILogout, ISettings, IStar, ITrash, IUser } from "../icons";

type ProfileCardItem = {
  id: number;
  title: string;
  cover: string;
};

/* 我的：结构固定（资料卡 + 我的收藏 / 观看历史 / 喜欢 / 关注）。
   收藏与观看记录等都存在本地，优先使用本地快照秒开展示；未登录也照常使用。 */
export default function Profile({ wide, active = true }: { wide: boolean; active?: boolean }) {
  const { setLoginOpen, logout, changeInteraction, removeHistory, clearHistory, push, searchFor, toast } = useStoreActions();
  const user = useSessionUser();
  const history = useHistoryState();
  const { favs, likes, follows, followAuthors } = useInteractions();
  const { lineVersion } = useDataVersion();
  const videoSnapshots = useVideoSnapshots();
  const [tab, setTab] = useState<"fav" | "history" | "like" | "follow">("fav");
  const [limit, setLimit] = useState(12);
  const [fetched, setFetched] = useState<Record<number, Detail>>({});
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const cacheRef = useRef<Map<string, Detail>>(new Map());
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const historyMap = useMemo(() => new Map(history.map((h) => [h.id, h])), [history]);
  const allIds = useMemo(
    () => (tab === "fav" ? favs : tab === "history" ? history.map((h) => h.id) : tab === "like" ? likes : []),
    [tab, favs, history, likes],
  );
  const recentHistory = useMemo(() => history.slice(0, 8), [history]);
  const recentIdsKey = useMemo(() => recentHistory.map((h) => h.id).join(","), [recentHistory]);

  const visibleIds = useMemo(() => allIds.slice(0, limit), [allIds, limit]);
  const fetchIdsKey = useMemo(() => {
    const merged = new Set<number>(visibleIds);
    for (const h of recentHistory) merged.add(h.id);
    return [...merged].join(",");
  }, [visibleIds, recentHistory]);
  const progressOf = (id: number) => (tab === "follow" ? undefined : historyMap.get(id));

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !active || tab === "follow" || loading || allIds.length <= visibleIds.length) return undefined;
    const io = new IntersectionObserver(
      (es) => { if (es[0].isIntersecting) setLimit((n) => n + 12); },
      { root: listRef.current, rootMargin: "220px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [active, tab, loading, allIds.length, visibleIds.length]);

  useEffect(() => {
    setLimit(12);
    setEditing(false);
  }, [tab]);

  useEffect(() => {
    cacheRef.current.clear();
  }, [lineVersion]);

  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    const ids = fetchIdsKey ? fetchIdsKey.split(",").map(Number) : [];
    if (!ids.length) {
      setLoading(false);
      return undefined;
    }
    const cacheKey = (id: number) => `${lineVersion}:${id}`;
    const missing: number[] = [];
    for (const id of ids) {
      if (cacheRef.current.has(cacheKey(id))) continue;
      const shared = getCachedVideoDetail(lineVersion, id);
      if (shared) cacheRef.current.set(cacheKey(id), shared);
      else missing.push(id);
    }
    if (!missing.length) {
      const nextMap: Record<number, Detail> = {};
      for (const id of ids) {
        const d = cacheRef.current.get(cacheKey(id));
        if (d) nextMap[id] = d;
      }
      setFetched(nextMap);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    mapWithConcurrency(missing, 4, (id) => fetchVideoDetailCached(lineVersion, id).then((d) => ({ id, d })))
      .then((rs) => {
        if (!alive) return;
        for (const r of rs) {
          if (r.status === "fulfilled") {
            cacheRef.current.set(cacheKey(r.value.id), r.value.d);
          }
        }
        const nextMap: Record<number, Detail> = {};
        for (const id of ids) {
          const d = cacheRef.current.get(cacheKey(id));
          if (d) nextMap[id] = d;
        }
        setFetched(nextMap);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [active, fetchIdsKey, lineVersion]);

  const resolveCard = (id: number): ProfileCardItem => {
    const d = fetched[id] || cacheRef.current.get(`${lineVersion}:${id}`);
    if (d) return { id, title: d.title, cover: d.cover };
    const snap = videoSnapshots[id];
    if (snap) return { id, title: snap.title, cover: snap.cover };
    return { id, title: `短剧 #${id}`, cover: "" };
  };

  const recentCards = useMemo(
    () => recentHistory.map((h) => ({ ...resolveCard(h.id), progress: h })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recentIdsKey, recentHistory, fetched, lineVersion, videoSnapshots],
  );
  const recentIds = useMemo(() => recentCards.map((c) => c.id), [recentCards]);
  const recentCovers = useMemo(() => Object.fromEntries(recentCards.map((c) => [c.id, c.cover])), [recentCards]);

  const cards = useMemo<ProfileCardItem[]>(() => {
    return visibleIds.map(resolveCard);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIds, fetched, lineVersion, videoSnapshots]);
  const cardIds = useMemo(() => cards.map((x) => x.id), [cards]);
  const cardCovers = useMemo(() => Object.fromEntries(cards.map((x) => [x.id, x.cover])), [cards]);

  const confirmRemoval = async (remove: () => Promise<boolean | null>, message: string) => {
    try {
      if (await remove() !== null) toast(message, "info");
    } catch (error) {
      toast((error as Error).message || "操作失败，请重试", "info");
    }
  };

  const removeItem = (id: number) => {
    if (tab === "fav") {
      void confirmRemoval(() => changeInteraction("favs", id, { remove: true }), "已移出收藏");
    } else if (tab === "history") {
      removeHistory(id);
      toast("已删除该观看记录", "info");
    } else if (tab === "like") {
      const ep = historyMap.get(id)?.ep || 1;
      void confirmRemoval(() => changeInteraction("likes", id, { ep, remove: true }), "已取消喜欢");
    }
  };

  const tabTitle = tab === "fav" ? "我的收藏" : tab === "history" ? "观看历史" : "我的喜欢";

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      {isIos ? <IosNavigation title="我的" action={<button className="w-11 rounded-full bg-fill" aria-label="设置" onClick={() => push({ kind: "settings" })}><ISettings size={21} /></button>} /> : !isMacos && (
      <div className="shrink-0 px-4 pb-2 flex items-center" style={{ paddingTop: "calc(var(--sat, 0px) + 14px)" }}>
        <div className="text-[24px] font-bold text-on leading-none">我的</div>
        {isMobile && (
          <button onClick={() => push({ kind: "settings" })} aria-label="设置"
            className="ml-auto w-9 h-9 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
            <ISettings size={17} strokeWidth={1.7} />
          </button>
        )}
      </div>
      )}
      <div ref={listRef} className="flex-1 scroll-y px-4 pt-2" style={{ paddingBottom: "calc(var(--sab, 0px) + 64px)" }}>
        {/* 资料卡：已登录 / 未登录 */}
        {user ? (
          <div className="account-group surface-card rounded-(--r-lg) p-4 a-rise">
            <div className="flex items-center gap-3.5">
              <Avatar size={56} name={user.nickname} hue={30} ring />
              <div className="flex-1 min-w-0">
                <div className="text-[17px] font-bold text-on truncate">{user.nickname}</div>
                <div className="text-[11.5px] text-mut mt-0.5">@{user.username} · ID {user.id}</div>
              </div>
              <button onClick={() => setConfirmLogout(true)}
                className="w-9 h-9 rounded-full bg-s3 hairline-ring flex items-center justify-center text-mut hover:text-on pressable" aria-label="退出登录" title="退出登录">
                <ILogout size={17} />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2 mt-3.5 pt-3 border-t border-sep text-center">
              <div>
                <div className="text-[15px] font-bold text-on tabular-nums">{fmt(Math.max(likes.length, user.counts?.like || 0))}</div>
                <div className="text-[11px] text-mut mt-0.5">喜欢</div>
              </div>
              <div>
                <div className="text-[15px] font-bold text-on tabular-nums">{fmt(Math.max(favs.length, user.counts?.collect || 0))}</div>
                <div className="text-[11px] text-mut mt-0.5">收藏</div>
              </div>
              <div>
                <div className="text-[15px] font-bold text-on tabular-nums">{fmt(Math.max(follows.length, user.counts?.following || 0))}</div>
                <div className="text-[11px] text-mut mt-0.5">关注</div>
              </div>
            </div>
          </div>
        ) : (
          <button onClick={() => setLoginOpen(true)}
            className="w-full text-left account-group surface-card rounded-(--r-lg) p-4 pressable a-rise">
            <div className="flex items-center gap-3.5">
              <Avatar size={56} icon={<IUser size={26} />} hue={30} ring />
              <div className="flex-1 min-w-0">
                <div className="text-[17px] font-bold text-on">登录 HGhub</div>
                <div className="text-[11.5px] text-mut mt-0.5 leading-snug">登录后可评论并同步互动；本机收藏与观看历史始终保留</div>
              </div>
              <span className="shrink-0 flex items-center gap-0.5 h-8 pl-3.5 pr-2.5 rounded-full brand-grad text-[12px] font-semibold">
                登录<IChevR size={13} />
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 mt-3.5 pt-3 border-t border-sep text-center">
              <div>
                <div className="text-[15px] font-bold text-on tabular-nums">{favs.length}</div>
                <div className="text-[11px] text-mut mt-0.5">收藏</div>
              </div>
              <div>
                <div className="text-[15px] font-bold text-on tabular-nums">{history.length}</div>
                <div className="text-[11px] text-mut mt-0.5">观看</div>
              </div>
              <div>
                <div className="text-[15px] font-bold text-on tabular-nums">{likes.length}</div>
                <div className="text-[11px] text-mut mt-0.5">喜欢</div>
              </div>
            </div>
          </button>
        )}

        {/* 继续观看快捷栏（有观看历史时置于顶部，一键秒续播） */}
        {recentCards.length > 0 && (
          <section aria-label="继续观看" className="mt-5 a-rise">
            <div className="flex items-center justify-between mb-2.5 px-0.5">
              <span className="text-[14.5px] font-bold text-on">继续观看</span>
              <button
                type="button"
                onClick={() => setTab("history")}
                className="text-[11.5px] text-primary font-medium flex items-center gap-0.5 pressable">
                全部历史<IChevR size={12} />
              </button>
            </div>
            <div className="scroll-x -mx-4 px-4 flex gap-2.5 snap-x">
              {recentCards.map((item, idx) => {
                const p = item.progress;
                const pct = p.dur > 0 && p.t > 0 ? Math.max(6, Math.min(100, Math.round((p.t / p.dur) * 100))) : 0;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => push({
                      kind: "feed",
                      videoIds: recentIds,
                      index: idx,
                      title: "继续观看",
                      startEp: p.ep,
                      startTime: p.t,
                      covers: recentCovers,
                    })}
                    className="w-[104px] shrink-0 text-left snap-start pressable">
                    <div className="cover-frame relative w-full aspect-[3/4] rounded-(--r-sm) overflow-hidden bg-s1">
                      {item.cover ? <Img src={item.cover} eager={idx < 4} /> : <div className="absolute inset-0 bg-s3 flex items-center justify-center text-[11px] text-dim px-2 text-center">{item.title}</div>}
                      <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md bg-black/70 text-[9.5px] font-semibold text-white/95 leading-none tabular-nums">
                        第 {p.ep} 集
                      </span>
                      {pct > 0 && (
                        <div className="absolute inset-x-0 bottom-0 h-[3px] bg-black/45">
                          <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                        </div>
                      )}
                    </div>
                    <div className="mt-1.5 text-[12px] font-semibold text-on clamp-1 leading-tight">{item.title}</div>
                    <div className="text-[10.5px] text-mut mt-0.5 tabular-nums">
                      {p.t > 3 ? `看到 ${fmtTime(p.t)}` : `第 ${p.ep} 集`}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* 我的内容 */}
        <div className="flex items-center gap-2 mt-4">
          <SegmentedControl
            className="flex-1"
            ariaLabel="我的内容分类"
            value={tab}
            onChange={setTab}
            options={[{ value: "fav", label: "收藏" }, { value: "history", label: "历史" }, { value: "like", label: "喜欢" }, { value: "follow", label: "关注" }]}
          />
          {tab !== "follow" && allIds.length > 0 && (
            <button type="button" onClick={() => setEditing((v) => !v)}
              className={`shrink-0 px-3 h-8 rounded-(--r-ctl) text-[12px] font-semibold pressable ${editing ? "bg-primary text-on-primary" : "bg-s3 text-mut"}`}>
              {editing ? "完成" : "管理"}
            </button>
          )}
        </div>

        <div className="library-group mt-3">
          {tab === "follow" ? (
            follows.length ? (
              <div className="divide-y divide-s3 rounded-(--r-md) bg-s1 overflow-hidden">
                {follows.map((uid) => {
                  const info = followAuthors[uid];
                  const name = info?.name || `创作者 #${uid}`;
                  return (
                    <div key={uid} className="flex items-center gap-3 px-3.5 py-2.5">
                      <button
                        type="button"
                        disabled={!info?.name}
                        onClick={() => { if (info?.name) searchFor(info.name); }}
                        className="flex items-center gap-3 flex-1 min-w-0 text-left pressable disabled:cursor-default">
                        <Avatar size={38} name={name} hue={(uid * 53) % 360} />
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-semibold text-on truncate">{name}</div>
                          <div className="text-[10.5px] text-dim">{info?.name ? `ID ${uid} · 点按搜作品` : `ID ${uid}`}</div>
                        </div>
                      </button>
                      <button type="button"
                        onClick={() => void confirmRemoval(
                          () => changeInteraction("follows", uid, { remove: true }), `已取消关注 ${name}`,
                        )}
                        className="shrink-0 px-3 h-7 rounded-full bg-s3 text-[11.5px] text-mut pressable">
                        取消关注
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <Empty icon={<IUser size={24} />} title="还没有关注作者" sub="在剧集详情里关注喜欢的创作者" action="去逛逛" onAction={() => push({ kind: "ranks" })} />
            )
          ) : loading && !cards.length ? (
            <CardGridSkeleton wide={wide} count={6} aspect="aspect-[3/4]" gap="gap-2" />
          ) : cards.length ? (
            <div className={`grid gap-2 ${wide ? "grid-cols-4 lg:grid-cols-5" : "grid-cols-3"}`}>
              {cards.map((c, idx) => {
                const p = progressOf(c.id);
                const ori = getVideoOrientation(c.id);
                return (
                <div key={c.id} className="relative">
                  <button
                    onClick={() => {
                      if (editing) {
                        removeItem(c.id);
                        return;
                      }
                      push({
                        kind: "feed", videoIds: cardIds, index: idx,
                        title: tabTitle,
                        startEp: p?.ep, startTime: p?.t,
                        covers: cardCovers,
                      });
                    }}
                    className="cover-frame relative w-full aspect-[3/4] rounded-(--r-sm) overflow-hidden bg-s1 elev-1 pressable text-left block">
                    {c.cover ? <Img src={c.cover} /> : <div className="absolute inset-0 bg-s3 flex items-center justify-center text-[11px] text-dim px-2 text-center">{c.title}</div>}
                    {!!p && (
                      <div className="absolute top-1.5 left-1.5 max-w-[calc(100%-36px)] truncate px-1.5 py-0.5 rounded-full bg-black/65 text-[9.5px] text-white/90 leading-none">
                        第 {p.ep} 集{p.t > 3 ? ` · ${fmtTime(p.t)}` : ""}
                      </div>
                    )}
                    {!editing && ori?.orientation === "landscape" && (
                      <span className="absolute top-1.5 right-1.5 px-1 py-0.5 rounded bg-black/65 text-[9.5px] text-white/95 leading-none">
                        横屏
                      </span>
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-1.5">
                      <div className="text-[11px] text-white clamp-2 leading-tight">{c.title}</div>
                    </div>
                    {!!p && p.dur > 0 && p.t > 0 && (
                      <div className="absolute inset-x-0 bottom-0 h-[2.5px] bg-white/20 pointer-events-none">
                        <div
                          className="h-full bg-primary"
                          style={{ width: `${Math.max(4, Math.min(100, Math.round((p.t / p.dur) * 100)))}%` }}
                        />
                      </div>
                    )}
                  </button>
                  {editing && (
                    <button type="button" aria-label={`移除 ${c.title}`} onClick={() => removeItem(c.id)}
                      className="absolute top-1.5 right-1.5 z-10 w-6 h-6 rounded-full bg-black/75 text-white flex items-center justify-center pressable">
                      <IClose size={12} />
                    </button>
                  )}
                </div>
                );
              })}
            </div>
          ) : (
            <Empty
              icon={tab === "fav" ? <IStar size={24} /> : tab === "like" ? <IHeart size={24} /> : <IClock size={24} />}
              title={tab === "fav" ? "还没有收藏" : tab === "like" ? "还没有喜欢的剧集" : "还没有观看记录"}
              sub={tab === "fav" ? "在剧集页点收藏，之后就能在这里找到" : tab === "like" ? "点过喜欢的剧集会汇总在这里" : "看过的剧集会出现在这里"}
              action="去逛逛"
              onAction={() => push({ kind: "ranks" })}
            />
          )}
          {tab !== "follow" && allIds.length > visibleIds.length && (
            <>
              <div ref={sentinelRef} className="h-2" />
              <button disabled={loading} onClick={() => setLimit((n) => n + 12)}
                className="mt-3 w-full h-9 rounded-(--r-ctl) bg-s3 text-[12px] text-on/80 pressable disabled:opacity-60">
                {loading ? "加载中…" : `加载更多（已显示 ${visibleIds.length}/${allIds.length}）`}
              </button>
            </>
          )}
          {cards.length > 0 && tab === "history" && (
            <button onClick={() => setConfirmClear(true)} className="mt-2.5 w-full h-9 rounded-(--r-ctl) bg-s3 text-[12px] text-mut flex items-center justify-center gap-1.5 pressable">
              <ITrash size={13} />清空观看历史
            </button>
          )}
        </div>

        <div className="text-center text-[10.5px] text-dim mt-5">HGhub {APP_VERSION} · {platform === "android" ? "Android" : platform === "ios" ? "iOS" : platform === "macos" ? "macOS" : platform === "linux" ? "Linux" : "Windows"} 客户端</div>
      </div>

      <Modal open={confirmClear} onClose={() => setConfirmClear(false)} width={320}>
        <div className="confirm-alert p-5">
          <div className="text-[14.5px] font-bold text-on">清空观看历史</div>
          <p className="text-[12px] text-mut leading-relaxed mt-2">确定要清除全部观看记录与续播进度吗？此操作不可撤销。</p>
          <div className="flex gap-2 mt-5">
            <button onClick={() => setConfirmClear(false)} className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[12.5px] text-on/80 pressable">取消</button>
            <button onClick={() => { clearHistory(); setConfirmClear(false); toast("已清空观看历史", "info"); }}
              className="flex-1 h-9 rounded-(--r-ctl) bg-danger text-[12.5px] font-semibold text-on-danger pressable">确定清空</button>
          </div>
        </div>
      </Modal>

      <Modal open={confirmLogout} onClose={() => setConfirmLogout(false)} width={320}>
        <div className="confirm-alert p-5">
          <div className="text-[14.5px] font-bold text-on">退出登录</div>
          <p className="text-[12px] text-mut leading-relaxed mt-2">确定退出当前账号吗？本机收藏与观看历史仍会保留。</p>
          <div className="flex gap-2 mt-5">
            <button onClick={() => setConfirmLogout(false)} className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[12.5px] text-on/80 pressable">取消</button>
            <button onClick={async () => { setConfirmLogout(false); await logout(); }}
              className="flex-1 h-9 rounded-(--r-ctl) bg-danger text-[12.5px] font-semibold text-on-danger pressable">退出登录</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}