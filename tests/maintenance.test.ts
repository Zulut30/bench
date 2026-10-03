import { describe, expect, it } from 'vitest';
import { maintenanceCheck, assess } from '../src/checks.js';
import { readJson } from '../src/storage.js';
import { projectRoot } from '../src/runner.js';
import { responsesSchema } from '../src/mock-provider.js';
import { join } from 'node:path';
import { task } from './helpers.js';

const original = responsesSchema.parse(readJson(join(projectRoot, 'fixtures/mock-responses.json')))['maintenance-notice']!.correct;
const replace = (sentence: string) => original.replace('Остальные функции продолжают работать.', sentence);
describe('Уведомление: объективные ограничения и смысл', () => {
  it.each(['Остальные функции не будут работать.', 'Остальные функции не работают.', 'Остальные функции будут недоступны.',
    'Остальные функции перестанут работать.', 'Остальные функции будут отключены.',
    'Остальные функции продолжают работать, но они недоступны.', 'Остальные функции работают. Другие функции не работают.'])('отвергает противоречие: %s', (sentence) => {
    expect(maintenanceCheck(replace(sentence))).toMatchObject({ pass: false, semanticStatus: 'contradiction' });
  });
  it.each(['Все другие возможности сервиса остаются доступными.', 'Остальные функции будут работать без перебоев.',
    'Остальные функции не будут отключены.', 'Остальные функции не перестанут работать.',
    'Другие разделы сервиса продолжат работу в обычном режиме.'])('принимает перефразировку объективно, смысл pending: %s', (sentence) => {
    expect(maintenanceCheck(replace(sentence))).toMatchObject({ pass: true, semanticStatus: 'pending' });
  });
  it('не объявляет неоднозначный смысл доказанным и сохраняет ручную рубрику', () => {
    const result = maintenanceCheck(replace('Остальные функции могут быть доступны частично.'));
    expect(result.semanticStatus).toBe('pending'); expect(result.reason).toContain('требуется судья');
    const t = task('maintenance-notice');
    const checks = t.checks.map((c) => ({ ...c, pass: result.pass, score: result.pass ? 1 : 0, reason: result.reason, evidence: [] }));
    expect(assess(t, checks)).toMatchObject({ status: 'pending' });
  });
  it('выявляет положительное противоречие недоступности экспорта и нарушения точных ограничений', () => {
    expect(maintenanceCheck(original.replace('экспорт CSV будет недоступен', 'экспорт CSV будет доступен')).pass).toBe(false);
    expect(maintenanceCheck(original.replace('02:30', '03:30')).pass).toBe(false);
    expect(maintenanceCheck(original.replace('Плановые работы', 'Ничего не происходит')).pass).toBe(false);
  });
});
