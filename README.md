# Practical Model Bench · v1

Локальный CLI на TypeScript и **promptfoo**: практические задания, проверка кода
в контейнере, учёт usage и бюджета, история JSON/JSONL/PNG, статический HTML,
сравнение моделей/систем и отдельное слепое A/B. По умолчанию — бесплатное mock-демо.
08.10.2026 по явному запросу пользователя выполнен подписочный прогон Codex CLI
с `xhigh` на 16 заданиях для четырёх моделей. Платные API и ИИ-судьи не вызывались.
Условия и ограничения: [подписочный эксперимент](docs/chatgpt-xhigh-2026-10-08.md).
Статус интеграций и ограничения: [готовность v1](docs/readiness.md).

## Установка

Нужны Node.js **24.16.0**, npm, Docker с работающим daemon и Chromium.
Версии пакетов, контейнерных зависимостей и базовых образов закреплены.
Установка пакетов/образов требует интернета; mock после установки работает локально.

```bash
npm ci
npm run browser:install
npm run sandbox:build
npm run typecheck
npm test
npm run bench:smoke
```

Linux: сначала установите `bubblewrap` для CLI-подключений и библиотеки браузера:
`npx playwright install --with-deps chromium`. macOS: Docker Desktop либо Colima.
В этой рабочей папке подготовлен отдельный Colima-профиль `bench` без host mounts;
его контекст выбирается явно: `export DOCKER_CONTEXT=colima-bench`.
Установка и платформенные ограничения описаны в [docs/setup.md](docs/setup.md).
`npm test` действительно исполняет код и браузер: отсутствие контейнера — ошибка,
а не молчаливый пропуск. Windows-подключения CLI пока не поддерживаются.

## Демонстрация и наборы

```bash
npm run bench                         # два прежних demo-запуска baseline/current
npm run bench:demo
npm run bench:smoke                   # 6 коротких практических задач, 1 попытка
npm run bench:standard -- --attempts 2 # 16 категорий, 32 попытки
```

Demo сохраняет 10 задач × 2 попытки с правильными/ошибочными ответами, retries,
reasoning, неполным usage, provider cache и локальным ответом из кеша.
В консоли — `Baseline ID`, `Current ID`, ссылки на отчёты. API-расходы mock = **0 USD**;
моделируемые цены synthetic показаны отдельно. Это не рейтинг реальных моделей.

```bash
npm run bench -- --baseline <baseline-id> --current <current-id>
npm run bench:compare -- --baseline <baseline-id> --current <current-id>
```

Подставьте напечатанные IDs без угловых скобок. HTML открывается как обычный файл,
сервер не нужен. Каждое сравнение сохраняется отдельно, генераций не вызывает.

`benchmarks/standard.json` содержит **16 независимых заданий**, одно primary на
категорию. Каждое имеет версию, фиксированные материалы, критерии, рубрику, лимиты,
два разных правильных примера и содержательный пример дефекта. Все **48 примеров**
проверяются тестами. Smoke выбирает frontend/backend/sql/writing/translation/
instruction-following; оставшиеся 10 категорий показывает как непокрытые.
`--profile pilot` сохраняет совместимость со старым набором из пяти задач.

| Проверка | Что реально исполняется |
| --- | --- |
| frontend | TypeScript strict + Playwright: ошибки/успех/повтор формы, 1440/390 px, PNG |
| backend | Node HTTP-сервер: пагинация, пустая страница, неверные параметры, 400/404/405 |
| SQL / security | SQLite на фиксированных данных; LEFT JOIN, нули, SQL injection |
| algorithms / debugging / refactoring | Граничные примеры, отсутствие мутации входа / сохранение поведения |
| test-writing | Исправная shipping-функция и 4 заранее внесённых дефекта; измеряется обнаружение |
| DevOps | Контракт Dockerfile и реальный start.sh/health; кандидатский Dockerfile не собирается |
| текст / редактура / перевод / архитектура / дизайн | Источники, числа, формат, обязательные элементы; субъективное pending |
| long-context / instruction-following | Связывание фактов из фиксированных материалов / строгий JSON |

