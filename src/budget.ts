import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DemoConfig } from './schema.js';

const micro = z.number().int().nonnegative().safe();
const accountSchema = z.strictObject({ spentMicroUsd: micro, reservedMicroUsd: micro });
const reservationSchema = z.strictObject({
  id: z.string(), runId: z.string(), taskKey: z.string(), month: z.string(),
  initialMicroUsd: micro, remainingMicroUsd: micro, knownSpentMicroUsd: micro,
  reconciliationRequired: z.boolean(), finished: z.boolean(),
});
export const budgetStateSchema = z.strictObject({
  schemaVersion: z.literal(1), namespace: z.enum(['synthetic', 'api']), timezone: z.string(),
  runs: z.record(z.string(), accountSchema), tasks: z.record(z.string(), accountSchema),
  months: z.record(z.string(), accountSchema), reservations: z.record(z.string(), reservationSchema),
  frozenReason: z.string().optional(),
});
export type BudgetState = z.infer<typeof budgetStateSchema>;
export type BudgetLimits = DemoConfig['syntheticBudget'];
export type BudgetDecision = { allowed: true; reservationId: string } | { allowed: false; reason: string; details?: { scope: string; spentUsd: number; reservedUsd: number; nextUsd: number; limitUsd: number } };
export interface BudgetAccess {
  reserve(runId: string, taskId: string, upper: { perCallUsd: number; attemptUsd: number } | null, now: Date): BudgetDecision;
  validateReservation(reservationId: string, upper: { perCallUsd: number; attemptUsd: number } | null, now?: Date): BudgetDecision;
  charge(reservationId: string, costUsd: number | null): void;
  finish(reservationId: string): void;
  snapshot(): BudgetState;
  freeze(reason: string): void;
}

export function monthKey(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit' }).formatToParts(date);
  return `${parts.find((p) => p.type === 'year')?.value}-${parts.find((p) => p.type === 'month')?.value}`;
}

// Лимиты округляются вниз, резерв и расход — вверх до микродоллара.
function toMicro(value: number, round: 'up' | 'down'): number {
  if (!Number.isFinite(value) || value < 0) throw new Error('Стоимость должна быть конечной и неотрицательной');
  const result = round === 'up' ? Math.ceil(value * 1e6 - 1e-9) : Math.floor(value * 1e6 + 1e-9);
  if (!Number.isSafeInteger(result)) throw new Error('Слишком большая стоимость');
  return result;
}

export class BudgetLedger {
  private state: BudgetState;
  constructor(
    private readonly limits: BudgetLimits,
    readonly timezone: string,
    initial?: BudgetState,
    private readonly persist?: (state: BudgetState) => void,
    namespace: BudgetState['namespace'] = 'synthetic',
  ) {
    Object.values(limits).forEach((v) => toMicro(v, 'down'));
    monthKey(new Date(), timezone);
    this.state = initial ? budgetStateSchema.parse(initial) : {
      schemaVersion: 1, namespace, timezone, runs: {}, tasks: {}, months: {}, reservations: {},
    };
    if (this.state.timezone !== timezone) throw new Error('Таймзона журнала отличается; используйте отдельный results-dir');
    if (this.state.namespace !== namespace) throw new Error('Нельзя смешивать API и синтетический журнал');
  }

  reserve(runId: string, taskId: string, upper: { perCallUsd: number; attemptUsd: number } | null, now: Date): BudgetDecision {
    if (this.state.frozenReason) return { allowed: false, reason: `Журнал заблокирован до сверки: ${this.state.frozenReason}` };
    if (upper === null) return { allowed: false, reason: 'Неизвестен тариф или верхняя граница стоимости' };
    const request = toMicro(upper.perCallUsd, 'up');
    const next = toMicro(upper.attemptUsd, 'up');
    if (next < request) throw new Error('Резерв попытки меньше резерва вызова');
    if (request > toMicro(this.limits.perRequestUsd, 'down')) return { allowed: false, reason: 'Лимит запроса', details: { scope: 'request', spentUsd: 0, reservedUsd: 0, nextUsd: request / 1e6, limitUsd: this.limits.perRequestUsd } };
    const taskKey = `${runId}/${taskId}`;
    const month = monthKey(now, this.timezone);
    const scopes = [
      { map: this.state.runs, key: runId, limit: this.limits.runUsd, label: 'Лимит запуска' },
      { map: this.state.tasks, key: taskKey, limit: this.limits.perTaskUsd, label: 'Лимит задания' },
      { map: this.state.months, key: month, limit: this.limits.monthUsd, label: 'Лимит месяца' },
    ];
    for (const scope of scopes) {
      const account = scope.map[scope.key];
      if ((account?.spentMicroUsd ?? 0) + (account?.reservedMicroUsd ?? 0) + next > toMicro(scope.limit, 'down')) {
        return { allowed: false, reason: scope.label, details: { scope: scope.label, spentUsd: (account?.spentMicroUsd ?? 0) / 1e6, reservedUsd: (account?.reservedMicroUsd ?? 0) / 1e6, nextUsd: next / 1e6, limitUsd: scope.limit } };
      }
    }
    const reservationId = randomUUID();
    // Проверка и изменение синхронны: конкурирующие Promise не разделяют эту операцию.
    this.mutate(() => {
      for (const scope of scopes) {
        const account = scope.map[scope.key] ??= { spentMicroUsd: 0, reservedMicroUsd: 0 };
        account.reservedMicroUsd += next;
      }
      this.state.reservations[reservationId] = {
        id: reservationId, runId, taskKey, month, initialMicroUsd: next, remainingMicroUsd: next,
        knownSpentMicroUsd: 0, reconciliationRequired: false, finished: false,
      };
    });
    return { allowed: true, reservationId };
  }

