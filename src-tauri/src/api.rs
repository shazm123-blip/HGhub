//! 业务命令：登录 / 列表 / 详情 / 播放 / 互动。

use crate::net::{base, edge, edge_while, EdgeError, EDGE_CONTEXT_CHANGED};
use crate::session::{Credentials, SessionStore};
use serde_json::{json, Value};
use tauri::State;
use tauri_plugin_opener::OpenerExt;

const SESSION_EXPIRED: &str = "HTTP 401 登录已过期";
const SESSION_CHANGED: &str = "登录状态已变化，请重试";

pub struct Api {
    pub session: SessionStore,
}

impl Api {
    pub fn new() -> Self {
        Self {
            session: SessionStore::new(),
        }
    }

    async fn get(&self, path: &str) -> Result<Value, String> {
        let origin = base();
        let credentials = self.session.credentials(&origin);
        self.request(&origin, credentials.as_ref(), "GET", path, None, || true)
            .await
    }

    async fn request(
        &self,
        origin: &str,
        credentials: Option<&Credentials>,
        method: &str,
        path: &str,
        body: Option<Value>,
        is_current: impl Fn() -> bool + Sync,
    ) -> Result<Value, String> {
        let token = credentials.map(|c| c.token.as_str());
        edge_while(origin, method, path, body, token, is_current)
            .await
            .map_err(|error| match credentials {
                Some(c) => self.session_error(origin, c, error),
                None => error.into(),
            })
    }

    fn session_error(&self, origin: &str, credentials: &Credentials, error: EdgeError) -> String {
        let expired = match &error {
            EdgeError::Unauthorized => true,
            EdgeError::Business(message) => business_session_expired(message),
            EdgeError::ContextChanged | EdgeError::Transport(_) => false,
        };
        if !expired {
            return error.into();
        }
        if self.session.clear_if_matches(origin, credentials) {
            SESSION_EXPIRED.into()
        } else {
            SESSION_CHANGED.into()
        }
    }

    async fn authed(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
        let origin = base();
        let credentials = self
            .session
            .credentials(&origin)
            .ok_or_else(|| "请先登录".to_string())?;
        self.request(&origin, Some(&credentials), method, path, body, || true)
            .await
    }
}

fn business_session_expired(message: &str) -> bool {
    let reason = message
        .split(['，', ',', '。', '！', '!', '；', ';', '：', ':'])
        .next()
        .unwrap_or_default()
        .trim();
    let reason = reason.strip_prefix("您的").unwrap_or(reason);
    matches!(
        reason,
        "请先登录"
            | "请先登录后重试"
            | "请先登录后再试"
            | "请先登录后继续"
            | "登录已过期"
            | "登录状态已过期"
            | "当前登录已过期"
            | "当前登录状态已过期"
    )
}

/// API/运行错误与自检统一写入 debug.log，每行附 RFC 3339 UTC 时间和进程编号。
#[tauri::command]
pub async fn debug_log(app: tauri::AppHandle, msg: String) -> Result<(), String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || crate::logging::append_debug(&dir, &msg))
        .await
        .map_err(|e| e.to_string())?
}

/// 网络自检：系统代理 / DNS / 连通性快照，用于远程定位「打不开」。
#[tauri::command]
pub async fn net_diag() -> Result<Value, String> {
    Ok(crate::net::diagnose().await)
}

/* ───────────────────────── 线路（数据源） ───────────────────────── */

/// 当前线路 + 固定线路清单（镜像线路另外按需拉取）。
#[tauri::command]
pub async fn line_state() -> Result<Value, String> {
    Ok(json!({
        "base": base(),
        "default": crate::net::DEFAULT_BASE,
        "fixed": crate::lines::fixed(),
    }))
}

/// 手动切换线路：立即生效并落盘（下次启动沿用）。
#[tauri::command]
pub async fn line_set(state: State<'_, Api>, url: String) -> Result<String, String> {
    crate::net::set_base(&url, || state.session.clear())
}

/// 从地址发布页抓镜像线路（只在用户点开「线路」时调用）。
#[tauri::command]
pub async fn line_mirrors() -> Result<Value, String> {
    // 用户手动点「刷新 / 打开线路」时重新读一次系统代理：代理软件开关过之后旧客户端会卡死
    crate::net::refresh_client();
    crate::lines::mirrors().await
}

/// 可达性探测：只报结果，不做自动检查 / 自动切换。
#[tauri::command]
pub async fn line_probe(urls: Vec<String>) -> Result<Value, String> {
    crate::net::refresh_client();
    Ok(crate::lines::probe(urls).await)
}

/* ───────────────────────── 更新检查 ───────────────────────── */

const REPO: &str = "Minireel/HGhub";

