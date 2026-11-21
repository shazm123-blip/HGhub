import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api, platform as envPlatform, setApiBase } from "./api";
import { isStrictSecurity, setStrictSecurity as setHtmlStrictSecurity } from "./html";
import type { FollowAuthor, User, VideoOrientationMeta, VideoSnapshot } from "./types";

export type Platform = "android" | "ios" | "windows" | "macos" | "linux";
export type Theme = "dark" | "light";
/** 外观偏好：system 跟随系统（Apple 平台默认） */
export type ThemePref = Theme | "system";
export type Tab = "home" | "search" | "category" | "profile";

/** 播放页上下文：ids 是来源列表，index 是当前条目。 */
export type FeedContext = {
  kind: "feed";
  key: string;
  videoIds: number[];
  index: number;
  title: string;
  source: string;
  feedKind?: "video" | "post";
  /** 从观看记录续播：起始集数与秒数 */
  startEp?: number;
  startTime?: number;
  covers?: Record<number, string>;
};

export type Page =
  | FeedContext
  | { kind: "channel"; key: string; cate: string; name: string }
  | { kind: "ranks"; key: string }
  | { kind: "settings"; key: string }
  | { kind: "posts"; key: string }
  | { kind: "post"; key: string; id: number };

export type PageInput =
  | { kind: "feed"; videoIds: number[]; index: number; title: string; source?: string; feedKind?: "video" | "post"; startEp?: number; startTime?: number; covers?: Record<number, string> }
  | { kind: "channel"; cate: string; name: string }
  | { kind: "ranks" }
  | { kind: "settings" }
  | { kind: "posts" }
  | { kind: "post"; id: number };

export type Toast = { id: number; msg: string; icon?: "ok" | "heart" | "star" | "info" };

/** 观看记录：看到第几集、第几秒（`dur` 用来判断是否已看完） */
export type WatchProgress = { id: number; ep: number; t: number; dur: number; at: number };

const MAX_SNAPSHOTS = 120;
const MAX_ORIENTATIONS = 300;

type Persist = {
  likes: number[];
  favs: number[];
  history: WatchProgress[];
  follows: number[];
  followAuthors: Record<number, FollowAuthor>;
  videoSnapshots: Record<number, VideoSnapshot>;
  videoOrientations: Record<number, VideoOrientationMeta>;
  landscapeFitPref: "contain" | "cover";
  muted: boolean;
  muteOnStartup: boolean;
  volume: number;
  searchHist: string[];
};

const LS = "hghub_app_v1";
const DEFAULTS: Persist = {
  likes: [], favs: [], history: [], follows: [],
  followAuthors: {},
  videoSnapshots: {},
  videoOrientations: {},
  landscapeFitPref: "contain",
  muted: true, muteOnStartup: true, volume: 0.7, searchHist: [],
};

/** 旧版本 history 是 number[]，读出来时升级成带进度的结构 */
function normalizeHistory(raw: unknown): WatchProgress[] {
  if (!Array.isArray(raw)) return [];
  const out: WatchProgress[] = [];
  raw.forEach((item, i) => {
    if (typeof item === "number") {
      out.push({ id: item, ep: 1, t: 0, dur: 0, at: Date.now() - i });
      return;
    }
    const h = item as Partial<WatchProgress> | null;
    if (h && typeof h.id === "number") {
      out.push({ id: h.id, ep: Number(h.ep) || 1, t: Number(h.t) || 0, dur: Number(h.dur) || 0, at: Number(h.at) || Date.now() - i });
    }
  });
  return out;
}

