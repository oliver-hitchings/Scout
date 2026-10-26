using System;
using System.Collections.Generic;
using System.IO;
using System.Net;

namespace ScoutHost {
  static class NativeTests {
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    static string Id(int value) { return value.ToString("x64"); }
    public static int Main() {
      try {
        var state = new NotificationDeliveryState(3, 2);
        Check(state.ShouldDisplay(Id(1)), "A new notification must be displayed");
        Check(!state.HasPendingReceipts, "An unseen balloon must never be receipted");
        state.QueueReceipt(Id(1));
        Check(!state.HasPendingReceipts, "Queueing cannot receipt a balloon before Windows reports it shown");
        state.MarkShown(Id(1));
        Check(!state.ShouldDisplay(Id(1)), "A shown balloon must not be displayed again");
        Check(state.PendingReceiptIds().Count == 1, "The shown event queues one receipt");
        state.MarkShown(Id(1));
        Check(state.PendingReceiptIds().Count == 1, "Duplicate native shown events must deduplicate receipts");
        state.ReceiptResult(Id(1), 503);
        Check(state.HasPendingReceipts && !state.ShouldDisplay(Id(1)), "A failed receipt retries without redisplaying the balloon");
        state.ReceiptResult(Id(1), 200);
        Check(!state.HasPendingReceipts, "A successful receipt drains the pending acknowledgement");
        state.QueueReceipt(Id(1)); state.ReceiptResult(Id(1), 404);
        Check(!state.HasPendingReceipts, "A retired outbox item drains its pending acknowledgement");
        state.MarkShown(Id(2)); state.MarkShown(Id(3)); state.MarkShown(Id(4));
        Check(state.PendingReceiptIds().Count == 2, "A poll cannot exceed its bounded receipt batch");
        Check(!state.ShouldDisplay(Id(4)) && !state.ShouldDisplay(Id(3)), "Capacity eviction preserves the newest shown identities");
        Check(state.ShouldDisplay(Id(1)), "Only the oldest bounded shown identity is evicted");
        Check(!state.ShouldDisplay("invalid-id"), "Malformed notification identifiers are not displayed");
        var diagnosticsRoot = Path.Combine(Path.GetTempPath(), "scout-native-diagnostics-" + Guid.NewGuid().ToString("N"));
        var diagnosticsFile = Path.Combine(diagnosticsRoot, "host-notifications.log");
        try {
          var diagnostics = new NotificationDiagnostics(diagnosticsFile);
          diagnostics.RecordPollFailure(new WebException("Synthetic private detail must never be logged", WebExceptionStatus.Timeout));
          var first = File.ReadAllText(diagnosticsFile);
          Check(first.Contains("notification-poll-timeout"), "A failed poll records a bounded timeout reason");
          Check(!first.Contains("private detail"), "Exception messages must never enter diagnostics");
          diagnostics.RecordReceiptFailure(new ArgumentException("Synthetic private path"));
          Check(File.ReadAllText(diagnosticsFile).Contains("notification-receipt-invalid-response"), "Receipt failures are separately diagnosable");
          for (var i = 0; i < 1500; i++) diagnostics.RecordPollFailure(new Exception("Synthetic raw failure"));
          Check(new FileInfo(diagnosticsFile).Length <= NotificationDiagnostics.MaximumBytes, "Repeated failures retain a bounded diagnostic file");
          Check(!File.ReadAllText(diagnosticsFile).Contains("raw failure"), "Wrapped diagnostics contain only reason codes");
        } finally { if (Directory.Exists(diagnosticsRoot)) Directory.Delete(diagnosticsRoot, true); }
        Console.WriteLine("Native notification receipt assertions passed.");
        return 0;
      } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
  }
}
