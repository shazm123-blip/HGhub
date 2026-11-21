//! 媒体层：封面解密 + HLS 代理。
//!
//! 站点封面是 AES-128-CBC 密文，m3u8 内部分片/key 又可能被 WebView 的 CORS 拦住，
//! 所以图片与视频统一走本地自定义协议（Windows/Android 为 `http://hg.localhost`，
//! macOS 为 `hg://localhost`，见 [`LOCAL_ORIGIN`]）。

use crate::net::fetch_bytes;
use aes::cipher::{BlockDecrypt, KeyInit};
use aes::Aes128;
use once_cell::sync::Lazy;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::http::{Response, StatusCode};

/// 本平台自定义协议的完整基址。
///
/// Tauri 的自定义协议地址随平台不同：Windows / Android 是 `http://<scheme>.localhost`，
/// macOS / iOS / Linux 是 `<scheme>://localhost`。m3u8 里的分片与 key 地址按它改写。
/// 前端 `src/api.ts` 的 `LOCAL` 必须与此一致，否则封面与视频全部加载失败。
#[cfg(any(target_os = "windows", target_os = "android"))]
pub const LOCAL_ORIGIN: &str = "http://hg.localhost";
#[cfg(not(any(target_os = "windows", target_os = "android")))]
pub const LOCAL_ORIGIN: &str = "hg://localhost";

const IMG_KEY: &[u8] = b"f5d965df75336270";
const IMG_IV: &[u8] = b"97b60394abc2fbe1";

struct CacheEntry<V> {
    tick: u64,
    bytes: usize,
    val: V,
}

struct LruCache<V> {
    max_entries: usize,
    max_bytes: usize,
    total_bytes: usize,
    tick: u64,
    entries: HashMap<String, CacheEntry<V>>,
}

impl<V: Clone> LruCache<V> {
    fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            max_entries,
            max_bytes,
            total_bytes: 0,
            tick: 0,
            entries: HashMap::new(),
        }
    }

    fn get(&mut self, key: &str) -> Option<V> {
        let entry = self.entries.get_mut(key)?;
        self.tick = self.tick.wrapping_add(1);
        entry.tick = self.tick;
        Some(entry.val.clone())
    }

    fn put(&mut self, key: String, val: V, bytes: usize) {
        if self.max_entries == 0 || bytes > self.max_bytes {
            return;
        }
        if let Some(old) = self.entries.remove(&key) {
            self.total_bytes = self.total_bytes.saturating_sub(old.bytes);
        }
        while self.entries.len() >= self.max_entries
            || self.total_bytes.saturating_add(bytes) > self.max_bytes
        {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.tick)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Some(removed) = self.entries.remove(&oldest) {
                self.total_bytes = self.total_bytes.saturating_sub(removed.bytes);
            }
        }
        self.tick = self.tick.wrapping_add(1);
        self.total_bytes = self.total_bytes.saturating_add(bytes);
        self.entries.insert(
            key,
            CacheEntry {
                tick: self.tick,
                bytes,
                val,
            },
        );
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.total_bytes = 0;
    }
}

type SegmentEntry = (String, Arc<Vec<u8>>);
type CacheStore<V> = Lazy<Mutex<LruCache<V>>>;

#[cfg(any(target_os = "ios", target_os = "android"))]
const IMG_CACHE_MAX: usize = 100;
#[cfg(any(target_os = "ios", target_os = "android"))]
const IMG_CACHE_MAX_BYTES: usize = 16 * 1024 * 1024;
#[cfg(any(target_os = "ios", target_os = "android"))]
const PL_CACHE_MAX: usize = 24;
#[cfg(any(target_os = "ios", target_os = "android"))]
const PL_CACHE_MAX_BYTES: usize = 2 * 1024 * 1024;
#[cfg(any(target_os = "ios", target_os = "android"))]
const KEY_CACHE_MAX: usize = 64;
#[cfg(any(target_os = "ios", target_os = "android"))]
const KEY_CACHE_MAX_BYTES: usize = 1 * 1024 * 1024;
#[cfg(any(target_os = "ios", target_os = "android"))]
const SEG_CACHE_MAX: usize = 8;
#[cfg(any(target_os = "ios", target_os = "android"))]
const SEG_CACHE_TOTAL_BYTES: usize = 12 * 1024 * 1024;
#[cfg(any(target_os = "ios", target_os = "android"))]
const SEG_CACHE_MAX_BYTES: usize = 2 * 1024 * 1024;

#[cfg(not(any(target_os = "ios", target_os = "android")))]
const IMG_CACHE_MAX: usize = 240;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const IMG_CACHE_MAX_BYTES: usize = 48 * 1024 * 1024;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const PL_CACHE_MAX: usize = 60;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const PL_CACHE_MAX_BYTES: usize = 8 * 1024 * 1024;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const KEY_CACHE_MAX: usize = 120;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const KEY_CACHE_MAX_BYTES: usize = 4 * 1024 * 1024;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const SEG_CACHE_MAX: usize = 36;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const SEG_CACHE_TOTAL_BYTES: usize = 48 * 1024 * 1024;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const SEG_CACHE_MAX_BYTES: usize = 4 * 1024 * 1024;

