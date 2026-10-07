(() => {
"use strict";

if (window.__veyraRendererInitialized) return;
window.__veyraRendererInitialized = true;

const launcher = window.launcher;
const el = (id) => document.getElementById(id);
const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
let viewTransitionToken = 0;
let motionUiInitialized = false;

const ui = {
  state: null,
  operation: null,
  progress: null,
  error: false,
  settingsDirty: false,
  versionKey: "",
  toastTimer: null,
  cancelling: false,
  cancelRequested: false,
  logs: [],
};

const controls = {
  playerName: el("player-name"),
  versionSelect: el("version-select"),
  mainAction: el("main-action"),
  mainActionLabel: el("main-action-label"),
  mainActionIcon: el("main-action-icon"),
  actionHint: el("action-hint"),
  javaPath: el("java-path"),
  memoryGb: el("memory-gb"),
  gameDirectory: el("game-directory"),
  showSnapshots: el("show-snapshots"),
  saveSettings: el("save-settings"),
};

function getSettings() {
  return ui.state?.settings || {};
}

function getVersions() {
  const versions = Array.isArray(ui.state?.versions) ? ui.state.versions : [];
  return versions.filter((version) => getSettings().showSnapshots || version.type !== "snapshot");
}

function selectedVersion() {
  return getVersions().find((version) => version.id === controls.versionSelect.value) || null;
}

function validPlayerName(name) {
  return /^[A-Za-z0-9_]{3,16}$/.test(name.trim());
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(date);
}

function friendlyError(error) {
  return error?.message || String(error || "Неизвестная ошибка. Попробуйте ещё раз.");
}

function showError(message) {
  ui.error = true;
  el("error-message").textContent = message || "Неизвестная ошибка. Попробуйте ещё раз.";
  el("error-banner").hidden = false;
  renderHeader();
}

function dismissError() {
  ui.error = false;
  el("error-banner").hidden = true;
  renderHeader();
}

function showToast(message) {
  const toast = el("toast");
  toast.textContent = message;
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add("is-visible"));
  window.clearTimeout(ui.toastTimer);
  ui.toastTimer = window.setTimeout(() => {
    toast.classList.remove("is-visible");
    window.setTimeout(() => {
      if (!toast.classList.contains("is-visible")) toast.hidden = true;
    }, 480);
  }, 3200);
}

function renderMiniLogs() {
  const root = el("mini-logs");
  if (!root) return;
  root.replaceChildren();
  const items = ui.logs.length ? ui.logs.slice(0, 5) : [{ message: "Veyra готова к работе", level: "ok", time: "сейчас" }];
  for (const item of items) {
    const row = document.createElement("div");
    const dot = document.createElement("i");
    dot.className = item.level || "ok";
    const time = document.createElement("time");
    time.textContent = item.time || "сейчас";
    const text = document.createElement("span");
    text.textContent = item.message;
    row.append(dot, time, text);
    root.append(row);
  }
}

function pushLog(message, level = "ok") {
  if (!message) return;
  if (ui.logs[0]?.message === message) return;
  const now = new Date();
  ui.logs.unshift({
    message,
    level,
    time: new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(now),
  });
  ui.logs = ui.logs.slice(0, 8);
  renderMiniLogs();
}

function setActivity(message, level = "ok") {
  el("last-activity").textContent = message;
  const line = document.querySelector(".activity-line");
  if (line && !prefersReducedMotion?.matches) {
    line.classList.remove("is-bumping");
    void line.offsetWidth;
    line.classList.add("is-bumping");
  }
  pushLog(message, level);
}

async function setView(view) {
  const next = view === "settings" ? "settings" : "play";
  const nextView = el(`${next}-view`);
  const currentView = [el("play-view"), el("settings-view")].find((node) => node && !node.hidden);
  const token = ++viewTransitionToken;

  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === next;
    button.classList.toggle("is-active", active && button.classList.contains("nav-link"));
    if (button.classList.contains("nav-link")) {
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  });

  if (currentView === nextView) {
    animateViewElements(nextView);
    return;
  }

  const reduced = Boolean(prefersReducedMotion?.matches);
  if (currentView && !reduced) {
    currentView.classList.add("is-view-transitioning");
    const exit = currentView.animate([
      { opacity: 1, transform: "translate3d(0,0,0) scale(1)", filter: "blur(0px)" },
      { opacity: 0, transform: "translate3d(0,-9px,0) scale(.992)", filter: "blur(5px)" },
    ], { duration: 190, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" });
    try { await exit.finished; } catch {}
    exit.cancel();
    currentView.classList.remove("is-view-transitioning");
  }

  if (token !== viewTransitionToken) return;
  el("play-view").hidden = next !== "play";
  el("settings-view").hidden = next !== "settings";
  document.querySelector(".content")?.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });

  if (!reduced) {
    nextView.classList.add("is-view-transitioning");
    const enter = nextView.animate([
      { opacity: 0, transform: "translate3d(0,14px,0) scale(.988)", filter: "blur(7px)" },
      { opacity: 1, transform: "translate3d(0,0,0) scale(1)", filter: "blur(0px)" },
    ], { duration: 520, easing: "cubic-bezier(.16,1,.3,1)" });
    try { await enter.finished; } catch {}
    nextView.classList.remove("is-view-transitioning");
  }
  animateViewElements(nextView);
}

