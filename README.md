# Practical Model Bench

Практический бенчмарк на TypeScript и promptfoo: локальное mock-демо, небольшой
pilot через OpenRouter или официальные подписочные CLI, ручной импорт из веб-чатов
и слепое A/B-сравнение сохранённых ответов. По умолчанию работает mock.
Во время разработки реальные генерации не запускались и подписочные квоты не расходовались.

## Установка и бесплатная демонстрация

Нужен Node.js 24 LTS; проверено на 24.16.0. Версии зависимостей закреплены в lockfile.
Установка пакетов и Chromium требует интернета. Демо после установки работает локально
без ключей: внешние fetch/HTTP/TCP-запросы Node.js блокируются, IPC разрешён.

```bash
npm ci
npm run browser:install
npm run typecheck
npm test
npm run bench
```

В Linux системные библиотеки браузера можно установить через
`npx playwright install --with-deps chromium` в подготовленном окружении.

`npm run bench` и `npm run bench:demo` создают два различающихся **synthetic** запуска
baseline/current: 10 заданий, по две попытки. В консоли будут `Baseline ID`, `Current ID`
и пути к HTML. Откройте `report.html` в браузере; сервер не нужен.
Демо содержит правильные/ошибочные ответы, технический повтор, reasoning, неполный
usage, кеш провайдера и локальный готовый ответ. Фактические расходы API равны нулю.

```bash
npm run bench -- --baseline <baseline-id> --current <current-id>
npm run bench:compare -- --baseline <baseline-id> --current <current-id>
```

Замените `<...>` напечатанными ID без угловых скобок. Compare читает историю;
новых генераций и судей не вызывает. Каждое сравнение сохраняется отдельно.

## Первый pilot: пять задач

`benchmarks/pilot.json` содержит форму HTML, JSON-контракт пагинации, уведомление
о работах, перевод и страницу тарифов. Реестр сохраняет все 16 категорий.
Пять основных направлений плюс `instruction-following` дают шесть категорий
с заданиями; остальные десять явно показаны как **не покрыто**.

Бэкенд здесь проверяет **JSON-контракт ответа**, не сервер и не серверный код.
HTML/CSS проверяются Playwright в Chromium при 1440×900 и 390×844, с настоящими
скриншотами. JavaScript кандидата, service workers и сеть страницы отключены.
Факты, числа, формат и обязательные элементы проверяются относительно материалов.
Проверки и эталоны в промпт и рабочую папку кандидата не попадают.

```bash
npm run bench -- diagnose
npm run bench -- dry-run --provider mock
npm run bench -- run --provider mock
```

Последняя команда выполняет пять правильных fixtures с одной попыткой и сохраняет
`Run ID`. Для проверки pilot-сравнения выполните её дважды:

```bash
npm run bench -- compare --baseline <первый-run-id> --current <второй-run-id>
```

`dry-run` не генерирует ответы. Для API он получает публичные metadata, показывает
план, верхнюю цену, лимиты и решения резервирования на копии журнала; журнал не меняет.
`--results-dir ./results-pilot` задаёт отдельную историю и отдельный месячный бюджет.

## Подключения и условия

| Provider | Вход / billingMode | Режим и границы |
| --- | --- | --- |
| `mock` | без входа / mock | synthetic fixtures, API = 0 |
| `openrouter` | `OPENROUTER_API_KEY` / api | model-only, закреплённые model ID и endpoint tag |
| `codex-cli` | официальный ChatGPT login / subscription | agent, read-only sandbox, без поиска и пользовательских правил |
| `claude-code` | официальный claude.ai login / subscription | model-only с пустым списком tools; agent с Read/Glob/Grep |
| `gemini-cli` | официальный Google login / subscription | agent; изоляция и ограничения клиента, overage never |
| `manual` | пользовательская веб-сессия / manual | условия заявлены пользователем, usage неизвестен |

