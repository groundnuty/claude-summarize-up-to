#!/usr/bin/env python3
"""End-to-end test of summarize-up-to in a real, interactive Claude Code session.

Starts Claude Code in a throwaway tmux session and folder with the mod loaded
from this repository, builds a scripted conversation, compacts it, and checks
what survives verbatim, both in the session transcript and by asking the model.

    python3 e2e/run.py manual   # /summarize-up-to 60%, then /compact
    python3 e2e/run.py auto     # auto-compaction fires; the mod cuts it

Needs tmux, the latest Claude Code, and a login where Claude Code's security
default is not seated (a personal account on a machine without managed
settings). Uses claude-haiku-5-5. Exits non-zero when a check fails.
"""
import argparse
import glob
import json
import os
import re
import subprocess
import sys
import tempfile
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORDS = ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO", "FOXTROT", "GOLF", "HOTEL", "INDIA", "JULIETT", "KILO", "LIMA",
         "MIKE", "NOVEMBER", "OSCAR", "PAPA"]
WORD_RE = re.compile(r"\b(" + "|".join(WORDS) + r")\b")
MODEL = "claude-haiku-5-5"
# Text that only a dialog shows. The driver never types while one is up.
DIALOG = ("Enter to continue", "Esc to cancel", "Do you want", "(y/n)", "❯ 1.", "❯ 2.", "Press Enter to")
TRUST = ("trust the files in this folder", "Yes, I trust this folder", "Is this a project you")


class Abort(Exception):
    pass


class Session:
    """One interactive Claude Code in a detached tmux session."""

    def __init__(self, name, cwd, args, env, log):
        self.name, self.cwd, self.log = name, cwd, log
        self.projects = os.path.expanduser("~/.claude/projects/" + re.sub(r"[^A-Za-z0-9]", "-", os.path.realpath(cwd)))
        tmux("kill-session", "-t", name)
        command = " ".join(["env"] + [f"{k}={v}" for k, v in env.items()] + ["claude"] + [quote(a) for a in args])
        tmux("new-session", "-d", "-s", name, "-x", "200", "-y", "50", "-c", cwd, command)
        self.started = time.time()
        deadline = time.time() + 60
        while time.time() < deadline:
            pane = self.pane()
            if any(t in pane for t in TRUST):
                tmux("send-keys", "-t", name, "Enter")  # a fresh scratch folder: trust it once
                time.sleep(2)
                continue
            if self.state()[0] == "idle":
                return
            time.sleep(1)
        raise Abort("Claude Code did not reach its prompt:\n" + self.pane())

    def pane(self):
        return tmux("capture-pane", "-p", "-t", self.name)

    def state(self):
        pane = self.pane()
        tail = "\n".join(pane.rstrip().splitlines()[-16:])
        if any(m in tail for m in DIALOG):
            return "dialog", pane
        if "esc to interrupt" in pane.lower():
            return "busy", pane
        if re.search(r"^\s*❯", tail, re.M):
            return "idle", pane
        return "unknown", pane

    def wait_idle(self, timeout):
        deadline, calm = time.time() + timeout, 0
        while time.time() < deadline:
            state, pane = self.state()
            if state == "dialog":
                raise Abort("a dialog appeared; nothing typed into it:\n" + pane)
            calm = calm + 1 if state == "idle" else 0
            if calm >= 3:
                return
            time.sleep(1)
        raise Abort(f"not idle after {timeout}s:\n" + self.pane())

    def send(self, text, paste=None, timeout=180):
        self.wait_idle(60)
        before = len(self.entries())
        if paste is not None:
            tmux("load-buffer", "-b", "e2e", paste)
            tmux("paste-buffer", "-p", "-b", "e2e", "-t", self.name)
            time.sleep(1.5)
        tmux("send-keys", "-t", self.name, "-l", text)
        time.sleep(0.4)
        tmux("send-keys", "-t", self.name, "Enter")
        self.log(f"> {text[:90]}")
        deadline = time.time() + timeout
        while time.time() < deadline and len(self.entries()) == before:
            time.sleep(1)
        time.sleep(2)
        self.wait_idle(timeout)

    def transcript(self):
        files = [f for f in glob.glob(os.path.join(self.projects, "*.jsonl")) if os.path.getmtime(f) >= self.started - 5]
        return max(files, key=os.path.getmtime) if files else None

    def entries(self):
        path = self.transcript()
        if path is None:
            return []
        out = []
        for line in open(path):
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
        return out

    def close(self):
        tmux("kill-session", "-t", self.name)


def tmux(*args):
    return subprocess.run(["tmux", *args], capture_output=True, text=True).stdout


