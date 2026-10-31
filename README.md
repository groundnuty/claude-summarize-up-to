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

Installed at user scope, the mod is active in every session you start afterwards on that machine.

## Use

A cut takes two steps: the command arms it and tells you what will happen, and your `/compact` carries it out.

```
❯ /summarize-up-to 70%
  Armed: /compact will summarize everything before the step at 68% ("…").
  You asked for 70%; 68% is the nearest point that keeps tool calls whole.
  Summarized: 412 messages (68%, about 120k tokens). Kept verbatim: 236 messages (32%, about 56k tokens).
  Claude Code may keep a message or two more before the cut.
  Type /compact to go ahead, or /summarize-up-to cancel.
❯ /compact
```

| Command | What it does |
| --- | --- |
| `/summarize-up-to` | Lists the cut points: your prompts and the notifications between turns |
| `/summarize-up-to 70% [notes]` | Arms a cut at the step nearest 70% of the conversation. Steps fall between any two messages that don't separate a tool call from its result, so long agent-driven turns can be cut too |
| `/summarize-up-to #12 [notes]` | Arms a cut at a listed cut point |
| `/summarize-up-to status` | Shows the armed cut, partial auto-compaction, and when Claude Code auto-compacts |
| `/summarize-up-to cancel` | Drops the armed cut |

Optional notes are passed to the summarizer together with any you give `/compact <notes>`. The percentage is a target: the cut snaps to the nearest point that keeps tool calls whole, which can be some way off when single messages are large. The confirmation says where it landed. The token figures estimate the conversation's text alone, not the system prompt or tools.

The mod never starts a compaction itself. Claude Code doesn't run a mod's compaction hook on a compaction that same mod started, so the cut would be lost and the whole conversation summarized.

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
- Claude Code may keep a message or two before the cut in addition to what the mod hands back. The end-to-end tests saw one reply kept, and once a reply and a prompt.
- If anything goes wrong mid-cut, the conversation is left as it was.

## Develop

```
claude plugin validate .
claude plugin test .
python3 e2e/run.py manual && python3 e2e/run.py auto
```

The unit tests run the mod against Claude Code's test kit. The end-to-end tests drive a real, interactive Claude Code session in tmux and must pass before a release. See [e2e/README.md](e2e/README.md).

Requires Claude Code 2.1.314 or later.

## License

MIT
