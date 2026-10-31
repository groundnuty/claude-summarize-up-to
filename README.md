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

| Command | What it does |
| --- | --- |
| `/summarize-up-to` | Lists the cut points: your prompts and the notifications between turns |
| `/summarize-up-to 70% [notes]` | Summarizes everything before the step nearest 70% of the conversation and keeps the rest verbatim. Steps fall between any two messages that don't separate a tool call from its result, so long agent-driven turns can be cut too |
| `/summarize-up-to #12 [notes]` | The same at a listed cut point |
| `/summarize-up-to status` | Shows partial auto-compaction, its share, and when Claude Code auto-compacts |
| `/summarize-up-to cancel` | Drops a cut that is still waiting for `/compact` |

Optional notes are passed to the summarizer, as with `/compact <notes>`.

In a headless (`-p`) or SDK session, Claude Code doesn't let a mod start a compaction. The cut is armed instead, and your next `/compact` applies it.

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
- The engine may keep one more assistant reply before the cut than the mod reports.
- If anything goes wrong mid-cut, the conversation is left as it was.

## Develop

```
claude plugin validate .
claude plugin test .
```

Requires Claude Code 2.1.314 or later.

## License

MIT
