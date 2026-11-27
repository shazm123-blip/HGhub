import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore, type Page, type Tab } from "./store";
import { isMobile, selfTest } from "./api";
import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { hasBackHandler, isPlaybackLocked, runBack } from "./back";
import IosBackEdge from "./components/IosBackEdge";
import { IClose, IGrid, IGridF, IHome, IHomeF, IKeyboard, ISearch, IUser, IUserF } from "./icons";
import Home from "./pages/Home";
import Feed from "./components/Feed";
import LoginModal from "./components/LoginModal";
import LinePicker from "./components/LinePicker";
import { Modal, ToastHost } from "./components/ui";
import { DesktopRail, DesktopTitleBar, MacToolbar } from "./components/DesktopChrome";
import ResizeHandles from "./components/ResizeHandles";
import { tracePlayback } from "./playbackDiagnostics";

const Search = lazy(() => import("./pages/Search"));
const RankPage = lazy(() => import("./pages/Search").then((m) => ({ default: m.RankPage })));
const Category = lazy(() => import("./pages/Category"));
const ChannelPage = lazy(() => import("./pages/Category").then((m) => ({ default: m.ChannelPage })));
const Profile = lazy(() => import("./pages/Profile"));
const SettingsPage = lazy(() => import("./pages/Settings"));
const PostsPage = lazy(() => import("./pages/Posts").then((m) => ({ default: m.PostsPage })));
const PostDetail = lazy(() => import("./pages/Posts").then((m) => ({ default: m.PostDetail })));