API, CLI и веб-чат сохраняются как разные системы. Codex/Gemini не объявляются
model-only, поскольку полное отключение всех инструментов не гарантируется.
Клиенты запускаются через аргументы и stdin с `shell: false`, в новой сессии
и новой временной папке на каждую попытку/повтор. Их JSON/JSONL валидируется.

CLI использует вход официального клиента; бенчмарк не читает OAuth credentials
и не обращается к внутренним API веб-чатов. В окружение дочернего процесса
не передаются API-ключи/токены из процесса бенчмарка. Нужен `sandbox-exec` на macOS
или `bwrap` на Linux; диагностика проверяет песочницу командой `--version`.
Без неё генерация блокируется. macOS блокирует доступ к проекту и results;
Linux дополнительно ограничивает доступные каталоги. Это не универсальная VM:
официальному клиенту необходим доступ к его собственному хранилищу входа.

Конфиги: `configs/pilot-{mock,openrouter,codex-cli,claude-code,gemini-cli,manual}.json`.
Конкретные реальные модели намеренно не выбраны. При необходимости задайте
`executable`, `clientHome`, режим и сведения о подписке в локальной копии конфига.
`.env` автоматически не загружается; `.env.example` содержит только пустое поле ключа.

`diagnose` выполняет только `--version`, `--help`, status официального входа
и/или публичные metadata. Личные данные и credential store не экспортирует.
Доступность конкретной CLI-модели аккаунту без генерации остаётся `unverified`.
Есть отдельные статусы отсутствующего клиента/входа/модели, неверного JSON,
квоты, таймаута, несовместимых флагов, изоляции и изменённого маршрута.
Квота останавливает оставшиеся вызовы; автоматического перехода на платный API нет.

### OpenRouter

Экспортируйте свой `OPENROUTER_API_KEY` в окружение терминала. Ключ не пишется
в конфиги, запросы-артефакты, HTML или логи. Выберите доступный конкретный model ID:

```bash
export MODEL_ID='выбранный-author/model-id'
npm run bench -- diagnose --provider openrouter --model "$MODEL_ID"
```

Без endpoint команда покажет `availableEndpoints` из публичных metadata и статус
`model_missing`. Затем выберите точный `tag`, а не общее имя провайдера:

```bash
export ENDPOINT_TAG='выбранный-endpoint-tag'
npm run bench -- dry-run --provider openrouter --model "$MODEL_ID" --endpoint "$ENDPOINT_TAG" --budget 0.20
npm run bench -- run --provider openrouter --model "$MODEL_ID" --endpoint "$ENDPOINT_TAG" --budget 0.20
```

Последняя команда — реальная платная генерация; запускайте её сами после dry-run.
`run` требует явного `--provider`, API дополнительно требует `--budget > 0`.
Этот аргумент задаёт лимит запуска; конфиг также ограничивает запрос (0.05 USD),
задачу (0.15 USD), месяц (1 USD) и таймзону. Бюджет 0.20 — пример лимита,
не обещание стоимости или достаточности для любого endpoint.

`provider.only/order` содержат единственный tag, `allow_fallbacks: false`,
`require_parameters: true`; router-варианты и автоматическая замена запрещены.
Сохраняются фактически возвращённые model/provider/generation ID, metadata и тариф.
Уход с закреплённого маршрута останавливает следующие запросы.

### Подписочные клиенты

Войдите через собственные официальные команды клиента. Диагностика без генерации:

```bash
npm run bench -- diagnose --provider codex-cli --model "$CODEX_MODEL_ID"
npm run bench -- diagnose --provider claude-code --model "$CLAUDE_MODEL_ID"
npm run bench -- diagnose --provider gemini-cli --model "$GEMINI_MODEL_ID"
```

Переменные должны содержать конкретные IDs, доступные вашему аккаунту, а не
псевдонимы auto/pro/flash/opus/sonnet. Для первого запуска через ChatGPT:

