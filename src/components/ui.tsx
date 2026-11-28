import React, { forwardRef, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cover, isIos, isMobile } from "../api";
import { pushBackHandler } from "../back";
import { useToasts } from "../store";
import { ICheck, IHeartF, IRefresh, ISparkF, IStarF } from "../icons";

/* ——— 头像 ——— */
export function Avatar({ hue = 250, icon, name, size = 40, ring = false, className = "" }: {
  hue?: number; icon?: React.ReactNode; name?: string; size?: number; ring?: boolean; className?: string;
}) {
  const inner = (
    <div className="w-full h-full rounded-full flex items-center justify-center overflow-hidden font-semibold"
      style={{ background: `hsl(${hue} 24% 24%)`, color: `hsl(${hue} 76% 86%)` }}>
      {icon ?? <span style={{ fontSize: size * 0.42 }} className="leading-none">{(name || "H").replace(/^@/, "")[0].toUpperCase()}</span>}
    </div>
  );
  return (
    <div className={`shrink-0 ${className}`} style={{ width: size, height: size }}>
      {ring ? (
        <div className="w-full h-full rounded-full p-[2px] brand-grad glow-neon">
          <div className="w-full h-full rounded-full bg-s1 p-[2px]">{inner}</div>
        </div>
      ) : inner}
    </div>
  );
}

