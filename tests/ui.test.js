const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
test('conversation-first UI keeps plans compact and has progressive disclosure controls',()=>{
  const html=fs.readFileSync(path.join(root,'src/public/index.html'),'utf8');
  const css=fs.readFileSync(path.join(root,'src/public/style.css'),'utf8');
  const js=fs.readFileSync(path.join(root,'src/public/app.js'),'utf8');
  assert.match(html,/id="messages"/);assert.match(html,/id="input"/);assert.match(html,/id="voice"/);assert.match(html,/id="planToggle"/);assert.match(html,/id="planPanel"/);
  assert.match(css,/@media\(max-width:720px\)/);assert.match(css,/\.sidebar\.open/);assert.match(css,/\.collapsed/);
  assert.match(js,/planCard/);assert.match(js,/شوفي الخطة/);assert.match(js,/message\.plan/);
  assert.doesNotMatch(js,/speechSynthesis|SpeechSynthesisUtterance|getVoices/);
});
