import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ipcMain, BrowserWindow, shell } from 'electron';
import { getOrchestrator } from './worker';
import { normalizeAgentTaskInput, type AgentTaskInput, type TaskSubmitMode } from './worker/orchestrator';
import { activateChatConversation, appendChatMessage, createChatConversation, deleteChatConversation, getChatConversation, listChatConversations, renameChatConversation, setChatConversationPinned } from './worker/session-store';
import { activateTab, closeTab, listTabs, openTabUrl, setBrowserTabsEmitter, setBrowserViewBoundsFromRenderer } from './browser-view';
import { listBrowserRecordingSummaries, listBrowserRecordings, replayBrowserRecording, replayLatestBrowserRecording, startBrowserRecording, stopBrowserRecording } from './browser-recorder';
import { createWorkbenchEntry, deleteWorkbenchEntry, getWorkbenchOverview, listWorkbenchDirectory, openWorkbenchItem, readWorkbenchFile, renameWorkbenchEntry, writeWorkbenchFile } from './workbench';
import { deleteManagedSkill, getManagedSkill, listManagedSkills, saveManagedSkill, syncManagedSkills } from './skill-manager';
import {
  clearHardboardRuntimeHistory,
  listHardboardDevices,
  isHardboardLauncherRunning,
  readHardboardRuntimeEvents,
  readHardboardSourceFile,
  startHardboardBuild,
  startHardboardFlash,
} from './hardboard';
import {
  clearSharedSerialMonitor,
  readSharedSerialMonitor,
  startSharedSerialMonitor,
  stopSharedSerialMonitor,
  subscribeSharedSerialClear,
  subscribeSharedSerialEvents,
  subscribeSharedSerialState,
  writeSharedSerialMonitor,
} from './serial-monitor-controller';
import { pickChatAttachments, validateAttachmentReferences } from './attachment-store';
import { registerExploreKnowledgeIpc } from './explore-knowledge';
import { registerExploreZhihuStatusIpc } from './explore-zhihu-status';
import { registerExploreRequestIpc } from './explore-request';
import { isExploreRequestInFlight, registerExploreAnalysisIpc } from './explore-analysis';
import { registerExploreContextIpc } from './explore-context';
import { registerExploreSessionIpc } from './explore-session';
import { activateProject, assertMutableProjectPath, assertPathInActiveProject, createProject, getProjectSessionStatus, requireActiveProject } from './project-session';
import { registerModelManagementIpc } from './model-management';
import { snapshotEngineeringAgentModel } from './agent-model-selection';
import { registerRadioIpc } from './radio-process';
import { firmwarePackageError, getSelectedFirmwarePackage, pickFirmwarePackage, resolveFirmwarePackageFlash } from './firmware-package';
import { startFirmwarePackageFlash } from './hardboard';
import { boardInfoError, pickBoardInfo, releaseBoardInfoDraft } from './board-info';

