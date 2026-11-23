// Keep the historic verifier entry point; the persistent Agent is now Rust/Rig.
// The host fixture exercises real multi-turn execution without paid model credentials.
if (process.versions.electron) {
  require('./verify_rig_host.cjs');
} else {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'node_modules', 'electron', 'cli.js'), path.join(__dirname, 'verify_rig_host.cjs')], { stdio: 'inherit', windowsHide: true });
  process.exitCode = result.status || (result.error ? 1 : 0);
}
