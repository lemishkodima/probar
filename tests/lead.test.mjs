import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/lead.js';
const keys=['TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','LEAD_WEBHOOK_URL','LEAD_WEBHOOK_TOKEN','RESEND_API_KEY','LEAD_EMAIL_TO','LEAD_EMAIL_FROM'];
const valid={ name:'Тест', phone:'+380671234567', website:'' };
async function call({method='POST',body=valid,headers={}}={}) {
 const res={code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(c){this.code=c;return this;},json(v){this.body=v;return this;}};
 await handler({method,body,headers:{host:'example.test','content-type':'application/json',...headers}},res);
 return res;
}
test('Lead delivery contract', async t=>{
 const env=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 const originalFetch=globalThis.fetch;
 t.after(()=>{globalThis.fetch=originalFetch;for(const k of keys) env[k]===undefined?delete process.env[k]:process.env[k]=env[k];});
 for(const k of keys) delete process.env[k];
 await t.test('rejects unsupported method',async()=>assert.equal((await call({method:'GET'})).code,405));
 await t.test('rejects malformed JSON',async()=>assert.equal((await call({body:'{'})).code,400));
 await t.test('rejects foreign origin',async()=>assert.equal((await call({headers:{origin:'https://foreign.test'}})).code,403));
 await t.test('rejects invalid phone',async()=>assert.equal((await call({body:{...valid,phone:'123'}})).code,400));
 await t.test('missing delivery settings never reports success',async()=>assert.equal((await call()).code,503));
 await t.test('honeypot never calls provider',async()=>{
  globalThis.fetch=()=>{throw new Error('must not send');};
  assert.equal((await call({body:{...valid,website:'spam'}})).code,200);
 });
 process.env.LEAD_WEBHOOK_URL='https://crm.example.test/leads';
 await t.test('webhook receives fields and success waits for acceptance',async()=>{
  globalThis.fetch=async(url,opts)=>{assert.equal(url,process.env.LEAD_WEBHOOK_URL);assert.equal(JSON.parse(opts.body).phone,valid.phone);return {ok:true};};
  assert.deepEqual((await call()).body,{ok:true});
 });
 await t.test('provider rejection is visible failure',async()=>{globalThis.fetch=async()=>({ok:false});assert.equal((await call()).code,502);});
 await t.test('network failure is visible failure',async()=>{globalThis.fetch=async()=>{throw new Error('timeout');};assert.equal((await call()).code,502);});
 delete process.env.LEAD_WEBHOOK_URL;
 Object.assign(process.env,{RESEND_API_KEY:'test-key',LEAD_EMAIL_TO:'test@example.test',LEAD_EMAIL_FROM:'site@example.test'});
 await t.test('email path uses configured recipient and plain text',async()=>{
  globalThis.fetch=async(url,opts)=>{assert.equal(url,'https://api.resend.com/emails');const body=JSON.parse(opts.body);assert.deepEqual(body.to,['test@example.test']);assert.ok(body.text.includes(valid.phone));return {ok:true};};
  assert.equal((await call()).code,200);
 });
 process.env.TELEGRAM_BOT_TOKEN='test-bot-token';
 await t.test('partial Telegram configuration fails without falling through to email',async()=>assert.equal((await call()).code,503));
 process.env.TELEGRAM_CHAT_ID='-1004305846803';
 await t.test('Telegram takes priority and sends plain text to the configured channel',async()=>{
  globalThis.fetch=async(url,opts)=>{
   assert.equal(url,'https://api.telegram.org/bottest-bot-token/sendMessage');
   const body=JSON.parse(opts.body);
   assert.equal(body.chat_id,'-1004305846803');
   assert.ok(body.text.includes(valid.phone));
   assert.ok(body.text.includes('Ім’я: <Тест & ім’я>'));
   assert.equal(body.parse_mode,undefined);
   return {ok:true,json:async()=>({ok:true,result:{message_id:123}})};
  };
  assert.equal((await call({body:{...valid,name:'<Тест & ім’я>'}})).code,200);
 });
 await t.test('Telegram API error body must not report delivery success',async()=>{
  globalThis.fetch=async()=>({ok:true,json:async()=>({ok:false,description:'Forbidden'})});
  assert.equal((await call()).code,502);
 });
 await t.test('Telegram HTTP rejection and timeout do not fall through to another provider',async()=>{
  let calls=0;
  globalThis.fetch=async()=>{calls++;return {ok:false};};
  assert.equal((await call()).code,502);assert.equal(calls,1);
  globalThis.fetch=async()=>{throw new Error('timeout');};
  assert.equal((await call()).code,502);
 });

});
