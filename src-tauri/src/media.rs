//! 媒体层：封面解密 + HLS 代理。
//!
//! 站点封面是 AES-128-CBC 密文，m3u8 内部分片/key 又可能被 WebView 的 CORS 拦住，
//! 所以图片与视频统一走本地自定义协议（Windows/Android 为 `http://hg.localhost`，
//! macOS 为 `hg://localhost`，见 [`LOCAL_ORIGIN`]）。

use crate::net::{
    fetch_bytes, fetch_bytes_with_range, fetch_bytes_with_timeout_attempts, get, read_text_limited,
    MAX_MEDIA_BYTES, MAX_TEXT_BYTES,
};
use aes::cipher::{BlockDecrypt, KeyInit};
use aes::Aes128;
use once_cell::sync::Lazy;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::{Duration, Instant, SystemTime};
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

const LRU_NONE: usize = usize::MAX;

struct CacheNode<V> {
    key: String,
    bytes: usize,
    val: Option<V>,
    prev: usize,
    next: usize,
}

struct LruCache<V> {
    max_entries: usize,
    max_bytes: usize,
    total_bytes: usize,
    head: usize,
    tail: usize,
    nodes: Vec<CacheNode<V>>,
    free: Vec<usize>,
    entries: HashMap<String, usize>,
}

impl<V: Clone> LruCache<V> {
    fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            max_entries,
            max_bytes,
            total_bytes: 0,
            head: LRU_NONE,
            tail: LRU_NONE,
            nodes: Vec::new(),
            free: Vec::new(),
            entries: HashMap::new(),
        }
    }

    fn detach(&mut self, idx: usize) {
        let (prev, next) = (self.nodes[idx].prev, self.nodes[idx].next);
        if prev != LRU_NONE {
            self.nodes[prev].next = next;
        } else {
            self.head = next;
        }
        if next != LRU_NONE {
            self.nodes[next].prev = prev;
        } else {
            self.tail = prev;
        }
        self.nodes[idx].prev = LRU_NONE;
        self.nodes[idx].next = LRU_NONE;
    }

    fn attach_front(&mut self, idx: usize) {
        self.nodes[idx].prev = LRU_NONE;
        self.nodes[idx].next = self.head;
        if self.head != LRU_NONE {
            self.nodes[self.head].prev = idx;
        } else {
            self.tail = idx;
        }
        self.head = idx;
    }

    fn evict_tail(&mut self) -> bool {
        let idx = self.tail;
        if idx == LRU_NONE {
            return false;
        }
        self.detach(idx);
        let key = std::mem::take(&mut self.nodes[idx].key);
        let bytes = self.nodes[idx].bytes;
        self.nodes[idx].val = None;
        self.nodes[idx].bytes = 0;
        self.entries.remove(&key);
        self.total_bytes = self.total_bytes.saturating_sub(bytes);
        self.free.push(idx);
        true
    }

    fn get(&mut self, key: &str) -> Option<V> {
        let idx = *self.entries.get(key)?;
        if idx != self.head {
            self.detach(idx);
            self.attach_front(idx);
        }
        self.nodes[idx].val.clone()
    }

    fn put(&mut self, key: String, val: V, bytes: usize) {
        if self.max_entries == 0 || bytes > self.max_bytes {
            return;
        }
        if let Some(&idx) = self.entries.get(&key) {
            let old_bytes = self.nodes[idx].bytes;
            self.total_bytes = self.total_bytes.saturating_sub(old_bytes);
            self.nodes[idx].bytes = bytes;
            self.nodes[idx].val = Some(val);
            self.total_bytes = self.total_bytes.saturating_add(bytes);
            if idx != self.head {
                self.detach(idx);
                self.attach_front(idx);
            }
            while self.total_bytes > self.max_bytes {
                if !self.evict_tail() {
                    break;
                }
            }
            return;
        }
        while self.entries.len() >= self.max_entries
            || self.total_bytes.saturating_add(bytes) > self.max_bytes
        {
            if !self.evict_tail() {
                break;
            }
        }
        let idx = if let Some(slot) = self.free.pop() {
            self.nodes[slot] = CacheNode {
                key: key.clone(),
                bytes,
                val: Some(val),
                prev: LRU_NONE,
                next: LRU_NONE,
            };
            slot
        } else {
            let slot = self.nodes.len();
            self.nodes.push(CacheNode {
                key: key.clone(),
                bytes,
                val: Some(val),
                prev: LRU_NONE,
                next: LRU_NONE,
            });
            slot
        };
        self.attach_front(idx);
        self.total_bytes = self.total_bytes.saturating_add(bytes);
        self.entries.insert(key, idx);
    }

    fn trim_to(&mut self, max_entries: usize, max_bytes: usize) {
        while self.entries.len() > max_entries || self.total_bytes > max_bytes {
            if !self.evict_tail() {
                break;
            }
        }
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.nodes.clear();
        self.free.clear();
        self.head = LRU_NONE;
        self.tail = LRU_NONE;
        self.total_bytes = 0;
    }
}

type SegmentEntry = (String, Arc<Vec<u8>>);
type CacheStore<V> = Lazy<Mutex<LruCache<V>>>;

#[cfg(any(target_os = "ios", target_os = "android"))]
const IMG_CACHE_MAX: usize = 80;
#[cfg(any(target_os = "ios", target_os = "android"))]
const IMG_CACHE_MAX_BYTES: usize = 8 * 1024 * 1024;
#[cfg(any(target_os = "ios", target_os = "android"))]
const IMG_DISK_MAX_FILES: usize = 400;
#[cfg(any(target_os = "ios", target_os = "android"))]
const IMG_DISK_MAX_BYTES: usize = 48 * 1024 * 1024;
#[cfg(any(target_os = "ios", target_os = "android"))]
const IMG_NET_CONCURRENCY: usize = 4;
#[cfg(any(target_os = "ios", target_os = "android"))]
const RANGE_OPEN_CHUNK: usize = 2 * 1024 * 1024;
#[cfg(any(target_os = "ios", target_os = "android"))]
const PL_CACHE_MAX: usize = 24;
#[cfg(any(target_os = "ios", target_os = "android"))]
const PL_CACHE_MAX_BYTES: usize = 2 * 1024 * 1024;
#[cfg(any(target_os = "ios", target_os = "android"))]
const KEY_CACHE_MAX: usize = 64;
#[cfg(any(target_os = "ios", target_os = "android"))]
const KEY_CACHE_MAX_BYTES: usize = 1 * 1024 * 1024;
#[cfg(any(target_os = "ios", target_os = "android"))]
const SEG_CACHE_MAX: usize = 12;
#[cfg(any(target_os = "ios", target_os = "android"))]
const SEG_CACHE_TOTAL_BYTES: usize = 20 * 1024 * 1024;
#[cfg(any(target_os = "ios", target_os = "android"))]
const SEG_CACHE_MAX_BYTES: usize = 4 * 1024 * 1024;

