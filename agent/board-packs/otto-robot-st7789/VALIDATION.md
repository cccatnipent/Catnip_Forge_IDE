# Otto Robot ST7789 验证记录

## 资料验证（已完成）

- [x] 用户原理图包含 `LCD-240x240`。
- [x] 原理图文本/视觉区域包含 `LCD_BL`、`LCD_DC`、`LCD_SCL`、`LCD_SDA`、`LCD_RST`。
- [x] 官方 `config.h` 选择 `LCD_TYPE_ST7789_SERIAL`、240 × 240、RGB、颜色反转、SPI mode 3。
- [x] 官方无摄像头配置给出 GPIO3/9/10/11/12/46 LCD 接线。
- [x] 官方 `otto_robot.cc` 使用 SPI3、40 MHz、ST7789 和 offset 0/0 的候选路径。
- [x] 背光配置为 GPIO3，官方宏 `DISPLAY_BACKLIGHT_OUTPUT_INVERT=false`。
- [x] GPIO12 与官方无摄像头配置的 `right_hand_pin` 复用已记录，测试程序不会初始化舵机。
- [x] 测试素材来自 MIT 许可的 `cristurm/nyan-cat`；8 帧已离线量化为共享 24 色 RGB565 RLE，生成头文件和输入 PNG 可复现。

## COM10 设备验证（已完成）

- [x] Windows 枚举：`USB 串行设备 (COM10)`。
- [x] USB identity：Espressif `303A:1001`。
- [x] 芯片：ESP32-S3 v0.2。
- [x] Flash：16 MB。
- [x] PSRAM：8 MB。
- [x] 烧录前仅执行只读芯片/Flash 读取；随后按授权完成测试固件写入，未执行整片 `erase-flash`。

- [x] ESP-IDF 5.4.3 `set-target esp32s3` 与 `idf.py build` 成功；应用二进制 289,472 bytes。
- [x] 使用 `idf.py -p COM10 flash` 成功写入并校验 bootloader、factory app、partition table；命令未调用 `erase-flash`（写入过程仅擦除目标写入扇区）。
- [x] Flash 后通过 COM10 115200 串口读取到 `NYAN_ASSET`、`RAINBOW_CAT_READY` 和连续 `RAINBOW_CAT_ANIMATION` 心跳；该日志只证明初始化、帧提交和循环运行，不证明物理屏幕可见。
## 验证结论

- [x] 当前 COM10 实体已重新枚举为 `USB 串行设备 (COM10)`；本次没有选择 COM7 Intel AMT SOL。
- [x] 当前 BoardPack 工程已设置 `esp32s3` 并在 ESP-IDF 5.4.3 下编译成功（应用二进制 289,472 bytes）。
- [x] `idf.py -p COM10 flash` 写入并校验 bootloader、factory app、partition table；没有调用 `erase-flash`。
- [x] 真实串口运行日志包含 `NYAN_ASSET`、`RAINBOW_CAT_READY` 和连续 `RAINBOW_CAT_ANIMATION` 心跳。
- [ ] 当前 COM10 实体与官方 Otto PCB/版本的照片或丝印确认。
- [x] 用户确认 COM10 对应物理屏幕显示了 Nyan Cat 彩虹猫动画；该观察与串口、构建、烧录证据共同完成本次显示验证。

`RAINBOW_CAT_READY` 只表示 LCD 初始化和 framebuffer 提交完成；物理可见性由用户观察单独确认。当前状态：`REAL_DEVICE_DISPLAY_VALIDATED`。

当前状态：`REAL_DEVICE_DISPLAY_VALIDATED`。
