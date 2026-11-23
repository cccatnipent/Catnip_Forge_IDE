const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const electronRoot = path.resolve(__dirname, '..');
const versionInfo = JSON.parse(fs.readFileSync(path.join(electronRoot, '..', 'config', 'version.json'), 'utf-8'));
const outputRoot = process.env.CATNIP_PACKAGE_OUTPUT
  ? path.resolve(electronRoot, process.env.CATNIP_PACKAGE_OUTPUT)
  : path.join(electronRoot, 'dist-package');
const packageDirectoryName = 'Catnip_Forge';
const executableName = 'Catnip_Forge.exe';
const generatedPackageRoot = path.join(outputRoot, 'win-unpacked');
const packageRoot = path.join(outputRoot, packageDirectoryName);
const resourcesRoot = path.join(packageRoot, 'resources');
const exePath = path.join(packageRoot, executableName);
const builder = path.join(electronRoot, 'node_modules', 'electron-builder', 'cli.js');
const stamp = path.join(electronRoot, 'scripts', 'stamp_win_exe_version.cjs');
const localElectronDist = path.join(electronRoot, 'node_modules', 'electron', 'dist');
const requiredBundleSources = [
  path.join(electronRoot, '..', 'agent', 'bin', 'catnip-agent.exe'),
  path.join(electronRoot, '..', 'agent', 'AGENT_RULES.md'),
  path.join(electronRoot, '..', 'agent', 'board-packs', 'esp32-s3-generic', 'manifest.json'),
  path.join(electronRoot, '..', '_bundled', 'nodejs', 'node.exe'),
  path.join(electronRoot, '..', '_bundled', 'python', 'python.exe'),
  path.join(electronRoot, '..', '_bundled', 'python', 'python3.dll'),
  path.join(electronRoot, '..', '_bundled', 'python', 'opus.dll'),
  path.join(electronRoot, '..', '_bundled', 'python', 'Lib', 'site-packages', 'serial'),
  path.join(electronRoot, '..', '_bundled', 'python', 'Lib', 'site-packages', 'aiosqlite'),
  path.join(electronRoot, '..', '_bundled', 'python', 'Lib', 'site-packages', 'amqtt'),
  path.join(electronRoot, '..', '_bundled', 'python', 'Lib', 'site-packages', 'zeroconf'),
  path.join(electronRoot, '..', '_bundled', 'python', 'Lib', 'site-packages', 'click', 'core.py'),
  path.join(electronRoot, '..', '_bundled', 'python', 'Lib', 'site-packages', 'idf_component_manager', '__init__.py'),
  path.join(electronRoot, '..', '_bundled', 'playwright'),
  path.join(electronRoot, '..', 'runtime', 'otto-master', 'config.electron.yaml'),
  path.join(electronRoot, '..', 'runtime', 'otto-master', 'src', 'otto_master', '__main__.py'),
  path.join(electronRoot, '..', 'runtime', 'otto-master', 'src', 'otto_master', 'web', 'index.html'),
];
const missingBundleSources = requiredBundleSources.filter((source) => !fs.existsSync(source));

if (missingBundleSources.length) {
  console.error('[pack:win] required ignored bundle sources are missing:');
  missingBundleSources.forEach((source) => console.error(`  - ${path.relative(path.join(electronRoot, '..'), source)}`));
  console.error('[pack:win] restore _bundled resources before rebuilding win-unpacked.');
  process.exit(1);
}

const bundledPythonRoot = path.join(electronRoot, '..', '_bundled', 'python');
const bundledPython = path.join(bundledPythonRoot, 'python.exe');
const pythonProbe = spawnSync(bundledPython, ['-c', [
  'import pathlib, serial, click.core, idf_component_manager, esptool, fastapi, uvicorn, httpx, websockets, cryptography, openai, edge_tts, mcp, aiosqlite, amqtt, zeroconf, opuslib_next',
  'root = pathlib.Path(__import__("sys").executable).resolve().parent',
  'assert all(str(pathlib.Path(module.__file__).resolve()).lower().startswith(str(root).lower()) for module in [serial, click.core, idf_component_manager, esptool, fastapi, uvicorn, httpx, websockets, cryptography, openai, edge_tts, mcp, aiosqlite, amqtt, zeroconf, opuslib_next])',
].join('; ')], {
  cwd: electronRoot,
  encoding: 'utf-8',
  windowsHide: true,
  env: {
    ...process.env,
    PATH: `${bundledPythonRoot}${path.delimiter}${process.env.PATH || process.env.Path || ''}`,
    PYTHONHOME: bundledPythonRoot,
    PYTHONNOUSERSITE: '1',
  },
});
if (pythonProbe.status !== 0) {
  console.error(`[pack:win] bundled Python isolation probe failed: ${pythonProbe.stderr || pythonProbe.stdout}`);
  process.exit(pythonProbe.status || 1);
}