Одна задача на категорию даёт диагностику, не статистически надёжный рейтинг.
Для полного замера остаётся расширить набор до 40–50 задач. Автоматические pass rate
и субъективные оценки разделены; непроведённое имеет null/pending.

## Команды на каждый день

```bash
npm run bench -- diagnose --provider mock
npm run bench -- dry-run --provider mock --profile standard --attempts 2
npm run bench -- run --provider mock --profile smoke
npm run bench -- resume --run <run-id>
npm run bench -- compare --baseline <id> --current <id>
npm run bench -- export --run <id> --output ./export-unique
```

Run требует явного `--provider`, по умолчанию выбирает smoke. `--attempts 1–10`,
`--tasks v1-sql,v1-backend`, `--profile smoke/standard/pilot`, `--config <JSON>`
и `--results-dir <путь>` задают условия. Локальные конфиги `configs/local-*.json`
исключены из Git. `.env` автоматически не загружается, ключей в репозитории нет.

События состояний и ошибок — JSON в stderr; итог и пути — stdout.
Коды: **0** — завершённый прогон (включая объективный провал/pending), **2** —
аргументы/невосстановленная ошибка, **3** — подключение/формат/изоляция, **4** —
бюджет, **5** — квота, **6** — таймаут, **7** — in_doubt, **130** — Ctrl+C.
Провал задания — измеренный результат, технический пропуск — отсутствие оценки.

Ctrl+C останавливает транспорт, сохраняет вызовы и план. `resume` использует
исходные настройки и ту же папку: completed/failed не генерируются повторно,
planned/reserved продолжаются. **Dispatched без надёжного результата → in_doubt**:
автоматической повторной отправки нет. Изменившийся код измерений блокирует resume;
данные доступны для сверки/экспорта. Экспорт требует новую папку; у незавершённого
запуска включает `recovery-state.json`, у завершённого проверяет integrity.

## Первый ограниченный реальный прогон

Выберите модель и точный endpoint самостоятельно; встроенного выбора платной модели нет.
Подключения OpenRouter, Codex CLI, Claude Code, Gemini CLI и manual реализованы.
Codex CLI проверен реальными подписочными вызовами; остальные подключения
**не проверены реальными генерациями**. Следующие API-команды запускаются пользователем.

Экспортируйте `OPENROUTER_API_KEY` в своём терминале, затем:

```bash
export MODEL_ID='выбранный-author/model-id'
npm run bench -- diagnose --provider openrouter --model "$MODEL_ID"
export ENDPOINT_TAG='точный-tag-из-availableEndpoints'
npm run bench -- dry-run --provider openrouter --model "$MODEL_ID" --endpoint "$ENDPOINT_TAG" --profile smoke --tasks v1-writing --attempts 1 --budget 0.05
npm run bench -- run --provider openrouter --model "$MODEL_ID" --endpoint "$ENDPOINT_TAG" --profile smoke --tasks v1-writing --attempts 1 --budget 0.05
npm run bench -- reconcile --run <run-id>
```

Diagnose/dry-run не вызывают генераций. Бюджет 0.05 — предел, не обещание цены:
если dry-run отказал, запрос не отправится. Лимиты конфига дополнительно ограничивают
запрос (0.05), задачу (0.15), месяц (1 USD, Europe/Warsaw). `only/order`, отключённые
fallback и compression/plugins фиксируют маршрут; actual model/provider/ID сохраняются.
Резерв включает выход/reasoning, максимальную ставку обычного/cache-входа,
request/image fees и разрешённые retries. Неизвестные платные параметры и нетекстовый
выход (image/audio) блокируются.

