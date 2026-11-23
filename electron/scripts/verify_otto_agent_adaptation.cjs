const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const http = require('node:http');
const { app } = require('electron');
const { once } = require('node:events');
const { createInterface } = require('node:readline');

const repoRoot = path.resolve(__dirname, '..', '..');
const kitSource = path.join(repoRoot, 'runtime', 'hardboard', 'board-adaptation-kits', 'otto-st7789-board-adaptation-kit-v1.1.0');
const workspaceSource = path.join(repoRoot, 'runtime', 'hardboard', 'workspaces', 'otto-st7789-cat-agent');
// Scripted SSE responses verify the execution pipeline; no inference model generates this implementation.
const secret = 'fixture-adaptation-token-not-real';
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'catnip-otto-adaptation-'));
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === '--evidence-dir'), 'usage: verify_otto_agent_adaptation.cjs [--evidence-dir <new-directory>]');
const exportEvidence = args.length === 2;
const artifactRoot = exportEvidence ? path.resolve(args[1]) : path.join(tempRoot, 'evidence-artifact');
const projectRoot = path.join(tempRoot, 'projects');
const sessionRoot = path.join(tempRoot, 'sessions');
const userData = path.join(tempRoot, 'user-data');
const modelRequests = [];
const toolCalls = [];
const processes = [];
let server;
let responder;
let agent;

app.setPath('userData', userData);
process.env.CATNIP_PROJECTS_ROOT = projectRoot;
process.env.CATNIP_PROJECT_SESSIONS_ROOT = sessionRoot;
process.env.CATNIP_DEEPSEEK_API_KEY_PATH = path.join(tempRoot, 'absent-key.txt');
process.env.CATNIP_QWEN_API_KEY_PATH = path.join(tempRoot, 'absent-vision.txt');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function treeHashes(root, skipProjectState = false) {
  const output = {};
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (skipProjectState && ['build', '.catnip', '.git'].includes(entry.name)) continue;
      const full = path.join(current, entry.name);
      const relative = path.relative(root, full).replaceAll(path.sep, '/');
      const stat = fs.lstatSync(full);
      assert(!stat.isSymbolicLink() && (!stat.isFile() || stat.nlink === 1), `input link refused: ${relative}`);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) output[relative] = sha256(full);
      else assert.fail(`unsupported input: ${relative}`);
    }
  }
  visit(root);
  return output;
}

function copyTree(source, target) {
  fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
}

function pngPixels(file) {
  const bytes = fs.readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const compressed = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      compressed.push(data);
    }
  }
  assert.equal(bitDepth, 8);
  assert.equal(colorType, 2);
  assert.equal(interlace, 0);
  const raw = zlib.inflateSync(Buffer.concat(compressed));
  const bytesPerPixel = 3;
  const stride = width * bytesPerPixel;
  const rows = [];
  let cursor = 0;
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor++];
    const row = Buffer.from(raw.subarray(cursor, cursor + stride));
    cursor += stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const up = previous[x];
      const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      if (filter === 1) row[x] = (row[x] + left) & 255;
      else if (filter === 2) row[x] = (row[x] + up) & 255;
      else if (filter === 3) row[x] = (row[x] + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) {
        const estimate = left + up - upperLeft;
        const pa = Math.abs(estimate - left);
        const pb = Math.abs(estimate - up);
        const pc = Math.abs(estimate - upperLeft);
        const predictor = pa <= pb && pa <= pc ? left : (pb <= pc ? up : upperLeft);
        row[x] = (row[x] + predictor) & 255;
      } else assert.equal(filter, 0);
    }
    rows.push(row);
    previous = row;
  }
  return { width, height, rows };
}

function rgb565(red, green, blue) {
  return ((red & 0xf8) << 8) | ((green & 0xfc) << 3) | (blue >> 3);
}

