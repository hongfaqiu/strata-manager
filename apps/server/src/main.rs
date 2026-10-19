use strata_manager_server::{bind_listener, build_router, config::ServerConfig, PRODUCT_VERSION};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse().unwrap()))
        .init();

    let config = match ServerConfig::from_env() {
        Ok(c) => c,
        Err(err) => {
            eprintln!("strata-manager-server: {err}");
            std::process::exit(2);
        }
    };

    let (listener, state, fresh_token) = match bind_listener(config.clone()).await {
        Ok(v) => v,
        Err(err) => {
            eprintln!("strata-manager-server: {err}");
            std::process::exit(1);
        }
    };

    let addr = listener
        .local_addr()
        .map(|a| a.to_string())
        .unwrap_or_else(|_| config.bind.to_string());

    println!("Strata Manager Server {PRODUCT_VERSION}");
    println!("listening on http://{addr}");
    println!("data dir: {}", config.data_dir.display());
    if let Some(web) = &config.web_root {
        println!("web root: {}", web.display());
    } else {
        println!("web root: (placeholder — set STRATA_MANAGER_WEB_ROOT to apps/desktop/dist)");
    }
    if let Some(token) = &fresh_token {
        println!();
        println!(
            "*** First-run access token (save this; also in {} ) ***",
            state.auth.token_path.display()
        );
        println!("{token}");
        println!("Authorization: Bearer {token}");
        println!();
    } else {
        println!(
            "auth token: loaded from {} (or STRATA_MANAGER_TOKEN)",
            state.auth.token_path.display()
        );
    }

    let app = build_router(state);
    if let Err(err) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        eprintln!("strata-manager-server: {err}");
        std::process::exit(1);
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut stream) = signal(SignalKind::terminate()) {
            stream.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