#[cfg(not(any(target_os = "ios", target_os = "android")))]
const IMG_CACHE_MAX: usize = 240;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const IMG_CACHE_MAX_BYTES: usize = 48 * 1024 * 1024;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const IMG_DISK_MAX_FILES: usize = 1200;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const IMG_DISK_MAX_BYTES: usize = 120 * 1024 * 1024;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const IMG_NET_CONCURRENCY: usize = 6;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const RANGE_OPEN_CHUNK: usize = 4 * 1024 * 1024;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const PL_CACHE_MAX: usize = 60;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const PL_CACHE_MAX_BYTES: usize = 8 * 1024 * 1024;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const KEY_CACHE_MAX: usize = 120;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const KEY_CACHE_MAX_BYTES: usize = 4 * 1024 * 1024;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const SEG_CACHE_MAX: usize = 48;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const SEG_CACHE_TOTAL_BYTES: usize = 64 * 1024 * 1024;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const SEG_CACHE_MAX_BYTES: usize = 8 * 1024 * 1024;

static IMG_CACHE: CacheStore<Arc<Vec<u8>>> =
    Lazy::new(|| Mutex::new(LruCache::new(IMG_CACHE_MAX, IMG_CACHE_MAX_BYTES)));
static PL_CACHE: CacheStore<Arc<String>> =
    Lazy::new(|| Mutex::new(LruCache::new(PL_CACHE_MAX, PL_CACHE_MAX_BYTES)));
static KEY_CACHE: CacheStore<SegmentEntry> =
    Lazy::new(|| Mutex::new(LruCache::new(KEY_CACHE_MAX, KEY_CACHE_MAX_BYTES)));
static SEG_CACHE: CacheStore<SegmentEntry> =
    Lazy::new(|| Mutex::new(LruCache::new(SEG_CACHE_MAX, SEG_CACHE_TOTAL_BYTES)));

static IMG_DISK_DIR: Lazy<RwLock<Option<PathBuf>>> = Lazy::new(|| RwLock::new(None));
static DISK_INDEX: Lazy<Mutex<Option<(PathBuf, HashSet<String>)>>> = Lazy::new(|| Mutex::new(None));
static DISK_WRITES: AtomicU64 = AtomicU64::new(0);
static DISK_TMP_SEQ: AtomicU64 = AtomicU64::new(0);
static IMG_NET_SEM: Lazy<tokio::sync::Semaphore> =
    Lazy::new(|| tokio::sync::Semaphore::new(IMG_NET_CONCURRENCY));
static PREWARM_GEN: AtomicU64 = AtomicU64::new(0);
static PREWARM_SEM: Lazy<tokio::sync::Semaphore> = Lazy::new(|| tokio::sync::Semaphore::new(1));
static PREWARM_TASK: Lazy<Mutex<Option<tokio::task::AbortHandle>>> =
    Lazy::new(|| Mutex::new(None));

#[derive(Clone, Debug, PartialEq, Eq)]
struct CdnWebpConfig {
    base: String,
    hosts: Vec<String>,
}

const CDN_CONFIG_TTL: Duration = Duration::from_secs(600);
const CDN_CONFIG_ERR_TTL: Duration = Duration::from_secs(30);
const WEBP_CANDIDATE_TIMEOUT: Duration = Duration::from_secs(4);
const WEBP_HOST_COOLDOWN_TTL: Duration = Duration::from_secs(60);

static IMG_INFLIGHT: Lazy<InFlight<(String, Arc<Vec<u8>>)>> = Lazy::new(InFlight::new);
static PL_INFLIGHT: Lazy<InFlight<Arc<String>>> = Lazy::new(InFlight::new);
static SEG_INFLIGHT: Lazy<InFlight<(Option<String>, Arc<Vec<u8>>)>> = Lazy::new(InFlight::new);
static CDN_WEBP_CACHE: Lazy<Mutex<HashMap<String, (Instant, Option<CdnWebpConfig>)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static CDN_WEBP_FLIGHT: Lazy<tokio::sync::Mutex<()>> =
    Lazy::new(|| tokio::sync::Mutex::new(()));
static WEBP_HOST_COOLDOWN: Lazy<Mutex<HashMap<String, Instant>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn lock_cache<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

type WatchRx<V> = tokio::sync::watch::Receiver<Option<Result<V, String>>>;
type WatchTx<V> = tokio::sync::watch::Sender<Option<Result<V, String>>>;

struct FlightGuard<V: Clone> {
    map: Arc<Mutex<HashMap<String, WatchRx<V>>>>,
    key: String,
    tx: Option<WatchTx<V>>,
}

impl<V: Clone> FlightGuard<V> {
    fn finish(mut self, result: Result<V, String>) -> Result<V, String> {
        {
            let mut guard = lock_cache(&self.map);
            guard.remove(&self.key);
        }
        if let Some(tx) = self.tx.take() {
            let _ = tx.send(Some(result.clone()));
        }
        result
    }
}

impl<V: Clone> Drop for FlightGuard<V> {
    fn drop(&mut self) {
        if let Some(tx) = self.tx.take() {
            {
                let mut guard = lock_cache(&self.map);
                guard.remove(&self.key);
            }
            let _ = tx.send(Some(Err("请求已取消".to_string())));
        }
    }
}

enum FlightRole<V: Clone> {
    Leader(FlightGuard<V>),
    Waiter(WatchRx<V>),
}

struct InFlight<V> {
    map: Arc<Mutex<HashMap<String, WatchRx<V>>>>,
}

