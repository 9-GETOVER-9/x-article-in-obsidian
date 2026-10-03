import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/logger.ts', import.meta.url), 'utf8') + '\nexport { safeStringify };';
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const context = { exports: {}, Error, require: () => ({}) };
vm.runInNewContext(compiled, context);
const serialize = value => JSON.parse(context.exports.safeStringify(value));

test('log serialization recursively redacts credential keys', () => {
  const value = { status: 200, nested: [{ apiKey: 'api-secret', password: 'password-secret',
    PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'browser-secret', headers: { Authorization: 'Bearer header-secret', Cookie: 'cookie-secret' } }] };
  const output = context.exports.safeStringify(value);
  for (const secret of ['api-secret', 'password-secret', 'browser-secret', 'header-secret', 'cookie-secret']) assert.ok(!output.includes(secret));
  assert.equal(JSON.parse(output).status, 200);
  assert.equal(value.nested[0].apiKey, 'api-secret');
});

test('runtime environment values never enter logs while key names remain diagnostic', () => {
  const result = serialize({ runtime: { command: 'node', source: 'configured', env: { UNRELATED_NAME: 'private-value', TOKEN: 'private-token' } } });
  assert.equal(result.runtime.command, 'node');
  assert.equal(result.runtime.source, 'configured');
  assert.deepEqual(result.runtime.env, ['UNRELATED_NAME', 'TOKEN']);
});

test('error and non-sensitive diagnostic details remain readable', () => {
  const result = serialize({ error: new Error('network unavailable'), counts: { images: 2 }, status: 500 });
  assert.equal(result.error.name, 'Error');
  assert.equal(result.error.message, 'network unavailable');
  assert.equal(result.counts.images, 2);
  assert.equal(result.status, 500);
});