static IMG_CACHE: CacheStore<Arc<Vec<u8>>> =
    Lazy::new(|| Mutex::new(LruCache::new(IMG_CACHE_MAX, IMG_CACHE_MAX_BYTES)));
static PL_CACHE: CacheStore<Arc<String>> =
    Lazy::new(|| Mutex::new(LruCache::new(PL_CACHE_MAX, PL_CACHE_MAX_BYTES)));
static KEY_CACHE: CacheStore<SegmentEntry> =
    Lazy::new(|| Mutex::new(LruCache::new(KEY_CACHE_MAX, KEY_CACHE_MAX_BYTES)));
static SEG_CACHE: CacheStore<SegmentEntry> =
    Lazy::new(|| Mutex::new(LruCache::new(SEG_CACHE_MAX, SEG_CACHE_TOTAL_BYTES)));

fn lock_cache<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/* ───────────────────────── AES ───────────────────────── */

fn aes_cbc_decrypt(data: &[u8]) -> Option<Vec<u8>> {
    if data.is_empty() || !data.len().is_multiple_of(16) {
        return None;
    }
    let cipher = Aes128::new_from_slice(IMG_KEY).ok()?;
    let mut prev = [0u8; 16];
    prev.copy_from_slice(IMG_IV);
    let mut out = Vec::with_capacity(data.len());
    for chunk in data.chunks(16) {
        let mut ct = [0u8; 16];
        ct.copy_from_slice(chunk);
        let mut block = ct;
        cipher.decrypt_block((&mut block).into());
        for i in 0..16 {
            out.push(block[i] ^ prev[i]);
        }
        prev = ct;
    }
    Some(out)
}

fn strip_padding(mut buf: Vec<u8>) -> Vec<u8> {
    let pad = *buf.last().unwrap_or(&0) as usize;
    if pad > 0
        && pad <= 16
        && buf.len() >= pad
        && buf[buf.len() - pad..].iter().all(|b| *b as usize == pad)
    {
        buf.truncate(buf.len() - pad);
    }
    buf
}

fn image_kind(buf: &[u8]) -> Option<&'static str> {
    if buf.len() < 12 {
        return None;
    }
    if buf[0] == 0xFF && buf[1] == 0xD8 {
        return Some("image/jpeg");
    }
    if buf.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return Some("image/png");
    }
    if buf.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    if buf.starts_with(b"RIFF") && &buf[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if &buf[4..8] == b"ftyp" {
        if matches!(&buf[8..12], b"avif" | b"avis") {
            return Some("image/avif");
        }
        if matches!(
            &buf[8..12],
            b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1" | b"msf1"
        ) {
            return Some("image/heic");
        }
    }
    if buf.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if buf.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return Some("image/x-icon");
    }
    None
}

fn decode_image_bytes(bytes: Vec<u8>) -> Result<(&'static str, Vec<u8>), String> {
    if let Some(kind) = image_kind(&bytes) {
        return Ok((kind, bytes));
    }
    let dec = aes_cbc_decrypt(&bytes).ok_or_else(|| "封面解密失败".to_string())?;
    let plain = strip_padding(dec);
    let kind = image_kind(&plain).ok_or_else(|| "封面内容格式无效".to_string())?;
    Ok((kind, plain))
}

/// 取封面：命中缓存直接返回，否则下载并按需解密。
pub async fn load_image(url: &str) -> Result<(String, Arc<Vec<u8>>), String> {
    let trimmed = url.trim();
    let resolved = if trimmed.starts_with("//") {
        format!("https:{trimmed}")
    } else if trimmed.starts_with('/') {
        absolutize(&crate::net::base(), trimmed)
    } else {
        trimmed.to_string()
    };
    if let Some(hit) = lock_cache(&IMG_CACHE).get(&resolved) {
        if let Some(kind) = image_kind(&hit) {
            return Ok((kind.to_string(), hit));
        }
    }
    let (_, bytes) = fetch_bytes(&resolved).await?;
    let (kind, plain) = tokio::task::spawn_blocking(move || decode_image_bytes(bytes))
        .await
        .map_err(|_| "封面解密任务中断".to_string())??;
    let len = plain.len();
    let arc = Arc::new(plain);
    lock_cache(&IMG_CACHE).put(resolved, arc.clone(), len);
    Ok((kind.to_string(), arc))
}

/* ───────────────────────── HLS ───────────────────────── */

