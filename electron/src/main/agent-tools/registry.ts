import { createRequire } from 'node:module';
import path from 'node:path';
import { getRuntimeDir } from '../paths';
import type { AgentTool, ToolContext, ToolDefinition, ToolResult } from './types';

interface Validator { (value: unknown): boolean }
interface SchemaValidator { compile(schema: unknown): Validator }
const runtimeRequire = createRequire(path.join(getRuntimeDir(), 'package.json'));
const Ajv = runtimeRequire('ajv') as new (options: unknown) => SchemaValidator;

export class ToolRegistry {
  private tools = new Map<string, { tool: AgentTool; validate: Validator }>();
  private validator = new Ajv({ strict: false, allErrors: false, validateFormats: false });
  constructor(private context: ToolContext, private secrets: string[] = []) {}

  register(tool: AgentTool): void {
    if (this.tools.has(tool.definition.name)) throw new Error('DUPLICATE_TOOL_NAME');
    this.tools.set(tool.definition.name, { tool, validate: this.validator.compile(tool.definition.parameters) });
  }
  definitions(): ToolDefinition[] {
    return [...this.tools.values()].filter(({ tool }) => tool.profiles.includes(this.context.profile)).map(({ tool }) => tool.definition);
  }
  scrub(text: string): string {
    for (const secret of this.secrets) if (secret.length >= 8) text = text.split(secret).join('[credential redacted]').split(JSON.stringify(secret).slice(1, -1)).join('[credential redacted]');
    return text;
  }
  async execute(name: string, input: unknown): Promise<ToolResult> {
    try {
      if (this.context.signal.aborted) throw new Error('TOOL_ABORTED');
      const entry = this.tools.get(name);
      if (!entry || !entry.tool.profiles.includes(this.context.profile)) throw new Error('TOOL_PROFILE_FORBIDDEN');
      if (!input || typeof input !== 'object' || Array.isArray(input) || !entry.validate(input)) throw new Error('TOOL_INVALID_ARGUMENTS');
      if (this.secrets.some(secret => secret.length >= 8 && (JSON.stringify(input).includes(secret) || JSON.stringify(input).includes(JSON.stringify(secret).slice(1, -1))))) throw new Error('TOOL_CREDENTIAL_ARGUMENT_REFUSED');
      const result = await entry.tool.execute(input as Record<string, unknown>, this.context);
      const text = this.scrub(typeof result === 'string' ? result : (JSON.stringify(result) ?? ''));
      return { content: text.length > 24_000 ? `${text.slice(0, 24_000)}\n[tool result truncated]` : text, isError: false };
    } catch (error) {
      return { content: this.scrub(error instanceof Error ? error.message : 'TOOL_EXECUTION_FAILED').slice(0, 1000), isError: true };
    }
  }
}
