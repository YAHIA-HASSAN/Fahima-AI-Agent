const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const { randomUUID }=require('node:crypto');
const { calculate }=require('../server/planning');
const { validateText, chooseQuestion }=require('../server/response-quality');
const agent=require('../server/agent');
const marketResearchModule=require('../server/market-research');

const literal=(value,basis='assumption',evidence=null)=>({fact_key:null,value,basis,evidence});
const reference=key=>({fact_key:key,value:null,basis:'stored',evidence:null});
const calc=(type,fields={})=>({id:'result',type,budget:null,reserve:null,price:null,quantity:null,unit_cost:null,fixed_cost:null,target:null,lines:[],...fields});
const fact=(key,value,evidence,extra={})=>({key,label:key==='capital'?'الفلوس المتاحة للبداية':'معلومة عن المشروع',value:String(value),numeric_value:typeof value==='number'?value:null,unit:typeof value==='number'?'جنيه':null,kind:'fact',certainty:'confirmed',evidence,correction:false,observed_on:null,...extra});
const output=(fields={})=>({intent:'advise',transaction_status:'unclear',transactions:[],transaction_type:null,amount:null,amount_kind:null,date:'',period:'today',description:'',estimated:false,product_name:null,quantity:null,unit:null,unit_price:null,markup_percent:null,reminder_title:null,due_date:null,fact_key:null,fact_value:null,answer:'نقدر نبدأ بخطوة مناسبة لوضع المشروع.',...fields});
const state=(objective,mode='continue',next_action='نراجع المتطلبات قبل أي شراء.')=>({mode,objective,capability:'تقييم الوضع',next_action,progress:null});
const plan=(title,step)=>({title,summary:'خطة مبدئية حسب الظروف المتاحة.',requirements:['مراجعة ملاءمة المكان.'],assumptions:['الطلب محتاج تجربة صغيرة.'],risks:['الأسعار والطلب ممكن يتغيروا.'],steps:[{key:'first',text:step,status:'proposed',evidence:null}],indicators:['تسجيل نتيجة التجربة.'],next_action:step});

test('planning tools use deterministic arithmetic, explicit reserves, and no missing-price guesses',()=>{
  const facts=[{key:'capital',numeric_value:10000,certainty:'confirmed'},{key:'price',numeric_value:10,certainty:'approximate',kind:'price',observed_on:'2026-10-08',source:'user'}];
  const budget=calculate(calc('budget',{budget:reference('capital'),reserve:literal(2000),lines:[{label:'تجهيز',weight:1,amount:null},{label:'تشغيل',weight:2,amount:null}]}),{facts});
  assert.equal(budget.values.allocations.reduce((sum,row)=>sum+Math.round(row.amount*100),0),800000);
  assert.equal(budget.values.reserve,2000);
  const purchase=calculate(calc('purchase',{budget:reference('capital'),reserve:literal(4000),price:reference('price')}),{facts});
  assert.equal(purchase.values.quantity,600);
  assert.equal(purchase.values.remaining,4000);
  assert.equal(purchase.scenario,true);
  assert.equal(purchase.sources[1].certainty,'hypothetical');
  assert.deepEqual(calculate(calc('purchase',{budget:reference('capital'),reserve:literal(2000)}),{facts}).missing,['price']);
  const goal=calculate(calc('goal',{price:literal(50),unit_cost:literal(30),fixed_cost:literal(1000),target:literal(5000),quantity:literal(100)}));
  assert.equal(goal.values.required_quantity,300);
  assert.equal(goal.values.target_covered,false);
  assert.equal(calculate(calc('revenue',{price:literal(25),quantity:literal(4)})).values.revenue,100);
  assert.equal(calculate(calc('break_even',{price:literal(20),unit_cost:literal(30),fixed_cost:literal(100)})).values.required_quantity,null);
  assert.throws(()=>calculate(calc('budget',{budget:literal(100),reserve:literal(200),lines:[{label:'تشغيل',weight:1,amount:null}]})));
  assert.deepEqual(calculate(calc('cash',{budget:reference('capital')}),{facts}).missing,['opening_cash']);
});

