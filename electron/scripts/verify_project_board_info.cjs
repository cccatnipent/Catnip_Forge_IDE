const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { app } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catnip-project-board-test-'));
app.setPath('userData', path.join(root, 'user-data'));
process.env.CATNIP_PROJECTS_ROOT = path.join(root, 'projects');
process.env.CATNIP_PROJECT_SESSIONS_ROOT = path.join(root, 'sessions');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function main() {
  await app.whenReady();
  const boards = require('../dist/main/board-info.js');
  const projects = require('../dist/main/project-session.js');
  const { createToolRegistry } = require('../dist/main/agent-tools/index.js');
  const { buildContext } = require('../dist/main/worker/context.js');
  const { getHardboardDir } = require('../dist/main/paths.js');
  const kit = getHardboardDir('packages', 'otto-st7789-board-adaptation-kit-v1.1.0.zip');
  const original = sha(fs.readFileSync(kit));
  assert.equal(projects.getProjectSessionStatus().activeProject, null);
  const plain = projects.createProject('without-board').createdProject;
  assert.equal(plain.boardInfo, null);
  const draft = await boards.importBoardInfoFile(kit);
  assert.equal(draft.archiveSha256, original);
  assert.equal(projects.requireActiveProject().id, plain.id, 'import selected another project');
  assert(!JSON.stringify(draft).includes(root), 'Renderer summary exposed Main temporary paths');
  const created = projects.createProject('with-board', draft.id).createdProject;
  assert.equal(created.boardInfo.id, draft.id);
  assert.equal(created.boardInfo.documents.length, 14);
  const boundRoot = path.join(created.projectDir, '.catnip', 'board-info');
  const binding = JSON.parse(fs.readFileSync(path.join(boundRoot, 'binding.json'), 'utf8'));
  for (const row of binding.files) assert.equal(sha(fs.readFileSync(path.join(boundRoot, 'references', row.path))), row.sha256);
  const protectedBoard = JSON.parse(boards.buildProtectedBoardContext(created.projectDir));
  assert.equal(protectedBoard.documents.length, 14);
  for (const document of protectedBoard.documents) {
    assert.equal(document.content, fs.readFileSync(path.join(boundRoot, 'references', document.document), 'utf8'));
    assert.equal(document.contentSha256, sha(Buffer.from(document.content, 'utf8')));
  }
  assert(protectedBoard.package.documentationLinks.some(link => link.source === 'hardware/pinout.json' && link.pointer === '/lcd' && link.documents.includes('hardware/ST7789.md')));
  assert.match(protectedBoard.documents.find(document => document.document === 'hardware/ST7789.md').content, /4092/);
  const { boardDocumentationSignature, collectBoardDocumentationLinks } = require('../dist/common/board-documentation');
  const declared = new Set(created.boardInfo.documents);
  for (const bad of ['../escape.md', 'https://example.com/manual.md', 'hardware/missing.md', 'hardware/schematic/otto-robot-schematic.pdf']) {
    assert.throws(() => collectBoardDocumentationLinks('hardware/pinout.json', { lcd: { documentation: [bad] } }, declared), /DOCUMENTATION_INVALID/);
  }
  assert.deepEqual(collectBoardDocumentationLinks('legacy.json', { lcd: { controller: 'ST7789' } }, declared), []);
  assert.equal(boardDocumentationSignature(protectedBoard.package.documentationLinks), boardDocumentationSignature([...protectedBoard.package.documentationLinks].reverse()));
  assert.throws(() => boardDocumentationSignature({}), /DOCUMENTATION_INVALID/);
  const rawBinding = fs.readFileSync(path.join(boundRoot, 'binding.json'));
  const rawBindingHash = fs.readFileSync(path.join(boundRoot, 'binding.sha256'));
  const mismatched = { ...binding, documentationLinks: [] };
  const changedBinding = Buffer.from(JSON.stringify(mismatched));
  fs.writeFileSync(path.join(boundRoot, 'binding.json'), changedBinding);
  fs.writeFileSync(path.join(boundRoot, 'binding.sha256'), sha(changedBinding));
  assert.throws(() => boards.getProjectBoardInfo(created.projectDir), /DOCUMENTATION_INVALID/, 'Main trusted stale association metadata');
  fs.writeFileSync(path.join(boundRoot, 'binding.json'), rawBinding);
  fs.writeFileSync(path.join(boundRoot, 'binding.sha256'), rawBindingHash);
  const { buildRigInitConfig } = require('../dist/main/agent.js');
  const budgetModel = { upstreamModel: 'offline', baseUrl: 'http://127.0.0.1', authToken: 'fixture-no-real-credential', authField: 'ANTHROPIC_API_KEY', contextWindow: 1000000, reserveTokens: 80000, maxOutputTokens: 32768, keepRecentTokens: 24000 };
  const init = buildRigInitConfig('default', budgetModel, [], { conversationId: 'board-test' });
  assert.deepEqual(JSON.parse(init.protectedContext), protectedBoard);
  assert.equal(init.contextWindow, 1000000);
  assert.equal(buildRigInitConfig('explore_analysis', budgetModel, [], { conversationId: 'board-test' }).protectedContext, null);
  const context = { profile: 'default', projectId: created.id, projectDir: created.projectDir, signal: new AbortController().signal };
  const registry = createToolRegistry(context);
  const exec = async (name, input) => {
    const result = await registry.execute(name, input);
    assert.equal(result.isError, false, result.content);
    return JSON.parse(result.content);
  };
  assert.equal((await exec('BoardPack', {})).projectPack.id, draft.id);
  assert.equal((await exec('BoardPack', { source: 'project' })).boardId, draft.boardId);
  const hardware = await exec('BoardPack', { source: 'project', document: 'hardware/HARDWARE_CONTRACT.md' });
  assert.match(hardware.content, /GPIO12/);
  const pinout = await exec('BoardPack', { source: 'project', document: 'hardware/pinout.json' });
  const lcdLink = pinout.documentationLinks.find(link => link.pointer === '/lcd');
  assert.equal(lcdLink.documents[0], 'hardware/ST7789.md');
  const lcdDocumentation = await exec('BoardPack', { source: 'project', document: lcdLink.documents[0] });
  assert.match(lcdDocumentation.content, /SPI3_HOST/); assert.match(lcdDocumentation.content, /4092/);
  const page = await exec('BoardPack', { source: 'project', document: 'BOARD_MANIFEST.json', offset: 2, limit: 3 });
  assert.equal(page.offset, 2); assert.equal(page.truncated, true); assert.equal(page.content.split('\n').length, 3);
  assert.match(page.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal((await registry.execute('BoardPack', { source: 'project', document: 'BOARD_MANIFEST.json', offset: 0 })).isError, true);
  assert.equal((await registry.execute('BoardPack', { source: 'project', document: 'BOARD_MANIFEST.json', limit: 401 })).isError, true);
  assert.equal((await registry.execute('BoardPack', { source: 'project', id: 'board-' + '0'.repeat(32) })).isError, true);
  for (const document of ['../escape.md', 'hardware/schematic/otto-robot-schematic.pdf', 'binding.json']) {
    assert.equal((await registry.execute('BoardPack', { source: 'project', document })).isError, true);
  }
  for (const name of ['Read', 'Write', 'Edit']) {
    const args = name === 'Write' ? { path: '.catnip/board-info/references/BOARD_MANIFEST.json', content: 'changed' }
      : name === 'Edit' ? { path: '.catnip/board-info/references/BOARD_MANIFEST.json', oldText: 'esp32s3', newText: 'wrong' }
      : { path: '.catnip/board-info/references/BOARD_MANIFEST.json' };
    assert.equal((await registry.execute(name, args)).isError, true, 'ordinary tool reached board reference');
  }
  assert.throws(() => projects.assertMutableProjectPath(path.join(boundRoot, 'binding.json')), /Main/);
  for (const profile of ['explore_analysis', 'explore_plan']) {
    const restricted = createToolRegistry({ ...context, profile });
    assert.equal((await restricted.execute('BoardPack', { source: 'project' })).isError, true);
  }
  const task = buildContext('制作离线沙漏，并编译固件');
  assert.match(task.prompt, /BoardPack\(\{source:"project"/);
  assert(task.prompt.includes(draft.id));
  for (const detail of ['ST7789', 'MOSI', 'SPI3_HOST', '40000000', 'cs": 12']) assert(!task.prompt.includes(detail), 'task auto-injected hardware facts: ' + detail);
  projects.resetActiveProjectForTest();
  const cold = projects.getProjectSessionStatus();
  assert.equal(cold.activeProject, null);
  assert.equal(cold.projects.find(p => p.id === created.id).boardInfo.archiveSha256, original);
  projects.activateProject(plain.id);
  const other = createToolRegistry({ ...context, projectId: plain.id, projectDir: plain.projectDir });
  assert.equal(boards.buildProtectedBoardContext(plain.projectDir), null);
  assert.equal((await other.execute('BoardPack', { source: 'project' })).isError, true);
  assert.equal(JSON.parse((await other.execute('BoardPack', {})).content).projectPack, null);
  projects.activateProject(created.id);
  assert.equal(projects.requireActiveProject().boardInfo.id, draft.id);
  assert.throws(() => projects.createProject('bad-selection', 'board-' + '0'.repeat(32)), /SELECTION_EXPIRED/);
  assert(!fs.existsSync(path.join(root, 'projects', 'bad-selection')));
  assert.equal(projects.requireActiveProject().id, created.id);
  const reference = path.join(boundRoot, 'references', 'hardware', 'HARDWARE_CONTRACT.md');
  const prior = fs.readFileSync(reference);
  fs.writeFileSync(reference, Buffer.concat([prior, Buffer.from('tampered')]));
  assert.throws(() => boards.getProjectBoardInfo(created.projectDir), /FILE_INVALID|CHECKSUM_MISMATCH/);
  assert.throws(() => boards.buildProtectedBoardContext(created.projectDir), /FILE_INVALID|CHECKSUM_MISMATCH/);
  assert.equal((await registry.execute('BoardPack', { source: 'project' })).isError, true);
  projects.resetActiveProjectForTest();
  assert(projects.getProjectSessionStatus().projects.find(p => p.id === created.id).boardInfoError);
  assert.throws(() => projects.activateProject(created.id), /板卡信息包/);
  fs.writeFileSync(reference, prior);
  projects.activateProject(plain.id);
  boards.clearBoardInfoDrafts();
  assert.throws(() => projects.createProject('expired-selection', draft.id), /SELECTION_EXPIRED/);
  assert(!fs.existsSync(path.join(root, 'projects', 'expired-selection')));
  assert.equal(sha(fs.readFileSync(kit)), original);
  console.log('project board information passed: real ZIP, bytes, binding, rollback, restart, isolation, read-only Tool, profiles, declared text and tamper refusal; no provider or device calls.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  try { require('../dist/main/board-info.js').clearBoardInfoDrafts(); } finally {
    fs.rmSync(root, { recursive: true, force: true }); app.exit(process.exitCode || 0);
  }
});
