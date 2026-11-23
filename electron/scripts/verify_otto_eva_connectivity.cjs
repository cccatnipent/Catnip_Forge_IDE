const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');

const { configureCatnipUserDataPath } = require('../dist/main/user-data-path.js');
configureCatnipUserDataPath();
const { ensureRadioProcess, stopRadioProcess } = require('../dist/main/radio-process.js');

async function main() {
  await app.whenReady();
  const credentialsPath = path.join(app.getPath('userData'), 'otto-master', '.local-secrets', 'mqtt-credentials.json');
  const expected = JSON.parse(fs.readFileSync(credentialsPath, 'utf8')).users
    .filter((user) => user.role === 'device')
    .map((user) => user.device_id);
  const started = await ensureRadioProcess();
  if (started.state !== 'ready' || !started.url) throw new Error(started.message);

  let devices = [];
  let mqtt = {};
  let health = {};
  const startedAt = Date.now();
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const [deviceResponse, mqttResponse, healthResponse] = await Promise.all([
      fetch(new URL('api/v1/devices', started.url)),
      fetch(new URL('api/v1/mqtt/status', started.url)),
      fetch(new URL('api/v1/health', started.url)),
    ]);
    if (![deviceResponse, mqttResponse, healthResponse].every((response) => response.ok)) {
      throw new Error('Otto local read-only status API failed');
    }
    devices = (await deviceResponse.json()).items;
    mqtt = await mqttResponse.json();
    health = await healthResponse.json();
    const online = expected.filter((id) => devices.some((device) => device.device_id === id && device.status === 'online'));
    if (online.length === expected.length) break;
    if (attempt < 15) await delay(3_000);
  }

  const result = {
    backendPid: started.pid,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1_000),
    mqtt: { state: mqtt.state, healthy: mqtt.healthy, connectedClients: mqtt.connected_clients },
    mdns: { state: health.components?.mdns?.state, healthy: health.components?.mdns?.healthy },
    eva: expected.map((id, index) => {
      const device = devices.find((item) => item.device_id === id);
      return {
        label: `EVA credential ${index + 1}`,
        idSuffix: id.slice(-4),
        seen: Boolean(device),
        status: device?.status || 'not_seen',
        transport: device?.transport || null,
        lastHeartbeatAt: device?.last_heartbeat_at || null,
      };
    }),
  };
  console.log(JSON.stringify(result, null, 2));
}

let exitCode = 0;
main()
  .catch((error) => {
    console.error(error.message || String(error));
    exitCode = 1;
  })
  .finally(async () => {
    await stopRadioProcess();
    app.exit(exitCode);
  });
