const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');
const { spawn } = require('node:child_process');
const { app, BrowserWindow } = electron;
const esbuild = require('esbuild');
const parentRun = typeof electron === 'string';
const root = process.env.CATNIP_CHAT_STREAM_UI_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'catnip-chat-stream-ui-'));
const sourceRoot = path.resolve(__dirname, '../src');
const frames = ['时钟在', '走：00:01:00 → 00:02:00；\n\n| 现象 | 调整 |\n| --- | --- |\n| 背光', '亮 | 保留空格 ', '|\n| 颜色偏 | 字节序 |\n\n```c\n  return 0;\n```\n'];
let win;

async function main() {
  app.setPath('userData', path.join(root, 'user-data'));
  await app.whenReady();
  const cssFile = fs.readdirSync(path.resolve(__dirname, '../dist/renderer/assets')).find(x => /^index-.*\.css$/.test(x));
  fs.copyFileSync(path.resolve(__dirname, '../dist/renderer/assets', cssFile), path.join(root, 'style.css'));
  const buildInput = `import React, { useState } from 'react'; import {createRoot} from 'react-dom/client';
    import ChatPanel from ${JSON.stringify(path.join(sourceRoot, 'renderer/components/ChatPanel.tsx'))};
    import {upsertChatMessage} from ${JSON.stringify(path.join(sourceRoot, 'common/chat-stream.ts'))};
    const noop=()=>{};
    window.electronAPI={listManagedSkills:async()=>({ok:true,skills:[]})};
    function Test(){const [messages,setMessages]=useState([]);window.receiveStored=m=>setMessages(v=>upsertChatMessage(v,m));
      return <div style={{width:'100%',height:'100%',display:'flex'}}><ChatPanel messages={messages} steps={[]} conversations={[]} activeConversationId='fixture' historyError='' taskStatus={{busy:false,paused:false,activeTaskId:null,activeTask:null,queueLength:0,guidanceCount:0}} onSend={noop} onStop={noop} onCreateConversation={noop} onSelectConversation={noop} onDeleteConversation={noop} onRenameConversation={noop} onToggleConversationPinned={noop}/></div>;}
    createRoot(document.getElementById('root')).render(<Test/>);`;
  await esbuild.build({ stdin: { contents: buildInput, loader: 'tsx', resolveDir: path.resolve(__dirname, '..') }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(root, 'ui.js'), loader: { '.png': 'dataurl', '.jpg': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' } });
  fs.writeFileSync(path.join(root, 'ui.html'), '<!DOCTYPE html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>');
  win = new BrowserWindow({ show: false, width: 620, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await win.loadFile(path.join(root, 'ui.html'));
  await win.webContents.executeJavaScript('new Promise(resolve=>{const timer=setInterval(()=>{if(window.receiveStored){clearInterval(timer);resolve(true)}},10)})');
  const { mergeAssistantResponse } = require('../dist/common/chat-stream');
  let text = '';
  for (const frame of frames) {
    text = mergeAssistantResponse(text, frame);
    const msg = { id: 'response:fixture-task:rig-text-1', streamId: 'rig-text-1', kind: 'conversation', taskId: 'fixture-task', role: 'agent', timestamp: 1, text };
    await win.webContents.executeJavaScript(`window.receiveStored(${JSON.stringify(msg)}); new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const count = await win.webContents.executeJavaScript('document.querySelectorAll(".chat-msg--agent").length');
    assert.equal(count, 1, 'every accumulated update must replace the same visible Agent bubble');
  }
  const report = await win.webContents.executeJavaScript(`({bubbles:document.querySelectorAll('.chat-msg--agent').length,tables:document.querySelectorAll('.chat-msg--agent table').length,rows:document.querySelectorAll('.chat-msg--agent tbody tr').length,code:document.querySelector('.chat-msg--agent pre code')?.textContent,text:document.querySelector('.chat-msg--agent .chat-markdown')?.textContent,overflow:document.documentElement.scrollWidth>innerWidth})`);
  assert.equal(report.bubbles, 1); assert.equal(report.tables, 1); assert.equal(report.rows, 2);
  assert.equal(report.code, '  return 0;'); assert.match(report.text, /时钟在走/); assert.equal(report.overflow, false);
  console.log(JSON.stringify({ status: 'passed', actualChatPanel: true, isolatedElectronWindow: true, ...report }, null, 2));
}
if (parentRun) {
  // Electron holds Chromium cache files until process exit; the parent owns cleanup.
  const child = spawn(electron, [__filename], { env: { ...process.env, CATNIP_CHAT_STREAM_UI_ROOT: root }, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('close', code => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    process.exitCode = code ?? 1;
  });
} else {
  main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { win?.destroy(); app.exit(process.exitCode || 0); });
}