impl<V: Clone> InFlight<V> {
    fn new() -> Self {
        Self {
            map: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn enter(&self, key: &str) -> FlightRole<V> {
        let mut guard = lock_cache(&self.map);
        if let Some(rx) = guard.get(key) {
            return FlightRole::Waiter(rx.clone());
        }
        let (tx, rx) = tokio::sync::watch::channel(None);
        guard.insert(key.to_string(), rx);
        FlightRole::Leader(FlightGuard {
            map: self.map.clone(),
            key: key.to_string(),
            tx: Some(tx),
        })
    }

    async fn run<F, Fut>(&self, key: &str, work: F) -> Result<V, String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<V, String>>,
    {
        match self.enter(key) {
            FlightRole::Leader(guard) => {
                let result = work().await;
                guard.finish(result)
            }
            FlightRole::Waiter(mut rx) => loop {
                if let Some(res) = rx.borrow_and_update().clone() {
                    return res;
                }
                if rx.changed().await.is_err() {
                    if let Some(res) = rx.borrow().clone() {
                        return res;
                    }
                    return Err("在途请求中断".to_string());
                }
            },
        }
    }
}

pub fn bind_cache_dir(dir: &Path) {
    if std::fs::create_dir_all(dir).is_ok() {
        if let Ok(mut guard) = IMG_DISK_DIR.write() {
            *guard = Some(dir.to_path_buf());
        }
        *lock_cache(&DISK_INDEX) = None;
    }
}

fn disk_cache_dir() -> Option<PathBuf> {
    IMG_DISK_DIR.read().ok().and_then(|g| g.clone())
}

fn is_bound_cache_dir(dir: &Path) -> bool {
    IMG_DISK_DIR
        .read()
        .ok()
        .and_then(|g| g.as_ref().map(|p| p == dir))
        .unwrap_or(false)
}

fn disk_index_may_contain(dir: &Path, filename: &str) -> bool {
    if !is_bound_cache_dir(dir) {
        return true;
    }
    {
        let guard = lock_cache(&DISK_INDEX);
        if let Some((indexed_dir, set)) = guard.as_ref() {
            if indexed_dir == dir {
                return set.contains(filename);
            }
        }
    }
    let mut built = HashSet::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("img") {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    built.insert(name.to_string());
                }
            }
        }
    }
    let hit = built.contains(filename);
    let mut guard = lock_cache(&DISK_INDEX);
    *guard = Some((dir.to_path_buf(), built));
    hit
}

fn disk_index_insert(dir: &Path, filename: &str) {
    if let Some((indexed_dir, set)) = lock_cache(&DISK_INDEX).as_mut() {
        if indexed_dir == dir {
            set.insert(filename.to_string());
        }
    }
}

fn disk_index_remove(dir: &Path, filename: &str) {
    if let Some((indexed_dir, set)) = lock_cache(&DISK_INDEX).as_mut() {
        if indexed_dir == dir {
            set.remove(filename);
        }
    }
}

fn disk_cache_filename(key: &str) -> String {
    const OFFSET_BASIS: u128 = 0x6c62272e07bb0142_62b821756295c58d;
    const PRIME: u128 = 0x0000000001000000_000000000000013b;
    let mut hash = OFFSET_BASIS;
    for &b in key.as_bytes() {
        hash ^= b as u128;
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{hash:032x}.img")
}

fn read_disk_image(dir: &Path, key: &str) -> Option<(&'static str, Vec<u8>)> {
    let filename = disk_cache_filename(key);
    if !disk_index_may_contain(dir, &filename) {
        return None;
    }
    let path = dir.join(&filename);
    let Ok(bytes) = std::fs::read(&path) else {
        disk_index_remove(dir, &filename);
        return None;
    };
    if let Some(kind) = image_kind(&bytes) {
        // 近似 LRU：命中超过 30 分钟才刷新 mtime，大幅减少移动端闪存元数据写入与唤醒
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta
                .modified()
                .ok()
                .and_then(|t| SystemTime::now().duration_since(t).ok())
                .is_some_and(|age| age.as_secs() > 1800)
            {
                if let Ok(file) = std::fs::File::options().write(true).open(&path) {
                    let _ = file.set_modified(SystemTime::now());
                }
            }
        }
        Some((kind, bytes))
    } else {
        let _ = std::fs::remove_file(&path);
        disk_index_remove(dir, &filename);
        None
    }
}

fn prune_disk_cache(dir: &Path, max_files: usize, max_bytes: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(PathBuf, usize, SystemTime)> = Vec::new();
    let mut total_bytes = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("img") {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let len = usize::try_from(meta.len()).unwrap_or(usize::MAX);
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        total_bytes = total_bytes.saturating_add(len);
        files.push((path, len, modified));
    }
    if files.len() <= max_files && total_bytes <= max_bytes {
        return;
    }
    files.sort_unstable_by_key(|(_, _, modified)| *modified);
    let mut remaining = files.len();
    for (path, len, _) in files {
        if remaining <= max_files && total_bytes <= max_bytes {
            break;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_string);
        if std::fs::remove_file(path).is_ok() {
            if let Some(n) = name {
                disk_index_remove(dir, &n);
            }
            remaining = remaining.saturating_sub(1);
            total_bytes = total_bytes.saturating_sub(len);
        }
    }
}

fn write_disk_image(dir: &Path, key: &str, bytes: &[u8]) {
    if bytes.is_empty() || bytes.len() > IMG_CACHE_MAX_BYTES {
        return;
    }
    let final_name = disk_cache_filename(key);
    let final_path = dir.join(&final_name);
    let seq = DISK_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_path = dir.join(format!("{final_name}.{}.{seq}.tmp", std::process::id()));
    if std::fs::write(&tmp_path, bytes).is_err() {
        let _ = std::fs::remove_file(&tmp_path);
        return;
    }
    if std::fs::rename(&tmp_path, &final_path).is_err() {
        let _ = std::fs::remove_file(&tmp_path);
        return;
    }
    disk_index_insert(dir, &final_name);
    if DISK_WRITES
        .fetch_add(1, Ordering::Relaxed)
        .is_multiple_of(32)
    {
        prune_disk_cache(dir, IMG_DISK_MAX_FILES, IMG_DISK_MAX_BYTES);
    }
}

fn clear_disk_dir(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.ends_with(".img") || name.contains(".tmp") {
            let _ = std::fs::remove_file(path);
        }
    }
    if let Some((indexed_dir, set)) = lock_cache(&DISK_INDEX).as_mut() {
        if indexed_dir == dir {
            set.clear();
        }
    }
}

fn disk_cache_stats(dir: &Path) -> (usize, usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (0, 0);
    };
    let mut count = 0usize;
    let mut bytes = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("img") {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    count += 1;
                    bytes = bytes.saturating_add(usize::try_from(meta.len()).unwrap_or(usize::MAX));
                }
            }
        }
    }
    (count, bytes)
}

/* ───────────────────────── AES ───────────────────────── */

fn aes_cbc_decrypt(mut data: Vec<u8>) -> Option<Vec<u8>> {
    if data.is_empty() || !data.len().is_multiple_of(16) {
        return None;
    }
    let cipher = Aes128::new_from_slice(IMG_KEY).ok()?;
    let mut prev = [0u8; 16];
    prev.copy_from_slice(IMG_IV);
    for chunk in data.chunks_exact_mut(16) {
        let mut ct = [0u8; 16];
        ct.copy_from_slice(chunk);
        let mut block = ct;
        cipher.decrypt_block((&mut block).into());
        for i in 0..16 {
            chunk[i] = block[i] ^ prev[i];
        }
        prev = ct;
    }
    Some(data)
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
    let dec = aes_cbc_decrypt(bytes).ok_or_else(|| "封面解密失败".to_string())?;
    let plain = strip_padding(dec);
    let kind = image_kind(&plain).ok_or_else(|| "封面内容格式无效".to_string())?;
    Ok((kind, plain))
}

