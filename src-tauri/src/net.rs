//! 网络层：与上游站点对话。
//!
//! 站点把全部 `/api/**` 调用收敛成按分组划分的网关入口
//! （`/api/public/request`、`/api/dynamic/request`、`/api/playback/request`、`/api/user/request`），
//! 并使用 `dx150-edge-v1` 加密或公开 JSON 通道；我们只实现这组入口，其余接口都是「填 path」。
//!
//! # 代理（用户反馈「浏览器能开、HGhub 打不开」的根因就在这里）
//!
//! 客户端的流量**全部**走本文件的 reqwest，跟 WebView2 无关，所以它既不共享
//! 浏览器的代理设置，也不共享浏览器的证书库：
//!
//! * reqwest 只有开了 `system-proxy` feature 才会读 Windows 系统代理
//!   （`HKCU\...\Internet Settings` 的 `ProxyEnable`/`ProxyServer`/`ProxyOverride`）。
//!   本 crate 用 `default-features = false`，早先漏了这个 feature ⇒ 永远直连，
//!   只有 TUN/虚拟网卡这种网络层接管才「看起来能用」。
//! * 即使开了 `system-proxy`，PAC（`AutoConfigURL`）也不被支持，只认固定代理。
//! * Android 没有注册表可读，系统「Wi-Fi 代理」同样不被 reqwest 采用；
//!   安卓上只有 VPN/TUN 模式（VpnService 抓全流量）才有效。
//!
//! 排查手段：环境变量 `HGHUB_PROXY=http://127.0.0.1:7897` 可强制指定代理，
//! `net_diag` 命令会输出 DNS/HTTP/环境变量快照。

use crate::edge_crypto::{self, EdgeScope};
use crate::network_policy;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use once_cell::sync::Lazy;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

/// 默认上游（固定线路 1）。
pub const DEFAULT_BASE: &str = "https://huangguoai.com";

/// 当前上游基址（不带结尾斜杠）。可在设置里切到固定线路 2 或镜像线路，运行时立即生效。
static BASE: Lazy<RwLock<String>> = Lazy::new(|| RwLock::new(DEFAULT_BASE.to_string()));
/// 线路配置落盘位置（应用数据目录/line.json），由 [`bind_base`] 在启动时绑定。
static BASE_FILE: Lazy<RwLock<Option<PathBuf>>> = Lazy::new(|| RwLock::new(None));

/// 当前上游基址。
pub fn base() -> String {
    BASE.read()
        .map(|b| b.clone())
        .unwrap_or_else(|_| DEFAULT_BASE.to_string())
}

/// 线路必须是纯 HTTPS origin，不允许路径、认证、查询串或片段。
pub fn normalize_base(raw: &str) -> Option<String> {
    let parsed = network_policy::parse_target(raw.trim()).ok()?;
    if parsed.scheme() != "https"
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    Some(parsed.origin().ascii_serialization())
}

/// 远端发布页只提供游客镜像，不能扩展账号密码的信任范围。
pub fn trusted_auth_origin(origin: &str) -> bool {
    matches!(origin, "https://huangguoai.com" | "https://huangguoai.ai")
}

/// 启动时读回上次选择的线路（文件不存在 / 内容坏了就保持默认）。
pub fn bind_base(dir: &std::path::Path) {
    network_policy::bind_security(dir);
    let path = dir.join("line.json");
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            if let Some(next) = v
                .get("base")
                .and_then(|x| x.as_str())
                .and_then(normalize_base)
            {
                if let Ok(mut cur) = BASE.write() {
                    *cur = next;
                }
            }
        }
    }
    if let Ok(mut f) = BASE_FILE.write() {
        *f = Some(path);
    }
}

/// 切换线路并落盘，返回规整后的地址。
pub fn set_base(url: &str, on_change: impl FnOnce()) -> Result<String, String> {
    let next = normalize_base(url)
        .ok_or_else(|| "线路地址无效（需要纯 HTTPS 站点地址，禁止内网）".to_string())?;
    let previous = {
        let mut cur = BASE.write().map_err(|_| "线路状态锁失败")?;
        let previous = std::mem::replace(&mut *cur, next.clone());
        if previous != next {
            on_change();
        }
        previous
    };
    if let Some(path) = BASE_FILE.read().ok().and_then(|p| p.clone()) {
        let temp = path.with_extension("json.tmp");
        let _ = std::fs::write(&temp, json!({ "base": next }).to_string())
            .and_then(|_| std::fs::rename(&temp, &path));
    }
    if previous != next {
        edge_crypto::clear_sessions();
        crate::playback_log::record(
            "line.changed",
            json!({
                "previous_host": url::Url::parse(&previous).ok().and_then(|u| u.host_str().map(str::to_owned)),
                "line_host": url::Url::parse(&next).ok().and_then(|u| u.host_str().map(str::to_owned)),
            }),
        );
    }
    Ok(next)
}

pub const UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// 手动指定代理（排查 / 公司内网用）：`HGHUB_PROXY=http://127.0.0.1:7897`。
/// 不设时交给 reqwest 的 `system-proxy` 探测（注册表 + 环境变量）。
fn proxy_override() -> Option<String> {
    std::env::var("HGHUB_PROXY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn client_builder(allow_retry: bool) -> reqwest::ClientBuilder {
    let builder = reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .gzip(true)
        .tcp_nodelay(true)
        .tcp_keepalive(Some(Duration::from_secs(
            if cfg!(any(target_os = "ios", target_os = "android")) { 90 } else { 30 },
        )))
        .http2_adaptive_window(true)
        .pool_idle_timeout(Duration::from_secs(
            if cfg!(any(target_os = "ios", target_os = "android")) { 45 } else { 90 },
        ))
        .pool_max_idle_per_host(if cfg!(any(target_os = "ios", target_os = "android")) { 4 } else { 8 });
    if allow_retry {
        builder
    } else {
        // 播放取地址每次发送都要经过会话检查，仅禁用库内自动重试，保留连接池复用。
        builder.retry(reqwest::retry::never())
    }
}

const CLIENT_TTL: Duration = Duration::from_secs(120);

#[derive(Clone)]
struct CachedDns {
    expires: Instant,
    host: String,
    addrs: Vec<SocketAddr>,
}

type DnsCache = HashMap<String, CachedDns>;
static DNS_CACHE: Lazy<Mutex<DnsCache>> = Lazy::new(|| Mutex::new(HashMap::new()));
static SHARED_CLIENTS: Lazy<Mutex<[Option<Arc<reqwest::Client>>; 2]>> =
    Lazy::new(|| Mutex::new([None, None]));
static CLIENT_FLIGHTS: Lazy<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn dns_cache_key(strict: bool, host: &str) -> String {
    format!("{strict}:{}", host.trim_end_matches('.').to_ascii_lowercase())
}

fn cached_dns(cache: &DnsCache, key: &str, now: Instant) -> Option<Vec<SocketAddr>> {
    cache
        .get(key)
        .filter(|entry| now < entry.expires)
        .map(|entry| entry.addrs.clone())
}

/// 共享 DNS 解析器：优先读取已校验的固定 IP 缓存；若缓存未命中或过期，
/// 在解析时即时执行 `network_policy::resolve_host`（IPv6 优先 + 严格私网拦截），
/// 让所有域名安全共用 2 个 `reqwest::Client`（共享单一 rustls 根证书树与连接池），
/// 避免每域名新建 Client 造成的数十 MB 堆内存与证书解析开销。
struct PinnedDnsResolver;

impl Resolve for PinnedDnsResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().trim_end_matches('.').to_ascii_lowercase();
        let strict = network_policy::strict_security();
        let key = dns_cache_key(strict, &host);
        if let Ok(cache) = DNS_CACHE.lock() {
            if let Some(addrs) = cached_dns(&cache, &key, Instant::now()) {
                return Box::pin(async move {
                    let iter: Addrs = Box::new(addrs.into_iter());
                    Ok(iter)
                });
            }
        }
        Box::pin(async move {
            let addrs = network_policy::resolve_host(&host, 0, strict)
                .await
                .map_err(|msg| Box::new(std::io::Error::other(msg)) as Box<dyn std::error::Error + Send + Sync>)?;
            let now = Instant::now();
            if let Ok(mut cache) = DNS_CACHE.lock() {
                cache.retain(|_, entry| now < entry.expires);
                if cache.len() >= 128 {
                    cache.clear();
                }
                cache.insert(
                    key,
                    CachedDns {
                        expires: now + CLIENT_TTL,
                        host,
                        addrs: addrs.clone(),
                    },
                );
            }
            let iter: Addrs = Box::new(addrs.into_iter());
            Ok(iter)
        })
    }
}

