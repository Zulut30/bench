import { describe, expect, it } from 'vitest';
import { configSchema, suiteSchema, taskSchema } from '../src/schema.js';
import { categories, categoryIds } from '../src/categories.js';
import { checkText } from '../src/checks.js';
import { responsesSchema } from '../src/mock-provider.js';
import { readJson } from '../src/storage.js';
import { projectRoot } from '../src/runner.js';
import { join } from 'node:path';
import { config, suite, task } from './helpers.js';

describe('Схема и готовность демонстрационного набора', () => {
  it('содержит 16 направлений, 10 уникальных задач и пять primary категорий', () => {
    expect(Object.keys(categories)).toEqual([...categoryIds]);
    expect(suiteSchema.parse(suite).tasks).toHaveLength(10);
    expect(new Set(suite.tasks.map((t) => t.primaryCategory))).toEqual(new Set(['frontend', 'backend', 'writing', 'translation', 'ui-design']));
  });
  it.each(['primary', 'category', 'limits', 'manual', 'duplicate'] as const)('отвергает некорректное задание: %s', (problem) => {
    const t = task();
    if (problem === 'primary') t.primaryCategory = 'sql';
    if (problem === 'category') t.checks[0]!.category = 'sql';
    if (problem === 'limits') t.limits.maxRetries = 2;
    if (problem === 'manual') t.manualRequired = true;
    if (problem === 'duplicate') t.evaluationCategories.push('backend');
    expect(taskSchema.safeParse(t).success).toBe(false);
  });
  it('запрещает real и ненулевой фактический бюджет', () => {
    expect(configSchema.safeParse({ ...config, mode: 'real' }).success).toBe(false);
    expect(configSchema.safeParse({ ...config, realBudgetUsd: 0.01 }).success).toBe(false);
    expect(configSchema.safeParse({ ...config, timezone: 'bad/timezone' }).success).toBe(false);
  });
  it('проверяет правильные и ошибочные текстовые эталоны до включения', () => {
    const responses = responsesSchema.parse(readJson(join(projectRoot, 'fixtures/mock-responses.json')));
    for (const t of suite.tasks.filter((t) => ['backend', 'writing', 'translation'].includes(t.primaryCategory))) {
      expect(checkText(t.id, responses[t.id]!.correct).pass, `${t.id}: правильный ответ`).toBe(true);
      expect(checkText(t.id, responses[t.id]!.incorrect).pass, `${t.id}: дефект`).toBe(false);
    }
  });
  it('принимает альтернативный порядок ключей и ошибок, но обнаруживает потерю поля', () => {
    expect(checkText('validation-error', '{"body":{"fields":[{"code":"INVALID_EMAIL","field":"email"},{"code":"MIN_18","field":"age"}],"code":"VALIDATION_ERROR"},"status":422}').pass).toBe(true);
    expect(checkText('validation-error', '{"status":422,"body":{"code":"VALIDATION_ERROR","fields":[{"field":"email","code":"INVALID_EMAIL"}]}}').pass).toBe(false);
  });
});
