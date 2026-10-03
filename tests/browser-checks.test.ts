import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserChecks, safeHtml } from '../src/checks.js';
import { projectRoot } from '../src/runner.js';
import { readJson } from '../src/storage.js';
import { responsesSchema } from '../src/mock-provider.js';
import { task } from './helpers.js';

describe('Содержательные браузерные проверки эталонов', () => {
  const browser = new BrowserChecks();
  const dir = mkdtempSync(join(tmpdir(), 'bench-html-test-'));
  const responses = responsesSchema.parse(readJson(join(projectRoot, 'fixtures/mock-responses.json')));
  beforeAll(async () => { mkdirSync(join(dir, 'screenshots')); await browser.start(); });
  afterAll(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });

  it.each(['contact-form', 'faq-disclosure', 'pricing-layout', 'dashboard-layout'])('принимает эталон и выявляет заданный дефект %s', async (id) => {
    const t = task(id);
    expect((await browser.check(t, responses[id]!.correct, dir, `${id}-correct`)).pass).toBe(true);
    expect((await browser.check(t, responses[id]!.incorrect, dir, `${id}-incorrect`)).pass).toBe(false);
  });
  it('принимает доступный FAQ с первоначально раскрытым первым вопросом', async () => {
    const output = responses['faq-disclosure']!.correct.replace('<details>', '<details open>');
    expect((await browser.check(task('faq-disclosure'), output, dir, 'initially-open')).pass).toBe(true);
  });
  it('не принимает невидимые подписи формы', async () => {
    const output = responses['contact-form']!.correct.replace('</style>', 'label{display:none}</style>');
    expect((await browser.check(task('contact-form'), output, dir, 'hidden-labels')).pass).toBe(false);
  });
  it('отвергает JavaScript и внешние ресурсы до загрузки HTML', () => {
    for (const injected of ['<script>alert(1)</script>', '<img src="https://example.test/x">', '<style>@import "https://example.test/x";</style>']) {
      expect(safeHtml(responses['contact-form']!.correct.replace('</body>', `${injected}</body>`))).toBe(false);
    }
  });
});
