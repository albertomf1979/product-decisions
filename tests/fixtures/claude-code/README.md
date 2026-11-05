# Claude Code hook fixtures

Payloads captured on 2026-11-05 from Claude Code 2.1.310 by the probe in `spikes/s1-hook-probe`, with the home directory replaced by `/home/user`. File names follow `<HookEvent>[-variant].json`.

| Fixture | Origin |
|---|---|
| `StopFailure.json`, `PostModelSwitch.json` | **From docs.** Hand-written from the hooks reference, because they could not be triggered in a short non-interactive run |
| Everything else | **Real** |

`agent_type` on main-agent fixtures holds `ui-color-palette:uicper`, the main agent configured on the capture machine. It does not mean a subagent. Only `agent_id` marks a subagent.
