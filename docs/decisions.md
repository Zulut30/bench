# Решения этапа 1

Дата: 03.10.2026. Выполнение последовательное; ключи и платные запросы не используются.

1. **promptfoo — движок.** Один `evaluate()` на запуск, явный объект `MockProvider`,
   функции JavaScript assertions, `maxConcurrency: 1`, `cache: false`,
   `sharing: false`, `writeLatestResults: false`. Собственный CLI не заменяет цикл
   исполнения promptfoo. Внутреннюю БД promptfoo не включаем; экспортируем его
   `toEvaluateSummary()` в JSON. Телеметрия, обновления и удалённая генерация
   отключены до динамического импорта. Конфигурационный каталог временный.
   В 0.123.1 отключение телеметрии всё равно вызывает opt-out event. Поэтому
   на время mock дополнительно запрещаем внешние fetch/HTTP/TCP-запросы Node.js,
   сохраняя локальный IPC. После выполнения восстанавливаем функции процесса.
2. **Явные повторные попытки.** Две запланированные попытки каждого задания заданы
   как два случая promptfoo. Внутри одной попытки provider может сделать только
   оговорённый технический повтор `mock_temporary_unavailable`. Провал проверки
   качества повтор не вызывает. Каждый вызов получает собственный callId и ответ.
3. **Mock usage — отдельный контракт.** Input включает кеш, output — reasoning.
   Тариф синтетический, reasoning повторно не тарифицируется. Отсутствующее поле
   остаётся null. Исторический usage локального ответа сохранён, но новая генерация
   равна нулю. Отдельные реальные адаптеры нельзя строить переносом этих правил
   без проверки документации их API.
4. **Раздельные деньги.** Только синтетический журнал и лимиты mock; настоящий
   API-бюджет и расходы равны нулю. Суммы строятся по уникальным callId.
   Судья учитывается в типах и агрегации, но в демо его не создаём и не имитируем.
5. **Резерв целой попытки.** Верхняя цена входа использует самый дорогой тариф
   обычного входа/кеша, выход ограничен maxOutputTokens и уже включает reasoning.
   Все разрешённые повторы включены в конверт. Последующие вызовы расходуют его,
   не увеличивая доступный бюджет. Неизвестные начисления удерживают остаток.
   Атомарные синхронные изменения сохраняются через временный JSON + rename.
   Один lock в results-dir защищает общий журнал от двух процессов. Это бюджет
   данного проекта; для настоящих денег потребуется сверка с биллингом.
6. **Простые объективные проверки.** Native HTML формы/FAQ и HTML макеты проверяем
   Chromium с настоящими скриншотами. API в демо — JSON-контракт, а не выполнение
   неизвестного кода. Текст — фиксированные источники/глоссарии и обязательные
   факты. Рубрики дизайна, стиля и естественности сохраняются как pending.
7. **Изоляция HTML.** JS кандидата запрещён, сеть страницы и service workers
   заблокированы. Chromium имеет временный HOME/TMPDIR и окружение без ключей.
   Скрытые проверки выполняет наш Node.js-код через Playwright; их нет в промпте.
   Это ограниченный HTML-режим, не универсальная песочница для произвольного кода.
8. **История.** Уникальная новая папка, файлы создаются с `wx`, manifest сохраняет
   набор/проверки/лимиты, промпты и хеши материалов, исходников/fixtures, lockfile,
   Node/платформу, браузер и commit (null вне Git). integrity.json обнаруживает
   изменения до compare. При аварии сохраняем частичные данные и failure.json.
9. **Сопоставимость.** Качество сравниваем по общей части заданий и оценённых пар
   попыток с одинаковым индексом. Расходы учитывают все парные попытки, включая
   технические ошибки. Смена рубрики исключает качество, смена окружения/оболочки
   маркирует сравнение систем. Negative delta имеет статус suspected; число
   повторов не используется как число независимых задач. Статистики уверенности
   в первом этапе нет.
