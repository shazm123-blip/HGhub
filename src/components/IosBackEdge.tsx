import { useEffect, useRef, type PointerEvent } from "react";
import { hasBackHandler, isPlaybackLocked } from "../back";

export default function IosBackEdge({ onBack }: { onBack: () => void }) {
  const drag = useRef<{ start: number; width: number; front: HTMLElement; behind: HTMLElement; id: number } | null>(null);
  const settling = useRef<Animation[]>([]);
  function reset() {
    settling.current.forEach(animation => animation.cancel());
    settling.current = [];
    if (!drag.current) return;
    drag.current.front.style.removeProperty("translate");
    drag.current.behind.style.removeProperty("translate");
    drag.current = null;
  }
  useEffect(() => reset, []);
  function start(e: PointerEvent<HTMLDivElement>) {
    if (settling.current.length || !e.isPrimary || hasBackHandler() || isPlaybackLocked() || document.fullscreenElement) return;
    const front = e.currentTarget.parentElement!;
    const behind = front.previousElementSibling?.matches("[data-stack]") ? front.previousElementSibling
      : front.parentElement?.querySelector("[data-tab]:not(.invisible)");
    if (!(behind instanceof HTMLElement)) return;
    drag.current = { front, behind, start: e.clientX, width: front.clientWidth, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent<HTMLDivElement>, end = false) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const x = Math.max(0, Math.min(e.clientX - d.start, d.width));
    if (hasBackHandler() || isPlaybackLocked()) { reset(); return; }
    if (end) {
      const commit = x >= Math.min(110, d.width * .3);
      const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 170;
      const options = { duration, easing: "ease-out", fill: "forwards" as const };
      const slide = d.front.animate([{ translate: x + "px" }, { translate: commit ? "100%" : "0px" }], options);
      const reveal = d.behind.animate([{ translate: (x - d.width) * .18 + "px" }, { translate: commit ? "0px" : "-18%" }], options);
      settling.current = [slide, reveal];
      slide.onfinish = () => {
        reset();
        if (commit && !hasBackHandler() && !isPlaybackLocked()) onBack();
      };
    } else {
      d.front.style.translate = x + "px";
      d.behind.style.translate = (x - d.width) * .18 + "px";
    }
  }
  return <div aria-hidden className="ios-back-edge" onPointerDown={start} onPointerMove={move}
    onPointerUp={e => move(e, true)} onLostPointerCapture={() => { if (!settling.current.length) reset(); }} onPointerCancel={reset} />;
}
