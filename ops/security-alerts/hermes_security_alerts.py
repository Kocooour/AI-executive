#!/usr/bin/env python3
"""Deliver sanitized AI Executive security alerts through Hermes Telegram."""

from __future__ import annotations

import fcntl
import json
import os
import re
import stat
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERMES_ROOT = Path("/usr/local/lib/hermes-agent")
sys.path.insert(0, str(HERMES_ROOT))

from hermes_cli.env_loader import load_hermes_dotenv  # noqa: E402
from tools.send_message_tool import send_message_tool  # noqa: E402

# The Hermes gateway entrypoint loads ~/.hermes/.env before constructing its
# platform configuration. This narrow sender imports the delivery tool
# directly, so it must perform the same supported initialization explicitly.
load_hermes_dotenv(
    hermes_home=os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")),
    project_env=HERMES_ROOT / ".env",
)

OUTBOX = Path(os.environ.get("AI_EXECUTIVE_SECURITY_OUTBOX", "/var/lib/ai-executive-security/outbox"))
PROCESSING = Path(os.environ.get("AI_EXECUTIVE_SECURITY_PROCESSING", "/var/lib/ai-executive-security/processing"))
SENT = Path(os.environ.get("AI_EXECUTIVE_SECURITY_SENT", "/var/lib/ai-executive-security/sent"))
FAILED = Path(os.environ.get("AI_EXECUTIVE_SECURITY_FAILED", "/var/lib/ai-executive-security/failed"))
LOCK = PROCESSING / "delivery.lock"
MAX_FILES_PER_RUN = 10
MAX_FILE_BYTES = 16 * 1024
RETENTION_SECONDS = 30 * 24 * 60 * 60
RULES = {
    "rate-limit-triggered": ("critical", "AI Executive: rate limit triggered"),
    "unauthenticated-mutation": ("critical", "AI Executive: blocked unauthorized write"),
    "authentication-failures": ("critical", "AI Executive: repeated authentication failures"),
    "protected-route-reconnaissance": ("warning", "AI Executive: protected route probing"),
}


def bounded(value: object, limit: int) -> str:
    text = str(value or "").replace("\x00", "").strip()
    return text[:limit]


def timestamp(value: object) -> str:
    raw = bounded(value, 40)
    if "\n" in raw or "\r" in raw:
        raise ValueError("invalid alert timestamp")
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("invalid alert timestamp") from error
    if parsed.tzinfo is None:
        raise ValueError("alert timestamp must include a timezone")
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def validate(payload: object) -> dict[str, object]:
    if not isinstance(payload, dict) or payload.get("schema") != 1:
        raise ValueError("unsupported alert schema")
    alert_id = bounded(payload.get("id"), 36)
    if not re.fullmatch(r"[0-9a-f-]{36}", alert_id, re.IGNORECASE):
        raise ValueError("invalid alert id")
    severity = bounded(payload.get("severity"), 12)
    if severity not in {"warning", "critical"}:
        raise ValueError("invalid severity")
    rule = bounded(payload.get("rule"), 80)
    if rule not in RULES:
        raise ValueError("unsupported alert rule")
    expected_severity, canonical_title = RULES[rule]
    if severity != expected_severity:
        raise ValueError("severity does not match rule")
    source = bounded(payload.get("source"), 24)
    if not re.fullmatch(r"[0-9a-f]{24}", source):
        raise ValueError("invalid source")
    count = int(payload.get("eventCount", 0))
    if count < 1 or count > 1_000_000:
        raise ValueError("invalid event count")
    return {
        "id": alert_id,
        "severity": severity,
        "rule": rule,
        # Never trust free-form outbox text. The app may select only a known
        # rule; the privileged sender derives the user-facing wording.
        "title": canonical_title,
        "eventCount": count,
        "firstAt": timestamp(payload.get("firstAt")),
        "lastAt": timestamp(payload.get("lastAt")),
        "source": source,
    }


