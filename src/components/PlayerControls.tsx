import { memo, useEffect, useRef, useState } from "react";
import { fmtTime } from "../api";
import { useSeekInput } from "../useSeekInput";
import { useProgressClock, useScrub, type PlaybackProgressBus, type ScrubBus } from "../playbackProgress";
import { ICheck, ICompress, IExpand, ILockF, INext, IPauseF, IPip, IPlayF, ITheater, IVol, IVolMute } from "../icons";

type Props = {
  paused: boolean;
  time?: number;
  duration: number;
  buffered?: number;
  progressBus?: PlaybackProgressBus;
  scrubBus?: ScrubBus;
  rate: number;
  muted: boolean;
  volume: number;
  orientationLabel?: string;
  theater?: boolean;
  fullscreen?: boolean;
  visible?: boolean;
  seekEnabled?: boolean;
  seekKey?: string;
  prevDisabled?: boolean;
  prevTitle?: string;
  nextDisabled?: boolean;
  nextTitle?: string;
  onToggle: () => void;
  onSeek: (t: number, source?: string) => void;
  onSeekInteraction?: (phase: string, input: string, target: number, pointerTarget?: number) => void;
  onRate: (r: number) => void;
  onMute: () => void;
  onVolume: (v: number) => void;
  onPip: () => void;
  onLock: () => void;
  onTheater?: () => void;
  onFullscreen: () => void;
  onPrev?: () => void;
  onNext?: () => void;
};

const clock = (s: number) => fmtTime(Math.max(0, s || 0)).padStart(5, "0");

/* 独立时钟文本：仅在控制条可见时按整秒刷新，隐藏时 0 React 提交 */
const DesktopTimecode = memo(function DesktopTimecode({
  time, duration, progressBus, scrubBus, visible,
}: {
  time?: number; duration: number; progressBus?: PlaybackProgressBus; scrubBus?: ScrubBus; visible: boolean;
}) {
  const sec = useProgressClock(progressBus, visible);
  const scrubSnap = useScrub(scrubBus);
  const shown = scrubSnap?.target ?? time ?? sec;
  return (
    <span className="player-timecode">
      <span>{clock(shown)}</span>
      <span className="player-time-separator">/</span>
      {clock(duration)}
    </span>
  );
});

/* 独立进度条：播放态由 DOM ref 直接驱动 scaleX 与 thumb，0 React 重渲染；拖动/键盘仍走 useSeekInput 保证精确交互 */
const DesktopSeekBar = memo(function DesktopSeekBar({
  time, duration, buffered, progressBus, scrubBus, visible, seekEnabled, seekKey, onSeek, onSeekInteraction,
}: {
  time?: number;
  duration: number;
  buffered?: number;
  progressBus?: PlaybackProgressBus;
  scrubBus?: ScrubBus;
  visible: boolean;
  seekEnabled: boolean;
  seekKey?: string;
  onSeek: (t: number, source?: string) => void;
  onSeekInteraction?: (phase: string, input: string, target: number, pointerTarget?: number) => void;
}) {
  const [hover, setHover] = useState<{ pct: number; time: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const scrubSnap = useScrub(scrubBus);
  const bufferRef = useRef<HTMLSpanElement>(null);
  const playedRef = useRef<HTMLSpanElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const initialTime = scrubSnap?.target ?? time ?? progressBus?.get().time ?? 0;
  const seek = useSeekInput({
    time: initialTime,
    duration,
    enabled: seekEnabled,
    resetKey: seekKey,
    onInteraction: onSeekInteraction,
    onSeek: (target, input) => onSeek(target, `desktop_${input}`),
  });
  const isInteracting = dragging || !!scrubSnap;
  const isInteractingRef = useRef(isInteracting);
  isInteractingRef.current = isInteracting;

  const pct = duration ? Math.max(0, Math.min(100, (seek.time / duration) * 100)) : 0;
  const bufRatio = Math.max(0, Math.min(1, buffered ?? progressBus?.get().buffered ?? 0));

  useEffect(() => {
    if (!seekEnabled) {
      setHover(null);
      setDragging(false);
    }
  }, [seekEnabled]);

  useEffect(() => {
    if (!progressBus) return undefined;
    const applyDom = () => {
      const snap = progressBus.get();
      const b = Math.max(0, Math.min(1, snap.buffered));
      if (bufferRef.current) bufferRef.current.style.transform = `scaleX(${b})`;
      if (isInteractingRef.current) return;
      const t = snap.time;
      const ratio = duration > 0 ? Math.max(0, Math.min(1, t / duration)) : 0;
      if (playedRef.current) playedRef.current.style.transform = `scaleX(${ratio})`;
      if (thumbRef.current) thumbRef.current.style.left = `${ratio * 100}%`;
      if (inputRef.current && document.activeElement !== inputRef.current) {
        const clamped = duration > 0 ? Math.max(0, Math.min(t, duration)) : 0;
        inputRef.current.value = String(clamped);
      }
    };
    if (!visible) return undefined;
    applyDom();
    return progressBus.subscribe(applyDom);
  }, [progressBus, duration, visible]);

  const updateHover = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!seekEnabled || !duration || duration <= 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width) return;
    const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    setHover({ pct: p, time: p * duration });
  };

  return (
    <div
      className={`desktop-seek ${seekEnabled ? "is-seekable" : ""} ${isInteracting ? "is-dragging" : ""}`}
      onPointerMove={updateHover}
      onPointerDown={(e) => { if (seekEnabled && e.button === 0) setDragging(true); updateHover(e); }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => { setDragging(false); setHover(null); }}
      onPointerLeave={() => { setDragging(false); setHover(null); }}>
      <div className="desktop-seek-track">
        <span ref={bufferRef} className="desktop-seek-buffer" style={{ transform: `scaleX(${bufRatio})` }} />
        <span ref={playedRef} className="desktop-seek-played" style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
      <span ref={thumbRef} className="desktop-seek-thumb" style={{ left: `${pct}%` }} />
      {hover && visible && (
        <span
          className="desktop-seek-tooltip"
          style={{ left: `clamp(24px, ${hover.pct * 100}%, calc(100% - 24px))` }}>
          {clock(hover.time)}
        </span>
      )}
      <input
        ref={inputRef}
        aria-label="播放进度"
        type="range"
        {...seek.inputProps}
        onFocus={() => {
          if (progressBus && inputRef.current && duration > 0) {
            const t = Math.max(0, Math.min(progressBus.get().time, duration));
            inputRef.current.value = String(t);
          }
        }}
      />
    </div>
  );
});

