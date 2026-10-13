# 未发布浮条密度与配色预览 / Unreleased monitor density and colors

本目录记录 2026-10-14 工作区增量。界面来自真实 React 组件与隔离浏览器夹具，数值和折线为示例数据，不是实测性能；尚未包含在 0.1.7 安装包中。

| 文件 | 内容 |
| --- | --- |
| `compact.zh.png` | 中文深色：紧凑浮条与精简自定义设置。 |
| `two-row.zh.png` | 中文深色：双行浮条与逐项颜色设置。 |
| `compact.en.png` | 英文浅色：紧凑浮条与精简自定义设置。 |
| `two-row.en.png` | 英文浅色：双行浮条与逐项颜色设置。 |
| `settings.zh.png` | 中文深色：最终精简文案的完整桌面监控设置。 |

当前预设示例的浮条逻辑尺寸为：紧凑 180×40、隐藏标签后 180×28、双行 244×120。完整截图还包含配置界面，因此图片像素尺寸不等于浮条逻辑尺寸；其它指标、布局和字号可产生不同尺寸。

以上截图均已落盘。已完成的隔离浏览器检查包括：中文深色、英文浅色、列宽与无溢出、颜色修改／恢复、8px／36px 字号。最终完整设置文案见 `settings.zh.png`：移除逐项重复颜色说明与开关下方说明，统一保留一处主题说明；非法颜色仍显示错误，恢复默认后清除错误状态。

常驻任务栏切换已移除，旧偏好迁回桌面浮条。本目录不展示任务栏嵌入，也不证明真实 Windows 拖拽、吸边、模型采样或安装包兼容性。原生任务栏探针仅保留在内部验收记录中。

These captures have been saved from real React components with isolated example data. They cover compact and two-row layouts and metric colors in Chinese/dark and English/light themes. The final concise settings copy is recorded in `settings.zh.png`. Screenshot pixel dimensions include the settings panel and differ from the monitor's logical dimensions. The taskbar switch has been removed. These images do not certify native dragging, edge snapping, real model telemetry or installer behavior.
