import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/lead.js';

const keys = [
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID',
  'BITRIX24_WEBHOOK_URL', 'BITRIX24_ASSIGNED_BY_ID',
  'LEAD_WEBHOOK_URL', 'LEAD_WEBHOOK_TOKEN',
  'RESEND_API_KEY', 'LEAD_EMAIL_TO', 'LEAD_EMAIL_FROM'
];
const valid = { name: 'Тест', phone: '+380671234567', website: '' };

async function call({ method = 'POST', body = valid, headers = {} } = {}) {
  const res = {
    code: 200, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.code = code; return this; },
    json(value) { this.body = value; return this; }
  };
  await handler({ method, body, headers: { host: 'example.test', 'content-type': 'application/json', ...headers } }, res);
  return res;
}

function clearDeliveryEnv() {
  for (const key of keys) delete process.env[key];
}

test('Lead delivery contract', async t => {
  const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const key of keys) env[key] === undefined ? delete process.env[key] : process.env[key] = env[key];
  });

  clearDeliveryEnv();
  await t.test('rejects unsupported method', async () => assert.equal((await call({ method: 'GET' })).code, 405));
  await t.test('rejects malformed JSON', async () => assert.equal((await call({ body: '{' })).code, 400));
  await t.test('rejects foreign origin', async () => assert.equal((await call({ headers: { origin: 'https://foreign.test' } })).code, 403));
  await t.test('rejects invalid phone', async () => assert.equal((await call({ body: { ...valid, phone: '123' } })).code, 400));
  await t.test('missing delivery settings never reports success', async () => assert.equal((await call()).code, 503));
  await t.test('honeypot never calls a provider', async () => {
    globalThis.fetch = () => { throw new Error('must not send'); };
    assert.equal((await call({ body: { ...valid, website: 'spam' } })).code, 200);
  });

  await t.test('generic webhook remains a fallback', async () => {
    clearDeliveryEnv();
    process.env.LEAD_WEBHOOK_URL = 'https://crm.example.test/leads';
    globalThis.fetch = async (url, options) => {
      assert.equal(url, process.env.LEAD_WEBHOOK_URL);
      assert.equal(JSON.parse(options.body).phone, valid.phone);
      return { ok: true };
    };
    assert.deepEqual((await call()).body, { ok: true, delivered: ['webhook'] });
  });
  await t.test('fallback provider rejection and timeout are visible', async () => {
    globalThis.fetch = async () => ({ ok: false });
    assert.equal((await call()).code, 502);
    globalThis.fetch = async () => { throw new Error('timeout'); };
    assert.equal((await call()).code, 502);
  });

  await t.test('email remains a fallback', async () => {
    clearDeliveryEnv();
    Object.assign(process.env, {
      RESEND_API_KEY: 'test-key', LEAD_EMAIL_TO: 'test@example.test', LEAD_EMAIL_FROM: 'site@example.test'
    });
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://api.resend.com/emails');
      const body = JSON.parse(options.body);
      assert.deepEqual(body.to, ['test@example.test']);
      assert.ok(body.text.includes(valid.phone));
      return { ok: true };
    };
    assert.deepEqual((await call()).body, { ok: true, delivered: ['email'] });
  });

  await t.test('partial Telegram configuration fails', async () => {
    clearDeliveryEnv();
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
    assert.equal((await call()).code, 503);
  });
  await t.test('Telegram sends plain text to the configured channel', async () => {
    clearDeliveryEnv();
    Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 'test-bot-token', TELEGRAM_CHAT_ID: '-1004305846803' });
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://api.telegram.org/bottest-bot-token/sendMessage');
      const body = JSON.parse(options.body);
      assert.equal(body.chat_id, '-1004305846803');
      assert.ok(body.text.includes('Ім’я: <Тест & ім’я>'));
      assert.equal(body.parse_mode, undefined);
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 123 } }) };
    };
    assert.deepEqual((await call({ body: { ...valid, name: '<Тест & ім’я>' } })).body, { ok: true, delivered: ['telegram'] });
  });
  await t.test('Telegram API error body does not report success', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: false, description: 'Forbidden' }) });
    assert.equal((await call()).code, 502);
  });

  await t.test('invalid Bitrix24 configuration fails before delivery', async () => {
    clearDeliveryEnv();
    process.env.BITRIX24_WEBHOOK_URL = 'http://portal.example.test/rest/1/secret/';
    assert.equal((await call()).code, 503);
    process.env.BITRIX24_WEBHOOK_URL = 'https://portal.example.test/rest/1/secret/';
    process.env.BITRIX24_ASSIGNED_BY_ID = 'not-a-number';
    assert.equal((await call()).code, 503);
  });
  await t.test('Bitrix24 creates a Classic CRM lead with source, price, phone and UTM fields', async () => {
    clearDeliveryEnv();
    Object.assign(process.env, {
      BITRIX24_WEBHOOK_URL: 'https://portal.bitrix24.com/rest/7/secret/', BITRIX24_ASSIGNED_BY_ID: '42'
    });
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://portal.bitrix24.com/rest/7/secret/crm.item.add.json');
      const body = JSON.parse(options.body);
      assert.equal(body.entityTypeId, 1);
      assert.equal(body.fields.stageId, 'NEW');
      assert.equal(body.fields.sourceId, 'WEB');
      assert.equal(body.fields.sourceDescription, 'Лендинг Oatly × ProBar');
      assert.equal(body.fields.opportunity, 1040);
      assert.equal(body.fields.assignedById, 42);
      assert.deepEqual(body.fields.fm, [{ typeId: 'PHONE', valueType: 'WORK', value: valid.phone }]);
      assert.equal(body.fields.utmSource, 'google ads');
      return { ok: true, json: async () => ({ result: { item: { id: 777 } } }) };
    };
    const response = await call({ body: { ...valid, utmSource: 'google\nads' } });
    assert.deepEqual(response.body, { ok: true, delivered: ['bitrix24'] });
  });

  await t.test('Telegram and Bitrix24 receive the same submission in parallel', async () => {
    clearDeliveryEnv();
    Object.assign(process.env, {
      TELEGRAM_BOT_TOKEN: 'test-bot-token', TELEGRAM_CHAT_ID: '-1004305846803',
      BITRIX24_WEBHOOK_URL: 'https://portal.bitrix24.com/rest/7/secret/'
    });
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (url.includes('api.telegram.org')) {
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 123 } }) };
      }
      return { ok: true, json: async () => ({ result: { item: { id: 777 } } }) };
    };
    const response = await call();
    assert.deepEqual(response.body, { ok: true, delivered: ['telegram', 'bitrix24'] });
    assert.equal(calls.length, 2);
    assert.ok(calls.some(item => item.url.includes('api.telegram.org')));
    assert.ok(calls.some(item => item.url.endsWith('/crm.item.add.json')));
  });
  await t.test('a rejection from either parallel destination returns a visible failure', async () => {
    globalThis.fetch = async url => {
      if (url.includes('api.telegram.org')) {
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 123 } }) };
      }
      return { ok: true, json: async () => ({ error: 'ACCESS_DENIED' }) };
    };
    assert.equal((await call()).code, 502);
  });
});
