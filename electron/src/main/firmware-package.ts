import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { BrowserWindow, dialog } from 'electron';
import type { FirmwarePackageResult, FirmwarePackageSummary } from '../common/firmware-package';
import { getHardboardDir, getUserDataPath } from './paths';
import { requireActiveProject } from './project-session';
import { execHardboardPackageValidator } from './hardboard';

interface Selection { id: string; planSha256: string }
const ID = /^firmware-[a-f0-9]{32}$/;

export function firmwarePackagesRoot(projectId: string): string {
  if (!/^project-[a-f0-9]{32}$/.test(projectId)) throw new Error('FIRMWARE_PACKAGE_PROJECT_INVALID');
  return getUserDataPath('firmware-packages', projectId);
}

function ensureDirectory(directory: string): void {
  const parent = path.dirname(directory);
  if (parent !== directory) ensureDirectory(parent);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('FIRMWARE_PACKAGE_LINK_REFUSED');
}

function checkedFile(file: string, maxBytes: number): Buffer {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes || fs.lstatSync(file).isSymbolicLink()) throw new Error('FIRMWARE_PACKAGE_FILE_INVALID');
    const buffer = Buffer.alloc(maxBytes + 1);
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (length > maxBytes || length !== stat.size) throw new Error('FIRMWARE_PACKAGE_FILE_INVALID');
    return buffer.subarray(0, length);
  } finally { fs.closeSync(descriptor); }
}

function planDigest(root: string, id: string): string {
  const directory = path.join(root, id);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('FIRMWARE_PACKAGE_LINK_REFUSED');
  return createHash('sha256').update(checkedFile(path.join(directory, 'package.json'), 512 * 1024)).digest('hex');
}

function summary(value: Record<string, unknown>, projectId: string): FirmwarePackageSummary {
  // Reconstruct the IPC result: no source paths, evidence/log content or
  // package-provided commands are passed to Renderer.
  const { id, name, version, archiveName, archiveSha256, chip, flashMode, flashFrequency, flashSize, images } = value;
  if (typeof id !== 'string' || !ID.test(id) || !Array.isArray(images)) throw new Error('FIRMWARE_PACKAGE_METADATA_INVALID');
  return { id, projectId, name, version, archiveName, archiveSha256, chip, flashMode, flashFrequency, flashSize, images } as FirmwarePackageSummary;
}

export async function importFirmwarePackageFile(file: string, projectId: string): Promise<FirmwarePackageSummary> {
  const project = requireActiveProject();
  if (project.id !== projectId) throw new Error('FIRMWARE_PACKAGE_PROJECT_CHANGED');
  const root = firmwarePackagesRoot(project.id);
  ensureDirectory(root);
  const id = `firmware-${randomUUID().replace(/-/g, '')}`;
  const plan = await execHardboardPackageValidator(['import', root, id, project.projectDir, file]);
  if (requireActiveProject().id !== project.id) throw new Error('FIRMWARE_PACKAGE_PROJECT_CHANGED');
  const selection: Selection = { id, planSha256: planDigest(root, id) };
  const pointer = path.join(root, 'selection.json');
  const temporary = path.join(root, `.selection-${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(selection), { flag: 'wx', mode: 0o600 });
  try { fs.renameSync(temporary, pointer); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return summary(plan, project.id);
}

export async function pickFirmwarePackage(window: BrowserWindow): Promise<FirmwarePackageResult> {
  const project = requireActiveProject();
  const result = await dialog.showOpenDialog(window, {
    title: '导入烧录包',
    defaultPath: getHardboardDir('packages'),
    properties: ['openFile'],
    filters: [{ name: '固件烧录包（ZIP）', extensions: ['zip'] }],
  });
  if (result.canceled || !result.filePaths.length) return { ok: true, canceled: true };
  return { ok: true, package: await importFirmwarePackageFile(result.filePaths[0], project.id) };
}

export async function getSelectedFirmwarePackage(): Promise<FirmwarePackageResult> {
  const project = requireActiveProject();
  const root = firmwarePackagesRoot(project.id);
  const pointer = path.join(root, 'selection.json');
  if (!fs.existsSync(pointer)) return { ok: true };
  ensureDirectory(root);
  const selection = JSON.parse(checkedFile(pointer, 1024).toString('utf8')) as Selection;
  const validated = await resolveFirmwarePackageFlash(selection.id, project.id);
  return { ok: true, package: validated.package };
}

export async function resolveFirmwarePackageFlash(id: string, projectId: string): Promise<{ root: string; planSha256: string; package: FirmwarePackageSummary }> {
  const project = requireActiveProject();
  if (project.id !== projectId) throw new Error('FIRMWARE_PACKAGE_PROJECT_CHANGED');
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('FIRMWARE_PACKAGE_ID_INVALID');
  const root = firmwarePackagesRoot(project.id);
  ensureDirectory(root);
  const selection = JSON.parse(checkedFile(path.join(root, 'selection.json'), 1024).toString('utf8')) as Selection;
  if (selection.id !== id || !/^[a-f0-9]{64}$/.test(selection.planSha256)) throw new Error('FIRMWARE_PACKAGE_SELECTION_INVALID');
  if (planDigest(root, id) !== selection.planSha256) throw new Error('FIRMWARE_PACKAGE_CHANGED_REIMPORT_REQUIRED');
  const plan = await execHardboardPackageValidator(['inspect', root, id, project.projectDir, selection.planSha256]);
  if (requireActiveProject().id !== project.id) throw new Error('FIRMWARE_PACKAGE_PROJECT_CHANGED');
  return { root, planSha256: selection.planSha256, package: summary(plan, project.id) };
}

export function firmwarePackageError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  const explanations: Record<string, string> = {
    FIRMWARE_PACKAGE_MANIFEST_MISSING: '没有找到固件清单。请选择参考固件 ZIP；板卡资料包和任务素材包不能直接烧录。',
    FIRMWARE_PACKAGE_CHECKSUM_MISMATCH: '烧录包校验失败：文件内容与 SHA-256 不一致。',
    FIRMWARE_PACKAGE_IMAGE_RANGE_INVALID: '烧录偏移重叠或超出 Flash 容量。',
    FIRMWARE_PACKAGE_CHANGED_REIMPORT_REQUIRED: '导入后的烧录包已变更，请重新导入。',
    FIRMWARE_PACKAGE_PROJECT_CHANGED: '当前工程已切换，请在目标工程重新导入或选择烧录包。',
  };
  return explanations[code] || `烧录包校验失败（${/^FIRMWARE_PACKAGE_[A-Z_]+$/.test(code) ? code : 'FIRMWARE_PACKAGE_INVALID'}）`;
}
