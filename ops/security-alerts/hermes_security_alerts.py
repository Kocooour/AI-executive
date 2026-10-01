#!/usr/bin/env python3
"""Deliver sanitized AI Executive security alerts through Hermes Telegram."""

from __future__ import annotations

import fcntl
import json
import os
import re
import socket
import stat
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

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
AI_RULES = {
    "rate-limit-triggered": (
        "critical",
        "Bylo překročeno povolené množství požadavků.",
        "Ověřte, zda provoz nevytváří vaše zařízení nebo automatizace. Pokud zdroj nepoznáváte, doporučuji přístup dočasně omezit.",
    ),
    "unauthenticated-mutation": (
        "critical",
        "Někdo se bez přihlášení pokusil změnit data.",
        "Při ojedinělém pokusu stačí situaci sledovat. Pokud se bude opakovat, doporučuji dočasně omezit veřejný přístup a prověřit logy.",
    ),
    "authentication-failures": (
        "critical",
        "Zaznamenal jsem několik neúspěšných pokusů o přihlášení.",
        "Pokud pokusy nepocházejí od vás, doporučuji prověřit jejich zdroj a při pokračování dočasně omezit přístup z internetu.",
    ),
    "protected-route-reconnaissance": (
        "warning",
        "Zaznamenal jsem opakované pokusy o přístup k chráněným částem aplikace.",
        "Zatím doporučuji pouze sledovat další vývoj. Omezení přístupu má smysl, pokud se aktivita opakuje nebo zesiluje.",
    ),
}
SERVER_RULES = {
    "server-monitor-self-test": (
        "warning",
        "Test serverového bezpečnostního monitoringu proběhl úspěšně.",
        "Není potřeba nic měnit. Tato zpráva pouze potvrzuje funkční cestu od serveru přes Hermes do Telegramu.",
    ),
    "server-ssh-auth-failures": (
        "critical",
        "Na serveru proběhlo několik neúspěšných pokusů o přihlášení přes SSH.",
        "Pokud zdroj nepoznáváte, doporučuji prověřit SSH logy a zvážit dočasné omezení přístupu.",
    ),
    "server-sudo-auth-failures": (
        "critical",
        "Na serveru proběhlo několik neúspěšných pokusů o získání oprávnění přes sudo.",
        "Ověřte, zda pokusy pocházejí z vaší relace. V opačném případě doporučuji okamžitě prověřit uživatelské účty a logy.",
    ),
    "server-fail2ban-ban": (
        "critical",
        "Fail2ban během krátké doby zablokoval větší počet různých zdrojů.",
        "Jde o rozsáhlejší pokus o přihlášení. Doporučuji prověřit SSH logy a ponechat přístup omezený jen na důvěryhodné sítě.",
    ),
    "server-service-down": (
        "critical",
        "Jedna z klíčových serverových služeb přestala běžet.",
        "Doporučuji prověřit stav a log služby dříve, než ji znovu spustíte.",
    ),
    "server-unit-failed": (
        "critical",
        "Systemd ohlásil novou službu ve stavu failed.",
        "Doporučuji zjistit příčinu z journalu a ověřit, zda selhání nesouvisí s bezpečnostním incidentem.",
    ),
    "server-new-listener": (
        "critical",
        "Na serveru se opakovaně objevil nový veřejně naslouchající síťový port.",
        "Doporučuji ihned ověřit vlastníka procesu a port uzavřít, pokud jeho zpřístupnění nebylo plánované.",
    ),
    "server-tailscale-config-changed": (
        "warning",
        "Změnila se konfigurace Tailscale Serve nebo Funnel.",
        "Porovnejte změnu se svými posledními zásahy a ověřte, že se veřejně nezpřístupnila nechtěná služba.",
    ),
    "server-sensitive-file-changed": (
        "critical",
        "Změnil se citlivý konfigurační soubor serveru.",
        "Pokud změna nebyla plánovaná, doporučuji ji považovat za incident a ihned prověřit související logy.",
    ),
    "server-firewall-changed": (
        "critical",
        "Serverový firewall zůstal vypnutý v několika po sobě jdoucích kontrolách.",
        "Doporučuji firewall bez odkladu obnovit a prověřit, zda jeho vypnutí bylo plánované.",
    ),
    "server-firewall-blocks": (
        "critical",
        "Firewall během krátké doby zablokoval mimořádně vysoký počet síťových pokusů.",
        "Doporučuji prověřit cílové porty a zdroje provozu a podle výsledku dočasně zpřísnit síťová pravidla.",
    ),
}
SCOPE = os.environ.get("SECURITY_ALERT_SCOPE", "ai-executive").strip().lower()
if SCOPE not in {"ai-executive", "server"}:
    raise RuntimeError("unsupported security alert scope")