fn split_semver(v: &str) -> (Vec<u64>, Option<&str>) {
    let s = v.trim().trim_start_matches(['v', 'V']);
    let s = s.split('+').next().unwrap_or(s);
    let (core_str, pre) = match s.split_once('-') {
        Some((c, p)) => (c, Some(p).filter(|x| !x.is_empty())),
        None => (s, None),
    };
    let core = core_str
        .split('.')
        .map(|p| p.trim().parse::<u64>().unwrap_or(0))
        .collect();
    (core, pre)
}

fn cmp_prerelease(a: &str, b: &str) -> std::cmp::Ordering {
    let pa: Vec<&str> = a.split('.').collect();
    let pb: Vec<&str> = b.split('.').collect();
    for (x, y) in pa.iter().zip(pb.iter()) {
        let ord = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(nx), Ok(ny)) => nx.cmp(&ny),
            (Ok(_), Err(_)) => std::cmp::Ordering::Less,
            (Err(_), Ok(_)) => std::cmp::Ordering::Greater,
            (Err(_), Err(_)) => x.cmp(y),
        };
        if ord != std::cmp::Ordering::Equal {
            return ord;
        }
    }
    pa.len().cmp(&pb.len())
}

/// 按 SemVer 语义比较版本：`v1.2.0` > `1.1.9`；同主版本下正式版大于预发布版。
fn is_newer(latest: &str, current: &str) -> bool {
    let (a_core, a_pre) = split_semver(latest);
    let (b_core, b_pre) = split_semver(current);
    for i in 0..a_core.len().max(b_core.len()) {
        let x = *a_core.get(i).unwrap_or(&0);
        let y = *b_core.get(i).unwrap_or(&0);
        if x != y {
            return x > y;
        }
    }
    match (a_pre, b_pre) {
        (None, Some(_)) => true,
        (Some(_), None) | (None, None) => false,
        (Some(ap), Some(bp)) => cmp_prerelease(ap, bp) == std::cmp::Ordering::Greater,
    }
}

/// 对比 GitHub Release 的 tag 与当前版本（未认证 60 次/小时/IP，够用）。
#[tauri::command]
pub async fn check_update() -> Result<Value, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let resp = crate::net::get(
        &url,
        std::time::Duration::from_secs(12),
        Some("application/vnd.github+json"),
        None,
    )
    .await?;

    let status = resp.status();
    if status.as_u16() == 404 {
        // 还没发过 release
        return Ok(json!({
            "current": current, "latest": "", "has_update": false,
            "url": format!("https://github.com/{REPO}/releases"),
        }));
    }
    if !status.is_success() {
        return Err(format!("GitHub 返回 HTTP {status}"));
    }

    let bytes = crate::net::read_bytes_limited(resp, crate::net::MAX_TEXT_BYTES).await?;
    let v: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("更新响应 JSON 无效: {e}"))?;
    let tag = v
        .get("tag_name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let html = v
        .get("html_url")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("https://github.com/{REPO}/releases"));
    let notes = v.get("body").and_then(|x| x.as_str()).unwrap_or("");

    Ok(json!({
        "current": current,
        "latest": tag.trim_start_matches(['v', 'V']).to_string(),
        "tag": tag,
        "has_update": !tag.is_empty() && is_newer(&tag, &current),
        "url": html,
        "name": v.get("name").and_then(|x| x.as_str()).unwrap_or(""),
        "published_at": v.get("published_at").and_then(|x| x.as_str()).unwrap_or(""),
        "notes": notes.chars().take(800).collect::<String>(),
    }))
}

/// 用系统默认浏览器打开链接（只允许 http/https）。
#[tauri::command]
pub async fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let target = crate::network_policy::parse_target(&url)?;
    // 固定使用默认处理器；不向前端暴露可指定程序的 opener 命令。
    app.opener()
        .open_url(target.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// 切换移动端屏幕方向（iOS 原生旋转屏幕方向：横屏 Landscape / 竖屏 Portrait）。
#[tauri::command]
pub async fn set_orientation(app: tauri::AppHandle, landscape: bool) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let _ = app.run_on_main_thread(move || {
            request_ios_orientation(landscape);
        });
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (&app, landscape);
    }
    Ok(())
}

