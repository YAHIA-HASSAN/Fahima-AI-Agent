function validateValue(value,schema,path='input') {
  const types=Array.isArray(schema.type)?schema.type:[schema.type];
  const actual=value===null?'null':Array.isArray(value)?'array':Number.isInteger(value)?'integer':typeof value;
  if(!types.includes(actual)&&!(actual==='integer'&&types.includes('number')))throw new TypeError(`${path} has an invalid type.`);
  if(schema.enum&&!schema.enum.includes(value))throw new TypeError(`${path} is not an allowed value.`);
  if((actual==='number'||actual==='integer')&&(!Number.isFinite(value)||schema.minimum!=null&&value<schema.minimum||schema.maximum!=null&&value>schema.maximum))throw new TypeError(`${path} is outside the allowed range.`);
  if(actual==='string'&&(schema.minLength!=null&&value.length<schema.minLength||schema.maxLength!=null&&value.length>schema.maxLength))throw new TypeError(`${path} has an invalid length.`);
  if(actual==='array') {
    if(schema.maxItems!=null&&value.length>schema.maxItems)throw new TypeError(`${path} has too many items.`);
    if(schema.items)value.forEach((item,index)=>validateValue(item,schema.items,`${path}[${index}]`));
  }
  if(actual==='object') {
    for(const key of schema.required||[])if(!Object.hasOwn(value,key))throw new TypeError(`${path}.${key} is required.`);
    for(const [key,item] of Object.entries(value)) {
      const child=schema.properties?.[key];
      if(!child){if(schema.additionalProperties===false)throw new TypeError(`${path}.${key} is not allowed.`);continue;}
      validateValue(item,child,`${path}.${key}`);
    }
  }
  return value;
}

function createToolRegistry({projectId}) {
  const scope=Number(projectId),definitions=new Map();
  if(!Number.isSafeInteger(scope)||scope<1)throw new Error('A server-selected project scope is required.');
  function register(definition) {
    if(!definition||!/^[a-z][a-z0-9_]{1,63}$/u.test(definition.name)||definitions.has(definition.name))throw new Error('Tool definition is invalid or duplicated.');
    if(typeof definition.execute!=='function'||!definition.inputSchema||!definition.outputSchema||typeof definition.description!=='string')throw new Error('Tool definition is incomplete.');
    definitions.set(definition.name,Object.freeze({...definition,inputSchema:structuredClone(definition.inputSchema),outputSchema:structuredClone(definition.outputSchema),projectId:scope}));
    return api;
  }
  function execute(name,input={},context={}) {
    const tool=definitions.get(name);
    if(!tool)return {tool:name,status:'rejected',output:null,error:{code:'UNKNOWN_TOOL'}};
    const success=output=>{validateValue(output,tool.outputSchema,'output');return {tool:name,status:'succeeded',output:output??null};};
    const failure=error=>({tool:name,status:'failed',output:null,error:{code:String(error?.code||'TOOL_EXECUTION_FAILED'),message:String(error?.message||'Tool execution failed.').slice(0,240)}});
    try {
      validateValue(input,tool.inputSchema);
      if(tool.authorize&&!tool.authorize({projectId:scope,input,context}))return {tool:name,status:'rejected',output:null,error:{code:'UNAUTHORIZED'}};
      const output=tool.execute(input,{projectId:scope,context});
      return output&&typeof output.then==='function'?Promise.resolve(output).then(success).catch(failure):success(output);
    } catch(error) {return failure(error);}
  }
  const api={projectId:scope,register,execute,describe:()=>[...definitions.values()].map(({name,description,inputSchema,outputSchema})=>({name,description,inputSchema:structuredClone(inputSchema),outputSchema:structuredClone(outputSchema)}))};
  return api;
}

module.exports={createToolRegistry,validateValue};
