# summarize-up-to

A Claude Code mod that summarizes only the oldest part of a conversation and keeps the rest verbatim. It works at any point you choose, including inside long turns that agents drive on their own. It can also make every auto-compaction work this way.

Claude Code's own `/compact` and auto-compaction summarize the whole conversation. `/rewind` → **Summarize up to here** keeps the newest part, but it only lets you cut at a prompt you typed. In sessions driven by other agents, subagents or background tasks, there is often no such prompt anywhere near where you want to cut.

## Install

At the prompt of a terminal session:

```
/plugin install summarize-up-to --marketplace groundnuty/claude-summarize-up-to
```

From a shell (for example, to set up a remote machine that runs agents):

```
claude plugin install summarize-up-to --marketplace groundnuty/claude-summarize-up-to
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then **Plugins**, **Add marketplace** with `groundnuty/claude-summarize-up-to`, then **Add plugin**.

Installed at user scope, the mod is active in every session you start afterwards on that machine. It needs `python3` on the machine to keep each cut across restarts (see below); `/summarize-up-to status` says whether it is there.

## Use

Set the share once; every `/compact` then summarizes that much of the oldest conversation and keeps the rest verbatim, until you set another share. The setting is per project, so each agent keeps its own, and it outlives restarts.

```
❯ /summarize-up-to 20%
  Set: every /compact in this project now summarizes the oldest 20%, until you set another share.
  Now that is everything before the step at 21% ("calls Bash: make test").
  21% is the nearest point to 20% that keeps tool calls whole.
  Summarized: 128 messages (21%, about 37k tokens). Kept verbatim: 520 messages (79%, about 139k tokens).
  Shares are of what the model reads: about 176k tokens of conversation by Claude Code's count.
  Type /compact to compact now; /compact full summarizes everything, this once.
❯ /compact
  summarize-up-to: summarized everything before the step at 21% ("calls Bash: make test"). That message and everything after it are kept verbatim. Every /compact here summarizes the oldest 20%, until you set another share.
  summarize-up-to: saved the cut so that a restart or resume keeps it (corrected 37 links Claude Code wrote to before the compaction).
```

| Command | What it does |
| --- | --- |
| `/summarize-up-to 20% [notes]` | Every `/compact` in this project summarizes the oldest 20%, until you set another share. The reply shows what that comes to now. Notes go to the next summary |
| `/summarize-up-to 0%` | Every `/compact` summarizes the whole conversation again, as without the mod |
| `/compact` | Summarizes the share set for this project; until you set one, the `/config` option **Share to summarize on /compact** (65% unless changed) |
| `/compact full` | Summarizes the whole conversation, this once |
| `/summarize-up-to` | Lists the cut points: your prompts and the notifications between turns |
| `/summarize-up-to #12 [notes]` | The next `/compact` only: summarize everything before listed point 12 |
| `/summarize-up-to cancel` | Drops a cut armed with `#n` |
| `/summarize-up-to status` | Shows the share `/compact` uses and where it comes from, partial auto-compaction, and when Claude Code auto-compacts |

A cut falls at a prompt or notification, or at a step between two tool round-trips, so long agent-driven turns can be cut too. It never separates a tool call from its result, or a prompt from the reply it asked for. Notes are passed to the summarizer together with any you give `/compact <notes>`. The mod keeps each project's share in its own store, under the project's folder.

The percentage is a share of what the model reads. That includes what the mod's view of the conversation leaves out: messages from other sessions, attached files, and queued commands. The token figures split Claude Code's own count of the conversation (not the system prompt or tools) by that share. In the end-to-end runs on Claude 5 models, they came within about 15% of what then left the model's input. On Claude 4.x models they ran up to 1.6× high. The percentage is a target. The cut snaps to the nearest point that keeps tool calls whole, which can be some way off when single messages are large. The confirmation says where it landed.

The mod never starts a compaction itself. Claude Code doesn't run a mod's compaction hook on a compaction that same mod started, so the cut would be lost and the whole conversation summarized.