#[cfg(target_os = "ios")]
fn request_ios_orientation(landscape: bool) {
    use std::ffi::{c_char, c_void};
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }
    unsafe {
        let msg0: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let msg0_usize: unsafe extern "C" fn(*mut c_void, *mut c_void) -> usize =
            std::mem::transmute(objc_msgSend as *const ());
        let msg1_usize: unsafe extern "C" fn(*mut c_void, *mut c_void, usize) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let msg1_isize: unsafe extern "C" fn(*mut c_void, *mut c_void, isize) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let msg2_ptr: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, *mut c_void) =
            std::mem::transmute(objc_msgSend as *const ());
        let msg1_void: unsafe extern "C" fn(*mut c_void, *mut c_void) =
            std::mem::transmute(objc_msgSend as *const ());

        // 1. iOS 16+ UIWindowScene.requestGeometryUpdateWithPreferences:errorHandler:
        // UIInterfaceOrientationMaskPortrait = 1 << 1 = 2
        // UIInterfaceOrientationMaskLandscape = (1 << 3) | (1 << 4) = 24
        let mask: usize = if landscape { (1 << 3) | (1 << 4) } else { 1 << 1 };
        let prefs_cls = objc_getClass(b"UIWindowSceneGeometryPreferencesIOS\0".as_ptr() as *const c_char);
        let app_cls = objc_getClass(b"UIApplication\0".as_ptr() as *const c_char);
        let mut updated_via_scene = false;
        if !prefs_cls.is_null() && !app_cls.is_null() {
            let sel_alloc = sel_registerName(b"alloc\0".as_ptr() as *const c_char);
            let sel_init = sel_registerName(b"initWithInterfaceOrientations:\0".as_ptr() as *const c_char);
            let sel_release = sel_registerName(b"release\0".as_ptr() as *const c_char);
            let raw_prefs = msg0(prefs_cls, sel_alloc);
            let prefs = if !raw_prefs.is_null() {
                msg1_usize(raw_prefs, sel_init, mask)
            } else {
                std::ptr::null_mut()
            };

            let sel_shared = sel_registerName(b"sharedApplication\0".as_ptr() as *const c_char);
            let app = msg0(app_cls, sel_shared);
            if !app.is_null() && !prefs.is_null() {
                let sel_scenes = sel_registerName(b"connectedScenes\0".as_ptr() as *const c_char);
                let scenes_set = msg0(app, sel_scenes);
                if !scenes_set.is_null() {
                    let sel_all = sel_registerName(b"allObjects\0".as_ptr() as *const c_char);
                    let arr = msg0(scenes_set, sel_all);
                    if !arr.is_null() {
                        let sel_count = sel_registerName(b"count\0".as_ptr() as *const c_char);
                        let sel_at = sel_registerName(b"objectAtIndex:\0".as_ptr() as *const c_char);
                        let sel_req = sel_registerName(
                            b"requestGeometryUpdateWithPreferences:errorHandler:\0".as_ptr() as *const c_char,
                        );
                        let sel_responds = sel_registerName(b"respondsToSelector:\0".as_ptr() as *const c_char);
                        let msg_responds: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> bool =
                            std::mem::transmute(objc_msgSend as *const ());
                        let count = msg0_usize(arr, sel_count);
                        for i in 0..count {
                            let scene = msg1_usize(arr, sel_at, i);
                            if !scene.is_null() && msg_responds(scene, sel_responds, sel_req) {
                                msg2_ptr(scene, sel_req, prefs, std::ptr::null_mut());
                                updated_via_scene = true;
                            }
                        }
                    }
                }
            }
            if !prefs.is_null() {
                msg1_void(prefs, sel_release);
            }
        }

        if updated_via_scene {
            return;
        }

        // 2. Fallback (iOS < 16): UIDevice setValue:forKey:@"orientation" + attemptRotationToDeviceOrientation
        let dev_cls = objc_getClass(b"UIDevice\0".as_ptr() as *const c_char);
        let num_cls = objc_getClass(b"NSNumber\0".as_ptr() as *const c_char);
        let str_cls = objc_getClass(b"NSString\0".as_ptr() as *const c_char);
        let vc_cls = objc_getClass(b"UIViewController\0".as_ptr() as *const c_char);
        if !dev_cls.is_null() && !num_cls.is_null() && !str_cls.is_null() {
            let sel_cur = sel_registerName(b"currentDevice\0".as_ptr() as *const c_char);
            let dev = msg0(dev_cls, sel_cur);
            let sel_num = sel_registerName(b"numberWithInteger:\0".as_ptr() as *const c_char);
            let orient_val: isize = if landscape { 3 } else { 1 };
            let num = msg1_isize(num_cls, sel_num, orient_val);
            let sel_str = sel_registerName(b"stringWithUTF8String:\0".as_ptr() as *const c_char);
            let msg_str: unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_char) -> *mut c_void =
                std::mem::transmute(objc_msgSend as *const ());
            let key = msg_str(str_cls, sel_str, b"orientation\0".as_ptr() as *const c_char);
            if !dev.is_null() && !num.is_null() && !key.is_null() {
                let sel_set_val = sel_registerName(b"setValue:forKey:\0".as_ptr() as *const c_char);
                msg2_ptr(dev, sel_set_val, num, key);
            }
            if !vc_cls.is_null() {
                let sel_attempt = sel_registerName(b"attemptRotationToDeviceOrientation\0".as_ptr() as *const c_char);
                msg1_void(vc_cls, sel_attempt);
            }
        }
    }
}