function renderHeader() {
  const status = document.querySelector(".header-status");
  const text = el("header-status-text");
  status.classList.toggle("is-error", ui.error);
  status.classList.toggle("is-ready", Boolean(ui.state?.versions?.length) && !ui.error);

  if (ui.error) text.textContent = "Требуется внимание";
  else if (!ui.state) text.textContent = "Подключение…";
  else if (ui.state.running) text.textContent = "Игра запущена";
  else if (ui.state.busy || ui.operation) text.textContent = "Идёт подготовка";
  else if (ui.state.versions?.length) text.textContent = "Версии доступны";
  else text.textContent = "Список пуст";

  el("refresh-button").disabled = !launcher || !ui.state || Boolean(ui.state.busy || ui.operation);
}

function renderVersions() {
  const versions = getVersions();
  const settings = getSettings();
  const key = JSON.stringify({ items: versions.map((item) => [item.id, item.installed]), snapshots: settings.showSnapshots });
  const current = controls.versionSelect.value;

  if (key !== ui.versionKey) {
    controls.versionSelect.replaceChildren();
    if (!versions.length) {
      controls.versionSelect.add(new Option("Нет доступных версий", ""));
    } else {
      for (const version of versions) {
        const suffix = version.installed ? " · установлена" : "";
        const type = version.type === "snapshot" ? " · снимок" : "";
        controls.versionSelect.add(new Option(`${version.id}${type}${suffix}`, version.id));
      }
    }
    const desired = versions.some((version) => version.id === current) ? current : settings.selectedVersion;
    controls.versionSelect.value = versions.some((version) => version.id === desired) ? desired : (versions[0]?.id || "");
    ui.versionKey = key;
  }

  controls.versionSelect.disabled = !versions.length || Boolean(ui.state?.busy);
  const selected = selectedVersion();
  const meta = el("version-meta");
  if (selected) {
    const type = selected.type === "snapshot" ? "Тестовая версия" : "Стабильная версия";
    const installed = selected.installed ? "установлена" : "не установлена";
    const date = formatDate(selected.releaseTime);
    meta.textContent = [type, installed, date].filter(Boolean).join(" · ");
  } else if (ui.state?.versions?.length && !settings.showSnapshots) {
    meta.textContent = "Включите снимки в настройках или обновите список версий";
  } else {
    meta.textContent = "Обновите список версий, чтобы продолжить";
  }
}