/* ——— 底部弹层（含下拉关闭手势、软键盘避让、无障碍属性、Esc 关闭与焦点恢复） ——— */
export function Sheet({ open, onClose, children, z = "z-50", ariaLabel }: {
  open: boolean; onClose: () => void; children: React.ReactNode; z?: string; ariaLabel?: string;
}) {
  const [render, setRender] = useState(open);
  const [kbOffset, setKbOffset] = useState(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) setRender(true);
    else {
      setKbOffset(0);
      const t = window.setTimeout(() => setRender(false), 230);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  /* 移动端软键盘弹出时通过 visualViewport 避让，防止评论发送框 / 登录提交钮被遮挡 */
  useEffect(() => {
    if (!open || !isMobile || typeof window === "undefined" || !window.visualViewport) return undefined;
    const vv = window.visualViewport;
    const sync = () => {
      const hiddenBottom = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      setKbOffset(hiddenBottom > 48 ? hiddenBottom : 0);
    };
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, [open]);

  /* 原生跟手下拉关闭手势：顶部手柄区随时可拉；内容滚动区在 scrollTop === 0 时向下滑动接管 */
  useEffect(() => {
    if (!open || !render) return undefined;
    const surface = surfaceRef.current;
    if (!surface) return undefined;
    let drag: {
      startX: number; startY: number; lastY: number; lastT: number; vy: number;
      fromHandle: boolean; scrollEl: HTMLElement | null; active: boolean; lockedScroll: boolean;
    } | null = null;

    const resetVisual = (animate = true) => {
      surface.style.transition = animate ? "transform .24s cubic-bezier(.32,.72,0,1)" : "";
      surface.style.transform = "";
      if (backdropRef.current) {
        backdropRef.current.style.transition = animate ? "opacity .22s ease" : "";
        backdropRef.current.style.opacity = "";
      }
      if (animate) {
        window.setTimeout(() => {
          if (surfaceRef.current) surfaceRef.current.style.transition = "";
          if (backdropRef.current) backdropRef.current.style.transition = "";
        }, 250);
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [data-no-sheet-drag]")) return;
      const t0 = e.touches[0];
      const fromHandle = Boolean(target?.closest("[data-sheet-handle]"));
      const scrollEl = target?.closest<HTMLElement>(".scroll-y") ?? null;
      if (!fromHandle && scrollEl && scrollEl.scrollTop > 2) return;
      drag = {
        startX: t0.clientX,
        startY: t0.clientY,
        lastY: t0.clientY,
        lastT: Date.now(),
        vy: 0,
        fromHandle,
        scrollEl,
        active: false,
        lockedScroll: false,
      };
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!drag || e.touches.length !== 1) return;
      const t0 = e.touches[0];
      const dx = t0.clientX - drag.startX;
      const dy = t0.clientY - drag.startY;
      if (!drag.active) {
        if (drag.lockedScroll) return;
        if (!drag.fromHandle && drag.scrollEl && drag.scrollEl.scrollTop > 2) {
          drag.lockedScroll = true;
          return;
        }
        if (dy < -6 || Math.abs(dx) > Math.abs(dy) * 1.15) {
          if (Math.hypot(dx, dy) > 8) drag.lockedScroll = true;
          return;
        }
        if (dy > 8) {
          drag.active = true;
          surface.style.transition = "none";
          if (backdropRef.current) backdropRef.current.style.transition = "none";
        } else {
          return;
        }
      }
      e.preventDefault();
      const now = Date.now();
      const dt = Math.max(1, now - drag.lastT);
      drag.vy = (t0.clientY - drag.lastY) / dt;
      drag.lastY = t0.clientY;
      drag.lastT = now;
      const offset = Math.max(0, dy);
      surface.style.transform = `translate3d(0, ${offset}px, 0)`;
      if (backdropRef.current) {
        const h = Math.max(240, surface.clientHeight || 400);
        backdropRef.current.style.opacity = String(Math.max(0.15, 1 - offset / h));
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!drag) return;
      const g = drag;
      drag = null;
      if (!g.active) return;
      const dy = Math.max(0, g.lastY - g.startY);
      const h = Math.max(240, surface.clientHeight || 400);
      const shouldClose = e.type !== "touchcancel" && (dy > Math.min(110, h * 0.26) || (dy > 32 && g.vy > 0.55));
      if (shouldClose) {
        surface.style.transition = "transform .18s cubic-bezier(.3,0,.8,.15)";
        surface.style.transform = `translate3d(0, ${h}px, 0)`;
        if (backdropRef.current) {
          backdropRef.current.style.transition = "opacity .18s ease";
          backdropRef.current.style.opacity = "0";
        }
        onCloseRef.current();
      } else {
        resetVisual(true);
      }
    };

    surface.addEventListener("touchstart", onTouchStart, { passive: true });
    surface.addEventListener("touchmove", onTouchMove, { passive: false });
    surface.addEventListener("touchend", onTouchEnd);
    surface.addEventListener("touchcancel", onTouchEnd);
    return () => {
      resetVisual(false);
      surface.removeEventListener("touchstart", onTouchStart);
      surface.removeEventListener("touchmove", onTouchMove);
      surface.removeEventListener("touchend", onTouchEnd);
      surface.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [open, render]);

  useEffect(() => {
    if (!open) return undefined;
    prevFocusRef.current = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => {
      const root = surfaceRef.current;
      if (root && !root.contains(document.activeElement)) {
        root.focus({ preventScroll: true });
      }
    });
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    const releaseBack = pushBackHandler(() => { onCloseRef.current(); return true; });
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKeyDown, true);
      releaseBack();
      const prev = prevFocusRef.current;
      prevFocusRef.current = null;
      if (prev && prev.isConnected) {
        try { prev.focus({ preventScroll: true }); } catch { /* ignore */ }
      }
    };
  }, [open]);
  if (!render) return null;
  return (
    <div className={`fixed inset-0 ${z}`}>
      <div
        ref={backdropRef}
        className={`absolute inset-0 ${open ? "a-fade" : "opacity-0 transition-opacity duration-200"}`}
        style={{ background: "rgba(0,0,0,.55)", touchAction: "none" }}
        onTouchMove={(e) => e.stopPropagation()}
        onClick={onClose} />
      <div
        ref={surfaceRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={`sheet-surface absolute inset-x-0 bg-s2 elev-3 overflow-hidden outline-none ${open ? "a-sheet" : "a-sheet-out"}`}
        style={{
          bottom: kbOffset,
          maxHeight: kbOffset > 0 ? `calc(100dvh - var(--sat, 0px) - ${kbOffset}px - 8px)` : undefined,
          paddingBottom: kbOffset > 0 ? 4 : "var(--sab, 0px)",
          borderTopLeftRadius: "var(--r-lg)",
          borderTopRightRadius: "var(--r-lg)",
        }}>
        <div data-sheet-handle className="pt-3 pb-1.5 flex justify-center cursor-grab active:cursor-grabbing" style={{ touchAction: "none" }}>
          <div className="w-9 h-1 rounded-full bg-dim/70" />
        </div>
        {children}
      </div>
    </div>
  );
}

/* ——— 居中弹窗（含焦点管理与无障碍属性） ——— */
const FOCUSABLE_SELECTOR = 'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Modal({ open, onClose, children, width = 340, ariaLabel }: {
  open: boolean; onClose: () => void; children: React.ReactNode; width?: number; ariaLabel?: string;
}) {
  const [render, setRender] = useState(open);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) setRender(true);
    else { const t = window.setTimeout(() => setRender(false), 200); return () => window.clearTimeout(t); }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    prevFocusRef.current = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => {
      const root = surfaceRef.current;
      if (!root) return;
      if (!root.contains(document.activeElement)) {
        const first = root.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? root;
        first.focus({ preventScroll: true });
      }
    });
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const root = surfaceRef.current;
      if (!root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) {
        e.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (!activeEl || activeEl === first || !root.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else if (!activeEl || activeEl === last || !root.contains(activeEl)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    const releaseBack = pushBackHandler(() => { onCloseRef.current(); return true; });
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKeyDown, true);
      releaseBack();
      const prev = prevFocusRef.current;
      prevFocusRef.current = null;
      if (prev && prev.isConnected) {
        try { prev.focus({ preventScroll: true }); } catch { /* ignore */ }
      }
    };
  }, [open]);

  if (!render) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-5"
      style={{ paddingTop: "calc(var(--sat, 0px) + 16px)", paddingBottom: "calc(var(--sab, 0px) + 16px)" }}>
      <div className={`absolute inset-0 bg-black/70 ${open ? "a-fade" : "opacity-0 transition-opacity"}`}
        style={{ touchAction: "none" }}
        onTouchMove={(e) => e.stopPropagation()}
        onClick={onClose} />
      <div
        ref={surfaceRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={`modal-surface relative bg-s3 rounded-(--r-lg) elev-3 scroll-y outline-none ${open ? "a-scale-in" : "opacity-0 scale-90 transition-all"}`}
        style={{ width, maxWidth: "100%", maxHeight: "calc(100dvh - var(--sat, 0px) - var(--sab, 0px) - 32px)" }}>
        {children}
      </div>
    </div>
  );
}