10. **Зафиксированные зависимости.** promptfoo 0.123.1, Playwright 1.63.0,
    Vitest 5.0.3, TypeScript 7.0.2, Zod 4.6.5, tsx 4.23.15, Node 24.16.0.
    npm audit сообщил 10 high в цепочке promptfoo. Автоматический downgrade
    promptfoo или небезопасная подмена вложенных пакетов не выполнялись;
    устранение этих advisories отслеживается перед расширением доверенной границы.

Источники API: [Node package](https://www.promptfoo.dev/docs/usage/node-package/),
[Node API reference](https://www.promptfoo.dev/docs/usage/node-api-reference/),
[Custom JavaScript provider](https://www.promptfoo.dev/docs/providers/custom-api/).
Дополнительно использован Context7 `/promptfoo/promptfoo` и проверены типы
локально установленного пакета; схема не выведена из устаревшего примера CLI.

## Решения pilot и подключений

Дата: 03.10.2026. Этап реализован поверх работающего mock; зависимости сохранены.
Реальные модельные запросы и подписочные генерации при разработке не выполнялись.

1. **Единый интерфейс, один движок.** ModelConnection диагностирует клиента,
   выполняет один транспортный вызов и предоставляет тариф/верхнюю границу.
   promptfoo по-прежнему выполняет задания и JavaScript assertions. Собственный
   CallExecutor ведёт изоляцию, резерв, разрешённые технические повторы и артефакты.
   HTTP 429 передаётся с metadata.rateLimitKind=quota: локальный исходник promptfoo
   0.123.1 подтвердил, что без этого scheduler автоматически повторяет custom provider.
   Регрессионный тест проверяет ровно один POST и остановку всех судей.
2. **Строгий запуск.** Demo остаётся default. Для run обязателен явный provider,
   для API — положительный --budget. Diagnose/dry-run не генерируют ответы.
   Candidate и judge оплачиваются в разных запусках; evaluate имеет собственный
   бюджет и включает только объективно допустимые пары сохранённых результатов.
3. **OpenRouter.** Только публичный API, model ID + конкретный endpoint tag,
   only/order, allow_fallbacks=false, require_parameters=true, max_price.
   Endpoint metadata получается без ключа и сохраняет тариф/дату. Резерв по всему
   опубликованному max_prompt/context + max output + request/image charges + retries;
   неизвестные дополнительные платные параметры блокируют запуск. Поэтому резерв
   может быть намного выше предполагаемой цены короткой задачи.
   usage.cost — actual API, токенный расчёт — отдельная предварительная оценка.
4. **Официальные CLI.** Args/stdin без shell, JSON/JSONL, свежая сессия и папка,
   подписочный login управляется клиентом. Вход через API-key несовместим.
   Не читаем OAuth и не имитируем веб-API. Codex --ephemeral/ignore-user-config/
   ignore-rules/read-only; Claude safe-mode/restricted/empty tools/no MCP/hooks/
   no session persistence; Gemini oauth-personal/overage never/maxSessionTurns.
   Claude --bare не используется. --help подтверждает необходимые флаги перед запуском.
5. **Граница подписки.** Claude может использовать Usage credits на сервере;
   отключение команды credits в интерфейсе не отключает расход. До заявления
   пользователя subscription.paidOverage=disabled клиент блокируется. Это заявление,
   а не автоматическая проверка переключателя аккаунта. Для Codex вход принудительно
   chatgpt; Gemini API-key env не передаётся и тип входа принудительно oauth-personal.
   Квота прекращает весь этап без смены провайдера и платного fallback.
6. **Изоляция и режим.** macOS sandbox-exec запрещает чтение/запись проекта/results;
   Linux bwrap монтирует системные пути и нужные каталоги официального клиента,
   закрывает protected paths. Работоспособность проверяется --version. Без изоляции
   запрос не отправляется. Это ограничение рабочих файлов, не полная защита VM.
   Codex/Gemini маркируются agent, Claude без tools и API — model-only.
   Fake CLI на macOS подтвердил отсутствие доступа к fixtures/проверкам и ключам env.
7. **Применённые параметры.** Requested config хранится отдельно от фактических
   параметров. CLI temperature=null; Codex/Claude none→low; Gemini reasoning=null.
   Claude max output — настройка клиента, Codex/Gemini output — наблюдаемый предел,
   плюс обязательный timeout/шаги/размер потока. Жёсткий output cap без поддержки
   клиента не заявляется. Actual model отсутствует у многих Codex exec JSONL:
   поле null, автоматический regression signal запрещён.
8. **Usage.** OpenRouter/Codex input и output уже содержат cache/reasoning. Claude
   добавляет cache read/write к обычному input. Gemini prompt + tool-input и
   candidates + thoughts; cached — подмножество prompt. Учитываем итоговые сводки,
   не суммируем промежуточные assistant/modelUsage/roles. Hidden retries — null.
   Claude total_cost_usd имеет смысл API-эквивалентной оценки подписочного вызова.
   Доступные токены/ограничения/фиксированная месячная подписка задаются пользователем.
9. **Бюджет и неизвестное.** Раздельные namespace api/synthetic; общий lock и журнал
   для одного results-dir. Конверт включает retries до отправки, конкурентные calls
   видят резерв. Неизвестная цена удерживает резерв; overcharge замораживает журнал.
   Требуется сверка с биллингом; автоматического удаления/сброса неизвестных нет.
10. **Честные проверки.** Maintenance regex обнаруживает явные противоречия,
    но формат/факты и смысл разделены; неоднозначное pending. Pilot backend только
    JSON-контракт. Рубрики текста/перевода/дизайна не заменены фиктивным судьёй.
11. **A/B.** Случайный порядок, одинаковые источники/рубрика, JSON A/B/tie/
    insufficient_data + причина, настоящие четыре PNG для vision. Оценки и ручные
    проверки сохраняются отдельно от кандидатов. Swap-order показывает спор,
    calibration — совпадение вердиктов/unknown. A/B остаётся относительным:
    абсолютные категории в исходной истории не получают искусственный pass.
12. **Сопоставимость.** Версии, tools, режим, config hash, окружение и actual route
    определяют допустимость автоматического сигнала. Разные условия исключают
    парное качество; цены остаются. Manual — заявленные условия, токены неизвестны,
    автоматического регрессионного сигнала нет. Только suspected, без уверенного
    рейтинга по пяти задачам и объяснений внутренних причин поведения модели.
13. **Проверка текущего этапа.** Локальные HTTP/fake CLI, настоящий promptfoo,
    JSON/PNG/HTML, бюджет и изоляция. Установленные Codex 0.147.0 / Claude 2.1.257
    проверены только диагностически; Gemini отсутствует. Linux/native live генерации
    ещё не подтверждены. Повторный npm audit: 10 high, те же транзитивные цепочки;
    audit fix --force и неподтверждённые overrides не применялись.

Документация и официальные источники:
[OpenRouter endpoint metadata](https://openrouter.ai/docs/api/api-reference/endpoints/list-endpoints),
[routing](https://openrouter.ai/docs/guides/routing/provider-selection),
[usage](https://openrouter.ai/docs/guides/guides/usage-accounting),
[Codex exec](https://developers.openai.com/codex/noninteractive),
[config](https://developers.openai.com/codex/config-reference),
[Claude CLI](https://code.claude.com/docs/en/cli-reference),
[settings](https://code.claude.com/docs/en/settings),
[costs](https://code.claude.com/docs/en/costs),
[Gemini headless](https://geminicli.com/docs/cli/headless/),
[configuration](https://geminicli.com/docs/reference/configuration/).
Context7 использован для promptfoo, OpenRouter и Gemini; flags проверены локальным help,
Gemini cumulative stats дополнительно сверены с официальным исходником uiTelemetry.