test('reply guard suppresses repeated questions and unsupported claims without damaging names',()=>{
  const facts=[{key:'capital',value:'10000',numeric_value:10000,certainty:'confirmed'}, {key:'brand',value:'Brother 2100',numeric_value:null,certainty:'confirmed'}];
  assert.equal(chooseQuestion({text:'معاك كام؟',fact_key:'capital',reason:'تقسيم الميزانية'},facts,null),null);
  assert.equal(validateText('الماكينة Brother 2100 محتاجة صيانة.',{facts}).valid,true);
  assert.equal(validateText('capital عندك 10000 جنيه.',{facts}).text,'المبلغ المتاح لبداية المشروع عندك 10000 جنيه.');
  assert.equal(validateText('هتكسب أكيد 5000 جنيه.',{facts}).valid,false);
  assert.equal(validateText('سعر السوق 300 جنيه.',{facts}).valid,false);
  assert.equal(validateText('صافي الربح 10000 جنيه.',{facts}).valid,false);
  assert.equal(validateText('سعر السوق 10000 جنيه.',{facts}).valid,false);
  assert.equal(validateText('SELECT * FROM projects',{facts}).valid,false);
});

test('market search has a terminal timeout instead of hanging',async()=>{
  marketResearchModule.__setGeminiClientForTests({interactions:{create:()=>new Promise(()=>{})}});
  try {
    await assert.rejects(marketResearchModule.search({key:'timeout_item',query:'سعر بند تجريبي',purpose:'price',product_name:'بند',freshness_days:7},{timeoutMs:25}),error=>error.code==='SEARCH_TIMEOUT');
  } finally {marketResearchModule.__setGeminiClientForTests(null);}
});

