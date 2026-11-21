import { useEffect, useEffectEvent, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore, type Tab } from "../store";
import { hasBackHandler, isPlaybackLocked } from "../back";
import { APP_VERSION } from "../api";
import { Avatar } from "./ui";
import {
  IBack, IChevR, IClose, IGrid, IGridF, IHome, IHomeF, IMinus, IMoon, IRestore, ISearch, ISettings, ISidebar,
  ISquare, ISun, ITrophy, IUser, IUserF, Logo,
} from "../icons";

const appWindow = () => getCurrentWindow();

export function DesktopTitleBar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { theme, setTheme, setTab } = useStore();
  const [maxed, setMaxed] = useState(false);
  useEffect(() => {
    let un: (() => void) | undefined;
    const sync = () => {
      appWindow().isMaximized().then(setMaxed).catch(() => {});
    };
    sync();
    appWindow().onResized(sync)
      .then((f: () => void) => { un = f; }).catch(() => {});
    return () => { un?.(); };
  }, []);

  return (
    <header className="win-titlebar" data-tauri-drag-region
      onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest("button")) appWindow().toggleMaximize().catch(() => {}); }}>
      <div className="win-wordmark" data-tauri-drag-region>
        <Logo size={24} />
        <span>HG<span className="win-wordmark-light">hub</span></span>
      </div>
      <button className="win-caption-tool" aria-label={collapsed ? "展开侧栏" : "收起侧栏"} onClick={onToggle}>
        <ISidebar size={17} strokeWidth={1.7} />
      </button>
      <div className="win-drag-region" data-tauri-drag-region />
      <button className="win-caption-tool" aria-label="切换外观" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
        {theme === "dark" ? <ISun size={17} strokeWidth={1.7} /> : <IMoon size={17} strokeWidth={1.7} />}
      </button>
      <button className="win-caption-tool" aria-label="搜索" onClick={() => setTab("search")}>
        <ISearch size={17} strokeWidth={1.7} />
      </button>
      <div className="win-caption-buttons">
        <button aria-label="最小化" onClick={() => appWindow().minimize().catch(() => {})}><IMinus size={15} strokeWidth={1.5} /></button>
        <button aria-label={maxed ? "还原" : "最大化"} onClick={() => appWindow().toggleMaximize().catch(() => {})}>
          {maxed ? <IRestore size={14} strokeWidth={1.5} /> : <ISquare size={14} strokeWidth={1.5} />}
        </button>
        <button className="win-close" aria-label="关闭" onClick={() => appWindow().close().catch(() => {})}><IClose size={16} strokeWidth={1.5} /></button>
      </div>
    </header>
  );
}

export function MacToolbar({ collapsed, theater, onToggle }: { collapsed: boolean; theater: boolean; onToggle: () => void }) {
  const { tab, stack, setTab, push, travel, canGoBack, canGoForward, loginOpen, themePref, theme, setTheme } = useStore();
  const page = stack.at(-1);
  const titles = { home: "首页", category: "分类", profile: "我的", search: "搜索", ranks: "排行榜", settings: "设置", posts: "黄果吃瓜", post: "吃瓜详情" };
  const title = page?.kind === "feed" ? page.title : page?.kind === "channel" ? page.name : titles[page?.kind ?? tab];
  function search() {
    setTab("search");
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-tab]:not(.invisible) input[type=search]')?.focus());
  }
  useEffect(() => {
    if (isTauri()) appWindow().setTheme(themePref === "system" ? null : themePref).catch(() => {});
  }, [themePref]);
  const navigate = useEffectEvent((action: "find" | "settings") => {
    if (loginOpen || hasBackHandler() || isPlaybackLocked()) return;
    if (action === "find") search();
    else if (page?.kind !== "settings") push({ kind: "settings" });
  });
  useEffect(() => {
    if (isTauri()) {
      const listening = listen<"find" | "settings">("mac-navigation", event => navigate(event.payload));
      return () => { void listening.then(unlisten => unlisten()); };
    }
    const keydown = (event: KeyboardEvent) => {
      if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
      if (!["f", ","].includes(event.key.toLowerCase())) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      navigate(event.key === "," ? "settings" : "find");
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, []);
  return <header className={'mac-toolbar' + (theater ? ' theater' : '')} data-tauri-drag-region>
    {!theater && <button aria-label={collapsed ? "展开侧栏" : "收起侧栏"} onClick={onToggle}><ISidebar size={17} /></button>}
    <button aria-label="后退" disabled={!canGoBack} onClick={() => travel(-1)}><IBack size={17} /></button>
    <button aria-label="前进" disabled={!canGoForward} onClick={() => travel(1)}><IChevR size={17} /></button>
    <strong className="truncate" data-tauri-drag-region>{title}</strong>
    <div className="flex-1 h-full" data-tauri-drag-region />
    <button aria-label="切换外观" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <ISun size={16} /> : <IMoon size={16} />}</button>
    <button className="mac-search" onClick={search}><ISearch size={14} />搜索<kbd>⌘F</kbd></button>
  </header>;
}

