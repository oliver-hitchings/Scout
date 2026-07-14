using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;

namespace ScoutHost {
  static class Program {
    const string Url = "http://127.0.0.1:8459/";
    static Mutex mutex;
    [STAThread] static void Main(string[] args) {
      bool first;
      mutex = new Mutex(true, "Local\\Scout.Desktop.Host", out first);
      if (!first) { OpenDashboard(); return; }
      Application.EnableVisualStyles();
      Application.SetCompatibleTextRenderingDefault(false);
      Application.Run(new TrayContext(Array.IndexOf(args, "--background") >= 0));
    }
    public static void OpenDashboard() { Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true }); }
  }

  sealed class TrayContext : ApplicationContext {
    const string Url = "http://127.0.0.1:8459/";
    readonly NotifyIcon tray;
    readonly string root;
    Process serverProcess;
    System.Windows.Forms.Timer initialTimer;
    System.Windows.Forms.Timer dailyTimer;
    string updateUrl;

    public TrayContext(bool background) {
      root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
      tray = new NotifyIcon();
      tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
      tray.Text = "Scout";
      tray.Visible = true;
      var menu = new ContextMenuStrip();
      menu.Items.Add("Open Scout", null, delegate { Program.OpenDashboard(); });
      menu.Items.Add("Check for updates", null, delegate { CheckUpdates(true); });
      menu.Items.Add("Restart Scout", null, delegate { Post("api/restart", "{}"); });
      menu.Items.Add(new ToolStripSeparator());
      menu.Items.Add("Quit Scout", null, delegate { Quit(); });
      tray.ContextMenuStrip = menu;
      tray.DoubleClick += delegate { Program.OpenDashboard(); };
      tray.BalloonTipClicked += delegate { if (!String.IsNullOrEmpty(updateUrl)) Process.Start(new ProcessStartInfo(updateUrl) { UseShellExecute = true }); };
      if (!EnsureServer()) { tray.Visible = false; tray.Dispose(); return; }
      if (!background) Program.OpenDashboard();
      initialTimer = new System.Windows.Forms.Timer(); initialTimer.Interval = 10000; initialTimer.Tick += delegate { initialTimer.Stop(); CheckUpdates(false); }; initialTimer.Start();
      dailyTimer = new System.Windows.Forms.Timer(); dailyTimer.Interval = 60 * 60 * 1000; dailyTimer.Tick += delegate { CheckUpdates(false); }; dailyTimer.Start();
    }

    bool EnsureServer() {
      try {
        var info = new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string, object>>(Get("api/app-info"));
        var expected = Path.GetFullPath(Path.Combine(root, "app")).TrimEnd('\\');
        var actual = Path.GetFullPath(Convert.ToString(info["appRoot"])).TrimEnd('\\');
        if (String.Equals(expected, actual, StringComparison.OrdinalIgnoreCase)) return true;
        MessageBox.Show("Another Scout copy is already using the local dashboard. Quit it before opening this version.\n\nRunning from: " + actual, "Scout", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        ExitThread(); return false;
      } catch { }
      var runtime = Path.Combine(root, "runtime", "ScoutRuntime.exe");
      var server = Path.Combine(root, "app", "ui", "server.mjs");
      var startInfo = new ProcessStartInfo(runtime, Quote(server));
      startInfo.WorkingDirectory = Path.Combine(root, "app"); startInfo.UseShellExecute = false; startInfo.CreateNoWindow = true; startInfo.WindowStyle = ProcessWindowStyle.Hidden;
      serverProcess = Process.Start(startInfo);
      for (var i = 0; i < 50; i++) { Thread.Sleep(300); try { Get(""); return true; } catch { } }
      MessageBox.Show("Scout did not start. Check the workspace logs.", "Scout", MessageBoxButtons.OK, MessageBoxIcon.Error);
      return false;
    }

    void CheckUpdates(bool force) {
      try {
        var body = Post("api/update/check", "{\"force\":" + (force ? "true" : "false") + "}");
        var available = body.Contains("\"available\":true");
        var notify = force || body.Contains("\"notify\":true");
        var match = Regex.Match(body, "\"url\":\"(https://github\\.com/oliver-hitchings/Scout/releases/[^\"]+)\"");
        if (available && match.Success && notify) {
          updateUrl = match.Groups[1].Value.Replace("\\/", "/");
          tray.BalloonTipTitle = "Scout update available"; tray.BalloonTipText = "Click to open the verified GitHub release."; tray.ShowBalloonTip(8000);
        } else if (force) MessageBox.Show("Scout is up to date.", "Scout", MessageBoxButtons.OK, MessageBoxIcon.Information);
      } catch (Exception ex) { if (force) MessageBox.Show("Update check failed: " + ex.Message, "Scout", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
    }

    void Quit() {
      using (var dialog = new QuitDialog()) {
        var choice = dialog.ShowDialog();
        if (choice == DialogResult.Cancel) return;
        if (choice == DialogResult.No) {
          try { Post("api/schedule", "{\"action\":\"remove\"}"); }
          catch (Exception ex) { MessageBox.Show("Daily scans could not be disabled, so Scout remains open. " + ex.Message, "Scout", MessageBoxButtons.OK, MessageBoxIcon.Error); return; }
        }
      }
      StopServer(); tray.Visible = false; tray.Dispose(); ExitThread();
    }

    void StopServer() {
      try { Post("api/shutdown", "{}"); return; } catch { }
      try { if (serverProcess != null && !serverProcess.HasExited) serverProcess.Kill(); } catch { }
    }

    static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
    static string Get(string path) { using (var client = new WebClient()) { return client.DownloadString(Url + path); } }
    static string Post(string path, string json) {
      var request = (HttpWebRequest)WebRequest.Create(Url + path); request.Method = "POST"; request.ContentType = "application/json";
      var bytes = Encoding.UTF8.GetBytes(json); request.ContentLength = bytes.Length; using (var stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
      using (var response = (HttpWebResponse)request.GetResponse()) using (var reader = new StreamReader(response.GetResponseStream())) return reader.ReadToEnd();
    }
  }

  sealed class QuitDialog : Form {
    public QuitDialog() {
      Text = "Quit Scout"; Width = 510; Height = 190; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false; StartPosition = FormStartPosition.CenterScreen;
      var label = new Label { Left = 18, Top = 18, Width = 460, Height = 42, Text = "Scout has scheduled daily scans. What should happen when the app closes?" };
      var keep = new Button { Left = 18, Top = 78, Width = 205, Height = 34, Text = "Keep scans enabled", DialogResult = DialogResult.Yes };
      var disable = new Button { Left = 230, Top = 78, Width = 155, Height = 34, Text = "Disable and quit", DialogResult = DialogResult.No };
      var cancel = new Button { Left = 392, Top = 78, Width = 80, Height = 34, Text = "Cancel", DialogResult = DialogResult.Cancel };
      Controls.Add(label); Controls.Add(keep); Controls.Add(disable); Controls.Add(cancel); CancelButton = cancel;
    }
  }

}
