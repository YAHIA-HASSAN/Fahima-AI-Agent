require('dotenv').config();
const test=require('node:test');
const assert=require('node:assert/strict');
const marketResearch=require('../server/market-research');

const enabled=process.env.FAHIMA_LIVE_SEARCH_DIAGNOSTIC==='1';
test('live search diagnostic compares grounding, URL context, and combined retrieval',{skip:!enabled?'Set FAHIMA_LIVE_SEARCH_DIAGNOSTIC=1 and optionally FAHIMA_SEARCH_DIAGNOSTIC_URL to run real provider calls.':false,timeout:240000},async t=>{
  assert.ok(process.env.GEMINI_API_KEY,'GEMINI_API_KEY is required.');
  const request={key:'diagnostic_feed',query:'current poultry feed bag price Egypt',purpose:'price',product_name:'poultry feed',unit:'bag',freshness_days:14};
  const rows=[];let url=process.env.FAHIMA_SEARCH_DIAGNOSTIC_URL||'';
  for(const mode of ['google_search','url_context','combined']) {
    if(mode==='url_context'&&!url) {rows.push({mode,status:'skipped_no_source_url'});continue;}
    const started=Date.now();
    try {
      const result=await marketResearch.search({...request,...(url?{source_url:url}:{})},{provider:'gemini',mode,timeoutMs:45000});
      if(mode==='google_search'&&!url)url=result.sources?.[0]?.url||result.items?.[0]?.source_url||'';
      rows.push({mode,status:'completed',elapsedMs:Date.now()-started,citations:result.sources.length,items:result.items.length,pricedItems:result.items.filter(item=>item.price!=null).length});
    } catch(error) {
      rows.push({mode,status:error.code==='SEARCH_TIMEOUT'?'application_timeout':'provider_or_network_error',elapsedMs:Date.now()-started,code:String(error.code||error.status||'unknown').slice(0,60),providerStatus:Number(error.status||error.statusCode||0)||null});
    }
  }
  console.log(`LIVE_SEARCH_DIAGNOSTIC ${JSON.stringify(rows)}`);
  if(!url)t.diagnostic('URL-context provider behavior remains unverified because the live search did not return a citation and no diagnostic URL was configured.');
  assert.equal(rows.length,3);
});
