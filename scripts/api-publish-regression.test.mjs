import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Exercise the real publisher, including its browser scripts. Only the
// Obsidian host and external browser/network boundary are replaced.
function harness({ editorReadyAt = 0, contentError = null, coverError = null, titleResponse = null, coverResponse = null, uploadDelays = [] } = {}) {
  let now = 0;
  let uploads = 0;
  let contentSaves = 0;
  const notices = [];
  const logs = [];
  const media = new Map();
  const pendingMedia = [];
  const content = {
    getBlockMap: () => ({ forEach: fn => {
      for (const task of pendingMedia) {
        if (!task.done && task.due <= now) { media.set(task.key, task.value); task.done = true; }
      }
      for (const key of media.keys()) fn({
        getType: () => 'atomic',
        findEntityRanges: (_predicate, accept) => accept(0),
        getCharacterList: () => ({ get: () => ({ getEntity: () => key }) }),
      });
    }}),
    getEntity: key => ({ getType: () => 'MEDIA', getData: () => media.get(key) }),
  };
  const editor = {
    focus() {},
    __reactFiber$test: { stateNode: { props: { editorState: { getCurrentContent: () => content } } },
      memoizedProps: { onFilesAdded() {
        const key = String(++uploads);
        pendingMedia.push({ key, due: now + (uploadDelays[uploads - 1] ?? 0),
          value: { mediaItems: [{ mediaId: `media-${key}`, localMediaId: key, mediaCategory: 'DraftTweetImage' }] } });
      }}, return: null },
  };
  const browser = vm.createContext({
    window: {},
    document: { cookie: 'ct0=test', querySelector: () => now < editorReadyAt ? null : { ...editor, closest: () => editor } },
    location: { href: 'https://x.com/compose/articles/edit/123', reload() {} },
    Date: class extends Date { static now() { return now; } },
    setTimeout: fn => { now += 200; fn(); },
    Uint8Array, Blob, File, atob,
    fetch: async url => {
      if (titleResponse && url.includes('ArticleEntityUpdateTitle')) return {
        status: titleResponse.status ?? 200,
        text: async () => titleResponse.text ?? JSON.stringify(titleResponse.body),
      };
      if (coverResponse && url.includes('ArticleEntityUpdateCoverMedia')) return {
        status: coverResponse.status ?? 200,
        text: async () => coverResponse.text ?? JSON.stringify(coverResponse.body),
      };
      let error = null;
      let field = 'articleentity_update_title';
      if (url.includes('ArticleEntityUpdateContent')) { contentSaves++; error = contentError; field = 'articleentity_update_content_state'; }
      if (url.includes('ArticleEntityUpdateCoverMedia')) { error = coverError; field = 'articleentity_update_cover_media'; }
      return { status: 200, text: async () => JSON.stringify(error ? { errors: [{ message: error }] } : { data: { [field]: { id: '123' } } }) };
    },
  });
  const evaluate = async source => {
    if (source.includes('findCreateButton')) return true;
    if (source.includes('getElementById')) return 'banner-set';
    return vm.runInContext(`(${source})()`, browser);
  };
  const bridge = { evalJS: async expr => {
    const value = await vm.runInContext(expr, browser);
    return typeof value === 'string' && (value.startsWith('{') || value.startsWith('[')) ? JSON.parse(value) : value;
  }, sleep: async ms => { now += ms; }, press: async () => {} };
  const client = { assertToolsAvailable: async () => {}, close: async () => {}, callTool: async (name, args) => {
    if (name === 'browser_evaluate') return evaluate(args.function);
    return null;
  }};
  const image = { type: 'image', marker: 'MPH_MARKER_0', alt: 'test', fileName: 'test.png', mimeType: 'image/png', base64: 'AA==' };
  const payload = { title: 'test', markdown: 'before\n\nMPH_MARKER_0\n\nafter', items: [image], cover: image };
  const stubs = {
    obsidian: { MarkdownView: class {}, TFile: class {}, Notice: class { constructor(message) { notices.push(message); } } },
    '../logger': { appendPublishLog: async (_plugin, event, details) => logs.push({ event, details }) },
    './copyPublishScript': { buildPublishPayloadForNote: async () => payload, buildPublishFunctionForNote() {} },
    './publishViaMcp': { StdioMcpClient: { connect: async () => client }, detectPlaywrightRuntime: async () => ({ source: 'test' }),
      REQUIRED_PLAYWRIGHT_TOOLS: [], normalizeMcpErrorMessage: e => e.message, normalizeEvaluateSource: s => s,
      parsePlaywrightToolResult: value => value, MCP_EVALUATE_TIMEOUT_MS: 90000, MCP_REQUEST_TIMEOUT_MS: 90000 },
  };
  const source = readFileSync(new URL('../src/commands/publishViaApiMcp.ts', import.meta.url), 'utf8')
    + '\nexport { uploadOneImage, buildContentState, saveContent, runApiPublish, processedMarkdownToSegments };';
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = { exports: {}, require: id => { if (!(id in stubs)) throw Error(`unexpected import ${id}`); return stubs[id]; },
    setTimeout: fn => { now += 2000; fn(); }, Date: class extends Date { static now() { return now; } } };
  vm.runInNewContext(compiled, context);
  const plugin = { t: key => key };
  return { api: context.exports, bridge, image, logs, notices,
    publish: () => context.exports.publishViaApiMcp(plugin, { file: { path: 'test.md' }, content: 'test' }),
    get uploads() { return uploads; }, get contentSaves() { return contentSaves; } };
}

