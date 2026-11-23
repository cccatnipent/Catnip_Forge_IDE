export type AgentProfile = 'default' | 'explore_analysis' | 'explore_plan';
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolContext { profile: AgentProfile; projectId: string; projectDir: string; conversationId?: string; signal: AbortSignal }
export interface AgentTool {
  definition: ToolDefinition;
  profiles: AgentProfile[];
  execute(input: Record<string, unknown>, context: ToolContext): Promise<unknown>;
}
export interface ToolResult { content: string; isError: boolean }
export const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
export const stringSchema = (maxLength = 4096) => ({ type: 'string', minLength: 1, maxLength });