function createFrameHeader(assetRoot) {
  const first = pngPixels(path.join(assetRoot, 'frame-00.png'));
  assert.equal(first.width, 240);
  assert.equal(first.height, 240);
  const palette = [];
  const paletteIndex = new Map();
  function addColor(color) {
    const key = color.join(',');
    if (!paletteIndex.has(key)) {
      paletteIndex.set(key, palette.length);
      palette.push(color);
    }
    return paletteIndex.get(key);
  }
  for (const row of first.rows) {
    for (let x = 0; x < first.width; x += 1) addColor([...row.subarray(x * 3, x * 3 + 3)]);
  }
  assert.equal(palette.length, 24);
  const frames = [];
  for (let frameIndex = 0; frameIndex < 8; frameIndex += 1) {
    const image = pngPixels(path.join(assetRoot, `frame-${String(frameIndex).padStart(2, '0')}.png`));
    assert.equal(image.width, 240);
    assert.equal(image.height, 240);
    const indices = [];
    for (let y = 0; y < 120; y += 1) {
      for (let x = 0; x < 120; x += 1) {
        const row = image.rows[y * 2];
        const color = [...row.subarray(x * 2 * 3, x * 2 * 3 + 3)];
        const index = addColor(color);
        assert(index < 256);
        indices.push(index);
      }
    }
    const runs = [];
    let current = indices[0];
    let length = 0;
    for (const index of indices) {
      if (index === current && length < 0x7fff) length += 1;
      else {
        runs.push((length << 8) | current);
        current = index;
        length = 1;
      }
    }
    runs.push((length << 8) | current);
    frames.push(runs);
  }
  assert.equal(palette.length, 24);
  const lines = [
    '#pragma once',
    '#include <stdint.h>',
    '#define CAT_AGENT_FRAME_WIDTH 120',
    '#define CAT_AGENT_FRAME_HEIGHT 120',
    '#define CAT_AGENT_FRAME_SCALE 2',
    '#define CAT_AGENT_FRAME_COUNT 8',
    '#define CAT_AGENT_PALETTE_SIZE 24',
    'static const uint16_t cat_agent_palette[CAT_AGENT_PALETTE_SIZE] = {',
    `    ${palette.map(color => `0x${rgb565(...color).toString(16).padStart(4, '0')}u`).join(', ')},`,
    '};',
  ];
  frames.forEach((runs, frameIndex) => {
    lines.push(`static const uint32_t cat_agent_frame_${String(frameIndex).padStart(2, '0')}[] = {`);
    for (let i = 0; i < runs.length; i += 8) {
      lines.push(`    ${runs.slice(i, i + 8).map(value => `0x${value.toString(16)}u`).join(', ')},`);
    }
    lines.push('};');
  });
  lines.push('static const uint16_t cat_agent_frame_run_counts[CAT_AGENT_FRAME_COUNT] = {');
  lines.push(`    ${frames.map(frame => frame.length).join(', ')},`);
  lines.push('};');
  lines.push('static const uint32_t *cat_agent_frames[CAT_AGENT_FRAME_COUNT] = {');
  lines.push('    cat_agent_frame_00, cat_agent_frame_01, cat_agent_frame_02, cat_agent_frame_03,');
  lines.push('    cat_agent_frame_04, cat_agent_frame_05, cat_agent_frame_06, cat_agent_frame_07,');
  lines.push('};');
  return lines.join('\n') + '\n';
}

