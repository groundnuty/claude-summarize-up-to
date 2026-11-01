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
# The model the test sessions run; E2E_MODEL picks another, for one with a different window.
MODEL = os.environ.get("E2E_MODEL", "claude-haiku-5-5")
# The Claude Code binary under test; set CLAUDE_BIN where `claude` is not on PATH.
CLAUDE = os.environ.get("CLAUDE_BIN", "claude")
# Text that only a dialog shows. The driver never types while one is up.
DIALOG = ("Enter to continue", "Esc to cancel", "Do you want", "(y/n)", "❯ 1.", "❯ 2.", "Press Enter to")
TRUST = ("trust the files in this folder", "Yes, I trust this folder", "Is this a project you")


class Abort(Exception):
    pass


class Session:
    """One interactive Claude Code in a detached tmux session, always named
    exactly ("=name"): tmux otherwise matches a prefix, another run's session."""

    def __init__(self, name, cwd, args, env, log):
        self.name, self.cwd, self.log = name, cwd, log
        self.projects = os.path.expanduser("~/.claude/projects/" + re.sub(r"[^A-Za-z0-9]", "-", os.path.realpath(cwd)))
        tmux("kill-session", "-t", f"={name}")
        command = " ".join(["env"] + [f"{k}={v}" for k, v in env.items()] + [CLAUDE] + [quote(a) for a in args])
        tmux("new-session", "-d", "-s", name, "-x", "200", "-y", "50", "-c", cwd, command)
        self.started = time.time()
        deadline = time.time() + 60
        while time.time() < deadline:
            pane = self.pane()
            if any(t in pane for t in TRUST):
                tmux("send-keys", "-t", f"={name}:", "Enter")  # a fresh scratch folder: trust it once
                time.sleep(2)
                continue
            if self.state()[0] == "idle":
                return
            time.sleep(1)
        raise Abort("Claude Code did not reach its prompt:\n" + self.pane())

    def pane(self):
        return tmux("capture-pane", "-p", "-t", f"={self.name}:")

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

    def send(self, text, paste=None, timeout=180, quiet=False):
        """Type a prompt and wait until the session is idle again. A quiet one
        (dropped by a hook) writes nothing to the transcript to wait for."""
        self.wait_idle(60)
        before = len(self.entries())
        # The typed text first, the paste after it: a model took an instruction
        # that followed a paste for part of the paste, and declined it.
        tmux("send-keys", "-t", f"={self.name}:", "-l", text)
        time.sleep(0.4)
        if paste is not None:
            tmux("load-buffer", "-b", "e2e", paste)
            tmux("paste-buffer", "-p", "-b", "e2e", "-t", f"={self.name}:")
            time.sleep(1.5 + os.path.getsize(paste) / 50000)
        tmux("send-keys", "-t", f"={self.name}:", "Enter")
        self.log(f"> {text[:90]}")
        deadline = time.time() + (4 if quiet else timeout)
        while time.time() < deadline and (quiet or len(self.entries()) == before):
            time.sleep(1)
        time.sleep(2)
        self.wait_idle(timeout)

    def box(self):
        """What the prompt box holds: the lines between its two borders."""
        lines = self.pane().splitlines()
        borders = [i for i, line in enumerate(lines) if line.startswith("──")]
        if len(borders) < 2:
            return None
        inside = " ".join(line.strip() for line in lines[borders[-2] + 1:borders[-1]])
        return inside.lstrip("❯").strip()

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

    def exit(self):
        """Quit Claude Code with /exit, as a person would, and wait until it has."""
        self.wait_idle(60)
        tmux("send-keys", "-t", f"={self.name}:", "-l", "/exit")
        time.sleep(0.4)
        tmux("send-keys", "-t", f"={self.name}:", "Enter")
        self.log("> /exit")
        deadline = time.time() + 30
        while time.time() < deadline and subprocess.run(["tmux", "has-session", "-t", f"={self.name}"], capture_output=True).returncode == 0:
            time.sleep(1)
        self.close()

    def close(self):
        tmux("kill-session", "-t", f"={self.name}")


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
    body = WORD_RE.sub("", text, count=1).lstrip(" \n:.,;!?-*")
    # A heading the model may open with ("**Athens, Greece**") is no sentence.
    # Emphasis marks go: the model quotes the words, not the markdown.
    lines = [re.sub(r"[*_]+", "", line).strip(" #") for line in body.split("\n") if re.sub(r"[*_]+", "", line).strip(" #")]
    while len(lines) > 1 and len(lines[0]) < 80 and not re.search(r"[.!?]$", lines[0]):
        lines.pop(0)
    body = " ".join(lines)
    match = re.match(r"(.{20,}?[.!?])(\s|$)", body, re.S)
    return (match.group(1) if match else body[:80]).strip()


