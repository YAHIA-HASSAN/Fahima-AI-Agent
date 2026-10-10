const $ = (s) => document.querySelector(s);
let projectId = null,
  conversationId = null,
  busy = false,
  lastReply = "",
  activeTaskId = null,
  audioContext = null,
  audioSources = [],
  audioRunning = false,
  audioStopped = false;
function bubble(text, role = "assistant", plan = null) {
  const node = document.createElement("div");
  node.className = `bubble ${role}`;
  node.textContent = text;
  $("#messages").append(node);
  if (plan) $("#messages").append(planCard(plan));
  $("#messages").scrollTop = $("#messages").scrollHeight;
  return node;
}
function planCard(saved, full = false) {
  const plan = saved?.plan || saved || {};
  const card = document.createElement("article");
  card.className = "plan-card";
  const title = document.createElement("h3");
  title.textContent = plan.objective || "خطة المشروع";
  card.append(title);
  const status = document.createElement("span");
  status.className = "plan-status";
  status.textContent =
    (saved.qualityStatus || saved.quality_status) === "COMPLETE"
      ? "خطة مكتملة"
      : "خطة مبدئية";
  card.append(status);
  if (plan.budget) {
    const money = document.createElement("p");
    money.textContent = `رأس المال: ${Number(plan.budget.capital || 0).toLocaleString("ar-EG")} جنيه · إجمالي مقترح: ${Number(plan.budget.total || 0).toLocaleString("ar-EG")} جنيه`;
    card.append(money);
  }
  const steps = document.createElement("div");
  steps.innerHTML = "<strong>الخطوات الجاية</strong>";
  const list = document.createElement("ol");
  for (const step of (plan.steps || []).slice(0, 3)) {
    const li = document.createElement("li");
    li.textContent = step;
    list.append(li);
  }
  steps.append(list);
  card.append(steps);
  if (
    (plan.steps || []).length > 3 ||
    plan.risks?.length ||
    plan.assumptions?.length ||
    plan.missingInformation?.length ||
    plan.sources?.length
  ) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = full ? "تفاصيل الخطة" : "شوفي الخطة";
    details.append(summary);
    details.append(fullPlan(plan));
    card.append(details);
  }
  return card;
}
function fullPlan(plan) {
  const box = document.createElement("div");
  const add = (label, items) => {
    if (!items?.length) return;
    const h = document.createElement("p");
    h.innerHTML = `<strong>${label}</strong><br>${items.map((x) => `• ${escapeHtml(x)}`).join("<br>")}`;
    box.append(h);
  };
  add("الخطوات", plan.steps);
  add("الافتراضات", plan.assumptions);
  add("المخاطر", plan.risks);
  add("المعلومات الناقصة", plan.missingInformation);
  if (plan.budget) {
    const b = document.createElement("p");
    b.innerHTML = `<strong>الميزانية</strong><br>الإجمالي: ${Number(plan.budget.total || 0).toLocaleString("ar-EG")} جنيه<br>المتبقي: ${Number(plan.budget.remaining || 0).toLocaleString("ar-EG")} جنيه`;
    box.append(b);
  }
  if (plan.sources?.length) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "شوفي المصادر";
    details.append(summary);
    for (const source of plan.sources) {
      const a = document.createElement("a");
      a.href = source.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = source.title || source.url;
      details.append(a, document.createElement("br"));
    }
    box.append(details);
  }
  return box;
}
function escapeHtml(value) {
  const node = document.createElement("span");
  node.textContent = value;
  return node.innerHTML;
}
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "حصلت مشكلة مؤقتة.");
  return body;
}
async function loadProjects() {
  const data = await api("/api/projects");
  $("#projects").replaceChildren(
    ...data.projects.map((p) => {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name;
      return o;
    }),
  );
  if (!projectId && data.projects.length) projectId = data.projects[0].id;
  $("#projects").value = projectId || "";
  $("#projectName").textContent =
    data.projects.find((p) => p.id === Number(projectId))?.name ||
    "مستشارة مشروعك";
  await loadProjectData();
}
async function loadProjectData() {
  if (!projectId) return;
  conversationId = null;
  $("#messages").replaceChildren();
  closePanels();
  const [plan, history, records] = await Promise.all([
    api(`/api/projects/${projectId}/plan`),
    api(`/api/projects/${projectId}/conversation`),
    api(`/api/projects/${projectId}/transactions`),
  ]);
  if (history.conversation) {
    conversationId = history.conversation.id;
    for (const message of history.messages)
      bubble(
        message.content,
        message.role === "user" ? "user" : "assistant",
        message.plan,
      );
    lastReply =
      [...history.messages].reverse().find((m) => m.role === "assistant")
        ?.content || "";
    $("#playReply").hidden = !lastReply;
  }
  if (history.activeTask) {
    busy = true;
    activeTaskId = history.activeTask.id;
    $("#cancelTask").hidden = false;
    void waitForTask(activeTaskId).finally(finishBusy);
  }
  renderSidebarPlan(plan, records);
}
function renderSidebarPlan(data, records) {
  const saved = data.plan;
  $("#plan").replaceChildren();
  if (saved) {
    const title = document.createElement("strong");
    title.textContent = saved.plan.objective || "الخطة الحالية";
    $("#plan").append(title);
    const p = document.createElement("p");
    p.textContent =
      (saved.qualityStatus || saved.quality_status) === "COMPLETE"
        ? "خطة مكتملة"
        : "خطة مبدئية";
    $("#plan").append(p);
    const button = document.createElement("button");
    button.className = "outline-button";
    button.textContent = "شوف الخطة";
    button.onclick = () => {
      const old = $("#plan").querySelector(".plan-card");
      if (old) old.remove();
      $("#plan").append(planCard(saved, true));
    };
    $("#plan").append(button);
  } else $("#plan").textContent = "مفيش خطة محفوظة لسه.";
  const list = $("#transactions");
  list.replaceChildren();
  for (const row of records.transactions
    .filter((r) => !r.voided_at)
    .slice(0, 20)) {
    const item = document.createElement("div");
    item.className = "transaction-row";
    const labels = { income: "مبيعات", stock_cost: "مشتريات", operating_expense: "مصروف", withdrawal: "سحب" };
    item.textContent = `${labels[row.type] || "عملية"} · ${row.amount} جنيه · ${row.date}`;
    list.append(item);
  }
  if (!records.transactions.length) list.textContent = "مفيش معاملات مسجلة.";
}
async function sendMessage(text, inputMode = "text") {
  if (busy || !projectId || !text.trim()) return;
  busy = true;
  $("#send").disabled = $("#voice").disabled = true;
  $("#status").textContent = "فهيمة بتفكر…";
  bubble(text, "user");
  $("#input").value = "";
  try {
    const data = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        projectId,
        conversationId,
        message: text,
        inputMode,
        requestId: crypto.randomUUID(),
      }),
    });
    conversationId = data.conversationId;
    activeTaskId = data.taskId;
    $("#cancelTask").hidden = false;
    await waitForTask(data.taskId, inputMode === "voice");
  } catch (error) {
    bubble(error.message);
    $("#status").textContent = "";
  } finally {
    finishBusy();
  }
}
function finishBusy() {
  busy = false;
  activeTaskId = null;
  $("#cancelTask").hidden = true;
  $("#send").disabled = $("#voice").disabled = false;
  $("#input").focus();
}
async function waitForTask(id, autoSpeak = false) {
  for (let i = 0; i < 180; i++) {
    const data = await api(`/api/tasks/${id}?projectId=${projectId}`);
    if (
      [
        "COMPLETE",
        "PROVISIONAL",
        "WAITING_FOR_INPUT",
        "FAILED",
        "CANCELLED",
      ].includes(data.task.status)
    ) {
      if (data.message) {
        const saved = data.task.result?.plan;
        if (data.message.content)
          bubble(data.message.content, "assistant", saved);
        lastReply = data.message.content;
        $("#playReply").hidden = !lastReply;
        if (autoSpeak) void speakReply();
      } else bubble(data.task.result?.answer || "");
      if (data.task.result?.plan) await loadProjectData();
      $("#status").textContent =
        data.task.status === "WAITING_FOR_INPUT"
          ? "فهيمة محتاجة معلومة واحدة."
          : data.task.status === "CANCELLED"
            ? "المهمة اتلغت."
            : "";
      return;
    }
    $("#status").textContent = "فهيمة شغالة…";
    await new Promise((r) => setTimeout(r, 700));
  }
  $("#status").textContent = "المهمة لسه شغالة؛ تقدري ترجعي بعد شوية.";
}
function closePanels() {
  for (const id of ["planPanel", "recordsPanel", "reportPanel"])
    $("#" + id).classList.add("collapsed");
  for (const id of ["planToggle", "recordsToggle", "reportToggle"])
    $("#" + id).setAttribute("aria-expanded", "false");
}
function togglePanel(button, panel) {
  const el = $("#" + panel),
    open = el.classList.toggle("collapsed") === false;
  button.setAttribute("aria-expanded", String(open));
}
$("#planToggle").onclick = () => togglePanel($("#planToggle"), "planPanel");
$("#recordsToggle").onclick = () =>
  togglePanel($("#recordsToggle"), "recordsPanel");
