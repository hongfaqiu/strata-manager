# Linux test Secret Service

`build-linux-test-keyring.sh` builds a private GNOME Keyring 40.0 daemon for Linux CI native tests and installer smoke tests. It uses the real Secret Service protocol and the unchanged Rust credential client. It never installs over the system daemon or becomes part of the application bundle.

The source is the official `gnome-keyring-40.0.tar.xz`, SHA256 `a3d24db08ee2fdf240fbbf0971a98c8ee295aa0e1a774537f4ea938038a3b931`, from <https://download.gnome.org/sources/gnome-keyring/40/>. The corresponding GNOME tag commit is `a9c867468b86719afc9fb62479dc5c48244f5926`.

The patch backports the two files and five hunks from [GNOME MR !112](https://gitlab.gnome.org/GNOME/gnome-keyring/-/merge_requests/112), fixed head `8fcdeffe67ae8c1600eae9637816acbf73f66b81`. That merge request was still open and unmerged when selected. The vendored patch is pinned by SHA256 in the build script; builds never download the mutable merge-request diff.

The change synchronously registers a missing client before accessing its PKCS#11 session or publishing its session object. Negotiation failures return a real DBus error, and failed or empty negotiation results cannot enter the generated completion routine. This prevents the observed `client` assertion followed by a null GVariant and daemon termination. The one intentional difference from the MR is retaining the original `error != NULL` check alongside `!opened`, `output == NULL` and `result == NULL`.

The daemon is built with default assertions enabled, then copied into a fresh private prefix. The wrapper accepts its absolute path through `STRATA_TEST_KEYRING_DAEMON`, creates private data/runtime/control directories and the `data/keyrings` directory, and verifies real store/read/delete plus the original daemon PID and unique DBus owner. Build, daemon or ownership failures remain failures; there are no retries against a replacement provider or skipped credential tests.

This patch repairs the CI test provider. The shipped application continues to use the user's system Secret Service; CI success does not assert that every distribution's GNOME daemon contains the upstream fix.