/* ——— 开关 ——— */
export function Toggle({ on, onChange, label, disabled = false }: { on: boolean; onChange: (b: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button disabled={disabled} onClick={() => onChange(!on)} role={isIos ? "switch" : undefined} aria-checked={isIos ? on : undefined} aria-pressed={isIos ? undefined : on} aria-label={label}
      className={`setting-switch relative shrink-0 w-[46px] h-[26px] rounded-full transition-colors duration-200 disabled:opacity-50 disabled:cursor-wait ${on ? "bg-primary" : "bg-s4"}`}>
      <span className={`absolute top-[3px] w-5 h-5 rounded-full elev-1 transition-all duration-200 ${on ? "left-[23px] bg-on-primary" : "left-[3px] bg-mut"}`} />
    </button>
  );
}

/* ——— 空状态 ——— */
export function Empty({ icon, title, sub, action, onAction, secondaryAction, onSecondaryAction }: {
  icon: React.ReactNode; title: string; sub?: string; action?: string; onAction?: () => void;
  secondaryAction?: string; onSecondaryAction?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-8 text-center a-rise">
      <div className="w-16 h-16 rounded-(--r-md) tonal flex items-center justify-center mb-4">{icon}</div>
      <div className="text-[15px] font-semibold text-on/90">{title}</div>
      {sub && <div className="text-xs text-mut mt-1.5 leading-relaxed select-text">{sub}</div>}
      {(action || secondaryAction) && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
          {action && (
            <button onClick={onAction} className="px-6 h-10 rounded-(--r-ctl) bg-primary text-on-primary text-[13px] font-bold pressable">{action}</button>
          )}
          {secondaryAction && (
            <button onClick={onSecondaryAction} className="px-5 h-10 rounded-(--r-ctl) bg-s3 text-on text-[13px] font-semibold pressable">{secondaryAction}</button>
          )}
        </div>
      )}
    </div>
  );
}

