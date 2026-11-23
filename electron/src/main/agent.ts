import { ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './worker/logger';
import { getRigAgentBin, getRuntimeDir, getResourcesDir, getRuntimeDevServerEntry, getRuntimeServerEntry, isDev } from './paths';
import { buildAgentSystemPrompt } from './worker/context';
import { ensureManagedSkillsDeployed } from './skill-manager';
import { getSerialMonitorBridgeEnv } from './serial-monitor-bridge';
import { getAttachmentBridgeEnv } from './attachment-bridge';
import { getActiveProject, getActiveProjectStatePath, requireActiveProject } from './project-session';
import type { EngineeringAgentRuntimeModel } from './agent-model-selection';
import { createToolRegistry } from './agent-tools';
import { RuntimeTools } from './agent-tools/mcp';
import { buildProtectedBoardContext } from './board-info';
import type { AgentProfile } from './agent-tools/types';

export type AgentExecutionProfile = AgentProfile;
export interface AgentSessionBinding { conversationId: string; bootstrap?: string }
interface AgentHost {
  process: ChildProcess;
  key: string;
  profile: AgentExecutionProfile;
  abort: AbortController;
  runtime: RuntimeTools;
  ready: Promise<void>;
}
let host: AgentHost | null = null;
let agentSeq = 0;

export function buildRigInitConfig(profile: AgentExecutionProfile, model: EngineeringAgentRuntimeModel, tools: ReturnType<ReturnType<typeof createToolRegistry>['definitions']>, binding: AgentSessionBinding) {
  const project = requireActiveProject();
  const systemPrompt = `${buildAgentSystemPrompt()}\n\n当前工程：${project.projectDir}\n文件 Tools 只能操作此工程；Runtime 工具名将点号替换为下划线，例如 hardboard_idf_build。Read 返回 contentSha256，覆盖 Write 时需提供该 hash。\n${profile === 'default' ? '' : '当前为探索受限档位，只分析或计划，不得修改工程或操作硬件。完成时单独调用 StructuredOutput 提交最终结果。'}`;
  // Opaque identifiers cannot turn into paths; restricted Explore requests use memory only.
  const sessionId = createHash('sha256').update(binding.conversationId).digest('hex');
  return {
    profile, systemPrompt, model: model.upstreamModel, baseUrl: model.baseUrl,
    apiKey: model.authToken, authField: model.authField, tools,
    sessionFile: profile === 'default' ? getActiveProjectStatePath('agent', 'rig', sessionId, 'history.jsonl') : null,
    bootstrap: profile === 'default' ? binding.bootstrap || null : null,
    contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens,
    reserveTokens: model.reserveTokens, keepRecentTokens: model.keepRecentTokens,
    protectedContext: profile === 'default' ? buildProtectedBoardContext(project.projectDir) : null,
  };
}
export function ensureAgentProcess(profile: AgentExecutionProfile = 'default', model?: EngineeringAgentRuntimeModel, binding: AgentSessionBinding = { conversationId: 'engineering' }): ChildProcess {
  if (!model?.authToken) throw new Error('当前工程 Agent 供应商尚未配置');
  const project = requireActiveProject();
  const key = createHash('sha256').update(JSON.stringify([profile, project.id, binding.conversationId, model.providerId, model.baseUrl, model.authField, model.upstreamModel, model.contextWindow, model.maxOutputTokens, model.reserveTokens, model.keepRecentTokens, project.boardInfo?.id, model.authToken])).digest('hex');
  if (host && !host.process.killed && host.process.exitCode == null && host.key === key) return host.process;
  killAgent();
  ensureManagedSkillsDeployed();
  const bin = getRigAgentBin();
  if (!fs.existsSync(bin)) throw new Error('Rig Agent 尚未构建，请运行 npm --prefix electron run build:agent');
  const proc = spawn(bin, [], { cwd: project.projectDir, env: buildAgentEnv(model), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const abort = new AbortController();
  const runtime = new RuntimeTools();
  const current: AgentHost = { process: proc, key, profile, abort, runtime, ready: Promise.resolve() };
  host = current;
  const seq = ++agentSeq;
  const active = () => host === current && !abort.signal.aborted && !proc.killed && proc.exitCode == null;
  const dispose = () => { abort.abort(); void runtime.close().catch(() => {}); if (host === current) host = null; };
  proc.once('close', dispose);
  proc.once('error', dispose);
  current.ready = (async () => {
    const runtimeTools = profile === 'default' ? await runtime.connect(buildAgentMcpConfig(profile)) : [];
    if (getActiveProject()?.id !== project.id) throw new Error('AGENT_PROJECT_CHANGED');
    if (!active()) { await runtime.close(); return; }
    const registry = createToolRegistry({ profile, projectId: project.id, projectDir: project.projectDir, conversationId: binding.conversationId, signal: abort.signal }, [model.authToken], runtimeTools);
    const decoder = new StringDecoder('utf8');
    let buffer = ''; let pending = false;
    proc.stdout?.prependListener('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { proc.kill(); return; }
      let boundary: number;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        if (!active()) return;
        let event: Record<string, unknown>;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'result' && event.is_error === true) { dispose(); return; }
        if (event.type !== 'tool_request') continue;
        if (pending || typeof event.id !== 'string' || typeof event.name !== 'string') { proc.kill(); return; }
        pending = true;
        void (async () => {
          const sameProject = requireActiveProject().id === project.id;
          const result = sameProject ? await registry.execute(String(event.name), event.input) : { isError: true, content: 'TOOL_PROJECT_CHANGED' };
          if (getActiveProject()?.id !== project.id) { if (active()) proc.kill(); return; }
          if (active()) proc.stdin?.write(`${JSON.stringify({ type: 'tool_response', id: event.id, ...result })}\n`);
        })().catch(() => { if (active()) proc.kill(); }).finally(() => { pending = false; });
      }
    });
    if (active()) proc.stdin?.write(`${JSON.stringify({ type: 'init', config: buildRigInitConfig(profile, model, registry.definitions(), binding) })}\n`);
  })().catch(() => {
    if (!active()) return;
    dispose();
    // Keep provider errors and credentials out of Worker logs/UI.
    proc.stdout?.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', is_error: true, result: 'AGENT_TOOL_HOST_INIT_FAILED' })}\n`));
    proc.kill();
  });
  logger.info('agent:spawn', { runtime: 'rig', pid: proc.pid, profile, projectId: project.id, seq });
  return proc;
}
export function sendAgentMessage(prompt: string, profile: AgentExecutionProfile = 'default', model?: EngineeringAgentRuntimeModel, binding?: AgentSessionBinding): void {
  const proc = ensureAgentProcess(profile, model, binding);
  const current = host!;
  const projectId = requireActiveProject().id;
  if (Buffer.byteLength(prompt) > 1024 * 1024) throw new Error('AGENT_PROMPT_TOO_LARGE');
  void current.ready.then(() => {
    if (host !== current || current.abort.signal.aborted || !proc.stdin || proc.stdin.destroyed) return;
    if (getActiveProject()?.id !== projectId) { proc.kill(); return; }
    proc.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
  });
}
export function killAgent(): void {
  const old = host;
  if (!old) return;
  host = null; agentSeq++;
  old.abort.abort();
  void old.runtime.close().catch(() => {});
  old.process.kill();
}
export function getAgentProcess(): ChildProcess | null { return host?.process || null; }
export function getAgentSeq(): number { return agentSeq; }
export function getAgentExecutionProfile(): AgentExecutionProfile | null { return host?.profile || null; }
export function buildAgentEnv(model?: EngineeringAgentRuntimeModel): NodeJS.ProcessEnv {
  if (!model?.authToken) throw new Error('当前工程 Agent 供应商尚未配置');
  const env: NodeJS.ProcessEnv = {};
  // Credentials/config arrive only through stdin; retain the minimum host OS environment.
  for (const name of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

/** Main owns the existing Runtime MCP subprocess; no config file or credentials in argv. */
export function buildAgentMcpConfig(profile: AgentExecutionProfile): { mcpServers: Record<string, unknown> } {
  if (profile !== 'default') return { mcpServers: {} };
  const runtimeDir = getRuntimeDir();
  const tsxCli = path.join(runtimeDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const devServerEntry = getRuntimeDevServerEntry();
  const prodServerEntry = getRuntimeServerEntry();

  // 所有模式都传入 RUNTIME_ROOT + PLAYWRIGHT 环境变量
  const playwrightDir = path.join(getResourcesDir(), 'playwright');
  const baseEnv: Record<string, string> = {
    CDP_PORT: '9230',
    RUNTIME_ROOT: runtimeDir,
    PLAYWRIGHT_BROWSERS_PATH: playwrightDir,
    CATNIP_AGENT_RUNTIME_STORE: getActiveProjectStatePath('agent', 'runtime-tools'),
    ...getSerialMonitorBridgeEnv(),
    ...getAttachmentBridgeEnv(),
  };

  // 开发模式：tsx 直接跑 .ts
  if (isDev()) {
    return {
      mcpServers: {
        'vibeide-runtime': {
          command: process.execPath,
          args: [tsxCli, devServerEntry, 'mcp'],
          env: {
            ...baseEnv,
            // process.execPath is electron.exe in development. Make it behave
            // like Node when Main launches the stdio MCP subprocess.
            ELECTRON_RUN_AS_NODE: '1',
          },
        },
      },
    };
  }

  // 生产模式：portable node + tsx 跑编译后的 JS（tsx 处理 ESM 后缀问题）
  const nodeBin = path.join(runtimeDir, 'nodejs', 'node.exe');
  if (fs.existsSync(nodeBin) && fs.existsSync(tsxCli)) {
    return {
      mcpServers: {
        'vibeide-runtime': {
          command: nodeBin,
          args: [tsxCli, prodServerEntry, 'mcp'],
          env: baseEnv,
        },
      },
    };
  }

  // 最终降级：系统 PATH 中的 node + tsx
  return {
    mcpServers: {
      'vibeide-runtime': {
        command: 'node',
        args: [tsxCli, prodServerEntry, 'mcp'],
        env: baseEnv,
      },
    },
  };
}
