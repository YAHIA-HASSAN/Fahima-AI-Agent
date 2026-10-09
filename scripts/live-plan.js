const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { loadConfig } = require('../src/shared/config');
const { createTestDb } = require('../tests/helpers');
const { createGeminiModel } = require('../src/llm/gemini-client');
const { createSerperClient } = require('../src/domain/research/serper-client');
const { createAgent } = require('../src/agent/agent');
const { waitForTask } = require('../tests/helpers');

async function main() {
  const config = { ...loadConfig(), taskMaxDecisions: 6, taskMaxTools: 6, taskTimeoutMs: 240000, leaseMs: 30000, allowFinancialRecording: false };
  if (!config.geminiApiKey || !config.serperApiKey) {
    console.log(JSON.stringify({ status: 'SKIPPED', reason: !config.geminiApiKey ? 'Gemini credentials are unavailable.' : 'Serper credentials are unavailable.' }));
    return;
  }
  const db = createTestDb();
  const projectId = Number(db.prepare('INSERT INTO projects(name,activity,capital) VALUES(?,?,?)').run('اختبار فهيمة المعزول','تجارة مستلزمات صيانة الهواتف',10000).lastInsertRowid);
  const conversationId = Number(db.prepare('INSERT INTO conversations(project_id,title) VALUES(?,?)').run(projectId,'اختبار تخطيط معزول').lastInsertRowid);
  const agent = createAgent({ db, config, model: createGeminiModel(config), search: createSerperClient({ apiKey: config.serperApiKey }) });
  const message = 'معايا ١٠ آلاف جنيه وعايز أبدأ تجارة مستلزمات صيانة الموبايلات في القاهرة. اعملي خطة مبدئية بخطوات ومخاطر وتكاليف. ابحثي عن الأسعار لو لقيتي معلومات مناسبة، ولو البحث مفيهوش أسعار موثوقة اكتبي الافتراضات والنواقص بوضوح. ما تسجليش أي معاملة.';
  const request = await agent.run({ projectId, conversationId, message, requestId: `live-plan-${Date.now()}` });
  const task = await waitForTask(agent, request.taskId, projectId, config.taskTimeoutMs + 5000);
  const decisions = db.prepare('SELECT sequence,action_type,tool_names_json,input_tokens,output_tokens FROM fahima_v2_decisions WHERE task_id=? ORDER BY sequence').all(task.id).map(row => ({ sequence: row.sequence, action: row.action_type, tools: JSON.parse(row.tool_names_json), inputTokens: row.input_tokens, outputTokens: row.output_tokens }));
  const observations = db.prepare('SELECT sequence,tool_name,outcome_json FROM fahima_v2_observations WHERE task_id=? ORDER BY sequence').all(task.id).map(row => { const value = JSON.parse(row.outcome_json); return { sequence: row.sequence, tool: row.tool_name, status: value.status, code: value.code, validationErrors: value.details?.errors, resultCount: value.output?.resultCount, outputStatus: value.output?.terminalResult?.status }; });
  const plan = agent.plans.latest(projectId);
  const transactionsCreated = db.prepare('SELECT COUNT(*) n FROM transactions').get().n;
  const planSaved = Boolean(plan && ['COMPLETE', 'PROVISIONAL'].includes(task.status) && plan.plan.steps.length > 0);
  console.log(JSON.stringify({ status: planSaved && transactionsCreated === 0 ? 'LIVE_PLAN_PERSISTED' : 'LIVE_INCOMPLETE', projectIsolated: true, transactionsCreated, task: { id: task.id, status: task.status, error: task.error }, decisions, observations, plan: plan ? { quality: plan.qualityStatus, revision: plan.revision, stepCount: plan.plan.steps.length, assumptions: plan.plan.assumptions.length, missingInformation: plan.plan.missingInformation.length, priceEvidenceCount: plan.plan.prices?.length || 0, sourceCount: plan.plan.sources?.length || 0, financialTotal: plan.plan.budget?.total, reserveStatus: plan.plan.budget?.reserveStatus } : null, deliveredMessage: db.prepare("SELECT content FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY id DESC LIMIT 1").get(conversationId)?.content || null }));
  db.close();
  if (!planSaved || transactionsCreated !== 0) process.exitCode = 1;
}
main().catch(error => { console.error(JSON.stringify({ status: 'LIVE_FAILED', code: error.code || error.name, message: String(error.message || '').slice(0, 240) })); process.exitCode = 1; });
