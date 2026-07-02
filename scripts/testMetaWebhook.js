import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const {
  META_VERIFY_TOKEN,
  META_PAGE_ACCESS_TOKEN,
  META_GRAPH_API_VERSION = 'v21.0',
  PUBLIC_API_URL = 'https://groquik-crm-backend.onrender.com',
} = process.env;

async function graph(pathname, token = META_PAGE_ACCESS_TOKEN, options = {}) {
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}${pathname}`);
  if (options.method !== 'POST' || !options.body) {
    url.searchParams.set('access_token', token);
  }
  const res = await fetch(url, {
    method: options.method || 'GET',
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function fail(step, message, hints = []) {
  console.error(`${step}: FAIL — ${message}`);
  hints.forEach((line) => console.error(`   ${line}`));
  process.exit(1);
}

async function resolvePageContext() {
  const me = await graph('/me?fields=id,name');
  if (!me.ok) {
    fail('2. Token check', me.data?.error?.message || 'invalid token');
  }

  const formsProbe = await graph(`/${me.data.id}/leadgen_forms?limit=1`);
  if (formsProbe.ok) {
    return { pageId: me.data.id, pageName: me.data.name, pageToken: META_PAGE_ACCESS_TOKEN };
  }

  const accounts = await graph('/me/accounts?fields=id,name,access_token');
  const pages = accounts.data?.data || [];

  if (accounts.ok && pages.length) {
    console.log(`2. Token type: USER token (${me.data.name}) — not a Page token`);
    console.log('   Your Facebook Pages:');
    pages.forEach((p) => console.log(`   - ${p.name} (id ${p.id})`));
    fail('2. Page token required', 'META_PAGE_ACCESS_TOKEN must be a Page access token', [
      'Graph API Explorer → Get Token → Get Page Access Token',
      'Select your Facebook Page (not your personal profile)',
      'Permissions: leads_retrieval, pages_manage_metadata',
      'Copy into .env and Render as META_PAGE_ACCESS_TOKEN',
    ]);
  }

  fail('2. Page token check', formsProbe.data?.error?.message || 'cannot access leadgen_forms for this token', [
    'Use a Page access token for the Page that owns your Lead Ads forms',
    'Graph API Explorer → Get Token → Get Page Access Token',
  ]);
}

async function main() {
  console.log('Meta integration test\n');

  if (!META_PAGE_ACCESS_TOKEN?.trim()) {
    fail('Setup', 'META_PAGE_ACCESS_TOKEN is missing in .env');
  }

  const verifyUrl = `${PUBLIC_API_URL.replace(/\/$/, '')}/api/meta/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(META_VERIFY_TOKEN)}&hub.challenge=crm_test_ok`;
  const verifyRes = await fetch(verifyUrl);
  const verifyBody = await verifyRes.text();
  console.log(`1. Render webhook verify: ${verifyRes.status === 200 && verifyBody === 'crm_test_ok' ? 'OK' : 'FAIL'} (${verifyRes.status})`);

  const { pageId, pageName, pageToken } = await resolvePageContext();
  console.log(`2. Page token valid: OK (${pageName}, page id ${pageId})`);

  const subs = await graph(`/${pageId}/subscribed_apps`, pageToken);
  const apps = subs.data?.data || [];
  const hasLeadgen = apps.some((a) => (a.subscribed_fields || []).includes('leadgen'));
  console.log(`3. Page subscribed_apps: ${hasLeadgen ? 'OK (leadgen found)' : 'MISSING leadgen — subscribing now...'}`);

  if (!hasLeadgen) {
    const subUrl = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${pageId}/subscribed_apps`);
    subUrl.searchParams.set('subscribed_fields', 'leadgen');
    subUrl.searchParams.set('access_token', pageToken);
    const subRes = await fetch(subUrl, { method: 'POST' });
    const subData = await subRes.json().catch(() => ({}));
    if (!subRes.ok) {
      fail('3. Subscribe page to leadgen', subData?.error?.message || subRes.statusText, [
        'Token needs pages_manage_metadata permission',
        'Regenerate Page access token with leads_retrieval + pages_manage_metadata',
      ]);
    }
    console.log('   Subscribed page to leadgen: OK');
  }

  const forms = await graph(`/${pageId}/leadgen_forms?fields=id,name,status`, pageToken);
  const formList = forms.data?.data || [];
  if (!forms.ok) {
    fail('4. Lead forms', forms.data?.error?.message || 'could not list forms', [
      'Confirm this Page has Instant Forms / Lead Ads',
      'Token needs leads_retrieval permission',
    ]);
  }
  if (!formList.length) {
    console.log('4. Lead forms: none on this Page — create one in Meta Instant Forms first');
    process.exit(0);
  }
  console.log(`4. Lead forms: ${formList.length} found`);
  formList.forEach((f) => console.log(`   - ${f.name} (${f.id})`));

  const formId = formList[0].id;
  const formName = formList[0].name;

  const existing = await graph(`/${formId}/test_leads?fields=id,created_time`, pageToken);
  const existingLeads = existing.data?.data || [];
  if (existingLeads.length) {
    console.log(`5. Existing test lead on "${formName}": deleting ${existingLeads.length}...`);
    for (const lead of existingLeads) {
      const delUrl = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${lead.id}`);
      delUrl.searchParams.set('access_token', pageToken);
      await fetch(delUrl, { method: 'DELETE' });
    }
  }

  const createUrl = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${formId}/test_leads`);
  const body = new URLSearchParams();
  body.set('access_token', pageToken);
  body.set(
    'field_data',
    JSON.stringify([
      { name: 'full_name', values: ['Groquik Test Lead'] },
      { name: 'phone_number', values: ['9876501234'] },
      { name: 'company_name', values: ['Test Jewellers Kochi'] },
    ]),
  );

  const createRes = await fetch(createUrl, { method: 'POST', body });
  const createData = await createRes.json().catch(() => ({}));
  if (!createRes.ok) {
    fail(`5. Create test lead on "${formName}"`, createData?.error?.message || createRes.statusText);
  }
  console.log(`5. Create test lead on "${formName}": OK (lead id ${createData.id})`);
  console.log('\nMeta should POST to your webhook within a few seconds.');
  console.log('Check CRM → Leads for source META, phone 9876501234.');
  console.log('Check Render logs for POST /api/meta/webhook');
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