```bash
npm run bench -- dry-run --provider codex-cli --model "$CODEX_MODEL_ID"
npm run bench -- run --provider codex-cli --model "$CODEX_MODEL_ID"
```

Для Claude **сначала отключите Usage credits в аккаунте**, затем в локальной копии
`configs/pilot-claude-code.json` явно задайте
`candidate.subscription.paidOverage: "disabled"`. Пока поле unknown, генерация
получает `subscription_policy_unknown`. Это ваше заявление о состоянии аккаунта:
CLI не раскрывает проверяемый без генерации серверный переключатель.
`DISABLE_EXTRA_USAGE_COMMAND` скрывает команду интерфейса, не отключает биллинг.
`--bare` не используется: он исключает подписочный OAuth-вход.

```bash
npm run bench -- dry-run --provider claude-code --config configs/local-claude.json --model "$CLAUDE_MODEL_ID"
npm run bench -- run --provider claude-code --config configs/local-claude.json --model "$CLAUDE_MODEL_ID"
npm run bench -- run --provider gemini-cli --model "$GEMINI_MODEL_ID"
```

Температура CLI неизвестна (`null`). Для Codex/Claude запрошенное reasoning=none
применяется как effort=low и так записывается; Gemini использует настройки клиента,
reasoning неизвестен. OpenRouter получает точные параметры запроса.
Claude имеет настройку max output; Codex/Gemini проверяют наблюдаемый выход после
ответа. Таймаут, размер stdout и число шагов ограничены до/во время процесса.
Жёсткая провайдерская граница output у этих CLI не заявляется.

### Ручной импорт

```bash
npm run bench -- manual-template --output ./manual-answers.json
npm run bench -- import --input ./manual-answers.json
```

Шаблон содержит точные `prompts` и хеши. В новой веб-сессии для каждой попытки
скопируйте соответствующий промпт, затем заполните ответ, уникальный `sessionId`,
модель, версию/дату веб-клиента, фактические tools и известное время (или null).
Не меняйте promptHash; `newSession` должно быть true. Неисполненные ответы удалите
из answers: они станут пропусками. Повтор сессии, изменённый промпт и model-only
с инструментами отклоняются. Точные usage, списания и скрытые повторы — null;
время обработки импорта отделено от неизвестного времени генерации.

## Судьи и ручная калибровка

Объективные проверки выполняются первыми. Проверка maintenance-текста теперь
отклоняет явные отрицания/противоречия, включая «Остальные функции не будут работать».
Правильные перефразировки принимаются; неопределённый смысл не объявляется доказанным.
Смысл уведомления, естественность перевода и дизайн сохраняют `pending`.
Непроведённая оценка имеет null, а не нулевой балл.

Судьи запускаются отдельной командой по сохранённой baseline/current-паре.
Они имеют **отдельный явный API-бюджет**: кандидатский запуск не вызывает их автоматически.
Скопируйте `configs/pilot-judges.json` в `configs/local-judges.json`; задайте конкретные
`judges.text.model/providerEndpoint` и/или `judges.vision.model/providerEndpoint`.
Не используемый тип судьи оставьте null. Нужен OPENROUTER_API_KEY.

```bash
npm run bench -- evaluate --baseline <baseline-id> --current <current-id> --config configs/local-judges.json --budget 0.10 --limit-pairs 1
npm run bench -- compare --baseline <baseline-id> --current <current-id> --evaluation <evaluation-id>
```

Без подходящего text/vision-судьи вердикт pending, запросов нет. Пара с объективным
провалом/пропуском или несовместимыми условиями не отправляется судье.
Кандидатские названия моделей скрыты, A/B выбирается случайно; судья получает
задачу, источники и версионированную рубрику. Сохраняются порядок, причина и строгий
вердикт A/B/tie/insufficient_data. Для vision нужны четыре настоящих PNG: A/B, ПК/телефон.
`--swap-order` повторяет оценку в обратном порядке в пределах maxJudgeCalls/бюджета;
разные победители показываются как спор. При maxRetries=1 два порядка могут не
поместиться в лимит 2 вызова: для калибровки задайте maxRetries=0.

