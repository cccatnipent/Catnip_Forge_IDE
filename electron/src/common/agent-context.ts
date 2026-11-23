export type ContextPhase = 'ready' | 'compacting' | 'compacted' | 'failed';

export interface AgentContextUsage {
  contextWindow: number;
  usedTokens: number;
  remainingTokens: number;
  reserveTokens: number;
  maxOutputTokens: number;
  protectedTokens: number;
  compactionCount: number;
  phase: ContextPhase;
  measurement: 'estimate' | 'provider';
  providerInputTokens?: number;
  providerOutputTokens?: number;
}

export function normalizeAgentContextUsage(value: unknown): AgentContextUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const keys = ['contextWindow', 'usedTokens', 'remainingTokens', 'reserveTokens', 'maxOutputTokens', 'protectedTokens', 'compactionCount'] as const;
  for (const key of keys) if (!Number.isSafeInteger(input[key]) || Number(input[key]) < 0 || Number(input[key]) > (key === 'compactionCount' ? 1_000_000 : 32_000_000)) return null;
  const window = Number(input.contextWindow);
  if (window < 16_384 || window > 2_000_000 || Number(input.remainingTokens) !== Math.max(0, window - Number(input.usedTokens)) || Number(input.reserveTokens) >= window || Number(input.maxOutputTokens) > Number(input.reserveTokens) || Number(input.protectedTokens) > Number(input.usedTokens)) return null;
  if (!['ready', 'compacting', 'compacted', 'failed'].includes(String(input.phase)) || !['estimate', 'provider'].includes(String(input.measurement))) return null;
  const result = Object.fromEntries(keys.map(key => [key, input[key]])) as unknown as AgentContextUsage;
  result.phase = input.phase as ContextPhase;
  result.measurement = input.measurement as AgentContextUsage['measurement'];
  for (const key of ['providerInputTokens', 'providerOutputTokens'] as const) {
    if (input[key] == null) continue;
    if (!Number.isSafeInteger(input[key]) || Number(input[key]) < 0 || Number(input[key]) > 32_000_000) return null;
    result[key] = input[key] as number;
  }
  return result;
}
