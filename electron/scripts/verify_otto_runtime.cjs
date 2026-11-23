const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');

const { configureCatnipUserDataPath } = require('../dist/main/user-data-path.js');
configureCatnipUserDataPath();
const { ensureRadioProcess, stopRadioProcess } = require('../dist/main/radio-process.js');

async function verify() {
  await app.whenReady();
  const started = await ensureRadioProcess();
  assert.equal(started.state, 'ready', started.message);
  assert.equal(started.backendReady, true);
  assert(Number.isInteger(started.pid) && started.pid > 0);
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

  const second = await ensureRadioProcess();
  assert.equal(second.pid, started.pid, 'opening the radio twice must reuse one Otto PID');

  const healthResponse = await fetch(new URL('api/v1/health', started.url));
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  // The portable source intentionally omits the optional OTA firmware binary.
  assert(
    health.status === 'healthy'
      || (health.status === 'degraded' && JSON.stringify(health.unhealthy_components) === '["ota"]'),
    JSON.stringify(health.unhealthy_components),
  );
  assert.equal(health.components.web.healthy, true);
  assert.equal(health.components.mqtt.healthy, true);

  const pageResponse = await fetch(started.url);
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.text();
  assert(page.includes('Forge 电台'), 'Otto WebUI was not served at the radio URL');
  const asset = page.match(/(?:src|href)="(\/assets\/[^\"]+)"/);
  assert(asset, 'Otto WebUI has no built asset reference');
  const assetResponse = await fetch(new URL(asset[1], started.url));
  assert.equal(assetResponse.status, 200);

  await stopRadioProcess();
  let stopped = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fetch(new URL('api/v1/health', started.url), { signal: AbortSignal.timeout(500) });
    } catch {
      stopped = true;
      break;
    }
    await delay(100);
  }
  assert(stopped, 'Otto HTTP port remained open after stopping its child process');
  console.log(`Otto Electron integration passed: PID ${started.pid}, ${health.status}, WebUI, asset, stop`);
}

let exitCode = 0;
verify()
  .catch((error) => {
    console.error(error);
    exitCode = 1;
  })
  .finally(async () => {
    await stopRadioProcess();
    app.exit(exitCode);
  });
