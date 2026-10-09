const { SYSTEM_PROMPT } = require('../llm/prompts/system-prompt');
const { buildPromptContext } = require('./context-builder');

async function runLoop({ model, registry, context, budgets, persistObservation = async () => {}, persistDecision = async () => {}, onProgress = () => {}, isCancelled = () => false }) {
  const initialContext = { role: 'user', parts: [{ text: `سياق المهمة ومعلومات المشروع بصيغة JSON:\n${buildPromptContext(context)}` }] };
  let recentRound = context.observations.length ? [{role:'user',parts:context.observations.slice(-1).map(item=>({functionResponse:{name:item.tool,response:item.observation}}))}] : [];
  let decisions = Number(context.task.decisionCount) || 0, toolCount = context.observations.length, inputTokens = 0, outputTokens = 0;
  const startedAt = Date.now();
  while (decisions < budgets.maxDecisions && toolCount <= budgets.maxTools && Date.now() - startedAt < budgets.timeoutMs) {
    if (isCancelled()) return { status:'CANCELLED', result:{answer:'تم إلغاء المهمة. أي خطوة مكتملة قبل الإلغاء فضلت محفوظة.'}, metrics:{decisions,toolCount,inputTokens,outputTokens,elapsedMs:Date.now()-startedAt} };
    const contents=[initialContext];
    const latestCount=recentObservationCount(recentRound);
    const completed=latestCount?context.observations.slice(0,-latestCount):context.observations;
    if(completed.length)contents.push({role:'user',parts:[{text:`نتائج الأدوات السابقة باختصار (استخدميها عند القرار التالي):\n${JSON.stringify(completed.map(compactObservation))}`}]});
    contents.push(...recentRound);
    const decision = await model.decide({ system: SYSTEM_PROMPT, contents, tools: registry.definitions() });
    decisions++;
    inputTokens += Number(decision.usage?.promptTokenCount) || 0;
    outputTokens += Number(decision.usage?.candidatesTokenCount) || 0;
    const calls = (decision.candidate?.parts || []).filter(part => part.functionCall?.name).map(part => part.functionCall);
    await persistDecision({ sequence: decisions, actionType: calls.length ? 'tool_call' : decision.text ? 'answer' : 'invalid', toolNames: calls.map(call => call.name), inputTokens: Number(decision.usage?.promptTokenCount) || 0, outputTokens: Number(decision.usage?.candidatesTokenCount) || 0 });
    context.task.decisionCount = decisions;
    if (!decision.candidate) {
      if (decision.text) return terminal(context, { status: 'COMPLETE', answer: decision.text, plan: null }, { decisions, toolCount, inputTokens, outputTokens, elapsedMs: Date.now() - startedAt });
      throw Object.assign(new Error('Gemini returned no decision.'), { code: 'EMPTY_GEMINI_RESPONSE' });
    }
    const parts = decision.candidate.parts || [];
    if (!calls.length) {
      const answer = parts.map(part => part.text).filter(Boolean).join('\n').trim() || decision.text;
      if (answer) {
        recentRound=[decision.candidate,{ role: 'user', parts: [{ text: 'حوّلي الإجابة النهائية إلى استدعاء أداة. لو طلب المستخدم خطة مشروع استخدمي deliver_business_plan وأرسلي الخطة كاملة، وإلا استخدمي deliver_response. لا تنهي المهمة بنص عادي.' }] }];
        continue;
      }
      throw Object.assign(new Error('Gemini did not return a tool call or answer.'), { code: 'INVALID_GEMINI_DECISION' });
    }
    const observations = [];
    for (const call of calls) {
      if (isCancelled()) return { status:'CANCELLED', result:{answer:'تم إلغاء المهمة. أي خطوة مكتملة قبل الإلغاء فضلت محفوظة.'}, metrics:{decisions,toolCount,inputTokens,outputTokens,elapsedMs:Date.now()-startedAt} };
      toolCount++;
      if (toolCount > budgets.maxTools) break;
      context.toolSequence = toolCount;
      const observation = await registry.execute({ name: call.name, input: call.args || {}, context });
      context.observations.push({ tool: call.name, observation });
      await persistObservation(call.name, observation, toolCount);
      onProgress({ type: 'tool', name: call.name, status: observation.status });
      observations.push({ functionResponse: { name: call.name, response: observation } });
      if (observation.output?.terminalResult) return terminal(context, observation.output.terminalResult, { decisions, toolCount, inputTokens, outputTokens, elapsedMs: Date.now() - startedAt });
    }
    recentRound=[decision.candidate,{ role: 'user', parts: observations }];
  }
  return { status: 'FAILED', result: { answer: 'مقدرتش أكمل المهمة ضمن حدود التشغيل. جربي طلبًا أضيق أو أعيدي المحاولة.' }, metrics: { decisions, toolCount, inputTokens, outputTokens, elapsedMs: Date.now() - startedAt } };
}
function terminal(context, result, metrics) { return { status: result.status, result: result, metrics }; }
function recentObservationCount(round){return round.filter(item=>item.role==='user').reduce((sum,item)=>sum+(item.parts||[]).filter(part=>part.functionResponse).length,0);}
function compactObservation(item){
  const output=item.observation?.output||{};
  if(item.tool==='search_market')return {tool:item.tool,status:item.observation?.status,count:output.resultCount,results:(output.results||[]).slice(0,5).map(row=>({title:row.title,url:row.url,price:row.price,snippet:String(row.snippet||'').slice(0,160)}))};
  const serialized=JSON.stringify(item.observation);
  return {tool:item.tool,status:item.observation?.status,result:serialized.length>1200?`${serialized.slice(0,1200)}…`:item.observation};
}
module.exports = { runLoop };
