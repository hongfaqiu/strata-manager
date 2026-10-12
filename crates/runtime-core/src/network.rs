//! Local listener settings and the address the Manager uses to control it.
//! Wildcards are listen addresses only; control requests always target this host.
use crate::types::ServiceProfile;
use serde_json::Value;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener};

pub(crate) struct ListenEndpoint {
    pub host: String,
    pub port: u16,
    pub address: SocketAddr,
    pub listen_address: SocketAddr,
    pub base_url: String,
}

/// Probe the address the server will bind, rather than its control URL. A
/// wildcard control URL uses loopback and can miss another interface's socket.
pub(crate) fn assert_bind_available(address: SocketAddr) -> Result<(), String> {
    #[cfg(windows)]
    {
        // Winsock permits a default wildcard socket to coexist with a socket
        // on a concrete interface. Use the native full-port LISTEN table too;
        // SO_EXCLUSIVEADDRUSE would falsely reject a retired server's TIME_WAIT.
        // This profile only supplies the port to the existing owner-table API.
        let probe = ServiceProfile {
            id: String::new(),
            name: String::new(),
            base_url: format!("http://127.0.0.1:{}", address.port()),
            install_dir: String::new(),
            python_path: String::new(),
            config_path: String::new(),
            managed: true,
        };
        if !crate::external::listener_ids(&probe)?.is_empty() {
            return Err(format!(
                "监听端口 {} 已被其它进程占用，未启动新服务",
                address.port()
            ));
        }
    }
    bind_listener(address)
        .map(|_| ())
        .map_err(|error| format!("监听地址 {address} 无法绑定，未启动新服务：{error}"))
}

#[cfg(not(unix))]
fn bind_listener(address: SocketAddr) -> std::io::Result<TcpListener> {
    TcpListener::bind(address)
}

#[cfg(unix)]
fn bind_listener(address: SocketAddr) -> std::io::Result<TcpListener> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    // Python's server sets SO_REUSEADDR. Match it so a just-stopped owned
    // listener's TIME_WAIT sockets don't cause a false conflict. listen(),
    // rather than bind() alone, still rejects an existing live listener.
    let domain = if address.is_ipv4() {
        libc::AF_INET
    } else {
        libc::AF_INET6
    };
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let socket_type = libc::SOCK_STREAM | libc::SOCK_CLOEXEC;
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    let socket_type = libc::SOCK_STREAM;
    // The resulting descriptor is owned immediately and closed on every error.
    let raw = unsafe { libc::socket(domain, socket_type, 0) };
    if raw < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let socket = unsafe { OwnedFd::from_raw_fd(raw) };
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    if unsafe { libc::fcntl(socket.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let reuse: libc::c_int = 1;
    if unsafe {
        libc::setsockopt(
            socket.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_REUSEADDR,
            (&reuse as *const libc::c_int).cast(),
            std::mem::size_of_val(&reuse) as libc::socklen_t,
        )
    } < 0
    {
        return Err(std::io::Error::last_os_error());
    }
    let result = match address {
        SocketAddr::V4(address) => {
            let mut native: libc::sockaddr_in = unsafe { std::mem::zeroed() };
            #[cfg(any(
                target_os = "macos",
                target_os = "ios",
                target_os = "freebsd",
                target_os = "openbsd",
                target_os = "netbsd",
                target_os = "dragonfly"
            ))]
            {
                native.sin_len = std::mem::size_of_val(&native) as _;
            }
            native.sin_family = libc::AF_INET as _;
            native.sin_port = address.port().to_be();
            native.sin_addr.s_addr = u32::from_ne_bytes(address.ip().octets());
            unsafe {
                libc::bind(
                    socket.as_raw_fd(),
                    (&native as *const libc::sockaddr_in).cast(),
                    std::mem::size_of_val(&native) as libc::socklen_t,
                )
            }
        }
        SocketAddr::V6(address) => {
            let mut native: libc::sockaddr_in6 = unsafe { std::mem::zeroed() };
            #[cfg(any(
                target_os = "macos",
                target_os = "ios",
                target_os = "freebsd",
                target_os = "openbsd",
                target_os = "netbsd",
                target_os = "dragonfly"
            ))]
            {
                native.sin6_len = std::mem::size_of_val(&native) as _;
            }
            native.sin6_family = libc::AF_INET6 as _;
            native.sin6_port = address.port().to_be();
            native.sin6_addr.s6_addr = address.ip().octets();
            native.sin6_flowinfo = address.flowinfo().to_be();
            native.sin6_scope_id = address.scope_id();
            unsafe {
                libc::bind(
                    socket.as_raw_fd(),
                    (&native as *const libc::sockaddr_in6).cast(),
                    std::mem::size_of_val(&native) as libc::socklen_t,
                )
            }
        }
    };
    if result < 0 || unsafe { libc::listen(socket.as_raw_fd(), libc::SOMAXCONN) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(TcpListener::from(socket))
}