/* ───────────────────────── 会话 ───────────────────────── */

#[tauri::command]
pub async fn app_boot(state: State<'_, Api>) -> Result<Value, String> {
    let origin = base();
    Ok(json!({
        "user": state.session.user(&origin),
        "logged_in": state.session.token(&origin).is_some(),
        "base": origin,
        "strict_security": crate::network_policy::strict_security(),
        "cli_relaxed": crate::network_policy::cli_strict_override() == Some(false),
    }))
}

/// 切换严格安全模式（关闭后回退到兼容清洗与网络守卫模式，立即生效并落盘）。
#[tauri::command]
pub async fn security_set(strict: bool) -> Result<bool, String> {
    crate::network_policy::set_strict_security(strict)?;
    crate::net::refresh_client();
    crate::playback_log::record(
        "security.mode_changed",
        json!({"strict": crate::network_policy::strict_security()}),
    );
    Ok(crate::network_policy::strict_security())
}

#[tauri::command]
pub async fn api_login(
    state: State<'_, Api>,
    username: String,
    password: String,
) -> Result<Value, String> {
    let origin = base();
    let data = edge(
        &origin,
        "POST",
        "/api/account/loginByPassword",
        Some(json!({ "username": username, "password": password })),
        None,
    )
    .await?;
    let token = data
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "登录返回缺少 token".to_string())?
        .to_string();
    let user = data.get("user").cloned().unwrap_or(Value::Null);
    if base() != origin {
        return Err("登录期间线路已变化，请重新登录".into());
    }
    state.session.set(&origin, token, user.clone());
    Ok(json!({ "user": user }))
}

#[tauri::command]
pub async fn api_register(
    state: State<'_, Api>,
    username: String,
    password: String,
    email: String,
) -> Result<Value, String> {
    let origin = base();
    let mut body = json!({
        "username": username,
        "password": password,
        "confirm_password": password,
    });
    if !email.trim().is_empty() {
        body["email"] = json!(email);
    }
    let data = edge(
        &origin,
        "POST",
        "/api/account/registerByPassword",
        Some(body),
        None,
    )
    .await?;
    let token = data
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "注册返回缺少 token".to_string())?
        .to_string();
    let user = data.get("user").cloned().unwrap_or(Value::Null);
    if base() != origin {
        return Err("注册期间线路已变化，请重新登录".into());
    }
    state.session.set(&origin, token, user.clone());
    Ok(json!({ "user": user }))
}

#[tauri::command]
pub fn api_logout(state: State<'_, Api>) -> Result<Value, String> {
    let origin = base();
    if let Some(token) = state.session.take_token(&origin) {
        tauri::async_runtime::spawn(async move {
            let _ = edge(&origin, "POST", "/api/account/logout", None, Some(&token)).await;
        });
    }
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn api_me(state: State<'_, Api>) -> Result<Value, String> {
    let origin = base();
    let credentials = state.session.credentials(&origin);
    let me = state
        .request(&origin, credentials.as_ref(), "GET", "/api/account/me", None, || true)
        .await?;
    if base() != origin {
        return Err("读取账号期间线路已变化".into());
    }
    if let Some(credentials) = credentials.as_ref() {
        if !state
            .session
            .update_user_if_matches(&origin, credentials, me.clone())
        {
            return Err("登录状态已变化，请重试".into());
        }
    }
    Ok(me)
}

/* ───────────────────────── 列表 ───────────────────────── */

#[tauri::command]
pub async fn api_feed(state: State<'_, Api>, page: u32, size: u32) -> Result<Value, String> {
    state
        .get(&format!("/api/videos?page={page}&size={size}"))
        .await
}

fn validate_category_slug(cate: &str) -> Result<&str, String> {
    let trimmed = cate.trim();
    if trimmed.is_empty()
        || trimmed.len() > 64
        || !trimmed
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("分类标识无效".to_string());
    }
    Ok(trimmed)
}

fn normalize_category_sort(sort: Option<&str>) -> &'static str {
    match sort.map(str::trim) {
        Some("hot") => "hot",
        _ => "new",
    }
}

fn category_api_path(cate: &str, sort: &str, page: u32, size: u32) -> String {
    if cate == "original" {
        format!("/api/videos?is_original=1&sort={sort}&page={page}&size={size}")
    } else {
        format!("/api/videos/category/{cate}?sort={sort}&page={page}&size={size}")
    }
}

