# Установка v1

Node.js 24.16.0 задан в `.nvmrc` и package engines. npm устанавливает точные версии
по `package-lock.json`; контейнер имеет собственный `sandbox/package-lock.json`.
Сборка образа загружает закреплённые digest Node и Playwright и фиксированные npm-пакеты.
Код кандидата ничего не скачивает: `--network none`, только заранее собранный образ.

## macOS

Docker Desktop можно использовать с текущим Docker context. Альтернатива — Colima:

```bash
brew install colima docker
colima start --profile bench --cpu 2 --memory 3 --disk 20 --mount none --activate=false
export DOCKER_CONTEXT=colima-bench
npm ci
npm run browser:install
npm run sandbox:build
npm run release:check
```

Контекст выбирается переменной либо `sandbox.dockerContext` в локальном конфиге;
не меняйте общий Docker context, если он нужен другим проектам. Colima использует
отдельную VM; каталог проекта и домашняя папка в проверяющий контейнер не монтируются.
Docker Desktop не требует Colima. Для подписочных генераций нужен штатный
`/usr/bin/sandbox-exec`; diagnose проверяет его. Повторную установку не делать без причины.

## Linux

Нужны Docker daemon/CLI, поддержка cgroups и user namespaces, bubblewrap и Chromium:

```bash
sudo apt-get update
sudo apt-get install -y bubblewrap
npm ci
npx playwright install --with-deps chromium
npm run sandbox:build
npm run release:check
```

Если системная политика блокирует bubblewrap, CLI получает isolation_unavailable
и не генерирует. Настройку политики выполняйте в своём подготовленном окружении;
бенчмарк сам sysctl не меняет. GitHub Actions использует отдельный ephemeral runner
с разрешёнными user namespaces. Docker-проверки работают отдельно от bubblewrap.

## Диагностика без генераций

```bash
node --version
npm --version
docker version
npm run bench -- diagnose --provider mock
npm run bench -- dry-run --provider mock --profile standard
```

Без образа dry-run сообщает isolation_unavailable. Не выполняется автоматический
pull во время проверки: сборка — отдельная команда. Локальный тег образа перед
запуском разрешается в image ID, который сохраняется в manifest и проверках.

`npm ci` может предупреждать о транзитивных deprecated packages/advisories.
Не запускайте audit fix --force: предложенный downgrade promptfoo несовместим
с проверенными предположениями scheduler. Оценка остаточных advisories — в readiness.
`.env.example` не содержит ключей и не загружается автоматически.

## Перенос истории

Не удаляйте `results/`, `.bench.sqlite`, его WAL/SHM при работающем процессе или
старый `.api-budget.json`. Для резервного копирования закрывайте процессы бенчмарка
и копируйте весь results-dir целиком; export отдельного запуска не переносит общий
месячный бюджет для дальнейших оплат. Старый JSON-журнал переносится автоматически
один раз, оригинал и его хеш сохраняются. Изменённый оригинал блокирует новые запросы.

Linux amd64 и macOS arm64 используют разные image IDs/окружения. Их A/B возможно,
но автоматический мониторинг между платформами запрещён. Windows/WSL и rootless
Docker отдельно не аттестованы. Для Windows нужен подготовленный Linux executor.
