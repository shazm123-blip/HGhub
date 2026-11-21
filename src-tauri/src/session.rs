//! 会话持久化：token + 用户资料存到应用数据目录。

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

fn lock_state<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Session {
    // 旧版本没有 origin：不能推断其 token 属于哪个镜像，升级后必须重新登录。
    #[serde(default)]
    pub origin: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub user: serde_json::Value,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn credentials_are_bound_to_origin() {
        let store = SessionStore::new();
        store.set(
            "https://huangguoai.com",
            "secret-token".into(),
            json!({"id": 1}),
        );
        assert_eq!(
            store.token("https://huangguoai.com").as_deref(),
            Some("secret-token")
        );
        assert_eq!(store.token("https://huangguoai.ai"), None);
        assert_eq!(store.token("https://evil.example"), None);
        assert!(store.user("https://evil.example").is_null());
        store.clear();
        assert_eq!(store.token("https://huangguoai.com"), None);
    }

    #[test]
    fn legacy_sessions_are_not_assigned_to_current_line() {
        let store = SessionStore::new();
        *lock_state(&store.current) =
            serde_json::from_str(r#"{"token":"legacy","user":{"id":1}}"#).unwrap();
        assert_eq!(store.token("https://huangguoai.com"), None);
        assert!(store.user("https://huangguoai.com").is_null());
    }

    #[test]
    fn persists_atomically_with_restricted_permissions() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hghub-session-{}-{unique}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = SessionStore::new();
        store.bind(dir.clone());
        store.set(
            "https://huangguoai.com",
            "secret-token".into(),
            json!({"id": 42}),
        );
        let session_path = dir.join("session.json");
        assert!(session_path.exists());
        assert!(!dir.join("session.json.tmp").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&session_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let reloaded = SessionStore::new();
        reloaded.bind(dir.clone());
        assert_eq!(
            reloaded.token("https://huangguoai.com").as_deref(),
            Some("secret-token")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}

pub struct SessionStore {
    pub file: Mutex<Option<PathBuf>>,
    pub current: Mutex<Session>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self {
            file: Mutex::new(None),
            current: Mutex::new(Session::default()),
        }
    }

    pub fn bind(&self, dir: PathBuf) {
        let mut path = dir;
        path.push("session.json");
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(sess) = serde_json::from_str::<Session>(&text) {
                *lock_state(&self.current) = sess;
            }
        }
        *lock_state(&self.file) = Some(path);
    }

    pub fn token(&self, origin: &str) -> Option<String> {
        let cur = lock_state(&self.current);
        (cur.origin == origin && !cur.token.is_empty()).then(|| cur.token.clone())
    }

    pub fn user(&self, origin: &str) -> serde_json::Value {
        let cur = lock_state(&self.current);
        if cur.origin == origin && !cur.token.is_empty() {
            cur.user.clone()
        } else {
            serde_json::Value::Null
        }
    }

    pub fn set(&self, origin: &str, token: String, user: serde_json::Value) {
        {
            let mut cur = lock_state(&self.current);
            cur.origin = origin.to_string();
            cur.token = token;
            cur.user = user;
        }
        self.persist();
    }

    pub fn clear(&self) {
        {
            let mut cur = lock_state(&self.current);
            cur.token.clear();
            cur.origin.clear();
            cur.user = serde_json::Value::Null;
        }
        self.persist();
    }

    fn persist(&self) {
        let snapshot = lock_state(&self.current).clone();
        let path = lock_state(&self.file).clone();
        if let Some(path) = path {
            if let Ok(text) = serde_json::to_string_pretty(&snapshot) {
                let tmp = path.with_extension("json.tmp");
                let mut opts = std::fs::OpenOptions::new();
                opts.write(true).create(true).truncate(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    opts.mode(0o600);
                }
                if let Ok(mut file) = opts.open(&tmp) {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let _ = std::fs::set_permissions(
                            &tmp,
                            std::fs::Permissions::from_mode(0o600),
                        );
                    }
                    if file.write_all(text.as_bytes()).is_ok() && file.sync_all().is_ok() {
                        drop(file);
                        let _ = std::fs::rename(&tmp, &path);
                    } else {
                        drop(file);
                        let _ = std::fs::remove_file(&tmp);
                    }
                }
            }
        }
    }
}