fn enc(s: &str) -> String {
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

fn dec(s: &str) -> String {
    percent_decode_str(s).decode_utf8_lossy().to_string()
}

fn absolutize(base: &str, target: &str) -> String {
    if target.starts_with("http://") || target.starts_with("https://") {
        return target.to_string();
    }
    if let Ok(b) = url::Url::parse(base) {
        if let Ok(j) = b.join(target) {
            return j.to_string();
        }
    }
    target.to_string()
}

/// 属性列表中的引号内可含逗号，不能直接 split(',')。
fn hls_attributes(line: &str) -> Option<(&str, Vec<&str>)> {
    let (tag, rest) = line.split_once(':')?;
    let mut attributes = Vec::new();
    let mut quoted = false;
    let mut start = 0;
    for (i, ch) in rest.char_indices() {
        if ch == '"' {
            quoted = !quoted;
        }
        if ch == ',' && !quoted {
            attributes.push(&rest[start..i]);
            start = i + 1;
        }
    }
    attributes.push(&rest[start..]);
    Some((tag, attributes))
}

fn map_uri_attributes(line: &str, mut rewrite: impl FnMut(&str) -> String) -> String {
    let Some((tag, attributes)) = hls_attributes(line) else {
        return line.to_string();
    };
    let mapped: Vec<String> = attributes
        .into_iter()
        .map(|attribute| {
            if let Some((key, value)) = attribute.split_once('=') {
                if key.trim() == "URI" {
                    if let Some(uri) = value
                        .trim()
                        .strip_prefix('"')
                        .and_then(|v| v.strip_suffix('"'))
                    {
                        return format!("{key}=\"{}\"", rewrite(uri));
                    }
                }
            }
            attribute.to_string()
        })
        .collect();
    format!("{tag}:{}", mapped.join(","))
}

fn rewrite_uri_attr(line: &str, prefix: &str) -> String {
    map_uri_attributes(line, |uri| format!("{prefix}/seg?u={}", enc(uri)))
}

/// 取 m3u8 并把 key / 子列表 / 分片地址改写到本地协议。
pub async fn load_playlist(url: &str, prefix: &str) -> Result<Arc<String>, String> {
    let cache_key = format!("{prefix}|{url}");
    if let Some(hit) = lock_cache(&PL_CACHE).get(&cache_key) {
        return Ok(hit);
    }
    let (_, bytes) = fetch_bytes(url).await?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "播放列表不是 UTF-8 文本")?;
    if !text.trim_start_matches('\u{feff}').starts_with("#EXTM3U") {
        return Err("响应不是 HLS 播放列表".into());
    }
    let rewritten = rewrite_playlist(url, text, prefix);
    let len = rewritten.len();
    let arc = Arc::new(rewritten);
    lock_cache(&PL_CACHE).put(cache_key, arc.clone(), len);
    Ok(arc)
}

fn rewrite_playlist(url: &str, text: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(text.len() + 512);
    for raw in text.trim_start_matches('\u{feff}').lines() {
        let line = raw.trim_end();
        if line.is_empty() {
            out.push('\n');
            continue;
        }
        if line.starts_with('#') {
            // 禁用可派生 URL 的内容引导；DATERANGE 保留时间线/SCTE-35 元数据。
            if line.starts_with("#EXT-X-CONTENT-STEERING:") {
                continue;
            }
            if line.starts_with("#EXT-X-DATERANGE:") {
                if let Some((tag, attributes)) = hls_attributes(line) {
                    let safe: Vec<&str> = attributes
                        .into_iter()
                        .filter(|attribute| {
                            let key = attribute
                                .split('=')
                                .next()
                                .unwrap_or("")
                                .trim()
                                .to_ascii_uppercase();
                            !key.contains("URI") && key != "X-ASSET-LIST"
                        })
                        .collect();
                    out.push_str(&format!("{tag}:{}\n", safe.join(",")));
                }
                continue;
            }
            if line.contains("URI=\"") {
                // KEY/MAP/MEDIA/SESSION-KEY/PART/PRELOAD-HINT 等 URI 都必须经过目标检查。
                let absolute = absolutize_uri_in_attr(url, line);
                out.push_str(&rewrite_uri_attr(&absolute, prefix));
            } else {
                out.push_str(line);
            }
        } else {
            let absolute = absolutize(url, line);
            out.push_str(&format!("{prefix}/seg?u={}", enc(&absolute)));
        }
        out.push('\n');
    }

    out
}

fn absolutize_uri_in_attr(base: &str, line: &str) -> String {
    map_uri_attributes(line, |uri| absolutize(base, uri))
}

