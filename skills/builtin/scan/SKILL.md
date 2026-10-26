---
name: scan
description: Run Scout's trusted scan runtime and review the recorded opportunities, assessment results and dated report.
---

# Scan opportunities

Before acting, read `docs/SCOUT_SCAN_PROTOCOL.md`, `AGENTS.md`, `workspace.json`, and the private profile. Follow the canonical protocol exactly. For unattended work, require explicit `agent` and `mode`; otherwise use the provider selected in `workspace.json` and `mode=primary`.

Start the installed runtime with `scout scan --provider PROVIDER --mode MODE` (`PROVIDER` is `codex` or `claude`; `MODE` is `primary` or `second-pass`) using the selected private workspace. The runtime owns collection, assessment, tracker/report mutation, queueing and recovery. Do not independently browse and rewrite scan outputs, invoke the compatibility lock CLI as a substitute, or commit workspace changes while a scan owns mutation authority. Review the runtime result and retry only through its explicit recovery path.