class Checks:
    def __init__(self):
        self.failed = 0

    def __call__(self, ok, label, detail=""):
        print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"  ({detail})" if detail else ""), flush=True)
        self.failed += 0 if ok else 1


def reported_step(debug):
    """The command of the step the mod last cut at, when it cut at one."""
    found = None
    for line in open(debug, errors="replace"):
        if "[summarize-up-to] $.ui.log:" in line and "summarized everything before" in line:
            step = re.search(r'the step at \d+% \(\\?"calls Bash: ([^"\\]*?)(?:…)?\\?"\)', line)
            found = step.group(1) if step else None
    return found


def reported_start(debug):
    """The code word where the mod says verbatim text starts, when Claude Code
    kept messages before its cut; None when it starts at the cut."""
    found = None
    for line in open(debug, errors="replace"):
        if "[summarize-up-to] $.ui.log:" in line and "summarized everything before" in line:
            start = line.split('verbatim text starts at "', 1)
            found = WORD_RE.search(start[1]) if len(start) == 2 else None
    return found.group(1) if found else None


def reported_cut(debug):
    """The code word of the message the mod said it cut at, from its log line."""
    found = None
    for line in open(debug, errors="replace"):
        if "[summarize-up-to] $.ui.log:" in line and "summarized everything before" in line:
            found = WORD_RE.search(line.split("summarized everything before", 1)[1])
    return found.group(1) if found else None


def verify(session, check, trigger, used_words, debug, least=2):
    entries = session.entries()
    bs = boundaries(entries)
    check(bool(bs) and bs[-1].get("compactMetadata", {}).get("trigger") == trigger,
          f"the latest compaction has trigger {trigger}", str(bs[-1].get("compactMetadata", {}).get("trigger")) if bs else "none")
    if not bs:
        return None
    md = bs[-1]["compactMetadata"]
    check(md.get("postTokens", 0) < md.get("preTokens", 0), "the compaction freed context", f"{md.get('preTokens')} -> {md.get('postTokens')} tokens")
    cut, step = reported_cut(debug), reported_step(debug)
    check(reports(debug) > 0, "the mod reports its cut", f"before {cut}" if cut else f"before the step {step!r}" if step else "no report in the debug log")
    live = live_context(entries)
    check(not any(CLOSING in text_of(e) for e in live), "the mod's closing message is not left in the conversation")
    summary = " ".join(text_of(e) for e in live if e.get("isCompactSummary"))
    replies = [e for e in live if e.get("type") == "assistant" and not e.get("isCompactSummary")]
    verbatim = []
    for e in replies:
        m = WORD_RE.match(text_of(e).lstrip(" *#"))
        if m and m.group(1) not in verbatim:
            verbatim.append(m.group(1))
    print(f"  ...   replies kept verbatim: {' '.join(verbatim) or '(none)'}", flush=True)
    check(len(verbatim) >= least, f"at least {least} of the newest replies {'are' if least > 1 else 'is'} kept verbatim")
    check(verbatim == used_words[len(used_words) - len(verbatim):], "the kept replies are exactly the newest ones, in order")
    check(len(verbatim) <= len(used_words) - 2, "at least two of the oldest replies are not kept verbatim")
    if step is not None:
        # A cut inside a turn: the kept part opens on the command the mod named.
        first = next((e for e in live if e.get("type") == "assistant" and not e.get("isCompactSummary")), None)
        commands = [b.get("input", {}).get("command", "") for b in ((first or {}).get("message") or {}).get("content") or []
                    if isinstance(b, dict) and b.get("type") == "tool_use"]
        check(any(c.startswith(step) for c in commands), "the kept part starts where the mod says", f"kept from {commands}, the mod said {step!r}")
    elif cut in used_words and verbatim:
        # Claude Code keeps some of what precedes the cut; the mod reports where
        # verbatim text then starts.
        expected = reported_start(debug) or cut
        check(verbatim[0] == expected, "the kept part starts where the mod says", f"kept from {verbatim[0]}, the mod said {expected}")
    dropped = [w for w in used_words if w not in verbatim]
    check(any(w in summary for w in dropped), "the summary covers the older replies", f"{sum(w in summary for w in dropped)}/{len(dropped)} named")

    sentences = {WORD_RE.match(text_of(e).lstrip(" *#")).group(1): first_sentence(text_of(e))
                 for e in entries if e.get("type") == "assistant" and WORD_RE.match(text_of(e).lstrip(" *#"))}
    quotes(session, check, verbatim, dropped, sentences)
    saved(session, check, debug)
    return verbatim, dropped, sentences


