function buildPromptContext(context) {
  return JSON.stringify({
    currentProject: context.memory.project,
    savedFacts: context.memory.facts,
    projectGoals: context.memory.goals,
    knownInventory: context.memory.inventory,
    activePlan: compactPlan(context.memory.plans[0]),
    recentConversation: context.memory.messages,
    recentTasks: context.memory.tasks,
    activeTasks: context.memory.activeTasks,
    priorDecisions: context.memory.previousDecisions.slice(0, 4),
    savedResearch: context.memory.research.slice(0, 5).map(row => ({ query:row.query,url:row.source_url,retrievedAt:row.retrieved_at,title:row.result?.title,price:row.result?.price,snippet:String(row.result?.snippet||'').slice(0,180) })),
    recentFinancialRecords: context.memory.transactions,
    currentTask: { id: context.task.id, objective: context.task.objective },
    currentUserMessage: context.message,
    cairoDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
  });
}
function compactPlan(saved) {
  if(!saved)return null;
  const body=saved.body||{};
  return {revision:saved.revision,quality_status:saved.quality_status,body:{objective:body.objective,assumptions:(body.assumptions||[]).slice(0,8),steps:(body.steps||[]).slice(0,12),risks:(body.risks||[]).slice(0,8),missingInformation:(body.missingInformation||[]).slice(0,8),budget:body.budget?{capital:body.budget.capital,total:body.budget.total,reserve:body.budget.reserve,remaining:body.budget.remaining,items:(body.budget.items||[]).slice(0,12)}:null,prices:(body.prices||[]).slice(0,10),sources:(body.sources||[]).slice(0,8)}};
}
module.exports = { buildPromptContext };
