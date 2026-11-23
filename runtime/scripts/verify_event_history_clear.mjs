import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeide-event-clear-'));
const eventsDir = path.join(testRoot, 'hardboard', 'events');
const logsDir = path.join(testRoot, 'hardboard', 'logs');

try {
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(eventsDir, 'events.jsonl'), [
    JSON.stringify({ seq: 1, id: 'one', time: Date.now(), source: 'test', kind: 'tool.completed' }),
    JSON.stringify({ seq: 2, id: 'two', time: Date.now(), source: 'test', kind: 'hardboard.build.completed' }),
  ].join('\n') + '\n', 'utf-8');
  fs.writeFileSync(path.join(eventsDir, 'state.json'), JSON.stringify({
    generatedAt: Date.now(),
    lastSeq: 2,
    lastHeartbeatAt: null,
    activeTaskId: null,
    activeToolName: null,
    activeProjectDir: null,
    activePid: 999999,
    phase: 'build',
    status: 'running',
    progress: 100,
    currentFile: null,
    currentPort: null,
    files: [],
    recent: [],
    lastError: null,
  }), 'utf-8');
  fs.writeFileSync(path.join(logsDir, 'build.stdout.log'), 'build output', 'utf-8');
  fs.writeFileSync(path.join(logsDir, 'build.stderr.log'), 'build error', 'utf-8');
  fs.writeFileSync(path.join(logsDir, 'keep.txt'), 'must remain', 'utf-8');

  process.env.RUNTIME_ROOT = testRoot;
  const { appendRuntimeEvent, clearRuntimeEventHistory, getRecentRuntimeEvents } = await import('../dist/eventbus/event-store.js');
  const result = clearRuntimeEventHistory();

  assert.equal(result.ok, true);
  assert.equal(result.eventsRemoved, 2);
  assert.equal(result.logsRemoved, 2);
  assert.equal(result.state.lastSeq, 0);
  assert.equal(result.state.status, 'idle');
  assert.equal(fs.existsSync(path.join(eventsDir, 'events.jsonl')), false);
  assert.equal(fs.existsSync(path.join(logsDir, 'build.stdout.log')), false);
  assert.equal(fs.existsSync(path.join(logsDir, 'build.stderr.log')), false);
  assert.equal(fs.existsSync(path.join(logsDir, 'keep.txt')), true);
  assert.deepEqual(getRecentRuntimeEvents(), []);

  // Simulate another process advancing the shared stream while this module
  // still holds the old in-memory sequence from the clear operation.
  const externalEvent = { seq: 50, id: 'external-writer', time: Date.now(), source: 'test', kind: 'heartbeat' };
  fs.writeFileSync(path.join(eventsDir, 'events.jsonl'), `${JSON.stringify(externalEvent)}\n{"partial":`, 'utf-8');
  fs.writeFileSync(path.join(eventsDir, 'state.json'), JSON.stringify({
    ...result.state,
    lastSeq: 50,
    recent: [externalEvent],
  }), 'utf-8');
  const resumed = appendRuntimeEvent({ source: 'test', kind: 'tool.started', message: 'resumed writer' });
  assert.equal(resumed.seq, 51);
  assert.equal(JSON.parse(fs.readFileSync(path.join(eventsDir, 'state.json'), 'utf-8')).lastSeq, 51);
  assert.deepEqual(getRecentRuntimeEvents(50).map((event) => event.id), [resumed.id]);

  const writerCode = [
    "import('./dist/eventbus/event-store.js').then(({ appendRuntimeEvent }) => {",
    "  for (let index = 0; index < 20; index += 1) appendRuntimeEvent({ source: 'parallel-test', kind: 'heartbeat' });",
    '});',
  ].join('\n');
  await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', writerCode], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, RUNTIME_ROOT: testRoot },
      stdio: 'pipe',
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`parallel writer failed (${code}): ${stderr}`)));
  })));
  const concurrentEvents = getRecentRuntimeEvents(50);
  assert.equal(concurrentEvents.length, 121);
  assert.equal(new Set(concurrentEvents.map((event) => event.seq)).size, concurrentEvents.length);
  assert.deepEqual(concurrentEvents.map((event) => event.seq), Array.from({ length: 121 }, (_, index) => index + 51));
  assert.equal(JSON.parse(fs.readFileSync(path.join(eventsDir, 'state.json'), 'utf-8')).lastSeq, 171);

  // Growing archives must never be reread in full on every Build event or UI poll.
  const archivePath = path.join(eventsDir, 'events.jsonl');
  fs.writeFileSync(archivePath, 'x'.repeat(3 * 1024 * 1024) + '\n' + JSON.stringify({ seq: 200, kind: 'heartbeat' }) + '\n{"partial":');
  const originalReadFile = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    assert.notEqual(path.resolve(String(file)), archivePath, 'event archive reads must be bounded');
    return originalReadFile.call(this, file, ...args);
  };
  try {
    const bounded = appendRuntimeEvent({ source: 'test', kind: 'heartbeat', message: '中文 tail' });
    assert.equal(bounded.seq, 201);
    assert.deepEqual(getRecentRuntimeEvents(199).map(event => event.seq), [200, 201]);
  } finally { fs.readFileSync = originalReadFile; }
  console.log('event history clear and concurrent multi-writer sequence smoke ok');
} finally {
  const tempRoot = path.resolve(os.tmpdir());
  const resolvedTestRoot = path.resolve(testRoot);
  assert(resolvedTestRoot.startsWith(`${tempRoot}${path.sep}`));
  assert(path.basename(resolvedTestRoot).startsWith('vibeide-event-clear-'));
  fs.rmSync(resolvedTestRoot, { recursive: true, force: true });
}
