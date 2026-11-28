import { Suspense, lazy, memo, useSyncExternalStore } from "react";
import { fmt, fmtTime } from "../../api";
import type { Episode } from "../../types";
import { useScrub, type PlaybackProgressBus, type ScrubBus } from "../../playbackProgress";
import { formatScrubDelta } from "../../scrubGesture";
import { Avatar, Img, SegmentedControl, Sheet } from "../ui";
import { MobileProgressLine } from "./MobileProgressLine";
import {
  IChevR, IClose, ICommentF, IExpand, IHeart, IHeartF, ILink, INext, IRotate, IStar, IStarF,
} from "../../icons";

const EpisodesPanel = lazy(() => import("../Panels").then((m) => ({ default: m.EpisodesPanel })));

export type OsdBus = {
  get: () => { id: number; text: string } | null;
  show: (text: string) => void;
  clear: () => void;
  subscribe: (fn: () => void) => () => void;
};

export function createOsdBus(): OsdBus {
  let cur: { id: number; text: string } | null = null;
  let timer: number | undefined;
  let seq = 0;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((fn) => fn());
  return {
    get: () => cur,
    show: (text: string) => {
      if (timer !== undefined) window.clearTimeout(timer);
      cur = { id: ++seq, text };
      emit();
      timer = window.setTimeout(() => {
        timer = undefined;
        cur = null;
        emit();
      }, 1150);
    },
    clear: () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      if (cur !== null) { cur = null; emit(); }
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

export const ScrubOverlay = memo(function ScrubOverlay({ bus, duration }: { bus: ScrubBus; duration: number }) {
  const scrub = useScrub(bus);
  if (!scrub) return null;
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center pointer-events-none">
      <div
        className="px-5 py-3 rounded-2xl flex flex-col items-center min-w-[200px] max-w-[72%]"
        style={{ background: "rgba(14,14,18,.86)", boxShadow: "inset 0 0 0 .5px rgba(255,255,255,.16), 0 10px 30px rgba(0,0,0,.48)" }}>
        <div className="flex items-baseline gap-1.5 tabular-nums">
          <span className="text-[24px] font-bold hg-ink">{fmtTime(scrub.target)}</span>
          <span className="text-[12px] hg-ink-4">/ {fmtTime(duration)}</span>
        </div>
        <span className="mt-0.5 text-[12px] font-semibold text-primary tabular-nums">{formatScrubDelta(scrub.delta)}</span>
        <div className="mt-2.5 w-full min-w-[160px] h-[3px] rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,.22)" }}>
          <div className="h-full w-full bg-primary" style={{ transformOrigin: "left center", transform: `scaleX(${Math.max(0, Math.min(1, scrub.pct / 100))})` }} />
        </div>
      </div>
    </div>
  );
});

export const PlayerOsd = memo(function PlayerOsd({ bus }: { bus: OsdBus }) {
  const osd = useSyncExternalStore(bus.subscribe, bus.get);
  if (!osd) return null;
  return (
    <div key={osd.id} className="pointer-events-none absolute top-14 left-1/2 -translate-x-1/2 z-30 a-scale-in">
      <div
        className="px-3.5 py-1.5 rounded-full text-[12px] font-semibold hg-ink whitespace-nowrap"
        style={{ background: "rgba(16,16,20,.86)", boxShadow: "inset 0 0 0 .5px rgba(255,255,255,.16), 0 6px 20px rgba(0,0,0,.4)" }}>
        {osd.text}
      </div>
    </div>
  );
});

/* 桌面端零模糊轻氛围背光：取代原全屏 blur-xl 实时高斯模糊，大幅降低笔记本 GPU 耗电 */
export const AmbientGlow = memo(function AmbientGlow() {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 pointer-events-none"
      style={{
        background:
          "radial-gradient(62% 55% at 50% 42%, rgba(255, 159, 10, .07) 0%, rgba(22, 22, 28, .25) 55%, rgba(0, 0, 0, .92) 100%)",
      }}
    />
  );
});