function renderProgress() {
  const progress = ui.progress;
  const installing = ui.operation === "install" || (ui.state?.busy && progress);
  const box = el("installation-progress");
  box.hidden = !installing;
  if (!installing) return;

  const total = Number(progress?.total);
  const completed = Number(progress?.completed);
  const determinate = Number.isFinite(total) && total > 0 && Number.isFinite(completed) && completed >= 0;
  const percent = determinate ? Math.min(100, Math.max(0, Math.round((completed / total) * 100))) : null;
  const track = el("progress-track");
  track.classList.toggle("is-indeterminate", percent === null);
  if (percent === null) {
    track.removeAttribute("aria-valuenow");
    el("progress-percent").textContent = "";
    el("progress-fill").style.width = "30%";
  } else {
    track.setAttribute("aria-valuenow", String(percent));
    el("progress-percent").textContent = `${percent}%`;
    el("progress-fill").style.width = `${percent}%`;
  }
  el("progress-title").textContent = progress?.phase || "Подготовка установки…";
  el("progress-message").textContent = progress?.message || "Загружаем необходимые файлы";
}

function renderAction() {
  const selected = selectedVersion();
  const name = controls.playerName.value.trim();
  const busy = Boolean(ui.state?.busy || ui.operation);
  const running = Boolean(ui.state?.running);
  const button = controls.mainAction;
  const hint = controls.actionHint;
  const cancel = el("cancel-button");

  button.classList.toggle("is-busy", busy);
  cancel.hidden = !(ui.operation === "install" && ui.state?.busy);
  cancel.disabled = ui.cancelling;

  if (!ui.state) {
    button.disabled = true;
    controls.mainActionLabel.textContent = "Подключение…";
    hint.textContent = "Связываемся с лаунчером";
  } else if (running) {
    button.disabled = true;
    controls.mainActionLabel.textContent = "Игра запущена";
    hint.textContent = "Вернитесь после завершения игры";
  } else if (busy) {
    button.disabled = true;
    controls.mainActionLabel.textContent = ui.operation === "install" ? "Установка…" : ui.operation === "launch" ? "Запуск…" : "Подождите…";
    hint.textContent = ui.operation === "refresh" ? "Обновляем список версий" : "Операция выполняется";
  } else if (!selected) {
    button.disabled = true;
    controls.mainActionLabel.textContent = "Нет версии";
    hint.textContent = "Нажмите ↻, чтобы обновить список";
  } else if (!validPlayerName(name)) {
    button.disabled = true;
    controls.mainActionLabel.textContent = selected.installed ? "Играть" : "Установить версию";
    hint.textContent = "Введите имя: 3–16 латинских букв, цифр или _";
  } else {
    button.disabled = false;
    controls.mainActionLabel.textContent = selected.installed ? "Играть" : "Установить версию";
    hint.textContent = selected.installed ? "Версия готова к запуску" : "Файлы версии будут загружены на компьютер";
  }
  controls.mainActionIcon.textContent = selected?.installed ? "▶" : "↓";
}

function renderSettings() {
  if (!ui.settingsDirty) {
    const settings = getSettings();
    controls.javaPath.value = settings.javaPath || "";
    controls.memoryGb.value = settings.memoryGb ?? 4;
    controls.gameDirectory.value = settings.gameDirectory || "";
    controls.showSnapshots.checked = Boolean(settings.showSnapshots);
  }
  controls.saveSettings.disabled = !ui.state || Boolean(ui.operation || ui.state.busy);
  el("quick-memory").textContent = `${getSettings().memoryGb ?? 4} ГБ`;
  const java = getSettings().javaPath;
  el("quick-java").textContent = java ? "Java выбрана" : "Java по умолчанию";
  const directory = getSettings().gameDirectory;
  el("quick-directory").textContent = directory ? directory.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || directory : "Папка по умолчанию";
  el("open-folder-home").disabled = !ui.state;
  el("open-folder-settings").disabled = !ui.state;
}

