import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app=express(),dev=process.argv.includes('--dev'),root=path.dirname(fileURLToPath(import.meta.url));
const required=['NMI_PRIVATE_KEY','NMI_TOKENIZATION_KEY','APP_SECRET'];
const missing=required.filter(k=>!process.env[k]);
if(missing.length) console.warn(`Missing ${missing.join(', ')}. Copy .env.example to .env before processing payments.`);
app.use(express.json({limit:'30kb'}));

const key=crypto.createHash('sha256').update(process.env.APP_SECRET||'development-only-not-for-production').digest();
function seal(value){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64url')}
function open(value){try{const raw=Buffer.from(value,'base64url'),iv=raw.subarray(0,12),tag=raw.subarray(12,28),data=raw.subarray(28),dec=crypto.createDecipheriv('aes-256-gcm',key,iv);dec.setAuthTag(tag);return JSON.parse(Buffer.concat([dec.update(data),dec.final()]).toString())}catch{return null}}
function cookies(req){return Object.fromEntries((req.headers.cookie||'').split(';').filter(Boolean).map(v=>{const i=v.indexOf('=');return [v.slice(0,i).trim(),decodeURIComponent(v.slice(i+1))]}))}
function setOrder(res,data){res.setHeader('Set-Cookie',`gemify_order=${seal(data)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7200${process.env.NODE_ENV==='production'?'; Secure':''}`)}
function getOrder(req){return open(cookies(req).gemify_order||'')}
function clean(v,n=180){return String(v||'').trim().slice(0,n)}
function orderId(prefix='DPS'){return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`}
async function nmi(params){if(!process.env.NMI_PRIVATE_KEY)throw new Error('Gateway is not configured');const body=new URLSearchParams({security_key:process.env.NMI_PRIVATE_KEY,...params});const response=await fetch(`${process.env.NMI_BASE_URL||'https://secure.nmi.com'}/api/transact.php`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});if(!response.ok)throw new Error(`Gateway HTTP ${response.status}`);return Object.fromEntries(new URLSearchParams(await response.text()))}
function gatewayError(data){return clean(data.responsetext||data.response_text||'Payment was declined. Please verify your information.',250)}

app.get('/api/config',(req,res)=>res.json({tokenizationKey:process.env.NMI_TOKENIZATION_KEY||'',configured:missing.length===0}));
app.post('/api/checkout',async(req,res)=>{try{const {paymentToken,bump,customer={}}=req.body||{};if(!paymentToken)return res.status(400).json({ok:false,error:'Payment token is required.'});const amount=bump?'44.00':'27.00',oid=orderId();const names=clean(customer.name,100).split(/\s+/);const data=await nmi({type:'sale',amount,payment_token:clean(paymentToken,500),customer_vault:'add_customer',orderid:oid,order_description:bump?'Daily Profits System + Trade Vault':'Daily Profits System',firstname:names.shift()||'',lastname:names.join(' '),email:clean(customer.email),phone:clean(customer.phone,30),address1:clean(customer.address),city:clean(customer.city,80),state:clean(customer.state,50),zip:clean(customer.zip,20),country:'US',initiated_by:'customer',stored_credential_indicator:'stored'});if(data.response!=='1')return res.status(402).json({ok:false,error:gatewayError(data)});if(!data.customer_vault_id)return res.status(502).json({ok:false,error:'Payment approved but no vault ID was returned. Contact support.'});setOrder(res,{vaultId:data.customer_vault_id,initialTransactionId:data.transactionid,email:clean(customer.email),bump:!!bump,created:Date.now()});res.json({ok:true,transactionId:data.transactionid,orderId:oid})}catch(e){console.error('checkout',e.message);res.status(500).json({ok:false,error:'Unable to process the payment. Please try again.'})}});
app.post('/api/upsell',async(req,res)=>{try{const order=getOrder(req);if(!order||Date.now()-order.created>72e5)return res.status(401).json({ok:false,error:'Your secure order session expired.'});if(order.powerHour)return res.status(409).json({ok:false,error:'This upgrade was already processed.'});const data=await nmi({type:'sale',amount:'197.00',customer_vault_id:order.vaultId,orderid:orderId('TPH'),order_description:'Trading Power Hour',initiated_by:'customer',stored_credential_indicator:'used',initial_transaction_id:order.initialTransactionId});if(data.response!=='1')return res.status(402).json({ok:false,error:gatewayError(data)});setOrder(res,{...order,powerHour:true,upgradeTransactionId:data.transactionid});res.json({ok:true,transactionId:data.transactionid})}catch(e){console.error('upsell',e.message);res.status(500).json({ok:false,error:'Unable to process the upgrade.'})}});
app.post('/api/payment-plan',async(req,res)=>{try{const order=getOrder(req);if(!order||Date.now()-order.created>72e5)return res.status(401).json({ok:false,error:'Your secure order session expired.'});if(order.plan)return res.status(409).json({ok:false,error:'This payment plan was already created.'});const start=new Date();start.setUTCDate(start.getUTCDate()+30);const startDate=start.toISOString().slice(0,10).replaceAll('-','');const data=await nmi({type:'sale',amount:'66.00',customer_vault_id:order.vaultId,orderid:orderId('TPHPLAN'),order_description:'Trading Power Hour Payment Plan',initiated_by:'customer',stored_credential_indicator:'used',initial_transaction_id:order.initialTransactionId,recurring:'add_subscription',plan_amount:'66.00',plan_payments:'2',day_frequency:'30',start_date:startDate});if(data.response!=='1')return res.status(402).json({ok:false,error:gatewayError(data)});setOrder(res,{...order,plan:true,planTransactionId:data.transactionid,subscriptionId:data.subscription_id||''});res.json({ok:true,transactionId:data.transactionid,subscriptionId:data.subscription_id||''})}catch(e){console.error('plan',e.message);res.status(500).json({ok:false,error:'Unable to create the payment plan.'})}});
app.get('/api/order',(req,res)=>{const o=getOrder(req);if(!o)return res.json({ok:false});res.json({ok:true,email:o.email,bump:!!o.bump,powerHour:!!o.powerHour,plan:!!o.plan})});

if(!process.env.VERCEL){
  if(dev){const {createServer}=await import('vite');const vite=await createServer({server:{middlewareMode:true},appType:'spa'});app.use(vite.middlewares)}
  else{app.use(express.static(path.join(root,'dist')));app.get('*path',(req,res)=>res.sendFile(path.join(root,'dist','index.html')))}
  app.listen(Number(process.env.PORT)||5173,()=>console.log(`Gemify funnel running at http://localhost:${process.env.PORT||5173}`));
}

export default app;
