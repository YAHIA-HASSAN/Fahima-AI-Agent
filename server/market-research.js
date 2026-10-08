const { loadConfig } = require('./config');
const { createGeminiClient } = require('./gemini-client');
const { withDeadline } = require('./deadline');

let geminiClient;
function client() {
  if (!geminiClient) {
    const config=loadConfig();
    geminiClient = createGeminiClient(config,{timeoutMs:config.geminiSearchTimeoutMs});
  }
  return geminiClient;
}

function isoDate(value) {
  const match=String(value||'').match(/^\d{4}-\d{2}-\d{2}$/);
  return match?match[0]:null;
}
function finite(value) {
  const number=Number(value);
  return Number.isFinite(number)&&number>=0?number:null;
}
function parseJson(text) {
  const clean=String(text||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  return JSON.parse(clean);
}
function citations(interaction) {
  const rows=[];
  for(const step of interaction?.steps||[]) {
    if(step.type!=='model_output')continue;
    for(const block of step.content||[])for(const item of block.annotations||[]) {
      if(item.type!=='url_citation'||!item.url)continue;
      const url=String(item.url);
      if(!rows.some(row=>row.url===url))rows.push({url,title:String(item.title||'مصدر على الإنترنت').slice(0,200)});
    }
  }
  return rows;
}
function safeUrl(value) {
  try {const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.href:'';} catch {return '';}
}
function normalizeRequest(request, fallbackLocation) {
  const key=String(request.key||'').trim().slice(0,80);
  const query=String(request.query||'').trim().slice(0,300);
  const purpose=['price','supplier','requirement','regulation','market'].includes(request.purpose)?request.purpose:'market';
  const days=Math.max(1,Math.min(90,Math.round(Number(request.freshness_days)||14)));
  if(!key||!query)throw new Error('طلب البحث محتاج مفتاح وكلمات بحث واضحة.');
  return {...request,key,query,purpose,product_name:String(request.product_name||'').trim().slice(0,120),
    specification:String(request.specification||'').trim().slice(0,200),unit:String(request.unit||'').trim().slice(0,60),
    location:String(request.location||fallbackLocation||'مصر').trim().slice(0,120),freshness_days:days};
}

async function search(request, options={}) {
  const config=loadConfig();
  const timeoutMs=Number(options.timeoutMs)||config.geminiSearchTimeoutMs;
  const input=normalizeRequest(request,options.location);
  const prompt=`ابحث في الويب عن معلومة تجارية حديثة لمشروع صغير في مصر. افتح صفحات النتائج المناسبة وتحقق من صفحة المنتج أو المصدر نفسه متى أمكن؛ مقتطف البحث وحده لا يثبت السعر أو التوفر.
المطلوب: ${input.query}
الغرض: ${input.purpose}
المنتج أو البند: ${input.product_name||'غير محدد'}
المواصفات: ${input.specification||'غير محددة'}
الوحدة المطلوبة: ${input.unit||'غير محددة'}
المكان: ${input.location}
أعد JSON فقط بالشكل التالي: {"summary":"ملخص عربي قصير","items":[{"product_name":"","specification":"","description":"","price":null,"currency":"EGP","quantity":null,"unit":"","normalized_price":null,"normalized_unit":"","seller":"","source_url":"","source_kind":"published_offer|market_estimate|regulation|requirement|other","observed_on":null,"location":"","confidence":"high|medium|low","availability":"","delivery_cost":null,"total_cost":null,"excerpt":""}]}.
لا تضع سعرًا إلا إذا ظهر بوضوح مع العملة والكمية أو الوحدة. استخدم source_kind=published_offer فقط بعد فحص صفحة عرض أو منتج فعلية؛ وإلا استخدم market_estimate. لا تخترع رابطًا أو سعرًا أو توفرًا. لا تخلط بين أحجام أو مواصفات مختلفة. اجعل source_url هو رابط المصدر الذي استندت إليه. رتب النتائج حسب مطابقة المواصفات والمكان والتكلفة الكلية والملاءمة، وليس حسب أقل سعر فقط؛ أول نتيجة يجب أن تكون الأنسب للحساب إن وُجدت.`;
  const interaction=await withDeadline(client().interactions.create({model:config.geminiModel,input:prompt,
    tools:[{type:'google_search'},{type:'url_context'}],generation_config:{thinking_level:'low'}},{timeout:timeoutMs}),timeoutMs,'SEARCH_TIMEOUT');
  const sourceRows=citations(interaction);
  let parsed;
  try {parsed=parseJson(interaction?.output_text);} catch {parsed={summary:String(interaction?.output_text||'').slice(0,1000),items:[]};}
  const now=new Date();
  const retrievedAt=now.toISOString();
  const validUntil=new Date(now.getTime()+input.freshness_days*86400000).toISOString();
  const items=[];
  for(const raw of Array.isArray(parsed.items)?parsed.items.slice(0,8):[]) {
    const url=safeUrl(raw.source_url);
    const cited=sourceRows.find(row=>row.url===url);
    // A numeric market value without an API citation is unsafe to use in calculations.
    const price=cited?finite(raw.price):null;
    const quantity=finite(raw.quantity);
    const normalizedPrice=cited?finite(raw.normalized_price):null;
    items.push({research_key:input.key,query:input.query,purpose:input.purpose,
      product_name:String(raw.product_name||input.product_name).slice(0,120),specification:String(raw.specification||input.specification||'').slice(0,200),description:String(raw.description||'').slice(0,500),
      price,currency:price==null?null:String(raw.currency||'EGP').slice(0,10),quantity,unit:String(raw.unit||'').slice(0,60)||null,
      normalized_price:normalizedPrice,normalized_unit:String(raw.normalized_unit||'').slice(0,60)||null,
      seller:String(raw.seller||'').slice(0,160)||null,source_title:cited?.title||'',source_url:cited?.url||'',
      source_kind:['published_offer','market_estimate','regulation','requirement','other'].includes(raw.source_kind)?raw.source_kind:'other',
      observed_on:isoDate(raw.observed_on),retrieved_at:retrievedAt,valid_until:validUntil,
      location:String(raw.location||input.location).slice(0,120)||null,
      confidence:['high','medium','low'].includes(raw.confidence)?raw.confidence:'low',availability:String(raw.availability||'').slice(0,160)||null,
      delivery_cost:finite(raw.delivery_cost),total_cost:finite(raw.total_cost),
      raw_excerpt:String(raw.excerpt||'').slice(0,500)});
  }
  if(!items.length)for(const source of sourceRows.slice(0,8))items.push({research_key:input.key,query:input.query,purpose:input.purpose,
    product_name:input.product_name,specification:input.specification,description:'مصدر مرتبط بالبحث؛ لم يظهر سعر واضح بنفس الوحدة والمواصفات.',
    price:null,currency:null,quantity:null,unit:null,normalized_price:null,normalized_unit:null,seller:null,source_title:source.title,source_url:source.url,
    source_kind:'other',observed_on:null,retrieved_at:retrievedAt,valid_until:validUntil,location:input.location,confidence:'low',availability:null,
    delivery_cost:null,total_cost:null,raw_excerpt:String(parsed.summary||'').slice(0,500)});
  return {request:input,summary:String(parsed.summary||'').slice(0,1000),items,sources:sourceRows.slice(0,12),retrieved_at:retrievedAt,valid_until:validUntil};
}

function __setGeminiClientForTests(value) {geminiClient=value;}
module.exports={search,normalizeRequest,__setGeminiClientForTests};
