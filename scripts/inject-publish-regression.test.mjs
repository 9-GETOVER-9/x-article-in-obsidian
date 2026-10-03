import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Exercise the public publisher and its preparation. Replace only Obsidian,
// local files, and the external browser bridge that returns the runner result.
function harness({ markdown = 'Complete text', files = {}, remoteStatus = 404, imgFail = 0, atomicFail = 0 } = {}) {
  class TFile {
    constructor(path) { this.path = path; this.name = path.split('/').pop(); this.basename = this.name.replace(/\.[^.]+$/, ''); this.extension = this.name.split('.').pop(); }
  }
  const note = new TFile('article.md');
  const fileMap = new Map(Object.entries(files).map(([path, bytes]) => [path, { file: new TFile(path), bytes }]));
  const calls = [];
  const notices = [];
  const logs = [];
  const result = { ok: true, summary: { mainSummary: { atomicOk: 0, atomicFail, imgOk: Object.keys(files).length, imgFail, markersCleaned: 0 } } };
  const client = { assertToolsAvailable: async () => {}, close: async () => {}, callTool: async (name, args) => {
    calls.push({ name, args });
    return name === 'browser_evaluate' && args.function.includes('const runnerSource') ? result : true;
  } };
  const plugin = {
    settings: { useFilenameAsTitle: false }, t: key => key,
    app: {
      workspace: { getActiveViewOfType: () => ({ file: note, editor: { getValue: () => markdown } }) },
      metadataCache: { getFirstLinkpathDest: path => fileMap.get(path)?.file ?? null },
      vault: { getAbstractFileByPath: () => null, readBinary: async file => Uint8Array.from(fileMap.get(file.path).bytes).buffer },
    },
  };
  const stubs = {
    obsidian: { TFile, MarkdownView: class {}, Platform: { isDesktopApp: true }, Notice: class { constructor(message) { notices.push(message); } },
      requestUrl: async () => ({ status: remoteStatus, headers: { 'content-type': 'image/png' }, arrayBuffer: Uint8Array.from([1]).buffer }) },
    '../logger': { appendPublishLog: async (_plugin, event, details) => logs.push({ event, details }) },
    '../vendor/x-article-inject-core/runner': { INJECT_CORE_RUNNER_SHA256: 'test', INJECT_CORE_RUNNER_SOURCE: '' },
    './publishViaMcp': { detectPlaywrightRuntime: async () => ({ source: 'test' }), StdioMcpClient: { connect: async () => client },
      normalizeEvaluateSource: value => value, normalizeMcpErrorMessage: error => error.message, parsePlaywrightToolResult: value => value, REQUIRED_PLAYWRIGHT_TOOLS: [] },
    '../markdown': {}, '../vendor/x-article-publish/template': {},
  };
  const copyContext = { exports: {}, require: id => { if (!(id in stubs)) throw Error(`unexpected import ${id}`); return stubs[id]; } };
  const copySource = readFileSync(new URL('../src/commands/copyPublishScript.ts', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(copySource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, copyContext);
  stubs['./copyPublishScript'] = copyContext.exports;
  const source = readFileSync(new URL('../src/commands/publishViaInjectCoreMcp.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = { exports: {}, btoa, require: id => { if (!(id in stubs)) throw Error(`unexpected import ${id}`); return stubs[id]; } };
  vm.runInNewContext(compiled, context);
  return { calls, logs, notices, publish: () => context.exports.publishViaInjectCoreMcp(plugin) };
}

for (const field of ['imgFail', 'atomicFail']) {
  test(`inject-core ${field} prevents a success notice even when runner ok is true`, async () => {
    const h = harness({ [field]: 1 });
    await h.publish();
    assert.ok(h.logs.some(entry => entry.event === 'publish.inject_core.error'));
    assert.ok(!h.notices.some(message => message.startsWith('notice.publishSuccess')));
  });
}

for (const [name, markdown, expected] of [
  ['local body image', 'Before\n\n![photo](missing.png)\n\nAfter', /missing\.png/],
  ['remote body image', '![photo](https://example.invalid/missing.png)', /missing\.png/],
  ['explicit cover', '---\nformatter:\n  cover: "![[missing-cover.png]]"\n---\n\nComplete text', /missing-cover\.png/],
]) {
  test(`missing ${name} aborts before navigating to create a draft`, async () => {
    const h = harness({ markdown });
    await h.publish();
    assert.equal(h.calls.length, 0);
    assert.ok(h.notices.some(message => expected.test(message)));
    assert.ok(h.logs.some(entry => entry.event === 'publish.inject_core.error'));
  });
}

test('valid image payload retains the successful publish flow', async () => {
  const h = harness({ markdown: 'Before\n\n![photo](photo.png)\n\nAfter', files: { 'photo.png': [1, 2] } });
  await h.publish();
  assert.ok(h.notices.some(message => message.startsWith('notice.publishSuccess')));
  assert.ok(h.calls.some(call => call.name === 'browser_evaluate' && call.args.function.includes('AQI=')));
});

test('text-only article still succeeds without any image', async () => {
  const h = harness();
  await h.publish();
  assert.ok(h.logs.some(entry => entry.event === 'publish.inject_core.success'));
});

test('image syntax inside a fenced code sample is not a required image asset', async () => {
  const h = harness({ markdown: 'Example:\n\n```markdown\n![example](missing-sample.png)\n```' });
  await h.publish();
  assert.ok(h.notices.some(message => message.startsWith('notice.publishSuccess')));
  assert.equal(h.logs.find(entry => entry.event === 'publish.inject_core.prepare').details.stagedImages, 0);
});

test('data URI body images remain supported by the browser runner', async () => {
  const h = harness({ markdown: '![pixel](data:image/png;base64,AQ==)' });
  await h.publish();
  assert.ok(h.notices.some(message => message.startsWith('notice.publishSuccess')));
  assert.equal(h.logs.find(entry => entry.event === 'publish.inject_core.prepare').details.stagedImages, 0);
});

for (const [name, markdown] of [
  ['inline code', 'Use `![example](missing.png)` in Markdown.'],
  ['double-backtick inline code', 'Use `` `![example](missing.png)` `` in Markdown.'],
  ['tilde fence', '~~~markdown\n![example](missing.png)\n~~~'],
  ['long fence containing shorter fence', '````markdown\n```example\n![example](missing.png)\n```\n````'],
]) {
  test(`inject-core excludes image examples within ${name}`, async () => {
    const h = harness({ markdown });
    await h.publish();
    assert.ok(h.notices.some(message => message.startsWith('notice.publishSuccess')));
    assert.equal(h.logs.find(entry => entry.event === 'publish.inject_core.prepare').details.stagedImages, 0);
  });
}