Если framing конкретного upstream неизвестен, честный fallback — его context limit.
Literal raw Llama3 byte-bound доказан на локальном HTTP-контракте; семейство tokenizer
само по себе **не позволяет уменьшить реальный резерв OpenRouter**. Подробности в
[решениях v1](docs/decisions.md). Dry-run показывает метод и числовые spent/reserved/
next/limit каждого отказа, не меняя бюджет.

`reconcile` выполняет **GET /generation**, не генерацию. При terminal total_cost
начисление сверяется в SQLite, неизвестный резерв освобождается. Исходные артефакты
остаются прежними; результат сверки сохраняется в `reconciliations/`.
Без ID/окончательной цены резерв удерживается. Найдите ID в OpenRouter Activity:

```json
{"calls":[{"callId":"точный-callId-из-events/SQLite","generationId":"gen-..."}]}
```

```bash
npm run bench -- reconcile --run <id> --input ./generation-mapping.json
```

Сверяйте JSON с Activity/биллингом. Сбой до получения ID нельзя доказательно назвать
бесплатным; резерв вручную не удаляйте. Списания других проектов по тому же ключу
местный журнал не контролирует. Для одного бюджета используйте один results-dir.

## Подписочные CLI и ручной импорт

Официальный вход остаётся в клиенте. Бенчмарк не читает OAuth credentials, не
передаёт env-ключи и не переходит на платный API. Генерация идёт в новой сессии/
временной папке с sandbox-exec (macOS) или bubblewrap (Linux); без изоляции блокируется.
Полученный код отдельно выполняется в Docker, куда хранилище входа не попадает.
Codex/Gemini маркируются **agent**, Claude без tools и OpenRouter — **model-only**.
Температура CLI неизвестна; Codex/Claude reasoning=none применяется как low.
Codex/Gemini output cap наблюдаемый, жёсткая гарантия провайдера не заявляется.

`generation.reasoning` принимает `xhigh`; Codex получает его без понижения.
Для длительного reasoning конфиг допускает до 300 000 ms ожидания и 32 768 выходных
токенов, включая reasoning. Фактический предел — минимум лимита задания и конфига.
Исходный standard сохраняет свои короткие лимиты; для другого режима создавайте
отдельную версию набора с явными лимитами и одинаковыми условиями для всех моделей.
Предел выполнения полученного кода остаётся 60 000 ms.

```bash
npm run bench -- diagnose --provider codex-cli --model "$CODEX_MODEL_ID"
npm run bench -- dry-run --provider codex-cli --model "$CODEX_MODEL_ID" --tasks v1-writing --attempts 1
npm run bench -- run --provider codex-cli --model "$CODEX_MODEL_ID" --tasks v1-writing --attempts 1
```

Нужны конкретные доступные model IDs. Для Claude сначала отключите **Usage credits**
в аккаунте, затем укажите `candidate.subscription.paidOverage: "disabled"` в своей
копии `configs/pilot-claude-code.json`. Это заявление пользователя, серверный флаг
CLI проверить не умеет; unknown блокирует генерацию. `--bare` не используется.
Gemini требует oauth-personal и отключённый overage. Квота останавливает дальнейшие
вызовы; доступные токены и цена подписки задаются пользователем, не угадываются.

```bash
npm run bench -- manual-template --output ./manual-answers.json
npm run bench -- import --input ./manual-answers.json
```

Шаблон фиксирует промпты/хеши; каждый ответ — новая веб-сессия. Заполните модель,
tools, версию веб-клиента и известное время/null. Manual usage и скрытые вызовы
неизвестны; импорт отделяет время обработки от времени генерации.

## Слепые судьи и сравнение

Скопируйте `configs/pilot-judges.json` в `configs/local-judges.json`; задайте реальные
`judges.text`/`judges.vision` model+endpoint, ненужный тип оставьте null.
Судьи имеют **отдельный явный API-бюджет** и работают по сохранённым ответам:

```bash
npm run bench -- evaluate --baseline <id> --current <id> --config configs/local-judges.json --budget 0.05 --limit-pairs 1 --swap-order
npm run bench -- compare --baseline <id> --current <id> --evaluation <evaluation-id>
npm run bench -- calibrate-sample --evaluation <evaluation-id>
npm run bench -- calibrate --evaluation <evaluation-id> --input ./reviews.json
```

