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

A cut takes two steps: the command arms it and tells you what will happen, and your `/compact` carries it out.

```
❯ /summarize-up-to 70%
  Armed: /compact will summarize everything before the step at 68% ("calls Bash: make test").
  You asked for 70%; 68% is the nearest point that keeps tool calls whole.
  Summarized: 410 messages (68%, about 120k tokens). Kept verbatim: 238 messages (32%, about 56k tokens).
  Claude Code also keeps the last reply before the cut, so the kept part starts 2 messages earlier; the figures count that.
  Shares are of what the model reads: about 176k tokens of conversation by Claude Code's count.
  Type /compact to go ahead, or /summarize-up-to cancel.
❯ /compact
  summarize-up-to: summarized everything before the step at 68% ("calls Bash: make test"). That message and everything after it are kept verbatim.
  summarize-up-to: saved the cut so that a restart or resume keeps it (corrected 37 links Claude Code wrote to before the compaction).
```

| Command | What it does |
| --- | --- |
| `/summarize-up-to` | Lists the cut points: your prompts and the notifications between turns |
| `/summarize-up-to 70% [notes]` | Arms a cut at the step nearest 70% of the conversation. Steps fall between any two messages that don't separate a tool call from its result, so long agent-driven turns can be cut too |
| `/summarize-up-to #12 [notes]` | Arms a cut at a listed cut point |
| `/summarize-up-to status` | Shows the armed cut, partial auto-compaction, and when Claude Code auto-compacts |
| `/summarize-up-to cancel` | Drops the armed cut |

Optional notes are passed to the summarizer together with any you give `/compact <notes>`.

The percentage is a share of what the model reads. That includes what the mod's view of the conversation leaves out: messages from other sessions, attached files, and queued commands. The token figures split Claude Code's own count of the conversation (not the system prompt or tools) by that share. The percentage is a target. The cut snaps to the nearest point that keeps tool calls whole, which can be some way off when single messages are large. The confirmation says where it landed.

The mod never starts a compaction itself. Claude Code doesn't run a mod's compaction hook on a compaction that same mod started, so the cut would be lost and the whole conversation summarized.

**A space before the slash.** ` /compact` or ` /summarize-up-to 70%`, typed with a leading space (dictation does this), is not a command to Claude Code: it would go to the model as text, and an agent may act on it. The mod catches both. It runs its own command as meant and empties the prompt box. It holds back ` /compact`, puts `/compact` in the box without the space, and leaves it there for you to send with Enter.

**Restarts and resumes keep the cut.** Claude Code saves a mod's partial compaction so that a resume would rebuild the wrong conversation. The copies of the kept tool results still link to entries from before the compaction, so a resume never reaches the summary. Seconds after each cut, the mod runs `tools/relink.py` on the session's transcript. It points each such link at the entry before it, changing only those 36-character ids where they stand, and checks that a resume reaches the summary and every message after it. If that cannot be done (no `python3`, for one), the mod says so and prints the command that writes a repaired copy to resume instead.

To repair a session cut before this was in place, run the tool from this repository:

```
python3 tools/relink.py --session <session id>              # report only
python3 tools/relink.py --session <session id> --in-place   # patch it, also while it runs
python3 tools/relink.py --session <session id> --write      # or write a repaired copy and resume its id
```

### Partial auto-compaction

Turn on **Partial auto-compaction** in `/config` (the mod's options), and set **Share to summarize** (default 65%). From then on, every auto-compaction summarizes that share of the oldest conversation and keeps the rest verbatim. Claude Code still decides when to compact. To compact at 90% of a 1M-token window:

```
/autocompact 900k
```

Auto-compaction has to be on (`autoCompactEnabled`), and Claude Code doesn't auto-compact headless sessions. If no suitable cut exists, or the summarizer refuses the older part, that auto-compaction runs as Claude Code's normal full one, so a session never gets stuck at the limit.

## Team and Enterprise organizations

For Team and Enterprise logins, and on machines with managed settings, Claude Code loads a built-in guard (`cc-plugin-sec-default`). The guard keeps compaction away from mods a user installs. There the mod refuses to cut and explains why, rather than starting a full compaction. An administrator can let it run by installing it as an organization mod, with the guard kept for every other mod. That means placing a clone of this repository at an admin-only path on each machine and setting:

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
- Claude Code also keeps the last assistant message before the cut, and whatever lies between it and the cut, such as a prompt with an attached file. The confirmation's counts, shares and tokens already include it.
- If anything goes wrong mid-cut, the conversation is left as it was.
- Claude Code records the part summarized as the compaction's `preTokens`, and its own estimate of the rest as `postTokens`. The model's input after a cut is what the status line shows.
- The mod's debug-log lines (`claude --debug`) say where each cut fell, both in the rows and in the conversation as the model reads it.
- Claude Code 2.1.302 shows a dropped prompt's reason only for a moment. It draws the mod's transcript line for a held-back ` /compact` only once the command menu that `/compact` opens in the box closes, and it shows line breaks in such lines as `�`. 2.1.314 shows all of them as written.

## Develop

```
claude plugin validate .
claude plugin test .
python3 e2e/run.py manual && python3 e2e/run.py auto
```

The unit tests run the mod against Claude Code's test kit. The end-to-end tests drive a real, interactive Claude Code session in tmux and must pass before a release. See [e2e/README.md](e2e/README.md).

Tested end to end on Claude Code 2.1.314 (macOS) and 2.1.302 (Linux).

## License

MIT