function loadPersist(): Persist {
  try {
    const raw = localStorage.getItem(LS);
    if (!raw) return DEFAULTS;
    const p = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Persist>) };
    // 只在启动时应用；本次使用中取消静音不会关闭此偏好。
    const muteOnStartup = p.muteOnStartup !== false;
    return {
      ...p,
      followAuthors: p.followAuthors && typeof p.followAuthors === "object" ? p.followAuthors : {},
      videoSnapshots: p.videoSnapshots && typeof p.videoSnapshots === "object" ? p.videoSnapshots : {},
      videoOrientations: p.videoOrientations && typeof p.videoOrientations === "object" ? p.videoOrientations : {},
      landscapeFitPref: p.landscapeFitPref === "cover" ? "cover" : "contain",
      muteOnStartup,
      muted: muteOnStartup || p.muted === true,
      history: normalizeHistory(p.history),
    };
  } catch {
    return DEFAULTS;
  }
}

const isApple = envPlatform === "ios" || envPlatform === "macos";
const darkQuery = typeof window !== "undefined" && window.matchMedia
  ? window.matchMedia("(prefers-color-scheme: dark)") : null;
const systemTheme = (): Theme => (darkQuery && !darkQuery.matches ? "light" : "dark");

/* 新键 hghub_theme_pref 记偏好；旧键 hghub_theme 只记实际外观（旧版每次启动都会写入，
   无法区分是否手动选过），所以 Apple 平台没有新键时一律按「跟随系统」处理。 */
function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem("hghub_theme_pref");
    if (v === "light" || v === "dark" || v === "system") return v;
    if (isApple) return "system";
    return localStorage.getItem("hghub_theme") === "light" ? "light" : "dark";
  } catch {
    return isApple ? "system" : "dark";
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("theme-light", theme === "light");
  document.documentElement.style.colorScheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--p-canvas").trim();
  if (meta) meta.setAttribute("content", bg || (theme === "light" ? "#f9f9f9" : "#1a1a1a"));
}

type Store = {
  platform: Platform;
  /** 实际生效的外观（已解析「跟随系统」） */
  theme: Theme; setTheme: (t: Theme) => void;
  themePref: ThemePref; setThemePref: (t: ThemePref) => void;
  tab: Tab; setTab: (t: Tab) => void;
  canGoBack: boolean; canGoForward: boolean; travel: (offset: -1 | 1) => void;
  stack: Page[]; push: (p: PageInput) => void; pop: () => void;
  user: User | null; setUser: (u: User | null) => void;
  mergeUserInteractions: (u: User | null) => void;
  loginOpen: boolean; setLoginOpen: (b: boolean) => void;
  linePickerOpen: boolean; setLinePickerOpen: (b: boolean) => void;
  shortcutsOpen: boolean; setShortcutsOpen: (b: boolean) => void;
  logout: () => Promise<void>;
  likes: number[]; favs: number[]; history: WatchProgress[]; follows: number[];
  followAuthors: Record<number, FollowAuthor>;
  videoSnapshots: Record<number, VideoSnapshot>;
  upsertVideoSnapshot: (snap: Omit<VideoSnapshot, "updatedAt">) => void;
  recordVideoOrientation: (id: number, w: number, h: number) => void;
  getVideoOrientation: (id: number) => VideoOrientationMeta | undefined;
  landscapeFitPref: "contain" | "cover";
  setLandscapeFitPref: (fit: "contain" | "cover") => void;
  isLiked: (id: number) => boolean; isFav: (id: number) => boolean;
  toggleLikeLocal: (id: number) => boolean;
  toggleFavLocal: (id: number) => boolean;
  removeFav: (id: number) => void;
  removeLike: (id: number) => void;
  removeHistory: (id: number) => void;
  /** 记一条观看记录；`ep/t/dur` 省略时保留原进度，`ep` 变了就把进度归零 */
  addHistory: (id: number, ep?: number, t?: number, dur?: number) => void;
  clearHistory: () => void;
  toggleFollowLocal: (uid: number, author?: { name: string; avatar?: string }) => boolean;
  theater: boolean; setTheater: (v: boolean | ((p: boolean) => boolean)) => void;
  fs: boolean; setFs: (v: boolean | ((p: boolean) => boolean)) => void;
  muted: boolean; setMuted: (v: boolean | ((p: boolean) => boolean)) => void;
  muteOnStartup: boolean; setMuteOnStartup: (on: boolean) => void;
  volume: number; setVolume: (v: number) => void;
  searchHist: string[]; addSearch: (q: string) => void; removeSearchHist: (q: string) => void; clearSearchHist: () => void;
  strictSecurity: boolean; strictSecurityReady: boolean; securityPending: boolean; cliRelaxed: boolean; setStrictSecurity: (on: boolean) => Promise<void>;
  lineVersion: number; bumpLineVersion: () => void;
  homeRefresh: number; bumpHomeRefresh: () => void;
  toasts: Toast[]; toast: (msg: string, icon?: Toast["icon"]) => void;
};

