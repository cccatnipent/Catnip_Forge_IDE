import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { app, BrowserWindow, dialog } from 'electron';
import type { BoardInfoPickResult, BoardInfoSummary } from '../common/board-info';
import { execBoardInfoValidator } from './hardboard';
import { getHardboardDir } from './paths';
import { boardDocumentationSignature, collectBoardDocumentationLinks } from '../common/board-documentation';

interface ReferenceFile { path: string; bytes: number; sha256: string }
interface Binding extends BoardInfoSummary { schemaVersion: 1; files: ReferenceFile[] }
const ID = /^board-[a-f0-9]{32}$/;
const PRIVATE = /(?:secret|credential|password|token|apikey|\.env|\.catnip|\.git)/i;
let draftRoot: string | null = null;
const drafts = new Map<string, { digest: string; expires: number }>();

function checkedPath(root: string, relative = ''): string {
  const resolved = path.resolve(root, relative);
  const inside = path.relative(path.resolve(root), resolved);
  if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error('BOARD_INFO_PATH_INVALID');
  let cursor = path.parse(resolved).root;
  for (const segment of resolved.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const info = fs.lstatSync(cursor);
    if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1)) throw new Error('BOARD_INFO_LINK_REFUSED');
  }
  return resolved;
}

function boundedFile(root: string, relative: string, limit: number): Buffer {
  const file = checkedPath(root, relative);
  const descriptor = fs.openSync(file, 'r');
  try {
    const info = fs.fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw new Error('BOARD_INFO_FILE_INVALID');
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(descriptor, bytes, length, bytes.length - length, length);
      if (!read) break;
      length += read;
    }
    if (length > limit || length !== info.size) throw new Error('BOARD_INFO_FILE_INVALID');
    return bytes.subarray(0, length);
  } finally { fs.closeSync(descriptor); }
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function referencePath(name: string): void {
  if (typeof name !== 'string' || name.length > 240 || name.split('/').some(part => !part || part === '.' || part === '..' || /[\x00-\x1f\x7f<>:"\\|?*]|[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part) || PRIVATE.test(part))) throw new Error('BOARD_INFO_PATH_INVALID');
  if (name !== 'SHA256SUMS.txt' && name !== 'upstream-reference/config.h' && !/\.(?:md|txt|json|pdf)$/i.test(name)) throw new Error('BOARD_INFO_CONTENT_TYPE_REFUSED');
}

function loadBinding(root: string, expectedDigest?: string): Binding {
  const bytes = boundedFile(root, 'binding.json', 128 * 1024);
  if (expectedDigest && hash(bytes) !== expectedDigest) throw new Error('BOARD_INFO_CHANGED_RESELECT_REQUIRED');
  const value = JSON.parse(bytes.toString('utf8')) as Binding;
  if (value.schemaVersion !== 1 || !ID.test(value.id) || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 128 || !Array.isArray(value.documents)) throw new Error('BOARD_INFO_BINDING_INVALID');
  for (const key of ['boardId', 'name', 'version', 'archiveName', 'archiveSha256', 'chip'] as const) {
    if (typeof value[key] !== 'string' || !value[key] || value[key].length > 200 || /[\x00-\x1f\x7f<>]/.test(value[key])) throw new Error('BOARD_INFO_BINDING_INVALID');
  }
  if (!/^[a-f0-9]{64}$/.test(value.archiveSha256) || !/^\d+\.\d+\.\d+$/.test(value.version) || (value.display !== null && typeof value.display !== 'string')) throw new Error('BOARD_INFO_BINDING_INVALID');
  const names = new Set<string>();
  const verifiedJson = new Map<string, Buffer>();
  let total = 0;
  for (const row of value.files) {
    referencePath(row.path);
    if (names.has(row.path.toLowerCase()) || !Number.isInteger(row.bytes) || row.bytes < 0 || row.bytes > 4 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('BOARD_INFO_BINDING_INVALID');
    names.add(row.path.toLowerCase());
    total += row.bytes;
    if (total > 16 * 1024 * 1024) throw new Error('BOARD_INFO_BINDING_INVALID');
    const content = boundedFile(root, `references/${row.path}`, row.bytes);
    if (content.length !== row.bytes || hash(content) !== row.sha256) throw new Error('BOARD_INFO_CHECKSUM_MISMATCH');
    if (row.path.toLowerCase().endsWith('.json')) verifiedJson.set(row.path, content);
  }
  if (value.documents.length !== new Set(value.documents).size) throw new Error('BOARD_INFO_BINDING_INVALID');
  if (value.documents.length > 128 || value.documents.some(name => typeof name !== 'string' || !value.files.some(row => row.path === name) || /\.pdf$/i.test(name) || name === 'SHA256SUMS.txt')) throw new Error('BOARD_INFO_BINDING_INVALID');
  const declaredDocuments = new Set(value.documents);
  const links = value.documents.filter(name => name.toLowerCase().endsWith('.json')).sort().flatMap(name => {
    const content = verifiedJson.get(name);
    if (!content || content.length > 128 * 1024) throw new Error('BOARD_INFO_FILE_INVALID');
    return collectBoardDocumentationLinks(name, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)), declaredDocuments);
  });
  if (links.length > 64 || (value.documentationLinks !== undefined && boardDocumentationSignature(value.documentationLinks) !== boardDocumentationSignature(links))) throw new Error('BOARD_INFO_DOCUMENTATION_INVALID');
  value.documentationLinks = links;
  return value;
}

function summary(value: Binding): BoardInfoSummary {
  const { id, boardId, name, version, archiveName, archiveSha256, chip, display, documents, documentationLinks } = value;
  return { id, boardId, name, version, archiveName, archiveSha256, chip, display, documents, documentationLinks };
}

function stagingRoot(): string {
  if (!draftRoot) {
    draftRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'catnip-board-info-'));
    app.once('will-quit', clearBoardInfoDrafts);
  }
  return draftRoot;
}

