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

  // This state is independent of WinForms so the actual host assembly can be
  // compiled and its delivery boundary exercised without displaying a desktop.
  sealed class NotificationDeliveryState {
    readonly System.Collections.Generic.HashSet<string> shownNotificationIds = new System.Collections.Generic.HashSet<string>();
    readonly System.Collections.Generic.HashSet<string> pendingNotificationReceipts = new System.Collections.Generic.HashSet<string>();
    readonly System.Collections.Generic.Queue<string> shownOrder = new System.Collections.Generic.Queue<string>();
    readonly int capacity;
    readonly int batchSize;
    public NotificationDeliveryState(int capacity = 1000, int batchSize = 4) {
      if (capacity < 1 || batchSize < 1) throw new ArgumentOutOfRangeException();
      this.capacity = capacity; this.batchSize = batchSize;
    }
    public bool HasPendingReceipts { get { return pendingNotificationReceipts.Count > 0; } }
    public bool ShouldDisplay(string id) {
      return id != null && Regex.IsMatch(id, "^[a-f0-9]{64}$") && !shownNotificationIds.Contains(id);
    }
    public void MarkShown(string id) {
      if (id == null || !Regex.IsMatch(id, "^[a-f0-9]{64}$")) return;
      if (shownNotificationIds.Add(id)) {
        shownOrder.Enqueue(id);
        while (shownOrder.Count > capacity) shownNotificationIds.Remove(shownOrder.Dequeue());
      }
      pendingNotificationReceipts.Add(id);
    }
    public void QueueReceipt(string id) {
      if (id != null && shownNotificationIds.Contains(id)) pendingNotificationReceipts.Add(id);
    }
    public System.Collections.Generic.List<string> PendingReceiptIds() {
      var result = new System.Collections.Generic.List<string>();
      foreach (var id in pendingNotificationReceipts) { if (result.Count >= batchSize) break; result.Add(id); }
      return result;
    }
    public void ReceiptResult(string id, int status) {
      if ((status >= 200 && status < 300) || status == 404) pendingNotificationReceipts.Remove(id);
    }
  }

  sealed class NotificationDiagnostics {
    public const int MaximumBytes = 64 * 1024;
    readonly string file;
    readonly object gate = new object();
    public NotificationDiagnostics(string file) { this.file = file; }
    public static NotificationDiagnostics Local() {
      return new NotificationDiagnostics(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Scout", "logs", "host-notifications.log"));
    }
    string Reason(Exception error) {
      var web = error as WebException;
      if (web != null) return web.Status == WebExceptionStatus.Timeout ? "timeout" : "http";
      return error is ArgumentException || error is InvalidOperationException || error is System.Collections.Generic.KeyNotFoundException ? "invalid-response" : "unavailable";
    }
    public void RecordPollFailure(Exception error) { Record("notification-poll-" + Reason(error)); }
    public void RecordReceiptFailure(Exception error) { Record("notification-receipt-" + Reason(error)); }
    void Record(string reason) {
      lock (gate) {
        try {
          var directory = Path.GetDirectoryName(file);
          Directory.CreateDirectory(directory);
          // Diagnostics contain reason codes only and must not follow a linked
          // log path into another file when the bounded log wraps.
          for (var entry = new DirectoryInfo(directory); entry != null; entry = entry.Parent) {
            if ((entry.Attributes & FileAttributes.ReparsePoint) != 0) return;
          }
          if (File.Exists(file) && (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) return;
          var bytes = Encoding.UTF8.GetBytes(DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture) + " " + reason + Environment.NewLine);
          using (var stream = new FileStream(file, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.Read)) {
            if (stream.Length + bytes.Length > MaximumBytes) stream.SetLength(0);
            stream.Seek(0, SeekOrigin.End); stream.Write(bytes, 0, bytes.Length); stream.Flush();
          }
        } catch { /* Diagnostics must not interrupt retries or reveal raw errors. */ }
      }
    }
  }

  sealed class TrayContext : ApplicationContext {
    const string Url = "http://127.0.0.1:8459/";
    readonly NotifyIcon tray;
    readonly string root;
    Process serverProcess;
    System.Windows.Forms.Timer initialTimer;
    System.Windows.Forms.Timer dailyTimer;
    System.Windows.Forms.Timer watchdogTimer;
    System.Windows.Forms.Timer notificationTimer;
    readonly NotificationDeliveryState notificationDelivery = new NotificationDeliveryState();
    readonly NotificationDiagnostics notificationDiagnostics = NotificationDiagnostics.Local();
    NotifyIcon notificationIcon;
    DateTime notificationIconExpiresAt = DateTime.MinValue;
    string pendingBalloonTitle;
    string pendingBalloonText;
    string pendingBalloonUrl;
    int pendingBalloonDuration;
    DateTime balloonBusyUntil = DateTime.MinValue;
    int restartAttempts;
    DateTime nextRestartAt = DateTime.MinValue;
    bool quitting;
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
      tray.BalloonTipClicked += delegate {
        if (!String.IsNullOrEmpty(updateUrl)) Process.Start(new ProcessStartInfo(updateUrl) { UseShellExecute = true });
        else Program.OpenDashboard();
      };
      tray.BalloonTipClosed += delegate { updateUrl = null; balloonBusyUntil = DateTime.MinValue; ShowPendingStatusBalloon(); };
      var started = EnsureServer(true);
      if (!background && started) Program.OpenDashboard();
      initialTimer = new System.Windows.Forms.Timer(); initialTimer.Interval = 10000; initialTimer.Tick += delegate { initialTimer.Stop(); CheckUpdates(false); }; initialTimer.Start();
      dailyTimer = new System.Windows.Forms.Timer(); dailyTimer.Interval = 60 * 60 * 1000; dailyTimer.Tick += delegate { CheckUpdates(false); }; dailyTimer.Start();
      notificationTimer = new System.Windows.Forms.Timer(); notificationTimer.Interval = 30000; notificationTimer.Tick += delegate { PollNotifications(); }; notificationTimer.Start();
      watchdogTimer = new System.Windows.Forms.Timer(); watchdogTimer.Interval = 30000; watchdogTimer.Tick += delegate { WatchdogTick(); }; watchdogTimer.Start();
    }

    string RunningAppRoot() {
      try {
        var info = new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string, object>>(Get("api/app-info"));
        return Path.GetFullPath(Convert.ToString(info["appRoot"])).TrimEnd('\\');
      } catch { }
      return null;
    }

    bool ServerHealthy() {
      var actual = RunningAppRoot();
      var expected = Path.GetFullPath(Path.Combine(root, "app")).TrimEnd('\\');
      return actual != null && String.Equals(expected, actual, StringComparison.OrdinalIgnoreCase);
    }

    bool EnsureServer(bool notifyFailure) {
      if (ServerHealthy()) return true;
      var running = RunningAppRoot();
      if (running != null) {
        if (notifyFailure) MessageBox.Show("Another Scout copy is already using the local dashboard. Quit it before opening this version.\n\nRunning from: " + running, "Scout", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        return false;
      }
      var runtime = Path.Combine(root, "runtime", "ScoutRuntime.exe");
      var server = Path.Combine(root, "app", "ui", "server.mjs");
      var startInfo = new ProcessStartInfo(runtime, Quote(server));
      startInfo.WorkingDirectory = Path.Combine(root, "app"); startInfo.UseShellExecute = false; startInfo.CreateNoWindow = true; startInfo.WindowStyle = ProcessWindowStyle.Hidden;
      serverProcess = Process.Start(startInfo);
      for (var i = 0; i < 50; i++) { Thread.Sleep(300); try { Get(""); return true; } catch { } }
      if (notifyFailure) MessageBox.Show("Scout did not start yet. The tray host will keep trying in the background.", "Scout", MessageBoxButtons.OK, MessageBoxIcon.Warning);
      return false;
    }

    void WatchdogTick() {
      if (quitting) return;
      if (ServerHealthy()) { restartAttempts = 0; nextRestartAt = DateTime.MinValue; return; }
      if (DateTime.UtcNow < nextRestartAt) return;
      try { if (serverProcess != null && !serverProcess.HasExited) serverProcess.Kill(); } catch { }
      if (EnsureServer(false)) {
        restartAttempts = 0; nextRestartAt = DateTime.MinValue;
        ShowStatusBalloon("Scout recovered", "The Scout runtime restarted and remote access is available again.", 5000);
        return;
      }
      restartAttempts++;
      var delays = new[] { 30, 60, 120, 300 };
      nextRestartAt = DateTime.UtcNow.AddSeconds(delays[Math.Min(restartAttempts - 1, delays.Length - 1)]);
      ShowStatusBalloon("Scout is recovering", "The runtime is unavailable. Scout will keep retrying in the background.", 5000);
    }

    void ConfirmNotificationDelivery() {
      foreach (var id in notificationDelivery.PendingReceiptIds()) {
        try {
          Post("api/notifications/delivered", new JavaScriptSerializer().Serialize(new { id = id }), 3000);
          notificationDelivery.ReceiptResult(id, 200);
        } catch (WebException error) {
          var response = error.Response as HttpWebResponse;
          var retired = response != null && response.StatusCode == HttpStatusCode.NotFound;
          if (response != null) response.Close();
          if (retired) { notificationDelivery.ReceiptResult(id, 404); continue; }
          notificationDiagnostics.RecordReceiptFailure(error);
          break; // Retry the receipt without displaying the balloon again.
        } catch (Exception error) { notificationDiagnostics.RecordReceiptFailure(error); break; }
      }
    }

    void RetireNotificationIcon(NotifyIcon owner) {
      // A late event from an older icon must not clear or unhide a newer one.
      if (Object.ReferenceEquals(notificationIcon, owner)) {
        notificationIcon = null;
        if (!quitting) tray.Visible = true;
      }
      owner.Dispose();
    }

    void ShowNotificationBalloon(string id, string title, string body) {
      var owner = new NotifyIcon();
      owner.Icon = tray.Icon; owner.Text = "Scout"; owner.ContextMenuStrip = tray.ContextMenuStrip;
      owner.DoubleClick += delegate { Program.OpenDashboard(); };
      owner.BalloonTipClicked += delegate { Program.OpenDashboard(); };
      owner.BalloonTipShown += delegate {
        notificationDelivery.MarkShown(id);
        ConfirmNotificationDelivery();
      };
      owner.BalloonTipClosed += delegate {
        RetireNotificationIcon(owner);
        ShowPendingStatusBalloon();
      };
      notificationIcon = owner;
      notificationIconExpiresAt = DateTime.UtcNow.AddSeconds(15);
      tray.Visible = false; owner.Visible = true;
      owner.BalloonTipTitle = title; owner.BalloonTipText = body; owner.ShowBalloonTip(8000);
    }

    void PollNotifications() {
      if (quitting) return;
      ConfirmNotificationDelivery();
      if (notificationIcon != null && DateTime.UtcNow >= notificationIconExpiresAt) RetireNotificationIcon(notificationIcon);
      if (DateTime.UtcNow > balloonBusyUntil) updateUrl = null;
      ShowPendingStatusBalloon();
      if (DateTime.UtcNow < balloonBusyUntil || notificationDelivery.HasPendingReceipts || notificationIcon != null || !String.IsNullOrEmpty(updateUrl)) return;
      try {
        var response = new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string, object>>(Post("api/notifications/poll", "{}", 3000));
        var outbox = response["outbox"] as System.Collections.IEnumerable;
        if (outbox == null) return;
        foreach (var raw in outbox) {
          var alert = raw as System.Collections.Generic.Dictionary<string, object>;
          if (alert == null) continue;
          var id = Convert.ToString(alert["id"]);
          if (!Regex.IsMatch(id, "^[a-f0-9]{64}$")) continue;
          if (!notificationDelivery.ShouldDisplay(id)) { notificationDelivery.QueueReceipt(id); ConfirmNotificationDelivery(); continue; }
          var title = Convert.ToString(alert["title"]);
          var body = Convert.ToString(alert["body"]);
          if (title.Length > 100 || body.Length > 250) continue;
          ShowNotificationBalloon(id, title, body);
          break;
        }
      } catch (Exception error) { notificationDiagnostics.RecordPollFailure(error); }
    }

    void ShowStatusBalloon(string title, string text, int duration, string link = null) {
      if (quitting) return;
      if (notificationIcon != null || DateTime.UtcNow < balloonBusyUntil) {
        pendingBalloonTitle = title; pendingBalloonText = text; pendingBalloonDuration = duration; pendingBalloonUrl = link;
        return;
      }
      updateUrl = link;
      balloonBusyUntil = DateTime.UtcNow.AddSeconds(15);
      tray.BalloonTipTitle = title; tray.BalloonTipText = text; tray.ShowBalloonTip(duration);
    }

    void ShowPendingStatusBalloon() {
      if (quitting) return;
      if (String.IsNullOrEmpty(pendingBalloonTitle) || notificationIcon != null || DateTime.UtcNow < balloonBusyUntil) return;
      var title = pendingBalloonTitle; var text = pendingBalloonText; var duration = pendingBalloonDuration; var link = pendingBalloonUrl;
      pendingBalloonTitle = null; pendingBalloonText = null; pendingBalloonUrl = null;
      ShowStatusBalloon(title, text, duration, link);
    }

    void CheckUpdates(bool force) {
      try {
        var body = Post("api/update/check", "{\"force\":" + (force ? "true" : "false") + "}");
        var available = body.Contains("\"available\":true");
        var notify = force || body.Contains("\"notify\":true");
        var match = Regex.Match(body, "\"url\":\"(https://github\\.com/oliver-hitchings/Scout/releases/[^\"]+)\"");
        if (available && match.Success && notify) {
          var releaseUrl = match.Groups[1].Value.Replace("\\/", "/");
          ShowStatusBalloon("Scout update available", "Click to open the verified GitHub release.", 8000, releaseUrl);
        } else if (force) MessageBox.Show("Scout is up to date.", "Scout", MessageBoxButtons.OK, MessageBoxIcon.Information);
      } catch (Exception ex) { if (force) MessageBox.Show("Update check failed: " + ex.Message, "Scout", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
    }

    void Quit() {
      var remoteAccess = HasRemoteAccess();
      if (!HasScheduledScans()) {
        var message = remoteAccess
          ? "Quit Scout? Remote access will stop until Scout is relaunched or your next Windows sign-in."
          : "Quit Scout? No daily scan is currently scheduled.";
        var choice = MessageBox.Show(message, "Quit Scout", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
        if (choice != DialogResult.Yes) return;
        quitting = true; StopServer(); DisposeTrayIcons(); ExitThread(); return;
      }
      using (var dialog = new QuitDialog(remoteAccess)) {
        var choice = dialog.ShowDialog();
        if (choice == DialogResult.Cancel) return;
        if (choice == DialogResult.No) {
          try { Post("api/schedule", "{\"action\":\"remove\"}"); }
          catch (Exception ex) { MessageBox.Show("Daily scans could not be disabled, so Scout remains open. " + ex.Message, "Scout", MessageBoxButtons.OK, MessageBoxIcon.Error); return; }
        }
      }
      quitting = true; StopServer(); DisposeTrayIcons(); ExitThread();
    }

    bool HasScheduledScans() {
      try {
        var status = new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string, object>>(Get("api/setup/status"));
        var schedule = status["schedule"] as System.Collections.Generic.Dictionary<string, object>;
        return schedule != null && schedule.ContainsKey("enabled") && Convert.ToBoolean(schedule["enabled"]);
      } catch { return false; }
    }

    bool HasRemoteAccess() {
      try {
        var status = new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string, object>>(Get("api/remote-access/status"));
        return status.ContainsKey("enabled") && Convert.ToBoolean(status["enabled"]);
      } catch { return false; }
    }

    void DisposeTrayIcons() {
      if (notificationIcon != null) notificationIcon.Dispose();
      notificationIcon = null;
      tray.Visible = false; tray.Dispose();
    }

    void StopServer() {
      try { Post("api/shutdown", "{}"); return; } catch { }
      try { if (serverProcess != null && !serverProcess.HasExited) serverProcess.Kill(); } catch { }
    }

    static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
    static string Get(string path) { using (var client = new WebClient()) { return client.DownloadString(Url + path); } }
    static string Post(string path, string json, int timeout = 0) {
      var request = (HttpWebRequest)WebRequest.Create(Url + path); request.Method = "POST"; request.ContentType = "application/json"; if (timeout > 0) { request.Timeout = timeout; request.ReadWriteTimeout = timeout; }
      var bytes = Encoding.UTF8.GetBytes(json); request.ContentLength = bytes.Length; using (var stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
      using (var response = (HttpWebResponse)request.GetResponse()) using (var reader = new StreamReader(response.GetResponseStream())) return reader.ReadToEnd();
    }
  }

  sealed class QuitDialog : Form {
    public QuitDialog(bool remoteAccess) {
      Text = "Quit Scout"; Width = 510; Height = 190; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false; StartPosition = FormStartPosition.CenterScreen;
      var label = new Label { Left = 18, Top = 18, Width = 460, Height = 52, Text = remoteAccess ? "Scout has scheduled scans. Quitting also stops remote access until relaunch or next sign-in." : "Scout has scheduled daily scans. What should happen when the app closes?" };
      var keep = new Button { Left = 18, Top = 78, Width = 205, Height = 34, Text = "Keep scans enabled", DialogResult = DialogResult.Yes };
      var disable = new Button { Left = 230, Top = 78, Width = 155, Height = 34, Text = "Disable and quit", DialogResult = DialogResult.No };
      var cancel = new Button { Left = 392, Top = 78, Width = 80, Height = 34, Text = "Cancel", DialogResult = DialogResult.Cancel };
      Controls.Add(label); Controls.Add(keep); Controls.Add(disable); Controls.Add(cancel); CancelButton = cancel;
    }
  }

}
