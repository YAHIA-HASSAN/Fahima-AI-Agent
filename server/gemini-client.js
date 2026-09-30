function createGeminiClient(config, options = {}) {
  if (!config.geminiApiKey) {
    const error = new Error('Gemini API key is not configured.');
    error.code = 'GEMINI_NOT_CONFIGURED';
    throw error;
  }
  const GoogleGenAI = options.GoogleGenAI || require('@google/genai').GoogleGenAI;
  return new GoogleGenAI({
    apiKey: config.geminiApiKey,
    httpOptions: {
      timeout: options.timeoutMs || config.geminiTimeoutMs || 30000,
      retryOptions: { attempts: 1 },
    },
  });
}

module.exports = { createGeminiClient };
