Catnip Forge v2.0.0（Build 7201）Windows x64 便携版
中文全称：Catnip 硬件智能开发平台
英文定位：Autonomous Hardware Development Agent

使用方法：
1. 必须完整解压整个 Catnip_Forge 文件夹，不要只复制 exe，也不要直接在压缩包内运行。
2. 建议解压到路径较短的用户可写目录，例如 D:\Catnip_Forge；不要放进需要管理员权限的 Program Files。
3. 双击“Catnip_Forge.exe”。
4. 首次启动会打开原生安全窗口，填写 DeepSeek API Key；Qwen API Key 可选。保存后软件会自动重启，重新打开后再选择或创建当前工程。
5. 不要把 Key 写入安装包、`resources\`、日志、聊天内容或工程文件。模型凭据由应用使用 Windows 安全存储维护。

运行要求：
- Windows 10/11 x64。
- 使用 Agent 时需要能够访问 DeepSeek API 的网络。
- 串口功能需要开发板驱动，并确保端口没有被其他串口软件占用。
- 请始终保留 exe、resources、locales 和 DLL 文件的相对目录结构。

安全说明：
- 发布包不包含开发者或其他用户的真实 API Key。
- 应用配置的模型凭据保存在当前 Windows 用户数据目录，由 Electron safeStorage 加密。
- 转发或重新压缩前，请确认包目录没有用户数据、日志、`.catnip`、电台数据库或其他运行态文件；需要重新生成时遵循仓库的 Windows 打包规则。

版本说明：
- 对外发布版本：v2.0.0
- 内部构建号：7201
- Windows 文件版本：2.0.0.7201