export function startGateway(mainWindow: BrowserWindow): void {
  // Gateway 提供 pushUI 能力 — Worker 通过它推消息到 UI
  const pushUI = (channel: string, data: unknown) => {
    if (channel === 'chat:message' && data && typeof data === 'object') {
      const payload = data as {
        id?: string;
        text?: string;
        timestamp?: number;
        kind?: 'conversation' | 'progress' | 'detail' | 'status' | 'thinking';
        toolName?: string;
        error?: boolean;
        taskId?: string | null;
        streamId?: string;
      };
      if (typeof payload.text === 'string' && (payload.text.trim() || payload.streamId)) {
        const conversationId = listChatConversations().activeConversationId;
        const message = appendChatMessage(conversationId, {
          id: payload.id || randomUUID(),
          text: payload.text,
          role: 'agent',
          timestamp: payload.timestamp || Date.now(),
          kind: payload.kind,
          toolName: payload.toolName,
          error: payload.error,
          taskId: payload.taskId,
          streamId: payload.streamId,
        });
        mainWindow.webContents.send(channel, { ...payload, ...message, conversationId });
        return;
      }
    }
    mainWindow.webContents.send(channel, data);
  };

  setBrowserTabsEmitter((tabs) => {
    mainWindow.webContents.send('browser:tabs', { tabs });
  });

  const unsubscribeSerialEvent = subscribeSharedSerialEvents((event) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('hardboard:serial-data', event);
  });
  const unsubscribeSerialState = subscribeSharedSerialState((snapshot) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('hardboard:serial-state', snapshot);
  });
  const unsubscribeSerialClear = subscribeSharedSerialClear((event) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('hardboard:serial-clear', event);
  });
  mainWindow.once('closed', () => {
    unsubscribeSerialEvent();
    unsubscribeSerialState();
    unsubscribeSerialClear();
  });

  const orch = getOrchestrator(mainWindow, pushUI);
  registerExploreKnowledgeIpc(ipcMain);
  registerExploreZhihuStatusIpc(ipcMain);
  registerExploreRequestIpc(ipcMain);
  registerExploreAnalysisIpc(ipcMain, orch);
  registerExploreContextIpc(ipcMain);
  registerExploreSessionIpc(ipcMain);
  registerModelManagementIpc(ipcMain);
  registerRadioIpc(ipcMain);

  let firmwareImportPending = false;
  let boardInfoPickPending = false;
  let hardwareLaunchPending = false;
  const assertHardwareIdle = () => {
    if (isHardboardLauncherRunning()) throw new Error('Build 或 Flash 正在启动/运行');
    const task = orch.getTaskStatus();
    if (task.busy || task.queueLength > 0 || isExploreRequestInFlight()) throw new Error('请等待 Agent 和 Explore 任务完成');
    const serial = readSharedSerialMonitor();
    if (serial.running || serial.opening) throw new Error('请先关闭串口监视器');
  };
  const assertProjectSwitchSafe = async () => {
    if (firmwareImportPending || boardInfoPickPending || hardwareLaunchPending) throw new Error('烧录包正在导入或硬件任务正在启动，请稍后切换工程');
    if (isExploreRequestInFlight()) throw new Error('Explore 正在检索来源，请等待完成后再切换工程');
    const task = orch.getTaskStatus();
    if (task.busy || task.queueLength > 0) throw new Error('Agent 或 Explore 仍有运行/排队任务，请完成或停止后再切换工程');
    const serial = readSharedSerialMonitor();
    if (serial.running || serial.opening) throw new Error('串口仍在打开，请关闭串口后再切换工程');
    const runtime = await readHardboardRuntimeEvents(0) as { state?: { status?: string } };
    if (runtime.state?.status === 'running') throw new Error('Build 或 Flash 正在运行，完成后才能切换工程');
    assertHardwareIdle();
    if (firmwareImportPending || boardInfoPickPending || hardwareLaunchPending) throw new Error('请等待资料导入或硬件任务启动完成');
  };

  ipcMain.handle('project:session:status', async () => getProjectSessionStatus());

  ipcMain.handle('project:session:activate', async (_event, projectId: string) => {
    await assertProjectSwitchSafe();
    orch.resetAgentConversation();
    return { ok: true, ...activateProject(projectId) };
  });

  ipcMain.handle('project:session:create', async (event, name: string, boardInfoId?: string) => {
    if (event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('无法从此页面创建工程');
    await assertProjectSwitchSafe();
    const result = createProject(name, boardInfoId);
    if (boardInfoId) releaseBoardInfoDraft(boardInfoId);
    orch.resetAgentConversation();
    return { ok: true, ...result };
  });

  ipcMain.handle('project:boardInfo:pick', async (event) => {
    if (event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return { ok: false, error: '无法从此页面选择板卡信息包' };
    if (boardInfoPickPending || firmwareImportPending || hardwareLaunchPending) return { ok: false, error: '请等待当前操作完成' };
    boardInfoPickPending = true;
    try { return await pickBoardInfo(mainWindow); }
    catch (error) { return { ok: false, error: boardInfoError(error) }; }
    finally { boardInfoPickPending = false; }
  });

  ipcMain.handle('project:boardInfo:release', async (event, id: unknown) => {
    if (event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('无法从此页面移除板卡信息包');
    if (typeof id !== 'string' || !/^board-[a-f0-9]{32}$/.test(id)) throw new Error('BOARD_INFO_ID_INVALID');
    releaseBoardInfoDraft(id);
    return { ok: true };
  });

  // 聊天 — 委托 Worker
  ipcMain.handle('chat:send', async (_event, request: string | AgentTaskInput, mode?: TaskSubmitMode, conversationId?: string, messageId?: string, timestamp?: number) => {
    requireActiveProject();
    const input = normalizeAgentTaskInput(request);
    const store = listChatConversations();
    const targetConversationId = conversationId || store.activeConversationId;
    const status = orch.getTaskStatus();
    if (status.busy && targetConversationId !== store.activeConversationId) {
      throw new Error('Agent 正在工作，完成或停止后才能切换历史对话');
    }
    if (!status.busy && targetConversationId !== store.activeConversationId) activateChatConversation(targetConversationId);
    input.attachments = validateAttachmentReferences(targetConversationId, input.attachments);
    const selectedModel = snapshotEngineeringAgentModel();
    const message = appendChatMessage(targetConversationId, {
      id: messageId || randomUUID(),
      text: input.text,
      role: 'user',
      timestamp: timestamp || Date.now(),
      skillRefs: input.skillRefs,
      attachments: input.attachments,
      modelSnapshot: {
        profileId: selectedModel.profileId,
        providerId: selectedModel.providerId,
        providerName: selectedModel.providerName,
        upstreamModel: selectedModel.upstreamModel,
        protocol: selectedModel.protocol,
        baseUrl: selectedModel.baseUrl,
      },
    });
    return { ...orch.submitTask(input, mode || 'auto', targetConversationId), message };
  });

  ipcMain.handle('chat:attachments:pick', async (_event, conversationId: string) => {
    requireActiveProject();
    return pickChatAttachments(mainWindow, conversationId);
  });

  ipcMain.handle('chat:conversations:list', async () => {
    requireActiveProject();
    return listChatConversations();
  });

  ipcMain.handle('chat:conversations:get', async (_event, id?: string) => {
    requireActiveProject();
    return getChatConversation(id);
  });

  ipcMain.handle('chat:conversations:create', async () => {
    requireActiveProject();
    if (orch.getTaskStatus().busy) throw new Error('Agent 正在工作，完成或停止后才能新建对话');
    orch.resetAgentConversation();
    return createChatConversation();
  });

  ipcMain.handle('chat:conversations:activate', async (_event, id: string) => {
    requireActiveProject();
    if (orch.getTaskStatus().busy) throw new Error('Agent 正在工作，完成或停止后才能切换历史对话');
    orch.resetAgentConversation();
    return activateChatConversation(id);
  });

  ipcMain.handle('chat:conversations:delete', async (_event, id: string) => {
    requireActiveProject();
    if (orch.getTaskStatus().busy) throw new Error('Agent 正在工作，完成或停止后才能删除对话');
    orch.resetAgentConversation();
    return deleteChatConversation(id);
  });

  ipcMain.handle('chat:conversations:rename', async (_event, id: string, title: string) => {
    requireActiveProject();
    if (orch.getTaskStatus().busy) throw new Error('Agent 正在工作，完成或停止后才能重命名对话');
    return renameChatConversation(id, title);
  });

  ipcMain.handle('chat:conversations:pin', async (_event, id: string, pinned: boolean) => {
    requireActiveProject();
    if (orch.getTaskStatus().busy) throw new Error('Agent 正在工作，完成或停止后才能调整置顶');
    return setChatConversationPinned(id, pinned);
  });

  ipcMain.handle('task:status', async () => orch.getTaskStatus());

  // 任务控制 — 委托 Worker
  ipcMain.handle('task:pause', async () => {
    orch.pause();
    return { ok: true };
  });

  ipcMain.handle('task:resume', async () => {
    orch.resume();
    return { ok: true };
  });

  ipcMain.handle('task:stop', async () => {
    orch.stop();
    return { ok: true };
  });

  // 浏览器控制 — 委托 Worker
  ipcMain.handle('browser:navigate', async (_event, url: string) => {
    orch.navigateBrowser(url);
    return { ok: true };
  });

  ipcMain.handle('browser:getState', async () => {
    return orch.getBrowserState();
  });

  ipcMain.handle('browser:setBounds', async (_event, bounds: { x: number; y: number; width: number; height: number }) => {
    setBrowserViewBoundsFromRenderer(bounds);
    return { ok: true };
  });

  ipcMain.handle('browser:listTabs', async () => {
    return { tabs: listTabs() };
  });

  ipcMain.handle('workbench:getOverview', async () => {
    return getWorkbenchOverview();
  });

  ipcMain.handle('workbench:openItem', async (_event, targetPath: string) => {
    try {
      const result = openWorkbenchItem(targetPath);
      openTabUrl(result.url, true);
      return { ok: true, ...result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('workbench:openFolder', async (_event, targetPath: string) => {
    try {
      const result = openWorkbenchItem(targetPath);
      if (result.kind !== 'dir') return { ok: false, error: '只能在资源管理器中打开目录' };
      const error = await shell.openPath(result.path);
      return error ? { ok: false, error } : { ok: true, path: result.path };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('workbench:readFile', async (_event, targetPath: string) => {
    assertPathInActiveProject(targetPath);
    return readWorkbenchFile(targetPath);
  });

  ipcMain.handle('app:open-external', async (_event, url: unknown) => {
    if (typeof url !== 'string' || url.length > 2_048) throw new Error('外部地址无效');
    let target: URL;
    try { target = new URL(url); }
    catch { throw new Error('外部地址无效'); }
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) {
      throw new Error('只允许打开不含凭据的 HTTP/HTTPS 来源');
    }
    await shell.openExternal(target.toString());
    return { ok: true };
  });

  ipcMain.handle('workbench:listDirectory', async (_event, targetPath: string) => {
    assertPathInActiveProject(targetPath);
    return listWorkbenchDirectory(targetPath);
  });

  ipcMain.handle('workbench:writeFile', async (_event, targetPath: string, text: string) => {
    assertMutableProjectPath(targetPath);
    return writeWorkbenchFile(targetPath, text);
  });

  ipcMain.handle('workbench:createEntry', async (_event, parentPath: string, name: string, kind: 'file' | 'dir') => {
    assertMutableProjectPath(parentPath, true);
    assertMutableProjectPath(path.join(parentPath, name));
    return createWorkbenchEntry(parentPath, name, kind);
  });

  ipcMain.handle('workbench:renameEntry', async (_event, targetPath: string, nextName: string) => {
    assertMutableProjectPath(targetPath);
    assertMutableProjectPath(path.join(path.dirname(targetPath), nextName));
    return renameWorkbenchEntry(targetPath, nextName);
  });

  ipcMain.handle('workbench:deleteEntry', async (_event, targetPath: string) => {
    assertMutableProjectPath(targetPath);
    return deleteWorkbenchEntry(targetPath);
  });

  ipcMain.handle('skills:list', async () => {
    try {
      return { ok: true, ...listManagedSkills() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('skills:get', async (_event, id: string) => {
    try {
      return { ok: true, skill: getManagedSkill(id) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('skills:save', async (_event, input: { id: string; name: string; description: string; body: string; originalId?: string }) => {
    try {
      return { ok: true, skill: saveManagedSkill(input), snapshot: listManagedSkills() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('skills:delete', async (_event, id: string) => {
    try {
      await deleteManagedSkill(id);
      return { ok: true, snapshot: listManagedSkills() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('skills:sync', async () => {
    try {
      return { ok: true, ...syncManagedSkills() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('smoke:workbench:finish', async (_event, result: unknown) => {
    const resultFile = process.env.VIBEIDE_SMOKE_RESULT_FILE;
    if (resultFile) {
      fs.mkdirSync(path.dirname(resultFile), { recursive: true });
      fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf-8');
    }
    setTimeout(() => {
      mainWindow.close();
    }, 250);
    return { ok: true };
  });

  ipcMain.handle('browser:activateTab', async (_event, id: string) => {
    activateTab(id);
    return { ok: true };
  });

  ipcMain.handle('browser:closeTab', async (_event, id: string) => {
    closeTab(id);
    return { ok: true };
  });

  ipcMain.handle('browser:startRecording', async () => {
    await startBrowserRecording();
    return { ok: true };
  });

  ipcMain.handle('browser:stopRecording', async (_event, label?: string) => {
    const result = await stopBrowserRecording(label || 'browser-recording');
    return { ok: true, ...result };
  });

  ipcMain.handle('browser:replayLatestRecording', async () => {
    try {
      const result = await replayLatestBrowserRecording();
      return { ok: true, ...result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('browser:replayRecording', async (_event, target?: string) => {
    try {
      const result = await replayBrowserRecording(target);
      return { ok: true, ...result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('browser:listRecordings', async () => {
    return { files: await listBrowserRecordings() };
  });

  ipcMain.handle('browser:listRecordingSummaries', async () => {
    return { recordings: await listBrowserRecordingSummaries() };
  });

  ipcMain.handle('hardboard:listDevices', async () => {
    return { devices: await listHardboardDevices() };
  });

  ipcMain.handle('hardboard:runtimeEvents', async (_event, sinceSeq?: number) => {
    return readHardboardRuntimeEvents(typeof sinceSeq === 'number' ? sinceSeq : 0);
  });

  ipcMain.handle('hardboard:runtimeHistoryClear', async () => {
    return clearHardboardRuntimeHistory();
  });

  ipcMain.handle('hardboard:firmwarePackageImport', async (event) => {
    if (event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return { ok: false, error: '无法从此页面导入烧录包' };
    if (firmwareImportPending || boardInfoPickPending || hardwareLaunchPending) return { ok: false, error: '请等待当前操作完成' };
    firmwareImportPending = true;
    try { return await pickFirmwarePackage(mainWindow); }
    catch (error) { return { ok: false, error: firmwarePackageError(error) }; }
    finally { firmwareImportPending = false; }
  });

  ipcMain.handle('hardboard:firmwarePackageSelected', async (event) => {
    if (event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return { ok: false, error: '无法从此页面读取烧录包' };
    try { return await getSelectedFirmwarePackage(); }
    catch (error) { return { ok: false, error: firmwarePackageError(error) }; }
  });

  ipcMain.handle('hardboard:buildStart', async (event, options?: { projectDir?: string; cmakeFile?: string; configFile?: string; sourceFile?: string }) => {
    if (event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return { ok: false, error: '无法从此页面启动 Build' };
    if (hardwareLaunchPending || firmwareImportPending || boardInfoPickPending) return { ok: false, error: '请等待烧录包操作完成' };
    const project = requireActiveProject();
    hardwareLaunchPending = true;
    try {
      assertHardwareIdle();
      if (requireActiveProject().id !== project.id) return { ok: false, error: '工程已切换' };
      const result = startHardboardBuild({ ...options, projectDir: project.projectDir });
      return result;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Build 启动失败' };
    } finally { hardwareLaunchPending = false; }
  });

  ipcMain.handle('hardboard:flashStart', async (event, options: { projectDir?: string; projectId?: string; port: string; packageId?: string; artifactFile?: string; configFile?: string }) => {
    if (event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return { ok: false, error: '无法从此页面烧录' };
    if (hardwareLaunchPending || firmwareImportPending || boardInfoPickPending) return { ok: false, error: '请等待当前操作完成' };
    const project = requireActiveProject();
    if (!options || typeof options.port !== 'string' || !/^(?:COM[1-9][0-9]{0,3}|\/dev\/(?:ttyUSB|ttyACM|cu\.)[A-Za-z0-9._-]+)$/.test(options.port)) return { ok: false, error: '请选择有效串口' };
    if (options.projectId && options.projectId !== project.id) return { ok: false, error: '工程已切换，请重新选择烧录来源' };
    hardwareLaunchPending = true;
    try {
      assertHardwareIdle();
      const runtime = await readHardboardRuntimeEvents(0) as { state?: { status?: string } };
      if (runtime.state?.status === 'running') return { ok: false, error: 'Build 或 Flash 正在运行' };
      if (requireActiveProject().id !== project.id) return { ok: false, error: '工程已切换' };
      const devices = await listHardboardDevices();
      if (!devices.some((device) => device.port === options.port)) return { ok: false, error: '所选串口已断开，请刷新设备' };
      if (options.packageId !== undefined) {
        if (options.projectId !== project.id) throw new Error('FIRMWARE_PACKAGE_PROJECT_CHANGED');
        const resolved = await resolveFirmwarePackageFlash(options.packageId, project.id);
        return startFirmwarePackageFlash({ projectDir: project.projectDir, port: options.port, packageId: options.packageId, packageRoot: resolved.root, planSha256: resolved.planSha256 });
      }
      return startHardboardFlash({ ...options, projectDir: project.projectDir });
    } catch (error) {
      return { ok: false, error: options.packageId ? firmwarePackageError(error) : error instanceof Error ? error.message : 'Flash 启动失败' };
    } finally { hardwareLaunchPending = false; }
  });

  ipcMain.handle('hardboard:readSource', async (_event, targetPath: string) => {
    return readHardboardSourceFile(targetPath);
  });

  ipcMain.handle('hardboard:serialStart', async (_event, options: { port: string; baudRate: number; encoding: string }) => {
    requireActiveProject();
    const result = await startSharedSerialMonitor(options, 'ui');
    return { ...result, ...readSharedSerialMonitor() };
  });

  ipcMain.handle('hardboard:serialStop', async () => {
    await stopSharedSerialMonitor('ui');
    return { ok: true, ...readSharedSerialMonitor() };
  });

  ipcMain.handle('hardboard:serialWrite', async (_event, data: string, mode: 'text' | 'hex', encoding: string) => {
    return writeSharedSerialMonitor(data, mode, encoding, 'ui');
  });

  ipcMain.handle('hardboard:serialStatus', async () => {
    return readSharedSerialMonitor();
  });

  ipcMain.handle('hardboard:serialClear', async () => {
    return clearSharedSerialMonitor('ui');
  });
}