test('adaptive advisory scenarios persist independently and survive an application reload',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fahima-advisor-'));
  const saved={DB_PATH:process.env.DB_PATH,GEMINI_API_KEY:process.env.GEMINI_API_KEY};
  process.env.DB_PATH=path.join(dir,'test.sqlite');process.env.GEMINI_API_KEY='test-key';
  let db,B,server,base,next=output(),captured='',marketResearch;
  async function start() {
    for(const name of ['../server/db','../server/business','../server/index'])delete require.cache[require.resolve(name)];
    const app=require('../server/index');db=require('../server/db');B=require('../server/business');marketResearch=require('../server/market-research');
    agent.__setGeminiClientForTests({interactions:{create:async request=>{captured=request.input;return {output_text:JSON.stringify(next)};}}});
    server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    base=`http://127.0.0.1:${server.address().port}`;
  }
  async function stop(){await new Promise(resolve=>server.close(resolve));db.close();}
  async function api(route,body){const response=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:response.status,...await response.json()};}
  async function researchJob(id,projectId){
    const response=await fetch(`${base}/api/research-jobs/${id}/events?projectId=${projectId}`);
    const events=(await response.text()).split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
    return events.at(-1);
  }
  async function create(name){const row=await api('/api/projects',{name});return {projectId:row.project.id,conversationId:row.conversationId};}
  async function send(scope,message,fields={},identity=randomUUID()){
    next=output(fields);return api('/api/chat',{...scope,message,requestId:identity});
  }
  await start();
  try {
    const primary=await create('المشروع الأول');
    const msg='معايا 10 آلاف جنيه وعايز أعمل مشروع دواجن وعندي أوضة فاضية';
    await t.test('multiple facts save automatically once and memory supplies capital on follow-up',async()=>{
      const fields={facts:[fact('capital',10000,'معايا 10 آلاف جنيه'),fact('activity','تربية دواجن','مشروع دواجن'),fact('space','أوضة فاضية','عندي أوضة فاضية',{kind:'resource'})],state_update:state('تقييم بداية المشروع')};
      let response=await send(primary,msg,fields,'first-message');
      assert.equal(response.kind,'advice');assert.doesNotMatch(response.reply,/أحفظ|capital/);
      assert.equal(B.getProject(primary.projectId).capital,10000);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM project_facts WHERE project_id=?').get(primary.projectId).n,3);
      await send(primary,msg,fields,'first-message');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM project_facts WHERE project_id=?').get(primary.projectId).n,3);
      response=await send(primary,'قسملي الفلوس على المشروع',{calculations:[calc('budget',{budget:reference('capital'),reserve:literal(2000),lines:[{label:'تجهيز المكان',weight:1,amount:null},{label:'تشغيل مبدئي',weight:3,amount:null}]})],question:{text:'معاك كام جنيه؟',fact_key:'capital',reason:'تقسيم الميزانية'},plan:plan('بداية صغيرة','نتأكد من ملاءمة المكان مع مختص محلي.')});
      assert.equal(response.calculations[0].values.budget,10000);
      assert.doesNotMatch(response.reply,/معاك كام/);
      assert.ok(captured.includes('10000'));assert.ok(response.plan);
    });
    await t.test('direct actions cannot end as promises and report requests execute',async()=>{
      let response=await send(primary,'احسب وقولي',{answer:'تمام، هنحسب ونقولك النتيجة.'});
      assert.doesNotMatch(response.reply,/هنحسب|هنبدأ|هراجع/);
      assert.match(response.reply,/ما بدأش|مدخلات/);
      response=await send(primary,'وريني حسابات الشهر ده',{intent:'question',period:'month',answer:'حاضر، هجهز التقرير.'});
      assert.equal(response.kind,'report');assert.ok(response.period.from);assert.ok(response.period.to);
      const report=await api(`/api/report?projectId=${primary.projectId}&from=${response.period.from}&to=${response.period.to}`);
      assert.equal(report.status,200);assert.ok(report.summary);
    });
    await t.test('the reported poultry conversation executes research and calculation without promise loops',async()=>{
      const scope=await create('محادثة الدواجن');
      let response=await send(scope,'معايا 10 تلاف جنيه وعايز اعمل مشروع دواجن',{
        facts:[fact('capital',10000,'معايا 10 تلاف جنيه'),fact('activity','مشروع دواجن','مشروع دواجن')],
        state_update:state('تجهيز بداية مناسبة للمشروع'),answer:'المبلغ والنشاط اتسجلوا. هحدد متطلبات البداية الأساسية وأحسب خطة أولية من غير ما أفترض أسعار.'
      });
      assert.equal(response.kind,'advice');assert.equal(B.getProject(scope.projectId).capital,10000);
      response=await send(scope,'عايز ايه يعني مش فاهم منك حاجه',{answer:'هحسب لك عدد بداية مبدئي بعد مراجعة سعر الكتكوت والعلف، وهسيب جزء للتجهيز والطوارئ.',state_update:state('تجهيز بداية مناسبة للمشروع')});
      assert.doesNotMatch(response.reply,/هل نبدأ|معاك كام/);

      const chickSource='https://supplier.example/chicks';
      const feedSource='https://supplier.example/feed';
      marketResearch.__setGeminiClientForTests({interactions:{create:async request=>{
        const feed=String(request.input).includes('العلف');
        const source=feed?feedSource:chickSource;
        const item=feed
          ?{product_name:'علف بادئ',price:20000,currency:'EGP',quantity:1000,unit:'كيلو',normalized_price:20,normalized_unit:'كيلو'}
          :{product_name:'كتكوت تسمين',price:50,currency:'EGP',quantity:1,unit:'طائر',normalized_price:50,normalized_unit:'طائر'};
        return {output_text:JSON.stringify({summary:'عرض منشور للاختبار.',items:[{...item,seller:'مورد تجريبي',source_url:source,source_kind:'published_offer',observed_on:B.localDate(),location:'مصر',confidence:'medium',availability:'راجع التوفر',excerpt:'سعر منشور'}]}),
          steps:[{type:'model_output',content:[{type:'text',annotations:[{type:'url_citation',url:source,title:'صفحة المورد'}]}]}]};
      }}});
      response=await send(scope,'ماشي احسب وقولي',{
        answer:'هراجع السعرين المطلوبين، والحساب هيستخدم جزءًا محددًا من الميزانية للكتاكيت مع احتياطي لباقي التشغيل.',
        research_requests:[
          {key:'broiler_chick',query:'سعر كتكوت تسمين عمر يوم في مصر',purpose:'price',product_name:'كتكوت تسمين',specification:'عمر يوم',unit:'طائر',location:'مصر',freshness_days:7,reason:'حساب عدد بداية مبدئي'},
          {key:'starter_feed',query:'سعر كيلو علف بادئ تسمين في مصر',purpose:'price',product_name:'علف بادئ',specification:'تسمين',unit:'كيلو',location:'مصر',freshness_days:7,reason:'مراجعة جزء العلف من الميزانية'}
        ],
        calculations:[calc('purchase',{budget:literal(3000),reserve:literal(0),price:reference('market:broiler_chick')})],
        plan:{...plan('خطة بداية مبدئية','راجع ملاءمة المكان والتدفئة والتحصين مع مختص محلي قبل الشراء.'),
          assumptions:['مخصص الكتاكيت جزء من الميزانية، والباقي للعلف والتجهيز والطوارئ.'],requirements:['مراجعة المكان والتدفئة والمياه والتحصين.']},
        state_update:state('تجهيز بداية مناسبة للمشروع')
      });
      assert.ok(response.researchJobId);assert.ok(captured.includes('10000'));
      const finished=await researchJob(response.researchJobId,scope.projectId);
      assert.equal(finished.status,'completed');
      assert.equal(finished.result.calculations[0].values.quantity,60);
      assert.match(finished.result.reply,/60|٦٠/);
      assert.ok(finished.result.research.flatMap(row=>row.items).some(item=>item.source_url===chickSource));

      response=await send(scope,'فين؟',{},'poultry-where');
      assert.match(response.reply,/60|٦٠/);assert.doesNotMatch(response.reply,/معاك يا فندم|هنحسب/);
      response=await send(scope,'هجيب قد اه',{},'poultry-how-many');
      assert.match(response.reply,/60|٦٠/);assert.doesNotMatch(response.reply,/هل نبدأ|سعر.*كام/);
    });
    await t.test('grounded market research is project scoped, cited, fresh, and available to deterministic calculations',async()=>{
      const source='https://supplier.example/item';
      let searchCalls=0;
      let releaseFirstSearch;
      const firstSearchGate=new Promise(resolve=>{releaseFirstSearch=resolve;});
      marketResearch.__setGeminiClientForTests({interactions:{create:async request=>{
        searchCalls++;
        if(searchCalls===1)await firstSearchGate;
        assert.ok(request.tools.some(tool=>tool.type==='google_search'));
        return {output_text:JSON.stringify({summary:'عرض منشور تمت مراجعته.',items:[{product_name:'مدخل تشغيل',description:'عبوة مناسبة',price:10,currency:'EGP',quantity:1,unit:'وحدة',normalized_price:10,normalized_unit:'وحدة',seller:'مورد تجريبي',source_url:source,source_kind:'published_offer',observed_on:B.localDate(),location:'مصر',confidence:'medium',availability:'راجع التوفر',excerpt:'السعر منشور على صفحة المنتج'}]}),
          steps:[{type:'model_output',content:[{type:'text',annotations:[{type:'url_citation',url:source,title:'صفحة المورد'}]}]}]};
      }}});
      const pendingResponse=send(primary,'دوري على سعر المدخل واحسبي اللي نقدر نشتريه',{research_requests:[{key:'input_unit',query:'سعر مدخل التشغيل للوحدة في مصر',purpose:'price',product_name:'مدخل تشغيل',specification:null,unit:'وحدة',location:'مصر',freshness_days:7,reason:'حساب كمية بداية مناسبة'}],
        calculations:[calc('purchase',{budget:reference('capital'),reserve:literal(2000),price:reference('market:input_unit')})]});
      const quick=await Promise.race([pendingResponse,new Promise(resolve=>setTimeout(()=>resolve(null),100))]);
      assert.ok(quick,'main chat response must not wait for market research');
      let response=quick;releaseFirstSearch();
      assert.ok(response.researchJobId);assert.deepEqual(response.calculations[0].missing,['market:input_unit']);
      let finished=await researchJob(response.researchJobId,primary.projectId);
      assert.equal(finished.status,'completed');response=finished.result;
      assert.equal(response.calculations[0].values.quantity,800);
      assert.equal(response.research[0].items[0].source_url,source);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM market_research WHERE project_id=?').get(primary.projectId).n,1);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM market_research WHERE project_id<>? AND research_key='input_unit'").get(primary.projectId).n,0);
      assert.match(response.reply,/سعر منشور|بحث السوق/);
      response=await send(primary,'راجعي نفس السعر تاني',{research_requests:[{key:'input_unit',query:'سعر مدخل التشغيل للوحدة في مصر',purpose:'price',product_name:'مدخل تشغيل',specification:null,unit:'وحدة',location:'مصر',freshness_days:7,reason:'مراجعة الحساب'}],
        calculations:[calc('purchase',{budget:reference('capital'),reserve:literal(2000),price:reference('market:input_unit')})]});
      assert.equal(searchCalls,1);assert.equal(response.calculations[0].values.quantity,800);
      db.prepare("UPDATE market_research SET valid_until='2000-01-01T00:00:00.000Z' WHERE project_id=?").run(primary.projectId);
      response=await send(primary,'حدّثي السعر لأنه قديم',{research_requests:[{key:'input_unit',query:'سعر مدخل التشغيل للوحدة في مصر',purpose:'price',product_name:'مدخل تشغيل',specification:null,unit:'وحدة',location:'مصر',freshness_days:7,reason:'السعر القديم انتهت صلاحيته'}]});
      finished=await researchJob(response.researchJobId,primary.projectId);assert.equal(finished.status,'completed');
      assert.equal(searchCalls,2);assert.equal(db.prepare('SELECT COUNT(*) n FROM market_research WHERE project_id=?').get(primary.projectId).n,2);
      marketResearch.__setGeminiClientForTests({interactions:{create:async()=>({output_text:JSON.stringify({summary:'رقم بلا مصدر.',items:[{product_name:'بند بلا مصدر',price:999,currency:'EGP',quantity:1,unit:'وحدة',source_url:'https://uncited.example/item',source_kind:'published_offer'}]}),steps:[]})}});
      response=await send(primary,'ابحثي عن بند تاني',{research_requests:[{key:'uncited_item',query:'سعر بند تاني',purpose:'price',product_name:'بند تاني',specification:null,unit:'وحدة',location:'مصر',freshness_days:7,reason:'اختبار المصدر'}],
        calculations:[calc('purchase',{budget:reference('capital'),reserve:literal(2000),price:reference('market:uncited_item')})]});
      finished=await researchJob(response.researchJobId,primary.projectId);response=finished.result;
      assert.equal(response.research[0].items[0].price,null);
      assert.deepEqual(response.calculations[0].missing,['market:uncited_item']);
    });
    await t.test('a stalled search reaches a visible terminal fallback',async()=>{
      const oldTimeout=process.env.GEMINI_SEARCH_TIMEOUT_MS;
      process.env.GEMINI_SEARCH_TIMEOUT_MS='1000';
      marketResearch.__setGeminiClientForTests({interactions:{create:()=>new Promise(()=>{})}});
      try {
        const response=await send(primary,'دوري على سعر خامة متأخرة واحسبي',{research_requests:[{key:'stalled_item',query:'سعر خامة متأخرة',purpose:'price',product_name:'خامة متأخرة',specification:null,unit:'وحدة',location:'مصر',freshness_days:7,reason:'اختبار المهلة'}],
          calculations:[calc('purchase',{budget:reference('capital'),reserve:literal(2000),price:reference('market:stalled_item')})]});
        assert.ok(response.researchJobId);
        const finished=await researchJob(response.researchJobId,primary.projectId);
        assert.equal(finished.status,'completed');
        assert.match(finished.result.reply,/اتأخر|فوقفت الانتظار|حساب مشروط/);
        assert.deepEqual(finished.result.calculations[0].missing,['market:stalled_item']);
      } finally {
        marketResearch.__setGeminiClientForTests(null);
        if(oldTimeout===undefined)delete process.env.GEMINI_SEARCH_TIMEOUT_MS;else process.env.GEMINI_SEARCH_TIMEOUT_MS=oldTimeout;
      }
    });
    await t.test('unknown prices do not invent market data and interrupting preserves the objective',async()=>{
      const before=(await api(`/api/init?projectId=${primary.projectId}`)).advisor.state.objective;
      const response=await send(primary,'معرفش سعر العلف',{answer:'السعر الحالي مش متاح عندي. نقدر نجمع عرض سعر كامل من مورد محلي، ونقارن حجم بداية صغير بعده.',state_update:state('سؤال جانبي','interrupt')});
      assert.match(response.reply,/مش متاح/);assert.equal(response.advisorState.objective,before);
      const resumed=await send(primary,'طيب كمل الخطة',{state_update:state(null,'resume')});
      assert.equal(resumed.advisorState.objective,before);
      assert.ok(captured.includes('بداية صغيرة'));
    });
    await t.test('price provenance, explicit correction, hypothetical capital and frustration',async()=>{
      let response=await send(primary,'سعر الكتكوت حوالي 10 جنيه',{facts:[fact('input_price',10,'سعر الكتكوت حوالي 10 جنيه',{kind:'price',certainty:'approximate',observed_on:B.localDate()})]});
      let price=db.prepare("SELECT * FROM project_facts WHERE project_id=? AND key='input_price'").get(primary.projectId);
      assert.equal(price.source,'user');assert.equal(price.certainty,'approximate');assert.equal(price.observed_on,B.localDate());
      response=await send(primary,'لا، خليهم 12 ألف',{facts:[fact('capital',12000,'خليهم 12 ألف',{correction:true})],calculations:[calc('budget',{budget:reference('capital'),reserve:literal(2000),lines:[{label:'بداية مبدئية',weight:1,amount:null}]})]});
      assert.equal(response.calculations[0].values.budget,12000);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM project_facts WHERE project_id=? AND key='capital'").get(primary.projectId).n,1);
      assert.equal((await api(`/api/init?projectId=${primary.projectId}`)).advisor.plan.stale,1);
      await send(primary,'لو كان معايا 50 ألف بدل 12 ألف',{facts:[fact('capital',50000,'لو كان معايا 50 ألف',{certainty:'hypothetical',correction:true})]});
      assert.equal(B.getProject(primary.projectId).capital,12000);
      response=await send(primary,'قولتلك معايا 12 ألف! إنت بتسأل تاني ليه؟',{answer:'المبلغ معروف، نكمل تقييم المتطلبات بالمعلومات الموجودة.',question:{text:'معاك كام؟',fact_key:'capital',reason:'ميزانية'}});
      assert.doesNotMatch(response.reply,/معاك كام|أحفظ/);
    });
    await t.test('goals persist and deterministic feasibility uses the saved goal',async()=>{
      const message='عايز أكسب 5000 جنيه شهريًا';
      const response=await send(primary,message,{goals:[{key:'monthly',title:'دخل للمشروع كل شهر',target:5000,unit:'جنيه',horizon:'شهر',evidence:message,status:'active',correction:false}],
        calculations:[calc('goal',{target:reference('goal:monthly'),price:literal(50),unit_cost:literal(30),fixed_cost:literal(1000),quantity:literal(100)})]});
      assert.equal(response.calculations[0].values.required_quantity,300);
      assert.equal(response.calculations[0].values.target_covered,false);
      assert.match(response.reply,/مش ضمان/);
    });
    await t.test('corrections recalculate prior plan arithmetic without pretending the strategy is reviewed',async()=>{
      let response=await send(primary,'رأس المال بقى 15000',{facts:[fact('capital',15000,'رأس المال بقى 15000',{correction:true})]});
      assert.equal(response.calculations[0].values.budget,15000);
      assert.equal(response.plan.stale,1);
      response=await send(primary,'رجعه 12000',{facts:[fact('capital',12000,'رجعه 12000',{correction:true})]});
      assert.equal(response.plan.body.calculations[0].values.budget,12000);
    });
    await t.test('same industry with different conditions and arbitrary industries remain independent',async()=>{
      const cases=[['تشغيل قائم','دواجن','شغال',50000,'تحسين البيع'],['إعادة تشغيل','دواجن','متوقف',15000,'فهم أسباب التوقف'],['تفصيل','خياطة','جديد',8000,'تجربة الطلب'],['محل','بقالة','شغال',6000,'مراجعة حركة الفلوس'],['أكل من البيت','أكل منزلي','جديد',4000,'مراجعة سلامة المكان'],['نشاط غير مألوف','تصميم نماذج صوتية تعليمية','جديد',3000,'تجربة خدمة صغيرة']];
      for(const [name,activity,status,capital,objective] of cases){
        const scope=await create(name);const message=`نشاطي ${activity} ووضعه ${status} ومعايا ${capital}`;
        const response=await send(scope,message,{facts:[fact('activity',activity,`نشاطي ${activity}`),fact('project_status',status,`وضعه ${status}`),fact('capital',capital,`معايا ${capital}`)],state_update:state(objective),plan:plan(name,objective)});
        assert.equal(response.advisorState.objective,objective);assert.equal(response.plan.title,name);
        assert.equal(B.getProject(scope.projectId).capital,capital);
        assert.equal(B.getProject(primary.projectId).capital,12000);
        if(activity!=='دواجن')assert.ok(!captured.includes('تربية دواجن'));
      }
    });
    await t.test('planned purchase is stored only as a proposal; actual purchase still needs review and retries do not duplicate',async()=>{
      const purchase={intent:'record_transaction',transaction_type:'stock_cost',amount:500,amount_kind:'total',product_name:'كتاكيت',quantity:50,unit:'طائر',description:'هشتري 50 كتكوت'};
      const before=db.prepare('SELECT COUNT(*) n FROM transactions').get().n;
      const planned=await send(primary,'هشتري 50 كتكوت',{...purchase,transaction_status:'planned'});
      assert.equal(planned.kind,'advice');assert.ok(planned.plan);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions').get().n,before);
      const actual=await send(primary,'اشتريت 50 كتكوت بخمسمية',{...purchase,transaction_status:'actual',description:'اشتريت 50 كتكوت'},'purchase');
      assert.equal(actual.kind,'confirm');
      await send(primary,'اشتريت 50 كتكوت بخمسمية',{...purchase,transaction_status:'actual'},'purchase');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions').get().n,before);
      const saved=await send(primary,'أيوه',{},'confirm-purchase');assert.equal(saved.kind,'saved');
      await send(primary,'أيوه',{},'confirm-purchase');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions').get().n,before+1);
    });
    await t.test('project switching resolves only explicit database names without transferring facts',async()=>{
      const response=await send(primary,'نروح مشروع محل',{intent:'switch_project',project_reference:'محل',facts:[fact('capital',9999,'نروح مشروع محل')]});
      assert.equal(response.kind,'switch_project');assert.notEqual(response.projectId,primary.projectId);
      assert.equal(B.getProject(response.projectId).capital,6000);assert.equal(B.getProject(primary.projectId).capital,12000);
      assert.equal((await send(primary,'كمل',{intent:'switch_project',project_reference:'محل'})).kind,'clarify');
    });
    await t.test('mixed actual and planned operations keep separate records and side questions preserve financial review',async()=>{
      const scope=await create('عمليات مختلطة');
      const item=(status,description,amount)=>({transaction_status:status,transaction_type:'operating_expense',amount,amount_kind:'total',date:'',description,estimated:false,product_name:null,quantity:null,unit:null,unit_price:null});
      const response=await send(scope,'دفعت 20 جنيه نقل وهشتري خامات بـ50 جنيه',{intent:'record_transactions',transaction_status:'actual',transactions:[item('actual','نقل',20),item('planned','خامات بـ50 جنيه',50)]});
      assert.equal(response.kind,'confirm');assert.equal(response.pending.payload.amount,20);assert.ok(response.plan);
      await send(scope,'إزاي أحسن البيع؟',{state_update:state('سؤال جانبي','interrupt')});
      assert.equal((await send(scope,'أيوه')).kind,'confirm');
      const saved=await send(scope,'أيوه');assert.equal(saved.transaction.amount,20);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions WHERE project_id=?').get(scope.projectId).n,1);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM business_plans WHERE project_id=?').get(scope.projectId).n,1);
    });
    await t.test('restart restores memory, plans, goals, objective and durable request receipts',async()=>{
      const before=(await api(`/api/init?projectId=${primary.projectId}`)).advisor;
      await stop();await start();
      const after=(await api(`/api/init?projectId=${primary.projectId}`)).advisor;
      assert.equal(after.state.objective,before.state.objective);assert.equal(after.plan.id,before.plan.id);
      assert.equal(after.goals[0].target,5000);assert.equal(B.getProject(primary.projectId).capital,12000);
      const n=db.prepare('SELECT COUNT(*) n FROM transactions').get().n;
      assert.equal((await send(primary,'أيوه',{},'confirm-purchase')).kind,'saved');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions').get().n,n);
      const reply=await send(primary,'كمل',{state_update:state(null,'resume')});
      assert.equal(reply.advisorState.objective,before.state.objective);assert.ok(captured.includes('12000'));
    });
  } finally {
    agent.__setGeminiClientForTests(null);marketResearch?.__setGeminiClientForTests(null);await stop();
    for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
