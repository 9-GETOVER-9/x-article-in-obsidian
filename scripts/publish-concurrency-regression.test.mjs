import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

// Run the real plugin command registration and preview upload method. Obsidian
// UI and the three browser publishers are host boundaries; holding their
// promises open exposes overlapping requests without writing any X drafts.
async function harness() {
  const commands = new Map();
  const notices = [];
  const requests = [];
  const errors = [];
  let copied = 0;
  const publish = mode => (_plugin, context) => new Promise((resolve, reject) => {
    requests.push({ mode, context, resolve, reject });
  });
  const obsidian = {
    Plugin: class {
      app = { workspace: { getLeavesOfType: () => [] } };
      async loadData() { return { showWelcomeGuide: false }; }
      registerView() {}
      addRibbonIcon() {}
      addCommand(command) { commands.set(command.id, command.callback); }
      addSettingTab() {}
    },
    ItemView: class {},
    MarkdownView: class {},
    Notice: class { constructor(message) { notices.push(message); } },
  };
  const stubs = new Map([
    ['settings', { DEFAULT_SETTINGS: { locale: 'en', publishMode: 'api' }, XArticleSettingTab: class {} }],
    ['ui/welcomeModal', { XArticleWelcomeModal: class {} }],
    ['commands/copyPublishScript', { copyPublishScript: () => { copied++; } }],
    ['commands/publishViaMcp', { publishViaDetectedMcp: publish('menu') }],
    ['commands/publishViaApiMcp', { publishViaApiMcp: publish('api') }],
    ['commands/publishViaInjectCoreMcp', { publishViaInjectCoreMcp: publish('inject-core') }],
    ['markdown', {}], ['renderEnhancements', {}], ['templateMapper', {}],
  ]);
  const modules = new Map();
  function loadModule(relative) {
    if (stubs.has(relative)) return stubs.get(relative);
    if (modules.has(relative)) return modules.get(relative);
    const file = path.join(sourceRoot, `${relative}.ts`);
    const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const exports = {};
    modules.set(relative, exports);
    vm.runInNewContext(compiled, {
      exports,
      require: id => id === 'obsidian' ? obsidian : loadModule(path.posix.normalize(path.posix.join(path.posix.dirname(relative), id))),
      console: { error: (...args) => errors.push(args) },
    }, { filename: file });
    return exports;
  }
  const Plugin = loadModule('main').default;
  const Preview = loadModule('views/xArticlePreviewView').XArticlePreviewView;
  const plugin = new Plugin();
  await plugin.onload();
  const context = { file: { path: 'test.md' }, content: 'test body' };
  function createPreview() {
    const preview = new Preview({}, plugin);
    preview.publishButtonEl = { disabled: false, setText() {} };
    preview.formatterButtonEl = { disabled: false, setText() {} };
    preview.getTargetContext = async () => context;
    return preview;
  }
  const previews = [createPreview(), createPreview()];
  return {
    plugin, requests, notices, context, errors,
    trigger: entry => entry.startsWith('preview-') ? previews[Number(entry.slice(-1))].publish() : commands.get(entry)(),
    get copied() { return copied; },
    async completeAll() {
      for (const request of requests) request.resolve();
      await nextTurn();
    },
  };
}

const entries = [
  'publish-x-article-via-api-mcp',
  'publish-x-article-via-mcp',
  'publish-x-article-via-inject-core-mcp',
  'publish-x-article-default-mode',
  'preview-0',
  'preview-1',
];

for (const first of entries) {
  test(`${first} excludes all other upload entry points until it finishes`, async () => {
    const h = await harness();
    h.trigger(first);
    await nextTurn();
    assert.equal(h.requests.length, 1);
    try {
      for (const second of entries) {
        h.trigger(second);
        await nextTurn();
      }
      assert.equal(h.requests.length, 1, 'only one publisher may manipulate the browser');
      assert.equal(h.notices.length, entries.length, 'every blocked entry should explain that an upload is running');
      assert.ok(h.notices.every(message => /already in progress/i.test(message)));
    } finally {
      await h.completeAll();
    }
    h.trigger('publish-x-article-default-mode');
    await nextTurn();
    assert.equal(h.requests.length, 2, 'the lock must release after a successful upload');
    await h.completeAll();
  });
}

test('a publisher error releases the lock and is reported without an unhandled rejection', async () => {
  const h = await harness();
  const pending = h.plugin.publishWithDefaultMode();
  await nextTurn();
  h.requests[0].reject(new Error('publisher unavailable'));
  await assert.doesNotReject(pending);
  assert.ok(h.notices.some(message => /failed/i.test(message)));
  h.trigger('publish-x-article-via-mcp');
  await nextTurn();
  assert.equal(h.requests.length, 2);
  await h.completeAll();
});

test('the shared entry preserves the preview note and configured menu mode', async () => {
  const h = await harness();
  h.plugin.settings.publishMode = 'menu';
  h.trigger('preview-0');
  await nextTurn();
  assert.equal(h.requests[0].mode, 'menu');
  assert.equal(h.requests[0].context, h.context);
  await h.completeAll();
});

test('copying an upload script remains available during a draft upload', async () => {
  const h = await harness();
  h.trigger('publish-x-article-via-api-mcp');
  await nextTurn();
  h.trigger('copy-x-article-publish-script');
  await nextTurn();
  assert.equal(h.copied, 1);
  assert.equal(h.requests.length, 1);
  await h.completeAll();
});