/// The old owned listener is still live during restart preflight. Allow exact
/// replacements and a known wildcard narrowing; refuse an overlapping expansion
/// instead of overlooking a foreign per-interface listener on Unix.
pub(crate) fn assert_replacement_bind_available(
    target: SocketAddr,
    owned: SocketAddr,
) -> Result<(), String> {
    if target.port() != owned.port() {
        return assert_bind_available(target);
    }
    let same_family = target.is_ipv4() == owned.is_ipv4();
    if target == owned || (same_family && owned.ip().is_unspecified()) {
        return Ok(());
    }
    if target.ip().is_unspecified() || owned.ip().is_unspecified() {
        #[cfg(windows)]
        if same_family {
            // The caller must subsequently prove all port listeners belong to
            // the held Windows Job before allowing an overlapping replacement.
            return Ok(());
        }
        return Err("运行中不能在同一端口扩大或改变通配监听范围；请改用其它端口，或先停止模型服务后再启动。原服务仍保留".into());
    }
    assert_bind_available(target)
}

fn local_ip(ip: IpAddr) -> Result<IpAddr, String> {
    if ip.is_loopback() || ip.is_unspecified() {
        return Ok(ip);
    }
    let lan = match ip {
        IpAddr::V4(ip) => ip.is_private() || ip.is_link_local(),
        IpAddr::V6(ip) => {
            let prefix = ip.segments()[0];
            prefix & 0xfe00 == 0xfc00 || prefix & 0xffc0 == 0xfe80
        }
    };
    if !lan {
        return Err("监听地址必须为本机 loopback、通配地址或本机局域网 IP".into());
    }
    // Binding an ephemeral socket proves that this is an assigned local address,
    // rather than another machine on the private network. No request is sent.
    TcpListener::bind(SocketAddr::new(ip, 0))
        .map_err(|_| "局域网 IP 未分配给本机，无法作为本机服务监听地址")?;
    Ok(ip)
}

pub(crate) fn listen_ip(host: &str) -> Result<IpAddr, String> {
    if host == "localhost" {
        return Ok(IpAddr::V4(Ipv4Addr::LOCALHOST));
    }
    let ip = host
        .parse::<IpAddr>()
        .map_err(|_| "host 必须为 localhost 或本机 IP，不能包含协议、路径或端口")?;
    local_ip(ip)
}

fn management_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(ip) if ip.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(ip) if ip.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
        _ => ip,
    }
}

pub(crate) fn management_host(url: &url::Url) -> Result<IpAddr, String> {
    let ip = match url.host() {
        Some(url::Host::Ipv4(ip)) => IpAddr::V4(ip),
        Some(url::Host::Ipv6(ip)) => IpAddr::V6(ip),
        Some(url::Host::Domain("localhost")) => IpAddr::V4(Ipv4Addr::LOCALHOST),
        _ => return Err("只允许连接本机 loopback 或本机局域网 IP 的 Strata 服务".into()),
    };
    if ip.is_unspecified() {
        return Err("服务管理地址不能是通配地址，请使用本机 loopback 或局域网 IP".into());
    }
    local_ip(ip)
}

pub fn validate_config(config: &Value) -> Result<(), String> {
    if let Some(host) = config.get("host") {
        listen_ip(host.as_str().ok_or("host 必须是字符串")?)?;
    }
    if let Some(port) = config.get("port") {
        if !port
            .as_u64()
            .is_some_and(|port| (1..=65535).contains(&port))
        {
            return Err("port 必须为 1–65535 的整数".into());
        }
    }
    Ok(())
}

