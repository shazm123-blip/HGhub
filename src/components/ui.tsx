import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cover, isIos } from "../api";
import { pushBackHandler } from "../back";
import { useStore } from "../store";
import { ICheck, IHeartF, ISparkF, IStarF } from "../icons";

/* ——— 头像 ——— */
export function Avatar({ hue = 250, icon, name, size = 40, ring = false, className = "" }: {
  hue?: number; icon?: React.ReactNode; name?: string; size?: number; ring?: boolean; className?: string;
}) {
  const inner = (
    <div className="w-full h-full rounded-full flex items-center justify-center overflow-hidden font-semibold"
      style={{ background: `hsl(${hue} 22% 30%)`, color: `hsl(${hue} 70% 88%)` }}>
      {icon ?? <span style={{ fontSize: size * 0.42 }} className="leading-none">{(name || "H").replace(/^@/, "")[0].toUpperCase()}</span>}
    </div>
  );
  return (
    <div className={`shrink-0 ${className}`} style={{ width: size, height: size }}>
      {ring ? <div className="w-full h-full rounded-full p-[2px] bg-primary"><div className="w-full h-full rounded-full bg-bg p-[2px]">{inner}</div></div> : inner}
    </div>
  );
}

/* ——— 底部弹层 ——— */
export function Sheet({ open, onClose, children, z = "z-50" }: { open: boolean; onClose: () => void; children: React.ReactNode; z?: string }) {
  const [render, setRender] = useState(open);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (open) setRender(true);
    else { const t = window.setTimeout(() => setRender(false), 230); return () => window.clearTimeout(t); }
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    return pushBackHandler(() => { onCloseRef.current(); return true; });
  }, [open]);
  if (!render) return null;
  return (
    <div className={`fixed inset-0 ${z}`}>
      <div className={`absolute inset-0 ${open ? "a-fade" : "opacity-0 transition-opacity duration-200"}`}
        style={{ background: "rgba(0,0,0,.55)", touchAction: "none" }}
        onTouchMove={(e) => e.stopPropagation()}
        onClick={onClose} />
      <div className={`sheet-surface absolute bottom-0 inset-x-0 bg-s2 elev-3 overflow-hidden ${open ? "a-sheet" : "a-sheet-out"}`}
        style={{ paddingBottom: "var(--sab, 0px)", borderTopLeftRadius: "var(--r-lg)", borderTopRightRadius: "var(--r-lg)" }}>
        <div className="pt-3 pb-1 flex justify-center"><div className="w-8 h-1 rounded-full bg-dim/70" /></div>
        {children}
      </div>
    </div>
  );
}

/* ——— 居中弹窗 ——— */
export function Modal({ open, onClose, children, width = 340 }: { open: boolean; onClose: () => void; children: React.ReactNode; width?: number }) {
  const [render, setRender] = useState(open);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (open) setRender(true);
    else { const t = window.setTimeout(() => setRender(false), 200); return () => window.clearTimeout(t); }
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    return pushBackHandler(() => { onCloseRef.current(); return true; });
  }, [open]);
  if (!render) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-5"
      style={{ paddingTop: "calc(var(--sat, 0px) + 16px)", paddingBottom: "calc(var(--sab, 0px) + 16px)" }}>
      <div className={`absolute inset-0 bg-black/65 backdrop-blur-sm ${open ? "a-fade" : "opacity-0 transition-opacity"}`}
        style={{ touchAction: "none" }}
        onTouchMove={(e) => e.stopPropagation()}
        onClick={onClose} />
      <div className={`modal-surface relative bg-s3 rounded-(--r-lg) elev-3 scroll-y ${open ? "a-scale-in" : "opacity-0 scale-90 transition-all"}`}
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

/* ——— Toast ——— */
export function ToastHost() {
  const { toasts } = useStore();
  return (
    <div aria-live="polite" className="absolute inset-x-0 z-[80] flex flex-col items-center gap-2 pointer-events-none px-6" style={{ bottom: "calc(var(--sab, 0px) + 96px)" }}>
      {toasts.map((t) => (
        <div key={t.id} className="a-toast pointer-events-auto flex items-center gap-2.5 max-w-full bg-s4/95 backdrop-blur-md rounded-(--r-sm) pl-3.5 pr-4 py-2.5 elev-3">
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

/* ——— 图片（骨架 + 渐显，自动走本地解密协议；支持同步缓存兜底与瞬时失败自动重试） ——— */
export function Img({ src, alt = "", className = "", eager = false, raw = false }: {
  src: string; alt?: string; className?: string; eager?: boolean; raw?: boolean;
}) {
  const baseUrl = raw ? src : cover(src);
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState(false);
  const [retry, setRetry] = useState(0);
  const imgRef = useRef<HTMLImageElement>(null);
  const prevUrlRef = useRef(baseUrl);
  const retryTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
  }, []);

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

  const displayUrl = retry > 0 && baseUrl && !baseUrl.startsWith("data:") && !baseUrl.startsWith("blob:")
    ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}r=${retry}`
    : baseUrl;

  const handleError = () => {
    if (retry < 2 && baseUrl && !baseUrl.startsWith("data:") && !baseUrl.startsWith("blob:")) {
      const delay = retry === 0 ? 700 : 1800;
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
    <div className={`absolute inset-0 overflow-hidden ${className}`}>
      {!ok && !err && <div className="absolute inset-0 shimmer" />}
      {err && <div className="absolute inset-0 bg-s3" />}
      {displayUrl && (
        <img
          ref={imgRef}
          src={displayUrl}
          alt={alt}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          onLoad={() => { setOk(true); setErr(false); }}
          onError={handleError}
          className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-300 ${ok ? "opacity-100" : "opacity-0"}`}
          draggable={false}
        />
      )}
    </div>
  );
}