/// 加载分片或 AES Key（带内存缓存，避免拖动进度条时重复拉取同一 Key 或分片导致卡顿）。
pub async fn load_segment(url: &str) -> Result<(Option<String>, Arc<Vec<u8>>), String> {
    if let Some((ctype, hit)) = lock_cache(&KEY_CACHE).get(url) {
        return Ok((Some(ctype), hit));
    }
    if let Some((ctype, hit)) = lock_cache(&SEG_CACHE).get(url) {
        return Ok((Some(ctype), hit));
    }
    let (ctype, bytes) = fetch_bytes(url).await?;
    let mime = ctype.clone().unwrap_or_else(|| {
        let p = url.split('?').next().unwrap_or(url).to_ascii_lowercase();
        if p.ends_with(".ts") {
            "video/mp2t".to_string()
        } else if p.ends_with(".m4s") || p.ends_with(".mp4") {
            "video/mp4".to_string()
        } else {
            "application/octet-stream".to_string()
        }
    });
    let len = bytes.len();
    let arc = Arc::new(bytes);
    if len <= 65536 {
        lock_cache(&KEY_CACHE).put(url.to_string(), (mime.clone(), arc.clone()), len);
    } else if len <= SEG_CACHE_MAX_BYTES {
        lock_cache(&SEG_CACHE).put(url.to_string(), (mime.clone(), arc.clone()), len);
    }
    Ok((Some(mime), arc))
}

/// 清空封面 / 播放列表 / 分片内存缓存
pub fn clear_caches() {
    lock_cache(&IMG_CACHE).clear();
    lock_cache(&PL_CACHE).clear();
    lock_cache(&KEY_CACHE).clear();
    lock_cache(&SEG_CACHE).clear();
}

/// 统计当前内存缓存条目数与字节总数
pub fn cache_stats() -> (usize, usize) {
    let img = lock_cache(&IMG_CACHE);
    let pl = lock_cache(&PL_CACHE);
    let key = lock_cache(&KEY_CACHE);
    let seg = lock_cache(&SEG_CACHE);
    let entries = img.entries.len() + pl.entries.len() + key.entries.len() + seg.entries.len();
    let bytes = img.total_bytes + pl.total_bytes + key.total_bytes + seg.total_bytes;
    (entries, bytes)
}

/* ───────────────────────── 协议响应 ───────────────────────── */

fn respond(status: u16, ctype: &str, body: Vec<u8>, cache: &str) -> Response<Vec<u8>> {
    let len = body.len().to_string();
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::OK))
        .header("Content-Type", ctype)
        .header("Content-Length", len)
        .header("Accept-Ranges", "bytes")
        .header("X-Content-Type-Options", "nosniff")
        .header(
            "Access-Control-Expose-Headers",
            "Content-Length, Content-Type, Accept-Ranges, Content-Range",
        )
        .header("Cache-Control", cache)
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// 解析单段 HTTP `Range: bytes=...` 请求头；多段或非 bytes 请求回退完整响应，越界返回 `Err(())`。
fn parse_byte_range(header: &str, total: usize) -> Result<Option<(usize, usize)>, ()> {
    let trimmed = header.trim();
    let Some((unit, spec)) = trimmed.split_once('=') else {
        return Ok(None);
    };
    if !unit.trim().eq_ignore_ascii_case("bytes") {
        return Ok(None);
    }
    let spec = spec.trim();
    if spec.is_empty() || spec.contains(',') {
        return Ok(None);
    }
    let Some((raw_start, raw_end)) = spec.split_once('-') else {
        return Ok(None);
    };
    let raw_start = raw_start.trim();
    let raw_end = raw_end.trim();
    if raw_start.is_empty() && raw_end.is_empty() {
        return Ok(None);
    }
    if total == 0 {
        return Err(());
    }
    if raw_start.is_empty() {
        let Ok(suffix) = raw_end.parse::<usize>() else {
            return Ok(None);
        };
        if suffix == 0 {
            return Err(());
        }
        let take = suffix.min(total);
        return Ok(Some((total - take, total - 1)));
    }
    let Ok(start) = raw_start.parse::<usize>() else {
        return Ok(None);
    };
    if start >= total {
        return Err(());
    }
    if raw_end.is_empty() {
        return Ok(Some((start, total - 1)));
    }
    let Ok(end) = raw_end.parse::<usize>() else {
        return Ok(None);
    };
    if end < start {
        return Err(());
    }
    Ok(Some((start, end.min(total - 1))))
}