def quotes(session, check, verbatim, dropped, sentences, after=""):
    """What the model sees: exact first sentences of the kept replies, and none of the dropped ones."""
    session.send("Answer without using tools. For every assistant reply that appears as a verbatim message in this "
                 "conversation (not one only described in a summary), write its code word, a colon, and the first "
                 "full sentence that follows the code word, copied exactly. One per line, nothing else.", timeout=240)
    answer = text_of(next(e for e in reversed(session.entries()) if e.get("type") == "assistant"))
    quoted = {m.group(1): m.group(2).strip() for m in re.finditer(r"^\W*(" + "|".join(WORDS) + r")\W*:\s*(.+)$", answer, re.M)}
    # Case aside: a reply's sentence may open lower-case after its code word.
    exact = [w for w in verbatim if w in sentences and sentences[w][:40].lower() in quoted.get(w, "").lower()]
    check(len(exact) >= max(1, len(verbatim) - 1), f"the model quotes the kept replies word for word{after}", f"{len(exact)}/{len(verbatim)} exact")
    leaked = [w for w in dropped if w in sentences and len(sentences[w]) > 30 and sentences[w][:40].lower() in answer.lower()]
    check(not leaked, f"the model cannot quote the summarized replies{after}", ", ".join(leaked) or "none")


def saved(session, check, debug):
    """The mod saved the cut so that a resume keeps it: it says so, and the
    repair tool, reading only, finds the transcript whole as it stands."""
    deadline = time.time() + 60
    said = None
    while time.time() < deadline and said is None:
        for line in open(debug, errors="replace"):
            if "[summarize-up-to] $.ui.log:" in line and ("saved the cut" in line or "could not save the cut" in line):
                said = line.split("$.ui.log: ", 1)[1].strip()
        time.sleep(2)
    check(said is not None and "saved the cut so that a restart or resume keeps it" in said and "could not save" not in said,
          "the mod saved the cut so that a restart or resume keeps it", (said or "no report")[:140])
    run = subprocess.run([sys.executable, "-I", os.path.join(REPO, "tools", "relink.py"), session.transcript()],
                         capture_output=True, text=True)
    as_is = next((line for line in run.stdout.splitlines() if line.startswith("as it is:")), run.stderr.strip())
    whole = re.search(r"a resume reaches the latest summary; (\d+) of the (\d+) messages", as_is)
    check(whole is not None and whole.group(1) == whole.group(2), "the transcript as saved resumes whole", as_is[:140])


def real_input(entry):
    usage = (entry.get("message") or {}).get("usage") or {}
    return sum(usage.get(k) or 0 for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))


