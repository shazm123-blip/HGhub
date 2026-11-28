import { useCallback, useEffect, useRef, useState } from "react";
import { acquirePlaybackLock } from "../back";
import { ILockF } from "../icons";

const BLOCKED_KEYS = new Set([
  " ", "Enter", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "Home", "End", "PageUp", "PageDown", "f", "t", "m", "l", "s", "c", "e",
  "n", "p", "[", "]",
  "1", "2", "3", "4", "/",
]);

/** Shield pointer input and playback shortcuts without pausing the media. */
export default function PlaybackLock({ active, onUnlock }: { active: boolean; onUnlock: () => void }) {
  const [awake, setAwake] = useState(true);
  const [hint, setHint] = useState(true);
  const hideTimerRef = useRef<number | undefined>(undefined);

  const wake = useCallback((showHint = true) => {
    setAwake(true);
    if (showHint) setHint(true);
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      setAwake(false);
      setHint(false);
    }, 2600);
  }, []);

  useEffect(() => {
    wake(true);
    return () => window.clearTimeout(hideTimerRef.current);
  }, [wake]);

  useEffect(() => {
    if (!active) return undefined;
    const releaseLock = acquirePlaybackLock();
    const block = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true'], [data-playback-unlock]")) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (BLOCKED_KEYS.has(key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", block, true);
    return () => {
      releaseLock();
      window.removeEventListener("keydown", block, true);
    };
  }, [active]);

  return (
    <div
      data-playback-lock-shield
      className="absolute inset-0 z-50"
      style={{ touchAction: "none" }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        wake(true);
      }}
      onWheel={(e) => e.stopPropagation()}>
      <button
        type="button"
        data-playback-unlock
        aria-label="解锁播放控制"
        title="解锁播放控制"
        aria-pressed
        onClick={(e) => {
          e.stopPropagation();
          if (!awake) {
            wake(true);
            return;
          }
          onUnlock();
        }}
        className={`playback-unlock absolute right-3 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full flex items-center justify-center transition-opacity duration-200 ${awake ? "opacity-100" : "opacity-15"}`}>
        <ILockF size={19} />
      </button>
      {hint && (
        <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-12 px-3.5 py-1.5 rounded-full hg-chip-strong text-[12px] font-semibold hg-ink whitespace-nowrap a-fade">
          屏幕已锁定 · 点击右侧锁图标解锁
        </div>
      )}
    </div>
  );
}