**What the summarizer sees.** The mod hands Claude Code everything before the cut, closed by one short message of its own. Claude Code keeps the last assistant message of what it is handed out of the summary and verbatim. Without the closing message, that is the last real reply. The summarizer's part then ended on a request it never saw answered, and in end-to-end runs it answered that request instead of summarizing. The closing message takes that place, and the mod drops it from the result. The summarizer is also told that its only task is the summary and that every request it sees was handled.

**A space before the slash.** ` /compact` or ` /summarize-up-to 70%`, typed with a leading space (dictation does this), is not a command to Claude Code: it would go to the model as text, and an agent may act on it. The mod catches both. It runs its own command as meant and empties the prompt box. It holds back ` /compact`, puts `/compact` in the box without the space, and leaves it there for you to send with Enter.

**Restarts and resumes keep the cut.** Claude Code saves a mod's partial compaction so that a resume would rebuild the wrong conversation. The copies of the kept tool results still link to entries from before the compaction, so a resume never reaches the summary. Seconds after each cut, the mod runs `tools/relink.py` on the session's transcript. It points each such link at the entry before it, changing only those 36-character ids where they stand, and checks that a resume reaches the summary and every message after it. If that cannot be done (no `python3`, for one), the mod says so and prints the command that writes a repaired copy to resume instead.

To repair a session cut before this was in place, run the tool from this repository:

```
python3 tools/relink.py --session <session id>              # report only
python3 tools/relink.py --session <session id> --in-place   # patch it, also while it runs
python3 tools/relink.py --session <session id> --write      # or write a repaired copy and resume its id
```

### Partial auto-compaction