def deliver(alert: dict[str, object]) -> None:
    icon = "🚨" if alert["severity"] == "critical" else "⚠️"
    message = (
        f"{icon} {alert['title']}\n"
        f"Rule: {alert['rule']} · Events: {alert['eventCount']}\n"
        f"Source: {alert['source']} · Last: {alert['lastAt']}\n"
        "The request was blocked; review AI Executive security logs."
    )
    raw = send_message_tool({"action": "send", "target": "telegram", "message": message})
    result = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(result, dict) or not result.get("success"):
        raise RuntimeError(bounded(result, 500))


def valid_filename(name: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-f-]{36}\.json", name, re.IGNORECASE))


def claim_file(name: str) -> None:
    """Atomically remove a candidate from the app-writable trust boundary."""
    source_fd = os.open(OUTBOX, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    destination_fd = os.open(PROCESSING, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.rename(name, name, src_dir_fd=source_fd, dst_dir_fd=destination_fd)
    finally:
        os.close(destination_fd)
        os.close(source_fd)


def process_file(name: str) -> None:
    directory_fd = os.open(PROCESSING, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory_fd)
        try:
            opened = os.fstat(fd)
            if not stat.S_ISREG(opened.st_mode) or opened.st_size > MAX_FILE_BYTES:
                raise ValueError(f"invalid alert file: {name}")
            raw = os.read(fd, MAX_FILE_BYTES + 1)
        finally:
            os.close(fd)
        current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
            raise ValueError(f"alert changed while opening: {name}")
    finally:
        os.close(directory_fd)
    payload = json.loads(raw.decode("utf-8"))
    alert = validate(payload)
    if name != f"{alert['id']}.json":
        raise ValueError(f"alert filename mismatch: {name}")
    deliver(alert)
    os.replace(PROCESSING / name, SENT / name)


def prune_sent() -> None:
    cutoff = time.time() - RETENTION_SECONDS
    for item in os.scandir(SENT):
        if item.is_file(follow_symlinks=False) and item.name.endswith(".json") and item.stat().st_mtime < cutoff:
            Path(item.path).unlink()


def prune_stale_temporary_files() -> None:
    cutoff = time.time() - 60 * 60
    for item in os.scandir(OUTBOX):
        if (
            item.name.startswith(".")
            and item.name.endswith(".tmp")
            and item.is_file(follow_symlinks=False)
            and item.stat(follow_symlinks=False).st_mtime < cutoff
        ):
            os.unlink(item.path)


def handle_file(name: str) -> bool:
    try:
        process_file(name)
        return True
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        print(f"Security alert rejected for {name}: {error}", file=sys.stderr)
        try:
            os.replace(PROCESSING / name, FAILED / name)
        except FileNotFoundError:
            pass
        return False
    except Exception as error:
        # Keep transient delivery failures in the Hermes-only processing
        # directory for the next timer run and make systemd record a failure.
        print(f"Security alert delivery failed for {name}: {error}", file=sys.stderr)
        return False


def main() -> int:
    OUTBOX.mkdir(parents=True, exist_ok=True)
    PROCESSING.mkdir(parents=True, exist_ok=True)
    SENT.mkdir(parents=True, exist_ok=True)
    FAILED.mkdir(parents=True, exist_ok=True)
    with LOCK.open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        attempts = 0
        failed = False
        # Retry already-claimed messages first. Only Hermes can write here, so
        # each file remains stable while it is validated and delivered.
        names = [item.name for item in os.scandir(PROCESSING) if valid_filename(item.name)]
        for name in sorted(set(names)):
            if attempts >= MAX_FILES_PER_RUN:
                break
            attempts += 1
            failed = not handle_file(name) or failed
        if attempts < MAX_FILES_PER_RUN:
            for item in sorted(os.scandir(OUTBOX), key=lambda entry: entry.name):
                if attempts >= MAX_FILES_PER_RUN:
                    break
                if not valid_filename(item.name):
                    continue
                try:
                    claim_file(item.name)
                    attempts += 1
                    failed = not handle_file(item.name) or failed
                except FileNotFoundError:
                    continue
                except Exception as error:
                    attempts += 1
                    failed = True
                    print(f"Security alert claim failed for {item.name}: {error}", file=sys.stderr)
        prune_stale_temporary_files()
        prune_sent()
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
