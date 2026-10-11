const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
test('conversation-first UI exposes business records and reports without a plan panel',()=>{
  const html=fs.readFileSync(path.join(root,'src/public/index.html'),'utf8');
  const css=fs.readFileSync(path.join(root,'src/public/style.css'),'utf8');
  const js=fs.readFileSync(path.join(root,'src/public/app.js'),'utf8');
  assert.match(html,/id="messages"/);assert.match(html,/id="input"/);assert.match(html,/id="voice"/);assert.doesNotMatch(html,/id="planToggle"/);assert.doesNotMatch(html,/id="planPanel"/);
  assert.match(css,/@media\(max-width:720px\)/);assert.match(css,/\.sidebar\.open/);assert.match(css,/\.collapsed/);
  assert.doesNotMatch(js,/planCard/);assert.doesNotMatch(js,/message\.plan/);assert.match(js,/renderSidebarRecords/);
  assert.match(html,/id="downloadReport"/);assert.match(html,/id="deleteProject"/);assert.match(js,/URL\.createObjectURL/);assert.match(js,/download = `fahima-report/);assert.match(js,/DELETE/);
  assert.doesNotMatch(js,/speechSynthesis|SpeechSynthesisUtterance|getVoices/);
});
