# Catnip Forge IDE

Catnip Forge（Catnip 硬件智能开发平台）是面向 ESP32 项目的桌面开发环境。你可以在同一个窗口打开和编辑工程、让 Agent 辅助修改代码、调用 ESP-IDF 编译和烧录，以及查看串口输出。

软件定位为 Autonomous Hardware Development Agent。当前源码版本为 v2.0.0（Build 7201）。

## 下载 Windows 便携版

在 [GitHub Releases](https://github.com/cccatnipent/Catnip_Forge_IDE/releases) 下载 Windows x64 便携包。将整个 `Catnip_Forge` 文件夹解压到短、可写的路径，例如 `D:\Catnip_Forge`，然后双击 `Catnip_Forge.exe`。

便携包带有 ESP-IDF 5.4.3、编译器、Python、Node.js 和浏览器组件。在 IDE 中打开工程即可调用内置工具链。首次启动按界面配置自己的模型服务凭据。使用 ESP32-S3-WROOM-1U-N16R8 的读者，可以从 [Hello World 心跳示例](runtime/hardboard/projects/hello_world_esp32s3/README.md) 开始。使用实体板时通过 USB 连接，并在烧录前核对芯片型号和串口。

## 源码结构

| 路径 | 用途 |
| --- | --- |
| `electron/` | Electron 桌面程序和 React 界面，包含编辑器、工程选择、任务管理器和串口监视器 |
| `agent/runtime/` | Rust Agent 执行程序，通过 Rig 调用模型并处理工具请求 |
| `agent/skills/` | 本地 Skill 定义 |
| `runtime/src/` | TypeScript Runtime 和 MCP 工具，包括工程构建、烧录及串口接口 |
| `runtime/webui/`、`runtime/otto-master/` | 机器人仿真前端和控制服务 |
| `electron/radio/` | 电台相关源码和随项目保留的上游组件 |

## 在 Windows 上构建和启动

准备 Git、Node.js 22.12+、npm、Rust 1.95+ 和 Visual Studio C++ Build Tools。在源码根目录运行以下命令。

```powershell
npm.cmd --prefix agent ci --include=dev
npm.cmd --prefix runtime ci --include=dev
npm.cmd --prefix electron ci --include=dev
npm.cmd --prefix runtime/webui ci --include=dev --ignore-scripts
npm.cmd --prefix runtime run build
npm.cmd --prefix electron run desktop
```

`desktop` 会构建 Rust Agent 和仿真前端，再启动开发窗口。首次启动后可在「模型」里配置自己的模型服务。可以先打开本地工程并使用编辑器，使用 Agent 时再配置模型。

ESP32 构建需要与目标芯片匹配的 ESP-IDF 工具链。安装 ESP-IDF 后，启动 IDE 前把 `VIBEIDE_ESP_IDF_PATH` 指向 ESP-IDF 根目录、`VIBEIDE_PYTHON` 指向该工具链的 Python 解释器。若 ESP-IDF 工具不在默认目录，还可设置 `IDF_TOOLS_PATH`。把完整的 ESP-IDF 工程放在 `runtime/hardboard/projects/`，在 IDE 里选择工程，再到「任务管理器」编译和选择本机串口烧录。烧录后在「监视器」打开串口查看输出。模型服务、知乎连接、机器人仿真及电台各自依赖相应的外部组件或配置。知乎官方 Skill、语音模型和板卡资料 ZIP 需从各自来源另行取得。

从本仓库自行重新打 Windows 分发包需要准备 Node.js、Python、Playwright、ESP-IDF 等打包资源，打包入口为 `npm.cmd --prefix electron run pack:win`。

## 开发检查

```powershell
npm.cmd --prefix runtime run typecheck
npm.cmd --prefix electron run typecheck
npm.cmd --prefix electron run build:main
npm.cmd --prefix electron run build:renderer
```

部分硬件和发布回归脚本需要本机 ESP-IDF、额外板卡资料、外部服务或开发板。

## 第三方材料

随附第三方源码和资源的说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可证

Catnip Forge IDE 自有部分采用 [Apache License 2.0](LICENSE)。第三方代码、组件和素材遵循各自的许可证及随附声明。
