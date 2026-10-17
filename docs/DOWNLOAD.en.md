# Download and try

[Documentation](README.en.md) · [User guide](USER_GUIDE.en.md) · [Changelog](../CHANGELOG.md) · [Website changelog](https://strata-manager.cosfoc.com/docs/changelog.en) · [简体中文](DOWNLOAD.md)

Strata Manager is a desktop workspace for the Strata runtime and local model services. The desktop package contains the app and its independent background process. The Strata runtime and model weights are prepared separately.

## Download a published stable release

Choose a package from the [latest stable release](https://github.com/hongfaqiu/strata-manager/releases/latest) or the [website download section](https://strata-manager.cosfoc.com/en/#get-started). The exact public stable version is shown there. Install only files listed for the selected release and check its notes for included capabilities. You can also [try source](#try-source).

The README, website screenshots and user guide describe the current source. Installer features depend on the selected version. The [changelog](../CHANGELOG.md) distinguishes released versions from unreleased development. CI coverage is described below; completed publication is established by that version’s workflow and asset verification.

| Platform | Package | Scope |
| --- | --- | --- |
| Windows x64 | [NSIS installer (.exe)](https://github.com/hongfaqiu/strata-manager/releases/latest) | Requires WebView2; installation steps below. |
| Linux x64 | [AppImage / DEB](https://strata-manager.cosfoc.com/en/#get-started) | Built in Ubuntu 22.04 CI; system installation and GPU scope below. |

Download `SHA256SUMS` for the same version from the [selected stable release](https://github.com/hongfaqiu/strata-manager/releases/latest) and compare your file's SHA256 with its matching filename before installing. Update signature files are for updater verification; use the `.exe`, `.AppImage` or `.deb` for initial installation.

Models, image input and API protocols depend on your Strata runtime. Check hardware, drivers, RAM, VRAM and disk requirements before preparing weights. Supported existing weights do not need downloading again.

## Install on Windows

1. Download the Windows x64 NSIS installer from the [latest stable release](https://github.com/hongfaqiu/strata-manager/releases/latest) or the [website download section](https://strata-manager.cosfoc.com/en/#get-started). Its filename ends in `_x64-setup.exe`.
2. Confirm the version and source, then run the installer and follow its wizard. Windows requires WebView2; follow installer or system instructions if it is missing.
3. Open Strata Manager from the Start menu or the installer completion screen.
4. Follow the package release notes. The app first checks or prepares the runtime in Strata, then follows the [user guide](USER_GUIDE.en.md#prepare-or-reuse-a-model) to choose or prepare a model. Installing the desktop app does not automatically download weights.
5. To uninstall, choose **Stop services and quit** from the tray first, then uninstall through Windows **Installed apps**.

The project currently has no Windows Authenticode publisher certificate. Windows may show an unknown publisher or SmartScreen prompt. Confirm that the file comes from this project's versioned release page; Tauri update signatures do not establish a trusted Windows publisher.

## Install on Linux

### AppImage

1. Download the Linux x64 `.AppImage` file from the [latest stable release](https://github.com/hongfaqiu/strata-manager/releases/latest) or the [website download section](https://strata-manager.cosfoc.com/en/#get-started).
2. Allow execution in its file properties, or use `chmod +x` followed by the actual downloaded filename in your download directory.
3. Run the AppImage. Follow your distribution's instructions if FUSE or system dependencies are missing.
4. Follow the package release notes. On first use, check Strata before selecting a local model; see the [user guide](USER_GUIDE.en.md#prepare-or-reuse-a-model).

### DEB

Download the Linux x64 `.deb` file from the [latest stable release](https://github.com/hongfaqiu/strata-manager/releases/latest) or the [website download section](https://strata-manager.cosfoc.com/en/#get-started), then open it in the Ubuntu/Debian system package installer. Follow system instructions for installation and dependencies, then launch it from the application menu. Ubuntu 22.04 is the CI build environment; the DEB check covers launching its extracted contents. System-level installation, uninstall, login startup and real GPU workflows remain unverified.

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
- Current source implements global Strata management and matching Windows x64 ZIP engine updates, automatic local model listings, graphical/JSON runtime configuration, service controls, chat, persistent usage metadata and complete use-case tuning. Published packages have their own release notes; screenshot examples do not establish real-model performance.
- Stable updates use the `latest` channel; previews remain manual downloads and do not replace that channel.
- Windows CI gates cover silent installation, desktop startup, private background IPC, clean shutdown and uninstall; [VERIFICATION](VERIFICATION.md) records passing historical revisions.
- Linux CI gates cover AppImage and extracted DEB startup, private background IPC and clean shutdown in Ubuntu 22.04 with Xvfb, without claiming compatibility across all distributions.
- Complete real GPU workflows, Strata ZIP updates on a real machine, Linux system DEB installation/uninstall, login startup, Windows automatic setup without Python, and the real Tauri cross-version update download, verification, installation and service recovery require separate acceptance. Cross-version NSIS installer checks are distinct from that updater flow. ZIP engine updates require a matching official Windows x64 package; Linux retains release information but does not offer Windows ZIP updates.
- Windows installers currently have no Authenticode publisher certificate. Tauri update signatures verify update files and are separate from Windows publisher signing.

## Releases and updates

[GitHub Releases](https://github.com/hongfaqiu/strata-manager/releases) lists versioned packages and release notes. Previews, stable releases, CI artifacts and local builds are separate sources; check the version and support scope first.

Only published stable versions that pass release gates enter `latest`; download links point to the [latest stable release](https://github.com/hongfaqiu/strata-manager/releases/latest). See [CHANGELOG.md](../CHANGELOG.md) or the [website changelog](https://strata-manager.cosfoc.com/docs/changelog.en) for release history and feature changes. Previews do not replace the stable channel, and finding no beta update does not establish that the latest preview is installed.

Current source manages app updates, the Strata runtime and model weights separately. Automatic checks are enabled by default; release notes are shown and installation requires confirmation. On Windows x64, Strata selects matching ZIPs from upstream release information, downloads and extracts them, then backs up and replaces program files while retaining models. The [user guide](USER_GUIDE.en.md) explains behavior.
