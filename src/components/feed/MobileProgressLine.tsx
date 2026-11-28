import { memo, useEffect, useRef } from "react";
import { fmtTime } from "../../api";
import { useProgressClock, useScrub, type PlaybackProgressBus, type ScrubBus } from "../../playbackProgress";

/* 移动端极细进度线：播放中由 DOM Ref 直驱 scaleX（0 React 提交），隐藏时自动退订 */
export const MobileProgressLine = memo(function MobileProgressLine({
  bus, scrubBus, duration, barPct, paused = false, visible = true, className, onDown, onMove, onUp, onCancel,
}: {
  bus: PlaybackProgressBus;
  scrubBus: ScrubBus;
  duration: number;
  barPct: number | null;
  paused?: boolean;
  visible?: boolean;
  className: string;
  onDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const scrub = useScrub(scrubBus);
  const pausedSec = useProgressClock(bus, visible && paused && barPct === null && scrub === null);
  const bufferRef = useRef<HTMLDivElement>(null);
  const playedRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  const activeDrag = barPct !== null || scrub !== null;
  const activeDragRef = useRef(activeDrag);
  activeDragRef.current = activeDrag;

  const initialSnap = bus.get();
  const rawProgress = barPct ?? (scrub !== null ? scrub.pct / 100 : (duration > 0 ? initialSnap.time / duration : 0));
  const progress = Math.max(0, Math.min(1, rawProgress));
  const buffered = Math.max(0, Math.min(1, initialSnap.buffered));

  useEffect(() => {
    if (!visible) return undefined;
    const syncDom = () => {
      const snap = bus.get();
      const b = Math.max(0, Math.min(1, snap.buffered));
      if (bufferRef.current) bufferRef.current.style.transform = `scaleX(${b})`;
      if (activeDragRef.current) return;
      const p = duration > 0 ? Math.max(0, Math.min(1, snap.time / duration)) : 0;
      if (playedRef.current) playedRef.current.style.transform = `scaleX(${p})`;
      if (thumbRef.current) thumbRef.current.style.left = `${p * 100}%`;
    };
    syncDom();
    return bus.subscribe(syncDom);
  }, [bus, duration, visible]);

  useEffect(() => {
    if (!activeDrag) return;
    if (playedRef.current) playedRef.current.style.transform = `scaleX(${progress})`;
    if (thumbRef.current) thumbRef.current.style.left = `${progress * 100}%`;
  }, [activeDrag, progress]);

  return (
    <div
      className={className}
      style={{ height: 24, touchAction: "none" }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancel}>
      <div
        className={`absolute inset-x-0 top-1/2 -translate-y-1/2 rounded-full overflow-hidden transition-[height] duration-150 ${activeDrag ? "h-[5px]" : "h-[2px]"}`}
        style={{ background: "rgba(255,255,255,.20)" }}>
        <div
          ref={bufferRef}
          className="absolute inset-0 w-full rounded-full"
          style={{ background: "rgba(255,255,255,.24)", transformOrigin: "left center", transform: `scaleX(${buffered})` }}
        />
        <div
          ref={playedRef}
          className="absolute inset-0 w-full rounded-full"
          style={{
            background: "#ff9f0a",
            transformOrigin: "left center",
            transform: `scaleX(${progress})`,
            boxShadow: activeDrag ? "0 0 10px rgba(255,159,10,.6)" : undefined,
          }}
        />
      </div>
      {activeDrag && (
        <div
          ref={thumbRef}
          className="pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white"
          style={{ left: `${progress * 100}%`, boxShadow: "0 0 10px rgba(255,159,10,.7), 0 1px 4px rgba(0,0,0,.5)" }}
        />
      )}
      {barPct !== null ? (
        <div className="absolute left-1/2 -translate-x-1/2 -top-8 px-2.5 py-1 rounded-full hg-chip-strong text-[12px] font-bold tabular-nums whitespace-nowrap">
          {fmtTime(barPct * (duration || 0))} / {fmtTime(duration)}
        </div>
      ) : paused && scrub === null && duration > 0 ? (
        <div className="pointer-events-none absolute right-0 -top-6 px-2 py-0.5 rounded-full hg-chip text-[10.5px] font-semibold hg-ink-2 tabular-nums whitespace-nowrap a-fade">
          {fmtTime(pausedSec)} / {fmtTime(duration)}
        </div>
      ) : null}
    </div>
  );
});

/* 全屏模式时钟文本：仅可见时按整秒刷新，隐藏时 0 React 提交 */
export const MobileFsClock = memo(function MobileFsClock({
  bus, visible = true,
}: {
  bus: PlaybackProgressBus; visible?: boolean;
}) {
  const sec = useProgressClock(bus, visible);
  return <span className="shrink-0 text-[11.5px] font-semibold hg-ink-2 tabular-nums">{fmtTime(sec)}</span>;
});
