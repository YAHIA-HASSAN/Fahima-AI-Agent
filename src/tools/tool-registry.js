const { FahimaError } = require('../shared/errors');

function validate(value, schema, path = 'input') {
  if (!schema || typeof schema !== 'object') throw new FahimaError('INVALID_SCHEMA', 'Tool schema is invalid.', 500);
  const fail = (message) => { throw new FahimaError('INVALID_TOOL_INPUT', `${path}: ${message}`); };
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected an object');
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
    for (const [key, child] of Object.entries(schema.properties || {})) if (Object.hasOwn(value, key)) validate(value[key], child, `${path}.${key}`);
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties || {}, key)) fail(`unknown field ${key}`);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength || 0) || value.length > (schema.maxLength || Infinity)) fail('invalid string');
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value)) || (schema.minimum != null && value < schema.minimum) || (schema.maximum != null && value > schema.maximum)) fail('invalid number');
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') fail('expected a boolean');
  else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > (schema.maxItems || Infinity)) fail('invalid array');
    value.forEach((item, i) => validate(item, schema.items, `${path}[${i}]`));
  }
  if (schema.enum && !schema.enum.includes(value)) fail('value is not allowed');
  return value;
}

function createToolRegistry() {
  const tools = new Map();
  return {
    register(tool) {
      if (!tool?.name || tools.has(tool.name) || typeof tool.execute !== 'function') throw new Error('Tool requires a unique name and execute function.');
      tools.set(tool.name, Object.freeze(tool));
      return this;
    },
    definitions() { return [...tools.values()].map(({ name, description, inputSchema }) => ({ name, description, parameters: inputSchema })); },
    async execute({ name, input, context }) {
      const tool = tools.get(name);
      if (!tool) return { status: 'failed', code: 'UNKNOWN_TOOL', error: `Unknown tool: ${name}` };
      try {
        validate(input, tool.inputSchema);
        if (tool.permission && !tool.permission(context, input)) throw new FahimaError('FORBIDDEN', 'Tool is not permitted in this project.', 403);
        const output = await tool.execute(input, context);
        if (output?.rejected) return { status: 'failed', code: 'OUTPUT_VALIDATION_FAILED', error: 'The requested output did not pass deterministic validation.', details: { ...(output.validation || { unsupportedPriceCount: output.unsupportedPriceCount || 0 }), nextAction: output.nextAction || null } };
        return { status: 'succeeded', output };
      } catch (error) {
        return { status: 'failed', code: error.code || 'TOOL_FAILED', error: String(error.message || 'Tool failed').slice(0, 500) };
      }
    },
    has(name) { return tools.has(name); },
  };
}

module.exports = { createToolRegistry, validate };
