import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { IBack } from "../icons";

export default function IosNavigation({ title, subtitle, onBack, action }: { title: string; subtitle?: string; onBack?: () => void; action?: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const list = ref.current?.parentElement?.querySelector<HTMLElement>(":scope > .scroll-y");
    if (!list) return;
    const sync = () => setCompact(previous => list.scrollTop > 60 || (previous && list.scrollTop > 2));
    sync();
    list.addEventListener("scroll", sync, { passive: true });
    return () => list.removeEventListener("scroll", sync);
  }, []);
  return (
    <header ref={ref} className={'ios-navigation' + (compact ? ' compact' : '')}>
      <div className="ios-toolbar">
        {onBack && <button onClick={onBack} aria-label="返回"><IBack size={21} />返回</button>}
        {action}
      </div>
      <h1>{title}</h1>
      {subtitle && !compact && <p className="px-[18px] pb-2 text-[13px] text-mut">{subtitle}</p>}
    </header>
  );
}
