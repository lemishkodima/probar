// Server-side delivery. Credentials stay in Vercel Environment Variables.
const REQUEST_TIMEOUT_MS = 10000;

function optionalText(value, maxLength = 255) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, maxLength);
}

function bitrixMethodUrl(webhookUrl) {
  const url = new URL(webhookUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid_bitrix_webhook');
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  url.pathname += 'crm.item.add.json';
  return url.toString();
}

async function sendTelegram({ token, chatId, name, phone, submittedAt }) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `Нова B2B-заявка — Oatly × ProBar\n\nІм’я: ${name}\nТелефон: ${phone}\n\nДжерело: лендинг Oatly × ProBar\nЧас: ${submittedAt} (Київ)`,
      link_preview_options: { is_disabled: true }
    })
  });
  if (!response.ok) throw new Error('telegram_rejected');
  const result = await response.json();
  if (result.ok !== true || !result.result?.message_id) throw new Error('telegram_rejected');
  return { provider: 'telegram', id: result.result.message_id };
}

async function sendBitrixLead({ webhookUrl, assignedById, name, phone, utm }) {
  const fields = {
    title: 'Заявка із сайту — Oatly Barista Edition',
    name,
    stageId: 'NEW',
    sourceId: 'WEB',
    sourceDescription: 'Лендинг Oatly × ProBar',
    comments: 'Продукт: Oatly Barista Edition\nЦіна: 1 040 грн / ящик\nМінімальне замовлення: 1 ящик (6 × 1 л)',
    currencyId: 'UAH',
    opportunity: 1040,
    isManualOpportunity: 'Y',
    fm: [{ typeId: 'PHONE', valueType: 'WORK', value: phone }],
    ...(utm.utmSource ? { utmSource: utm.utmSource } : {}),
    ...(utm.utmMedium ? { utmMedium: utm.utmMedium } : {}),
    ...(utm.utmCampaign ? { utmCampaign: utm.utmCampaign } : {}),
    ...(utm.utmContent ? { utmContent: utm.utmContent } : {}),
    ...(utm.utmTerm ? { utmTerm: utm.utmTerm } : {}),
    ...(assignedById ? { assignedById } : {})
  };
  const response = await fetch(bitrixMethodUrl(webhookUrl), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ entityTypeId: 1, fields })
  });
  if (!response.ok) throw new Error('bitrix_rejected');
  const result = await response.json();
  const leadId = result?.result?.item?.id;
  if (result.error || !leadId) throw new Error('bitrix_rejected');
  return { provider: 'bitrix24', id: leadId };
}

async function sendGenericWebhook({ url, token, name, phone }) {
  if (new URL(url).protocol !== 'https:') throw new Error('invalid_webhook');
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ name, phone, source: 'Oatly × ProBar landing', submittedAt: new Date().toISOString() })
  });
  if (!response.ok) throw new Error('webhook_rejected');
  return { provider: 'webhook' };
}

async function sendEmail({ apiKey, to, from, name, phone }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to: [to], subject: 'Нова B2B-заявка — Oatly × ProBar',
      text: `Ім’я: ${name}\nТелефон: ${phone}\nДжерело: Oatly × ProBar landing`
    })
  });
  if (!response.ok) throw new Error('email_rejected');
  return { provider: 'email' };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return res.status(403).json({ ok: false });
    } catch { return res.status(403).json({ ok: false }); }
  }
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    return res.status(415).json({ ok: false });
  }
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    if (JSON.stringify(body).length > 4096) return res.status(413).json({ ok: false });
  } catch { return res.status(400).json({ ok: false }); }
  if (body.website) return res.status(200).json({ ok: true }); // Honeypot: no delivery.

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const digits = phone.replace(/\D/g, '');
  if (name.length < 2 || name.length > 100 || /[\r\n\x00-\x1f]/.test(name) ||
      phone.length > 25 || !/^[+0-9() .\-]+$/.test(phone) || digits.length < 10 || digits.length > 15) {
    return res.status(400).json({ ok: false, error: 'invalid_fields' });
  }

  const {
    TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
    BITRIX24_WEBHOOK_URL, BITRIX24_ASSIGNED_BY_ID,
    LEAD_WEBHOOK_URL, LEAD_WEBHOOK_TOKEN,
    RESEND_API_KEY, LEAD_EMAIL_TO, LEAD_EMAIL_FROM
  } = process.env;
  const telegramConfigured = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
  if ((TELEGRAM_BOT_TOKEN || TELEGRAM_CHAT_ID) && !telegramConfigured) {
    return res.status(503).json({ ok: false, error: 'delivery_not_configured' });
  }
  let assignedById;
  if (BITRIX24_ASSIGNED_BY_ID) {
    assignedById = Number(BITRIX24_ASSIGNED_BY_ID);
    if (!Number.isInteger(assignedById) || assignedById < 1) {
      return res.status(503).json({ ok: false, error: 'delivery_not_configured' });
    }
  }
  if (BITRIX24_WEBHOOK_URL) {
    try { bitrixMethodUrl(BITRIX24_WEBHOOK_URL); }
    catch { return res.status(503).json({ ok: false, error: 'delivery_not_configured' }); }
  }

  const submittedAt = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv', dateStyle: 'short', timeStyle: 'short'
  }).format(new Date());
  const utm = {
    utmSource: optionalText(body.utmSource),
    utmMedium: optionalText(body.utmMedium),
    utmCampaign: optionalText(body.utmCampaign),
    utmContent: optionalText(body.utmContent),
    utmTerm: optionalText(body.utmTerm)
  };
  const deliveries = [];
  if (telegramConfigured) {
    deliveries.push(sendTelegram({ token: TELEGRAM_BOT_TOKEN, chatId: TELEGRAM_CHAT_ID, name, phone, submittedAt }));
  }
  if (BITRIX24_WEBHOOK_URL) {
    deliveries.push(sendBitrixLead({ webhookUrl: BITRIX24_WEBHOOK_URL, assignedById, name, phone, utm }));
  }
  // Legacy fallbacks remain available only when Telegram and Bitrix24 are not configured.
  if (!telegramConfigured && !BITRIX24_WEBHOOK_URL && LEAD_WEBHOOK_URL) {
    deliveries.push(sendGenericWebhook({ url: LEAD_WEBHOOK_URL, token: LEAD_WEBHOOK_TOKEN, name, phone }));
  } else if (!telegramConfigured && !BITRIX24_WEBHOOK_URL && RESEND_API_KEY && LEAD_EMAIL_TO && LEAD_EMAIL_FROM) {
    deliveries.push(sendEmail({ apiKey: RESEND_API_KEY, to: LEAD_EMAIL_TO, from: LEAD_EMAIL_FROM, name, phone }));
  }
  if (!deliveries.length) return res.status(503).json({ ok: false, error: 'delivery_not_configured' });

  try {
    const delivered = await Promise.all(deliveries);
    return res.status(200).json({ ok: true, delivered: delivered.map(item => item.provider) });
  } catch {
    // Do not log personal data or provider credentials.
    return res.status(502).json({ ok: false, error: 'delivery_failed' });
  }
}
