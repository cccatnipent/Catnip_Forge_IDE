# Otto Robot ST7789 BoardPack v1.0.0

本包是独立的 Otto Robot 基础/无摄像头版本资料包，不修改 `esp32-s3-generic`。

## 已确认的候选配置

| 项目 | 配置 |
| --- | --- |
| 芯片 | ESP32-S3；COM10 实测 USB VID/PID `303A:1001`；v0.2；16 MB Flash；8 MB PSRAM |
| 屏幕 | ST7789，240 × 240，串行 SPI |
| SPI | SPI3/FSPI host；mode 3；40 MHz；RGB565；RGB；颜色反转 |
| LCD MOSI/SDA | GPIO10 |
| LCD SCLK/SCL | GPIO9 |
| LCD D/C | GPIO46 |
| LCD RESET/RES | GPIO11 |
| LCD CS | GPIO12 |
| LCD 背光 LEDK/BL | GPIO3，高电平有效；`DISPLAY_BACKLIGHT_OUTPUT_INVERT=false` |
| 显示方向/偏移 | 不镜像、不交换 XY；offset X/Y = 0/0 |
| Boot 按键 | GPIO0 |

上表由用户提供的 `otto机器人原理图.pdf` 与官方 `txp666/xiaozhi-esp32/main/boards/otto-robot/` 源码交叉得到。官方无摄像头配置明确给出 LCD GPIO；官方 `otto_robot.cc` 明确使用 `SPI3_HOST`、40 MHz 和 `esp_lcd_new_panel_st7789()`。

## GPIO12 说明

官方无摄像头配置同时把 GPIO12 设为 `right_hand_pin` 和 LCD CS。这是该候选板级设计的复用，不在本资料包中擅自改线或“修正”。测试工程只初始化 LCD，不初始化舵机、音频或摄像头，避免在显示验证阶段引入额外外设副作用。

## 资料来源

- [官方 Otto board directory](https://github.com/txp666/xiaozhi-esp32/tree/main/main/boards/otto-robot)
- [官方 `config.h`](https://github.com/txp666/xiaozhi-esp32/blob/main/main/boards/otto-robot/config.h)
- [官方 `otto_robot.cc`](https://github.com/txp666/xiaozhi-esp32/blob/main/main/boards/otto-robot/otto_robot.cc)
- [ESP32-S3 ESP-IDF 5.4.3](https://docs.espressif.com/projects/esp-idf/en/v5.4.3/esp32s3/)
- [ESP-IDF LCD API](https://docs.espressif.com/projects/esp-idf/en/v5.4.3/esp32s3/api-reference/peripherals/lcd.html)
- 验证参考了 Otto Robot 原理图。
- 测试素材：`runtime/hardboard/projects/otto_rainbow_cat/main/otto_nyan_frames.h`；来源与 MIT 许可、离线转换过程见该工程的 `ASSET_LICENSE.md`。
- 素材不是运行时 GIF 解析：8 张 240×240 截图被量化为共享 RGB565 调色板并做行优先 RLE，固件每 125 ms 解码一帧。

## 状态

`REAL_DEVICE_DISPLAY_VALIDATED`：已完成 ESP-IDF 5.4.3 编译、COM10 非 erase-flash 烧录和串口运行证据；用户确认 COM10 对应物理屏幕显示了 Nyan Cat 彩虹猫动画。准确 Otto PCB 修订版和面板供应商仍未确认。