  charge(reservationId: string, costUsd: number | null): void {
    const reservation = this.getReservation(reservationId);
    if (reservation.finished) throw new Error('Попытка уже завершена');
    if (costUsd === null) {
      this.mutate(() => { reservation.reconciliationRequired = true; });
      return;
    }
    const cost = toMicro(costUsd, 'up');
    if (cost > reservation.remainingMicroUsd) throw new Error('Расход превысил верхнюю границу; требуется сверка');
    this.mutate(() => {
      reservation.remainingMicroUsd -= cost;
      reservation.knownSpentMicroUsd += cost;
      for (const account of this.accounts(reservation)) {
        account.reservedMicroUsd -= cost;
        account.spentMicroUsd += cost;
      }
    });
  }
  validateReservation(reservationId: string, upper: { perCallUsd: number; attemptUsd: number } | null, now = new Date()): BudgetDecision {
    const reservation = this.getReservation(reservationId);
    if (reservation.month !== monthKey(now, this.timezone)) return { allowed: false, reason: 'Сохранённый резерв относится к другому месяцу; нужен новый запуск в текущем бюджете' };
    if (this.state.frozenReason || reservation.finished || reservation.reconciliationRequired) return { allowed: false, reason: 'Резерв завершён/неизвестен или журнал заморожен; отправка блокирована' };
    if (!upper) return { allowed: false, reason: 'Восстановление: текущая верхняя цена неизвестна' };
    const request = toMicro(upper.perCallUsd, 'up'), next = toMicro(upper.attemptUsd, 'up');
    if (request > toMicro(this.limits.perRequestUsd, 'down')) return { allowed: false, reason: 'Восстановление: текущая цена выше лимита запроса', details: { scope: 'request', spentUsd: 0, reservedUsd: reservation.remainingMicroUsd / 1e6, nextUsd: request / 1e6, limitUsd: this.limits.perRequestUsd } };
    return next <= reservation.remainingMicroUsd ? { allowed: true, reservationId } : { allowed: false, reason: 'Восстановление: текущая цена/повторы выше сохранённого резерва',
      details: { scope: 'reservation', spentUsd: reservation.knownSpentMicroUsd / 1e6, reservedUsd: reservation.remainingMicroUsd / 1e6, nextUsd: next / 1e6, limitUsd: reservation.initialMicroUsd / 1e6 } };
  }

  finish(reservationId: string): void {
    const reservation = this.getReservation(reservationId);
    if (reservation.finished) throw new Error('Повторное завершение резерва');
    this.mutate(() => {
      if (!reservation.reconciliationRequired) {
        for (const account of this.accounts(reservation)) account.reservedMicroUsd -= reservation.remainingMicroUsd;
        reservation.remainingMicroUsd = 0;
      }
      reservation.finished = true;
    });
  }

  snapshot(): BudgetState { return structuredClone(this.state); }
  reconcile(reservationId: string, costUsd: number): void {
    const reservation = this.getReservation(reservationId);
    const cost = toMicro(costUsd, 'up');
    // Суммарная окончательная цена конверта; известные списания уже учтены.
    if (cost < reservation.knownSpentMicroUsd) throw new Error('Сверенная стоимость меньше уже известной');
    const additional = cost - reservation.knownSpentMicroUsd;
    this.mutate(() => {
      for (const account of this.accounts(reservation)) {
        account.reservedMicroUsd -= reservation.remainingMicroUsd; account.spentMicroUsd += additional;
      }
      reservation.knownSpentMicroUsd = cost; reservation.remainingMicroUsd = 0;
      reservation.reconciliationRequired = false; reservation.finished = true;
      if (cost > reservation.initialMicroUsd) this.state.frozenReason = 'Сверенное начисление выше верхней границы';
    });
  }
  freeze(reason: string): void { this.mutate(() => { this.state.frozenReason = reason; }); }

  private getReservation(id: string) {
    const reservation = this.state.reservations[id];
    if (!reservation) throw new Error('Резерв не найден');
    return reservation;
  }
  private accounts(reservation: BudgetState['reservations'][string]) {
    const result = [this.state.runs[reservation.runId], this.state.tasks[reservation.taskKey], this.state.months[reservation.month]];
    if (result.some((a) => !a)) throw new Error('Повреждён журнал бюджета');
    return result.map((a) => a!);
  }
  private mutate(action: () => void): void {
    const previous = structuredClone(this.state);
    try { action(); this.persist?.(this.snapshot()); } catch (error) { this.state = previous; throw error; }
  }
}
