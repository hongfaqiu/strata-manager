# 第三方来源

界面样式沿用 Strata 官方前端的 design tokens 与基础组件，来源为 [Niko1221/Strata](https://github.com/Niko1221/Strata)，参考版本 `fb58e0dbc8399662c0e47c76578c6e878b14f6cf`。相关源文件说明见 `apps/desktop/src/official/README.md`。

## Strata — MIT License

Copyright (c) 2026 Niko1221 and the Strata contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Outfit 字体

官方前端使用的 Outfit 字体采用 SIL Open Font License 1.1。字体文件随前端源码保存，完整许可位于 `apps/desktop/public/licenses/outfit-OFL.txt`，不会在运行时请求在线字体服务。Strata MIT 许可也包含在安装包的前端资源中。

## 官网动效 / Website animation

官网使用本地固定版本 GSAP 3.13.0 与 ScrollTrigger，文件位于 `website/vendor/`。原始版权与许可头保留在对应文件中，来源记录见 [website/vendor/README.md](website/vendor/README.md)，许可见 [GSAP Standard License](https://gsap.com/standard-license/)。

The website serves GSAP 3.13.0 and ScrollTrigger locally. Original copyright and license headers are preserved; sources are recorded in `website/vendor/README.md` under the linked GSAP Standard License.

其他 npm/Cargo 依赖的许可由相应包自身提供；此文件记录本项目直接复用的上游界面资源。
