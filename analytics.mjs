import { neon } from '@neondatabase/serverless';

const connection=process.env.DATABASE_URL||process.env.POSTGRES_URL;
const sql=connection?neon(connection):null;
let ready;

export function initAnalytics(){
  if(!sql)return Promise.resolve(false);
  if(!ready)ready=(async()=>{
    await sql`CREATE TABLE IF NOT EXISTS leads (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      first_name TEXT DEFAULT '', last_name TEXT DEFAULT '', phone TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'optin', source TEXT DEFAULT 'funnel', campaign TEXT DEFAULT '',
      landing_page TEXT DEFAULT '/', consent_email BOOLEAN DEFAULT TRUE, consent_sms BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS funnel_events (
      id BIGSERIAL PRIMARY KEY, lead_id BIGINT REFERENCES leads(id) ON DELETE SET NULL,
      email TEXT DEFAULT '', name TEXT DEFAULT '', phone TEXT DEFAULT '', event_type TEXT NOT NULL,
      product TEXT DEFAULT '', amount NUMERIC(12,2) NOT NULL DEFAULT 0, status TEXT DEFAULT '',
      transaction_id TEXT DEFAULT '', order_id TEXT DEFAULT '', gateway_response TEXT DEFAULT '',
      session_id TEXT DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS funnel_events_created_idx ON funnel_events(created_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS funnel_events_email_idx ON funnel_events(email)`;
    return true;
  })();
  return ready;
}

export async function upsertLead(data={}){
  if(!sql||!data.email)return null;
  await initAnalytics();
  const email=String(data.email).trim().toLowerCase();
  const rows=await sql`INSERT INTO leads(email,first_name,last_name,phone,status,source,campaign,landing_page,consent_email,consent_sms)
    VALUES(${email},${data.firstName||''},${data.lastName||''},${data.phone||''},${data.status||'optin'},${data.source||'funnel'},${data.campaign||''},${data.landingPage||'/'},${data.consentEmail!==false},${!!data.consentSms})
    ON CONFLICT(email) DO UPDATE SET first_name=COALESCE(NULLIF(EXCLUDED.first_name,''),leads.first_name),last_name=COALESCE(NULLIF(EXCLUDED.last_name,''),leads.last_name),phone=COALESCE(NULLIF(EXCLUDED.phone,''),leads.phone),status=EXCLUDED.status,updated_at=NOW()
    RETURNING *`;
  return rows[0];
}

export async function trackEvent(data={}){
  if(!sql)return null;
  await initAnalytics();
  let lead=null;
  if(data.email)lead=await upsertLead({email:data.email,firstName:data.firstName,lastName:data.lastName,phone:data.phone,status:data.eventType==='sale'?'buyer':data.status||'optin',source:data.source,campaign:data.campaign,landingPage:data.landingPage});
  const rows=await sql`INSERT INTO funnel_events(lead_id,email,name,phone,event_type,product,amount,status,transaction_id,order_id,gateway_response,session_id)
    VALUES(${lead?.id||null},${data.email||''},${data.name||''},${data.phone||''},${data.eventType||'event'},${data.product||''},${Number(data.amount)||0},${data.status||''},${data.transactionId||''},${data.orderId||''},${data.gatewayResponse||''},${data.sessionId||''}) RETURNING id`;
  return rows[0];
}

export async function dashboardData(search=''){
  if(!sql)return {stats:{},activity:[],leads:[],buyers:[]};
  await initAnalytics();
  const q=`%${String(search).trim().toLowerCase()}%`;
  const [stats]=await sql`SELECT
    (SELECT COUNT(*)::int FROM leads) total_optins,
    (SELECT COUNT(*)::int FROM leads WHERE status='buyer') buyers,
    COALESCE((SELECT SUM(amount) FROM funnel_events WHERE event_type='sale' AND status='approved'),0)::float revenue,
    (SELECT COUNT(*)::int FROM funnel_events WHERE event_type='payment_attempt') payment_attempts,
    (SELECT COUNT(*)::int FROM funnel_events WHERE event_type='decline') declined,
    (SELECT COUNT(*)::int FROM funnel_events WHERE event_type='error') system_errors,
    (SELECT COUNT(*)::int FROM funnel_events WHERE event_type='page_view') page_views`;
  stats.lead_to_buyer_rate=stats.total_optins?Number(((stats.buyers/stats.total_optins)*100).toFixed(1)):0;
  const activity=await sql`SELECT name,email,phone,product,amount::float,status,transaction_id,gateway_response,created_at FROM funnel_events WHERE event_type IN ('payment_attempt','sale','decline','error') ORDER BY created_at DESC LIMIT 100`;
  const leads=await sql`SELECT * FROM leads WHERE ${!search} OR LOWER(email||' '||first_name||' '||last_name||' '||phone) LIKE ${q} ORDER BY created_at DESC LIMIT 250`;
  const buyers=await sql`SELECT l.id,l.first_name,l.last_name,l.email,l.phone,COUNT(e.id)::int purchases,STRING_AGG(DISTINCT e.product,', ') products,COALESCE(SUM(e.amount),0)::float gross_sales,0::float refunds,COALESCE(SUM(e.amount),0)::float net_sales,MAX(e.created_at) last_purchase FROM leads l JOIN funnel_events e ON e.lead_id=l.id AND e.event_type='sale' AND e.status='approved' WHERE ${!search} OR LOWER(l.email||' '||l.first_name||' '||l.last_name||' '||l.phone) LIKE ${q} GROUP BY l.id ORDER BY last_purchase DESC LIMIT 250`;
  return {stats,activity,leads,buyers};
}

export async function exportLeads(){if(!sql)return[];await initAnalytics();return sql`SELECT first_name,last_name,email,phone,status,source,campaign,landing_page,consent_email,consent_sms,created_at FROM leads ORDER BY created_at DESC`}
