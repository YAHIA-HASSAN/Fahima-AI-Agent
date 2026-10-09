require('dotenv').config();
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

const enabled=process.env.FAHIMA_LIVE_AGENT_TEST==='1';
test('live chat task uses Gemini, grounded web search, and reports plan delivery status honestly',{
  skip:!enabled?'Set FAHIMA_LIVE_AGENT_TEST=1 to make real Gemini and Google Search requests.':false,
  timeout:360000,
},async t=>{
  assert.ok(process.env.GEMINI_API_KEY,'GEMINI_API_KEY is required for the live integration test.');
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'fahima-live-agent-'));
  const previousDbPath=process.env.DB_PATH;
  process.env.DB_PATH=path.join(folder,'live.sqlite');
  for(const name of ['../server/db','../server/business','../server/index'])delete require.cache[require.resolve(name)];
  const {loadConfig}=require('../server/config');
  const {createGeminiClient}=require('../server/gemini-client');
  const agent=require('../server/agent');
  const config=loadConfig();
  const provider=createGeminiClient(config);
  const calls=[];
  agent.__setGeminiClientForTests({interactions:{create:async request=>{
    const prompt=String(request.input||'');
    const call={hasTaskContext:prompt.includes('"task":{'),hasMarketSearchOutcome:prompt.includes('"kind":"market_search"')&&prompt.includes('"output"')};
    calls.push(call);
    const response=await provider.interactions.create(request);
    const usage=response?.usage_metadata||response?.usage||{};
    call.providerReportedTokens=Boolean(usage.input_tokens??usage.prompt_tokens??usage.promptTokenCount??usage.output_tokens??usage.completion_tokens??usage.candidatesTokenCount);
    return response;
  }}});
  const app=require('../server/index');
  const db=require('../server/db');
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const timings={startedAt:new Date().toISOString()};
  try {
    const projectResponse=await fetch(`${base}/api/projects`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Live integration sandbox'})});
    assert.equal(projectResponse.status,201);
    const created=await projectResponse.json();
    const project={...created.project,conversationId:created.conversationId};
    const message='معايا ١٠ آلاف جنيه وعايز خطة أعمال عملية لمشروع دواجن صغير. ابحث عن سعر حديث للعلف في مصر، واحسب تصورًا أوليًا واضح الافتراضات. لا تسجل أي عملية ولا تنفذ شراء.';
    timings.requestStartedAt=Date.now();
    const chatResponse=await fetch(`${base}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId:project.id,conversationId:project.conversationId,message,requestId:`live-${Date.now()}`})});
    assert.equal(chatResponse.status,200);
    const accepted=await chatResponse.json();
    timings.acceptedAt=Date.now();
    assert.ok(accepted.agentTaskId,'The production chat route did not create a background plan task.');
    let task;
    const deadline=Date.now()+300000;
    do {
      const response=await fetch(`${base}/api/agent-tasks/${accepted.agentTaskId}?projectId=${project.id}`);
      assert.equal(response.status,200);
      task=await response.json();
      if(!['QUEUED','RUNNING'].includes(task.status))break;
      await new Promise(resolve=>setTimeout(resolve,1000));
    } while(Date.now()<deadline);
    assert.ok(task&&!['QUEUED','RUNNING'].includes(task.status),'The production task did not reach a terminal state within five minutes.');
    timings.taskCompletedAt=Date.now();
    const events=await fetch(`${base}/api/agent-tasks/${accepted.agentTaskId}/events?projectId=${project.id}`);
    const eventText=await events.text();
    const streamed=eventText.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6))).at(-1);
    const planRow=db.prepare('SELECT id,revision,status,body FROM business_plans WHERE project_id=? ORDER BY revision DESC LIMIT 1').get(project.id);
    const delivery=db.prepare('SELECT m.content FROM agent_task_deliveries d JOIN messages m ON m.id=d.message_id WHERE d.task_id=?').get(accepted.agentTaskId);
    const searchSteps=(task.steps||[]).filter(step=>step.kind==='market_search');
    const calculations=(task.steps||[]).filter(step=>step.kind==='calculation');
    const retrievedPlan=task.result?.planRef?.planId
      ?await (await fetch(`${base}/api/plans/${task.result.planRef.planId}?projectId=${project.id}`)).json():null;
    const trace={
      request:'مشروع دواجن صغير بميزانية 10,000 جنيه؛ بحث سعر العلف وحساب تصور مبدئي؛ لا معاملات أو مشتريات.',
      taskId:accepted.agentTaskId,
      timingMs:{chatAcceptance:timings.acceptedAt-timings.requestStartedAt,backgroundToTerminal:timings.taskCompletedAt-timings.acceptedAt},
      gemini:{connected:calls.length>0,calls:calls.length,decisions:task.result?.metrics?.decisions??task.decisionCount,nextDecisionReceivedSearchOutcome:calls.some(call=>call.hasMarketSearchOutcome),tokenSource:calls.every(call=>call.providerReportedTokens)?'provider-reported':'estimated-fallback-used',inputTokens:task.inputTokens,outputTokens:task.outputTokens},
      tools:{searchDispatched:searchSteps.length>0,searchCalls:searchSteps.length,searchOutcomes:searchSteps.map(step=>({status:step.result?.status||step.status,itemCount:step.result?.output?.items?.length??0,error:step.result?.errors?.[0]?.code||step.error||null,mode:step.result?.errors?.[0]?.mode||step.input?.mode||'google_search',elapsedMs:step.result?.errors?.[0]?.elapsedMs||null,providerStatus:step.result?.errors?.[0]?.providerStatus||null})),
        calculationCalls:calculations.length,calculationOutcomes:calculations.map(step=>({status:step.result?.status||step.status,hasMissingInputs:Boolean(step.result?.missingInputs?.length||step.result?.output?.missing?.length)})),
        validCalculation:calculations.some(step=>step.result?.status==='succeeded'&&!step.result?.missingInputs?.length)},
      validation:task.result?.validation||null,
      persistence:{planStored:Boolean(planRow),planRevision:planRow?.revision||null,planStatus:planRow?.status||null,deliveryStored:Boolean(delivery)},
      ui:{sseStatus:streamed?.status||null,assistantMessageStored:Boolean(delivery),planRefDelivered:Boolean(streamed?.result?.planRef),planFetchSucceeded:Boolean(retrievedPlan?.plan),planRevisionMatches:Boolean(retrievedPlan?.plan&&retrievedPlan.plan.revision===task.result?.planRef?.revision)},
      finalStatus:task.status,
    };
    console.log(`LIVE_AGENT_TRACE ${JSON.stringify(trace)}`);
    assert.ok(calls.length,'The live request did not reach Gemini.');
    assert.ok(searchSteps.length,'The live run did not dispatch grounded web search.');
    assert.ok(task.result?.validation,'The live run did not return plan validation.');
    assert.ok(delivery,'The live run did not persist its assistant delivery.');
    assert.equal(streamed?.status,task.status,'The SSE endpoint did not deliver the terminal task status.');
    assert.ok(['COMPLETE','PROVISIONAL','WAITING_FOR_INPUT','FAILED'].includes(task.status),'The task did not reach a recognized terminal state.');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE project_id=?').get(project.id).count,0,'The live run must not create financial transactions.');
    if(planRow)assert.ok(task.result?.planRef,'A persisted plan must be referenced by the terminal task result.');
    if(!planRow)assert.ok(['WAITING_FOR_INPUT','FAILED'].includes(task.status),'A task without a stored plan must not be presented as successful plan delivery.');
    if(task.result?.planRef) {
      assert.ok(retrievedPlan?.plan,'Persisted plan reference is not retrievable through its scoped endpoint.');
      assert.equal(retrievedPlan.plan.project_id,project.id);
      assert.equal(retrievedPlan.plan.revision,task.result.planRef.revision);
    }
    if(searchSteps.some(step=>step.result?.status!=='succeeded')) {
      assert.ok(calls.some(call=>call.hasMarketSearchOutcome),'Gemini did not receive the failed or insufficient search outcome in a follow-up decision.');
      if(calculations.some(step=>step.result?.status==='insufficient_data'))assert.notEqual(task.status,'COMPLETE','Incomplete authoritative calculation cannot be reported complete.');
      t.diagnostic('Live safety path passed: search did not return verified data, and no successful end-to-end planning result is claimed.');
      return;
    }
    assert.ok(searchSteps.some(step=>step.result?.status==='succeeded'),'No live search returned validated results.');
    assert.ok(calls.some(call=>call.hasMarketSearchOutcome),'No follow-up Gemini call received the completed market-search result.');
    if(!trace.tools.validCalculation||!['COMPLETE','PROVISIONAL'].includes(task.result?.validation?.status)) {
      assert.notEqual(task.status,'COMPLETE','A live calculation that is missing or invalid cannot produce a complete plan.');
      t.diagnostic('Gemini and search were reachable, but authoritative calculation or plan validation remained incomplete; no end-to-end planning success is claimed.');
      return;
    }
    assert.ok(planRow,'The live run did not persist a plan revision.');
    assert.ok(retrievedPlan?.plan,'The persisted plan could not be retrieved for UI delivery.');
    assert.ok(task.result?.planRef,'The terminal result did not include the persisted plan reference.');
  } finally {
    await app.locals.agentTasks.close();
    server.closeAllConnections?.();
    await new Promise(resolve=>server.close(resolve));
    db.close();
    agent.__setGeminiClientForTests(null);
    if(previousDbPath===undefined)delete process.env.DB_PATH;else process.env.DB_PATH=previousDbPath;
    fs.rmSync(folder,{recursive:true,force:true});
  }
});
