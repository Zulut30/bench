import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { checkText, maintenanceCheck, practicalText } from '../src/checks.js';
import { loadConfig } from '../src/connections/config.js';
import { pilotSuite } from '../src/pilot.js';
import { projectRoot } from '../src/runner.js';
import { executeSandbox } from '../src/sandbox.js';

const config = loadConfig(join(projectRoot, 'configs/pilot-mock.json'));
config.profile = 'standard';
const architectureTask = pilotSuite(config).tasks.find(t => t.primaryCategory === 'architecture')!;

describe('Объективные проверки принимают эквивалентные формы ответа', () => {
  it('редактура допускает Markdown-заголовок, сохраняя число пунктов и факты', () => {
    const notes = '# Версия 1.4.0\n\n- Добавлен экспорт в CSV.\n- Исправлен сброс фильтра при обновлении страницы.\n- На бесплатном тарифе можно экспортировать до 500 строк.';
    expect(checkText('release-notes', notes).pass).toBe(true);
    expect(checkText('release-notes', notes.replace('500', '5000')).pass).toBe(false);
    expect(checkText('release-notes', notes + '\n- Дополнительный пункт.').pass).toBe(false);
  });

  it('перевод допускает оба распространённых порядка даты, но не другую дату', () => {
    const translated = 'Scheduled maintenance on October 12, 2026, from 02:00 to 02:30 UTC. CSV export will be unavailable during the infrastructure update. All other features continue to work. Support: help@example.test.';
    expect(checkText('translation-en', translated).pass).toBe(true);
    expect(checkText('translation-en', translated.replace('October 12, 2026', '12 October 2026')).pass).toBe(true);
    expect(checkText('translation-en', translated.replace('October 12', 'October 13')).pass).toBe(false);
    expect(checkText('translation-en', translated.replace('02:30', '02:45')).pass).toBe(false);
    expect(checkText('translation-en', translated.replace('unavailable', 'available')).pass).toBe(false);
  });

  it('уведомление сохраняет ту же дату, написанную словами, без изменения ограничений', () => {
    const notice = 'Плановые работы\n\n12 октября 2026 года с 02:00 до 02:30 UTC пройдёт обновление инфраструктуры. В это время будет недоступен только экспорт CSV. Остальные функции продолжат работать. По вопросам о плановых работах обращайтесь в поддержку: help@example.test.';
    expect(maintenanceCheck(notice)).toMatchObject({ pass: true, semanticStatus: 'pending' });
    expect(maintenanceCheck(notice.replace('12 октября', '13 октября')).pass).toBe(false);
    expect(maintenanceCheck(notice.replace('Остальные функции продолжат работать', 'Остальные функции не будут работать')).pass).toBe(false);
  });

  it('архитектура допускает вложенные поля JSON: их типы не ограничены заданием', () => {
    const answer = { storage: { engine: 'PostgreSQL' }, queue: { type: 'SQL outbox в той же транзакции с заказом' },
      idempotency: { key: 'eventId' }, retries: { max_attempts: 3, exhausted: 'dead_letter' },
      backup: { schedule: 'Ежедневный backup', verification: 'Проверка восстановления' },
      rationale: ['Существующая SQL база уменьшает объём поддержки для двух инженеров.'] };
    expect(practicalText(architectureTask, JSON.stringify(answer)).pass).toBe(true);
    expect(practicalText(architectureTask, JSON.stringify({ ...answer, queue: 'Таблица SQL и отдельный worker', idempotency: { key: 'event_id' } })).pass).toBe(true);
    expect(practicalText(architectureTask, JSON.stringify({ ...answer, retries: 'После третьей попытки — dead letter',
      backup: 'Ежедневный backup. Регулярно восстанавливать копию в изолированную базу.' })).pass).toBe(true);
    expect(practicalText(architectureTask, JSON.stringify({ ...answer, retries: 'После тринадцатой попытки — dead letter' })).pass).toBe(false);
    expect(practicalText(architectureTask, JSON.stringify({ ...answer, storage: { engine: 'MongoDB' } })).pass).toBe(false);
    expect(practicalText(architectureTask, JSON.stringify({ ...answer, idempotency: { key: 'orderId' } })).pass).toBe(false);
    expect(practicalText(architectureTask, JSON.stringify({ ...answer, retries: { max_attempts: 4, exhausted: 'dead_letter' } })).pass).toBe(false);
    expect(practicalText(architectureTask, JSON.stringify({ ...answer, backup: null })).pass).toBe(false);
  });

  it('дизайн допускает цены в отдельных span и переносы, но отвергает изменённую цену', async () => {
    const html = (business: string) => '<!doctype html><html lang="ru"><head><meta charset="UTF-8"><link rel="stylesheet" href="styles.css"></head><body>'
      + [['Старт', '0'], ['Команда', '990'], ['Бизнес', business]].map(([name, price]) => `<article><h2>${name}</h2><p><span>${price}</span><span>₽</span></p><button>Выбрать</button></article>`).join('')
      + '</body></html>';
    const files = (price: string) => [{ path: 'index.html', content: html(price) }, { path: 'styles.css', content: '.price span{display:inline-block} body{margin:0} article{max-width:100%}' }];
    const good = await executeSandbox('ui-design', files('2990'), config.sandbox, 20000);
    expect(good.results.every(r => r.pass), JSON.stringify(good.results)).toBe(true);
    const links = files('2990').map(f => f.path === 'index.html' ? { ...f, content: f.content.replaceAll('<button>', '<a href="#choose">').replaceAll('</button>', '</a>') } : f);
    expect((await executeSandbox('ui-design', links, config.sandbox, 20000)).results.every(r => r.pass)).toBe(true);
    const bad = await executeSandbox('ui-design', files('2991'), config.sandbox, 20000);
    expect(bad.results.filter(r => r.id.startsWith('design-content')).every(r => !r.pass)).toBe(true);
  });

  it('не штрафует нативную HTML-валидацию за неоговорённое требование точки в домене', async () => {
    const files = [
      { path: 'index.html', content: '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="styles.css"></head><body><form novalidate><label for="email">Email</label><input type="email" id="email" required><button>Подписаться</button><p role="status" id="message"></p></form><script type="module" src="app.js"></script></body></html>' },
      { path: 'styles.css', content: 'body{margin:8px} input{max-width:100%}' },
      { path: 'app.ts', content: `const form = document.querySelector<HTMLFormElement>('form')!;
const email = document.querySelector<HTMLInputElement>('#email')!;
const message = document.querySelector<HTMLElement>('#message')!;
form.addEventListener('submit', event => { event.preventDefault();
  if (!email.value) message.textContent = 'Введите email';
  else if (!email.validity.valid) message.textContent = 'Некорректный email';
  else { message.textContent = 'Спасибо'; email.value = ''; }
});` },
    ];
    const good = await executeSandbox('frontend', files, config.sandbox, 20000);
    expect(good.results.every(r => r.pass), JSON.stringify(good.results)).toBe(true);
    const bad = await executeSandbox('frontend', files.map(f => f.path === 'app.ts'
      ? { ...f, content: f.content.replace('!email.validity.valid', 'false') } : f), config.sandbox, 20000);
    expect(bad.results.some(r => !r.pass && r.id.startsWith('invalid'))).toBe(true);
  });
});
