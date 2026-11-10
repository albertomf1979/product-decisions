# product-decisions

A plugin for Claude Code and OpenAI Codex CLI that silently records how a product is built: who decided what, when, with which model or subagent, and based on which sources. It never intervenes. Its hooks only observe, it never touches your code or your documents, and it writes its readable record to a folder and a Git branch of its own.

Use it to reconstruct why something was decided, write a case study, hand a project over, or answer an audit, months later, from a folder anyone on the team can read.

> **Codex support is pending review.** It is built from the Codex documentation and from what Codex CLI does without a login. No real Codex session has been run yet, because the author has no Codex account. If you have one, please help verify it (see [Contributing](#contributing)).

## What it records, and what it cannot

This is the honest promise. Hooks see a lot, but not everything.

| What | Claude Code | Codex (pending review) |
|---|---|---|
| Session start and end | Full (a crash loses the end event, recovered later) | Full (`reason` is always `other`) |
| Your prompts | Full | Full |
| Final response of each turn | Full | Full |
| Intermediate agent text | Best effort, from the transcript | Best effort, from the transcript |
| Tool calls and results | Full | Partial: hosted tools such as web search fire no hook, and some specialized paths may not |
| Denied tool calls | Partial: auto mode denials only. Denials by a person, a rule, or a safety check fire no hook; best effort from the transcript | Not documented, to confirm |
| URLs consulted | Full, through tool events | Partial: missing for hosted tools unless the transcript shows them |
| MCP calls | Full, with the server | Full, server taken from the tool name |
| Subagent start, stop, result | Full | Full |
| Subagent brief | From the `Agent` tool input | From the `spawn_agent` tool input, to confirm |
| Attribution of tool calls to a subagent | Full, through `agent_id` | Not documented, to confirm |
| File edits through edit tools | Full | Full (`apply_patch`) |
| File changes through the shell | Net effect at the end of each turn, no per-command attribution | Same |
| Commits | Linked after the fact. A later rebase changes the hash | Same |
| Model, main agent | Partial: switch events, and the transcript | Full, on every event |
| Model, subagent | Best effort, from the transcript | When `agent_id` is present on model request events |
| Token usage | Best effort, from the transcript | Full |
| Compaction | Full, with summary | Full, trigger only |
| Sessions opened in a folder above the repository | Partial: tool events that touch the repository's files. Prompts and responses are missing until the session moves into the repository | Same, to confirm |
| Edits made by people outside a session | Net effect at the next check | Same |
| Cloud sessions | Not captured. Teleport the session to your terminal, then `import` it | Not examined |

## Install

You need Node.js 18 or later and Git. The plugin has no dependencies.

**Claude Code**

```bash
claude plugin marketplace add albertomf1979/product-decisions
claude plugin install product-decisions@product-decisions
```

**Codex CLI** (pending review)

```bash
codex plugin marketplace add albertomf1979/product-decisions
codex plugin add product-decisions@product-decisions
```

Codex skips a plugin's hooks until you review and trust them in `/hooks` (in the desktop app, Settings > Hooks). Trust is tied to the hook files, so after each plugin update you must re-approve them, or capture stops without an error. `status` warns when a Codex session left no events.

The plugin ships no `bin/` folder, because claude.ai and Cowork do not install plugins that have one. The command line runs through `npx` instead.

## Activate it in a repository

Installing the plugin captures nothing. Capture starts only in a repository where a person activates it, and only for that person:

```bash
npx github:albertomf1979/product-decisions#v1.0.0 init
```

`init` shows what is recorded and where it goes, and asks you to accept. The first person to run it also declares the project: its folder name, language, and the documents it tracks. Every teammate who wants to be recorded runs `init` on their own clone. Nobody is recorded without their own consent.

| Option | What it does |
|---|---|
| `--no-push` | Keep everything on this machine. Nothing is pushed |
| `--push` | Turn publishing back on |
| `--no-llm` | Turn off automatic LLM summaries for you |
| `--llm` | Turn them back on |
| `--language en\|es` | The language of the generated documents |
| `--folder <name>` | The name of the local folder (default `product-decisions`) |
| `--track <path>` | A document to watch, such as `PRD.md`. Repeat it for more |
| `--yes` | Accept without asking, for scripts |

Running `init` again keeps your earlier choices: only `--push`, `--no-push`, `--llm`, and `--no-llm` change them. If the consent text changes in a later version, `init` asks again, and nothing is published until you accept.

## Commands

The real interface is the command line. It needs no model, and only `sync --llm` spends any (see [LLM synthesis](#llm-synthesis)):

```bash
npx github:albertomf1979/product-decisions#v1.0.0 <command>
```

| Command | What it does |
|---|---|
| `init` | Declare the project or join it, and activate capture for you |
| `status [--json]` | What is active, what was captured, publication, LLM use against the caps, hook latency, recent errors |
| `pause` | Stop capture for you on this clone |
| `resume` | Restart capture. The gap is recorded, with its time range and no content |
| `verify [--json]` | Check that the record has not been altered |
| `sync [--no-push] [--llm]` | Bring the record and the folder up to date. `--llm` also runs LLM synthesis now |
| `import [--dry-run] [--session <id>]` | Bring in your past Claude Code sessions for this repository |

For convenience, `status` and `verify` also exist inside the agents: `/product-decisions:status` and `/product-decisions:verify` in Claude Code, and `$product-decisions:status` and `$product-decisions:verify` in Codex (pending review). Each use spends a model turn, which the command line does not. You must call them explicitly: they are never added to the model's automatic choices. In Codex they run `npx`, which needs network access, so Codex may ask you to approve it.

## Where the record lives

- **On your machine:** `.git/product-decisions/` holds the full record, sealed with hash chains. Your code, documents, branches, `HEAD`, and index never change.
- **The folder:** `product-decisions/` in your main checkout is a readable copy, kept up to date. It is listed in `.git/info/exclude`, so it never shows in `git status` or in the agents' content searches. Its file names still show in file listings, and an agent can open its files like any other.
- **On the remote:** readable documents go to the branch `product-decisions/docs`, so they do not appear in your code branches or pull requests. Switch to that branch on GitHub to read them there. The full record goes to the custom ref `refs/product-decisions/raw`, which normal clones do not download.

## Publication

| Repository visibility | Readable documents | Full record |
|---|---|---|
| Verified private | Published | Published |
| Verified public | Published, with a clear notice at `init` | Stays on each machine |
| Unknown (no network, or a host other than GitHub) | Published | Stays on each machine, unless the project sets `publish.raw: "always"` in `config.json` on the docs branch |

**If a private repository later becomes public, its branches become public too**, including `product-decisions/docs` and any full record already pushed. `status` warns when a repository that is now public holds a published full record. Before you make a repository public, decide whether to delete those refs, as described in [If a secret leaked](#if-a-secret-leaked).

## LLM synthesis

After a Claude Code session closes, the plugin asks `claude` with your own login to draft decision records (ADRs) and phase notes from the session. It runs with no tools, no hooks, and no plugins, and the plugin writes every file itself. Each decision and note must cite at least one event from the record, and a decision attributed to a person must cite one of that person's events, or it is rejected. The check makes sure the evidence exists, not that it proves the claim: the records are drafts to review.

- **What it costs:** it uses your plan's limits or bills your API key.
- **The caps:** by default 10 runs a day and $1.00 per run, with the model `sonnet`. A project can lower them in `config.json` on the docs branch, never raise them above what each person accepted.
- **`sync --llm`** runs every pending session now, past the daily cap. The per-run limit still applies. Imported sessions wait for it: automatic synthesis never spends your quota on a backlog.
- **Codex sessions** wait for `sync --llm`, which runs `codex exec`, with no per-run spending limit (pending review). A project that sets `llm.engine` to `"claude"` has them synthesized automatically by `claude`, like Claude Code sessions.
- **Opt out** for yourself with `init --no-llm`. Without LLM synthesis you still get the chronicles, the indexes, and the sources inventory, but no decisions.

## Importing past sessions

`import` brings in the Claude Code sessions you had in this repository before capture was on, labelled as imported. Run `import --dry-run` first to see the counts.

- **What it finds:** transcripts of this repository, its worktrees, its subfolders, and the folders above it.
- **What it takes:** only records written inside this repository. It leaves out records written while capture was paused, shell commands run with `!` and their output, local command output such as `/status`, and messages the tool injects.
- **Same protection as live capture:** the same redaction and secret-file protection apply, and a second run adds nothing.
- **What it cannot rebuild:** the seals of an imported session only prove the state since the import, not what happened at the time. File changes and commits are not reconstructed.
- **Claude Code deletes transcripts after 30 days by default**, so older sessions may not exist. Raise `cleanupPeriodDays` in your Claude Code settings if you want to keep them longer.
- **Cloud sessions** cannot be captured: plugins do not load there, and a cloud session starts from a fresh clone with nobody activated. Teleport the session to your terminal (`claude --teleport`), then run `import`. Any repository setup you might add for the cloud is yours to add; the plugin never adds it.
- **Codex sessions** cannot be imported: their transcript format is not documented.

## Limits

This detects changes made after sealing or publication. It does not prove authorship or legal compliance, and someone with full control of a machine can rewrite records that were never published.

## Privacy

The record holds prompts, responses, and tool results in full, including files the agent reads. Secrets are redacted by pattern, which is not perfect. When a tool names a secret file such as `.env`, its content is not stored, only a salted hash, but content printed indirectly can be. The home folder is masked as `~`.

### If a secret leaked

1. **Rotate the secret first.** Assume it is compromised.
2. Delete the full record from the remote with one push: `git push origin :refs/product-decisions/raw`. If the secret reached the readable documents, delete them the same way: `git push origin :product-decisions/docs`.
3. Every clone with the plugin notices the deletion at its next publication and stops publishing that ref, and `status` says so. Publishing starts again only when someone runs `init --push` on their clone.
4. Each machine still holds the secret in its own record under `.git/product-decisions/`, and `init --push` would publish it again. Run it only once what it would publish is acceptable.
5. The remote may keep unreachable data for some time. Your hosting provider can purge it.

Your code history is not affected.

### People's data

The record holds people's names and prompts, which are personal data. Tell everyone who will be recorded, and check the rules that apply to your team and your country before you activate it. This README gives no legal advice. Each person activates capture for themselves, and can stop it at any time with `pause`.

## Platforms

| Platform | How it is verified |
|---|---|
| macOS | By hand, on every milestone, and in CI |
| Linux | CI, on Node.js 18 and 24 |
| Windows (native) | CI only. Claude Code runs the hooks without a shell, so PowerShell as the default shell is fine. Codex runs them through its shell (pending review) |
| Codex CLI | Pending review: built from the documentation, no real session yet |

## Sample output

<!-- sample:start -->
The folder, after one session with one decision:

```text
product-decisions/
  03-development/changes.md
  README.md
  annotations/2026-11-03-claude-code-7c1e2d3f-5a6b-4c7d-8e9f-0a1b2c3d4e5f-a1b2c3d4.jsonl
  consent/55219f0b.md
  decisions/ADR-20261103-471289-follow-the-system-theme-by-default.md
  decisions/README.md
  sources/README.md
  timeline/2026-11-03-claude-code-7c1e2d3f-5a6b-4c7d-8e9f-0a1b2c3d4e5f-a1b2c3d4.md
```

`README.md`, the living index:

````markdown
# Product decisions record

> Generated by product-decisions from the record: do not edit this file.

A traceable record of how this product is being built: sessions with coding agents, what changed, and which sources informed it.

## Decisions

| When | ADR | Decided by |
|---|---|---|
| 2026-11-03 10:12 | [ADR-20261103-471289](decisions/ADR-20261103-471289-follow-the-system-theme-by-default.md) Follow the system theme by default | user, Ana |

## Sessions

| Date | Tool | People | Events | Chronicle |
|---|---|---|---|---|
| 2026-11-03 10:00 | claude-code | Ana | 9 | [7c1e2d3f](timeline/2026-11-03-claude-code-7c1e2d3f-5a6b-4c7d-8e9f-0a1b2c3d4e5f-a1b2c3d4.md) |

## Consent

| Person | Accepted | Text | How |
|---|---|---|---|
| Ana | 2026-11-03 09:58 | [55219f0b](consent/55219f0b.md) | answered in a terminal |

## More

- [Change index](03-development/changes.md)
- [Sources inventory](sources/README.md)
````

The session chronicle, in `timeline/`:

````markdown
# Session 2026-11-03, claude-code, 7c1e2d3f

> Generated by product-decisions from the record. It grows as the session continues: do not edit it.

- **Started:** 2026-11-03T10:00:00.000+01:00
- **Ended:** 2026-11-03T10:33:00.000+01:00
- **People:** Ana
- **Models:** claude-opus-5-5
- **Events:** 9 (+3 added by the plugin)

## Timeline

- 10:00:00 · Ana · Session started (startup) · `01KA2B3C4D5E6F7G8H9J0K01MN`
- 10:03:00 · Ana · Prompt: Add a dark mode to the settings page. · `01KA2B3C4D5E6F7G8H9J0K02MN`
- 10:06:00 · claude · Read src/settings/Settings.tsx · `01KA2B3C4D5E6F7G8H9J0K03MN`
- 10:09:00 · claude · Response: Should the new theme start dark, light, or follow the system setting? · `01KA2B3C4D5E6F7G8H9J0K04MN`
- 10:12:00 · Ana · Prompt: Follow the system setting by default, and keep a toggle to override it. · `01KA2B3C4D5E6F7G8H9J0K05MN`
- 10:15:00 · claude · Edit src/theme/tokens.css · `01KA2B3C4D5E6F7G8H9J0K06MN`
- 10:18:00 · claude · Edit src/settings/Settings.tsx · `01KA2B3C4D5E6F7G8H9J0K07MN`
- 10:21:00 · claude · Response: Done: the theme follows the system setting, and the toggle overrides it. · `01KA2B3C4D5E6F7G8H9J0K08MN`
- 10:24:00 · product-decisions · 2 files changed in the working tree · `01KA2B3C4D5E6F7G8H9J0K09MN`
- 10:27:00 · product-decisions · Commit 8b2e4f6: Add a dark mode that follows the system setting · `01KA2B3C4D5E6F7G8H9J0K10MN`
- 10:30:00 · product-decisions · Model in use: claude-opus-5-5 · `01KA2B3C4D5E6F7G8H9J0K11MN`
- 10:33:00 · Ana · Session ended (other) · `01KA2B3C4D5E6F7G8H9J0K12MN`

## Files changed

| File | Change | Lines |
|---|---|---|
| `src/settings/Settings.tsx` | modified | +18 −2 |
| `src/theme/tokens.css` | modified | +24 −0 |

## Commits

- `8b2e4f6` Add a dark mode that follows the system setting

## What was not observed

Hooks do not observe denials by a person, a rule, or a safety check, intermediate agent text, or the model of subagents. Denials by a person, intermediate text, and subagent models are added from the transcript when it shows them, on a best-effort basis.
````

A decision record, in `decisions/`. Only LLM synthesis writes these, and every one cites the events it rests on:

````markdown
# ADR-20261103-471289: Follow the system theme by default

> Inferred by product-decisions from the record with an LLM. The plugin never rewrites this file. To correct it, edit it on the product-decisions/docs branch. To retire it, change its status there. Deleting it does not stick.

- **Status:** Accepted (inferred)
- **Decided by:** user, Ana
- **When:** 2026-11-03 10:12 +01:00, [session 7c1e2d3f](../timeline/2026-11-03-claude-code-7c1e2d3f-5a6b-4c7d-8e9f-0a1b2c3d4e5f-a1b2c3d4.md)
- **Evidence:** `01KA2B3C4D5E6F7G8H9J0K05MN`
- **Related:** none

## Context

The settings page had no dark mode. Asked how the new theme should start, Ana chose its default.

## Decision

The theme follows the system setting until the person picks light or dark with the toggle.

## Alternatives considered

- Start in light mode, as before
- Start in dark mode

## Consequences

People who never touch the toggle get the theme of their system. The dark colours live in tokens.css.

## Sources

None.
````
<!-- sample:end -->

## FAQ

**Does it change my code or my documents?**
No. It writes only to its folder, its own Git refs, `.git/product-decisions/`, and one line in `.git/info/exclude`. It never edits your PRD, designs, or code, and never touches your branches, `HEAD`, or index.

**Does it slow my agent down?**
Hooks append one line and return. Heavy work runs later in a background process. `status` shows the hook times on your machine.

**Can it change what the agent does?**
No. Its hooks return no decisions and print nothing, so nothing reaches the model. The `status` and `verify` wrappers enter the conversation only when you call them. An agent can still see the folder's file names in a listing and open its files, like any other file in your checkout.

**What does it cost?**
Capture costs nothing. LLM synthesis uses your plan or your API key, within the caps above. Turn it off with `init --no-llm`.

**How do I stop it, or remove it?**
`pause` stops capture for you on that clone, and `resume` restarts it. To remove it, uninstall the plugin. What it wrote stays until you delete it: the record in `.git/product-decisions/`, the `product-decisions/` folder and its line in `.git/info/exclude`, the local `product-decisions/docs` branch and `refs/product-decisions/raw` ref, and anything already pushed, which you delete as in [If a secret leaked](#if-a-secret-leaked).

**Does it work in the cloud?**
Not directly. Teleport the session to your terminal, then run `import`.

**Why is Codex pending review?**
The author has no Codex account. Everything Codex-specific is built from its documentation and checked with Codex CLI without a login, and the code is open so that people with an account can verify it.

**Can teammates read it without the plugin?**
Yes. The documents are plain Markdown on the `product-decisions/docs` branch.

## Contributing

The most useful contribution is a real check of the Codex column: install the plugin in Codex CLI, trust its hooks, run a session, and report what `status` shows and what the chronicle missed. Issues and pull requests are welcome.

## License

MIT. See [LICENSE](LICENSE).
