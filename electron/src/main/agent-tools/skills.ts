import fs from 'node:fs';
import path from 'node:path';
import { getManagedSkill } from '../skill-manager';
import { objectSchema, stringSchema, type AgentTool } from './types';
import { readToolText, toolPath } from './paths';

export function skillTool(): AgentTool {
  return {
    definition: {
      name: 'Skill', description: '加载已有 Skill 的 SKILL.md 或相对路径的文本 support file。只读，不执行脚本。',
      parameters: objectSchema({ skill: { ...stringSchema(64), pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' }, file: stringSchema() }, ['skill']),
    },
    profiles: ['default', 'explore_analysis'],
    async execute(input) {
      const skill = getManagedSkill(String(input.skill));
      if (!skill.deployed) throw new Error('SKILL_NOT_DEPLOYED');
      const source = input.file ? toolPath(skill.folderPath, String(input.file)) : skill.sourcePath;
      if (fs.lstatSync(source).isSymbolicLink()) throw new Error('SKILL_LINK_REFUSED');
      return { skill: skill.id, directory: path.dirname(skill.sourcePath), instructions: readToolText(source, 100 * 1024) };
    },
  };
}