A/B — относительное предпочтение. Оно не превращает исходный pending в фиктивный
абсолютный успех/балл. Оценка сохраняется отдельно, история кандидатов не меняется.
Отчёт оценки содержит страницы `*-blind.html` для ручной проверки. Начните
с небольшой выборки (ориентир 10% и спорные пары), затем создайте reviews.json:

```json
{
  "reviewer": "ваш-идентификатор",
  "reviews": [
    { "pairId": "maintenance-notice-a1-text-order1", "verdict": "tie", "reason": "Оба ответа сохраняют факты и смысл" }
  ]
}
```

```bash
npm run bench -- calibrate --evaluation <evaluation-id> --input ./reviews.json
```

Ручные решения и agreement/null сохраняются отдельным неизменяемым артефактом.
Калибровка не объявляется проведённой до импорта реальных ручных решений.

## Usage, деньги и бюджет

Для каждого вызова сохраняются исходный usage, inputTotal/outputTotal, reasoning,
cacheRead/cacheWrite, источник/полнота, роль candidate/judge, retry, agentSteps,
clientVersion, модель/маршрут, applied/requested настройки, время и артефакты.
Неизвестные поля — null. Итог — только inputTotal + outputTotal:

| Адаптер | Правило включения |
| --- | --- |
| OpenRouter / Codex | кеш уже в input, reasoning уже в output |
| Claude | обычный input + cache read + cache write; output без повторного reasoning |
| Gemini | prompt + tool-input; candidates + thoughts; cached уже в prompt |
| mock | synthetic input включает кеш, output включает reasoning |

Сводки Claude/Gemini и финальная сводка одного Codex exec учитываются один раз;
промежуточные сообщения/дублирующие modelUsage/roles не суммируются с ними.
Внутренние повторы, которые клиент не раскрывает, остаются неизвестными.
Сохраняется сырой поток для проверки предположений после смены версии клиента.

`billingMode` отделяет api/subscription/manual/mock. Для API usage.cost — фактическое
списание; modeledCostUsd — отдельно расчёт по опубликованному тарифу токенов.
Дополнительные request/image charges учитываются в резерве, а точная итоговая сумма
берётся из actual cost. Для Claude total_cost_usd — только API-эквивалентная оценка.
Подписочная генерация не является отдельным API-списанием этого проекта (API = 0);
fixedMonthlyUsd, availableTokens и knownLimits задаёт пользователь и видит отдельно.
Остаток подписочной квоты не выдумывается и автоматически не запрашивается.
Mock-токены и деньги synthetic, manual точных начислений не заявляет.

Агрегация дедуплицирует callId и считает расходы по primaryCategory, не по сумме
пересекающихся оценок. Модель, судья, повторы, agent steps и общее списание видны
отдельно. Цена полного успеха включает все попытки того же набора и судью;
при нуле успехов/неизвестных начислениях — null. Расходы разработки сюда не входят.

До POST резервируется верхняя цена **всего опубликованного контекста endpoint**
(включая возможные изображения), максимального выхода и разрешённых повторов.
Это консервативный резерв: даже короткая задача может не поместиться в маленький
лимит endpoint с большим/дорогим контекстом. Dry-run показывает это заранее.
Unknown tariff/upper bound блокирует API. Одновременные вызовы видят общие резервы.

Журналы `.api-budget.json` и `.synthetic-budget.json` несовместимы и раздельны.
Общий `.bench.lock` защищает историю и журнал от параллельных процессов в одном
results-dir. Используйте **один results-dir для общего API-бюджета**: разные каталоги
не имеют общего lock/месячного лимита. Известное списание замещает резерв; unknown
удерживает его до сверки. Начисление выше резерва замораживает журнал.
Отказ бюджета до отправки — `budget_exhausted`, не провал качества.
При аварии не удаляйте lock до проверки PID; автоматического сброса/сверки денег нет.
Биллинг внешних вызовов по тому же ключу этот локальный журнал не контролирует.

