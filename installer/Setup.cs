using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using System.Windows.Shell;
using Path = System.Windows.Shapes.Path;

namespace Veyra.Setup {
  sealed class Args {
    readonly List<string> list;
    public Args(string[] args) { list = new List<string>(args); }
    public bool Has(string name) { return list.Exists(delegate (string item) { return string.Equals(item, name, StringComparison.OrdinalIgnoreCase); }); }
    public string Value(string name) {
      int index = list.FindIndex(delegate (string item) { return string.Equals(item, name, StringComparison.OrdinalIgnoreCase); });
      return index >= 0 && index + 1 < list.Count ? list[index + 1] : null;
    }
  }

  // Режимы одной программы:
  //   без аргументов           — окно установки;
  //   --quiet [--root папка]   — установка без окна (--no-desktop, --no-start-menu, --launch);
  //   --update --root папка    — обновление без окна, его запускает сам лаунчер;
  //   --uninstall [--quiet]    — удаление (деинсталлятор — эта же программа без архива).
  static class Program {
    [STAThread]
    static int Main(string[] argv) {
      // Лаунчер читает ответы установщика как UTF-8, иначе русские сообщения исказятся.
      try {
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
        Console.SetError(new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true });
      } catch { }
      var args = new Args(argv);
      Engine engine;
      try { engine = new Engine(); }
      catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
      RemoveLeftovers(engine.SelfPath);
      try {
        if (args.Has("--uninstall") || engine.Package == null) return Uninstall(engine, args);
        if (args.Has("--update")) return Quiet(engine, args, true);
        if (args.Has("--quiet")) return Quiet(engine, args, false);
        return Single(engine, delegate { return Ui.Run(engine, args, false, null); });
      } catch (Exception error) {
        engine.Log.Write("Сбой: " + error);
        Console.Error.WriteLine(error.Message);
        return 1;
      }
    }

    // Два установщика одновременно не работают: второй ждёт первого (без окна) или сообщает об этом.
    static int Single(Engine engine, Func<int> action) {
      using (var mutex = new Mutex(false, "Local\\VeyraLauncherSetup")) {
        bool owned;
        try { owned = mutex.WaitOne(TimeSpan.FromMinutes(3)); } catch (AbandonedMutexException) { owned = true; }
        if (!owned) { Console.Error.WriteLine("Уже работает другой установщик Veyra"); return 4; }
        try { return action(); } finally { mutex.ReleaseMutex(); }
      }
    }

    static int Quiet(Engine engine, Args args, bool update) {
      var root = args.Value("--root") ?? engine.FindRoot(null) ?? engine.DefaultRoot;
      if (update && Engine.ReadState(root) == null) { Console.Error.WriteLine("Veyra не найдена в " + root); return 3; }
      engine.LowPriority = update;
      return Single(engine, delegate {
        try {
          engine.Install(new InstallOptions { Root = root, Update = update, Desktop = !args.Has("--no-desktop"), StartMenu = !args.Has("--no-start-menu") });
          if (args.Has("--launch")) engine.Launch(root);
          Console.Out.WriteLine("OK " + engine.Package.Version + " " + engine.Package.Build);
          return 0;
        } catch (Exception error) {
          engine.Log.Write("Ошибка: " + error);
          Console.Error.WriteLine(error is SetupException ? error.Message : "Непредвиденная ошибка: " + error.Message);
          return 1;
        }
      });
    }