def quote(arg):
    return "'" + arg.replace("'", "'\\''") + "'"


def text_of(entry):
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        return content
    return "\n".join(b.get("text", "") for b in content or [] if isinstance(b, dict) and b.get("type") == "text")


def boundaries(entries):
    return [e for e in entries if e.get("type") == "system" and e.get("subtype") == "compact_boundary"]


def live_context(entries):
    """The conversation as it stands after the latest compaction, oldest first.

    When a hook answers a compaction, Claude Code writes the boundary, the
    summary and then the kept messages again as new entries, in order; some
    keep parent links into the old conversation, so file order, not the parent
    chain, is what holds the live context."""
    start = max(i for i, e in enumerate(entries) if e.get("type") == "system" and e.get("subtype") == "compact_boundary")
    return [e for e in entries[start + 1:] if e.get("type") in ("user", "assistant")]


def first_sentence(text):
    body = WORD_RE.sub("", text, count=1).strip(" \n:.,-*")
    match = re.match(r"(.{20,}?[.!?])(\s|$)", body, re.S)
    return (match.group(1) if match else body[:80]).strip()


class Checks:
    def __init__(self):
        self.failed = 0

    def __call__(self, ok, label, detail=""):
        print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"  ({detail})" if detail else ""), flush=True)
        self.failed += 0 if ok else 1


def reported_cut(debug):
    """The code word of the message the mod said it cut at, from its log line."""
    found = None
    for line in open(debug, errors="replace"):
        if "$.ui.log: summarize-up-to:" in line and "summarized everything before" in line:
            found = WORD_RE.search(line.split("summarized everything before", 1)[1])
    return found.group(1) if found else None


def verify(session, check, trigger, used_words, debug):
    entries = session.entries()
    bs = boundaries(entries)
    check(bool(bs) and bs[-1].get("compactMetadata", {}).get("trigger") == trigger,
          f"the latest compaction has trigger {trigger}", str(bs[-1].get("compactMetadata", {}).get("trigger")) if bs else "none")
    if not bs:
        return
    md = bs[-1]["compactMetadata"]
    check(md.get("postTokens", 0) < md.get("preTokens", 0), "the compaction freed context", f"{md.get('preTokens')} -> {md.get('postTokens')} tokens")
    cut = reported_cut(debug)
    check(cut is not None, "the mod reports its cut", f"before {cut}" if cut else "no report in the debug log")
    live = live_context(entries)
    summary = " ".join(text_of(e) for e in live if e.get("isCompactSummary"))
    replies = [e for e in live if e.get("type") == "assistant" and not e.get("isCompactSummary")]
    verbatim = []
    for e in replies:
        m = WORD_RE.match(text_of(e).lstrip(" *#"))
        if m and m.group(1) not in verbatim:
            verbatim.append(m.group(1))
    print(f"  ...   replies kept verbatim: {' '.join(verbatim) or '(none)'}", flush=True)
    check(len(verbatim) >= 2, "at least two of the newest replies are kept verbatim")
    check(verbatim == used_words[len(used_words) - len(verbatim):], "the kept replies are exactly the newest ones, in order")
    check(len(verbatim) <= len(used_words) - 2, "at least two of the oldest replies are not kept verbatim")
    if cut in used_words and verbatim:
        # Claude Code keeps the one reply just before a cut that opens on a prompt.
        first = used_words.index(verbatim[0])
        check(first in (used_words.index(cut), used_words.index(cut) - 1), "the kept part starts at the reported cut",
              f"kept from {verbatim[0]}, cut before {cut}")
    dropped = [w for w in used_words if w not in verbatim]
    check(any(w in summary for w in dropped), "the summary covers the older replies", f"{sum(w in summary for w in dropped)}/{len(dropped)} named")

    # What the model sees: exact first sentences of the kept replies, and none of the dropped ones.
    sentences = {WORD_RE.match(text_of(e).lstrip(" *#")).group(1): first_sentence(text_of(e))
                 for e in entries if e.get("type") == "assistant" and WORD_RE.match(text_of(e).lstrip(" *#"))}
    session.send("Answer without using tools. For every assistant reply that appears as a verbatim message in this "
                 "conversation (not one only described in a summary), write its code word, a colon, and the first "
                 "full sentence that follows the code word, copied exactly. One per line, nothing else.", timeout=240)
    answer = text_of(next(e for e in reversed(session.entries()) if e.get("type") == "assistant"))
    quoted = {m.group(1): m.group(2).strip() for m in re.finditer(r"^\W*(" + "|".join(WORDS) + r")\W*:\s*(.+)$", answer, re.M)}
    exact = [w for w in verbatim if w in sentences and sentences[w][:40] in quoted.get(w, "")]
    check(len(exact) >= max(1, len(verbatim) - 1), "the model quotes the kept replies word for word", f"{len(exact)}/{len(verbatim)} exact")
    leaked = [w for w in dropped if w in sentences and len(sentences[w]) > 30 and sentences[w][:40] in answer]
    check(not leaked, "the model cannot quote the summarized replies", ", ".join(leaked) or "none")


