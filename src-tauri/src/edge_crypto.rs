//! 上游分组网关路由与 `dx150-edge-v1` 应用层加密协议（ECDH P-256 + HKDF-SHA256 + AES-256-GCM）。

use base64::engine::general_purpose::{STANDARD as B64_STD, URL_SAFE_NO_PAD as B64_URL};
use base64::Engine;
use once_cell::sync::Lazy;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::agreement::{agree_ephemeral, EphemeralPrivateKey, UnparsedPublicKey, ECDH_P256};
use ring::hkdf::{KeyType, Salt, HKDF_SHA256};
use ring::rand::SystemRandom;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const PROTOCOL: &str = "dx150-edge-v1";
const MAX_SEQUENCE: u32 = 16_384;
const SESSION_TTL_CAP_SECS: i64 = 600;
const SESSION_RENEW_MARGIN: Duration = Duration::from_secs(5);
const MAX_CACHED_SESSIONS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EdgeScope {
    Public,
    Dynamic,
    Playback,
    User,
}

impl EdgeScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Dynamic => "dynamic",
            Self::Playback => "playback",
            Self::User => "user",
        }
    }

    pub fn endpoint_path(self) -> &'static str {
        match self {
            Self::Public => "/api/public/request",
            Self::Dynamic => "/api/dynamic/request",
            Self::Playback => "/api/playback/request",
            Self::User => "/api/user/request",
        }
    }
}

struct RouteSpec {
    method: &'static str,
    pattern: &'static str,
    scope: EdgeScope,
}

