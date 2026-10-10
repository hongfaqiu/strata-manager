# Download and try

[Documentation](README.en.md) · [User guide](USER_GUIDE.en.md) · [简体中文](DOWNLOAD.md)

Strata Manager is a desktop app for local model management. The desktop package contains the app and its independent background process. Model weights and the Strata runtime are prepared or imported separately.

## Preview v0.1.0-beta.2

Preview **v0.1.0-beta.2** is available. Select a package for your system below and install it manually. Read the [release notes](https://github.com/hongfaqiu/strata-manager/releases/tag/v0.1.0-beta.2) or [try source](#try-source).

| Platform | Package | Scope |
| --- | --- | --- |
| Windows x64 | [NSIS installer](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.0-beta.2/Strata.Manager_0.1.0-beta.2_x64-setup.exe) | Requires WebView2; installation steps below. |
| Linux x64 | [AppImage](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.0-beta.2/Strata.Manager_0.1.0-beta.2_amd64.AppImage) / [DEB](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.0-beta.2/Strata.Manager_0.1.0-beta.2_amd64.deb) | Built in Ubuntu 22.04 CI; system installation and GPU scope below. |

[Download SHA256SUMS](https://github.com/hongfaqiu/strata-manager/releases/download/v0.1.0-beta.2/SHA256SUMS) and compare your file's SHA256 with its matching filename before installing. Update signature files are for updater verification; use the `.exe`, `.AppImage` or `.deb` above for initial installation.

Models, image input and API protocols depend on your Strata runtime. Check hardware, drivers, RAM, VRAM and disk requirements before preparing weights. A supported existing installation can be imported.

## Install on Windows

1. Download the Windows x64 NSIS installer `Strata.Manager_0.1.0-beta.2_x64-setup.exe` above.
2. Confirm the version and source, then run the installer and follow its wizard. Windows requires WebView2; follow installer or system instructions if it is missing.
3. Open Strata Manager from the Start menu or the installer completion screen.
4. Follow the [user guide](USER_GUIDE.en.md#prepare-or-reuse-a-model) to import an existing Strata installation or prepare a model. Installing the desktop app does not automatically download weights.
5. To uninstall, choose **Stop services and quit** from the tray first, then uninstall through Windows **Installed apps**.

The project currently has no Windows Authenticode publisher certificate. Windows may show an unknown publisher or SmartScreen prompt. Confirm that the file comes from this project's versioned release page; Tauri update signatures do not establish a trusted Windows publisher.

## Install on Linux

### AppImage

1. Download `Strata.Manager_0.1.0-beta.2_amd64.AppImage` above.
2. Allow execution in its file properties or run `chmod +x ./Strata.Manager_0.1.0-beta.2_amd64.AppImage` in your download directory.
3. Run the AppImage. Follow your distribution's instructions if FUSE or system dependencies are missing.
4. Follow the [user guide](USER_GUIDE.en.md#prepare-or-reuse-a-model) to import or prepare a local model.

### DEB

Download `Strata.Manager_0.1.0-beta.2_amd64.deb` above and open it in the Ubuntu/Debian system package installer. Follow system instructions for installation and dependencies, then launch it from the application menu. Ubuntu 22.04 is the CI build environment; the DEB check covers launching its extracted contents. System-level installation, uninstall, login startup and real GPU workflows remain unverified.

## Try source

Use Node.js 22.13+, the project's pinned pnpm 11 and Rust stable. Windows requires MSVC C++ Build Tools, Windows SDK and WebView2; Linux requires [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/).

~~~sh
git clone https://github.com/hongfaqiu/strata-manager.git
cd strata-manager
pnpm install --frozen-lockfile
pnpm desktop
~~~

pnpm desktop starts the complete desktop app and background process. pnpm dev runs the frontend only and does not replace installation, process management or operating-system integration.

## Support scope

- Current targets are Windows/Linux x64. Models, hardware, image input and API capabilities depend on the Strata runtime and chosen model.
- Local import and preparation, background services, Chat, metadata usage statistics, bounded tuning and update controls are implemented. Screenshot examples do not establish real-model performance.
- Previews use manual download and installation and do not replace the stable `latest` automatic update channel.
- Windows package checks cover silent installation, desktop startup, private background IPC, clean shutdown and uninstall.
- Linux package checks cover AppImage and extracted DEB startup, private background IPC and clean shutdown in Ubuntu 22.04 with Xvfb.
- Complete real GPU workflows, Linux system DEB installation/uninstall, login startup, Windows automatic setup without Python, and cross-version installation updates remain unverified.
- Windows installers currently have no Authenticode publisher certificate. Tauri update signatures verify update files and are separate from Windows publisher signing.

## Releases and updates

[GitHub Releases](https://github.com/hongfaqiu/strata-manager/releases) lists versioned packages and release notes. Previews, stable releases, CI artifacts and local builds are separate sources; check the version and support scope first.

v0.1.0-beta.2 is a preview for manual download and installation from its release page; it is not pushed through the stable `latest` channel. Update checks in Settings use the stable update source. Failing to find a beta update does not prove that the latest preview is installed.

App updates, the Strata runtime and model weights are managed separately. Automatic checking/downloading is not installation. Runtime updates use a reviewed fixed candidate, not upstream latest automatically. The [user guide](USER_GUIDE.en.md) explains behavior.
