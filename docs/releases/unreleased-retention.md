# Unreleased: bounded scan storage

- Historical recovery decisions no longer keep otherwise eligible completed or
  terminally skipped runs forever. Active work, queued work, damaged journals and
  unreceipted mutations remain protected.
- Measuring storage pressure no longer reads every artifact body. Review and
  archive still verify contents before any selected source is deleted.
- New scan-input diagnostics share their run's retention. Existing external
  inputs count towards pressure and can use the same reviewed encrypted archive.
- Reviewed cleanup compacts old recovery selections with an encrypted audit and
  a recoverable receipt. It keeps recent records and current run dispositions.

The dashboard continues to show storage pressure. There is no new cleanup button,
public cleanup command, automatic deletion or archive-expiry policy. See
[scan storage and reviewed cleanup](../OPERATIONS.md#scan-storage-and-reviewed-cleanup)
for the maintenance boundary.
