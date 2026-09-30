#!/usr/bin/env python3
"""Deliver bounded, user-enabled AI Executive briefings through Hermes."""
import fcntl, json, os, re, stat, sys
from pathlib import Path

HERMES_ROOT = Path("/usr/local/lib/hermes-agent")
sys.path.insert(0, str(HERMES_ROOT))
from hermes_cli.env_loader import load_hermes_dotenv  # noqa: E402
from tools.send_message_tool import send_message_tool  # noqa: E402

load_hermes_dotenv(hermes_home=os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")), project_env=HERMES_ROOT / ".env")
ROOT = Path("/var/lib/ai-executive-briefings")
OUTBOX, PROCESSING, SENT, FAILED = (ROOT / name for name in ("outbox", "processing", "sent", "failed"))
LOCK = PROCESSING / "delivery.lock"

def text(value, limit):
    return str(value or "").replace("\x00", "").strip()[:limit]

def validate(raw):
    if not isinstance(raw, dict) or raw.get("schema") != 1: raise ValueError("unsupported schema")
    result = {"id": text(raw.get("id"), 36), "kind": text(raw.get("kind"), 10), "workspace": text(raw.get("workspace"), 120), "localDate": text(raw.get("localDate"), 10), "summary": text(raw.get("summary"), 500)}
    if not re.fullmatch(r"[0-9a-f-]{36}", result["id"], re.I): raise ValueError("invalid id")
    if result["kind"] not in {"morning", "evening"}: raise ValueError("invalid kind")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", result["localDate"]): raise ValueError("invalid date")
    tasks = raw.get("topTasks", [])
    suggestions = raw.get("suggestions", [])
    if not isinstance(tasks, list) or len(tasks) > 3 or not isinstance(suggestions, list) or len(suggestions) > 5: raise ValueError("invalid list")
    result["tasks"] = [{"title": text(item.get("title"), 240), "reason": text(item.get("reason"), 80)} for item in tasks if isinstance(item, dict)]
    result["suggestions"] = [text(item, 400) for item in suggestions]
    return result

def deliver(item):
    heading = "Dobré ráno — denní přehled" if item["kind"] == "morning" else "Večerní rekapitulace"
    tasks = "\n".join(f"{index}. {task['title']} — {task['reason']}" for index, task in enumerate(item["tasks"], 1)) or "Žádné prioritní úkoly."
    suggestions = "\n".join(f"• {value}" for value in item["suggestions"])
    message = f"◇ {heading}\n\nWorkspace: {item['workspace']}\nDatum: {item['localDate']}\n\n{item['summary']}\n\nTop 3:\n{tasks}\n\nDoporučení:\n{suggestions}\n\nZměny úkolů provedu jen jako návrh v aplikaci, po vašem potvrzení a s možností Undo."
    result = send_message_tool({"action": "send", "target": "telegram", "message": message})
    parsed = json.loads(result) if isinstance(result, str) else result
    if not isinstance(parsed, dict) or not parsed.get("success"): raise RuntimeError(text(parsed, 500))

def process(name):
    source = PROCESSING / name
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 16384: raise ValueError("invalid file")
        raw = os.read(fd, 16385)
    finally: os.close(fd)
    item = validate(json.loads(raw.decode("utf-8")))
    if name != f"{item['id']}.json": raise ValueError("filename mismatch")
    deliver(item)
    os.replace(source, SENT / name)

def main():
    for directory in (OUTBOX, PROCESSING, SENT, FAILED): directory.mkdir(parents=True, exist_ok=True)
    failed = False
    with LOCK.open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        names = [p.name for p in PROCESSING.iterdir() if re.fullmatch(r"[0-9a-f-]{36}\.json", p.name, re.I)]
        for candidate in sorted(OUTBOX.iterdir()):
            if len(names) >= 10: break
            if re.fullmatch(r"[0-9a-f-]{36}\.json", candidate.name, re.I):
                try: os.replace(candidate, PROCESSING / candidate.name); names.append(candidate.name)
                except FileNotFoundError: pass
        for name in names[:10]:
            try: process(name)
            except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
                print(f"Briefing rejected: {error}", file=sys.stderr); os.replace(PROCESSING / name, FAILED / name)
            except Exception as error:
                print(f"Briefing delivery failed: {error}", file=sys.stderr); failed = True
    return 1 if failed else 0

if __name__ == "__main__": raise SystemExit(main())
