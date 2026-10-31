#!/usr/bin/env python3
"""Make a resume rebuild a session as it stood after its latest partial cut.

When a compaction hook such as summarize-up-to's keeps messages verbatim,
Claude Code writes the summary and then copies of the kept messages, and some
copies, kept tool results among them, keep their link to a parent from before
the compaction. A resume follows those links back from the newest message,
never reaches the summary, and rebuilds the wrong conversation.

This points each such entry at the entry before it in the file, the order in
which the kept messages were written, and checks that the newest message then
leads back to the summary through every message after the compaction. Only
the 36-character parent ids change, each for another of the same length.

    relink.py <transcript.jsonl | --session ID>               report only
    relink.py <transcript.jsonl | --session ID> --in-place    patch the file
    relink.py <transcript.jsonl | --session ID> --write       write a repaired copy

--in-place overwrites those ids where they stand, without truncating or
rewriting the file, so it is safe while Claude Code appends to it; the mod
runs it after each cut. --write leaves the original as it is and writes a new
session beside it, printing the id to resume.

The last line printed is JSON: {"fixed", "reaches", "covered", "total"}.
Exit codes: 0 done (or nothing to do), 2 the result would not be a whole
conversation (nothing changed), 3 no compaction newer than --since yet.
"""
import argparse
import glob
import json
import os
import sys
import uuid

# Entries that take part in the conversation's chain of parent links.
CHAINED = ("user", "assistant", "attachment", "system")
PARENT = b'"parentUuid":"'


def is_boundary(entry):
    return entry.get("type") == "system" and entry.get("subtype") == "compact_boundary"


def is_chained(entry):
    return entry.get("type") in CHAINED and "uuid" in entry and not entry.get("isSidechain")


def is_message(entry):
    return entry.get("type") in ("user", "assistant") and not entry.get("isSidechain")


def transcript_of(session_id):
    root = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    found = glob.glob(os.path.join(root, "projects", "*", session_id + ".jsonl"))
    if len(found) != 1:
        sys.exit(f"no single transcript for session {session_id} under {root}/projects")
    return found[0]


def tail_of(data):
    """The latest compaction boundary and every entry after it, each as
    (byte offset of its line, the line, the entry); None without a boundary."""
    lines, offset = [], 0
    for raw in data.split(b"\n"):
        lines.append((offset, raw))
        offset += len(raw) + 1
    for k in range(len(lines) - 1, -1, -1):
        if b'"compact_boundary"' not in lines[k][1]:
            continue
        try:
            entry = json.loads(lines[k][1])
        except ValueError:
            continue
        if is_boundary(entry):
            break
    else:
        return None
    tail = []
    for at, raw in lines[k:]:
        try:
            tail.append((at, raw, json.loads(raw)))
        except ValueError:
            pass  # an empty or unfinished last line
    return tail


def fixes_of(tail):
    """Entries after the boundary whose parent is neither the boundary nor an
    entry after it: (offset, line, old parent, new parent)."""
    boundary = tail[0][2]
    known = {e["uuid"] for _, _, e in tail if "uuid" in e}
    previous, fixes = boundary["uuid"], []
    for at, raw, entry in tail[1:]:
        if not is_chained(entry):
            continue
        parent = entry.get("parentUuid")
        if parent and parent not in known:
            fixes.append((at, raw, parent, previous))
        previous = entry["uuid"]
    return fixes


def check(tail, fixes=()):
    """With `fixes` applied: whether the newest message leads back to the
    boundary, as a resume walks it, and how many of the messages after the
    boundary lead back to it. Claude Code writes parallel tool calls and some
    results on branches of their own, which a resume gathers in any session;
    what matters is that no message leads back to before the compaction."""
    moved = {(at, old): new for at, _, old, new in fixes}
    parent_of, index = {}, {}
    for i, (at, _, entry) in enumerate(tail):
        if "uuid" in entry:
            index[entry["uuid"]] = i
            old = entry.get("parentUuid")
            parent_of[i] = moved.get((at, old), old)
    messages = [i for i in range(1, len(tail)) if is_message(tail[i][2])]
    if not messages:
        return True, 0, 0

    known = {0: True}

    def leads_back(i):
        path = []
        while i not in known:
            path.append(i)
            parent = index.get(parent_of.get(i) or "")
            if parent is None or parent in path:
                known[i] = False
                break
            i = parent
        for j in path:
            known[j] = known[i]
        return known[i]

    return leads_back(messages[-1]), sum(leads_back(i) for i in messages), len(messages)