/* ============ 底部标签栏（Android）—— 细瘦纯文字、低侵入 ============ */
function TabBar() {
  const { tab, setTab, stack, bumpHomeRefresh, theme, platform } = useStore();
  const pickTab = (k: Tab) => {
    if (k === "home" && tab === "home" && stack.length === 0) bumpHomeRefresh();
    else setTab(k);
  };
  const items: { k: Tab; label: string }[] = [
    { k: "home", label: "首页" },
    { k: "search", label: "搜索" },
    { k: "category", label: "分类" },
    { k: "profile", label: "我的" },
  ];
  const icons = { home: [IHome, IHomeF], search: [ISearch, ISearch], category: [IGrid, IGridF], profile: [IUser, IUserF] };
  /* 首页是沉浸视频 → 底栏压深色；搜索/分类/我的 是常规内容页 → 跟随主题外观。 */
  const overVideo = tab === "home";
  const lightBar = !overVideo && theme === "light";
  if (platform === "ios") {
    return <nav aria-label="主导航" className={`hg-tabbar ios-tabbar ${overVideo ? "mat-chrome" : "mat"}`}>
      {items.map(({ k, label }) => {
        const selected = k === tab;
        const Icon = icons[k][selected ? 1 : 0];
        return <button key={k} aria-current={selected ? "page" : undefined} onClick={() => pickTab(k)}>
          <Icon size={23} /><span>{label}</span>
        </button>;
      })}
    </nav>;
  }
  return (
    <nav aria-label="主导航" className="hg-tabbar absolute bottom-0 inset-x-0 z-30"
      style={{
        paddingBottom: "var(--sab, 0px)",
        background: lightBar ? "rgba(250, 250, 250, .97)" : overVideo ? "rgba(8, 8, 10, .94)" : "#141414",
        borderTop: lightBar ? "1px solid rgba(0,0,0,.08)" : overVideo ? "1px solid rgba(255,255,255,.06)" : "1px solid rgba(255,255,255,.07)",
        boxShadow: lightBar ? "0 -2px 14px rgba(0,0,0,.05)" : "none",
      }}>
      <div className="h-[50px] flex items-center px-1">
        {items.map(({ k, label }) => {
          const on = tab === k;
          const Icon = icons[k][on ? 1 : 0];
          const color = lightBar
            ? (on ? "var(--p-primary)" : "rgba(0,0,0,.5)")
            : (on ? "#ffffff" : "rgba(255,255,255,.6)");
          return (
            <button key={k} aria-current={on ? "page" : undefined} onClick={() => pickTab(k)}
              className="flex-1 h-full flex flex-col items-center justify-center gap-0.5 pressable"
              style={{ color }}>
              <Icon size={20} strokeWidth={on ? 2.1 : 1.75} />
              <span className="text-[10.5px] leading-none transition-colors duration-200"
                style={{ fontWeight: on ? 700 : 500 }}>
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/* ============ 堆栈页面 ============ */
function StackPage({ page, onBack, wide, top, bottomInset }: {
  page: Page; onBack: () => void; wide: boolean; top: boolean; bottomInset: number;
}) {
  if (page.kind === "feed") {
    return (
      <Feed videoIds={page.videoIds} startIndex={page.index} title={page.title} kind={page.feedKind || "video"}
        startEp={page.startEp} startTime={page.startTime} initialCovers={page.covers}
        mode="context" active={top} bottomInset={bottomInset} onBack={onBack} />
    );
  }
  if (page.kind === "channel") return <ChannelPage cate={page.cate} name={page.name} onBack={onBack} wide={wide} />;
  if (page.kind === "ranks") return <RankPage onBack={onBack} wide={wide} />;
  if (page.kind === "settings") return <SettingsPage onBack={onBack} wide={wide} />;
  if (page.kind === "posts") return <PostsPage onBack={onBack} wide={wide} />;
  if (page.kind === "post") return <PostDetail id={page.id} onBack={onBack} active={top} />;
  return null;
}

/* ============ 统一主视口（桌面 / 移动共用） ============ */
function MainViewport({ collapsed, theater }: { collapsed: boolean; theater: boolean }) {
  const { platform, tab, setTab, stack, pop, loginOpen, setLoginOpen, linePickerOpen, shortcutsOpen, setShortcutsOpen, fs } = useStore();
  const mainRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(!isMobile);
  const [visitedTabs, setVisitedTabs] = useState<Record<Tab, boolean>>(() => ({
    home: true, search: tab === "search", category: tab === "category", profile: tab === "profile",
  }));
  useEffect(() => {
    setVisitedTabs((prev) => (prev[tab] ? prev : { ...prev, [tab]: true }));
  }, [tab]);

  const prevStackRef = useRef<Page[]>(stack);
  const [exitingPage, setExitingPage] = useState<Page | null>(null);
  const exitTimerRef = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const prev = prevStackRef.current;
    prevStackRef.current = stack;
    if (stack.length < prev.length) {
      const popped = prev[prev.length - 1];
      const reduceMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (popped && !reduceMotion) {
        window.clearTimeout(exitTimerRef.current);
        setExitingPage(popped);
        exitTimerRef.current = window.setTimeout(() => {
          exitTimerRef.current = undefined;
          setExitingPage(null);
        }, 210);
      }
    } else if (stack.length > prev.length) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = undefined;
      setExitingPage(null);
    }
  }, [stack]);
  useEffect(() => () => window.clearTimeout(exitTimerRef.current), []);

  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth > 640));
    ro.observe(el);
    setWide(el.clientWidth > 640);
    return () => ro.disconnect();
  }, []);

  /* 全局键盘 */
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (isPlaybackLocked()) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        if (runBack()) return;
        if (loginOpen) { setLoginOpen(false); return; }
        if (stack.length) pop();
        return;
      }
      if (loginOpen || linePickerOpen || shortcutsOpen || hasBackHandler()) return;
      if (e.key === "?" && !isMobile) { e.preventDefault(); setShortcutsOpen(true); return; }
      if (e.key === "/") { e.preventDefault(); setTab("search"); return; }
      if (["1", "2", "3", "4"].includes(e.key) && !e.repeat) {
        setTab((["home", "search", "category", "profile"] as Tab[])[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [stack.length, pop, setTab, loginOpen, setLoginOpen, linePickerOpen, shortcutsOpen, setShortcutsOpen]);

  const vis = (k: Tab) => (tab === k ? "absolute inset-0" : "absolute inset-0 invisible pointer-events-none tab-hidden");
  const modalBlocking = loginOpen || linePickerOpen || shortcutsOpen;
  const pageActive = stack.length === 0 && !modalBlocking;
  const bottomInset = isMobile ? (fs ? 0 : platform === "ios" ? 49 : 50) : 14;
  /* 栈页（从搜索/分类/我的进入的播放页、图文页）没有底栏，底部只让出安全区。 */
  const stackInset = isMobile ? 0 : 14;

  const tabFallback = <div className="absolute inset-0 bg-bg flex items-center justify-center"><div className="w-8 h-8 spinner" /></div>;

  return (
    <div className={`absolute inset-0 flex bg-canvas plat-${platform}`}>
      {!isMobile && platform !== "macos" && !theater && <DesktopRail collapsed={collapsed} />}
      <div ref={mainRef} className={`relative flex-1 min-w-0 overflow-hidden win-main ${!isMobile && theater ? "is-theater-main" : ""}`}>
        <div data-tab className={vis("home")}><Home active={pageActive && tab === "home"} bottomInset={bottomInset} /></div>
        <div data-tab className={vis("search")}>
          {(visitedTabs.search || tab === "search") && (
            <Suspense fallback={tabFallback}><Search active={pageActive && tab === "search"} wide={wide} /></Suspense>
          )}
        </div>
        <div data-tab className={vis("category")}>
          {(visitedTabs.category || tab === "category") && (
            <Suspense fallback={tabFallback}><Category wide={wide} active={pageActive && tab === "category"} /></Suspense>
          )}
        </div>
        <div data-tab className={vis("profile")}>
          {(visitedTabs.profile || tab === "profile") && (
            <Suspense fallback={tabFallback}><Profile wide={wide} active={pageActive && tab === "profile"} /></Suspense>
          )}
        </div>

        {exitingPage && (
          <div data-stack-exiting key={`exit-${exitingPage.key}`}
            className={`absolute inset-0 z-30 bg-bg pointer-events-none ${isMobile ? "a-page-out" : "win-page-out"}`}
            style={{ boxShadow: "var(--p-stack-shadow)" }}>
            <Suspense fallback={null}>
              <StackPage page={exitingPage} onBack={() => {}} wide={wide} top={false} bottomInset={stackInset} />
            </Suspense>
          </div>
        )}

        {stack.map((p, i) => (
          <div data-stack key={p.key} className={`absolute inset-0 z-30 bg-bg ${isMobile ? "a-page-in" : "win-page-in"}`} style={{ boxShadow: "var(--p-stack-shadow)" }}>
            <Suspense fallback={<div className="absolute inset-0 bg-bg flex items-center justify-center"><div className="w-8 h-8 spinner" /></div>}>
              <StackPage page={p} onBack={pop} wide={wide} top={i === stack.length - 1 && !modalBlocking} bottomInset={stackInset} />
            </Suspense>
            {platform === "ios" && i === stack.length - 1 && !modalBlocking && !fs && <IosBackEdge onBack={pop} />}
          </div>
        ))}

        {isMobile && !fs && stack.length === 0 && <TabBar />}
      </div>
    </div>
  );
}

/* ============ 桌面窗口壳（Windows / macOS / Linux）============ */
function DesktopShell() {
  const [collapsed, setCollapsed] = useState(false);
  const { theater, platform } = useStore();
  if (platform === "macos") return (
    <div className="absolute inset-0 flex mac-window">
      {!theater && <DesktopRail collapsed={collapsed} />}
      <div className="min-w-0 flex-1 flex flex-col">
        <MacToolbar collapsed={collapsed} theater={theater} onToggle={() => setCollapsed(c => !c)} />
        <div className="relative flex-1 min-h-0"><MainViewport collapsed={collapsed} theater={theater} /></div>
      </div>
    </div>
  );
  return (
    <div className={`absolute inset-0 flex flex-col bg-canvas win-root plat-${platform}`}>
      <DesktopTitleBar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <div className="relative flex-1 min-h-0">
        <MainViewport collapsed={collapsed || theater} theater={theater} />
      </div>
      {/* 边缘缩放热区用于无边框窗口（Windows / Linux），macOS 走原生窗口边框 */}
      {(platform === "windows" || platform === "linux") && <ResizeHandles />}
    </div>
  );
}

/* ============ 移动端（无壳） ============ */
function MobileShell() {
  const { platform, fs } = useStore();
  return (
    <div className={`fixed inset-0 flex flex-col bg-canvas plat-${platform}`}
      style={fs ? undefined : { paddingLeft: "var(--sal, 0px)", paddingRight: "var(--sar, 0px)" }}>
      <div className="relative flex-1 min-h-0">
        <MainViewport collapsed={false} theater={false} />
      </div>
    </div>
  );
}

/* ============ 快捷键速查弹窗 ============ */
function ShortcutsModal() {
  const { shortcutsOpen, setShortcutsOpen, platform } = useStore();
  const rows: [string, string][] = [
    ["Space", "播放 / 暂停"],
    ["↑ / ↓", "上一个 / 下一个视频"],
    ["← / →", "快退 / 快进 5 秒"],
    ["N / P", "下一集 / 上一集"],
    ["F / Esc", "进入 / 退出全屏"],
    ["T", "影院模式"],
    ["M", "静音切换"],
    ["L / S", "喜欢 / 收藏"],
    ["C / E", "评论面板 / 选集面板"],
    ["1 ~ 4 / /", "切换导航标签 / 搜索"],
    ...(platform === "macos" ? [["⌘[ / ⌘]", "后退 / 前进"] as [string, string], ["⌘F / ⌘,", "搜索 / 设置"] as [string, string]] : []),
    ["?", "显示本快捷键说明"],
  ];
  return (
    <Modal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} width={380}>
      <div className="p-5">
        <div className="flex items-center gap-2 mb-3">
          <span className="shrink-0 w-8 h-8 rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center"><IKeyboard size={17} /></span>
          <span className="text-[15px] font-bold text-on">键盘快捷键</span>
          <button onClick={() => setShortcutsOpen(false)} aria-label="关闭"
            className="ml-auto w-7 h-7 rounded-full bg-s4 flex items-center justify-center text-mut pressable">
            <IClose size={13} />
          </button>
        </div>
        <div className="divide-y divide-s4/60">
          {rows.map(([k, desc]) => (
            <div key={k} className="flex items-center justify-between py-2 text-[12px]">
              <span className="text-on/85">{desc}</span>
              <kbd className="px-2 py-0.5 rounded bg-s4 text-[11px] font-semibold text-primary tabular-nums">{k}</kbd>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/* ============ 入口 ============ */
export default function App() {
  const { platform, loginOpen, setLoginOpen, linePickerOpen, setLinePickerOpen, shortcutsOpen, setShortcutsOpen, tab, setTab, stack, pop, fs, setFs, toast } = useStore();
  const lastBackExitRef = useRef(0);
  useEffect(() => {
    tracePlayback("navigation.change", { tab, stack: stack.map(p => ({ page: p.kind, key: p.key })), login_open: loginOpen });
  }, [tab, stack, loginOpen]);

  /* —— 安卓硬件返回键 ——
     层级：播放锁拦截 → 全屏 → 面板/弹层 → 线路/登录框 → 页面栈 → 回首页 → 双击退出应用。
     不注册这个监听，Tauri 会直接 webView.goBack() 或退出，表现就是「任意页面返回都回桌面」。 */
  const backRef = useRef<() => void>(() => {});
  backRef.current = () => {
    if (isPlaybackLocked()) { toast("屏幕已锁定，请点击右侧锁图标解锁", "info"); return; }
    if (fs) { setFs(false); return; }                        // 沉浸全屏
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    if (runBack()) return;                                  // 播放器的选集/评论/图文面板
    if (shortcutsOpen) { setShortcutsOpen(false); return; }
    if (linePickerOpen) { setLinePickerOpen(false); return; }
    if (loginOpen) { setLoginOpen(false); return; }
    if (stack.length) { pop(); return; }
    if (tab !== "home") { setTab("home"); return; }
    const now = Date.now();
    if (now - lastBackExitRef.current < 2000) {
      invoke("plugin:app|exit", { code: 0 }).catch(() => {});
    } else {
      lastBackExitRef.current = now;
      toast("再按一次退出应用", "info");
    }
  };

  useEffect(() => {
    if (platform !== "android") return undefined;
    let disposed = false;
    let handle: { unregister: () => Promise<void> } | null = null;
    addPluginListener("app", "back-button", () => backRef.current())
      .then((l) => { if (disposed) l.unregister().catch(() => {}); else handle = l; })
      .catch(() => { /* 非安卓宿主忽略 */ });
    return () => {
      disposed = true;
      handle?.unregister().catch(() => {});
    };
  }, [platform]);

  useEffect(() => {
    const prevent = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true'], .article-body, .select-text")) return;
      const sel = window.getSelection()?.toString();
      if (sel && sel.trim().length > 0) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", prevent);
    return () => document.removeEventListener("contextmenu", prevent);
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const t = window.setTimeout(() => {
      selfTest().then((r) => { invoke("debug_log", { msg: r }).catch(() => {}); }).catch(() => {});
    }, 2500);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div className={`fixed inset-0 plat-${platform}`}>
      {isMobile ? <MobileShell /> : <DesktopShell />}
      <LoginModal />
      <LinePicker open={linePickerOpen} onClose={() => setLinePickerOpen(false)} />
      <ShortcutsModal />
      <ToastHost />
    </div>
  );
}