    static int Uninstall(Engine engine, Args args) {
      var own = System.IO.Path.GetDirectoryName(engine.SelfPath);
      var root = args.Value("--root") ?? (Engine.ReadState(own) != null ? own : engine.FindRoot(null));
      if (root == null) {
        if (!args.Has("--quiet")) MessageBox.Show("Veyra Launcher не найдена на этом компьютере.", "Удаление Veyra Launcher", MessageBoxButton.OK, MessageBoxImage.Information);
        return 3;
      }
      // Деинсталлятор лежит в удаляемой папке. Запущенный EXE нельзя удалить, но можно переместить: он переносит себя
      // во временную папку и удаляет установку сам — без копий и без запуска других программ (антивирусы не любят
      // самоудаление через cmd). Если временная папка на другом диске, удаление продолжает копия оттуда.
      if (Inside(engine.SelfPath, root) && !args.Has("--from-temp")) {
        var away = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "veyra-uninstall-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".exe");
        try {
          File.Move(engine.SelfPath, away);
        } catch {
          File.Copy(engine.SelfPath, away, true);
          var rest = "--uninstall --from-temp --parent " + Process.GetCurrentProcess().Id + " --root \"" + root + "\"" + (args.Has("--quiet") ? " --quiet" : "") + (args.Has("--remove-settings") ? " --remove-settings" : "");
          Process.Start(new ProcessStartInfo(away, rest) { UseShellExecute = false });
          return 0;
        }
      }
      int parent;
      if (int.TryParse(args.Value("--parent") ?? "", out parent)) {
        try { Process.GetProcessById(parent).WaitForExit(15000); } catch { }
      }
      int code;
      if (args.Has("--quiet")) {
        try { engine.Uninstall(root, args.Has("--remove-settings")); code = 0; }
        catch (Exception error) { engine.Log.Write("Ошибка удаления: " + error); Console.Error.WriteLine(error.Message); code = 1; }
      } else code = Ui.Run(engine, args, true, root);
      return code;
    }
    static bool Inside(string file, string root) {
      return file.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
    }
    // Деинсталляторы, оставшиеся во временной папке после прошлых удалений, убирает любой следующий запуск.
    static void RemoveLeftovers(string self) {
      try {
        foreach (var file in Directory.GetFiles(System.IO.Path.GetTempPath(), "veyra-uninstall-*.exe")) {
          if (!string.Equals(file, self, StringComparison.OrdinalIgnoreCase)) Engine.TryDelete(file);
        }
      } catch { }
    }
  }

  sealed class Ui {
    readonly Engine engine;
    readonly Args args;
    readonly bool uninstall;
    string root;
    InstallState existing;
    Window window;
    FrameworkElement view;
    bool busy, finished, repair;
    int exitCode = 2;
    Action retry;
    readonly List<Border> stepBoxes = new List<Border>();
    readonly List<TextBlock> stepLabels = new List<TextBlock>();
    static readonly string[] Pages = { "Welcome", "Existing", "Working", "Done", "Failed", "Remove" };

    Ui(Engine engine, Args args, bool uninstall, string root) {
      this.engine = engine; this.args = args; this.uninstall = uninstall; this.root = root;
    }

    public static int Run(Engine engine, Args args, bool uninstall, string root) {
      var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
      var ui = new Ui(engine, args, uninstall, root);
      ui.Build();
      app.Run(ui.window);
      return ui.exitCode;
    }

    // ── Ресурсы ──
    T Find<T>(string name) where T : class { return view.FindName(name) as T; }
    static BitmapImage Bitmap(string name) {
      var image = new BitmapImage();
      using (var stream = new MemoryStream(Engine.Resource(name))) {
        image.BeginInit();
        image.CacheOption = BitmapCacheOption.OnLoad;
        image.StreamSource = stream;
        image.EndInit();
      }
      image.Freeze();
      return image;
    }
    // Шрифты лаунчера кладутся во временную папку: WPF загружает собственные шрифты из файлов.
    static FontFamily[] Fonts() {
      var dir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "veyra-setup-fonts");
      try {
        Directory.CreateDirectory(dir);
        foreach (var pair in new[] { new[] { "font.mono", "Monocraft.otf" }, new[] { "font.body", "DotumChe-RUS.ttf" } }) {
          var bytes = Engine.Resource(pair[0]);
          var file = System.IO.Path.Combine(dir, pair[1]);
          if (!File.Exists(file) || new FileInfo(file).Length != bytes.Length) File.WriteAllBytes(file, bytes);
        }
      } catch { }
      var uri = new Uri(dir + "\\");
      return new[] { new FontFamily(uri, "./#Monocraft, Consolas"), new FontFamily(uri, "./#DotumChe RUS BY hidsky, Segoe UI") };
    }

    void Build() {
      view = (FrameworkElement)XamlReader.Parse(Encoding.UTF8.GetString(Engine.Resource("ui.xaml")));
      var fonts = Fonts();
      view.Resources["MonoFont"] = fonts[0];
      view.Resources["BodyFont"] = fonts[1];
      Find<Image>("Scene").Source = Bitmap("img.scene");
      Find<Image>("Logo").Source = Bitmap("img.logo");
      var deep = new ImageBrush(Bitmap("img.deep")) { TileMode = TileMode.Tile, Viewport = new Rect(0, 0, 64, 64), ViewportUnits = BrushMappingMode.Absolute, Stretch = Stretch.None };
      RenderOptions.SetBitmapScalingMode(deep, BitmapScalingMode.NearestNeighbor);
      Find<Grid>("Side").Background = deep;
      Find<TextBlock>("VersionBadge").Text = engine.Package != null ? engine.Package.Version : (existing != null ? existing.Version : "veyra");

      window = new Window {
        Title = uninstall ? "Удаление Veyra Launcher" : "Установка Veyra Launcher", Content = view, SizeToContent = SizeToContent.WidthAndHeight,
        ResizeMode = ResizeMode.CanMinimize, WindowStyle = WindowStyle.None, WindowStartupLocation = WindowStartupLocation.CenterScreen,
        Background = new SolidColorBrush(Color.FromRgb(0x20, 0x1b, 0x22)), Icon = Bitmap("img.icon"),
      };
      WindowChrome.SetWindowChrome(window, new WindowChrome { CaptionHeight = 0, GlassFrameThickness = new Thickness(0, 0, 0, 1), ResizeBorderThickness = new Thickness(0), UseAeroCaptionButtons = false });
      window.SourceInitialized += delegate { Native.SquareCorners(new WindowInteropHelper(window).Handle); };
      window.Closing += delegate (object sender, System.ComponentModel.CancelEventArgs e) { if (busy) e.Cancel = true; };
      Find<TextBlock>("TitleText").Text = window.Title;
      foreach (var name in new[] { "TitleBar", "Art" }) {
        Find<UIElement>(name).MouseLeftButtonDown += delegate (object sender, MouseButtonEventArgs e) { if (e.ButtonState == MouseButtonState.Pressed) { try { window.DragMove(); } catch { } } };
      }
      Find<Button>("MinimizeButton").Click += delegate { window.WindowState = WindowState.Minimized; };
      Find<Button>("CloseButton").Click += delegate { if (!busy) window.Close(); };
      Find<Button>("SiteLink").Click += delegate { Open(engine.Package != null ? engine.Package.Site : "https://veyra-launcher.com/"); };
      Find<Button>("SecondaryButton").Click += delegate { if (!busy) window.Close(); };
      Find<Button>("PrimaryButton").Click += delegate { Primary(); };
      Find<Button>("BrowseButton").Click += delegate { Browse(); };
      Find<TextBox>("RootBox").TextChanged += delegate { UpdateSpace(); };
      Find<Button>("ExistingRemove").Click += delegate { StartUninstallFromInstaller(); };
      Find<Button>("FailedLog").Click += delegate { Open(engine.Log.File); };
      Find<Button>("RemoveOpenBuilds").Click += delegate { Directory.CreateDirectory(engine.BuildsDir); Open(engine.BuildsDir); };
      Animate();

      if (uninstall) ShowRemove();
      else {
        root = args.Value("--root") ?? engine.FindRoot(null);
        existing = root != null ? Engine.ReadState(root) : null;
        if (existing != null) ShowExisting(); else ShowWelcome(root ?? engine.DefaultRoot);
      }
    }

    // ── Оживление: парящий логотип и частицы над картиной, как на сайте ──
    void Animate() {
      var ease = new SineEase { EasingMode = EasingMode.EaseInOut };
      Find<TranslateTransform>("LogoFloat").BeginAnimation(TranslateTransform.YProperty,
        new DoubleAnimation(0, -9, TimeSpan.FromSeconds(2.6)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever, EasingFunction = ease });
      var canvas = Find<Canvas>("Motes");
      var random = new Random(7);
      var colors = new[] { Color.FromRgb(0xd2, 0x9a, 0x8a), Color.FromRgb(0xf0, 0xe1, 0xd3), Color.FromRgb(0xa7, 0xac, 0xc9) };
      for (int index = 0; index < 12; index++) {
        int size = random.Next(2) == 0 ? 3 : 6;
        var mote = new Rectangle { Width = size, Height = size, Fill = new SolidColorBrush(colors[index % colors.Length]), Opacity = 0 };
        Canvas.SetLeft(mote, 20 + random.Next(290));
        canvas.Children.Add(mote);
        var duration = TimeSpan.FromSeconds(7 + random.NextDouble() * 6);
        var delay = TimeSpan.FromSeconds(random.NextDouble() * 8);
        mote.BeginAnimation(Canvas.TopProperty, new DoubleAnimation(490, 110, duration) { BeginTime = delay, RepeatBehavior = RepeatBehavior.Forever });
        var fade = new DoubleAnimationUsingKeyFrames { BeginTime = delay, Duration = duration, RepeatBehavior = RepeatBehavior.Forever };
        fade.KeyFrames.Add(new LinearDoubleKeyFrame(0, KeyTime.FromPercent(0)));
        fade.KeyFrames.Add(new LinearDoubleKeyFrame(0.75, KeyTime.FromPercent(0.15)));
        fade.KeyFrames.Add(new LinearDoubleKeyFrame(0.5, KeyTime.FromPercent(0.7)));
        fade.KeyFrames.Add(new LinearDoubleKeyFrame(0, KeyTime.FromPercent(1)));
        mote.BeginAnimation(UIElement.OpacityProperty, fade);
      }
    }

    void ShowPage(string name) {
      foreach (var page in Pages) Find<UIElement>(page).Visibility = page == name ? Visibility.Visible : Visibility.Collapsed;
      var shown = Find<UIElement>(name);
      var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
      shown.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(220)) { EasingFunction = ease });
      Find<TranslateTransform>("PageShift").BeginAnimation(TranslateTransform.XProperty, new DoubleAnimation(18, 0, TimeSpan.FromMilliseconds(260)) { EasingFunction = ease });
      Find<TextBlock>("FooterNote").Visibility = name == "Welcome" || name == "Existing" ? Visibility.Visible : Visibility.Collapsed;
    }
    void Buttons(string primary, string icon, string secondary, string style) {
      var button = Find<Button>("PrimaryButton");
      button.Style = (Style)view.Resources[style ?? "Primary"];
      button.Visibility = primary == null ? Visibility.Collapsed : Visibility.Visible;
      Find<TextBlock>("PrimaryLabel").Text = primary ?? "";
      var path = Find<Path>("PrimaryIcon");
      path.Visibility = icon == null ? Visibility.Collapsed : Visibility.Visible;
      if (icon != null) path.Data = Geometry.Parse((string)view.Resources["icon." + icon]);
      Find<Button>("SecondaryButton").Visibility = secondary == null ? Visibility.Collapsed : Visibility.Visible;
      Find<TextBlock>("SecondaryLabel").Text = secondary ?? "";
      button.IsEnabled = true;
    }

    // ── Страницы установки ──
    string mode;
    void ShowWelcome(string preset) {
      mode = "install";
      var package = engine.Package;
      Find<TextBlock>("WelcomeTitle").Text = "Veyra " + package.Version;
      Find<TextBox>("RootBox").Text = preset;
      var portableCache = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Veyra Launcher", "app");
      bool migrating = Regex.IsMatch(System.IO.Path.GetFileName(engine.SelfPath), @"^Veyra-Launcher-[\d.]+-x64\.exe$", RegexOptions.IgnoreCase) || (!engine.Test && Directory.Exists(portableCache));
      Find<UIElement>("MigrationNote").Visibility = migrating ? Visibility.Visible : Visibility.Collapsed;
      UpdateSpace();
      ShowPage("Welcome");
      Buttons("Установить", "download", "Отмена", "Primary");
      Find<TextBox>("RootBox").Focus();
      Find<TextBox>("RootBox").CaretIndex = preset.Length;
    }
    void ShowExisting() {
      mode = "existing";
      var package = engine.Package;
      Find<TextBlock>("ExistingPath").Text = root;
      bool newer = Engine.Newer(package.Version, existing.Version), same = !newer && !Engine.Newer(existing.Version, package.Version);
      repair = same;
      if (newer) {
        Find<TextBlock>("ExistingEyebrow").Text = "ОБНОВЛЕНИЕ";
        Find<TextBlock>("ExistingTitle").Text = "Обновить Veyra до " + package.Version;
        Find<TextBlock>("ExistingLead").Text = "Сейчас установлена версия " + existing.Version + ". Сборки, миры, настройки и ярлыки останутся на месте.";
        Buttons("Обновить", "refresh", "Отмена", "Create");
      } else if (same) {
        Find<TextBlock>("ExistingEyebrow").Text = "УЖЕ УСТАНОВЛЕНА";
        Find<TextBlock>("ExistingTitle").Text = "Veyra " + package.Version + " уже на месте";
        Find<TextBlock>("ExistingLead").Text = "Можно переустановить её: файлы лаунчера распакуются заново, а сборки, миры и настройки не изменятся.";
        Buttons("Переустановить", "refresh", "Отмена", "Primary");
      } else {
        Find<TextBlock>("ExistingEyebrow").Text = "УСТАНОВЛЕНА НОВЕЕ";
        Find<TextBlock>("ExistingTitle").Text = "У вас уже Veyra " + existing.Version;
        Find<TextBlock>("ExistingLead").Text = "В этом установщике более старая версия " + package.Version + ". Можно вернуться на неё — сборки и настройки останутся.";
        Buttons("Установить " + package.Version, "download", "Отмена", "Quiet");
      }
      ShowPage("Existing");
    }
    void ShowRemove() {
      mode = "remove";
      var state = Engine.ReadState(root);
      Find<TextBlock>("RemoveLead").Text = "Лаунчер" + (state != null ? " " + state.Version : "") + " и его ярлыки будут удалены из «" + root + "».";
      Find<TextBlock>("VersionBadge").Text = state != null ? state.Version : "veyra";
      Find<UIElement>("RunningNote").Visibility = Engine.Running(root).Count > 0 ? Visibility.Visible : Visibility.Collapsed;
      ShowPage("Remove");
      Buttons("Удалить", "trash", "Отмена", "Danger");
    }

    void UpdateSpace() {
      var text = Find<TextBlock>("SpaceText");
      text.Foreground = new SolidColorBrush(Color.FromRgb(0xa3, 0x96, 0x8f));
      try {
        var chosen = Engine.NormalizeRoot(Find<TextBox>("RootBox").Text);
        var drive = new DriveInfo(System.IO.Path.GetPathRoot(chosen));
        text.Text = "Понадобится около " + Engine.Megabytes(engine.Package.Size) + " · свободно " + Gigabytes(drive.AvailableFreeSpace) + " на диске " + drive.Name.TrimEnd('\\');
        if (!string.Equals(chosen, Find<TextBox>("RootBox").Text.Trim().TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) text.Text += " · папка: " + chosen;
      } catch {
        text.Text = "Укажите папку, например " + engine.DefaultRoot;
        text.Foreground = new SolidColorBrush(Color.FromRgb(0xe0, 0x7a, 0x6e));
      }
    }
    static string Gigabytes(long bytes) {
      return bytes >= 1L << 30 ? (bytes / (double)(1L << 30)).ToString("0.#") + " ГБ" : Engine.Megabytes(bytes);
    }

    void Browse() {
      var picked = Native.PickFolder(new WindowInteropHelper(window).Handle, "Куда установить Veyra", Find<TextBox>("RootBox").Text);
      if (picked != null) Find<TextBox>("RootBox").Text = Engine.NormalizeRoot(picked);
    }

    void Primary() {
      if (busy) return;
      if (finished) { window.Close(); return; }
      if (mode == "install") {
        string chosen;
        try { chosen = Engine.NormalizeRoot(Find<TextBox>("RootBox").Text); }
        catch { UpdateSpace(); return; }
        var options = new InstallOptions { Root = chosen, Desktop = Find<CheckBox>("DesktopBox").IsChecked == true, StartMenu = Find<CheckBox>("StartBox").IsChecked == true };
        bool launch = Find<CheckBox>("LaunchBox").IsChecked == true;
        retry = delegate { Install(options, launch, false); };
      } else if (mode == "existing") {
        var options = new InstallOptions { Root = root, Update = true };
        bool launch = Find<CheckBox>("ExistingLaunch").IsChecked == true, force = repair;
        retry = delegate { Install(options, launch, force); };
      } else if (mode == "remove") {
        bool settings = Find<CheckBox>("RemoveSettings").IsChecked == true;
        retry = delegate { Remove(settings); };
      }
      if (retry != null) retry();
    }

    void Install(InstallOptions options, bool launch, bool force) {
      Work(options.Update ? "ОБНОВЛЕНИЕ" : "УСТАНОВКА", options.Update ? "Обновляем Veyra" : "Устанавливаем Veyra", "Это займёт меньше минуты. Сборки, миры и настройки не затрагиваются.",
        new[] { "Распаковываем файлы", "Готовим запуск", "Создаём ярлыки", "Убираем старые версии" }, delegate {
          if (force) {
            // Переустановка той же версии: прежняя копия распаковывается заново.
            var target = System.IO.Path.Combine(options.Root, "app-" + engine.Package.Build);
            if (Directory.Exists(target)) {
              if (!engine.CloseRunning(options.Root, 15000)) throw new SetupException("Закройте Veyra и нажмите «Повторить»: лаунчер не закрылся сам.");
              engine.DeleteDirectory(target, false);
            }
          }
          engine.Install(options);
          string note = "";
          if (launch) {
            if (Engine.Running(options.Root).Count > 0 && !engine.CloseRunning(options.Root, 15000)) note = " Перезапустите лаунчер, чтобы открыть новую версию.";
            else engine.Launch(options.Root);
          }
          return note;
        }, delegate (string note) {
          root = options.Root;
          Find<TextBlock>("DoneEyebrow").Text = "ГОТОВО";
          Find<TextBlock>("DoneTitle").Text = options.Update ? "Veyra обновлена до " + engine.Package.Version : "Veyra установлена";
          var state = Engine.ReadState(options.Root);
          var where = state != null && state.StartMenu ? (state.Desktop ? "в меню «Пуск» и на рабочем столе" : "в меню «Пуск»") : state != null && state.Desktop ? "на рабочем столе" : null;
          Find<TextBlock>("DoneLead").Text = (launch ? "Лаунчер уже открывается." : "Лаунчер готов к запуску.") + (where != null && !options.Update ? " Ярлык «Veyra Launcher» — " + where + "." : "") + note;
          Find<UIElement>("DoneTips").Visibility = Visibility.Visible;
          Finish(launch ? null : "Запустить Veyra");
        });
    }

    void Remove(bool settings) {
      Work("УДАЛЕНИЕ", "Удаляем Veyra", "Сборки и миры в «Документах» не затрагиваются.", new[] { "Закрываем Veyra", "Удаляем ярлыки", "Удаляем файлы", "Наводим порядок" }, delegate {
        engine.Uninstall(root, settings);
        return "";
      }, delegate (string note) {
        Find<TextBlock>("DoneEyebrow").Text = "ГОТОВО";
        Find<TextBlock>("DoneTitle").Text = "Veyra удалена";
        Find<TextBlock>("DoneLead").Text = "Спасибо, что играли! Вернуть лаунчер можно в любой момент с veyra-launcher.com — сборки и миры будут ждать в «Документах».";
        Find<UIElement>("DoneTips").Visibility = Visibility.Collapsed;
        Finish(null);
      });
    }

    // Удаление из окна установщика: запускается деинсталлятор установленной версии.
    void StartUninstallFromInstaller() {
      var uninstaller = System.IO.Path.Combine(root, Engine.UninstallerName);
      if (!File.Exists(uninstaller)) { mode = "remove"; ShowRemove(); return; }
      Process.Start(new ProcessStartInfo(uninstaller, "--uninstall --root \"" + root + "\"") { UseShellExecute = false });
      exitCode = 0;
      window.Close();
    }

    void Work(string eyebrow, string title, string lead, string[] steps, Func<string> job, Action<string> done) {
      busy = true;
      Find<TextBlock>("WorkingEyebrow").Text = eyebrow;
      Find<TextBlock>("WorkingTitle").Text = title;
      Find<TextBlock>("WorkingLead").Text = lead;
      BuildSteps(steps);
      Find<ProgressBar>("Bar").Value = 0;
      Find<TextBlock>("BarText").Text = "Начинаем";
      Find<TextBlock>("BarPercent").Text = "0%";
      ShowPage("Working");
      Buttons(null, null, null, null);
      Find<Button>("CloseButton").IsEnabled = false;
      var dispatcher = window.Dispatcher;
      engine.Progress = delegate (double value, string status) { dispatcher.BeginInvoke(new Action(delegate { SetProgress(value, status); })); };
      engine.Step = delegate (int index) { dispatcher.BeginInvoke(new Action(delegate { SetStep(index); })); };
      var thread = new Thread(delegate () {
        try {
          var note = job();
          dispatcher.BeginInvoke(new Action(delegate { busy = false; Find<Button>("CloseButton").IsEnabled = true; SetStep(steps.Length); SetProgress(1, "Готово"); done(note); }));
        } catch (Exception error) {
          engine.Log.Write("Ошибка: " + error);
          var message = error is SetupException ? error.Message : "Непредвиденная ошибка: " + error.Message;
          dispatcher.BeginInvoke(new Action(delegate { busy = false; Find<Button>("CloseButton").IsEnabled = true; Failed(message); }));
        }
      });
      thread.IsBackground = true;
      thread.Start();
    }

    void BuildSteps(string[] steps) {
      var list = Find<StackPanel>("StepList");
      list.Children.Clear(); stepBoxes.Clear(); stepLabels.Clear();
      foreach (var step in steps) {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 11) };
        var box = new Border { Width = 21, Height = 21, BorderThickness = new Thickness(3), BorderBrush = Brush(0x17, 0x13, 0x1a), Background = Brush(0x1d, 0x18, 0x1f), Margin = new Thickness(0, 0, 13, 0) };
        var label = new TextBlock { Text = step, Style = (Style)view.Resources["OptionTitle"], VerticalAlignment = VerticalAlignment.Center, Foreground = Brush(0xa3, 0x96, 0x8f) };
        row.Children.Add(box); row.Children.Add(label); list.Children.Add(row);
        stepBoxes.Add(box); stepLabels.Add(label);
      }
    }
    void SetStep(int active) {
      for (int index = 0; index < stepBoxes.Count; index++) {
        var box = stepBoxes[index];
        box.BeginAnimation(UIElement.OpacityProperty, null);
        box.Opacity = 1;
        if (index < active) {
          box.Background = Brush(0x8e, 0xae, 0x91);
          box.Child = new Path { Data = Geometry.Parse((string)view.Resources["icon.check"]), Fill = Brush(0x17, 0x13, 0x1a), Stretch = Stretch.Fill, Width = 9, Height = 9 };
          stepLabels[index].Foreground = Brush(0xcd, 0xbf, 0xb4);
        } else if (index == active) {
          box.Background = Brush(0xd2, 0x9a, 0x8a);
          box.Child = null;
          stepLabels[index].Foreground = Brush(0xf0, 0xe1, 0xd3);
          box.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(1, 0.45, TimeSpan.FromMilliseconds(520)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever });
        } else {
          box.Background = Brush(0x1d, 0x18, 0x1f);
          box.Child = null;
          stepLabels[index].Foreground = Brush(0xa3, 0x96, 0x8f);
        }
      }
    }
    void SetProgress(double value, string status) {
      var bar = Find<ProgressBar>("Bar");
      var target = Math.Max(0, Math.Min(1000, value * 1000));
      bar.BeginAnimation(RangeBase.ValueProperty, new DoubleAnimation(target, TimeSpan.FromMilliseconds(180)));
      Find<TextBlock>("BarText").Text = status;
      Find<TextBlock>("BarPercent").Text = Math.Round(value * 100) + "%";
    }

    void Finish(string launchLabel) {
      finished = true;
      exitCode = 0;
      ShowPage("Done");
      var pop = new DoubleAnimation(0.4, 1, TimeSpan.FromMilliseconds(420)) { EasingFunction = new BackEase { Amplitude = 0.5, EasingMode = EasingMode.EaseOut } };
      Find<ScaleTransform>("DoneScale").BeginAnimation(ScaleTransform.ScaleXProperty, pop);
      Find<ScaleTransform>("DoneScale").BeginAnimation(ScaleTransform.ScaleYProperty, pop);
      if (launchLabel != null) {
        Buttons(launchLabel, "play", "Закрыть", "Create");
        finished = false;
        mode = "launch";
        retry = delegate {
          try { engine.Launch(root); } catch (Exception error) { engine.Log.Write("Запуск: " + error.Message); }
          window.Close();
        };
      } else Buttons("Готово", "check", null, "Primary");
    }
    void Failed(string message) {
      Find<TextBlock>("FailedTitle").Text = uninstall || mode == "remove" ? "Удаление не удалось" : "Установка не удалась";
      Find<TextBlock>("FailedLead").Text = message;
      ShowPage("Failed");
      exitCode = 1;
      Buttons("Повторить", "refresh", "Закрыть", "Primary");
    }

    static SolidColorBrush Brush(byte red, byte green, byte blue) { return new SolidColorBrush(Color.FromRgb(red, green, blue)); }
    static void Open(string target) {
      try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); } catch { }
    }
  }
}
