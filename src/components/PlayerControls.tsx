import { useEffect, useRef, useState } from "react";
import { fmtTime } from "../api";
import { useSeekInput } from "../useSeekInput";
import { useProgress, useScrub, type PlaybackProgressBus, type ScrubBus } from "../playbackProgress";
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

export default function PlayerControls({
  paused, time, duration, buffered, progressBus, scrubBus, rate, muted, volume, orientationLabel, theater = false, fullscreen = false,
  visible = true, seekEnabled = true, seekKey, prevDisabled = false, prevTitle = "上一个", nextDisabled = false, nextTitle = "下一个",
  onToggle, onSeek, onSeekInteraction, onRate, onMute, onVolume, onPip, onLock, onTheater, onFullscreen, onPrev, onNext,
}: Props) {
  const [speedOpen, setSpeedOpen] = useState(false);
  const [hover, setHover] = useState<{ pct: number; time: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const busSnap = useProgress(progressBus);
  const scrubSnap = useScrub(scrubBus);
  const effectiveTime = scrubSnap?.target ?? time ?? busSnap?.time ?? 0;
  const effectiveBuffered = buffered ?? busSnap?.buffered ?? 0;
  const seek = useSeekInput({ time: effectiveTime, duration, enabled: seekEnabled, resetKey: seekKey, onInteraction: onSeekInteraction,
    onSeek: (target, input) => onSeek(target, `desktop_${input}`) });
  const pct = duration ? Math.max(0, Math.min(100, (seek.time / duration) * 100)) : 0;
  const bufRatio = Math.max(0, Math.min(1, effectiveBuffered));

  useEffect(() => {
    if (!seekEnabled) {
      setHover(null);
      setDragging(false);
    }
  }, [seekEnabled]);

  useEffect(() => {
    if (!speedOpen) return;
    const outside = (e: PointerEvent) => { if (!boxRef.current?.contains(e.target as Node)) setSpeedOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [speedOpen]);

  const updateHover = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!seekEnabled || !duration || duration <= 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width) return;
    const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    setHover({ pct: p, time: p * duration });
  };

  return (
    <div ref={boxRef} className={`desktop-controls ${fullscreen ? "is-fullscreen" : ""} ${visible ? "" : "is-hidden"}`}
      onPointerDown={(e) => e.stopPropagation()}>
      <div
        className={`desktop-seek ${seekEnabled ? "is-seekable" : ""} ${dragging || !!scrubSnap ? "is-dragging" : ""}`}
        onPointerMove={updateHover}
        onPointerDown={(e) => { if (seekEnabled && e.button === 0) setDragging(true); updateHover(e); }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => { setDragging(false); setHover(null); }}
        onPointerLeave={() => { setDragging(false); setHover(null); }}>
        <div className="desktop-seek-track">
          <span className="desktop-seek-buffer" style={{ transform: `scaleX(${bufRatio})` }} />
          <span className="desktop-seek-played" style={{ transform: `scaleX(${pct / 100})` }} />
        </div>
        <span className="desktop-seek-thumb" style={{ left: `${pct}%` }} />
        {hover && visible && (
          <span
            className="desktop-seek-tooltip"
            style={{ left: `clamp(24px, ${hover.pct * 100}%, calc(100% - 24px))` }}>
            {clock(hover.time)}
          </span>
        )}
        <input aria-label="播放进度" type="range" {...seek.inputProps} />
      </div>

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
        <span className="player-timecode"><span>{clock(seek.time)}</span><span className="player-time-separator">/</span>{clock(duration)}</span>
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
}
