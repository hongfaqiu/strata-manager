use std::{collections::HashMap, path::PathBuf, process::ExitCode};

fn run() -> Result<(), String> {
    let mut values = HashMap::new();
    let mut require_signed_version = false;
    let mut arguments = std::env::args_os().skip(1);
    while let Some(argument) = arguments.next() {
        if argument == "--require-signed-version" {
            require_signed_version = true;
            continue;
        }
        let key = argument.to_string_lossy().into_owned();
        if !["--config", "--artifact", "--signature", "--version"].contains(&key.as_str()) {
            return Err("Expected --config, --artifact, --signature and --version".into());
        }
        let value = arguments.next().ok_or("Missing argument value")?;
        if values.insert(key, value).is_some() {
            return Err("Duplicate argument".into());
        }
    }
    let required = |key: &str| {
        values
            .get(key)
            .cloned()
            .ok_or_else(|| format!("Missing {key}"))
    };
    let config = std::fs::read_to_string(PathBuf::from(required("--config")?))
        .map_err(|error| format!("Cannot read public updater configuration: {error}"))?;
    let config: serde_json::Value =
        serde_json::from_str(&config).map_err(|_| "Invalid updater configuration JSON")?;
    let public_key = config
        .pointer("/plugins/updater/pubkey")
        .and_then(serde_json::Value::as_str)
        .ok_or("Missing built-in updater public key")?;
    let signature = std::fs::read_to_string(PathBuf::from(required("--signature")?))
        .map_err(|error| format!("Cannot read update signature: {error}"))?;
    let artifact = PathBuf::from(required("--artifact")?);
    let version = required("--version")?;
    let version = version.to_str().ok_or("Invalid announced version")?;
    strata_update_verifier::verify_artifact(
        public_key,
        signature.trim_end_matches(['\r', '\n']),
        &artifact,
        version,
        require_signed_version,
    )?;
    println!("Update artifact signature and signed version verified.");
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Update verification refused: {error}");
            ExitCode::FAILURE
        }
    }
}