fn is_volatile_image_param(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "auth_key" | "sign" | "sig" | "token" | "expires" | "expire" | "t" | "ts" | "r"
    )
}

fn image_cache_key(resolved: &str) -> String {
    let Ok(mut parsed) = url::Url::parse(resolved) else {
        return resolved.to_string();
    };
    parsed.set_fragment(None);
    if parsed.query().is_some() {
        let kept: Vec<(String, String)> = parsed
            .query_pairs()
            .filter(|(k, _)| !is_volatile_image_param(k))
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        if kept.is_empty() {
            parsed.set_query(None);
        } else {
            let mut pairs = parsed.query_pairs_mut();
            pairs.clear();
            for (k, v) in kept {
                pairs.append_pair(&k, &v);
            }
        }
    }
    parsed.into()
}

fn parse_cdn_webp_config(raw: &str) -> Option<CdnWebpConfig> {
    let trimmed = raw.trim_start_matches('\u{feff}').trim();
    let json_text = if let Some(rest) = trimmed.strip_prefix("define(") {
        let without_semi = rest.trim_end().strip_suffix(';').unwrap_or(rest).trim_end();
        without_semi.strip_suffix(')')?.trim()
    } else {
        trimmed
    };
    let val: serde_json::Value = serde_json::from_str(json_text).ok()?;
    let webp = val.get("webp")?;
    if webp.get("enabled").and_then(|v| v.as_bool()) != Some(true) {
        return None;
    }
    let base_raw = webp.get("base").and_then(|v| v.as_str())?.trim();
    let base_url = url::Url::parse(base_raw).ok()?;
    if base_url.scheme() != "https"
        || !base_url.username().is_empty()
        || base_url.password().is_some()
        || base_url.query().is_some()
        || base_url.fragment().is_some()
        || crate::network_policy::parse_target(base_raw).is_err()
    {
        return None;
    }
    let hosts: Vec<String> = webp
        .get("hosts")?
        .as_array()?
        .iter()
        .filter_map(|v| v.as_str())
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    if hosts.is_empty() {
        return None;
    }
    Some(CdnWebpConfig {
        base: base_raw.trim_end_matches('/').to_string(),
        hosts,
    })
}

fn has_webp_convertible_ext(path: &str) -> bool {
    let file_name = path.rsplit('/').next().unwrap_or("");
    let Some((_, ext)) = file_name.rsplit_once('.') else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "bmp"
    )
}

fn looks_like_webp_eligible_path(resolved: &str) -> bool {
    let Ok(url) = url::Url::parse(resolved) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
        && !url.path().starts_with("/static/")
        && has_webp_convertible_ext(url.path())
}

fn webp_candidate_url(resolved: &str, site_origin: &str, cfg: &CdnWebpConfig) -> Option<String> {
    let url = url::Url::parse(resolved).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    if !cfg.hosts.iter().any(|h| h == &host) {
        return None;
    }
    let path = url.path();
    if !has_webp_convertible_ext(path) || path.starts_with("/static/") {
        return None;
    }
    if path.starts_with("/upload/")
        && url::Url::parse(site_origin).ok().is_some_and(|origin| {
            origin.origin().ascii_serialization() == url.origin().ascii_serialization()
        })
    {
        return None;
    }
    let candidate = format!("{}{path}.webp", cfg.base);
    if candidate == resolved || crate::network_policy::parse_target(&candidate).is_err() {
        return None;
    }
    Some(candidate)
}

async fn cdn_webp_config(origin: &str) -> Option<CdnWebpConfig> {
    let base_origin = origin.trim().trim_end_matches('/');
    let key = base_origin.to_ascii_lowercase();
    if key.is_empty() {
        return None;
    }
    let now = Instant::now();
    if let Some((expires, cached)) = lock_cache(&CDN_WEBP_CACHE).get(&key) {
        if now < *expires {
            return cached.clone();
        }
    }
    let _flight = CDN_WEBP_FLIGHT.lock().await;
    let now = Instant::now();
    if let Some((expires, cached)) = lock_cache(&CDN_WEBP_CACHE).get(&key) {
        if now < *expires {
            return cached.clone();
        }
    }
    let cfg_url = format!("{base_origin}/cdn-config.js");
    let referer = format!("{base_origin}/");
    let parsed = match get(&cfg_url, Duration::from_secs(5), Some("*/*"), Some(&referer)).await {
        Ok(resp) if resp.status().is_success() => read_text_limited(resp, MAX_TEXT_BYTES)
            .await
            .ok()
            .and_then(|text| parse_cdn_webp_config(&text)),
        _ => None,
    };
    let ttl = if parsed.is_some() {
        CDN_CONFIG_TTL
    } else {
        CDN_CONFIG_ERR_TTL
    };
    let expires = Instant::now() + ttl;
    let mut cache = lock_cache(&CDN_WEBP_CACHE);
    let now = Instant::now();
    cache.retain(|_, (exp, _)| now < *exp);
    if cache.len() >= 16 {
        cache.clear();
    }
    cache.insert(key, (expires, parsed.clone()));
    parsed
}

fn is_webp_host_in_cooldown(url: &str) -> bool {
    let Some(host) = url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_ascii_lowercase()))
    else {
        return false;
    };
    let now = Instant::now();
    let mut map = lock_cache(&WEBP_HOST_COOLDOWN);
    match map.get(&host).copied() {
        Some(until) if now < until => true,
        Some(_) => {
            map.remove(&host);
            false
        }
        None => false,
    }
}

fn mark_webp_host_cooldown(url: &str) {
    let Some(host) = url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_ascii_lowercase()))
    else {
        return;
    };
    let now = Instant::now();
    let until = now + WEBP_HOST_COOLDOWN_TTL;
    let mut map = lock_cache(&WEBP_HOST_COOLDOWN);
    if map.len() >= 32 {
        map.retain(|_, exp| now < *exp);
    }
    map.insert(host, until);
}

async fn fetch_and_decode_image(
    resolved: &str,
    webp_url: Option<String>,
) -> Result<(&'static str, Vec<u8>), String> {
    if let Some(candidate_url) = webp_url {
        let permit = IMG_NET_SEM
            .acquire()
            .await
            .map_err(|_| "图片并发控制关闭".to_string())?;
        // 与官网 crypto-image.js 的 candidateTimeout 策略一致：短超时单次尝试，慢或失败立即冷却并回退原图。
        let fetched =
            fetch_bytes_with_timeout_attempts(&candidate_url, WEBP_CANDIDATE_TIMEOUT, 1).await;
        drop(permit);
        match fetched {
            Ok((_, bytes)) => {
                if let Ok(Ok(decoded)) =
                    tokio::task::spawn_blocking(move || decode_image_bytes(bytes)).await
                {
                    return Ok(decoded);
                }
            }
            Err(err) => {
                if !err.starts_with("HTTP 404") && !err.starts_with("HTTP 410") {
                    mark_webp_host_cooldown(&candidate_url);
                }
            }
        }
    }
    let permit = IMG_NET_SEM
        .acquire()
        .await
        .map_err(|_| "图片并发控制关闭".to_string())?;
    let (_, bytes) = fetch_bytes(resolved).await?;
    drop(permit);
    tokio::task::spawn_blocking(move || decode_image_bytes(bytes))
        .await
        .map_err(|_| "封面解密任务中断".to_string())?
}

