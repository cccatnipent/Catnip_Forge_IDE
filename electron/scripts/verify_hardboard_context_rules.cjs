const assert = require('node:assert/strict');
const { app } = require('electron');

const tasks = [
  '帮我编译 ESP32-S3 工程',
  '选择串口 COM3 然后烧录固件',
  '用 ESP-IDF 5.4.3 新建一个硬件工程',
];

async function main() {
  await app.whenReady();
  const { buildContext, taskWantsBrowser } = require('../dist/main/worker/context');

  for (const task of tasks) {
    const context = buildContext(task);
    assert(
      context.skillsFound.includes('espidf-hardboard'),
      `espidf-hardboard not loaded for: ${task}`,
    );
    assert(
      context.prompt.includes('hardboard'),
      `hardboard tool rules missing for: ${task}`,
    );
    assert(
      context.prompt.includes('BoardPack({})') && context.prompt.includes('HARDWARE.md') && context.prompt.includes('原理图 PDF 只作为原始证据'),
      `text-first BoardPack rules missing for: ${task}`,
    );
  }

  const hardwareOnly = buildContext('【当前工作工程】\n工程目录：E:\\BaiduNetdiskDownload\\vibeide\\runtime\\hardboard\\projects\\demo\n【当前工作工程结束】\n制作离线星空沙漏，只允许编译，不打开串口，不烧录。先读取板卡摘要列出的文本，禁止网络。');
  assert(!hardwareOnly.prompt.includes('【平台硬约束】'));
  assert(!hardwareOnly.prompt.includes('【执行模式】打开'));
  assert(!hardwareOnly.recommendedSkills.includes('browser-guide'));
  assert(!hardwareOnly.recommendedSkills.includes('search-workflow'));
  assert(hardwareOnly.prompt.includes('不打开串口，不烧录'), 'lost user restriction');
  assert(buildContext('用百度搜索 ESP32 技术文档').prompt.includes('明确指定了百度'));
  assert(buildContext('打开网页看看效果').prompt.includes('【执行模式】打开'));
  const restrictions = '仅限本工程 Build，不打开串口，不使用浏览器/网络/声音/机械动作，不搜索，不截图。';
  const constrained = buildContext(restrictions);
  assert(!constrained.recommendedSkills.includes('browser-guide'));
  assert(!constrained.recommendedSkills.includes('search-workflow'));
  assert.equal(taskWantsBrowser(restrictions), false);
  assert(constrained.prompt.includes(restrictions), 'negative restrictions must stay in the actual prompt');
  assert.equal(taskWantsBrowser('打开网页然后截图确认'), true);
  console.log('hardboard context rules smoke ok');
  app.quit();
}

main().catch((error) => {
  console.error(error);
  app.quit();
  process.exit(1);
});
