import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isVisibleName, readToolText, toolPath } from './paths';
import { objectSchema, stringSchema, type AgentTool } from './types';

export function fileTools(): AgentTool[] {
  const make = (name: string, description: string, parameters: Record<string, unknown>, execute: AgentTool['execute']): AgentTool => ({
    definition: { name, description, parameters }, profiles: ['default'], execute,
  });
  return [
    make('Read', '读取当前工程 UTF-8 文本文件，返回行号。不能读取 Secret、构建产物或其他工程。', objectSchema({
      path: stringSchema(), offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 400 },
    }, ['path']), async (input, context) => {
      const text = readToolText(toolPath(context.projectDir, String(input.path)));
      const lines = text.split(/\r?\n/); const offset = Number(input.offset || 1); const limit = Number(input.limit || 200);
      return { path: input.path, contentSha256: createHash('sha256').update(text).digest('hex'), totalLines: lines.length, content: lines.slice(offset - 1, offset - 1 + limit).map((line, i) => `${offset + i}: ${line}`).join('\n'), truncated: offset - 1 + limit < lines.length };
    }),
    make('Write', '创建或覆盖当前工程文本文件；已有文件必须提供 expectedContentSha256 防止覆盖并发改动。', objectSchema({
      path: stringSchema(), content: { type: 'string', maxLength: 128 * 1024 }, expectedContentSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    }, ['path', 'content']), async (input, context) => {
      const file = toolPath(context.projectDir, String(input.path)); const content = String(input.content);
      if (Buffer.byteLength(content) > 128 * 1024) throw new Error('TOOL_FILE_TOO_LARGE');
      if (fs.existsSync(file)) {
        if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== input.expectedContentSha256) throw new Error('WRITE_REQUIRES_MATCHING_CONTENT_SHA256');
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      toolPath(context.projectDir, String(input.path));
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' }); fs.renameSync(temporary, file); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      return { path: input.path, bytes: Buffer.byteLength(content) };
    }),
    make('Edit', '在当前工程文件中精确替换唯一 oldText；不匹配或重复时拒绝。', objectSchema({
      path: stringSchema(), oldText: stringSchema(128 * 1024), newText: { type: 'string', maxLength: 128 * 1024 },
    }, ['path', 'oldText', 'newText']), async (input, context) => {
      const file = toolPath(context.projectDir, String(input.path)); const before = readToolText(file);
      const oldText = String(input.oldText); const index = before.indexOf(oldText);
      if (index < 0 || before.indexOf(oldText, index + 1) >= 0) throw new Error('EDIT_MATCH_MUST_BE_UNIQUE');
      const after = before.slice(0, index) + String(input.newText) + before.slice(index + oldText.length);
      if (Buffer.byteLength(after) > 128 * 1024) throw new Error('TOOL_FILE_TOO_LARGE');
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, after, { encoding: 'utf8', flag: 'wx' });
        if (fs.readFileSync(file, 'utf8') !== before) throw new Error('EDIT_CONCURRENT_CHANGE');
        fs.renameSync(temporary, file);
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      return { path: input.path, replaced: 1 };
    }),
    make('List', '列出当前工程文件夹，自动跳过 Secret、链接、构建目录；最多 200 项。', objectSchema({ path: stringSchema() }), async (input, context) => {
      const directory = toolPath(context.projectDir, String(input.path || '.'), true);
      const entries = fs.readdirSync(directory, { withFileTypes: true }).filter(e => isVisibleName(e.name) && !e.isSymbolicLink());
      return { entries: entries.slice(0, 200).map(e => ({ name: e.name, directory: e.isDirectory() })), truncated: entries.length > 200 };
    }),
    make('Grep', '在当前工程有界搜索文字（literal）；跳过 Secret、build、链接、二进制。最多 200 文件、100 命中。', objectSchema({ query: stringSchema(256), path: stringSchema() }, ['query']), async (input, context) => {
      const root = toolPath(context.projectDir, String(input.path || '.'), true); const matches: unknown[] = []; let scanned = 0; let visited = 0;
      function visit(directory: string, depth: number): void {
        if (depth > 5 || scanned >= 200 || visited >= 1000 || matches.length >= 100) return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (++visited >= 1000 || scanned >= 200 || matches.length >= 100) break;
          if (!isVisibleName(entry.name) || entry.isSymbolicLink()) continue;
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) visit(file, depth + 1);
          else if (entry.isFile()) {
            scanned++;
            try {
              toolPath(context.projectDir, file);
              readToolText(file, 32 * 1024).split(/\r?\n/).forEach((line, i) => {
                if (matches.length < 100 && line.includes(String(input.query))) matches.push({ path: path.relative(context.projectDir, file), line: i + 1, text: line.slice(0, 500) });
              });
            } catch { /* inaccessible/binary/large candidates are intentionally skipped */ }
          }
        }
      }
      if (!fs.statSync(root).isDirectory()) throw new Error('GREP_PATH_MUST_BE_DIRECTORY');
      visit(root, 0); return { matches, scanned, truncated: scanned >= 200 || visited >= 1000 || matches.length >= 100 };
    }),
  ];
}