#[tauri::command]
pub async fn api_category(
    state: State<'_, Api>,
    cate: String,
    page: u32,
    size: u32,
    sort: Option<String>,
) -> Result<Value, String> {
    let cate = validate_category_slug(&cate)?;
    let sort = normalize_category_sort(sort.as_deref());
    let path = category_api_path(cate, sort, page, size);
    state.get(&path).await
}

#[tauri::command]
pub async fn api_rank(state: State<'_, Api>, kind: String) -> Result<Value, String> {
    let kind = match kind.as_str() {
        "recommend" | "potential" => kind,
        _ => "hot".to_string(),
    };
    state.get(&format!("/api/ranks/{kind}")).await
}

#[tauri::command]
pub async fn api_search(
    state: State<'_, Api>,
    q: String,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    let encoded: String = url::form_urlencoded::byte_serialize(q.as_bytes()).collect();
    state
        .get(&format!("/api/search?q={encoded}&page={page}&size={size}"))
        .await
}

#[tauri::command]
pub async fn api_posts(state: State<'_, Api>, page: u32, size: u32) -> Result<Value, String> {
    state
        .get(&format!("/api/posts?page={page}&size={size}"))
        .await
}

#[tauri::command]
pub async fn api_post(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.get(&format!("/api/posts/{id}")).await
}

/* ───────────────────────── 详情 / 播放 ───────────────────────── */

#[tauri::command]
pub async fn api_video(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.get(&format!("/api/videos/{id}")).await
}

/// 新版播放接口返回 `streams.{main,hevc,preview}`，旧接口的 `video_url` 现在恒为空串。
/// 这里把新字段回填到 `video_url` / `video_url_hevc`，前端和自检继续按原字段取流。
fn normalize_play_info(info: &mut Value) {
    fn non_empty(v: Option<&Value>) -> Option<String> {
        v.and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    }
    let main = non_empty(info.get("streams").and_then(|s| s.get("main")));
    let hevc = non_empty(info.get("streams").and_then(|s| s.get("hevc")));
    let Some(obj) = info.as_object_mut() else { return };
    for (field, stream) in [("video_url", main), ("video_url_hevc", hevc)] {
        if let Some(url) = stream {
            if non_empty(obj.get(field)).is_none() {
                obj.insert(field.into(), json!(url));
            }
        }
    }
}

fn has_play_url(info: &Value) -> bool {
    info.get("video_url")
        .and_then(|v| v.as_str())
        .is_some_and(|s| !s.is_empty())
}

fn playback_session_error(error: &str) -> bool {
    matches!(error, SESSION_EXPIRED | SESSION_CHANGED | EDGE_CONTEXT_CHANGED)
}

async fn resolve_playback<F: std::future::Future<Output = Result<Value, String>>>(
    mut primary: Result<Value, String>,
    is_current: impl Fn() -> bool,
    legacy: impl FnOnce() -> F,
) -> Result<Value, String> {
    if primary.as_ref().is_err_and(|error| playback_session_error(error)) {
        return primary;
    }
    if !is_current() {
        return Err(EDGE_CONTEXT_CHANGED.into());
    }
    if let Ok(info) = &mut primary {
        normalize_play_info(info);
        if has_play_url(info) {
            return primary;
        }
    }

    let fallback = legacy().await;
    if fallback.as_ref().is_err_and(|error| playback_session_error(error)) {
        return fallback;
    }
    if !is_current() {
        return Err(EDGE_CONTEXT_CHANGED.into());
    }
    match fallback {
        Ok(mut info) => {
            normalize_play_info(&mut info);
            if has_play_url(&info) || primary.is_err() {
                Ok(info)
            } else {
                primary
            }
        }
        Err(_) => primary,
    }
}

async fn until_session_changes<F: std::future::Future<Output = Result<Value, String>>>(
    mut revisions: tokio::sync::watch::Receiver<u64>,
    revision: u64,
    operation: F,
) -> Result<Value, String> {
    tokio::select! {
        biased;
        _ = revisions.wait_for(|current| *current != revision) => Err(EDGE_CONTEXT_CHANGED.into()),
        result = operation => result,
    }
}

#[tauri::command]
pub async fn api_play(state: State<'_, Api>, id: i64, ep: u32) -> Result<Value, String> {
    let revisions = state.session.revisions();
    let origin = base();
    let (revision, credentials) = state.session.snapshot(&origin);
    let is_current = || base() == origin && state.session.matches_revision(revision);
    if !is_current() {
        return Err(EDGE_CONTEXT_CHANGED.into());
    }
    let primary_path = format!("/api/videos/{id}/episodes/{ep}/playback");
    let legacy_path = format!("/api/videos/{id}/play?ep={ep}&page_texts=0");
    until_session_changes(revisions, revision, async {
        let primary = state
            .request(
                &origin,
                credentials.as_ref(),
                "POST",
                &primary_path,
                Some(json!({})),
                is_current,
            )
            .await;
        resolve_playback(primary, is_current, || {
            state.request(&origin, credentials.as_ref(), "GET", &legacy_path, None, is_current)
        })
        .await
    })
    .await
}