/// 取封面：先查内存与磁盘缓存，再合并在途请求并优先走站点 /cdn-config.js 的 WebP CDN，失败时自动回退原地址。
pub async fn load_image(url: &str) -> Result<(String, Arc<Vec<u8>>), String> {
    let trimmed = url.trim();
    let resolved = if trimmed.starts_with("//") {
        format!("https:{trimmed}")
    } else if trimmed.starts_with('/') {
        absolutize(&crate::net::base(), trimmed)
    } else {
        trimmed.to_string()
    };
    let cache_key = image_cache_key(&resolved);
    if let Some(hit) = lock_cache(&IMG_CACHE).get(&cache_key) {
        if let Some(kind) = image_kind(&hit) {
            return Ok((kind.to_string(), hit));
        }
    }
    IMG_INFLIGHT
        .run(&cache_key, || {
            let resolved = resolved.clone();
            let cache_key = cache_key.clone();
            async move {
                if let Some(hit) = lock_cache(&IMG_CACHE).get(&cache_key) {
                    if let Some(kind) = image_kind(&hit) {
                        return Ok((kind.to_string(), hit));
                    }
                }
                if let Some(dir) = disk_cache_dir() {
                    let filename = disk_cache_filename(&cache_key);
                    let maybe_on_disk = {
                        let guard = lock_cache(&DISK_INDEX);
                        guard
                            .as_ref()
                            .is_none_or(|(indexed_dir, set)| indexed_dir != &dir || set.contains(&filename))
                    };
                    if maybe_on_disk {
                        let key_for_disk = cache_key.clone();
                        let dir_for_disk = dir.clone();
                        if let Ok(Some((kind, plain))) = tokio::task::spawn_blocking(move || {
                            read_disk_image(&dir_for_disk, &key_for_disk)
                        })
                        .await
                        {
                            let len = plain.len();
                            let arc = Arc::new(plain);
                            lock_cache(&IMG_CACHE).put(cache_key, arc.clone(), len);
                            return Ok((kind.to_string(), arc));
                        }
                    }
                }
                let origin = crate::net::base();
                let webp_url = if looks_like_webp_eligible_path(&resolved) {
                    cdn_webp_config(&origin)
                        .await
                        .and_then(|cfg| webp_candidate_url(&resolved, &origin, &cfg))
                        .filter(|u| !is_webp_host_in_cooldown(u))
                } else {
                    None
                };
                let (kind, plain) = fetch_and_decode_image(&resolved, webp_url).await?;
                let len = plain.len();
                let arc = Arc::new(plain);
                lock_cache(&IMG_CACHE).put(cache_key.clone(), arc.clone(), len);
                if let Some(dir) = disk_cache_dir() {
                    if len <= IMG_CACHE_MAX_BYTES {
                        let arc_for_disk = arc.clone();
                        tokio::spawn(async move {
                            let _ = tokio::task::spawn_blocking(move || {
                                write_disk_image(&dir, &cache_key, &arc_for_disk);
                            })
                            .await;
                        });
                    }
                }
                Ok((kind.to_string(), arc))
            }
        })
        .await
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

/// 取 m3u8 并把 key / 子列表 / 分片地址改写到本地协议（合并在途请求）。
pub async fn load_playlist(url: &str, prefix: &str) -> Result<Arc<String>, String> {
    let cache_key = format!("{prefix}|{url}");
    if let Some(hit) = lock_cache(&PL_CACHE).get(&cache_key) {
        return Ok(hit);
    }
    PL_INFLIGHT
        .run(&cache_key, || {
            let url = url.to_string();
            let prefix = prefix.to_string();
            let cache_key = cache_key.clone();
            async move {
                if let Some(hit) = lock_cache(&PL_CACHE).get(&cache_key) {
                    return Ok(hit);
                }
                let (_, bytes) = fetch_bytes(&url).await?;
                let text = std::str::from_utf8(&bytes).map_err(|_| "播放列表不是 UTF-8 文本")?;
                if !text.trim_start_matches('\u{feff}').starts_with("#EXTM3U") {
                    return Err("响应不是 HLS 播放列表".into());
                }
                let rewritten = rewrite_playlist(&url, text, &prefix);
                let len = rewritten.len();
                let arc = Arc::new(rewritten);
                lock_cache(&PL_CACHE).put(cache_key, arc.clone(), len);
                Ok(arc)
            }
        })
        .await
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

fn resolve_segment_mime(url: &str, ctype: Option<String>) -> String {
    ctype.unwrap_or_else(|| {
        let p = url.split('?').next().unwrap_or(url).to_ascii_lowercase();
        if p.ends_with(".ts") {
            "video/mp2t".to_string()
        } else if p.ends_with(".m4s") || p.ends_with(".mp4") {
            "video/mp4".to_string()
        } else {
            "application/octet-stream".to_string()
        }
    })
}

fn cache_segment(url: &str, mime: &str, bytes: Vec<u8>) -> Arc<Vec<u8>> {
    let len = bytes.len();
    let arc = Arc::new(bytes);
    if len <= 65536 {
        lock_cache(&KEY_CACHE).put(url.to_string(), (mime.to_string(), arc.clone()), len);
    } else if len <= SEG_CACHE_MAX_BYTES {
        lock_cache(&SEG_CACHE).put(url.to_string(), (mime.to_string(), arc.clone()), len);
    }
    arc
}

fn cached_segment(url: &str) -> Option<(Option<String>, Arc<Vec<u8>>)> {
    if let Some((ctype, hit)) = lock_cache(&KEY_CACHE).get(url) {
        return Some((Some(ctype), hit));
    }
    if let Some((ctype, hit)) = lock_cache(&SEG_CACHE).get(url) {
        return Some((Some(ctype), hit));
    }
    None
}

/// 加载分片或 AES Key（带内存缓存与在途去重，避免拖动进度条或预热时重复拉取同一 Key 或分片）。
pub async fn load_segment(url: &str) -> Result<(Option<String>, Arc<Vec<u8>>), String> {
    if let Some(hit) = cached_segment(url) {
        return Ok(hit);
    }
    SEG_INFLIGHT
        .run(url, || {
            let url = url.to_string();
            async move {
                if let Some(hit) = cached_segment(&url) {
                    return Ok(hit);
                }
                let (ctype, bytes) = fetch_bytes(&url).await?;
                let mime = resolve_segment_mime(&url, ctype);
                let arc = cache_segment(&url, &mime, bytes);
                Ok((Some(mime), arc))
            }
        })
        .await
}

fn unwrap_proxy_seg_url(uri: &str, prefix: &str) -> Option<String> {
    let seg_prefix = format!("{prefix}/seg?u=");
    let encoded = uri.trim().strip_prefix(&seg_prefix)?;
    let decoded = dec(encoded);
    (!decoded.is_empty()).then_some(decoded)
}

fn extract_first_key_and_segment(rewritten: &str, prefix: &str) -> (Option<String>, Option<String>) {
    let mut key_uri = None;
    let mut seg_uri = None;
    for raw in rewritten.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('#') {
            if key_uri.is_none() && line.starts_with("#EXT-X-KEY:") {
                if let Some((_, attrs)) = hls_attributes(line) {
                    for attr in attrs {
                        if let Some((k, v)) = attr.split_once('=') {
                            if k.trim() == "URI" {
                                if let Some(u) = v
                                    .trim()
                                    .strip_prefix('"')
                                    .and_then(|s| s.strip_suffix('"'))
                                {
                                    key_uri = unwrap_proxy_seg_url(u, prefix);
                                }
                            }
                        }
                    }
                }
            }
            continue;
        }
        if seg_uri.is_none() {
            seg_uri = unwrap_proxy_seg_url(line, prefix);
        }
        if key_uri.is_some() && seg_uri.is_some() {
            break;
        }
    }
    (key_uri, seg_uri)
}

fn is_direct_media_url(url: &str) -> bool {
    let path = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase();
    matches!(
        path.rsplit('.').next(),
        Some("mp4" | "webm" | "mov" | "m4v" | "ogv" | "ogg")
    )
}

/// 取消当前在途的预热任务，立即中止未完成的 HTTP 下载
pub fn cancel_prewarm() {
    PREWARM_GEN.fetch_add(1, Ordering::SeqCst);
    if let Some(prev) = lock_cache(&PREWARM_TASK).take() {
        prev.abort();
    }
}

/// 后台预热即将切换的 HLS 流：清单 → 首条 Key（或嵌套子清单）→ 首条分片。
pub fn prewarm_hls(url: &str) {
    let trimmed = url.trim();
    if trimmed.is_empty()
        || (!trimmed.starts_with("http://") && !trimmed.starts_with("https://"))
        || is_direct_media_url(trimmed)
    {
        return;
    }
    let url = trimmed.to_string();
    let gen = PREWARM_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = tokio::spawn(async move {
        let Ok(_permit) = PREWARM_SEM.acquire().await else {
            return;
        };
        if PREWARM_GEN.load(Ordering::SeqCst) != gen {
            return;
        }
        let Ok(playlist) = load_playlist(&url, LOCAL_ORIGIN).await else {
            return;
        };
        if PREWARM_GEN.load(Ordering::SeqCst) != gen {
            return;
        }
        let (key_uri, seg_uri) = extract_first_key_and_segment(&playlist, LOCAL_ORIGIN);
        if let Some(key) = key_uri {
            if PREWARM_GEN.load(Ordering::SeqCst) != gen {
                return;
            }
            let _ = load_segment(&key).await;
        }
        if PREWARM_GEN.load(Ordering::SeqCst) != gen {
            return;
        }
        let Some(seg) = seg_uri else {
            return;
        };
        let Ok((ctype, bytes)) = load_segment(&seg).await else {
            return;
        };
        if is_playlist_payload(ctype.as_deref(), &bytes) {
            if let Ok(text) = std::str::from_utf8(bytes.as_slice()) {
                let nested = rewrite_playlist(&seg, text, LOCAL_ORIGIN);
                let (nested_key, nested_seg) = extract_first_key_and_segment(&nested, LOCAL_ORIGIN);
                if let Some(key) = nested_key {
                    if PREWARM_GEN.load(Ordering::SeqCst) != gen {
                        return;
                    }
                    let _ = load_segment(&key).await;
                }
                if PREWARM_GEN.load(Ordering::SeqCst) != gen {
                    return;
                }
                if let Some(first_seg) = nested_seg {
                    let _ = load_segment(&first_seg).await;
                }
            }
        }
    });
    let mut slot = lock_cache(&PREWARM_TASK);
    if let Some(prev) = slot.replace(handle.abort_handle()) {
        prev.abort();
    }
}

/// 切后台时裁剪内存媒体缓存（释放视频分片与冗余图片缓冲，保留磁盘封面缓存，降低移动端 Jetsam 风险）
pub fn trim_memory_caches() {
    cancel_prewarm();
    lock_cache(&SEG_CACHE).clear();
    lock_cache(&PL_CACHE).clear();
    lock_cache(&IMG_CACHE).trim_to(
        (IMG_CACHE_MAX / 3).max(16),
        (IMG_CACHE_MAX_BYTES / 4).max(2 * 1024 * 1024),
    );
}

/// 清空封面 / 播放列表 / 分片内存缓存及封面磁盘缓存
pub fn clear_caches() {
    cancel_prewarm();
    lock_cache(&IMG_CACHE).clear();
    lock_cache(&PL_CACHE).clear();
    lock_cache(&KEY_CACHE).clear();
    lock_cache(&SEG_CACHE).clear();
    lock_cache(&CDN_WEBP_CACHE).clear();
    lock_cache(&WEBP_HOST_COOLDOWN).clear();
    if let Some(dir) = disk_cache_dir() {
        clear_disk_dir(&dir);
    }
}

/// 统计当前内存缓存与封面磁盘缓存的条目数与字节总数
pub fn cache_stats() -> (usize, usize) {
    let (mem_entries, mem_bytes) = {
        let img = lock_cache(&IMG_CACHE);
        let pl = lock_cache(&PL_CACHE);
        let key = lock_cache(&KEY_CACHE);
        let seg = lock_cache(&SEG_CACHE);
        (
            img.entries.len() + pl.entries.len() + key.entries.len() + seg.entries.len(),
            img.total_bytes + pl.total_bytes + key.total_bytes + seg.total_bytes,
        )
    };
    let (disk_entries, disk_bytes) = disk_cache_dir()
        .map(|dir| disk_cache_stats(&dir))
        .unwrap_or((0, 0));
    (mem_entries + disk_entries, mem_bytes.saturating_add(disk_bytes))
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

fn respond_partial(
    ctype: &str,
    content_range: &str,
    body: Vec<u8>,
    cache: &str,
) -> Response<Vec<u8>> {
    let len = body.len().to_string();
    Response::builder()
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
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn respond_416(content_range: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header("Content-Type", "text/plain")
        .header("Content-Length", "0")
        .header("Content-Range", content_range)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn normalize_upstream_range(header: &str, max_chunk: usize) -> Option<String> {
    if max_chunk == 0 {
        return None;
    }
    let trimmed = header.trim();
    let (unit, spec) = trimmed.split_once('=')?;
    if !unit.trim().eq_ignore_ascii_case("bytes") {
        return None;
    }
    let spec = spec.trim();
    if spec.is_empty() || spec.contains(',') {
        return None;
    }
    let (raw_start, raw_end) = spec.split_once('-')?;
    let raw_start = raw_start.trim();
    let raw_end = raw_end.trim();
    if raw_start.is_empty() && raw_end.is_empty() {
        return None;
    }
    if raw_start.is_empty() {
        let suffix = raw_end.parse::<usize>().ok()?;
        if suffix == 0 || suffix > MAX_MEDIA_BYTES {
            return None;
        }
        return Some(format!("bytes=-{suffix}"));
    }
    let start = raw_start.parse::<usize>().ok()?;
    if raw_end.is_empty() {
        let end = start.saturating_add(max_chunk - 1);
        return Some(format!("bytes={start}-{end}"));
    }
    let end = raw_end.parse::<usize>().ok()?;
    if end < start {
        return None;
    }
    let max_end = start.saturating_add(MAX_MEDIA_BYTES - 1);
    let capped = end.min(max_end);
    Some(format!("bytes={start}-{capped}"))
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
                let content_range = format!("bytes {start}-{end}/{}", body.len());
                return respond_partial(ctype, &content_range, slice, cache);
            }
            Err(()) => {
                return respond_416(&format!("bytes */{}", body.len()));
            }
            Ok(None) => {}
        }
    }
    let owned = Arc::try_unwrap(body).unwrap_or_else(|arc| (*arc).clone());
    respond(200, ctype, owned, cache)
}

fn is_playlist_payload(ctype: Option<&str>, bytes: &[u8]) -> bool {
    ctype.is_some_and(|t| t.to_ascii_lowercase().contains("mpegurl"))
        || bytes.starts_with(b"#EXTM3U")
        || bytes.starts_with(b"\xef\xbb\xbf#EXTM3U")
}

/// 主清单的子清单也经 /seg 返回：必须继续改写，不能把内层 URL 原样交给播放器。
fn segment_response(
    target: &str,
    ctype: Option<&str>,
    bytes: Arc<Vec<u8>>,
    origin: &str,
    range: Option<&str>,
) -> Response<Vec<u8>> {
    if is_playlist_payload(ctype, bytes.as_slice()) {
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

async fn handle_segment(target: &str, origin: &str, range: Option<&str>) -> Response<Vec<u8>> {
    if let Some((ctype, hit)) = cached_segment(target) {
        return segment_response(target, ctype.as_deref(), hit, origin, range);
    }
    if let Some(range_header) = range {
        if let Some(up_range) = normalize_upstream_range(range_header, RANGE_OPEN_CHUNK) {
            match fetch_bytes_with_range(target, Some(&up_range)).await {
                Ok(fetched) => {
                    if is_playlist_payload(fetched.content_type.as_deref(), &fetched.bytes) {
                        return match load_segment(target).await {
                            Ok((ctype, bytes)) => {
                                segment_response(target, ctype.as_deref(), bytes, origin, range)
                            }
                            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
                        };
                    }
                    let mime = resolve_segment_mime(target, fetched.content_type);
                    if fetched.status == 206 {
                        if let Some(content_range) = fetched.content_range {
                            return respond_partial(
                                &mime,
                                &content_range,
                                fetched.bytes,
                                "public, max-age=3600",
                            );
                        }
                    }
                    let arc = cache_segment(target, &mime, fetched.bytes);
                    return segment_response(target, Some(&mime), arc, origin, range);
                }
                Err(e) if e.starts_with("HTTP 416") => {
                    return respond_416("bytes */*");
                }
                Err(e) => {
                    return respond(502, "text/plain", e.into_bytes(), "no-store");
                }
            }
        }
    }
    match load_segment(target).await {
        Ok((ctype, bytes)) => segment_response(target, ctype.as_deref(), bytes, origin, range),
        Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
    }
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
        "/seg" => handle_segment(&target, origin, range).await,
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

        let decrypted = aes_cbc_decrypt(encrypted).expect("decrypt");
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

    #[test]
    fn image_cache_key_strips_volatile_signature_params_only() {
        assert_eq!(
            image_cache_key(
                "https://pic.drleao.cn/covers/1.jpg?w=480&auth_key=123&Sign=abc&r=2#frag"
            ),
            "https://pic.drleao.cn/covers/1.jpg?w=480"
        );
        assert_eq!(
            image_cache_key("https://pic.drleao.cn/covers/1.jpg?auth_key=123&t=999"),
            "https://pic.drleao.cn/covers/1.jpg"
        );
    }

    #[test]
    fn disk_cache_roundtrip_and_clear_works() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "hghub-media-disk-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let key = "https://pic.drleao.cn/covers/test.jpg";
        let jpeg = b"\xFF\xD8\xFF\xE0valid-jpeg-bytes".to_vec();
        write_disk_image(&dir, key, &jpeg);
        assert_eq!(disk_cache_stats(&dir), (1, jpeg.len()));
        let (kind, read_back) = read_disk_image(&dir, key).expect("disk hit");
        assert_eq!(kind, "image/jpeg");
        assert_eq!(read_back, jpeg);

        // 损坏文件自动剔除且不会命中
        let bad_key = "https://pic.drleao.cn/covers/corrupt.jpg";
        std::fs::write(dir.join(disk_cache_filename(bad_key)), b"<html>broken</html>").unwrap();
        assert!(read_disk_image(&dir, bad_key).is_none());
        assert!(!dir.join(disk_cache_filename(bad_key)).exists());

        // 超过数量限制时淘汰旧文件
        for i in 0..4 {
            write_disk_image(&dir, &format!("https://pic.drleao.cn/{i}.jpg"), &jpeg);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        prune_disk_cache(&dir, 2, usize::MAX);
        assert_eq!(disk_cache_stats(&dir).0, 2);

        clear_disk_dir(&dir);
        assert_eq!(disk_cache_stats(&dir), (0, 0));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn normalize_upstream_range_caps_open_ended_and_preserves_explicit_ranges() {
        assert_eq!(
            normalize_upstream_range("bytes=0-", 1024).as_deref(),
            Some("bytes=0-1023")
        );
        assert_eq!(
            normalize_upstream_range("bytes=500-", 1024).as_deref(),
            Some("bytes=500-1523")
        );
        assert_eq!(
            normalize_upstream_range("bytes=0-1", 1024).as_deref(),
            Some("bytes=0-1")
        );
        assert_eq!(
            normalize_upstream_range("bytes=-512", 1024).as_deref(),
            Some("bytes=-512")
        );
        assert_eq!(
            normalize_upstream_range("bytes=0-999999999", 1024).as_deref(),
            Some(format!("bytes=0-{}", MAX_MEDIA_BYTES - 1)).as_deref()
        );
        assert!(normalize_upstream_range("bytes=0-1, 2-3", 1024).is_none());
        assert!(normalize_upstream_range("bytes=10-5", 1024).is_none());
        assert!(normalize_upstream_range("items=0-5", 1024).is_none());
    }

    #[tokio::test]
    async fn inflight_coalesces_concurrent_work() {
        use std::sync::atomic::AtomicUsize;

        let flight = Arc::new(InFlight::<u32>::new());
        let runs = Arc::new(AtomicUsize::new(0));
        let (a, b, c) = tokio::join!(
            flight.run("k", || {
                let runs = runs.clone();
                async move {
                    runs.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                    Ok(7)
                }
            }),
            flight.run("k", || {
                let runs = runs.clone();
                async move {
                    runs.fetch_add(1, Ordering::SeqCst);
                    Ok(99)
                }
            }),
            flight.run("k", || {
                let runs = runs.clone();
                async move {
                    runs.fetch_add(1, Ordering::SeqCst);
                    Ok(100)
                }
            }),
        );
        assert_eq!(a.unwrap(), 7);
        assert_eq!(b.unwrap(), 7);
        assert_eq!(c.unwrap(), 7);
        assert_eq!(runs.load(Ordering::SeqCst), 1);

        // 领导者被取消时，等待者立即收到取消错误而不死锁
        let cancelled_flight = Arc::new(InFlight::<u32>::new());
        let FlightRole::Leader(guard) = cancelled_flight.enter("abort") else {
            unreachable!();
        };
        let waiter_flight = cancelled_flight.clone();
        let waiter = tokio::spawn(async move {
            waiter_flight
                .run("abort", || async { Ok(1) })
                .await
        });
        tokio::task::yield_now().await;
        drop(guard);
        assert!(waiter.await.unwrap().is_err());
    }

    #[test]
    fn extract_first_key_and_segment_from_rewritten_playlist() {
        let raw = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin?auth_key=1\"\n#EXTINF:4,\nseg0.ts?auth_key=1\n#EXTINF:4,\nseg1.ts\n";
        let rewritten = rewrite_playlist("https://cdn.example/v/list.m3u8", raw, LOCAL_ORIGIN);
        let (key, seg) = extract_first_key_and_segment(&rewritten, LOCAL_ORIGIN);
        assert_eq!(
            key.as_deref(),
            Some("https://cdn.example/v/key.bin?auth_key=1")
        );
        assert_eq!(
            seg.as_deref(),
            Some("https://cdn.example/v/seg0.ts?auth_key=1")
        );
    }

    #[test]
    fn parse_cdn_webp_config_handles_amd_define_and_validates_base() {
        let raw = r#"define({"imgEnabled":false,"webp":{"enabled":true,"base":"https://new2.qnlycc.cn/","hosts":["pic.qnlycc.cn","HUANGGUOAI.COM"]}});"#;
        let parsed = parse_cdn_webp_config(raw).expect("valid cdn-config");
        assert_eq!(parsed.base, "https://new2.qnlycc.cn");
        assert_eq!(
            parsed.hosts,
            vec!["pic.qnlycc.cn".to_string(), "huangguoai.com".to_string()]
        );

        assert!(parse_cdn_webp_config(r#"{"webp":{"enabled":false,"base":"https://new2.qnlycc.cn","hosts":["pic.qnlycc.cn"]}}"#).is_none());
        assert!(parse_cdn_webp_config(r#"define({"webp":{"enabled":true,"base":"http://new2.qnlycc.cn","hosts":["pic.qnlycc.cn"]}});"#).is_none());
        assert!(parse_cdn_webp_config(r#"define({"webp":{"enabled":true,"base":"https://127.0.0.1","hosts":["pic.qnlycc.cn"]}});"#).is_none());
        assert!(parse_cdn_webp_config(r#"define({"webp":{"enabled":true,"base":"https://new2.qnlycc.cn","hosts":[]}});"#).is_none());
    }

    #[test]
    fn webp_candidate_url_matches_upstream_rules() {
        let cfg = CdnWebpConfig {
            base: "https://new2.qnlycc.cn".into(),
            hosts: vec!["pic.qnlycc.cn".into(), "huangguoai.com".into()],
        };
        assert_eq!(
            webp_candidate_url(
                "https://pic.qnlycc.cn/upload_01/upload/20260924/a.jpg?auth_key=123",
                "https://huangguoai.com",
                &cfg,
            )
            .as_deref(),
            Some("https://new2.qnlycc.cn/upload_01/upload/20260924/a.jpg.webp")
        );
        assert_eq!(
            webp_candidate_url(
                "https://huangguoai.com/upload_01/xiao/b.PNG",
                "https://huangguoai.com",
                &cfg,
            )
            .as_deref(),
            Some("https://new2.qnlycc.cn/upload_01/xiao/b.PNG.webp")
        );
        // Same-origin /upload/ and /static/ assets and non-raster/already-webp files are skipped
        assert!(webp_candidate_url(
            "https://huangguoai.com/upload/local.jpg",
            "https://huangguoai.com",
            &cfg
        )
        .is_none());
        assert!(webp_candidate_url(
            "https://pic.qnlycc.cn/static/web/images/cover-placeholder.png",
            "https://huangguoai.com",
            &cfg
        )
        .is_none());
        assert!(webp_candidate_url(
            "https://pic.qnlycc.cn/upload_01/a.webp",
            "https://huangguoai.com",
            &cfg
        )
        .is_none());
        assert!(webp_candidate_url(
            "https://other.cdn.example/upload_01/a.jpg",
            "https://huangguoai.com",
            &cfg
        )
        .is_none());
    }

    #[test]
    fn lru_cache_trim_to_evicts_oldest_and_keeps_newest() {
        let mut cache = LruCache::new(10, 1000);
        for i in 0..6 {
            cache.put(format!("k{i}"), i, 100);
        }
        // Touch k0 so it becomes MRU
        assert_eq!(cache.get("k0"), Some(0));
        cache.trim_to(3, 250);
        assert_eq!(cache.entries.len(), 2);
        assert_eq!(cache.total_bytes, 200);
        assert_eq!(cache.get("k0"), Some(0));
        assert_eq!(cache.get("k5"), Some(5));
        assert_eq!(cache.get("k1"), None);
    }
}