pub(crate) fn endpoint(
    config: &Value,
    fallback: &ServiceProfile,
) -> Result<ListenEndpoint, String> {
    validate_config(config)?;
    let url = crate::http::endpoint(fallback, "/health")?;
    let ip = match config.get("host") {
        Some(host) => listen_ip(host.as_str().ok_or("host 必须是字符串")?)?,
        None => management_host(&url)?,
    };
    let port = config
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .or_else(|| url.port_or_known_default())
        .filter(|port| *port != 0)
        .ok_or("服务端口必须为 1–65535")?;
    let address = SocketAddr::new(management_ip(ip), port);
    Ok(ListenEndpoint {
        host: ip.to_string(),
        port,
        address,
        listen_address: SocketAddr::new(ip, port),
        base_url: format!("http://{address}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::net::TcpStream;
    use std::time::Duration;

    fn per_interface_listener() -> TcpListener {
        let networks = sysinfo::Networks::new_with_refreshed_list();
        let mut candidates = networks
            .values()
            .flat_map(|network| network.ip_networks())
            .filter_map(|network| match network.addr {
                IpAddr::V4(ip) if ip.is_private() && !ip.is_loopback() => Some(ip),
                _ => None,
            })
            .collect::<Vec<_>>();
        candidates.push(Ipv4Addr::new(127, 0, 0, 2));
        candidates
            .into_iter()
            .find_map(|ip| TcpListener::bind((ip, 0)).ok())
            .expect("test needs an assigned non-127.0.0.1 interface or loopback alias")
    }

    #[test]
    fn actual_bind_catches_per_interface_conflict_that_loopback_probe_misses() {
        let foreign = per_interface_listener();
        let address = foreign.local_addr().unwrap();
        let loopback = SocketAddr::from((Ipv4Addr::LOCALHOST, address.port()));
        assert!(TcpStream::connect_timeout(&loopback, Duration::from_millis(100)).is_err());
        assert!(assert_bind_available(address).is_err());
        assert!(
            assert_bind_available(SocketAddr::from((Ipv4Addr::UNSPECIFIED, address.port())))
                .is_err()
        );

        let owned = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let owned_address = owned.local_addr().unwrap();
        assert!(assert_replacement_bind_available(address, owned_address).is_err());
        assert!(assert_replacement_bind_available(
            SocketAddr::from((Ipv4Addr::UNSPECIFIED, address.port())),
            owned_address
        )
        .is_err());
        assert!(TcpStream::connect(owned_address).is_ok());
    }

    #[test]
    fn exact_wildcard_restart_and_same_port_narrowing_preserve_valid_restarts() {
        let owned = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).unwrap();
        let address = owned.local_addr().unwrap();
        assert!(assert_replacement_bind_available(address, address).is_ok());
        assert!(assert_replacement_bind_available(
            SocketAddr::from((Ipv4Addr::LOCALHOST, address.port())),
            address
        )
        .is_ok());
        drop(owned);
        assert!(assert_bind_available(address).is_ok());
    }

    #[test]
    fn same_port_expansion_requires_a_platform_ownership_proof() {
        let owned = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = owned.local_addr().unwrap();
        let target = SocketAddr::from((Ipv4Addr::UNSPECIFIED, address.port()));
        let result = assert_replacement_bind_available(target, address);
        #[cfg(not(windows))]
        assert!(result.unwrap_err().contains("先停止模型服务"));
        #[cfg(windows)]
        assert!(result.is_ok()); // Caller validates the complete Windows PID table.
        assert!(TcpStream::connect(address).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn reusable_bind_allows_retired_connection_time_wait() {
        use std::io::Read;
        let owned = bind_listener(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).unwrap();
        let address = owned.local_addr().unwrap();
        let mut client = TcpStream::connect(address).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let (server, _) = owned.accept().unwrap();
        drop(server); // Server closes first, leaving its accepted socket in TIME_WAIT.
        assert_eq!(client.read(&mut [0; 1]).unwrap(), 0);
        drop(client);
        drop(owned);
        assert!(assert_bind_available(address).is_ok());
    }

    fn profile() -> ServiceProfile {
        ServiceProfile {
            id: "network-fixture".into(),
            name: "fixture".into(),
            base_url: "http://127.0.0.1:18081".into(),
            install_dir: String::new(),
            python_path: String::new(),
            config_path: String::new(),
            managed: true,
        }
    }

    #[test]
    fn config_host_and_port_control_listener_and_management_endpoint() {
        for (host, expected_host, expected_url) in [
            ("127.0.0.1", "127.0.0.1", "http://127.0.0.1:23456"),
            ("localhost", "127.0.0.1", "http://127.0.0.1:23456"),
            ("0.0.0.0", "0.0.0.0", "http://127.0.0.1:23456"),
            ("::", "::", "http://[::1]:23456"),
        ] {
            let endpoint = endpoint(&json!({"host":host,"port":23456}), &profile()).unwrap();
            assert_eq!(endpoint.host, expected_host);
            assert_eq!(endpoint.base_url, expected_url);
            assert_eq!(endpoint.address.port(), 23456);
        }
        assert_eq!(endpoint(&json!({}), &profile()).unwrap().port, 18081);
    }

    #[test]
    fn rejects_nonlocal_hosts_and_invalid_ports() {
        for host in [
            "example.com",
            "8.8.8.8",
            "192.0.2.1",
            "224.0.0.1",
            "255.255.255.255",
            "http://127.0.0.1",
            "127.0.0.1:8080",
            "",
            " ::",
        ] {
            assert!(validate_config(&json!({"host":host})).is_err(), "{host}");
        }
        for port in [
            json!(0),
            json!(65536),
            json!(-1),
            json!(1.5),
            json!("8080"),
            json!(null),
        ] {
            assert!(validate_config(&json!({"port":port})).is_err());
        }
        for port in [1, 65535] {
            assert!(validate_config(&json!({"port":port})).is_ok());
        }
        let unassigned: IpAddr = "10.254.253.252".parse().unwrap();
        if TcpListener::bind((unassigned, 0)).is_err() {
            assert!(listen_ip("10.254.253.252").is_err());
            assert!(
                management_host(&url::Url::parse("http://10.254.253.252:23456").unwrap()).is_err()
            );
        }
        assert!(management_host(&url::Url::parse("http://0.0.0.0:23456").unwrap()).is_err());
    }
}
