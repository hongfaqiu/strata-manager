//! Exercise endpoint changes against a tiny owned HTTP fixture, without a model.
#[cfg(windows)]
use crate::*;

#[cfg(windows)]
async fn fixture_health(state: &RuntimeState, base_url: &str) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    loop {
        let last_error = match state
            .client
            .get(format!("{base_url}/health"))
            .timeout(Duration::from_millis(300))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                return response.json().await.unwrap()
            }
            Ok(response) => format!("HTTP {}", response.status()),
            Err(error) => format!("{error:?}"),
        };
        if std::time::Instant::now() >= deadline {
            for profile in state.registered_profiles().unwrap() {
                println!(
                    "fixture diagnostic {}",
                    serde_json::to_string(&read_logs(state, profile, 20).unwrap()).unwrap()
                );
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "fixture unavailable at {base_url}: {last_error}"
        );
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

#[cfg(windows)]
#[tokio::test]
async fn network_runtime_port_changes_preserve_old_owner_and_lan_listener_works() {
    let temp = tempfile::tempdir().unwrap();
    let state = RuntimeState::open(temp.path().join("state")).unwrap();
    struct Cleanup(Arc<RuntimeState>);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            self.0.cleanup();
        }
    }
    let _cleanup = Cleanup(state.clone());
    let runtime = temp.path().join("runtime");
    fs::create_dir_all(runtime.join("serve")).unwrap();
    fs::write(runtime.join("setup.py"), b"").unwrap();
    fs::write(runtime.join("serve/server.py"), br#"
import argparse, json, socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socketserver import TCPServer
p=argparse.ArgumentParser()
p.add_argument('--host');p.add_argument('--port',type=int)
a,_=p.parse_known_args()
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.end_headers();self.wfile.write(json.dumps({'service':'strata','status':'ok','host':a.host,'port':a.port}).encode())
 def do_POST(self):
  self.send_response(200);self.end_headers();self.wfile.write(b'{"status":"unloaded"}')
 def log_message(self,*args): pass
class Server(ThreadingHTTPServer):
 address_family=socket.AF_INET6 if ':' in a.host else socket.AF_INET
 def server_bind(self):
  TCPServer.server_bind(self)
  self.server_name=a.host;self.server_port=a.port
Server((a.host,a.port),Handler).serve_forever()
"#).unwrap();
    let reserve = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let first_port = reserve.local_addr().unwrap().port();
    let next_reserve = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let second_port = next_reserve.local_addr().unwrap().port();
    drop(reserve);
    let config_path = runtime.join("config.json");
    let first_config = json!({"exe":"fixture.exe","args":[],"host":"127.0.0.1","port":first_port});
    fs::write(&config_path, serde_json::to_vec(&first_config).unwrap()).unwrap();
    let profile = ServiceProfile {
        id: format!("network-owned-{}", uuid::Uuid::new_v4()),
        name: "network fixture".into(),
        base_url: format!("http://127.0.0.1:{first_port}"),
        install_dir: runtime.to_string_lossy().into(),
        python_path: output("py", &["-c", "import sys;print(sys.executable)"]).unwrap(),
        config_path: config_path.to_string_lossy().into(),
        managed: true,
    };
    state.database.lock().unwrap().execute(
        "INSERT INTO local_installations(id,profile,original_profile,imported_at) VALUES(?1,?2,?2,0)",
        rusqlite::params![profile.id,serde_json::to_string(&profile).unwrap()],
    ).unwrap();
    let plan = prepare_startup(&profile, &state.processes, &state.tasks).unwrap();
    start_prepared_service(&state, profile.clone(), plan, None).unwrap();
    assert_eq!(
        fixture_health(&state, &profile.base_url).await["port"],
        first_port
    );
    // Windows can prove this same-port expansion belongs to the held Job.
    state
        .clone()
        .dispatch(
            "write_config",
            json!({"profile":profile,"config":{
                "exe":"fixture.exe","args":[],"host":"0.0.0.0","port":first_port
            }}),
        )
        .await
        .unwrap();
    restart_service(state.clone(), profile.clone())
        .await
        .unwrap();
    assert_eq!(
        fixture_health(&state, &profile.base_url).await["host"],
        "0.0.0.0"
    );
    assert_eq!(
        state.owned_listeners.lock().unwrap()[&profile.id],
        std::net::SocketAddr::from((std::net::Ipv4Addr::UNSPECIFIED, first_port))
    );
    let second_config = json!({"exe":"fixture.exe","args":[],"host":"0.0.0.0","port":second_port});
    let snapshot = storage::read_snapshot(&profile).unwrap();
    state
        .clone()
        .dispatch(
            "write_config_cas_v1",
            json!({"profile":profile,"config":second_config,"expectedRevision":snapshot.revision}),
        )
        .await
        .unwrap();
    assert_eq!(
        state.registered_profile(&profile.id).unwrap().base_url,
        profile.base_url
    );
    assert_eq!(
        state.owned_gui_profile(&profile.id).unwrap().base_url,
        profile.base_url
    );
    assert_eq!(
        fixture_health(&state, &profile.base_url).await["host"],
        "0.0.0.0"
    );
    // A conflicting new port fails before terminating the old owned service.
    assert!(restart_service(state.clone(), profile.clone())
        .await
        .is_err());
    assert_eq!(
        fixture_health(&state, &profile.base_url).await["port"],
        first_port
    );
    assert_eq!(
        state.owned_listeners.lock().unwrap()[&profile.id].port(),
        first_port
    );
    drop(next_reserve);
    restart_service(state.clone(), profile.clone())
        .await
        .unwrap();
    let second = state.registered_profile(&profile.id).unwrap();
    assert_eq!(second.base_url, format!("http://127.0.0.1:{second_port}"));
    assert_eq!(
        fixture_health(&state, &second.base_url).await["host"],
        "0.0.0.0"
    );
    assert!(std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, first_port)).is_err());
    // Stored management URL remains loopback, while the actual listen record
    // must retain the wildcard for ordinary same-port restart and narrowing.
    restart_service(state.clone(), second.clone())
        .await
        .unwrap();
    assert_eq!(
        fixture_health(&state, &second.base_url).await["host"],
        "0.0.0.0"
    );
    assert_eq!(
        state.owned_listeners.lock().unwrap()[&profile.id],
        std::net::SocketAddr::from((std::net::Ipv4Addr::UNSPECIFIED, second_port))
    );

    let networks = sysinfo::Networks::new_with_refreshed_list();
    let lan = std::env::var("STRATA_NETWORK_TEST_LAN_IP")
        .ok()
        .and_then(|ip| ip.parse::<std::net::Ipv4Addr>().ok())
        .or_else(|| {
            networks
                .values()
                .flat_map(|network| network.ip_networks())
                .find_map(|network| match network.addr {
                    std::net::IpAddr::V4(ip) if ip.is_private() && !ip.is_loopback() => Some(ip),
                    _ => None,
                })
        });
    if let Some(lan) = lan {
        println!("checking wildcard listener from local NIC {lan}:{second_port}");
        assert_eq!(
            fixture_health(&state, &format!("http://{lan}:{second_port}")).await["host"],
            "0.0.0.0"
        );
        // Narrow a wildcard to one local interface without changing its port.
        state
            .clone()
            .dispatch(
                "write_config",
                json!({"profile":profile,"config":{
                    "exe":"fixture.exe","args":[],"host":lan.to_string(),"port":second_port
                }}),
            )
            .await
            .unwrap();
        restart_service(state.clone(), second.clone())
            .await
            .unwrap();
        let narrowed = state.registered_profile(&profile.id).unwrap();
        assert_eq!(
            fixture_health(&state, &narrowed.base_url).await["host"],
            lan.to_string()
        );
        assert!(
            std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, second_port)).is_err()
        );

        let reservation = std::net::TcpListener::bind((lan, 0)).unwrap();
        let third_port = reservation.local_addr().unwrap().port();
        // This listener is invisible at the wildcard's management URL. Both
        // wildcard and exact-interface replacements must preserve the old PID.
        assert!(std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, third_port)).is_err());
        for host in ["0.0.0.0".to_string(), lan.to_string()] {
            state
                .clone()
                .dispatch(
                    "write_config",
                    json!({"profile":profile,"config":{
                        "exe":"fixture.exe","args":[],"host":host,"port":third_port
                    }}),
                )
                .await
                .unwrap();
            let old_pid = state.processes.lock().unwrap()[&profile.id].status.pid;
            assert!(restart_service(state.clone(), narrowed.clone())
                .await
                .is_err());
            assert_eq!(
                state.processes.lock().unwrap()[&profile.id].status.pid,
                old_pid
            );
            assert_eq!(
                fixture_health(&state, &narrowed.base_url).await["port"],
                second_port
            );
            assert_eq!(
                state.owned_listeners.lock().unwrap()[&profile.id],
                std::net::SocketAddr::from((lan, second_port))
            );
        }
        let third_config =
            json!({"exe":"fixture.exe","args":[],"host":lan.to_string(),"port":third_port});
        state
            .clone()
            .dispatch(
                "write_config",
                json!({"profile":profile,"config":third_config}),
            )
            .await
            .unwrap();
        assert_eq!(
            state.registered_profile(&profile.id).unwrap().base_url,
            narrowed.base_url
        );
        drop(reservation);
        restart_service(state.clone(), second.clone())
            .await
            .unwrap();
        println!("checking specific local NIC listener {lan}:{third_port}");
        let third = state.registered_profile(&profile.id).unwrap();
        assert_eq!(third.base_url, format!("http://{lan}:{third_port}"));
        assert_eq!(
            fixture_health(&state, &third.base_url).await["host"],
            lan.to_string()
        );
        assert_eq!(
            http::desktop_request(
                &state,
                profile.clone(),
                "/health".into(),
                "GET".into(),
                None
            )
            .await
            .unwrap()["port"],
            third_port
        );
        assert!(std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, third_port)).is_err());
        assert!(
            std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, second_port)).is_err()
        );
        println!("verified owned listener: first {first_port}, wildcard {second_port}, LAN {lan}:{third_port}; retired ports closed");
    }
    let current = state.registered_profile(&profile.id).unwrap();
    let before = storage::read_snapshot(&current).unwrap();
    assert!(state
        .clone()
        .dispatch(
            "write_config",
            json!({"profile":profile,"config":{"host":"10.254.253.252","port":23456}})
        )
        .await
        .is_err());
    assert_eq!(
        storage::read_snapshot(&current).unwrap().revision,
        before.revision
    );
    stop_service(&state, profile.id.clone()).await.unwrap();
    assert!(!state
        .owned_listeners
        .lock()
        .unwrap()
        .contains_key(&profile.id));
    state.clone().dispatch("write_config",json!({"profile":profile,"config":{"exe":"fixture.exe","args":[],"host":"127.0.0.1","port":23456}})).await.unwrap();
    assert_eq!(
        state.registered_profile(&profile.id).unwrap().base_url,
        "http://127.0.0.1:23456"
    );
    assert!(
        !state
            .processes
            .lock()
            .unwrap()
            .get_mut(&profile.id)
            .unwrap()
            .refresh()
            .unwrap()
            .running
    );
}
