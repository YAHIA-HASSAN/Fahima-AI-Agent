const {EventEmitter}=require('node:events');
const path=require('node:path');
require('dotenv').config({path:path.resolve(__dirname,'../.env')});
const {loadConfig}=require('../src/shared/config');
const {createTtsService}=require('../src/voice/tts');
async function main(){
  const config=loadConfig();
  if(!config.geminiApiKey){console.log(JSON.stringify({status:'SKIPPED',reason:'Gemini credentials are unavailable.'}));return;}
  const tts=createTtsService(config),id=tts.issue('فهيمة معاك.');
  const req=new EventEmitter();req.destroyed=false;
  const res={headersSent:false,statusCode:200,chunks:[],status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;},set(){return this;},flushHeaders(){this.headersSent=true;},write(bytes){this.chunks.push(Buffer.from(bytes));return true;},end(){this.ended=true;},destroy(error){this.error=error;}};
  const started=Date.now();await tts.stream(id,req,res);
  const bytes=Buffer.concat(res.chunks);
  console.log(JSON.stringify({component:'gemini_tts_stream',status:res.statusCode===200&&bytes.length?'VERIFIED':'FAILED',httpStatus:res.statusCode,firstAudioMs:res.chunks.length?Date.now()-started:null,chunks:res.chunks.length,bytes:bytes.length,model:config.ttsModel,streamEnded:res.ended===true,failure:res.body?.error||res.error?.code||null}));
  if(res.statusCode!==200||!bytes.length)process.exitCode=1;
}
main().catch(error=>{console.log(JSON.stringify({component:'gemini_tts_stream',status:'FAILED',code:error.code||error.name,message:String(error.message||'').slice(0,200)}));process.exitCode=1;});
