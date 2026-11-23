import { EXPLORE_ANALYSIS_JSON_SCHEMA } from '../../common/explore';
import { ToolRegistry } from './registry';
import { fileTools } from './files';
import { skillTool } from './skills';
import { boardTool } from './boards';
import { platformSearchTool } from './search';
import type { AgentTool, ToolContext } from './types';

export const EXPLORE_PLAN_SCHEMA = { type: 'object', ...EXPLORE_ANALYSIS_JSON_SCHEMA.oneOf.find(branch => branch.properties.mode.const === 'plan') };
export function createToolRegistry(context: ToolContext, secrets: string[], runtime: AgentTool[] = []): ToolRegistry {
  const registry = new ToolRegistry(context, secrets);
  for (const tool of [...fileTools(), skillTool(), boardTool(), platformSearchTool(), ...runtime]) registry.register(tool);
  if (context.profile !== 'default') registry.register({
    definition: {
      name: 'StructuredOutput', description: '提交最终结构化分析或计划。完成时必须单独调用此工具，不把 JSON 输出为普通文本。',
      parameters: context.profile === 'explore_analysis' ? EXPLORE_ANALYSIS_JSON_SCHEMA : EXPLORE_PLAN_SCHEMA,
    },
    profiles: ['explore_analysis', 'explore_plan'],
    async execute() { return 'STRUCTURED_OUTPUT_VALIDATED'; },
  });
  return registry;
}
