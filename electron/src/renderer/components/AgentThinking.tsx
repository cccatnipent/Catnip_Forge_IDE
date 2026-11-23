import React, { useEffect, useState } from 'react';
import { BrainCircuit } from 'lucide-react';
import type { AgentActivity } from '../../common/agent-activity';
import type { ChatMessage } from '../types';

const PHASE_LABELS = {
  waiting: '等待模型响应',
  thinking: '思考中',
  responding: '正在输出',
  tool_input: '正在准备工具调用',
  complete: '本轮响应已完成',
  failed: '本轮响应失败',
  tool: '正在执行工具',
} as const;

export function ModelActivityStatus({ activity, paused }: { activity: AgentActivity; paused: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (paused || activity.phase === 'complete' || activity.phase === 'failed') return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activity.requestId, activity.phase, paused]);
  const terminal = activity.phase === 'complete' || activity.phase === 'failed';
  const elapsed = Math.floor(Math.max(activity.elapsedMs, (terminal || paused ? activity.lastEventAt : now) - activity.startedAt) / 1000);
  const quiet = Math.floor(Math.max(0, now - activity.lastEventAt) / 1000);
  return (
    <details className={`chat-model-activity${terminal || paused ? '' : ' is-active'}`}>
      <summary aria-label={paused ? '已暂停' : activity.phase === 'tool' ? activity.toolLabel || PHASE_LABELS.tool : PHASE_LABELS[activity.phase]}>
        <BrainCircuit aria-hidden="true" />
        <strong>{paused ? '已暂停' : activity.phase === 'tool' ? activity.toolLabel || PHASE_LABELS.tool : PHASE_LABELS[activity.phase]}</strong>
        <span>{elapsed} 秒</span>
        <small>详情</small>
      </summary>
      <div className="chat-model-activity-detail" role="status" aria-live="polite">
        {terminal ? '响应已结束' : activity.phase === 'tool' ? '等待工具返回结果' : activity.events === 0 ? '等待首个事件' : quiet >= 5 ? `${quiet} 秒未收到新事件` : '正在接收模型事件'}
        {activity.reasoningBytes > 0 ? <span> · 已收到 {activity.reasoningBytes.toLocaleString('zh-CN')} 字节思考内容</span> : null}
      </div>
    </details>
  );
}

export default function ThinkingMessage({ message, active }: { message: ChatMessage; active: boolean }) {
  const [open, setOpen] = useState(active);
  useEffect(() => { if (active) setOpen(true); }, [active]);
  return (
    <details className={`chat-thinking${active ? ' is-active' : ''}`} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <BrainCircuit aria-hidden="true" />
        <strong>{active ? '思考中' : '思考过程'}</strong>
        <span>{message.text.length.toLocaleString('zh-CN')} 字符</span>
        <small>{open ? '收起' : '展开'}</small>
      </summary>
      <pre>{message.text}</pre>
    </details>
  );
}
