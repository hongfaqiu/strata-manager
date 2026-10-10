//! Read-only release verification using the same library and encoding as Tauri's updater.
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use std::{fs::File, io::Read, path::Path};

const MAX_LEGACY_ARTIFACT_BYTES: u64 = 256 * 1024 * 1024;

fn decode_text(encoded: &str, label: &str) -> Result<String, String> {
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| format!("Invalid base64 {label}"))?;
    String::from_utf8(bytes).map_err(|_| format!("Invalid UTF-8 {label}"))
}

/// The outer strings are Tauri base64-encoded minisign documents. Their inner
/// key/signature records are parsed by minisign-verify, never by custom crypto.
/// Modern signatures stream; legacy signatures retain the updater's
/// `PublicKey::verify(..., true)` compatibility. Trusted version fields are read
/// only after the payload and the global signature have both been verified.
pub fn verify_artifact(
    public_key: &str,
    release_signature: &str,
    artifact: &Path,
    announced_version: &str,
    require_signed_version: bool,
) -> Result<(), String> {
    let public_key = PublicKey::decode(&decode_text(public_key, "public key")?)
        .map_err(|error| format!("Invalid minisign public key: {error}"))?;
    let signature = Signature::decode(&decode_text(release_signature, "signature")?)
        .map_err(|error| format!("Invalid minisign signature: {error}"))?;
    let mut file =
        File::open(artifact).map_err(|error| format!("Cannot open artifact: {error}"))?;
    if file
        .metadata()
        .map_err(|error| format!("Cannot inspect artifact: {error}"))?
        .len()
        == 0
    {
        return Err("The update artifact is empty".into());
    }
    match public_key.verify_stream(&signature) {
        Ok(mut verifier) => {
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let count = file
                    .read(&mut buffer)
                    .map_err(|error| format!("Cannot read artifact: {error}"))?;
                if count == 0 {
                    break;
                }
                verifier.update(&buffer[..count]);
            }
            verifier
                .finalize()
                .map_err(|error| format!("Signature verification failed: {error}"))?;
        }
        Err(minisign_verify::Error::UnsupportedLegacyMode) => {
            if file.metadata().map_err(|error| error.to_string())?.len() > MAX_LEGACY_ARTIFACT_BYTES
            {
                return Err("Legacy update artifact exceeds the 256 MiB verification limit".into());
            }
            let mut data = Vec::new();
            file.take(MAX_LEGACY_ARTIFACT_BYTES + 1)
                .read_to_end(&mut data)
                .map_err(|error| format!("Cannot read legacy artifact: {error}"))?;
            if data.len() as u64 > MAX_LEGACY_ARTIFACT_BYTES {
                return Err("Legacy update artifact exceeds the 256 MiB verification limit".into());
            }
            public_key
                .verify(&data, &signature, true)
                .map_err(|error| format!("Signature verification failed: {error}"))?;
        }
        Err(error) => return Err(format!("Signature verification failed: {error}")),
    }
    verify_signed_version(
        signature.trusted_comment(),
        announced_version,
        require_signed_version,
    )
}

