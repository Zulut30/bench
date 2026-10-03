export const categoryIds = [
  'frontend', 'ui-design', 'backend', 'sql', 'algorithms', 'debugging',
  'refactoring', 'test-writing', 'architecture', 'devops', 'security',
  'writing', 'editing', 'translation', 'long-context', 'instruction-following',
] as const;

export type CategoryId = (typeof categoryIds)[number];

export const categories: Record<CategoryId, { label: string; measures: string }> = {
  frontend: { label: 'Фронтенд', measures: 'Формы, состояния, взаимодействия, адаптивность' },
  'ui-design': { label: 'Дизайн интерфейсов', measures: 'Иерархия, композиция, типографика, читаемость' },
  backend: { label: 'Бэкенд', measures: 'API, бизнес-логика, обработка ошибок' },
  sql: { label: 'SQL и базы данных', measures: 'Запросы, транзакции, эффективность' },
  algorithms: { label: 'Алгоритмы', measures: 'Корректность, граничные случаи, ресурсы' },
  debugging: { label: 'Исправление багов', measures: 'Устранение причины, отсутствие новых ошибок' },
  refactoring: { label: 'Рефакторинг', measures: 'Сохранение поведения, улучшение структуры' },
  'test-writing': { label: 'Написание тестов', measures: 'Обнаружение внесённых дефектов' },
  architecture: { label: 'Архитектура', measures: 'Ограничения и обоснование решений' },
  devops: { label: 'DevOps', measures: 'Docker, CI и запуск' },
  security: { label: 'Безопасность', measures: 'Заданные уязвимости' },
  writing: { label: 'Написание текстов', measures: 'Факты, структура, ясность' },
  editing: { label: 'Редактура', measures: 'Смысл и голос автора' },
  translation: { label: 'Перевод', measures: 'Смысл, терминология, естественность, полнота' },
  'long-context': { label: 'Длинный контекст', measures: 'Поиск и связывание информации' },
  'instruction-following': { label: 'Следование инструкциям', measures: 'Формат, ограничения, требования' },
};
