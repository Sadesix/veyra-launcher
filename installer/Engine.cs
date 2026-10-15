using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace Veyra.Setup {
  // Ошибка, которую можно показать человеку как есть.
  sealed class SetupException : Exception {
    public SetupException(string message) : base(message) { }
  }

  // Сведения о сборке: scripts/build-installer.js дописывает их в конец установщика вместе с архивом.
  sealed class PackageInfo {
    public string Product, Version, Build, Publisher, Site;
    public long Size, PayloadOffset, PayloadLength, ExeLength;
  }

  // veyra-install.json в корне установки: какая сборка текущая и какие ярлыки выбрал человек.
  sealed class InstallState {
    public string Version = "", Build = "", Previous = "", InstalledAt = "", UpdatedAt = "";
    public bool Desktop = true, StartMenu = true;
  }

  sealed class InstallOptions {
    public string Root;
    public bool Desktop = true, StartMenu = true, Update;
  }

  sealed class Log {
    readonly string file;
    public Log(string file) { this.file = file; }
    public string File { get { return file; } }
    public void Write(string text) {
      try {
        Directory.CreateDirectory(Path.GetDirectoryName(file));
        var info = new FileInfo(file);
        if (info.Exists && info.Length > 1024 * 1024) info.Delete();
        System.IO.File.AppendAllText(file, "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + text + Environment.NewLine, Encoding.UTF8);
      } catch { }
    }
  }

  // Установка устроена «по версиям»: каждая сборка живёт в своей папке app-<сборка>, а маленький
  // «Veyra Launcher.exe» в корне запускает ту, что указана в veyra-install.json. Обновление
  // распаковывается рядом, пока старая версия работает, и переключается одной записью файла —
  // занятые файлы и наполовину обновлённая программа исключены.
  sealed class Engine {
    public const string AppId = "dev.veyra.launcher";
    public const string AppExe = "Veyra Launcher.exe";
    public const string StubName = "Veyra Launcher.exe";
    public const string UninstallerName = "Uninstall Veyra Launcher.exe";
    public const string StateName = "veyra-install.json";
    public const string ReadyName = ".veyra-ready";
    public const string ShortcutName = "Veyra Launcher.lnk";

    public readonly string SelfPath;
    public readonly PackageInfo Package;
    public readonly bool Test;
    readonly string testDir;
    public readonly Log Log;
    public Action<double, string> Progress = delegate { };
    public Action<int> Step = delegate { };
    public bool LowPriority;

    public Engine() {
      SelfPath = Assembly.GetExecutingAssembly().Location;
      Test = Environment.GetEnvironmentVariable("VEYRA_SETUP_TEST") == "1";
      testDir = Environment.GetEnvironmentVariable("VEYRA_SETUP_TEST_DIR") ?? "";
      if (Test && testDir == "") throw new SetupException("VEYRA_SETUP_TEST требует VEYRA_SETUP_TEST_DIR");
      Package = ReadPackage(SelfPath);
      Log = new Log(Test ? Path.Combine(testDir, "setup.log") : Path.Combine(LocalData, "Veyra Launcher", "setup.log"));
    }

    static string LocalData { get { return Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData); } }
    public string DefaultRoot { get { return Test ? Path.Combine(testDir, "Veyra Launcher") : Path.Combine(LocalData, "Programs", "Veyra Launcher"); } }
    public string UninstallKey { get { return Test ? @"Software\VeyraLauncherTest\Uninstall\VeyraLauncher" : @"Software\Microsoft\Windows\CurrentVersion\Uninstall\VeyraLauncher"; } }
    public string DesktopLink { get { return Path.Combine(Test ? Path.Combine(testDir, "Desktop") : Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), ShortcutName); } }
    public string StartMenuLink { get { return Path.Combine(Test ? Path.Combine(testDir, "Programs") : Environment.GetFolderPath(Environment.SpecialFolder.Programs), ShortcutName); } }
    // Настройки лаунчера (вход, параметры, Java) — userData Electron; сборки лежат в «Документах» и не трогаются.
    public string SettingsDir { get { return Test ? Path.Combine(testDir, "settings") : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "veyra-launcher"); } }
    public string BuildsDir { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Veyra Launcher"); } }

    // ── Архив внутри установщика ──
    static PackageInfo ReadPackage(string self) {
      try {
        using (var stream = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
          if (stream.Length < 32) return null;
          var trailer = new byte[32];
          stream.Seek(-32, SeekOrigin.End);
          ReadExactly(stream, trailer);
          if (Encoding.ASCII.GetString(trailer, 0, 8) != "VEYRAPK1") return null;
          long offset = BitConverter.ToInt64(trailer, 8), length = BitConverter.ToInt64(trailer, 16);
          int metaLength = BitConverter.ToInt32(trailer, 24);
          if (offset <= 0 || length <= 0 || metaLength <= 0 || offset + length + metaLength + 32 != stream.Length) return null;
          var meta = new byte[metaLength];
          stream.Seek(offset + length, SeekOrigin.Begin);
          ReadExactly(stream, meta);
          var json = (Dictionary<string, object>)new JavaScriptSerializer().DeserializeObject(Encoding.UTF8.GetString(meta));
          return new PackageInfo {
            Product = Text(json, "product", "Veyra Launcher"), Version = Text(json, "version", ""), Build = Text(json, "build", ""),
            Publisher = Text(json, "publisher", "Veyra"), Site = Text(json, "site", "https://veyra-launcher.com/"),
            Size = Convert.ToInt64(json.ContainsKey("size") ? json["size"] : 0), PayloadOffset = offset, PayloadLength = length, ExeLength = offset,
          };
        }
      } catch { return null; }
    }
    static void ReadExactly(Stream stream, byte[] buffer) {
      int read = 0;
      while (read < buffer.Length) {
        int count = stream.Read(buffer, read, buffer.Length - read);
        if (count <= 0) throw new EndOfStreamException();
        read += count;
      }
    }
    static string Text(Dictionary<string, object> json, string key, string fallback) {
      object value;
      return json.TryGetValue(key, out value) && value is string ? (string)value : fallback;
    }

    // ── Существующая установка ──
    public static InstallState ReadState(string root) {
      try {
        var json = (Dictionary<string, object>)new JavaScriptSerializer().DeserializeObject(System.IO.File.ReadAllText(Path.Combine(root, StateName), Encoding.UTF8));
        var state = new InstallState { Version = Text(json, "version", ""), Build = Text(json, "build", ""), Previous = Text(json, "previous", ""), InstalledAt = Text(json, "installedAt", ""), UpdatedAt = Text(json, "updatedAt", "") };
        object flag;
        if (json.TryGetValue("desktop", out flag) && flag is bool) state.Desktop = (bool)flag;
        if (json.TryGetValue("startMenu", out flag) && flag is bool) state.StartMenu = (bool)flag;
        return state.Build == "" ? null : state;
      } catch { return null; }
    }
    // Где уже стоит Veyra: по записи в «Приложениях», затем в папке по умолчанию.
    public string FindRoot(string preferred) {
      var candidates = new List<string>();
      if (!string.IsNullOrEmpty(preferred)) candidates.Add(preferred);
      try {
        using (var key = Registry.CurrentUser.OpenSubKey(UninstallKey)) {
          if (key != null && key.GetValue("InstallLocation") is string) candidates.Add((string)key.GetValue("InstallLocation"));
        }
      } catch { }
      candidates.Add(DefaultRoot);
      foreach (var root in candidates) if (ReadState(root) != null) return Path.GetFullPath(root);
      return null;
    }
    // Если человек выбрал общую папку вроде D:\Games, лаунчер ставится во вложенную «Veyra Launcher».
    public static string NormalizeRoot(string chosen) {
      var full = Path.GetFullPath(chosen.Trim().Trim('"')).TrimEnd('\\');
      if (Path.GetPathRoot(full).TrimEnd('\\') == full) return Path.Combine(full + "\\", "Veyra Launcher");
      if (ReadState(full) != null || string.Equals(Path.GetFileName(full), "Veyra Launcher", StringComparison.OrdinalIgnoreCase)) return full;
      if (Directory.Exists(full) && Directory.GetFileSystemEntries(full).Length > 0) return Path.Combine(full, "Veyra Launcher");
      return full;
    }

    // ── Установка и обновление ──
    public void Install(InstallOptions options) {
      if (Package == null) throw new SetupException("В этом файле нет лаунчера: скачайте установщик заново на veyra-launcher.com");
      var root = Path.GetFullPath(options.Root).TrimEnd('\\');
      Log.Write((options.Update ? "Обновление до " : "Установка ") + Package.Version + " (" + Package.Build + ") в " + root);
      Step(0);
      Progress(0, "Проверяем папку");
      EnsureWritable(root);
      var target = Path.Combine(root, "app-" + Package.Build);
      if (IsReady(target)) {
        Log.Write("Сборка " + Package.Build + " уже распакована");
        Progress(0.8, "Файлы уже на месте");
      } else {
        CheckSpace(root);
        Extract(target);
      }

      Step(1);
      Progress(0.82, "Обновляем файлы запуска");
      WriteFile(Path.Combine(root, StubName), Resource("app.stub"));
      WriteFile(Path.Combine(root, UninstallerName), OwnProgram());
      var previous = ReadState(root);
      var now = DateTime.Now.ToString("o");
      var state = new InstallState {
        Version = Package.Version, Build = Package.Build,
        Previous = previous == null ? "" : previous.Build != Package.Build ? previous.Build : previous.Previous,
        Desktop = options.Update && previous != null ? previous.Desktop : options.Desktop,
        StartMenu = options.Update && previous != null ? previous.StartMenu : options.StartMenu,
        InstalledAt = previous != null && previous.InstalledAt != "" ? previous.InstalledAt : now, UpdatedAt = now,
      };
      WriteState(root, state);
      Log.Write("Текущая сборка: " + state.Build + (state.Previous != "" ? ", прежняя: " + state.Previous : ""));

      Step(2);
      Progress(0.88, "Создаём ярлыки");
      // Обновление не трогает ярлыки: удалённый человеком ярлык не вернётся сам.
      if (!options.Update) Shortcuts(root, state.Desktop, state.StartMenu);
      Register(root);

      Step(3);
      Progress(0.94, "Убираем старые версии");
      Cleanup(root, target);
      Progress(1, "Готово");
      Log.Write("Готово: " + Package.Version);
    }

    void EnsureWritable(string root) {
      try {
        Directory.CreateDirectory(root);
        var probe = Path.Combine(root, ".veyra-write-test");
        System.IO.File.WriteAllText(probe, "ok");
        System.IO.File.Delete(probe);
      } catch (UnauthorizedAccessException) {
        throw new SetupException("Нет прав на запись в папку «" + root + "». Выберите папку в своём профиле — например, предложенную по умолчанию.");
      } catch (IOException error) {
        throw new SetupException("Не удалось открыть папку «" + root + "»: " + error.Message);
      }
    }
    void CheckSpace(string root) {
      try {
        var drive = new DriveInfo(Path.GetPathRoot(root));
        long need = Package.Size + Package.PayloadLength + 64L * 1024 * 1024;
        if (drive.AvailableFreeSpace < need) throw new SetupException("На диске " + drive.Name.TrimEnd('\\') + " не хватает места: нужно " + Megabytes(need) + ", свободно " + Megabytes(drive.AvailableFreeSpace) + ".");
      } catch (SetupException) { throw; } catch { }
    }
    public static string Megabytes(long bytes) { return Math.Max(1, (long)Math.Round(bytes / 1048576.0)) + " МБ"; }

    public static bool IsReady(string dir) {
      return System.IO.File.Exists(Path.Combine(dir, ReadyName)) && System.IO.File.Exists(Path.Combine(dir, AppExe)) && System.IO.File.Exists(Path.Combine(dir, "resources", "app.asar"));
    }

    // Распаковка во временную папку *.partial и переименование целиком: оборванная установка
    // не оставит полусобранную версию, а старая продолжит работать.
    void Extract(string target) {
      var partial = target + ".partial";
      DeleteDirectory(partial, true);
      var temp = Path.Combine(Path.GetTempPath(), "veyra-setup-" + Process.GetCurrentProcess().Id);
      Directory.CreateDirectory(temp);
      var archive = Path.Combine(temp, "app.7z");
      var tool = Path.Combine(temp, "7za.exe");
      try {
        Progress(0.01, "Готовим файлы");
        System.IO.File.WriteAllBytes(tool, Resource("tool.7za"));
        using (var source = new FileStream(SelfPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        using (var output = new FileStream(archive, FileMode.Create, FileAccess.Write)) {
          source.Seek(Package.PayloadOffset, SeekOrigin.Begin);
          var buffer = new byte[1 << 20];
          long left = Package.PayloadLength;
          while (left > 0) {
            int count = source.Read(buffer, 0, (int)Math.Min(buffer.Length, left));
            if (count <= 0) throw new SetupException("Установщик повреждён: архив обрывается. Скачайте его заново.");
            output.Write(buffer, 0, count);
            left -= count;
            Progress(0.01 + 0.06 * (1 - (double)left / Package.PayloadLength), "Готовим файлы");
          }
        }
        Progress(0.07, "Распаковываем файлы");
        RunSevenZip(tool, archive, partial);
        if (!System.IO.File.Exists(Path.Combine(partial, AppExe)) || !System.IO.File.Exists(Path.Combine(partial, "resources", "app.asar")))
          throw new SetupException("Файлы распаковались не полностью. Проверьте место на диске и запустите установщик ещё раз.");
        System.IO.File.WriteAllText(Path.Combine(partial, ReadyName), Package.Build);
        if (Directory.Exists(target)) DeleteDirectory(target, false);
        Retry(delegate { Directory.Move(partial, target); }, 20, 250);
      } catch {
        DeleteDirectory(partial, true);
        throw;
      } finally {
        DeleteDirectory(temp, true);
      }
    }

    void RunSevenZip(string tool, string archive, string destination) {
      var info = new ProcessStartInfo(tool, "x \"" + archive + "\" -o\"" + destination + "\" -y -bsp1 -bso0 -bse2") {
        UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
      };
      using (var process = Process.Start(info)) {
        if (LowPriority) { try { process.PriorityClass = ProcessPriorityClass.BelowNormal; } catch { } }
        var errors = new StringBuilder();
        var reader = new Thread(delegate () { try { errors.Append(process.StandardError.ReadToEnd()); } catch { } });
        reader.IsBackground = true;
        reader.Start();
        var buffer = new char[512];
        var tail = new StringBuilder();
        int count, last = -1;
        while ((count = process.StandardOutput.Read(buffer, 0, buffer.Length)) > 0) {
          tail.Append(buffer, 0, count);
          var matches = Regex.Matches(tail.ToString(), @"(\d{1,3})%");
          if (matches.Count > 0) {
            int percent = int.Parse(matches[matches.Count - 1].Groups[1].Value);
            if (percent != last && percent <= 100) { last = percent; Progress(0.07 + 0.73 * percent / 100.0, "Распаковываем файлы"); }
          }
          if (tail.Length > 2048) tail.Remove(0, tail.Length - 64);
        }
        process.WaitForExit();
        reader.Join(5000);
        if (process.ExitCode > 1) {
          var message = errors.ToString().Trim();
          Log.Write("7-Zip завершился с кодом " + process.ExitCode + ": " + message);
          if (message.IndexOf("space", StringComparison.OrdinalIgnoreCase) >= 0) throw new SetupException("Не хватило места на диске во время распаковки.");
          throw new SetupException("Не удалось распаковать файлы (код " + process.ExitCode + "). Подробности — в журнале установки.");
        }
      }
    }

    public static byte[] Resource(string name) {
      using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name)) {
        if (stream == null) throw new SetupException("В установщике нет ресурса " + name);
        var memory = new MemoryStream();
        stream.CopyTo(memory);
        return memory.ToArray();
      }
    }
    // Деинсталлятор — эта же программа без архива: она весит меньше мегабайта.
    byte[] OwnProgram() {
      using (var stream = new FileStream(SelfPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
        var bytes = new byte[Package.ExeLength];
        ReadExactly(stream, bytes);
        return bytes;
      }
    }

    void WriteFile(string path, byte[] bytes) {
      try {
        if (System.IO.File.Exists(path)) {
          var current = System.IO.File.ReadAllBytes(path);
          if (current.Length == bytes.Length && Equal(current, bytes)) return;
        }
      } catch { }
      var temporary = path + ".new";
      System.IO.File.WriteAllBytes(temporary, bytes);
      Retry(delegate {
        if (System.IO.File.Exists(path)) System.IO.File.Delete(path);
        System.IO.File.Move(temporary, path);
      }, 40, 150);
    }
    static bool Equal(byte[] left, byte[] right) {
      for (int index = 0; index < left.Length; index++) if (left[index] != right[index]) return false;
      return true;
    }

    void WriteState(string root, InstallState state) {
      var text = new StringBuilder();
      text.Append("{\n");
      text.Append("  \"version\": " + Json(state.Version) + ",\n");
      text.Append("  \"build\": " + Json(state.Build) + ",\n");
      text.Append("  \"previous\": " + Json(state.Previous) + ",\n");
      text.Append("  \"desktop\": " + (state.Desktop ? "true" : "false") + ",\n");
      text.Append("  \"startMenu\": " + (state.StartMenu ? "true" : "false") + ",\n");
      text.Append("  \"installedAt\": " + Json(state.InstalledAt) + ",\n");
      text.Append("  \"updatedAt\": " + Json(state.UpdatedAt) + "\n}\n");
      var path = Path.Combine(root, StateName);
      var temporary = path + ".new";
      System.IO.File.WriteAllText(temporary, text.ToString(), new UTF8Encoding(false));
      Retry(delegate {
        if (System.IO.File.Exists(path)) System.IO.File.Replace(temporary, path, null);
        else System.IO.File.Move(temporary, path);
      }, 20, 150);
    }
    static string Json(string value) {
      return new JavaScriptSerializer().Serialize(value ?? "");
    }

    void Shortcuts(string root, bool desktop, bool startMenu) {
      var stub = Path.Combine(root, StubName);
      foreach (var pair in new[] { new KeyValuePair<string, bool>(StartMenuLink, startMenu), new KeyValuePair<string, bool>(DesktopLink, desktop) }) {
        try {
          if (pair.Value) Native.CreateShortcut(pair.Key, stub, root, "Лаунчер Minecraft Java Edition", AppId);
          else if (PointsInto(pair.Key, root)) System.IO.File.Delete(pair.Key);
        } catch (Exception error) { Log.Write("Ярлык " + pair.Key + ": " + error.Message); }
      }
    }
    static bool PointsInto(string link, string root) {
      var target = Native.ShortcutTarget(link);
      return target != null && target.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
    }

    void Register(string root) {
      using (var key = Registry.CurrentUser.CreateSubKey(UninstallKey)) {
        var uninstaller = Path.Combine(root, UninstallerName);
        key.SetValue("DisplayName", Package.Product);
        key.SetValue("DisplayVersion", Package.Version);
        key.SetValue("Publisher", Package.Publisher);
        key.SetValue("DisplayIcon", "\"" + Path.Combine(root, StubName) + "\",0");
        key.SetValue("InstallLocation", root);
        key.SetValue("UninstallString", "\"" + uninstaller + "\" --uninstall");
        key.SetValue("QuietUninstallString", "\"" + uninstaller + "\" --uninstall --quiet");
        key.SetValue("URLInfoAbout", Package.Site);
        key.SetValue("HelpLink", Package.Site);
        key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
        key.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, Package.Size / 1024), RegistryValueKind.DWord);
        key.SetValue("NoModify", 1, RegistryValueKind.DWord);
        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
      }
    }

    // Прежние версии удаляются, только если их EXE свободен: работающий лаунчер старой версии не пострадает,
    // его папку уберёт уже новая версия при следующем запуске.
    void Cleanup(string root, string keep) {
      foreach (var dir in Directory.GetDirectories(root, "app-*")) {
        if (string.Equals(dir, keep, StringComparison.OrdinalIgnoreCase)) continue;
        if (dir.EndsWith(".partial", StringComparison.OrdinalIgnoreCase)) {
          if (Directory.GetLastWriteTimeUtc(dir) < DateTime.UtcNow.AddHours(-1)) DeleteDirectory(dir, true);
          continue;
        }
        RemoveBuild(dir);
      }
      var packages = Path.Combine(root, "packages");
      if (Directory.Exists(packages)) {
        foreach (var file in Directory.GetFiles(packages)) {
          if (string.Equals(file, SelfPath, StringComparison.OrdinalIgnoreCase)) continue;
          var match = Regex.Match(Path.GetFileName(file), @"(\d+(?:\.\d+){1,3})");
          if (match.Success && !Newer(match.Groups[1].Value, Package.Version)) TryDelete(file);
        }
      }
      // Копии переносных версий 0.7.x, которые распаковывались в %LOCALAPPDATA%\Veyra Launcher\app.
      if (!Test) {
        var portable = Path.Combine(LocalData, "Veyra Launcher", "app");
        if (Directory.Exists(portable)) {
          foreach (var dir in Directory.GetDirectories(portable)) if (!Path.GetFileName(dir).StartsWith(".unpack-")) RemoveBuild(dir);
          try { if (Directory.GetFileSystemEntries(portable).Length == 0) Directory.Delete(portable); } catch { }
        }
      }
    }
    void RemoveBuild(string dir) {
      try {
        var exe = Path.Combine(dir, AppExe);
        if (System.IO.File.Exists(exe)) System.IO.File.Delete(exe);
      } catch { Log.Write("Папка занята, оставлена: " + dir); return; }
      DeleteDirectory(dir, true);
      Log.Write("Удалена прежняя версия: " + Path.GetFileName(dir));
    }

    public static bool Newer(string candidate, string current) {
      var left = candidate.Split('.'); var right = current.Split('.');
      for (int index = 0; index < Math.Max(left.Length, right.Length); index++) {
        int a = index < left.Length ? int.Parse(left[index]) : 0, b = index < right.Length ? int.Parse(right[index]) : 0;
        if (a != b) return a > b;
      }
      return false;
    }

    // ── Запущенный лаунчер ──
    public static List<Process> Running(string root) {
      var list = new List<Process>();
      var prefix = root.TrimEnd('\\') + "\\";
      foreach (var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(AppExe))) {
        try { if (process.MainModule.FileName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) list.Add(process); } catch { }
      }
      return list;
    }
    // Лаунчер закрывается как от кнопки «Закрыть»: он сохраняет настройки и останавливает сервер.
    public bool CloseRunning(string root, int timeout) {
      var running = Running(root);
      if (running.Count == 0) return true;
      Log.Write("Закрываем запущенный лаунчер");
      foreach (var process in running) { try { if (process.MainWindowHandle != IntPtr.Zero) process.CloseMainWindow(); } catch { } }
      var deadline = DateTime.UtcNow.AddMilliseconds(timeout);
      while (DateTime.UtcNow < deadline) {
        if (Running(root).Count == 0) return true;
        Thread.Sleep(200);
      }
      return false;
    }
    public void KillRunning(string root) {
      foreach (var process in Running(root)) { try { process.Kill(); process.WaitForExit(5000); } catch { } }
    }

    public void Launch(string root) {
      var info = new ProcessStartInfo(Path.Combine(root, StubName)) { UseShellExecute = false, WorkingDirectory = root };
      Process.Start(info);
      Log.Write("Запущен лаунчер");
    }

    // ── Удаление ──
    public void Uninstall(string root, bool removeSettings) {
      root = Path.GetFullPath(root).TrimEnd('\\');
      Log.Write("Удаление из " + root + (removeSettings ? " вместе с настройками" : ""));
      Step(0);
      Progress(0.05, "Закрываем Veyra");
      if (!CloseRunning(root, 15000)) KillRunning(root);
      Step(1);
      Progress(0.2, "Удаляем ярлыки");
      foreach (var link in new[] { DesktopLink, StartMenuLink }) {
        try { if (PointsInto(link, root)) System.IO.File.Delete(link); } catch (Exception error) { Log.Write("Ярлык " + link + ": " + error.Message); }
      }
      try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false); } catch (Exception error) { Log.Write("Реестр: " + error.Message); }
      Step(2);
      Progress(0.35, "Удаляем файлы");
      if (Directory.Exists(root)) {
        var dirs = Directory.GetDirectories(root, "app-*");
        for (int index = 0; index < dirs.Length; index++) {
          DeleteDirectory(dirs[index], false);
          Progress(0.35 + 0.45 * (index + 1) / dirs.Length, "Удаляем файлы");
        }
        DeleteDirectory(Path.Combine(root, "packages"), true);
        foreach (var name in new[] { StubName, UninstallerName, StateName, StateName + ".new", StubName + ".new" }) {
          var file = Path.Combine(root, name);
          if (!string.Equals(file, SelfPath, StringComparison.OrdinalIgnoreCase)) TryDelete(file);
        }
        try { if (Directory.GetFileSystemEntries(root).Length == 0) Directory.Delete(root); } catch { }
      }
      Step(3);
      Progress(0.85, "Наводим порядок");
      if (removeSettings) DeleteDirectory(SettingsDir, true);
      if (!Test) DeleteDirectory(Path.Combine(LocalData, "Veyra Launcher", "app"), true);
      Progress(1, "Готово");
      Log.Write("Удаление завершено");
    }

    // ── Файлы ──
    public static void TryDelete(string file) {
      try { if (System.IO.File.Exists(file)) { System.IO.File.SetAttributes(file, FileAttributes.Normal); System.IO.File.Delete(file); } } catch { }
    }
    public void DeleteDirectory(string dir, bool quiet) {
      if (!Directory.Exists(dir)) return;
      try {
        Retry(delegate {
          foreach (var file in Directory.GetFiles(dir, "*", SearchOption.AllDirectories)) {
            var attributes = System.IO.File.GetAttributes(file);
            if ((attributes & FileAttributes.ReadOnly) != 0) System.IO.File.SetAttributes(file, FileAttributes.Normal);
          }
          Directory.Delete(dir, true);
        }, 10, 300);
      } catch (Exception error) {
        Log.Write("Не удалось удалить " + dir + ": " + error.Message);
        if (!quiet) throw new SetupException("Не удалось удалить «" + dir + "»: файлы заняты. Закройте Veyra и повторите.");
      }
    }
    // Антивирус и индексатор ненадолго держат свежие файлы: короткие повторы снимают эти сбои.
    static void Retry(Action action, int attempts, int delay) {
      for (int attempt = 1; ; attempt++) {
        try { action(); return; }
        catch (Exception error) {
          if (attempt >= attempts || !(error is IOException || error is UnauthorizedAccessException)) throw;
          Thread.Sleep(delay);
        }
      }
    }
  }
}
