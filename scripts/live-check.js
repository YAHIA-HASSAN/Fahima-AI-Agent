const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { loadConfig } = require('../src/shared/config');
const { createGeminiModel } = require('../src/llm/gemini-client');
const { createSerperClient } = require('../src/domain/research/serper-client');
const { revenue } = require('../src/domain/finance/calculator');

async function main() {
  const config = loadConfig();
  if (!config.geminiApiKey || !config.serperApiKey) {
    console.log(JSON.stringify({ status: 'SKIPPED', reason: !config.geminiApiKey ? 'Gemini credentials are unavailable.' : 'Serper credentials are unavailable.' }));
    return;
  }
  const started = Date.now();
  const model = createGeminiModel(config);
  const declaration = { name: 'calculate_revenue', description: 'Calculate quantity times unit price, without saving a transaction.', parameters: { type: 'object', properties: { quantity: { type: 'number' }, unitPrice: { type: 'number' } }, required: ['quantity', 'unitPrice'] } };
  try {
    const first = await model.decide({ system: 'You are an assistant. Call calculate_revenue for this arithmetic. This is hypothetical and must never be recorded.', contents: [{ role: 'user', parts: [{ text: 'Calculate revenue for 3 units at 2 EGP each using the calculate_revenue tool.' }] }], tools: [declaration] });
    const call = first.candidate?.parts?.find(part => part.functionCall?.name === 'calculate_revenue')?.functionCall;
    if (!call) throw Object.assign(new Error('Gemini did not choose the required arithmetic tool.'), { code: 'LIVE_TOOL_NOT_SELECTED' });
    const result = { revenue: revenue(call.args.quantity, call.args.unitPrice), currency: 'EGP', recorded: false };
    const second = await model.decide({ system: 'Explain the observed result briefly. Do not change the number.', contents: [{ role: 'user', parts: [{ text: 'Calculate 3 units at 2 EGP using the provided tool.' }] }, first.candidate, { role: 'user', parts: [{ functionResponse: { name: 'calculate_revenue', response: { status: 'succeeded', output: result } } }] }], tools: [] });
    console.log(JSON.stringify({ component: 'gemini_agent_loop', status: 'VERIFIED', firstDecisionMs: Date.now() - started, tool: call.name, toolInput: call.args, toolOutput: result, nextDecisionReceivedObservation: true, nextAnswer: String(second.text || second.candidate?.parts?.map(part => part.text || '').join('') || '').slice(0, 300), inputTokens: (Number(first.usage?.promptTokenCount) || 0) + (Number(second.usage?.promptTokenCount) || 0), outputTokens: (Number(first.usage?.candidatesTokenCount) || 0) + (Number(second.usage?.candidatesTokenCount) || 0) }));
  } catch (error) {
    console.log(JSON.stringify({ component: 'gemini_agent_loop', status: 'FAILED', code: error.code || error.status || error.name, message: String(error.message || '').slice(0, 240) }));
    process.exitCode = 1;
  }
  try {
    const search = createSerperClient({ apiKey: config.serperApiKey, timeoutMs: 12000 });
    const result = await search({ query: 'سعر كتكوت أبيض جنيه', location: 'مصر', searchType: 'shopping' });
    const offers = result.results.filter(item => /(?:\bEGP\b|جنيه|ج\.م|ج م)/i.test(item.price));
    console.log(JSON.stringify({ component: 'serper', status: result.resultCount ? 'VERIFIED_RESULTS' : 'NO_RESULTS', http: 200, resultCount: result.resultCount, itemsWithExplicitEgpPrice: offers.length, firstSource: offers[0]?.url || result.results[0]?.url || null, elapsedMs: result.elapsedMs || null }));
  } catch (error) {
    console.log(JSON.stringify({ component: 'serper', status: 'FAILED', code: error.code || error.status || error.name, message: String(error.message || '').slice(0, 240) }));
    process.exitCode = 1;
  }
}
main().catch(error => { console.error(JSON.stringify({ status: 'FAILED', code: error.code || error.name })); process.exitCode = 1; });
