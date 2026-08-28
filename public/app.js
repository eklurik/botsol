const messages = document.getElementById('messages');
const form = document.getElementById('form');
const text = document.getElementById('text');
let lastRequest = '';
const conversation = [];
const INACTIVITY_MS = 5 * 60 * 1000;
let inactivityTimer;
let selectedRating = 0;
let chatClosed = false;

const faqContent = {
  finish: ['Как завершить поездку', 'Проверьте в приложении, что вы остановились в разрешённой зоне, припаркуйте транспорт и нажмите «Завершить поездку». Дождитесь подтверждения.', 'Я не могу завершить поездку. Подскажите, что делать.'],
  payment: ['Оплата и возврат', 'Если вы не согласны со списанием, напишите сумму, время поездки и что произошло. Мы проверим операцию и передадим финансовый вопрос менеджеру.', 'Я хочу вернуть деньги за поездку. Помогите проверить списание.'],
  vehicle: ['Транспорт не едет', 'Остановитесь в безопасном месте и не продолжайте поездку на неисправном транспорте. Опишите проблему, чтобы мы передали её в техническую службу.', 'Транспорт не едет. Помогите разобраться с поездкой.'],
  unlock: ['Замок не открылся', 'Проверьте интернет-соединение и не повторяйте разблокировку много раз. Если деньги списались, напишите об этом: мы проверим платёж и состояние замка.', 'Замок не открылся, но с меня списали деньги.']
};

document.querySelectorAll('.faq-quick').forEach((button) => {
  button.addEventListener('click', () => { text.value = button.dataset.text; form.requestSubmit(); });
});

document.querySelectorAll('.faq-tab').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.faq-tab').forEach((tab) => tab.classList.toggle('active', tab === button));
    const [title, description, question] = faqContent[button.dataset.faq];
    document.getElementById('faq-instruction').innerHTML = `<strong>${title}</strong><p>${description}</p><button class="faq-ask" data-text="${question}">Задать этот вопрос в чате <span>↗</span></button>`;
    document.querySelector('.faq-ask').addEventListener('click', (event) => { text.value = event.currentTarget.dataset.text; form.requestSubmit(); });
  });
});

document.querySelector('.faq-ask').addEventListener('click', (event) => { text.value = event.currentTarget.dataset.text; form.requestSubmit(); });

function resetInactivityTimer() {
  clearTimeout(inactivityTimer);
  if (!chatClosed) inactivityTimer = setTimeout(closeChat, INACTIVITY_MS);
}

function closeChat() {
  if (chatClosed) return;
  chatClosed = true;
  addMessage('Похоже, вы больше не нуждаетесь в помощи. Я закрываю чат. Оцените, пожалуйста, консультацию и напишите, что можно улучшить.', 'agent');
  form.querySelector('textarea').disabled = true;
  form.querySelector('.send').disabled = true;
  document.getElementById('feedback').hidden = false;
}

document.querySelectorAll('[data-rating]').forEach((button) => {
  button.addEventListener('click', () => {
    selectedRating = Number(button.dataset.rating);
    document.querySelectorAll('[data-rating]').forEach((item) => item.classList.toggle('selected', item === button));
    document.getElementById('feedback-send').disabled = false;
  });
});

document.getElementById('feedback-send').addEventListener('click', () => {
  const status = document.getElementById('feedback-status');
  status.textContent = `Спасибо за оценку ${selectedRating}/5${document.getElementById('feedback-text').value.trim() ? '.' : '!'}`;
  document.getElementById('feedback-send').disabled = true;
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = text.value.trim();
  if (!value) return;
  if (chatClosed) return;
  resetInactivityTimer();
  lastRequest = value;
  conversation.push({ role: 'user', content: value });
  addMessage(value, 'client');
  text.value = '';
  const send = form.querySelector('.send');
  send.disabled = true;
  addMessage('Проверяю информацию...', 'typing');
  try {
    const response = await fetch('/api/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: value, conversation }) });
    const data = await response.json();
    document.querySelector('.typing')?.remove();
    if (!response.ok) throw new Error(data.error || 'Не удалось отправить сообщение');
    addMessage(data.reply, 'agent', data);
    conversation.push({ role: 'assistant', content: data.reply });
  } catch (error) {
    document.querySelector('.typing')?.remove();
    addMessage(error.message.includes('Failed to fetch') ? 'Чат временно не подключён к серверу. Запустите приложение командой npm start и обновите страницу.' : error.message, 'error');
  } finally { send.disabled = false; text.focus(); }
});

resetInactivityTimer();

text.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
});

function addMessage(value, type, data = null) {
  const item = document.createElement('div');
  item.className = `message ${type}`;
  if (type === 'client') item.innerHTML = `<div><p>${escapeHtml(value)}</p><time>сейчас</time></div>`;
  else if (type === 'typing') item.innerHTML = '<span class="avatar">B</span><div><p class="dots">● ● ●</p></div>';
  else item.innerHTML = `<span class="avatar">B</span><div><p>${escapeHtml(value)}</p>${data?.managerAction ? `<button class="manager" data-request="${escapeHtml(lastRequest)}">${escapeHtml(data.managerAction)}</button>` : ''}<time>${data?.source === 'llm' ? 'служба поддержки' : 'сейчас'}</time></div>`;
  messages.appendChild(item);
  messages.scrollTop = messages.scrollHeight;
  item.querySelector('.manager')?.addEventListener('click', sendManagerRequest);
}

async function sendManagerRequest(event) {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Отправляю менеджеру...';
  try {
    const response = await fetch('/api/manager-request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: button.dataset.request }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Ошибка отправки');
    button.remove();
    addMessage(data.message, 'agent');
  } catch (error) { button.disabled = false; button.textContent = 'Повторить запрос менеджеру'; addMessage(error.message, 'error'); }
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char])); }