/* ───────────────────────── 评论 / 互动 ───────────────────────── */

#[tauri::command]
pub async fn api_comments(
    state: State<'_, Api>,
    id: i64,
    ep: u32,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    state
        .get(&format!(
            "/api/videos/{id}/comments?ep={ep}&page={page}&size={size}"
        ))
        .await
}

#[tauri::command]
pub async fn api_comment_send(
    state: State<'_, Api>,
    id: i64,
    ep: u32,
    text: String,
    reply_id: Option<i64>,
) -> Result<Value, String> {
    let mut body = json!({ "text": text });
    let path = match reply_id {
        Some(rid) if rid > 0 => {
            body["reply_id"] = json!(rid);
            format!("/api/videos/{id}/comments")
        }
        _ => format!("/api/videos/{id}/comments?ep={ep}"),
    };
    state.authed("POST", &path, Some(body)).await
}

#[tauri::command]
pub async fn api_like(state: State<'_, Api>, id: i64, ep: u32, on: bool) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .authed(method, &format!("/api/videos/{id}/like?ep={ep}"), None)
        .await
}

#[tauri::command]
pub async fn api_collect(state: State<'_, Api>, id: i64, on: bool) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .authed(method, &format!("/api/videos/{id}/collect"), None)
        .await
}

#[tauri::command]
pub async fn api_follow(state: State<'_, Api>, uid: i64, on: bool) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .authed(method, &format!("/api/users/{uid}/follow"), None)
        .await
}

/* ───────────────────────── 本地缓存 ───────────────────────── */

