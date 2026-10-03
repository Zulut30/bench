import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { z } from 'zod';
import type { Task } from './schema.js';
import type { Assessment, AttemptStatus, CheckResult } from './types.js';

const htmlTasks = new Set(['contact-form', 'faq-disclosure', 'pricing-layout', 'dashboard-layout']);
export function isHtmlTask(task: Task): boolean { return htmlTasks.has(task.id); }

export function safeHtml(output: string): boolean {
  return output.length <= 200_000 && /^(?:<!doctype html[^>]*>\s*)?<html[\s>]/i.test(output.trim())
    && !/```|<(?:script|iframe|object|embed|base|link|svg|math)\b|\bon[a-z]+\s*=|javascript\s*:|http-equiv\s*=\s*["']?refresh|\b(?:src|href|action)\s*=\s*["']?(?:https?:|\/\/|file:)|@import\b/i.test(output);
}

function formatCheck(task: Task, output: string): boolean {
  if (isHtmlTask(task)) return safeHtml(output);
  if (['pagination', 'validation-error'].includes(task.id)) {
    try { const parsed: unknown = JSON.parse(output); return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed); } catch { return false; }
  }
  return output.trim().length > 0 && !output.includes('```');
}

const numericTokens = (value: string) => value.match(/\d+(?:[.:]\d+)*/g) ?? [];
const onlyNumbers = (output: string, allowed: string[]) => numericTokens(output).every((n) => allowed.includes(n));

export function maintenanceCheck(output: string): { pass: boolean; reason: string; semanticStatus: 'pending' | 'contradiction' } {
  const words = output.trim().split(/\s+/).length;
  const objective = /^Плановые работы\s*\n/u.test(output) && words >= 35 && words <= 80
    && ['12.10.2026', '02:00', '02:30', 'UTC', 'CSV', 'help@example.test'].every((s) => output.includes(s))
    && onlyNumbers(output, ['12.10.2026', '02:00', '02:30', '30']);
  // Это детектор явных противоречий, а не доказательство сохранения смысла.
  const clauses = output.toLowerCase().split(/[.!?\n]|(?<!\p{L})(?:но|однако)(?!\p{L})/u);
  const contradiction = clauses.some((clause) =>
    (/(?:остальн\S*|друг\S*|все)\s+(?:функци\S*|возможност\S*|сервис\S*)/u.test(clause)
      || /остальн\S*\s+функци\S*/iu.test(output) && /^\s*(?:они|эти функции)(?!\p{L})/u.test(clause))
      && /(?<!\p{L})не\s+(?:будут\s+|продолжат\s+)?работ|недоступ|отключ|перестан\S*\s+работ|прекрат\S*\s+работ/u.test(clause)
      && !/не\s+(?:перестан\S*\s+работ|прекрат\S*\s+работ)|не\s+будут\s+(?:недоступ|отключ)/u.test(clause)
    || /экспорт\s+csv/u.test(clause) && /(?:будет|оста[её]тся|полностью)\s+доступен|не\s+(?:будет\s+)?(?:недоступен|отключ[её]н)/u.test(clause));
  return { pass: objective && !contradiction, semanticStatus: contradiction ? 'contradiction' : 'pending',
    reason: contradiction ? 'Обнаружено явное противоречие исходным фактам'
      : objective ? 'Формат, длина, числа и обязательные элементы выполнены; сохранение смысла pending, требуется судья'
      : 'Нарушены ограничения формата, длины, чисел или обязательных элементов; смысл pending' };
}

