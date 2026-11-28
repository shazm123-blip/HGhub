import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api, platform as envPlatform, getApiBase, observeSessionExpiry, SESSION_EXPIRED_MESSAGE, setApiBase } from "./api";
import { isStrictSecurity, setStrictSecurity as setHtmlStrictSecurity } from "./security";
import {
  bindVideoMetaPersistence,
  clearVideoDetailCache,
  flushVideoMetaCache,
  getVideoOrientation,
  recordVideoOrientation,
  seedLegacyVideoMetaCache,
  upsertVideoSnapshot,
} from "./videoMeta";
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

type Interactions = {
  likes: number[];
  likeEpisodes?: Record<number, number[]>;
  postLikes?: number[];
  postFavs?: number[];
  favs: number[];
  follows: number[];
  followAuthors: Record<number, FollowAuthor>;
};

type InteractionField = "likes" | "favs" | "follows";
type InteractionOptions = {
  remove?: boolean;
  ep?: number;
  post?: boolean;
  author?: { name: string; avatar?: string };
};

type PlaybackPrefsState = {
  landscapeFitPref: "contain" | "cover";
  muted: boolean;
  muteOnStartup: boolean;
  volume: number;
  playbackRate: number;
};

const VALID_PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
function sanitizePlaybackRate(raw: unknown): number {
  const n = Number(raw);
  return (VALID_PLAYBACK_RATES as readonly number[]).includes(n) ? n : 1;
}

type Persist = Interactions & {
  accounts: Record<string, Interactions>;
  history: WatchProgress[];
  searchHist: string[];
};

