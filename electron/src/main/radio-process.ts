import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { IpcMain } from 'electron';
import { getResourcesDir, getUserDataPath, isDev } from './paths';
import { logger } from './worker/logger';

export interface RadioProcessSnapshot {
  state: 'stopped' | 'starting' | 'ready' | 'error';
  pid: number | null;
  url: string | null;
  message: string;
  backendReady: boolean;
}

let child: ChildProcess | null = null;
let snapshot: RadioProcessSnapshot = {
  state: 'stopped',
  pid: null,
  url: null,
  message: 'Otto Master 尚未启动',
  backendReady: false,
};
let starting: Promise<RadioProcessSnapshot> | null = null;
let lifecycle = 0;
const intentionalStops = new WeakSet<ChildProcess>();

function ottoRoot(): string {
  return getResourcesDir('runtime', 'otto-master');
}

function pythonExecutable(): string {
  const override = process.env.CATNIP_OTTO_PYTHON;
  if (override && fs.existsSync(override)) return override;

  const candidates = isDev()
    ? [
        getResourcesDir('_bundled', 'python', 'python.exe'),
        getResourcesDir('runtime', 'python', 'python.exe'),
        'python',
      ]
    : [getResourcesDir('runtime', 'python', 'python.exe')];
  return candidates.find((candidate) => candidate === 'python' || fs.existsSync(candidate)) ?? 'python';
}

function ottoEnvironment(root: string, python: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  for (const name of [
    'OTTO_CONSOLE_TOKEN',
    'OTTO_MQTT_MASTER_PASSWORD',
    'OTTO_ASR_API_KEY',
    'DEEPSEEK_API_KEY',
    'OTTO_TTS_API_KEY',
    'ZHIHU_ACCESS_SECRET',
    'OTTO_PROVISIONING_TOKEN',
  ]) {
    if (process.env[name]) env[name] = process.env[name];
  }

  const sourcePath = path.join(root, 'src');
  const inheritedPythonPath = process.env.PYTHONPATH ? `${sourcePath}${path.delimiter}${process.env.PYTHONPATH}` : sourcePath;
  if (path.isAbsolute(python)) {
    env.PATH = `${path.dirname(python)}${path.delimiter}${env.PATH || env.Path || ''}`;
    delete env.Path;
  }
  return {
    ...env,
    OTTO_CONFIG_PATH: path.join(root, 'config.electron.yaml'),
    OTTO_DATA_DIR: getUserDataPath('otto-master'),
    OTTO_ENV_FILE: getUserDataPath('otto-master', '.env'),
    OTTO_ELECTRON_EMBEDDED: '1',
    OTTO_MDNS_PRIMARY_ROUTE_ONLY: '1',
    PYTHONPATH: inheritedPythonPath,
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONNOUSERSITE: '1',
  };
}

function terminateProcessTree(proc: ChildProcess): Promise<void> {
  intentionalStops.add(proc);
  if (!proc.pid || proc.killed) return Promise.resolve();
  if (process.platform !== 'win32') {
    proc.kill('SIGTERM');
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}

export function getRadioProcessSnapshot(): RadioProcessSnapshot {
  return { ...snapshot };
}

export function ensureRadioProcess(): Promise<RadioProcessSnapshot> {
  if (snapshot.state === 'ready' && child && !child.killed) return Promise.resolve(getRadioProcessSnapshot());
  if (starting) return starting;

  const operation = new Promise<RadioProcessSnapshot>((resolve) => {
    const launchId = ++lifecycle;
    const root = ottoRoot();
    const entry = path.join(root, 'src', 'otto_master', '__main__.py');
    if (!fs.existsSync(entry)) {
      snapshot = {
        state: 'error',
        pid: null,
        url: null,
        message: 'Otto Master 启动文件缺失',
        backendReady: false,
      };
      resolve(getRadioProcessSnapshot());
      return;
    }

    snapshot = {
      state: 'starting',
      pid: null,
      url: null,
      message: '正在启动 Otto Master 服务…',
      backendReady: false,
    };
    // The bundled Windows Python uses a *_pth file and intentionally ignores
    // PYTHONPATH. Add the runtime source directory before running the module
    // so the same launcher works in development and in the packaged app.
    const moduleBootstrap = [
      'import runpy,sys',
      'sys.path.insert(0,sys.argv[1])',
      "runpy.run_module('otto_master',run_name='__main__')",
    ].join(';');
    const python = pythonExecutable();
    const proc = spawn(python, ['-c', moduleBootstrap, path.join(root, 'src')], {
      cwd: root,
      env: ottoEnvironment(root, python),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = proc;
    snapshot.pid = proc.pid ?? null;
    logger.info('otto:spawn', { pid: snapshot.pid });

    let stdout = '';
    let settled = false;
    const finish = (value: RadioProcessSnapshot, apply = launchId === lifecycle) => {
      if (apply) snapshot = value;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(getRadioProcessSnapshot());
      }
    };
    const timer = setTimeout(() => {
      if (child === proc) void terminateProcessTree(proc);
      finish({
        state: 'error',
        pid: proc.pid ?? null,
        url: null,
        message: 'Otto Master 服务启动超时',
        backendReady: false,
      });
    }, 30_000);

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-4096);
      const match = stdout.match(/OTTO_MASTER_READY:(\d+)/);
      if (match) {
        finish({
          state: 'ready',
          pid: proc.pid ?? null,
          url: `http://127.0.0.1:${match[1]}/`,
          message: 'Otto Master 已就绪',
          backendReady: true,
        });
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => logger.warn('otto:stderr', { chars: chunk.length }));
    proc.once('error', () => finish({
      state: 'error',
      pid: null,
      url: null,
      message: '无法启动 Otto Master Python 服务',
      backendReady: false,
    }));
    proc.once('close', (code) => {
      if (child === proc) child = null;
      const next: RadioProcessSnapshot = {
        state: code === 0 ? 'stopped' : 'error',
        pid: null,
        url: null,
        message: code === 0 ? 'Otto Master 已停止' : 'Otto Master 服务异常退出',
        backendReady: false,
      };
      if (intentionalStops.has(proc)) {
        if (!settled) finish({ ...next, state: 'stopped', message: 'Otto Master 已停止' }, false);
        return;
      }
      finish(next);
    });
  });
  const pending = operation.finally(() => { if (starting === pending) starting = null; });
  starting = pending;
  return starting;
}

export async function restartRadioProcess(): Promise<RadioProcessSnapshot> {
  await stopRadioProcess();
  return ensureRadioProcess();
}

export async function stopRadioProcess(): Promise<RadioProcessSnapshot> {
  lifecycle += 1;
  starting = null;
  const current = child;
  child = null;
  if (current && !current.killed) await terminateProcessTree(current);
  snapshot = {
    state: 'stopped',
    pid: null,
    url: null,
    message: 'Otto Master 已停止',
    backendReady: false,
  };
  return getRadioProcessSnapshot();
}

export function registerRadioIpc(ipcMain: IpcMain): void {
  ipcMain.handle('radio:status', () => getRadioProcessSnapshot());
  ipcMain.handle('radio:start', () => ensureRadioProcess());
  ipcMain.handle('radio:restart', () => restartRadioProcess());
  ipcMain.handle('radio:stop', () => stopRadioProcess());
}