/* ——— Toast（移动端贴顶部安全区下方避开播放底栏与键盘；桌面端置底部） ——— */
export function ToastHost() {
  const toasts = useToasts();
  return (
    <div
      aria-live="polite"
      className="fixed inset-x-0 z-[80] flex flex-col items-center gap-2 pointer-events-none px-6"
      style={isMobile ? { top: "calc(var(--sat, 0px) + 54px)" } : { bottom: 84 }}>
      {toasts.map((t) => (
        <div key={t.id} className="a-toast pointer-events-auto flex items-center gap-2.5 max-w-full rounded-(--r-sm) pl-3.5 pr-4 py-2.5 elev-3 bg-s4/[0.96]">
          {t.icon === "ok" && <ICheck size={16} className="text-mint shrink-0" />}
          {t.icon === "heart" && <IHeartF size={16} className="text-neon shrink-0" />}
          {t.icon === "star" && <IStarF size={16} className="text-amber shrink-0" />}
          {t.icon === "info" && <ISparkF size={15} className="text-cyan shrink-0" />}
          <span className="text-[13px] text-on truncate">{t.msg}</span>
        </div>
      ))}
    </div>
  );
}

/* ——— 移动端下拉刷新滚动容器（DOM Ref 直驱，下拉拖动 0 React 重渲染；桌面端零额外开销） ——— */
const PTR_THRESHOLD = 58;
const PTR_MAX = 92;

export const PullToRefresh = forwardRef<HTMLDivElement, {
  onRefresh: () => void | Promise<unknown>;
  refreshing?: boolean;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}>(function PullToRefresh({ onRefresh, refreshing = false, className = "", style, children }, forwardedRef) {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const indicatorRef = useRef<HTMLDivElement | null>(null);
  const iconWrapRef = useRef<HTMLSpanElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const [busy, setBusy] = useState(false);
  const pullRef = useRef(0);
  const busyRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  busyRef.current = busy || refreshing;

  const setRefs = (el: HTMLDivElement | null) => {
    innerRef.current = el;
    if (typeof forwardedRef === "function") forwardedRef(el);
    else if (forwardedRef) forwardedRef.current = el;
  };

  const applyIndicator = (height: number, animate: boolean, isRefreshing: boolean) => {
    const ind = indicatorRef.current;
    if (!ind) return;
    ind.style.transition = animate ? "height .18s cubic-bezier(.32,.72,0,1), opacity .18s ease" : "none";
    ind.style.height = `${height}px`;
    ind.style.opacity = height > 4 ? "1" : "0";
    if (iconWrapRef.current && !isRefreshing) {
      const deg = Math.min(180, (height / PTR_THRESHOLD) * 180);
      iconWrapRef.current.style.transform = `rotate(${deg}deg)`;
    }
    if (labelRef.current && !isRefreshing) {
      labelRef.current.textContent = height >= PTR_THRESHOLD ? "松开立即刷新" : "下拉刷新";
    }
  };

  useEffect(() => {
    if (!isMobile) return;
    const activeRefresh = busy || refreshing;
    applyIndicator(activeRefresh ? 40 : 0, true, activeRefresh);
    if (labelRef.current && activeRefresh) labelRef.current.textContent = "正在刷新…";
  }, [busy, refreshing]);

  useEffect(() => {
    if (!isMobile) return undefined;
    const el = innerRef.current;
    if (!el) return undefined;
    let startX = 0;
    let startY = 0;
    let tracking = false;
    let pulling = false;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || busyRef.current || el.scrollTop > 2) {
        tracking = false;
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target?.closest(".scroll-x")) {
        tracking = false;
        return;
      }
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      tracking = true;
      pulling = false;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!tracking || e.touches.length !== 1) return;
      if (el.scrollTop > 2) {
        tracking = false;
        if (pulling) {
          pulling = false;
          pullRef.current = 0;
          applyIndicator(0, true, false);
        }
        return;
      }
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (!pulling) {
        if (dy < 6 || Math.abs(dx) > Math.abs(dy) * 0.9) {
          if (Math.hypot(dx, dy) > 10) tracking = false;
          return;
        }
        pulling = true;
      }
      if (dy <= 0) {
        pullRef.current = 0;
        applyIndicator(0, false, false);
        return;
      }
      e.preventDefault();
      const damped = Math.min(PTR_MAX, Math.round(dy * 0.46));
      if (damped !== pullRef.current) {
        pullRef.current = damped;
        applyIndicator(damped, false, false);
      }
    };

    const onTouchEnd = () => {
      if (!tracking && !pulling) return;
      tracking = false;
      const dist = pullRef.current;
      pulling = false;
      pullRef.current = 0;
      if (dist >= PTR_THRESHOLD && !busyRef.current) {
        setBusy(true);
        applyIndicator(40, true, true);
        if (labelRef.current) labelRef.current.textContent = "正在刷新…";
        Promise.resolve(onRefreshRef.current())
          .catch(() => {})
          .finally(() => {
            setBusy(false);
          });
      } else {
        applyIndicator(0, true, false);
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);

  const activeRefresh = busy || refreshing;

  return (
    <div ref={setRefs} className={className} style={style}>
      {isMobile && (
        <div
          ref={indicatorRef}
          aria-live="polite"
          className="flex items-center justify-center gap-1.5 overflow-hidden text-[11.5px] text-mut select-none"
          style={{ height: activeRefresh ? 40 : 0, opacity: activeRefresh ? 1 : 0 }}>
          <span ref={iconWrapRef} className="inline-flex">
            <IRefresh size={14} className={activeRefresh ? "animate-spin text-primary" : "text-mut"} />
          </span>
          <span ref={labelRef}>{activeRefresh ? "正在刷新…" : "下拉刷新"}</span>
        </div>
      )}
      {children}
    </div>
  );
});