fn verify_signed_version(
    trusted_comment: &str,
    announced_version: &str,
    required: bool,
) -> Result<(), String> {
    let versions: Vec<_> = trusted_comment
        .split('\t')
        .filter_map(|field| field.strip_prefix("version:"))
        .collect();
    let Some(signed) = versions.first().copied() else {
        return if required {
            Err("The signature has no signed application version".into())
        } else {
            Ok(())
        };
    };
    if required {
        if versions.len() != 1 {
            return Err("The signature must contain exactly one application version".into());
        }
        let signed = semver::Version::parse(signed.strip_prefix('v').unwrap_or(signed))
            .map_err(|_| "The signed application version must be valid SemVer")?;
        let announced = semver::Version::parse(
            announced_version
                .strip_prefix('v')
                .unwrap_or(announced_version),
        )
        .map_err(|_| "The announced application version must be valid SemVer")?;
        return if signed == announced {
            Ok(())
        } else {
            Err("The signed application version does not match latest.json".into())
        };
    }
    let matches = match (
        semver::Version::parse(signed.trim_start_matches('v')),
        semver::Version::parse(announced_version.trim_start_matches('v')),
    ) {
        (Ok(signed), Ok(announced)) => signed == announced,
        _ => signed == announced_version,
    };
    if matches {
        Ok(())
    } else {
        Err("The signed application version does not match latest.json".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUBLIC: &str = include_str!("../tests/fixtures/public.txt");
    const WRONG_PUBLIC: &str = include_str!("../tests/fixtures/wrong-public.txt");
    const SIGNATURE: &str = include_str!("../tests/fixtures/artifact.sig");
    const PAYLOAD: &[u8] = include_bytes!("../tests/fixtures/artifact.bin");

    fn verify(public: &str, signature: &str, payload: &[u8]) -> Result<(), String> {
        let directory = tempfile::tempdir().unwrap();
        let artifact = directory.path().join("artifact");
        std::fs::write(&artifact, payload).unwrap();
        verify_artifact(public, signature, &artifact, "0.1.0", true)
    }

    #[test]
    fn tauri_double_encoded_signed_fixture_verifies() {
        verify(PUBLIC, SIGNATURE, PAYLOAD).unwrap();
    }

    #[test]
    fn wrong_public_key_and_tampered_payload_fail() {
        assert!(verify(WRONG_PUBLIC, SIGNATURE, PAYLOAD).is_err());
        assert!(verify(PUBLIC, SIGNATURE, b"tampered installer").is_err());
        assert!(verify(PUBLIC, SIGNATURE, b"").is_err());
    }

    #[test]
    fn empty_fake_or_unwrapped_signature_fails() {
        for signature in [
            "",
            "x",
            "not base64",
            "eHh4eHg=",
            &decode_text(SIGNATURE, "fixture").unwrap(),
        ] {
            assert!(verify(PUBLIC, signature, PAYLOAD).is_err());
        }
        let decoded = decode_text(SIGNATURE, "fixture").unwrap();
        let changed = decoded.replace("version:0.1.0", "version:9.9.9");
        assert!(verify(PUBLIC, &STANDARD.encode(changed), PAYLOAD).is_err());
    }

    #[test]
    fn signed_version_must_match_the_manifest() {
        let directory = tempfile::tempdir().unwrap();
        let artifact = directory.path().join("artifact");
        std::fs::write(&artifact, PAYLOAD).unwrap();
        assert!(verify_artifact(PUBLIC, SIGNATURE, &artifact, "0.2.0", true).is_err());
        verify_artifact(PUBLIC, SIGNATURE, &artifact, "v0.1.0", true).unwrap();
    }

    #[test]
    fn release_versions_cannot_be_duplicate_conflicting_or_invalid() {
        for comment in [
            "version:0.1.0\tversion:0.1.0",
            "version:0.1.0\tversion:9.9.9",
            "version:invalid",
            "version:vv0.1.0",
        ] {
            assert!(verify_signed_version(comment, "0.1.0", true).is_err());
        }
        verify_signed_version("version:v0.1.0", "0.1.0", true).unwrap();
    }

    #[test]
    fn updater_base64_strings_cannot_contain_whitespace() {
        assert!(verify(&format!(" {PUBLIC}"), SIGNATURE, PAYLOAD).is_err());
        assert!(verify(PUBLIC, &format!("{SIGNATURE} "), PAYLOAD).is_err());
    }

    #[test]
    fn legacy_minisign_is_compatible_but_cannot_bypass_release_version_binding() {
        // Public test vector from minisign-verify 0.2.5 (MIT); no secret key.
        let public = STANDARD.encode("untrusted comment: minisign public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n");
        let signature = STANDARD.encode("untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==\n");
        let directory = tempfile::tempdir().unwrap();
        let artifact = directory.path().join("legacy");
        std::fs::write(&artifact, b"test").unwrap();
        verify_artifact(&public, &signature, &artifact, "0.1.0", false).unwrap();
        assert!(verify_artifact(&public, &signature, &artifact, "0.1.0", true).is_err());
        File::options()
            .write(true)
            .open(&artifact)
            .unwrap()
            .set_len(MAX_LEGACY_ARTIFACT_BYTES + 1)
            .unwrap();
        assert!(
            verify_artifact(&public, &signature, &artifact, "0.1.0", false)
                .unwrap_err()
                .contains("256 MiB")
        );
    }
}