function renderDashboard() {
  const settings = getSettings();
  const selected = selectedVersion();
  const versionId = selected?.id || settings.selectedVersion || "—";
  const installed = Boolean(selected?.installed);
  const memory = `${settings.memoryGb ?? 4} ГБ`;
  const javaText = settings.javaPath ? (settings.javaPath.split(/[\\/]/).pop() || "Выбрана") : "Авто";
  const running = Boolean(ui.state?.running);

  document.querySelector(".hero-card")?.classList.toggle("is-running", running);
  const title = installed ? `Vanilla ${versionId}` : `Minecraft ${versionId}`;
  el("hero-title").textContent = title;
  el("hero-version").textContent = versionId === "—" ? "Minecraft" : `Minecraft ${versionId}`;
  el("hero-path").textContent = settings.gameDirectory || "Локальная сборка Veyra";
  el("hero-memory").textContent = memory;
  el("hero-java").textContent = javaText;
  el("hero-profile").textContent = settings.playerName || "Локальный";
  el("instance-card-title").textContent = title;
  el("instance-card-version").textContent = versionId === "—" ? "Версия не выбрана" : `${versionId} · Vanilla`;
  el("instance-card-status").textContent = running ? "Игра запущена" : installed ? "Готово к запуску" : "Требуется установка";
  el("running-status").textContent = running ? "Запущена" : "Не запущена";
  el("sidebar-java").textContent = javaText;
  el("sidebar-memory").textContent = memory;
  el("sidebar-versions").textContent = String(ui.state?.versions?.length || 0);
  el("perf-ram").textContent = `${settings.memoryGb ?? 4} GB`;
  el("memory-fill").style.width = `${Math.min(100, Math.max(8, ((settings.memoryGb ?? 4) / 16) * 100))}%`;
  el("app-version").textContent = ui.state?.appVersion || "0.1.0";

  const folder = settings.gameDirectory;
  el("storage-used").textContent = folder ? (folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder) : "Папка игры";
  el("storage-total").textContent = `${ui.state?.versions?.filter((v) => v.installed).length || 0} установлено`;
  el("storage-fill").style.width = `${Math.min(100, Math.max(10, (ui.state?.versions?.filter((v) => v.installed).length || 0) * 8))}%`;

  const runningAction = el("running-action");
  runningAction.disabled = running || controls.mainAction.disabled;
  runningAction.textContent = running ? "● Игра уже запущена" : installed ? "▶ Запустить игру" : "↓ Установить и запустить";
  el("quick-install").textContent = installed ? "▶  Запустить выбранную версию" : "↓  Установить выбранную версию";
}

function render() {
  if (ui.state && document.activeElement !== controls.playerName) controls.playerName.value = getSettings().playerName || "";
  renderHeader();
  renderVersions();
  renderAction();
  renderProgress();
  renderSettings();
  renderDashboard();
}

function applyState(state) {
  if (!state || typeof state !== "object") return;
  const wasRunning = Boolean(ui.state?.running);
  ui.state = state;
  if (state.running && !wasRunning) setActivity("Minecraft запущен");
  else if (!state.running && wasRunning) setActivity("Игра завершена");
  if (!state.busy && ui.operation === "install") ui.progress = null;
  render();
}

async function syncState() {
  if (!launcher) return;
  applyState(await launcher.getState());
}

async function refreshVersions() {
  if (!launcher || ui.operation || ui.state?.busy) return;
  dismissError();
  ui.operation = "refresh";
  setActivity("Обновляем список версий…");
  render();
  try {
    await launcher.refreshVersions();
    await syncState();
    setActivity("Список версий обновлён");
  } catch (error) {
    showError(`Не удалось обновить версии: ${friendlyError(error)}`);
    setActivity("Список версий не обновлён");
  } finally {
    ui.operation = null;
    render();
  }
}

async function savePlayerAndVersion() {
  const playerName = controls.playerName.value.trim();
  const selectedVersionId = controls.versionSelect.value;
  if (!validPlayerName(playerName)) throw new Error("Имя игрока должно содержать 3–16 латинских букв, цифр или _.");
  if (!selectedVersionId) throw new Error("Сначала выберите версию Minecraft.");
  await launcher.saveSettings({ playerName, selectedVersion: selectedVersionId });
  await syncState();
  return selectedVersionId;
}

