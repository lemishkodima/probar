const video = document.querySelector('.hero-video video');
const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
function syncVideo() {
  if (!video) return;
  if (motion.matches || navigator.connection?.saveData || document.hidden) video.pause();
  else { video.muted = true; video.play().catch(() => {}); }
}
motion.addEventListener('change', syncVideo);
document.addEventListener('visibilitychange', syncVideo);
syncVideo();

const form = document.querySelector('#lead-form');
const status = document.querySelector('#form-status');
const button = form.querySelector('button[type="submit"]');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (button.disabled || !form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form));
  const search = new URLSearchParams(window.location.search);
  for (const [field, parameter] of Object.entries({
    utmSource: 'utm_source', utmMedium: 'utm_medium', utmCampaign: 'utm_campaign',
    utmContent: 'utm_content', utmTerm: 'utm_term'
  })) {
    const value = search.get(parameter);
    if (value) data[field] = value.slice(0, 255);
  }
  if (data.phone.replace(/\D/g, '').length < 10) {
    status.dataset.state = 'error';
    status.textContent = 'Перевірте номер телефону: введіть щонайменше 10 цифр.';
    form.elements.phone.focus();
    return;
  }
  button.disabled = true;
  button.textContent = 'Надсилаємо…';
  status.dataset.state = 'pending';
  status.textContent = '';
  try {
    const response = await fetch('/api/lead', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data), signal: AbortSignal.timeout(15000)
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new Error('delivery-failed');
    status.dataset.state = 'success';
    status.textContent = 'Дякуємо! Заявку отримано. Менеджер зв’яжеться з вами у робочий час.';
    form.reset();
  } catch {
    status.dataset.state = 'error';
    status.textContent = 'Не вдалося підтвердити надсилання. Спробуйте ще раз або зателефонуйте: 0 800 60 60 60.';
  } finally {
    button.disabled = false;
    button.textContent = 'Отримати пропозицію →';
  }
});
