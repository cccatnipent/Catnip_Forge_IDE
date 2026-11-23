# ESP32-S3 通用资料包 v1.0.0

本包说明芯片和随现有 Hardboard 提供的 ESP-IDF 5.4.3，不代表一款具体显示板。芯片、Flash 和 PSRAM 容量必须从设备实际读取；USB VID 303A/PID 1001 只证明 Espressif USB-Serial/JTAG 身份。

显示屏驱动、分辨率、SPI/RGB 接口、引脚、背光极性和面板偏移未知，manifest 的 display/pins 必须保持 null。不得从 ESP32-S3 身份推导 Waveshare、ST7789、GC9A01 等板级接线。

通过 BoardPack 加载并明确选择具体板卡包后，才能把对应资料加入任务。包是受控数据，不执行脚本或安装新工具链。确认显示板后创建独立版本化包，写明官方原始资料及实机验证状态；不要修改通用包来伪装设备已识别。