export function checkText(evaluator: string, output: string): { pass: boolean; reason: string } {
  let pass = false;
  switch (evaluator) {
    case 'pagination': {
      const parsed = z.strictObject({ items: z.array(z.strictObject({ id: z.number(), amount: z.number() })), total: z.number(), nextOffset: z.number().nullable() }).safeParse(parseJson(output));
      pass = parsed.success && parsed.data.total === 4 && parsed.data.nextOffset === 3
        && parsed.data.items.length === 2 && parsed.data.items[0]?.id === 2 && parsed.data.items[0]?.amount === 20
        && parsed.data.items[1]?.id === 3 && parsed.data.items[1]?.amount === 30;
      break;
    }
    case 'validation-error': {
      const parsed = z.strictObject({ status: z.literal(422), body: z.strictObject({ code: z.literal('VALIDATION_ERROR'), fields: z.array(z.strictObject({ field: z.string(), code: z.string() })).length(2) }) }).safeParse(parseJson(output));
      pass = parsed.success && parsed.data.body.fields.some((f) => f.field === 'email' && f.code === 'INVALID_EMAIL')
        && parsed.data.body.fields.some((f) => f.field === 'age' && f.code === 'MIN_18') && !output.includes('invalid-secret');
      break;
    }
    case 'maintenance-notice': return maintenanceCheck(output);
    case 'release-notes':
      pass = /^Версия 1\.4\.0\s*\n/u.test(output) && (output.match(/^\s*[-*]\s+.+$/gm)?.length ?? 0) === 3
        && /добавлен[^\n]*CSV/iu.test(output) && /исправлен[^\n]*фильтр[^\n]*обновлен/iu.test(output)
        && /500\s+строк/iu.test(output) && onlyNumbers(output, ['1.4.0', '500']);
      break;
    case 'translation-en':
      pass = /scheduled maintenance/i.test(output) && /12 October 2026/i.test(output)
        && ['02:00', '02:30', 'UTC', 'help@example.test'].every((s) => output.includes(s))
        && /CSV export[^.!\n]{0,50}(?:unavailable|not (?:be )?available)/i.test(output) && /support/i.test(output)
        && onlyNumbers(output, ['12', '2026', '02:00', '02:30']);
      break;
    case 'translation-ru':
      pass = /бесплатн(?:ый|ом) тариф/iu.test(output) && /3\s+проект/iu.test(output)
        && /резервные копии[^.!\n]{0,25}не (?:включены|входят|предусмотрены)/iu.test(output)
        && /точки восстановления[^.!\n]{0,70}7\s+дней[^.!\n]{0,30}платн(?:ом|ый) тариф/iu.test(output)
        && onlyNumbers(output, ['3', '7']);
      break;
    default: throw new Error(`Неизвестная текстовая проверка: ${evaluator}`);
  }
  return { pass, reason: pass ? 'Объективные условия выполнены' : `Нарушены объективные условия ${evaluator}; см. задание и сохранённый ответ` };
}

function parseJson(output: string): unknown { try { return JSON.parse(output); } catch { return null; } }

export class BrowserChecks {
  private browser: Browser | null = null;
  private temp: string | null = null;
  async start(): Promise<void> {
    this.temp = mkdtempSync(join(tmpdir(), 'practical-bench-browser-'));
    try {
      this.browser = await chromium.launch({
        headless: true, chromiumSandbox: true,
        env: { PATH: process.env.PATH ?? '', HOME: this.temp, TMPDIR: this.temp, LANG: 'en_US.UTF-8' },
      });
    } catch (error) {
      await this.close();
      throw new Error('Не удалось запустить Chromium. Выполните npm run browser:install.', { cause: error });
    }
  }
  version(): string { if (!this.browser) throw new Error('Браузер не запущен'); return this.browser.version(); }
  async close(): Promise<void> {
    try { await this.browser?.close(); } finally {
      this.browser = null;
      if (this.temp) rmSync(this.temp, { recursive: true, force: true });
      this.temp = null;
    }
  }
  async check(task: Task, output: string, dir: string, attemptId: string): Promise<{ pass: boolean; reason: string; evidence: string[] }> {
    if (!safeHtml(output)) return { pass: false, reason: 'HTML не соответствует безопасному формату демо', evidence: [] };
    if (!this.browser) throw new Error('Браузер не запущен');
    const context = await this.browser.newContext({
      javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false,
      locale: 'ru-RU', timezoneId: 'UTC', deviceScaleFactor: 1, reducedMotion: 'reduce',
    });
    await context.route('**/*', (route) => route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(task.limits.timeoutMs);
    const evidence: string[] = [];
    const observations: string[] = [];
    let pass = true;
    try {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
        const protectedOutput = output.replace(/<head\b[^>]*>/i, '$&<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'">');
        await page.setContent(protectedOutput, { timeout: task.limits.timeoutMs, waitUntil: 'load' });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        let valid = !overflow;
        if (task.id === 'contact-form') {
          const formValid = await page.evaluate(() => {
            const email = document.querySelector<HTMLInputElement>('input[type=email]');
            const message = document.querySelector<HTMLTextAreaElement>('textarea');
            const form = document.querySelector('form');
            if (!email || !message || !form || !email.required || !message.required || form.noValidate) return false;
            if (![email, message].every((element) => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0
              && Array.from(element.labels ?? []).some((label) => Boolean(label.textContent?.trim()) && label.getBoundingClientRect().height > 0 && getComputedStyle(label).visibility !== 'hidden'))) return false;
            const button = form.querySelector<HTMLElement>('button[type=submit],input[type=submit],button:not([type])');
            if (!button || button.getBoundingClientRect().width <= 0 || button.getBoundingClientRect().height <= 0) return false;
            if (form.checkValidity()) return false;
            message.value = 'Здравствуйте'; email.value = 'not-an-email';
            if (form.checkValidity()) return false;
            email.value = 'user@example.test';
            if (!form.checkValidity()) return false;
            message.value = '';
            return !form.checkValidity();
          });
          valid &&= formValid;
        } else if (task.id === 'faq-disclosure') {
          const content = await page.locator('body').textContent() ?? '';
          valid &&= await page.locator('details > summary').count() === 3
            && ['Как оплатить?', 'Картой.', 'Можно вернуть?', '14 дней', 'Где поддержка?', 'help@example.test'].every((s) => content.includes(s));
          if (valid) {
            const summary = page.locator('details > summary').first();
            const initiallyOpen = await page.locator('details').first().getAttribute('open') !== null;
            await summary.focus();
            await page.keyboard.press('Enter');
            valid &&= (await page.locator('details').first().getAttribute('open') !== null) !== initiallyOpen;
            await page.keyboard.press('Enter');
            valid &&= (await page.locator('details').first().getAttribute('open') !== null) === initiallyOpen;
          }
        } else {
          const layout = await page.evaluate(() => {
            const cards = Array.from(document.querySelectorAll('article'));
            return { title: document.querySelector('h1')?.textContent?.trim(), h1Count: document.querySelectorAll('h1').length,
              cards: cards.map((c) => ({ text: c.textContent ?? '', y: c.getBoundingClientRect().top, x: c.getBoundingClientRect().left, width: c.getBoundingClientRect().width })),
              actionCount: document.querySelectorAll('article button').length,
              reportLink: Boolean(document.querySelector('a[href="#report"]') && document.querySelector('#report')) };
          });
          const expected = task.id === 'pricing-layout'
            ? [/Старт[\s\S]*\b0\s+USD/, /Команда[\s\S]*\b12\s+USD/, /Бизнес[\s\S]*\b40\s+USD/]
            : [/Заявки[\s\S]*\b120\b/, /Ошибки[\s\S]*\b3\b/, /Время ответа[\s\S]*\b240\s+мс/];
          valid &&= layout.h1Count === 1 && layout.title === (task.id === 'pricing-layout' ? 'Тарифы' : 'Обзор')
            && layout.cards.length === 3 && layout.cards.every((c, i) => expected[i]?.test(c.text) && c.width > 0)
            && (task.id === 'pricing-layout' ? layout.actionCount === 3 : layout.reportLink);
          if (layout.cards.length === 3) {
            valid &&= width === 1440
              ? layout.cards.every((c) => Math.abs(c.y - layout.cards[0]!.y) < 2)
              : layout.cards[0]!.y < layout.cards[1]!.y && layout.cards[1]!.y < layout.cards[2]!.y;
          }
        }
        pass &&= valid;
        observations.push(`${width}px: ${valid ? 'passed' : 'failed'}, горизонтальная прокрутка: ${overflow}`);
        const screenshot = `screenshots/${attemptId}-${width}.png`;
        await page.screenshot({ path: join(dir, screenshot), fullPage: true, animations: 'disabled' });
        evidence.push(screenshot);
      }
      return { pass, reason: observations.join('; '), evidence };
    } finally { await context.close(); }
  }
}

export async function evaluateChecks(task: Task, output: string, browser: BrowserChecks, dir: string, attemptId: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of task.checks) {
    const result = check.evaluator === 'output-format'
      ? { pass: formatCheck(task, output), reason: 'Проверка формата ответа', evidence: [] }
      : isHtmlTask(task) ? await browser.check(task, output, dir, attemptId)
      : { ...checkText(check.evaluator, output), evidence: [] };
    results.push({ id: check.id, category: check.category, critical: check.critical, weight: check.weight,
      ...result, score: result.pass ? 1 : 0 });
  }
  return results;
}

