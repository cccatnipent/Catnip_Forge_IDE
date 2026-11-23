import React, { useState } from 'react';
import type { AgentContextUsage } from '../../common/agent-context';

export function formatContextTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 ? 2 : 0)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value % 1000 ? 1 : 0)}K`;
  return String(value);
}

export default function ContextRing({ usage, capacity }: { usage?: AgentContextUsage | null; capacity?: number }) {
  const [expanded, setExpanded] = useState(false);
  const window = usage?.contextWindow ?? capacity;
  const ratio = usage && window ? Math.min(1, Math.max(0, usage.remainingTokens / window)) : null;
  const percent = ratio === null ? null : Math.floor(ratio * 100);
  const tone = usage?.phase === 'failed' ? 'error' : usage?.phase === 'compacting' ? 'compacting' : usage && usage.remainingTokens <= usage.reserveTokens * 2 ? 'warning' : 'normal';
  const label = usage ? `上下文剩余约 ${usage.remainingTokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens` : '上下文容量，尚未计量';
  const status = usage?.phase === 'compacting' ? '正在压缩历史' : usage?.phase === 'failed' ? '压缩失败，历史已保留' : usage?.compactionCount ? `已自动压缩 ${usage.compactionCount} 次` : '接近上限自动压缩';
  return (
    <div className={`chat-context is-${tone}`}>
      <button type="button" className="chat-context-toggle" aria-label={label} aria-expanded={expanded} onClick={() => setExpanded(current => !current)}>
        <span className="chat-context-ring" role="img" aria-label={percent === null ? '上下文尚未计量' : `剩余 ${percent}%`}>
          <svg viewBox="0 0 40 40" aria-hidden="true"><circle className="chat-context-track" cx="20" cy="20" r="16" /><circle className="chat-context-value" cx="20" cy="20" r="16" pathLength="100" strokeDasharray={`${ratio === null ? 0 : ratio * 100} 100`} transform="rotate(-90 20 20)" /></svg>
          <span>{percent === null ? '—' : `${percent}%`}</span>
        </span>
        <span className="chat-context-label"><strong>{usage ? `剩余 ${formatContextTokens(usage.remainingTokens)} / ${formatContextTokens(usage.contextWindow)}` : window ? `${formatContextTokens(window)} 上下文` : '上下文容量'}</strong><small>{usage ? status : '首次请求后计量'}</small></span>
      </button>
      {expanded ? <div className="chat-context-details">
        <div><span>已用（估算）</span><strong>{usage ? `${usage.usedTokens.toLocaleString()} tokens` : '尚未计量'}</strong></div>
        <div><span>总容量</span><strong>{window?.toLocaleString() ?? '未配置'} tokens</strong></div>
        {usage ? <>
          <div><span>自动压缩阈值</span><strong>{(usage.contextWindow - usage.reserveTokens).toLocaleString()} tokens</strong></div>
          <div><span>单次输出上限</span><strong>{usage.maxOutputTokens.toLocaleString()} tokens</strong></div>
          <div><span>板卡资料保护区</span><strong>{usage.protectedTokens.toLocaleString()} tokens</strong></div>
          {usage.providerInputTokens !== undefined ? <div><span>最近请求 · 供应商计量</span><strong>输入 {usage.providerInputTokens.toLocaleString()} · 输出 {usage.providerOutputTokens?.toLocaleString() ?? '未返回'}</strong></div> : null}
        </> : null}
        <p>圆环显示估算剩余空间，并提前为模型输出预留容量。自动压缩只归纳历史，板卡原文和原始记录完整保留。</p>
      </div> : null}
    </div>
  );
}
