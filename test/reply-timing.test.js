const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function browserFunction(name, endMarker, globals) {
  const start = source.indexOf(`function ${name}(`);
  const prefix = source.slice(start - 6, start) === 'async ' ? 'async ' : '';
  return vm.runInNewContext(`${prefix}${source.slice(start, source.indexOf(endMarker, start))}\n${name};`, globals);
}

test('final speech sends before recognition ends, once per recording', async () => {
  const calls = [];
  const status = {};
  const globals = {
    SpeechRecognitionApi: class { stop() { this.stopped = true; } },
    finalTranscript: '', speechFeedback: '',
    $: () => status, setVoiceMode: () => {},
    sendMessage: async (text, type) => { calls.push({ text, type }); return true; },
    addMessage: () => ({ classList: { add() {} } }),
  };
  const create = browserFunction('createRecognition', 'recordButton.addEventListener', globals);
  const finalResult = Object.assign([{ transcript: 'أيوه' }], { isFinal: true });
  const event = { resultIndex: 0, results: [finalResult] };
  const first = create();
  first.onresult(event);
  assert.deepEqual(calls, [{ text: 'أيوه', type: 'voice' }]);
  assert.equal(first.stopped, true);
  first.onresult(event);
  first.onend();
  assert.equal(calls.length, 1);
  await Promise.resolve();
  // A separate confirmation must not be discarded by a time-based filter.
  const second = create();
  second.onresult(event);
  second.onend();
  assert.equal(calls.length, 2);
});

test('interim speech is not submitted', () => {
  let sends = 0;
  const create = browserFunction('createRecognition', 'recordButton.addEventListener', {
    SpeechRecognitionApi: class { stop() {} }, finalTranscript: '', speechFeedback: '',
    $: () => ({}), setVoiceMode: () => {},
    sendMessage: async () => { sends++; }, addMessage: () => ({ classList: { add() {} } }),
  });
  const recognition = create();
  recognition.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'اشتريت' }], { isFinal: false })] });
  recognition.onend();
  assert.equal(sends, 0);
});

test('ready reply starts audio without waiting for report generation', async () => {
  const events = [];
  const send = browserFunction('sendMessage', '$("#message-form").addEventListener', {
    replyBusy: false, state: { project: { id: 1 } }, conversation: { conversation: { id: 1 } },
    setReplyBusy: () => {}, addMessage: () => ({ remove() {}, classList: { add() {} } }),
    api: async () => ({ reply: 'التقرير جاهز', kind: 'report', period: { from: '2026-10-01', to: '2026-10-01' } }),
    lastReplyText: '', playReplyButton: {},
    playReplyWithGemini: () => { events.push('audio'); return new Promise(() => {}); },
    downloadReport: () => { events.push('report'); return new Promise(() => {}); },
  });
  assert.equal(await send('التقرير'), true);
  assert.deepEqual(events, ['audio', 'report']);
});

test('empty database prompts project creation and never requests a fixed project ID', async () => {
  const requests = [];
  const elements = new Map();
  const messages = [];
  const globals = {
    state: null, conversation: null, lastReplyText: '', playReplyButton: {},
    localStorage: { getItem: () => '1', removeItem() {} },
    $: selector => {
      if (!elements.has(selector)) elements.set(selector, { replaceChildren() {} });
      return elements.get(selector);
    },
    api: async route => { requests.push(route); return { projects: [] }; },
    addMessage: text => messages.push(text), setReplyBusy() {},
  };
  await browserFunction('load', 'function renderFacts', globals)();
  assert.deepEqual(requests, ['/api/projects']);
  assert.equal(globals.state, null);
  assert.equal(elements.get('#report').disabled, true);
  assert.match(messages[0], /مشروع جديد/);
});