async function performMainAction() {
  if (!launcher || !ui.state || ui.state.busy || ui.state.running || ui.operation) return;
  const version = selectedVersion();
  if (!version) return;
  dismissError();
  ui.operation = version.installed ? "launch" : "install";
  ui.progress = null;
  ui.cancelRequested = false;
  setActivity(version.installed ? "Запускаем Minecraft…" : `Устанавливаем версию ${version.id}…`);
  render();
  try {
    const versionId = await savePlayerAndVersion();
    if (version.installed) {
      await launcher.launchVersion(versionId);
      if (ui.state?.running) setActivity("Minecraft запущен");
    } else {
      await launcher.installVersion(versionId);
      await syncState();
      const installed = Boolean(ui.state?.versions?.find((item) => item.id === versionId)?.installed);
      if (installed) {
        setActivity(`Версия ${versionId} установлена`);
        showToast("Версия установлена. Теперь можно играть.");
      } else if (ui.cancelRequested) setActivity("Установка отменена");
    }
  } catch (error) {
    if (ui.cancelRequested) setActivity("Установка отменена");
    else {
      showError(friendlyError(error));
      setActivity("Операция завершилась с ошибкой");
    }
  } finally {
    try { await syncState(); } catch (error) { showError(friendlyError(error)); }
    ui.operation = null;
    ui.progress = null;
    ui.cancelRequested = false;
    render();
  }
}

async function cancelInstall() {
  if (!launcher || ui.operation !== "install") return;
  ui.cancelling = true;
  ui.cancelRequested = true;
  renderAction();
  setActivity("Отменяем установку…");
  try {
    const accepted = await launcher.cancelInstall();
    if (!accepted) {
      ui.cancelRequested = false;
      setActivity("Отмена пока недоступна. Попробуйте ещё раз.");
      return;
    }
    await syncState();
    setActivity("Установка отменена");
  } catch (error) {
    ui.cancelRequested = false;
    showError(`Не удалось отменить установку: ${friendlyError(error)}`);
  } finally {
    ui.cancelling = false;
    renderAction();
  }
}

async function saveSettings() {
  if (!launcher || !ui.state || ui.state.busy || ui.operation) return;
  const memoryGb = Number(controls.memoryGb.value);
  if (!Number.isInteger(memoryGb) || memoryGb < 1 || memoryGb > 64) {
    showError("Выберите объём памяти от 1 до 64 ГБ.");
    controls.memoryGb.focus();
    return;
  }
  const partial = {
    javaPath: controls.javaPath.value.trim(),
    memoryGb,
    gameDirectory: controls.gameDirectory.value.trim(),
    showSnapshots: controls.showSnapshots.checked,
  };
  if (!partial.showSnapshots && getSettings().selectedVersion) {
    const selected = ui.state.versions?.find((version) => version.id === getSettings().selectedVersion);
    if (selected?.type === "snapshot") {
      partial.selectedVersion = ui.state.versions?.find((version) => version.type !== "snapshot")?.id || "";
    }
  }
  dismissError();
  ui.operation = "save";
  controls.saveSettings.textContent = "Сохраняем…";
  render();
  try {
    await launcher.saveSettings(partial);
    ui.settingsDirty = false;
    await syncState();
    showToast("Настройки сохранены");
    setActivity("Настройки запуска сохранены");
  } catch (error) {
    showError(`Не удалось сохранить настройки: ${friendlyError(error)}`);
  } finally {
    ui.operation = null;
    controls.saveSettings.textContent = "Сохранить настройки";
    render();
  }
}

function extractPath(result) {
  if (typeof result === "string") return result;
  if (typeof result?.path === "string") return result.path;
  if (typeof result?.filePath === "string") return result.filePath;
  if (typeof result?.filePaths?.[0] === "string") return result.filePaths[0];
  return null;
}

async function pickPath(kind) {
  if (!launcher) return;
  const input = kind === "java" ? controls.javaPath : controls.gameDirectory;
  const setting = kind === "java" ? "javaPath" : "gameDirectory";
  try {
    const result = kind === "java" ? await launcher.pickJava() : await launcher.pickGameDirectory();
    const path = extractPath(result);
    if (path) {
      input.value = path;
      ui.settingsDirty = true;
    } else {
      const fresh = await launcher.getState();
      const changed = fresh?.settings?.[setting];
      if (changed && changed !== getSettings()[setting]) {
        input.value = changed;
        ui.settingsDirty = true;
      }
      applyState(fresh);
    }
  } catch (error) {
    showError(`Не удалось выбрать файл или папку: ${friendlyError(error)}`);
  }
}

