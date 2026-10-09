const crypto = require('node:crypto');
const { GoogleGenAI } = require('@google/genai');

function createTtsService(config) {
  const tickets = new Map();
  function issue(text) {
    const clean = String(text || '').trim();
    if (!clean || clean.length > 3000) throw Object.assign(new Error('نص الصوت غير صالح.'), { status: 400 });
    if (!config.geminiApiKey) throw Object.assign(new Error('تحويل الصوت غير متاح حاليًا.'), { status: 503 });
    const now = Date.now();
    for (const [id, row] of tickets) if (row.expiresAt < now) tickets.delete(id);
    const id = crypto.randomUUID();
    tickets.set(id, { text: clean, expiresAt: now + 120000 });
    return id;
  }
  async function stream(id, req, res) {
    const ticket = tickets.get(id);
    if (!ticket || ticket.expiresAt < Date.now()) return res.status(404).json({ error: 'رابط الصوت انتهى. اطلبي سماعه مرة تانية.' });
    tickets.delete(id);
    let started = false;
    try {
      const ai = new GoogleGenAI({ apiKey: config.geminiApiKey, httpOptions: { timeout: config.ttsTimeoutMs, retryOptions: { attempts: 1 } } });
      const response = await ai.interactions.create({
        model: config.ttsModel,
        input: [{ type: 'user_input', content: [{ type: 'text', text: ticket.text, annotations: [{ type: 'speech_metadata', style: 'Speak in a warm, natural Egyptian Arabic feminine voice. Read the text verbatim.' }] }] }],
        response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 },
        generation_config: { speech_config: [{ voice: 'Aoede' }] }, stream: true,
      }, { timeout: config.ttsTimeoutMs });
      for await (const event of response) {
        if (req.destroyed) return;
        const audio = event?.delta?.type === 'audio' && event.delta.data ? Buffer.from(event.delta.data, 'base64') : null;
        if (!audio?.length) continue;
        if (!started) { started = true; res.status(200).set({ 'Content-Type': 'audio/l16; rate=24000; channels=1', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' }); res.flushHeaders(); }
        if (!res.write(audio)) await new Promise(resolve => res.once('drain', resolve));
      }
      if (!started) throw Object.assign(new Error('Gemini returned no audio.'), { code: 'EMPTY_AUDIO' });
      res.end();
    } catch (error) {
      const status = Number(error.status || error.statusCode || error.response?.status || 0);
      const timeout = error.code === 23 || error.code === 'TTS_TIMEOUT' || error.name === 'TimeoutError';
      console.error('TTS stream failed:', error.code || error.name || 'Error', status || '');
      if (res.headersSent) return res.destroy(error);
      return res.status(status === 429 ? 429 : timeout ? 504 : 503).json({ error: status === 429 ? 'صوت Gemini غير متاح مؤقتًا؛ الرد المكتوب موجود.' : timeout ? 'الصوت اتأخر؛ الرد المكتوب موجود.' : 'تعذر تجهيز صوت الرد؛ الرد المكتوب موجود.' });
    }
  }
  return { issue, stream };
}
module.exports = { createTtsService };
