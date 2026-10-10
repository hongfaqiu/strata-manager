# Download and try

[Documentation](README.en.md) · [User guide](USER_GUIDE.en.md) · [简体中文](DOWNLOAD.md)

Strata Manager is a desktop app for local model management. The desktop package contains the app and its independent background process. Model weights and the Strata runtime are prepared or imported separately.

## Choose a preview

As of 2026-10-11, the repository has no formal Release. An empty Releases list does not mean source or documentation is unavailable, and it does not provide a release installer.

| Platform | Available entry points | Scope |
| --- | --- | --- |
| Windows x64 | [Try source](#try-source); [view build progress](https://github.com/hongfaqiu/strata-manager/actions/workflows/ci.yml) | NSIS is the installer target. Only uploaded artifacts are downloadable packages. |
| Linux x64 | [Historical CI previews](#linux-preview-builds) or source | AppImage / DEB test packages, separate from a formal signed release and real GPU acceptance. |

Models, image input and API protocols depend on your Strata runtime. Check hardware, drivers, RAM, VRAM and disk requirements before preparing weights. A supported existing installation can be imported.

## Linux preview builds

The verified [historical run 38066271017](https://github.com/hongfaqiu/strata-manager/actions/runs/38066271017) belongs to commit d1e2155. Its Linux job succeeded and uploaded these artifacts; its Windows job failed, so the complete workflow was not successful:

- **ci-linux-amd64-appimage**
- **ci-linux-amd64-deb**

These previews come from an older commit and do not include all later changes. Build current source for current code. Check other runs in the [CI workflow](https://github.com/hongfaqiu/strata-manager/actions/workflows/ci.yml), confirming that the platform job succeeded and uploaded Artifacts before treating a run as a download.

### Download steps

1. Sign in to GitHub and open the run summary above.
2. Find **Artifacts** and select the required artifact name.
3. Extract the downloaded ZIP to find the AppImage or DEB package.
4. Give the AppImage executable permission before running it, or open the DEB with your system package installer. Resolve system dependencies using your distribution's instructions.
5. Follow the [user guide](USER_GUIDE.en.md#prepare-or-reuse-a-model) to import or prepare a model.

Artifact downloads require a signed-in account with repository read access, and artifacts can expire. See [GitHub's download instructions](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts). If Artifacts is missing, check sign-in, run completion, the platform job and retention; a run with no uploaded files is not a package download.

## Try source

Use Node.js 22.13+, the project's pinned pnpm 11 and Rust stable. Windows requires MSVC C++ Build Tools, Windows SDK and WebView2; Linux requires [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/).

~~~sh
git clone https://github.com/hongfaqiu/strata-manager.git
cd strata-manager
pnpm install --frozen-lockfile
pnpm desktop
~~~

pnpm desktop starts the complete desktop app and background process. pnpm dev runs the frontend only and does not replace installation, process management or operating-system integration. See [development instructions](DEVELOPMENT.md) for builds and checks.

## Releases and updates

A formal version will list its packages and release notes on [GitHub Releases](https://github.com/hongfaqiu/strata-manager/releases). Formal releases, CI previews and local builds are separate sources; check the version and verified scope first.

App updates, the Strata runtime and model weights are managed separately. Automatic checking/downloading is not installation. Runtime updates use a reviewed fixed candidate, not upstream latest automatically. The [user guide](USER_GUIDE.en.md) explains behavior; the [verification record](VERIFICATION.md) maintains detailed evidence in Chinese.