def patched(raw, old, new):
    """The line with its parent id replaced, and where in it; None when the
    id is not there exactly once."""
    key = PARENT + old.encode() + b'"'
    at = raw.find(key)
    if at < 0 or raw.find(key, at + 1) >= 0 or len(old) != len(new):
        return None
    start = at + len(PARENT)
    return raw[:start] + new.encode() + raw[start + len(old):], start


def report(result):
    print(json.dumps(result))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("transcript", nargs="?")
    parser.add_argument("--session", help="find the transcript by session id")
    parser.add_argument("--since", type=float, help="milliseconds since the epoch: expect a compaction at least this new")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--in-place", action="store_true", help="patch the transcript where it stands")
    mode.add_argument("--write", action="store_true", help="write a repaired copy as a new session")
    args = parser.parse_args()
    path = args.transcript or (transcript_of(args.session) if args.session else parser.error("a transcript or --session"))

    with open(path, "rb") as f:
        data = f.read()
    tail = tail_of(data)
    if tail is None:
        print("no compaction in this transcript; nothing to do")
        return report({"fixed": 0, "reaches": True, "covered": 0, "total": 0})
    if args.since is not None:
        from datetime import datetime
        stamp = tail[0][2].get("timestamp", "")
        when = datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp() * 1000 if stamp else 0
        if when < args.since - 1000:
            print(f"the latest compaction ({stamp}) is older than expected; not written yet")
            sys.exit(3)

    fixes = fixes_of(tail)
    reaches, covered, total = check(tail)
    print(f"as it is: a resume {'reaches' if reaches else 'does not reach'} the latest summary; {covered} of the {total} messages after it lead back to it")
    if not fixes:
        return report({"fixed": 0, "reaches": reaches, "covered": covered, "total": total})
    if any(patched(raw, old, new) is None for _, raw, old, new in fixes):
        print("some links could not be found where expected; nothing changed")
        report({"fixed": 0, "reaches": reaches, "covered": covered, "total": total})
        sys.exit(2)
    reaches, covered, total = check(tail, fixes)
    print(f"repaired: {len(fixes)} links pointed to before the compaction; a resume {'reaches' if reaches else 'does not reach'} the latest summary; {covered} of the {total} messages after it lead back to it")
    result = {"fixed": len(fixes), "reaches": reaches, "covered": covered, "total": total}
    if not reaches or covered != total:
        print("the repair would not give a whole conversation; nothing changed")
        report({**result, "fixed": 0})
        sys.exit(2)

    if args.in_place:
        with open(path, "r+b") as f:
            for at, raw, old, new in fixes:
                start = at + patched(raw, old, new)[1]
                f.seek(start)
                if f.read(len(old)) != old.encode():
                    sys.exit("the transcript changed under the repair; stopped")
                f.seek(start)
                f.write(new.encode())
            f.flush()
            os.fsync(f.fileno())
        with open(path, "rb") as f:
            after = tail_of(f.read())
        reaches, covered, total = check(after)
        print(f"patched in place: a resume {'reaches' if reaches else 'does not reach'} the latest summary; {covered} of the {total} messages after it lead back to it")
        result = {"fixed": len(fixes), "reaches": reaches, "covered": covered, "total": total}
        report(result)
        return sys.exit(0 if reaches and covered == total else 2)

    if args.write:
        lines = {at: patched(raw, old, new)[0] for at, raw, old, new in fixes}
        new_id = str(uuid.uuid4())
        old_id = next((e.get("sessionId") for _, _, e in tail if e.get("sessionId")), None)
        target = os.path.join(os.path.dirname(os.path.abspath(path)), new_id + ".jsonl")
        out, offset = [], 0
        for raw in data.split(b"\n"):
            line = lines.get(offset, raw)
            if old_id:
                line = line.replace(f'"sessionId":"{old_id}"'.encode(), f'"sessionId":"{new_id}"'.encode())
            out.append(line)
            offset += len(raw) + 1
        with open(target, "xb") as f:
            f.write(b"\n".join(out))
        os.chmod(target, 0o600)
        print(f"original untouched: {path}")
        print(f"new session: {new_id}")
        return report(result)

    print("report only; --in-place patches the transcript, --write creates a repaired copy")
    report({**result, "fixed": 0})


if __name__ == "__main__":
    main()
