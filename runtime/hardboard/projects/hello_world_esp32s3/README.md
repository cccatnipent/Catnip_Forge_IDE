# ESP32-S3 Hello World

本示例用于 ESP32-S3-WROOM-1U-N16R8，默认 16 MB Flash，串口使用芯片原生 USB Serial/JTAG。程序启动后每秒打印一次心跳。它使用内部 RAM。

1. 用支持数据传输的 USB 线连接开发板的原生 USB 接口。
2. 在 Catnip Forge 选择 `hello_world_esp32s3`。在「任务管理器」编译，再选择实际串口，使用「当前工程构建」烧录。
3. 在「监视器」选择同一串口，以 115200、8 数据位、1 停止位、无校验打开。若窗口保留了上次的输出，先清空接收区，再观察新行。

```text
Hello world! heartbeat=0, free_heap=... bytes
Hello world! heartbeat=1, free_heap=... bytes
```

计数持续增加表示程序在运行。堆内存数值随编译选项和设备状态变化。通过板载 USB 转串口芯片接入的板卡，需要按其硬件配置选择 UART 控制台。Flash 容量不同的板卡，先调整 ESP-IDF 配置再编译。