/// 按**当前**系统代理设置新建一个共享客户端（含自定义安全 DNS 解析器）。
///
/// 注意：reqwest 的 `system-proxy` 只在构建时读一次注册表 / 环境变量。代理软件被关掉后，
/// 旧客户端仍会往 `127.0.0.1:7897` 建隧道，所以代理报错时通过 [`refresh_client`] 重建。
fn build_shared_client(allow_retry: bool) -> Result<reqwest::Client, String> {
    let mut builder = client_builder(allow_retry).dns_resolver(Arc::new(PinnedDnsResolver));
    if let Some(p) = proxy_override() {
        // 错误信息不能含原始代理 URL（其中可能有用户名/密码）。
        let proxy = reqwest::Proxy::all(&p).map_err(|_| "HGHUB_PROXY 配置无效（已隐藏原始值）")?;
        builder = builder.proxy(proxy);
    }
    builder
        .build()
        .map_err(|_| "无法创建 HTTP 客户端".to_string())
}

fn shared_client(allow_retry: bool) -> Result<Arc<reqwest::Client>, String> {
    let slot = usize::from(allow_retry);
    {
        let guard = SHARED_CLIENTS.lock().map_err(|_| "HTTP 客户端锁失败")?;
        if let Some(existing) = &guard[slot] {
            return Ok(existing.clone());
        }
    }
    let built = Arc::new(build_shared_client(allow_retry)?);
    let mut guard = SHARED_CLIENTS.lock().map_err(|_| "HTTP 客户端锁失败")?;
    if let Some(existing) = &guard[slot] {
        return Ok(existing.clone());
    }
    guard[slot] = Some(built.clone());
    Ok(built)
}

#[cfg(test)]
fn same_addr_set(a: &[SocketAddr], b: &[SocketAddr]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut sa = a.to_vec();
    let mut sb = b.to_vec();
    sa.sort_unstable();
    sb.sort_unstable();
    sa == sb
}

fn flight_lock(key: &str) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
    let mut flights = CLIENT_FLIGHTS.lock().map_err(|_| "HTTP 客户端并发锁失败")?;
    if flights.len() >= 128 {
        flights.retain(|_, lock| Arc::strong_count(lock) > 1);
    }
    Ok(flights
        .entry(key.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone())
}

/// 校验目标并在严格模式下预校验/缓存该主机的 DNS 解析结果（按模式与域名隔离，120s TTL），
/// 然后返回全局复用的共享 `reqwest::Client`（按 `allow_retry` 仅维护 2 个实例）。
async fn client_for(raw: &str, allow_retry: bool) -> Result<(url::Url, Arc<reqwest::Client>), String> {
    let strict = network_policy::strict_security();
    let target = network_policy::parse_target_with_mode(raw, strict)?;
    let _port = target.port_or_known_default().ok_or("目标端口无效")?;
    let skip_local_dns =
        proxy_override().is_some() && matches!(target.host(), Some(url::Host::Domain(_)));

    if strict && !skip_local_dns {
        if let Some(url::Host::Domain(host)) = target.host() {
            let host_lower = host.trim_end_matches('.').to_ascii_lowercase();
            let key = dns_cache_key(strict, &host_lower);
            let hit = {
                let cache = DNS_CACHE.lock().map_err(|_| "DNS 缓存锁失败")?;
                cached_dns(&cache, &key, Instant::now()).is_some()
            };
            if !hit {
                let flight = flight_lock(&key)?;
                let _guard = flight.lock().await;
                let hit_after = {
                    let cache = DNS_CACHE.lock().map_err(|_| "DNS 缓存锁失败")?;
                    cached_dns(&cache, &key, Instant::now()).is_some()
                };
                if !hit_after {
                    let addrs = network_policy::resolve_target(&target, strict).await?;
                    let now = Instant::now();
                    let mut cache = DNS_CACHE.lock().map_err(|_| "DNS 缓存锁失败")?;
                    cache.retain(|_, entry| now < entry.expires);
                    if cache.len() >= 128 {
                        cache.clear();
                    }
                    cache.insert(
                        key,
                        CachedDns {
                            expires: now + CLIENT_TTL,
                            host: host_lower,
                            addrs,
                        },
                    );
                }
            }
        }
    }

    let http = shared_client(allow_retry)?;
    Ok((target, http))
}

pub fn refresh_client() {
    if let Ok(mut clients) = SHARED_CLIENTS.lock() {
        *clients = [None, None];
    }
    if let Ok(mut cache) = DNS_CACHE.lock() {
        cache.clear();
    }
    if let Ok(mut flights) = CLIENT_FLIGHTS.lock() {
        flights.clear();
    }
    edge_crypto::clear_sessions();
}

/// 移动端切后台时释放空闲 HTTP 连接池与过期 DNS 条目，降低后台保活电量消耗与内存占用。
pub fn trim_background_connections() {
    if let Ok(mut clients) = SHARED_CLIENTS.lock() {
        *clients = [None, None];
    }
    let now = Instant::now();
    if let Ok(mut cache) = DNS_CACHE.lock() {
        cache.retain(|_, entry| now < entry.expires);
    }
    if let Ok(mut flights) = CLIENT_FLIGHTS.lock() {
        flights.retain(|_, lock| Arc::strong_count(lock) > 1);
    }
    if let Ok(mut healed) = LAST_HOST_HEAL.lock() {
        healed.retain(|_, t| t.elapsed() < Duration::from_secs(30));
    }
}

