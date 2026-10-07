function exitCode(value) {
  return Number.isInteger(value) && value > 0x7fffffff ? value - 0x100000000 : value;
}

function diagnoseFailure(output, code, signal) {
  if (output.includes('NeoForgeVersionCheck') && output.includes('getStatus()')) {
    return 'NeoForge упал при проверке обновлений в главном меню. Это ошибка версии загрузчика. Откройте отчёт для подробностей.';
  }
  if (/OutOfMemoryError|Could not reserve enough space|Failed to allocate/i.test(output)) {
    return 'Minecraft не хватило памяти. Закройте лишние программы и проверьте выделенную память в настройках.';
  }
  if (/ModLoadingException|LoadingFailedException|Incompatible mods found|Mod resolution encountered an incompatible mod set/i.test(output)) {
    return 'Обнаружены несовместимые моды или отсутствующие зависимости. Подробности находятся в отчёте игры.';
  }
  return 'Minecraft завершился с кодом ' + (exitCode(code) ?? signal ?? '?') + '. Откройте отчёт или журнал игры, чтобы узнать причину.';
}

module.exports = { exitCode, diagnoseFailure };