def summarized_tokens(entries):
    """What the latest compaction took out of the model's input: its input just
    before, less its input just after, plus the summary that replaced it."""
    found = [i for i, e in enumerate(entries) if e.get("type") == "system" and e.get("subtype") == "compact_boundary"]
    if not found:
        return None
    at = found[-1]
    answered = [(i, real_input(e)) for i, e in enumerate(entries)
                if e.get("type") == "assistant" and real_input(e) > 0 and (e.get("message") or {}).get("model") != "<synthetic>"]
    before = [n for i, n in answered if i < at]
    after = [n for i, n in answered if i > at]
    summary = sum(len(text_of(e)) for e in entries[at + 1:] if e.get("isCompactSummary"))
    return before[-1] - after[0] + summary // 4 if before and after else None


# The message the mod closes the summarizer's part with (hooks/cut.ts CLOSING);
# it must never remain in the conversation.
CLOSING = "The conversation goes on after your summary, verbatim from the next message."

# Files mentioned in the first turns: the model reads them, the mod's rows do not.
ATTACHED = (0, 2, 3)


def turns_manual(session, words):
    for i, word in enumerate(words):
        if i in ATTACHED:
            session.send(f"Start your reply with the code word {word}, then describe in about 120 words a place whose "
                         f"name starts with the letter {word[0]}. Here is @notes{i}.txt for later; it is attached "
                         f"already, so leave it be and use no tool.")
        elif i % 3 == 1:
            session.send(f"Use the Bash tool to run exactly `echo {word}-1`, then exactly `echo {word}-2`, as two "
                         f"separate calls. Then reply, starting with the code word {word}, in two sentences about a "
                         f"river whose name starts with {word[0]}.")
        else:
            session.send(f"Start your reply with the code word {word}, then describe in about 120 words a place whose "
                         f"name starts with the letter {word[0]}.")


def scenario_manual(session, check, log, debug):
    words = WORDS[:10]
    turns_manual(session, words)
    entries = session.entries()
    check(sum(e.get("type") == "attachment" and (e.get("attachment") or {}).get("type") == "file" for e in entries) >= len(ATTACHED),
          "the mentioned files reached the model as attachments")
    session.send("/summarize-up-to status")
    pane = session.pane()
    check("Compaction reaches this mod in this session" in pane, "status: compaction reaches the mod")

    # Typed after a space, a slash command is text. The mod runs its own
    # command and empties the box; it holds /compact back and offers it in the
    # box without the space, so Enter alone compacts.
    replies = sum(e.get("type") == "assistant" for e in session.entries())
    count = len(boundaries(session.entries()))
    session.send("  /summarize-up-to 60%", quiet=True)
    pane = session.pane()
    check("every /compact in this project now summarizes the oldest 60%" in re.sub(r"\s+", " ", pane),
          "'  /summarize-up-to 60%' sets the share for every /compact")
    check("could not store the share" not in pane, "the share is stored to outlive the session")
    check(session.box() == "", "the box is empty afterwards", repr(session.box()))
    flat = re.sub(r"\s+", " ", pane)
    numbers = re.search(r"Summarized: \d+ messages \(\d+%, (?:about (\d+)k|under 1k) tokens\)\. Kept verbatim: \d+ messages", flat)
    check(numbers is not None and "Shares are of what the model reads" in flat,
          "the confirmation weighs the cut by what the model reads, in Claude Code's tokens")
    time.sleep(15)
    check(len(boundaries(session.entries())) == count, "arming alone starts no compaction (the 0.2.1 bug)")
    session.send(" /compact", quiet=True)
    pane = session.pane()
    reason = "with a space before the slash it would have gone to the model as text"
    shown = reason in re.sub(r"\s+", " ", pane)
    # Claude Code 2.1.302 draws the line only once the box's command menu closes.
    logged = any("[summarize-up-to] $.ui.log:" in line and reason in line for line in open(debug, errors="replace"))
    check(shown or logged, "' /compact' is held back with a reason",
          "on screen" if shown else "in the transcript, not on screen yet" if logged else "nowhere")
    time.sleep(5)
    entries = session.entries()
    check(sum(e.get("type") == "assistant" for e in entries) == replies and len(boundaries(entries)) == count,
          "' /compact' reached neither the model nor compaction")
    check(session.box() == "/compact", "the box now holds /compact without the space", repr(session.box()))
    session.send("", timeout=300)
    kept = verify(session, check, "manual", words, debug)

    estimate = int(numbers.group(1)) * 1000 if numbers is not None and numbers.group(1) else None
    real = summarized_tokens(session.entries())
    check(estimate is not None and real is not None and 0.6 <= estimate / max(real, 1) <= 1.6,
          "the confirmation's summarized tokens match what left the model's input", f"said {estimate}, measured {real}")
    return kept