async function openGameDirectory() {
  if (!launcher) return;
  try { await launcher.openGameDirectory(); }
  catch (error) { showError(`Не удалось открыть папку игры: ${friendlyError(error)}`); }
}

function animateViewElements(root) {
  if (!root || prefersReducedMotion?.matches) return;
  const items = [...root.querySelectorAll([
    ".hero-card",
    ".library-panel",
    ".side-panel",
    ".settings-header",
    ".settings-card",
    ".settings-footer",
    ".activity-line",
  ].join(","))];
  items.forEach((node, index) => {
    node.classList.remove("veyra-reveal");
    node.style.setProperty("--reveal-delay", `${Math.min(index, 14) * 42}ms`);
    void node.offsetWidth;
    node.classList.add("veyra-reveal");
  });
}

function addRipple(event) {
  const host = event.currentTarget;
  if (!(host instanceof HTMLElement) || host.matches(":disabled")) return;
  const rect = host.getBoundingClientRect();
  const ripple = document.createElement("span");
  ripple.className = "veyra-ripple";
  ripple.style.left = `${event.clientX - rect.left}px`;
  ripple.style.top = `${event.clientY - rect.top}px`;
  host.append(ripple);
  ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
}

function bindMagnetic(element, strength = 8) {
  if (!element || prefersReducedMotion?.matches) return;
  element.classList.add("veyra-magnetic");
  element.addEventListener("pointermove", (event) => {
    const rect = element.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width - .5) * strength;
    const y = ((event.clientY - rect.top) / rect.height - .5) * strength;
    element.style.setProperty("--mag-x", `${x.toFixed(2)}px`);
    element.style.setProperty("--mag-y", `${y.toFixed(2)}px`);
  });
  element.addEventListener("pointerleave", () => {
    element.style.setProperty("--mag-x", "0px");
    element.style.setProperty("--mag-y", "0px");
  });
}

function bindTilt(element, amount = 3.6) {
  if (!element || prefersReducedMotion?.matches) return;
  element.classList.add("veyra-tilt");
  if (!element.querySelector(":scope > .veyra-tilt-glow")) {
    const glow = document.createElement("span");
    glow.className = "veyra-tilt-glow";
    element.append(glow);
  }
  element.addEventListener("pointermove", (event) => {
    const rect = element.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width;
    const py = (event.clientY - rect.top) / rect.height;
    element.style.setProperty("--tilt-y", `${((px - .5) * amount).toFixed(2)}deg`);
    element.style.setProperty("--tilt-x", `${((.5 - py) * amount).toFixed(2)}deg`);
    element.style.setProperty("--glow-x", `${(px * 100).toFixed(1)}%`);
    element.style.setProperty("--glow-y", `${(py * 100).toFixed(1)}%`);
  });
  element.addEventListener("pointerleave", () => {
    element.style.setProperty("--tilt-x", "0deg");
    element.style.setProperty("--tilt-y", "0deg");
    element.style.setProperty("--glow-x", "50%");
    element.style.setProperty("--glow-y", "50%");
  });
}

function setupHeroParallax() {
  const hero = document.querySelector(".hero-card");
  if (!hero || prefersReducedMotion?.matches) return;
  hero.addEventListener("pointermove", (event) => {
    const rect = hero.getBoundingClientRect();
    const px = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const py = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    const x = (px - .5) * -10;
    const y = (py - .5) * -8;
    hero.style.setProperty("--pointer-x", `${(px * 100).toFixed(1)}%`);
    hero.style.setProperty("--pointer-y", `${(py * 100).toFixed(1)}%`);
    hero.style.setProperty("--hero-x", `${x.toFixed(2)}px`);
    hero.style.setProperty("--hero-y", `${y.toFixed(2)}px`);
    hero.style.setProperty("--hero-cx", `${(-x * .22).toFixed(2)}px`);
    hero.style.setProperty("--hero-cy", `${(-y * .22).toFixed(2)}px`);
  });
  hero.addEventListener("pointerleave", () => {
    hero.style.setProperty("--pointer-x", "50%");
    hero.style.setProperty("--pointer-y", "50%");
    hero.style.setProperty("--hero-x", "0px");
    hero.style.setProperty("--hero-y", "0px");
    hero.style.setProperty("--hero-cx", "0px");
    hero.style.setProperty("--hero-cy", "0px");
  });
}