export function DesktopRail({ collapsed }: { collapsed: boolean }) {
  const { tab, setTab, bumpHomeRefresh, user, setLoginOpen, push, platform, stack } = useStore();
  /* 从侧栏进入的栈页（排行榜 / 设置）接管高亮，否则「我的」会一直亮着，看起来不像独立页面 */
  const top = stack[stack.length - 1];
  const railPage: "ranks" | "settings" | null =
    top?.kind === "settings" ? "settings" : top?.kind === "ranks" ? "ranks" : null;
  const onTab = (key: Tab | "search") => !railPage && tab === key;
  const items: { key: Tab; label: string; Icon: typeof IHome; Filled: typeof IHomeF }[] = [
    { key: "home", label: "首页", Icon: IHome, Filled: IHomeF },
    { key: "category", label: "分类", Icon: IGrid, Filled: IGridF },
    { key: "profile", label: "我的", Icon: IUser, Filled: IUserF },
  ];
  return (
    <nav className={`win-sidebar ${collapsed ? "is-compact" : ""}`} aria-label="主导航" data-tauri-drag-region={platform === "macos" ? "" : undefined}>
      <div className="win-sidebar-inner">
        {platform === "macos" ? <div className="mac-brand" data-tauri-drag-region><Logo size={26} /><strong>HGhub</strong></div> : <button className={`win-search-launch ${onTab("search") ? "is-selected" : ""}`}
          onClick={() => setTab("search")} aria-label="搜索">
          <ISearch size={19} strokeWidth={1.7} />
          <span className="win-nav-copy">搜索你感兴趣的</span>
          <kbd className="win-nav-key">/</kbd>
        </button>}
        <div className="win-nav-items">
          {platform === "macos" && <small className="mac-group">资料库</small>}
          {items.map(({ key, label, Icon, Filled }) => (
            <button key={key} aria-label={label} aria-current={onTab(key) ? "page" : undefined}
              className={`win-nav-item ${onTab(key) ? "is-selected" : ""}`}
              onClick={() => {
                if (key === "home" && onTab("home") && stack.length === 0) bumpHomeRefresh();
                else setTab(key);
              }}>
              <span className="win-nav-symbol">{onTab(key) ? <Filled size={21} /> : <Icon size={21} strokeWidth={1.7} />}</span>
              <span className="win-nav-copy">{label}</span>
            </button>
          ))}
          <button aria-label="排行榜" className={`win-nav-item ${railPage === "ranks" ? "is-selected" : ""}`}
            aria-current={railPage === "ranks" ? "page" : undefined}
            onClick={() => { if (railPage !== "ranks") push({ kind: "ranks" }); }}>
            <span className="win-nav-symbol"><ITrophy size={21} strokeWidth={1.7} /></span>
            <span className="win-nav-copy">排行榜</span>
          </button>
          {platform === "macos" && <small className="mac-group">应用</small>}
          <button aria-label="设置" className={`win-nav-item ${railPage === "settings" ? "is-selected" : ""}`}
            aria-current={railPage === "settings" ? "page" : undefined}
            onClick={() => { if (railPage !== "settings") push({ kind: "settings" }); }}>
            <span className="win-nav-symbol"><ISettings size={21} strokeWidth={1.7} /></span>
            <span className="win-nav-copy">设置</span>
          </button>
        </div>
        <div className="win-sidebar-bottom">
          <button className="win-account" aria-label={user?.nickname || "登录 HGhub"} onClick={() => { setTab("profile"); if (!user) setLoginOpen(true); }}>
            <Avatar size={34} hue={220} name={user?.nickname} icon={user ? undefined : <IUser size={17} />} />
            <span className="win-account-copy">
              <strong>{user?.nickname || "登录 HGhub"}</strong>
              <small>{user ? "你的精彩，都在这里" : "留住每一次心动"}</small>
            </span>
          </button>
          <span className="win-sidebar-version">HGhub for {platform === "macos" ? "macOS" : platform === "linux" ? "Linux" : "Windows"} {APP_VERSION}</span>
        </div>
      </div>
    </nav>
  );
}