import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { getRuntimeDir } from '../paths';
import { getActiveProjectStatePath, requireActiveProject } from '../project-session';
import { toolPath } from './paths';
import type { AgentTool, ToolContext } from './types';
import { analyzeVisionDataUrl } from '../attachment-bridge';
import { objectSchema, stringSchema } from './types';

interface McpTool { name: string; description?: string; inputSchema: Record<string, unknown> }
interface McpClient {
  connect(transport: unknown): Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  listTools(input?: { cursor: string }): Promise<{ tools: McpTool[]; nextCursor?: string }>;
  callTool(input: { name: string; arguments: Record<string, unknown> }, schema?: unknown, options?: unknown): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }>;
  close(): Promise<void>;
}
interface Transport { close(): Promise<void>; readonly pid?: number | null; readonly stderr?: Readable | null }
const runtimeRequire = createRequire(path.join(getRuntimeDir(), 'package.json'));
const ALLOWED = new Set([
  'hardboard.env_status', 'hardboard.devices_list', 'hardboard.idf_build', 'hardboard.idf_set_target', 'hardboard.idf_flash', 'hardboard.idf_clean',
  'hardboard.serial_status', 'hardboard.serial_open', 'hardboard.serial_close', 'hardboard.serial_write', 'hardboard.serial_read', 'hardboard.serial_wait', 'hardboard.serial_clear', 'hardboard.serial_capture', 'hardboard.snapshot_create',
  'browser.navigate', 'browser.click', 'browser.fill', 'browser.scroll', 'browser.wait', 'browser.screenshot', 'browser.extract', 'browser.getState',
  'browser.recording_start', 'browser.recording_stop', 'browser.recordings_list', 'browser.recording_replay', 'browser.workflow_save', 'browser.workflows_list', 'browser.workflow_run',
  'storage.save', 'storage.read', 'storage.list', 'attachment.status', 'attachment.inspect', 'attachment.read_text', 'attachment.search', 'vision.qwen_analyze',
]);

