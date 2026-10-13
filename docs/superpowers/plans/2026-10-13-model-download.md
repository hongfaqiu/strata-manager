# 模型下载工作区实施计划

> 按用户已批准的 `output/design/model-download-v1/model-download-v1.png` 与设计说明执行；采用 subagent-driven-development 并行完成独立模块，主会话集成与验收。

**目标：**在现有产品中实现模型列表与版本详情、统一下载及 GPU 默认设置、清晰的资源和准备操作。

**架构：**抽出 `ModelDownloadPage`，保留原生 `runSetup`、磁盘预检和资源评估；`ModelDownloadDefaults` 通过已有 JSON store 持久化，提交时创建独立任务参数快照。配置只影响新建任务。任务跳转复用现有任务与日志。

**技术：**React 19、TypeScript、TanStack Query、现有 OfficialControls/Lucide 与 Strata 样式变量。

- [x] core 公共配置：新增 `model-download.ts` 与行为测试，接口 `ModelDownloadDefaults {schemaVersion:1; options:OfficialSetupOptions; runtime:ServiceProfile|null}`；无效存储报错，`snapshotModelDownloadRequest(profile,selection,options)` 校验并复制本次参数。运行 `pnpm --filter @strata-manager/core exec vitest run tests/model-download.test.ts`。
- [x] 资源面板：添加可选 `compact` 与磁盘状态输入，复用同一查询与历史匹配；初始展示三项摘要，展开保留现有详细证据。运行原有 ResourceAssessmentPanel 测试并补充未知/不足状态。
- [x] 下载工作区：新增 `ModelDownloadPage.tsx`、`ModelDownloadSettingsDialog.tsx`、`model-download.css`。使用模型搜索、可选行、量化单选表、每模型独立草稿、折叠启动预设和固定下载动作。公共配置显式保存，关闭和窗口退出接入现有草稿保护；目录选择在保存前保持草稿状态。保留已有模型检查/导入到折叠辅助入口。
- [x] App 集成：替换原 ModelsPage/ModelCard，继续调用 `runRecipe({kind:'setup',...snapshot})`，保留任务配方用于重试；公共默认配置不改变已有配方。仅修改下载相关分支及草稿保护注册。
- [x] 验证：检查类型、相关 core/组件测试、前端生产构建；使用当前 Vite 隔离浏览器验证保存/取消/重载、切模型保留量化、参数快照、磁盘阻止、无搜索结果、中英明暗、窄窗与键盘。模拟原生 IO 不可落入真实模型请求。截图和设计稿以相同视口目视比较，记录 design-qa。
- [x] 交接：更新 `.local/model-download-redesign-status.json` 为 ready，由新会话 `01a13461-9996-7551-8cb7-010156d213d9` 作为唯一提交者分批提交，并更新 README/Changelog/官网；本会话不暂存或提交。

本次不新增运行时生命周期操作、不迁移既有模型目录；原生接口决定实际目录。验收截图的硬件和模型服务来自隔离样例，真实 GPU/局域网验收另行记录。