/// 不可信 GET 的统一入口；自动重定向被关闭，每一跳重新检查 URL、DNS 并固定解析地址。
pub async fn get_with_range(
    raw: &str,
    timeout: Duration,
    accept: Option<&str>,
    referer: Option<&str>,
    range: Option<&str>,
) -> Result<reqwest::Response, String> {
    tokio::time::timeout(timeout, async {
        let policy_error = |phase: &str, error: String| {
            crate::playback_log::record("network.target_failed", json!({"resource": crate::playback_log::resource_id(raw), "phase": phase, "error_kind": crate::playback_log::error_kind(&error)}));
            error
        };
        let mut next = network_policy::parse_target(raw).map_err(|e| policy_error("parse", e))?;
        for hop in 0..=5 {
            let resolving = Instant::now();
            let (target, http) = client_for(next.as_str(), true).await.map_err(|e| policy_error("dns_or_client", e))?;
            crate::playback_log::record("network.target_ready", json!({"resource": crate::playback_log::resource_id(raw), "target_resource": crate::playback_log::resource_id(target.as_str()), "dns_or_client_ms": resolving.elapsed().as_millis() as u64, "hop": hop}));
            let mut request = http.get(target.clone()).timeout(timeout);
            if let Some(value) = accept {
                request = request.header("Accept", value);
            }
            if let Some(value) = referer {
                request = request.header("Referer", value);
            }
            if let Some(value) = range {
                request = request.header(reqwest::header::RANGE, value);
            }
            let response = request.send().await.map_err(|e| {
                let msg = err_text(&e);
                heal_client_for(target.as_str(), &msg);
                msg
            })?;
            if !matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
                return Ok(response);
            }
            if hop == 5 {
                return Err("重定向次数超过限制".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or("重定向缺少有效 Location")?;
            next = network_policy::redirect_target(&target, location).map_err(|e| policy_error("redirect", e))?;
            crate::playback_log::record("network.redirect", json!({"resource": crate::playback_log::resource_id(raw), "from": crate::playback_log::resource_id(target.as_str()), "to": crate::playback_log::resource_id(next.as_str()), "status": response.status().as_u16(), "hop": hop + 1}));
        }
        Err("重定向次数超过限制".into())
    })
    .await
    .map_err(|_| "请求超时".to_string())?
}

/// 不可信 GET 的统一入口；自动重定向被关闭，每一跳重新检查 URL、DNS 并固定解析地址。
pub async fn get(
    raw: &str,
    timeout: Duration,
    accept: Option<&str>,
    referer: Option<&str>,
) -> Result<reqwest::Response, String> {
    get_with_range(raw, timeout, accept, referer, None).await
}

/// 只返回代理的协议/主机/端口；解析失败时隐藏整个值，绝不回传认证或查询参数。
pub fn redact_proxy(raw: &str) -> String {
    let parsed = url::Url::parse(raw.trim())
        .ok()
        .filter(|u| u.host_str().is_some());
    match parsed {
        Some(url) => {
            let mut safe = format!("{}://{}", url.scheme(), url.host_str().unwrap());
            if let Some(port) = url.port() {
                safe.push_str(&format!(":{port}"));
            }
            safe
        }
        None => "[已配置，原始值已隐藏]".into(),
    }
}

pub const MAX_API_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_MEDIA_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;

pub async fn read_bytes_limited(
    mut resp: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    if resp
        .content_length()
        .is_some_and(|len| len > max_bytes as u64)
    {
        return Err("响应体超出大小限制".into());
    }
    let cap = resp
        .content_length()
        .and_then(|len| usize::try_from(len).ok())
        .map(|len| len.min(max_bytes))
        .unwrap_or(0);
    let mut out = Vec::with_capacity(cap);
    while let Some(chunk) = resp.chunk().await.map_err(|e| err_text(&e))? {
        if out.len().saturating_add(chunk.len()) > max_bytes {
            return Err("响应体超出大小限制".into());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

pub async fn read_text_limited(
    resp: reqwest::Response,
    max_bytes: usize,
) -> Result<String, String> {
    let bytes = read_bytes_limited(resp, max_bytes).await?;
    Ok(String::from_utf8(bytes)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()))
}

/// 看起来像代理 / 隧道问题（而不是目标站点本身不可达）。
pub fn is_proxy_error(e: &str) -> bool {
    let e = e.to_ascii_lowercase();
    e.contains("tunnel") || e.contains("proxy")
}

fn should_heal_client(reason: &str) -> bool {
    let lower = reason.to_ascii_lowercase();
    is_proxy_error(&lower)
        || lower.contains("connect")
        || lower.contains("timed out")
        || lower.contains("refused")
        || lower.contains("dns")
}

static LAST_HEAL: Lazy<std::sync::Mutex<Option<Instant>>> =
    Lazy::new(|| std::sync::Mutex::new(None));
static LAST_HOST_HEAL: Lazy<Mutex<HashMap<String, Instant>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn evict_host_client(host: &str) {
    if let Ok(mut cache) = DNS_CACHE.lock() {
        cache.retain(|_, entry| !entry.host.eq_ignore_ascii_case(host));
    }
    edge_crypto::evict_host_sessions(host);
}

/// 请求失败后按需重建客户端：代理隧道错误（全局）重建全部客户端，单域名连接被拒/超时/DNS 错仅清理对应域名。
/// 3 秒内只触发一次，批量请求不会反复抖动连接池。
pub fn heal_client(reason: &str) {
    if !should_heal_client(reason) {
        return;
    }
    let mut last = match LAST_HEAL.lock() {
        Ok(l) => l,
        Err(_) => return,
    };
    if let Some(t) = *last {
        if t.elapsed() < Duration::from_secs(3) {
            return;
        }
    }
    *last = Some(Instant::now());
    drop(last);
    refresh_client();
}

pub fn heal_client_for(url: &str, reason: &str) {
    if !should_heal_client(reason) {
        return;
    }
    if is_proxy_error(reason) {
        heal_client(reason);
        return;
    }
    let Some(host) = url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_ascii_lowercase()))
    else {
        heal_client(reason);
        return;
    };
    let mut last = match LAST_HOST_HEAL.lock() {
        Ok(l) => l,
        Err(_) => return,
    };
    if let Some(t) = last.get(&host) {
        if t.elapsed() < Duration::from_secs(3) {
            return;
        }
    }
    if last.len() >= 128 {
        last.retain(|_, t| t.elapsed() < Duration::from_secs(30));
    }
    last.insert(host.clone(), Instant::now());
    drop(last);
    evict_host_client(&host);
}

/// reqwest 的 `Display` 只有「error sending request for url (...)」，
/// 真正的原因（dns error / connection refused / invalid peer certificate）
/// 藏在 `source()` 链里。展开成一行，界面和 debug.log 才有排查价值。
pub fn err_text(e: &reqwest::Error) -> String {
    let mut out = e.to_string();
    let mut src = std::error::Error::source(e);
    while let Some(s) = src {
        let t = s.to_string();
        if !t.is_empty() && !out.contains(&t) {
            out.push_str(" ← ");
            out.push_str(&t);
        }
        src = s.source();
    }
    out
}

fn dns_summary(addrs: impl IntoIterator<Item = SocketAddr>) -> Value {
    let mut ips: Vec<_> = addrs.into_iter().map(|addr| addr.ip()).collect();
    ips.sort_unstable();
    ips.dedup();
    let has_fake_ip = ips.iter().any(|ip| {
        let v4 = match ip {
            std::net::IpAddr::V4(v4) => Some(*v4),
            std::net::IpAddr::V6(v6) => v6.to_ipv4_mapped(),
        };
        v4.is_some_and(|ip| {
            let [a, b, _, _] = ip.octets();
            a == 198 && (b == 18 || b == 19)
        })
    });
    json!({ "count": ips.len(), "has_fake_ip": has_fake_ip })
}

/// 探测上游业务网关健康状态（先测公开 JSON 通道，若上游仅开加密通道则退化为 hello 握手探测）。
pub async fn probe_api(origin: &str, timeout: Duration) -> Result<u16, String> {
    let cur = normalize_base(origin)
        .ok_or_else(|| "线路地址无效（需要纯 HTTPS 站点地址，禁止内网）".to_string())?;
    let endpoint = format!("{cur}{}", EdgeScope::Public.endpoint_path());
    let referer = format!("{cur}/");
    let packet = json!({
        "method": "GET",
        "path": "/api/videos?page=1&size=1",
        "body": "",
        "content_type": "",
    });
    tokio::time::timeout(timeout, async {
        let (target, client) = client_for(&endpoint, false).await?;
        let resp = client
            .post(target.clone())
            .timeout(timeout)
            .header("Accept", "application/json")
            .header("Origin", &cur)
            .header("Referer", &referer)
            .header("X-HG-Public-JSON", "1")
            .json(&packet)
            .send()
            .await
            .map_err(|e| err_text(&e))?;
        let status = resp.status();
        let has_public_hdr = resp
            .headers()
            .get("x-hg-public-json")
            .and_then(|v| v.to_str().ok())
            == Some("1");
        if status == reqwest::StatusCode::OK {
            let text = read_text_limited(resp, MAX_API_BYTES).await?;
            let val: Value = serde_json::from_str(&text)
                .map_err(|_| "业务接口返回非 JSON 响应".to_string())?;
            if val.get("status").and_then(Value::as_i64) == Some(1) {
                return Ok(200);
            }
            return Err("业务接口返回异常状态".into());
        }
        if status == reqwest::StatusCode::BAD_REQUEST && !has_public_hdr {
            let text = read_text_limited(resp, MAX_API_BYTES).await?;
            if is_public_json_unsupported(&text) {
                let offer = edge_crypto::HelloOffer::generate()?;
                let hello_resp = client
                    .post(target)
                    .timeout(timeout)
                    .header("Accept", "application/json")
                    .header("Origin", &cur)
                    .header("Referer", &referer)
                    .json(&offer.request_body)
                    .send()
                    .await
                    .map_err(|e| err_text(&e))?;
                return Ok(hello_resp.status().as_u16());
            }
        }
        Ok(status.as_u16())
    })
    .await
    .map_err(|_| "请求超时".to_string())?
}

/// 网络自检：DNS / HTTP / 代理相关环境变量，用于远程定位「打不开」。
pub async fn diagnose() -> Value {
    let cur = base();
    let host = url::Url::parse(&cur)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_default();

    // fake-ip（198.18.0.0/15）说明 DNS 被 TUN 接管：关掉 TUN 后这个地址根本不可路由。
    let dns = {
        let host = host.clone();
        tokio::task::spawn_blocking(move || {
            use std::net::ToSocketAddrs;
            match (host.as_str(), 443u16).to_socket_addrs() {
                Ok(iter) => dns_summary(iter),
                Err(_) => json!({ "error": "DNS 解析失败" }),
            }
        })
        .await
        .unwrap_or(Value::Null)
    };

    let started = Instant::now();
    let http = match get(&format!("{cur}/"), Duration::from_secs(20), None, None).await {
        Ok(r) => json!({
            "status": r.status().as_u16(),
            "ms": started.elapsed().as_millis() as u64,
        }),
        Err(e) => json!({
            "error": e,
            "ms": started.elapsed().as_millis() as u64,
        }),
    };

    let api_started = Instant::now();
    let api = match probe_api(&cur, Duration::from_secs(10)).await {
        Ok(status) => json!({
            "status": status,
            "ms": api_started.elapsed().as_millis() as u64,
        }),
        Err(e) => json!({
            "error": e,
            "ms": api_started.elapsed().as_millis() as u64,
        }),
    };

    json!({
        "base": cur,
        "host": host,
        "dns": dns,
        "http": http,
        "api": api,
        "env": {
            "HTTP_PROXY": std::env::var("HTTP_PROXY").ok().map(|p| redact_proxy(&p)),
            "HTTPS_PROXY": std::env::var("HTTPS_PROXY").ok().map(|p| redact_proxy(&p)),
            "ALL_PROXY": std::env::var("ALL_PROXY").ok().map(|p| redact_proxy(&p)),
            "NO_PROXY": std::env::var("NO_PROXY").ok().map(|_| "[已配置，列表已隐藏]"),
            "HGHUB_PROXY": proxy_override().map(|p| redact_proxy(&p)),
        },
    })
}

fn retryable_error(error: &str) -> bool {
    if matches!(error, "401" | EDGE_CONTEXT_CHANGED) {
        return false;
    }
    if let Some(status) = error
        .strip_prefix("HTTP ")
        .and_then(|s| s.split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|s| s.parse::<u16>().ok())
    {
        return matches!(status, 408 | 425 | 429 | 500..=599);
    }
    !matches!(
        crate::playback_log::error_kind(error),
        "https_downgrade_denied"
            | "private_address_denied"
            | "target_policy_denied"
            | "redirect_error"
    )
}

async fn with_retry_attempts<F, Fut, T>(
    attempts: usize,
    is_current: impl Fn() -> bool,
    on_heal: impl Fn(&str),
    mut f: F,
) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let mut last = String::from("network error");
    let attempts = attempts.max(1);
    for attempt in 0..attempts {
        require_current(&is_current)?;
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                last = e;
                if !retryable_error(&last) {
                    return Err(last);
                }
                require_current(&is_current)?;
                on_heal(&last);
                if attempt + 1 < attempts {
                    tokio::time::sleep(Duration::from_millis(350 * (attempt as u64 + 1))).await;
                }
            }
        }
    }
    Err(last)
}