function setupCursorAura() {
  if (prefersReducedMotion?.matches) return;
  const aura = document.createElement("div");
  aura.className = "cursor-aura";
  document.body.append(aura);
  let targetX = -999;
  let targetY = -999;
  let currentX = -999;
  let currentY = -999;
  let raf = 0;

  const renderAura = () => {
    currentX += (targetX - currentX) * .15;
    currentY += (targetY - currentY) * .15;
    aura.style.transform = `translate3d(${currentX}px, ${currentY}px, 0) translate(-50%, -50%)`;
    if (Math.abs(targetX - currentX) > .15 || Math.abs(targetY - currentY) > .15) raf = requestAnimationFrame(renderAura);
    else raf = 0;
  };

  window.addEventListener("pointermove", (event) => {
    targetX = event.clientX;
    targetY = event.clientY;
    aura.classList.add("is-visible");
    if (!raf) raf = requestAnimationFrame(renderAura);
  }, { passive: true });
  window.addEventListener("pointerleave", () => aura.classList.remove("is-visible"));
  document.addEventListener("pointerover", (event) => {
    aura.classList.toggle("is-hot", Boolean(event.target.closest("button, .instance-card, .hero-card, input, select")));
  });
}

function setupAmbientParticles() {
  if (prefersReducedMotion?.matches) return;
  const layer = document.createElement("div");
  layer.className = "ambient-particles";
  for (let i = 0; i < 14; i += 1) {
    const particle = document.createElement("span");
    particle.className = "ambient-particle";
    particle.style.setProperty("--x", `${7 + ((i * 23) % 88)}%`);
    particle.style.setProperty("--y", `${5 + ((i * 37) % 90)}%`);
    particle.style.setProperty("--size", `${1 + (i % 3)}px`);
    particle.style.setProperty("--duration", `${8 + (i % 5) * 2.1}s`);
    particle.style.setProperty("--delay", `${-(i * .83)}s`);
    layer.append(particle);
  }
  document.body.append(layer);
}

