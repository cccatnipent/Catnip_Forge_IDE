# Otto Robot ST7789：Agent 可读硬件约束

> 这是给无多模态模型使用的纯文本硬件摘要。它不是原理图的替代品；原理图只作为 `hardware/schematic/otto-robot-schematic.pdf` 的原始证据保留。任何未在本文件、`manifest.json` 或 `VALIDATION.md` 中确认的参数都必须视为未知，不得猜测。

## 已确认的目标与工具链

- BoardPack ID：`otto-robot-st7789`，版本 `1.0.0`。
- 芯片：`ESP32-S3`，target：`esp32s3`。
- 工具链：ESP-IDF `5.4.3`。
- 观测设备身份：Espressif USB VID/PID `303A:1001`，芯片 revision `v0.2`，Flash `16MB`，PSRAM `8MB`。
- `COM10` 只是当前主机本次观测到的端口名，不是板卡永久属性；`COM7` 是 Intel AMT SOL，不能当作 Otto。

## LCD 接线与显示配置

| 信号 | GPIO | 约束 |
| --- | ---: | --- |
| 背光 BL | 3 | 高电平有效 |
| MOSI / SDA | 10 | SPI 数据 |
| SCLK / SCL | 9 | SPI 时钟 |
| D/C | 46 | 命令/数据 |
| RESET / RST | 11 | 面板复位 |
| CS | 12 | LCD 片选 |

- 控制器：ST7789。
- 分辨率：`240 × 240`。
- 总线：串行 SPI，`SPI3_HOST`。
- SPI mode：`3`；pixel clock：`40MHz`。
- 像素：RGB565，线缆大端序；RGB order：RGB。
- 颜色反转：启用；mirror X/Y：关闭；swap XY：关闭；offset X/Y：`0/0`。
- 显示测试应只初始化 LCD。不要因为资料中出现其他 GPIO 就自动初始化舵机、音频、摄像头或网络。

## 复用、边界和未知项

- 上游无摄像头配置同时把 GPIO12 标为 `right_hand_pin`；本 BoardPack 将其记录为 `lcd.cs` 与上游 `right_hand_pin` 的复用。LCD-only 验证应用不得初始化舵机。
- Boot 按键为 GPIO0；无摄像头；音频候选引脚见 `manifest.json` 和 `VALIDATION.md`，不等于本轮已启用的外设。
- 先前 LCD-only 测试已在观测到的 COM10 实体上由用户确认看到彩虹猫动画，因此 BoardPack 状态为 `REAL_DEVICE_DISPLAY_VALIDATED`。这不证明准确 PCB 修订版或 LCD 面板供应商；两项仍未知。
- 串口日志、构建成功或 `RAINBOW_CAT_READY` 只能证明对应软件阶段，不自动证明屏幕可见。

## 使用顺序

1. 调用 `BoardPack({})` 枚举板卡，再调用 `BoardPack({"id":"otto-robot-st7789"})` 加载 manifest。
2. 调用 `BoardPack({"id":"otto-robot-st7789","document":"HARDWARE.md"})` 读取本文件；需要验证边界时再读取 `README.md` 与 `VALIDATION.md`。
3. 使用资料中的 `esp32s3`、ESP-IDF 5.4.3 和 LCD 参数生成工程；不要读取或复制旧 Otto 应用作为实现证据。
4. 设备操作前重新枚举串口并核对 VID/PID；没有匹配证据时保持 `REAL_HARDWARE_VALIDATION_PENDING`，不要猜接线或烧录。
5. 任何 Flash、Serial 或物理显示声明都必须引用实际 Runtime/设备证据；禁止把 PDF 是否存在、BoardPack 是否加载或模拟结果写成硬件成功。

## 来源

- 用户提供的 Otto 原理图（保留为原始 PDF 证据）。
- `upstream-reference/config.h` 与 `upstream-reference/config.json` 中的无摄像头配置。
- `VALIDATION.md` 中的本地构建、端口身份和物理观察记录。