/// 只重试可能恢复的错误；404/权限错误/安全拒绝直接结束，避免无效等待。
/// 站点偶发 TLS 抖动；碰上代理隧道错误就先重建客户端再试
/// （代理软件开关后旧客户端会一直卡在 tunnel error 上）。
async fn with_retry_healed<F, Fut, T>(
    retry: bool,
    is_current: impl Fn() -> bool,
    on_heal: impl Fn(&str),
    f: F,
) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    with_retry_attempts(if retry { 3 } else { 1 }, is_current, on_heal, f).await
}

#[cfg(test)]
async fn with_retry<F, Fut, T>(
    retry: bool,
    is_current: impl Fn() -> bool,
    f: F,
) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    with_retry_healed(retry, is_current, |reason| heal_client(reason), f).await
}

// 只记录固定的操作类型，不写搜索词、账号、内容 ID 或查询参数。
fn edge_operation(path: &str) -> &'static str {
    let path = path.split('?').next().unwrap_or("");
    if path.starts_with("/api/videos/category/") {
        "category"
    } else if path.starts_with("/api/videos/") && (path.ends_with("/play") || path.ends_with("/playback")) {
        "play"
    } else if path == "/api/videos" {
        "feed"
    } else if path.starts_with("/api/videos/") {
        "video"
    } else if path == "/api/posts" {
        "posts"
    } else if path.starts_with("/api/posts/") {
        "post"
    } else if path.starts_with("/api/ranks/") {
        "rank"
    } else if path == "/api/search" {
        "search"
    } else if path.starts_with("/api/account/") {
        "account"
    } else {
        "other"
    }
}

/// 仅无请求体、无凭据的逻辑 GET 可以迁移网关；信封本身仍使用 POST。
fn edge_redirect_target(
    current: &url::Url,
    status: u16,
    location: &str,
    guest_get: bool,
) -> Result<url::Url, String> {
    if !guest_get || !matches!(status, 301..=303) {
        return Err("业务接口重定向已拒绝".into());
    }
    network_policy::redirect_target(current, location)
}

const EDGE_UNAUTHORIZED: &str = "HTTP 401: 登录已过期，请重新登录";
pub const EDGE_CONTEXT_CHANGED: &str = "线路或登录状态已变化，请重试";

fn require_current(is_current: impl FnOnce() -> bool) -> Result<(), String> {
    if is_current() {
        Ok(())
    } else {
        Err(EDGE_CONTEXT_CHANGED.into())
    }
}

#[derive(Debug)]
pub enum EdgeError {
    Unauthorized,
    ContextChanged,
    Business(String),
    Transport(String),
}

impl From<EdgeError> for String {
    fn from(error: EdgeError) -> Self {
        match error {
            EdgeError::Unauthorized => EDGE_UNAUTHORIZED.into(),
            EdgeError::ContextChanged => EDGE_CONTEXT_CHANGED.into(),
            // 业务文案不能伪装成前端识别的 HTTP 状态。
            EdgeError::Business(message) if message.trim_start().starts_with("HTTP ") => {
                format!("接口返回失败：{message}")
            }
            EdgeError::Business(message) | EdgeError::Transport(message) => message,
        }
    }
}

fn decode_edge_body(status: reqwest::StatusCode, text: &str) -> Result<Value, String> {
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(EDGE_UNAUTHORIZED.into());
    }
    if !status.is_success() {
        return Err(format!(
            "HTTP {status}: {}",
            text.chars().take(160).collect::<String>()
        ));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(text)
        .map_err(|e| format!("{e}: {}", text.chars().take(160).collect::<String>()))
}

fn classify_edge_transport(error: String) -> EdgeError {
    match error.as_str() {
        EDGE_UNAUTHORIZED => EdgeError::Unauthorized,
        EDGE_CONTEXT_CHANGED => EdgeError::ContextChanged,
        _ => EdgeError::Transport(error),
    }
}