/* 移动端右侧互动操作列 + 底部单行核心操作栏 + 贴底 2px 进度线 */
export const FeedMobileOverlay = memo(function FeedMobileOverlay({
  kind, title, curEp, episodesCount, hasNextEp, nextEpNum, isLandscapeVideo, portraitFit,
  liked, likeCount, heartBurst, favorited, bottomInset,
  progressBus, scrubBus, duration, barPct, paused,
  onLike, onFav, onOpenComments, onEnterFs, onShare,
  onOpenEpisodes, onNextEp, onOpenDetail, onTogglePortraitFit,
  onBarDown, onBarMove, onBarUp, onBarCancel,
}: {
  kind: "video" | "post";
  title: string;
  curEp: number;
  episodesCount: number;
  hasNextEp: boolean;
  nextEpNum?: number;
  isLandscapeVideo: boolean;
  portraitFit: "contain" | "cover";
  liked: boolean;
  likeCount: number;
  heartBurst: number;
  favorited: boolean;
  bottomInset: number;
  progressBus: PlaybackProgressBus;
  scrubBus: ScrubBus;
  duration: number;
  barPct: number | null;
  paused: boolean;
  onLike: () => void;
  onFav: () => void;
  onOpenComments: () => void;
  onEnterFs: () => void;
  onShare: () => void;
  onOpenEpisodes: () => void;
  onNextEp: () => void;
  onOpenDetail: () => void;
  onTogglePortraitFit: () => void;
  onBarDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onBarMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onBarUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onBarCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <>
      {/* 右侧互动列 */}
      <div
        className="absolute right-3 z-20 flex flex-col items-center gap-4"
        style={{ bottom: `calc(var(--sab, 0px) + ${bottomInset + 96}px)` }}>
        {kind === "video" && (
          <button onClick={onLike} className="flex flex-col items-center gap-1 pressable" aria-pressed={liked} aria-label="喜欢">
            <span key={heartBurst} className={heartBurst ? "a-pop" : ""}>
              {liked
                ? <IHeartF size={28} className="text-neon drop-shadow-[0_2px_10px_rgba(255,55,95,.5)]" />
                : <IHeart size={28} className="hg-ink hg-ov-shadow" />}
            </span>
            <span className="text-[10.5px] font-medium hg-ink-2 hg-ov-shadow tabular-nums">{likeCount > 0 ? fmt(likeCount) : "喜欢"}</span>
          </button>
        )}
        <button onClick={onFav} className="flex flex-col items-center gap-1 pressable" aria-pressed={favorited} aria-label="收藏">
          {favorited
            ? <IStarF size={27} className="hg-gold drop-shadow-[0_2px_10px_rgba(255,214,10,.45)]" />
            : <IStar size={27} className="hg-ink hg-ov-shadow" />}
          <span className="text-[10.5px] font-medium hg-ink-2 hg-ov-shadow">收藏</span>
        </button>
        <button onClick={onOpenComments} className="flex flex-col items-center gap-1 pressable" aria-label="评论">
          <ICommentF size={26} className="hg-ink hg-ov-shadow" />
          <span className="text-[10.5px] font-medium hg-ink-2 hg-ov-shadow">评论</span>
        </button>
        <button onClick={onEnterFs} className="flex flex-col items-center gap-1 pressable" aria-label="全屏">
          <IExpand size={25} className="hg-ink hg-ov-shadow" />
          <span className="text-[10.5px] font-medium hg-ink-2 hg-ov-shadow">全屏</span>
        </button>
        <button onClick={onShare} className="flex flex-col items-center gap-1 pressable" aria-label="分享">
          <ILink size={24} className="hg-ink hg-ov-shadow" />
          <span className="text-[10.5px] font-medium hg-ink-2 hg-ov-shadow">分享</span>
        </button>
      </div>

      {/* 底部影院暗角渐变 + 剧名 + 单行核心操作胶囊 + 贴底 2px 进度线 */}
      <div
        className="absolute inset-x-0 z-20 pointer-events-none"
        style={{ bottom: `calc(var(--sab, 0px) + ${bottomInset}px)` }}>
        <div
          className="absolute inset-x-0 bottom-0 h-[216px] pointer-events-none"
          style={{ background: "linear-gradient(0deg, rgba(0,0,0,.86) 0%, rgba(0,0,0,.44) 48%, transparent 100%)" }}
        />

        <div className="relative pl-4 pr-[72px] pb-2">
          <p className="select-text text-[15px] font-semibold leading-snug tracking-[-0.01em] hg-ink hg-ov-shadow clamp-2">
            {title}
          </p>
        </div>

        {/* 单行核心操作栏（横向可微滚兜底，绝不折行遮挡画面） */}
        <div className="relative pl-4 pr-[68px] pb-1.5 flex items-center gap-1.5 overflow-x-auto no-bar pointer-events-auto">
          {kind === "video" && (
            <button
              type="button"
              onClick={onOpenEpisodes}
              className="shrink-0 hg-chip-accent px-3 h-[30px] rounded-full flex items-center gap-1.5 text-[12px] font-semibold hg-ink pressable">
              <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
              <span className="tabular-nums">
                {episodesCount > 0 ? `选集 · ${curEp}/${episodesCount}` : `第 ${curEp} 集`}
              </span>
            </button>
          )}
          {hasNextEp && (
            <button
              type="button"
              onClick={onNextEp}
              aria-label={`下一集（第 ${nextEpNum} 集）`}
              className="shrink-0 hg-chip px-2.5 h-[30px] rounded-full flex items-center gap-1 text-[12px] font-medium hg-ink-2 pressable">
              <INext size={11} strokeWidth={1.9} />下一集
            </button>
          )}
          <button
            type="button"
            onClick={onOpenDetail}
            className="shrink-0 hg-chip px-2.5 h-[30px] rounded-full flex items-center gap-0.5 text-[12px] font-medium hg-ink-2 pressable">
            {kind === "post" ? "查看详情" : "详情"}<IChevR size={11} />
          </button>
          {isLandscapeVideo && (
            <>
              <button
                type="button"
                onClick={onEnterFs}
                className="shrink-0 hg-chip-strong px-2.5 h-[30px] rounded-full flex items-center gap-1 text-[12px] font-semibold hg-ink pressable">
                <IRotate size={12} />横屏
              </button>
              <button
                type="button"
                onClick={onTogglePortraitFit}
                className="shrink-0 hg-chip px-2.5 h-[30px] rounded-full text-[11.5px] font-medium hg-ink-2 pressable">
                {portraitFit === "contain" ? "铺满" : "完整"}
              </button>
            </>
          )}
        </div>

        {/* 贴底 2px 精致进度线 */}
        <MobileProgressLine
          bus={progressBus}
          scrubBus={scrubBus}
          duration={duration}
          barPct={barPct}
          paused={paused}
          className="mx-3 -mb-[8px] relative pointer-events-auto"
          onDown={onBarDown}
          onMove={onBarMove}
          onUp={onBarUp}
          onCancel={onBarCancel}
        />
      </div>
    </>
  );
});

