# 安装与系统语言功能验收（2026-10-14）

已合入当前工作区，属于尚未发布的源码改动。AppImage PR 的英文回复已发布：[AppImage/appimage.github.io #10150](https://github.com/AppImage/appimage.github.io/pull/10150#issuecomment-6152206833)，附两张公开英文界面截图。

## 行为

- Windows NSIS 安装器提供十种语言，按 Windows UI 语言匹配，未支持的语言回退英文；自动更新、被动和静默模式不弹语言选择框。
- 应用首次启动提供语言选择，AppImage/DEB 也可使用。默认跟随电脑语言；安装器选了不同于系统默认的语言时，新用户会继承选择。
- 旧用户保存的中英文选择保持有效；设置中可选择任意语言，或恢复“跟随系统语言”。选择在本机保存。
- 支持英文、简体中文、繁体中文、日语、韩语、德语、法语、西班牙语、葡萄牙语和俄语。八个新增语言包各覆盖现有 677 条公共界面文案，另有首次启动及语言偏好的译文。
- 未接入 i18next 的高级工具使用英文回退；服务输出、用户内容和原始日志保留原语言。

## 验证

| 检查 | 结果 |
| --- | --- |
| 前端和核心测试 | 589 项通过（434 Vitest + 132 desktop Node + 23 scripts Node） |
| 浏览器验收 | 18/18 通过，涵盖十种语言、未知语言、手动设置、重启持久化、存量迁移、安装器选择与跟随系统、主要页面 |
| 前端生产构建 | 成功，包含 TypeScript 检查；保留现有大 chunk 提示 |
| 主工作区 Cargo check | 成功 |
| 原生定向测试 | system_locale 7、monitor_tray 7、taskbar_monitor 37、invoke_policy 2，共 53 项通过 |
| NSIS 语言测试 | 2/2 通过；实际编译并运行微型安装器和卸载器各 /P、/UPDATE、/S 共六种模式 |
| 语言资源 | 全部键、非空值与插值占位符检查通过 |

浏览器使用真实 App 组件与生产 CSS，原生调用和存储由隔离示例数据提供；没有操作真实服务、用户存储或模型。原生语言探测实际读取了本机 Windows UI 语言。NSIS 自动模式测试使用微型测试程序，并未安装完整应用。

尚未构建或发布新的完整安装包，也未完成完整安装器的手动语言选择、Linux AppImage/DEB 实机验收或母语用户校对。

## 证据

- [浏览器结果](../../output/language-verification/results.json)
- [英文首次启动截图](../../output/language-verification/first-launch-en.png)
- [日语首次启动截图](../../output/language-verification/first-launch-ja.png)
- [法语设置页截图](../../output/language-verification/settings-fr.png)
- [前端/核心测试日志](../../.local/language-final-unit-tests.log)
- [构建日志](../../.local/language-final-build.log)
- [原生编译日志](../../.local/language-final-native-check.log)

原工作区已有修改已备份在 `.local/language-integration-backup/`；合并同时保留了后续并行编辑。共享 Cargo 缓存的陈旧元数据通过刷新源码 mtime 后重新编译解决，源码内容保持不变。没有启动模型或服务。