Судья получает A/B без названий моделей, случайный порядок, задачу/источники и
версионированную рубрику. Vision получает настоящие PNG A/B при 1440/390 px.
JSON-вердикты: A/B/tie/insufficient_data + причина. Смена порядка выявляет споры.
Без судьи — pending; объективный провал/пропуск или другая рубрика исключает пару.
**Разные модели, endpoint и CLI допустимы для A/B**, различия систем показываются.
A/B — относительное предпочтение, не абсолютный pass/балл.

`calibrate-sample` случайно выбирает около 10% уникальных пар задача/попытка
и все споры, сохраняя слепые страницы и `reviews-template.json`. Заполните копию
шаблона: reviewer, verdict, reason; импортируйте через calibrate. Незаполненные
null не принимаются. Ручная калибровка не объявляется выполненной автоматически.

Compare разделяет модели, системы и мониторинг. Регрессия требует совпадения
клиента/инструментов/параметров/проверок/окружения и подтверждённого actual route.
Manual/unknown route не даёт автоматического сигнала. Оформление HTML не входит
в fingerprint измерений. Совпадающие задачи сопоставляются независимо от числа
попыток; разброс и независимое число задач видимы. Отрицательная разница — suspected:

```bash
npm run bench -- rerun --comparison <compare-id> --attempts 3 --budget 0.05
```

Это явная команда **свежих генераций** затронутых задач, с новым run ID, без кеша
готовых ответов. Для mock бюджет не нужен. Сама по себе отрицательная разница
не подтверждает ухудшение и не устанавливает внутреннюю причину поведения модели.

## Учёт, сохранность и проверки

InputTotal включает весь вход и кеш; outputTotal весь выход с reasoning.
Итог = input + output; подмножества не прибавляются повторно. Для Claude кеш
добавляется к обычному input; Gemini — prompt + tool и candidates + thoughts.
Каждый клиент нормализуется отдельно, финальные сводки не складываются с событиями.
Unknown — null. API actual, оценки кандидата/судьи/retries, API-эквивалент и фиксированная
подписка показаны отдельно; цена успеха неопределена при нуле полных успехов.

`.bench.sqlite` (WAL/FULL) хранит транзакционные бюджеты, вызовы, планы, оценки и
PID/token lease. Фазы planned/reserved/dispatched/completed/failed/in_doubt сохраняются
до транспорта; reserve + переход и settlement + charge атомарны. Старый JSON-журнал
мигрируется идемпотентно с проверкой хеша и сохранением оригинала. Неизвестные
начисления удерживают резерв, превышение границы замораживает дальнейшие расходы.

Папки запуска неизменяемы: manifest, plan, responses, calls/attempts/events JSONL,
checks, PNG, promptfoo summary, HTML, integrity. Атомарная публикация не заменяет
файлы истории. Resume восстанавливает оборванный хвост собственного незавершённого
журнала из SQLite, сохраняя повреждённые байты. Завершённая история проверяется хешами.

```bash
npm run typecheck
npm test
npm run release:check
```

Тесты: 48 примеров, UTF-8 по байтам, учёт/cache/reasoning, preflight refusal,
параллельные процессы, SIGKILL на всех фазах, восстановление/сверка/unknown,
квота/таймаут/неверный JSON, Ctrl+C, разные CLI/A-B/PNG, контейнерные ограничения,
fresh rerun и неизменность экспорта/истории. GitHub Actions проверяет чистую установку,
Docker/Chromium, typecheck, тесты и mock-smoke **без внешних генераций**.
На дату проверки 04.10.2026 npm audit показывал 3 high сообщения одной транзитивной
цепочки node-forge/jks-js/promptfoo без доступного исправленного forge.
Ограничения и дата проверки перечислены в docs/readiness.md.
