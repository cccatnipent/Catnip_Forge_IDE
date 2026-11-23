const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const packageRoot = process.env.CATNIP_PACKAGE_ROOT
  ? path.resolve(process.env.CATNIP_PACKAGE_ROOT)
  : path.join(__dirname, '..', 'dist-package', 'Catnip_Forge');
const exe = path.join(packageRoot, 'Catnip_Forge.exe');
assert(fs.existsSync(exe), `missing packaged executable: ${exe}`);

async function rendererTarget() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const targets = await fetch('http://127.0.0.1:9230/json').then((response) => response.json());
      const target = targets.find((item) => item.type === 'page'
        && item.url?.toLowerCase().includes('app.asar/dist/renderer/index.html'));
      if (target?.webSocketDebuggerUrl) return target;
    } catch { /* Electron is still starting. */ }
    await delay(500);
  }
  throw new Error('Packaged Electron renderer did not appear on CDP port 9230');
}

async function cdpCall(socket, method, params = {}) {
  const id = Math.floor(Math.random() * 1_000_000);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('renderer evaluation timed out')), 35_000);
    const onMessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      if (message.error || message.result?.exceptionDetails) {
        reject(new Error(message.error?.message || message.result.exceptionDetails.text));
      } else {
        resolve(message.result);
      }
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({
      id,
      method,
      params,
    }));
  });
}

async function evaluate(socket, expression) {
  const response = await cdpCall(socket, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return response?.result?.value;
}

async function main() {
  const child = spawn(exe, ['--disable-gpu', '--no-sandbox'], {
    cwd: packageRoot,
    env: process.env,
    stdio: 'ignore',
    windowsHide: true,
  });
  let socket;
  let iframeSocket;
  try {
    const target = await rendererTarget();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    const startup = await evaluate(socket, `(async () => {
      for (let i = 0; i < 100; i += 1) {
        if (window.electronAPI?.getRadioStatus) {
          const status = await window.electronAPI.getRadioStatus();
          if (status.state === 'ready' || status.state === 'error') return status;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { state: 'timeout' };
    })()`);
    assert.equal(startup.state, 'ready', 'Otto did not auto-start with Electron');
    const result = await evaluate(socket, `(async () => {
      for (let i = 0; i < 100; i += 1) {
        const tab = document.querySelector('[data-tour-id="tab-radio"]');
        if (tab) {
          tab.click();
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      for (let i = 0; i < 150; i += 1) {
        const frame = document.querySelector('.radio-workspace iframe');
        if (frame) {
          const status = await window.electronAPI.getRadioStatus();
          return { found: true, src: frame.src, chip: document.querySelector('.radio-service-chip')?.textContent, status };
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return { found: false, message: document.querySelector('.radio-workspace-state p')?.textContent };
    })()`);
    assert.equal(result.found, true, result.message || 'radio iframe did not appear');
    assert.equal(result.status.state, 'ready');
    assert.equal(result.status.backendReady, true);
    assert.equal(result.status.pid, startup.pid, 'opening the radio launched a second Otto process');
    assert.equal(result.src, result.status.url);
    assert(result.chip.includes('Otto Master 已就绪'));
    let iframeTarget;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const targets = await fetch('http://127.0.0.1:9230/json').then((response) => response.json());
      iframeTarget = targets.find((item) => item.type === 'iframe' && item.url === result.src);
      if (iframeTarget?.webSocketDebuggerUrl) break;
      await delay(100);
    }
    assert(iframeTarget?.webSocketDebuggerUrl, 'radio iframe did not navigate to the Otto WebUI');
    iframeSocket = new WebSocket(iframeTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      iframeSocket.addEventListener('open', resolve, { once: true });
      iframeSocket.addEventListener('error', reject, { once: true });
    });
    const embedded = await evaluate(iframeSocket, `(async () => {
      for (let i = 0; i < 50 && document.readyState !== 'complete'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {
        ready: document.readyState,
        title: document.title,
        location: location.href,
        assembly: Boolean(document.querySelector('.assembly-app')),
        serverTab: Boolean(document.querySelector('[data-tab="server"]'))
      };
    })()`);
    assert.equal(embedded.ready, 'complete');
    assert.equal(embedded.assembly, true, JSON.stringify(embedded));
    assert.equal(embedded.serverTab, true);
    const consoleState = await evaluate(iframeSocket, `(async () => {
      document.querySelector('[data-tab="server"]').click();
      for (let i = 0; i < 100; i += 1) {
        const title = document.querySelector('.server-summary-title')?.textContent || '';
        if (title.includes('Otto Master')) {
          return { loaded: true, kpis: document.querySelectorAll('.server-kpi-strip > *').length };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { loaded: false, kpis: 0 };
    })()`);
    assert.equal(consoleState.loaded, true, 'Otto server console did not load backend state');
    assert(consoleState.kpis >= 4, 'Otto server console did not render its status cards');
    const health = await fetch(new URL('api/v1/health', result.src));
    assert.equal(health.status, 200);
    await evaluate(socket, 'window.electronAPI.stopRadio()');
    console.log(`Packaged radio UI passed: Otto PID ${result.status.pid}, iframe, health, stop`);
  } finally {
    if (iframeSocket) iframeSocket.close();
    if (socket) socket.close();
    if (child.pid) await new Promise((resolve) => {
      execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