RULES = SERVER_RULES if SCOPE == "server" else AI_RULES


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
    expected_severity, canonical_description, canonical_recommendation = RULES[rule]
    if severity != expected_severity:
        raise ValueError("severity does not match rule")
    source = bounded(payload.get("source"), 24)
    if not re.fullmatch(r"[0-9a-f]{24}", source):
        raise ValueError("invalid source")
    count = int(payload.get("eventCount", 0))
    if count < 1 or count > 1_000_000:
        raise ValueError("invalid event count")
    subject = bounded(payload.get("subject"), 120)
    if subject and not re.fullmatch(r"[A-Za-z0-9_./:@+,\-\[\] ]{1,120}", subject):
        raise ValueError("invalid alert subject")
    return {
        "id": alert_id,
        "severity": severity,
        "rule": rule,
        # Never trust free-form outbox text. The app may select only a known
        # rule; the privileged sender derives the user-facing wording.
        "description": canonical_description,
        "recommendation": canonical_recommendation,
        "eventCount": count,
        "firstAt": timestamp(payload.get("firstAt")),
        "lastAt": timestamp(payload.get("lastAt")),
        "source": source,
        "subject": subject,
    }


def deliver(alert: dict[str, object]) -> None:
    icon = "🚨" if alert["severity"] == "critical" else "⚠️"
    hostname = re.sub(r"[^A-Za-z0-9.-]", "", socket.gethostname())[:63] or "server"
    heading = (
        f"Bezpečnostní upozornění ze serveru {hostname}"
        if SCOPE == "server"
        else "Bezpečnostní upozornění z AI Executive"
    )
    local_time = (
        datetime.fromisoformat(str(alert["lastAt"]).replace("Z", "+00:00"))
        .astimezone(ZoneInfo("Europe/Prague"))
        .strftime("%-d. %-m. %Y v %H:%M:%S")
    )
    attempt_count = int(alert["eventCount"])
    attempt_label = "pokus" if attempt_count == 1 else "pokusy" if 2 <= attempt_count <= 4 else "pokusů"
    subject_line = f"Týká se: {alert['subject']}\n" if alert.get("subject") else ""
    outcome = (
        "Událost byla zaznamenána serverovým monitoringem."
        if SCOPE == "server"
        else "Požadavek byl zablokován a data zůstala beze změny."
    )
    choices = (
        "A — Pouze sledovat další upozornění.\n"
        "B — Připravit bezpečný postup pro dočasné omezení dotčené služby nebo přístupu.\n"
        "C — Prověřit technické logy a konfiguraci posledního incidentu.\n"
        "D — Připravit cílený bezpečnostní audit dotčené části serveru."
        if SCOPE == "server"
        else
        "A — Pouze sledovat další upozornění.\n"
        "B — Připravit bezpečný postup pro dočasné omezení přístupu z internetu.\n"
        "C — Prověřit technické logy posledního incidentu a shrnout zjištění."
    )
    available_choices = "A, B, C nebo D" if SCOPE == "server" else "A, B nebo C"
    message = (
        f"{icon} {heading}\n\n"
        f"{alert['description']}\n"
        f"{subject_line}"
        f"Zachyceno: {attempt_count} {attempt_label}\n"
        f"Kdy: {local_time}\n"
        f"Zdroj: {alert['source']} (anonymizováno)\n\n"
        f"{outcome}\n\n"
        f"Doporučení: {alert['recommendation']}\n\n"
        "Jak chcete pokračovat?\n"
        f"{choices}\n\n"
        f"Stačí odpovědět jediným písmenem: {available_choices}. "
        "Písmeno se vždy použije jako volba pro nejnovější bezpečnostní hlášení. "
        "Bez vašeho potvrzení se žádný další zásah neprovede."
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