const LS = "hghub_app_v1";
const EMPTY_INTERACTIONS: Interactions = { likes: [], favs: [], follows: [], followAuthors: {} };
const DEFAULTS: Persist = {
  ...EMPTY_INTERACTIONS, history: [], accounts: {}, searchHist: [],
};
const PREF_DEFAULTS: PlaybackPrefsState = {
  landscapeFitPref: "contain",
  muted: true,
  muteOnStartup: true,
  volume: 0.7,
  playbackRate: 1,
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

function loadPersistState(): { persist: Persist; prefs: PlaybackPrefsState; migratedCache: boolean } {
  let persist: Persist = DEFAULTS;
  let prefs: PlaybackPrefsState = PREF_DEFAULTS;
  let legacySnapshots: Record<number, VideoSnapshot> | undefined;
  let legacyOrientations: Record<number, VideoOrientationMeta> | undefined;
  try {
    const raw = localStorage.getItem(LS);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Persist & PlaybackPrefsState & {
        videoSnapshots?: Record<number, VideoSnapshot>;
        videoOrientations?: Record<number, VideoOrientationMeta>;
      }>;
      if (parsed.videoSnapshots && typeof parsed.videoSnapshots === "object") legacySnapshots = parsed.videoSnapshots;
      if (parsed.videoOrientations && typeof parsed.videoOrientations === "object") legacyOrientations = parsed.videoOrientations;
      const muteOnStartup = parsed.muteOnStartup !== false;
      persist = {
        accounts: parsed.accounts && typeof parsed.accounts === "object" ? parsed.accounts : {},
        likeEpisodes: parsed.likeEpisodes,
        postLikes: parsed.postLikes,
        postFavs: parsed.postFavs,
        likes: Array.isArray(parsed.likes) ? parsed.likes : DEFAULTS.likes,
        favs: Array.isArray(parsed.favs) ? parsed.favs : DEFAULTS.favs,
        history: normalizeHistory(parsed.history),
        follows: Array.isArray(parsed.follows) ? parsed.follows : DEFAULTS.follows,
        followAuthors: parsed.followAuthors && typeof parsed.followAuthors === "object" ? parsed.followAuthors : {},
        searchHist: Array.isArray(parsed.searchHist) ? parsed.searchHist : DEFAULTS.searchHist,
      };
      prefs = {
        landscapeFitPref: parsed.landscapeFitPref === "cover" ? "cover" : "contain",
        muted: muteOnStartup || parsed.muted === true,
        muteOnStartup,
        volume: typeof parsed.volume === "number" ? parsed.volume : PREF_DEFAULTS.volume,
        playbackRate: sanitizePlaybackRate(parsed.playbackRate),
      };
    }
  } catch { /* ignore */ }

  const migratedCache = seedLegacyVideoMetaCache(legacySnapshots, legacyOrientations);
  return { persist, prefs, migratedCache };
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

type PlaybackPrefs = PlaybackPrefsState & {
  setLandscapeFitPref: (fit: "contain" | "cover") => void;
  setMuted: (v: boolean | ((p: boolean) => boolean)) => void;
  setMuteOnStartup: (on: boolean) => void;
  setVolume: (v: number) => void;
  setPlaybackRate: (r: number) => void;
};

export type NavState = {
  tab: Tab;
  stack: Page[];
  canGoBack: boolean;
  canGoForward: boolean;
};

export type ThemeState = {
  theme: Theme;
  themePref: ThemePref;
};

export type InteractionsState = {
  likes: number[];
  favs: number[];
  follows: number[];
  followAuthors: Record<number, FollowAuthor>;
  isLiked: (id: number, post?: boolean) => boolean;
  isFav: (id: number, post?: boolean) => boolean;
};

export type UiState = {
  loginOpen: boolean;
  linePickerOpen: boolean;
  shortcutsOpen: boolean;
  theater: boolean;
  fs: boolean;
  strictSecurity: boolean;
  strictSecurityReady: boolean;
  securityPending: boolean;
  cliRelaxed: boolean;
  lineVersion: number;
  homeRefresh: number;
  searchIntent: { q: string; seq: number } | null;
};

export type StoreActions = {
  platform: Platform;
  setTheme: (t: Theme) => void;
  setThemePref: (t: ThemePref) => void;
  setTab: (t: Tab) => void;
  travel: (offset: -1 | 1) => void;
  push: (p: PageInput) => void;
  pop: () => void;
  setUser: (u: User | null) => void;
  handleSessionError: (error: unknown) => void;
  prepareLogin: () => (user: User) => void;
  setLoginOpen: (b: boolean) => void;
  setLinePickerOpen: (b: boolean) => void;
  setShortcutsOpen: (b: boolean) => void;
  logout: () => Promise<void>;
  upsertVideoSnapshot: (snap: Omit<VideoSnapshot, "updatedAt">) => void;
  recordVideoOrientation: (id: number, w: number, h: number) => void;
  getVideoOrientation: (id: number) => VideoOrientationMeta | undefined;
  changeInteraction: (field: InteractionField, id: number, options?: InteractionOptions) => Promise<boolean | null>;
  removeHistory: (id: number) => void;
  /** 记一条观看记录；`ep/t/dur` 省略时保留原进度，`ep` 变了就把进度归零 */
  addHistory: (id: number, ep?: number, t?: number, dur?: number, immediate?: boolean) => void;
  clearHistory: () => void;
  getWatchProgress: (id: number) => WatchProgress | undefined;
  getHistoryIds: () => Set<number>;
  setTheater: (v: boolean | ((p: boolean) => boolean)) => void;
  setFs: (v: boolean | ((p: boolean) => boolean)) => void;
  addSearch: (q: string) => void;
  removeSearchHist: (q: string) => void;
  clearSearchHist: () => void;
  setStrictSecurity: (on: boolean) => Promise<void>;
  bumpLineVersion: () => void;
  bumpHomeRefresh: () => void;
  searchFor: (q: string) => void;
  toast: (msg: string, icon?: Toast["icon"]) => void;
};

type Store = StoreActions & NavState & ThemeState & InteractionsState & UiState & {
  user: User | null;
  history: WatchProgress[];
  searchHist: string[];
};

const ActionsCtx = createContext<StoreActions>(null as unknown as StoreActions);
const NavCtx = createContext<NavState>(null as unknown as NavState);
const ThemeCtx = createContext<ThemeState>(null as unknown as ThemeState);
const SessionCtx = createContext<User | null>(null);
const UiCtx = createContext<UiState>(null as unknown as UiState);
const InteractionsCtx = createContext<InteractionsState>(null as unknown as InteractionsState);
const HistoryCtx = createContext<WatchProgress[]>([]);
const SearchHistCtx = createContext<string[]>([]);
const ToastCtx = createContext<Toast[]>([]);
const PlaybackPrefsCtx = createContext<PlaybackPrefs>(null as unknown as PlaybackPrefs);

export const useStoreActions = () => useContext(ActionsCtx);
export const useNavState = () => useContext(NavCtx);
export const useThemeState = () => useContext(ThemeCtx);
export const useSessionUser = () => useContext(SessionCtx);
export const useUiState = () => useContext(UiCtx);
export const useInteractions = () => useContext(InteractionsCtx);
export const useHistoryState = () => useContext(HistoryCtx);
export const useSearchHistory = () => useContext(SearchHistCtx);
export const useToasts = () => useContext(ToastCtx);
export const usePlaybackPrefs = () => useContext(PlaybackPrefsCtx);

/** 兼容入口：需要完整订阅的组件可继续使用 `useStore()`，高频路径推荐按切片 hook 订阅 */
export function useStore(): Store {
  const actions = useStoreActions();
  const nav = useNavState();
  const themeState = useThemeState();
  const user = useSessionUser();
  const ui = useUiState();
  const inter = useInteractions();
  const history = useHistoryState();
  const searchHist = useSearchHistory();
  return useMemo(
    () => ({ ...actions, ...nav, ...themeState, user, ...ui, ...inter, history, searchHist }),
    [actions, nav, themeState, user, ui, inter, history, searchHist],
  );
}
let seq = 0;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const initialRef = useRef<ReturnType<typeof loadPersistState> | null>(null);
  if (!initialRef.current) initialRef.current = loadPersistState();
  const [p, setPersist] = useState<Persist>(initialRef.current.persist);
  const [prefs, setPrefsState] = useState<PlaybackPrefsState>(initialRef.current.prefs);
  const pRef = useRef(p);
  const prefsRef = useRef(prefs);
  const dirtyPRef = useRef(initialRef.current.migratedCache);
  const setP = useCallback((update: (previous: Persist) => Persist) => {
    const next = update(pRef.current);
    if (next === pRef.current) return;
    pRef.current = next;
    dirtyPRef.current = true;
    setPersist(next);
  }, []);
  const setPrefs = useCallback((update: (previous: PlaybackPrefsState) => PlaybackPrefsState) => {
    const next = update(prefsRef.current);
    if (next === prefsRef.current) return;
    prefsRef.current = next;
    dirtyPRef.current = true;
    setPrefsState(next);
  }, []);
  const pTimerRef = useRef<number | undefined>(undefined);
  const [themePref, setThemePref] = useState<ThemePref>(readThemePref);
  const [sysTheme, setSysTheme] = useState<Theme>(systemTheme);
  const theme: Theme = themePref === "system" ? sysTheme : themePref;
  const setTheme = useCallback((t: Theme) => setThemePref(t), []);
  type Destination = { tab: Tab; stack: Page[] };
  const [navigation, setNavigation] = useState<{ entries: Destination[]; index: number }>({
    entries: [{ tab: "home", stack: [] }], index: 0,
  });
  const { tab, stack } = navigation.entries[navigation.index];
  const [session, setSession] = useState<{ user: User; key: string } | null>(null);
  const sessionChange = useRef(0);
  const user = session?.user ?? null;
  const accountKey = session?.key;
  const interactions = accountKey ? (p.accounts[accountKey] ?? EMPTY_INTERACTIONS) : p;
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
  const [searchIntent, setSearchIntent] = useState<{ q: string; seq: number } | null>(null);
  const toastSeq = useRef(0);
  const searchIntentSeq = useRef(0);
  const bumpLineVersion = useCallback(() => {
    clearVideoDetailCache();
    setLineVersion((v) => v + 1);
  }, []);
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

  const writeAppPersist = useCallback(() => {
    try {
      localStorage.setItem(LS, JSON.stringify({ ...pRef.current, ...prefsRef.current }));
    } catch { /* ignore */ }
  }, []);

  const flushPersist = useCallback(() => {
    window.clearTimeout(pTimerRef.current);
    pTimerRef.current = undefined;
    if (dirtyPRef.current) {
      dirtyPRef.current = false;
      writeAppPersist();
    }
    flushVideoMetaCache();
  }, [writeAppPersist]);

  useEffect(() => {
    if (!dirtyPRef.current) return;
    window.clearTimeout(pTimerRef.current);
    pTimerRef.current = window.setTimeout(() => {
      pTimerRef.current = undefined;
      dirtyPRef.current = false;
      writeAppPersist();
    }, 1500);
  }, [p, prefs, writeAppPersist]);

  useEffect(() => {
    const unbindMeta = bindVideoMetaPersistence();
    const onHide = () => {
      if (document.visibilityState === "hidden") flushPersist();
    };
    window.addEventListener("pagehide", flushPersist);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flushPersist);
      document.removeEventListener("visibilitychange", onHide);
      flushPersist();
      unbindMeta();
    };
  }, [flushPersist]);

  const applyUser = useCallback((u: User | null, cached = false, beforeLogin?: Persist["accounts"]) => {
    sessionChange.current++;
    if (!u?.id) { setSession(null); return; }
    const key = JSON.stringify([new URL(getApiBase()).origin, u.id]);
    setP((s) => {
      const saved = s.accounts[key];
      // app_boot returns the login-time snapshot, which may predate local changes.
      if (cached && saved) return s;
      const previous = saved ?? EMPTY_INTERACTIONS;
      const before = beforeLogin ? beforeLogin[key] ?? EMPTY_INTERACTIONS : previous;
      const inter = u.interactions;
      const ids = (value: unknown, field: "likes" | "favs" | "follows") => {
        if (!Array.isArray(value)) return previous[field];
        const server = new Set<number>(value.filter((id) => typeof id === "number"));
        if (before[field] !== previous[field]) {
          const old = new Set(before[field]);
          const current = new Set(previous[field]);
          for (const id of old) if (!current.has(id)) server.delete(id);
          for (const id of current) if (!old.has(id)) server.add(id);
        }
        return [...server];
      };
      const follows = ids(inter?.follow_user_ids, "follows");
      const likes = new Set(ids(inter?.like_video_ids, "likes"));
      const likeEpisodes: Record<number, number[]> = Array.isArray(inter?.like_video_episodes)
        ? {} : { ...previous.likeEpisodes };
      if (Array.isArray(inter?.like_video_episodes)) {
        for (const entry of inter.like_video_episodes) {
          if (!entry || !Number.isInteger(entry.video_id) || !Number.isInteger(entry.ep) || entry.ep <= 0) continue;
          const episodes = likeEpisodes[entry.video_id] ??= [];
          if (!episodes.includes(entry.ep)) episodes.push(entry.ep);
        }
      }
      if (before.likeEpisodes !== previous.likeEpisodes) {
        const old = before.likeEpisodes ?? {};
        const current = previous.likeEpisodes ?? {};
        for (const id of new Set([...Object.keys(old), ...Object.keys(current)].map(Number))) {
          if (old[id] === current[id]) continue;
          const before = new Set(old[id]);
          const after = new Set(current[id]);
          const server = new Set(likeEpisodes[id]);
          const hadServerEpisodes = server.size > 0;
          for (const ep of before) if (!after.has(ep)) server.delete(ep);
          for (const ep of after) if (!before.has(ep)) server.add(ep);
          if (server.size) {
            likeEpisodes[id] = [...server];
            likes.add(id);
          } else {
            delete likeEpisodes[id];
            if (hadServerEpisodes) likes.delete(id);
          }
        }
      }
      return { ...s, accounts: { ...s.accounts, [key]: {
        likes: [...likes],
        likeEpisodes,
        postLikes: previous.postLikes,
        postFavs: previous.postFavs,
        favs: ids(inter?.favorite_video_ids, "favs"),
        follows,
        followAuthors: Object.fromEntries(follows.flatMap((id) => previous.followAuthors[id] ? [[id, previous.followAuthors[id]]] : [])),
      } } };
    });
    setSession({ user: u, key });
  }, [setP]);
  const setUser = useCallback((u: User | null) => applyUser(u), [applyUser]);
  const prepareLogin = useCallback(() => {
    const beforeLogin = pRef.current.accounts;
    return (u: User) => applyUser(u, false, beforeLogin);
  }, [applyUser]);

  useEffect(() => {
    const revision = sessionChange.current;
    let alive = true;
    api.boot()
      .then((r) => {
        if (!alive) return;
        if (sessionChange.current === revision) {
          if (r.base) setApiBase(r.base);
          if (r.user && (r.user as User).id) applyUser(r.user as User, true);
        }
        if (typeof r.strict_security === "boolean") {
          setStrictSecurityState(r.strict_security);
          setHtmlStrictSecurity(r.strict_security);
          setStrictSecurityReady(true);
        }
        setCliRelaxed(!!r.cli_relaxed);
      })
      .catch(() => { /* 离线也能用 */ });
    return () => { alive = false; };
  }, [applyUser]);

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
    const duration = Math.max(2200, Math.min(3800, 1400 + msg.length * 80));
    setToasts((t) => [...t.slice(-2), { id, msg, icon }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), duration);
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
  const searchFor = useCallback((raw: string) => {
    const q = raw.trim();
    if (!q) return;
    setTab("search");
    setSearchIntent({ q, seq: ++searchIntentSeq.current });
  }, [setTab]);
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

  const pendingInteractions = useRef(new Set<string>());
  const revision = sessionChange.current;
  const handleSessionError = useCallback((error: unknown) => {
    if (!accountKey || sessionChange.current !== revision || !(error instanceof Error)) return;
    if (error.message === SESSION_EXPIRED_MESSAGE || error.message === "请先登录") {
      setUser(null);
      setLoginOpen(true);
    }
  }, [accountKey, revision, setUser]);
  useLayoutEffect(() => observeSessionExpiry(handleSessionError), [handleSessionError]);

  const changeInteraction = useCallback(async (field: InteractionField, id: number, options: InteractionOptions = {}) => {
    if (sessionChange.current !== revision) return null;
    const list = options.post && field === "likes" ? "postLikes"
      : options.post && field === "favs" ? "postFavs" : field;
    const key = JSON.stringify([accountKey, list, id]);
    if (pendingInteractions.current.has(key)) return null;

    const getInteractions = (state: Persist) => accountKey ? state.accounts[accountKey] : state;
    const update = (change: (previous: Interactions) => Partial<Interactions>) => {
      setP((state) => {
        const patch = change(getInteractions(state));
        return accountKey
          ? { ...state, accounts: { ...state.accounts, [accountKey]: { ...state.accounts[accountKey], ...patch } } }
          : { ...state, ...patch };
      });
    };
    const current = getInteractions(pRef.current);
    const had = current[list]?.includes(id) ?? false;
    const on = !options.remove && !had;
    if (!had && !on) return null;

    const assertCurrentSession = () => {
      if (sessionChange.current !== revision) throw new Error("登录状态已变化，请重试");
    };
    const commit = (ep?: number) => {
      // A successful response belongs to the account that sent it, even after logout.
      update((state) => {
        const others = (state[list] ?? []).filter((x) => x !== id);
        const ids = on ? [id, ...others] : others;
        if (list === "favs" || list === "postLikes" || list === "postFavs") return { [list]: ids };
        if (field === "follows") {
          const followAuthors = { ...state.followAuthors };
          if (on && options.author?.name) followAuthors[id] = { id, ...options.author };
          if (!on) delete followAuthors[id];
          return { follows: ids, followAuthors };
        }
        const likeEpisodes = { ...state.likeEpisodes };
        if (on && ep !== undefined) likeEpisodes[id] = [ep];
        if (!on) {
          const remaining = ep === undefined ? [] : (likeEpisodes[id] ?? []).filter((x) => x !== ep);
          if (remaining.length) {
            likeEpisodes[id] = remaining;
            return { likeEpisodes };
          }
          delete likeEpisodes[id];
        }
        return { likes: ids, likeEpisodes };
      });
    };

    pendingInteractions.current.add(key);
    try {
      if (!accountKey) {
        commit(on && !options.post ? options.ep : undefined);
      } else if (field === "likes" && !options.post) {
        const fallbackEp = options.ep ?? 1;
        const episodes = on ? [fallbackEp] : (current.likeEpisodes?.[id] ?? [fallbackEp]);
        for (const ep of episodes) {
          assertCurrentSession();
          await api.like(id, ep, on);
          commit(ep);
        }
      } else {
        if (field === "likes") await api.postLike(id, on);
        else if (field === "follows") await api.follow(id, on);
        else if (options.post) await api.postCollect(id, on);
        else await api.collect(id, on);
        commit();
      }
      return sessionChange.current === revision ? on : null;
    } catch (error) {
      if (sessionChange.current !== revision) return null;
      handleSessionError(error);
      throw error;
    } finally {
      pendingInteractions.current.delete(key);
    }
  }, [accountKey, revision, setP, handleSessionError]);
  const removeHistory = useCallback((id: number) => {
    setP((s) => ({ ...s, history: s.history.filter((x) => x.id !== id) }));
  }, [setP]);
  const setLandscapeFitPref = useCallback((fit: "contain" | "cover") => {
    setPrefs((s) => (s.landscapeFitPref === fit ? s : { ...s, landscapeFitPref: fit }));
  }, [setPrefs]);
  const addHistory = useCallback((id: number, ep?: number, t?: number, dur?: number, immediate = false) => {
    if (!id) return;
    setP((s) => {
      const prev = s.history.find((x) => x.id === id);
      const epChanged = ep !== undefined && prev !== undefined && prev.ep !== ep;
      const entry: WatchProgress = {
        id,
        ep: ep ?? prev?.ep ?? 1,
        t: t ?? (epChanged ? 0 : prev?.t ?? 0),
        dur: dur ?? (epChanged ? 0 : prev?.dur ?? 0),
        at: Date.now(),
      };
      return { ...s, history: [entry, ...s.history.filter((x) => x.id !== id)].slice(0, 80) };
    });
    if (immediate) flushPersist();
  }, [flushPersist, setP]);
  const clearHistory = useCallback(() => setP((s) => ({ ...s, history: [] })), [setP]);
  const addSearch = useCallback((q: string) => {
    const t = q.trim();
    if (!t) return;
    setP((s) => ({ ...s, searchHist: [t, ...s.searchHist.filter((x) => x !== t)].slice(0, 12) }));
  }, [setP]);
  const removeSearchHist = useCallback((q: string) => {
    setP((s) => ({ ...s, searchHist: s.searchHist.filter((x) => x !== q) }));
  }, [setP]);
  const clearSearchHist = useCallback(() => setP((s) => ({ ...s, searchHist: [] })), [setP]);

  const logout = useCallback(async () => {
    if (sessionChange.current !== revision) return;
    const logoutRequest = api.logout();
    setUser(null);
    toast("已退出登录", "info");
    await logoutRequest.catch(() => {});
  }, [revision, setUser, toast]);

  const setTheater = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setTheaterState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setMuted = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setPrefs((s) => ({ ...s, muted: typeof v === "function" ? v(s.muted) : v }));
  }, [setPrefs]);
  const setMuteOnStartup = useCallback((on: boolean) => {
    setPrefs((s) => ({ ...s, muteOnStartup: on }));
  }, [setPrefs]);
  const setVolume = useCallback((v: number) => {
    const volume = Math.max(0, Math.min(1, v));
    setPrefs((s) => ({ ...s, volume, muted: volume === 0 }));
  }, [setPrefs]);
  const setPlaybackRate = useCallback((r: number) => {
    const playbackRate = sanitizePlaybackRate(r);
    setPrefs((s) => (s.playbackRate === playbackRate ? s : { ...s, playbackRate }));
  }, [setPrefs]);

  const getWatchProgress = useCallback((id: number) => pRef.current.history.find((x) => x.id === id), []);
  const getHistoryIds = useCallback(() => new Set(pRef.current.history.map((x) => x.id)), []);

  const playbackPrefsValue = useMemo<PlaybackPrefs>(() => ({
    landscapeFitPref: prefs.landscapeFitPref,
    setLandscapeFitPref,
    muted: prefs.muted,
    setMuted,
    muteOnStartup: prefs.muteOnStartup,
    setMuteOnStartup,
    volume: prefs.volume,
    setVolume,
    playbackRate: prefs.playbackRate,
    setPlaybackRate,
  }), [prefs, setLandscapeFitPref, setMuted, setMuteOnStartup, setVolume, setPlaybackRate]);

  const actionsValue = useMemo<StoreActions>(() => ({
    platform: envPlatform,
    setTheme, setThemePref,
    setTab, travel, push, pop,
    setUser, handleSessionError, prepareLogin,
    setLoginOpen, setLinePickerOpen, setShortcutsOpen, logout,
    upsertVideoSnapshot, recordVideoOrientation, getVideoOrientation,
    changeInteraction, removeHistory, addHistory, clearHistory,
    getWatchProgress, getHistoryIds,
    setTheater, setFs,
    addSearch, removeSearchHist, clearSearchHist,
    setStrictSecurity, bumpLineVersion, bumpHomeRefresh, searchFor, toast,
  }), [
    setTheme, setTab, travel, push, pop,
    setUser, handleSessionError, prepareLogin, logout,
    changeInteraction, removeHistory, addHistory, clearHistory,
    getWatchProgress, getHistoryIds,
    setTheater, setFs,
    addSearch, removeSearchHist, clearSearchHist,
    setStrictSecurity, bumpLineVersion, bumpHomeRefresh, searchFor, toast,
  ]);

  const navValue = useMemo<NavState>(() => ({
    tab, stack,
    canGoBack: navigation.index > 0,
    canGoForward: navigation.index < navigation.entries.length - 1,
  }), [tab, stack, navigation.index, navigation.entries.length]);

  const themeValue = useMemo<ThemeState>(() => ({ theme, themePref }), [theme, themePref]);

  const uiValue = useMemo<UiState>(() => ({
    loginOpen, linePickerOpen, shortcutsOpen, theater, fs,
    strictSecurity, strictSecurityReady, securityPending, cliRelaxed,
    lineVersion, homeRefresh, searchIntent,
  }), [
    loginOpen, linePickerOpen, shortcutsOpen, theater, fs,
    strictSecurity, strictSecurityReady, securityPending, cliRelaxed,
    lineVersion, homeRefresh, searchIntent,
  ]);

  const interactionsValue = useMemo<InteractionsState>(() => {
    const likeSet = new Set(interactions.likes);
    const postLikeSet = new Set(interactions.postLikes);
    const favSet = new Set(interactions.favs);
    const postFavSet = new Set(interactions.postFavs);
    return {
      likes: interactions.likes,
      favs: interactions.favs,
      follows: interactions.follows,
      followAuthors: interactions.followAuthors,
      isLiked: (id, post) => (post ? postLikeSet : likeSet).has(id),
      isFav: (id, post) => (post ? postFavSet : favSet).has(id),
    };
  }, [interactions]);

  return (
    <ActionsCtx.Provider value={actionsValue}>
      <NavCtx.Provider value={navValue}>
        <ThemeCtx.Provider value={themeValue}>
          <SessionCtx.Provider value={user}>
            <UiCtx.Provider value={uiValue}>
              <InteractionsCtx.Provider value={interactionsValue}>
                <HistoryCtx.Provider value={p.history}>
                  <SearchHistCtx.Provider value={p.searchHist}>
                    <PlaybackPrefsCtx.Provider value={playbackPrefsValue}>
                      <ToastCtx.Provider value={toasts}>{children}</ToastCtx.Provider>
                    </PlaybackPrefsCtx.Provider>
                  </SearchHistCtx.Provider>
                </HistoryCtx.Provider>
              </InteractionsCtx.Provider>
            </UiCtx.Provider>
          </SessionCtx.Provider>
        </ThemeCtx.Provider>
      </NavCtx.Provider>
    </ActionsCtx.Provider>
  );
}
