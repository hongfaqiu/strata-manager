# 开发与构建 / Development

[中文产品介绍](../README.md) · [English README](../README.en.md) · [验收记录](VERIFICATION.md) · [发布指南](RELEASING.md)

## 环境 / Requirements

Node.js 22.13+（CI 使用 24）、项目固定的 pnpm 11、Rust stable。Windows 需要 MSVC C++ Build Tools、Windows SDK 和 WebView2；Linux 系统依赖见 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)。

## 启动与检查 / Run and check

```sh
pnpm install --frozen-lockfile
pnpm desktop       # 准备独立后台并启动 Tauri / Prepare the background and start Tauri
pnpm check         # Types, core/HTTP tests, frontend build
pnpm native:test   # Rust workspace tests
pnpm bundle        # Build a local installer; updater artifacts require signing
```

`pnpm dev` 仅运行前端；安装、进程管理和系统功能在桌面应用中执行。独立后台可用 `node scripts/prepare-sidecar.mjs --profile release` 构建。

`pnpm dev` runs the frontend only. Installation, process management and OS features require the desktop application. Build the independent background with `node scripts/prepare-sidecar.mjs --profile release`.

## 代码位置 / Source layout

| 路径 / Path | 职责 / Role |
| --- | --- |
| `apps/desktop` | React interface and Tauri shell |
| `apps/supervisor` | Independent background process |
| `crates/runtime-core` | Local runtime, preparation, analytics and tuning |
| `crates/local-ipc` | User-scoped local communication |
| `crates/update-verifier` | Verify release installer bytes against the built-in public key |
| `packages/core` | Shared types, API protocols and metrics |

`node scripts/contract-server.mjs` 启动 `http://127.0.0.1:18091` 协议夹具；没有模型推理，不是 GPU 性能证据。

`node scripts/contract-server.mjs` starts a protocol fixture at `http://127.0.0.1:18091`. It performs no model inference and is not a GPU benchmark.

## 发布 / Release

正式发布需要版本一致、实际签名密钥、两平台检查和安装包、草稿资产的真实密码学验签。不要提交私钥、用户配置、个人聊天或未经脱敏的诊断。流程与验收边界见 [RELEASING](RELEASING.md)。

Official releases require matching versions, signing configuration, both platform checks and installers, and cryptographic verification of draft assets. Keep private keys, user configuration, personal chats and unredacted diagnostics out of Git.
