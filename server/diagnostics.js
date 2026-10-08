function diagnostic(event, details={}) {
  if(process.env.NODE_ENV==='test'||process.env.FAHIMA_DIAGNOSTICS==='0')return;
  const safe={};
  for(const [key,value] of Object.entries(details)) {
    if(value==null||['string','number','boolean'].includes(typeof value))safe[key]=typeof value==='string'?value.slice(0,160):value;
  }
  console.info(JSON.stringify({component:'fahima',event,at:new Date().toISOString(),...safe}));
}

module.exports={diagnostic};
