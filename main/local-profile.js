function validPlayerName(value, anySymbols = false) {
  if (typeof value !== 'string') return false;
  if (!anySymbols) return /^[A-Za-z0-9_]{3,16}$/.test(value);
  const length = Array.from(value).length;
  return length >= 1 && length <= 32 && value.trim().length > 0 && !/\p{Cc}/u.test(value);
}
module.exports = { validPlayerName };
