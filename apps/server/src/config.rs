//! Bind address and data directory for the headless server.
use std::{
    env, fs,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
};

pub const DEFAULT_BIND: &str = "127.0.0.1:8787";
pub const DEFAULT_PORT: u16 = 8787;

#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub bind: SocketAddr,
    pub data_dir: PathBuf,
    pub web_root: Option<PathBuf>,
    pub token_env: Option<String>,
}

impl ServerConfig {
    pub fn from_env() -> Result<Self, String> {
        let bind = parse_bind(
            env::var("STRATA_MANAGER_BIND")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .as_deref()
                .unwrap_or(DEFAULT_BIND),
        )?;
        warn_non_loopback(bind);
        let data_dir = env::var("STRATA_MANAGER_DATA_DIR")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(default_data_dir);
        if !data_dir.is_absolute() {
            return Err("STRATA_MANAGER_DATA_DIR must be an absolute path".into());
        }
        fs::create_dir_all(&data_dir).map_err(|e| format!("data dir: {e}"))?;
        let data_dir = dunce::canonicalize(&data_dir).map_err(|e| format!("data dir: {e}"))?;
        let web_root = env::var("STRATA_MANAGER_WEB_ROOT")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from);
        let token_env = env::var("STRATA_MANAGER_TOKEN").ok();
        Ok(Self {
            bind,
            data_dir,
            web_root,
            token_env,
        })
    }

    pub fn for_test(data_dir: PathBuf, bind: SocketAddr) -> Self {
        Self {
            bind,
            data_dir,
            web_root: None,
            token_env: None,
        }
    }
}

pub fn parse_bind(raw: &str) -> Result<SocketAddr, String> {
    raw.trim()
        .parse::<SocketAddr>()
        .map_err(|e| format!("invalid STRATA_MANAGER_BIND '{raw}': {e}"))
}

pub fn warn_non_loopback(bind: SocketAddr) {
    if !bind.ip().is_loopback() {
        eprintln!(
            "WARNING: strata-manager-server is binding to {} (not loopback). \
             A bearer token is required; prefer a reverse proxy with TLS for LAN access.",
            bind
        );
    }
}

fn default_data_dir() -> PathBuf {
    if let Ok(home) = env::var("HOME") {
        return PathBuf::from(home).join(".local/share/strata-manager-server");
    }
    PathBuf::from("/var/lib/strata-manager")
}

pub fn is_loopback_only(bind: SocketAddr) -> bool {
    match bind.ip() {
        IpAddr::V4(ip) => ip.is_loopback() || ip == Ipv4Addr::UNSPECIFIED && false,
        IpAddr::V6(ip) => ip.is_loopback(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, SocketAddrV4};

    #[test]
    fn default_bind_is_loopback_8787() {
        let addr = parse_bind(DEFAULT_BIND).unwrap();
        assert_eq!(
            addr,
            SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 8787))
        );
        assert!(addr.ip().is_loopback());
    }

    #[test]
    fn rejects_garbage_bind() {
        assert!(parse_bind("not-an-addr").is_err());
    }
}
