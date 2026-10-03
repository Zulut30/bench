import type { CategoryId } from './categories.js';
import type { DemoConfig, Suite, Task, Tariff } from './schema.js';
import type { Usage } from './usage.js';
import type { BudgetState } from './budget.js';
import type { BillingMode, ProviderId, RunConfig } from './connections/config.js';
import type { ConnectionStatus, Diagnostic } from './connections/types.js';

export type Scenario = 'baseline' | 'current';
export type EvaluationStatus = 'passed' | 'failed' | 'pending' | 'not_evaluated';
export type AttemptStatus = EvaluationStatus | 'budget_exhausted' | Exclude<ConnectionStatus, 'ok'>;
export interface CheckResult {
  id: string; category: CategoryId; critical: boolean; weight: number;
  pass: boolean; score: number; reason: string; evidence: string[];
}
export interface Assessment {
  category: CategoryId; status: EvaluationStatus; score: number | null;
  automatedScore: number | null; automatedPass: boolean | null;
  subjectiveStatus: 'pending' | 'not_required'; reason: string;
}
export interface AttemptRecord {
  runId: string; taskId: string; attemptId: string; index: number;
  primaryCategory: CategoryId; model: string; status: AttemptStatus;
  checks: CheckResult[]; assessments: Assessment[]; callIds: string[];
  elapsedMs: number; reason: string; artifacts: string[];
  promptfooSuccess: boolean | null;
}
export interface CallRecord {
  runId: string; taskId: string; attemptId: string; callId: string;
  primaryCategory: CategoryId; role: 'candidate' | 'judge';
  provider: 'local-mock' | ProviderId; requestedModel: string; returnedModel: string | null;
  retryIndex: number; status: ConnectionStatus; error: string | null;
  rawUsage: Record<string, unknown>; usage: Usage; historicalUsage: Usage | null;
  delivery: 'fresh' | 'local_cache'; tariff: Tariff | null;
  modeledCostUsd: number | null; incurredCostUsd: number | null;
  costMethod: 'synthetic-token-tariff' | 'local-cache' | 'api-token-estimate' | 'client-api-equivalent-estimate' | 'unknown';
  billingMode?: BillingMode; returnedProvider?: string | null; generationId?: string | null;
  agentSteps?: number | null; internalRetries?: number | null; usageScope?: 'request' | 'session-summary' | 'unknown';
  accountingIncomplete?: boolean; clientVersion?: string | null; subscriptionRun?: boolean;
  sourceRunId?: string;
  elapsedKind?: 'generation' | 'import-processing'; generationElapsedMs?: number | null;
  generationParameters?: { requested: RunConfig['generation']; applied: Manifest['generation']; outputLimit: string };
  startedAt: string; elapsedMs: number; apiRequests: number; simulatedRequests: number;
  parameters: Task['limits']; artifacts: string[];
}
export interface Manifest {
  schemaVersion: 1 | 2; runId: string; mode: ProviderId; synthetic: boolean; scenario: Scenario | 'pilot' | 'manual';
  startedAt: string; completedAt: string; durationMs: number; timezone: string;
  suite: Suite; suiteHash: string; taskHashes: Record<string, string>;
  promptHashes: Record<string, string>; materialHashes: Record<string, string>;
  evaluationVersion: string; shellVersion: string; model: string;
  generation: { temperature: number | null; reasoning: string | null; cache: false };
  environment: { node: string; platform: string; arch: string; commit: string | null; dependencies: Record<string, string>; lockfileHash: string; implementationHash: string };
  browser: { engine: 'chromium'; version: string; viewports: number[]; font: string; javaScriptEnabled: false; network: 'blocked' };
  config: DemoConfig | RunConfig; budget: BudgetState;
  realBudget: { limitUsd: number; spentUsd: number; reservedUsd: number };
  billingMode?: BillingMode; conditions?: { provider: ProviderId; executionMode: 'model-only' | 'agent';
    clientVersion: string | null; authMethod: string | null; tools: string[]; configHash: string;
    isolation: 'api-no-tools' | 'os-workspace' | 'manual-declared' | 'mock'; diagnostic: Diagnostic };
  artifacts: string[]; status: 'complete' | 'complete_with_skips';
}
export interface SavedRun {
  manifest: Manifest; calls: CallRecord[]; attempts: AttemptRecord[];
}
