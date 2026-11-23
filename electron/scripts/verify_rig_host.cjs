const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const { app } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catnip-rig-host-'));
app.setPath('userData', path.join(root, 'user-data'));
process.env.CATNIP_PROJECTS_ROOT = path.join(root, 'projects');
process.env.CATNIP_PROJECT_SESSIONS_ROOT = path.join(root, 'sessions');
process.env.CATNIP_DEEPSEEK_API_KEY_PATH = path.join(root, 'absent-key.txt');
process.env.CATNIP_QWEN_API_KEY_PATH = path.join(root, 'absent-vision.txt');
const testResources = process.env.CATNIP_RIG_TEST_RESOURCES ? path.resolve(process.env.CATNIP_RIG_TEST_RESOURCES) : null;
if (testResources) {
  Object.defineProperty(app, 'isPackaged', { value: true });
  Object.defineProperty(process, 'resourcesPath', { value: testResources });
}
const mainRoot = testResources ? path.join(testResources, 'app.asar', 'dist', 'main') : path.join(__dirname, '..', 'dist', 'main');
const secret = 'fixture-host-token-not-real';
let agent;
let runtime;
let responder;
let server;
const requests = [];
const processes = [];
function respond(res, blocks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  event({ type: 'message_start', message: { id: 'host-fixture', type: 'message', role: 'assistant', model: 'offline-host', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } });
  blocks.forEach((block, index) => {
    event({ type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
    event({ type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    event({ type: 'content_block_stop', index });
  });
  event({ type: 'message_delta', delta: { stop_reason: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
  event({ type: 'message_stop' }); res.end();
}
function observe(proc) {
  const events = []; let stderr = ''; let stdout = '';
  const lines = createInterface({ input: proc.stdout });
  lines.on('line', line => { stdout += line + '\n'; events.push(JSON.parse(line)); });
  proc.stderr.on('data', data => { stderr += data.toString(); });
  const wait = async predicate => {
    const started = Date.now();
    while (Date.now() - started < 15000) {
      const value = events.find(predicate); if (value) return value;
      if (proc.exitCode != null) throw new Error(`Host process exited: ${JSON.stringify(events)}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Host fixture timeout');
  };
  const check = () => { assert(!stdout.includes(secret)); assert(!stderr.includes(secret)); };
  const observation = { proc, events, wait, check }; processes.push(observation); return observation;
}
async function main() {
  await app.whenReady();
  server = http.createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    const body = JSON.parse(data); requests.push({ body, headers: req.headers });
    responder(body, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  agent = require(path.join(mainRoot, 'agent.js'));
  const projects = require(path.join(mainRoot, 'project-session.js'));
  const { RuntimeTools } = require(path.join(mainRoot, 'agent-tools', 'mcp.js'));
  const { Orchestrator } = require(path.join(mainRoot, 'worker', 'orchestrator.js'));
  projects.createProject('host-project-a'); const projectA = projects.getActiveProject();
  fs.writeFileSync(path.join(projectA.projectDir, 'fixture.c'), 'actual host file');
  const model = { providerId: 'offline', upstreamModel: 'offline-host', baseUrl: `http://127.0.0.1:${server.address().port}`, authToken: secret, authField: 'ANTHROPIC_AUTH_TOKEN', contextWindow: 131072, reserveTokens: 36864, maxOutputTokens: 32768, keepRecentTokens: 24000 };
  const binding = { conversationId: 'host-conversation', bootstrap: 'bootstrap-only-once-marker' };
  let count = 0;
  responder = (_body, res) => {
    count++;
    respond(res, count === 1 ? [{ type: 'tool_use', id: 'host-read', name: 'Read', input: { path: 'fixture.c' } }] : [{ type: 'text', text: 'host complete 中文' }]);
  };
  const parsed = [];
  const worker = Object.create(Orchestrator.prototype);
  Object.assign(worker, { currentConversationId: binding.conversationId, observedAgentPid: null, handleParsedChunk: chunk => parsed.push(chunk), pushUI: () => {}, stopSilenceTimer: () => {} });
  const proc = worker.ensurePersistentAgent('default', model, binding.bootstrap);
  const first = observe(proc);
  agent.sendAgentMessage('read fixture.c', 'default', model, binding);
  const result = await first.wait(e => e.type === 'result'); assert.equal(result.is_error, false, result.result);
  assert(parsed.some(e => e.type === 'text' && /host complete 中文/.test(e.content)));
  assert(parsed.some(e => e.type === 'tool_result' && /actual host file/.test(e.content)));
  assert(!parsed.some(e => /tool_request/.test(e.content)));
  assert.equal(agent.ensureAgentProcess('default', model, binding).pid, proc.pid);
  assert.equal(requests[0].headers.authorization, `Bearer ${secret}`);
  assert(requests[0].body.tools.some(tool => tool.name === 'hardboard_idf_build'));
  assert(!requests[0].body.tools.some(tool => /erase|Bash|Shell/.test(tool.name)));
  assert(requests[0].body.tools.some(tool => tool.name === 'browser_analyzeScreenshot'));
  responder = (_body, res) => respond(res, [{ type: 'text', text: 'second turn' }]);
  const previous = first.events.filter(e => e.type === 'result').length;
  agent.sendAgentMessage('continue', 'default', model, binding);
  await first.wait(() => first.events.filter(e => e.type === 'result').length > previous);
  assert.equal((JSON.stringify(requests.at(-1).body).match(/bootstrap-only-once-marker/g) || []).length, 1);
  const ended = once(proc, 'close'); agent.killAgent(); await ended;
  const restored = observe(worker.ensurePersistentAgent('default', model, binding.bootstrap));
  agent.sendAgentMessage('resume', 'default', model, binding); await restored.wait(e => e.type === 'result');
  assert(JSON.stringify(requests.at(-1).body).includes('actual host file'));
  projects.createProject('host-project-b'); const projectB = projects.getActiveProject();
  const next = observe(worker.ensurePersistentAgent('default', model, binding.bootstrap));
  const parsedBefore = parsed.length;
  restored.proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'LATE_OLD_PROJECT_OUTPUT' }] } }) + '\n'));
  assert.equal(parsed.length, parsedBefore, 'old process stdout must not mutate the new Worker task');
  agent.sendAgentMessage('project b', 'default', model, binding); await next.wait(e => e.type === 'result');
  assert(!JSON.stringify(requests.at(-1).body).includes('actual host file'));
  assert(agent.buildRigInitConfig('default', model, [], binding).sessionFile.startsWith(projectB.projectDir));
  const nextEnded = once(next.proc, 'close'); agent.killAgent(); await nextEnded;
  // A failed result can synchronously start a queued task before the failed process exits.
  responder = (_body, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'fixture transient failure' } })); };
  const failed = observe(worker.ensurePersistentAgent('default', model, binding.bootstrap));
  let replacement;
  const failureLines = createInterface({ input: failed.proc.stdout });
  failureLines.on('line', line => {
    if (JSON.parse(line).type !== 'result' || replacement) return;
    responder = (_body, res) => respond(res, [{ type: 'text', text: 'queued task recovered' }]);
    replacement = observe(worker.ensurePersistentAgent('default', model, binding.bootstrap));
    assert.notEqual(replacement.proc.pid, failed.proc.pid, 'failed runtime must be retired before Worker starts the next queued task');
    agent.sendAgentMessage('queued after failure', 'default', model, binding);
  });
  agent.sendAgentMessage('force failure', 'default', model, binding);
  assert.equal((await failed.wait(e => e.type === 'result')).is_error, true);
  assert.equal((await replacement.wait(e => e.type === 'result')).is_error, false);
  const replacementEnded = once(replacement.proc, 'close'); agent.killAgent(); await replacementEnded;
  // The real MCP server uses a project-specific store; labels cannot cross into another project.
  runtime = new RuntimeTools();
  const mcpConfig = agent.buildAgentMcpConfig('default');
  assert(mcpConfig.mcpServers['vibeide-runtime'].env.CATNIP_AGENT_RUNTIME_STORE.startsWith(projectB.projectDir));
  const tools = await runtime.connect(mcpConfig);
  assert(tools.some(tool => tool.definition.name === 'hardboard_idf_build'));
  const signal = new AbortController().signal;
  const context = { profile: 'default', projectId: projectB.id, projectDir: projectB.projectDir, conversationId: binding.conversationId, signal };
  await runtime.call('storage.save', { workspace: 'fixture', data: '{"evidence":"project-b-only"}' }, context);
  assert.match(await runtime.call('storage.read', { workspace: 'fixture' }, context), /project-b-only/);
  // A failed MCP request is reported as outcome-unknown and never replayed.
  const originalClient = runtime.client;
  let uncertainCalls = 0;
  const originalCallTool = originalClient.callTool.bind(originalClient);
  originalClient.callTool = async (input, schema, options) => {
    if (input.name === 'hardboard.idf_build') {
      uncertainCalls++;
      runtime.disconnected = true;
      throw new Error('MCP error -32000: Connection closed');
    }
    return originalCallTool(input, schema, options);
  };
  runtime.transport.stderr.emit('data', Buffer.from(`FATAL ERROR: heap out of memory ${secret}`));
  await assert.rejects(runtime.call('hardboard.idf_build', {}, context), /RUNTIME_CONNECTION_LOST:memory;TOOL_OUTCOME_UNKNOWN/);
  assert.equal(uncertainCalls, 1);
  assert.equal(runtime.diagnosticTail.length <= 4096, true);
  assert.match(await runtime.call('storage.read', { workspace: 'fixture' }, context), /project-b-only/);
  assert.equal(uncertainCalls, 1, 'reconnect must not replay the failed operation');
  const disconnectedPid = runtime.transport.pid;
  process.kill(disconnectedPid);
  for (let index = 0; index < 150 && !runtime.disconnected; index++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(runtime.disconnected, true, 'owned process close must invalidate the MCP connection');
  assert.match(await runtime.call('storage.read', { workspace: 'fixture' }, context), /project-b-only/);
  assert.notEqual(runtime.transport.pid, disconnectedPid);
  const runtimePid = runtime.transport.pid;
  await runtime.close(); runtime = null;
  assert.throws(() => process.kill(runtimePid, 0), undefined, 'owned MCP process must stop');
  const logs = fs.readdirSync(path.join(root, 'user-data'), { recursive: true }).filter(file => /\.log$/.test(file));
  for (const file of logs) assert(!fs.readFileSync(path.join(root, 'user-data', file), 'utf8').includes(secret));
  for (const observed of processes) observed.check();
  console.log('Rig Main/Worker passed: real offline Rig + MCP, file Tool dispatch, streamed Unicode, persistent PID, one-time bootstrap, restart, project isolation, stale event guard, project-scoped Runtime storage, owned process cleanup.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  agent?.killAgent(); await runtime?.close();
  for (const observed of processes) if (observed.proc.exitCode == null) observed.proc.kill();
  server?.closeAllConnections(); server?.close();
  app.quit(); fs.rmSync(root, { recursive: true, force: true });
});