/* 移动端详情/选集双栏毛玻璃抽屉 */
export const FeedDetailSheet = memo(function FeedDetailSheet({
  panel, curId, curEp, episodes, meta, orientationBadge, followed,
  onChangePanel, onClose, onPickEp, onFollow, onSearch,
}: {
  panel: "episodes" | "comments" | "article" | "detail" | null;
  curId: number;
  curEp: number;
  episodes: Episode[];
  meta: {
    title: string; cover: string; desc: string; author: string; authorId: number;
    tags: string[]; score: number; like: number; comment: number; collect: number;
  };
  orientationBadge: string;
  followed: boolean;
  onChangePanel: (p: "detail" | "episodes") => void;
  onClose: () => void;
  onPickEp: (ep: number) => void;
  onFollow: () => void;
  onSearch: (q: string) => void;
}) {
  return (
    <Sheet open={panel === "detail" || panel === "episodes"} onClose={onClose} ariaLabel={panel === "episodes" ? "选集" : "剧集详情"}>
      <div className="flex flex-col" style={{ height: "min(70dvh, calc(100dvh - var(--sat, 0px) - 24px))" }}>
        <div className="shrink-0 flex items-center gap-2.5 px-4 pb-2.5">
          <SegmentedControl
            className="flex-1"
            ariaLabel="剧集信息切换"
            value={panel === "episodes" ? "episodes" : "detail"}
            onChange={onChangePanel}
            options={[{ value: "detail", label: "详情" }, { value: "episodes", label: "选集" }]}
          />
          <button
            onClick={onClose}
            aria-label="关闭"
            className="w-8 h-8 rounded-full bg-s3 hairline-ring flex items-center justify-center text-mut pressable">
            <IClose size={14} />
          </button>
        </div>

        <div className="flex-1 min-h-0">
          {panel === "episodes" ? (
            <Suspense fallback={<div className="h-full flex items-center justify-center"><div className="w-7 h-7 spinner" /></div>}>
              <EpisodesPanel bare videoId={curId} episodes={episodes} current={curEp} onPick={onPickEp} onClose={onClose} />
            </Suspense>
          ) : (
            <div className="h-full scroll-y px-4 pb-6">
              <div className="flex gap-3.5">
                <div className="cover-frame relative w-[86px] shrink-0 rounded-(--r-sm) overflow-hidden bg-s3" style={{ aspectRatio: "3 / 4" }}>
                  <Img src={meta.cover} />
                </div>
                <div className="flex-1 min-w-0 pt-0.5">
                  <div className="text-[15px] font-bold text-on leading-snug clamp-2">{meta.title}</div>
                  <div className="flex items-center flex-wrap gap-2 mt-2">
                    {!!meta.score && <span className="text-[12.5px] font-bold text-primary tabular-nums">★ {meta.score.toFixed(1)} 分</span>}
                    {episodes.length > 0 && <span className="text-[11.5px] text-mut">共 {episodes.length} 集</span>}
                    {!!orientationBadge && <span className="px-1.5 py-0.5 rounded bg-s3 text-[10px] font-medium text-mut">{orientationBadge}</span>}
                  </div>
                  <div className="flex gap-3.5 mt-2.5 text-[11px] text-mut tabular-nums">
                    <span>点赞 <b className="text-on/90 font-semibold">{fmt(meta.like)}</b></span>
                    <span>收藏 <b className="text-on/90 font-semibold">{fmt(meta.collect)}</b></span>
                    <span>评论 <b className="text-on/90 font-semibold">{fmt(meta.comment)}</b></span>
                  </div>
                </div>
              </div>

              <div className="mt-4 flex items-center gap-2.5 rounded-(--r-md) surface-card p-3">
                <button
                  type="button"
                  disabled={!meta.author || meta.author === "黄果短剧" || meta.author === "黄果吃瓜"}
                  onClick={() => { onClose(); onSearch(meta.author); }}
                  className="flex items-center gap-2.5 flex-1 min-w-0 text-left pressable disabled:cursor-default">
                  <Avatar size={36} name={meta.author} hue={28} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-semibold text-on truncate">{meta.author}</div>
                    <div className="text-[10.5px] text-mut">
                      {meta.author && meta.author !== "黄果短剧" && meta.author !== "黄果吃瓜" ? "作者 · 点按搜作品" : "作者"}
                    </div>
                  </div>
                </button>
                {meta.authorId > 0 && (
                  <button
                    onClick={onFollow}
                    className={`h-8 px-3.5 rounded-full text-[11.5px] font-semibold pressable ${followed ? "bg-s3 text-mut" : "brand-grad"}`}>
                    {followed ? "已关注" : "+ 关注"}
                  </button>
                )}
              </div>

              {!!meta.tags.length && (
                <div className="mt-4">
                  <div className="text-[11.5px] font-semibold text-dim mb-2">题材标签</div>
                  <div className="flex flex-wrap gap-1.5">
                    {meta.tags.slice(0, 12).map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => { onClose(); onSearch(tag); }}
                        className="px-3 h-7 rounded-(--r-ctl) bg-s3 hairline-ring text-[11.5px] text-on/85 hover:text-primary pressable">
                        #{tag}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-4">
                <div className="text-[11.5px] font-semibold text-dim mb-1.5">简介</div>
                <p className="text-[12.5px] leading-relaxed text-mut whitespace-pre-wrap">{meta.desc || "暂无简介"}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
});