# How Claude Code reached and ran a compaction, from its debug log.
PATH_LINES = ("autocompact: routing", "precomputed compact:", "session.compact (", "autocompact: tokens=")


def compaction_path(debug):
    seen = []
    for line in open(debug, errors="replace"):
        text = line.split("] ", 1)[-1].strip()
        if any(p in text for p in PATH_LINES) and "level=ok" not in text and "level=warn" not in text:
            text = re.sub(r"\s+", " ", text)[:150]
            if not seen or seen[-1] != text:
                seen.append(text)
    return seen


def threshold_of(session):
    """Claude Code's auto-compaction threshold in tokens, as /summarize-up-to status reports it."""
    session.send("/summarize-up-to status")
    flat = re.sub(r"\s+", " ", session.pane())
    found = re.findall(r"auto-compacts at (\d+)k tokens \((\d+)% of (\d+)k\)", flat)
    return (int(found[-1][0]) * 1000, found[-1]) if found else (None, None)


def write_filler(path, tokens):
    lines = max(50, int(tokens * 4 / 68))
    with open(path, "w") as f:
        f.writelines(f"{i:05d} filler line for the end-to-end test; nothing here to remember.\n" for i in range(lines))


def reports(debug):
    """How many cuts the mod has reported in the debug log."""
    return sum(1 for line in open(debug, errors="replace")
               if "[summarize-up-to] $.ui.log:" in line and "summarized everything before" in line)


def kept_replies(entries):
    return [e for e in live_context(entries) if e.get("type") == "assistant" and not e.get("isCompactSummary")
            and WORD_RE.match(text_of(e).lstrip(" *#"))]


def standing(session, check, debug):
    """After a restart, the share set with the command still stands: a plain
    /compact cuts at it again, nothing armed; /compact full summarizes all."""
    session.send("/summarize-up-to status")
    check("/compact summarizes the oldest 60% (set with /summarize-up-to)" in re.sub(r"\s+", " ", session.pane()),
          "after the restart, the share set with the command still stands")
    for word in WORDS[10:14]:
        session.send(f"Start your reply with the code word {word}, then describe in about 120 words a place whose "
                     f"name starts with the letter {word[0]}.")
    count, cuts = len(boundaries(session.entries())), reports(debug)
    session.send("/compact", timeout=300)
    entries = session.entries()
    check(len(boundaries(entries)) == count + 1 and reports(debug) == cuts + 1 and kept_replies(entries),
          "a plain /compact after the restart cuts at that share again", f"{len(kept_replies(entries))} replies kept")
    count, cuts = len(boundaries(entries)), reports(debug)
    session.send("/compact full", timeout=300)
    entries = session.entries()
    check(len(boundaries(entries)) == count + 1 and reports(debug) == cuts and not kept_replies(entries),
          "/compact full summarizes everything", f"{len(kept_replies(entries))} replies kept")


# The files the mid-turn scenario's tool loop reads: about 6k tokens each,
# under Claude Code's cap on one command's output.
PARTS = 5


def last_input(entries):
    """The model's input on its latest answer, in tokens."""
    return next((real_input(e) for e in reversed(entries)
                 if e.get("type") == "assistant" and real_input(e) > 0 and (e.get("message") or {}).get("model") != "<synthetic>"), 0)