const Ctx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(Ctx);
let seq = 0;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [p, setP] = useState<Persist>(loadPersist);
  const pRef = useRef(p);
  pRef.current = p;
  const [themePref, setThemePref] = useState<ThemePref>(readThemePref);
  const [sysTheme, setSysTheme] = useState<Theme>(systemTheme);
  const theme: Theme = themePref === "system" ? sysTheme : themePref;
  const setTheme = useCallback((t: Theme) => setThemePref(t), []);
  type Destination = { tab: Tab; stack: Page[] };
  const [navigation, setNavigation] = useState<{ entries: Destination[]; index: number }>({
    entries: [{ tab: "home", stack: [] }], index: 0,
  });
  const { tab, stack } = navigation.entries[navigation.index];
  const [user, setUser] = useState<User | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [linePickerOpen, setLinePickerOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theater, setTheaterState] = useState(false);
  const [fs, setFsState] = useState(false);
  const [strictSecurity, setStrictSecurityState] = useState<boolean>(isStrictSecurity);
  const [cliRelaxed, setCliRelaxed] = useState(false);
  const [strictSecurityReady, setStrictSecurityReady] = useState(false);
  const [securityPending, setSecurityPending] = useState(false);
  const [lineVersion, setLineVersion] = useState(0);
  const [homeRefresh, setHomeRefresh] = useState(0);
  const toastSeq = useRef(0);
  const bumpLineVersion = useCallback(() => setLineVersion((v) => v + 1), []);
  const bumpHomeRefresh = useCallback(() => setHomeRefresh((v) => v + 1), []);

  useEffect(() => {
    if (!darkQuery) return undefined;
    const fn = () => setSysTheme(systemTheme());
    darkQuery.addEventListener("change", fn);
    return () => darkQuery.removeEventListener("change", fn);
  }, []);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem("hghub_theme", theme);
      localStorage.setItem("hghub_theme_pref", themePref);
    } catch { /* ignore */ }
  }, [theme, themePref]);

  useEffect(() => {
    try { localStorage.setItem(LS, JSON.stringify(p)); } catch { /* ignore */ }
  }, [p]);

  const mergeUserInteractions = useCallback((u: User | null) => {
    const inter = u?.interactions;
    if (!inter) return;
    const srvLikes = Array.isArray(inter.like_video_ids) ? inter.like_video_ids.filter((x) => typeof x === "number") : [];
    const srvFavs = Array.isArray(inter.favorite_video_ids) ? inter.favorite_video_ids.filter((x) => typeof x === "number") : [];
    const srvFollows = Array.isArray(inter.follow_user_ids) ? inter.follow_user_ids.filter((x) => typeof x === "number") : [];
    if (!srvLikes.length && !srvFavs.length && !srvFollows.length) return;
    setP((s) => {
      const mergeIds = (local: number[], incoming: number[]) => {
        if (!incoming.length) return local;
        const seen = new Set(local);
        const added = incoming.filter((id) => !seen.has(id));
        return added.length ? [...local, ...added] : local;
      };
      const likes = mergeIds(s.likes, srvLikes);
      const favs = mergeIds(s.favs, srvFavs);
      const follows = mergeIds(s.follows, srvFollows);
      if (likes === s.likes && favs === s.favs && follows === s.follows) return s;
      const next = { ...s, likes, favs, follows };
      pRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    api.boot()
      .then((r) => {
        if (r.base) setApiBase(r.base);
        if (r.user && (r.user as User).id) {
          const u = r.user as User;
          setUser(u);
          mergeUserInteractions(u);
        }
        if (typeof r.strict_security === "boolean") {
          setStrictSecurityState(r.strict_security);
          setHtmlStrictSecurity(r.strict_security);
          setStrictSecurityReady(true);
        }
        setCliRelaxed(!!r.cli_relaxed);
      })
      .catch(() => { /* 离线也能用 */ });
  }, [mergeUserInteractions]);

  const setStrictSecurity = useCallback(async (on: boolean) => {
    if (!strictSecurityReady) throw new Error("安全设置尚未读取，请重新启动应用");
    setSecurityPending(true);
    try {
      const saved = await api.securitySet(on);
      setHtmlStrictSecurity(saved);
      setStrictSecurityState(saved);
    } finally {
      setSecurityPending(false);
    }
  }, [strictSecurityReady]);

  const toast = useCallback((msg: string, icon?: Toast["icon"]) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t.slice(-2), { id, msg, icon }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2200);
  }, []);

  const setFs = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setFsState((prev) => {
      const next = typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v;
      if (!next) {
        invoke("set_orientation", { landscape: false }).catch(() => {});
        try { screen.orientation?.unlock?.(); } catch { /* ignore */ }
      }
      return next;
    });
  }, []);

  const syncTheaterForDest = useCallback((dest: Destination) => {
    const top = dest.stack[dest.stack.length - 1];
    const isPlayer = top ? top.kind === "feed" : dest.tab === "home";
    if (!isPlayer) setTheaterState(false);
  }, []);

  const navigate = useCallback((update: (current: Destination) => Destination) => {
    setFs(false);
    setNavigation(previous => {
      const current = previous.entries[previous.index];
      const next = update(current);
      if (current === next) return previous;
      syncTheaterForDest(next);
      if (envPlatform !== "macos") return { entries: [next], index: 0 };
      const entries = [...previous.entries.slice(Math.max(0, previous.index - 48), previous.index + 1), next];
      return { entries, index: entries.length - 1 };
    });
  }, [setFs, syncTheaterForDest]);
  const setTab = useCallback((tab: Tab) => navigate(current =>
    current.tab === tab && !current.stack.length ? current : { tab, stack: [] }), [navigate]);
  const push = useCallback((pg: PageInput) => {
    const page = { ...pg, key: `p${++seq}` } as Page;
    navigate(current => ({ ...current, stack: [...current.stack, page] }));
  }, [navigate]);
  const travel = useCallback((offset: -1 | 1) => {
    setFs(false);
    setNavigation(previous => {
      const index = Math.max(0, Math.min(previous.index + offset, previous.entries.length - 1));
      const next = previous.entries[index];
      if (next) syncTheaterForDest(next);
      return { ...previous, index };
    });
  }, [setFs, syncTheaterForDest]);
  const pop = useCallback(() => {
    if (envPlatform === "macos" && navigation.index > 0) travel(-1);
    else navigate(current => ({ ...current, stack: current.stack.slice(0, -1) }));
  }, [navigate, navigation.index, travel]);

  const toggleLikeLocal = useCallback((id: number) => {
    const on = !pRef.current.likes.includes(id);
    pRef.current = {
      ...pRef.current,
      likes: on ? [id, ...pRef.current.likes] : pRef.current.likes.filter((x) => x !== id),
    };
    setP((s) => {
      const has = s.likes.includes(id);
      if (on === has) return s;
      return { ...s, likes: on ? [id, ...s.likes] : s.likes.filter((x) => x !== id) };
    });
    return on;
  }, []);
  const toggleFavLocal = useCallback((id: number) => {
    const on = !pRef.current.favs.includes(id);
    pRef.current = {
      ...pRef.current,
      favs: on ? [id, ...pRef.current.favs] : pRef.current.favs.filter((x) => x !== id),
    };
    setP((s) => {
      const has = s.favs.includes(id);
      if (on === has) return s;
      return { ...s, favs: on ? [id, ...s.favs] : s.favs.filter((x) => x !== id) };
    });
    return on;
  }, []);
  const toggleFollowLocal = useCallback((uid: number, author?: { name: string; avatar?: string }) => {
    const on = !pRef.current.follows.includes(uid);
    const nextAuthors = { ...pRef.current.followAuthors };
    if (on && author?.name) nextAuthors[uid] = { id: uid, name: author.name, avatar: author.avatar };
    else if (!on) delete nextAuthors[uid];
    pRef.current = {
      ...pRef.current,
      follows: on ? [uid, ...pRef.current.follows] : pRef.current.follows.filter((x) => x !== uid),
      followAuthors: nextAuthors,
    };
    setP((s) => {
      const has = s.follows.includes(uid);
      const authors = { ...s.followAuthors };
      if (on && author?.name) authors[uid] = { id: uid, name: author.name, avatar: author.avatar };
      else if (!on) delete authors[uid];
      if (on === has && (!on || !author?.name)) return s;
      return { ...s, follows: on ? (has ? s.follows : [uid, ...s.follows]) : s.follows.filter((x) => x !== uid), followAuthors: authors };
    });
    return on;
  }, []);
  const removeFav = useCallback((id: number) => {
    pRef.current = { ...pRef.current, favs: pRef.current.favs.filter((x) => x !== id) };
    setP((s) => ({ ...s, favs: s.favs.filter((x) => x !== id) }));
  }, []);
  const removeLike = useCallback((id: number) => {
    pRef.current = { ...pRef.current, likes: pRef.current.likes.filter((x) => x !== id) };
    setP((s) => ({ ...s, likes: s.likes.filter((x) => x !== id) }));
  }, []);
  const removeHistory = useCallback((id: number) => {
    setP((s) => ({ ...s, history: s.history.filter((x) => x.id !== id) }));
  }, []);
  const upsertVideoSnapshot = useCallback((snap: Omit<VideoSnapshot, "updatedAt">) => {
    if (!snap.id || !snap.title) return;
    setP((s) => {
      const cur = s.videoSnapshots[snap.id];
      const nextEntry: VideoSnapshot = { ...cur, ...snap, updatedAt: Date.now() };
      const map: Record<number, VideoSnapshot> = { ...s.videoSnapshots, [snap.id]: nextEntry };
      const keys = Object.keys(map);
      if (keys.length > MAX_SNAPSHOTS) {
        const sorted = keys
          .map((k) => map[Number(k)])
          .filter(Boolean)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, MAX_SNAPSHOTS);
        const trimmed: Record<number, VideoSnapshot> = {};
        for (const item of sorted) trimmed[item.id] = item;
        return { ...s, videoSnapshots: trimmed };
      }
      return { ...s, videoSnapshots: map };
    });
  }, []);
  const recordVideoOrientation = useCallback((id: number, w: number, h: number) => {
    if (!id || w <= 0 || h <= 0) return;
    const orientation: VideoOrientationMeta["orientation"] = w > h ? "landscape" : "portrait";
    setP((s) => {
      const prev = s.videoOrientations[id];
      if (prev && prev.orientation === orientation && prev.w === w && prev.h === h) return s;
      const entries = Object.entries(s.videoOrientations);
      const map: Record<number, VideoOrientationMeta> =
        entries.length >= MAX_ORIENTATIONS
          ? Object.fromEntries(entries.slice(-(MAX_ORIENTATIONS - 1)))
          : { ...s.videoOrientations };
      map[id] = { orientation, w, h };
      return { ...s, videoOrientations: map };
    });
  }, []);
  const getVideoOrientation = useCallback((id: number) => pRef.current.videoOrientations[id], []);
  const setLandscapeFitPref = useCallback((fit: "contain" | "cover") => {
    setP((s) => (s.landscapeFitPref === fit ? s : { ...s, landscapeFitPref: fit }));
  }, []);
  const addHistory = useCallback((id: number, ep?: number, t?: number, dur?: number) => {
    if (!id) return;
    setP((s) => {
      const prev = s.history.find((x) => x.id === id);
      const epChanged = ep !== undefined && prev !== undefined && prev.ep !== ep;
      const entry: WatchProgress = {
        id,
        ep: ep ?? prev?.ep ?? 1,
        t: epChanged ? 0 : (t ?? prev?.t ?? 0),
        dur: dur ?? prev?.dur ?? 0,
        at: Date.now(),
      };
      return { ...s, history: [entry, ...s.history.filter((x) => x.id !== id)].slice(0, 80) };
    });
  }, []);
  const clearHistory = useCallback(() => setP((s) => ({ ...s, history: [] })), []);
  const addSearch = useCallback((q: string) => {
    const t = q.trim();
    if (!t) return;
    setP((s) => ({ ...s, searchHist: [t, ...s.searchHist.filter((x) => x !== t)].slice(0, 12) }));
  }, []);
  const removeSearchHist = useCallback((q: string) => {
    setP((s) => ({ ...s, searchHist: s.searchHist.filter((x) => x !== q) }));
  }, []);
  const clearSearchHist = useCallback(() => setP((s) => ({ ...s, searchHist: [] })), []);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* ignore */ }
    setUser(null);
    toast("已退出登录", "info");
  }, [toast]);

  const setTheater = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setTheaterState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setMuted = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setP((s) => ({ ...s, muted: typeof v === "function" ? v(s.muted) : v }));
  }, []);
  const setMuteOnStartup = useCallback((on: boolean) => {
    setP((s) => ({ ...s, muteOnStartup: on }));
  }, []);
  const setVolume = useCallback((v: number) => {
    const volume = Math.max(0, Math.min(1, v));
    setP((s) => ({ ...s, volume, muted: volume === 0 }));
  }, []);

  const value = useMemo<Store>(() => ({
    platform: envPlatform,
    theme, setTheme, themePref, setThemePref,
    canGoBack: navigation.index > 0, canGoForward: navigation.index < navigation.entries.length - 1, travel,
    tab, setTab, stack, push, pop,
    user, setUser, mergeUserInteractions, loginOpen, setLoginOpen, linePickerOpen, setLinePickerOpen, shortcutsOpen, setShortcutsOpen, logout,
    likes: p.likes, favs: p.favs, history: p.history, follows: p.follows,
    followAuthors: p.followAuthors, videoSnapshots: p.videoSnapshots,
    upsertVideoSnapshot, recordVideoOrientation, getVideoOrientation,
    landscapeFitPref: p.landscapeFitPref, setLandscapeFitPref,
    isLiked: (id) => p.likes.includes(id),
    isFav: (id) => p.favs.includes(id),
    toggleLikeLocal, toggleFavLocal, removeFav, removeLike, removeHistory, toggleFollowLocal, addHistory, clearHistory,
    muted: p.muted, setMuted, volume: p.volume, setVolume,
    theater, setTheater, fs, setFs,
    muteOnStartup: p.muteOnStartup, setMuteOnStartup,
    searchHist: p.searchHist, addSearch, removeSearchHist, clearSearchHist,
    strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    lineVersion, bumpLineVersion,
    homeRefresh, bumpHomeRefresh,
    toasts, toast,
  }), [navigation, travel, theme, setTheme, themePref, tab, setTab, stack, push, pop, user, mergeUserInteractions, loginOpen, linePickerOpen, shortcutsOpen, logout,
    p, upsertVideoSnapshot, recordVideoOrientation, getVideoOrientation, setLandscapeFitPref,
    toggleLikeLocal, toggleFavLocal, removeFav, removeLike, removeHistory, toggleFollowLocal, addHistory, clearHistory,
    setMuted, setMuteOnStartup, setVolume, addSearch, removeSearchHist, clearSearchHist, strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    lineVersion, bumpLineVersion, homeRefresh, bumpHomeRefresh, toasts, toast, theater, setTheater, fs, setFs]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
