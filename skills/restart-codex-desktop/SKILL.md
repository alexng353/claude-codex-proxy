---
name: restart-codex-desktop
description: Restart Alex's Linux Codex Desktop after configuration or archive patches, using an independent job that verifies the relaunched window. Use when a desktop restart is requested or already authorized.
---

# Restart Codex Desktop

This skill targets the Arch/Hyprland installation: `/usr/bin/chatgpt` launches
`/usr/lib/chatgpt/ChatGPT`. Inspect the host before using it elsewhere.

Finish and verify requested work before restarting. Check other active tasks with
`list_threads`; report any that the restart will interrupt. A restart request is
sufficient authorization; do not ask again. If no restart was authorized, obtain
that authorization before scheduling one.

1. Run `python3 <skill-dir>/scripts/restart.py --probe`. This checks the actual
   main process, mapped window, and working Hyprland dispatcher without closing
   anything. Stop on failure and diagnose it.
2. Finish the user-facing report, then run
   `python3 <skill-dir>/scripts/restart.py --schedule 15` as the last action.
   Send the final response during the delay. The independent systemd job survives
   the app closing and records `~/.local/state/codex-restart/status.json`.
3. Say **scheduled**, not **restarted**, until the status reports `verified` with
   a new PID and mapped window. After reconnecting, inspect that file and, if
   needed, `journalctl --user -u codex-desktop-restart.service -n 40`.

The helper captures only graphical-session environment keys before quitting,
uses SIGTERM with a bounded wait, launches through `hl.dsp.exec_cmd`, and restores
the previous workspace. It never kills the proxy service or unrelated Codex CLI
processes. It stops rather than escalating to SIGKILL. Do not use broad
`pkill -f codex` or run the restart inside a shell owned by the app.

A previous relaunch merely dispatched a command and logged success despite no
window returning. A detached launcher needs the session bus/graphical environment;
Hyprland's legacy `dispatch exec ...` syntax also fails on this Lua-based setup.
The helper verifies both the dispatcher and a new mapped window. No conversation
state, sidebar data, credentials, or model cache needs editing for a restart.