export function clearBoardInfoDrafts(): void {
  drafts.clear();
  if (draftRoot) fs.rmSync(draftRoot, { recursive: true, force: true });
  draftRoot = null;
}

export function releaseBoardInfoDraft(id: string): void {
  if (!ID.test(id) || !draftRoot || !drafts.has(id)) return;
  fs.rmSync(path.join(draftRoot, id), { recursive: true, force: true });
  drafts.delete(id);
}

export async function importBoardInfoFile(file: string): Promise<BoardInfoSummary> {
  const root = stagingRoot();
  for (const [id, entry] of drafts) if (entry.expires < Date.now()) {
    fs.rmSync(path.join(root, id), { recursive: true, force: true }); drafts.delete(id);
  }
  if (drafts.size >= 8) throw new Error('BOARD_INFO_DRAFT_LIMIT');
  const id = `board-${randomUUID().replace(/-/g, '')}`;
  await execBoardInfoValidator(['import', root, id, file]);
  const directory = path.join(root, id);
  try {
    const value = loadBinding(directory);
    drafts.set(id, { digest: hash(boundedFile(directory, 'binding.json', 128 * 1024)), expires: Date.now() + 60 * 60 * 1000 });
    return summary(value);
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}

export async function pickBoardInfo(window: BrowserWindow): Promise<BoardInfoPickResult> {
  const result = await dialog.showOpenDialog(window, {
    title: '选择板卡信息包', defaultPath: getHardboardDir('packages'), properties: ['openFile'],
    filters: [{ name: '板卡信息包（ZIP）', extensions: ['zip'] }],
  });
  if (result.canceled || !result.filePaths.length) return { ok: true, canceled: true };
  return { ok: true, package: await importBoardInfoFile(result.filePaths[0]) };
}

export function installBoardInfoDraft(id: string, projectDir: string): BoardInfoSummary {
  const entry = typeof id === 'string' && ID.test(id) ? drafts.get(id) : null;
  if (!entry || !draftRoot || entry.expires < Date.now()) throw new Error('BOARD_INFO_SELECTION_EXPIRED');
  const source = checkedPath(draftRoot, id);
  const value = loadBinding(source, entry.digest);
  const state = path.join(projectDir, '.catnip');
  if (!fs.existsSync(state)) fs.mkdirSync(state);
  checkedPath(projectDir, '.catnip');
  const target = path.join(state, 'board-info');
  if (fs.existsSync(target)) throw new Error('BOARD_INFO_DESTINATION_EXISTS');
  fs.mkdirSync(target);
  for (const row of value.files) {
    const bytes = boundedFile(source, `references/${row.path}`, row.bytes);
    if (hash(bytes) !== row.sha256) throw new Error('BOARD_INFO_CHECKSUM_MISMATCH');
    const file = path.join(target, 'references', row.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { flag: 'wx' });
  }
  const bindingBytes = boundedFile(source, 'binding.json', 128 * 1024);
  if (hash(bindingBytes) !== entry.digest) throw new Error('BOARD_INFO_CHANGED_RESELECT_REQUIRED');
  fs.writeFileSync(path.join(target, 'binding.json'), bindingBytes, { flag: 'wx' });
  fs.writeFileSync(path.join(target, 'binding.sha256'), entry.digest, { flag: 'wx' });
  return summary(loadBinding(target, entry.digest));
}

export function getProjectBoardInfo(projectDir: string): BoardInfoSummary | null {
  const target = path.join(projectDir, '.catnip', 'board-info');
  if (!fs.existsSync(target)) return null;
  checkedPath(projectDir, '.catnip/board-info');
  const expected = boundedFile(target, 'binding.sha256', 64).toString('utf8');
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('BOARD_INFO_BINDING_INVALID');
  return summary(loadBinding(target, expected));
}

export function readProjectBoardInfo(projectDir: string, document?: string, offset = 1, limit = 200): unknown {
  const pack = getProjectBoardInfo(projectDir);
  if (!pack) throw new Error('BOARD_INFO_NOT_BOUND');
  if (!document) return pack;
  if (!pack.documents.includes(document)) throw new Error('BOARD_PACK_DOCUMENT_NOT_DECLARED');
  const bytes = boundedFile(path.join(projectDir, '.catnip', 'board-info'), `references/${document}`, 128 * 1024);
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split(/\r?\n/);
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  const documentationLinks = document.toLowerCase().endsWith('.json')
    ? (pack.documentationLinks ?? []).filter(link => link.source === document)
    : undefined;
  return {
    id: pack.id, source: 'project', document, contentSha256: hash(bytes),
    ...(documentationLinks?.length ? { documentationLinks } : {}),
    content: selected.map((line, index) => `${offset + index}: ${line}`).join('\n'),
    offset, totalLines: lines.length, truncated: offset - 1 + selected.length < lines.length,
  };
}
export function buildProtectedBoardContext(projectDir: string): string | null {
  const pack = getProjectBoardInfo(projectDir);
  if (!pack) return null;
  const root = path.join(projectDir, '.catnip', 'board-info');
  const documents = pack.documents.map(document => {
    const bytes = boundedFile(root, `references/${document}`, 128 * 1024);
    const row = JSON.parse(boundedFile(root, 'binding.json', 128 * 1024).toString('utf8')).files.find((file: ReferenceFile) => file.path === document) as ReferenceFile | undefined;
    if (!row || bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw new Error('BOARD_INFO_CHECKSUM_MISMATCH');
    return { document, contentSha256: hash(bytes), content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  });
  const context = JSON.stringify({ source: 'project', package: pack, documents });
  // Preserve every declared text byte or fail explicitly; never trim board facts to fit.
  if (Buffer.byteLength(context, 'utf8') > 512 * 1024) throw new Error('BOARD_INFO_PROTECTED_CONTEXT_TOO_LARGE');
  const verified = getProjectBoardInfo(projectDir);
  if (verified?.id !== pack.id || verified.archiveSha256 !== pack.archiveSha256) throw new Error('BOARD_INFO_CHECKSUM_MISMATCH');
  return context;
}


export function boardInfoError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  const labels: Record<string, string> = {
    BOARD_INFO_MANIFEST_MISSING: '请选择板卡信息 ZIP。任务素材包和烧录包不能作为板卡资料。',
    BOARD_INFO_CHECKSUM_MISMATCH: '板卡信息包校验失败，文件内容与 SHA-256 不一致。',
    BOARD_INFO_DOCUMENTATION_INVALID: '板卡说明关联无效。请使用包内已声明的 Markdown/文字相对路径，并检查文件是否存在。',
    BOARD_INFO_SELECTION_EXPIRED: '板卡信息包选择已失效，请重新选择。',
    BOARD_INFO_CHANGED_RESELECT_REQUIRED: '板卡资料已变更，请重新选择信息包。',
  };
  return labels[code] || `板卡信息包校验失败（${/^BOARD_INFO_[A-Z_]+$/.test(code) ? code : 'BOARD_INFO_INVALID'}）`;
}
