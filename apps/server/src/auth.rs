//! Bearer token for the headless management API.
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub const TOKEN_FILE: &str = "server-token";

#[derive(Clone, Debug)]
pub struct AuthState {
    /// Constant-time comparable digest of the bearer token.
    digest: [u8; 32],
    pub token_path: PathBuf,
    /// True when this process created the token file (print once).
    pub newly_created: bool,
}

impl AuthState {
    pub fn load_or_create(data_dir: &Path) -> Result<(Self, Option<String>), String> {
        fs::create_dir_all(data_dir).map_err(|e| format!("data dir: {e}"))?;
        let token_path = data_dir.join(TOKEN_FILE);
        if token_path.is_file() {
            let raw = fs::read_to_string(&token_path).map_err(|e| format!("read token: {e}"))?;
            let token = raw.trim().to_string();
            if token.len() < 16 {
                return Err("server-token is too short; delete it to regenerate".into());
            }
            return Ok((
                Self {
                    digest: hash_token(&token),
                    token_path,
                    newly_created: false,
                },
                None,
            ));
        }
        let token = generate_token()?;
        write_token_file(&token_path, &token)?;
        Ok((
            Self {
                digest: hash_token(&token),
                token_path,
                newly_created: true,
            },
            Some(token),
        ))
    }

    pub fn from_env_or_file(
        data_dir: &Path,
        env_token: Option<String>,
    ) -> Result<(Self, Option<String>), String> {
        if let Some(token) = env_token.filter(|t| !t.trim().is_empty()) {
            let token = token.trim().to_string();
            if token.len() < 16 {
                return Err("STRATA_MANAGER_TOKEN must be at least 16 characters".into());
            }
            let token_path = data_dir.join(TOKEN_FILE);
            // Do not rewrite the file when env overrides; still keep path for diagnostics.
            return Ok((
                Self {
                    digest: hash_token(&token),
                    token_path,
                    newly_created: false,
                },
                None,
            ));
        }
        Self::load_or_create(data_dir)
    }

    pub fn authorize(&self, header: Option<&str>) -> Result<(), AuthError> {
        let Some(header) = header else {
            return Err(AuthError::Missing);
        };
        let token = header
            .strip_prefix("Bearer ")
            .or_else(|| header.strip_prefix("bearer "))
            .ok_or(AuthError::Malformed)?;
        if !constant_time_eq(&self.digest, &hash_token(token.trim())) {
            return Err(AuthError::Invalid);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthError {
    Missing,
    Malformed,
    Invalid,
}

impl AuthError {
    pub fn status(self) -> u16 {
        401
    }
    pub fn message(self) -> &'static str {
        match self {
            Self::Missing => "missing Authorization Bearer token",
            Self::Malformed => "Authorization must be Bearer <token>",
            Self::Invalid => "invalid bearer token",
        }
    }
}

fn hash_token(token: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hasher.finalize().into()
}

fn constant_time_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn generate_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("random token: {e}"))?;
    Ok(base64::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        bytes,
    ))
}

fn write_token_file(path: &Path, token: &str) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| format!("create token file: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod token: {e}"))?;
    }
    file.write_all(token.as_bytes())
        .map_err(|e| format!("write token: {e}"))?;
    file.write_all(b"\n")
        .map_err(|e| format!("write token: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn rejects_missing_and_wrong_token() {
        let dir = tempdir().unwrap();
        let (auth, created) = AuthState::load_or_create(dir.path()).unwrap();
        let token = created.expect("new token");
        assert!(auth.authorize(None).is_err());
        assert!(auth.authorize(Some("Basic x")).is_err());
        assert!(auth.authorize(Some("Bearer wrong-token-value!!")).is_err());
        assert!(auth.authorize(Some(&format!("Bearer {token}"))).is_ok());
    }

    #[test]
    fn reuses_existing_token_file() {
        let dir = tempdir().unwrap();
        let (first, t1) = AuthState::load_or_create(dir.path()).unwrap();
        let token = t1.unwrap();
        assert!(first.newly_created);
        let (second, t2) = AuthState::load_or_create(dir.path()).unwrap();
        assert!(t2.is_none());
        assert!(!second.newly_created);
        assert!(second.authorize(Some(&format!("Bearer {token}"))).is_ok());
    }

    #[test]
    fn env_token_overrides_file() {
        let dir = tempdir().unwrap();
        let (_, _) = AuthState::load_or_create(dir.path()).unwrap();
        let env = "env-override-token-123456".to_string();
        let (auth, printed) = AuthState::from_env_or_file(dir.path(), Some(env.clone())).unwrap();
        assert!(printed.is_none());
        assert!(auth.authorize(Some(&format!("Bearer {env}"))).is_ok());
    }
}