/* ——— 分段滑块控件 ——— */
export function SegmentedControl<T extends string>({
  options, value, onChange, ariaLabel, role = "group", className = "",
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
  role?: "radiogroup" | "group";
  className?: string;
}) {
  const activeIdx = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div role={role} aria-label={ariaLabel} className={`segment-control ${className}`}>
      <div
        aria-hidden="true"
        className="segment-indicator"
        style={{
          width: `calc((100% - 6px) / ${Math.max(1, options.length)})`,
          transform: `translateX(${activeIdx * 100}%)`,
        }}
      />
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role={role === "radiogroup" ? "radio" : undefined}
            aria-checked={role === "radiogroup" ? active : undefined}
            aria-pressed={role !== "radiogroup" ? active : undefined}
            onClick={() => onChange(opt.value)}
            className="pressable">
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/* ——— 骨架屏（对齐画廊式海报卡结构） ——— */
export function CardGridSkeleton({ wide = false, count = 8, aspect = "aspect-[3/4]", gap = "gap-3" }: {
  wide?: boolean; count?: number; aspect?: string; gap?: string;
}) {
  return (
    <div className={`grid ${wide ? "grid-cols-3 xl:grid-cols-4" : "grid-cols-2"} ${gap}`} aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="w-full">
          <div className={`relative w-full ${aspect} rounded-(--r-sm) overflow-hidden shimmer`} />
          <div className="mt-2 h-3.5 w-4/5 rounded shimmer" />
          <div className="mt-1.5 h-2.5 w-1/2 rounded shimmer" />
        </div>
      ))}
    </div>
  );
}

export function RowCardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="flex gap-2.5" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="row-cover w-[108px] shrink-0">
          <div className="w-full aspect-[3/4] rounded-(--r-sm) shimmer" />
          <div className="mt-1.5 h-3 w-4/5 rounded shimmer" />
          <div className="mt-1 h-2.5 w-3/5 rounded shimmer" />
        </div>
      ))}
    </div>
  );
}

export function RankListSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="space-y-2" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-center gap-3 p-2.5 rounded-(--r-md) bg-s2">
          <div className="w-7 h-7 rounded-full shimmer shrink-0" />
          <div className="w-[52px] h-[68px] rounded-lg shimmer shrink-0" />
          <div className="flex-1 min-w-0 space-y-2">
            <div className="h-3.5 w-3/4 rounded shimmer" />
            <div className="h-2.5 w-1/2 rounded shimmer" />
            <div className="h-1 w-full rounded-full shimmer" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function CommentListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="divide-y divide-s3" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex gap-2.5 py-3">
          <div className="w-8 h-8 rounded-full shimmer shrink-0" />
          <div className="flex-1 min-w-0 space-y-2 pt-0.5">
            <div className="flex items-center gap-2">
              <div className="h-3 w-20 rounded shimmer" />
              <div className="h-2.5 w-12 rounded shimmer" />
            </div>
            <div className="h-3 w-11/12 rounded shimmer" />
            <div className="h-3 w-2/3 rounded shimmer" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function PostDetailSkeleton() {
  return (
    <div className="max-w-[760px] mx-auto" aria-busy="true">
      <div className="w-full md:rounded-(--r-md) md:mt-3 shimmer" style={{ height: "min(36dvh, 320px)" }} />
      <div className="px-4 pt-4 space-y-3">
        <div className="h-5 w-11/12 rounded shimmer" />
        <div className="h-5 w-2/3 rounded shimmer" />
        <div className="flex gap-2.5 pt-1">
          <div className="h-3 w-24 rounded shimmer" />
          <div className="h-3 w-14 rounded shimmer" />
        </div>
        <div className="space-y-2.5 pt-3">
          <div className="h-3.5 w-full rounded shimmer" />
          <div className="h-3.5 w-full rounded shimmer" />
          <div className="h-3.5 w-5/6 rounded shimmer" />
          <div className="h-3.5 w-4/5 rounded shimmer" />
        </div>
      </div>
    </div>
  );
}

