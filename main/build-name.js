function buildName(value, instances, excludeId = '') {
  if (value == null) value = '';
  if (typeof value !== 'string' || value.trim().length > 40 || value.trim().length === 1) throw new Error('Название: от 2 до 40 символов. Можно оставить пустым');
  if (value.trim()) return value.trim();
  const used = new Set(instances.filter(item => item.id !== excludeId).map(item => item.name.toLocaleLowerCase('ru')));
  let number = 1, name = 'Сборка';
  while (used.has(name.toLocaleLowerCase('ru'))) name = 'Сборка ' + ++number;
  return name;
}
module.exports = { buildName };
