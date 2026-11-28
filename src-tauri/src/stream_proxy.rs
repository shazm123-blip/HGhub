//! 本地回环 HTTP/1.1 流媒体代理（专供 iOS 原生 AVPlayer 硬件硬解 HLS）。
//!
//! # 为什么需要它
//! iOS WKWebView 的原生 `<video>` / AVPlayer 无法通过自定义 `WKURLSchemeHandler`（`hg://`）
//! 播放 HLS 流，此前只能退回主线程无 Worker 的 `hls.js` 软件解封装，导致主线程长任务与较高功耗。
//! 本模块仅绑定 `127.0.0.1` 随机临时端口，并要求每个请求携带 128-bit 启动期随机路径令牌，
//! 只代理 `/hls` 与 `/seg`，且所有上游访问继续复用 `media::handle` 与 `network_policy` 的完整安全校验。
//!
//! 传输完全运行在 Tokio 异步网络线程中，不经 UI 主线程 `run_on_main_thread` 也不触发
//! `WKURLSchemeTask` 全量缓冲拷贝。

use crate::media;
use once_cell::sync::Lazy;
use ring::rand::{SecureRandom, SystemRandom};
use std::sync::RwLock;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const MAX_HEADER_BYTES: usize = 8192;
const READ_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_KEEPALIVE_REQUESTS: usize = 128;

static PROXY_BASE: Lazy<RwLock<Option<String>>> = Lazy::new(|| RwLock::new(None));

/// 当前回环流媒体代理的完整基址（形如 `http://127.0.0.1:54321/<32-hex-token>`）。
/// 非 iOS 平台或尚未启动时返回 `None`。
pub fn base_url() -> Option<String> {
    PROXY_BASE.read().ok().and_then(|g| g.clone())
}

fn generate_token() -> Result<String, String> {
    let rng = SystemRandom::new();
    let mut raw = [0u8; 16];
    rng.fill(&mut raw).map_err(|_| "无法生成媒体代理随机令牌")?;
    let mut hex = String::with_capacity(32);
    for b in raw {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{b:02x}");
    }
    Ok(hex)
}

/// 在给定异步运行时上启动 `127.0.0.1:0` 流媒体代理并记录全局基址（幂等）。
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub async fn start_on_current_runtime() -> Result<String, String> {
    if let Some(existing) = base_url() {
        return Ok(existing);
    }
    let (base, listener, token) = bind_listener().await?;
    {
        let mut guard = PROXY_BASE.write().map_err(|_| "媒体代理状态锁失败")?;
        if let Some(existing) = guard.as_ref() {
            return Ok(existing.clone());
        }
        *guard = Some(base.clone());
    }
    let origin = base.clone();
    tokio::spawn(async move {
        serve_loop(listener, token, origin).await;
    });
    Ok(base)
}

async fn bind_listener() -> Result<(String, TcpListener, String), String> {
    let token = generate_token()?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("无法绑定本地流媒体代理端口: {e}"))?;
    let addr = listener
        .local_addr()
        .map_err(|e| format!("无法获取本地流媒体代理端口: {e}"))?;
    let base = format!("http://127.0.0.1:{}/{token}", addr.port());
    Ok((base, listener, token))
}

async fn serve_loop(listener: TcpListener, token: String, origin: String) {
    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                if !peer.ip().is_loopback() {
                    continue;
                }
                let _ = stream.set_nodelay(true);
                let tok = token.clone();
                let orig = origin.clone();
                tokio::spawn(async move {
                    handle_connection(stream, &tok, &orig).await;
                });
            }
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
}

struct ParsedRequest {
    method: String,
    target: String,
    range: Option<String>,
    keep_alive: bool,
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4)
}

