// Server-side delivery. Credentials stay in Vercel Environment Variables.
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
    if (JSON.stringify(body).length > 2048) return res.status(413).json({ ok: false });
  } catch { return res.status(400).json({ ok: false }); }
  if (body.website) return res.status(200).json({ ok: true }); // Honeypot: no delivery.
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const digits = phone.replace(/\D/g, '');
  if (name.length < 2 || name.length > 100 || /[\r\n\x00-\x1f]/.test(name) ||
      phone.length > 25 || !/^[+0-9() .\-]+$/.test(phone) || digits.length < 10 || digits.length > 15) {
    return res.status(400).json({ ok: false, error: 'invalid_fields' });
  }
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, LEAD_WEBHOOK_URL, LEAD_WEBHOOK_TOKEN, RESEND_API_KEY, LEAD_EMAIL_TO, LEAD_EMAIL_FROM } = process.env;
  const telegramConfigured = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
  if ((TELEGRAM_BOT_TOKEN || TELEGRAM_CHAT_ID) && !telegramConfigured) {
    return res.status(503).json({ ok: false, error: 'delivery_not_configured' });
  }
  if (!telegramConfigured && !LEAD_WEBHOOK_URL && !(RESEND_API_KEY && LEAD_EMAIL_TO && LEAD_EMAIL_FROM)) {
    return res.status(503).json({ ok: false, error: 'delivery_not_configured' });
  }
  try {
    let response;
    if (telegramConfigured) {
      const submittedAt = new Intl.DateTimeFormat('uk-UA', {
        timeZone: 'Europe/Kyiv', dateStyle: 'short', timeStyle: 'short'
      }).format(new Date());
      response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: `Нова B2B-заявка — Oatly × ProBar\n\nІм’я: ${name}\nТелефон: ${phone}\n\nДжерело: лендинг Oatly × ProBar\nЧас: ${submittedAt} (Київ)`,
          link_preview_options: { is_disabled: true }
        })
      });
      if (!response.ok) throw new Error('telegram_rejected');
      const result = await response.json();
      if (result.ok !== true || !result.result?.message_id) throw new Error('telegram_rejected');
    } else if (LEAD_WEBHOOK_URL) {
      if (new URL(LEAD_WEBHOOK_URL).protocol !== 'https:') throw new Error('invalid_webhook');
      response = await fetch(LEAD_WEBHOOK_URL, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', ...(LEAD_WEBHOOK_TOKEN ? { Authorization: `Bearer ${LEAD_WEBHOOK_TOKEN}` } : {}) },
        body: JSON.stringify({ name, phone, source: 'Oatly × ProBar landing', submittedAt: new Date().toISOString() })
      });
    } else {
      response = await fetch('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: LEAD_EMAIL_FROM, to: [LEAD_EMAIL_TO], subject: 'Нова B2B-заявка — Oatly × ProBar',
          text: `Ім’я: ${name}\nТелефон: ${phone}\nДжерело: Oatly × ProBar landing`
        })
      });
    }
    if (!response.ok) throw new Error('provider_rejected');
    return res.status(200).json({ ok: true });
  } catch {
    // Do not log personal data or provider credentials.
    return res.status(502).json({ ok: false, error: 'delivery_failed' });
  }
}