def scenario_midturn(session, check, log, filler, debug, work):
    """Claude Code crosses its auto-compaction threshold inside a tool loop, as
    an agent does: filler turns to just under it, then a turn of one-at-a-time
    cat commands and a closing reply. The compaction must come after that
    turn's prompt and before its reply, and the turn must finish after it."""
    threshold, shown = threshold_of(session)
    log(f"auto-compaction threshold: {shown[0]}k tokens, {shown[1]}% of a {shown[2]}k window" if shown else "auto-compaction threshold: not shown")
    check(threshold is not None, "Claude Code reports an auto-compaction threshold")
    if threshold is None:
        return None
    write_filler(filler, threshold / 12)
    for i in range(1, PARTS + 1):
        with open(os.path.join(work, f"part{i}.txt"), "w") as f:
            f.writelines(f"{n:05d} part {i} filler line for the end-to-end test; nothing here to remember.\n" for n in range(330))
    words, used = iter(WORDS), []
    for word in words:
        session.send(f"Code word {word}. Ignore the pasted filler; start your reply with the code word, then write "
                     f"two sentences about a city whose name starts with {word[0]}.", paste=filler, timeout=300)
        used.append(word)
        if boundaries(session.entries()):
            check(False, "the build-up stays under the threshold", f"compacted after {len(used)} turns")
            return None
        if last_input(session.entries()) >= threshold - 26000:
            break
    log(f"{len(used)} build-up turns; input {last_input(session.entries())} tokens, threshold {threshold}")
    loop = next(words)
    count = len(boundaries(session.entries()))
    commands = ", ".join(f"cat part{i}.txt" for i in range(1, PARTS + 1))
    session.send(f"Code word {loop}. Run these {PARTS} commands one at a time, each as its own Bash call, and wait for "
                 f"each result before the next: {commands}. The files are filler: do not describe them. After the last "
                 f"one, start your reply with the code word {loop}, then write one sentence about a city whose name "
                 f"starts with {loop[0]}.", timeout=600)
    used.append(loop)
    entries = session.entries()
    check(len(boundaries(entries)) == count + 1, "Claude Code auto-compacted during the turn")
    if len(boundaries(entries)) != count + 1:
        return None
    # Kept messages are written again after the boundary with their own
    # timestamps, so the order is read from timestamps, not file positions.
    boundary = boundaries(entries)[-1]["timestamp"]
    asked = min((e["timestamp"] for e in entries if e.get("type") == "user" and f"Code word {loop}." in text_of(e)), default=None)
    replied = max((e["timestamp"] for e in entries if e.get("type") == "assistant"
                   and WORD_RE.match(text_of(e).lstrip(" *#")) and WORD_RE.match(text_of(e).lstrip(" *#")).group(1) == loop), default=None)
    # Each call once: the kept ones appear again, as copies, after the summary.
    calls = sorted({b["id"]: e["timestamp"] for e in entries if e.get("type") == "assistant" and asked and e["timestamp"] > asked
                    for b in (e.get("message") or {}).get("content") or [] if isinstance(b, dict) and b.get("type") == "tool_use"}.values())
    check(asked is not None and replied is not None and asked < boundary < replied,
          "the compaction came inside the turn, between its prompt and its reply",
          f"{sum(c < boundary for c in calls)} tool calls before it, {sum(c > boundary for c in calls)} after")
    check(replied is not None, "the turn finished after the compaction", f"reply {loop}" if replied else "no reply")
    for line in compaction_path(debug):
        log(f"path: {line}")
    # The kept part here can lie wholly inside the loop turn: one reply.
    return verify(session, check, "auto", used, debug, least=1)


