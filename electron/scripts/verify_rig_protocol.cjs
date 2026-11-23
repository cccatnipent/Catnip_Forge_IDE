const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');

const binary = process.env.CATNIP_RIG_TEST_BINARY ? path.resolve(process.env.CATNIP_RIG_TEST_BINARY) : path.resolve(__dirname, '..', '..', 'agent', 'bin', process.platform === 'win32' ? 'catnip-agent.exe' : 'catnip-agent');
const secret = 'fixture-key-not-a-real-credential';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catnip-rig-protocol-'));
const children = new Set();
let responder;
let requests = [];
let responseId = 0;
function tool(name = 'Read', input = { path: 'main.c' }, id = `fixture-tool-${++responseId}`) { return { type: 'tool_use', id, name, input }; }
function text(value) { return { type: 'text', text: value }; }
function respond(res, content, stopReason) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  event({ type: 'message_start', message: { id: `fixture-${++responseId}`, type: 'message', role: 'assistant', model: 'offline-fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  content.forEach((block, index) => {
    event({ type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : block.type === 'thinking' ? { type: 'thinking', thinking: '' } : { ...block, input: {} } });
    if (block.type === 'text') { for (const value of block.deltas || [block.text]) event({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: value } }); }
    else if (block.type === 'thinking') {
      for (const thinking of block.deltas || [block.thinking]) event({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } });
      event({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'fixture-signature' } });
    } else event({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    event({ type: 'content_block_stop', index });
  });
  event({ type: 'message_delta', delta: { stop_reason: stopReason || (content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'), stop_sequence: null }, usage: { output_tokens: 30 } });
  event({ type: 'message_stop' });
  res.end();
}
const server = http.createServer(async (req, res) => {
  try {
    let data = '';
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    requests.push({ body, headers: req.headers, url: req.url });
    await responder(body, res, req);
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'FIXTURE_FAILED' } }));
  }
});
function config(overrides = {}) {
  return { profile: 'default', systemPrompt: 'Offline test. Preserve actual evidence.', model: 'offline-fixture', baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: secret, authField: 'ANTHROPIC_AUTH_TOKEN', tools: [{ name: 'Read', description: 'read text', parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false } }], sessionFile: path.join(root, 'history.jsonl'), bootstrap: null, contextWindow: 32768, reserveTokens: 8192, keepRecentTokens: 3000, ...overrides };
}
function launch(settings) {
  const proc = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  children.add(proc);
  const events = []; let all = ''; let stderr = '';
  const lines = createInterface({ input: proc.stdout });
  lines.on('line', line => { all += line + '\n'; events.push(JSON.parse(line)); });
  proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
  proc.once('close', () => children.delete(proc));
  const send = value => proc.stdin.write(JSON.stringify(value) + '\n');
  const wait = async (predicate, timeout = 10000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const value = events.find(predicate);
      if (value) return value;
      if (proc.exitCode != null) throw new Error(`Rust exited: ${JSON.stringify(events)} ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Rust timeout: ${JSON.stringify(events)} ${stderr}`);
  };
  const close = async () => {
    if (proc.exitCode == null) { const ended = once(proc, 'close'); proc.kill(); await ended; }
    assert(!all.includes(secret), 'credential leaked to stdout');
    assert(!stderr.includes(secret), 'credential leaked to stderr');
  };
  send({ type: 'init', config: settings });
  return { proc, events, send, wait, close, transcript: () => all };
}
const user = value => ({ type: 'user', message: { content: value } });
const archive = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // Actual Rig HTTP streaming, tool pair persistence, model/auth selection, multi-turn and restart.
  let count = 0;
  responder = async (body, res) => { count++; respond(res, count === 1 ? [text('reading 工程'), tool()] : [text('verified 中文 result')]); };
  let settings = config();
  let child = launch(settings);
  await child.wait(e => e.subtype === 'init'); child.send(user('read main.c'));
  const call = await child.wait(e => e.type === 'tool_request');
  assert.equal(call.name, 'Read');
  child.send({ type: 'tool_response', id: call.id, content: 'actual-file-content', isError: false });
  assert.equal((await child.wait(e => e.type === 'result')).is_error, false);
  assert(requests[1].body.messages.some(m => m.content.some(b => b.type === 'tool_result' && JSON.stringify(b.content).includes('actual-file-content'))));
  assert.equal(requests[0].headers.authorization, `Bearer ${secret}`); assert.equal(requests[0].headers['x-api-key'], undefined);
  assert.equal(requests[0].body.model, 'offline-fixture');
  assert.equal(requests[0].url, '/v1/messages');
  await child.close();
  assert.equal(archive(settings.sessionFile).filter(e => e.type === 'message').length, 4);
  requests = []; responder = async (body, res) => respond(res, [text('restored')]);
  child = launch(settings); await child.wait(e => e.subtype === 'init'); child.send(user('continue')); await child.wait(e => e.type === 'result'); await child.close();
  assert(requests[0].body.messages.some(m => JSON.stringify(m).includes('actual-file-content')));
  // No history is shared with another project/session and x-api-key stays separate from bearer.
  requests = []; settings = config({ sessionFile: path.join(root, 'project-b', 'history.jsonl'), authField: 'ANTHROPIC_API_KEY' });
  child = launch(settings); await child.wait(e => e.subtype === 'init'); child.send(user('project B')); await child.wait(e => e.type === 'result'); await child.close();
  assert(!JSON.stringify(requests[0].body).includes('actual-file-content')); assert.equal(requests[0].headers['x-api-key'], secret); assert.equal(requests[0].headers.authorization, undefined);
  // A crash after a persisted tool call never replays the old operation.
  settings = config({ sessionFile: path.join(root, 'interrupted.jsonl') });
  responder = async (body, res) => respond(res, [tool('Read', { path: 'interrupted.c' }, 'interrupt-call')]);
  child = launch(settings); await child.wait(e => e.subtype === 'init'); child.send(user('interruption')); await child.wait(e => e.type === 'tool_request'); await child.close();
  requests = []; responder = async (body, res) => respond(res, [text('inspect state before retry')]);
  child = launch(settings); await child.wait(e => e.subtype === 'init'); child.send(user('resume safely')); await child.wait(e => e.type === 'result');
  assert(!child.events.some(e => e.type === 'tool_request')); assert.match(JSON.stringify(requests[0].body), /INTERRUPTED_TOOL_OUTCOME_UNKNOWN/); await child.close();
  // Budget compaction appends a boundary while retaining all original messages and recent input.
  const compactionFile = path.join(root, 'compact.jsonl');
  const entries = archive(path.join(root, 'history.jsonl')).slice(0, 4);
  // Generate histories with real Rig message shapes obtained above, including a complete tool pair.
  const oldUser = JSON.parse(JSON.stringify(entries[0])); const oldAnswer = JSON.parse(JSON.stringify(entries[3]));
  oldUser.message.content = [{ type: 'text', text: 'old-important-evidence '.repeat(1200) }];
  const records = [...entries, oldUser, oldAnswer];
  fs.writeFileSync(compactionFile, records.map(e => JSON.stringify(e)).join('\n') + '\n');
  requests = []; responder = async (body, res) => respond(res, [text(JSON.stringify(body.system).includes('归纳') ? 'Goal: continue. Done: read main.c. Constraints: user confirmation. Evidence: actual-file-content.' : 'after compaction')]);
  settings = config({ sessionFile: compactionFile, contextWindow: 16384, keepRecentTokens: 500 });
  child = launch(settings); await child.wait(e => e.subtype === 'init'); child.send(user('recent-current-input')); const compactResult = await child.wait(e => e.type === 'result');
  assert.equal(compactResult.is_error, false, compactResult.result); assert(child.events.some(e => e.subtype === 'compaction_end')); await child.close();
  const compacted = archive(compactionFile); assert(compacted.some(e => e.type === 'compaction')); assert(compacted.length > records.length);
  assert.deepEqual(compacted.slice(0, records.length), records); assert.match(JSON.stringify(requests.at(-1).body), /recent-current-input/);
  // Protected reference text is independent of the summary and survives restart/multiple compactions.
  const protectedText = JSON.stringify({ source: 'project', documents: [{ document: 'hardware/HARDWARE.md', content: 'raw-pin=12;panel-vendor=UNKNOWN;do-not-initialize-shared-actuator' }] });
  settings = config({ sessionFile: path.join(root, 'protected.jsonl'), contextWindow: 16384, keepRecentTokens: 500, protectedContext: protectedText, maxOutputTokens: 4096 });
  fs.writeFileSync(settings.sessionFile, records.map(e => JSON.stringify(e)).join('\n') + '\n');
  requests = [];
  child = launch(settings); await child.wait(e => e.subtype === 'init'); child.send(user('keep-board-current')); await child.wait(e => e.type === 'result'); await child.close();
  const boardRequest = requests.at(-1).body;
  assert(JSON.stringify(boardRequest).includes(JSON.stringify(protectedText).slice(1, -1)));
  const boardUsage = child.events.filter(e => e.subtype === 'context_usage').at(-1).context;
  assert(boardUsage.protectedTokens > 0); assert.equal(boardUsage.compactionCount, 1);
  assert.equal(boardUsage.remainingTokens, boardUsage.contextWindow - boardUsage.usedTokens);
  assert.equal(boardUsage.providerInputTokens, 100); assert.equal(boardUsage.providerOutputTokens, 30);
  requests = [];
  responder = async (body, res) => respond(res, [text(JSON.stringify(body.system).includes('归纳') ? 'Goal: preserve board original and current task; no hardware authorization.' : JSON.stringify(body.messages).includes('old-again') ? 'old response '.repeat(500) : 'after second compaction')]);
  child = launch(settings); await child.wait(e => e.subtype === 'init'); child.send(user('old-again '.repeat(1900))); await child.wait(e => e.type === 'result');
  const resultCount = child.events.filter(e => e.type === 'result').length;
  child.send(user('compact-again')); await child.wait(() => child.events.filter(e => e.type === 'result').length > resultCount); await child.close();
  assert(child.events.some(e => e.subtype === 'context_usage' && e.context.compactionCount === 2));
  assert(requests.at(-1).body.messages.some(m => m.content?.some(b => b.text?.endsWith(protectedText))));
  assert.deepEqual(archive(settings.sessionFile).slice(0, records.length), records);
  // A single long tool loop compacts only between fully resolved pairs, without a new user turn.
  let loopCount = 0; requests = [];
  responder = async (body, res) => {
    if (JSON.stringify(body.system).includes('归纳')) return respond(res, [text('Goal: keep current task. Done: completed tool pairs. Constraints: Build only; no Flash/Serial.')]);
    loopCount++; respond(res, loopCount <= 3 ? [tool('Read', { path: `loop-${loopCount}.c` }, `loop-${loopCount}`)] : [text('loop completed')]);
  };
  child = launch(config({ sessionFile: path.join(root, 'long-loop.jsonl'), contextWindow: 16384, keepRecentTokens: 500, protectedContext: protectedText }));
  await child.wait(e => e.subtype === 'init'); child.send(user('single-long-task'));
  for (let index = 1; index <= 3; index++) {
    const pending = await child.wait(e => e.type === 'tool_request' && e.id === `loop-${index}`);
    child.send({ type: 'tool_response', id: pending.id, content: 'large actual result '.repeat(800), isError: false });
  }
  assert.equal((await child.wait(e => e.type === 'result')).is_error, false); await child.close();
  assert(child.events.some(e => e.subtype === 'compaction_end'));
  assert(requests.at(-1).body.messages.some(m => m.content?.some(b => b.text?.endsWith(protectedText))));
  // Requested 1M window and output budget are real protocol settings, not model name decorations.
  requests = []; responder = async (_body, res) => respond(res, [text('one million configured')]);
  child = launch(config({ sessionFile: null, contextWindow: 1000000, reserveTokens: 80000, maxOutputTokens: 32768 }));
  await child.wait(e => e.subtype === 'init'); child.send(user('one million')); await child.wait(e => e.type === 'result'); await child.close();
  assert.equal(requests[0].body.max_tokens, 32768); assert.equal(child.events.find(e => e.subtype === 'context_usage').context.contextWindow, 1000000);
  // Truncated responses never execute even valid-looking partial Tool calls and report the exact reason.
  responder = async (_body, res) => respond(res, [tool('Read', { path: 'truncated.c' })], 'max_tokens');
  child = launch(config({ sessionFile: null })); await child.wait(e => e.subtype === 'init'); child.send(user('truncated'));
  assert.equal((await child.wait(e => e.type === 'result')).result, 'MODEL_OUTPUT_LIMIT_REACHED'); assert(!child.events.some(e => e.type === 'tool_request'));
  assert(child.events.some(e => e.subtype === 'model_diagnostic' && /stop=output_limit/.test(e.message))); await child.close();
  responder = async (_body, res) => respond(res, [text('refused')], 'refusal');
  child = launch(config({ sessionFile: null })); await child.wait(e => e.subtype === 'init'); child.send(user('provider failure'));
  assert.equal((await child.wait(e => e.type === 'result')).result, 'MODEL_RESPONSE_FAILED'); await child.close();
  settings = config({ sessionFile: compactionFile, contextWindow: 16384, keepRecentTokens: 500 });
  // Failed compaction keeps the previous projection/archive and returns an explicit failure.
  fs.writeFileSync(compactionFile, records.map(e => JSON.stringify(e)).join('\n') + '\n');
  responder = async (body, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: secret } })); };
  child = launch(settings); await child.wait(e => e.subtype === 'init'); child.send(user('failure-input')); assert.equal((await child.wait(e => e.type === 'result')).is_error, true); await child.close();
  assert(!archive(compactionFile).some(e => e.type === 'compaction')); assert.deepEqual(archive(compactionFile).slice(0, records.length), records);
  // Runtime profile rejects tools even if an upstream replies with a forbidden name.
  responder = async (body, res) => respond(res, [tool('Write', { path: 'forbidden.c', content: 'x' })]);
  child = launch(config({ profile: 'explore_analysis', sessionFile: null })); await child.wait(e => e.subtype === 'init'); child.send(user('analysis'));
  assert.equal((await child.wait(e => e.type === 'result')).is_error, true); assert(!child.events.some(e => e.type === 'tool_request')); await child.close();
  // Persisted corrupt data must be preserved rather than silently reset.
  fs.writeFileSync(path.join(root, 'corrupt.jsonl'), 'original-corrupt-line\n');
  child = launch(config({ sessionFile: path.join(root, 'corrupt.jsonl') })); assert.equal((await child.wait(e => e.type === 'result')).result, 'SESSION_CORRUPTED_PRESERVED'); await child.close();
  assert.equal(fs.readFileSync(path.join(root, 'corrupt.jsonl'), 'utf8'), 'original-corrupt-line\n');
  responder = async (_body, res) => respond(res, [tool('Read', { path: secret })]);
  child = launch(config({ sessionFile: null })); await child.wait(e => e.subtype === 'init'); child.send(user('refuse credential tool arguments'));
  assert.equal((await child.wait(e => e.type === 'result')).result, 'TOOL_CREDENTIAL_ARGUMENT_REFUSED'); assert(!child.events.some(e => e.type === 'tool_request')); await child.close();
  // One process handles successive user turns and supplies complete multi-call result pairs.
  requests = []; let multiCount = 0;
  responder = async (_body, res) => { multiCount++; respond(res, multiCount === 1 ? [tool('Read', { path: 'a.c' }, 'multi-a'), tool('Read', { path: 'b.c' }, 'multi-b')] : [text('multi complete')]); };
  child = launch(config({ sessionFile: null })); await child.wait(e => e.subtype === 'init');
  child.send(user('two calls'));
  for (const id of ['multi-a', 'multi-b']) {
    const nextCall = await child.wait(e => e.type === 'tool_request' && e.id === id);
    child.send({ type: 'tool_response', id: nextCall.id, content: `evidence-${id}`, isError: id === 'multi-b' });
  }
  assert.equal((await child.wait(e => e.type === 'result')).is_error, false);
  const followUp = JSON.stringify(requests.at(-1).body); assert.match(followUp, /evidence-multi-a/); assert.match(followUp, /evidence-multi-b/);
  const previousResults = child.events.filter(e => e.type === 'result').length; const pid = child.proc.pid;
  child.send(user('same process next turn'));
  await child.wait(() => child.events.filter(e => e.type === 'result').length > previousResults); assert.equal(child.proc.pid, pid); await child.close();
  // Provider-reported overflow retries once with a compaction; a second overflow is explicit.
  let overflowCount = 0; requests = [];
  settings = config({ sessionFile: path.join(root, 'overflow.jsonl'), contextWindow: 131072, keepRecentTokens: 500 });
  fs.writeFileSync(settings.sessionFile, records.map(e => JSON.stringify(e)).join('\n') + '\n');
  responder = async (body, res) => {
    if (JSON.stringify(body.system).includes('归纳')) return respond(res, [text('Goal: preserve file evidence. Done: Read main.c. Constraints: inspect before retry. Next: continue.')]);
    overflowCount++;
    if (overflowCount === 1) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'context window exceeded' } })); }
    else respond(res, [text('overflow recovered')]);
  };
  child = launch(settings); await child.wait(e => e.subtype === 'init'); child.send(user('recover overflow'));
  assert.equal((await child.wait(e => e.type === 'result')).is_error, false); assert.equal(overflowCount, 2); assert(child.events.some(e => e.subtype === 'compaction_end')); await child.close();
  assert.deepEqual(archive(settings.sessionFile).slice(0, records.length), records);
  // The restricted protocol submits only a validated single StructuredOutput call.
  const plan = { schemaVersion: 1, requestId: 'fixture-plan', mode: 'plan', plan: { summary: 'inspect board first', steps: [{ id: 'step-1', title: 'Confirm display', detail: 'Read exact board documentation before creating firmware.' }], risks: ['display unknown'] } };
  responder = async (_body, res) => respond(res, [tool('StructuredOutput', plan, 'structured-plan')]);
  child = launch(config({ profile: 'explore_plan', sessionFile: null, tools: [{ name: 'StructuredOutput', description: 'submit plan', parameters: { type: 'object' } }] }));
  await child.wait(e => e.subtype === 'init'); child.send(user('plan only'));
  const planCall = await child.wait(e => e.type === 'tool_request'); assert.equal(planCall.name, 'StructuredOutput');
  child.send({ type: 'tool_response', id: planCall.id, content: 'STRUCTURED_OUTPUT_VALIDATED', isError: false });
  const planResult = await child.wait(e => e.type === 'result'); assert.equal(planResult.is_error, false); assert.deepEqual(planResult.structured_output, plan); await child.close();
  // JSON escaping must not hide a credential from redaction, including initial bootstrap.
  const escapedCredential = 'fixture-"quoted-credential';
  const escapedSession = path.join(root, 'escaped.jsonl');
  responder = async (_body, res) => respond(res, [text(`echo ${escapedCredential}`)]);
  child = launch(config({ apiKey: escapedCredential, bootstrap: `legacy ${escapedCredential}`, sessionFile: escapedSession }));
  await child.wait(e => e.subtype === 'init'); child.send(user('redaction')); await child.wait(e => e.type === 'result');
  assert(!JSON.stringify(child.events).includes(escapedCredential));
  const escapedArchive = archive(escapedSession); assert(!JSON.stringify(escapedArchive).includes(JSON.stringify(escapedCredential).slice(1, -1)));
  assert(escapedArchive.every(e => !JSON.stringify(e).includes('quoted-credential'))); await child.close();
  // One streamed response keeps one ID across split Unicode/Markdown; the next request gets a new ID.
  const answerDeltas = ['中文说明 '.repeat(500) + secret.slice(0, 8), secret.slice(8), '\n\n| 现象 | 调整 |\n| --- | --- |\n| 背光', '亮 | 保留空格 ', '|\n\n```c\n  return 0;\n```\n'];
  responder = async (_body, res) => respond(res, [{ type: 'text', deltas: answerDeltas }]);
  child = launch(config({ sessionFile: null })); await child.wait(e => e.subtype === 'init'); child.send(user('stream complete Markdown'));
  await child.wait(e => e.type === 'result');
  const answerBlocks = child.events.flatMap(e => e.message?.content || []).filter(b => b.type === 'text');
  assert(answerBlocks.length >= 2); assert.equal(new Set(answerBlocks.map(b => b.id)).size, 1);
  assert.match(answerBlocks[0].id, /^rig-text-[1-9][0-9]*$/);
  assert.equal(answerBlocks.map(b => b.text).join(''), answerDeltas.join('').replace(secret, '[credential redacted]'));
  const beforeNext = child.events.length; child.send(user('next response'));
  while (!child.events.slice(beforeNext).some(e => e.type === 'result')) await new Promise(resolve => setTimeout(resolve, 10));
  assert(child.events.slice(beforeNext).flatMap(e => e.message?.content || []).filter(b => b.type === 'text').every(b => b.id !== answerBlocks[0].id));
  await child.close();
  // Provider reasoning deltas reach UI before tools, are redacted across chunks, and stay separate from answers.
  requests = [];
  const reasoningDeltas = ['先确认资料。'.repeat(500) + secret.slice(0, 8), secret.slice(8) + '再编写应用。'];
  responder = async (_body, res) => respond(res, [{ type: 'thinking', deltas: reasoningDeltas }, text('visible final answer')]);
  child = launch(config({ sessionFile: null })); await child.wait(e => e.subtype === 'init'); child.send(user('show actual thinking'));
  assert.equal((await child.wait(e => e.type === 'result')).is_error, false);
  const thinkingBlocks = child.events.flatMap(e => e.message?.content || []).filter(b => b.type === 'thinking');
  assert(thinkingBlocks.length >= 2); assert.equal(new Set(thinkingBlocks.map(b => b.id)).size, 1);
  assert.equal(thinkingBlocks.map(b => b.thinking).join(''), reasoningDeltas.join('').replace(secret, '[credential redacted]'));
  const activity = child.events.filter(e => e.subtype === 'model_activity').map(e => e.activity);
  assert.equal(activity[0].phase, 'waiting'); assert(activity.some(e => e.phase === 'thinking' && e.reasoningBytes > 0));
  assert(activity.some(e => e.phase === 'responding')); assert.equal(activity.at(-1).phase, 'complete'); await child.close();
  // An upstream HTTP402 remains explicit, with a failed activity state and no replay.
  let unavailableRequests = 0;
  responder = async (_body, res) => { unavailableRequests++; res.writeHead(402, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: secret } })); };
  child = launch(config({ sessionFile: null })); await child.wait(e => e.subtype === 'init'); child.send(user('account unavailable'));
  assert.equal((await child.wait(e => e.type === 'result')).result, 'MODEL_REQUEST_FAILED_HTTP_402');
  assert.equal(unavailableRequests, 1); assert.equal(child.events.filter(e => e.subtype === 'model_activity').at(-1).activity.phase, 'failed'); await child.close();
  // Restricted analysis never forwards reasoning to the engineering chat stream.
  responder = async (_body, res) => respond(res, [{ type: 'thinking', thinking: 'restricted private reasoning' }, tool('StructuredOutput', plan)]);
  child = launch(config({ profile: 'explore_plan', sessionFile: null, tools: [{ name: 'StructuredOutput', description: 'submit plan', parameters: { type: 'object' } }] }));
  await child.wait(e => e.subtype === 'init'); child.send(user('plan without engineering reasoning'));
  const restrictedCall = await child.wait(e => e.type === 'tool_request'); child.send({ type: 'tool_response', id: restrictedCall.id, content: 'STRUCTURED_OUTPUT_VALIDATED', isError: false });
  await child.wait(e => e.type === 'result'); assert(!child.events.some(e => e.subtype === 'model_activity' || e.message?.content?.some(b => b.type === 'thinking'))); await child.close();
  console.log('Rig protocol passed: real Rust/Rig process, streaming HTTP fixture, auth fields, tool pairs, restart, compaction, profile gate, failures, credential redaction.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const child of children) child.kill();
  server.closeAllConnections(); server.close();
  fs.rmSync(root, { recursive: true, force: true });
});