/* ——— 共享可见性观察器：避免视口外懒加载图片空转 shimmer 动画 ——— */
const visCallbacks = new WeakMap<Element, (visible: boolean) => void>();
let sharedImgObserver: IntersectionObserver | null = null;
function observeImgVisibility(el: Element, cb: (visible: boolean) => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    cb(true);
    return () => {};
  }
  if (!sharedImgObserver) {
    sharedImgObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          visCallbacks.get(entry.target)?.(entry.isIntersecting);
        }
      },
      { rootMargin: "120px" },
    );
  }
  visCallbacks.set(el, cb);
  sharedImgObserver.observe(el);
  return () => {
    visCallbacks.delete(el);
    sharedImgObserver?.unobserve(el);
  };
}

/* ——— 图片（骨架 + 渐显，自动走本地解密协议；支持同步缓存兜底与瞬时失败自动重试） ——— */
export function Img({ src, alt = "", className = "", imgClassName = "", eager = false, raw = false }: {
  src: string; alt?: string; className?: string; imgClassName?: string; eager?: boolean; raw?: boolean;
}) {
  const baseUrl = raw ? src : cover(src);
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState(false);
  const [retry, setRetry] = useState(0);
  const [inView, setInView] = useState(eager || typeof IntersectionObserver === "undefined");
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const prevUrlRef = useRef(baseUrl);
  const retryTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
  }, []);

  useEffect(() => {
    if (eager || ok || err) return undefined;
    const el = wrapRef.current;
    if (!el) return undefined;
    return observeImgVisibility(el, setInView);
  }, [eager, ok, err, baseUrl]);

  useLayoutEffect(() => {
    if (prevUrlRef.current !== baseUrl) {
      prevUrlRef.current = baseUrl;
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      setOk(false);
      setErr(false);
      setRetry(0);
    }
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) {
      setOk(true);
      setErr(false);
    }
  }, [baseUrl, retry]);

  const retryable = Boolean(baseUrl && !baseUrl.startsWith("data:") && !baseUrl.startsWith("blob:"));
  const displayUrl = retry > 0 && retryable
    ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}r=${retry}`
    : baseUrl;

  useEffect(() => {
    if (!err || !retryable) return undefined;
    const recover = () => {
      if (document.visibilityState === "hidden") return;
      setErr(false);
      setRetry((r) => r + 1);
    };
    window.addEventListener("online", recover);
    document.addEventListener("visibilitychange", recover);
    return () => {
      window.removeEventListener("online", recover);
      document.removeEventListener("visibilitychange", recover);
    };
  }, [err, retryable]);

  const handleError = () => {
    if (retry < 2 && retryable) {
      const delay = retry === 0 ? 800 : 2000;
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        setRetry((r) => r + 1);
      }, delay);
      return;
    }
    setErr(true);
  };

  return (
    <div ref={wrapRef} className={`absolute inset-0 overflow-hidden ${className}`}>
      {!ok && !err && (
        inView ? <div className="absolute inset-0 shimmer" /> : <div className="absolute inset-0 bg-s2" />
      )}
      {err && (
        <div aria-hidden="true" className="absolute inset-0 bg-s3 flex items-center justify-center text-dim/45">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2.5" />
            <circle cx="8.5" cy="9.5" r="1.5" />
            <path d="m21 16-5-5L5 20" />
          </svg>
        </div>
      )}
      {displayUrl && (
        <img
          ref={imgRef}
          src={displayUrl}
          alt={alt}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          onLoad={() => { setOk(true); setErr(false); }}
          onError={handleError}
          className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-300 ${ok ? "opacity-100" : "opacity-0"} ${imgClassName}`}
          draggable={false}
        />
      )}
    </div>
  );
}