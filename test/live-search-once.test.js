require('dotenv').config();
const marketResearch=require('../server/market-research');
const {loadConfig}=require('../server/config');

function safeProviderDetails(error,key) {
  const headers=error?.headers||error?.response?.headers;
  const selected={};
  if(headers) {
    const entries=typeof headers.entries==='function'?headers.entries():Object.entries(headers);
    for(const [name,value] of entries)if(/^(retry-after|x-ratelimit-[\w-]+|ratelimit-[\w-]+|x-goog-[\w-]*quota[\w-]*)$/i.test(name))selected[name]=String(value).slice(0,160);
  }
  const message=String(error?.message||'').replaceAll(key,'[REDACTED]').slice(0,500);
  return {name:error?.name||'Error',status:error?.status||error?.statusCode||error?.response?.status||null,code:error?.code||null,message,quotaHeaders:selected};
}

async function main() {
  const config=loadConfig();
  if(process.env.FAHIMA_LIVE_SEARCH_ONCE!=='1')throw new Error('Set FAHIMA_LIVE_SEARCH_ONCE=1 to authorize the single live request.');
  if(!config.geminiApiKey)throw new Error('GEMINI_API_KEY is not configured.');
  const started=Date.now();
  try {
    const result=await marketResearch.search({key:'live-search-once',query:'current poultry feed price Egypt',purpose:'price',product_name:'poultry feed',unit:'bag',freshness_days:14},{provider:'gemini',mode:'google_search',timeoutMs:config.geminiSearchTimeoutMs});
    console.log(JSON.stringify({outcome:'success',model:result.model,mode:result.mode,elapsedMs:Date.now()-started,sourceCount:result.sources.length,sources:result.sources.map(source=>({title:source.title,host:new URL(source.url).host})),items:result.items.length,pricedItems:result.items.filter(item=>item.price!==null).length,usage:result.usage||null},null,2));
  } catch(error) {
    console.log(JSON.stringify({outcome:'failed',model:config.geminiSearchModel,mode:error.searchMode||'google_search',elapsedMs:error.elapsedMs||Date.now()-started,provider:safeProviderDetails(error,config.geminiApiKey)},null,2));
    process.exitCode=1;
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
