import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api, cover, fmt, fmtTime, friendlyError, isAndroid, isIos, isMobile } from "../api";
import type { Detail, Episode, Post } from "../types";
import { useInteractions, usePlaybackPrefs, useStoreActions, useUiState } from "../store";
import { fetchVideoDetailCached, getVideoOrientation, recordVideoOrientation } from "../videoMeta";
import { Avatar, Img, SegmentedControl, Sheet } from "./ui";
import VideoSurface, { type VideoHandle } from "./VideoSurface";
import PlayerControls from "./PlayerControls";
import PlaybackLock from "./PlaybackLock";
import { pushBackHandler } from "../back";
import { computeScrubTarget, formatScrubDelta } from "../scrubGesture";
import { createProgressBus, createScrubBus, useProgress, useScrub, type PlaybackProgressBus, type ScrubBus } from "../playbackProgress";

const ArticlePanel = lazy(() => import("./ArticlePanel"));
const CommentsPanel = lazy(() => import("./Panels").then((m) => ({ default: m.CommentsPanel })));
const EpisodesPanel = lazy(() => import("./Panels").then((m) => ({ default: m.EpisodesPanel })));
import {
  IBack, IBoltF, IChevR, IChevronDown, IChevronUp, IClose, ICommentF, ICompress, IExpand, IFileText, IHeart, IHeartF,
  ILink, IList, ILockF, INext, IPauseF, IPlayF, IRefresh, IReplay, IRotate, ISearch, IStar, IStarF, IVol, IVolMute,
} from "../icons";

const MAX_FEED_CACHE = 40;
function pruneIdMap<T>(map: Record<number, T>, keepIds: Set<number>): Record<number, T> {
  if (Object.keys(map).length <= MAX_FEED_CACHE) return map;
  const next: Record<number, T> = {};
  for (const [k, v] of Object.entries(map)) {
    const id = Number(k);
    if (keepIds.has(id)) next[id] = v;
  }
  return next;
}
function prunePlayMap(map: Record<string, string>, keepIds: Set<number>): Record<string, string> {
  if (Object.keys(map).length <= MAX_FEED_CACHE) return map;
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    const id = Number(k.split(":")[0]);
    if (keepIds.has(id)) next[k] = v;
  }
  return next;
}

function MobileProgressLine({
  bus, scrubBus, duration, barPct, paused = false, className, onDown, onMove, onUp, onCancel,
}: {
  bus: PlaybackProgressBus;
  scrubBus: ScrubBus;
  duration: number;
  barPct: number | null;
  paused?: boolean;
  className: string;
  onDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const snap = useProgress(bus);
  const scrub = useScrub(scrubBus);
  const rawProgress = barPct ?? (scrub !== null ? scrub.pct / 100 : (duration ? (snap?.time ?? 0) / duration : 0));
  const progress = Math.max(0, Math.min(1, rawProgress));
  const buffered = Math.max(0, Math.min(1, snap?.buffered ?? 0));
  const activeDrag = barPct !== null || scrub !== null;
  return (
    <div className={className} style={{ height: 26, touchAction: "none" }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel}>
      <div className={`absolute inset-x-0 top-1/2 -translate-y-1/2 rounded-full overflow-hidden transition-[height] duration-150 ${activeDrag ? "h-[5px]" : "h-[3px]"}`}
        style={{ background: "rgba(255,255,255,.24)" }}>
        <div className="absolute inset-0 w-full rounded-full"
          style={{ background: "rgba(255,255,255,.26)", transformOrigin: "left center", transform: `scaleX(${buffered})` }} />
        <div className="absolute inset-0 w-full rounded-full bg-white"
          style={{ transformOrigin: "left center", transform: `scaleX(${progress})`, transition: activeDrag ? "none" : "transform .2s linear" }} />
      </div>
      {activeDrag && (
        <div
          className="pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white"
          style={{ left: `${progress * 100}%`, boxShadow: "0 0 10px rgba(255,255,255,.7), 0 1px 4px rgba(0,0,0,.5)" }}
        />
      )}
      {barPct !== null ? (
        <div className="absolute left-1/2 -translate-x-1/2 -top-8 px-2.5 py-1 rounded-md hg-chip-strong text-[12px] font-bold tabular-nums whitespace-nowrap">
          {fmtTime(barPct * (duration || 0))} / {fmtTime(duration)}
        </div>
      ) : paused && scrub === null && duration > 0 ? (
        <div className="pointer-events-none absolute right-0 -top-6 px-2 py-0.5 rounded-full hg-chip text-[10.5px] font-semibold hg-ink-2 tabular-nums whitespace-nowrap a-fade">
          {fmtTime(snap?.time ?? 0)} / {fmtTime(duration)}
        </div>
      ) : null}
    </div>
  );
}

function ScrubOverlay({ bus, duration }: { bus: ScrubBus; duration: number }) {
  const scrub = useScrub(bus);
  if (!scrub) return null;
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center pointer-events-none">
      <div className="px-5 py-3 rounded-2xl flex flex-col items-center min-w-[200px] max-w-[72%]"
        style={{ background: "rgba(18,18,22,.82)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.14), 0 10px 30px rgba(0,0,0,.45)" }}>
        <div className="flex items-baseline gap-1.5 tabular-nums">
          <span className="text-[24px] font-bold hg-ink">{fmtTime(scrub.target)}</span>
          <span className="text-[12px] hg-ink-4">/ {fmtTime(duration)}</span>
        </div>
        <span className="mt-0.5 text-[12px] font-semibold hg-ink-2 tabular-nums">{formatScrubDelta(scrub.delta)}</span>
        <div className="mt-2.5 w-full min-w-[160px] h-[3px] rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,.25)" }}>
          <div className="h-full w-full bg-white" style={{ transformOrigin: "left center", transform: `scaleX(${Math.max(0, Math.min(1, scrub.pct / 100))})` }} />
        </div>
      </div>
    </div>
  );
}

type OsdBus = {
  get: () => { id: number; text: string } | null;
  show: (text: string) => void;
  clear: () => void;
  subscribe: (fn: () => void) => () => void;
};

