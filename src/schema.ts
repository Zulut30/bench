import { z } from 'zod';
import { categoryIds } from './categories.js';

const id = z.string().regex(/^[a-z][a-z0-9-]*$/);
const category = z.enum(categoryIds);
export const evaluatorIds = [
  'contact-form', 'faq-disclosure', 'pagination', 'validation-error',
  'maintenance-notice', 'release-notes', 'translation-en', 'translation-ru',
  'pricing-layout', 'dashboard-layout', 'output-format',
  'practical-code', 'practical-text',
] as const;

export const taskSchema = z.strictObject({
  id,
  version: z.string().min(1),
  title: z.string().min(1),
  primaryCategory: category,
  evaluationCategories: z.array(category).min(1),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  prompt: z.string().min(1),
  materials: z.array(z.strictObject({ id, content: z.string().min(1) })).min(1),
  successCriteria: z.array(z.string().min(1)).min(1),
  criticalRequirements: z.array(z.string().min(1)).min(1),
  checks: z.array(z.strictObject({
    id,
    evaluator: z.enum(evaluatorIds),
    category,
    critical: z.boolean(),
    weight: z.number().positive().finite(),
  })).min(1),
  rubric: z.strictObject({
    version: z.string().min(1),
    categories: z.array(category),
    criteria: z.array(z.string().min(1)),
  }),
  manualRequired: z.boolean(),
  passThreshold: z.number().min(0).max(1),
  limits: z.strictObject({
    maxInputTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    timeoutMs: z.number().int().positive().max(300_000),
    maxCalls: z.number().int().positive(),
    maxRetries: z.number().int().min(0).max(2),
    maxSteps: z.number().int().positive(),
    attempts: z.number().int().positive().max(10),
    maxJudgeCalls: z.number().int().min(0).max(4),
  }),
  reference: z.string().nullable(),
  readiness: z.enum(['draft', 'validated', 'enabled']),
  execution: z.strictObject({ kind: z.enum(['frontend', 'ui-design', 'backend', 'sql', 'algorithms', 'debugging', 'refactoring', 'test-writing', 'devops', 'security']),
    allowedFiles: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)).min(1), timeoutMs: z.number().int().positive().max(60_000) }).optional(),
  validation: z.strictObject({ version: z.string().min(1), fixture: z.string().regex(/^fixtures\/[a-z0-9-]+\.json$/) }).optional(),
}).superRefine((task, ctx) => {
  const problem = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (!task.evaluationCategories.includes(task.primaryCategory)) problem('primaryCategory должна оцениваться');
  if (new Set(task.evaluationCategories).size !== task.evaluationCategories.length) problem('Повтор категории');
  if (new Set(task.checks.map((c) => c.id)).size !== task.checks.length) problem('Повтор ID проверки');
  if (new Set(task.materials.map((m) => m.id)).size !== task.materials.length) problem('Повтор ID материала');
  if (task.checks.some((c) => !task.evaluationCategories.includes(c.category))) problem('Категория проверки вне задания');
  if (task.rubric.categories.some((c) => !task.evaluationCategories.includes(c))) problem('Категория рубрики вне задания');
  if (new Set(task.rubric.categories).size !== task.rubric.categories.length) problem('Повтор категории рубрики');
  if (task.manualRequired !== (task.rubric.categories.length > 0)) problem('manualRequired не согласован с рубрикой');
  if (task.manualRequired && task.rubric.criteria.length === 0) problem('Нужны критерии ручной оценки');
  if (task.evaluationCategories.some((c) => !task.checks.some((check) => check.category === c) && !task.rubric.categories.includes(c))) {
    problem('У каждой категории должна быть проверка или рубрика');
  }
  if (task.limits.maxCalls < 1 + task.limits.maxRetries) problem('maxCalls не покрывает разрешённые повторы');
  if (task.limits.maxSteps < task.limits.maxCalls) problem('maxSteps не покрывает вызовы');
});

export const suiteSchema = z.strictObject({
  id,
  version: z.string().min(1),
  evaluationVersion: z.string().min(1),
  tasks: z.array(taskSchema).min(1),
}).superRefine((suite, ctx) => {
  if (new Set(suite.tasks.map((t) => t.id)).size !== suite.tasks.length) {
    ctx.addIssue({ code: 'custom', message: 'ID заданий должны быть уникальными' });
  }
});

export type Task = z.infer<typeof taskSchema>;
export type Suite = z.infer<typeof suiteSchema>;

const usd = z.number().finite().min(0);
export const configSchema = z.strictObject({
  mode: z.literal('mock'),
  realBudgetUsd: z.literal(0),
  timezone: z.string().refine((value) => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }, 'Неверная таймзона'),
  syntheticBudget: z.strictObject({ perRequestUsd: usd, perTaskUsd: usd, runUsd: usd, monthUsd: usd }),
  tariff: z.strictObject({
    id: z.string().min(1), version: z.string().min(1), asOf: z.iso.date(),
    currency: z.literal('USD'), synthetic: z.literal(true),
    inputPerMillion: usd, cacheReadPerMillion: usd, cacheWritePerMillion: usd, outputPerMillion: usd,
  }),
});
export type DemoConfig = z.infer<typeof configSchema>;
export interface Tariff {
  id: string; version: string; asOf: string; currency: 'USD'; synthetic: boolean;
  inputPerMillion: number; cacheReadPerMillion: number; cacheWritePerMillion: number; outputPerMillion: number;
}