function setupMotionUi() {
  if (motionUiInitialized) return;
  motionUiInitialized = true;
  document.body.classList.add("veyra-ready");

  document.querySelectorAll("button").forEach((button) => {
    button.classList.add("veyra-ripple-host");
    button.addEventListener("pointerdown", addRipple);
  });

  document.querySelectorAll([
    ".top-primary",
    ".top-secondary",
    ".play-button",
    ".save-settings",
    ".quick-action",
    ".square-button",
    ".back-button",
    ".running-action",
  ].join(",")).forEach((node) => bindMagnetic(node));

  document.querySelectorAll([
    ".instance-card:not(.ghost-card)",
    ".side-panel",
    ".settings-card",
    ".sidebar-card",
  ].join(",")).forEach((node) => bindTilt(node));

  document.querySelectorAll(".nav-item").forEach((item) => {
    item.addEventListener("pointermove", (event) => {
      const rect = item.getBoundingClientRect();
      item.style.setProperty("--nav-x", `${event.clientX - rect.left}px`);
      item.style.setProperty("--nav-y", `${event.clientY - rect.top}px`);
    });
  });

  setupHeroParallax();
  setupCursorAura();
  setupAmbientParticles();
  animateViewElements(el("play-view"));
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  el("dismiss-error").addEventListener("click", dismissError);
  el("refresh-button").addEventListener("click", refreshVersions);
  controls.playerName.addEventListener("input", renderAction);
  controls.playerName.addEventListener("keydown", (event) => { if (event.key === "Enter") controls.playerName.blur(); });
  controls.playerName.addEventListener("blur", async () => {
    const name = controls.playerName.value.trim();
    if (!launcher || !ui.state || !validPlayerName(name) || name === getSettings().playerName) return;
    try { await launcher.saveSettings({ playerName: name }); await syncState(); }
    catch (error) { showError(`Не удалось сохранить имя игрока: ${friendlyError(error)}`); }
  });
  controls.versionSelect.addEventListener("change", async () => {
    renderAction();
    if (!launcher || !controls.versionSelect.value) return;
    try { await launcher.saveSettings({ selectedVersion: controls.versionSelect.value }); await syncState(); }
    catch (error) { showError(`Не удалось сохранить версию: ${friendlyError(error)}`); }
  });
  controls.mainAction.addEventListener("click", performMainAction);
  el("cancel-button").addEventListener("click", cancelInstall);
  [controls.javaPath, controls.memoryGb, controls.gameDirectory, controls.showSnapshots].forEach((control) => {
    control.addEventListener("input", () => { ui.settingsDirty = true; });
    control.addEventListener("change", () => { ui.settingsDirty = true; });
  });
  controls.saveSettings.addEventListener("click", saveSettings);
  el("pick-java").addEventListener("click", () => pickPath("java"));
  el("pick-directory").addEventListener("click", () => pickPath("directory"));
  el("open-folder-home").addEventListener("click", openGameDirectory);
  el("open-folder-settings").addEventListener("click", openGameDirectory);
  el("quick-folder").addEventListener("click", openGameDirectory);
  el("quick-install").addEventListener("click", performMainAction);
  el("running-action").addEventListener("click", performMainAction);
  el("local-instance-card").addEventListener("click", () => {
    setView("play");
    controls.versionSelect.focus();
  });
  ["create-instance", "import-instance", "quick-import", "new-instance-card"].forEach((id) => {
    el(id).addEventListener("click", () => showToast("Менеджер сборок будет следующим этапом. Базовый запуск уже работает."));
  });
  document.querySelectorAll("[data-soon]").forEach((button) => button.addEventListener("click", () => showToast(`${button.dataset.soon}: раздел уже заложен в интерфейс и будет подключён следующим.`)));
  el("footer-update").addEventListener("click", refreshVersions);
  el("version-search").addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    const query = event.currentTarget.value.trim().toLowerCase();
    if (!query) return;
    const match = getVersions().find((version) => version.id.toLowerCase().includes(query));
    if (!match) { showToast("Такой версии в текущем списке нет."); return; }
    controls.versionSelect.value = match.id;
    render();
    try { await launcher.saveSettings({ selectedVersion: match.id }); await syncState(); } catch (error) { showError(friendlyError(error)); }
  });
  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      el("version-search").focus();
      el("version-search").select();
    }
  });
  if (launcher?.minimizeWindow) el("window-minimize").addEventListener("click", () => launcher.minimizeWindow());
  if (launcher?.maximizeWindow) el("window-maximize").addEventListener("click", () => launcher.maximizeWindow());
  if (launcher?.closeWindow) el("window-close").addEventListener("click", () => launcher.closeWindow());
}

function handleEvent(event) {
  if (!event || typeof event !== "object") return;
  if (event.type === "state") applyState(event.state);
  else if (event.type === "progress") {
    ui.progress = event;
    if (event.message) setActivity(event.message);
    renderProgress();
    renderAction();
  } else if (event.type === "status") {
    if (event.message) setActivity(event.message, event.level === "error" ? "err" : "ok");
  } else if (event.type === "log") {
    if (event.message) pushLog(event.message, "ok");
  } else if (event.type === "error") {
    showError(event.message || "Произошла ошибка лаунчера.");
    if (event.message) setActivity(event.message, "err");
  }
}

async function initialize() {
  setupMotionUi();
  bindEvents();
  if (!launcher) {
    showError("Не удалось подключиться к лаунчеру. Перезапустите приложение.");
    setActivity("Связь с приложением недоступна");
    return;
  }
  try {
    launcher.onEvent(handleEvent);
    await syncState();
    setActivity(ui.state?.versions?.length ? "Лаунчер готов к работе" : "Нажмите ↻, чтобы получить список версий");
    if (!ui.state?.versions?.length) await refreshVersions();
  } catch (error) {
    showError(`Не удалось загрузить данные лаунчера: ${friendlyError(error)}`);
    setActivity("Данные лаунчера недоступны");
  }
}

initialize();
})();
