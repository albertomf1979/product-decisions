# Claude Code hook fixtures

Payloads captured on 2026-11-05 from Claude Code 2.1.310 by a probe plugin, with the home directory replaced by `/home/user` and personal details removed. File names follow `<HookEvent>[-variant].json`.

| Fixture | Origin |
|---|---|
| `StopFailure.json`, `PostModelSwitch.json`, `PermissionDenied.json` | **From docs.** Hand-written from the hooks reference, because they could not be triggered in a short non-interactive run |
| Everything else | **Real** |

`agent_type` on main-agent fixtures holds `ui-color-palette:uicper`, the main agent configured on the capture machine. It does not mean a subagent. Only `agent_id` marks a subagent.

`transcript-enrich.jsonl` and its `transcript-enrich/subagents/` folder follow the record shapes of Claude Code 2.1.310 transcripts, with the denial text seen in 2.1.299, and neutral content.