function makeImplementation(header) {
  const cmake = [
    'cmake_minimum_required(VERSION 3.16)',
    'include($ENV{IDF_PATH}/tools/cmake/project.cmake)',
    'project(otto_st7789_cat_agent)',
    '',
  ].join('\n');
  const component = [
    'idf_component_register(',
    '    SRCS "main.c"',
    '    INCLUDE_DIRS "."',
    '    REQUIRES esp_lcd driver',
    ')',
    '',
  ].join('\n');
  const defaults = [
    '# Fixture initializes only the LCD; no servo, audio, camera, or network initialization.',
    'CONFIG_ESPTOOLPY_FLASHSIZE_16MB=y',
    '',
  ].join('\n');
  const source = [
    '#include <stdbool.h>',
    '#include <stddef.h>',
    '#include <stdint.h>',
    '#include <stdlib.h>',
    '#include "driver/gpio.h"',
    '#include "driver/spi_master.h"',
    '#include "esp_heap_caps.h"',
    '#include "esp_lcd_panel_io.h"',
    '#include "esp_lcd_panel_ops.h"',
    '#include "esp_lcd_panel_vendor.h"',
    '#include "esp_log.h"',
    '#include "freertos/FreeRTOS.h"',
    '#include "freertos/task.h"',
    '#include "cat_agent_frames.h"',
    '',
    '#define LCD_WIDTH 240',
    '#define LCD_HEIGHT 240',
    '#define LCD_FRAME_BYTES (LCD_WIDTH * LCD_HEIGHT * 2)',
    '#define LCD_MOSI_GPIO 10',
    '#define LCD_SCLK_GPIO 9',
    '#define LCD_DC_GPIO 46',
    '#define LCD_RESET_GPIO 11',
    '#define LCD_CS_GPIO 12',
    '#define LCD_BACKLIGHT_GPIO 3',
    '#define LCD_SPI_HOST SPI3_HOST',
    '#define LCD_SPI_MODE 3',
    '#define LCD_PIXEL_CLOCK_HZ (40 * 1000 * 1000)',
    '',
    '_Static_assert(LCD_WIDTH == CAT_AGENT_FRAME_WIDTH * CAT_AGENT_FRAME_SCALE, "frame width mismatch");',
    '_Static_assert(LCD_HEIGHT == CAT_AGENT_FRAME_HEIGHT * CAT_AGENT_FRAME_SCALE, "frame height mismatch");',
    '',
    'static const char *TAG = "otto_st7789_cat_agent";',
    'static uint8_t *framebuffer;',
    'static const uint8_t cat_glyphs[3][7] = {',
    '    {0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e},',
    '    {0x00, 0x00, 0x0e, 0x01, 0x0f, 0x11, 0x0f},',
    '    {0x04, 0x04, 0x1f, 0x04, 0x04, 0x05, 0x02},',
    '};',
    '',
    'static void put_pixel(size_t x, size_t y, uint16_t color)',
    '{',
    '    if (x >= LCD_WIDTH || y >= LCD_HEIGHT) return;',
    '    size_t offset = (y * LCD_WIDTH + x) * 2;',
    '    framebuffer[offset] = (uint8_t)(color >> 8);',
    '    framebuffer[offset + 1] = (uint8_t)color;',
    '}',
    '',
    'static void draw_cat_label(void)',
    '{',
    '    const size_t scale = 3;',
    '    const size_t glyph_width = 5 * scale;',
    '    const size_t spacing = scale;',
    '    const size_t label_width = 3 * glyph_width + 2 * spacing;',
    '    const size_t start_x = LCD_WIDTH - label_width - 8;',
    '    const size_t start_y = 10;',
    '    for (size_t pass = 0; pass < 2; ++pass) {',
    '        const uint16_t color = pass == 0 ? 0x0000u : 0xffe0u;',
    '        const size_t dx = pass == 0 ? 2 : 0;',
    '        const size_t dy = pass == 0 ? 2 : 0;',
    '        for (size_t glyph = 0; glyph < 3; ++glyph) {',
    '            for (size_t row = 0; row < 7; ++row) {',
    '                for (size_t column = 0; column < 5; ++column) {',
    '                    if ((cat_glyphs[glyph][row] & (1u << (4u - column))) == 0) continue;',
    '                    for (size_t yy = 0; yy < scale; ++yy)',
    '                        for (size_t xx = 0; xx < scale; ++xx)',
    '                            put_pixel(start_x + glyph * (glyph_width + spacing) + column * scale + xx + dx,',
    '                                      start_y + row * scale + yy + dy, color);',
    '                }',
    '            }',
    '        }',
    '    }',
    '}',
    '',
    'static void render_frame(esp_lcd_panel_handle_t panel, esp_lcd_panel_io_handle_t io, size_t frame_index)',
    '{',
    '    if (frame_index >= CAT_AGENT_FRAME_COUNT) abort();',
    '    const uint32_t *runs = cat_agent_frames[frame_index];',
    '    size_t source_pixel = 0;',
    '    const size_t source_pixels = CAT_AGENT_FRAME_WIDTH * CAT_AGENT_FRAME_HEIGHT;',
    '    for (uint16_t run_index = 0; run_index < cat_agent_frame_run_counts[frame_index]; ++run_index) {',
    '        uint32_t encoded = runs[run_index];',
    '        size_t length = encoded >> 8;',
    '        uint8_t palette_index = encoded & 0xffu;',
    '        if (length == 0 || palette_index >= CAT_AGENT_PALETTE_SIZE || source_pixel + length > source_pixels) abort();',
    '        for (size_t i = 0; i < length; ++i) {',
    '            size_t pixel = source_pixel + i;',
    '            size_t x = (pixel % CAT_AGENT_FRAME_WIDTH) * CAT_AGENT_FRAME_SCALE;',
    '            size_t y = (pixel / CAT_AGENT_FRAME_WIDTH) * CAT_AGENT_FRAME_SCALE;',
    '            uint16_t color = cat_agent_palette[palette_index];',
    '            for (size_t yy = 0; yy < CAT_AGENT_FRAME_SCALE; ++yy)',
    '                for (size_t xx = 0; xx < CAT_AGENT_FRAME_SCALE; ++xx) put_pixel(x + xx, y + yy, color);',
    '        }',
    '        source_pixel += length;',
    '    }',
    '    if (source_pixel != source_pixels) abort();',
    '    draw_cat_label();',
    '    ESP_ERROR_CHECK(esp_lcd_panel_draw_bitmap(panel, 0, 0, LCD_WIDTH, LCD_HEIGHT, framebuffer));',
    '    /* Wait for the queued DMA transfer before reusing the framebuffer. */',
    '    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(io, -1, NULL, 0));',
    '}',
    '',
    'static esp_lcd_panel_handle_t init_display(esp_lcd_panel_io_handle_t *io)',
    '{',
    '    const spi_bus_config_t bus = {',
    '        .mosi_io_num = LCD_MOSI_GPIO, .miso_io_num = -1, .sclk_io_num = LCD_SCLK_GPIO,',
    '        .quadwp_io_num = -1, .quadhd_io_num = -1, .max_transfer_sz = LCD_FRAME_BYTES,',
    '    };',
    '    ESP_ERROR_CHECK(spi_bus_initialize(LCD_SPI_HOST, &bus, SPI_DMA_CH_AUTO));',
    '    const esp_lcd_panel_io_spi_config_t io_config = {',
    '        .cs_gpio_num = LCD_CS_GPIO, .dc_gpio_num = LCD_DC_GPIO, .spi_mode = LCD_SPI_MODE,',
    '        .pclk_hz = LCD_PIXEL_CLOCK_HZ, .trans_queue_depth = 10, .lcd_cmd_bits = 8, .lcd_param_bits = 8,',
    '    };',
    '    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi(LCD_SPI_HOST, &io_config, io));',
    '    const esp_lcd_panel_dev_config_t panel_config = {',
    '        .reset_gpio_num = LCD_RESET_GPIO, .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,',
    '        .data_endian = LCD_RGB_DATA_ENDIAN_BIG, .bits_per_pixel = 16,',
    '    };',
    '    esp_lcd_panel_handle_t panel = NULL;',
    '    ESP_ERROR_CHECK(esp_lcd_new_panel_st7789(*io, &panel_config, &panel));',
    '    ESP_ERROR_CHECK(esp_lcd_panel_reset(panel));',
    '    ESP_ERROR_CHECK(esp_lcd_panel_init(panel));',
    '    ESP_ERROR_CHECK(esp_lcd_panel_invert_color(panel, true));',
    '    ESP_ERROR_CHECK(esp_lcd_panel_set_gap(panel, 0, 0));',
    '    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(panel, true));',
    '    return panel;',
    '}',
    '',
    'void app_main(void)',
    '{',
    '    ESP_LOGI(TAG, "ADAPTATION_BEGIN board=otto-robot-st7789 display=ST7789 240x240");',
    '    ESP_LOGI(TAG, "LCD pins MOSI=%d SCLK=%d DC=%d RST=%d CS=%d BL=%d mode=%d clock=%d",',
    '             LCD_MOSI_GPIO, LCD_SCLK_GPIO, LCD_DC_GPIO, LCD_RESET_GPIO, LCD_CS_GPIO,',
    '             LCD_BACKLIGHT_GPIO, LCD_SPI_MODE, LCD_PIXEL_CLOCK_HZ);',
    '    const gpio_config_t backlight = {',
    '        .pin_bit_mask = 1ULL << LCD_BACKLIGHT_GPIO, .mode = GPIO_MODE_OUTPUT,',
    '        .pull_up_en = GPIO_PULLUP_DISABLE, .pull_down_en = GPIO_PULLDOWN_DISABLE, .intr_type = GPIO_INTR_DISABLE,',
    '    };',
    '    ESP_ERROR_CHECK(gpio_config(&backlight));',
    '    ESP_ERROR_CHECK(gpio_set_level(LCD_BACKLIGHT_GPIO, 0));',
    '    framebuffer = heap_caps_malloc(LCD_FRAME_BYTES, MALLOC_CAP_DMA);',
    '    if (framebuffer == NULL) abort();',
    '    esp_lcd_panel_io_handle_t io = NULL;',
    '    esp_lcd_panel_handle_t panel = init_display(&io);',
    '    ESP_LOGI(TAG, "NYAN_ASSET frames=%u source=offline-png-input license=MIT", CAT_AGENT_FRAME_COUNT);',
    '    render_frame(panel, io, 0);',
    '    ESP_ERROR_CHECK(gpio_set_level(LCD_BACKLIGHT_GPIO, 1));',
    '    ESP_LOGI(TAG, "ADAPTATION_READY label=Cat position=top-right");',
    '    size_t frame = 1;',
    '    unsigned int heartbeat = 0;',
    '    while (true) {',
    '        render_frame(panel, io, frame);',
    '        frame = (frame + 1) % CAT_AGENT_FRAME_COUNT;',
    '        if (frame == 0) ESP_LOGI(TAG, "ADAPTATION_ANIMATION heartbeat=%u frames=%u", heartbeat++, CAT_AGENT_FRAME_COUNT);',
    '        vTaskDelay(pdMS_TO_TICKS(125));',
    '    }',
    '}',
    '',
  ].join('\n');
  return { cmake, component, defaults, header, source };
}

