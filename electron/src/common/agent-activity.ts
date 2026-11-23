export type AgentActivityPhase = 'waiting' | 'thinking' | 'responding' | 'tool_input' | 'complete' | 'failed' | 'tool';

export interface AgentModelActivity {
  requestId: number;
  phase: Exclude<AgentActivityPhase, 'tool'>;
  elapsedMs: number;
  events: number;
  textBytes: number;
  reasoningBytes: number;
  argumentBytes: number;
}

export interface AgentActivity extends Omit<AgentModelActivity, 'phase'> {
  phase: AgentActivityPhase;
  toolLabel?: string;
  startedAt: number;
  lastEventAt: number;
}

export const THINKING_PREVIEW_LIMIT = 20_000;
export const THINKING_PREVIEW_SUFFIX = '\n…（思考预览已达显示上限）';

export function normalizeAgentModelActivity(value: unknown): AgentModelActivity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!['waiting', 'thinking', 'responding', 'tool_input', 'complete', 'failed'].includes(String(input.phase))) return null;
  const keys = ['requestId', 'elapsedMs', 'events', 'textBytes', 'reasoningBytes', 'argumentBytes'] as const;
  for (const key of keys) {
    if (!Number.isSafeInteger(input[key]) || Number(input[key]) < (key === 'requestId' ? 1 : 0) || Number(input[key]) > (key === 'requestId' ? Number.MAX_SAFE_INTEGER : 128_000_000)) return null;
  }
  return { ...Object.fromEntries(keys.map(key => [key, input[key]])), phase: input.phase } as unknown as AgentModelActivity;
}

export function agentToolActivityLabel(name: string, input: unknown): string {
  const labels: Record<string, string> = {
    BoardPack: '读取板卡资料', Skill: '加载技能', Read: '读取文件', Write: '编写文件', Edit: '修改文件',
    Glob: '查找文件', Grep: '搜索代码', Bash: '运行命令',
    hardboard_env_status: '检查编译环境', hardboard_idf_set_target: '配置编译目标', hardboard_idf_build: '编译工程',
    hardboard_idf_clean: '清理构建', hardboard_snapshot_create: '保存工程快照',
    hardboard_devices_list: '查询设备', hardboard_idf_flash: '烧录工程',
    hardboard_serial_open: '打开串口', hardboard_serial_close: '关闭串口', hardboard_serial_read: '读取串口', hardboard_serial_wait: '等待串口事件',
  };
  const data = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const file = typeof (data.path ?? data.file_path) === 'string' ? String(data.path ?? data.file_path).replaceAll('\\', '/').split('/').pop() : '';
  const suffix = ['Read', 'Write', 'Edit'].includes(name) && file && /^[a-zA-Z0-9_.-]{1,80}$/.test(file) ? ` · ${file}` : '';
  return `${labels[name] ?? '执行工具'}${suffix}`;
}
export function mergeThinkingPreview(previous: string, delta: string): string {
  if (previous.endsWith(THINKING_PREVIEW_SUFFIX)) return previous;
  const combined = previous + delta;
  const available = THINKING_PREVIEW_LIMIT - THINKING_PREVIEW_SUFFIX.length;
  if (combined.length <= available) return combined;
  let boundary = available;
  const code = combined.charCodeAt(boundary - 1);
  if (code >= 0xd800 && code <= 0xdbff) boundary -= 1;
  return combined.slice(0, boundary) + THINKING_PREVIEW_SUFFIX;
}
