import { useEffect, useEffectEvent, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useModalUi, useNavState, useSessionUser, useStoreActions, useThemeState, useViewportMode, type Tab } from "../store";
import { hasBackHandler, isPlaybackLocked } from "../back";
import { APP_VERSION } from "../api";
import { Avatar } from "./ui";
import {
  IBack, IChevR, IClose, IGrid, IGridF, IHome, IHomeF, IMinus, IMoon, IRestore, ISearch, ISettings, ISidebar,
  ISquare, ISun, ITrophy, IUser, IUserF, Logo,
} from "../icons";

const appWindow = () => getCurrentWindow();

export function DesktopTitleBar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { setTheme, setTab, setTheater } = useStoreActions();
  const { theme } = useThemeState();
  const { theater } = useViewportMode();
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

  const handleSidebarToggle = () => {
    if (theater) {
      setTheater(false);
      if (collapsed) onToggle();
    } else {
      onToggle();
    }
  };
  const sidebarExpanded = !collapsed && !theater;

  return (
    <header className="win-titlebar" data-tauri-drag-region
      onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest("button")) appWindow().toggleMaximize().catch(() => {}); }}>
      <div className="win-wordmark" data-tauri-drag-region>
        <Logo size={24} />
        <span>HG<span className="win-wordmark-light">hub</span></span>
      </div>
      <button className="win-caption-tool" aria-label={sidebarExpanded ? "收起侧栏" : "展开侧栏"}
        title={theater ? "退出影院模式并显示侧栏 (T)" : sidebarExpanded ? "收起侧栏" : "展开侧栏"}
        onClick={handleSidebarToggle}>
        <ISidebar size={17} strokeWidth={1.7} />
      </button>
      <div className="win-drag-region" data-tauri-drag-region />
      <button className="win-caption-tool" aria-label="切换外观" title="切换深浅外观" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
        {theme === "dark" ? <ISun size={17} strokeWidth={1.7} /> : <IMoon size={17} strokeWidth={1.7} />}
      </button>
      <button className="win-caption-tool" aria-label="搜索" title="搜索 (/)" onClick={() => setTab("search")}>
        <ISearch size={17} strokeWidth={1.7} />
      </button>
      <div className="win-caption-buttons">
        <button aria-label="最小化" title="最小化" onClick={() => appWindow().minimize().catch(() => {})}><IMinus size={15} strokeWidth={1.5} /></button>
        <button aria-label={maxed ? "还原" : "最大化"} title={maxed ? "还原" : "最大化"} onClick={() => appWindow().toggleMaximize().catch(() => {})}>
          {maxed ? <IRestore size={14} strokeWidth={1.5} /> : <ISquare size={14} strokeWidth={1.5} />}
        </button>
        <button className="win-close" aria-label="关闭" title="关闭" onClick={() => appWindow().close().catch(() => {})}><IClose size={16} strokeWidth={1.5} /></button>
      </div>
    </header>
  );
}

export function MacToolbar({ collapsed, theater, onToggle }: { collapsed: boolean; theater: boolean; onToggle: () => void }) {
  const { setTab, push, travel, setTheme, setTheater } = useStoreActions();
  const { tab, stack, canGoBack, canGoForward } = useNavState();
  const { loginOpen, linePickerOpen, shortcutsOpen } = useModalUi();
  const { themePref, theme } = useThemeState();
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
    if (loginOpen || linePickerOpen || shortcutsOpen || hasBackHandler() || isPlaybackLocked()) return;
    if (action === "find") search();
    else if (page?.kind !== "settings") push({ kind: "settings" });
  });
  const navHistory = useEffectEvent((dir: "back" | "forward") => {
    if (loginOpen || linePickerOpen || shortcutsOpen || hasBackHandler() || isPlaybackLocked()) return;
    if (dir === "back" && canGoBack) travel(-1);
    else if (dir === "forward" && canGoForward) travel(1);
  });
  useEffect(() => {
    const listening = isTauri()
      ? listen<"find" | "settings">("mac-navigation", event => navigate(event.payload))
      : null;
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
      if (event.key === "[") { event.preventDefault(); navHistory("back"); return; }
      if (event.key === "]") { event.preventDefault(); navHistory("forward"); return; }
      if (!isTauri() && ["f", ","].includes(event.key.toLowerCase())) {
        event.preventDefault();
        event.stopImmediatePropagation();
        navigate(event.key === "," ? "settings" : "find");
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      void listening?.then(unlisten => unlisten());
    };
  }, []);
  const handleSidebarToggle = () => {
    if (theater) {
      setTheater(false);
      if (collapsed) onToggle();
    } else {
      onToggle();
    }
  };
  const sidebarExpanded = !collapsed && !theater;
  return <header className={'mac-toolbar' + (theater ? ' theater' : '')} data-tauri-drag-region>
    <button aria-label={sidebarExpanded ? "收起侧栏" : "展开侧栏"}
      title={theater ? "退出影院模式并显示侧栏 (T)" : sidebarExpanded ? "收起侧栏" : "展开侧栏"}
      onClick={handleSidebarToggle}><ISidebar size={17} /></button>
    <button aria-label="后退" title="后退 (⌘[)" disabled={!canGoBack} onClick={() => travel(-1)}><IBack size={17} /></button>
    <button aria-label="前进" title="前进 (⌘])" disabled={!canGoForward} onClick={() => travel(1)}><IChevR size={17} /></button>
    <strong className="truncate" data-tauri-drag-region>{title}</strong>
    <div className="flex-1 h-full" data-tauri-drag-region />
    <button aria-label="切换外观" title="切换深浅外观" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <ISun size={16} /> : <IMoon size={16} />}</button>
    <button className="mac-search" title="搜索 (⌘F)" onClick={search}><ISearch size={14} />搜索<kbd>⌘F</kbd></button>
  </header>;
}