export function assess(task: Task, checks: CheckResult[], skippedReason?: string): { status: AttemptStatus; assessments: Assessment[] } {
  const assessments: Assessment[] = task.evaluationCategories.map((category) => {
    const selected = checks.filter((c) => c.category === category);
    const weight = selected.reduce((sum, c) => sum + c.weight, 0);
    const automatedScore = weight ? selected.reduce((sum, c) => sum + c.weight * c.score, 0) / weight : null;
    const automatedPass = automatedScore === null ? null : automatedScore >= task.passThreshold && !selected.some((c) => c.critical && !c.pass);
    const subjectiveStatus = task.rubric.categories.includes(category) ? 'pending' : 'not_required';
    const status = skippedReason ? 'not_evaluated' : automatedPass === false ? 'failed' : subjectiveStatus === 'pending' ? 'pending' : automatedPass === true ? 'passed' : 'not_evaluated';
    return { category, status, score: skippedReason || subjectiveStatus === 'pending' ? null : automatedScore,
      automatedScore: skippedReason ? null : automatedScore, automatedPass: skippedReason ? null : automatedPass,
      subjectiveStatus, reason: skippedReason ?? (subjectiveStatus === 'pending' ? 'Субъективный судья не запускался' : 'Автоматические проверки') };
  });
  const weight = checks.reduce((sum, c) => sum + c.weight, 0);
  const objectiveScore = weight ? checks.reduce((sum, c) => sum + c.weight * c.score, 0) / weight : null;
  const status: AttemptStatus = skippedReason ? 'not_evaluated'
    : checks.some((c) => c.critical && !c.pass) || (objectiveScore !== null && objectiveScore < task.passThreshold) ? 'failed'
    : assessments.some((a) => a.status === 'pending') ? 'pending' : 'passed';
  return { status, assessments };
}
