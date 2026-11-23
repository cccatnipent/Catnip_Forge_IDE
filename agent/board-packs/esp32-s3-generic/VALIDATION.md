# 验证步骤

1. hardboard_devices_list 枚举真实端口，不能选 ACPI 或 Intel SOL 主机串口。
2. 读取芯片及 Flash 信息；确认硬件型号/屏幕官方文档与引脚。
3. 基于匹配包配置当前工程的 SDK target、显示驱动、Flash 大小和 PSRAM；不知道的字段明确保留未知。
4. 修改前创建现有 Hardboard snapshot。使用 hardboard_idf_build，依据真实 exitCode 判断 Build。
5. 仅在已获授权且端口与板卡匹配时调用 hardboard_idf_flash；不执行 erase-flash。
6. hardboard_serial_capture 或共享 serial_read/wait 获取运行日志；成功烧录不等于动画已经显示。
7. 屏幕彩虹猫须真实图像或用户观察确认。缺少该证据保留 REAL_HARDWARE_VALIDATION_PENDING。
