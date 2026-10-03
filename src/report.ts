import type { RunSummary, Sum } from './aggregate.js';
import type { Comparison } from './compare.js';
import type { SavedRun } from './types.js';

export const escapeHtml = (value: unknown): string => String(value).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s]!);
const money = (value: number | null) => value === null ? 'неизвестно' : `${value.toFixed(9).replace(/0+$/, '').replace(/\.$/, '')} USD`;
const percentage = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
const delta = (value: number | null) => value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(1)} п.п.`;
const sum = (value: Sum, usd = false) => value.value === null
  ? `неизвестно (известная часть: ${usd ? money(value.known) : value.known}; неизвестных: ${value.unknownCount})`
  : usd ? money(value.value) : String(value.value);
const link = (path: string, label = path) => `<a href="${escapeHtml(path)}">${escapeHtml(label)}</a>`;
const statusLabels: Record<string, string> = {
  passed: 'passed — пройдено', failed: 'failed — провал', pending: 'pending — ожидает судью',
  not_evaluated: 'not_evaluated — не оценено', budget_exhausted: 'budget_exhausted — лимит бюджета',
  technical_error: 'technical_error — техническая ошибка', limit_exceeded: 'limit_exceeded — лимит',
  auth_missing: 'auth_missing — нет входа/ключа', auth_incompatible: 'auth_incompatible — неподходящий способ входа',
  client_missing: 'client_missing — клиент не установлен', unsupported_client: 'unsupported_client — несовместимые флаги',
  model_missing: 'model_missing — выберите model ID/endpoint', model_unavailable: 'model_unavailable — модель/endpoint недоступны',
  quota_exhausted: 'quota_exhausted — квота исчерпана', timeout: 'timeout — время истекло', invalid_response: 'invalid_response — неверный JSON/JSONL',
  isolation_unavailable: 'isolation_unavailable — нет файловой песочницы', route_changed: 'route_changed — изменён маршрут',
  subscription_policy_unknown: 'subscription_policy_unknown — состояние usage credits неизвестно', not_comparable: 'условия несопоставимы',
  uncovered: 'не покрыто', evaluated: 'оценено', partial: 'частичное покрытие',
  suspected: 'suspected — требуется повтор', improved: 'улучшение', stable: 'без изменения',
};
const status = (value: string) => `<span class="tag ${escapeHtml(value)}">${escapeHtml(statusLabels[value] ?? value)}</span>`;
const table = (heads: string[], rows: string[]) => `<div class="scroll"><table><thead><tr>${heads.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
const row = (cells: string[]) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
const card = (label: string, value: string) => `<div class="card"><span>${label}</span><strong>${value}</strong></div>`;

function document(title: string, body: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file: data:; style-src 'unsafe-inline'; base-uri 'none'"><title>${escapeHtml(title)}</title><style>
  *{box-sizing:border-box}body{margin:0;color:#15283e;background:#edf1f6;font:16px/1.6 Arial,sans-serif}main{max-width:1280px;margin:auto;padding:32px}h1{font-size:36px;line-height:1.2;letter-spacing:-.5px}h2{margin:32px 0 12px;font-size:24px}p{max-width:100ch}.banner{border-left:5px solid #966100;background:#fff4d8;padding:16px 20px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:16px;margin:24px 0}.card{background:white;border:1px solid #ced8e4;border-radius:10px;padding:20px}.card span{display:block;color:#4a5e75;font-size:14px}.card strong{display:block;font-size:24px;margin-top:8px;overflow-wrap:anywhere}.scroll{overflow:auto;border:1px solid #cad5e2;border-radius:8px;background:white}table{border-collapse:collapse;width:100%;font-size:14px}th{text-align:left;background:#183a60;color:white;white-space:nowrap}th,td{padding:12px 14px;border-bottom:1px solid #dae2ed;vertical-align:top}tbody tr:nth-child(even){background:#f5f8fb}a{color:#124b9e;text-underline-offset:3px}code{font-size:13px;overflow-wrap:anywhere}.tag{display:inline-block;border-radius:5px;padding:2px 7px;background:#e7edf4;font-size:12px;white-space:nowrap}.passed,.improved{background:#daefdf;color:#195829}.failed,.suspected{background:#f9dfe1;color:#812334}.pending,.partial{background:#fff0cc;color:#754800}.uncovered,.not_evaluated{color:#4b5d72}details{margin:10px 0}summary{cursor:pointer;font-weight:bold}.muted{color:#4e6279}.thumb{width:200px;max-width:100%;border:1px solid #ced8e4}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#e3eaf3;padding:14px}ul{padding-left:24px}@media(max-width:600px){main{padding:16px}h1{font-size:28px}h2{font-size:21px}.cards{grid-template-columns:1fr}.card strong{font-size:22px}}
  </style></head><body><main>${body}</main></body></html>`;
}

export function renderRun(run: SavedRun, summary: RunSummary): string {
  if (run.manifest.schemaVersion === 2) return renderPilotRun(run, summary);
  const { manifest, attempts, calls } = run;
  const totals = summary.totals;
  const account = manifest.budget.runs[manifest.runId];
  const limits = 'syntheticBudget' in manifest.config ? manifest.config.syntheticBudget : manifest.config.apiBudget;
  const months = Object.entries(manifest.budget.months).map(([month, a]) => `${escapeHtml(month)}: расход ${money(a.spentMicroUsd / 1e6)}, резерв ${money(a.reservedMicroUsd / 1e6)}`).join('; ');
  const body = `<p class="muted">Practical Model Bench · этап 1 · mock</p><h1>Демонстрационный запуск: ${escapeHtml(manifest.scenario)}</h1>
    <div class="banner">Синтетические ответы, токены и тарифы. Этот отчёт не измеряет качество реальных моделей. Фактические расходы API: <b>0 USD</b>. Субъективного судьи нет.</div>
    <p>ID: <code>${escapeHtml(manifest.runId)}</code><br>Модель: <code>${escapeHtml(manifest.model)}</code>; возвращённые версии: ${escapeHtml([...new Set(calls.flatMap((c) => c.returnedModel ? [c.returnedModel] : []))].join(', '))}<br>${escapeHtml(manifest.startedAt)} · таймзона бюджета ${escapeHtml(manifest.timezone)}</p>
    <div class="cards">${card('Задачи / выполненные', `${summary.taskCount} / ${summary.executedTaskCount}`)}${card('Попытки / успешные полностью', `${summary.plannedAttempts} / ${totals.successfulAttempts}`)}${card('Категории с заданиями', `${summary.categories.filter((c) => c.taskCount).length} / 16`)}${card('Время запуска', `${(manifest.durationMs / 1000).toFixed(2)} с`)}</div>
    <p>Первичных направлений: ${new Set(manifest.suite.tasks.map((t) => t.primaryCategory)).size}. «Следование инструкциям» оценивается дополнительно; его расходы относятся к первичным категориям.</p>
    <h2>Качество и покрытие</h2><p>Итоговый pass rate считает только завершённые оценки (passed/failed); pending и пропуски исключены из знаменателя. «Авто» показывает только проверяемую часть. Итоговые баллы при незавершённой субъективной оценке отсутствуют.</p>
    ${table(['Категория', 'Задачи, выполнено', 'Покрытие', 'passed / failed / pending / пропуск', 'Итоговый pass rate', 'Авто pass rate', 'Итоговый балл', 'Синтетическая цена по primary'], summary.categories.map((c) => row([
      `${escapeHtml(c.label)}<br><code>${c.id}</code>`, `${c.taskCount}, ${c.executedTaskCount}`, status(c.coverage), `${c.passed} / ${c.failed} / ${c.pending} / ${c.skipped}`,
      percentage(c.passRate), percentage(c.automatedPassRate), c.meanScore === null ? '—' : c.meanScore.toFixed(3), sum(c.primaryCostUsd, true),
    ])))}
    <h2>Токены и расходы</h2><p>Общий объём = input + output. Reasoning входит в output, чтение/запись кеша входят в input. Они показаны как подмножества. Исторический usage локального кеша сохранён отдельно и в новые токены не включён.</p>
    ${table(['Вход', 'Выход', 'Всего', 'Reasoning (подмножество)', 'Cache read (подмножество)', 'Cache write (подмножество)'], [row([sum(totals.tokens.input), sum(totals.tokens.output), sum(totals.tokens.total), sum(totals.tokens.reasoning), sum(totals.tokens.cacheRead), sum(totals.tokens.cacheWrite)])])}
    ${table(['Модель: первые вызовы', 'Судья: первые вызовы', 'Повторы', 'Всего', 'Фактические API', 'Цена успешной попытки'], [row([sum(totals.costs.candidateInitial, true), sum(totals.costs.judgeInitial, true), sum(totals.costs.retries, true), sum(totals.costs.total, true), money(totals.incurredCostUsd), money(totals.costPerSuccessUsd)])])}
    <p>В цену успешной попытки включён судья (его вызовов ${totals.judgeCalls}); при неизвестных расходах или нуле успехов значение не определено. Все попытки выбранного набора входят в числитель. Расходы разработки в Codex здесь не учитываются.</p>
    <p>Уникальных вызовов: ${totals.callCount}; синтетических запросов: ${totals.simulatedRequests}; реальных API-запросов: ${totals.apiRequests}; технических повторов: ${totals.retryCalls}; локальных чтений кеша: ${totals.localCacheReads}; неполный usage: ${totals.incompleteUsageCalls}.</p>
    <h2>Бюджет до запроса</h2><p>Синтетический журнал: расход ${money((account?.spentMicroUsd ?? 0) / 1e6)}, резерв ${money((account?.reservedMicroUsd ?? 0) / 1e6)}. Лимиты: запрос ${money(limits.perRequestUsd)}, задача ${money(limits.perTaskUsd)}, запуск ${money(limits.runUsd)}, месяц ${money(limits.monthUsd)}.</p>
    <p>${months}. Неизвестные начисления удерживают остаток резерва и требуют сверки. Реальный бюджет: лимит / расход / резерв — 0 / 0 / 0 USD.</p>
    <h2>Попытки и доказательства</h2>
    ${table(['Задание / попытка', 'Статус', 'Проверки', 'Артефакты'], attempts.map((a) => row([
      `${escapeHtml(manifest.suite.tasks.find((t) => t.id === a.taskId)?.title ?? a.taskId)}<br><code>${escapeHtml(a.attemptId)}</code>`, status(a.status),
      a.checks.length ? a.checks.map((c) => `<details><summary>${escapeHtml(c.id)}: ${c.pass ? 'passed' : 'failed'}</summary><p>${escapeHtml(c.reason)}</p>${c.evidence.map((e) => link(e)).join('<br>')}</details>`).join('') : escapeHtml(a.reason),
      a.artifacts.map((e) => link(e)).join('<br>'),
    ])))}
    <h2>История вызовов</h2>${table(['callId', 'Роль / повтор', 'Результат', 'Источник usage / получение', 'Цена', 'Ответ'], calls.map((c) => row([
      `<code>${escapeHtml(c.callId)}</code>`, `${c.role} / ${c.retryIndex}`, escapeHtml(c.status), `${c.usage.source}${c.usage.complete ? '' : ' (неполный)'} / ${c.delivery}`,
      money(c.modeledCostUsd), c.artifacts.map((e) => link(e)).join('<br>'),
    ])))}
    <h2>Скриншоты и окружение</h2><p>Chromium ${escapeHtml(manifest.browser.version)}, Arial, 1440×900 / 390×844, масштаб 1. JavaScript выключен, сеть заблокирована. Скриншоты подтверждают отрисовку; красота ими автоматически не оценена.</p>
    ${attempts.filter((a) => a.index === 1).flatMap((a) => a.artifacts.filter((e) => e.endsWith('-390.png')).map((e) => `<a href="${escapeHtml(e)}"><img class="thumb" src="${escapeHtml(e)}" alt="${escapeHtml(a.taskId)} при 390 px"></a>`)).join(' ')}
    <p>Node ${escapeHtml(manifest.environment.node)}, ${escapeHtml(manifest.environment.platform)}/${escapeHtml(manifest.environment.arch)}; commit ${escapeHtml(manifest.environment.commit ?? 'нет Git-репозитория')}. Оценка: ${escapeHtml(manifest.evaluationVersion)}. Набор: ${escapeHtml(manifest.suite.version)}.</p>
    <h2>Сохранённые файлы</h2><p>${manifest.artifacts.map((name) => link(name)).join(' · ')}</p><p class="muted">integrity.json содержит SHA-256 артефактов. compare проверяет их перед чтением. Папка запуска не перезаписывается.</p>`;
  return document(`Mock ${manifest.scenario} — Practical Model Bench`, body);
}

function renderPilotRun(run: SavedRun, summary: RunSummary): string {
  const { manifest, calls, attempts } = run, totals = summary.totals;
  const config = 'candidate' in manifest.config ? manifest.config : null;
  const subscription = config?.candidate.subscription;
  return document('Pilot — Practical Model Bench', `<p class="muted">${escapeHtml(manifest.mode)} · billingMode ${escapeHtml(manifest.billingMode)} · ${escapeHtml(manifest.conditions?.executionMode)}</p>
    <h1>Практический pilot</h1><div class="banner">${manifest.synthetic ? 'Synthetic fixtures; это демонстрация, не качество реальной модели.' : 'Малый диагностический набор; результаты не дают уверенного рейтинга.'} Субъективный смысл и дизайн оцениваются отдельно слепым A/B; абсолютная оценка до калибровки pending. Backend проверяет JSON-контракт, сервер не запускается.</div>
    <p>ID: <code>${escapeHtml(manifest.runId)}</code>; система: <code>${escapeHtml(manifest.model)}</code>. Клиент ${escapeHtml(manifest.conditions?.clientVersion ?? 'неизвестен')}. Вход ${escapeHtml(manifest.conditions?.authMethod ?? 'неизвестен')}. Изоляция ${escapeHtml(manifest.conditions?.isolation)}.</p>
    <p>Применённая температура: ${manifest.generation.temperature ?? 'неизвестна'}; reasoning: ${escapeHtml(manifest.generation.reasoning ?? 'неизвестен')}. Запрошенные настройки сохранены отдельно в manifest.config. Гарантия лимита выхода: ${escapeHtml(manifest.conditions?.diagnostic.config.outputTokenLimit ?? (manifest.billingMode === 'api' ? 'API max_tokens' : 'fixtures/данные пользователя'))}.</p>
    <div class="cards">${card('Задач / выполнено', `${summary.taskCount} / ${summary.executedTaskCount}`)}${card('Попыток / полных успехов', `${summary.plannedAttempts} / ${totals.successfulAttempts}`)}${card('Фактическое API списание', sum(totals.incurredCost, true))}${card('Предварительная / API-эквивалент оценка', sum(totals.costs.total, true))}</div>
    <h2>Покрытие 16 категорий</h2>${table(['Категория', 'Задач', 'Покрытие', 'pass / fail / pending / пропуск', 'Авто pass rate', 'Итоговый pass rate', 'API по primaryCategory'], summary.categories.map((c) => row([escapeHtml(c.label), String(c.taskCount), status(c.coverage), `${c.passed}/${c.failed}/${c.pending}/${c.skipped}`, percentage(c.automatedPassRate), percentage(c.passRate), c.taskCount ? sum(c.primaryIncurredCostUsd, true) : '—'])))}
    <h2>Расход и полнота</h2>${table(['input', 'output (включает reasoning)', 'reasoning', 'cache read', 'cache write', 'total'], [row([sum(totals.tokens.input), sum(totals.tokens.output), sum(totals.tokens.reasoning), sum(totals.tokens.cacheRead), sum(totals.tokens.cacheWrite), sum(totals.tokens.total)])])}
    ${table(['Начисления модели', 'Судьи', 'Повторы', 'Всего', 'Фактическая цена полного успеха'], [row([sum(totals.actualCosts.candidateInitial, true), sum(totals.actualCosts.judgeInitial, true), sum(totals.actualCosts.retries, true), sum(totals.actualCosts.total, true), money(totals.incurredCostPerSuccessUsd)])])}
    <p>Запросов API ${totals.apiRequests}; запусков подписочного CLI ${totals.subscriptionRuns}; наблюдаемых шагов ${sum(totals.agentSteps)}; неполный usage ${totals.incompleteUsageCalls}; неполный учёт внутренних повторов/usage ${totals.accountingIncompleteCalls}. Накопительная сводка клиента учитывается один раз.</p>
    <p>Подписка: фиксированная месячная цена ${money(subscription?.fixedMonthlyUsd ?? null)}, доступные токены ${subscription?.availableTokens ?? 'неизвестны'}, известные ограничения ${escapeHtml(subscription?.knownLimits.join('; ') || 'неизвестны')}. Эти данные задаёт пользователь; цена подписки не распределяется как стоимость API вызова. Оценка клиента — API-эквивалент, а не списание.</p>
    <h2>Бюджет до отправки</h2><p>API журнал: лимит ${money(manifest.realBudget.limitUsd)}, известный расход ${money(manifest.realBudget.spentUsd)}, удержанный резерв ${money(manifest.realBudget.reservedUsd)}. Неизвестное начисление требует сверки. Таймзона ${escapeHtml(manifest.timezone)}. Синтетические расходы хранятся отдельно.</p>
    <h2>Попытки</h2>${table(['Задание', 'Статус', 'Проверки', 'Доказательства'], attempts.map((a) => row([escapeHtml(a.attemptId), status(a.status), a.checks.map((c) => `${escapeHtml(c.id)}: ${c.pass ? 'passed' : 'failed'} — ${escapeHtml(c.reason)}`).join('<br>') || escapeHtml(a.reason), a.artifacts.map((p) => link(p)).join('<br>')])))}
    <h2>Маршрут и вызовы</h2>${table(['callId', 'requested / returned model', 'provider / generation ID', 'роль / повтор / шаги', 'начисление / оценка', 'артефакты'], calls.map((c) => row([escapeHtml(c.callId), `${escapeHtml(c.requestedModel)} / ${escapeHtml(c.returnedModel ?? 'неизвестна')}`, `${escapeHtml(c.returnedProvider ?? 'неизвестен')} / ${escapeHtml(c.generationId ?? 'неизвестен')}`, `${c.role}/${c.retryIndex}/${c.agentSteps ?? 'неизвестно'}`, `${money(c.incurredCostUsd)} / ${money(c.modeledCostUsd)}`, c.artifacts.map((p) => link(p)).join('<br>')])))}
    <h2>Артефакты</h2><p>${manifest.artifacts.map((p) => link(p)).join(' · ')}</p><p>Скриншоты: Chromium ${escapeHtml(manifest.browser.version)}, Arial, 1440/390 px; JS отключён, сеть блокируется. Расходы разработки не входят в бенчмарк.</p>`);
}

export function renderComparison(comparison: Comparison): string {
  const body = `<p class="muted">Practical Model Bench · ${escapeHtml(comparison.mode)} · сравнение</p><h1>Baseline → current</h1>
    <div class="banner">${escapeHtml(comparison.uncertainty)}</div>
    <p>Baseline: ${link(`../../${comparison.baselineRunId}/report.html`, comparison.baselineRunId)}<br>Current: ${link(`../../${comparison.currentRunId}/report.html`, comparison.currentRunId)}</p>
    <p>Тип сравнения: ${escapeHtml(comparison.comparisonKind)}. Совпадают настройки оболочки: ${comparison.shellCompatible ? 'да' : 'нет, сравнение систем'}. Набор изменился: ${comparison.suiteChanged ? 'да' : 'нет'}. Версия оценки совпадает: ${comparison.evaluationCompatible ? 'да' : 'нет'}.</p>
    <p>Условия совместимы: ${comparison.conditionsCompatible ? 'да' : 'нет'}; автоматический сигнал разрешён: ${comparison.regressionEligible ? 'да' : 'нет'}; маршрут изменился: ${comparison.routeChanged ? 'да' : 'нет'}; фактические маршруты подтверждены: ${comparison.routesVerified ? 'да' : 'нет'}. Маршруты: ${escapeHtml(JSON.stringify(comparison.routes))}.</p>
    <div class="cards">${card('Совпавших / наблюдаемых задач', `${comparison.matchingTaskCount} / ${comparison.observedTaskCount}`)}${card('Пар оценённых попыток', String(comparison.pairedAttemptCount))}${card('Подозрительных изменений', String(comparison.tasks.filter((t) => t.status === 'suspected').length))}${card('Фактическое списание baseline / current', `${money(comparison.baseline.totals.incurredCostUsd)} / ${money(comparison.current.totals.incurredCostUsd)}`)}</div>
    <p>Исключённые задания: ${escapeHtml(comparison.excludedTaskIds.join(', ') || 'нет')}. Сравниваются совпадающие хеши задания, промпта, материалов, проверок и лимитов; пропуски не становятся провалами.</p>
    ${table(['Задание', 'Пар попыток / пропуски', 'Авто baseline', 'Авто current', 'Изменение', 'Сигнал'], comparison.tasks.map((t) => row([escapeHtml(t.title), `${t.pairedAttempts} / ${t.skippedPairs}`, percentage(t.baselineAutomatedPassRate), percentage(t.currentAutomatedPassRate), delta(t.deltaPercentagePoints), status(t.status)])))}
    <h2>Изменения по категориям</h2><p>Прочерк означает незавершённую оценку или отсутствие задач. Субъективная часть без судьи остаётся pending.</p>${table(['Категория', 'Задач', 'Итог baseline → current', 'Изменение итога', 'Авто baseline → current', 'Изменение авто', 'Итоговые баллы'], comparison.categories.map((c) => row([escapeHtml(c.label), String(c.tasks), `${percentage(c.baselinePassRate)} → ${percentage(c.currentPassRate)}`, delta(c.deltaPassRatePercentagePoints), `${percentage(c.baselineAutomatedPassRate)} → ${percentage(c.currentAutomatedPassRate)}`, delta(c.deltaAutomatedPercentagePoints), `${c.baselineScore === null ? '—' : c.baselineScore.toFixed(3)} → ${c.currentScore === null ? '—' : c.currentScore.toFixed(3)}`])))}
    <h2>Сопоставимый набор: токены и оценка цены</h2>${table(['Показатель', 'Baseline', 'Current'], [
      row(['input', sum(comparison.baseline.totals.tokens.input), sum(comparison.current.totals.tokens.input)]),
      row(['output (включает reasoning)', sum(comparison.baseline.totals.tokens.output), sum(comparison.current.totals.tokens.output)]),
      row(['reasoning', sum(comparison.baseline.totals.tokens.reasoning), sum(comparison.current.totals.tokens.reasoning)]),
      row(['cache read / write', `${sum(comparison.baseline.totals.tokens.cacheRead)} / ${sum(comparison.baseline.totals.tokens.cacheWrite)}`, `${sum(comparison.current.totals.tokens.cacheRead)} / ${sum(comparison.current.totals.tokens.cacheWrite)}`]),
      row(['Цена всех вызовов, с судьёй и повторами', sum(comparison.baseline.totals.costs.total, true), sum(comparison.current.totals.costs.total, true)]),
      row(['Цена успешной попытки', money(comparison.baseline.totals.costPerSuccessUsd), money(comparison.current.totals.costPerSuccessUsd)]),
    ])}<p>Изменение расходов: ${money(comparison.costDeltaUsd)}. При неполных начислениях точная разница не вычисляется.</p>
    <p>${link('comparison.json')} · ${link('integrity.json')}</p>`;
  const judging = comparison.judging ? `<h2>Слепой судья / ручная калибровка</h2><p>${link(`../../evaluations/${comparison.judging.id}/report.html`, 'Оценка и доказательства')}; версия ${escapeHtml(comparison.judging.version)}. Расход судьи включён в current отдельно от candidate. Абсолютные баллы остаются pending; A/B измеряет предпочтение. Споры порядка: ${escapeHtml(comparison.judging.orderDisputes.join(', ') || 'нет')}.</p>${table(['Пара', 'Статус', 'Предпочтение', 'Обоснование'], comparison.judging.pairs.map((p) => row([escapeHtml(p.id), status(p.status), escapeHtml(p.winner ?? 'pending'), escapeHtml(p.reason)])))}` : '';
  return document('Сравнение запусков — Practical Model Bench', body + judging);
}