fn parse_http_request(raw: &[u8]) -> Option<ParsedRequest> {
    let text = std::str::from_utf8(raw).ok()?;
    let mut lines = text.split("\r\n");
    let first = lines.next()?;
    let mut parts = first.split_whitespace();
    let method = parts.next()?.to_ascii_uppercase();
    let target = parts.next()?.to_string();
    let version = parts.next().unwrap_or("HTTP/1.1");
    let mut keep_alive = version.eq_ignore_ascii_case("HTTP/1.1");
    let mut range = None;
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim();
            let val = v.trim();
            if key.eq_ignore_ascii_case("range") && val.len() <= 128 {
                range = Some(val.to_string());
            } else if key.eq_ignore_ascii_case("connection") {
                if val.eq_ignore_ascii_case("close") {
                    keep_alive = false;
                } else if val.eq_ignore_ascii_case("keep-alive") {
                    keep_alive = true;
                }
            }
        }
    }
    Some(ParsedRequest {
        method,
        target,
        range,
        keep_alive,
    })
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn verify_and_extract_route<'a>(target: &'a str, expected_token: &str) -> Option<(&'a str, &'a str)> {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let rest = path.strip_prefix('/')?;
    let (provided_token, route_tail) = rest.split_once('/')?;
    if !ct_eq(provided_token.as_bytes(), expected_token.as_bytes()) {
        return None;
    }
    match route_tail {
        "hls" => Some(("/hls", query)),
        "seg" => Some(("/seg", query)),
        _ => None,
    }
}

async fn write_simple_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    keep_alive: bool,
) -> std::io::Result<()> {
    let conn = if keep_alive { "keep-alive" } else { "close" };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: {conn}\r\n\r\n"
    );
    tokio::time::timeout(WRITE_TIMEOUT, stream.write_all(head.as_bytes()))
        .await
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "write timeout"))?
}

async fn write_media_response(
    stream: &mut TcpStream,
    resp: &tauri::http::Response<Vec<u8>>,
    head_only: bool,
    keep_alive: bool,
) -> std::io::Result<()> {
    let status = resp.status();
    let reason = status.canonical_reason().unwrap_or("OK");
    let conn = if keep_alive { "keep-alive" } else { "close" };
    let mut head = format!("HTTP/1.1 {} {reason}\r\n", status.as_u16());
    let mut has_len = false;
    for (name, val) in resp.headers() {
        if let Ok(v) = val.to_str() {
            if name.as_str().eq_ignore_ascii_case("content-length") {
                has_len = true;
            }
            if name.as_str().eq_ignore_ascii_case("connection") {
                continue;
            }
            head.push_str(name.as_str());
            head.push_str(": ");
            head.push_str(v);
            head.push_str("\r\n");
        }
    }
    if !has_len {
        head.push_str(&format!("Content-Length: {}\r\n", resp.body().len()));
    }
    head.push_str(&format!("Connection: {conn}\r\n\r\n"));

    tokio::time::timeout(WRITE_TIMEOUT, async {
        stream.write_all(head.as_bytes()).await?;
        if !head_only && !resp.body().is_empty() {
            stream.write_all(resp.body()).await?;
        }
        stream.flush().await
    })
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "write timeout"))?
}