fn unpack_edge_response(value: Value) -> Result<Value, EdgeError> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    if value.get("status").and_then(|v| v.as_i64()) == Some(1) {
        return Ok(value.get("data").cloned().unwrap_or(Value::Null));
    }
    Err(EdgeError::Business(
        value
            .get("msg")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("接口返回失败")
            .to_string(),
    ))
}

fn classify_response_kind(ctype: &str) -> &'static str {
    let lower = ctype.to_ascii_lowercase();
    if lower.contains("json") {
        "json"
    } else if lower.contains("html") {
        "html"
    } else {
        "other"
    }
}

fn classify_gateway(headers: &reqwest::header::HeaderMap) -> &'static str {
    if headers.contains_key("x-amz-cf-id") {
        "cloudfront"
    } else if headers.contains_key("cf-ray") {
        "cloudflare"
    } else {
        "other"
    }
}

fn is_public_json_unsupported(text: &str) -> bool {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_owned))
        .is_some_and(|e| matches!(e.as_str(), "invalid_request" | "unsupported_version"))
}

fn is_crypto_session_expired(text: &str) -> bool {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_owned))
        .is_some_and(|e| e == "session_expired")
}

async fn ensure_crypto_session(
    origin: &str,
    scope: EdgeScope,
    endpoint_url: &str,
    referer: &str,
    allow_retry: bool,
    is_current: impl Fn() -> bool + Sync,
) -> Result<Arc<edge_crypto::CryptoSession>, String> {
    if let Some(session) = edge_crypto::get_cached_session(origin, scope) {
        return Ok(session);
    }
    let flight = edge_crypto::handshake_lock(origin, scope)?;
    let _guard = flight.lock().await;
    if let Some(session) = edge_crypto::get_cached_session(origin, scope) {
        return Ok(session);
    }
    require_current(&is_current)?;
    let offer = edge_crypto::HelloOffer::generate()?;
    let (target, client) = client_for(endpoint_url, allow_retry).await?;
    require_current(&is_current)?;
    let resp = client
        .post(target)
        .timeout(Duration::from_secs(10))
        .header("Accept", "application/json")
        .header("Origin", origin)
        .header("Referer", referer)
        .json(&offer.request_body)
        .send()
        .await
        .map_err(|e| err_text(&e))?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(EDGE_UNAUTHORIZED.into());
    }
    let text = read_text_limited(resp, MAX_API_BYTES).await?;
    if !status.is_success() {
        return Err(format!(
            "HTTP {status}: {}",
            text.chars().take(160).collect::<String>()
        ));
    }
    let hello_json: Value = serde_json::from_str(&text)
        .map_err(|e| format!("{e}: {}", text.chars().take(160).collect::<String>()))?;
    let session = Arc::new(offer.finish(scope, &hello_json)?);
    edge_crypto::store_session(origin, scope, session.clone());
    Ok(session)
}

enum PublicJsonOutcome {
    Ready(Result<Value, String>),
    FallbackEncrypted,
}

#[allow(clippy::too_many_arguments)]
async fn send_public_json_attempt(
    origin: &str,
    endpoint_url: &str,
    referer: &str,
    method: &str,
    path: &str,
    encoded: &str,
    ctype: &str,
    guest_get: bool,
    allow_retry: bool,
    is_current: &(impl Fn() -> bool + Sync),
    started: Instant,
    status_code: &mut Option<u16>,
    headers_ms: &mut Option<u64>,
    target_host: &mut String,
    response_kind: &mut &'static str,
    gateway: &mut &'static str,
) -> Result<PublicJsonOutcome, String> {
    let sorted_path = edge_crypto::sort_public_query(path);
    let envelope = json!({
        "method": method,
        "path": sorted_path,
        "body": encoded,
        "content_type": ctype,
    });
    let mut next = network_policy::parse_target(endpoint_url)?;
    for hop in 0..=5 {
        let (target, client) = client_for(next.as_str(), allow_retry).await?;
        *target_host = target.host_str().unwrap_or("").to_string();
        require_current(is_current)?;
        let resp = client
            .post(target.clone())
            .header("Accept", "application/json")
            .header("Origin", origin)
            .header("Referer", referer)
            .header("X-HG-Public-JSON", "1")
            .json(&envelope)
            .send()
            .await
            .map_err(|e| err_text(&e))?;
        let status = resp.status();
        *status_code = Some(status.as_u16());
        *headers_ms = Some(started.elapsed().as_millis() as u64);
        let resp_ctype = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        *response_kind = classify_response_kind(resp_ctype);
        *gateway = classify_gateway(resp.headers());
        if status.is_redirection() {
            if hop == 5 {
                return Err("重定向次数超过限制".into());
            }
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or("重定向缺少有效 Location")?;
            next = edge_redirect_target(&target, status.as_u16(), location, guest_get)?;
            continue;
        }
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Ok(PublicJsonOutcome::Ready(decode_edge_body(status, "")));
        }
        let has_public_hdr = resp
            .headers()
            .get("x-hg-public-json")
            .and_then(|v| v.to_str().ok())
            == Some("1");
        let text = read_text_limited(resp, MAX_API_BYTES).await?;
        if status == reqwest::StatusCode::BAD_REQUEST
            && !has_public_hdr
            && is_public_json_unsupported(&text)
        {
            return Ok(PublicJsonOutcome::FallbackEncrypted);
        }
        return Ok(PublicJsonOutcome::Ready(decode_edge_body(status, &text)));
    }
    Err("重定向次数超过限制".into())
}

#[allow(clippy::too_many_arguments)]
async fn send_encrypted_attempt(
    origin: &str,
    scope: EdgeScope,
    endpoint_url: &str,
    referer: &str,
    method: &str,
    envelope: &Value,
    token: Option<&str>,
    allow_retry: bool,
    is_current: &(impl Fn() -> bool + Sync),
    started: Instant,
    status_code: &mut Option<u16>,
    headers_ms: &mut Option<u64>,
    target_host: &mut String,
    response_kind: &mut &'static str,
    gateway: &mut &'static str,
) -> Result<Value, String> {
    let auth_token = if scope == EdgeScope::Public { None } else { token };
    for crypto_retry in 0..=1 {
        let session = ensure_crypto_session(
            origin,
            scope,
            endpoint_url,
            referer,
            allow_retry,
            is_current,
        )
        .await?;
        let prepared = session.prepare_call(envelope.clone(), auth_token)?;
        let (target, client) = client_for(endpoint_url, allow_retry).await?;
        *target_host = target.host_str().unwrap_or("").to_string();
        require_current(is_current)?;
        let resp = client
            .post(target)
            .header("Accept", "application/json")
            .header("Origin", origin)
            .header("Referer", referer)
            .json(&prepared.payload)
            .send()
            .await
            .map_err(|e| err_text(&e))?;
        let status = resp.status();
        *status_code = Some(status.as_u16());
        *headers_ms = Some(started.elapsed().as_millis() as u64);
        let resp_ctype = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        *response_kind = classify_response_kind(resp_ctype);
        *gateway = classify_gateway(resp.headers());
        if status.is_redirection() {
            return Err("业务接口重定向已拒绝".into());
        }
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return decode_edge_body(status, "");
        }
        let text = read_text_limited(resp, MAX_API_BYTES).await?;
        if !status.is_success() {
            if is_crypto_session_expired(&text) {
                edge_crypto::evict_session(origin, scope, &prepared.sid);
                if crypto_retry == 0 {
                    continue;
                }
            }
            return decode_edge_body(status, &text);
        }
        let result_json: Value = serde_json::from_str(&text)
            .map_err(|e| format!("{e}: {}", text.chars().take(160).collect::<String>()))?;
        let decrypted = session.decrypt_result(&prepared, &result_json, method)?;
        *status_code = Some(decrypted.status);
        *response_kind = classify_response_kind(&decrypted.content_type);
        let inner_status = reqwest::StatusCode::from_u16(decrypted.status)
            .map_err(|_| "加密接口响应状态码无效".to_string())?;
        return decode_edge_body(inner_status, &decrypted.body_text);
    }
    Err("加密接口会话已过期".into())
}

