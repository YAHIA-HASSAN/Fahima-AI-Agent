const TYPES = {
  income: "مبيعات / إيرادات",
  stock_cost: "مشتريات أو تكلفة إنتاج",
  operating_expense: "مصروف تشغيل",
  withdrawal: "مسحوبات للبيت",
};
const $ = (s) => document.querySelector(s);
let state = null,
  conversation = null,
  speechFeedback = "",
  lastReplyText = "",
  voiceAvailable = false,
  voiceMode = "ready";
let replyBusy = false;
const escapeHtml = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const money = (n) =>
  `${new Intl.NumberFormat("ar-EG", { maximumFractionDigits: 2 }).format(Number(n) || 0)} جنيه`;
function setReplyBusy(busy) {
  replyBusy = Boolean(busy);
  $("#message-text").disabled = replyBusy || !state;
  $("#send-text").disabled = replyBusy || !state;
  $("#record-voice").disabled = !state || replyBusy || voiceMode === "starting" || voiceMode === "processing" || !voiceAvailable;
  $("#project-select").disabled = replyBusy || !state;
  $("#new-project").disabled = replyBusy;
  $("#delete-project").disabled = replyBusy || !state;
}
async function appFetch(url, options) {
  try {
    return await fetch(url, options);
  } catch (error) {
    if (error instanceof TypeError || /failed to fetch|networkerror/i.test(error?.message || "")) {
      throw Error("الاتصال بفهيمة انقطع مؤقتًا. انتظري اكتمال تشغيله ثم أرسلي الرسالة مرة أخرى.");
    }
    throw error;
  }
}
async function api(url, options = {}) {
  const headers = {
    ...(options.body instanceof FormData
      ? {}
      : { "Content-Type": "application/json" }),
    ...(options.headers || {}),
  };
  const r = await appFetch(url, { ...options, headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(data.error || "حصلت مشكلة. جرب تاني.");
  return data;
}
function addMessage(text, who = "assistant", voice = false) {
  const el = document.createElement("div");
  el.className = `bubble ${who}`;
  el.textContent = text;
  if (voice && who === "user") {
    const mark = document.createElement("small");
    mark.textContent = " · رسالة صوتية";
    el.append(mark);
  }
  $("#messages").append(el);
  $("#messages").scrollTop = $("#messages").scrollHeight;
  return el;
}
function safeWebUrl(value) {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : ""; }
  catch { return ""; }
}
function addResearchSources(results) {
  const items = (results || []).flatMap(result => result.items || []).filter(item => item.source_url);
  if (!items.length) return;
  const box = document.createElement("div");
  box.className = "bubble assistant research-sources";
  const title = document.createElement("strong");
  title.textContent = "مصادر بحث السوق";
  box.append(title);
  for (const item of items.slice(0, 6)) {
    const url = safeWebUrl(item.source_url);
    if (!url) continue;
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = item.source_title || item.seller || "فتح المصدر";
    box.append(link);
  }
  if (box.childElementCount > 1) $("#messages").append(box);
}
function renderConversation(messages) {
  $("#messages").replaceChildren();
  if (!messages?.length)
    addMessage(
      "أهلًا، احكي لي عن مشروعك وإيه اللي عايز توصله. هنبني على المعلومات اللي تقولها، وأي بيع أو شراء هنراجعه قبل تسجيله.",
      "assistant",
    );
  else {
    messages.forEach((m) =>
      addMessage(
        m.content,
        m.role === "user" ? "user" : "assistant",
        m.input_type === "voice",
      ),
    );
    lastReplyText = [...messages].reverse().find((m) => m.role === "assistant")?.content || "";
    playReplyButton.hidden = !lastReplyText;
  }
}
async function load() {
  const projects = (await api("/api/projects")).projects;
  let id = Number(localStorage.getItem("fahimaProject") || localStorage.getItem("faheemaProject") || localStorage.getItem("fahimProject"));
  if (!projects.some((p) => p.id === id)) id = projects[0]?.id;
  if (!id) {
    state = null;
    conversation = null;
    localStorage.removeItem("fahimaProject");
    $("#project-select").replaceChildren();
    $("#messages").replaceChildren();
    addMessage("ابدأ باختيار «مشروع جديد» واكتب اسمه، وبعدها احكي لي عنه.");
    for (const selector of ["#report", "#profile-toggle", "#memory-toggle"]) $(selector).disabled = true;
    $("#profile-panel").hidden = true;
    $("#memory-panel").hidden = true;
    $("#report-panel").hidden = true;
    lastReplyText = "";
    playReplyButton.hidden = true;
    setReplyBusy(false);
    return;
  }
  for (const selector of ["#report", "#profile-toggle", "#memory-toggle"]) $(selector).disabled = false;
  localStorage.setItem("fahimaProject", id);
  localStorage.removeItem("faheemaProject");
  $("#project-select").innerHTML = projects
    .map(
      (p) =>
        `<option value="${p.id}" ${p.id === id ? "selected" : ""}>${escapeHtml(p.name)}</option>`,
    )
    .join("");
  state = await api(`/api/init?projectId=${id}`);
  conversation = await api(
    `/api/conversation?projectId=${id}&conversationId=${state.conversationId}`,
  );
  $("#from").value = state.period.from;
  $("#to").value = state.period.to;
  renderConversation(conversation.messages);
  renderFacts(state.facts);
  renderProfileStep();
  await voiceStatus();
  setReplyBusy(false);
  api(`/api/agent-tasks?projectId=${state.project.id}&conversationId=${conversation.conversation.id}`)
    .then(({tasks})=>tasks.forEach(task=>followAgentTask(task.id,state.project.id))).catch(()=>{});
}
function renderFacts(facts) {
  $("#facts-list").innerHTML = facts?.length
    ? facts
        .map(
          (f) =>
            `<div class="fact-row"><div><strong>${escapeHtml(f.label || "معلومة عن المشروع")}</strong><span>${escapeHtml(f.value)}${f.certainty === "approximate" ? " · تقريبي" : ""}${f.observed_on ? " · " + escapeHtml(f.observed_on) : ""}</span></div><button class="delete" data-fact-delete="${f.id}" aria-label="حذف المعلومة">×</button></div>`,
        )
        .join("")
    : '<p class="note">لسه مفيش معلومات مؤكدة محفوظة عن المشروع.</p>';
  document.querySelectorAll("[data-fact-delete]").forEach(
    (b) =>
      (b.onclick = async () => {
        await api(
          `/api/project-facts/${b.dataset.factDelete}?projectId=${state.project.id}`,
          { method: "DELETE" },
        );
        await load();
      }),
  );
}
async function refreshProjectData() {
  const projectId = state?.project?.id;
  if (!projectId) return;
  try {
    const updated = await api(`/api/init?projectId=${projectId}&conversationId=${conversation.conversation.id}`);
    if (state?.project?.id !== projectId) return;
    state = updated;
    renderFacts(state.facts);
    renderProfileStep();
  } catch (error) {
    addMessage(error.message).classList.add("error");
  }
}
const followedResearchJobs=new Set();
const followedAgentTasks=new Set();
const deliveredAgentTaskMessages=new Set();
function followAgentTask(taskId,projectId) {
  if(followedAgentTasks.has(taskId))return;
  followedAgentTasks.add(taskId);
  const progress=addMessage('براجع الخطة والمعلومات…');
  const events=new EventSource(`/api/agent-tasks/${encodeURIComponent(taskId)}/events?projectId=${encodeURIComponent(projectId)}`);
  let finished=false;
  const finish=async update=>{
    if(finished||!['COMPLETE','PROVISIONAL','WAITING_FOR_INPUT','FAILED','CANCELLED'].includes(update.status))return;
    finished=true;followedAgentTasks.delete(taskId);events.close();progress.remove();
    if(update.status==='FAILED'||update.status==='CANCELLED') {
      const failure=addMessage(update.result?.reply||update.error||(update.status==='CANCELLED'?'تم إيقاف المهمة.':'تعذر إكمال المهمة دلوقتي.'));
      if(!update.result?.reply)failure.classList.add('error');
      return;
    }
    const result=update.result||{};
    let planLoadError=false;
    if(result.planRef?.planId) {
      try {
        const response=await api(`/api/plans/${encodeURIComponent(result.planRef.planId)}?projectId=${encodeURIComponent(projectId)}`);
        if(Number(response.plan?.project_id)!==Number(projectId)||Number(response.plan?.revision)!==Number(result.planRef.revision))throw new Error('الخطة المحفوظة لا تطابق نتيجة المهمة.');
        if(state?.project?.id===Number(projectId)){state.advisor=state.advisor||{};state.advisor.plan=response.plan;renderProfileStep();}
      } catch {planLoadError=true;}
    }
    if(!deliveredAgentTaskMessages.has(taskId)) {
      const message=planLoadError?'تعذر تحميل الخطة المحفوظة، لذلك مش هاعرض المهمة على إنها جاهزة. جرّب تحديث الصفحة.':result.reply;
      if(message)addMessage(message);
      deliveredAgentTaskMessages.add(taskId);
    }
    addResearchSources(result.research);
    if(result.reply&&!planLoadError){
      lastReplyText=result.speechText||result.reply;playReplyButton.hidden=false;
      const speak=()=>void playReplyAudio(lastReplyText,true,result.speechStreamUrl);
      if(audioBusy||activeAudioPlaying)activeAudioDone.finally(speak);else speak();
    }
    if(result.planRef||result.plan||result.state||result.research)void refreshProjectData();
  };
  events.onmessage=event=>{
    let update;try{update=JSON.parse(event.data);}catch{return;}
    if(update.progress)progress.textContent=update.progress;
    void finish(update);
  };
  events.onerror=async()=>{
    if(finished)return;
    progress.textContent='بستعيد متابعة المهمة…';
    try{await finish(await api(`/api/agent-tasks/${encodeURIComponent(taskId)}?projectId=${encodeURIComponent(projectId)}`));}
    catch(error){finished=true;followedAgentTasks.delete(taskId);events.close();progress.textContent=error.message||'متابعة المهمة اتوقفت مؤقتًا.';progress.classList.add('error');}
  };
}
function followResearchJob(jobId, projectId) {
  if(followedResearchJobs.has(jobId))return;
  followedResearchJobs.add(jobId);
  const progress=addMessage("براجع المصادر والأسعار…");
  const events=new EventSource(`/api/research-jobs/${encodeURIComponent(jobId)}/events?projectId=${encodeURIComponent(projectId)}`);
  let finished=false;
  const finish=update=>{
    if(finished||!['completed','failed'].includes(update.status))return;
    finished=true;followedResearchJobs.delete(jobId);events.close();progress.remove();
    if(update.status==='failed') {addMessage(update.error||"تعذر إكمال بحث السوق دلوقتي.").classList.add("error");return;}
    const result=update.result||{};
    if(result.reply)addMessage(result.reply);
    addResearchSources(result.research);
    if(result.reply){
      lastReplyText=result.speechText||result.reply;
      playReplyButton.hidden=false;
      const speak=()=>void playReplyAudio(lastReplyText,true,result.speechStreamUrl);
      if(audioBusy||activeAudioPlaying)activeAudioDone.finally(speak);
      else speak();
    }
    if(result.marketResearchChanged||result.plan||result.advisorState)void refreshProjectData();
  };
  events.onmessage=event=>{
    let update;
    try {update=JSON.parse(event.data);} catch {return;}
    if(update.status==='queued'||update.status==='running')return;
    finish(update);
  };
  events.onerror=async()=>{
    if(finished)return;
    progress.textContent="بستعيد اتصال متابعة البحث…";
    try {
      const update=await api(`/api/research-jobs/${encodeURIComponent(jobId)}?projectId=${encodeURIComponent(projectId)}`);
      finish(update);
    } catch(error) {
      finished=true;followedResearchJobs.delete(jobId);events.close();
      progress.textContent=error.message||"متابعة البحث اتوقفت. اطلب تحديث البحث علشان نبدأه من جديد.";
      progress.classList.add("error");
    }
  };
}
async function sendMessage(text, inputType = "text") {
  const clean = String(text || "").trim();
  if (!clean || replyBusy || !state || !conversation) return false;
  setReplyBusy(true);
  addMessage(clean, "user", inputType === "voice");
  const loading = addMessage("بفهم طلبك…");
  const loadingTimer=setInterval(()=>{
    const elapsed=Number(loading.dataset.elapsed||0)+1;
    loading.dataset.elapsed=String(elapsed);
    loading.textContent=elapsed<4?"براجع معلومات المشروع…":"بجهز الرد…";
  },1500);
  const stopLoading=()=>clearInterval(loadingTimer);
  try {
    const result = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        message: clean,
        inputType,
        projectId: state.project.id,
        conversationId: conversation.conversation.id,
        requestId: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      }),
    });
    stopLoading();loading.remove();
    setReplyBusy(false);
    if (result.error) {
      addMessage(result.error).classList.add("error");
      setReplyBusy(false);
      return false;
    }
    if (result.kind === "switch_project") {
      localStorage.setItem("fahimaProject", result.projectId);
      setReplyBusy(false);
      await load();
      addMessage(result.reply);
      return true;
    }
    if (result.reply) {
      addMessage(result.reply);
      if (typeof addResearchSources === "function") addResearchSources(result.research);
      lastReplyText = result.speechText || result.reply;
      playReplyButton.hidden = false;
    }
    if (result.reply) void playReplyAudio(lastReplyText, true, result.speechStreamUrl);
    if (result.agentTaskId) followAgentTask(result.agentTaskId, state.project.id);
    else if (result.researchJobId) followResearchJob(result.researchJobId, state.project.id);
    if (result.kind === "report") void downloadReport(result.period.from, result.period.to);
    if (result.plan) $("#profile-panel").hidden = false;
    if (result.kind === "saved" || result.factsChanged || result.plan || result.advisorState || result.marketResearchChanged) void refreshProjectData();
    return Boolean(result.reply);
  } catch (e) {
    stopLoading();loading.remove();
    addMessage(e.message).classList.add("error");
    setReplyBusy(false);
    return false;
  }
}
$("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  void primeAudioPlayback();
  const input = $("#message-text");
  const button = $("#send-text");
  const text = input.value.trim();
  if (!text || button.disabled) return;
  button.disabled = true;
  try {
    if (await sendMessage(text, "text")) input.value = "";
  } finally {
    button.disabled = replyBusy;
    if (!replyBusy) input.focus();
  }
});
$("#profile-toggle").onclick = () =>
  ($("#profile-panel").hidden = !$("#profile-panel").hidden);