const PlayerControls = memo(function PlayerControls({
  paused, time, duration, buffered, progressBus, scrubBus, rate, muted, volume, orientationLabel, theater = false, fullscreen = false,
  visible = true, seekEnabled = true, seekKey, prevDisabled = false, prevTitle = "上一个", nextDisabled = false, nextTitle = "下一个",
  onToggle, onSeek, onSeekInteraction, onRate, onMute, onVolume, onPip, onLock, onTheater, onFullscreen, onPrev, onNext,
}: Props) {
  const [speedOpen, setSpeedOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!speedOpen) return;
    const outside = (e: PointerEvent) => { if (!boxRef.current?.contains(e.target as Node)) setSpeedOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [speedOpen]);

  return (
    <div ref={boxRef} className={`desktop-controls ${fullscreen ? "is-fullscreen" : ""} ${visible ? "" : "is-hidden"}`}
      onPointerDown={(e) => e.stopPropagation()}>
      <DesktopSeekBar
        time={time}
        duration={duration}
        buffered={buffered}
        progressBus={progressBus}
        scrubBus={scrubBus}
        visible={visible}
        seekEnabled={seekEnabled}
        seekKey={seekKey}
        onSeek={onSeek}
        onSeekInteraction={onSeekInteraction}
      />

      <div className="desktop-control-row">
        <button className="player-control primary-play" aria-label={paused ? "播放" : "暂停"} data-tooltip={paused ? "播放 Space" : "暂停 Space"} onClick={onToggle}>
          {paused ? <IPlayF size={19} /> : <IPauseF size={18} />}
        </button>
        {onPrev && (
          <button className="player-control" aria-label={prevTitle} data-tooltip={prevTitle} disabled={prevDisabled} onClick={onPrev}>
            <INext size={18} strokeWidth={1.7} className="rotate-180" />
          </button>
        )}
        {onNext && (
          <button className="player-control" aria-label={nextTitle} data-tooltip={nextTitle} disabled={nextDisabled} onClick={onNext}>
            <INext size={18} strokeWidth={1.7} />
          </button>
        )}
        <DesktopTimecode time={time} duration={duration} progressBus={progressBus} scrubBus={scrubBus} visible={visible} />
        <div className="player-control-spacer" />
        {!!orientationLabel && <span className="player-resolution">{orientationLabel}</span>}
        <div className="player-speed-slot">
          <button className={`player-control player-speed ${rate !== 1 ? "is-on" : ""}`} aria-label="倍速" aria-expanded={speedOpen}
            data-tooltip="播放速度" onClick={() => setSpeedOpen((v) => !v)}>
            {Number.isInteger(rate) ? rate.toFixed(1) : rate}x
          </button>
          {speedOpen && (
            <div className="player-speed-menu" role="menu">
              <span className="player-menu-title">播放速度</span>
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => (
                <button key={v} role="menuitemradio" aria-checked={rate === v} onClick={() => { onRate(v); setSpeedOpen(false); }}>
                  <span>{v === 1 ? "正常" : `${v}x`}</span>{rate === v && <ICheck size={14} />}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="player-volume">
          <button className="player-control" aria-label={muted ? "开启声音" : "静音"} data-tooltip="静音 M" onClick={onMute}>
            {muted || volume === 0 ? <IVolMute size={20} strokeWidth={1.6} /> : <IVol size={20} strokeWidth={1.6} />}
          </button>
          <div className="player-volume-slider">
            <input aria-label="音量" type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume}
              style={{ "--fill": `${(muted ? 0 : volume) * 100}%` } as React.CSSProperties}
              onChange={(e) => onVolume(Number(e.target.value))} />
          </div>
        </div>
        <button className="player-control" aria-label="画中画" data-tooltip="画中画" onClick={onPip}><IPip size={20} strokeWidth={1.6} /></button>
        <button className="player-control" aria-label="锁定播放控制" aria-pressed={false} data-tooltip="锁定播放控制" onClick={onLock}><ILockF size={18} /></button>
        {!fullscreen && onTheater && (
          <button className={`player-control ${theater ? "is-on" : ""}`} aria-label="影院模式" aria-pressed={theater}
            data-tooltip="影院模式 T" onClick={onTheater}><ITheater size={20} strokeWidth={1.6} /></button>
        )}
        <button className="player-control" aria-label={fullscreen ? "退出全屏" : "全屏"} data-tooltip={fullscreen ? "退出全屏 Esc" : "全屏 F"} onClick={onFullscreen}>
          {fullscreen ? <ICompress size={19} strokeWidth={1.6} /> : <IExpand size={19} strokeWidth={1.6} />}
        </button>
      </div>
    </div>
  );
});

export default PlayerControls;
