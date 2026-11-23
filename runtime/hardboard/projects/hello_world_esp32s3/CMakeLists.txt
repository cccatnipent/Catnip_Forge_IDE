# The following lines of boilerplate have to be in your project's
# CMakeLists in this exact order for cmake to work correctly
cmake_minimum_required(VERSION 3.16)

if(DEFINED IDF_TARGET AND NOT IDF_TARGET STREQUAL "esp32s3")
    message(FATAL_ERROR "This project requires IDF_TARGET=esp32s3. Use a fresh build directory for ESP32-S3.")
endif()
set(IDF_TARGET "esp32s3")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(hello_world)