Turn on **Partial auto-compaction** in `/config` (the mod's options), and set **Share to summarize** (default 65%), which is separate from the share for `/compact`. From then on, every auto-compaction summarizes that share of the oldest conversation and keeps the rest verbatim. Claude Code still decides when to compact. To compact at 90% of a 1M-token window:

```
/autocompact 900k
```

Auto-compaction has to be on (`autoCompactEnabled`), and Claude Code doesn't auto-compact headless sessions. If no suitable cut exists, or the summarizer refuses the older part, that auto-compaction runs as Claude Code's normal full one, so a session never gets stuck at the limit.

Claude Code reaches an auto-compaction by more than one route. The end-to-end tests cover each route with a real restart and resume after the cut:

| Threshold from | Claude Code's route | Tested |
| --- | --- | --- |
| `/autocompact` (the `autoCompactWindow` setting) | reactive, at the threshold | yes |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | reactive, at the threshold | yes |
| the default, 1M-window model | reactive, at about 967k tokens | yes |
| the default, 200k-window model | compacting directly, at about 167k tokens | yes |

Claude Code can also compute an auto-compaction ahead of time and install it at the threshold without asking any mod again. That is behind a Claude Code server flag, which was off in every test. With partial auto-compaction on, the mod declines that precomputation, so every auto-compaction comes through the mod. A `/compact` that the mod cuts never reuses a precomputed summary, because the mod passes the summarizer instructions of its own.

## Team and Enterprise organizations

For Team and Enterprise logins, and on machines with managed settings, Claude Code loads a built-in guard (`cc-plugin-sec-default`). The guard keeps compaction away from mods a user installs, so any compaction there would summarize the whole conversation. The guard is decided when a session starts or reloads its plugins, and once seated it holds until the session ends. So an account switcher that moves a machine to a Team login affects the next start or reload, and switching back does not undo a seat; only a restart under a personal login on a machine without managed settings does.

Where the guard stands in the mod's way, no compaction runs on its own:

- **Compaction is switched off.** When the mod loads into such a session (including after `/reload-plugins` or a resume), it sets `DISABLE_COMPACT=1` for that Claude Code process alone. No auto-compaction runs, whatever the settings say, and `/compact` becomes an unknown command. At the context limit the agent stops ("Context limit reached") instead of losing its context. Claude Code lets a mod switch compaction off but not back on, so it stays off until the session restarts.
- **It says so.** It writes "Not cutting: …" into the conversation, and `/summarize-up-to status` leads with the same warning. The switch outlives the guard: if a machine policy later seats the mod ahead of the guard in that same process, compaction reaches the mod but stays off until a restart, and the mod says that too.
- **The way out.** To compact in such a session anyway, start it with `DISABLE_COMPACT=0` in its environment. The mod leaves a value you set alone, and a compaction then summarizes everything.
- **Child processes inherit it.** Claude Code processes the session starts, such as teammates in an agent team, inherit `DISABLE_COMPACT=1`, so they don't compact either.
- **Where the switch is refused,** the mod still holds back a typed `/compact` with the reason and the restart command (`/compact full` goes through), but an auto-compaction would then summarize everything.

**On a machine you administer,** `tools/machine-policy.sh` seats the mod ahead of the guard through a machine policy, with the guard kept for every other mod. It uses sudo for `/opt/claude-plugins` and `/etc/claude-code`, and the policy applies to every Claude Code session on the machine:

```
bash tools/machine-policy.sh install <git ref> <percent> [project folder ...]
bash tools/machine-policy.sh update <git ref>
bash tools/machine-policy.sh remove
```

Its limit is the organization's. Managed sources are "first-wins": under a login whose organization delivers server-managed settings, even one key, Claude Code ignores the machine file, and a lower source can't opt into merging with the one above it. So the tool also installs the mod in each project you name, as a fallback: under such a login that install loads behind the guard and switches compaction off. The agent then stops at the context limit instead of compacting everything. To cut under that login, its organization has to seat the mod. Keep it out of an account switcher's rotation if it can't.

Restart running sessions after installing the policy. Where the policy applies, the current Claude Code loads only the machine's copy, and a reload stays clean (tested on 2.1.316). A `/reload-plugins` in a process still on 2.1.302 loaded both copies, and the one behind the guard switched compaction off until a restart.

An organization's administrator can let the mod run by installing it as an organization mod, with the guard kept for every other mod. That means placing a clone of this repository at an admin-only path on each machine and setting:

```json
{
  "extraKnownMarketplaces": {
    "groundnuty": { "source": { "source": "directory", "path": "/opt/claude-plugins/claude-summarize-up-to" } }
  },
  "enabledPlugins": { "summarize-up-to@groundnuty": true },
  "prependPlugins": ["summarize-up-to@groundnuty", "sec-default@builtin"]
}
```

See [Manage mods for your organization](https://code.claude.com/docs/en/plugins/mods/admin.md) for the conditions and other options.

## What to expect

- Cut points come from what Claude Code shows mods. Messages from other sessions are hidden from mods, so neither they nor the first reply after them are cut points. The steps between tool calls in the turns they start are.
- Verbatim text starts at the cut. On one route Claude Code keeps more of what precedes it: compacting directly (200k-window models, auto-compaction), it kept two more replies. After each cut, the mod reports where verbatim text actually starts and the share actually summarized.
- If anything goes wrong mid-cut, the conversation is left as it was.
- Claude Code records the part summarized as the compaction's `preTokens`, and its own estimate of the rest as `postTokens`.
- After any compaction, Claude Code's status line shows 0% until the next answer, which can look like a full compaction. `/context` counts the context at once.
- The mod's debug-log lines (`claude --debug`) say where each cut fell, both in the rows and in the conversation as the model reads it.
- Claude Code 2.1.302 shows a dropped prompt's reason only for a moment. It draws the mod's transcript line for a held-back ` /compact` only once the command menu that `/compact` opens in the box closes, and it shows line breaks in such lines as `�`. 2.1.314 shows all of them as written.

## Develop

```
claude plugin validate .
claude plugin test .
python3 e2e/run.py manual && python3 e2e/run.py auto && python3 e2e/run.py auto-setting
```

The unit tests run the mod against Claude Code's test kit. The end-to-end tests drive a real, interactive Claude Code session in tmux and must pass before a release. See [e2e/README.md](e2e/README.md).

Tested end to end on Claude Code 2.1.314 (macOS) and 2.1.302 (Linux), with claude-haiku-5-5 (1M window) and claude-haiku-4-5 (200k).

## License

MIT