$("#reportToggle").onclick = () =>
  togglePanel($("#reportToggle"), "reportPanel");
$("#menu").onclick = () => $("#sidebar").classList.toggle("open");
$("#send").onclick = () => sendMessage($("#input").value);
$("#input").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage($("#input").value);
  }
};
$("#projects").onchange = async (e) => {
  projectId = Number(e.target.value);
  await loadProjectData();
};
$("#newProject").onclick = async () => {
  const name = prompt("اسم المشروع؟");
  if (name?.trim()) {
    const result = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    projectId = result.project.id;
    await loadProjects();
  }
};
$("#deleteProject").onclick = async () => {
  if (!projectId) return;
  const selected = $("#projects").selectedOptions[0]?.textContent || "المشروع";
  if (!confirm(`حذف ${selected} وكل سجلاته؟ لا يمكن التراجع عن الحذف.`)) return;
  const button = $("#deleteProject"); button.disabled = true;
  try { await api(`/api/projects/${projectId}`, { method: "DELETE" }); projectId = null; conversationId = null; await loadProjects(); }
  catch (error) { $("#status").textContent = error.message; }
  finally { button.disabled = false; }
};
const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  $("#voice").onclick = () => {
    const recognition = new SpeechRecognition();
    recognition.lang = "ar-EG";
    recognition.interimResults = false;
    $("#status").textContent = "اتكلمي دلوقتي…";
    recognition.onresult = (e) =>
      sendMessage(e.results[0][0].transcript, "voice");
    recognition.onerror = () =>
      ($("#status").textContent = "الإملاء الصوتي مش متاح؛ اكتبي رسالتك.");
    recognition.start();
  };
} else $("#voice").disabled = true;
async function speakReply() {
  if (!lastReply || audioRunning) return;
  let context;
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) throw new Error("الصوت مش متاح في المتصفح.");
    context = audioContext = new Audio({ sampleRate: 24000 });
    await context.resume();
    audioStopped = false;
    audioSources = [];
    $("#playReply").disabled = true;
    $("#playReply").textContent = "⏳ بجهز الصوت…";
    const ticket = await api("/api/tts/ticket", {
      method: "POST",
      body: JSON.stringify({ text: lastReply }),
    });
    const response = await fetch(ticket.streamUrl);
    if (!response.ok) throw new Error("الصوت مش متاح دلوقتي.");
    const reader = response.body.getReader();
    let carry = new Uint8Array(0),
      scheduled = context.currentTime + 0.04,
      received = false;
    audioRunning = true;
    $("#pauseReply").hidden = false;
    $("#stopReply").hidden = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done || audioStopped) break;
      let bytes = value;
      if (carry.length) {
        const joined = new Uint8Array(carry.length + value.length);
        joined.set(carry);
        joined.set(value, carry.length);
        bytes = joined;
      }
      const usable = bytes.length - (bytes.length % 2);
      carry = bytes.slice(usable);
      if (!usable) continue;
      const buffer = context.createBuffer(1, usable / 2, 24000),
        channel = buffer.getChannelData(0);
      for (let i = 0; i < usable / 2; i++) {
        let sample = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
        if (sample >= 32768) sample -= 65536;
        channel[i] = sample / 32768;
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      scheduled = Math.max(scheduled, context.currentTime + 0.02);
      source.start(scheduled);
      audioSources.push(source);
      scheduled += buffer.duration;
      if (!received) {
        received = true;
        $("#status").textContent = "فهيمة بتقرأ الرد بصوت Gemini.";
      }
    }
    if (!received && !audioStopped) throw new Error("الصوت مش متاح دلوقتي.");
    if (!audioStopped)
      await new Promise((r) =>
        setTimeout(r, Math.max(0, (scheduled - context.currentTime) * 1000)),
      );
  } catch (error) {
    if (!audioStopped) $("#status").textContent = "الصوت مش متاح دلوقتي.";
  } finally {
    audioRunning = false;
    audioContext?.close();
    audioContext = null;
    audioSources = [];
    $("#playReply").disabled = false;
    $("#playReply").textContent = "🔊 اسمعي الرد";
    $("#pauseReply").hidden = true;
    $("#stopReply").hidden = true;
  }
}
$("#playReply").onclick = speakReply;
$("#pauseReply").onclick = async () => {
  if (!audioContext) return;
  if (audioContext.state === "running") {
    await audioContext.suspend();
    $("#pauseReply").textContent = "▶ استكملي";
  } else {
    await audioContext.resume();
    $("#pauseReply").textContent = "⏸ إيقاف مؤقت";
  }
};
$("#stopReply").onclick = () => {
  audioStopped = true;
  for (const source of audioSources)
    try {
      source.stop();
    } catch {}
  audioContext?.close();
};
$("#cancelTask").onclick = async () => {
  if (activeTaskId)
    await api(`/api/tasks/${activeTaskId}/cancel`, {
      method: "POST",
      body: JSON.stringify({ projectId }),
    });
};
function localToday() {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  return `${p.find((x) => x.type === "year").value}-${p.find((x) => x.type === "month").value}-${p.find((x) => x.type === "day").value}`;
}
const today = localToday();
$("#reportTo").value = today;
$("#reportFrom").value = `${today.slice(0, 8)}01`;
$("#loadReport").onclick = async () => {
  try {
    const report = await api(
      `/api/projects/${projectId}/report?from=${$("#reportFrom").value}&to=${$("#reportTo").value}`,
    );
    const labels = {
      income: "مبيعات",
      stock_cost: "مشتريات",
      operating_expense: "مصروفات",
      withdrawal: "مسحوبات",
    };
    const summary = report.summary || {};
    const reportLines = [
      `المبيعات: ${Number(summary.invoicedSales || 0).toLocaleString("ar-EG")} جنيه`,
      `المقبوض: ${Number(summary.cashCollected || 0).toLocaleString("ar-EG")} جنيه`,
      `لسه ليك عند الزباين: ${Number(summary.totalOutstanding || 0).toLocaleString("ar-EG")} جنيه`,
      ...(summary.cogsComplete === false ? ["تكلفة البضاعة المباعة: مش متاحة بالكامل."] : [`تكلفة البضاعة المباعة: ${Number(summary.cogs || 0).toLocaleString("ar-EG")} جنيه`]),
      ...(summary.grossProfit === null || summary.cogsComplete === false ? ["مجمل المكسب: مش ممكن يتحدد لسه لأن تكلفة بعض البضاعة مش معروفة."] : [`مجمل المكسب: ${Number(summary.grossProfit || 0).toLocaleString("ar-EG")} جنيه`]),
      ...(report.outsideRangeCount ? [`فيه ${report.outsideRangeCount} عملية خارج الفترة المختارة.`] : []),
      ...(report.outsideRangeCount && report.availableRange?.fromDate ? [`العمليات الموجودة من ${report.availableRange.fromDate} إلى ${report.availableRange.toDate}.`] : []),
      ...(Object.entries(report.totals)
        .map(
          ([type, v]) =>
            `${labels[type] || type}: ${Number(v.confirmed).toLocaleString("ar-EG")} جنيه`,
        )
        .join("\n") ? [] : ["مفيش معاملات مسجلة في الفترة دي."]),
    ];
    $("#report").textContent = reportLines.join("\n");
  } catch (e) {
    $("#report").textContent = e.message;
  }
};
$("#downloadReport").onclick = async () => {
  const from = $("#reportFrom").value, to = $("#reportTo").value;
  if (!from || !to || !projectId) { $("#report").textContent = "اختاري الفترة الأول."; return; }
  const button = $("#downloadReport"); button.disabled = true; button.textContent = "جاري التحميل…";
  try {
    const response = await fetch(`/api/projects/${projectId}/report.pdf?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    if (!response.ok) throw new Error("مش قادر أجهز التقرير دلوقتي.");
    const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = `fahima-report-${projectId}-${from}-${to}.pdf`; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000); $("#report").textContent = "التقرير اتحمل على جهازك.";
  } catch (e) { $("#report").textContent = e.message; } finally { button.disabled = false; button.textContent = "تحميل PDF"; }
};
loadProjects().catch((e) => {
  $("#status").textContent = e.message;
});