#[tauri::command]
pub async fn cache_clear() -> Result<(), String> {
    tokio::task::spawn_blocking(crate::media::clear_caches)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn cache_trim_memory() -> Result<(), String> {
    tokio::task::spawn_blocking(crate::media::trim_memory_caches)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn cache_stats() -> Result<Value, String> {
    let (entries, bytes) = tokio::task::spawn_blocking(crate::media::cache_stats)
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({ "entries": entries, "bytes": bytes }))
}

#[tauri::command]
pub async fn media_prewarm(url: String) -> Result<(), String> {
    crate::media::prewarm_hls(&url);
    Ok(())
}

/* ───────────────────────── 吃瓜帖子互动 ───────────────────────── */

#[tauri::command]
pub async fn api_post_like(state: State<'_, Api>, id: i64, on: bool) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .authed(method, &format!("/api/posts/{id}/like"), None)
        .await
}

#[tauri::command]
pub async fn api_post_collect(state: State<'_, Api>, id: i64, on: bool) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .authed(method, &format!("/api/posts/{id}/collect"), None)
        .await
}

#[tauri::command]
pub async fn api_post_comments(
    state: State<'_, Api>,
    id: i64,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    state
        .get(&format!("/api/posts/{id}/comments?page={page}&size={size}"))
        .await
}
#[cfg(test)]
mod tests {
    use super::{
        category_api_path, has_play_url, is_newer, normalize_category_sort, normalize_play_info,
        validate_category_slug,
    };
    use crate::net::EdgeError;
    use serde_json::{json, Value};

    #[tokio::test]
    async fn local_sign_out_cancels_pending_playback_before_remote_completion() {
        use super::{until_session_changes, Api, EDGE_CONTEXT_CHANGED};
        use tokio::sync::{oneshot, Notify};

        let api = Api::new();
        let origin = "https://huangguoai.com";
        api.session.set(origin, "old-token".into(), json!({"id": 1}));
        let revisions = api.session.revisions();
        let (revision, _) = api.session.snapshot(origin);
        let (waiting, started) = oneshot::channel();
        let connection_ready = Notify::new();
        let playback = until_session_changes(revisions, revision, async {
            waiting.send(()).unwrap();
            connection_ready.notified().await;
            panic!("obsolete playback should not resume when the connection becomes ready");
        });
        let (result, ()) = tokio::join!(playback, async {
            started.await.unwrap();
            assert_eq!(api.session.take_token(origin).as_deref(), Some("old-token"));
            assert!(api.session.credentials(origin).is_none());
            connection_ready.notify_one();
        });
        assert_eq!(result, Err(EDGE_CONTEXT_CHANGED.into()));
    }

    #[tokio::test]
    async fn playback_session_expiry_survives_its_own_invalidation_signal() {
        use super::{until_session_changes, Api, SESSION_EXPIRED};

        let api = Api::new();
        let origin = "https://huangguoai.com";
        api.session.set(origin, "expired-token".into(), json!({"id": 1}));
        let revisions = api.session.revisions();
        let (revision, credentials) = api.session.snapshot(origin);
        let result = until_session_changes(revisions, revision, async {
            tokio::task::yield_now().await;
            Err(api.session_error(origin, &credentials.unwrap(), EdgeError::Unauthorized))
        })
        .await;
        assert_eq!(result, Err(SESSION_EXPIRED.into()));
        assert!(api.session.credentials(origin).is_none());
    }

    #[tokio::test]
    async fn playback_fallback_preserves_session_expiry() {
        use super::{resolve_playback, SESSION_CHANGED, SESSION_EXPIRED};
        for error in [SESSION_EXPIRED, SESSION_CHANGED] {
            let result = resolve_playback(Err(error.into()), || false, || async {
                panic!("session failures must skip legacy playback")
            })
            .await;
            assert_eq!(result, Err(error.into()));
        }

        let result = resolve_playback(Ok(json!({})), || true, || async { Err(SESSION_EXPIRED.into()) }).await;
        assert_eq!(result, Err(SESSION_EXPIRED.into()));
        let result = resolve_playback(Err("primary unavailable".into()), || true, || async {
            Ok(json!({"streams": {"main": "https://fixture.invalid/video.m3u8"}}))
        })
        .await;
        assert_eq!(result.unwrap()["video_url"], "https://fixture.invalid/video.m3u8");
    }

    #[tokio::test]
    async fn playback_skips_or_discards_fallback_when_context_changes() {
        use super::{resolve_playback, Api, EDGE_CONTEXT_CHANGED};
        use std::cell::Cell;

        let api = Api::new();
        let origin = "https://huangguoai.com";
        api.session.set(origin, "fixture".into(), json!({"id": 1}));
        let (revision, _) = api.session.snapshot(origin);
        let active_origin = Cell::new(origin);
        let is_current = || active_origin.get() == origin && api.session.matches_revision(revision);

        active_origin.set("https://huangguoai.ai");
        let result = resolve_playback(Err("timeout".into()), is_current, || async {
            panic!("a switched line must skip fallback")
        })
        .await;
        assert_eq!(result, Err(EDGE_CONTEXT_CHANGED.into()));

        active_origin.set(origin);
        let result = resolve_playback(Err("timeout".into()), is_current, || async {
            api.session.clear();
            Ok(json!({"video_url": "https://fixture.invalid/legacy.m3u8"}))
        })
        .await;
        assert_eq!(result, Err(EDGE_CONTEXT_CHANGED.into()));

        // Session versions still change if the server reuses a token.
        api.session.set(origin, "fixture".into(), json!({"id": 1}));
        let result = resolve_playback(Err("timeout".into()), is_current, || async {
            panic!("a replacement session must skip fallback")
        })
        .await;
        assert_eq!(result, Err(EDGE_CONTEXT_CHANGED.into()));
    }

    #[test]
    fn business_expiry_accepts_variants_without_matching_unrelated_text() {
        let origin = "https://huangguoai.com";
        let api = super::Api::new();
        for message in [
            "您的登录已过期，请重新登录",
            "当前登录状态已过期；请重新登录。",
            "请先登录后再试！",
        ] {
            api.session.set(origin, "fixture".into(), json!({"id": 1}));
            let credentials = api.session.credentials(origin).unwrap();
            assert_eq!(
                api.session_error(origin, &credentials, EdgeError::Business(message.into())),
                super::SESSION_EXPIRED
            );
            assert!(api.session.token(origin).is_none());
        }
        api.session.set(origin, "fixture".into(), json!({"id": 1}));
        let credentials = api.session.credentials(origin).unwrap();
        let quoted = "评论内容不能包含「登录已过期」";
        assert_eq!(
            api.session_error(origin, &credentials, EdgeError::Business(quoted.into())),
            quoted
        );
        assert_eq!(api.session.token(origin).as_deref(), Some("fixture"));
    }

    #[test]
    fn business_auth_errors_expire_only_the_request_session() {
        let api = super::Api::new();
        let origin = "https://huangguoai.com";
        api.session.set(origin, "fixture".into(), json!({"id": 1}));
        let old = api.session.credentials(origin).unwrap();
        api.session.set(origin, "fixture".into(), json!({"id": 2}));
        let current = api.session.credentials(origin).unwrap();

        assert_eq!(
            api.session_error(origin, &old, EdgeError::Business("请先登录".into())),
            "登录状态已变化，请重试"
        );
        assert_eq!(
            api.session_error(origin, &current, EdgeError::Business("操作失败".into())),
            "操作失败"
        );
        for error in [
            "HTTP 503: <html>登录已过期，请重新登录</html>",
            "expected value at line 1 column 1: <html>登录已过期</html>",
        ] {
            assert_eq!(
                api.session_error(origin, &current, EdgeError::Transport(error.into())),
                error
            );
        }
        assert_eq!(api.session.user(origin), json!({"id": 2}));
        assert!(api.session_error(origin, &current, EdgeError::Business("登录已过期，请重新登录".into())).starts_with("HTTP 401"));
        assert_eq!(api.session.token(origin), None);
    }

    #[test]
    fn new_playback_streams_fill_legacy_url_fields() {
        let mut info = json!({
            "video_url": "",
            "streams": {"main": "https://x/main.m3u8", "hevc": "https://x/hevc.m3u8", "preview": "https://x/p.m3u8"}
        });
        normalize_play_info(&mut info);
        assert_eq!(info["video_url"], "https://x/main.m3u8");
        assert_eq!(info["video_url_hevc"], "https://x/hevc.m3u8");
        assert!(has_play_url(&info));
    }

    #[test]
    fn existing_video_url_is_kept_and_empty_streams_stay_empty() {
        let mut keep = json!({"video_url": "https://old/a.m3u8", "streams": {"main": "https://x/main.m3u8"}});
        normalize_play_info(&mut keep);
        assert_eq!(keep["video_url"], "https://old/a.m3u8");

        let mut empty = json!({"video_url": "", "streams": {"main": ""}});
        normalize_play_info(&mut empty);
        assert!(!has_play_url(&empty));
        assert!(!has_play_url(&json!({"id": 1})));
    }

    #[test]
    fn frontend_cannot_bypass_url_policy_with_opener_commands() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        for permission in capability["permissions"].as_array().unwrap() {
            let name = permission
                .as_str()
                .or_else(|| permission["identifier"].as_str())
                .unwrap();
            assert!(
                !name.starts_with("opener:"),
                "frontend opener command exposed: {name}"
            );
        }
    }

    #[test]
    fn external_links_are_urls_not_shell_commands() {
        for raw in [
            "https://example.com/|calc.exe",
            "https://example.com/?a=1&b=2",
            "https://example.com/%25PATH%25",
            "https://example.com/%VAR%",
        ] {
            assert!(crate::network_policy::parse_target(raw).is_ok());
        }
        for raw in [
            "file:///etc/passwd",
            "mailto:user@example.com",
            "tel:123",
            "data:text/html,test",
            "javascript:alert(1)",
            "https://example.com/\0cmd",
            "https://user:password@example.com/",
        ] {
            assert!(crate::network_policy::parse_target(raw).is_err());
        }
    }

    #[test]
    fn compares_versions() {
        assert!(is_newer("v1.0.2", "1.0.1"));
        assert!(is_newer("v1.1", "1.0.9"));
        assert!(is_newer("1.0.10", "1.0.9"));
        assert!(!is_newer("v1.0.1", "1.0.1"));
        assert!(!is_newer("v0.9.9", "1.0.1"));
        assert!(!is_newer("", "1.0.1"));
        assert!(!is_newer("v1.2.0-beta.1", "1.2.0"));
        assert!(!is_newer("v1.2.0-ios", "1.2.0"));
        assert!(is_newer("v1.2.0", "1.2.0-rc.1"));
        assert!(is_newer("v1.2.0-beta.2", "1.2.0-beta.1"));
    }

    #[test]
    fn category_slug_validation_rejects_traversal_and_query_injection() {
        assert_eq!(validate_category_slug("ai-duanju").unwrap(), "ai-duanju");
        assert_eq!(validate_category_slug("cat_01").unwrap(), "cat_01");
        for bad in ["", "   ", "../admin", "a/b", "ai?page=1", "ai#frag", "中文"] {
            assert!(validate_category_slug(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn category_api_path_routes_original_and_standard_slugs() {
        assert_eq!(normalize_category_sort(None), "new");
        assert_eq!(normalize_category_sort(Some("hot")), "hot");
        assert_eq!(normalize_category_sort(Some("score")), "new");
        assert_eq!(normalize_category_sort(Some("hot&bad=1")), "new");
        assert_eq!(
            category_api_path("original", "new", 2, 20),
            "/api/videos?is_original=1&sort=new&page=2&size=20"
        );
        assert_eq!(
            category_api_path("original", "hot", 1, 20),
            "/api/videos?is_original=1&sort=hot&page=1&size=20"
        );
        assert_eq!(
            category_api_path("ai-duanju", "new", 2, 20),
            "/api/videos/category/ai-duanju?sort=new&page=2&size=20"
        );
        assert_eq!(
            category_api_path("ai-duanju", "hot", 2, 20),
            "/api/videos/category/ai-duanju?sort=hot&page=2&size=20"
        );
    }
}