function tool(name, input, id) {
  return { type: 'tool_use', id, name, input };
}

function text(textValue) {
  return { type: 'text', text: textValue };
}

function respond(res, blocks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  event({ type: 'message_start', message: { id: `adaptation-${modelRequests.length}`, type: 'message', role: 'assistant', model: 'offline-adaptation-fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  blocks.forEach((block, index) => {
    event({ type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
    event({ type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    event({ type: 'content_block_stop', index });
  });
  event({ type: 'message_delta', delta: { stop_reason: blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 30 } });
  event({ type: 'message_stop' });
  res.end();
}

function observe(proc) {
  const events = [];
  let stdout = '';
  let stderr = '';
  const lines = createInterface({ input: proc.stdout });
  lines.on('line', line => {
    stdout += `${line}\n`;
    try { events.push(JSON.parse(line)); } catch { /* protocol diagnostics are asserted below */ }
  });
  proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const wait = async predicate => {
    const started = Date.now();
    while (Date.now() - started < 180000) {
      const value = events.find(predicate);
      if (value) return value;
      if (proc.exitCode != null) throw new Error(`adaptation Agent exited: ${stdout}\n${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`adaptation Agent timeout: ${stdout}\n${stderr}`);
  };
  const observation = { proc, events, wait, stdout: () => stdout, stderr: () => stderr };
  processes.push(observation);
  return observation;
}

async function main() {
  assert(fs.existsSync(kitSource), 'generic board kit is missing');
  assert(fs.existsSync(workspaceSource), 'task workspace is missing');
  assert(!fs.existsSync(path.join(kitSource, 'upstream-reference', 'otto_robot.cc')), 'generic kit must not contain application source');
  assert(!fs.existsSync(artifactRoot), 'adaptation evidence directory already exists; refusing to overwrite it');
  await app.whenReady();

  server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    modelRequests.push(request);
    try {
      await responder(request, res);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(error.message || error) } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  const projects = require(path.join(repoRoot, 'electron', 'dist', 'main', 'project-session.js'));
  agent = require(path.join(repoRoot, 'electron', 'dist', 'main', 'agent.js'));
  const { Orchestrator } = require(path.join(repoRoot, 'electron', 'dist', 'main', 'worker', 'orchestrator.js'));
  projects.createProject('otto-st7789-cat-agent-output');
  const project = projects.getActiveProject();
  assert(project, 'isolated project was not activated');
  fs.rmSync(path.join(project.projectDir, 'main'), { recursive: true, force: true });
  fs.rmSync(path.join(project.projectDir, 'CMakeLists.txt'), { force: true });
  assert.deepEqual(treeHashes(project.projectDir, true), {}, 'project must contain no application source');
  const originalKit = treeHashes(kitSource);
  const originalWorkspace = treeHashes(workspaceSource);
  fs.mkdirSync(path.join(project.projectDir, 'inputs'), { recursive: true });
  copyTree(kitSource, path.join(project.projectDir, 'inputs', 'kit'));
  copyTree(workspaceSource, path.join(project.projectDir, 'inputs', 'workspace'));
  const kitBefore = treeHashes(path.join(project.projectDir, 'inputs', 'kit'));
  const workspaceBefore = treeHashes(path.join(project.projectDir, 'inputs', 'workspace'));
  assert.deepEqual(kitBefore, originalKit, 'kit copy differs from original');
  assert.deepEqual(workspaceBefore, originalWorkspace, 'workspace copy differs from original');
  const implementation = makeImplementation(createFrameHeader(path.join(project.projectDir, 'inputs', 'workspace', 'assets', 'nyan')));
  const assetLicense = fs.readFileSync(path.join(project.projectDir, 'inputs', 'workspace', 'assets', 'ASSET_LICENSE.md'), 'utf8');
  const sourceFiles = ['CMakeLists.txt', 'sdkconfig.defaults', 'ASSET_LICENSE.md', 'main/CMakeLists.txt', 'main/main.c', 'main/cat_agent_frames.h'];

  const files = [
    ...Object.keys(kitBefore).filter(file => !file.endsWith('.pdf')).map(file => [`inputs/kit/${file}`]),
    ...Object.keys(workspaceBefore).filter(file => !file.endsWith('.png')).map(file => [`inputs/workspace/${file}`]),
    ['inputs/kit/hardware/schematic/otto-robot-schematic.pdf'],
    ['inputs/workspace/assets/nyan/frame-00.png'],
  ];
  const binaryReads = new Set(files.flat().filter(file => /\.(?:pdf|png)$/.test(file)));
  let callNumber = 0;
  const nextId = () => `adaptation-call-${++callNumber}`;
  const responses = files.map(([file]) => [tool('Read', { path: file }, nextId())]);
  responses.push(
    [tool('Write', { path: 'CMakeLists.txt', content: implementation.cmake }, nextId())],
    [tool('Write', { path: 'ASSET_LICENSE.md', content: assetLicense }, nextId())],
    [tool('Write', { path: 'main/CMakeLists.txt', content: implementation.component }, nextId())],
    [tool('Write', { path: 'sdkconfig.defaults', content: implementation.defaults }, nextId())],
    [tool('Write', { path: 'main/cat_agent_frames.h', content: implementation.header }, nextId())],
    [tool('Write', { path: 'main/main.c', content: implementation.source }, nextId())],
    [tool('hardboard_idf_set_target', { target: 'esp32s3', version: '5.4.3' }, nextId())],
    [tool('hardboard_idf_build', { version: '5.4.3' }, nextId())],
    [text('Created a new isolated ESP-IDF LCD-only project from the board kit and task workspace; build evidence is recorded by the host fixture.')],
  );
  let responseIndex = 0;
  responder = async (_body, res) => {
    const blocks = responses[responseIndex++];
    if (!blocks) throw new Error('offline fixture received more model turns than expected');
    await new Promise(resolve => setImmediate(resolve));
    respond(res, blocks);
  };

  const binding = { conversationId: 'otto-adaptation-fixture', bootstrap: null };
  const model = {
    providerId: 'offline-adaptation-fixture',
    upstreamModel: 'offline-adaptation-fixture',
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    authToken: secret,
    authField: 'ANTHROPIC_AUTH_TOKEN',
    contextWindow: 131072, reserveTokens: 36864, maxOutputTokens: 32768, keepRecentTokens: 24000,
  };
  const worker = Object.create(Orchestrator.prototype);
  const parsed = [];
  Object.assign(worker, {
    currentConversationId: binding.conversationId,
    observedAgentPid: null,
    handleParsedChunk: chunk => parsed.push(chunk),
    pushUI: () => {},
    stopSilenceTimer: () => {},
  });
  const proc = worker.ensurePersistentAgent('default', model, binding.bootstrap);
  const observation = observe(proc);
  agent.sendAgentMessage('Adapt the Otto ST7789 board from the supplied kit and implement the Cat task in this empty project. Use only the staged inputs; do not use any existing application source.', 'default', model, binding);
  const result = await observation.wait(event => event.type === 'result');
  assert.equal(result.is_error, false, result.result);
  assert.equal(responseIndex, responses.length, 'fixture did not complete its expected sequence');

  const requests = observation.events.filter(event => event.type === 'tool_request');
  const expectedCalls = responses.flat().filter(block => block.type === 'tool_use');
  assert.deepEqual(requests.map(event => ({ name: event.name, input: event.input })),
    expectedCalls.map(block => ({ name: block.name, input: block.input })), 'unexpected tool call or arguments');
  toolCalls.push(...requests.map(event => event.name));
  assert(!toolCalls.some(name => /flash|erase|serial|shell|bash|browser|vision/i.test(name)));
  assert(modelRequests[0].tools.some(definition => definition.name === 'hardboard_idf_build'));
  assert(!modelRequests[0].tools.some(definition => /erase|shell|bash/i.test(definition.name)));
  assert(!observation.stdout().includes(secret));
  assert(!observation.stderr().includes(secret));
  assert(!JSON.stringify(modelRequests).includes(secret));
  assert(!requests.some(event => typeof event.input.path === 'string' && /otto_rainbow_cat|otto_nyan_frames\.h/.test(event.input.path)), 'old application path was requested');
  assert.deepEqual(treeHashes(path.join(project.projectDir, 'inputs', 'kit')), kitBefore);
  assert.deepEqual(treeHashes(path.join(project.projectDir, 'inputs', 'workspace')), workspaceBefore);
  assert(!fs.existsSync(path.join(project.projectDir, 'main', 'otto_rainbow_cat_main.c')));
  assert(!fs.existsSync(path.join(project.projectDir, 'main', 'otto_nyan_frames.h')));

  const results = observation.events
    .filter(event => event.type === 'user' && Array.isArray(event.message?.content))
    .flatMap(event => event.message.content)
    .filter(block => block.type === 'tool_result');
  assert.equal(results.length, requests.length, 'missing or duplicated tool results');
  const ledger = [];
  const commandResults = {};
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    const reply = results[index];
    assert.equal(reply.tool_use_id, request.id, 'tool call/result pair mismatch');
    const expectedError = request.name === 'Read' && binaryReads.has(request.input.path);
    assert.equal(Boolean(reply.is_error), expectedError, `unexpected outcome for ${request.name} ${request.input.path || ''}: ${reply.content}`);
    if (expectedError) {
      const code = request.input.path.endsWith('.pdf') ? 'TOOL_FILE_TOO_LARGE_OR_NOT_TEXT' : 'TOOL_BINARY_FILE_REFUSED';
      assert(String(reply.content).includes(code), `unexpected binary Read refusal: ${reply.content}`);
      ledger.push({ id: request.id, name: request.name, path: request.input.path, isError: true, error: code });
      continue;
    }
    const value = JSON.parse(reply.content);
    if (request.name === 'Read') {
      assert.equal(value.path, request.input.path);
      assert.equal(value.truncated, false, `incomplete text Read: ${value.path}`);
      ledger.push({ id: request.id, name: request.name, path: value.path, isError: false, contentSha256: value.contentSha256 });
    } else if (request.name === 'Write') {
      assert.equal(value.path, request.input.path);
      assert.equal(value.bytes, Buffer.byteLength(request.input.content));
      ledger.push({ id: request.id, name: request.name, path: value.path, isError: false, bytes: value.bytes,
        sha256: sha256(path.join(project.projectDir, value.path)) });
    } else {
      assert.equal(value.exitCode, 0, `${request.name}: ${reply.content}`);
      assert.equal(path.resolve(value.cwd), path.resolve(project.projectDir), 'build escaped the isolated project');
      assert(!/erase-flash|\sflash(?:\s|$)/i.test(value.command));
      assert(/(?:set-target esp32s3|build)(?:\s|$)/.test(value.command));
      commandResults[request.name] = value;
      ledger.push({ id: request.id, name: request.name, isError: false, command: value.command, cwd: value.cwd,
        exitCode: value.exitCode, taskId: value.taskId, stdoutLogPath: value.stdoutLogPath, stderrLogPath: value.stderrLogPath });
    }
  }
  assert.deepEqual(treeHashes(kitSource), kitBefore, 'original kit changed');
  assert.deepEqual(treeHashes(workspaceSource), workspaceBefore, 'original workspace changed');
  const inputSourceFiles = files.flat().filter(file => !binaryReads.has(file));
  const outputFiles = Object.keys(treeHashes(project.projectDir, true)).filter(file => !file.startsWith('inputs/') && !['sdkconfig', 'sdkconfig.old'].includes(file));
  assert.deepEqual(outputFiles.sort(), [...sourceFiles].sort(), 'unexpected application output');
  const parsedBuild = commandResults.hardboard_idf_build;
  assert(parsedBuild, 'controlled build result was not returned');
  const appBinary = 'otto_st7789_cat_agent.bin';
  const appBinaryPath = path.join(project.projectDir, 'build', appBinary);
  assert(fs.statSync(appBinaryPath).size > 0, 'ESP-IDF build did not produce the expected application image');
  assert(fs.readFileSync(path.join(project.projectDir, 'sdkconfig'), 'utf8').includes('CONFIG_ESPTOOLPY_FLASHSIZE="16MB"'));
  const flasherArgs = JSON.parse(fs.readFileSync(path.join(project.projectDir, 'build', 'flasher_args.json'), 'utf8'));
  assert.equal(flasherArgs.flash_settings.flash_size, '16MB');
  fs.mkdirSync(path.join(artifactRoot, 'implementation'), { recursive: true });
  fs.mkdirSync(path.join(artifactRoot, 'evidence'), { recursive: true });
  for (const file of sourceFiles) {
    const destination = path.join(artifactRoot, 'implementation', file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(project.projectDir, file), destination);
  }
  for (const [name, value] of Object.entries(commandResults)) {
    const prefix = name === 'hardboard_idf_build' ? 'idf-build' : 'idf-set-target';
    for (const stream of ['stdout', 'stderr']) {
      const logPath = value[`${stream}LogPath`];
      assert(logPath && fs.existsSync(logPath), `missing ${prefix} ${stream} log`);
      fs.copyFileSync(logPath, path.join(artifactRoot, 'evidence', `${prefix}.${stream}.log`));
    }
  }
  fs.copyFileSync(appBinaryPath, path.join(artifactRoot, 'evidence', appBinary));
  fs.writeFileSync(path.join(artifactRoot, 'evidence', 'input-hashes.json'), `${JSON.stringify({ kit: kitBefore, workspace: workspaceBefore }, null, 2)}\n`);
  fs.writeFileSync(path.join(artifactRoot, 'evidence', 'tool-ledger.json'), `${JSON.stringify({
    schemaVersion: 1, verificationKind: 'SCRIPTED_RIG_HOST_BUILD_INTEGRATION', projectDir: project.projectDir,
    calls: ledger,
  }, null, 2)}\n`);
  const appSize = fs.statSync(appBinaryPath).size;
  const appHash = sha256(appBinaryPath);
  const report = [
    '# Otto ST7789 scripted Rig build integration test v1',
    '',
    '- **Status:** PASS for the offline Rig/Main/Runtime execution pipeline.',
    '- **Method:** the local SSE fixture supplies hand-written firmware source and a fixed Tool sequence. No inference model designs or generates this implementation.',
    '- **Autonomous model adaptation:** NOT_RUN; this fixture does not verify that capability.',
    '- **Inputs:** the generic hardware kit and separate Cat task workspace, copied into a fresh temporary project under `inputs/`; original and copied input hashes remain identical.',
    `- **Isolated project:** ${project.projectDir} (temporary project removed after evidence export).`,
    '- **Implementation:** `implementation/`; existing Otto application source and reference firmware are outside the test inputs.',
    `- **Host Tool sequence:** ${toolCalls.join(' -> ')}`,
    '- **Scope:** no Flash, erase-flash, Serial, public network, paid model, Qwen, or user credential access. The only model endpoint is a local loopback fixture with an invalid test token.',
    '',
    '## Fixture hardware configuration',
    '',
    '- ESP32-S3, target `esp32s3`, ESP-IDF `5.4.3`, flash size configured as `16MB`.',
    '- ST7789 240x240 serial SPI on `SPI3_HOST`, mode 3, 40 MHz, RGB565, RGB order, inverted colors, zero offset.',
    '- MOSI GPIO10, SCLK GPIO9, DC GPIO46, reset GPIO11, CS GPIO12, backlight GPIO3 active-high.',
    '- LCD-only initialization; no servo, audio, camera, or network initialization.',
    '',
    '## Controlled build evidence',
    '',
    `- Set-target command: ${commandResults.hardboard_idf_set_target.command}`,
    `- Build command: ${parsedBuild.command}`,
    `- Build exit code: ${parsedBuild.exitCode}`,
    `- Application image: evidence/${appBinary} (${appSize} bytes, SHA-256 ${appHash})`,
    '- Actual set-target/build stdout/stderr, input hashes, and paired Tool outcomes are preserved under `evidence/`.',
    '- ESP-IDF embeds build metadata; each run records its own image hash. Identical source does not imply an identical image hash across runs.',
    '',
    '## Display source',
    '',
    '- The fixture converts eight offline PNG inputs into a 24-entry RGB565 palette and 120x120 RLE data, expanded 2x2 into a 240x240 framebuffer.',
    '- `Cat` is drawn after each decoded frame with 5x7 glyphs at scale 3, yellow RGB565 and a black offset shadow, in the upper-right.',
    '- `esp_lcd_panel_io_tx_param(io, -1, NULL, 0)` follows `esp_lcd_panel_draw_bitmap()` before framebuffer reuse.',
    '- Source implements `ADAPTATION_BEGIN`, `NYAN_ASSET`, `ADAPTATION_READY label=Cat position=top-right`, and `ADAPTATION_ANIMATION`; these are not observed Serial events.',
    '- `implementation/ASSET_LICENSE.md` retains the Nyan Cat MIT attribution.',
    '',
    '## Evidence boundary and repeat command',
    '',
    `- Text Read succeeded for all ${inputSourceFiles.length} supplied text files. The 243260-byte PDF exceeds the 128 KiB Read limit and returns TOOL_FILE_TOO_LARGE_OR_NOT_TEXT. A PNG Read returns TOOL_BINARY_FILE_REFUSED. The fixture decodes PNGs in the test process.`,
    '- The hand-written implementation and PNG conversion are test fixtures. PASS proves Tool execution, input isolation, error propagation, and a real ESP-IDF build. Autonomous model adaptation and physical Cat-label visibility remain unverified.',
    '- `npm --prefix electron run verify:otto-agent-adaptation` uses temporary evidence and leaves existing reports intact.',
    '- To preserve a new run: `npm --prefix electron run verify:otto-agent-adaptation -- --evidence-dir <new-directory>`. Existing output directories are refused.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(artifactRoot, 'REPORT.md'), report);
  fs.writeFileSync(path.join(artifactRoot, 'SOURCE_MANIFEST.json'), `${JSON.stringify({
    schemaVersion: 1,
    status: 'PASS',
    verificationKind: 'SCRIPTED_RIG_HOST_BUILD_INTEGRATION',
    generatedAt: new Date().toISOString(),
    autonomousModelAdaptation: 'NOT_RUN',
    physicalDisplayValidation: 'NOT_RUN',
    files: treeHashes(path.join(artifactRoot, 'implementation')),
    evidenceFiles: treeHashes(path.join(artifactRoot, 'evidence')),
    applicationImage: { name: appBinary, path: `evidence/${appBinary}`, bytes: appSize, sha256: appHash },
  }, null, 2)}\n`);
  const hashes = treeHashes(artifactRoot);
  fs.writeFileSync(path.join(artifactRoot, 'SHA256SUMS.txt'), Object.entries(hashes).map(([file, hash]) => `${hash}  ${file}\n`).join(''));
  for (const file of Object.keys(treeHashes(artifactRoot))) {
    assert(!fs.readFileSync(path.join(artifactRoot, file)).includes(Buffer.from(secret)), `fixture credential leaked: ${file}`);
  }
  console.log(`Otto scripted build integration passed: ${appBinary} ${appSize} bytes; evidence=${exportEvidence ? path.relative(repoRoot, artifactRoot) : 'temporary (removed after verification)'}`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(async () => {
  agent?.killAgent();
  await Promise.all(processes.map(async observed => {
    if (observed.proc.exitCode != null) return;
    const closed = once(observed.proc, 'close');
    observed.proc.kill();
    let timer;
    try { await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]); }
    finally { clearTimeout(timer); }
  }));
  server?.closeAllConnections();
  server?.close();
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); }
  finally { app.exit(process.exitCode || 0); }
});