$("#memory-toggle").onclick = () =>
  ($("#memory-panel").hidden = !$("#memory-panel").hidden);
function renderProfileStep() {
  if (!state) return;
  const data = state.advisor || {};
  const current = data.state || {};
  const plan = data.plan;
  const list = rows => rows?.length ? '<ul>' + rows.map(text => '<li>' + escapeHtml(text) + '</li>').join('') + '</ul>' : '';
  let html = '<h3>' + escapeHtml(current.objective || 'الخطوة الجاية لمشروعك') + '</h3>';
  if (current.next_action) html += '<p>' + escapeHtml(current.next_action) + '</p>';
  if (data.goals?.length) html += '<h3>الأهداف</h3>' + list(data.goals.map(goal => goal.title + (goal.horizon ? ' · ' + goal.horizon : '')));
  if (plan) {
    html += '<details open><summary>' + escapeHtml(plan.title) + ' · نسخة ' + plan.revision + '</summary>';
    const planStatus=plan.body?.validation?.status||plan.status;
    if(planStatus==='COMPLETE')html+='<p class="note">الخطة اجتازت مراجعة الاكتمال.</p>';
    else if(planStatus==='PROVISIONAL')html+='<p class="note">الخطة مبدئية؛ راجع الافتراضات والنواقص قبل الاعتماد عليها.</p>';
    else if(planStatus==='INVALID')html+='<p class="note">الخطة غير صالحة للاعتماد؛ الأرقام أو المدخلات تحتاج تصحيحًا.</p>';
    else if(planStatus==='FAILED')html+='<p class="note">تعذر التحقق من الخطة الحالية.</p>';
    if(plan.body.validation?.missing?.length)html+='<p class="note">محتاجين نراجع: '+escapeHtml(plan.body.validation.missing.join('، '))+'</p>';
    if (plan.stale) html += '<p class="note">في معلومات اتغيرت. الخطة دي محتاجة مراجعة قبل الاعتماد عليها.</p>';
    if (plan.change_reason) html += '<p class="note">سبب آخر تحديث: ' + escapeHtml(plan.change_reason) + '</p>';
    html += '<p>' + escapeHtml(plan.body.summary) + '</p>';
    for (const [key,label] of [['requirements','اللي محتاجينه'],['assumptions','افتراضات محتاجة مراجعة'],['risks','حاجات ناخد بالنا منها'],['indicators','هنعرف التقدم إزاي']]) {
      if (plan.body[key]?.length) html += '<h4>' + label + '</h4>' + list(plan.body[key]);
    }
    html += '<h4>خطوات التنفيذ</h4>' + list(plan.body.steps.map(step => step.text + (step.status === 'completed' ? ' · تمت' : step.status === 'in_progress' ? ' · شغالين عليها' : ' · مقترحة')));
    if (plan.body.calculations?.length) html += '<h4>الحسابات</h4>' + list(plan.body.calculations.map(row => row.display || '').filter(Boolean));
    if (plan.body.sources?.length) {
      html += '<h4>مصادر الخطة والأسعار</h4><ul>' + plan.body.sources.slice(0,8).map(source => {
        const url=safeWebUrl(source.url);
        const label=[source.title||source.product,source.observed_on?` · ${source.observed_on}`:'',source.stale?' · قديم':''].join('');
        return `<li>${url?`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`:escapeHtml(label)}</li>`;
      }).join('') + '</ul>';
    }
    html += '</details>';
  }
  const research = data.knowledge?.research || [];
  if (research.length) {
    html += '<details><summary>بحث السوق والمصادر</summary>';
    html += research.slice(0, 12).map(row => {
      const url = safeWebUrl(row.source_url);
      const price = row.price == null ? 'من غير سعر واضح' : money(row.price) + (row.quantity && row.unit ? ' لكل ' + escapeHtml(row.quantity) + ' ' + escapeHtml(row.unit) : '');
      const delivery = row.delivery_cost == null ? '' : ' · توصيل ' + money(row.delivery_cost);
      const freshness = row.stale ? ' · محتاج تحديث' : ' · اتراجع ' + escapeHtml((row.retrieved_at || '').slice(0, 10));
      return '<p><strong>' + escapeHtml(row.product_name || row.research_key) + '</strong>' + (row.specification ? '<br>' + escapeHtml(row.specification) : '') + '<br>' + price + delivery + freshness + (url ? '<br><a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(row.source_title || 'فتح المصدر') + '</a>' : '') + '</p>';
    }).join('');
    html += '</details>';
  }
  html += '<button id="advisor-continue" class="primary">نكمل الخطوة الجاية</button>';
  $("#profile-step").innerHTML = html;
  $("#advisor-continue").onclick = () => sendMessage('كمل معايا الخطوة الجاية للمشروع');
}
$("#fact-form").onsubmit = async (e) => {
  e.preventDefault();
  const sent = await sendMessage(`معلومة عن المشروع: ${$("#fact-key").value}: ${$("#fact-value").value}`);
  if (sent) e.target.reset();
};
$("#clear-facts").onclick = async () => {
  if (
    !confirm(
      "هيتم مسح المعلومات المؤكدة من ذاكرة المشروع. المعاملات هتفضل زي ما هي. تكملي؟",
    )
  )
    return;
  await api(`/api/project-facts?projectId=${state.project.id}`, {
    method: "DELETE",
  });
  await load();
};
$("#clear-conversation").onclick = async () => {
  if (
    !confirm(
      "هيتم مسح رسائل المحادثة والطلب المعلق فقط. المعاملات وذاكرة المشروع هيفضلوا. تكملي؟",
    )
  )
    return;
  await api(
    `/api/conversation/${conversation.conversation.id}?projectId=${state.project.id}`,
    { method: "DELETE" },
  );
  await load();
};
$("#project-select").onchange = () => {
  localStorage.setItem("fahimaProject", $("#project-select").value);
  load();
};
$("#new-project").onclick = async () => {
  const name = prompt("اكتب اسم بسيط للمشروع:");
  if (!name?.trim()) return;
  try {
    const r = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    localStorage.setItem("fahimaProject", r.project.id);
    $("#profile-panel").hidden = false;
      await load();
  } catch (e) {
    addMessage(e.message).classList.add("error");
  }
};
$("#delete-project").onclick = async () => {
  const name = state?.project?.name || "المشروع الحالي";
  if (!confirm(`هيتم حذف «${name}» وكل بياناته ومحادثاته ومخزونه نهائيًا. لا يمكن التراجع. متأكدة؟`)) return;
  const button = $("#delete-project");
  button.disabled = true;
  try {
    await api(`/api/projects/${state.project.id}`, { method: "DELETE" });
    localStorage.removeItem("fahimaProject");
    localStorage.removeItem("faheemaProject");
    localStorage.removeItem("fahimProject");
    await load();
  } catch (e) {
    addMessage(e.message).classList.add("error");
  } finally {
    button.disabled = false;
  }
};
const recordButton = $("#record-voice");
const playReplyButton = $("#play-reply");
const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let finalTranscript = "";
function setVoiceMode(mode, message) {
  voiceMode = mode;
  const labels = { ready: "🎤 ابدأ الكلام", starting: "⏳ بجهز السماع…", recording: "⏹ إيقاف وإرسال", processing: "⏳ ثانية واحدة…" };
  recordButton.hidden = false;
  recordButton.textContent = labels[mode] || labels.ready;
  recordButton.disabled = !state || replyBusy || mode === "starting" || mode === "processing" || !voiceAvailable;
  recordButton.classList.toggle("recording", mode === "recording");
  recordButton.setAttribute("aria-pressed", String(mode === "recording"));
  $("#recording-status").textContent = message || ({ ready: voiceAvailable ? "اضغط وابدأ الكلام، واضغط تاني لما تخلصي." : "الصوت مش متاح هنا، اكتب رسالتك عادي.", starting: "بجهز الميكروفون…", recording: "سامعاك… اضغط لإيقاف الكلام وإرساله.", processing: "بحضّر الرد…" }[mode] || "");
}
function voiceStatus() {
  voiceAvailable = Boolean(SpeechRecognitionApi);
  $("#voice-status").textContent = voiceAvailable ? "الإملاء من المتصفح · صوت Gemini مباشر" : "الإملاء غير متاح · صوت Gemini مباشر";
  $("#voice-status").classList.toggle("voice-offline", !voiceAvailable);
  playReplyButton.hidden = !lastReplyText;
  setVoiceMode("ready");
}
function createRecognition() {
  if (!SpeechRecognitionApi) return null;
  const instance = new SpeechRecognitionApi();
  let submitted = false;
  const submitTranscript = () => {
    const text = finalTranscript.trim();
    if (submitted || !text) return false;
    submitted = true;
    finalTranscript = "";
    setVoiceMode("processing", "بحضّر الرد…");
    void sendMessage(text, "voice").finally(() => {
      setVoiceMode("ready", $("#recording-status").textContent);
    });
    return true;
  };
  instance.lang = "ar-EG";
  instance.continuous = false;
  instance.interimResults = true;
  instance.onstart = () => setVoiceMode("recording", "سامعاك… اضغط لإيقاف الكلام وإرساله.");
  instance.onresult = (event) => {
    if (submitted) return;
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const phrase = event.results[i][0]?.transcript || "";
      if (event.results[i].isFinal) finalTranscript += phrase + " ";
      else interim += phrase;
    }
    if (interim) $("#recording-status").textContent = `سامعاك: ${interim}`;
    // Final text is ready to send; browser shutdown can finish independently.
    if (finalTranscript.trim() && !interim && submitTranscript()) {
      try { instance.stop(); } catch { /* Recognition may already be ending. */ }
    }
  };
  instance.onerror = (event) => {
    if (submitted) return;
    const messages = { "not-allowed": "محتاجين السماح لِفهيمة تستخدم الميكروفون.", "service-not-allowed": "خدمة الصوت مش متاحة في المتصفح ده. اكتب رسالتك عادي.", "no-speech": "مسمعتش حاجة، حاولي تاني." };
    speechFeedback = messages[event.error] || "الصوت وقف. تقدر تكتبي رسالتك عادي.";
    if (event.error !== "no-speech") addMessage(speechFeedback).classList.add("error");
  };
  instance.onend = () => {
    if (submitted || submitTranscript()) return;
    setVoiceMode("ready", speechFeedback || "مسمعتش كلام واضح، حاولي تاني.");
  };
  return instance;
}
recordButton.addEventListener("click", () => {
  void primeAudioPlayback();
  if (!state || !voiceAvailable || voiceMode === "starting" || voiceMode === "processing") return;
  if (voiceMode === "recording") {
    setVoiceMode("processing", "ثانية واحدة…");
    recognition?.stop();
    return;
  }
  speechFeedback = "";
  finalTranscript = "";
  recognition = createRecognition();
  setVoiceMode("starting");
  try { recognition.start(); }
  catch { setVoiceMode("ready", "مش قادرة أفتح الميكروفون دلوقتي. جرب تاني أو اكتب."); }
});
playReplyButton.addEventListener("click", () => {
  void primeAudioPlayback();
  void playReplyAudio(lastReplyText, true);
});
let audioRequest = 0;
let audioContext = null;
let activeAudioController = null;
let activeAudioSources = [];
let activeAudioPlaying = false;
let audioBusy = false;
let activeAudioDone = Promise.resolve();
async function primeAudioPlayback() {
  const AudioContextApi=window.AudioContext||window.webkitAudioContext;
  if(!AudioContextApi)return null;
  if(!audioContext)audioContext=new AudioContextApi({sampleRate:24000});
  if(audioContext.state==='suspended')await audioContext.resume().catch(()=>{});
  return audioContext;
}
function stopActiveAudio() {
  activeAudioController?.abort();
  for(const source of activeAudioSources)try{source.stop();}catch{}
  activeAudioSources=[];
  activeAudioPlaying=false;
}
function pcmAudioBuffer(context,bytes) {
  const samples=Math.floor(bytes.length/2);
  const buffer=context.createBuffer(1,samples,24000);
  const channel=buffer.getChannelData(0);
  for(let index=0;index<samples;index+=1){
    let sample=bytes[index*2]|(bytes[index*2+1]<<8);
    if(sample>=0x8000)sample-=0x10000;
    channel[index]=sample/0x8000;
  }
  return buffer;
}
function playReplyAudio(text,autoPlay=false,streamUrl=null) {
  const clean=String(text||"").trim();
  if(!clean)return Promise.resolve();
  const task=playReplyWithGemini(clean,autoPlay,streamUrl);
  activeAudioDone=task.catch(()=>{});
  return task;
}
async function playReplyWithGemini(text, autoPlay = false, streamUrl = null) {
  const clean = String(text || "").trim();
  if (!clean) return;
  const request=++audioRequest;
  stopActiveAudio();
  const controller=new AbortController();
  activeAudioController=controller;
  audioBusy=true;
  playReplyButton.disabled = true;
  playReplyButton.textContent = "⏳ بجهز الصوت…";
  $("#recording-status").textContent = "الصوت هيبدأ أول ما توصل أول دفعة…";
  try {
    let resolvedStreamUrl=streamUrl;
    if(!resolvedStreamUrl){
      const response = await appFetch("/api/tts/ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: clean }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw Error(error.error || "تعذر تجهيز الصوت.");
      }
      const ticket=await response.json();
      resolvedStreamUrl=ticket.streamUrl;
    }
    if(request!==audioRequest)return;
    const audioResponse=await appFetch(resolvedStreamUrl,{signal:controller.signal});
    if(!audioResponse.ok){
      const error=await audioResponse.json().catch(()=>({}));
      throw Error(error.error||"تعذر تجهيز الصوت.");
    }
    const context=await primeAudioPlayback();
    if(!context||context.state!=='running')throw Error("المتصفح منع التشغيل التلقائي. اضغط زر اسمع الرد للمحاولة تاني.");
    if(!audioResponse.body)throw Error("المتصفح مش قادر يستقبل بث الصوت.");
    const reader=audioResponse.body.getReader();
    let carry=new Uint8Array(0),scheduledAt=context.currentTime+0.04,received=false;
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      if(request!==audioRequest){await reader.cancel();return;}
      let bytes=value;
      if(carry.length){const merged=new Uint8Array(carry.length+value.length);merged.set(carry);merged.set(value,carry.length);bytes=merged;}
      const usable=bytes.length-(bytes.length%2);
      carry=bytes.slice(usable);
      if(!usable)continue;
      const source=context.createBufferSource();
      source.buffer=pcmAudioBuffer(context,bytes.subarray(0,usable));
      source.connect(context.destination);
      scheduledAt=Math.max(scheduledAt,context.currentTime+0.02);
      source.start(scheduledAt);
      scheduledAt+=source.buffer.duration;
      activeAudioSources.push(source);
      if(!received){received=true;activeAudioPlaying=true;audioBusy=false;playReplyButton.disabled=false;playReplyButton.textContent="🔁 اسمع الرد تاني";$("#recording-status").textContent="فهيمة بتقرأ الرد بصوت Gemini.";}
    }
    if(!received)throw Error("Gemini مرجعش صوت قابل للتشغيل.");
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,(scheduledAt-context.currentTime)*1000)));
    if(request===audioRequest){activeAudioPlaying=false;activeAudioSources=[];$("#recording-status").textContent="خلص الرد الصوتي. تقدر تسمعه تاني من الزر.";playReplyButton.textContent="🔁 اسمع الرد تاني";}
  } catch (error) {
    if(request===audioRequest&&error?.name!=='AbortError'){
      stopActiveAudio();
      $("#recording-status").textContent = error.message || "تعذر تجهيز صوت Gemini. الرد النصي موجود، وجرب زر إعادة السماع.";
    }
  } finally {
    if(request===audioRequest){audioBusy=false;activeAudioPlaying=false;activeAudioController=null;playReplyButton.disabled = false;}
  }
}
voiceStatus();
function drawRtl(
  ctx,
  text,
  x,
  y,
  maxWidth,
  font = "24px Cairo, Tahoma, sans-serif",
  color = "#263a34",
  maxLines = 3,
) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.direction = "rtl";
  const words = String(text ?? "").split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
      if (lines.length >= maxLines - 1) break;
    } else line = candidate;
  }
  if (line) lines.push(line);
  const printed = lines.slice(0, maxLines);
  if (
    words.length &&
    printed.length === maxLines &&
    ctx.measureText(printed.at(-1)).width > maxWidth
  )
    printed[printed.length - 1] = printed.at(-1).slice(0, -1) + "…";
  printed.forEach((item, i) => ctx.fillText(item, x, y + i * 34, maxWidth));
  return y + printed.length * 34;
}
function reportCanvas(report, rows, pageNumber, totalPages, isFirst) {
  const canvas = document.createElement("canvas");
  canvas.width = 1240;
  canvas.height = 1754;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#146c5a";
  ctx.fillRect(0, 0, canvas.width, 220);
  drawRtl(
    ctx,
    "فهيمة · تقرير المشروع",
    1140,
    48,
    1040,
    "bold 48px Cairo, Tahoma, sans-serif",
    "#fff",
    1,
  );
  drawRtl(
    ctx,
    report.project.name,
    1140,
    118,
    1040,
    "28px Cairo, Tahoma, sans-serif",
    "#e8f4ef",
    1,
  );
  drawRtl(
    ctx,
    `الفترة: ${report.period.from} إلى ${report.period.to}`,
    1140,
    270,
    1050,
    "26px Cairo, Tahoma, sans-serif",
    "#263a34",
    1,
  );
  if (report.project.activity)
    drawRtl(
      ctx,
      `النشاط: ${report.project.activity}`,
      1140,
      315,
      1050,
      "23px Cairo, Tahoma, sans-serif",
      "#687873",
      1,
    );
  let startY = 375;
  if (isFirst) {
    const s = report.summary;
    const cards = [
      ["المبيعات المسجلة", s.totals.income],
      ["المشتريات / الإنتاج", s.totals.stock_cost],
      ["مصروفات التشغيل", s.totals.operating_expense],
      ["المسحوبات للبيت", s.totals.withdrawal],
    ];
    cards.forEach(([label, value], i) => {
      const col = i % 2,
        row = Math.floor(i / 2),
        x = 650 - col * 560,
        y = 375 + row * 150;
      ctx.fillStyle = "#f1f7f3";
      ctx.fillRect(x, y, 520, 126);
      drawRtl(
        ctx,
        label,
        x + 480,
        y + 16,
        460,
        "21px Cairo, Tahoma, sans-serif",
        "#687873",
        1,
      );
      drawRtl(
        ctx,
        money(value),
        x + 480,
        y + 58,
        460,
        "bold 30px Cairo, Tahoma, sans-serif",
        "#146c5a",
        1,
      );
    });
    drawRtl(
      ctx,
      `عدد عمليات البيع المسجلة: ${s.saleCount}`,
      1140,
      700,
      1050,
      "23px Cairo, Tahoma, sans-serif",
      "#263a34",
      1,
    );
    drawRtl(
      ctx,
      "المجاميع تعكس البيانات المسجلة فقط. لا يتضمن التقرير حساب صافي الربح؛ فقد تظل المشتريات ضمن المخزون ولا تتوفر دائمًا تكلفة البضاعة المباعة.",
      1140,
      744,
      1050,
      "20px Cairo, Tahoma, sans-serif",
      "#687873",
      3,
    );
    startY = 860;
  } else startY = 375;
  drawRtl(
    ctx,
    "تفاصيل العمليات",
    1140,
    startY,
    1050,
    "bold 27px Cairo, Tahoma, sans-serif",
    "#146c5a",
    1,
  );
  let y = startY + 55;
  if (!rows.length && isFirst)
    drawRtl(
      ctx,
      "لا توجد معاملات مسجلة خلال هذه الفترة.",
      1140,
      y,
      1050,
      "22px Cairo, Tahoma, sans-serif",
      "#687873",
      1,
    );
  rows.forEach((item, index) => {
    const top = y + index * 105;
    ctx.fillStyle = index % 2 ? "#fff" : "#f8faf9";
    ctx.fillRect(70, top - 8, 1100, 98);
    drawRtl(
      ctx,
      `${item.date} · ${TYPES[item.type]}${item.estimated ? " · تقديري" : ""}`,
      1115,
      top + 6,
      780,
      "19px Cairo, Tahoma, sans-serif",
      "#687873",
      1,
    );
    drawRtl(
      ctx,
      item.description,
      1115,
      top + 40,
      790,
      "21px Cairo, Tahoma, sans-serif",
      "#263a34",
      2,
    );
    ctx.font = "bold 21px Cairo, Tahoma, sans-serif";
    ctx.fillStyle = "#146c5a";
    ctx.textAlign = "left";
    ctx.direction = "rtl";
    ctx.fillText(money(item.amount), 100, top + 29, 245);
  });
  drawRtl(
    ctx,
    `فهيمة · صفحة ${pageNumber} من ${totalPages}`,
    1140,
    1685,
    1050,
    "18px Cairo, Tahoma, sans-serif",
    "#687873",
    1,
  );
  return canvas;
}
async function canvasJpeg(canvas) {
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.94),
  );
  if (!blob) throw Error("تعذر تجهيز صفحة PDF.");
  return new Uint8Array(await blob.arrayBuffer());
}
async function createReportPdf(report) {
  await document.fonts?.ready;
  const pages = [];
  const firstRows = report.transactions.slice(0, 7);
  pages.push({ rows: firstRows, first: true });
  const remaining = report.transactions.slice(7);
  for (let i = 0; i < remaining.length; i += 12)
    pages.push({ rows: remaining.slice(i, i + 12), first: false });
  const jpegPages = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    jpegPages.push(
      await canvasJpeg(
        reportCanvas(report, page.rows, i + 1, pages.length, page.first),
      ),
    );
  }
  const encoder = new TextEncoder(),
    parts = [];
  let byteLength = 0;
  const append = (part) => {
    parts.push(part);
    byteLength += part.length;
  };
  const ascii = (s) => encoder.encode(s);
  append(ascii("%PDF-1.4\n% fahima PDF\n"));
  const offsets = [];
  const addObject = (id, content) => {
    offsets[id] = byteLength;
    append(ascii(`${id} 0 obj\n`));
    for (const part of content)
      append(typeof part === "string" ? ascii(part) : part);
    append(ascii("\nendobj\n"));
  };
  const pageRefs = pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ");
  addObject(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
  addObject(2, [
    `<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>`,
  ]);
  for (let i = 0; i < pages.length; i++) {
    const pageId = 3 + i * 3,
      imageId = pageId + 1,
      contentId = pageId + 2,
      jpeg = jpegPages[i],
      stream = `q\n595.28 0 0 841.89 0 0 cm\n/Im0 Do\nQ`;
    addObject(pageId, [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    ]);
    addObject(imageId, [
      `<< /Type /XObject /Subtype /Image /Width 1240 /Height 1754 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      jpeg,
      "\nendstream",
    ]);
    addObject(contentId, [
      `<< /Length ${encoder.encode(stream).length} >>\nstream\n${stream}\nendstream`,
    ]);
  }
  const xrefOffset = byteLength;
  append(
    ascii(
      `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
        .join(
          "",
        )}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`,
    ),
  );
  return new Blob(parts, { type: "application/pdf" });
}
async function downloadReport(from = state.period.from, to = state.period.to) {
  const button = $("#report");
  const original = button?.innerHTML;
  if (button) {
    button.disabled = true;
    button.innerHTML = "جاري تجهيز التقرير…";
  }
  try {
    const report = await api(
      `/api/report?projectId=${state.project.id}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    const blob = await createReportPdf(report);
    const url = URL.createObjectURL(blob);
    const name = `fahima-report-${report.period.from}-${report.period.to}.pdf`;
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    const panel = $("#report-panel");
    panel.hidden = false;
    panel.innerHTML = `<div class="section-head"><div><p class="eyebrow">تم تجهيز التقرير</p><h2>${escapeHtml(report.project.name)} · ${escapeHtml(report.period.from)} إلى ${escapeHtml(report.period.to)}</h2></div></div><p class="report-body">التقرير جاهز. إذا لم يبدأ تنزيله تلقائيًا، استخدمي الزر بالأسفل. يتضمن المجاميع المسجلة ولا يحسب صافي الربح.</p>`;
    const fallback = document.createElement("a");
    fallback.className = "secondary report-download-link";
    fallback.href = url;
    fallback.download = name;
    fallback.textContent = "تنزيل تقرير PDF";
    panel.append(fallback);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    addMessage(e.message || "تعذر إنشاء التقرير.").classList.add("error");
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = original;
    }
  }
}
$("#report").onclick = () => downloadReport($("#from").value, $("#to").value);
load().catch((e) => addMessage(e.message).classList.add("error"));