const relativeOutputRoot = path.relative(electronRoot, outputRoot);
if (!relativeOutputRoot || relativeOutputRoot.startsWith('..') || path.isAbsolute(relativeOutputRoot)) {
  console.error(`[pack:win] refusing to clean output outside electron workspace: ${outputRoot}`);
  process.exit(1);
}
fs.rmSync(outputRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });

const builderArgs = [
  builder, '--win', '--x64', '--dir',
  `--config.directories.output=${outputRoot}`,
  '--config.extraResources=[]',
  // This unsigned unpacked distribution is stamped by our local resedit step below.
  '--config.win.signAndEditExecutable=false',
];
if (fs.existsSync(path.join(localElectronDist, 'electron.exe'))) {
  builderArgs.push(`--config.electronDist=${localElectronDist}`);
  console.log(`[pack:win] reusing installed Electron distribution: ${localElectronDist}`);
}

const result = spawnSync(process.execPath, builderArgs, {
  cwd: electronRoot,
  stdio: 'inherit',
  env: process.env,
});

if (result.status !== 0) {
  console.error(`[pack:win] electron-builder failed (status=${result.status}, signal=${result.signal || 'none'}).`);
  if (result.error) console.error(result.error);
  process.exit(result.status || 1);
}

if (!fs.existsSync(generatedPackageRoot)) {
  console.error(`[pack:win] electron-builder output is missing: ${generatedPackageRoot}`);
  process.exit(1);
}
fs.renameSync(generatedPackageRoot, packageRoot);
const generatedExecutablePath = path.join(packageRoot, `${versionInfo.productName}.exe`);
if (!fs.existsSync(generatedExecutablePath)) {
  console.error(`[pack:win] electron-builder executable is missing: ${generatedExecutablePath}`);
  process.exit(1);
}
fs.renameSync(generatedExecutablePath, exePath);
console.log(`[pack:win] renamed package directory: ${path.basename(packageRoot)}`);
console.log(`[pack:win] renamed executable: ${path.basename(exePath)}`);