test('waits for the editor to mount before invoking image upload', async () => {
  const h = harness({ editorReadyAt: 600 });
  const info = await h.api.uploadOneImage(h.bridge, h.image);
  assert.equal(info.mediaId, 'media-1');
  assert.equal(h.uploads, 1);
});

test('missing body media cannot silently produce a text-only content state', () => {
  const h = harness();
  assert.throws(() => h.api.buildContentState([h.image], new Map()), /image|图片/i);
});

test('permanently unavailable editor aborts before the final content save', async () => {
  const h = harness({ editorReadyAt: Infinity });
  await h.publish();
  assert.equal(h.contentSaves, 0);
  assert.ok(h.logs.some(l => l.event === 'publish.api.error'));
  assert.ok(!h.notices.includes('notice.publishSuccess'));
});

test('an upload that timed out after dispatch is not dispatched again', async () => {
  // A late completion from attempt one can otherwise be mistaken for the
  // retry, leaving the retry's late MEDIA available to the next image.
  const h = harness({ uploadDelays: [65000, 10000, 20000] });
  await h.publish();
  assert.equal(h.uploads, 1);
  assert.equal(h.contentSaves, 0);
  assert.ok(h.logs.some(l => l.event === 'publish.api.error'));
  assert.ok(!h.notices.includes('notice.publishSuccess'));
});

test('editor preparation can be retried before any upload has been dispatched', async () => {
  const h = harness({ editorReadyAt: 31000 });
  await h.publish();
  assert.equal(h.uploads, 2);
  assert.equal(h.contentSaves, 1);
  assert.ok(h.notices.includes('notice.publishSuccess'));
});

test('HTTP 200 containing a GraphQL error is reported as failure', async () => {
  const h = harness({ contentError: 'Internal: Unspecified' });
  await h.publish();
  assert.ok(h.logs.some(l => l.event === 'publish.api.error'));
  assert.ok(!h.notices.includes('notice.publishSuccess'));
});

test('cover rejection prevents the publisher from reporting complete success', async () => {
  const h = harness({ coverError: 'cover rejected' });
  await h.publish();
  assert.ok(h.logs.some(l => l.event === 'publish.api.error'));
  assert.ok(!h.notices.includes('notice.publishSuccess'));
});

for (const [name, response] of [
  ['GraphQL error', { body: { errors: [{ message: 'title rejected' }] } }],
  ['HTTP error', { status: 503, body: { data: { articleentity_update_title: { id: '123' } } } }],
  ['missing mutation data', { body: { data: {} } }],
]) {
  test(`title ${name} aborts the upload instead of reporting success`, async () => {
    const h = harness({ titleResponse: response });
    await h.publish();
    assert.equal(h.contentSaves, 0);
    assert.ok(h.logs.some(l => l.event === 'publish.api.title_fail'));
    assert.ok(h.logs.some(l => l.event === 'publish.api.error'));
    assert.ok(!h.notices.includes('notice.publishSuccess'));
  });
}

for (const [name, response] of [
  ['non-JSON response', { text: '<html>Login required</html>' }],
  ['missing mutation data', { body: { data: {} } }],
]) {
  test(`cover ${name} aborts the upload instead of reporting success`, async () => {
    const h = harness({ coverResponse: response });
    await h.publish();
    assert.equal(h.contentSaves, 0);
    assert.ok(h.logs.some(l => l.event === 'publish.api.cover_fail'));
    assert.ok(h.logs.some(l => l.event === 'publish.api.error'));
    assert.ok(!h.notices.includes('notice.publishSuccess'));
  });
}

test('successful text, body image and cover still save once and report success', async () => {
  const h = harness();
  await h.publish();
  assert.equal(h.uploads, 2);
  assert.equal(h.contentSaves, 1);
  assert.ok(h.notices.includes('notice.publishSuccess'));
  assert.ok(!h.logs.some(l => l.event === 'publish.api.error'));
});

test('Markdown H2 and H3 preserve their hierarchy using the two X heading types', () => {
  const h = harness();
  const segments = h.api.processedMarkdownToSegments('## 大标题\n\n内容甲\n\n### 小标题\n\n内容乙', []);
  const state = h.api.buildContentState(segments, new Map());
  assert.deepEqual(Array.from(state.blocks, block => block.type), ['header-one', 'unstyled', 'header-two', 'unstyled']);
  assert.deepEqual(Array.from(state.blocks, block => block.text), ['大标题', '内容甲', '小标题', '内容乙']);
});

test('deeper Markdown headings never send unsupported heading block types to X', () => {
  const h = harness();
  const segments = h.api.processedMarkdownToSegments('# H1\n\n#### H4\n\n##### H5\n\n###### H6', []);
  const state = h.api.buildContentState(segments, new Map());
  assert.ok(state.blocks.every(b => ['header-one', 'header-two'].includes(b.type)));
});
