const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(path.resolve(__dirname, '../../runtime/node_modules/playwright'));

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto('http://127.0.0.1:8081/', { waitUntil: 'domcontentloaded' });
    await page.locator('#assembly-viewport canvas[data-loaded="true"]').waitFor({ timeout: 30_000 });
    await page.locator('[data-tab="screen"]').click();
    await page.locator('#screen-mode').selectOption('js');
    await page.locator('#js-example').click();
    await page.locator('#js-run').click();
    const sandbox = page.locator('iframe[title="隔离的屏幕动画"]');
    await sandbox.waitFor({ state: 'attached', timeout: 5000 });
    await page.waitForFunction(() =>
      document.querySelector('iframe[title="隔离的屏幕动画"]')?.dataset.firstFrame === 'true',
      null,
      { timeout: 5000 },
    );
    await page.waitForTimeout(2500);
    const result = await page.evaluate(() => ({
      status: document.querySelector('#js-status')?.textContent,
      codeChars: document.querySelector('#js-code')?.value.length,
      modelLoaded: document.querySelector('#assembly-viewport canvas')?.dataset.loaded,
      sandboxCount: document.querySelectorAll('iframe[title="隔离的屏幕动画"]').length,
      firstFrame: document.querySelector('iframe[title="隔离的屏幕动画"]')?.dataset.firstFrame,
      sandboxSource: document.querySelector('iframe[title="隔离的屏幕动画"]')?.getAttribute('src'),
    }));
    console.log(JSON.stringify({ ...result, errors }, null, 2));
    assert.equal(result.modelLoaded, 'true', '3D scene did not load');
    assert.equal(result.firstFrame, 'true', 'screen example did not render its first frame');
    assert.match(result.status || '', /首帧已渲染/, 'screen example did not stay running');
    assert.equal(result.sandboxSource, '/screen-sandbox.html');
    assert.deepEqual(errors, [], 'browser errors while running screen example');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
