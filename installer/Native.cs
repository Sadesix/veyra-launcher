using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

namespace Veyra.Setup {
  // Вызовы Windows, которых нет в .NET Framework: ярлыки с AppUserModelID (по нему панель задач
  // группирует окна лаунчера с ярлыком), современный выбор папки и квадратные углы окна в Windows 11.
  static class Native {
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    class ShellLinkCom { }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
    interface IShellLinkW {
      void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int max, IntPtr data, uint flags);
      void GetIDList(out IntPtr list);
      void SetIDList(IntPtr list);
      void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int max);
      void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
      void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int max);
      void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
      void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int max);
      void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
      void GetHotkey(out short key);
      void SetHotkey(short key);
      void GetShowCmd(out int cmd);
      void SetShowCmd(int cmd);
      void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int max, out int index);
      void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
      void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
      void Resolve(IntPtr window, uint flags);
      void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    interface IPropertyStore {
      void GetCount(out uint count);
      void GetAt(uint index, out PropertyKey key);
      void GetValue(ref PropertyKey key, out PropVariant value);
      void SetValue(ref PropertyKey key, ref PropVariant value);
      void Commit();
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct PropertyKey { public Guid Format; public uint Id; }

    [StructLayout(LayoutKind.Explicit)]
    struct PropVariant {
      [FieldOffset(0)] public ushort Type;
      [FieldOffset(8)] public IntPtr Pointer;
      [FieldOffset(8)] public long Padding;
    }

    public static void CreateShortcut(string link, string target, string workingDirectory, string description, string appId) {
      Directory.CreateDirectory(Path.GetDirectoryName(link));
      var shell = (IShellLinkW)new ShellLinkCom();
      try {
        shell.SetPath(target);
        shell.SetWorkingDirectory(workingDirectory);
        shell.SetDescription(description);
        shell.SetIconLocation(target, 0);
        var store = (IPropertyStore)shell;
        var key = new PropertyKey { Format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), Id = 5 };
        var value = new PropVariant { Type = 31, Pointer = Marshal.StringToCoTaskMemUni(appId) };
        try {
          store.SetValue(ref key, ref value);
          store.Commit();
        } finally { Marshal.FreeCoTaskMem(value.Pointer); }
        ((IPersistFile)shell).Save(link, true);
      } finally { Marshal.ReleaseComObject(shell); }
    }

    // Куда ведёт ярлык: удаляются только ярлыки, которые указывают на эту установку.
    public static string ShortcutTarget(string link) {
      if (!File.Exists(link)) return null;
      var shell = (IShellLinkW)new ShellLinkCom();
      try {
        ((IPersistFile)shell).Load(link, 0);
        var path = new StringBuilder(1024);
        shell.GetPath(path, path.Capacity, IntPtr.Zero, 0);
        return path.ToString();
      } catch { return null; }
      finally { Marshal.ReleaseComObject(shell); }
    }

    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    class FileOpenDialogCom { }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("42f85136-db7e-439c-85f1-e4075d135fc8")]
    interface IFileDialog {
      [PreserveSig] int Show(IntPtr parent);
      void SetFileTypes(uint count, IntPtr specs);
      void SetFileTypeIndex(uint index);
      void GetFileTypeIndex(out uint index);
      void Advise(IntPtr sink, out uint cookie);
      void Unadvise(uint cookie);
      void SetOptions(uint options);
      void GetOptions(out uint options);
      void SetDefaultFolder(IShellItem item);
      void SetFolder(IShellItem item);
      void GetFolder(out IShellItem item);
      void GetCurrentSelection(out IShellItem item);
      void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
      void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
      void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
      void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
      void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
      void GetResult(out IShellItem item);
      void AddPlace(IShellItem item, int place);
      void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
      void Close(int result);
      void SetClientGuid(ref Guid guid);
      void ClearClientData();
      void SetFilter(IntPtr filter);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    interface IShellItem {
      void BindToHandler(IntPtr context, ref Guid handler, ref Guid interfaceId, out IntPtr result);
      void GetParent(out IShellItem parent);
      void GetDisplayName(uint form, [MarshalAs(UnmanagedType.LPWStr)] out string name);
      void GetAttributes(uint mask, out uint attributes);
      void Compare(IShellItem other, uint hint, out int order);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr context, ref Guid interfaceId, out IShellItem item);

    // Выбор папки в окне проводника Windows; null — если пользователь передумал.
    public static string PickFolder(IntPtr owner, string title, string start) {
      var dialog = (IFileDialog)new FileOpenDialogCom();
      try {
        dialog.SetOptions(0x20 | 0x40 | 0x800);
        dialog.SetTitle(title);
        dialog.SetOkButtonLabel("Выбрать папку");
        try {
          var folder = start;
          while (!string.IsNullOrEmpty(folder) && !Directory.Exists(folder)) folder = Path.GetDirectoryName(folder);
          if (!string.IsNullOrEmpty(folder)) {
            var id = typeof(IShellItem).GUID;
            IShellItem item;
            SHCreateItemFromParsingName(folder, IntPtr.Zero, ref id, out item);
            dialog.SetFolder(item);
          }
        } catch { }
        if (dialog.Show(owner) != 0) return null;
        IShellItem result;
        dialog.GetResult(out result);
        string path;
        result.GetDisplayName(0x80058000, out path);
        return path;
      } finally { Marshal.ReleaseComObject(dialog); }
    }

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

    // Пиксельному окну нужны прямые углы: Windows 11 иначе скругляет их сама.
    public static void SquareCorners(IntPtr window) {
      try { int square = 1; DwmSetWindowAttribute(window, 33, ref square, 4); } catch { }
    }
  }
}
