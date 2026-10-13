# 未发布桌面监控预览 / Unreleased monitor preview

来源提交：`74ef98d0523382c4439bf167154b7a17f5c945a1`。截图来自真实 React 组件与隔离 Vite 夹具；数值为示例，不是实测性能。

- `floating.zh.webp`：中文深色双行浮条，生成绿色、读取蓝色。
- `floating.en.webp`：英文浅色双行浮条。
- `settings.zh.webp` / `settings.en.webp`：完整桌面监控配置卡，示例曲线、指标选择与排序、字号和布局。卡片由浏览器直接裁取，未重绘内容。
- PNG 到 WebP 仅无损编码转换，逐像素校验一致。大小和 SHA-256 见 `manifest.json`。
- 浏览器浮条截图有效视口为 588×160；原生窗口请求默认 588×152 逻辑像素。主配置卡裁图为 1154×1240。

模式切换在浏览器中使用模拟原生命令；没有附着真实任务栏、启动模型或操作已安装应用。这些截图不能证明任务栏自动隐藏、Explorer 重启或多屏/DPI 已通过。任务栏代码仍属实验适配，未包含在 0.1.7 安装包。

Captured from production React components with synthetic native IO. The taskbar switch tests UI behavior only; no real Explorer/taskbar attachment is pictured or certified. Windows compatibility remains a separate acceptance gate. Images are lossless conversions of browser captures and are not part of the 0.1.7 release.