## История и сравнение

```text
results/
  .api-budget.json / .synthetic-budget.json
  <run-id>/
    manifest.json, calls.jsonl, attempts.jsonl, summary.json
    promptfoo.json, prompts/*.txt, responses/*.{txt,json}
    checks/*.json, screenshots/*.png, report.html, integrity.json
  evaluations/evaluation-<uuid>/
    evaluation.json, calls.jsonl, summary.json, report.html
    *-blind.html, *-judge-request.json, responses/, integrity.json
  calibrations/calibration-<uuid>/calibration.json
  comparisons/compare-<uuid>/{comparison.json,report.html,integrity.json}
```

Файлы создаются без перезаписи. Перед чтением истории проверяется SHA-256 integrity;
это обнаружение изменений, не криптографическая подпись. При аварии сохраняется
failure.json и частичные артефакты. Manifest фиксирует хеши задач/промптов/материалов,
commit, зависимости, реализацию, браузер, клиента, tools, настройки и лимиты.

Сравниваются совпадающие задания и попытки. Для pilot несовместимые версии клиента,
tools, режимы, настройки/окружение исключают автоматическое сравнение качества.
Изменение requested/actual маршрута показано отдельно; неизвестная actual-модель/
провайдер, как часто у Codex, не даёт автоматического сигнала регрессии.
Manual всегда исключён из автоматического сигнала. Разные оболочки отмечаются
как сравнение систем. Пропуски не превращаются в ошибки качества, расходы остаются.
Один слабый ответ даёт максимум suspected; нужна свежая повторная попытка.
Кеш готовых ответов promptfoo отключён, зависимости повторов и неопределённость видны.

## Проверки и оставшиеся ограничения

`npm test` проверяет нормализацию/двойной счёт, бюджет/резервы/месяц, агрегацию,
maintenance-отрицания и парафразы, настоящее promptfoo-демо, артефакты/lock/HTML,
локальный HTTP и fake CLI: успех, отсутствие usage, auth/quota/model error, timeout,
неверный JSON, закрепление маршрута, новые сессии, отсутствие ключей/доступа к эталонам,
бюджет до POST, слепое A/B/реальные PNG, смену порядка, ручной импорт и калибровку.

На этой машине диагностированы Codex CLI 0.147.0 и Claude Code 2.1.257;
Gemini CLI отсутствует. Реальные генерации через них и OpenRouter не проверялись
по требованию пользователя. Проверена macOS-изоляция; Linux требует bubblewrap
и отдельной проверки в целевом окружении. Флаги несовместимого клиента блокируют запуск.

Набор из пяти задач диагностический. Полный набор 40–50, выполнение серверных проектов,
надёжная изоляция произвольного кода, подтверждённые реальные замеры, мониторинг,
SQLite и веб-панель остаются дальнейшей работой.

Зависимости сохранены на фиксированных версиях; статус npm audit и принятые решения
описаны в [docs/decisions.md](docs/decisions.md), план — в [docs/roadmap.md](docs/roadmap.md).

Официальные источники: [promptfoo Node API](https://www.promptfoo.dev/docs/usage/node-package/),
[OpenRouter routing](https://openrouter.ai/docs/guides/routing/provider-selection),
[OpenRouter usage](https://openrouter.ai/docs/guides/guides/usage-accounting),
[Codex non-interactive](https://developers.openai.com/codex/noninteractive),
[Codex config](https://developers.openai.com/codex/config-reference),
[Claude CLI](https://code.claude.com/docs/en/cli-reference),
[Claude costs](https://code.claude.com/docs/en/costs),
[Gemini headless](https://geminicli.com/docs/cli/headless/),
[Gemini configuration](https://geminicli.com/docs/reference/configuration/).
Документация также проверялась через Context7; флаги установленных клиентов — через --help.
