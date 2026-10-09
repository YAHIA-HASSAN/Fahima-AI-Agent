function createGeminiModel(config, options = {}) {
  if (!config.geminiApiKey) throw Object.assign(new Error('إعداد Gemini غير متوفر.'), { code: 'GEMINI_NOT_CONFIGURED' });
  const GoogleGenAI = options.GoogleGenAI || require('@google/genai').GoogleGenAI;
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey, httpOptions: { timeout: options.timeoutMs || 30000, retryOptions: { attempts: 1 } } });
  return {
    async decide({ system, contents, tools }) {
      const response = await ai.models.generateContent({
        model: config.geminiModel,
        contents,
        config: {
          systemInstruction: system,
          tools: [{ functionDeclarations: tools }],
          toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
          temperature: 0.25,
        },
      });
      return { candidate: response.candidates?.[0]?.content || null, text: response.text || '', usage: response.usageMetadata || null };
    },
  };
}
module.exports = { createGeminiModel };
