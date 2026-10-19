# Strata Manager Server（无头 Web 面板）

面向 **Ubuntu Server** 等无图形环境：常驻进程 + 浏览器管理面板，启停本机 Strata 推理服务、查看状态/日志、编辑推理参数。不依赖桌面 AppImage / Xvfb。

## 快速试用

```bash
pnpm -w build
export STRATA_MANAGER_DATA_DIR=/tmp/strata-manager-server-data
export STRATA_MANAGER_WEB_ROOT="$(pwd)/apps/desktop/dist"
export STRATA_MANAGER_BIND=127.0.0.1:8787
cargo run -p strata-manager-server
```

首次启动会在终端打印 **Bearer 令牌**，并写入 `$STRATA_MANAGER_DATA_DIR/server-token`（0600）。打开 `http://127.0.0.1:8787/` 粘贴令牌，或使用 `?token=` 一次。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `STRATA_MANAGER_BIND` | `127.0.0.1:8787` | 监听地址 |
| `STRATA_MANAGER_DATA_DIR` | `~/.local/share/strata-manager-server` | 状态与令牌 |
| `STRATA_MANAGER_WEB_ROOT` | （占位页） | `apps/desktop/dist` |
| `STRATA_MANAGER_TOKEN` | （读文件） | 覆盖 token 文件 |

## API

- `GET /api/v1/health` — 公开
- `POST /api/v1/rpc` — Bearer 鉴权，方法对齐桌面 invoke / `dispatch`
- `WS /api/v1/events` — 状态推送

## 打包

`packaging/systemd/strata-manager-server.service`，`scripts/package-server.sh`。

## 参数即时 vs 重启

配置页模型启动参数保存后需**重启服务**（徽章「保存后重启生效」）。引擎 `/settings` 即时项经 `strata_request`。
