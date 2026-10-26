using System;
using System.Collections.Generic;

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
        Console.WriteLine("Native notification receipt assertions passed.");
        return 0;
      } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
  }
}
