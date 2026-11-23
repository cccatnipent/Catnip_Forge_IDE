idf_component_register(
    SRCS "hello_world_main.c"
    PRIV_REQUIRES esp_system spi_flash freertos
    INCLUDE_DIRS "."
)
