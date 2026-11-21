import IosNavigation from "../components/IosNavigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, isIos, APP_VERSION, fmt, fmtTime, isMobile, platform } from "../api";
import type { Detail } from "../types";
import { useStore } from "../store";
import { Avatar, Empty, Img, Modal } from "../components/ui";
import { IChevR, IClock, ILogout, ISettings, IStar, IUser } from "../icons";

/* 我的：结构固定（资料卡 + 我的收藏 / 观看历史）。
   收藏与观看记录都存在本地，所以未登录也照常展示；未登录时资料卡本身就是登录入口。 */
export default function Profile({ wide, active = true }: { wide: boolean; active?: boolean }) {
  const { user, setLoginOpen, logout, history, favs, clearHistory, push, lineVersion, toast } = useStore();
  const [tab, setTab] = useState<"fav" | "history">("fav");
  const [limit, setLimit] = useState(12);
  const [cards, setCards] = useState<Detail[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const cacheRef = useRef<Map<string, Detail>>(new Map());

  const allIds = useMemo(() => (tab === "fav" ? favs : history.map((h) => h.id)), [tab, favs, history]);
  const visibleIds = useMemo(() => allIds.slice(0, limit), [allIds, limit]);
  const visibleKey = visibleIds.join(",");
  /** 观看记录里这条的进度（收藏页没有） */
  const progressOf = (id: number) => (tab === "history" ? history.find((h) => h.id === id) : undefined);

  useEffect(() => {
    setLimit(12);
  }, [tab]);

  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    const ids = visibleKey ? visibleKey.split(",").map(Number) : [];
    if (!ids.length) {
      setCards([]);
      setLoading(false);
      return undefined;
    }
    const cacheKey = (id: number) => `${lineVersion}:${id}`;
    const missing = ids.filter((id) => !cacheRef.current.has(cacheKey(id)));
    if (!missing.length) {
      setCards(ids.map((id) => cacheRef.current.get(cacheKey(id))!).filter(Boolean));
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    Promise.allSettled(missing.map((id) => api.video(id).then((d) => ({ id, d }))))
      .then((rs) => {
        if (!alive) return;
        for (const r of rs) {
          if (r.status === "fulfilled") cacheRef.current.set(cacheKey(r.value.id), r.value.d);
        }
        setCards(ids.map((id) => cacheRef.current.get(cacheKey(id))).filter((x): x is Detail => !!x));
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [active, visibleKey, lineVersion]);

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      {isIos ? <IosNavigation title="我的" action={<button aria-label="设置" onClick={() => push({ kind: "settings" })}><ISettings size={21} /></button>} /> : (
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
              <div className="flex gap-3 mt-2 text-[10.5px] text-mut">
                <span>点赞 <b className="text-on">{fmt(user.counts?.like)}</b></span>
                <span>收藏 <b className="text-on">{fmt(user.counts?.collect)}</b></span>
                <span>关注 <b className="text-on">{fmt(user.counts?.following)}</b></span>
              </div>
            </div>
            <button onClick={async () => { await logout(); }}
              className="w-9 h-9 rounded-full bg-s3 flex items-center justify-center text-mut pressable" aria-label="退出登录">
              <ILogout size={17} />
            </button>
          </div>
        ) : (
          <button onClick={() => setLoginOpen(true)}
            className="w-full text-left account-group rounded-(--r-lg) bg-s1 p-4 elev-1 flex items-center gap-3.5 pressable a-rise">
            <Avatar size={56} icon={<IUser size={26} />} hue={220} ring />
            <div className="flex-1 min-w-0">
              <div className="text-[16px] font-bold text-on">未登录</div>
              <div className="text-[11px] text-mut mt-0.5">登录后可同步点赞、收藏与评论</div>
              <div className="flex gap-3 mt-2 text-[10.5px] text-mut">
                <span>收藏 <b className="text-on">{favs.length}</b></span>
                <span>观看 <b className="text-on">{history.length}</b></span>
              </div>
            </div>
            <span className="flex items-center gap-0.5 h-8 pl-3 pr-2 rounded-full bg-primary text-on-primary text-[11.5px] font-semibold">
              登录<IChevR size={13} />
            </span>
          </button>
        )}

        {/* 我的内容 */}
        <div className="segment-control flex bg-s3 rounded-(--r-ctl) p-1 mt-4">
          {([["fav", "我的收藏"], ["history", "观看历史"]] as const).map(([k, l]) => (
            <button aria-pressed={tab === k} key={k} onClick={() => setTab(k)}
              className={`flex-1 h-8 rounded-(--r-ctl) text-[12px] font-semibold pressable ${tab === k ? "tonal text-on-sec" : "text-mut"}`}
              style={tab === k ? { background: "var(--p-sec)", color: "var(--p-primary)" } : undefined}>{l}</button>
          ))}
        </div>

        <div className="library-group mt-3">
          {loading && !cards.length ? (
            <div className="flex justify-center py-8"><div className="w-7 h-7 spinner" /></div>
          ) : cards.length ? (
            <div className={`grid gap-2 ${wide ? "grid-cols-4 lg:grid-cols-5" : "grid-cols-3"}`}>
              {cards.map((c) => {
                const p = progressOf(c.id);
                return (
                <button key={c.id} onClick={() => push({
                  kind: "feed", videoIds: cards.map((x) => x.id), index: cards.findIndex((x) => x.id === c.id),
                  title: tab === "fav" ? "我的收藏" : "观看历史",
                  startEp: p?.ep, startTime: p?.t,
                  covers: Object.fromEntries(cards.map((x) => [x.id, x.cover])),
                })}
                  className="cover-frame relative w-full aspect-[3/4] rounded-(--r-sm) overflow-hidden bg-s1 elev-1 pressable text-left">
                  <Img src={c.cover} />
                  {!!p && (
                    <div className="absolute top-1.5 left-1.5 max-w-[calc(100%-12px)] truncate px-1.5 py-0.5 rounded-full bg-black/65 text-[9.5px] text-white/90 leading-none">
                      第 {p.ep} 集{p.t > 3 ? ` · ${fmtTime(p.t)}` : ""}
                    </div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-1.5">
                    <div className="text-[10.5px] text-white clamp-2 leading-tight">{c.title}</div>
                  </div>
                </button>
                );
              })}
            </div>
          ) : (
            <Empty icon={tab === "fav" ? <IStar size={24} /> : <IClock size={24} />}
              title={tab === "fav" ? "还没有收藏" : "还没有观看记录"}
              sub={tab === "fav" ? "在剧集页点收藏，之后就能在这里找到" : "看过的剧集会出现在这里"}
              action="去逛逛" onAction={() => push({ kind: "ranks" })} />
          )}
          {allIds.length > visibleIds.length && (
            <button disabled={loading} onClick={() => setLimit((n) => n + 12)}
              className="mt-3 w-full h-9 rounded-(--r-ctl) bg-s3 text-[12px] text-on/80 pressable disabled:opacity-60">
              {loading ? "加载中…" : `加载更多（已显示 ${visibleIds.length}/${allIds.length}）`}
            </button>
          )}
          {cards.length > 0 && tab === "history" && (
            <button onClick={() => setConfirmClear(true)} className="mt-2.5 w-full h-9 rounded-(--r-ctl) bg-s3 text-[12px] text-mut pressable">清空观看历史</button>
          )}
        </div>

        <div className="text-center text-[10px] text-dim mt-5">HGhub {APP_VERSION} · {platform === "android" ? "Android" : platform === "ios" ? "iOS" : platform === "macos" ? "macOS" : platform === "linux" ? "Linux" : "Windows"} 客户端</div>
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
    </div>
  );
}