function copyTree(source, target, excluded = () => false) {
  if (!fs.existsSync(source)) throw new Error(`[pack:win] missing resource source: ${source}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, {
    recursive: true,
    force: true,
    filter: (candidate) => {
      const relative = path.relative(source, candidate).replace(/\\/g, '/');
      return !excluded(relative, path.basename(candidate));
    },
  });
}

function hasSegment(relative, names) {
  return relative.split('/').some((segment) => names.has(segment));
}

const bundledProjectNames = new Set(['hello_world_esp32s3', 'otto_rainbow_cat', 'touch_hello', 'wifi_connect_fmai']);
function isPersonalHardboardTree(relative) {
  const [root, name] = relative.split('/');
  return root === 'git-snapshots' || (root === 'projects' && name && !bundledProjectNames.has(name));
}

console.log('[pack:win] copying packaged resources in the top-level process');
copyTree(path.join(electronRoot, 'apikey.txt.example'), path.join(resourcesRoot, 'apikey.txt.example'));
copyTree(path.join(electronRoot, 'CATNIP_FORGE_USER_GUIDE.md'), path.join(resourcesRoot, 'CATNIP_FORGE_USER_GUIDE.md'));
copyTree(path.join(electronRoot, 'assets', 'icon.ico'), path.join(resourcesRoot, 'electron', 'assets', 'icon.ico'));
copyTree(path.join(electronRoot, 'assets', 'icon.png'), path.join(resourcesRoot, 'electron', 'assets', 'icon.png'));
copyTree(path.join(electronRoot, '..', 'agent'), path.join(resourcesRoot, 'agent'), (relative) => {
  const first = relative.split('/')[0];
  return new Set(['logs', 'screenshots', 'recordings', 'node_modules', 'runtime', '.claude', '.catnip']).has(first)
    || relative.endsWith('.html') || relative.endsWith('.png')
    || relative.includes('node_modules/.cache/');
});
copyTree(path.join(electronRoot, '..', 'runtime', 'dist'), path.join(resourcesRoot, 'runtime', 'dist'));
copyTree(path.join(electronRoot, '..', 'runtime', 'package.json'), path.join(resourcesRoot, 'runtime', 'package.json'));
copyTree(path.join(electronRoot, '..', 'runtime', 'node_modules'), path.join(resourcesRoot, 'runtime', 'node_modules'), (relative) => (
  hasSegment(relative, new Set(['.cache', 'chrome_profile', 'recordings', 'workflows', 'logs']))
));
copyTree(path.join(electronRoot, '..', 'runtime', 'hardboard'), path.join(resourcesRoot, 'runtime', 'hardboard'), (relative) => (
  hasSegment(relative, new Set(['build', '.git', '.cache', '.catnip', '__pycache__', 'logs', 'events']))
  || isPersonalHardboardTree(relative)
  || /(?:^|\/)esptools\/esp-idf-v[^/]+\/esp-idf\/examples(?:\/|$)/.test(relative)
  || /(?:^|\/)idf-tools\/python_env(?:\/|$)/.test(relative)
));
copyTree(path.join(electronRoot, '..', 'scripts'), path.join(resourcesRoot, 'scripts'), (relative) => hasSegment(relative, new Set(['__pycache__'])));
copyTree(path.join(electronRoot, '..', 'config'), path.join(resourcesRoot, 'config'));
copyTree(path.join(electronRoot, '..', '_bundled', 'nodejs'), path.join(resourcesRoot, 'runtime', 'nodejs'));
copyTree(path.join(electronRoot, '..', '_bundled', 'python'), path.join(resourcesRoot, 'runtime', 'python'), (_relative, name) => name.startsWith('python312._pth.disabled'));
copyTree(path.join(electronRoot, '..', '_bundled', 'python', 'python.exe'), path.join(resourcesRoot, 'runtime', 'python', 'Scripts', 'python.exe'));
copyTree(path.join(electronRoot, '..', '_bundled', 'python', 'python312.dll'), path.join(resourcesRoot, 'runtime', 'python', 'Scripts', 'python312.dll'));
// Native abi3 extensions resolve python3.dll beside Scripts/python.exe.
copyTree(path.join(electronRoot, '..', '_bundled', 'python', 'python3.dll'), path.join(resourcesRoot, 'runtime', 'python', 'Scripts', 'python3.dll'));
copyTree(path.join(electronRoot, '..', 'runtime', 'python', 'python312-scripts._pth'), path.join(resourcesRoot, 'runtime', 'python', 'Scripts', 'python312._pth'));
copyTree(path.join(electronRoot, '..', 'runtime', 'python', 'sitecustomize.py'), path.join(resourcesRoot, 'runtime', 'python', 'Lib', 'site-packages', 'sitecustomize.py'));
copyTree(path.join(electronRoot, '..', '_bundled', 'playwright'), path.join(resourcesRoot, 'runtime', 'playwright'));
copyTree(path.join(electronRoot, '..', 'runtime', 'otto-master'), path.join(resourcesRoot, 'runtime', 'otto-master'), (relative) => (
  hasSegment(relative, new Set([
    'data', 'logs', 'firmware', '.local-secrets', '.venv', 'tests', 'docs', 'scripts',
    '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  ]))
  || path.basename(relative) === '.env'
  || path.basename(relative).startsWith('.env.')
  || relative.endsWith('.pyc')
));

for (const forbidden of ['apikey.txt', 'qwen-apikey.txt']) {
  if (fs.existsSync(path.join(resourcesRoot, forbidden))) {
    console.error(`[pack:win] forbidden credential file exists in package: resources/${forbidden}`);
    process.exit(1);
  }
}

const forbiddenMutableRoots = [
  path.join(resourcesRoot, 'agent', 'logs'),
  path.join(resourcesRoot, 'agent', 'screenshots'),
  path.join(resourcesRoot, 'agent', 'recordings'),
  path.join(resourcesRoot, 'runtime', 'logs'),
  path.join(resourcesRoot, 'runtime', 'chrome_profile'),
  path.join(resourcesRoot, 'runtime', 'recordings'),
  path.join(resourcesRoot, 'runtime', 'workflows'),
  path.join(resourcesRoot, 'runtime', 'attachments'),
  path.join(resourcesRoot, 'runtime', 'hardboard', 'logs'),
  path.join(resourcesRoot, 'runtime', 'hardboard', 'events'),
  path.join(resourcesRoot, 'runtime', 'otto-master', 'data'),
  path.join(resourcesRoot, 'runtime', 'otto-master', 'logs'),
  path.join(resourcesRoot, 'runtime', 'otto-master', '.local-secrets'),
  path.join(resourcesRoot, 'runtime', 'otto-master', 'firmware'),
];
const forbiddenStateNames = new Set([
  '.env', '.catnip', 'apikey.txt', 'qwen-apikey.txt',
  'credentials.json', 'knowledge.json', 'conversations.json',
  'radio.sqlite3', 'service.token', 'vault.key', 'otto.db', 'otto-master.jsonl', 'mqtt-credentials.json',
]);
const leakedState = [];
for (const mutableRoot of forbiddenMutableRoots) {
  if (fs.existsSync(mutableRoot)) leakedState.push(path.relative(packageRoot, mutableRoot));
}
const pendingStateScan = [resourcesRoot];
while (pendingStateScan.length) {
  const current = pendingStateScan.pop();
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const candidate = path.join(current, entry.name);
    if (forbiddenStateNames.has(entry.name.toLowerCase())) {
      leakedState.push(path.relative(packageRoot, candidate));
      continue;
    }
    if (entry.isDirectory()) pendingStateScan.push(candidate);
  }
}
if (leakedState.length) {
  console.error('[pack:win] refusing package containing credentials, conversations, knowledge, logs, browser profiles, or project state:');
  leakedState.slice(0, 50).forEach((relative) => console.error(`  - ${relative}`));
  process.exit(1);
}

const stampResult = spawnSync(process.execPath, [stamp, exePath], {
  cwd: electronRoot,
  stdio: 'inherit',
  env: process.env,
});

process.exit(stampResult.status || 0);
