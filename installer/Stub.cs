using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

[assembly: System.Reflection.AssemblyTitle("Veyra Launcher")]
[assembly: System.Reflection.AssemblyProduct("Veyra Launcher")]

namespace Veyra.Stub {
  // «Veyra Launcher.exe» в корне установки. На него ведут ярлыки и закреп на панели задач, поэтому
  // путь не меняется от версии к версии; сама программа живёт в app-<сборка>, указанной в veyra-install.json.
  static class Program {
    const string AppExe = "Veyra Launcher.exe";

    [STAThread]
    static int Main(string[] args) {
      var root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
      var exe = Current(root) ?? Newest(root);
      if (exe == null) return Broken(root);
      var info = new ProcessStartInfo(exe, Join(args)) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(exe) };
      info.EnvironmentVariables["VEYRA_INSTALL_ROOT"] = root;
      Process.Start(info);
      return 0;
    }

    static string Current(string root) {
      try {
        var text = File.ReadAllText(Path.Combine(root, "veyra-install.json"), Encoding.UTF8);
        var match = Regex.Match(text, "\"build\"\\s*:\\s*\"([^\"\\\\/]+)\"");
        if (!match.Success) return null;
        var dir = Path.Combine(root, "app-" + match.Groups[1].Value);
        return Ready(dir) ? Path.Combine(dir, AppExe) : null;
      } catch { return null; }
    }
    // Запасной путь, если veyra-install.json повреждён: самая свежая целая версия.
    static string Newest(string root) {
      string best = null;
      var time = DateTime.MinValue;
      try {
        foreach (var dir in Directory.GetDirectories(root, "app-*")) {
          if (dir.EndsWith(".partial", StringComparison.OrdinalIgnoreCase) || !Ready(dir)) continue;
          var stamp = File.GetLastWriteTimeUtc(Path.Combine(dir, ".veyra-ready"));
          if (stamp > time) { time = stamp; best = Path.Combine(dir, AppExe); }
        }
      } catch { }
      return best;
    }
    static bool Ready(string dir) {
      return File.Exists(Path.Combine(dir, ".veyra-ready")) && File.Exists(Path.Combine(dir, AppExe)) && File.Exists(Path.Combine(dir, "resources", "app.asar"));
    }

    static int Broken(string root) {
      System.Windows.Forms.MessageBox.Show("Файлы Veyra Launcher повреждены или удалены.\n\nСкачайте установщик на veyra-launcher.com и запустите его — сборки, миры и настройки сохранятся.",
        "Veyra Launcher", System.Windows.Forms.MessageBoxButtons.OK, System.Windows.Forms.MessageBoxIcon.Warning);
      try { Process.Start("https://veyra-launcher.com/#download"); } catch { }
      return 1;
    }

    // Аргументы передаются дальше по правилам командной строки Windows (кавычки и обратные слеши).
    static string Join(string[] args) {
      var line = new StringBuilder();
      foreach (var arg in args) {
        if (line.Length > 0) line.Append(' ');
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) { line.Append(arg); continue; }
        line.Append('"');
        int slashes = 0;
        foreach (var symbol in arg) {
          if (symbol == '\\') { slashes++; continue; }
          if (symbol == '"') { line.Append('\\', slashes * 2 + 1); line.Append('"'); }
          else { line.Append('\\', slashes); line.Append(symbol); }
          slashes = 0;
        }
        line.Append('\\', slashes * 2);
        line.Append('"');
      }
      return line.ToString();
    }
  }
}
