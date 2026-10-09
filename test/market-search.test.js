const test=require('node:test');
const assert=require('node:assert/strict');
const marketResearch=require('../server/market-research');
const {loadConfig}=require('../server/config');

test('search modes separate Google grounding, URL context, and combined tools',async()=>{
  const requested=[];
  marketResearch.__setGeminiClientForTests({interactions:{create:async request=>{
    requested.push({tools:request.tools.map(tool=>tool.type),model:request.model});
    return {output_text:JSON.stringify({summary:'اختبار بحث.',items:[]}),steps:[]};
  }}});
  try {
    const base={key:'feed',query:'سعر علف دواجن حديث مصر',purpose:'price',product_name:'علف دواجن',unit:'كيس'};
    await marketResearch.search(base,{mode:'google_search'});
    await marketResearch.search({...base,source_url:'https://example.test/feed'},{mode:'url_context'});
    await marketResearch.search({...base,source_url:'https://example.test/feed'},{mode:'combined'});
    assert.deepEqual(requested.map(row=>row.tools),[['google_search'],['url_context'],['google_search','url_context']]);
    assert.ok(requested.every(row=>row.model===loadConfig().geminiSearchModel));
    await assert.rejects(marketResearch.search(base,{mode:'url_context'}),/رابط مصدر صالح/);
  } finally {marketResearch.__setGeminiClientForTests(null);}
});

test('search uses its own Gemini model while the reasoning model remains unchanged',async()=>{
  const previous={GEMINI_MODEL:process.env.GEMINI_MODEL,GEMINI_SEARCH_MODEL:process.env.GEMINI_SEARCH_MODEL};
  const models=[];
  process.env.GEMINI_MODEL='brain-model-test';
  process.env.GEMINI_SEARCH_MODEL='search-model-test';
  marketResearch.__setGeminiClientForTests({interactions:{create:async request=>{
    models.push(request.model);
    return {output_text:JSON.stringify({summary:'مصدر تجريبي.',items:[]}),steps:[]};
  }}});
  try {
    const config=loadConfig();
    const result=await marketResearch.search({key:'model-split',query:'بحث تجريبي'},{mode:'google_search'});
    assert.equal(config.geminiModel,'brain-model-test');
    assert.equal(config.geminiSearchModel,'search-model-test');
    assert.deepEqual(models,['search-model-test']);
    assert.equal(result.model,'search-model-test');
  } finally {
    if(previous.GEMINI_MODEL===undefined)delete process.env.GEMINI_MODEL;else process.env.GEMINI_MODEL=previous.GEMINI_MODEL;
    if(previous.GEMINI_SEARCH_MODEL===undefined)delete process.env.GEMINI_SEARCH_MODEL;else process.env.GEMINI_SEARCH_MODEL=previous.GEMINI_SEARCH_MODEL;
    marketResearch.__setGeminiClientForTests(null);
  }
});
