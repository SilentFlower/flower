using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class PortableLauncher
{
    private const string Product = "Flower Desktop";
    private const string Executable = "Flower Desktop.exe";
    private const string Identity = "flower-desktop-portable-1";
    private const string UpdateMode = "--flower-apply-update";
    private const int WaitForQuit = 45000;
    private static readonly Regex VersionPattern = new Regex(@"\A(0|[1-9][0-9]{0,7})\.(0|[1-9][0-9]{0,7})\.(0|[1-9][0-9]{0,7})\z");
    private static readonly Regex NoncePattern = new Regex(@"\A[0-9a-f]{32}\z");
    private static readonly Encoding Utf8 = new UTF8Encoding(false);
    private static readonly string Root = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar);

    /// <summary>打包阶段写入的 Windows 版本标记。</summary>
    private sealed class BuildMarker
    {
        public string product { get; set; }
        public string platform { get; set; }
        public string version { get; set; }
        public string channel { get; set; }
    }

    /// <summary>运行便携入口或独立更新助手。</summary>
    /// <param name="args">用户启动参数或工作台提交的本机更新上下文。</param>
    /// <returns>Windows 进程退出码。</returns>
    [STAThread]
    private static int Main(string[] args)
    {
        bool update = args.Length > 0 && args[0] == UpdateMode;
        try
        {
            DirectoryAt(Root);
            if (ReadText(Path.Combine(Root, ".flower-desktop-managed"), 100).Trim() != Identity)
                throw new InvalidOperationException("找不到 Flower Desktop 的便携安装标记。");

            using (var mutex = new Mutex(false, MutexName()))
            {
                bool locked;
                try { locked = mutex.WaitOne(WaitForQuit + 5000); }
                catch (AbandonedMutexException) { locked = true; }
                if (!locked) throw new InvalidOperationException("另一项 Flower Desktop 更新正在收尾，请稍后重试。");
                try
                {
                    if (update) return ApplyUpdate(args);
                    LaunchCurrent(args);
                }
                finally { mutex.ReleaseMutex(); }
            }
            return 0;
        }
        catch (Exception error)
        {
            if (update) ReportUpdateFailure(error);
            else MessageBox.Show(error.Message, Product, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }
    }

    private static int ApplyUpdate(string[] args)
    {
        int parentId;
        if (args.Length != 7 || !int.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out parentId)
            || parentId <= 0 || (args[4] != "restart" && args[4] != "exit") || !NoncePattern.IsMatch(args[6]))
            throw new ArgumentException("Flower Desktop 收到无效的更新请求。");

        var from = args[2];
        var to = args[3];
        var restart = args[4] == "restart";
        var profile = Path.GetFullPath(args[5]);
        // Windows 会把 TEMP 传成 8.3 短路径，GetFullPath 展开后仍指向同一资料目录。
        if (!Path.IsPathRooted(args[5]) || !SamePath(Path.GetPathRoot(profile), Path.GetPathRoot(args[5])))
            throw new ArgumentException("更新请求的资料目录无效。");
        var before = InspectVersion(from);
        var after = InspectVersion(to);
        if (before.channel != after.channel || new Version(to) <= new Version(from) || ReadPointer("current.txt") != from)
            throw new InvalidOperationException("当前版本或更新渠道已变化，请重新检查更新。");

        // 先持有经过核对的父进程句柄，再通知工作台可以退出，避免等错 PID。
        using (var parent = Process.GetProcessById(parentId))
        {
            if (parent.Handle == IntPtr.Zero || !SamePath(parent.MainModule.FileName, VersionExecutable(from)))
                throw new InvalidOperationException("更新请求不来自当前正在运行的 Flower Desktop。");
            var ready = Path.Combine(Root, ".flower-update-" + args[6] + ".ready");
            try
            {
                using (var ack = new FileStream(ready, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
                {
                    var bytes = Utf8.GetBytes(args[6] + "\n");
                    ack.Write(bytes, 0, bytes.Length);
                    ack.Flush(true);
                }
                if (!parent.WaitForExit(WaitForQuit))
                    throw new InvalidOperationException("Flower Desktop 仍在运行，更新已暂缓。");
                if (ReadPointer("current.txt") != from || InspectVersion(to).channel != after.channel)
                    throw new InvalidOperationException("更新期间安装目录发生变化，保留当前版本。");

                // 新指针只引用已经完整准备好的目录。旧版继续作为启动恢复入口。
                WriteAtomic("previous.txt", from + "\n");
                WriteAtomic("current.txt", to + "\n");
                if (restart)
                {
                    try { Launch(to, new[] { "--user-data-dir=" + profile }, true); }
                    catch
                    {
                        WriteAtomic("current.txt", from + "\n");
                        ReportUpdateFailure(new InvalidOperationException("新版启动失败，已恢复上一版。"));
                        Launch(from, new[] { "--user-data-dir=" + profile }, false);
                        return 1;
                    }
                }
                TryDelete(Path.Combine(Root, "last-update-error.txt"));
                return 0;
            }
            finally { TryDelete(ready); }
        }
    }

    private static void LaunchCurrent(string[] args)
    {
        string current = null;
        try
        {
            current = ReadPointer("current.txt");
            Launch(current, args, true);
        }
        catch
        {
            if (!File.Exists(Path.Combine(Root, "previous.txt"))) throw;
            var previous = ReadPointer("previous.txt");
            if (previous == current) throw;
            // 只有切换助手会记录上一版。换指针前已经核对两个版本属于同一渠道。
            InspectVersion(previous);
            WriteAtomic("current.txt", previous + "\n");
            ReportUpdateFailure(new InvalidOperationException("当前版本启动失败，已恢复上一版。"));
            Launch(previous, args, false);
        }
    }

    private static void Launch(string version, string[] args, bool checkStartup)
    {
        InspectVersion(version);
        var start = new ProcessStartInfo(VersionExecutable(version), string.Join(" ", args.Select(Quote)));
        start.WorkingDirectory = VersionDirectory(version);
        start.UseShellExecute = false;
        start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
        start.EnvironmentVariables.Remove("NODE_OPTIONS");
        start.EnvironmentVariables.Remove("NODE_PATH");
        using (var child = Process.Start(start))
        {
            if (child == null || (checkStartup && child.WaitForExit(1500) && child.ExitCode != 0))
                throw new InvalidOperationException("无法启动 Flower Desktop " + version + "。");
        }
    }

    // Windows 传参规则要求尾随反斜杠、内嵌双引号各自转义，确保资料目录按单参数传送。
    private static string Quote(string argument)
    {
        return "\"" + Regex.Replace(Regex.Replace(argument, "(\\\\*)\"", "$1$1\\\""), "(\\\\+)$", "$1$1") + "\"";
    }

    private static BuildMarker ReadMarker(string version)
    {
        DirectoryAt(Path.Combine(Root, "versions"));
        DirectoryAt(VersionDirectory(version));
        var contents = ReadText(Path.Combine(VersionDirectory(version), "flower-desktop-build.json"), 8192);
        var marker = new JavaScriptSerializer().Deserialize<BuildMarker>(contents);
        if (marker == null || marker.product != Product || marker.platform != "win32-x64" || marker.version != version
            || (marker.channel != "stable" && marker.channel != "qa"))
            throw new InvalidOperationException("Flower Desktop 版本标记无效。");
        return marker;
    }

    private static BuildMarker InspectVersion(string version)
    {
        var marker = ReadMarker(version);
        var resources = Path.Combine(VersionDirectory(version), "resources");
        DirectoryAt(resources);
        FileAt(Path.Combine(resources, "app.asar"));
        FileAt(VersionExecutable(version));
        return marker;
    }

    private static string VersionExecutable(string version) { return Path.Combine(VersionDirectory(version), Executable); }
    private static string VersionDirectory(string version)
    {
        if (!VersionPattern.IsMatch(version)) throw new InvalidOperationException("Flower Desktop 版本号无效。");
        return Path.Combine(Root, "versions", version);
    }

    private static string ReadPointer(string name)
    {
        var pointer = ReadText(Path.Combine(Root, name), 100).Trim();
        if (!VersionPattern.IsMatch(pointer)) throw new InvalidOperationException("Flower Desktop 启动指针无效。");
        return pointer;
    }

    private static bool SamePath(string left, string right)
    {
        return string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
    }

    private static string MutexName()
    {
        using (var sha = SHA256.Create())
            return "Local\\FlowerDesktop_" + BitConverter.ToString(sha.ComputeHash(Utf8.GetBytes(Root.ToUpperInvariant()))).Replace("-", "");
    }

    private static void DirectoryAt(string path)
    {
        if ((File.GetAttributes(path) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != FileAttributes.Directory)
            throw new IOException("Flower Desktop 的安装目录位置无效。");
    }

    private static void FileAt(string path)
    {
        if ((File.GetAttributes(path) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
            throw new IOException("Flower Desktop 的安装文件位置无效。");
    }

    private static string ReadText(string path, int limit)
    {
        FileAt(path);
        using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        using (var reader = new StreamReader(file, Utf8))
        {
            if (file.Length > limit) throw new IOException("Flower Desktop 更新信息超过长度上限。");
            return reader.ReadToEnd();
        }
    }

    private static void WriteAtomic(string name, string value)
    {
        var path = Path.Combine(Root, name);
        var temporary = Path.Combine(Root, ".pointer-" + Guid.NewGuid().ToString("N"));
        try
        {
            using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                var bytes = Utf8.GetBytes(value);
                file.Write(bytes, 0, bytes.Length);
                file.Flush(true);
            }
            if (File.Exists(path))
            {
                FileAt(path);
                File.Replace(temporary, path, null);
            }
            else File.Move(temporary, path);
        }
        finally { TryDelete(temporary); }
    }

    private static void ReportUpdateFailure(Exception error)
    {
        try { WriteAtomic("last-update-error.txt", error.Message); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