function createOsdBus(): OsdBus {
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

function PlayerOsd({ bus }: { bus: OsdBus }) {
  const osd = useSyncExternalStore(bus.subscribe, bus.get);
  if (!osd) return null;
  return (
    <div key={osd.id} className="pointer-events-none absolute top-14 left-1/2 -translate-x-1/2 z-30 a-scale-in">
      <div className="px-3.5 py-1.5 rounded-full text-[12px] font-semibold hg-ink whitespace-nowrap"
        style={{ background: "rgba(18,18,22,.82)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.14), 0 6px 20px rgba(0,0,0,.38)" }}>
        {osd.text}
      </div>
    </div>
  );
}

function AmbientBackdrop({ src }: { src: string }) {
  const url = src ? cover(src, 160) : "";
  const [slot, setSlot] = useState<{ active: 0 | 1; urls: [string, string] }>({
    active: 0,
    urls: [url, ""],
  });
  useEffect(() => {
    if (!url) return;
    setSlot((prev) => {
      if (prev.urls[prev.active] === url) return prev;
      const nextActive: 0 | 1 = prev.active === 0 ? 1 : 0;
      const nextUrls: [string, string] = [prev.urls[0], prev.urls[1]];
      nextUrls[nextActive] = url;
      return { active: nextActive, urls: nextUrls };
    });
  }, [url]);
  if (!url && !slot.urls[0] && !slot.urls[1]) return null;
  return (
    <div className="absolute inset-0 scale-110 blur-xl opacity-22 pointer-events-none overflow-hidden transform-gpu">
      {[0, 1].map((idx) => (
        slot.urls[idx] ? (
          <img
            key={idx}
            src={slot.urls[idx]}
            alt=""
            decoding="async"
            className="absolute inset-0 w-full h-full object-cover transition-opacity duration-500"
            style={{ opacity: slot.active === idx && url ? 1 : 0 }}
          />
        ) : null
      ))}
      <div className="absolute inset-0" style={{ background: "radial-gradient(circle at 50% 45%, transparent 30%, rgba(0,0,0,.6) 100%)" }} />
    </div>
  );
}

function MobileFsClock({ bus }: { bus: PlaybackProgressBus }) {
  const snap = useProgress(bus);
  return <span className="shrink-0 text-[11.5px] font-semibold hg-ink-2 tabular-nums">{fmtTime(snap?.time ?? 0)}</span>;
}

type Props = {
  videoIds: number[];
  startIndex?: number;
  title?: string;
  mode: "home" | "context";
  kind?: "video" | "post";
  active: boolean;
  bottomInset: number;
  onBack?: () => void;
  onNearEnd?: () => void;
  onView?: (id: number) => void;
  /** 从观看记录续播：起始集数与秒数 */
  startEp?: number;
  startTime?: number;
  initialCovers?: Record<number, string>;
};

export default function Feed({ videoIds, startIndex = 0, title = "", mode, kind = "video", active, bottomInset, onBack, onNearEnd, onView, startEp, startTime, initialCovers }: Props) {
  const { changeInteraction, toast, addHistory, getWatchProgress, setTheater, setFs, setLinePickerOpen, setTab, searchFor, bumpHomeRefresh } = useStoreActions();
  const { isLiked, isFav, follows } = useInteractions();
  const { theater, fs, lineVersion } = useUiState();
  const { muted, setMuted, volume, setVolume, landscapeFitPref, setLandscapeFitPref, playbackRate: rate, setPlaybackRate: setRate } = usePlaybackPrefs();
  const isDesktop = !isMobile;

  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<VideoHandle>(null);
  const [index, setIndex] = useState(startIndex);
  const safeIndex = Math.min(index, Math.max(0, videoIds.length - 1));
  const indexRef = useRef(safeIndex);
  indexRef.current = safeIndex;
  useEffect(() => {
    if (index !== safeIndex) setIndex(safeIndex);
  }, [index, safeIndex]);
  const [epMap, setEpMap] = useState<Record<number, number>>(() => (startEp ? { [videoIds[startIndex]]: startEp } : {}));
  const [details, setDetails] = useState<Record<number, Detail>>({});
  const [playUrls, setPlayUrls] = useState<Record<string, string>>({});
  const [posts, setPosts] = useState<Record<number, Post>>({});

  const progressBus = useMemo(() => createProgressBus(), []);
  const scrubBus = useMemo(() => createScrubBus(), []);
  const osdBus = useMemo(() => createOsdBus(), []);
  const [duration, setDuration] = useState(0);
  const [vsize, setVsize] = useState({ w: 0, h: 0 });
  const [paused, setPaused] = useState(false);
  const [controlsLocked, setControlsLocked] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [tapHearts, setTapHearts] = useState<{ id: number; x: number; y: number; rot: number }[]>([]);
  const tapHeartSeqRef = useRef(0);
  const mobileTapTimerRef = useRef<number | undefined>(undefined);
  const lastMobileTapRef = useRef<{ t: number; x: number; y: number } | null>(null);
  const desktopClickTimerRef = useRef<number | undefined>(undefined);
  const lastDesktopClickRef = useRef(0);
  const historyCommittedKeyRef = useRef("");
  const [muteHintVisible, setMuteHintVisible] = useState(muted);
  const muteHintTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(muteHintTimerRef.current);
    if (!muted) {
      setMuteHintVisible(false);
      return;
    }
    setMuteHintVisible(true);
    muteHintTimerRef.current = window.setTimeout(() => setMuteHintVisible(false), 4500);
    return () => window.clearTimeout(muteHintTimerRef.current);
  }, [muted]);
  const [err, setErr] = useState("");
  const [endedOverlay, setEndedOverlay] = useState(false);
  /* 取播放地址失败后手动重试：递增即重新触发拉取 */
  const [playTry, setPlayTry] = useState(0);
  const [panel, setPanel] = useState<"episodes" | "comments" | "article" | "detail" | null>(null);
  const [descOpen, setDescOpen] = useState(false);
  /* 移动端全屏控制栏显隐 & 全屏选集抽屉 */
  const [fsUiVisible, setFsUiVisible] = useState(true);
  const [fsEpOpen, setFsEpOpen] = useState(false);
  const fsUiVisibleRef = useRef(true);
  fsUiVisibleRef.current = fsUiVisible;
  const fsUiTimerRef = useRef<number | undefined>(undefined);
  const prefetchedPlayRef = useRef(new Set<string>());
  const prewarmedRef = useRef(new Set<string>());
  const nextVideoPrefetchTimerRef = useRef<number | undefined>(undefined);
  /* 续播：拿到时长后再 seek 一次（只对进入时那一条生效） */
  const resumeRef = useRef<{ key: string; t: number } | null>(
    startTime && startTime > 1 ? { key: `${videoIds[startIndex]}:${startEp || 1}`, t: startTime } : null,
  );
  const [resumePrompt, setResumePrompt] = useState<{ id: number; ep: number; t: number } | null>(null);
  const resumePromptedIdsRef = useRef(new Set<number>(startEp || (startTime && startTime > 1) ? [videoIds[startIndex]] : []));
  const resumePromptTimerRef = useRef<number | undefined>(undefined);
  /* 观看进度：onTime 里节流写回 store，卸载时再兜一次 */
  const hasLiveProgress = useRef(false);
  const liveRef = useRef({ id: 0, ep: 1, dur: 0, t: 0 });
  const lastSaveRef = useRef(0);
  const activeFs = active && fs;
  const activeRef = useRef(active);
  activeRef.current = active;
  const fsRef = useRef(fs);
  fsRef.current = fs;
  useEffect(() => () => {
    if (activeRef.current && fsRef.current) setFs(false);
  }, [setFs]);

  /* 追踪手机视口是否已处于物理/系统横屏状态（window.innerWidth > window.innerHeight） */
  const [vpLandscape, setVpLandscape] = useState(
    () => typeof window !== "undefined" && window.innerWidth > window.innerHeight,
  );
  const vpLandscapeRef = useRef(vpLandscape);


  /* 桌面：鼠标闲置 2.8s 自动隐藏播放器 UI（沉浸） */
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number | undefined>(undefined);
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 2800);
  }, []);
  useEffect(() => {
    if (!isDesktop) return undefined;
    wake();
    return () => window.clearTimeout(idleTimer.current);
  }, [isDesktop, wake]);
  useEffect(() => {
    if (paused) { setIdle(false); window.clearTimeout(idleTimer.current); }
  }, [paused]);
  const [fullscreen, setFullscreen] = useState(false);
  const [heartBurst, setHeartBurst] = useState(0);
  /* —— 移动端手势 & 竖屏横片缩放 —— */
  const [holdSpeed, setHoldSpeed] = useState(false);
  const [speedLock, setSpeedLock] = useState(false);
  const [lockArmed, setLockArmed] = useState(false);
  const holdRef = useRef(false);
  const lockArmedRef = useRef(false);
  const [scrubbing, setScrubbing] = useState(false);
  const scrubTarget = useRef<number | null>(null);
  const suppressClickUntilRef = useRef(0);
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  /* 竖屏下横屏视频适应模式（跟随全局设置）+ 全屏临时适配 + 双指无级缩放/平移 */
  const portraitFit = landscapeFitPref;
  const [fsFit, setFsFit] = useState<"contain" | "cover">("contain");
  const [zoomBadgeScale, setZoomBadgeScale] = useState<number | null>(null);
  const zoomRef = useRef({ scale: 1, x: 0, y: 0, gesturing: false });
  const applyZoom = useCallback((
    updater: { scale: number; x: number; y: number; gesturing: boolean }
      | ((prev: { scale: number; x: number; y: number; gesturing: boolean }) => { scale: number; x: number; y: number; gesturing: boolean }),
  ) => {
    const prev = zoomRef.current;
    const next = typeof updater === "function" ? updater(prev) : updater;
    zoomRef.current = next;
    videoRef.current?.setTransform(next.scale, next.x, next.y, next.gesturing);
    const badge = next.scale > 1.05 ? next.scale : null;
    setZoomBadgeScale((cur) => {
      if (!next.gesturing) return badge;
      if ((cur === null) !== (badge === null)) return badge;
      return cur;
    });
  }, []);
  const resetZoom = useCallback(() => {
    applyZoom({ scale: 1, x: 0, y: 0, gesturing: false });
  }, [applyZoom]);
  const pinchRef = useRef<{
    dist0: number; midX0: number; midY0: number; scale0: number; x0: number; y0: number;
  } | null>(null);
  /* 进度条拖动 */
  const barScrub = useRef(false);
  const [barPct, setBarPct] = useState<number | null>(null);
  const gesture = useRef<{
    x: number; y: number; startX: number; startY: number; t: number; timer: number | null;
    mode: "idle" | "hold" | "scrub" | "pan" | "vertical"; base: number; width: number; playing: boolean;
    zoomed: boolean; zoomX: number; zoomY: number; scrubStartDx: number;
  } | null>(null);

  const curId = videoIds[safeIndex];
  const keepIdsRef = useRef<Set<number>>(new Set());
  keepIdsRef.current = useMemo(() => {
    const start = Math.max(0, safeIndex - 15);
    const end = Math.min(videoIds.length, safeIndex + 16);
    const s = new Set(videoIds.slice(start, end));
    if (curId) s.add(curId);
    return s;
  }, [videoIds, safeIndex, curId]);

  const detail = details[curId];
  const curEp = epMap[curId] || 1;
  const playKey = `${curId}:${curEp}`;
  const activePlayKey = useRef(playKey);
  activePlayKey.current = playKey;
  const episodes = detail?.episodes || [];
  const post = posts[curId];
  const playUrl = kind === "post" ? (post?.video_url || "") : (playUrls[playKey] || "");
  const cachedOri = curId ? getVideoOrientation(curId) : undefined;
  const playUrlsRef = useRef(playUrls);
  playUrlsRef.current = playUrls;
  const prewarmUrl = useCallback((key: string, url: string) => {
    if (!url || prewarmedRef.current.has(key)) return;
    if (prewarmedRef.current.size > 120) prewarmedRef.current.clear();
    prewarmedRef.current.add(key);
    void api.prewarmMedia(url);
  }, []);
  const prefetchPlay = useCallback((vid: number, epNum: number) => {
    const key = `${vid}:${epNum}`;
    const existing = playUrlsRef.current[key];
    if (existing) {
      if (activeRef.current) prewarmUrl(key, existing);
      return;
    }
    if (!vid || prefetchedPlayRef.current.has(key)) return;
    prefetchedPlayRef.current.add(key);
    api.play(vid, epNum)
      .then((info) => {
        if (info?.video_url) {
          setPlayUrls((m) => (m[key] ? m : prunePlayMap({ ...m, [key]: info.video_url }, keepIdsRef.current)));
          if (activeRef.current) prewarmUrl(key, info.video_url);
        } else {
          prefetchedPlayRef.current.delete(key);
        }
      })
      .catch(() => {
        prefetchedPlayRef.current.delete(key);
      });
  }, [prewarmUrl]);
  useEffect(() => { videoRef.current?.trace("page.active", { active, view: mode, video_id: curId, episode: curEp }); }, [active, mode, curId, curEp]);
  useEffect(() => {
    if (active && curId) onView?.(curId);
  }, [active, curId, onView]);

  const saveLiveProgress = useCallback((immediate = false, force = false) => {
    const s = liveRef.current;
    if (hasLiveProgress.current && `${s.id}:${s.ep}` === activePlayKey.current && s.dur > 0) {
      const qualified = force || historyCommittedKeyRef.current === activePlayKey.current || s.t >= 3;
      if (!qualified) return;
      historyCommittedKeyRef.current = activePlayKey.current;
      lastSaveRef.current = Date.now();
      addHistory(s.id, s.ep, s.t, s.dur, immediate);
    }
  }, [addHistory]);

  useEffect(() => {
    if (!active) return;
    const onVis = () => {
      if (document.visibilityState === "hidden") saveLiveProgress(true);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      saveLiveProgress();
      hasLiveProgress.current = false;
    };
  }, [active, saveLiveProgress]);

  /* 观看进度：写进独立进度总线避免 Feed 重渲染；有效观看满 3 秒才首次记入历史，避免快速划走污染历史，随后每 20 秒落盘 */
  const onTimeTick = (t: number) => {
    if (!activeRef.current || playKey !== activePlayKey.current) return;
    hasLiveProgress.current = true;
    liveRef.current = { id: curId, ep: curEp, dur: duration, t };
    if (!barScrub.current && gesture.current?.mode !== "scrub") {
      progressBus.update({ time: t });
    }
    const now = Date.now();
    if (kind === "video" && duration > 0 && t >= 3) {
      const firstCommit = historyCommittedKeyRef.current !== playKey;
      if (firstCommit || now - lastSaveRef.current > 20000) {
        historyCommittedKeyRef.current = playKey;
        lastSaveRef.current = now;
        addHistory(curId, curEp, t, duration);
      }
    }
    if (kind === "video" && nextEp && duration > 15 && (t / duration >= 0.7 || duration - t <= 15)) {
      prefetchPlay(curId, nextEp.ep_num);
    }
  };

  /* 拿到时长后再续播：只对进入时那一条生效，且不跳到片尾 */
  const onDurationTick = (d: number) => {
    if (playKey !== activePlayKey.current) return;
    setDuration(d);
    progressBus.update({ duration: d });
    if (liveRef.current.id === curId && liveRef.current.ep === curEp) {
      liveRef.current = { ...liveRef.current, dur: d };
    }
    const r = resumeRef.current;
    if (r && r.key === playKey && r.t > 1 && (!d || r.t < d - 3)) {
      resumeRef.current = null;
      setEndedOverlay(false);
      videoRef.current?.seek(r.t, "history_resume");
      progressBus.update({ time: r.t });
    }
  };

  /** 统一视图模型：短剧与吃瓜帖子共用同一套播放界面 */
  const meta = kind === "post"
    ? {
        title: post?.title || "",
        cover: post?.cover || initialCovers?.[curId] || "",
        desc: post?.content || post?.desc || "",
        author: "黄果吃瓜",
        authorId: -1,
        tags: post?.tags || [],
        score: 0,
        like: 0,
        comment: 0,
        collect: 0,
        episodes: [] as Episode[],
      }
    : {
        title: detail?.title || "",
        cover: detail?.cover || initialCovers?.[curId] || "",
        desc: detail?.description || "",
        author: detail?.author?.name || "黄果短剧",
        authorId: detail?.author?.id || -1,
        tags: detail?.tags || [],
        score: detail?.score || 0,
        like: detail?.counts?.like ?? 0,
        comment: detail?.counts?.comment ?? 0,
        collect: detail?.counts?.collect ?? 0,
        episodes: detail?.episodes || [],
      };

  const posterUrl = cover(meta.cover, 900);
  const hasVideo = kind === "video" || !!post?.video_url;
  const articleHtml = kind === "post" && !hasVideo ? (post?.content || "") : "";

  /* 分享：复制播放链接 */
  const shareLink = () => {
    const u = kind === "post" ? (posts[curId]?.video_url || meta.title) : `https://huangguoai.com/video/${curId}/`;
    navigator.clipboard?.writeText(u).then(() => toast("链接已复制", "ok")).catch(() => {});
  };

  /* 倍速：长按 / 锁定 → 2.0x，否则用基准倍速 */
  const effRate = holdSpeed || speedLock ? 2 : rate;
  /* 是否为横屏视频（优先使用本场视频真实宽高，未加载时读取历史记忆方向） */
  const isLandscapeVideo = vsize.w > 0 && vsize.h > 0
    ? vsize.w > vsize.h
    : cachedOri?.orientation === "landscape";
  const orientationBadge = vsize.w > 0 && vsize.h > 0
    ? (vsize.w > vsize.h ? "横屏" : "竖屏")
    : cachedOri
      ? (cachedOri.orientation === "landscape" ? "横屏" : "竖屏")
      : "";
  const orientationLabel = vsize.w > 0 && vsize.h > 0
    ? `${vsize.w > vsize.h ? "横屏" : "竖屏"} · ${Math.min(vsize.w, vsize.h)}p`
    : cachedOri
      ? `${cachedOri.orientation === "landscape" ? "横屏" : "竖屏"} · ${Math.min(cachedOri.w, cachedOri.h)}p`
      : "";
  /* 仅当「全屏 + 横屏视频 + 手机系统视口尚未横过来 (!vpLandscape)」时才用 CSS 旋转 90° 兜底；
     一旦系统屏幕已经横过来了 (vpLandscape === true)，不再叠加 CSS 旋转，彻底解决手机横置后视频反而竖过去的问题！ */
  const rotated = !isDesktop && activeFs && isLandscapeVideo && !vpLandscape;

  const showFsUi = useCallback((autoHide = true) => {
    setFsUiVisible(true);
    window.clearTimeout(fsUiTimerRef.current);
    if (autoHide && !paused && !fsEpOpen) {
      fsUiTimerRef.current = window.setTimeout(() => setFsUiVisible(false), 3200);
    }
  }, [paused, fsEpOpen]);

  const toggleFsUi = useCallback(() => {
    if (paused || fsEpOpen) {
      showFsUi(false);
      return;
    }
    if (fsUiVisibleRef.current) {
      window.clearTimeout(fsUiTimerRef.current);
      setFsUiVisible(false);
    } else {
      showFsUi(true);
    }
  }, [paused, fsEpOpen, showFsUi]);

  useEffect(() => {
    if (!activeFs) {
      window.clearTimeout(fsUiTimerRef.current);
      setFsUiVisible(true);
      setFsEpOpen(false);
      setFsFit("contain");
      return;
    }
    showFsUi(!paused && !fsEpOpen);
  }, [activeFs, paused, fsEpOpen, showFsUi]);

  useEffect(() => () => {
    window.clearTimeout(fsUiTimerRef.current);
    window.clearTimeout(nextVideoPrefetchTimerRef.current);
    window.clearTimeout(resumePromptTimerRef.current);
    window.clearTimeout(mobileTapTimerRef.current);
    window.clearTimeout(desktopClickTimerRef.current);
    window.clearTimeout(muteHintTimerRef.current);
    osdBus.clear();
  }, [osdBus]);

  /* 借鉴 stclock1988/hghub-ios (PlayerView.swift keepPlayingThroughTransition)：
     iOS 在横竖屏几何旋转或全屏视图层级切换期间，系统底层 AVPlayer / WebKit 视频层可能被短暂挂起暂停。
     在过渡窗口期内分批重申 play()，确保旋转/全屏切换不中断播放。 */
  const keepPlayingTimers = useRef<number[]>([]);
  const cancelKeepPlaying = useCallback(() => {
    keepPlayingTimers.current.forEach((id) => window.clearTimeout(id));
    keepPlayingTimers.current = [];
  }, []);

  const prevEp = useMemo(() => {
    const list = detail?.episodes;
    if (kind !== "video" || !list?.length) return undefined;
    const idx = list.findIndex((e) => e.ep_num === curEp);
    if (idx > 0) return list[idx - 1];
    const smaller = list.filter((e) => e.ep_num < curEp);
    return smaller[smaller.length - 1];
  }, [kind, detail?.episodes, curEp]);

  const nextEp = useMemo(() => {
    const list = detail?.episodes;
    if (kind !== "video" || !list?.length) return undefined;
    const exact = list.find((e) => e.ep_num === curEp + 1);
    if (exact) return exact;
    const idx = list.findIndex((e) => e.ep_num === curEp);
    if (idx >= 0 && idx + 1 < list.length) return list[idx + 1];
    return list.find((e) => e.ep_num > curEp);
  }, [kind, detail?.episodes, curEp]);

  const goPrevEp = useCallback(() => {
    if (!prevEp) return false;
    saveLiveProgress();
    cancelKeepPlaying();
    setEndedOverlay(false);
    setEpMap((m) => ({ ...m, [curId]: prevEp.ep_num }));
    setPanel(null);
    setFsEpOpen(false);
    toast(`第 ${prevEp.ep_num} 集`, "info");
    return true;
  }, [prevEp, curId, cancelKeepPlaying, saveLiveProgress, toast]);

  const goNextEp = useCallback((prefix = "") => {
    if (!nextEp) return false;
    saveLiveProgress();
    cancelKeepPlaying();
    setEndedOverlay(false);
    setEpMap((m) => ({ ...m, [curId]: nextEp.ep_num }));
    setPanel(null);
    setFsEpOpen(false);
    toast(`${prefix}第 ${nextEp.ep_num} 集`, "info");
    return true;
  }, [nextEp, curId, cancelKeepPlaying, saveLiveProgress, toast]);
  const keepPlayingThroughTransition = useCallback(() => {
    cancelKeepPlaying();
    const el = videoRef.current?.el();
    const shouldPlay = el ? !el.paused : !paused;
    if (!shouldPlay) return;
    for (const delay of [50, 150, 300, 500, 800, 1200]) {
      const tid = window.setTimeout(() => {
        const v = videoRef.current?.el();
        if (activeRef.current && v && v.paused && !v.ended) {
          videoRef.current?.play();
        }
      }, delay);
      keepPlayingTimers.current.push(tid);
    }
  }, [paused, cancelKeepPlaying]);

  useEffect(() => () => {
    cancelKeepPlaying();
  }, [cancelKeepPlaying]);

  /* 监听手机屏幕横竖屏变化：物理横置手机时自动进入全屏，竖回时自动退出全屏 */
  useEffect(() => {
    if (isDesktop) return undefined;
    const onViewportChange = () => {
      const isLand = window.innerWidth > window.innerHeight;
      if (vpLandscapeRef.current !== isLand) {
        vpLandscapeRef.current = isLand;
        setVpLandscape(isLand);
        if (active) {
          setFs(isLand);
          keepPlayingThroughTransition();
        }
      }
    };
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("orientationchange", onViewportChange);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("orientationchange", onViewportChange);
    };
  }, [isDesktop, active, setFs, keepPlayingThroughTransition]);

  /* 进入 / 退出全屏：对横屏视频直接调用原生屏幕方向切换，让手机系统界面真正横过来 */
  const enterFs = useCallback(() => {
    keepPlayingThroughTransition();
    setFs(true);
    if (isLandscapeVideo) {
      invoke("set_orientation", { landscape: true }).catch(() => {});
      try {
        (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.("landscape")?.catch(() => {});
      } catch { /* ignore */ }
    }
  }, [isLandscapeVideo, setFs, keepPlayingThroughTransition]);

  const exitFs = useCallback(() => {
    keepPlayingThroughTransition();
    setFs(false);
    invoke("set_orientation", { landscape: false }).catch(() => {});
    try { screen.orientation?.unlock?.(); } catch { /* ignore */ }
  }, [setFs, keepPlayingThroughTransition]);

  /* 全屏状态下若视频宽高刚加载出来且为横屏，自动补发一次横屏指令 */
  useEffect(() => {
    if (!isDesktop && activeFs && isLandscapeVideo) {
      invoke("set_orientation", { landscape: true }).catch(() => {});
    }
  }, [isDesktop, activeFs, isLandscapeVideo]);

  /* 全屏切换或视口旋转后复位缩放并校准滚动容器 scrollTop：
     - 进入全屏时非当前项已隐藏，当前项位于顶部 scrollTop = 0；
     - 退出全屏回到竖屏列表时，立即将 scrollTop 重新对齐到 index * clientHeight，防止错位到其它视频封面。 */
  useEffect(() => {
    resetZoom();
    const el = boxRef.current;
    if (!el) return undefined;
    if (activeFs) {
      el.scrollTop = 0;
      return undefined;
    }
    const syncScroll = () => {
      const box = boxRef.current;
      if (!box || activeFs) return;
      box.scrollTop = indexRef.current * (box.clientHeight || 1);
    };
    syncScroll();
    const raf = requestAnimationFrame(syncScroll);
    const t1 = window.setTimeout(syncScroll, 120);
    const t2 = window.setTimeout(syncScroll, 350);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [activeFs, vpLandscape]);

  /* 滚动定位（全屏或缩放手势期间锁定索引，避免容器尺寸变化误触发翻页） */
  const onScroll = useCallback(() => {
    if (activeFs || pinchRef.current) return;
    const el = boxRef.current;
    if (!el) return;
    const h = el.clientHeight || 1;
    const i = Math.max(0, Math.min(videoIds.length - 1, Math.round(el.scrollTop / h)));
    setIndex((prev) => (prev === i ? prev : i));
    if (onNearEnd && i >= videoIds.length - 3) onNearEnd();
  }, [videoIds.length, onNearEnd, activeFs]);

  const go = useCallback((delta: number) => {
    const next = Math.max(0, Math.min(videoIds.length - 1, safeIndex + delta));
    if (next === safeIndex) return;
    if (activeFs) {
      saveLiveProgress();
      setIndex(next);
      if (next >= videoIds.length - 3) onNearEnd?.();
      return;
    }
    const el = boxRef.current;
    el?.scrollTo({ top: next * el.clientHeight, behavior: "smooth" });
  }, [activeFs, safeIndex, videoIds.length, onNearEnd, saveLiveProgress]);

  /* 初始定位 */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = startIndex * (el.clientHeight || 1);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 切换横向视频在竖屏下的填充方式并记住偏好 */
  const togglePortraitFit = useCallback(() => {
    setLandscapeFitPref(landscapeFitPref === "contain" ? "cover" : "contain");
  }, [landscapeFitPref, setLandscapeFitPref]);

  /* 桌面端滚轮换剧（防 Windows 回弹 & macOS 触控板惯性连跳） */
  const wheelLastRef = useRef(0);
  const wheelAccumRef = useRef(0);
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    if (!isDesktop || activeFs || videoIds.length <= 1) return undefined;
    const el = boxRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      if (!activeRef.current || controlsLocked) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest(".desktop-video-meta button, .desktop-dock-panel")) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      const now = Date.now();
      if (now - wheelLastRef.current < 480) return;
      wheelAccumRef.current += e.deltaY;
      if (Math.abs(wheelAccumRef.current) >= 32) {
        const dir = wheelAccumRef.current > 0 ? 1 : -1;
        wheelAccumRef.current = 0;
        wheelLastRef.current = now;
        goRef.current(dir);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [isDesktop, activeFs, videoIds.length, controlsLocked]);

  /* 拉详情（当前立即请求 + 邻接 400ms 防抖预取，且裁剪超限缓存） */
  useEffect(() => {
    if (kind !== "video") return undefined;
    let alive = true;
    const fetchOne = (id?: number) => {
      if (!id || details[id]) return;
      fetchVideoDetailCached(lineVersion, id).then((d) => {
        if (!alive) return;
        setDetails((m) => pruneIdMap({ ...m, [id]: d }, keepIdsRef.current));
      }).catch(() => {});
    };
    fetchOne(videoIds[safeIndex]);
    const timer = window.setTimeout(() => {
      fetchOne(videoIds[safeIndex + 1]);
      fetchOne(videoIds[safeIndex - 1]);
    }, 400);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, safeIndex, videoIds]);

  /* 吃瓜帖子：当前立即请求 + 邻接 400ms 防抖预取（含 video_url） */
  useEffect(() => {
    if (kind !== "post") return undefined;
    let alive = true;
    const fetchPost = (id?: number) => {
      if (!id || posts[id]) return;
      api.post(id)
        .then((p) => { if (alive) setPosts((m) => pruneIdMap({ ...m, [id]: p }, keepIdsRef.current)); })
        .catch((e) => { if (alive && id === curId) setErr((e as Error).message || "加载帖子失败"); });
    };
    fetchPost(videoIds[safeIndex]);
    const timer = window.setTimeout(() => {
      fetchPost(videoIds[safeIndex + 1]);
      fetchPost(videoIds[safeIndex - 1]);
    }, 400);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, safeIndex, videoIds, playTry]);

  /* 拉播放地址 */
  useEffect(() => {
    if (kind !== "video" || !curId) return undefined;
    if (playUrls[playKey]) return undefined;
    let alive = true;
    api.play(curId, curEp)
      .then((info) => {
        if (!alive) return;
        if (!info?.video_url) throw new Error("暂无播放地址");
        setPlayUrls((m) => prunePlayMap({ ...m, [playKey]: info.video_url }, keepIdsRef.current));
      })
      .catch((e) => { if (alive) setErr((e as Error).message || "取播放地址失败"); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, curId, curEp, playTry]);

  /* 仅在用户主动选集/切集时立刻记录观看进度；普通浏览等待有效播放满 3 秒后再写入历史，防止快速划走污染历史 */

  const reloadPlaySource = () => {
    setErr("");
    setEndedOverlay(false);
    setWaiting(true);
    if (kind === "video") {
      setPlayUrls((m) => {
        if (!(playKey in m)) return m;
        const next = { ...m };
        delete next[playKey];
        return next;
      });
    } else if (curId) {
      setPosts((m) => {
        if (!(curId in m)) return m;
        const next = { ...m };
        delete next[curId];
        return next;
      });
    }
    setPlayTry((n) => n + 1);
  };

  /* 切换视频时检测是否存在跨页历史进度，提供一键续播胶囊 */
  useEffect(() => {
    window.clearTimeout(resumePromptTimerRef.current);
    if (kind !== "video" || !curId || !active) {
      setResumePrompt(null);
      return;
    }
    if (resumePromptedIdsRef.current.has(curId)) {
      setResumePrompt((prev) => (prev && prev.id === curId ? prev : null));
      return;
    }
    resumePromptedIdsRef.current.add(curId);
    const prog = getWatchProgress(curId);
    const notNearEnd = !prog?.dur || prog.t < prog.dur - 5;
    if (prog && (prog.ep > 1 || (prog.t > 5 && notNearEnd))) {
      setResumePrompt({ id: curId, ep: prog.ep, t: prog.t });
      resumePromptTimerRef.current = window.setTimeout(() => setResumePrompt(null), 7000);
    } else {
      setResumePrompt(null);
    }
  }, [kind, curId, active, getWatchProgress]);

  const applyResumePrompt = useCallback(() => {
    if (!resumePrompt || resumePrompt.id !== curId) return;
    const { ep, t } = resumePrompt;
    setResumePrompt(null);
    window.clearTimeout(resumePromptTimerRef.current);
    setEndedOverlay(false);
    if (t > 1) resumeRef.current = { key: `${curId}:${ep}`, t };
    if (ep !== curEp) {
      setEpMap((m) => ({ ...m, [curId]: ep }));
    } else if (t > 1) {
      resumeRef.current = null;
      videoRef.current?.seek(t, "history_resume");
      progressBus.update({ time: t });
    }
  }, [resumePrompt, curId, curEp, progressBus]);

  /* 切换条目/集数时重置播放与缩放状态 */
  useEffect(() => {
    progressBus.reset();
    scrubBus.set(null);
    setScrubbing(false);
    setDuration(0); setErr(""); setEndedOverlay(false); setWaiting(true); setPaused(false); setDescOpen(false);
    setFsFit("contain");
    setVsize({ w: 0, h: 0 });
    resetZoom();
  }, [playKey, progressBus, scrubBus, resetZoom]);

  /* 音量/静音同步 */
  useEffect(() => { videoRef.current?.mute(muted); }, [muted]);
  useEffect(() => { videoRef.current?.volume(volume); }, [volume]);
  /* 倍速同步（长按 2x / 锁定 2x / 基准倍速） */
  useEffect(() => { videoRef.current?.rate(effRate); }, [effRate, playKey]);

  /* 移动端隐藏时卸载 VideoSurface 释放硬件解码器与 MSE 缓冲，先记住当前进度以便回来续播 */
  useEffect(() => {
    if (!isMobile || active) return;
    const s = liveRef.current;
    if (s.id === curId && s.ep === curEp && s.t > 1) {
      resumeRef.current = { key: playKey, t: s.t };
    }
    setWaiting(false);
  }, [active, curId, curEp, playKey]);

  /* 返回键 / Escape：先关全屏选集抽屉，再关底部/侧边面板 */
  useEffect(() => {
    if (!fsEpOpen) return undefined;
    return pushBackHandler(() => { setFsEpOpen(false); return true; });
  }, [fsEpOpen]);

  useEffect(() => {
    if (!panel) return undefined;
    return pushBackHandler(() => { setPanel(null); return true; });
  }, [panel]);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggleFull = () => {
    const el = boxRef.current?.parentElement;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen().catch(() => {});
  };

  /* —— 移动端原生触摸手势（{ passive: false } 锁横滑防 iOS 滚动取消）+ 桌面端鼠标横拖 —— */
  const cancelSingleGesture = () => {
    const g = gesture.current;
    if (g?.timer) window.clearTimeout(g.timer);
    gesture.current = null;
    if (holdRef.current) {
      holdRef.current = false;
      setHoldSpeed(false);
    }
    lockArmedRef.current = false;
    setLockArmed(false);
    scrubBus.set(null);
    setScrubbing(false);
    scrubTarget.current = null;
  };

  const spawnTapHeart = useCallback((x: number, y: number) => {
    const id = ++tapHeartSeqRef.current;
    const rot = (Math.random() - 0.5) * 28;
    setTapHearts((prev) => [...prev.slice(-4), { id, x, y, rot }]);
    window.setTimeout(() => {
      setTapHearts((prev) => prev.filter((item) => item.id !== id));
    }, 780);
  }, []);

  const mobileDoubleTapRef = useRef<(clientX: number, clientY: number) => void>(() => {});
  mobileDoubleTapRef.current = (clientX: number, clientY: number) => {
    const rect = stageEl?.getBoundingClientRect();
    if (activeFs) {
      const span = rect ? (rotated ? rect.height : rect.width) : (rotated ? window.innerHeight : window.innerWidth);
      const offset = rect ? (rotated ? clientY - rect.top : clientX - rect.left) : (rotated ? clientY : clientX);
      const ratio = span > 0 ? offset / span : 0.5;
      const curTime = videoRef.current?.el()?.currentTime ?? progressBus.get().time;
      if (ratio < 0.33 && duration > 0) {
        const target = Math.max(0, curTime - 10);
        setErr("");
        setEndedOverlay(false);
        progressBus.update({ time: target });
        videoRef.current?.seek(target, "mobile_double_tap");
        osdBus.show("快退 10 秒");
      } else if (ratio > 0.67 && duration > 0) {
        const target = Math.min(Math.max(0, duration - 0.15), curTime + 10);
        setErr("");
        setEndedOverlay(false);
        progressBus.update({ time: target });
        videoRef.current?.seek(target, "mobile_double_tap");
        osdBus.show("快进 10 秒");
      } else {
        const wasPaused = videoRef.current?.el()?.paused;
        cancelKeepPlaying();
        videoRef.current?.toggle();
        osdBus.show(wasPaused ? "继续播放" : "已暂停");
      }
      showFsUi(true);
      return;
    }
    const localX = rect ? (rotated ? clientY - rect.top : clientX - rect.left) : clientX;
    const localY = rect ? (rotated ? rect.right - clientX : clientY - rect.top) : clientY;
    spawnTapHeart(localX, localY);
    if (kind === "video" && curId) {
      if (!isLiked(curId, false)) {
        onLike();
      } else {
        setHeartBurst((n) => n + 1);
      }
    }
  };

  const touchCtxRef = useRef({
    active,
    activeFs,
    fsEpOpen,
    controlsLocked,
    isDesktop,
    rotated,
    progressBus,
    scrubBus,
    duration,
    cancelKeepPlaying,
    cancelSingleGesture,
    toggleFsUi,
    showFsUi,
    setEndedOverlay,
    applyZoom,
    setScrubbing,
    setErr,
    setHoldSpeed,
    setLockArmed,
    setSpeedLock,
    toast,
  });
  touchCtxRef.current = {
    active,
    activeFs,
    fsEpOpen,
    controlsLocked,
    isDesktop,
    rotated,
    progressBus,
    scrubBus,
    duration,
    cancelKeepPlaying,
    cancelSingleGesture,
    toggleFsUi,
    showFsUi,
    setEndedOverlay,
    applyZoom,
    setScrubbing,
    setErr,
    setHoldSpeed,
    setLockArmed,
    setSpeedLock,
    toast,
  };

  useEffect(() => {
    if (!stageEl) return undefined;

    const onNativeTouchStart = (e: TouchEvent) => {
      const ctx = touchCtxRef.current;
      if (ctx.isDesktop || ctx.controlsLocked || !ctx.active || ctx.fsEpOpen) return;
      if (e.touches.length === 2) {
        ctx.cancelSingleGesture();
        const t0 = e.touches[0];
        const t1 = e.touches[1];
        const dist0 = Math.max(12, Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY));
        const midX0 = (t0.clientX + t1.clientX) / 2;
        const midY0 = (t0.clientY + t1.clientY) / 2;
        pinchRef.current = {
          dist0,
          midX0,
          midY0,
          scale0: zoomRef.current.scale,
          x0: zoomRef.current.x,
          y0: zoomRef.current.y,
        };
      } else if (e.touches.length === 1 && !pinchRef.current && !gesture.current) {
        const t0 = e.touches[0];
        const span = ctx.rotated ? (stageEl.clientHeight || window.innerHeight || 1) : (stageEl.clientWidth || 1);
        const base = videoRef.current?.el()?.currentTime ?? ctx.progressBus.get().time;
        gesture.current = {
          x: t0.clientX,
          y: t0.clientY,
          startX: t0.clientX,
          startY: t0.clientY,
          t: Date.now(),
          base,
          width: span,
          playing: videoRef.current?.el()?.paused === false,
          zoomed: zoomRef.current.scale > 1.05,
          zoomX: zoomRef.current.x,
          zoomY: zoomRef.current.y,
          scrubStartDx: 0,
          mode: "idle",
          timer: window.setTimeout(() => {
            const cur = gesture.current;
            if (!cur || cur.mode !== "idle" || pinchRef.current) return;
            cur.mode = "hold";
            holdRef.current = true;
            touchCtxRef.current.setHoldSpeed(true);
            touchCtxRef.current.setLockArmed(false);
            lockArmedRef.current = false;
            try { navigator.vibrate?.(25); } catch { /* ignore */ }
          }, 380) as unknown as number,
        };
      }
    };

    const onNativeTouchMove = (e: TouchEvent) => {
      const ctx = touchCtxRef.current;
      if (ctx.isDesktop || ctx.controlsLocked) return;
      if (e.touches.length === 2 && pinchRef.current) {
        e.preventDefault();
        const p = pinchRef.current;
        const t0 = e.touches[0];
        const t1 = e.touches[1];
        const dist = Math.max(12, Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY));
        const midX = (t0.clientX + t1.clientX) / 2;
        const midY = (t0.clientY + t1.clientY) / 2;
        const nextScale = Math.max(0.85, Math.min(3.5, p.scale0 * (dist / p.dist0)));
        const rawDx = midX - p.midX0;
        const rawDy = midY - p.midY0;
        const dx = ctx.rotated ? rawDy : rawDx;
        const dy = ctx.rotated ? -rawDx : rawDy;
        const stageW = ctx.rotated ? window.innerHeight : window.innerWidth;
        const stageH = ctx.rotated ? window.innerWidth : window.innerHeight;
        const maxX = Math.max(0, (nextScale - 1) * stageW * 0.55);
        const maxY = Math.max(0, (nextScale - 1) * stageH * 0.55);
        const nextX = Math.max(-maxX, Math.min(maxX, p.x0 + dx));
        const nextY = Math.max(-maxY, Math.min(maxY, p.y0 + dy));
        ctx.applyZoom({ scale: nextScale, x: nextX, y: nextY, gesturing: true });
        return;
      }
      if (pinchRef.current) {
        ctx.cancelSingleGesture();
        return;
      }
      const g = gesture.current;
      if (!g || e.touches.length !== 1) return;
      const t0 = e.touches[0];
      const rawDx = t0.clientX - g.x;
      const rawDy = t0.clientY - g.y;
      const dx = ctx.rotated ? rawDy : rawDx;
      const dy = ctx.rotated ? -rawDx : rawDy;

      if (g.mode === "hold") {
        e.preventDefault();
        const upDist = ctx.rotated ? (t0.clientX - g.startX) : (g.startY - t0.clientY);
        const armed = upDist > 64;
        if (armed !== lockArmedRef.current) {
          lockArmedRef.current = armed;
          ctx.setLockArmed(armed);
        }
        return;
      }

      if (g.mode === "vertical") return;

      if (g.mode === "idle") {
        const total = ctx.duration || videoRef.current?.el()?.duration || 0;
        if (g.zoomed && Math.hypot(dx, dy) > 6) {
          e.preventDefault();
          if (g.timer) window.clearTimeout(g.timer);
          g.mode = "pan";
        } else if (Number.isFinite(total) && total > 0 && Math.abs(dx) > 8 && Math.abs(dx) >= Math.abs(dy) * 1.1) {
          e.preventDefault();
          if (g.timer) window.clearTimeout(g.timer);
          g.mode = "scrub";
          g.scrubStartDx = dx;
          const res = computeScrubTarget(g.base, 0, g.width, total);
          scrubTarget.current = res.target;
          ctx.setScrubbing(true);
          ctx.scrubBus.set(res);
        } else if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx) * 1.1) {
          if (g.timer) window.clearTimeout(g.timer);
          g.mode = "vertical";
        }
        return;
      }

      if (g.mode === "pan" && g.zoomed) {
        e.preventDefault();
        const stageW = ctx.rotated ? window.innerHeight : window.innerWidth;
        const stageH = ctx.rotated ? window.innerWidth : window.innerHeight;
        const maxX = Math.max(0, (zoomRef.current.scale - 1) * stageW * 0.55);
        const maxY = Math.max(0, (zoomRef.current.scale - 1) * stageH * 0.55);
        const nextX = Math.max(-maxX, Math.min(maxX, g.zoomX + dx));
        const nextY = Math.max(-maxY, Math.min(maxY, g.zoomY + dy));
        ctx.applyZoom((prev) => ({ ...prev, x: nextX, y: nextY, gesturing: true }));
        return;
      }

      if (g.mode === "scrub") {
        e.preventDefault();
        const total = ctx.duration || videoRef.current?.el()?.duration || 0;
        if (!Number.isFinite(total) || total <= 0) return;
        const res = computeScrubTarget(g.base, dx - g.scrubStartDx, g.width, total);
        scrubTarget.current = res.target;
        ctx.scrubBus.set(res);
      }
    };

    const onNativeTouchEndOrCancel = (e: TouchEvent) => {
      const ctx = touchCtxRef.current;
      if (ctx.isDesktop) return;
      if (pinchRef.current && e.touches.length < 2) {
        pinchRef.current = null;
        ctx.applyZoom((prev) =>
          prev.scale < 1.08
            ? { scale: 1, x: 0, y: 0, gesturing: false }
            : { ...prev, gesturing: false },
        );
        return;
      }
      if (e.touches.length > 0) return;
      const cancelled = e.type === "touchcancel";
      const g = gesture.current;
      gesture.current = null;
      if (!g) return;
      if (g.timer) window.clearTimeout(g.timer);

      if (g.mode === "pan" && g.zoomed) {
        ctx.applyZoom((prev) => (prev.gesturing ? { ...prev, gesturing: false } : prev));
        return;
      }

      if (g.mode === "hold") {
        holdRef.current = false;
        ctx.setHoldSpeed(false);
        if (!cancelled && lockArmedRef.current) {
          ctx.setSpeedLock(true);
          ctx.toast("已锁定 2.0x 倍速 · 点顶部标签解除", "info");
        }
        lockArmedRef.current = false;
        ctx.setLockArmed(false);
        return;
      }

      if (g.mode === "scrub") {
        const target = scrubTarget.current;
        ctx.scrubBus.set(null);
        ctx.setScrubbing(false);
        scrubTarget.current = null;
        suppressClickUntilRef.current = Date.now() + 350;
        if (!cancelled && target != null) {
          ctx.setErr("");
          ctx.setEndedOverlay(false);
          ctx.progressBus.update({ time: target });
          videoRef.current?.seek(target, "mobile_gesture");
        }
        if (!cancelled && g.playing && ctx.active && !ctx.controlsLocked) videoRef.current?.play();
        if (ctx.activeFs) ctx.showFsUi(true);
        return;
      }

      if (!cancelled && g.mode === "idle" && Date.now() - g.t < 380) {
        const t = e.changedTouches[0];
        const moveDist = t ? Math.hypot(t.clientX - g.x, t.clientY - g.y) : 0;
        if (moveDist < 16 && t) {
          suppressClickUntilRef.current = Date.now() + 350;
          const now = Date.now();
          const prev = lastMobileTapRef.current;
          if (prev && now - prev.t < 240 && Math.hypot(t.clientX - prev.x, t.clientY - prev.y) < 56) {
            window.clearTimeout(mobileTapTimerRef.current);
            mobileTapTimerRef.current = undefined;
            lastMobileTapRef.current = null;
            mobileDoubleTapRef.current(t.clientX, t.clientY);
          } else {
            lastMobileTapRef.current = { t: now, x: t.clientX, y: t.clientY };
            window.clearTimeout(mobileTapTimerRef.current);
            const wasFs = ctx.activeFs;
            mobileTapTimerRef.current = window.setTimeout(() => {
              mobileTapTimerRef.current = undefined;
              lastMobileTapRef.current = null;
              if (wasFs) {
                touchCtxRef.current.toggleFsUi();
              } else {
                touchCtxRef.current.cancelKeepPlaying();
                videoRef.current?.toggle();
              }
            }, 230);
          }
        }
      }
    };

    stageEl.addEventListener("touchstart", onNativeTouchStart, { passive: true });
    stageEl.addEventListener("touchmove", onNativeTouchMove, { passive: false });
    stageEl.addEventListener("touchend", onNativeTouchEndOrCancel);
    stageEl.addEventListener("touchcancel", onNativeTouchEndOrCancel);
    return () => {
      pinchRef.current = null;
      if (gesture.current?.timer) window.clearTimeout(gesture.current.timer);
      gesture.current = null;
      stageEl.removeEventListener("touchstart", onNativeTouchStart);
      stageEl.removeEventListener("touchmove", onNativeTouchMove);
      stageEl.removeEventListener("touchend", onNativeTouchEndOrCancel);
      stageEl.removeEventListener("touchcancel", onNativeTouchEndOrCancel);
    };
  }, [stageEl]);

  /* —— 桌面端鼠标横拖快进快退 —— */
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse" || controlsLocked || !active || !e.isPrimary || gesture.current || e.button !== 0) return;
    const el = e.currentTarget;
    const span = el.clientWidth || 1;
    gesture.current = {
      x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY,
      t: Date.now(), base: videoRef.current?.el()?.currentTime ?? progressBus.get().time, width: span,
      playing: videoRef.current?.el()?.paused === false,
      zoomed: false, zoomX: 0, zoomY: 0, scrubStartDx: 0,
      mode: "idle", timer: null,
    };
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse") return;
    const g = gesture.current;
    if (!g || !e.isPrimary) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    const total = duration || videoRef.current?.el()?.duration || 0;

    if (g.mode === "idle") {
      if (Number.isFinite(total) && total > 0 && Math.abs(dx) > 10 && Math.abs(dx) >= Math.abs(dy) * 1.1) {
        g.mode = "scrub";
        g.scrubStartDx = dx;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        wake();
        const res = computeScrubTarget(g.base, 0, g.width, total);
        scrubTarget.current = res.target;
        setScrubbing(true);
        scrubBus.set(res);
      } else if (Math.abs(dy) > 16) {
        g.mode = "vertical";
      }
      return;
    }

    if (g.mode === "scrub") {
      if (!Number.isFinite(total) || total <= 0) return;
      wake();
      const res = computeScrubTarget(g.base, dx - g.scrubStartDx, g.width, total);
      scrubTarget.current = res.target;
      scrubBus.set(res);
    }
  };

  const onUp = (e?: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    if (e && e.pointerType !== "mouse") return;
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.timer) window.clearTimeout(g.timer);

    if (g.mode === "pan" && g.zoomed) {
      applyZoom((prev) => (prev.gesturing ? { ...prev, gesturing: false } : prev));
      return;
    }

    if (g.mode === "hold") {
      holdRef.current = false;
      setHoldSpeed(false);
      if (!cancelled && lockArmedRef.current) {
        setSpeedLock(true);
        toast("已锁定 2.0x 倍速 · 点顶部标签解除", "info");
      }
      lockArmedRef.current = false;
      setLockArmed(false);
      return;
    }

    if (g.mode === "scrub") {
      const target = scrubTarget.current;
      scrubBus.set(null);
      setScrubbing(false);
      scrubTarget.current = null;
      if (isDesktop) suppressClickUntilRef.current = Date.now() + 250;
      if (!cancelled && target != null) {
        setErr("");
        progressBus.update({ time: target });
        videoRef.current?.seek(target, isDesktop ? "desktop_drag_gesture" : "mobile_gesture");
      }
      if (!cancelled && g.playing && active && !controlsLocked) videoRef.current?.play();
    }
  };

  useEffect(() => {
    if (!active || controlsLocked) onUp(undefined, true);
    // Cancel pending gestures when the page is hidden or controls are locked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, controlsLocked]);

  useEffect(() => () => {
    if (gesture.current?.timer) window.clearTimeout(gesture.current.timer);
    gesture.current = null;
  }, [playKey]);

  const lockControls = () => { setPanel(null); setControlsLocked(true); };

  /* 长按倍速 / 横拖进度 / 画面放大平移 / 全屏期间禁止外层列表原生滚动 */
  useEffect(() => {
    if (isDesktop) return undefined;
    const el = boxRef.current;
    if (!el) return undefined;
    const fn = (e: TouchEvent) => {
      if (
        holdRef.current ||
        pinchRef.current ||
        activeFs ||
        gesture.current?.mode === "scrub" ||
        zoomRef.current.scale > 1.05 ||
        e.touches.length >= 2
      ) {
        e.preventDefault();
      }
    };
    el.addEventListener("touchmove", fn, { passive: false });
    return () => el.removeEventListener("touchmove", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop, videoIds.length, activeFs]);

  /* —— 进度条拖动（直接用当前触发元素的 BoundingRect，旋转舞台下按 Y 轴换算） —— */
  const barPctAt = (barEl: HTMLElement | null, clientX: number, clientY: number) => {
    const r = barEl?.getBoundingClientRect();
    if (!r) return null;
    const span = rotated ? r.height : r.width;
    if (!span) return null;
    const raw = rotated ? (clientY - r.top) / span : (clientX - r.left) / span;
    return Math.max(0, Math.min(1, raw));
  };
  const barSeekTo = (barEl: HTMLElement | null, clientX: number, clientY: number) => {
    const pct = barPctAt(barEl, clientX, clientY);
    if (pct == null) return null;
    setBarPct(pct);
    return pct;
  };
  const onBarDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (!duration || duration <= 0) return;
    if (activeFs) showFsUi(false);
    videoRef.current?.trace("seek.input.down", { input: "mobile_bar" });
    barScrub.current = true;
    const el = e.currentTarget as HTMLElement;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    barSeekTo(el, e.clientX, e.clientY);
  };
  const onBarMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!barScrub.current) return;
    e.stopPropagation();
    videoRef.current?.trace("seek.input.move", { input: "mobile_bar" });
    barSeekTo(e.currentTarget as HTMLElement, e.clientX, e.clientY);
  };
  const onBarUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!barScrub.current) return;
    barScrub.current = false;
    e.stopPropagation();
    const pct = barPctAt(e.currentTarget as HTMLElement, e.clientX, e.clientY) ?? barPct;
    setBarPct(null);
    if (activeFs) showFsUi(true);
    if (pct != null && duration > 0) {
      const target = Math.max(0, Math.min(duration - 0.15, pct * duration));
      setErr("");
      setEndedOverlay(false);
      progressBus.update({ time: target });
      videoRef.current?.trace("seek.input.up", { input: "mobile_bar", target });
      videoRef.current?.seek(target, "mobile_bar");
    }
  };
  const onBarCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!barScrub.current) return;
    barScrub.current = false;
    e.stopPropagation();
    setBarPct(null);
  };

  const togglePip = async () => {
    try {
      const v = videoRef.current?.el();
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (v && document.pictureInPictureEnabled) await v.requestPictureInPicture();
      else toast("当前环境不支持画中画", "info");
    } catch { toast("画中画开启失败", "info"); }
  };

  const interactionError = (e: unknown) => toast((e as Error).message || "操作失败，请重试", "info");

  const onLike = () => {
    if (!curId) return;
    void changeInteraction("likes", curId, { ep: curEp, post: kind === "post" }).then((on) => {
      if (on === null) return;
      if (on) setHeartBurst((n) => n + 1);
      toast(on ? "已加入喜欢" : "已取消喜欢", on ? "heart" : "info");
    }).catch(interactionError);
  };

  const onFav = () => {
    if (!curId) return;
    void changeInteraction("favs", curId, { post: kind === "post" }).then((on) => {
      if (on !== null) toast(on ? "已收藏" : "已取消收藏", on ? "star" : "info");
    }).catch(interactionError);
  };

  const onFollow = () => {
    const uid = meta.authorId;
    if (uid <= 0) return;
    void changeInteraction("follows", uid, { author: { name: meta.author, avatar: detail?.author?.avatar } }).then((on) => {
      if (on !== null) toast(on ? `已关注 ${detail?.author?.name || meta.author}` : "已取消关注", on ? "ok" : "info");
    }).catch(interactionError);
  };

  const keyStateRef = useRef({ go, goPrevEp, goNextEp, toggleFull, onLike, onFav, panel, muted, rate });
  keyStateRef.current = { go, goPrevEp, goNextEp, toggleFull, onLike, onFav, panel, muted, rate };

  /* 键盘（用 ref 读最新回调，避免反复重绑） */
  useEffect(() => {
    if (!active || controlsLocked) return undefined;
    const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape" || keyStateRef.current.panel) return;
      const curTime = videoRef.current?.el()?.currentTime ?? progressBus.get().time;
      switch (e.key) {
        case "ArrowDown": e.preventDefault(); keyStateRef.current.go(1); break;
        case "ArrowUp": e.preventDefault(); keyStateRef.current.go(-1); break;
        case " ": {
          e.preventDefault();
          const wasPaused = videoRef.current?.el()?.paused;
          videoRef.current?.toggle();
          if (isDesktop) osdBus.show(wasPaused ? "继续播放" : "已暂停");
          break;
        }
        case "ArrowLeft":
          e.preventDefault();
          setEndedOverlay(false);
          videoRef.current?.seek(Math.max(0, curTime - 5), "keyboard_shortcut");
          if (isDesktop) osdBus.show("快退 5 秒");
          break;
        case "ArrowRight":
          e.preventDefault();
          setEndedOverlay(false);
          videoRef.current?.seek(curTime + 5, "keyboard_shortcut");
          if (isDesktop) osdBus.show("快进 5 秒");
          break;
        case "[": {
          e.preventDefault();
          const idx = RATES.indexOf(keyStateRef.current.rate);
          const next = RATES[Math.max(0, (idx === -1 ? 2 : idx) - 1)];
          setRate(next);
          videoRef.current?.rate(next);
          if (isDesktop) osdBus.show(`倍速 ${next}x`);
          break;
        }
        case "]": {
          e.preventDefault();
          const idx = RATES.indexOf(keyStateRef.current.rate);
          const next = RATES[Math.min(RATES.length - 1, (idx === -1 ? 2 : idx) + 1)];
          setRate(next);
          videoRef.current?.rate(next);
          if (isDesktop) osdBus.show(`倍速 ${next}x`);
          break;
        }
        case "f": case "F": keyStateRef.current.toggleFull(); break;
        case "t": case "T": setTheater((v) => !v); break;
        case "m": case "M": {
          const nextMuted = !keyStateRef.current.muted;
          setMuted(nextMuted);
          if (isDesktop) osdBus.show(nextMuted ? "已静音" : "已开启声音");
          break;
        }
        case "l": case "L": keyStateRef.current.onLike(); break;
        case "s": case "S": keyStateRef.current.onFav(); break;
        case "c": case "C": setPanel("comments"); break;
        case "e": case "E": setPanel("episodes"); break;
        case "n": case "N": e.preventDefault(); if (!keyStateRef.current.goNextEp()) keyStateRef.current.go(1); break;
        case "p": case "P": e.preventDefault(); if (!keyStateRef.current.goPrevEp()) keyStateRef.current.go(-1); break;
        default: break;
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [active, controlsLocked, setTheater, setMuted, setRate, isDesktop, osdBus, progressBus]);

  const pickEp = (ep: number) => {
    if (ep !== curEp) saveLiveProgress(false, true);
    setResumePrompt(null);
    setEndedOverlay(false);
    setEpMap((m) => ({ ...m, [curId]: ep }));
    if (kind === "video" && curId) addHistory(curId, ep, 0, 0);
    setPanel(null);
    setFsEpOpen(false);
  };

  const liked = isLiked(curId, kind === "post");
  const favorited = isFav(curId, kind === "post");
  const likeCount = useMemo(() => {
    const serverLiked = !!detail?.interaction?.liked;
    const delta = (liked ? 1 : 0) - (serverLiked ? 1 : 0);
    return Math.max(0, meta.like + delta);
  }, [meta.like, liked, detail?.interaction?.liked]);

  if (!videoIds.length) {
    return <div className="absolute inset-0 bg-black flex items-center justify-center"><div className="w-9 h-9 spinner" /></div>;
  }

  const effectiveFit: "contain" | "cover" = isDesktop
    ? "contain"
    : isLandscapeVideo
      ? (activeFs || vpLandscape ? fsFit : portraitFit)
      : (vpLandscape ? "contain" : "cover");

  const fsTop = rotated
    ? "14px"
    : vpLandscape
      ? "max(env(safe-area-inset-top, 0px), 14px)"
      : "calc(var(--sat, 0px) + 8px)";
  const fsBottom = rotated
    ? "14px"
    : vpLandscape
      ? "max(env(safe-area-inset-bottom, 0px), 12px)"
      : "calc(var(--sab, 0px) + 10px)";
  const fsBarBottom = rotated
    ? "50px"
    : vpLandscape
      ? "calc(max(env(safe-area-inset-bottom, 0px), 12px) + 38px)"
      : "calc(var(--sab, 0px) + 52px)";
  // rotate(90deg) 后，舞台左边对应手机顶部，右边对应底部。
  const fsLeft = rotated
    ? `calc(var(${isIos ? "--sat" : "--sab"}, 16px) + 12px)`
    : vpLandscape
      ? "max(env(safe-area-inset-left, 0px), 16px)"
      : "16px";
  const fsRight = rotated
    ? `calc(var(${isIos ? "--sab" : "--sat"}, 12px) + 12px)`
    : vpLandscape
      ? "max(env(safe-area-inset-right, 0px), 16px)"
      : "16px";

  const fe = err ? friendlyError(err) : null;
  const renderErrorOverlay = () => fe && (
    <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none px-5">
      <div className="pointer-events-auto rounded-xl p-5 max-w-[300px] w-full flex flex-col items-center gap-3 text-[13px] hg-ink-2"
        style={{ background: "rgba(18,18,22,.84)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.14), 0 12px 32px rgba(0,0,0,.45)" }}>
        <span className="font-semibold hg-ink text-center leading-snug">{fe.summary}</span>
        {fe.detail && <span className="select-text text-[10.5px] hg-ink-4 text-center break-all">{fe.detail}</span>}
        <div className="flex items-center gap-2.5 mt-0.5">
          <button type="button" className="px-4 py-1.5 rounded-full hg-chip-strong hg-link text-[12.5px] font-semibold pressable"
            onClick={reloadPlaySource}>
            重新加载
          </button>
          <button type="button" className="px-4 py-1.5 rounded-full hg-chip text-[12.5px] font-semibold hg-ink-2 pressable"
            onClick={() => setLinePickerOpen(true)}>
            切换线路
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div
      className={`hg-player-ui absolute inset-0 overflow-hidden bg-black player-root ${controlsLocked ? "is-locked" : ""} ${isDesktop ? "player-surface" : ""} ${theater ? "is-theater" : ""} ${panel ? "has-panel" : ""} ${isDesktop && idle ? "is-idle" : ""}`}
      onPointerMove={() => { if (isDesktop) wake(); }}>
      <div className="absolute inset-0" inert={controlsLocked}>
      {/* 氛围背景（双层交叉淡入 + 160px 低清图，全屏及移动端隐藏） */}
      {!activeFs && isDesktop && <AmbientBackdrop src={meta.cover} />}

      <div ref={boxRef} onScroll={onScroll}
        className={`absolute inset-y-0 left-0 no-bar ${activeFs ? "overflow-hidden" : "overflow-y-scroll snap-y snap-mandatory overscroll-y-contain"}`}
        style={{ right: isDesktop && panel ? 372 : 0, transition: "right .3s cubic-bezier(.2,0,0,1)" }}>
        {videoIds.map((vid, i) => {
          const isActive = i === safeIndex;
          const isNear = Math.abs(i - safeIndex) <= 1;
          const mountVideo = isActive && !!playUrl && (!isMobile || active);
          return (
            <section
              key={vid}
              style={!isActive && activeFs ? { display: "none" } : undefined}
              className={`relative w-full h-full snap-start snap-always ${activeFs && isActive ? "" : "overflow-hidden"}`}>
              {!isNear ? null : (
                <>
              {mountVideo ? (
                <div className={rotated ? "fs-landscape" : (!isDesktop && activeFs ? "fs-immersive" : "absolute inset-0")}>
                  <div
                    ref={setStageEl}
                    className={`absolute inset-0 overflow-hidden select-none ${isDesktop && scrubbing ? "cursor-ew-resize" : ""}`}
                    style={{ touchAction: activeFs || zoomBadgeScale !== null ? "none" : "pan-y" }}
                    onPointerDown={onDown}
                    onPointerMove={onMove}
                    onPointerUp={(e) => onUp(e, false)}
                    onPointerCancel={(e) => onUp(e, true)}
                    onLostPointerCapture={(e) => { if (e.pointerType === "mouse" && gesture.current && gesture.current.mode !== "idle") onUp(e, true); }}>
                    <VideoSurface
                      ref={videoRef}
                      src={playUrl}
                      poster={activeFs ? undefined : posterUrl}
                      autoPlay
                      active={active}
                      diagnosticContext={{ active, view: mode, kind, video_id: curId, episode: curEp }}
                      muted={muted}
                      volume={volume}
                      rate={effRate}
                      fit={effectiveFit}
                      onClick={() => {
                        if (!isDesktop || Date.now() < suppressClickUntilRef.current) return;
                        const now = Date.now();
                        if (now - lastDesktopClickRef.current < 230) {
                          window.clearTimeout(desktopClickTimerRef.current);
                          desktopClickTimerRef.current = undefined;
                          lastDesktopClickRef.current = 0;
                          toggleFull();
                        } else {
                          lastDesktopClickRef.current = now;
                          window.clearTimeout(desktopClickTimerRef.current);
                          desktopClickTimerRef.current = window.setTimeout(() => {
                            desktopClickTimerRef.current = undefined;
                            cancelKeepPlaying();
                            videoRef.current?.toggle();
                          }, 210);
                        }
                      }}
                      onTime={onTimeTick}
                      onDuration={onDurationTick}
                      onBuffered={(ratio) => progressBus.update({ buffered: ratio })}
                      onSize={(w, h) => { setVsize({ w, h }); if (curId) recordVideoOrientation(curId, w, h); }}
                      onCanPlay={(isPaused) => { setWaiting(false); setPaused(isPaused); }}
                      onPlaying={() => {
                        cancelKeepPlaying();
                        setPaused(false); setWaiting(false); setErr(""); setEndedOverlay(false);
                        window.clearTimeout(nextVideoPrefetchTimerRef.current);
                        if (kind === "video" && mode === "home") {
                          const nextVid = videoIds[safeIndex + 1];
                          if (nextVid) {
                            nextVideoPrefetchTimerRef.current = window.setTimeout(() => {
                              if (activeRef.current) prefetchPlay(nextVid, epMap[nextVid] || 1);
                            }, 2000);
                          }
                        }
                      }}
                      onPause={() => { if (activeRef.current) saveLiveProgress(); setPaused(true); }}
                      onWaiting={() => setWaiting(true)}
                      onEnded={() => {
                        if (nextEp) goNextEp("即将播放 ");
                        else { setPaused(true); setEndedOverlay(true); }
                      }}
                      onError={(m) => setErr(m)}
                    />
                  </div>

                  {/* 双击点赞飘浮红心 */}
                  {tapHearts.map((h) => (
                    <span
                      key={h.id}
                      aria-hidden="true"
                      className="pointer-events-none absolute z-30 text-neon a-heart-float"
                      style={{ left: h.x, top: h.y, "--rot": `${h.rot.toFixed(1)}deg` } as React.CSSProperties}>
                      <IHeartF size={74} className="drop-shadow-[0_6px_18px_rgba(255,55,95,.55)]" />
                    </span>
                  ))}

                  {/* 横拖定位浮层（移动端 & 桌面端通用） */}
                  <ScrubOverlay bus={scrubBus} duration={duration} />
                  {(isDesktop || activeFs) && <PlayerOsd bus={osdBus} />}

                  {/* 剧终引导 / 暂停 / 缓冲 / 报错恢复 */}
                  {endedOverlay && !err && (
                    <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none px-4">
                      <div className="pointer-events-auto rounded-2xl p-4 flex flex-col items-center gap-3 min-w-[210px] max-w-[300px]"
                        style={{ background: "rgba(18,18,22,.84)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.14), 0 12px 32px rgba(0,0,0,.45)" }}>
                        <span className="text-[13.5px] font-bold hg-ink">本剧已播完</span>
                        <div className="flex flex-wrap items-center justify-center gap-2">
                          <button type="button"
                            onClick={() => {
                              setEndedOverlay(false);
                              videoRef.current?.seek(0, "replay");
                              videoRef.current?.play();
                            }}
                            className="px-3.5 h-8 rounded-full bg-primary text-on-primary text-[12px] font-semibold flex items-center gap-1.5 pressable">
                            <IReplay size={13} />重播本集
                          </button>
                          {episodes.length > 1 && curEp !== episodes[0].ep_num && (
                            <button type="button"
                              onClick={() => pickEp(episodes[0].ep_num)}
                              className="px-3.5 h-8 rounded-full hg-chip-strong text-[12px] font-semibold hg-ink pressable">
                              从第 {episodes[0].ep_num} 集看
                            </button>
                          )}
                          {safeIndex < videoIds.length - 1 && (
                            <button type="button"
                              onClick={() => { setEndedOverlay(false); go(1); }}
                              className="px-3.5 h-8 rounded-full hg-chip-strong text-[12px] font-semibold hg-ink pressable">
                              下一部
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                  {paused && !err && !endedOverlay && (
                    <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
                      <button
                        type="button"
                        aria-label="播放"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => { cancelKeepPlaying(); videoRef.current?.play(); }}
                        className="pointer-events-auto w-[66px] h-[66px] rounded-full flex items-center justify-center pressable"
                        style={{ background: "rgba(18,18,22,.72)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.16), 0 8px 24px rgba(0,0,0,.38)" }}>
                        <IPlayF size={28} className="hg-ink ml-0.5" />
                      </button>
                    </div>
                  )}
                  {waiting && !err && !paused && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none"><div className="w-9 h-9 spinner" /></div>
                  )}
                  {err && renderErrorOverlay()}

                  {/* 移动端：倍速状态 / 锁定提示 */}
                  {!isDesktop && (holdSpeed || speedLock || rate !== 1) && (
                    <button
                      onClick={() => {
                        if (speedLock) { setSpeedLock(false); toast("已解除倍速锁定", "info"); }
                        else if (rate !== 1 && !holdSpeed) setRate(1);
                      }}
                      className={`absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 px-3.5 h-8 rounded-full text-[12px] font-bold elev-2 pressable whitespace-nowrap ${speedLock ? "bg-primary text-on-primary" : "hg-chip hg-gold"}`}
                      style={{ top: activeFs ? fsTop : (vpLandscape ? "max(env(safe-area-inset-top, 0px), 14px)" : "calc(var(--sat, 0px) + 54px)") }}>
                      <IBoltF size={13} />
                      {effRate}x {speedLock ? "已锁定 · 点按解除" : holdSpeed ? "倍速中 · 松开恢复" : "倍速"}
                    </button>
                  )}
                  {!isDesktop && holdSpeed && (
                    <div
                      className={`absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-4 h-10 rounded-xl elev-2 transition-all duration-200 whitespace-nowrap ${lockArmed ? "bg-primary text-on-primary scale-110" : "hg-chip-strong hg-ink-2"}`}
                      style={{ top: "38%" }}>
                      <ILockF size={16} />
                      <span className="text-[12.5px] font-bold">{lockArmed ? "松开锁定 2.0x" : "上滑到此锁定倍速"}</span>
                    </div>
                  )}

                  {/* 移动端：沉浸全屏控制栏（单击视频显隐，3.2秒自动淡出，绝不遮挡字幕） */}
                  {!isDesktop && activeFs && !controlsLocked && (() => {
                    const fsShow = fsUiVisible || paused || barPct !== null || fsEpOpen;
                    return (
                    <>
                      <div className={`absolute z-40 flex items-center gap-2 transition-opacity duration-200 ${fsShow ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
                        style={{ top: fsTop, right: fsRight }}>
                        {isLandscapeVideo && (
                          <button onClick={() => { showFsUi(true); setFsFit((f) => (f === "contain" ? "cover" : "contain")); }}
                            className="hg-chip-strong px-2.5 h-9 rounded-full text-[11.5px] font-semibold flex items-center gap-1 pressable elev-1 whitespace-nowrap">
                            {fsFit === "contain" ? "铺满画面" : "完整显示"}
                          </button>
                        )}
                        <button onClick={() => { showFsUi(true); setMuted((m) => !m); }} aria-label={muted ? "取消静音" : "静音"}
                          className="hg-chip-strong player-round-hit w-9 h-9 rounded-full flex items-center justify-center pressable elev-1">
                          {muted ? <IVolMute size={17} /> : <IVol size={17} />}
                        </button>
                        <button onClick={lockControls} aria-label="锁定播放控制" title="锁定播放控制" aria-pressed={false}
                          className="hg-chip-strong player-round-hit w-9 h-9 rounded-full flex items-center justify-center pressable elev-1">
                          <ILockF size={17} />
                        </button>
                        <button onClick={exitFs} aria-label="退出全屏"
                          className="hg-chip-strong player-round-hit w-9 h-9 rounded-full flex items-center justify-center pressable elev-1">
                          <ICompress size={18} />
                        </button>
                      </div>
                      {zoomBadgeScale !== null && (
                        <button
                          onClick={resetZoom}
                          className={`hg-chip-strong absolute z-40 px-3 h-8 rounded-full text-[11.5px] font-semibold flex items-center gap-1 pressable elev-1 whitespace-nowrap transition-opacity duration-200 ${fsShow ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
                          style={{ top: fsTop, left: fsLeft }}>
                          还原画面 ({zoomBadgeScale.toFixed(1)}x)
                        </button>
                      )}
                      <div className={`absolute z-30 transition-opacity duration-200 ${fsShow ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
                        style={{ left: fsLeft, right: fsRight, bottom: fsBarBottom, height: 26 }}>
                        <MobileProgressLine bus={progressBus} scrubBus={scrubBus} duration={duration} barPct={barPct}
                          className="relative h-full" onDown={onBarDown} onMove={onBarMove} onUp={onBarUp} onCancel={onBarCancel} />
                      </div>
                      <div className={`absolute z-40 flex items-center gap-2.5 transition-opacity duration-200 ${fsShow ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
                        style={{ left: fsLeft, right: fsRight, bottom: fsBottom }}>
                        <button onClick={() => { showFsUi(true); cancelKeepPlaying(); videoRef.current?.toggle(); }}
                          aria-label={paused ? "播放" : "暂停"}
                          className="hg-chip shrink-0 player-round-hit player-transport-hit w-9 h-9 rounded-full flex items-center justify-center pressable">
                          {paused ? <IPlayF size={18} /> : <IPauseF size={17} />}
                        </button>
                        {prevEp && (
                          <button onClick={() => { showFsUi(true); goPrevEp(); }}
                            aria-label={`上一集（第 ${prevEp.ep_num} 集）`}
                            className="hg-chip shrink-0 player-round-hit player-transport-hit w-9 h-9 rounded-full flex items-center justify-center pressable">
                            <INext size={15} strokeWidth={1.8} className="rotate-180" />
                          </button>
                        )}
                        {nextEp && (
                          <button onClick={() => { showFsUi(true); goNextEp(); }}
                            aria-label={`下一集（第 ${nextEp.ep_num} 集）`}
                            className="hg-chip shrink-0 player-round-hit player-transport-hit w-9 h-9 rounded-full flex items-center justify-center pressable">
                            <INext size={16} strokeWidth={1.8} />
                          </button>
                        )}
                        <MobileFsClock bus={progressBus} />
                        <div className="flex-1" />
                        {episodes.length > 1 && (
                          <button
                            onClick={() => setFsEpOpen(true)}
                            className="shrink-0 flex items-center gap-1 px-2.5 h-8 rounded-full hg-chip hg-ink-2 text-[11.5px] font-semibold pressable whitespace-nowrap">
                            <IList size={13} />选集 {curEp}/{episodes.length}
                          </button>
                        )}
                        <button
                          onClick={() => {
                            showFsUi(true);
                            if (speedLock) { setSpeedLock(false); return; }
                            const seq = [1, 1.25, 1.5, 2];
                            const idx = seq.indexOf(rate);
                            setRate(seq[(idx + 1) % seq.length]);
                          }}
                          className={`shrink-0 flex items-center gap-1 px-2.5 h-8 rounded-full text-[12px] font-bold pressable whitespace-nowrap ${effRate !== 1 ? "bg-primary text-on-primary" : "hg-chip hg-ink-2"}`}>
                          <IBoltF size={12} />{effRate}x
                        </button>
                        <span className="shrink-0 text-[11.5px] hg-ink-4 tabular-nums">{fmtTime(duration)}</span>
                      </div>

                      {fsEpOpen && (
                        <div className="absolute inset-0 z-50" onPointerDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}>
                          <div className="absolute inset-0 bg-black/55" onClick={() => setFsEpOpen(false)} />
                          {(rotated || vpLandscape) ? (
                            <div className={`absolute inset-y-0 right-0 w-[280px] max-w-[75%] ${isAndroid ? "bg-s1" : "bg-s1/95 backdrop-blur-md"} border-l border-sep shadow-2xl a-panel-in`}>
                              <EpisodesPanel videoId={curId} episodes={episodes} current={curEp} onPick={pickEp} onClose={() => setFsEpOpen(false)} />
                            </div>
                          ) : (
                            <div className={`absolute inset-x-0 bottom-0 h-[58%] rounded-t-2xl ${isAndroid ? "bg-s1" : "bg-s1/95 backdrop-blur-md"} border-t border-sep shadow-2xl a-sheet`}
                              style={{ paddingBottom: "var(--sab, 0px)" }}>
                              <EpisodesPanel videoId={curId} episodes={episodes} current={curEp} onPick={pickEp} onClose={() => setFsEpOpen(false)} />
                            </div>
                          )}
                        </div>
                      )}
                    </>
                    );
                  })()}
                </div>
              ) : (
                <div className="absolute inset-0">
                  <Img src={posts[vid]?.cover || details[vid]?.cover || initialCovers?.[vid] || (isActive ? detail?.cover : "") || ""} eager />
                  <div className="absolute inset-0" style={{ background: "rgba(0,0,0,.25)" }} />
                </div>
              )}

              {/* 拉取播放地址期间显示加载转圈 */}
              {isActive && !playUrl && !err && (kind === "video" || !post) && (
                <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                  <div className="w-9 h-9 spinner" />
                </div>
              )}

              {/* 取不到播放地址时播放器不会创建，错误提示要放在播放器外面，否则只会停在封面 */}
              {isActive && !playUrl && !!err && renderErrorOverlay()}

              {/* 图文帖：没有视频就给个正文入口 */}
              {isActive && kind === "post" && !!post && !post.video_url && (
                <div className="absolute inset-0 z-10 flex items-center justify-center">
                  <button type="button" onClick={() => setPanel("article")}
                    className="flex items-center gap-2 h-11 px-5 rounded-full text-[13.5px] font-semibold pressable elev-3"
                    style={{ background: "rgba(255,255,255,.94)", color: "#0b0e15" }}>
                    <IFileText size={17} />查看图文详情
                  </button>
                </div>
              )}

              {/* 渐变压暗，保证文字可读 */}
              {isActive && !activeFs && (
                <div className="absolute inset-0 pointer-events-none"
                  style={{ background: "linear-gradient(0deg, rgba(8,11,15,.86) 0, rgba(11,14,20,.18) 26%, transparent 48%)" }} />
              )}

              {/* 竖屏下双指缩放后：顶部左侧显示复位胶囊（不再遮挡画面中部） */}
              {isActive && !activeFs && !isDesktop && zoomBadgeScale !== null && (
                <button
                  type="button"
                  onClick={resetZoom}
                  className="hg-chip-strong absolute left-3 z-30 px-3 h-7 rounded-full text-[11.5px] font-semibold flex items-center gap-1 pressable elev-1 whitespace-nowrap"
                  style={{ top: mode === "context" ? "calc(var(--sat, 0px) + 52px)" : "calc(var(--sat, 0px) + 46px)" }}>
                  还原画面 ({zoomBadgeScale.toFixed(1)}x)
                </button>
              )}

              {/* 顶部 */}
              {isActive && !activeFs && mode === "context" ? (
                isDesktop ? (
                  <div className="desktop-context-header">
                    <button onClick={onBack} aria-label="返回"><IBack size={17} /></button>
                    <span>{title}</span>
                    <small>{safeIndex + 1} / {videoIds.length}</small>
                  </div>
                ) : (
                  <div className="absolute inset-x-0 z-20 flex items-center gap-2 px-2.5" style={{ top: "calc(var(--sat, 0px) + 6px)", paddingRight: 148 }}>
                    <button onClick={onBack} aria-label="返回" className="shrink-0 hg-chip player-round-hit w-9 h-9 rounded-full flex items-center justify-center pressable elev-1"><IBack size={20} /></button>
                    <span className="text-[14.5px] font-semibold hg-ink hg-ov-shadow truncate">{title}</span>
                    <span className="ml-auto shrink-0 whitespace-nowrap px-2 py-0.5 rounded-full hg-chip text-[11px] font-semibold" style={{ color: "rgba(255,255,255,.9)" }}>{safeIndex + 1} / {videoIds.length}</span>
                  </div>
                )
              ) : isActive && !activeFs && mode === "home" ? (
                isDesktop ? (
                  <button type="button" onClick={() => bumpHomeRefresh()}
                    className="absolute z-20 flex items-center gap-1.5 px-3 h-8 rounded-full hg-chip text-[12px] font-semibold hg-ink-2 pressable"
                    style={{ top: 18, left: 20, opacity: idle ? 0 : 1, pointerEvents: idle ? "none" : "auto", transition: "opacity .28s ease" }}>
                    <IRefresh size={13} />换一批
                  </button>
                ) : (
                  <button type="button" onClick={() => bumpHomeRefresh()}
                    className="absolute left-3 z-20 flex items-center gap-1.5 px-3 h-8 rounded-full hg-chip text-[11.5px] font-semibold hg-ink pressable elev-1"
                    style={{ top: "calc(var(--sat, 0px) + 6px)" }}>
                    <IRefresh size={13} />换一批
                  </button>
                )
              ) : null}

              {/* 跨页断点续播胶囊 */}
              {isActive && !activeFs && !controlsLocked && !err && !panel && resumePrompt?.id === curId && (
                <div
                  className="absolute z-30 flex items-center rounded-full hg-chip-strong elev-2 a-rise"
                  style={isDesktop
                    ? { left: 26, bottom: 176 }
                    : { left: 16, bottom: `calc(var(--sab, 0px) + ${bottomInset + 110}px)` }}>
                  <button type="button" onClick={applyResumePrompt}
                    className="pl-3 pr-2 h-7 flex items-center gap-1.5 text-[11.5px] font-semibold hg-ink pressable whitespace-nowrap">
                    <IPlayF size={10} className="hg-link" />
                    <span>上次看到 第 {resumePrompt.ep} 集{resumePrompt.t > 3 ? ` · ${fmtTime(resumePrompt.t)}` : ""}</span>
                    <span className="hg-link">续播</span>
                  </button>
                  <button type="button" aria-label="忽略续播提示" onClick={() => setResumePrompt(null)}
                    className="pr-2.5 pl-1 h-7 flex items-center hg-ink-4 hover:hg-ink pressable">
                    <IClose size={11} />
                  </button>
                </div>
              )}

              {/* 默认静音显性引导胶囊（出现 4.5 秒后自动收起或手动关闭，避免长期遮挡画面） */}
              {isActive && !activeFs && !controlsLocked && !err && muted && muteHintVisible && !!playUrl && !paused && !panel && !holdSpeed && !speedLock && (isDesktop || rate === 1) && (
                <div
                  className="absolute right-3 z-30 flex items-center rounded-full hg-chip-strong elev-1 a-fade"
                  style={isDesktop
                    ? { top: mode === "context" ? 56 : 18, right: 22 }
                    : { top: "calc(var(--sat, 0px) + 50px)", right: 12 }}>
                  <button type="button"
                    onClick={() => setMuted(false)}
                    className="pl-3 pr-1.5 h-7 flex items-center gap-1.5 text-[11.5px] font-semibold hg-ink pressable whitespace-nowrap">
                    <IVolMute size={13} />静音中 · 点按开启声音
                  </button>
                  <button type="button" aria-label="关闭静音提示" onClick={() => setMuteHintVisible(false)}
                    className="pr-2.5 pl-1 h-7 flex items-center hg-ink-4 hover:hg-ink pressable">
                    <IClose size={11} />
                  </button>
                </div>
              )}

              {/* 右侧操作栏（移动端）：点赞 / 收藏 / 评论 / 全屏 / 分享
                  颜色写死不跟主题走：浅色主题下这些字必须仍是白色 */}
              {isActive && !activeFs && !isDesktop && (
                <div className="absolute right-3 z-20 flex flex-col items-center gap-3.5"
                  style={{ bottom: `calc(var(--sab, 0px) + ${bottomInset + 96}px)` }}>
                  {kind === "video" && (
                    <button onClick={onLike} className="flex flex-col items-center gap-1 pressable" aria-pressed={liked} aria-label="喜欢">
                      <span key={heartBurst} className={heartBurst ? "a-pop" : ""}>
                        {liked ? <IHeartF size={28} className="text-neon" /> : <IHeart size={28} className="hg-ink hg-ov-shadow" />}
                      </span>
                      <span className="text-[10.5px] hg-ink-2 hg-ov-shadow tabular-nums">{likeCount > 0 ? fmt(likeCount) : "喜欢"}</span>
                    </button>
                  )}
                  <button onClick={onFav} className="flex flex-col items-center gap-1 pressable" aria-pressed={favorited} aria-label="收藏">
                    {favorited ? <IStarF size={27} className="hg-gold" /> : <IStar size={27} className="hg-ink hg-ov-shadow" />}
                    <span className="text-[10.5px] hg-ink-2 hg-ov-shadow">收藏</span>
                  </button>
                  <button onClick={() => setPanel("comments")} className="flex flex-col items-center gap-1 pressable" aria-label="评论">
                    <ICommentF size={26} className="hg-ink hg-ov-shadow" />
                    <span className="text-[10.5px] hg-ink-2 hg-ov-shadow">评论</span>
                  </button>
                  <button onClick={enterFs} className="flex flex-col items-center gap-1 pressable" aria-label="全屏">
                    <IExpand size={26} className="hg-ink hg-ov-shadow" />
                    <span className="text-[10.5px] hg-ink-2 hg-ov-shadow">全屏</span>
                  </button>
                  <button onClick={shareLink} className="flex flex-col items-center gap-1 pressable" aria-label="分享">
                    <ILink size={25} className="hg-ink hg-ov-shadow" />
                    <span className="text-[10.5px] hg-ink-2 hg-ov-shadow">分享</span>
                  </button>
                </div>
              )}

              {/* 右侧操作栏（桌面） */}
              {isActive && !activeFs && isDesktop && (
              <div className="absolute z-20 flex flex-col items-center desktop-social">
                <div className="desktop-browse-inline">
                  <button onClick={() => go(-1)} disabled={safeIndex === 0} aria-label="上一个" title="上一个 ↑">
                    <IChevronUp size={19} strokeWidth={1.8} />
                  </button>
                  <button onClick={() => go(1)} disabled={safeIndex >= videoIds.length - 1} aria-label="下一个" title="下一个 ↓">
                    <IChevronDown size={19} strokeWidth={1.8} />
                  </button>
                  <small>{String(safeIndex + 1).padStart(2, "0")} / {String(videoIds.length).padStart(2, "0")}</small>
                </div>

                {kind === "video" && (
                  <>
                    <button onClick={onLike} className="flex flex-col items-center gap-1 pressable" aria-pressed={liked}>
                      <span key={heartBurst} className={heartBurst ? "a-pop" : ""}>
                        {liked ? <IHeartF size={30} className="text-neon" /> : <IHeart size={30} className="text-white tsh" />}
                      </span>
                      <span className="text-[10.5px] text-white/90 tabular-nums">{fmt(likeCount)}</span>
                    </button>

                    <button onClick={() => setPanel("comments")} className="flex flex-col items-center gap-1 pressable">
                      <ICommentF size={27} className="text-white tsh" />
                      <span className="text-[10.5px] text-white/90 tabular-nums">{fmt(meta.comment)}</span>
                    </button>

                    <button onClick={onFav} className="flex flex-col items-center gap-1 pressable" aria-pressed={favorited}>
                      {favorited ? <IStarF size={27} className="hg-gold" /> : <IStar size={27} className="hg-ink hg-ov-shadow" />}
                      <span className="text-[10.5px] text-white/90 tabular-nums">{fmt(meta.collect)}</span>
                    </button>

                    <button onClick={() => setPanel("episodes")} className="flex flex-col items-center gap-1 pressable">
                      <IList size={26} className="text-white tsh" />
                      <span className="text-[10.5px] text-white/90">选集</span>
                    </button>
                  </>
                )}

                <button onClick={shareLink} className="flex flex-col items-center gap-1 pressable">
                  <ILink size={25} className="text-white tsh" />
                  <span className="text-[10.5px] text-white/90">分享</span>
                </button>
              </div>
              )}

              {/* 桌面：左下信息 */}
              {isActive && !activeFs && isDesktop && (
              <div className="desktop-video-meta">
                <div className="flex items-center gap-2">
                  {meta.author && meta.author !== "黄果短剧" && meta.author !== "黄果吃瓜" ? (
                    <button
                      type="button"
                      onClick={() => searchFor(meta.author)}
                      title={`搜索 ${meta.author} 的更多作品`}
                      className="text-[15px] font-bold text-white tsh truncate hover:underline pressable">
                      @{meta.author}
                    </button>
                  ) : (
                    <span className="text-[15px] font-bold text-white tsh truncate">@{meta.author}</span>
                  )}
                  {episodes.length > 0 && (
                    <span className="shrink-0 px-1.5 py-px rounded-md text-[10px] font-bold text-white"
                      style={{ background: "rgba(255,255,255,.16)" }}>
                      第 {curEp}/{episodes.length} 集
                    </span>
                  )}
                  {!!orientationBadge && (
                    <span className="shrink-0 px-1.5 py-px rounded-md text-[10px] font-semibold text-white/85"
                      style={{ background: "rgba(255,255,255,.12)" }}>
                      {orientationBadge}
                    </span>
                  )}
                  {!!meta.score && (
                    <span className="shrink-0 text-[11px] font-bold hg-gold hg-ov-shadow">{meta.score.toFixed(1)} 分</span>
                  )}
                </div>

                <p className="select-text mt-1 text-[13.5px] leading-snug hg-ink-2 hg-ov-shadow clamp-2">{meta.title}</p>

                {/* 描述（单行，点开展开） */}
                <button onClick={() => setDescOpen((v) => !v)} className="mt-1 text-left w-full pressable group">
                  <p className={`select-text text-[11.5px] leading-relaxed hg-ink-4 ${descOpen ? "" : "clamp-1"}`}>
                    {meta.desc || "暂无简介"}
                  </p>
                  <span className="text-[10.5px] hg-link font-semibold">{descOpen ? "收起" : "展开简介"}</span>
                </button>
              </div>
              )}

              {/* 移动端：标题 + 选集/详情/横屏操作胶囊 + 进度线 */}
              {isActive && !activeFs && !isDesktop && (
                <div className="absolute inset-x-0 z-20 pointer-events-none" style={{ bottom: `calc(var(--sab, 0px) + ${bottomInset}px)` }}>
                  <div className="absolute inset-x-0 bottom-0 h-[210px] pointer-events-none"
                    style={{ background: "linear-gradient(0deg, rgba(0,0,0,.84) 0%, rgba(0,0,0,.44) 48%, transparent 100%)" }} />
                  <p className="select-text relative pl-4 pr-[72px] pb-2 text-[14px] font-semibold leading-snug hg-ink hg-ov-shadow clamp-2 pointer-events-none">{meta.title}</p>
                  <div className="relative pt-1 pb-2">
                    <div className="pl-4 pr-[72px] flex flex-wrap items-center gap-1.5">
                      {kind === "video" && (
                        <button type="button" onClick={() => setPanel("episodes")}
                          className="pointer-events-auto hg-chip-strong px-2.5 h-7 rounded-full flex items-center gap-1 text-[11.5px] font-semibold hg-ink pressable">
                          <IList size={12} />
                          {episodes.length > 0 ? `选集 · ${curEp}/${episodes.length}` : `第 ${curEp} 集`}
                        </button>
                      )}
                      {nextEp && (
                        <button type="button" onClick={() => goNextEp()}
                          aria-label={`下一集（第 ${nextEp.ep_num} 集）`}
                          className="pointer-events-auto hg-chip px-2.5 h-7 rounded-full flex items-center gap-1 text-[11.5px] font-semibold hg-ink pressable">
                          <INext size={11} strokeWidth={1.8} />下一集
                        </button>
                      )}
                      <button type="button" onClick={() => setPanel("detail")}
                        className="pointer-events-auto hg-chip px-2.5 h-7 rounded-full flex items-center gap-0.5 text-[11.5px] font-medium hg-ink-2 pressable">
                        {kind === "post" ? "查看详情" : "详情"}<IChevR size={11} />
                      </button>
                      {isLandscapeVideo && (
                        <>
                          <button type="button" onClick={enterFs}
                            className="pointer-events-auto hg-chip-strong px-2.5 h-7 rounded-full flex items-center gap-1 text-[11.5px] font-semibold hg-ink pressable">
                            <IRotate size={12} />横屏看
                          </button>
                          <button type="button" onClick={togglePortraitFit}
                            className="pointer-events-auto hg-chip px-2.5 h-7 rounded-full text-[11.5px] font-medium hg-ink-2 pressable">
                            {portraitFit === "contain" ? "铺满" : "完整"}
                          </button>
                        </>
                      )}
                    </div>
                    {isActive && (
                      <MobileProgressLine bus={progressBus} scrubBus={scrubBus} duration={duration} barPct={barPct} paused={paused}
                        className="mx-4 mt-2.5 relative pointer-events-auto" onDown={onBarDown} onMove={onBarMove} onUp={onBarUp} onCancel={onBarCancel} />
                    )}
                  </div>
                </div>
              )}
                </>
              )}
            </section>
          );
        })}
      </div>

      {/* 桌面控制条 */}
      {isDesktop && (
        <PlayerControls
          paused={paused} progressBus={progressBus} scrubBus={scrubBus} duration={duration} rate={rate}
          muted={muted} volume={volume} orientationLabel={orientationLabel} theater={theater} fullscreen={fullscreen}
          visible={active && !idle}
          seekEnabled={active && !controlsLocked}
          seekKey={playKey}
          prevDisabled={!prevEp && safeIndex === 0}
          prevTitle={prevEp ? `上一集（第 ${prevEp.ep_num} 集 P）` : "上一个 ↑"}
          nextDisabled={!nextEp && safeIndex >= videoIds.length - 1}
          nextTitle={nextEp ? `下一集（第 ${nextEp.ep_num} 集 N）` : "下一部 ↓"}
          onToggle={() => videoRef.current?.toggle()}
          onSeek={(t, source) => { setEndedOverlay(false); videoRef.current?.seek(t, source); progressBus.update({ time: t }); }}
          onSeekInteraction={(phase, input, target, pointerTarget) => videoRef.current?.trace(`seek.input.${phase}`, { input, target, pointer_target: pointerTarget })}
          onRate={(r) => { setRate(r); videoRef.current?.rate(r); osdBus.show(`倍速 ${r}x`); }}
          onMute={() => { const next = !muted; setMuted(next); osdBus.show(next ? "已静音" : "已开启声音"); }}
          onVolume={(v) => { setVolume(v); osdBus.show(v === 0 ? "已静音" : `音量 ${Math.round(v * 100)}%`); }}
          onPip={togglePip}
          onLock={lockControls}
          onTheater={() => setTheater((v) => !v)}
          onFullscreen={toggleFull}
          onPrev={() => { if (!goPrevEp()) go(-1); }}
          onNext={() => { if (!goNextEp()) go(1); }}
        />
      )}

      {/* 选集 / 评论：桌面停靠在右侧（画面让位），移动端底部弹层 */}
      {isDesktop ? (
        <div className={`desktop-dock-panel ${panel ? "is-open" : ""}`}>
          <div className="desktop-dock-inner">
            <Suspense fallback={<div className="flex-1 flex items-center justify-center"><div className="w-7 h-7 spinner" /></div>}>
              {panel === "episodes" ? (
                <EpisodesPanel videoId={curId} episodes={episodes} current={curEp} onPick={pickEp} onClose={() => setPanel(null)} />
              ) : panel === "comments" ? (
                <CommentsPanel videoId={curId} ep={curEp} total={meta.comment} kind={kind} onClose={() => setPanel(null)} />
              ) : null}
            </Suspense>
          </div>
        </div>
      ) : (
        <>
          {/* 评论：移动端底部弹层（右侧操作栏「评论」入口） */}
          <Sheet open={panel === "comments"} onClose={() => setPanel(null)}>
            <div className="flex flex-col" style={{ height: "min(72dvh, calc(100dvh - var(--sat, 0px) - 24px))" }}>
              <Suspense fallback={<div className="flex-1 flex items-center justify-center"><div className="w-7 h-7 spinner" /></div>}>
                <CommentsPanel videoId={curId} ep={curEp} total={meta.comment} kind={kind} onClose={() => setPanel(null)} />
              </Suspense>
            </div>
          </Sheet>

          {/* 吃瓜图文正文 */}
          <Sheet open={panel === "article"} onClose={() => setPanel(null)}>
            <div className="flex flex-col" style={{ height: "min(78dvh, calc(100dvh - var(--sat, 0px) - 24px))" }}>
              <Suspense fallback={<div className="flex-1 flex items-center justify-center"><div className="w-7 h-7 spinner" /></div>}>
                <ArticlePanel title={meta.title} html={articleHtml} cover={meta.cover} hot={post?.hot} onClose={() => setPanel(null)} />
              </Suspense>
            </div>
          </Sheet>

          <Sheet open={panel === "detail" || panel === "episodes"} onClose={() => setPanel(null)}>
            <div className="flex flex-col" style={{ height: "min(72dvh, calc(100dvh - var(--sat, 0px) - 24px))" }}>
              {/* 双栏抽屉：详情 / 选集 */}
              <div className="shrink-0 flex items-center gap-2 px-4 pb-2">
                <SegmentedControl
                  className="flex-1"
                  ariaLabel="剧集信息切换"
                  value={panel === "episodes" ? "episodes" : "detail"}
                  onChange={(k) => setPanel(k)}
                  options={[{ value: "detail", label: "详情" }, { value: "episodes", label: "选集" }]}
                />
                <button onClick={() => setPanel(null)} aria-label="关闭"
                  className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
                  <IClose size={14} />
                </button>
              </div>

              <div className="flex-1 min-h-0">
                {panel === "episodes" ? (
                  <Suspense fallback={<div className="h-full flex items-center justify-center"><div className="w-7 h-7 spinner" /></div>}>
                    <EpisodesPanel bare videoId={curId} episodes={episodes} current={curEp} onPick={pickEp} onClose={() => setPanel(null)} />
                  </Suspense>
                ) : (
                  <div className="h-full scroll-y px-4 pb-5">
                    {/* 封面 / 标题 / 评分 / 数据 */}
                    <div className="flex gap-3">
                      <div className="relative w-[84px] shrink-0 rounded-(--r-sm) overflow-hidden bg-s3" style={{ aspectRatio: "3 / 4" }}>
                        <Img src={meta.cover} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13.5px] font-bold text-on leading-snug clamp-2">{meta.title}</div>
                        <div className="flex items-center flex-wrap gap-2 mt-1.5">
                          {!!meta.score && <span className="text-[12px] font-bold text-amber">{meta.score.toFixed(1)} 分</span>}
                          {episodes.length > 0 && <span className="text-[11px] text-mut">共 {episodes.length} 集</span>}
                          {!!orientationBadge && <span className="px-1.5 py-0.5 rounded bg-s3 text-[10px] font-medium text-mut">{orientationBadge}</span>}
                        </div>
                        <div className="flex gap-3 mt-2 text-[10.5px] text-mut">
                          <span>点赞 {fmt(meta.like)}</span>
                          <span>收藏 {fmt(meta.collect)}</span>
                          <span>评论 {fmt(meta.comment)}</span>
                        </div>
                      </div>
                    </div>

                    {/* 作者 + 关注 */}
                    <div className="mt-4 flex items-center gap-2.5 rounded-(--r-md) bg-s2 p-2.5">
                      <button
                        type="button"
                        disabled={!meta.author || meta.author === "黄果短剧" || meta.author === "黄果吃瓜"}
                        onClick={() => { setPanel(null); searchFor(meta.author); }}
                        className="flex items-center gap-2.5 flex-1 min-w-0 text-left pressable disabled:cursor-default">
                        <Avatar size={34} name={meta.author} hue={220} />
                        <div className="flex-1 min-w-0">
                          <div className="text-[12.5px] font-semibold text-on truncate">{meta.author}</div>
                          <div className="text-[10px] text-mut">
                            {meta.author && meta.author !== "黄果短剧" && meta.author !== "黄果吃瓜" ? "作者 · 点按搜作品" : "作者"}
                          </div>
                        </div>
                      </button>
                      {meta.authorId > 0 && (
                        <button onClick={onFollow}
                          className={`h-7 px-3 rounded-full text-[11px] font-semibold pressable ${follows.includes(meta.authorId) ? "bg-s3 text-mut" : "bg-primary text-on-primary"}`}>
                          {follows.includes(meta.authorId) ? "已关注" : "+ 关注"}
                        </button>
                      )}
                    </div>

                    {/* 题材标签（点按直达搜索） */}
                    {!!meta.tags.length && (
                      <div className="mt-4">
                        <div className="text-[11px] font-semibold text-dim mb-1.5">题材标签</div>
                        <div className="flex flex-wrap gap-1.5">
                          {meta.tags.slice(0, 12).map((tag) => (
                            <button
                              key={tag}
                              type="button"
                              onClick={() => { setPanel(null); searchFor(tag); }}
                              className="px-2.5 h-7 rounded-(--r-ctl) bg-s3 text-[11.5px] text-on/85 hover:text-primary pressable">
                              #{tag}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* 简介 */}
                    <div className="mt-4">
                      <div className="text-[11px] font-semibold text-dim mb-1.5">简介</div>
                      <p className="text-[11.5px] leading-relaxed text-mut whitespace-pre-wrap">{meta.desc || "暂无简介"}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Sheet>
        </>
      )}
      </div>
      {!isDesktop && !activeFs && !controlsLocked && active && !panel && (
        <div className="absolute right-3 z-40 flex items-center gap-2" style={{ top: "calc(var(--sat, 0px) + 6px)" }}>
          <button onClick={() => setMuted(m => !m)} aria-label={muted ? "取消静音" : "静音"}
            className="hg-chip player-round-hit w-9 h-9 rounded-full flex items-center justify-center pressable elev-1">
            {muted ? <IVolMute size={17} /> : <IVol size={17} />}
          </button>
          <button onClick={lockControls} aria-label="锁定播放控制" title="锁定播放控制" aria-pressed={false}
            className="hg-chip player-round-hit w-9 h-9 rounded-full flex items-center justify-center pressable elev-1"><ILockF size={17} /></button>
          <button onClick={() => setTab("search")} aria-label="搜索"
            className="hg-chip player-round-hit w-9 h-9 rounded-full flex items-center justify-center pressable elev-1"><ISearch size={18} /></button>
        </div>
      )}
      {controlsLocked && <PlaybackLock active={active} onUnlock={() => { setControlsLocked(false); wake(); }} />}
    </div>
  );
}