export class RuntimeTools {
  private client: McpClient | null = null;
  private transport: Transport | null = null;
  private config: { mcpServers: Record<string, unknown> } | null = null;
  private reconnecting: Promise<AgentTool[]> | null = null;
  private closed = false;
  private disconnected = false;
  private diagnostic = 'closed';
  private diagnosticTail = '';
  private diagnosticDecoder = new TextDecoder();
  private images = new Map<string, { dataUrl: string; path: string; projectId: string }>();
  async connect(config: { mcpServers: Record<string, unknown> }): Promise<AgentTool[]> {
    const server = config.mcpServers['vibeide-runtime'] as { command: string; args: string[]; env: Record<string, string> } | undefined;
    if (!server) return [];
    const { Client } = runtimeRequire('@modelcontextprotocol/sdk/client/index.js') as { Client: new (info: unknown) => McpClient };
    const { StdioClientTransport } = runtimeRequire('@modelcontextprotocol/sdk/client/stdio.js') as { StdioClientTransport: new (options: unknown) => Transport };
    if (this.closed) throw new Error('RUNTIME_CLOSED');
    this.config = config;
    this.disconnected = false;
    this.diagnostic = 'closed';
    this.diagnosticTail = '';
    this.diagnosticDecoder = new TextDecoder();
    const client = new Client({ name: 'catnip-agent-tools', version: '1.0.0' });
    const transport = new StdioClientTransport({ ...server, stderr: 'pipe' });
    this.client = client; this.transport = transport;
    client.onclose = () => { if (this.client === client) this.disconnected = true; };
    // Raw Runtime stderr is never logged, persisted or forwarded to Agent/Renderer.
    transport.stderr?.on('data', (chunk: Buffer) => {
      if (this.transport !== transport) return;
      this.diagnosticTail = (this.diagnosticTail + this.diagnosticDecoder.decode(chunk, { stream: true })).slice(-4096);
      if (/heap out of memory|allocation failed|out of memory/i.test(this.diagnosticTail)) this.diagnostic = 'memory';
      else if (/event writer lock timed out/i.test(this.diagnosticTail)) this.diagnostic = 'event_lock';
      else if (/uncaught|unhandled|FATAL/i.test(this.diagnosticTail)) this.diagnostic = 'process_failure';
    });
    await client.connect(transport);
    if (this.closed) { await client.close(); throw new Error('RUNTIME_CLOSED'); }
    const tools: McpTool[] = []; let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools); cursor = page.nextCursor;
      if (tools.length > 200) throw new Error('RUNTIME_TOOL_LIST_TOO_LARGE');
    } while (cursor);
    if (this.closed) { await client.close(); throw new Error('RUNTIME_CLOSED'); }
    const adapted: AgentTool[] = tools.filter(tool => ALLOWED.has(tool.name)).map(tool => ({
      definition: { name: tool.name.replaceAll('.', '_'), description: tool.description || tool.name, parameters: tool.inputSchema },
      profiles: ['default'],
      execute: (input, context) => this.call(tool.name, input, context),
    }));
    adapted.push({
      definition: { name: 'browser_analyzeScreenshot', description: '使用已配置的 Qwen 分析本次工程任务通过 browser_screenshot 取得的图像。imageId 来自截图结果；返回视觉证据和不确定项。', parameters: objectSchema({ imageId: stringSchema(80), prompt: stringSchema(2000) }, ['imageId', 'prompt']) },
      profiles: ['default'], execute: async (input, context) => {
        const image = this.images.get(String(input.imageId));
        if (!image || image.projectId !== context.projectId) throw new Error('SCREENSHOT_NOT_IN_CURRENT_TASK');
        return analyzeVisionDataUrl(image.dataUrl, String(input.prompt), context.signal);
      },
    });
    return adapted;
  }
  private async reconnect(): Promise<void> {
    if (this.closed) throw new Error('RUNTIME_CLOSED');
    if (this.reconnecting) { await this.reconnecting; return; }
    const config = this.config;
    if (!config) throw new Error('RUNTIME_NOT_CONNECTED');
    this.reconnecting = (async () => {
      const oldClient = this.client; const oldTransport = this.transport;
      this.client = null; this.transport = null;
      try { await oldClient?.close(); } catch { /* dead transport */ }
      try { await oldTransport?.close(); } catch { /* dead transport */ }
      if (this.closed) throw new Error('RUNTIME_CLOSED');
      return this.connect(config);
    })().finally(() => { this.reconnecting = null; });
    await this.reconnecting;
  }
  private async call(name: string, input: Record<string, unknown>, context: ToolContext): Promise<unknown> {
    if (this.closed || !this.client) throw new Error('RUNTIME_NOT_CONNECTED');
    if (!ALLOWED.has(name)) throw new Error('RUNTIME_TOOL_NOT_ALLOWED');
    context.signal.throwIfAborted();
    if (requireActiveProject().id !== context.projectId) throw new Error('RUNTIME_PROJECT_CHANGED');
    const args = { ...input };
    if ('projectDir' in args) {
      const supplied = path.resolve(context.projectDir, String(args.projectDir));
      if ((process.platform === 'win32' ? supplied.toLowerCase() : supplied) !== (process.platform === 'win32' ? path.resolve(context.projectDir).toLowerCase() : path.resolve(context.projectDir))) throw new Error('RUNTIME_CROSS_PROJECT_REFUSED');
    }
    if (/^(?:attachment\.(?!status)|vision\.)/.test(name) && (!context.conversationId || args.conversationId !== context.conversationId)) throw new Error('RUNTIME_CROSS_CONVERSATION_REFUSED');
    if (/^hardboard\.(?:idf_|snapshot_create)/.test(name)) args.projectDir = context.projectDir;
    if (name === 'browser.navigate' && typeof args.url === 'string') {
      const url = new URL(args.url);
      if (url.protocol === 'file:') toolPath(context.projectDir, fileURLToPath(url));
      else if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('BROWSER_URL_REFUSED');
    }
    // A replay/workflow file must come from the runtime's controlled store; explicit arbitrary files are refused.
    if (typeof args.file === 'string' || typeof args.recordingFile === 'string') throw new Error('RUNTIME_ARBITRARY_FILE_REFUSED_USE_LABEL');
    if (typeof args.workspace === 'string' && (!/^[a-zA-Z0-9_-]{1,64}$/.test(args.workspace))) throw new Error('RUNTIME_WORKSPACE_NAME_INVALID');
    if (this.disconnected) await this.reconnect();
    context.signal.throwIfAborted();
    if (this.closed || !this.client) throw new Error('RUNTIME_CLOSED');
    if (requireActiveProject().id !== context.projectId) throw new Error('RUNTIME_PROJECT_CHANGED');
    let result;
    try {
      result = await this.client.callTool({ name, arguments: args }, undefined, { signal: context.signal, timeout: 10 * 60_000, maxTotalTimeout: 10 * 60_000 });
    } catch (error) {
      context.signal.throwIfAborted();
      if (this.disconnected || (error instanceof Error && /Not connected|Connection closed/.test(error.message))) {
        this.disconnected = true;
        // Never replay an operation whose result may have been lost. Only a later explicit Tool call reconnects.
        throw new Error(`RUNTIME_CONNECTION_LOST:${this.diagnostic};TOOL_OUTCOME_UNKNOWN; inspect project/runtime task state before a new operation.`);
      }
      throw error;
    }
    context.signal.throwIfAborted();
    if (requireActiveProject().id !== context.projectId) throw new Error('RUNTIME_PROJECT_CHANGED');
    const text = result.content.filter(item => item.type === 'text').map(item => item.text || '').join('\n');
    if (result.isError) throw new Error(text.slice(0, 1000) || 'RUNTIME_TOOL_FAILED');
    for (const item of result.content) {
      if (item.type !== 'text' || !item.text) continue;
      try {
        const value = JSON.parse(item.text) as { ok?: boolean; exitCode?: number };
        if (value.ok === false || (typeof value.exitCode === 'number' && value.exitCode !== 0)) throw new Error('RUNTIME_COMMAND_FAILED: ' + item.text.slice(-6000));
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('RUNTIME_COMMAND_FAILED')) throw error;
      }
    }
    const images = [];
    for (const item of result.content) {
      if (item.type !== 'image') {
        if (item.type !== 'text') throw new Error(`RUNTIME_UNSUPPORTED_CONTENT_TYPE: ${item.type}`);
        continue;
      }
      if (!item.data || item.mimeType !== 'image/png' || item.data.length > 8 * 1024 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(item.data)) throw new Error('RUNTIME_IMAGE_INVALID_OR_TOO_LARGE');
      const imageId = `image-${randomUUID()}`;
      const file = getActiveProjectStatePath('agent', 'screenshots', `${imageId}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(item.data, 'base64'), { flag: 'wx' });
      this.images.set(imageId, { dataUrl: `data:image/png;base64,${item.data}`, path: file, projectId: context.projectId });
      if (this.images.size > 8) this.images.delete(this.images.keys().next().value!);
      images.push({ imageId, path: file, bytes: fs.statSync(file).size, visualAnalysis: 'Call browser_analyzeScreenshot for visual evidence; capture alone does not prove page content.' });
    }
    return images.length ? { text, images } : text;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.config = null;
    this.diagnosticTail = '';
    const client = this.client; const transport = this.transport;
    this.client = null; this.transport = null;
    this.images.clear();
    // Kill only the owned Runtime tree, including an active IDF child, before closing its parent.
    if (process.platform === 'win32' && transport?.pid) await new Promise<void>(resolve => {
      execFile('taskkill.exe', ['/PID', String(transport.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => resolve());
    });
    try { await client?.close(); } finally { await transport?.close(); }
  }
}
