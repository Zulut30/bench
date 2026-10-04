import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { OpenRouterConnection } from './connections/openrouter.js';
import type { RunConfig } from './connections/config.js';
import { SqliteBudgetLedger } from './state.js';
import { finalizeIntegrity, withProjectLock, writeJson } from './storage.js';
interface Receipt { costUsd: number; generationId: string; raw: unknown; }
export async function reconcileRun(root: string, runId: string, options: { apiBaseUrl?: string; input?: unknown } = {}) {
  return withProjectLock(root, async store => {
    const plan = store.run<{ config: RunConfig; budgetUsd?: number | null; options?: { budgetUsd: number | null } }>(runId).plan;
    const budgetUsd = plan.budgetUsd ?? plan.options?.budgetUsd;
    if (budgetUsd == null) throw new Error('У этого запуска нет API-бюджета для сверки');
    const ledger = new SqliteBudgetLedger(store, { ...plan.config.apiBudget, runUsd: budgetUsd }, plan.config.timezone);
    const mapping = options.input === undefined ? [] : z.strictObject({ calls: z.array(z.strictObject({ callId: z.string(), generationId: z.string().regex(/^gen-[a-zA-Z0-9-]+$/) })).min(1) }).parse(options.input).calls;
    const intents = store.intents(runId), results = [];
    if (new Set(mapping.map(m => m.callId)).size !== mapping.length || new Set(mapping.map(m => m.generationId)).size !== mapping.length
      || mapping.some(m => !intents.some(i => i.id === m.callId))) throw new Error('Сопоставление должно содержать уникальные callId/generationId этого запуска');
    for (const intent of intents) {
      if (!intent.reservationId || intent.result?.sent === false) continue;
      const reservation = ledger.snapshot().reservations[intent.reservationId];
      if (intent.record?.incurredCostUsd != null && !reservation?.reconciliationRequired) continue;
      const existing = store.reconciliation<Receipt>(intent.id); if (existing) { results.push({ callId: intent.id, status: 'already_reconciled', ...existing }); continue; }
      const generationId = intent.generationId ?? mapping.find(m => m.callId === intent.id)?.generationId;
      if (!generationId) { results.push({ callId: intent.id, status: 'in_doubt', reason: 'Нет generation ID. Найдите его в OpenRouter Activity и передайте сопоставление через --input; резерв удержан' }); continue; }
      const settings = intent.role === 'candidate' ? plan.config.candidate : intent.attemptId.includes('-vision-') ? plan.config.judges.vision : plan.config.judges.text;
      if (!settings || settings.provider !== 'openrouter') continue;
      const connection = new OpenRouterConnection(settings, options.apiBaseUrl);
      try {
        const reconciliation = await connection.reconcileGeneration(generationId);
        if (reconciliation.costUsd === null) { results.push({ callId: intent.id, status: 'in_doubt', reason: 'Generation ещё не завершена или total_cost неизвестен; резерв удержан' }); continue; }
        store.transaction(() => {
          store.saveReconciliation(intent.id, { generationId, costUsd: reconciliation.costUsd, raw: reconciliation.raw });
          const siblings = intents.filter(c => c.reservationId === intent.reservationId);
          const costs = siblings.map(c => c.result?.sent === false ? 0 : store.reconciliation<Receipt>(c.id)?.costUsd ?? c.record?.incurredCostUsd ?? null);
          if (costs.every(c => c !== null)) ledger.reconcile(intent.reservationId!, costs.reduce<number>((sum, c) => sum + Math.ceil(c! * 1e6 - 1e-9) / 1e6, 0));
        });
        results.push({ callId: intent.id, status: 'reconciled', ...reconciliation, operatorMapped: intent.generationId === null });
      } catch (error) { results.push({ callId: intent.id, status: 'in_doubt', reason: String(error) }); }
    }
    const dir = join(root, 'reconciliations', `reconciliation-${randomUUID()}`); mkdirSync(dir, { recursive: true });
    const report = { runId, createdAt: new Date().toISOString(), results, budget: ledger.snapshot(), originalArtifactsModified: false };
    writeJson(join(dir, 'reconciliation.json'), report); finalizeIntegrity(dir); return { dir, report };
  });
}
