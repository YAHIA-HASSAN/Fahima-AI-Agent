require('dotenv').config();
const search=require('../server/market-research');
const {loadConfig}=require('../server/config');

async function main() {
  const config=loadConfig();
  if(process.env.FAHIMA_LIVE_SERPER!=='1') {console.log('SKIPPED: set FAHIMA_LIVE_SERPER=1 to allow one live Serper request.');return;}
  if(!config.serperApiKey) {console.log('SKIPPED: SERPER_API_KEY is not configured; no request was sent.');return;}
  const started=Date.now();
  try {
    const result=await search.search({key:'live-serper-smoke',query:'سعر علف دواجن في مصر',purpose:'price',product_name:'علف دواجن',unit:'كيس',location:'مصر',freshness_days:14},
      {provider:'serper',search_type:'shopping',projectId:'live-smoke',timeoutMs:config.geminiSearchTimeoutMs});
    console.log(JSON.stringify({status:result.httpStatus,provider:result.provider,searchType:result.mode,cached:result.cached,latencyMs:Date.now()-started,
      sources:result.sources.length,items:result.items.length,usablePrices:result.items.filter(item=>item.price!=null&&item.source_url&&item.unit).length,
      citations:result.sources.map(row=>({title:row.title,host:new URL(row.url).host}))},null,2));
  } catch(error) {
    console.log(JSON.stringify({status:error.status||error.providerStatus||null,provider:'serper',code:error.code||'SEARCH_FAILED',latencyMs:error.elapsedMs||Date.now()-started},null,2));
    process.exitCode=1;
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