/// 业务请求：走边缘分组网关。
pub async fn edge(
    origin: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> Result<Value, EdgeError> {
    edge_while(origin, method, path, body, token, || true).await
}

pub async fn edge_while(
    origin: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
    is_current: impl Fn() -> bool + Sync,
) -> Result<Value, EdgeError> {
    let cur = normalize_base(origin)
        .ok_or_else(|| EdgeError::Transport("业务请求必须使用安全 HTTPS 线路".into()))?;
    if network_policy::strict_security()
        && (token.is_some()
            || matches!(
                path,
                "/api/account/loginByPassword" | "/api/account/registerByPassword"
            ))
        && !trusted_auth_origin(&cur)
    {
        return Err(EdgeError::Transport("镜像线路仅供游客浏览；登录/注册请切换到固定线路".into()));
    }
    let scope = edge_crypto::classify_scope(method, path)
        .ok_or_else(|| EdgeError::Transport("接口未配置加密通道".into()))?;
    let (encoded, ctype) = match &body {
        Some(v) => (
            B64.encode(serde_json::to_vec(v).map_err(|e| EdgeError::Transport(e.to_string()))?),
            "application/json",
        ),
        None => (String::new(), ""),
    };
    let envelope = json!({
        "method": method,
        "path": path,
        "body": encoded,
        "content_type": ctype,
    });

    let url = format!("{cur}{}", scope.endpoint_path());
    let referer = format!("{cur}/");
    let token = token.map(|s| s.to_string());

    static NEXT_EDGE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let request = NEXT_EDGE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let line_host = url::Url::parse(&cur)
        .unwrap()
        .host_str()
        .unwrap()
        .to_string();
    let operation = edge_operation(path);
    let mut attempt = 0;
    let guest_get = method.eq_ignore_ascii_case("GET") && body.is_none() && token.is_none();
    // 取播放地址的 POST 没有副作用，和 GET 一样允许重试
    let can_retry = (method.eq_ignore_ascii_case("GET") && body.is_none())
        || (method.eq_ignore_ascii_case("POST") && operation == "play");
    let value = with_retry_healed(
        can_retry,
        &is_current,
        |reason| heal_client_for(&url, reason),
        || {
            let is_current = &is_current;
            attempt += 1;
            let attempt = attempt;
            let cur = cur.clone();
            let envelope = envelope.clone();
            let token = token.clone();
            let url = url.clone();
            let referer = referer.clone();
            let line_host = line_host.clone();
            let encoded = encoded.clone();
            async move {
                let started = Instant::now();
                crate::playback_log::record("api.begin", json!({"request": request, "attempt": attempt, "operation": operation, "scope": scope.as_str(), "method": method, "line_host": line_host}));
                let mut status_code = None;
                let mut headers_ms = None;
                let mut target_host = line_host.clone();
                let mut response_kind = "unknown";
                let mut gateway = "other";
                let result = if scope == EdgeScope::Public {
                    match send_public_json_attempt(
                        &cur,
                        &url,
                        &referer,
                        method,
                        path,
                        &encoded,
                        ctype,
                        guest_get,
                        operation != "play",
                        is_current,
                        started,
                        &mut status_code,
                        &mut headers_ms,
                        &mut target_host,
                        &mut response_kind,
                        &mut gateway,
                    )
                    .await
                    {
                        Ok(PublicJsonOutcome::Ready(res)) => res,
                        Ok(PublicJsonOutcome::FallbackEncrypted) => {
                            send_encrypted_attempt(
                                &cur,
                                scope,
                                &url,
                                &referer,
                                method,
                                &envelope,
                                token.as_deref(),
                                operation != "play",
                                is_current,
                                started,
                                &mut status_code,
                                &mut headers_ms,
                                &mut target_host,
                                &mut response_kind,
                                &mut gateway,
                            )
                            .await
                        }
                        Err(e) => Err(e),
                    }
                } else {
                    send_encrypted_attempt(
                        &cur,
                        scope,
                        &url,
                        &referer,
                        method,
                        &envelope,
                        token.as_deref(),
                        operation != "play",
                        is_current,
                        started,
                        &mut status_code,
                        &mut headers_ms,
                        &mut target_host,
                        &mut response_kind,
                        &mut gateway,
                    )
                    .await
                };
                crate::playback_log::record("api.end", json!({
                    "request": request, "attempt": attempt, "operation": operation, "scope": scope.as_str(), "method": method,
                    "line_host": line_host, "target_host": target_host, "status": status_code,
                    "headers_ms": headers_ms, "elapsed_ms": started.elapsed().as_millis() as u64,
                    "response_kind": response_kind, "gateway": gateway,
                    "business_status": result.as_ref().ok().and_then(|v: &Value| v.get("status")).and_then(Value::as_i64),
                    "error_kind": result.as_ref().err().map(|e: &String| crate::playback_log::error_kind(e)),
                    "retryable": can_retry && result.as_ref().err().is_some_and(|e| retryable_error(e)),
                }));
                result
            }
        },
    )
    .await
    .map_err(classify_edge_transport)?;
    unpack_edge_response(value)
}

pub struct FetchedBytes {
    pub status: u16,
    pub content_type: Option<String>,
    pub content_range: Option<String>,
    pub bytes: Vec<u8>,
}

/// 拉原始字节（支持可选上游 HTTP Range 透传、自定义超时与最大重试次数）。
async fn fetch_bytes_with_range_timeout_attempts(
    url: &str,
    range: Option<&str>,
    timeout: Duration,
    attempts: usize,
) -> Result<FetchedBytes, String> {
    static NEXT_REQUEST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let request = NEXT_REQUEST.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let resource = crate::playback_log::resource_id(url);
    let mut attempt = 0;
    let url = url.to_string();
    let range = range.map(|s| s.to_string());
    let referer = format!("{}/", base());
    with_retry_attempts(
        attempts,
        || true,
        |reason| heal_client_for(&url, reason),
        || {
            attempt += 1;
            let attempt = attempt;
            let resource = resource.clone();
            let url = url.clone();
            let range = range.clone();
            let referer = referer.clone();
            async move {
                let started = Instant::now();
                crate::playback_log::record("network.begin", json!({"request": request, "resource": resource, "attempt": attempt}));
                let mut status = None;
                let mut headers_ms = None;
                let result = async {
                    let resp = get_with_range(
                        &url,
                        timeout,
                        None,
                        Some(&referer),
                        range.as_deref(),
                    )
                    .await?;
                    let code = resp.status().as_u16();
                    status = Some(code);
                    headers_ms = Some(started.elapsed().as_millis() as u64);
                    if !resp.status().is_success() {
                        return Err(format!("HTTP {}", resp.status()));
                    }
                    let content_type = resp
                        .headers()
                        .get(reqwest::header::CONTENT_TYPE)
                        .and_then(|v| v.to_str().ok())
                        .map(|s| s.to_string());
                    let content_range = resp
                        .headers()
                        .get(reqwest::header::CONTENT_RANGE)
                        .and_then(|v| v.to_str().ok())
                        .map(|s| s.to_string());
                    let bytes = read_bytes_limited(resp, MAX_MEDIA_BYTES).await?;
                    Ok(FetchedBytes {
                        status: code,
                        content_type,
                        content_range,
                        bytes,
                    })
                }
                .await;
                crate::playback_log::record("network.end", json!({"request": request, "resource": resource, "attempt": attempt, "status": status, "headers_ms": headers_ms, "elapsed_ms": started.elapsed().as_millis() as u64, "bytes": result.as_ref().ok().map(|fetched| fetched.bytes.len()), "error_kind": result.as_ref().err().map(|e: &String| crate::playback_log::error_kind(e))}));
                result
            }
        },
    )
    .await
}

/// 拉原始字节（支持可选上游 HTTP Range 透传）。
pub async fn fetch_bytes_with_range(url: &str, range: Option<&str>) -> Result<FetchedBytes, String> {
    fetch_bytes_with_range_timeout_attempts(url, range, Duration::from_secs(20), 3).await
}

/// 拉原始字节（指定超时与最多尝试次数，供多候选图床快速回退使用）。
pub async fn fetch_bytes_with_timeout_attempts(
    url: &str,
    timeout: Duration,
    attempts: usize,
) -> Result<(Option<String>, Vec<u8>), String> {
    let fetched = fetch_bytes_with_range_timeout_attempts(url, None, timeout, attempts).await?;
    Ok((fetched.content_type, fetched.bytes))
}

/// 拉原始字节（图片 / m3u8 / 分片）。
pub async fn fetch_bytes(url: &str) -> Result<(Option<String>, Vec<u8>), String> {
    fetch_bytes_with_timeout_attempts(url, Duration::from_secs(20), 3).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn terminal_errors_do_not_retry_but_transient_failures_can_recover() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for error in [
            "HTTP 404 Not Found: <html>nginx</html>",
            "HTTP 403 Forbidden",
            "HTTP 401: 登录已过期，请重新登录",
            "401",
            "禁止访问内网",
            "重定向次数超过限制",
        ] {
            let calls = AtomicUsize::new(0);
            assert!(with_retry(true, || true, || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err::<(), _>(error.to_string())
            })
            .await
            .is_err());
            assert_eq!(calls.load(Ordering::SeqCst), 1, "{error}");
        }
        assert!(should_heal_client("error sending request ← connection refused"));
        assert!(should_heal_client("tunnel error: failed to connect"));
        assert!(should_heal_client("dns lookup failed"));
        assert!(!should_heal_client("HTTP 404 Not Found"));
        for error in ["HTTP 503 Service Unavailable", "请求超时"] {
            let calls = AtomicUsize::new(0);
            let value = with_retry(true, || true, || {
                let attempt = calls.fetch_add(1, Ordering::SeqCst);
                async move {
                    if attempt == 0 {
                        Err(error.to_string())
                    } else {
                        Ok(42)
                    }
                }
            })
            .await
            .unwrap();
            assert_eq!(value, 42);
            assert_eq!(calls.load(Ordering::SeqCst), 2);
        }
    }

    #[tokio::test]
    async fn playback_address_client_reuses_pooled_connections_without_internal_retry() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let connections = Arc::new(AtomicUsize::new(0));
        let accepted = connections.clone();
        let server = tokio::spawn(async move {
            let mut clients = tokio::task::JoinSet::new();
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                accepted.fetch_add(1, Ordering::SeqCst);
                clients.spawn(async move {
                    let mut socket = BufReader::new(socket);
                    let mut line = String::new();
                    loop {
                        line.clear();
                        match socket.read_line(&mut line).await {
                            Ok(0) | Err(_) => break,
                            Ok(_) if line == "\r\n" => {
                                if socket
                                    .get_mut()
                                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            }
                            Ok(_) => {}
                        }
                    }
                });
            }
        });
        let client = client_builder(false).no_proxy().build().unwrap();
        for _ in 0..2 {
            let response = client
                .get(&url)
                .timeout(Duration::from_secs(2))
                .send()
                .await
                .unwrap();
            assert_eq!(response.text().await.unwrap(), "ok");
        }
        server.abort();
        assert_eq!(connections.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn obsolete_playback_context_stops_retry_during_backoff() {
        use std::cell::Cell;
        use tokio::sync::Notify;

        let current = Cell::new(true);
        let checks = Cell::new(0);
        let attempts = Cell::new(0);
        let waiting = Notify::new();
        let result = with_retry(
            true,
            || {
                checks.set(checks.get() + 1);
                if checks.get() == 2 {
                    waiting.notify_one();
                }
                current.get()
            },
            || async {
                attempts.set(attempts.get() + 1);
                Err::<(), _>("HTTP 503 Service Unavailable".into())
            },
        );
        let (result, ()) = tokio::join!(result, async {
            waiting.notified().await;
            current.set(false);
        });

        assert_eq!(result, Err(EDGE_CONTEXT_CHANGED.into()));
        assert_eq!(attempts.get(), 1);
    }

    #[test]
    fn api_operation_labels_exclude_user_input() {
        for (path, expected) in [
            ("/api/videos?page=1&size=10", "feed"),
            ("/api/videos/category/private?x=secret", "category"),
            ("/api/videos/42/play?ep=1", "play"),
            ("/api/videos/42/episodes/1/playback", "play"),
            ("/api/search?q=private-search", "search"),
            ("/api/account/loginByPassword", "account"),
            ("/unknown/private", "other"),
        ] {
            assert_eq!(edge_operation(path), expected);
        }
    }

    #[tokio::test]
    async fn non_idempotent_operations_are_attempted_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for (retry, expected) in [(false, 1), (true, 3)] {
            let calls = AtomicUsize::new(0);
            let result = with_retry(retry, || true, || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err::<(), _>("rejected".to_string())
            })
            .await;
            assert!(result.is_err());
            assert_eq!(calls.load(Ordering::SeqCst), expected);
        }
    }

    #[test]
    fn dns_diagnostics_only_expose_counts_and_fake_ip_presence() {
        let addrs: Vec<SocketAddr> = ["10.0.0.1:443", "198.18.0.2:443", "[::ffff:198.18.0.3]:443"]
            .into_iter()
            .map(|raw| raw.parse().unwrap())
            .collect();
        let summary = dns_summary(addrs);
        assert_eq!(summary, json!({"count": 3, "has_fake_ip": true}));
        assert!(!summary.to_string().contains("10.0.0.1"));
        assert!(!summary.to_string().contains("198.18"));
        assert_eq!(
            dns_summary(Vec::<SocketAddr>::new()),
            json!({"count":0,"has_fake_ip":false})
        );
    }

    #[test]
    fn pinned_clients_expire_without_extending_the_dns_ttl() {
        let now = Instant::now();
        let addr: SocketAddr = "1.1.1.1:443".parse().unwrap();
        let mut cache = DnsCache::new();
        cache.insert(
            dns_cache_key(true, "example.com"),
            CachedDns {
                expires: now + CLIENT_TTL,
                host: "example.com".into(),
                addrs: vec![addr],
            },
        );
        assert_eq!(
            cached_dns(&cache, "true:example.com", now + Duration::from_secs(119)),
            Some(vec![addr])
        );
        assert!(cached_dns(&cache, "true:example.com", now + CLIENT_TTL).is_none());
        assert!(cached_dns(&cache, "false:example.com", now).is_none());
        assert!(cached_dns(&cache, "true:other.example", now).is_none());

        // 不同域名共用同一个共享 reqwest::Client 实例
        let c1 = shared_client(true).unwrap();
        let c2 = shared_client(true).unwrap();
        let c3 = shared_client(false).unwrap();
        assert!(Arc::ptr_eq(&c1, &c2));
        assert!(!Arc::ptr_eq(&c1, &c3));
    }

    #[test]
    fn same_addr_set_ignores_dns_round_robin_order() {
        let a: Vec<SocketAddr> = ["1.1.1.1:443", "8.8.8.8:443"]
            .into_iter()
            .map(|s| s.parse().unwrap())
            .collect();
        let b: Vec<SocketAddr> = ["8.8.8.8:443", "1.1.1.1:443"]
            .into_iter()
            .map(|s| s.parse().unwrap())
            .collect();
        let c: Vec<SocketAddr> = ["1.1.1.1:443", "9.9.9.9:443"]
            .into_iter()
            .map(|s| s.parse().unwrap())
            .collect();
        assert!(same_addr_set(&a, &b));
        assert!(!same_addr_set(&a, &c));
        assert!(same_addr_set(&[], &[]));
    }

    #[test]
    fn host_heal_only_evicts_failed_host_unless_proxy_error() {
        refresh_client();
        LAST_HOST_HEAL.lock().unwrap().clear();
        *LAST_HEAL.lock().unwrap() = None;

        let now = Instant::now();
        let shared = shared_client(true).unwrap();
        {
            let mut cache = DNS_CACHE.lock().unwrap();
            for host in ["cdn-a.test", "cdn-b.test"] {
                cache.insert(
                    dns_cache_key(true, host),
                    CachedDns {
                        expires: now + CLIENT_TTL,
                        host: host.into(),
                        addrs: vec!["1.1.1.1:443".parse().unwrap()],
                    },
                );
            }
        }

        heal_client_for("https://cdn-a.test/seg.ts", "connection reset");
        {
            let cache = DNS_CACHE.lock().unwrap();
            assert!(!cache.contains_key("true:cdn-a.test"));
            assert!(cache.contains_key("true:cdn-b.test"));
            // 单域名连接重置不破坏全局共享 Client
            assert!(Arc::ptr_eq(&shared, &shared_client(true).unwrap()));
        }

        heal_client_for("https://cdn-b.test/img.jpg", "tunnel error: failed to connect");
        assert!(DNS_CACHE.lock().unwrap().is_empty());
        assert!(SHARED_CLIENTS.lock().unwrap()[1].is_none());
        refresh_client();
    }

    #[test]
    fn edge_redirects_only_replay_anonymous_reads() {
        let current = url::Url::parse("https://huangguoai.ai/api/public/request").unwrap();
        assert_eq!(
            edge_redirect_target(
                &current,
                301,
                "https://huangguoai.com/api/public/request",
                true
            )
            .unwrap()
            .host_str(),
            Some("huangguoai.com")
        );
        assert!(edge_redirect_target(&current, 302, "/next", true).is_ok());
        for status in [301, 302, 303, 307, 308] {
            assert!(edge_redirect_target(&current, status, "/next", false).is_err());
        }
        for status in [307, 308] {
            assert!(edge_redirect_target(&current, status, "/next", true).is_err());
        }
        assert!(edge_redirect_target(&current, 301, "http://example.com/", true).is_err());
        assert!(edge_redirect_target(&current, 301, "https://127.0.0.1/", true).is_err());
    }

    #[test]
    fn proxy_credentials_and_query_are_redacted() {
        assert_eq!(
            redact_proxy("http://alice:p%40ss@127.0.0.1:7897/path?token=secret#hidden"),
            "http://127.0.0.1:7897"
        );
        assert_eq!(
            redact_proxy("socks5://alice:secret@[::1]:1080"),
            "socks5://[::1]:1080"
        );
        for raw in ["alice:secret@127.0.0.1:7897", "not a url secret", ""] {
            assert_eq!(redact_proxy(raw), "[已配置，原始值已隐藏]");
        }
    }

    #[test]
    fn base_requires_https_origin_and_auth_trust_is_static() {
        assert_eq!(
            normalize_base("https://HUANGGUOAI.COM:443/"),
            Some(DEFAULT_BASE.into())
        );
        for raw in [
            "http://huangguoai.com",
            "https://user:pass@huangguoai.com",
            "https://huangguoai.com/path",
            "https://huangguoai.com/?secret=1",
            "https://huangguoai.com/#fragment",
            "https://192.168.1.1",
        ] {
            assert_eq!(normalize_base(raw), None, "{raw}");
        }
        assert!(trusted_auth_origin(DEFAULT_BASE));
        assert!(trusted_auth_origin("https://huangguoai.ai"));
        assert!(!trusted_auth_origin("https://mirror.example"));
        assert!(!trusted_auth_origin("https://huangguoai.com.evil.example"));
    }

    #[test]
    fn authentication_errors_keep_their_response_source() {
        use reqwest::StatusCode;

        let html = "<html>登录已过期，请重新登录</html>";
        for status in [StatusCode::SERVICE_UNAVAILABLE, StatusCode::OK] {
            let error = decode_edge_body(status, html).unwrap_err();
            assert!(matches!(classify_edge_transport(error), EdgeError::Transport(_)));
        }
        let error = decode_edge_body(StatusCode::UNAUTHORIZED, html).unwrap_err();
        assert!(matches!(classify_edge_transport(error), EdgeError::Unauthorized));

        let response = decode_edge_body(StatusCode::OK, r#"{"status":0,"msg":"请先登录"}"#).unwrap();
        assert!(matches!(unpack_edge_response(response), Err(EdgeError::Business(message)) if message == "请先登录"));
    }

    #[tokio::test]
    async fn untrusted_origins_reject_credentials_before_network() {
        for (path, body, token) in [
            (
                "/api/account/loginByPassword",
                Some(json!({"password":"secret"})),
                None,
            ),
            (
                "/api/account/registerByPassword",
                Some(json!({"password":"secret"})),
                None,
            ),
            ("/api/videos", None, Some("secret-token")),
        ] {
            let err = edge("https://mirror.invalid", "POST", path, body, token)
                .await
                .unwrap_err();
            assert!(String::from(err).contains("镜像线路仅供游客浏览"));
        }
    }

    #[tokio::test]
    async fn private_get_is_rejected_before_network() {
        let err = get(
            "http://127.0.0.1:1/private",
            Duration::from_secs(1),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.contains("禁止访问"));
    }

    /// 手动跑：`cargo test --lib -- --ignored net::tests::diag -- --nocapture`
    /// 关掉 TUN、只留系统代理时跑一遍，能直接看出客户端有没有走代理。
    #[tokio::test]
    #[ignore = "联网测试：请求上游做网络自检，手动用 --ignored 运行"]
    async fn diag() {
        println!(
            "{}",
            serde_json::to_string_pretty(&diagnose().await).expect("json")
        );
    }

    /// 手动跑：`cargo test --lib -- --ignored net::tests::edge_live_smoke -- --nocapture`
    #[tokio::test]
    #[ignore = "联网测试：验证新分组网关与 dx150-edge-v1 加密通道，手动用 --ignored 运行"]
    async fn edge_live_smoke() {
        let base = "https://huangguoai.com";
        let feed = edge(base, "GET", "/api/videos?page=1&size=2", None, None)
            .await
            .expect("public feed");
        let first_id = feed["items"][0]["id"].as_i64().expect("first video id");
        println!("feed ok, first_id={first_id}");

        let detail = edge(base, "GET", &format!("/api/videos/{first_id}"), None, None)
            .await
            .expect("dynamic video detail");
        assert_eq!(detail["id"].as_i64(), Some(first_id));
        println!("detail ok: {}", detail["title"].as_str().unwrap_or(""));

        let play = edge(
            base,
            "POST",
            &format!("/api/videos/{first_id}/episodes/1/playback"),
            Some(json!({})),
            None,
        )
        .await
        .expect("playback endpoint");
        let stream = play["streams"]["main"]
            .as_str()
            .or_else(|| play["video_url"].as_str())
            .unwrap_or("");
        assert!(!stream.is_empty(), "empty playback stream: {play}");
        println!("playback ok");

        let search = edge(base, "GET", "/api/search?q=%E7%88%B1%E6%83%85&page=1&size=2", None, None)
            .await
            .expect("dynamic search");
        assert!(search["items"].is_array(), "search items: {search}");
        println!("search ok");

        let posts = edge(base, "GET", "/api/posts?page=1&size=2", None, None)
            .await
            .expect("public posts");
        assert!(posts["items"].is_array(), "posts items: {posts}");
        println!("posts ok");

        let rank = edge(base, "GET", "/api/ranks/hot", None, None)
            .await
            .expect("public rank");
        assert!(rank["items"].is_array(), "rank items: {rank}");
        println!("rank ok");

        assert_eq!(probe_api(base, Duration::from_secs(10)).await.unwrap(), 200);
        assert_eq!(
            probe_api("https://huangguoai.ai", Duration::from_secs(10))
                .await
                .unwrap(),
            404
        );
        println!("probe_api ok");
    }
}