/// 与上游 `window.__cloudfrontCompat.encryptedAPIRoutes` 对齐的分组路由表。
const ROUTES: &[RouteSpec] = &[
    // ── playback ──
    RouteSpec { method: "POST", pattern: "/api/media/playback/previews", scope: EdgeScope::Playback },
    RouteSpec { method: "POST", pattern: "/api/media/prerolls/:id/playback", scope: EdgeScope::Playback },
    RouteSpec { method: "POST", pattern: "/api/posts/:id/playback", scope: EdgeScope::Playback },
    RouteSpec { method: "POST", pattern: "/api/videos/:id/episodes/:ep/playback", scope: EdgeScope::Playback },
    RouteSpec { method: "GET", pattern: "/api/videos/:id/play", scope: EdgeScope::Playback },
    RouteSpec { method: "POST", pattern: "/api/videos/:id/playback", scope: EdgeScope::Playback },
    // ── public（静态段数相同按定义顺序匹配；静态路由优先于动态路由）──
    RouteSpec { method: "GET", pattern: "/api/feed/post/today", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/feed/recommend", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/feed/today", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/home/latest", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/home/recommends", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/posts", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/posts/:id/adjacent", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/posts/:id/related", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/posts/category/:route", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/posts/tag/:tag", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/posts/user/:id", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/ranks/:type", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/search/hot", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/search/suggest", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/search/tags/hot", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/site/categories/post", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/site/categories/video", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/site/config", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/site/links", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/site/menus", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/site/meta", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/site/pages", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/site/pages/:slug", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/site/sorts/video", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/site/transit", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/site/watermark", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/tags", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/topics", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/topics/:slug", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/users/:id/stats", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/videos", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/videos/long", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/videos/report-reasons", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/videos/:id/related", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/videos/category/:route", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/videos/sort/:route", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/videos/tag/:tag", scope: EdgeScope::Public },
    RouteSpec { method: "GET", pattern: "/api/videos/user/:id", scope: EdgeScope::Public },
    // ── dynamic ──
    RouteSpec { method: "POST", pattern: "/api/edge/image", scope: EdgeScope::Dynamic },
    RouteSpec { method: "GET", pattern: "/api/home", scope: EdgeScope::Dynamic },
    RouteSpec { method: "POST", pattern: "/api/media/covers", scope: EdgeScope::Dynamic },
    RouteSpec { method: "GET", pattern: "/api/posts/:id", scope: EdgeScope::Dynamic },
    RouteSpec { method: "GET", pattern: "/api/posts/:id/comments", scope: EdgeScope::Dynamic },
    RouteSpec { method: "POST", pattern: "/api/posts/:id/share", scope: EdgeScope::Dynamic },
    RouteSpec { method: "GET", pattern: "/api/search", scope: EdgeScope::Dynamic },
    RouteSpec { method: "GET", pattern: "/api/site/address-poster", scope: EdgeScope::Dynamic },
    RouteSpec { method: "POST", pattern: "/api/site/click", scope: EdgeScope::Dynamic },
    RouteSpec { method: "GET", pattern: "/api/site/entries", scope: EdgeScope::Dynamic },
    RouteSpec { method: "GET", pattern: "/api/site/go-home", scope: EdgeScope::Dynamic },
    RouteSpec { method: "POST", pattern: "/api/site/home-slots", scope: EdgeScope::Dynamic },
    RouteSpec { method: "POST", pattern: "/api/stats/click", scope: EdgeScope::Dynamic },
    RouteSpec { method: "POST", pattern: "/api/stats/origin", scope: EdgeScope::Dynamic },
    RouteSpec { method: "GET", pattern: "/api/users/:id", scope: EdgeScope::Dynamic },
    RouteSpec { method: "GET", pattern: "/api/videos/:id", scope: EdgeScope::Dynamic },
    RouteSpec { method: "GET", pattern: "/api/videos/:id/comments", scope: EdgeScope::Dynamic },
    RouteSpec { method: "GET", pattern: "/api/videos/:id/comments/:cid/replies", scope: EdgeScope::Dynamic },
    RouteSpec { method: "GET", pattern: "/api/videos/:id/next", scope: EdgeScope::Dynamic },
    RouteSpec { method: "POST", pattern: "/api/videos/:id/play", scope: EdgeScope::Dynamic },
    RouteSpec { method: "POST", pattern: "/api/videos/:id/episode-stats", scope: EdgeScope::Dynamic },
    RouteSpec { method: "POST", pattern: "/api/videos/:id/visit", scope: EdgeScope::Dynamic },
    RouteSpec { method: "POST", pattern: "/api/videos/recommend", scope: EdgeScope::Dynamic },
    RouteSpec { method: "POST", pattern: "/api/videos/recommend/ref/:ref", scope: EdgeScope::Dynamic },
    RouteSpec { method: "GET", pattern: "/api/whoami", scope: EdgeScope::Dynamic },
    // ── user ──
    RouteSpec { method: "POST", pattern: "/api/account/loginByPassword", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/account/logout", scope: EdgeScope::User },
    RouteSpec { method: "GET", pattern: "/api/account/me", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/account/password", scope: EdgeScope::User },
    RouteSpec { method: "PATCH", pattern: "/api/account/profile", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/account/registerByPassword", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/ai-wish", scope: EdgeScope::User },
    RouteSpec { method: "DELETE", pattern: "/api/posts/:id/collect", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/posts/:id/collect", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/posts/:id/comments", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/posts/:id/comments/:cid/guest-like", scope: EdgeScope::User },
    RouteSpec { method: "DELETE", pattern: "/api/posts/:id/comments/:cid/like", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/posts/:id/comments/:cid/like", scope: EdgeScope::User },
    RouteSpec { method: "GET", pattern: "/api/posts/:id/comments/liked", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/posts/:id/guest-comments", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/posts/:id/guest-like", scope: EdgeScope::User },
    RouteSpec { method: "GET", pattern: "/api/posts/:id/guest-liked", scope: EdgeScope::User },
    RouteSpec { method: "DELETE", pattern: "/api/posts/:id/like", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/posts/:id/like", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/posts/:id/visit", scope: EdgeScope::User },
    RouteSpec { method: "DELETE", pattern: "/api/users/:id/follow", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/users/:id/follow", scope: EdgeScope::User },
    RouteSpec { method: "GET", pattern: "/api/users/me/collects", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/users/me/collects/delete", scope: EdgeScope::User },
    RouteSpec { method: "GET", pattern: "/api/users/me/comments", scope: EdgeScope::User },
    RouteSpec { method: "GET", pattern: "/api/users/me/follows", scope: EdgeScope::User },
    RouteSpec { method: "GET", pattern: "/api/users/me/history", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/users/me/history", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/users/me/history/delete", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/users/me/history/sync", scope: EdgeScope::User },
    RouteSpec { method: "GET", pattern: "/api/users/me/likes", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/users/me/likes/delete", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/users/me/likes/sync", scope: EdgeScope::User },
    RouteSpec { method: "GET", pattern: "/api/users/me/messages", scope: EdgeScope::User },
    RouteSpec { method: "DELETE", pattern: "/api/users/me/messages/:id", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/users/me/messages/:id/read", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/users/me/messages/batch-delete", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/users/me/messages/read-all", scope: EdgeScope::User },
    RouteSpec { method: "GET", pattern: "/api/users/me/messages/unread-count", scope: EdgeScope::User },
    RouteSpec { method: "DELETE", pattern: "/api/videos/:id/collect", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/videos/:id/collect", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/videos/:id/comments", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/videos/:id/comments/:cid/guest-like", scope: EdgeScope::User },
    RouteSpec { method: "DELETE", pattern: "/api/videos/:id/comments/:cid/like", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/videos/:id/comments/:cid/like", scope: EdgeScope::User },
    RouteSpec { method: "GET", pattern: "/api/videos/:id/comments/liked", scope: EdgeScope::User },
    RouteSpec { method: "GET", pattern: "/api/videos/:id/comments/state", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/videos/:id/feedback", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/videos/:id/guest-comments", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/videos/:id/guest-like", scope: EdgeScope::User },
    RouteSpec { method: "GET", pattern: "/api/videos/:id/guest-liked", scope: EdgeScope::User },
    RouteSpec { method: "GET", pattern: "/api/videos/:id/interaction-state", scope: EdgeScope::User },
    RouteSpec { method: "DELETE", pattern: "/api/videos/:id/like", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/videos/:id/like", scope: EdgeScope::User },
    RouteSpec { method: "GET", pattern: "/api/videos/:id/rating", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/videos/:id/rating", scope: EdgeScope::User },
    RouteSpec { method: "POST", pattern: "/api/videos/:id/report", scope: EdgeScope::User },
    RouteSpec { method: "GET", pattern: "/api/videos/following", scope: EdgeScope::User },
];

fn match_pattern(pattern: &str, segments: &[&str]) -> Option<usize> {
    let pat_segs: Vec<&str> = pattern.split('/').collect();
    if pat_segs.len() != segments.len() {
        return None;
    }
    let mut dynamic_count = 0usize;
    for (&pat, &seg) in pat_segs.iter().zip(segments.iter()) {
        if pat.starts_with(':') {
            dynamic_count += 1;
            if matches!(pat, ":id" | ":cid" | ":ep") {
                if seg.is_empty() || !seg.bytes().all(|b| b.is_ascii_digit()) {
                    return None;
                }
            } else if seg.is_empty() {
                return None;
            }
        } else if pat != seg {
            return None;
        }
    }
    Some(dynamic_count)
}

/// 根据 HTTP 方法与路径分类到对应的上游边缘分组。
pub fn classify_scope(method: &str, path_and_query: &str) -> Option<EdgeScope> {
    let effective_method = if method.eq_ignore_ascii_case("HEAD") {
        "GET"
    } else {
        method
    };
    let no_frag = path_and_query.split('#').next().unwrap_or("");
    let (pathname, query) = match no_frag.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (no_frag, None),
    };
    let segments: Vec<&str> = pathname.split('/').collect();

    let mut best: Option<(usize, EdgeScope)> = None;
    for spec in ROUTES {
        if !spec.method.eq_ignore_ascii_case(effective_method) {
            continue;
        }
        if let Some(dyn_count) = match_pattern(spec.pattern, &segments) {
            if best.is_none_or(|(cur_dyn, _)| dyn_count < cur_dyn) {
                best = Some((dyn_count, spec.scope));
                if dyn_count == 0 {
                    break;
                }
            }
        }
    }

    let (_, scope) = best?;
    if scope == EdgeScope::Public {
        if let Some(q) = query {
            let is_random = url::form_urlencoded::parse(q.as_bytes()).any(|(k, v)| {
                k == "sort"
                    && (v.trim().eq_ignore_ascii_case("random")
                        || v.trim().eq_ignore_ascii_case("rand"))
            });
            if is_random {
                return Some(EdgeScope::Dynamic);
            }
        }
    }
    Some(scope)
}

/// 公开 JSON 通道要求按参数名稳定排序（同名参数保持原有顺序）。
pub fn sort_public_query(path_and_query: &str) -> String {
    let no_frag = path_and_query.split('#').next().unwrap_or("");
    let Some((pathname, query)) = no_frag.split_once('?') else {
        return no_frag.to_string();
    };
    if query.is_empty() {
        return pathname.to_string();
    }
    let mut pairs: Vec<(String, String)> = url::form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect();
    if pairs.is_empty() {
        return pathname.to_string();
    }
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    let sorted = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish();
    format!("{pathname}?{sorted}")
}

fn unix_now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn is_token_chars(s: &str, min_len: usize, max_len: usize) -> bool {
    (min_len..=max_len).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn is_site_chars(s: &str) -> bool {
    (1..=256).contains(&s.len())
        && s.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'.' | b':' | b'[' | b']' | b'-')
        })
}

fn decode_b64url(s: &str) -> Result<Vec<u8>, String> {
    if s.is_empty()
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("加密响应编码无效".into());
    }
    B64_URL.decode(s).map_err(|_| "加密响应编码无效".into())
}

struct KeyLen32;
impl KeyType for KeyLen32 {
    fn len(&self) -> usize {
        32
    }
}

fn derive_aes_key(prk: &ring::hkdf::Prk, info: &str, direction: &str) -> Result<LessSafeKey, String> {
    let suffix = format!("\n{direction}");
    let info_slices = [info.as_bytes(), suffix.as_bytes()];
    let okm = prk
        .expand(&info_slices, KeyLen32)
        .map_err(|_| "加密密钥派生失败".to_string())?;
    let mut raw = [0u8; 32];
    okm.fill(&mut raw)
        .map_err(|_| "加密密钥派生失败".to_string())?;
    let unbound = UnboundKey::new(&AES_256_GCM, &raw)
        .map_err(|_| "加密密钥初始化失败".to_string())?;
    Ok(LessSafeKey::new(unbound))
}

fn seq_nonce(seq: u32) -> Nonce {
    let mut bytes = [0u8; 12];
    bytes[8..12].copy_from_slice(&seq.to_be_bytes());
    Nonce::assume_unique_for_key(bytes)
}

pub struct HelloOffer {
    private_key: EphemeralPrivateKey,
    pub request_body: Value,
}

impl HelloOffer {
    pub fn generate() -> Result<Self, String> {
        let rng = SystemRandom::new();
        let private_key = EphemeralPrivateKey::generate(&ECDH_P256, &rng)
            .map_err(|_| "生成加密握手密钥失败".to_string())?;
        let public_key = private_key
            .compute_public_key()
            .map_err(|_| "导出加密握手公钥失败".to_string())?;
        let client_pub = B64_URL.encode(public_key.as_ref());
        Ok(Self {
            private_key,
            request_body: json!({
                "v": 1,
                "type": "hello",
                "client_pub": client_pub,
            }),
        })
    }

    pub fn finish(self, scope: EdgeScope, hello: &Value) -> Result<CryptoSession, String> {
        if hello.get("v").and_then(Value::as_i64) != Some(1)
            || hello.get("type").and_then(Value::as_str) != Some("hello")
        {
            return Err("加密握手响应无效".into());
        }
        let kid = hello
            .get("kid")
            .and_then(Value::as_str)
            .filter(|s| is_token_chars(s, 1, 64))
            .ok_or_else(|| "加密握手响应无效".to_string())?;
        let sid = hello
            .get("sid")
            .and_then(Value::as_str)
            .filter(|s| is_token_chars(s, 16, 128))
            .ok_or_else(|| "加密握手响应无效".to_string())?;
        let site = hello
            .get("site")
            .and_then(Value::as_str)
            .filter(|s| is_site_chars(s))
            .ok_or_else(|| "加密握手响应无效".to_string())?;
        let server_time = hello
            .get("server_time")
            .and_then(Value::as_i64)
            .ok_or_else(|| "加密握手响应无效".to_string())?;
        let expires_at = hello
            .get("expires_at")
            .and_then(Value::as_i64)
            .ok_or_else(|| "加密握手响应无效".to_string())?;
        let ttl = expires_at
            .checked_sub(server_time)
            .filter(|&ttl| ttl > 0 && ttl <= SESSION_TTL_CAP_SECS)
            .ok_or_else(|| "加密握手响应无效".to_string())?;

        let server_pub_b64 = hello
            .get("server_pub")
            .and_then(Value::as_str)
            .ok_or_else(|| "加密握手响应无效".to_string())?;
        let server_pub_bytes = decode_b64url(server_pub_b64)
            .map_err(|_| "加密握手响应无效".to_string())?;
        if server_pub_bytes.len() != 65 || server_pub_bytes[0] != 0x04 {
            return Err("加密握手响应无效".into());
        }

        let salt_b64 = hello
            .get("salt")
            .and_then(Value::as_str)
            .ok_or_else(|| "加密握手响应无效".to_string())?;
        let salt_bytes = decode_b64url(salt_b64)
            .map_err(|_| "加密握手响应无效".to_string())?;
        if salt_bytes.len() != 32 {
            return Err("加密握手响应无效".into());
        }

        let info = format!("{PROTOCOL}\n{}\n{site}\n{kid}\n{sid}", scope.as_str());
        let peer_pub = UnparsedPublicKey::new(&ECDH_P256, &server_pub_bytes);
        let (req_key, res_key) = agree_ephemeral(self.private_key, &peer_pub, |shared| {
            let prk = Salt::new(HKDF_SHA256, &salt_bytes).extract(shared);
            let req_key = derive_aes_key(&prk, &info, "req")?;
            let res_key = derive_aes_key(&prk, &info, "res")?;
            Ok::<_, String>((req_key, res_key))
        })
        .map_err(|_| "加密握手协商失败".to_string())??;

        let local_now = unix_now_secs();
        Ok(CryptoSession {
            info,
            kid: kid.to_string(),
            sid: sid.to_string(),
            clock_offset: server_time - local_now,
            expires_at: Instant::now() + Duration::from_secs(ttl as u64),
            sequence: AtomicU32::new(0),
            req_key,
            res_key,
        })
    }
}

pub struct CryptoSession {
    info: String,
    kid: String,
    pub sid: String,
    clock_offset: i64,
    expires_at: Instant,
    sequence: AtomicU32,
    req_key: LessSafeKey,
    res_key: LessSafeKey,
}

pub struct PreparedCall {
    pub sid: String,
    pub kid: String,
    pub seq: u32,
    pub ts: i64,
    res_aad: String,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecryptedResponse {
    pub status: u16,
    pub content_type: String,
    pub body_text: String,
}

impl CryptoSession {
    pub fn is_usable(&self, now: Instant) -> bool {
        now + SESSION_RENEW_MARGIN < self.expires_at
            && self.sequence.load(Ordering::Relaxed) < MAX_SEQUENCE
    }

    pub fn prepare_call(
        &self,
        request_envelope: Value,
        authorization: Option<&str>,
    ) -> Result<PreparedCall, String> {
        let prev = self
            .sequence
            .try_update(Ordering::AcqRel, Ordering::Acquire, |cur| {
                (cur < MAX_SEQUENCE).then_some(cur + 1)
            })
            .map_err(|_| "加密会话已到期".to_string())?;
        let seq = prev + 1;
        let ts = unix_now_secs() + self.clock_offset;

        let mut inner = serde_json::Map::new();
        inner.insert("request".into(), request_envelope);
        if let Some(token) = authorization.filter(|t| !t.is_empty()) {
            inner.insert("authorization".into(), json!(format!("Bearer {token}")));
        }
        let mut plaintext =
            serde_json::to_vec(&Value::Object(inner)).map_err(|e| e.to_string())?;

        let req_aad = format!("{}\nreq\n{seq}\n{ts}", self.info);
        let res_aad = format!("{}\nres\n{seq}\n{ts}", self.info);
        self.req_key
            .seal_in_place_append_tag(
                seq_nonce(seq),
                Aad::from(req_aad.as_bytes()),
                &mut plaintext,
            )
            .map_err(|_| "请求加密失败".to_string())?;

        let payload = json!({
            "v": 1,
            "type": "call",
            "kid": self.kid,
            "sid": self.sid,
            "seq": seq,
            "ts": ts,
            "ciphertext": B64_URL.encode(&plaintext),
        });

        Ok(PreparedCall {
            sid: self.sid.clone(),
            kid: self.kid.clone(),
            seq,
            ts,
            res_aad,
            payload,
        })
    }

    pub fn decrypt_result(
        &self,
        prepared: &PreparedCall,
        result_json: &Value,
        request_method: &str,
    ) -> Result<DecryptedResponse, String> {
        if result_json.get("v").and_then(Value::as_i64) != Some(1)
            || result_json.get("type").and_then(Value::as_str) != Some("result")
            || result_json.get("sid").and_then(Value::as_str) != Some(prepared.sid.as_str())
            || result_json.get("kid").and_then(Value::as_str) != Some(prepared.kid.as_str())
            || result_json.get("seq").and_then(Value::as_u64) != Some(u64::from(prepared.seq))
            || result_json.get("ts").and_then(Value::as_i64) != Some(prepared.ts)
        {
            return Err("加密接口响应不匹配".into());
        }

        let ct_b64 = result_json
            .get("ciphertext")
            .and_then(Value::as_str)
            .ok_or_else(|| "加密接口响应不匹配".to_string())?;
        let mut ct = decode_b64url(ct_b64)?;
        let plaintext = self
            .res_key
            .open_in_place(
                seq_nonce(prepared.seq),
                Aad::from(prepared.res_aad.as_bytes()),
                &mut ct,
            )
            .map_err(|_| "加密接口响应解密失败".to_string())?;

        let inner: Value = serde_json::from_slice(plaintext)
            .map_err(|_| "加密接口响应格式无效".to_string())?;
        let status_u64 = inner
            .get("status")
            .and_then(Value::as_u64)
            .filter(|&s| (200..=599).contains(&s))
            .ok_or_else(|| "加密接口响应格式无效".to_string())?;
        let status = status_u64 as u16;

        let headers_obj = inner
            .get("headers")
            .and_then(Value::as_object)
            .ok_or_else(|| "加密接口响应格式无效".to_string())?;
        let mut content_type = String::new();
        for (name, val) in headers_obj {
            let arr = val
                .as_array()
                .ok_or_else(|| "加密接口响应头无效".to_string())?;
            for item in arr {
                let s = item
                    .as_str()
                    .ok_or_else(|| "加密接口响应头无效".to_string())?;
                if name.eq_ignore_ascii_case("content-type") {
                    content_type = s.to_string();
                }
            }
        }

        let no_body = request_method.eq_ignore_ascii_case("HEAD")
            || matches!(status, 204 | 205 | 304);
        let body_text = if no_body {
            String::new()
        } else {
            let body_b64 = inner
                .get("body")
                .and_then(Value::as_str)
                .ok_or_else(|| "加密接口响应格式无效".to_string())?;
            let body_bytes = B64_STD
                .decode(body_b64)
                .map_err(|_| "加密响应编码无效".to_string())?;
            String::from_utf8(body_bytes)
                .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
        };

        Ok(DecryptedResponse {
            status,
            content_type,
            body_text,
        })
    }
}

type SessionKey = (String, EdgeScope);
static SESSION_CACHE: Lazy<Mutex<HashMap<SessionKey, Arc<CryptoSession>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static HANDSHAKE_FLIGHTS: Lazy<Mutex<HashMap<SessionKey, Arc<tokio::sync::Mutex<()>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub fn get_cached_session(origin: &str, scope: EdgeScope) -> Option<Arc<CryptoSession>> {
    let now = Instant::now();
    let cache = SESSION_CACHE.lock().ok()?;
    cache
        .get(&(origin.to_string(), scope))
        .filter(|s| s.is_usable(now))
        .cloned()
}

pub fn store_session(origin: &str, scope: EdgeScope, session: Arc<CryptoSession>) {
    if let Ok(mut cache) = SESSION_CACHE.lock() {
        let now = Instant::now();
        cache.retain(|_, s| s.is_usable(now));
        if cache.len() >= MAX_CACHED_SESSIONS {
            cache.clear();
        }
        cache.insert((origin.to_string(), scope), session);
    }
}

pub fn evict_session(origin: &str, scope: EdgeScope, sid: &str) {
    if let Ok(mut cache) = SESSION_CACHE.lock() {
        let key = (origin.to_string(), scope);
        if cache.get(&key).is_some_and(|s| s.sid == sid) {
            cache.remove(&key);
        }
    }
}

pub fn evict_host_sessions(host: &str) {
    if let Ok(mut cache) = SESSION_CACHE.lock() {
        cache.retain(|(origin, _), _| {
            url::Url::parse(origin)
                .ok()
                .and_then(|u| u.host_str().map(|h| !h.eq_ignore_ascii_case(host)))
                .unwrap_or(true)
        });
    }
}

pub fn clear_sessions() {
    if let Ok(mut cache) = SESSION_CACHE.lock() {
        cache.clear();
    }
    if let Ok(mut flights) = HANDSHAKE_FLIGHTS.lock() {
        flights.clear();
    }
}

pub fn handshake_lock(
    origin: &str,
    scope: EdgeScope,
) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
    let mut flights = HANDSHAKE_FLIGHTS
        .lock()
        .map_err(|_| "加密握手并发锁失败".to_string())?;
    if flights.len() >= 128 {
        flights.retain(|_, lock| Arc::strong_count(lock) > 1);
    }
    Ok(flights
        .entry((origin.to_string(), scope))
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_all_app_api_routes_into_expected_scopes() {
        let cases = [
            // Public
            ("GET", "/api/videos?page=1&size=10", Some(EdgeScope::Public)),
            ("GET", "/api/videos?is_original=1&sort=new&page=1&size=20", Some(EdgeScope::Public)),
            ("GET", "/api/videos/category/ai-duanju?sort=hot&page=2&size=20", Some(EdgeScope::Public)),
            ("GET", "/api/ranks/hot", Some(EdgeScope::Public)),
            ("GET", "/api/ranks/recommend", Some(EdgeScope::Public)),
            ("GET", "/api/ranks/potential", Some(EdgeScope::Public)),
            ("GET", "/api/posts?page=1&size=20", Some(EdgeScope::Public)),
            ("GET", "/api/videos/long?page=1", Some(EdgeScope::Public)),
            // Public -> Dynamic when sort=random/rand
            ("GET", "/api/videos?sort=random&page=1", Some(EdgeScope::Dynamic)),
            ("GET", "/api/videos/category/ai-duanju?sort=RAND&page=1", Some(EdgeScope::Dynamic)),
            // Dynamic
            ("GET", "/api/videos/12", Some(EdgeScope::Dynamic)),
            ("GET", "/api/videos/12/comments?ep=1&page=1&size=20", Some(EdgeScope::Dynamic)),
            ("GET", "/api/posts/88", Some(EdgeScope::Dynamic)),
            ("GET", "/api/posts/88/comments?page=1&size=20", Some(EdgeScope::Dynamic)),
            ("GET", "/api/search?q=test&page=1&size=20", Some(EdgeScope::Dynamic)),
            ("POST", "/api/videos/12/play", Some(EdgeScope::Dynamic)),
            // Playback
            ("POST", "/api/videos/12/episodes/1/playback", Some(EdgeScope::Playback)),
            ("GET", "/api/videos/12/play?ep=1&page_texts=0", Some(EdgeScope::Playback)),
            ("POST", "/api/videos/12/playback", Some(EdgeScope::Playback)),
            // User
            ("POST", "/api/account/loginByPassword", Some(EdgeScope::User)),
            ("POST", "/api/account/registerByPassword", Some(EdgeScope::User)),
            ("POST", "/api/account/logout", Some(EdgeScope::User)),
            ("GET", "/api/account/me", Some(EdgeScope::User)),
            ("POST", "/api/videos/12/comments?ep=1", Some(EdgeScope::User)),
            ("POST", "/api/videos/12/like?ep=1", Some(EdgeScope::User)),
            ("DELETE", "/api/videos/12/like?ep=1", Some(EdgeScope::User)),
            ("POST", "/api/videos/12/collect", Some(EdgeScope::User)),
            ("DELETE", "/api/videos/12/collect", Some(EdgeScope::User)),
            ("POST", "/api/users/99/follow", Some(EdgeScope::User)),
            ("DELETE", "/api/users/99/follow", Some(EdgeScope::User)),
            ("POST", "/api/posts/88/like", Some(EdgeScope::User)),
            ("DELETE", "/api/posts/88/like", Some(EdgeScope::User)),
            ("POST", "/api/posts/88/collect", Some(EdgeScope::User)),
            ("DELETE", "/api/posts/88/collect", Some(EdgeScope::User)),
            ("GET", "/api/videos/following", Some(EdgeScope::User)),
            // Unknown / invalid param
            ("GET", "/api/videos/not-a-number", None),
            ("GET", "/api/unknown", None),
        ];

        for (method, path, expected) in cases {
            assert_eq!(classify_scope(method, path), expected, "{method} {path}");
        }
        assert_eq!(classify_scope("HEAD", "/api/videos?page=1"), Some(EdgeScope::Public));
    }

    #[test]
    fn public_query_sorting_is_stable_and_preserves_duplicates() {
        assert_eq!(sort_public_query("/api/posts"), "/api/posts");
        assert_eq!(sort_public_query("/api/posts?"), "/api/posts");
        assert_eq!(
            sort_public_query("/api/videos?size=20&page=1&is_original=1"),
            "/api/videos?is_original=1&page=1&size=20"
        );
        assert_eq!(
            sort_public_query("/api/videos?tag=b&page=1&tag=a"),
            "/api/videos?page=1&tag=b&tag=a"
        );
    }

    #[test]
    fn dx150_edge_v1_roundtrip_and_tamper_checks() {
        let rng = SystemRandom::new();
        let server_priv = EphemeralPrivateKey::generate(&ECDH_P256, &rng).unwrap();
        let server_pub = server_priv.compute_public_key().unwrap();
        let salt = [0x5au8; 32];
        let now = unix_now_secs();
        let kid = "k1";
        let sid = "session_0123456789abcdef";
        let site = "huangguoai.com";

        let offer = HelloOffer::generate().unwrap();
        assert_eq!(offer.request_body["v"], 1);
        assert_eq!(offer.request_body["type"], "hello");
        let client_pub_bytes =
            decode_b64url(offer.request_body["client_pub"].as_str().unwrap()).unwrap();
        assert_eq!(client_pub_bytes.len(), 65);

        let hello = json!({
            "v": 1,
            "type": "hello",
            "kid": kid,
            "sid": sid,
            "site": site,
            "server_pub": B64_URL.encode(server_pub.as_ref()),
            "salt": B64_URL.encode(salt),
            "server_time": now + 30,
            "expires_at": now + 330,
        });
        let session = offer.finish(EdgeScope::Dynamic, &hello).unwrap();
        assert!(session.is_usable(Instant::now()));

        // Server derives the same request/response keys.
        let (srv_req_key, srv_res_key) = agree_ephemeral(
            server_priv,
            &UnparsedPublicKey::new(&ECDH_P256, &client_pub_bytes),
            |shared| {
                let info = format!("{PROTOCOL}\ndynamic\n{site}\n{kid}\n{sid}");
                let prk = Salt::new(HKDF_SHA256, &salt).extract(shared);
                Ok::<_, String>((
                    derive_aes_key(&prk, &info, "req").unwrap(),
                    derive_aes_key(&prk, &info, "res").unwrap(),
                ))
            },
        )
        .unwrap()
        .unwrap();

        let prepared = session
            .prepare_call(
                json!({"method": "GET", "path": "/api/videos/12", "body": "", "content_type": ""}),
                Some("tok-123"),
            )
            .unwrap();
        assert_eq!(prepared.seq, 1);

        // Server decrypts request
        let mut req_ct = decode_b64url(prepared.payload["ciphertext"].as_str().unwrap()).unwrap();
        let req_aad = format!(
            "{PROTOCOL}\ndynamic\n{site}\n{kid}\n{sid}\nreq\n{}\n{}",
            prepared.seq, prepared.ts
        );
        let req_plain = srv_req_key
            .open_in_place(seq_nonce(prepared.seq), Aad::from(req_aad.as_bytes()), &mut req_ct)
            .unwrap();
        let req_json: Value = serde_json::from_slice(req_plain).unwrap();
        assert_eq!(req_json["authorization"], "Bearer tok-123");
        assert_eq!(req_json["request"]["path"], "/api/videos/12");

        // Server encrypts response
        let inner_body = B64_STD.encode(r#"{"status":1,"data":{"id":12}}"#);
        let mut res_plain = serde_json::to_vec(&json!({
            "status": 200,
            "headers": {"Content-Type": ["application/json; charset=utf-8"]},
            "body": inner_body,
        }))
        .unwrap();
        let res_aad = format!(
            "{PROTOCOL}\ndynamic\n{site}\n{kid}\n{sid}\nres\n{}\n{}",
            prepared.seq, prepared.ts
        );
        srv_res_key
            .seal_in_place_append_tag(
                seq_nonce(prepared.seq),
                Aad::from(res_aad.as_bytes()),
                &mut res_plain,
            )
            .unwrap();
        let result_json = json!({
            "v": 1,
            "type": "result",
            "kid": kid,
            "sid": sid,
            "seq": prepared.seq,
            "ts": prepared.ts,
            "ciphertext": B64_URL.encode(&res_plain),
        });

        let decrypted = session.decrypt_result(&prepared, &result_json, "GET").unwrap();
        assert_eq!(decrypted.status, 200);
        assert_eq!(decrypted.content_type, "application/json; charset=utf-8");
        assert_eq!(decrypted.body_text, r#"{"status":1,"data":{"id":12}}"#);

        // Tampered seq/ts fails before or during decrypt
        let mut bad_seq = result_json.clone();
        bad_seq["seq"] = json!(99);
        assert!(session.decrypt_result(&prepared, &bad_seq, "GET").is_err());

        let mut bad_ct = result_json.clone();
        let mut raw = decode_b64url(bad_ct["ciphertext"].as_str().unwrap()).unwrap();
        raw[0] ^= 0xff;
        bad_ct["ciphertext"] = json!(B64_URL.encode(raw));
        assert!(session.decrypt_result(&prepared, &bad_ct, "GET").is_err());

        // HEAD / 204 returns empty body even without body field
        let mut res_204 = serde_json::to_vec(&json!({
            "status": 204,
            "headers": {},
        }))
        .unwrap();
        let p2 = session.prepare_call(json!({"method": "DELETE"}), None).unwrap();
        let res_aad_2 = format!(
            "{PROTOCOL}\ndynamic\n{site}\n{kid}\n{sid}\nres\n{}\n{}",
            p2.seq, p2.ts
        );
        srv_res_key
            .seal_in_place_append_tag(
                seq_nonce(p2.seq),
                Aad::from(res_aad_2.as_bytes()),
                &mut res_204,
            )
            .unwrap();
        let dec_204 = session
            .decrypt_result(
                &p2,
                &json!({
                    "v": 1, "type": "result", "kid": kid, "sid": sid,
                    "seq": p2.seq, "ts": p2.ts, "ciphertext": B64_URL.encode(&res_204),
                }),
                "DELETE",
            )
            .unwrap();
        assert_eq!(dec_204.status, 204);
        assert_eq!(dec_204.body_text, "");
    }

    #[test]
    fn invalid_hello_responses_are_rejected() {
        let now = unix_now_secs();
        let valid_pub = {
            let rng = SystemRandom::new();
            let priv_k = EphemeralPrivateKey::generate(&ECDH_P256, &rng).unwrap();
            B64_URL.encode(priv_k.compute_public_key().unwrap().as_ref())
        };
        let valid_salt = B64_URL.encode([1u8; 32]);

        let bad_cases = [
            json!({"v": 2, "type": "hello", "kid": "k", "sid": "0123456789abcdef", "site": "a.com", "server_pub": valid_pub, "salt": valid_salt, "server_time": now, "expires_at": now + 60}),
            json!({"v": 1, "type": "hello", "kid": "k", "sid": "short", "site": "a.com", "server_pub": valid_pub, "salt": valid_salt, "server_time": now, "expires_at": now + 60}),
            json!({"v": 1, "type": "hello", "kid": "k", "sid": "0123456789abcdef", "site": "a.com", "server_pub": valid_pub, "salt": valid_salt, "server_time": now, "expires_at": now + 601}),
            json!({"v": 1, "type": "hello", "kid": "k", "sid": "0123456789abcdef", "site": "a.com", "server_pub": B64_URL.encode([0x04; 10]), "salt": valid_salt, "server_time": now, "expires_at": now + 60}),
            json!({"v": 1, "type": "hello", "kid": "k", "sid": "0123456789abcdef", "site": "a.com", "server_pub": valid_pub, "salt": B64_URL.encode([1u8; 16]), "server_time": now, "expires_at": now + 60}),
        ];

        for bad in bad_cases {
            let offer = HelloOffer::generate().unwrap();
            assert!(offer.finish(EdgeScope::Public, &bad).is_err(), "{bad}");
        }
    }
}