def scenario_auto(session, check, log, filler, debug):
    threshold, shown = threshold_of(session)
    log(f"auto-compaction threshold: {shown[0]}k tokens, {shown[1]}% of a {shown[2]}k window" if shown else "auto-compaction threshold: not shown")
    check(threshold is not None, "Claude Code reports an auto-compaction threshold")
    if threshold is None:
        return None
    # About ten turns to reach it, so a 65% cut has turns on both sides.
    write_filler(filler, threshold / 10)
    used = []
    for word in WORDS:
        count = len(boundaries(session.entries()))
        session.send(f"Code word {word}. Ignore the pasted filler; start your reply with the code word, then write "
                     f"two sentences about a city whose name starts with {word[0]}.", paste=filler, timeout=300)
        used.append(word)
        if len(boundaries(session.entries())) > count:
            log(f"auto-compaction after {len(used)} turns")
            break
    else:
        check(False, "auto-compaction fired")
        for line in compaction_path(debug):
            log(f"path: {line}")
        return None
    for line in compaction_path(debug):
        log(f"path: {line}")
    return verify(session, check, "auto", used, debug)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("scenario", choices=["manual", "auto", "auto-setting", "auto-default", "auto-midturn"],
                        help="auto: threshold from CLAUDE_CODE_AUTO_COMPACT_WINDOW; auto-setting: from the "
                             "autoCompactWindow setting /autocompact writes; auto-default: Claude Code's own")
    parser.add_argument("--keep", action="store_true", help="leave the tmux session running afterwards")
    parser.add_argument("--tag", default="", help="a suffix for the tmux session name, to run copies side by side")
    args = parser.parse_args()

    work = tempfile.mkdtemp(prefix=f"sut-e2e-{args.scenario}-", dir="/tmp")
    os.makedirs(os.path.join(work, ".claude"))
    is_auto = args.scenario.startswith("auto")
    # The person's own settings stay out: project settings carry what the test needs.
    settings = {"autoCompactEnabled": is_auto, "permissions": {"allow": ["Bash(echo:*)", "Bash(cat:*)"]}}
    if args.scenario == "auto-setting":
        settings["autoCompactWindow"] = 100000
    with open(os.path.join(work, ".claude", "settings.json"), "w") as f:
        json.dump(settings, f)
    options = {"auto_compact": is_auto, "summarize_percent": 65}
    flags = json.dumps({"pluginConfigs": {"summarize-up-to@inline": {"options": options}}})
    debug = os.path.join(work, "debug.txt")
    claude_args = ["--model", MODEL, "--permission-mode", "default", "--setting-sources", "project", "--settings", flags,
                   "--strict-mcp-config", "--tools", "Bash", "--plugin-dir", REPO, "--debug-file", debug]
    env = {"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "100000"} if args.scenario in ("auto", "auto-midturn") else {}

    def log(message):
        print(f"  ...   {message}", flush=True)

    print(f"summarize-up-to e2e: {args.scenario}  (folder {work})", flush=True)
    check = Checks()
    session = None
    try:
        name = (f"sut-e2e-{args.scenario}" + (f"-{MODEL.replace('claude-', '')}" if "E2E_MODEL" in os.environ else "")
                + (f"-{args.tag}" if args.tag else ""))
        session = Session(name, work, claude_args, env, log)
        for i in ATTACHED:
            with open(os.path.join(work, f"notes{i}.txt"), "w") as f:
                f.writelines(f"note {i}.{n:04d}: a reference line the end-to-end test attaches; nothing to act on.\n" for n in range(200))
        if args.scenario == "auto-midturn":
            kept = scenario_midturn(session, check, log, os.path.join(work, "filler.txt"), debug, work)
        elif is_auto:
            kept = scenario_auto(session, check, log, os.path.join(work, "filler.txt"), debug)
        else:
            kept = scenario_manual(session, check, log, debug)
        if kept is not None:
            # A restart: Claude Code rebuilds the conversation from the transcript.
            resumed = os.path.basename(session.transcript())[:-len(".jsonl")]
            session.exit()
            session = Session(name, work, claude_args + ["--resume", resumed], env, log)
            log(f"resumed {resumed}")
            quotes(session, check, *kept, after=" after a restart and resume")
            if args.scenario == "manual":
                standing(session, check, debug)
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
