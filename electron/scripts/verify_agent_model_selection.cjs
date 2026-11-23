const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catnip-agent-model-'));
  app.setPath('userData', root);
  await app.whenReady();
  const { ModelConfigStore } = require('../dist/main/model-config-store.js');
  const { createDefaultModelConfig } = require('../dist/common/model-config.js');
  const { snapshotEngineeringAgentModel } = require('../dist/main/agent-model-selection.js');
  const { buildAgentEnv } = require('../dist/main/agent.js');

  try {
    const defaults = snapshotEngineeringAgentModel();
    assert.equal(defaults.profileId, 'deepseek');
    assert.equal(defaults.baseUrl, 'https://api.deepseek.com/anthropic');
    assert.equal(defaults.authField, 'ANTHROPIC_AUTH_TOKEN');
    assert.equal(defaults.haikuModel, 'deepseek-v4-flash');
    assert.equal('authToken' in defaults, false, 'queued model snapshot must contain no credential');

    assert.equal(defaults.contextWindow, 1000000);
    assert.equal(defaults.maxOutputTokens, 32768);
    assert.equal(defaults.reserveTokens, 80000);
    assert(defaults.reserveTokens > defaults.maxOutputTokens);
    const configStore = new ModelConfigStore(path.join(root, 'models', 'config.json'));
    const config = createDefaultModelConfig();
    config.providers.push({
      id: 'zhipu', name: '智谱清言', baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      protocols: ['anthropic-compatible'], enabled: true, builtIn: false, credentialId: 'zhipu',
      claudeCode: { apiFormat: 'anthropic', isFullUrl: false, authField: 'ANTHROPIC_API_KEY', primaryModel: 'glm-4.7', haikuModel: 'glm-4.5-air' },
    });
    config.activeClaudeProviderId = 'zhipu';
    config.setupMode = 'custom';
    configStore.replace(config, 0);
    const selected = snapshotEngineeringAgentModel();
    assert.equal(selected.upstreamModel, 'glm-4.7');
    assert.equal(selected.providerId, 'zhipu');
    assert.equal(selected.haikuModel, 'glm-4.5-air');
    assert.equal(selected.sonnetModel, 'glm-4.7');
    assert.equal(selected.fableModel, 'glm-4.7');
    assert.equal(selected.subagentModel, 'glm-4.5-air');
    assert.equal('authToken' in selected, false);

    assert.equal(selected.contextWindow, 131072);
    const resized = configStore.read();
    resized.providers.find(item => item.id === 'zhipu').claudeCode.contextWindow = 1000000;
    configStore.replace(resized, resized.revision);
    assert.equal(snapshotEngineeringAgentModel().contextWindow, 1000000);
    assert.equal(selected.contextWindow, 131072, 'created task snapshot changed');
    assert.equal(defaults.contextWindow, 1000000);
    const runtime = { ...selected, authToken: 'sk-agent-runtime-fixture', authSource: 'secure-storage' };
    const inherited = {
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    };
    process.env.ANTHROPIC_AUTH_TOKEN = 'parent-token-must-be-replaced';
    process.env.ANTHROPIC_API_KEY = 'parent-key-must-be-cleared';
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'parent-opus-must-be-cleared';
    const env = buildAgentEnv(runtime);
    for (const name of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) assert.equal(env[name], undefined);
    assert(!JSON.stringify(env).includes(runtime.authToken), 'Rig credentials must be injected through stdin only');
    for (const [key, value] of Object.entries(inherited)) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }

    const invalid = configStore.read();
    invalid.activeClaudeProviderId = 'qwen';
    assert.throws(() => configStore.replace(invalid, invalid.revision), /Claude Code compatible/);

    const agentSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'agent.ts'), 'utf8');
    assert.match(agentSource, /apiKey: model\.authToken/);
    assert.match(agentSource, /authField: model\.authField/);
    assert.match(agentSource, /host\.key === key/);
    assert.doesNotMatch(agentSource, /model\?\.authToken \?\? readDeepSeekApiKey/);
    assert.doesNotMatch(agentSource, /logger\.(?:info|warn|error)\([^\n]+authToken/);
    const orchestratorSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'worker', 'orchestrator.ts'), 'utf8');
    assert.doesNotMatch(orchestratorSource, /snapshotEngineeringAgentModel\([^)]*modelProfileId/);
    assert.doesNotMatch(orchestratorSource, /this\.ensurePersistentAgent\(\);/, 'Claude Code must not start before a configured task');
    console.log('Agent model selection verification passed.');
  } finally {
    app.quit();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