async fn handle_connection(mut stream: TcpStream, token: &str, origin: &str) {
    let mut buf = Vec::with_capacity(2048);
    let mut tmp = [0u8; 2048];
    for _ in 0..MAX_KEEPALIVE_REQUESTS {
        let header_end = loop {
            if let Some(end) = find_header_end(&buf) {
                break Some(end);
            }
            if buf.len() >= MAX_HEADER_BYTES {
                let _ = write_simple_response(&mut stream, 431, "Request Header Fields Too Large", false).await;
                return;
            }
            let read_res = tokio::time::timeout(READ_TIMEOUT, stream.read(&mut tmp)).await;
            match read_res {
                Ok(Ok(0)) | Err(_) => return,
                Ok(Ok(n)) => buf.extend_from_slice(&tmp[..n]),
                Ok(Err(_)) => return,
            }
        };
        let Some(end) = header_end else { return };
        let req_bytes: Vec<u8> = buf.drain(..end).collect();
        let Some(req) = parse_http_request(&req_bytes) else {
            let _ = write_simple_response(&mut stream, 400, "Bad Request", false).await;
            return;
        };

        if req.method == "OPTIONS" {
            if write_simple_response(&mut stream, 204, "No Content", req.keep_alive)
                .await
                .is_err()
            {
                return;
            }
            if !req.keep_alive {
                return;
            }
            continue;
        }

        if req.method != "GET" && req.method != "HEAD" {
            let _ = write_simple_response(&mut stream, 405, "Method Not Allowed", false).await;
            return;
        }

        let Some((route, query)) = verify_and_extract_route(&req.target, token) else {
            let _ = write_simple_response(&mut stream, 403, "Forbidden", false).await;
            return;
        };

        let resp = media::handle(route, query, origin, req.range.as_deref()).await;
        if write_media_response(&mut stream, &resp, req.method == "HEAD", req.keep_alive)
            .await
            .is_err()
        {
            return;
        }
        if !req.keep_alive {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_verification_requires_exact_token_and_media_route() {
        let tok = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            verify_and_extract_route(&format!("/{tok}/hls?u=abc"), tok),
            Some(("/hls", "u=abc"))
        );
        assert_eq!(
            verify_and_extract_route(&format!("/{tok}/seg?u=xyz"), tok),
            Some(("/seg", "u=xyz"))
        );
        // 封面接口与错误令牌一律拒绝
        assert_eq!(
            verify_and_extract_route(&format!("/{tok}/img?u=abc"), tok),
            None
        );
        assert_eq!(
            verify_and_extract_route("/wrongtoken/hls?u=abc", tok),
            None
        );
        assert_eq!(verify_and_extract_route("/hls?u=abc", tok), None);
    }

    #[test]
    fn http_request_parser_extracts_method_range_and_keepalive() {
        let raw = b"GET /tok/seg?u=test HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=0-1023\r\nConnection: keep-alive\r\n\r\n";
        let req = parse_http_request(raw).unwrap();
        assert_eq!(req.method, "GET");
        assert_eq!(req.target, "/tok/seg?u=test");
        assert_eq!(req.range.as_deref(), Some("bytes=0-1023"));
        assert!(req.keep_alive);

        let head = b"HEAD /tok/hls?u=1 HTTP/1.1\r\nConnection: close\r\n\r\n";
        let req2 = parse_http_request(head).unwrap();
        assert_eq!(req2.method, "HEAD");
        assert!(!req2.keep_alive);
    }

    #[tokio::test]
    async fn loopback_proxy_rejects_unauthorized_and_serves_authenticated_requests() {
        let (base, listener, token) = bind_listener().await.unwrap();
        let addr = listener.local_addr().unwrap();
        let origin = base.clone();
        let server = tokio::spawn(async move {
            serve_loop(listener, token.clone(), origin).await;
        });

        // 1. 错误令牌返回 403
        let mut s1 = TcpStream::connect(addr).await.unwrap();
        s1.write_all(b"GET /badtoken/hls?u=https%3A%2F%2Fexample.com%2Fa.m3u8 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut resp1 = String::new();
        s1.read_to_string(&mut resp1).await.unwrap();
        assert!(resp1.starts_with("HTTP/1.1 403 Forbidden"), "{resp1}");

        // 2. 正确令牌但缺少 u 参数返回 400（证明已进入 media::handle）
        let path_prefix = base.strip_prefix(&format!("http://127.0.0.1:{}", addr.port())).unwrap();
        let mut s2 = TcpStream::connect(addr).await.unwrap();
        let req = format!("GET {path_prefix}/hls HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        s2.write_all(req.as_bytes()).await.unwrap();
        let mut resp2 = String::new();
        s2.read_to_string(&mut resp2).await.unwrap();
        assert!(resp2.starts_with("HTTP/1.1 400 Bad Request"), "{resp2}");

        // 3. HEAD 方法同样可用且无响应体
        let mut s3 = TcpStream::connect(addr).await.unwrap();
        let req_head = format!("HEAD {path_prefix}/seg HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        s3.write_all(req_head.as_bytes()).await.unwrap();
        let mut resp3 = String::new();
        s3.read_to_string(&mut resp3).await.unwrap();
        assert!(resp3.starts_with("HTTP/1.1 400 Bad Request"), "{resp3}");
        assert!(resp3.ends_with("\r\n\r\n"), "{resp3}");

        server.abort();
    }
}
