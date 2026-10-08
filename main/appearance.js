const DEFAULT_APPEARANCE = { transparency: 0, brightness: 100, blur: 18 };
const limits = { transparency: [0, 60], brightness: [30, 150], blur: [0, 40] };
function appearance(value, strict = false) {
  const result = { ...DEFAULT_APPEARANCE };
  for (const [key, [min, max]] of Object.entries(limits)) {
    if (value?.[key] === undefined) continue;
    const number = value[key];
    if (!Number.isInteger(number) || number < min || number > max) {
      if (strict) throw new Error('Некорректное значение настройки фона: ' + key);
      continue;
    }
    result[key] = number;
  }
  return result;
}
module.exports = { DEFAULT_APPEARANCE, appearance };