def turns_manual(session, words):
    for i, word in enumerate(words):
        if i % 3 == 1:
            session.send(f"Use the Bash tool to run exactly `echo {word}-1`, then exactly `echo {word}-2`, as two "
                         f"separate calls. Then reply, starting with the code word {word}, in two sentences about a "
                         f"river whose name starts with {word[0]}.")
        else:
            session.send(f"Start your reply with the code word {word}, then describe in about 120 words a place whose "
                         f"name starts with the letter {word[0]}.")


def scenario_manual(session, check, log, debug):
    words = WORDS[:10]
    turns_manual(session, words)
    session.send("/summarize-up-to status")
    pane = session.pane()
    check("Compaction reaches this mod in this session" in pane, "status: compaction reaches the mod")
    session.send("/summarize-up-to 60%")
    pane = session.pane()
    check("Armed: /compact will summarize everything before" in pane, "the command arms a cut")
    check("Summarized:" in pane and "Kept verbatim:" in pane, "the confirmation says how much is summarized and kept")
    count = len(boundaries(session.entries()))
    time.sleep(15)
    check(len(boundaries(session.entries())) == count, "arming alone starts no compaction (the 0.2.1 bug)")
    session.send("/compact", timeout=300)
    verify(session, check, "manual", words, debug)


def scenario_auto(session, check, log, filler, debug):
    used = []
    for word in WORDS:
        count = len(boundaries(session.entries()))
        session.send(f"Ignore the pasted filler. Start your reply with the code word {word}, then write two "
                     f"sentences about a city whose name starts with {word[0]}.", paste=filler, timeout=300)
        used.append(word)
        if len(boundaries(session.entries())) > count:
            log(f"auto-compaction after {len(used)} turns")
            break
    else:
        check(False, "auto-compaction fired")
        return
    verify(session, check, "auto", used, debug)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("scenario", choices=["manual", "auto"])
    parser.add_argument("--keep", action="store_true", help="leave the tmux session running afterwards")
    args = parser.parse_args()

    work = tempfile.mkdtemp(prefix=f"sut-e2e-{args.scenario}-", dir="/tmp")
    os.makedirs(os.path.join(work, ".claude"))
    is_auto = args.scenario == "auto"
    # The person's own settings stay out: project settings carry what the test needs.
    with open(os.path.join(work, ".claude", "settings.json"), "w") as f:
        json.dump({"autoCompactEnabled": is_auto, "permissions": {"allow": ["Bash(echo:*)"]}}, f)
    options = {"auto_compact": is_auto, "summarize_percent": 65}
    flags = json.dumps({"pluginConfigs": {"summarize-up-to@inline": {"options": options}}})
    debug = os.path.join(work, "debug.txt")
    claude_args = ["--model", MODEL, "--permission-mode", "default", "--setting-sources", "project", "--settings", flags,
                   "--strict-mcp-config", "--tools", "Bash", "--plugin-dir", REPO, "--debug-file", debug]
    env = {"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "100000"} if is_auto else {}

    def log(message):
        print(f"  ...   {message}", flush=True)

    print(f"summarize-up-to e2e: {args.scenario}  (folder {work})", flush=True)
    check = Checks()
    session = None
    try:
        session = Session(f"sut-e2e-{args.scenario}", work, claude_args, env, log)
        if is_auto:
            # About 4k tokens a turn: enough turns before the threshold for a 65% cut.
            filler = os.path.join(work, "filler.txt")
            with open(filler, "w") as f:
                f.writelines(f"{i:05d} filler line for the end-to-end test; nothing here to remember.\n" for i in range(250))
            scenario_auto(session, check, log, filler, debug)
        else:
            scenario_manual(session, check, log, debug)
    except Abort as error:
        check(False, "the run finished", str(error)[:2000])
    finally:
        if session is not None:
            print(f"  transcript: {session.transcript()}\n  debug log:  {debug}", flush=True)
            if not args.keep:
                session.close()
    print(f"{'PASSED' if check.failed == 0 else f'FAILED ({check.failed})'}", flush=True)
    sys.exit(1 if check.failed else 0)


if __name__ == "__main__":
    main()
