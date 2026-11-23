export const ASSISTANT_RESPONSE_LIMIT = 256_000;
export const ASSISTANT_RESPONSE_SUFFIX = '\n…（回答已达显示上限，完整内容保留在工程原始历史中）';

export function normalizeResponseStreamId(value: unknown): string | undefined {
  return typeof value === 'string' && /^rig-text-[1-9][0-9]{0,15}$/.test(value) ? value : undefined;
}

export function mergeAssistantResponse(previous: string, delta: string): string {
  if (previous.endsWith(ASSISTANT_RESPONSE_SUFFIX)) return previous;
  const combined = previous + delta;
  if (combined.length <= ASSISTANT_RESPONSE_LIMIT) return combined;
  let boundary = ASSISTANT_RESPONSE_LIMIT - ASSISTANT_RESPONSE_SUFFIX.length;
  const code = combined.charCodeAt(boundary - 1);
  if (code >= 0xd800 && code <= 0xdbff) boundary -= 1;
  return combined.slice(0, boundary) + ASSISTANT_RESPONSE_SUFFIX;
}

interface UpdatableMessage {
  id: string;
  kind?: string;
  taskId?: string | null;
  streamId?: string;
}

// Main sends the complete stored text after merging a delta. Replace that view;
// concatenating it again in Renderer would duplicate all earlier fragments.
export function upsertChatMessage<T extends UpdatableMessage>(messages: T[], incoming: T): T[] {
  const index = incoming.kind === 'status'
    ? messages.findIndex(entry => entry.kind === 'status' && entry.taskId === incoming.taskId)
    : incoming.kind === 'thinking' || normalizeResponseStreamId(incoming.streamId)
      ? messages.findIndex(entry => entry.kind === incoming.kind && entry.id === incoming.id && entry.taskId === incoming.taskId && entry.streamId === incoming.streamId)
      : -1;
  if (index < 0) return [...messages, incoming];
  const next = [...messages];
  next[index] = { ...incoming, id: messages[index].id };
  return next;
}
