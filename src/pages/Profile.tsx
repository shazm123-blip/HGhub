import IosNavigation from "../components/IosNavigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, isIos, isMacos, APP_VERSION, fmt, fmtTime, isMobile, platform } from "../api";
import type { Detail } from "../types";
import { useStore } from "../store";
import { Avatar, Empty, Img, Modal } from "../components/ui";
import { IChevR, IClock, IClose, IHeart, ILogout, ISettings, IStar, ITrash, IUser } from "../icons";

type ProfileCardItem = {
  id: number;
  title: string;
  cover: string;
};

/* 我的：结构固定（资料卡 + 我的收藏 / 观看历史 / 喜欢 / 关注）。
   收藏与观看记录等都存在本地，优先使用本地快照秒开展示；未登录也照常使用。 */
export default function Profile({ wide, active = true }: { wide: boolean; active?: boolean }) {
  const {
    user, setLoginOpen, logout, history, favs, likes, follows, followAuthors,
    videoSnapshots, upsertVideoSnapshot, getVideoOrientation,
    changeInteraction, removeHistory, clearHistory, push, lineVersion, toast,
  } = useStore();
  const [tab, setTab] = useState<"fav" | "history" | "like" | "follow">("fav");
  const [limit, setLimit] = useState(12);
  const [fetched, setFetched] = useState<Record<number, Detail>>({});
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const cacheRef = useRef<Map<string, Detail>>(new Map());

  const allIds = useMemo(
    () => (tab === "fav" ? favs : tab === "history" ? history.map((h) => h.id) : tab === "like" ? likes : []),
    [tab, favs, history, likes],
  );
  const visibleIds = useMemo(() => allIds.slice(0, limit), [allIds, limit]);
  const visibleKey = visibleIds.join(",");
  const progressOf = (id: number) => (tab === "history" ? history.find((h) => h.id === id) : undefined);

  useEffect(() => {
    setLimit(12);
    setEditing(false);
  }, [tab]);

  useEffect(() => {
    cacheRef.current.clear();
  }, [lineVersion]);

  useEffect(() => {
    if (!active || tab === "follow") return undefined;
    let alive = true;
    const ids = visibleKey ? visibleKey.split(",").map(Number) : [];
    if (!ids.length) {
      setLoading(false);
      return undefined;
    }
    const cacheKey = (id: number) => `${lineVersion}:${id}`;
    const missing = ids.filter((id) => !cacheRef.current.has(cacheKey(id)));
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
    Promise.allSettled(missing.map((id) => api.video(id).then((d) => ({ id, d }))))
      .then((rs) => {
        if (!alive) return;
        for (const r of rs) {
          if (r.status === "fulfilled") {
            const d = r.value.d;
            cacheRef.current.set(cacheKey(r.value.id), d);
            upsertVideoSnapshot({
              id: d.id,
              title: d.title,
              cover: d.cover,
              score: d.score,
              episode_count: d.episode_count,
              is_finished: d.is_finished,
            });
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
  }, [active, tab, visibleKey, lineVersion, upsertVideoSnapshot]);

  const cards = useMemo<ProfileCardItem[]>(() => {
    return visibleIds.map((id) => {
      const d = fetched[id] || cacheRef.current.get(`${lineVersion}:${id}`);
      if (d) return { id, title: d.title, cover: d.cover };
      const snap = videoSnapshots[id];
      if (snap) return { id, title: snap.title, cover: snap.cover };
      return { id, title: `短剧 #${id}`, cover: "" };
    });
  }, [visibleIds, fetched, lineVersion, videoSnapshots]);

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
      const ep = history.find((h) => h.id === id)?.ep || 1;
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
      <div className="flex-1 scroll-y px-4 pt-2" style={{ paddingBottom: "calc(var(--sab, 0px) + 64px)" }}>
        {/* 资料卡：已登录 / 未登录（点开登录抽屉） */}
        {user ? (
          <div className="account-group rounded-(--r-lg) bg-s1 p-4 elev-1 flex items-center gap-3.5 a-rise">
            <Avatar size={56} name={user.nickname} hue={280} ring />
            <div className="flex-1 min-w-0">
              <div className="text-[16px] font-bold text-on truncate">{user.nickname}</div>
              <div className="text-[11px] text-mut mt-0.5">@{user.username} · ID {user.id}</div>
              <div className="flex gap-3 mt-2 text-[11px] text-mut">
                <span>喜欢 <b className="text-on">{fmt(Math.max(likes.length, user.counts?.like || 0))}</b></span>
                <span>收藏 <b className="text-on">{fmt(Math.max(favs.length, user.counts?.collect || 0))}</b></span>
                <span>关注 <b className="text-on">{fmt(Math.max(follows.length, user.counts?.following || 0))}</b></span>
              </div>
            </div>
            <button onClick={() => setConfirmLogout(true)}
              className="w-9 h-9 rounded-full bg-s3 flex items-center justify-center text-mut pressable" aria-label="退出登录" title="退出登录">
              <ILogout size={17} />
            </button>
          </div>
        ) : (
          <button onClick={() => setLoginOpen(true)}
            className="w-full text-left account-group rounded-(--r-lg) bg-s1 p-4 elev-1 flex items-center gap-3.5 pressable a-rise">
            <Avatar size={56} icon={<IUser size={26} />} hue={220} ring />
            <div className="flex-1 min-w-0">
              <div className="text-[16px] font-bold text-on">未登录</div>
              <div className="text-[11px] text-mut mt-0.5">登录官网账号后可发表评论并同步互动状态；收藏与观看历史也会保存在本机</div>
              <div className="flex gap-3 mt-2 text-[11px] text-mut">
                <span>收藏 <b className="text-on">{favs.length}</b></span>
                <span>观看 <b className="text-on">{history.length}</b></span>
                <span>喜欢 <b className="text-on">{likes.length}</b></span>
              </div>
            </div>
            <span className="shrink-0 flex items-center gap-0.5 h-8 pl-3 pr-2 rounded-full bg-primary text-on-primary text-[11.5px] font-semibold">
              登录<IChevR size={13} />
            </span>
          </button>
        )}

        {/* 我的内容 */}
        <div className="flex items-center gap-2 mt-4">
          <div className="segment-control flex-1 flex bg-s3 rounded-(--r-ctl) p-1">
            {([["fav", "收藏"], ["history", "历史"], ["like", "喜欢"], ["follow", "关注"]] as const).map(([k, l]) => (
              <button aria-pressed={tab === k} key={k} onClick={() => setTab(k)}
                className={`flex-1 h-8 rounded-(--r-ctl) text-[12px] font-semibold pressable ${tab === k ? "tonal text-on-sec" : "text-mut"}`}
                style={tab === k ? { background: "var(--p-sec)", color: "var(--p-primary)" } : undefined}>{l}</button>
            ))}
          </div>
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
                      <Avatar size={38} name={name} hue={(uid * 53) % 360} />
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-semibold text-on truncate">{name}</div>
                        <div className="text-[10.5px] text-dim">ID {uid}</div>
                      </div>
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
            <div className="flex justify-center py-8"><div className="w-7 h-7 spinner" /></div>
          ) : cards.length ? (
            <div className={`grid gap-2 ${wide ? "grid-cols-4 lg:grid-cols-5" : "grid-cols-3"}`}>
              {cards.map((c) => {
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
                        kind: "feed", videoIds: cards.map((x) => x.id), index: cards.findIndex((x) => x.id === c.id),
                        title: tabTitle,
                        startEp: p?.ep, startTime: p?.t,
                        covers: Object.fromEntries(cards.map((x) => [x.id, x.cover])),
                      });
                    }}
                    className="cover-frame relative w-full aspect-[3/4] rounded-(--r-sm) overflow-hidden bg-s1 elev-1 pressable text-left block">
                    {c.cover ? <Img src={c.cover} /> : <div className="absolute inset-0 bg-s3 flex items-center justify-center text-[11px] text-dim px-2 text-center">{c.title}</div>}
                    {!!p && (
                      <div className="absolute top-1.5 left-1.5 max-w-[calc(100%-36px)] truncate px-1.5 py-0.5 rounded-full bg-black/65 text-[9.5px] text-white/90 leading-none">
                        第 {p.ep} 集{p.t > 3 ? ` · ${fmtTime(p.t)}` : ""}
                      </div>
                    )}
                    {!editing && ori && (
                      <span className="absolute top-1.5 right-1.5 px-1 py-0.5 rounded bg-black/65 text-[9.5px] text-white/95 leading-none">
                        {ori.orientation === "landscape" ? "横屏" : "竖屏"}
                      </span>
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-1.5">
                      <div className="text-[11px] text-white clamp-2 leading-tight">{c.title}</div>
                    </div>
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
            <button disabled={loading} onClick={() => setLimit((n) => n + 12)}
              className="mt-3 w-full h-9 rounded-(--r-ctl) bg-s3 text-[12px] text-on/80 pressable disabled:opacity-60">
              {loading ? "加载中…" : `加载更多（已显示 ${visibleIds.length}/${allIds.length}）`}
            </button>
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