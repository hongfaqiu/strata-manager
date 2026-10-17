fn main() {
    // The Arena app key is compiled in from CI (secret ARENA_APP_KEY); rebuild whenever it changes.
    println!("cargo:rerun-if-env-changed=STRATA_ARENA_APP_KEY");
    println!("cargo:rerun-if-env-changed=STRATA_ARENA_ENDPOINT");
    println!("cargo:rerun-if-env-changed=STRATA_ARENA_REQUIRE_KEY");
    // Release builds set STRATA_ARENA_REQUIRE_KEY=1 so a missing secret fails the build instead of shipping a
    // read-only leaderboard by accident.
    if std::env::var("STRATA_ARENA_REQUIRE_KEY").as_deref() == Ok("1")
        && std::env::var("STRATA_ARENA_APP_KEY").map_or(true, |key| key.len() < 32)
    {
        panic!("STRATA_ARENA_REQUIRE_KEY=1 but STRATA_ARENA_APP_KEY is missing or shorter than 32 characters");
    }
    tauri_build::build()
}
