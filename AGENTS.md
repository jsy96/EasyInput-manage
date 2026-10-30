# 项目协作与文件存放规则

本文件适用于整个仓库，是目录归属的统一约定。当前项目为浏览器 PWA，开发板固件在同一仓库维护。

## 用户要求

1.所有需要生成和修改的操作，先和我确认方案，我确认后再执行消耗。
2.如果在安装或效果核验方面遇到问题，可以给出我方案或让我进行人工核验效果，不要陷入反复循环工作状态，避免Token无效

只读检查可先进行。确认方案时列明需要新增、移动、修改或清理的文件及目的；已确认范围内连续执行，扩大范围或调整目录约定时再次确认。

## 文件归属

| 位置 | 存放内容 |
| --- | --- |
| 根目录 | `README.md`、`AGENTS.md`、`index.html`、`package.json`、`package-lock.json`、`tsconfig.json`、`vite.config.ts`、`.gitignore` 等项目入口和配置 |
| `docs/` | 协议、使用说明、开发说明等专题文档；当前协议为 `docs/PROTOCOL.md` |
| `src/renderer/src/` | React 页面、入口、样式和浏览器类型声明 |
| `src/renderer/src/services/` | 浏览器设备 API 的调用与连接生命周期管理，例如蓝牙通信 |
| `src/shared/` | 不依赖 React、DOM 或浏览器设备 API 的通用协议、解析和连接状态逻辑 |
| 对应源码同目录 | 自动化测试，命名为 `<源码名>.test.ts` 或 `<源码名>.test.tsx` |
| `public/` | 应用图标等直接发布的静态资源 |
| `firmware/easyinput-monitor/` | ESP-IDF 固件工程；业务源码放在 `main/`，构建配置、分区表和 `sdkconfig.defaults` 留在工程根目录 |
| `cloudflare/` | 网站发布配置、云端网关与共享语音群服务；测试放对应源码同目录 |
| `agent/` | 历史局域网 Agent，仅保留兼容用途 |
| `scripts/` | 构建、固件导出等项目辅助脚本 |
| `dist/` | 网页构建产物，由网页构建工具生成，构建时可能清空 |
| `release/firmware/<版本>-v2-monitor/` | 新导出的版本固件包，每包包含 `firmware.json`、bootloader、分区表和应用镜像 |
| `firmware/easyinput-monitor/build/` | ESP-IDF 生成的中间文件、日志和原始构建镜像 |
| `node_modules/` | 包管理器安装的网页依赖 |

## 执行规则

- 新建文件前先按上表选择目录。现有分类无法容纳时，先说明用途并确认位置，不能随手增加根目录文件夹。
- 根目录只保留项目入口、概览和配置。专题文档放入 `docs/`；在 `README.md` 中提供必要入口，目录规则集中维护于本文件。
- 移动源码或文档时同步修改导入、链接、脚本和命令示例。目录整理只修改路径及必要引用，业务改动另列方案。
- 更新功能时，同步更新网页可见说明、状态提示、按键文案和相关文档，确保页面文字与实际功能一致；历史发布和验收记录保留原版本事实，不套用为本轮结果。
- 固件包统一放在 `release/firmware/`，不得放进 `dist/`、`public/` 或源码目录。默认通过 `scripts/export-firmware.py --version <版本>` 导出；自定义导出位置需在确认方案中说明。
- 历史固件按原版本目录保留，包括已有的 `release/firmware/0.1.1-wifi-fix/`。清理或覆盖历史版本须先说明并确认。
- `dist/`、`release/`、固件 `build/`、生成的 `sdkconfig`、`managed_components/` 和 `node_modules/` 不提交 Git。固件配置以 `sdkconfig.defaults` 为维护入口。
- 临时脚本、临时报告和手工备份使用系统临时目录；工具自身的中间文件放在其约定的构建目录。需要长期保留的材料按用途归入上表。
- 不恢复旧桌面运行时的 `out/`、`src/main/`、`src/preload/`。如需新增桌面程序，先确认新的项目方案。
- 清理文件时只处理已确认的目标，保护已有未提交修改；不顺手删除历史固件、源码或用户资料。