fn respond_bytes(
    ctype: &str,
    body: Arc<Vec<u8>>,
    cache: &str,
    range: Option<&str>,
) -> Response<Vec<u8>> {
    if let Some(range_header) = range {
        match parse_byte_range(range_header, body.len()) {
            Ok(Some((start, end))) => {
                let slice = body[start..=end].to_vec();
                let len = slice.len().to_string();
                let content_range = format!("bytes {start}-{end}/{}", body.len());
                return Response::builder()
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header("Content-Type", ctype)
                    .header("Content-Length", len)
                    .header("Content-Range", content_range)
                    .header("Accept-Ranges", "bytes")
                    .header("X-Content-Type-Options", "nosniff")
                    .header(
                        "Access-Control-Expose-Headers",
                        "Content-Length, Content-Type, Accept-Ranges, Content-Range",
                    )
                    .header("Cache-Control", cache)
                    .body(slice)
                    .unwrap_or_else(|_| Response::new(Vec::new()));
            }
            Err(()) => {
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header("Content-Type", "text/plain")
                    .header("Content-Length", "0")
                    .header("Content-Range", format!("bytes */{}", body.len()))
                    .header("X-Content-Type-Options", "nosniff")
                    .header("Cache-Control", "no-store")
                    .body(Vec::new())
                    .unwrap_or_else(|_| Response::new(Vec::new()));
            }
            Ok(None) => {}
        }
    }
    let owned = Arc::try_unwrap(body).unwrap_or_else(|arc| (*arc).clone());
    respond(200, ctype, owned, cache)
}

/// 主清单的子清单也经 /seg 返回：必须继续改写，不能把内层 URL 原样交给播放器。
fn segment_response(
    target: &str,
    ctype: Option<&str>,
    bytes: Arc<Vec<u8>>,
    origin: &str,
    range: Option<&str>,
) -> Response<Vec<u8>> {
    let playlist = ctype.is_some_and(|t| t.to_ascii_lowercase().contains("mpegurl"))
        || bytes.starts_with(b"#EXTM3U")
        || bytes.starts_with(b"\xef\xbb\xbf#EXTM3U");
    if playlist {
        return match std::str::from_utf8(bytes.as_slice()) {
            Ok(text) => respond(
                200,
                "application/vnd.apple.mpegurl",
                rewrite_playlist(target, text, origin).into_bytes(),
                // Rewriting nested URIs does not require disabling the upstream cache policy.
                "public, max-age=3600",
            ),
            Err(_) => respond(
                502,
                "text/plain",
                b"invalid playlist encoding".to_vec(),
                "no-store",
            ),
        };
    }
    respond_bytes(
        ctype.unwrap_or("application/octet-stream"),
        bytes,
        "public, max-age=3600",
        range,
    )
}

