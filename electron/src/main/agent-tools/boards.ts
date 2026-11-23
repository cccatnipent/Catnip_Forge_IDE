import fs from 'node:fs';
import path from 'node:path';
import { getAgentDir } from '../paths';
import { objectSchema, stringSchema, type AgentTool } from './types';
import { readToolText, toolPath } from './paths';
import { getProjectBoardInfo, readProjectBoardInfo } from '../board-info';

export function boardTool(root = path.join(getAgentDir(), 'board-packs')): AgentTool {
  function readPack(id: string): Record<string, unknown> {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error('BOARD_PACK_ID_INVALID');
    const file = toolPath(root, `${id}/manifest.json`);
    const pack = JSON.parse(readToolText(file, 16 * 1024)) as Record<string, unknown>;
    if (pack.schemaVersion !== 1 || pack.id !== id || typeof pack.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(pack.version) || typeof pack.chip !== 'string' || !Array.isArray(pack.documents)) throw new Error('BOARD_PACK_MANIFEST_INVALID');
    return pack;
  }
  return {
    definition: {
      name: 'BoardPack', description: '枚举内置板卡资料和当前工程由用户导入的只读资料。source=project 加载工程绑定摘要或声明文本；读取 pinout.json 等结构化资料后，按 documentationLinks 用同一 Tool 读取器件/开发板关联文字说明。documentation 是包根目录相对路径，不访问 URL；硬件配置须由资料明确支持。',
      parameters: objectSchema({ source: { type: 'string', enum: ['builtin', 'project'] }, id: stringSchema(64), document: stringSchema(), offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 400 } }),
    }, profiles: ['default'],
    async execute(input, context) {
      if (input.source === 'project') {
        const projectPack = getProjectBoardInfo(context.projectDir);
        if (!projectPack) throw new Error('BOARD_INFO_NOT_BOUND');
        if (input.id && input.id !== projectPack.id) throw new Error('BOARD_INFO_CROSS_PROJECT');
        return readProjectBoardInfo(context.projectDir, input.document === undefined ? undefined : String(input.document), Number(input.offset ?? 1), Number(input.limit ?? 200));
      }
      if (input.offset !== undefined || input.limit !== undefined) throw new Error('BOARD_PACK_PAGING_REQUIRES_PROJECT_SOURCE');
      if (!input.id) {
        if (input.document) throw new Error('BOARD_PACK_ID_REQUIRED');
        const packs = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.isSymbolicLink()).slice(0, 50).map(e => readPack(e.name)) : [];
        return { packs, projectPack: getProjectBoardInfo(context.projectDir) };
      }
      const id = String(input.id); const pack = readPack(id);
      if (!input.document) return pack;
      const document = String(input.document);
      if (!(pack.documents as unknown[]).includes(document)) throw new Error('BOARD_PACK_DOCUMENT_NOT_DECLARED');
      return { id, document, content: readToolText(toolPath(path.join(root, id), document), 24 * 1024) };
    },
  };
}
