const test=require('node:test');
const assert=require('node:assert/strict');
const search=require('../server/market-research');
const {loadConfig}=require('../server/config');

function configure({key='test-serper-key',fallback=''}={}) {
  return {...loadConfig(),searchProvider:'serper',searchFallbackProvider:fallback,serperApiKey:key||''};
}
function jsonResponse(data,{status=200,headers={}}={}) {
  return {ok:status>=200&&status<300,status,headers:{get:name=>headers[name.toLowerCase()]||null},json:async()=>data};
}
function request(extra={}) {return {key:'dynamic-input',query:'سعر مادة المشروع في المنيا',purpose:'price',product_name:'مادة المشروع',unit:'وحدة',location:'المنيا',...extra};}
test('Serper sends authenticated Arabic Egypt search and normalizes organic results without inventing prices',async()=>{
  const config=configure();let call;
  const fetch=async(url,options)=>{call={url,options};return jsonResponse({organic:[{title:'مصدر للمادة',link:'https://shop.example/item',snippet:'السعر 500 جنيه'}]});};
  const result=await search.search(request(),{provider:'serper',config,fetch,projectId:9});
  assert.equal(call.url,'https://google.serper.dev/search');
  assert.equal(call.options.method,'POST');assert.equal(call.options.headers['X-API-KEY'],'test-serper-key');
  assert.equal(call.options.headers['Content-Type'],'application/json');
  assert.deepEqual(JSON.parse(call.options.body),{q:'سعر مادة المشروع في المنيا',gl:'eg',hl:'ar',num:10});
  assert.equal(result.provider,'serper');assert.equal(result.items.length,1);
  assert.equal(result.items[0].source_url,'https://shop.example/item');assert.equal(result.items[0].price,null);
  assert.equal(result.items[0].validation_status,'unverified_search_result');
});

test('Serper shopping accepts only explicit EGP prices with product, specification, and unit match',async()=>{
  const config=configure();
  const fetch=async()=>jsonResponse({shopping:[
    {title:'مادة المشروع 25 كجم وحدة',link:'https://store.example/p',price:'EGP 125.50',source:'متجر موثوق',location:'المنيا'},
    {title:'مادة أخرى 25 كجم وحدة',link:'https://store.example/other',price:'EGP 1,000',source:'متجر آخر'},
    {title:'مادة المشروع 50 كجم وحدة',link:'https://store.example/wrong-spec',price:'EGP 999',source:'متجر'},
    {title:'مادة المشروع 25 كجم وحدة',link:'https://store.example/usd',price:'$9.00',source:'Store'},
  ]});
  const result=await search.search(request({specification:'25 كجم',search_type:'shopping'}),{provider:'serper',config,fetch,projectId:4});
  assert.equal(result.mode,'shopping');assert.equal(result.items[0].price,125.5);
  assert.equal(result.items[0].currency,'EGP');assert.equal(result.items[0].confidence,'medium');
  assert.equal(result.items[0].validation_status,'structured_shopping_offer');
  assert.equal(result.items[1].price,null);assert.equal(result.items[2].price,null);assert.equal(result.items[3].price,null);
});

test('Serper empty organic results return an empty successful result',async()=>{
  const config=configure();
  const result=await search.search(request(),{provider:'serper',config,fetch:async()=>jsonResponse({organic:[]}),projectId:3});
  assert.deepEqual(result.items,[]);assert.deepEqual(result.sources,[]);
});

test('Serper malformed response and JSON get safe provider errors',async()=>{
  const config=configure();
  await assert.rejects(search.search(request(),{provider:'serper',config,fetch:async()=>jsonResponse({unexpected:[]})}),error=>error.code==='SERPER_INVALID_RESPONSE');
  await assert.rejects(search.search(request(),{provider:'serper',config,fetch:async()=>({ok:true,status:200,json:async()=>{throw new Error('bad json');}})}),error=>error.code==='SERPER_INVALID_RESPONSE');
});

test('Serper provider reports missing key, authorization, and rate-limit errors without retries',async()=>{
  const missing=configure({key:null});
  await assert.rejects(search.search(request(),{provider:'serper',config:missing}),error=>error.code==='SERPER_NOT_CONFIGURED');
  let calls=0;const config=configure();
  await assert.rejects(search.search(request(),{provider:'serper',config,fetch:async()=>{calls++;return jsonResponse({}, {status:401});}}),error=>error.code==='SERPER_UNAUTHORIZED'&&error.status===401);
  await assert.rejects(search.search(request(),{provider:'serper',config,fetch:async()=>{calls++;return jsonResponse({}, {status:403});}}),error=>error.code==='SERPER_FORBIDDEN'&&error.status===403);
  calls=0;
  await assert.rejects(search.search(request(),{provider:'serper',config,fetch:async()=>{calls++;return jsonResponse({}, {status:429});}}),error=>error.code==='HTTP_429'&&error.status===429);
  assert.equal(calls,1);
});

test('Gemini fallback runs only when explicitly configured',async()=>{
  const config=configure({fallback:'gemini'});
  const fetch=async()=>jsonResponse({}, {status:401});
  search.__setGeminiClientForTests({interactions:{create:async()=>({output_text:JSON.stringify({summary:'بديل Gemini.',items:[]}),steps:[]})}});
  try {
    const result=await search.search(request(),{config,fetch,projectId:6});
    assert.equal(result.provider,'gemini');assert.equal(result.fallbackFrom,'serper');
  } finally {search.__setGeminiClientForTests(null);}
});

test('Serper timeout and transient 503 retry are bounded',async()=>{
  const config=configure();
  await assert.rejects(search.search(request(),{provider:'serper',config,fetch:()=>new Promise(()=>{}),timeoutMs:10}),error=>error.code==='SEARCH_TIMEOUT');
  let calls=0;
  const fetch=async()=>{calls++;return calls===1?jsonResponse({}, {status:503}):jsonResponse({organic:[]});};
  const result=await search.search(request(),{provider:'serper',config,fetch,timeoutMs:3000});
  assert.equal(calls,2);assert.equal(result.items.length,0);
});

test('Serper uses a project-scoped short cache and does not leak results to another scope',async()=>{
  const config=configure();let calls=0;
  const fetch=async()=>{calls++;return jsonResponse({organic:[]});};
  const one=await search.search(request(),{provider:'serper',config,fetch,projectId:101});
  const cached=await search.search(request(),{provider:'serper',config,fetch,projectId:101});
  const other=await search.search(request(),{provider:'serper',config,fetch,projectId:202});
  assert.equal(one.cached,false);assert.equal(cached.cached,true);assert.equal(other.cached,false);assert.equal(calls,2);
});