/// 统一入口：`<LOCAL_ORIGIN>/img?u=` / `hls?u=` / `seg?u=`
///
/// `origin` 是本平台自定义协议的完整基址，见 [`LOCAL_ORIGIN`]；用于改写 m3u8 里的
/// 分片与 key 地址。正常情况下调用方直接传 [`LOCAL_ORIGIN`]。
pub async fn handle(
    path: &str,
    query: &str,
    origin: &str,
    range: Option<&str>,
) -> Response<Vec<u8>> {
    let target = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("u="))
        .map(dec)
        .unwrap_or_default();

    if target.is_empty() {
        return respond(400, "text/plain", b"missing u".to_vec(), "no-store");
    }

    let log_enabled = crate::playback_log::enabled();
    let log_meta = if log_enabled {
        let route = match path {
            "/img" => "image",
            "/hls" => "playlist",
            "/seg" => "segment_or_key",
            _ => "unknown",
        };
        let resource = crate::playback_log::resource_id(&target);
        crate::playback_log::record(
            "proxy.begin",
            serde_json::json!({"route": route, "resource": &resource}),
        );
        Some((std::time::Instant::now(), route, resource))
    } else {
        None
    };

    let response = match path {
        "/img" => match load_image(&target).await {
            Ok((kind, bytes)) => respond_bytes(&kind, bytes, "public, max-age=86400", range),
            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
        },
        "/hls" => match load_playlist(&target, origin).await {
            Ok(text) => respond(
                200,
                "application/vnd.apple.mpegurl",
                text.as_bytes().to_vec(),
                "no-store",
            ),
            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
        },
        "/seg" => match load_segment(&target).await {
            Ok((ctype, bytes)) => {
                segment_response(&target, ctype.as_deref(), bytes, origin, range)
            }
            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
        },
        _ => respond(404, "text/plain", b"not found".to_vec(), "no-store"),
    };
    if let Some((started, route, resource)) = log_meta {
        crate::playback_log::record(
            "proxy.end",
            serde_json::json!({"route": route, "resource": resource, "status": response.status().as_u16(), "bytes": response.body().len(), "elapsed_ms": started.elapsed().as_millis() as u64}),
        );
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dateranges_keep_timing_and_scte_metadata_but_drop_external_resources() {
        let line = "#EXTM3U\n#EXT-X-DATERANGE:ID=\"event\",START-DATE=\"2026-11-07T00:00:00Z\",DURATION=4,SCTE35-OUT=0xFC,X-TEXT=\"a,b\",X-ASSET-URI=\"https://evil.example/ad\",X-ASSET-LIST=\"https://evil.example/list.json\"\n";
        let out = rewrite_playlist("https://cdn.example/master.m3u8", line, LOCAL_ORIGIN);
        assert!(out.contains("DURATION=4,SCTE35-OUT=0xFC,X-TEXT=\"a,b\""));
        assert!(out.contains("START-DATE="));
        assert!(!out.contains("evil.example") && !out.contains("X-ASSET"));
    }

    #[test]
    fn every_uri_attribute_is_rewritten_without_splitting_quoted_commas() {
        let line = "#EXT-X-MEDIA:NAME=\"audio,main\",URI=\"first.m3u8\",URI=\"second.m3u8\"";
        let absolute = absolutize_uri_in_attr("https://cdn.example/master.m3u8", line);
        let rewritten = rewrite_uri_attr(&absolute, LOCAL_ORIGIN);
        assert_eq!(
            rewritten.matches(&format!("{LOCAL_ORIGIN}/seg?u=")).count(),
            2
        );
        assert!(rewritten.contains("NAME=\"audio,main\""));
        assert!(!rewritten.contains("URI=\"https://"));
    }

    #[test]
    fn nested_playlists_and_alternate_uris_stay_behind_proxy() {
        let text = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"audio/list.m3u8\"\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"http://127.0.0.1/key\"\n#EXT-X-PART:DURATION=1,URI=\"part.ts\"\nvariant/list.m3u8\n";
        let response = segment_response(
            "https://cdn.example/master.m3u8",
            Some("application/octet-stream"),
            Arc::new(text.as_bytes().to_vec()),
            LOCAL_ORIGIN,
            None,
        );
        let body = std::str::from_utf8(response.body()).unwrap();
        assert_eq!(body.matches(&format!("{LOCAL_ORIGIN}/seg?u=")).count(), 4);
        assert!(!body.contains("URI=\"http://127.0.0.1"));
        assert!(body.contains("https%3A%2F%2Fcdn%2Eexample%2Faudio%2Flist%2Em3u8"));
        assert_eq!(
            response.headers()["Content-Type"],
            "application/vnd.apple.mpegurl"
        );
        assert_eq!(response.headers()["X-Content-Type-Options"], "nosniff");
        assert!(!response
            .headers()
            .contains_key("Access-Control-Allow-Origin"));
        let optional = rewrite_playlist("https://cdn.example/list.m3u8",
            "#EXTM3U\n#EXT-X-CONTENT-STEERING:SERVER-URI=\"https://other.example/list.json\"\n#EXT-X-DATERANGE:ID=\"ad\",X-ASSET-LIST=\"http://127.0.0.1/assets\"\nsegment.ts\n", LOCAL_ORIGIN);
        assert!(!optional.contains("CONTENT-STEERING") && !optional.contains("X-ASSET-LIST"));
        assert!(optional.contains("#EXT-X-DATERANGE:ID=\"ad\""));
        let bom = segment_response(
            "https://cdn.example/list.m3u8",
            None,
            Arc::new(b"\xef\xbb\xbf#EXTM3U\nsegment.ts\n".to_vec()),
            LOCAL_ORIGIN,
            None,
        );
        assert!(bom.body().starts_with(b"#EXTM3U\n"));
    }

    #[test]
    fn lru_cache_enforces_entry_and_byte_limits_and_evicts_oldest() {
        let mut cache = LruCache::new(3, 10);
        cache.put("a".into(), vec![1; 4], 4);
        cache.put("b".into(), vec![2; 4], 4);
        // 命中 a，使其比 b 更新
        assert_eq!(cache.get("a"), Some(vec![1; 4]));
        // 插入 c(4B) 需要 4+4+4=12 > 10，应先淘汰最久未用的 b
        cache.put("c".into(), vec![3; 4], 4);
        assert!(cache.get("b").is_none());
        assert_eq!(cache.get("a"), Some(vec![1; 4]));
        assert_eq!(cache.get("c"), Some(vec![3; 4]));
        assert_eq!(cache.total_bytes, 8);
        // 覆盖已有键不应错误淘汰其他键
        cache.put("a".into(), vec![9; 5], 5);
        assert_eq!(cache.total_bytes, 9);
        assert_eq!(cache.get("c"), Some(vec![3; 4]));
        // 超出单缓存总字节上限的条目跳过写入
        cache.put("oversize".into(), vec![0; 11], 11);
        assert!(cache.get("oversize").is_none());
    }

    #[test]
    fn cache_stats_reports_entries_and_bytes_across_stores() {
        clear_caches();
        assert_eq!(cache_stats(), (0, 0));
        lock_cache(&IMG_CACHE).put("k1".into(), Arc::new(vec![1u8; 10]), 10);
        lock_cache(&PL_CACHE).put("k2".into(), Arc::new("abc".to_string()), 3);
        let (entries, bytes) = cache_stats();
        assert_eq!(entries, 2);
        assert_eq!(bytes, 13);
        clear_caches();
        assert_eq!(cache_stats(), (0, 0));
    }

    #[test]
    fn range_requests_return_206_and_416_correctly() {
        let payload = Arc::new(b"0123456789".to_vec());
        let full = respond_bytes("video/mp4", payload.clone(), "public, max-age=3600", None);
        assert_eq!(full.status(), 200);
        assert_eq!(full.body(), payload.as_slice());

        let r1 = respond_bytes("video/mp4", payload.clone(), "public, max-age=3600", Some("bytes=2-5"));
        assert_eq!(r1.status(), 206);
        assert_eq!(r1.body(), b"2345");
        assert_eq!(r1.headers()["Content-Range"], "bytes 2-5/10");
        assert_eq!(r1.headers()["Content-Length"], "4");

        let r2 = respond_bytes("video/mp4", payload.clone(), "public, max-age=3600", Some("bytes=7-99"));
        assert_eq!(r2.status(), 206);
        assert_eq!(r2.body(), b"789");
        assert_eq!(r2.headers()["Content-Range"], "bytes 7-9/10");

        let r3 = respond_bytes("video/mp4", payload.clone(), "public, max-age=3600", Some("bytes=-3"));
        assert_eq!(r3.status(), 206);
        assert_eq!(r3.body(), b"789");
        assert_eq!(r3.headers()["Content-Range"], "bytes 7-9/10");

        let bad = respond_bytes("video/mp4", payload.clone(), "public, max-age=3600", Some("bytes=10-12"));
        assert_eq!(bad.status(), 416);
        assert_eq!(bad.headers()["Content-Range"], "bytes */10");

        let rev = respond_bytes("video/mp4", payload, "public, max-age=3600", Some("bytes=6-2"));
        assert_eq!(rev.status(), 416);

        let empty_bad = respond_bytes("video/mp4", Arc::new(Vec::new()), "public, max-age=3600", Some("bytes=0-0"));
        assert_eq!(empty_bad.status(), 416);
        assert_eq!(empty_bad.headers()["Content-Range"], "bytes */0");
    }

    /// 联网测试：默认跳过，手动跑 `cargo test --lib -- --ignored`。
    /// 依赖上游 `/api/videos/117/episodes/3/playback` 返回的实时播放地址。
    #[tokio::test]
    #[ignore = "联网测试：依赖上游实时播放地址，手动用 --ignored 运行"]
    async fn live_play_chain() {
        use crate::net::edge;
        let play = edge(
            &crate::net::base(),
            "POST",
            "/api/videos/117/episodes/3/playback",
            Some(serde_json::json!({})),
            None,
        )
        .await
        .expect("play api");
        let url = play
            .get("streams")
            .and_then(|s| s.get("main"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| play.get("video_url").and_then(|v| v.as_str()))
            .expect("video_url")
            .to_string();
        println!("play url: {}", &url[..url.len().min(90)]);
        let (_, bytes) = fetch_bytes(&url).await.expect("fetch playlist");
        let text = String::from_utf8_lossy(&bytes);
        println!(
            "raw playlist len={} head={}",
            text.len(),
            &text[..text.len().min(160)]
        );
        let q = format!("u={}", enc(&url));
        let resp = handle("/hls", &q, LOCAL_ORIGIN, None).await;
        let body = String::from_utf8_lossy(resp.body()).to_string();
        println!("proxied status={} len={}", resp.status(), body.len());
        assert!(body.contains("#EXTM3U"));
        // 取一个分片验证
        let seg_line = body
            .lines()
            .find(|l| !l.starts_with('#') && l.contains("/seg?u="))
            .expect("seg line")
            .to_string();
        println!("seg line: {}", &seg_line[..seg_line.len().min(120)]);
        let seg_q = seg_line.split("?u=").nth(1).unwrap();
        let seg = handle("/seg", &format!("u={seg_q}"), LOCAL_ORIGIN, None).await;
        println!("segment status={} len={}", seg.status(), seg.body().len());
        assert_eq!(seg.status(), 200);
        assert!(seg.body().len() > 1000);
    }

    /// 离线回归：不再依赖带 auth_key 时效的真实上游地址（旧地址已过期，会 403）。
    /// 与真实播放列表同构：带签名的分片地址 + 加密 KEY + 相对路径分片。
    #[test]
    fn playlist_rewrite_works() {
        let base = "https://cdn.example/videos5/abc/abc.m3u8?auth_key=9999999999-0-0-deadbeef&v=3&via=hgdj";
        let text = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin?auth_key=9999999999-0-0-deadbeef\"\n#EXTINF:4,\nseg-1.ts?auth_key=9999999999-0-0-deadbeef\n";
        let body = rewrite_playlist(base, text, LOCAL_ORIGIN);

        assert!(body.contains("#EXTM3U"), "not a playlist: {body}");
        assert!(
            body.contains(&format!("{LOCAL_ORIGIN}/seg?u=")),
            "segments not rewritten: {body}"
        );
        // 分片必须绝对化到源站，并保留签名查询串。
        assert!(
            body.contains("https%3A%2F%2Fcdn%2Eexample%2Fvideos5%2Fabc%2Fseg%2D1%2Ets%3Fauth%5Fkey%3D"),
            "segment not absolutized with query: {body}"
        );
        // 加密 KEY 也要走本地代理，否则 hls.js 会直接打源站被 CORS 拦住。
        assert!(
            body.contains("URI=\"") && body.contains("%2Fkey%2Ebin%3Fauth%5Fkey%3D"),
            "key uri not rewritten: {body}"
        );
        assert!(!body.contains("URI=\"key.bin"), "key uri left relative");
    }

    /// 离线回归：用已知明文 + 项目内置 key/IV 构造密文，验证解密、去填充与类型识别。
    /// 真实封面抓取那条仍保留为 `#[ignore]` 联网测试。
    #[test]
    fn cover_decrypt_roundtrip() {
        use aes::cipher::BlockEncrypt;

        let plain = b"\xFF\xD8\xFF\xE0cover-payload-for-test".to_vec();
        let mut buf = plain.clone();
        let pad = 16 - plain.len() % 16;
        buf.extend(std::iter::repeat_n(pad as u8, pad));

        let cipher = Aes128::new_from_slice(IMG_KEY).expect("key");
        let mut prev = [0u8; 16];
        prev.copy_from_slice(IMG_IV);
        let mut encrypted = Vec::with_capacity(buf.len());
        for chunk in buf.chunks(16) {
            let mut block = [0u8; 16];
            block.copy_from_slice(chunk);
            for i in 0..16 {
                block[i] ^= prev[i];
            }
            let mut out_block = block;
            cipher.encrypt_block((&mut out_block).into());
            encrypted.extend_from_slice(&out_block);
            prev = out_block;
        }

        let decrypted = aes_cbc_decrypt(&encrypted).expect("decrypt");
        let stripped = strip_padding(decrypted);
        assert_eq!(stripped, plain);
        assert_eq!(image_kind(&stripped), Some("image/jpeg"));
    }

    #[test]
    fn image_kind_recognizes_avif_heic_bmp_and_rejects_html() {
        let mut avif = b"\x00\x00\x00\x1cftypavif\x00\x00\x00\x00".to_vec();
        avif.extend_from_slice(&[0u8; 8]);
        assert_eq!(image_kind(&avif), Some("image/avif"));
        let mut heic = b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00".to_vec();
        heic.extend_from_slice(&[0u8; 8]);
        assert_eq!(image_kind(&heic), Some("image/heic"));
        let mut bmp = b"BM".to_vec();
        bmp.extend_from_slice(&[0u8; 16]);
        assert_eq!(image_kind(&bmp), Some("image/bmp"));
        assert_eq!(image_kind(b"<html><body>404</body></html>"), None);
    }

    #[test]
    fn decode_image_bytes_rejects_invalid_decrypted_payload() {
        use aes::cipher::BlockEncrypt;

        let html = b"<html><body>not-an-image</body></html>";
        let mut buf = html.to_vec();
        let pad = 16 - html.len() % 16;
        buf.extend(std::iter::repeat_n(pad as u8, pad));

        let cipher = Aes128::new_from_slice(IMG_KEY).expect("key");
        let mut prev = [0u8; 16];
        prev.copy_from_slice(IMG_IV);
        let mut encrypted = Vec::with_capacity(buf.len());
        for chunk in buf.chunks(16) {
            let mut block = [0u8; 16];
            block.copy_from_slice(chunk);
            for i in 0..16 {
                block[i] ^= prev[i];
            }
            let mut out_block = block;
            cipher.encrypt_block((&mut out_block).into());
            encrypted.extend_from_slice(&out_block);
            prev = out_block;
        }
        assert!(decode_image_bytes(encrypted).is_err());
        assert!(decode_image_bytes(b"<html>403</html>".to_vec()).is_err());
    }

    /// 联网测试：默认跳过。封面地址带时效签名，不能硬编码进仓库，
    /// 需要用当次上游返回的地址显式传入：
    /// `HGHUB_TEST_COVER_URL='https://…?auth_key=…' cargo test --lib -- --ignored`
    #[tokio::test]
    #[ignore = "联网测试：需要 HGHUB_TEST_COVER_URL，手动用 --ignored 运行"]
    async fn cover_decrypt_works() {
        let url = std::env::var("HGHUB_TEST_COVER_URL")
            .expect("需要设置 HGHUB_TEST_COVER_URL 为当前有效的封面地址");
        match load_image(&url).await {
            Ok((kind, bytes)) => {
                println!("kind={kind} len={}", bytes.len());
                assert!(kind.starts_with("image/"));
            }
            Err(e) => panic!("image failed: {e}"),
        }
    }
}
