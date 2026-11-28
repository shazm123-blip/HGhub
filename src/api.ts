import { invoke } from "@tauri-apps/api/core";
import type {
  CommentPage, Detail, Paged, PlayInfo, Post, RankItem, User, VideoCard,
} from "./types";

/* ── 运行环境 ───────────────────────────────────────────── */

/** 应用版本（构建时由 vite.config.ts 从 package.json 注入） */
export const APP_VERSION = __APP_VERSION__;

const ua = navigator.userAgent;
/** iPhone 的 UA 也带「like Mac OS X」，必须先于 macOS 判断；iPadOS 默认伪装成 Mac，用触点数区分。 */
export const isIos =
  /iPhone|iPad|iPod/i.test(ua) ||
  (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) ||
  (typeof navigator.platform === "string" && navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isAndroid = /Android/i.test(ua);
export const isMacos = !isIos && /Macintosh|Mac OS X/i.test(ua);
export const isLinux = !isAndroid && !isIos && /Linux/i.test(ua);
export const platform: "android" | "ios" | "windows" | "macos" | "linux" =
  isAndroid ? "android" : isIos ? "ios" : isMacos ? "macos" : isLinux ? "linux" : "windows";
/** 移动端（安卓 / iOS）共用触屏界面 */
export const isMobile = isAndroid || isIos;

/** 自定义协议地址随平台不同（见 tauri `register_asynchronous_uri_scheme_protocol` 文档）：
 *  Windows / Android → `http://<scheme>.localhost`
 *  macOS / iOS / Linux → `<scheme>://localhost`
 *  Rust 侧 `src-tauri/src/lib.rs` 里改写 m3u8 用的 scheme 必须与此一致。 */
export const LOCAL = isMacos || isIos || isLinux ? "hg://localhost" : "http://hg.localhost";

/** 当前上游基址（与 Rust line 保持同步，用于补全正文与封面中的相对 URL） */
let apiBase = "https://huangguoai.com";
export const getApiBase = () => apiBase;
export const setApiBase = (next?: string) => {
  if (next && /^https?:\/\//i.test(next)) apiBase = next.replace(/\/+$/, "");
};

/** src 是否已是本地协议地址（避免在详情页把代理地址再包一层） */
export const isLocalMedia = (src: string) => src.startsWith(`${LOCAL}/`);

/** 封面：经本地协议解密（站点封面是 AES 密文）。 */
export const cover = (url?: string, _w = 480) => {
  const raw = (url || "").trim();
  if (!raw) return "";
  if (isLocalMedia(raw) || raw.startsWith("data:") || raw.startsWith("blob:")) return raw;
  let absUrl = raw;
  if (raw.startsWith("//")) absUrl = `https:${raw}`;
  else if (!/^https?:\/\//i.test(raw)) {
    try { absUrl = new URL(raw, apiBase).href; } catch { return ""; }
  }
  return `${LOCAL}/img?u=${encodeURIComponent(absUrl)}`;
};

/** 播放列表：经本地协议改写分片地址，规避 CORS 与防盗链。 */
export const playlist = (url: string) => `${LOCAL}/hls?u=${encodeURIComponent(url)}`;

/* ── 调用封装 ───────────────────────────────────────────── */

/** 写一行到应用数据目录 debug.log（用户反馈「打不开」时要的就是它） */
export const logLine = (msg: string) => invoke("debug_log", { msg }).catch(() => {});

export const SESSION_EXPIRED_MESSAGE = "登录已过期，请重新登录";

let sessionExpiryObserver: ((error: Error) => void) | undefined;

export function observeSessionExpiry(observer: (error: Error) => void) {
  sessionExpiryObserver = observer;
  return () => {
    if (sessionExpiryObserver === observer) sessionExpiryObserver = undefined;
  };
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const onSessionExpiry = sessionExpiryObserver;
  try {
    return (await invoke(cmd, args)) as T;
  } catch (e) {
    const msg = typeof e === "string" ? e : "请求失败，请检查网络";
    // 落盘完整错误链（dns error / connection refused / 证书错误…），toast 只显示截断版
    logLine(`[api] ${cmd} → ${msg}`);
    const status = /^HTTP (\d{3})\b/.exec(msg)?.[1];
    if (status === "401") {
      const error = new Error(SESSION_EXPIRED_MESSAGE);
      if (msg === "HTTP 401 登录已过期") onSessionExpiry?.(error);
      throw error;
    }
    if (status === "410") {
      throw new Error("该频道或内容已下线");
    }
    if (status) {
      throw new Error(`服务器请求失败（HTTP ${status}），请稍后重试或在设置中切换线路`);
    }
    throw new Error(msg.length > 140 ? `${msg.slice(0, 140)}…` : msg);
  }
}

/* ── 接口 ───────────────────────────────────────────────── */

export const api = {
  boot: () =>
    call<{
      user: User | null;
      logged_in: boolean;
      base: string;
      strict_security?: boolean;
      cli_relaxed?: boolean;
    }>("app_boot"),
  securitySet: (strict: boolean) => call<boolean>("security_set", { strict }),
  login: (username: string, password: string) =>
    call<{ user: User }>("api_login", { username, password }),
  register: (username: string, password: string, email = "") =>
    call<{ user: User }>("api_register", { username, password, email }),
  logout: () => call<{ ok: boolean }>("api_logout"),
  me: () => call<User>("api_me"),

  feed: (page = 1, size = 20) => call<Paged<VideoCard>>("api_feed", { page, size }),
  category: (cate: string, page = 1, size = 20, sort?: "new" | "hot") =>
    call<Paged<VideoCard>>("api_category", sort ? { cate, page, size, sort } : { cate, page, size }),
  rank: (kind: "hot" | "recommend" | "potential") =>
    call<{ type: string; items: RankItem[] }>("api_rank", { kind }),
  search: (q: string, page = 1, size = 20) =>
    call<{ items: VideoCard[]; pagination: Paged<VideoCard>["pagination"]; keyword: string }>(
      "api_search", { q, page, size },
    ),
  posts: (page = 1, size = 20) => call<Paged<Post>>("api_posts", { page, size }),
  post: (id: number) => call<Post & { content?: string; video_url?: string }>("api_post", { id }),

  video: (id: number) => call<Detail>("api_video", { id }),
  play: (id: number, ep: number) => call<PlayInfo>("api_play", { id, ep }),

  comments: (id: number, ep: number, page = 1, size = 20) =>
    call<CommentPage>("api_comments", { id, ep, page, size }),
  commentSend: (id: number, ep: number, text: string, replyId?: number) =>
    call<unknown>("api_comment_send", { id, ep, text, replyId: replyId ?? null }),

  clearCache: () => invoke<void>("cache_clear"),
  trimMemoryCache: () => invoke<void>("cache_trim_memory").catch(() => {}),
  cacheStats: () => invoke<{ entries: number; bytes: number }>("cache_stats"),
  prewarmMedia: (url: string) => invoke<void>("media_prewarm", { url }).catch(() => {}),
  netDiag: () => invoke<Record<string, unknown>>("net_diag"),
  postLike: (id: number, on: boolean) => call<unknown>("api_post_like", { id, on }),
  postCollect: (id: number, on: boolean) => call<unknown>("api_post_collect", { id, on }),
  postComments: (id: number, page: number, size: number) => call<CommentPage>("api_post_comments", { id, page, size }),
  like: (id: number, ep: number, on: boolean) => call<unknown>("api_like", { id, ep, on }),
  collect: (id: number, on: boolean) => call<unknown>("api_collect", { id, on }),
  follow: (uid: number, on: boolean) => call<unknown>("api_follow", { uid, on }),

  /* 线路（数据源）：固定线路写死在 Rust 侧，镜像线路按需从地址发布页拉取 */
  lineState: () => call<LineState>("line_state"),
  lineSet: (url: string) => call<string>("line_set", { url }),
  lineMirrors: () => call<LineMirrors>("line_mirrors"),
  lineProbe: (urls: string[]) => call<LineProbe[]>("line_probe", { urls }),

  /* 更新检查：对比 GitHub Release 的 tag */
  checkUpdate: () => call<UpdateInfo>("check_update"),
  openUrl: (url: string) => call<void>("open_url", { url }),
};

/* ── 更新检查 ───────────────────────────────────────────── */

export type UpdateInfo = {
  current: string;
  latest: string;
  tag?: string;
  has_update: boolean;
  url: string;
  name?: string;
  published_at?: string;
  notes?: string;
};

/* ── 线路（数据源） ─────────────────────────────────────── */

export type LineItem = { name?: string; url: string; host?: string };
export type LineState = { base: string; default: string; fixed: LineItem[] };
export type LineMirrors = { source: string; script?: string; items: LineItem[] };
export type LineProbe = { url: string; ok: boolean; status?: number; ms: number; error?: string };

/** `https://a.b/c` → `a.b`（线路展示用） */
export const hostOf = (url: string) => {
  try { return new URL(url).host; } catch { return url.replace(/^https?:\/\//, "").replace(/\/.*$/, ""); }
};

/** 判断是否属于可登录账号的固定主线 */
export const isFixedLine = (url: string) =>
  /^https:\/\/(huangguoai\.com|huangguoai\.ai)(\/|$)/i.test(url.trim());

/** 字节格式化 */
export const fmtBytes = (bytes: number): string => {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

/** 把底层网络/播放器错误代码翻译为更易懂的中文说明 */
export function friendlyError(raw: string): { summary: string; detail?: string } {
  const s = (raw || "").trim();
  if (!s) return { summary: "加载失败，请稍后重试或切换线路" };
  const lower = s.toLowerCase();
  if (s === SESSION_EXPIRED_MESSAGE || s === "请先登录") return { summary: "登录态已失效，请重新登录" };
  if (s.includes("已下线") || /\b410\b/.test(s)) return { summary: "该内容或频道已下线", detail: s };
  if (/\b404\b/.test(s)) return { summary: "内容不存在或线路接口异常", detail: s };
  if (/\b403\b/.test(s)) return { summary: "资源访问被拒绝或签名已过期，请尝试重新加载", detail: s };
  if (/5\d\d/.test(s)) return { summary: "服务器暂时开小差了，请稍后重试或切换线路", detail: s };
  if (lower.includes("fragloadtimeout") || lower.includes("manifestloadtimeout") || lower.includes("timed out") || s.includes("超时")) {
    return { summary: "视频加载超时，可能是当前线路较慢或网络不稳定", detail: s };
  }
  if (lower.includes("manifestloaderror") || lower.includes("fragloaderror") || lower.includes("networkerror")) {
    return { summary: "网络连接中断或分片加载失败，可尝试切换线路", detail: s };
  }
  if (lower.includes("mediaerror")) {
    return { summary: "视频解码异常，请点击重新加载重试", detail: s };
  }
  if (lower.includes("dns") || lower.includes("enotfound") || lower.includes("nodename")) {
    return { summary: "域名解析失败，建议切换其他线路或检查网络代理", detail: s };
  }
  if (lower.includes("tunnel") || lower.includes("proxy")) {
    return { summary: "系统代理连接失败，请检查代理工具或尝试直连镜像线路", detail: s };
  }
  if (lower.includes("refused")) {
    return { summary: "连接被服务器拒绝，请尝试切换线路", detail: s };
  }
  return { summary: s };
}

/* ── 自检：验证 webview → 本地协议 → 上游 的取流链路 ───────── */
export async function selfTest(): Promise<string> {
  const steps: string[] = [];
  try {
    const info = await api.play(117, 3);
    steps.push(`play:${info?.video_url ? "ok" : "empty"}`);
    const hlsUrl = `${LOCAL}/hls?u=${encodeURIComponent(info.video_url)}`;
    const r1 = await fetch(hlsUrl);
    const txt = await r1.text();
    steps.push(`hls:${r1.status}/${txt.length}/${txt.startsWith("#EXTM3U") ? "m3u8" : "bad"}`);
    const keyLine = txt.split("\n").find((l) => l.startsWith("#EXT-X-KEY"));
    if (keyLine) {
      const m = keyLine.match(/URI="([^"]+)"/);
      if (m) {
        const rustUrl = m[1];
        steps.push(`rustUrl:${rustUrl.slice(0, 60)}`);
        // A/B：用 JS 重新编码同一条上游地址
        const inner = decodeURIComponent(rustUrl.split("?u=")[1] || "");
        steps.push(`inner:${inner.slice(0, 50)}`);
        try {
          const rk = await fetch(rustUrl);
          const bk = await rk.arrayBuffer();
          steps.push(`keyRust:${rk.status}/${bk.byteLength}`);
        } catch (e) { steps.push(`keyRust:throw:${(e as Error).message.slice(0, 30)}`); }
        try {
          const rk2 = await fetch(`${LOCAL}/seg?u=${encodeURIComponent(inner)}`);
          const bk2 = await rk2.arrayBuffer();
          steps.push(`keyJs:${rk2.status}/${bk2.byteLength}`);
        } catch (e) { steps.push(`keyJs:throw:${(e as Error).message.slice(0, 30)}`); }
      }
    }
    const segLine = txt.split("\n").find((l) => l && !l.startsWith("#") && l.includes("/seg?u="));
    if (segLine) {
      try {
        const r2 = await fetch(segLine.trim());
        const buf = await r2.arrayBuffer();
        steps.push(`seg:${r2.status}/${buf.byteLength}`);
      } catch (e) { steps.push(`seg:throw:${(e as Error).message.slice(0, 40)}`); }
    } else steps.push("seg:no-line");
  } catch (e) {
    steps.push(`err:${(e as Error).message.slice(0, 60)}`);
  }
  return steps.join(" | ");
}

/* ── 格式化 ─────────────────────────────────────────────── */

export const fmt = (n: number | undefined) => {
  const v = Number(n) || 0;
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1).replace(/\.0$/, "")}亿`;
  if (v >= 10_000) return `${(v / 10_000).toFixed(1).replace(/\.0$/, "")}万`;
  return String(v);
};

export const fmtTime = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, "0")}`;
};

export const dur = (s?: number | string) => {
  const n = Number(s) || 0;
  if (n <= 0) return "";
  const m = Math.floor(n / 60);
  const ss = n % 60;
  return `${m}:${String(ss).padStart(2, "0")}`;
};

/** 非 m3u8 媒体（mp4 等）走 /seg 原样透传 */
export function directMedia(url: string): string {
  return `${LOCAL}/seg?u=${encodeURIComponent(url)}`;
}

/** 按扩展名选择代理方式：已知直连封装走 /seg 透传，其它（含 m3u8 与无扩展名流）走 /hls */
export function mediaUrl(url: string): string {
  return /\.(mp4|webm|mov|m4v|ogv|ogg)(\?|#|$)/i.test(url) ? directMedia(url) : playlist(url);
}
