import type { CategoryId } from './categories.js';
import type { DemoConfig, Suite, Task, Tariff } from './schema.js';
import type { MockUsage, Usage } from './usage.js';
import type { BudgetState } from './budget.js';

export type Scenario = 'baseline' | 'current';
export type EvaluationStatus = 'passed' | 'failed' | 'pending' | 'not_evaluated';
export type AttemptStatus = EvaluationStatus | 'budget_exhausted' | 'technical_error' | 'limit_exceeded';
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
  provider: 'local-mock'; requestedModel: string; returnedModel: string | null;
  retryIndex: number; status: 'ok' | 'technical_error' | 'limit_exceeded'; error: string | null;
  rawUsage: MockUsage; usage: Usage; historicalUsage: Usage | null;
  delivery: 'fresh' | 'local_cache'; tariff: Tariff;
  modeledCostUsd: number | null; incurredCostUsd: number;
  costMethod: 'synthetic-token-tariff' | 'local-cache';
  startedAt: string; elapsedMs: number; apiRequests: number; simulatedRequests: number;
  parameters: Task['limits']; artifacts: string[];
}
export interface Manifest {
  schemaVersion: 1; runId: string; mode: 'mock'; synthetic: true; scenario: Scenario;
  startedAt: string; completedAt: string; durationMs: number; timezone: string;
  suite: Suite; suiteHash: string; taskHashes: Record<string, string>;
  promptHashes: Record<string, string>; materialHashes: Record<string, string>;
  evaluationVersion: string; shellVersion: string; model: string;
  generation: { temperature: 0; reasoning: 'synthetic-in-output'; cache: false };
  environment: { node: string; platform: string; arch: string; commit: string | null; dependencies: Record<string, string>; lockfileHash: string; implementationHash: string };
  browser: { engine: 'chromium'; version: string; viewports: number[]; font: string; javaScriptEnabled: false; network: 'blocked' };
  config: DemoConfig; budget: BudgetState;
  realBudget: { limitUsd: 0; spentUsd: 0; reservedUsd: 0 };
  artifacts: string[]; status: 'complete' | 'complete_with_skips';
}
export interface SavedRun {
  manifest: Manifest; calls: CallRecord[]; attempts: AttemptRecord[];
}
