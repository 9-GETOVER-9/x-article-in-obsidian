import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import process from 'node:process';
import { setImmediate } from 'node:timers';
import ts from 'typescript';

// Run real payload preparation with only Obsidian's file/render/network host replaced.
function harness({ frontmatter = {}, files = {}, remoteStatus = 404, unreadable = [] } = {}) {
  class TFile {
    constructor(path) { this.path = path; this.name = path.split('/').pop(); this.extension = this.name.split('.').pop(); }
  }
  const note = new TFile('article.md');
  const fileMap = new Map(Object.entries(files).map(([path, bytes]) => [path, { file: new TFile(path), bytes }]));
  const plugin = {
    settings: { autoApplyCover: true },
    app: {
      metadataCache: { getFileCache: () => ({ frontmatter }), getFirstLinkpathDest: path => fileMap.get(path)?.file ?? null },
      vault: { getAbstractFileByPath: () => null, readBinary: async file => {
        if (unreadable.includes(file.path)) throw new Error(`Cannot read ${file.path}`);
        return Uint8Array.from(fileMap.get(file.path).bytes).buffer;
      } },
    },
  };
  const stubs = {
    obsidian: { TFile, Component: class { unload() {} }, MarkdownRenderer: { render: async (_app, markdown, container) => { container.innerHTML = markdown; } },
      requestUrl: async () => ({ status: remoteStatus, headers: { 'content-type': 'image/png' }, arrayBuffer: Uint8Array.from([1, 2]).buffer }) },
    '../markdown': { buildPreviewMarkdown: (_file, markdown) => markdown },
    '../vendor/x-article-publish/template': {},
  };
  const source = readFileSync(new URL('../src/commands/copyPublishScript.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = { exports: {}, btoa, document: { createElement: () => ({ innerHTML: '', querySelectorAll: () => [] }) },
    require: id => { if (!(id in stubs)) throw Error(`unexpected import ${id}`); return stubs[id]; } };
  vm.runInNewContext(compiled, context);
  return markdown => context.exports.buildPublishPayloadForNote(plugin, note, markdown);
}

test('missing local body image aborts payload preparation with its reference', async () => {
  await assert.rejects(harness()('Before\n\n![photo](missing.png)\n\nAfter'), /missing\.png/);
});

test('missing wiki image aborts instead of leaving an orphan marker', async () => {
  await assert.rejects(harness()('Before\n\n![[missing.png]]'), /missing\.png/);
});

test('remote download failure aborts payload preparation', async () => {
  await assert.rejects(harness()('Before\n\n![photo](https://example.invalid/missing.png)'), /missing\.png/);
});

test('explicit missing cover aborts even when the body has no image', async () => {
  await assert.rejects(harness({ frontmatter: { formatter: { cover: '![[missing-cover.png]]' } } })('Complete text'), /missing-cover\.png/);
});

test('text-only payload still works when no cover is configured', async () => {
  const payload = await harness({ frontmatter: { title: 'Title' } })('Complete text');
  assert.equal(payload.markdown, 'Complete text');
  assert.equal(payload.cover, null);
  assert.equal(payload.items.length, 0);
});

test('valid images preserve order and first-image cover fallback', async () => {
  const payload = await harness({ files: { 'one.png': [1], 'two.png': [2] } })('Before\n\n![first](one.png)\n\nMiddle\n\n![second](two.png)\n\nAfter');
  assert.deepEqual(Array.from(payload.items, item => item.fileName), ['one.png', 'two.png']);
  assert.equal(payload.cover.fileName, 'one.png');
  assert.ok(payload.markdown.indexOf(payload.items[0].marker) < payload.markdown.indexOf(payload.items[1].marker));
});

test('multiple concurrent file read failures are all observed', async () => {
  const failures = [];
  const listener = error => failures.push(error);
  process.on('unhandledRejection', listener);
  try {
    await assert.rejects(harness({ files: { 'one.png': [1], 'two.png': [2] }, unreadable: ['one.png', 'two.png'] })('![one](one.png)\n\n![two](two.png)'), /Cannot read/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(failures.length, 0);
  } finally { process.off('unhandledRejection', listener); }
});

for (const [name, markdown] of [
  ['inline code', 'Use `![example](missing.png)` in Markdown.'],
  ['double-backtick inline code', 'Use `` `![example](missing.png)` `` in Markdown.'],
  ['backtick fence', '```markdown\n![example](missing.png)\n```'],
  ['tilde fence', '~~~markdown\n![example](missing.png)\n~~~'],
  ['long fence containing shorter fence', '````markdown\n```example\n![example](missing.png)\n```\n````'],
]) {
  test(`${name} image example is neither a body asset nor an automatic cover`, async () => {
    const payload = await harness()(markdown);
    assert.equal(payload.items.filter(item => item.type === 'image').length, 0);
    assert.equal(payload.cover, null);
    assert.ok(payload.markdown.includes('missing.png') || payload.items.some(item => item.code?.includes('missing.png')));
  });
}

test('automatic cover skips a code example and uses the first real body image', async () => {
  const payload = await harness({ files: { 'real.png': [1] } })('`![example](missing.png)`\n\n![real](real.png)');
  assert.equal(payload.cover.fileName, 'real.png');
  assert.deepEqual(Array.from(payload.items.filter(item => item.type === 'image'), item => item.fileName), ['real.png']);
});
