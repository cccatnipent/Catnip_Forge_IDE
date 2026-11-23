const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const cargoCandidates = [process.env.CATNIP_CARGO_BIN, path.join(os.homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo')];
const cargo = cargoCandidates.find(candidate => candidate && fs.existsSync(candidate)) || 'cargo';
const debug = process.argv.includes('--debug');
const args = ['build', '--locked', '--manifest-path', path.join(root, 'agent', 'runtime', 'Cargo.toml'), ...(debug ? [] : ['--release'])];
const child = spawn(cargo, args, { cwd: root, stdio: 'inherit', windowsHide: true });
child.once('error', () => { console.error('Rust Cargo unavailable. Install the official Rust minimal toolchain with C++ Build Tools, or set CATNIP_CARGO_BIN.'); process.exitCode = 1; });
child.once('close', code => {
  if (code !== 0) { process.exitCode = code || 1; return; }
  const name = process.platform === 'win32' ? 'catnip-agent.exe' : 'catnip-agent';
  const source = path.join(root, 'agent', 'runtime', 'target', debug ? 'debug' : 'release', name);
  const target = path.join(root, 'agent', 'bin', name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
  console.log(`Rig Agent built: ${path.relative(root, target)} (${fs.statSync(target).size} bytes)`);
});
