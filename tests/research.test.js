const test = require('node:test');
const assert = require('node:assert/strict');
const { createSerperClient } = require('../src/domain/research/serper-client');

test('Serper search caches per project and rejects malformed results', async () => {
  let calls = 0;
  const client = createSerperClient({ apiKey: 'test-key', cacheTtlMs: 60000, fetchImpl: async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ organic: [{ title: 'نتيجة', snippet: 'معلومات', link: 'https://example.test/page' }] }) };
  } });
  const input = { query: 'سعر معدات', location: 'القاهرة', projectId: 1 };
  const first = await client(input);
  const cached = await client(input);
  const isolated = await client({ ...input, projectId: 2 });
  assert.equal(first.resultCount, 1);
  assert.equal(first.cached, false);
  assert.equal(cached.cached, true);
  assert.equal(isolated.cached, false);
  assert.equal(calls, 2);
  const invalid = createSerperClient({ apiKey: 'test-key', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ organic: 'invalid' }) }) });
  await assert.rejects(invalid(input), error => error.code === 'INVALID_SEARCH_RESPONSE');
});

test('Serper 429 without retry guidance is not repeated', async () => {
  let calls = 0;
  const client = createSerperClient({ apiKey: 'test-key', fetchImpl: async () => { calls++; return { ok: false, status: 429, headers: { get: () => null } }; } });
  await assert.rejects(client({ query: 'مورد', projectId: 7 }), error => error.code === 'RATE_LIMITED');
  assert.equal(calls, 1);
});
