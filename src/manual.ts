import { z } from 'zod';
import { hash, writeJson } from './storage.js';
import { taskPrompt } from './runner.js';
import { pilotSuite } from './pilot.js';
import type { RunConfig, ConnectionConfig } from './connections/config.js';
import type { ConnectionRequest, ConnectionResult, ModelConnection } from './connections/types.js';
import { emptyResult } from './connections/parsers.js';

export const manualSchema = z.strictObject({
  version: z.literal(1), model: z.string().min(1), clientVersion: z.string().min(1), executionMode: z.enum(['model-only', 'agent']),
  answers: z.array(z.strictObject({ taskId: z.string(), index: z.number().int().positive(), promptHash: z.string().regex(/^[a-f0-9]{64}$/),
    response: z.string().min(1).max(200_000), sessionId: z.string().min(1), newSession: z.literal(true),
    tools: z.array(z.string()), elapsedMs: z.number().nonnegative().nullable(),
  })).min(1),
}).superRefine((value, ctx) => {
  if (new Set(value.answers.map((a) => `${a.taskId}/${a.index}`)).size !== value.answers.length) ctx.addIssue({ code: 'custom', message: 'Повтор ответа одной попытки' });
  if (new Set(value.answers.map((a) => a.sessionId)).size !== value.answers.length) ctx.addIssue({ code: 'custom', message: 'Каждая попытка должна иметь отдельную новую сессию' });
  if (value.executionMode === 'model-only' && value.answers.some((a) => a.tools.length)) ctx.addIssue({ code: 'custom', message: 'Инструменты несовместимы с model-only' });
});
export type ManualInput = z.infer<typeof manualSchema>;
export function manualTemplate(config: RunConfig, path: string): void {
  const suite = pilotSuite(config);
  writeJson(path, { version: 1, model: config.candidate.model ?? 'УКАЖИТЕ-МОДЕЛЬ', clientVersion: 'УКАЖИТЕ-ВЕБ-КЛИЕНТ-И-ДАТУ', executionMode: 'model-only',
    answers: suite.tasks.filter((t) => t.readiness === 'enabled').flatMap((task) => Array.from({ length: task.limits.attempts }, (_, i) => ({
      taskId: task.id, index: i + 1, promptHash: hash(taskPrompt(task)), response: '', sessionId: '', newSession: true, tools: [], elapsedMs: null,
    }))), prompts: Object.fromEntries(suite.tasks.map((t) => [t.id, taskPrompt(t)])) });
}
export function parseManual(raw: unknown, config: RunConfig): ManualInput {
  // prompts служит только копированию в веб-чат; импорт хеширует наш исходный промпт.
  const { prompts: _prompts, ...input } = z.looseObject({}).parse(raw);
  const parsed = manualSchema.parse(input), suite = pilotSuite(config);
  for (const answer of parsed.answers) {
    const task = suite.tasks.find((t) => t.id === answer.taskId && t.readiness === 'enabled');
    if (!task || answer.index > task.limits.attempts || answer.promptHash !== hash(taskPrompt(task))) throw new Error('Manual: неизвестное задание, попытка или изменённый промпт');
  }
  return parsed;
}
export class ManualConnection implements ModelConnection {
  constructor(readonly config: ConnectionConfig, private readonly input: ManualInput) {}
  tariff() { return null; }
  upperBound() { return { perCallUsd: 0, attemptUsd: 0 }; }
  async diagnose() { return { provider: 'manual' as const, status: 'ok' as const, reason: 'Сессии и условия заявлены пользователем; автоматический сигнал регрессии запрещён',
    version: this.input.clientVersion, authMethod: 'user-managed-webchat', configuredModel: this.input.model, modelAvailability: 'unverified' as const,
    executionMode: this.input.executionMode, tools: [...new Set(this.input.answers.flatMap((a) => a.tools))], config: { isolation: 'manual-declared', exactUsage: false } }; }
  async execute(request: ConnectionRequest): Promise<ConnectionResult> {
    const answer = this.input.answers.find((a) => a.taskId === request.taskId && a.index === request.attemptIndex);
    if (!answer) return { ...emptyResult(), sent: false, status: 'not_evaluated', reason: 'Ответ не импортирован; пропуск' };
    return { ...emptyResult(), output: answer.response, raw: { imported: true, sessionId: answer.sessionId, newSession: true,
      elapsedMs: answer.elapsedMs, tools: answer.tools, hiddenUsage: true, hiddenRetries: true },
      incurredCostUsd: null, generationId: answer.sessionId, returnedModel: null, returnedProvider: 'manual-webchat' };
  }
}
