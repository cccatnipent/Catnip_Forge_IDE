import React, { useEffect, useState } from 'react';
import { RadioTower, RefreshCw } from 'lucide-react';
import type { RadioProcessSnapshot } from '../types';

export default function RadioPanel() {
  const [status, setStatus] = useState<RadioProcessSnapshot>({ state: 'starting', pid: null, url: null, message: '正在启动 Otto Master 服务…', backendReady: false });

  const start = async () => setStatus(await window.electronAPI.startRadio());
  useEffect(() => { void start(); }, []);

  if (status.state !== 'ready' || !status.url) {
    return <section className="radio-workspace-state" aria-live="polite">
      <RadioTower aria-hidden="true" />
      <h2>Forge 电台</h2>
      <p>{status.message}</p>
      {status.state === 'error' ? <button type="button" onClick={() => void start()}><RefreshCw aria-hidden="true" />重新启动</button> : null}
    </section>;
  }

  return <section className="radio-workspace" data-tour-id="panel-radio">
    <iframe
      key={status.url}
      src={status.url}
      title="Forge 电台"
      allow="autoplay"
      referrerPolicy="no-referrer"
    />
    <div className="radio-service-chip" title={`Python PID ${status.pid ?? 'unknown'}`}>
      <span />{status.backendReady ? 'Otto Master 已就绪' : 'Otto Master 未就绪'}
    </div>
  </section>;
}
