import React, { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import { fmtTime, isLocalMedia, isMobile, mediaUrl, platform } from "../api";
import { pushBackHandler } from "../back";
import { mediaResource, observeHls, usePlayerDiagnostics } from "../playbackDiagnostics";
import { usePlaybackActivity } from "../usePlaybackActivity";
import { useSeekInput } from "../useSeekInput";
import { computeScrubTarget, formatScrubDelta } from "../scrubGesture";
import PlaybackLock from "./PlaybackLock";
import { ICompress, IExpand, ILockF, IPauseF, IPlayF, IVol, IVolMute } from "../icons";

type Props = {
  src: string;              // 原始媒体地址
  poster?: string;          // 已处理好的封面地址（本地协议）
  autoPlay?: boolean;
  active?: boolean;
  muted?: boolean;
  volume?: number;
  loop?: boolean;
  onEnded?: () => void;
  onPlaying?: () => void;
  onTogglePlay?: (playing: boolean) => void;
  onToggleMute?: () => void;
  controls?: boolean;
  className?: string;
  diagnosticContext?: Record<string, unknown>;
};

export default function Player({
  src, poster, autoPlay, active = true, muted = false, volume = 1, loop = false, onEnded, onPlaying,
  onTogglePlay, onToggleMute, controls = true, className = "", diagnosticContext = {},
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const recoverCountRef = useRef(0);
  const hideControlsTimerRef = useRef<number | null>(null);
  const lastTimeRef = useRef(-1);
  const resource = useMemo(() => mediaResource(src), [src]);
  const { trace, requestSeek } = usePlayerDiagnostics(videoRef, hlsRef, { view: "post_detail", ...diagnosticContext, active, resource });
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const activity = usePlaybackActivity(videoRef, hlsRef, {
    active,
    autoPlay: !!autoPlay,
    src,
    trace,
    onPlayRejected: () => {
      setWaiting(false);
      setPlaying(false);
    },
  });
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [full, setFull] = useState(false);
  const [cssFull, setCssFull] = useState(false);
  const effectiveFull = full || cssFull;
  const [rate, setRate] = useState(1);
  const [errMsg, setErrMsg] = useState<string>("");
  const [controlsLocked, setControlsLocked] = useState(false);
  const [controlsShown, setControlsShown] = useState(false);

  const showControlsTemporarily = () => {
    setControlsShown(true);
    if (hideControlsTimerRef.current) window.clearTimeout(hideControlsTimerRef.current);
    hideControlsTimerRef.current = window.setTimeout(() => setControlsShown(false), 3000);
  };

  const [scrub, setScrub] = useState<{ pct: number; target: number; delta: number } | null>(null);
  const scrubTargetRef = useRef<number | null>(null);
  const suppressClickUntilRef = useRef(0);
  const dragRef = useRef<{
    id: number; x: number; y: number; base: number; width: number;
    playing: boolean; scrubbing: boolean; startDx: number;
  } | null>(null);

  useEffect(() => () => {
    if (hideControlsTimerRef.current) window.clearTimeout(hideControlsTimerRef.current);
  }, []);

  useEffect(() => {
    if (!active || controlsLocked) {
      dragRef.current = null;
      scrubTargetRef.current = null;
      setScrub(null);
    }
  }, [active, controlsLocked]);

  const applySeek = (target: number, source: string) => {
    const video = videoRef.current;
    if (!video || !activity.isActive()) return;
    requestSeek(target, source);
    setWaiting(true);
    if (hlsRef.current && !hlsRef.current.loadingEnabled) {
      try { hlsRef.current.startLoad(target); } catch { /* ignore */ }
    }
    video.currentTime = target;
    trace("seek.assigned", { target, source });
    lastTimeRef.current = target;
    setTime(target);
  };

  const seek = useSeekInput({ time: scrub ? scrub.target : time, duration, enabled: active && !controlsLocked, resetKey: src,
    onInteraction: (phase, input, target, pointerTarget) => trace(`seek.input.${phase}`, { input, target, pointer_target: pointerTarget }),
    onSeek: (target, input) => applySeek(target, `legacy_${input}`),
  });

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    const url = isLocalMedia(src) ? src : mediaUrl(src);
    const useHls = !url.includes("/seg?u=");
    const isIos = platform === "ios";
    recoverCountRef.current = 0;
    lastTimeRef.current = -1;
    setErrMsg("");
    trace("source.load", { engine: useHls && Hls.isSupported() ? "hls.js" : "native", auto_play: autoPlay });

    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    video.muted = muted;
    video.volume = volume;
    video.playbackRate = rate;

    if (useHls && Hls.isSupported()) {
      const hls = new Hls({
        // 禁用从插播/内容引导 JSON 派生直连 URL 的可选功能。
        interstitialsController: undefined,
        contentSteeringController: undefined,
        enableInterstitialPlayback: false,
        enableWorker: !isIos,
        // Keep the same macOS seek workaround as the shared player.
        preferManagedMediaSource: false,
        autoStartLoad: false,
        lowLatencyMode: false,
        maxBufferLength: isIos ? 12 : 30,
        maxMaxBufferLength: isIos ? 20 : 60,
        maxBufferSize: isIos ? 15 * 1000 * 1000 : 60 * 1000 * 1000,
        backBufferLength: isIos ? 6 : 30,
        startFragPrefetch: false,
        maxBufferHole: 0.5,
        nudgeOffset: 0.25,
        nudgeMaxRetry: 6,
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 4,
        fragLoadingTimeOut: 25000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 400,
      });
      hlsRef.current = hls;
      observeHls(hls, trace);
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (activity.isActive()) hls.startLoad();
        if (autoPlay) activity.play("manifest_autoplay", true);
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        recoverCountRef.current = 0;
        setErrMsg("");
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (!activity.isActive()) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recoverCountRef.current < 4) {
          recoverCountRef.current += 1;
          try { hls.startLoad(video.currentTime || -1); } catch { /* ignore */ }
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoverCountRef.current < 4) {
          recoverCountRef.current += 1;
          try {
            hls.recoverMediaError();
            if (!video.paused) activity.play("hls_media_recover", true);
          } catch { /* ignore */ }
          return;
        }
        const detail = `${data.type}/${data.details}/${data.response?.code ?? ""}/${String(data.reason ?? "").slice(0, 80)}`;
        (window as unknown as { __hlsErr?: string }).__hlsErr = detail;
        setErrMsg(detail);
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR || data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          try { hls.stopLoad(); } catch { /* ignore */ }
        } else {
          hls.destroy();
          hlsRef.current = null;
        }
      });
    } else {
      // Safari / 部分 WebView 原生支持 HLS 或直连 MP4
      video.src = url;
      if (autoPlay) activity.play("native_autoplay", true);
    }

    return () => {
      trace("source.cleanup");
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      video.pause();
      if (video.hasAttribute("src") || video.querySelector("source")) {
        video.removeAttribute("src");
        video.querySelectorAll("source").forEach((s) => s.remove());
        try { video.load(); } catch { /* ignore */ }
      }
    };
  }, [src, autoPlay]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = muted;
    video.volume = volume;
  }, [muted, volume]);

  useEffect(() => {
    const onFs = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  useEffect(() => {
    if (!cssFull) return undefined;
    return pushBackHandler(() => { setCssFull(false); return true; });
  }, [cssFull]);

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    showControlsTemporarily();
    trace("toggle.request");
    if (video.paused) activity.play("toggle");
    else activity.pause("toggle");
  };

  const onVideoClick = () => {
    if (Date.now() < suppressClickUntilRef.current) return;
    toggle();
  };

  const onStageDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerType !== "mouse" || !active || controlsLocked || !e.isPrimary || e.button !== 0 || dragRef.current) return;
    const width = e.currentTarget.clientWidth || wrapRef.current?.clientWidth || 390;
    dragRef.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      base: videoRef.current?.currentTime ?? time,
      width,
      playing: videoRef.current?.paused === false,
      scrubbing: false,
      startDx: 0,
    };
  };

  const onStageMove = (e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerType !== "mouse") return;
    const g = dragRef.current;
    if (!g || g.id !== e.pointerId || !e.isPrimary) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    const total = duration || videoRef.current?.duration || 0;
    if (!g.scrubbing) {
      if (Number.isFinite(total) && total > 0 && Math.abs(dx) > 10 && Math.abs(dx) >= Math.abs(dy) * 1.1) {
        g.scrubbing = true;
        g.startDx = dx;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        showControlsTemporarily();
        const res = computeScrubTarget(g.base, 0, g.width, total);
        scrubTargetRef.current = res.target;
        setScrub(res);
      } else if (Math.abs(dy) > 16) {
        dragRef.current = null;
      }
      return;
    }
    if (!Number.isFinite(total) || total <= 0) return;
    showControlsTemporarily();
    const res = computeScrubTarget(g.base, dx - g.startDx, g.width, total);
    scrubTargetRef.current = res.target;
    setScrub(res);
  };

  const onStageUp = (e: React.PointerEvent<HTMLElement>, cancelled = false) => {
    if (e.pointerType !== "mouse") return;
    const g = dragRef.current;
    if (!g || g.id !== e.pointerId) return;
    dragRef.current = null;
    if (!g.scrubbing) return;
    const target = scrubTargetRef.current;
    scrubTargetRef.current = null;
    setScrub(null);
    suppressClickUntilRef.current = Date.now() + 250;
    if (!cancelled && target != null) {
      applySeek(target, "drag_gesture");
    }
    if (!cancelled && g.playing && active && !controlsLocked) {
      activity.play("drag_seek_resume", true);
    }
  };

  const touchCtxRef = useRef({ active, controlsLocked, time, duration, showControlsTemporarily, applySeek, activity });
  touchCtxRef.current = { active, controlsLocked, time, duration, showControlsTemporarily, applySeek, activity };

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return undefined;
    let tg: {
      x: number; y: number; t: number; base: number; width: number;
      playing: boolean; mode: "idle" | "scrub" | "vertical"; startDx: number;
    } | null = null;

    const onTouchStart = (e: TouchEvent) => {
      const ctx = touchCtxRef.current;
      if (ctx.controlsLocked || !ctx.active || e.touches.length !== 1 || tg) return;
      const t0 = e.touches[0];
      const width = el.clientWidth || wrapRef.current?.clientWidth || 390;
      tg = {
        x: t0.clientX,
        y: t0.clientY,
        t: Date.now(),
        base: el.currentTime || ctx.time,
        width,
        playing: el.paused === false,
        mode: "idle",
        startDx: 0,
      };
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!tg || e.touches.length !== 1) return;
      const ctx = touchCtxRef.current;
      if (ctx.controlsLocked || !ctx.active) { tg = null; return; }
      const t0 = e.touches[0];
      const dx = t0.clientX - tg.x;
      const dy = t0.clientY - tg.y;
      if (tg.mode === "vertical") return;
      const total = ctx.duration || el.duration || 0;
      if (tg.mode === "idle") {
        if (Number.isFinite(total) && total > 0 && Math.abs(dx) > 8 && Math.abs(dx) >= Math.abs(dy) * 1.1) {
          e.preventDefault();
          tg.mode = "scrub";
          tg.startDx = dx;
          ctx.showControlsTemporarily();
          const res = computeScrubTarget(tg.base, 0, tg.width, total);
          scrubTargetRef.current = res.target;
          setScrub(res);
        } else if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx) * 1.1) {
          tg.mode = "vertical";
        }
        return;
      }
      if (tg.mode === "scrub") {
        e.preventDefault();
        if (!Number.isFinite(total) || total <= 0) return;
        ctx.showControlsTemporarily();
        const res = computeScrubTarget(tg.base, dx - tg.startDx, tg.width, total);
        scrubTargetRef.current = res.target;
        setScrub(res);
      }
    };

    const onTouchEndOrCancel = (e: TouchEvent) => {
      if (e.touches.length > 0 || !tg) return;
      const g = tg;
      tg = null;
      if (g.mode !== "scrub") return;
      const ctx = touchCtxRef.current;
      const cancelled = e.type === "touchcancel";
      const target = scrubTargetRef.current;
      scrubTargetRef.current = null;
      setScrub(null);
      suppressClickUntilRef.current = Date.now() + 350;
      if (!cancelled && target != null) {
        ctx.applySeek(target, "drag_gesture");
      }
      if (!cancelled && g.playing && ctx.active && !ctx.controlsLocked) {
        ctx.activity.play("drag_seek_resume", true);
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEndOrCancel);
    el.addEventListener("touchcancel", onTouchEndOrCancel);
    return () => {
      tg = null;
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEndOrCancel);
      el.removeEventListener("touchcancel", onTouchEndOrCancel);
    };
  }, []);

  const cycleRate = () => {
    const video = videoRef.current;
    if (!video) return;
    const next = rate === 1 ? 1.25 : rate === 1.25 ? 1.5 : rate === 1.5 ? 2 : 1;
    video.playbackRate = next;
    setRate(next);
  };

  const toggleFull = () => {
    const el = wrapRef.current;
    if (!el) return;
    if (isMobile || typeof el.requestFullscreen !== "function") {
      setCssFull((v) => !v);
      return;
    }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen().catch(() => { setCssFull((v) => !v); });
  };

  const shownTime = scrub ? scrub.target : seek.time;
  const pct = duration > 0 ? (shownTime / duration) * 100 : 0;

  return (
    <div ref={wrapRef} className={cssFull ? "fixed inset-0 z-50 bg-black overflow-hidden group" : `relative bg-black overflow-hidden group ${className}`}>
      <div className="absolute inset-0" inert={controlsLocked}>
      <video
        ref={videoRef}
        poster={poster}
        playsInline
        webkit-playsinline="true"
        preload="auto"
        muted={muted}
        loop={loop}
        style={{ touchAction: cssFull ? "none" : "pan-y" }}
        className={`w-full h-full object-contain bg-black select-none ${!isMobile && scrub ? "cursor-ew-resize" : ""}`}
        onPointerDown={onStageDown}
        onPointerMove={onStageMove}
        onPointerUp={(e) => onStageUp(e, false)}
        onPointerCancel={(e) => onStageUp(e, true)}
        onLostPointerCapture={(e) => { if (dragRef.current?.scrubbing) onStageUp(e, true); }}
        onClick={onVideoClick}
        onCanPlay={() => setWaiting(false)}
        onPlay={() => { if (activity.isActive()) { setPlaying(true); onTogglePlay?.(true); } }}
        onPause={() => { setPlaying(false); onTogglePlay?.(false); }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => { if (activity.isActive()) { setWaiting(false); setErrMsg(""); onPlaying?.(); } }}
        onSeeked={() => setWaiting(false)}
        onTimeUpdate={(e) => {
          const t = (e.target as HTMLVideoElement).currentTime;
          if (lastTimeRef.current < 0 || Math.abs(t - lastTimeRef.current) >= 0.25) {
            lastTimeRef.current = t;
            setTime(t);
          }
        }}
        onLoadedMetadata={(e) => {
          const v = e.target as HTMLVideoElement;
          v.volume = volume;
          v.muted = muted;
          v.playbackRate = rate;
          setDuration(v.duration || 0);
        }}
        onEnded={() => { if (activity.isActive()) onEnded?.(); }}
      />

      {scrub && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center pointer-events-none">
          <div className="px-4 py-2.5 rounded-2xl backdrop-blur-md flex flex-col items-center" style={{ background: "rgba(0,0,0,.62)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.12)" }}>
            <div className="flex items-baseline gap-1.5 tabular-nums">
              <span className="text-[22px] font-bold text-white">{fmtTime(scrub.target)}</span>
              <span className="text-[12px] text-white/65">/ {fmtTime(duration)}</span>
            </div>
            <span className="mt-0.5 text-[11.5px] font-semibold text-white/85 tabular-nums">{formatScrubDelta(scrub.delta)}</span>
          </div>
        </div>
      )}

      {errMsg && (
        <div
          className="absolute left-2 z-30 max-w-[80%] rounded bg-black/70 px-2 py-1 text-[10px] leading-tight text-red-300 break-all"
          style={{ top: cssFull ? "calc(var(--sat, 0px) + 8px)" : 8 }}>
          {errMsg}
        </div>
      )}

      {waiting && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-9 h-9 spinner" />
        </div>
      )}

      {!playing && !waiting && !scrub && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={toggle}
            aria-label="播放"
            className="pointer-events-auto w-16 h-16 rounded-full bg-black/45 backdrop-blur-sm flex items-center justify-center elev-2 pressable">
            <IPlayF size={26} className="text-white ml-0.5" />
          </button>
        </div>
      )}

      {controls && (
        <div
          onPointerDown={showControlsTemporarily}
          style={cssFull ? {
            paddingBottom: "calc(var(--sab, 0px) + 8px)",
            paddingLeft: "max(var(--sal, 0px), 12px)",
            paddingRight: "max(var(--sar, 0px), 12px)",
          } : undefined}
          className={`absolute inset-x-0 bottom-0 px-3 pb-2 pt-8 bg-gradient-to-t from-black/80 to-transparent transition-opacity ${!playing || controlsShown ? "opacity-100" : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto"}`}>
          <input aria-label="播放进度" type="range" {...seek.inputProps}
            className="hg-range w-full" style={{ ...seek.inputProps.style, "--fill": `${pct}%` } as React.CSSProperties} />
          <div className="flex items-center gap-3 mt-1 text-white">
            <button onClick={toggle} aria-label={playing ? "暂停" : "播放"} className="pressable">
              {playing ? <IPauseF size={16} /> : <IPlayF size={16} />}
            </button>
            <button onClick={() => onToggleMute?.()} aria-label={muted ? "取消静音" : "静音"} className="pressable">
              {muted ? <IVolMute size={16} /> : <IVol size={16} />}
            </button>
            <span className="text-[11px] tabular-nums text-white/85">{fmtTime(seek.time)} / {fmtTime(duration)}</span>
            <div className="flex-1" />
            <button onClick={() => setControlsLocked(true)} aria-label="锁定播放控制" title="锁定播放控制" aria-pressed={false} className="pressable">
              <ILockF size={16} />
            </button>
            <button onClick={cycleRate} className="text-[11px] font-bold text-white/85 pressable tabular-nums">{rate}x</button>
            <button onClick={toggleFull} aria-label={effectiveFull ? "退出全屏" : "全屏"} className="pressable">
              {effectiveFull ? <ICompress size={16} /> : <IExpand size={16} />}
            </button>
          </div>
        </div>
      )}
      </div>
      {controlsLocked && <PlaybackLock active={active} onUnlock={() => setControlsLocked(false)} />}
    </div>
  );
}