export function DesktopRail({ collapsed }: { collapsed: boolean }) {
  const { platform, setTab, bumpHomeRefresh, setLoginOpen, push } = useStoreActions();
  const { tab, stack } = useNavState();
  const user = useSessionUser();
  /* 从侧栏进入的栈页（排行榜 / 设置）接管高亮，否则「我的」会一直亮着，看起来不像独立页面 */
  const top = stack[stack.length - 1];
  const railPage: "ranks" | "settings" | null =
    top?.kind === "settings" ? "settings" : top?.kind === "ranks" ? "ranks" : null;
  const onTab = (key: Tab | "search") => !railPage && tab === key;
  const items: { key: Tab; label: string; shortcut: string; Icon: typeof IHome; Filled: typeof IHomeF }[] = [
    { key: "home", label: "首页", shortcut: "1", Icon: IHome, Filled: IHomeF },
    { key: "category", label: "分类", shortcut: "3", Icon: IGrid, Filled: IGridF },
    { key: "profile", label: "我的", shortcut: "4", Icon: IUser, Filled: IUserF },
  ];
  return (
    <nav className={`win-sidebar ${collapsed ? "is-compact" : ""}`} aria-label="主导航" data-tauri-drag-region={platform === "macos" ? "" : undefined}>
      <div className="win-sidebar-inner">
        {platform === "macos" ? <div className="mac-brand" data-tauri-drag-region><Logo size={26} /><strong>HGhub</strong></div> : <button className={`win-search-launch ${onTab("search") ? "is-selected" : ""}`}
          onClick={() => setTab("search")} aria-label="搜索" title="搜索 (/)">
          <ISearch size={19} strokeWidth={1.7} />
          <span className="win-nav-copy">搜索你感兴趣的</span>
          <kbd className="win-nav-key">/</kbd>
        </button>}
        <div className="win-nav-items">
          {platform === "macos" && <small className="mac-group">资料库</small>}
          {items.map(({ key, label, shortcut, Icon, Filled }) => (
            <button key={key} aria-label={label} title={`${label} (${shortcut})`} aria-current={onTab(key) ? "page" : undefined}
              className={`win-nav-item ${onTab(key) ? "is-selected" : ""}`}
              onClick={() => {
                if (key === "home" && onTab("home") && stack.length === 0) bumpHomeRefresh();
                else setTab(key);
              }}>
              <span className="win-nav-symbol">{onTab(key) ? <Filled size={21} /> : <Icon size={21} strokeWidth={1.7} />}</span>
              <span className="win-nav-copy">{label}</span>
            </button>
          ))}
          <button aria-label="排行榜" title="排行榜" className={`win-nav-item ${railPage === "ranks" ? "is-selected" : ""}`}
            aria-current={railPage === "ranks" ? "page" : undefined}
            onClick={() => { if (railPage !== "ranks") push({ kind: "ranks" }); }}>
            <span className="win-nav-symbol"><ITrophy size={21} strokeWidth={1.7} /></span>
            <span className="win-nav-copy">排行榜</span>
          </button>
          {platform === "macos" && <small className="mac-group">应用</small>}
          <button aria-label="设置" title={platform === "macos" ? "设置 (⌘,)" : "设置"} className={`win-nav-item ${railPage === "settings" ? "is-selected" : ""}`}
            aria-current={railPage === "settings" ? "page" : undefined}
            onClick={() => { if (railPage !== "settings") push({ kind: "settings" }); }}>
            <span className="win-nav-symbol"><ISettings size={21} strokeWidth={1.7} /></span>
            <span className="win-nav-copy">设置</span>
          </button>
        </div>
        <div className="win-sidebar-bottom">
          <button className="win-account" aria-label={user?.nickname || "登录 HGhub"} title={user?.nickname || "登录 HGhub"} onClick={() => { setTab("profile"); if (!user) setLoginOpen(true); }}>
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