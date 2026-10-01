#!/usr/bin/env python3
"""Collect and sanitize host security signals without network access."""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
import re
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

STATE_DIR = Path("/var/lib/server-security-monitor")
STATE_FILE = STATE_DIR / "state.json"
OUTBOX = Path("/var/lib/server-security/outbox")
MAX_OUTPUT = 512 * 1024
SERVICES = ("ssh", "fail2ban", "tailscaled", "hermes-gateway", "ai-executive")
SSH_FAILURE_THRESHOLD = 20
SSH_TOTAL_FAILURE_THRESHOLD = 50
SUDO_FAILURE_THRESHOLD = 5
FAIL2BAN_BURST_THRESHOLD = 10
FIREWALL_BLOCK_THRESHOLD = 100
CONFIRMATION_RUNS = 3
AUTH_ALERT_COOLDOWN = 6 * 60 * 60
INFRASTRUCTURE_ALERT_COOLDOWN = 24 * 60 * 60
SENSITIVE_PATHS = (
    Path("/etc/passwd"),
    Path("/etc/group"),
    Path("/etc/gshadow"),
    Path("/etc/shadow"),
    Path("/etc/ssh/sshd_config"),
    Path("/etc/ssh/sshd_config.d"),
    Path("/etc/sudoers"),
    Path("/etc/sudoers.d"),
    Path("/etc/fail2ban"),
    Path("/etc/ufw"),
    Path("/etc/systemd/system/ai-executive.service"),
    Path("/etc/systemd/system/ai-executive.service.d"),
    Path("/etc/systemd/system/hermes-gateway.service"),
    Path("/etc/systemd/system/hermes-gateway.service.d"),
    Path("/etc/systemd/system/tailscaled.service.d"),
    Path("/etc/systemd/system/server-security-monitor.service"),
    Path("/etc/systemd/system/server-security-monitor.timer"),
    Path("/etc/systemd/system/server-security-alerts.service"),
    Path("/etc/systemd/system/server-security-alerts.timer"),
    Path("/usr/local/lib/server-security-monitor/server_security_monitor.py"),
    Path("/usr/local/lib/ai-executive-security/hermes_security_alerts.py"),
)


def run(command: list[str], timeout: int = 10) -> tuple[int, str]:
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
            env={"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
        )
        output = (completed.stdout + "\n" + completed.stderr)[:MAX_OUTPUT]
        return completed.returncode, output.strip()
    except (OSError, subprocess.SubprocessError) as error:
        return 127, type(error).__name__


def load_state() -> dict:
    try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if isinstance(state, dict) and isinstance(state.get("auditKey"), str):
            return state
    except (OSError, ValueError):
        pass
    return {
        "schema": 1,
        "auditKey": os.urandom(32).hex(),
        "initialized": False,
        "dedupe": {},
        "services": {},
        "failedUnits": [],
        "listeners": [],
        "sensitiveFiles": {},
        "tailscaleHash": "",
        "firewallHash": "",
        "bannedIps": [],
        "serviceDownStreaks": {},
        "unexpectedListeners": {},
        "firewallInactiveStreak": 0,
        "firewallActive": None,
    }


def save_state(state: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = STATE_FILE.with_name(f".{STATE_FILE.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, STATE_FILE)


def source_hash(state: dict, value: str) -> str:
    return hmac.new(
        bytes.fromhex(state["auditKey"]),
        value.encode("utf-8", errors="replace"),
        hashlib.sha256,
    ).hexdigest()[:24]


def safe_subject(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_./:@+,\-\[\] ]", "", value).strip()
    return cleaned[:120] or "server"


def emit(
    state: dict,
    rule: str,
    severity: str,
    subject: str,
    source: str,
    count: int = 1,
    window_seconds: int = 600,
) -> bool:
    now = int(time.time())
    normalized_subject = safe_subject(subject)
    dedupe_key = hashlib.sha256(f"{rule}|{normalized_subject}|{source}".encode()).hexdigest()
    previous = state["dedupe"].get(dedupe_key)
    if isinstance(previous, int) and now - previous < window_seconds:
        return False
    alert_id = str(uuid.uuid4())
    timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    payload = {
        "schema": 1,
        "id": alert_id,
        "severity": severity,
        "rule": rule,
        "subject": normalized_subject,
        "eventCount": max(1, min(int(count), 1_000_000)),
        "firstAt": timestamp,
        "lastAt": timestamp,
        "source": source_hash(state, source),
    }
    OUTBOX.mkdir(parents=True, exist_ok=True, mode=0o770)
    temporary = OUTBOX / f".{alert_id}.{uuid.uuid4().hex}.tmp"
    final = OUTBOX / f"{alert_id}.json"
    temporary.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    os.chmod(temporary, 0o640)
    os.replace(temporary, final)
    state["dedupe"][dedupe_key] = now
    return True


def audit(message: str) -> None:
    """Keep low-confidence signals in journald without paging the owner."""
    print(f"security-observation: {safe_subject(message)}")


def journal_messages(arguments: list[str]) -> list[str]:
    code, output = run(["/usr/bin/journalctl", "--since", "5 minutes ago", "-n", "2000", "-o", "json", "--no-pager", *arguments])
    if code not in {0, 1}:
        return []
    messages: list[str] = []
    for line in output.splitlines():
        try:
            record = json.loads(line)
            message = str(record.get("MESSAGE", ""))
            if message:
                messages.append(message[:2000])
        except ValueError:
            continue
    return messages


def detect_authentication(state: dict) -> None:
    ssh_failures: dict[str, int] = {}
    for message in journal_messages(["-u", "ssh.service"]):
        lowered = message.lower()
        if not any(marker in lowered for marker in ("failed password", "invalid user", "authentication failure")):
            continue
        match = re.search(r"(?:from|rhost=)\s*([0-9a-f:.]+)", message, re.IGNORECASE)
        source = match.group(1).lower() if match else "unknown-ssh-source"
        ssh_failures[source] = ssh_failures.get(source, 0) + 1
    total_failures = sum(ssh_failures.values())
    worst_source_count = max(ssh_failures.values(), default=0)
    if total_failures >= SSH_TOTAL_FAILURE_THRESHOLD or worst_source_count >= SSH_FAILURE_THRESHOLD:
        # Aggregate the burst into one incident. Do not page once per attacking
        # address; internet SSH scanners routinely rotate their source IPs.
        emit(
            state,
            "server-ssh-auth-failures",
            "critical",
            "SSH brute-force burst",
            "ssh-authentication-burst",
            total_failures,
            window_seconds=AUTH_ALERT_COOLDOWN,
        )
    elif total_failures:
        audit(f"SSH failures below alert threshold count={total_failures}")

    sudo_count = 0
    for message in journal_messages(["_COMM=sudo"]):
        lowered = message.lower()
        if any(marker in lowered for marker in ("authentication failure", "incorrect password", "not in sudoers")):
            sudo_count += 1
    if sudo_count >= SUDO_FAILURE_THRESHOLD:
        emit(
            state,
            "server-sudo-auth-failures",
            "critical",
            "sudo authentication burst",
            "local-sudo",
            sudo_count,
            window_seconds=AUTH_ALERT_COOLDOWN,
        )
    elif sudo_count:
        audit(f"sudo failures below alert threshold count={sudo_count}")


def detect_fail2ban(state: dict, initialized: bool) -> None:
    code, output = run(["/usr/bin/fail2ban-client", "status", "sshd"])
    banned: set[str] = set()
    if code == 0:
        match = re.search(r"Banned IP list:\s*(.*)", output)
        if match:
            banned = {value for value in match.group(1).split() if re.fullmatch(r"[0-9a-f:.]+", value, re.IGNORECASE)}
    previous = set(state.get("bannedIps", []))
    newly_banned = banned - previous
    if initialized and len(newly_banned) >= FAIL2BAN_BURST_THRESHOLD:
        emit(
            state,
            "server-fail2ban-ban",
            "critical",
            "Fail2ban SSH ban burst",
            "fail2ban-ban-burst",
            len(newly_banned),
            window_seconds=AUTH_ALERT_COOLDOWN,
        )
    elif initialized and newly_banned:
        audit(f"Fail2ban handled new sources count={len(newly_banned)}")
    state["bannedIps"] = sorted(banned)


def service_states() -> dict[str, str]:
    result: dict[str, str] = {}
    for service in SERVICES:
        _, output = run(["/usr/bin/systemctl", "is-active", service])
        result[service] = output.splitlines()[0] if output else "unknown"
    return result


def detect_services(state: dict, initialized: bool) -> None:
    current = service_states()
    previous = state.get("services", {})
    streaks = state.get("serviceDownStreaks", {})
    if not isinstance(streaks, dict):
        streaks = {}
    for service, status in current.items():
        if status == "active":
            streaks.pop(service, None)
            continue
        if previous.get(service) != "active" and service not in streaks:
            # Preserve an already-down service as the existing baseline after
            # upgrades. Only a new active -> down transition starts paging.
            audit(f"service {service} remains in baseline status={status}")
            continue
        streak = int(streaks.get(service, 0)) + 1
        streaks[service] = streak
        audit(f"service {service} status={status} confirmation={streak}")
        if initialized and streak == CONFIRMATION_RUNS:
            emit(
                state,
                "server-service-down",
                "critical",
                service,
                f"service:{service}:{status}",
                window_seconds=INFRASTRUCTURE_ALERT_COOLDOWN,
            )
    state["serviceDownStreaks"] = streaks
    state["services"] = current

    _, output = run(["/usr/bin/systemctl", "--failed", "--no-legend", "--plain"])
    failed = {line.split()[0] for line in output.splitlines() if line.split()}
    new_failed = failed - set(state.get("failedUnits", []))
    if initialized and new_failed:
        # A generic failed unit is an operational clue, not evidence of an
        # attack. Critical monitored services are handled above after three
        # consecutive checks; everything else remains available in journald.
        audit(f"new failed systemd units count={len(new_failed)}")
    state["failedUnits"] = sorted(failed)


def external_listeners() -> set[str]:
    code, output = run(["/usr/bin/ss", "-lntH"])
    if code != 0:
        return set()
    listeners: set[str] = set()
    for line in output.splitlines():
        fields = line.split()
        if len(fields) < 4:
            continue
        endpoint = fields[3]
        host = endpoint.rsplit(":", 1)[0].strip("[]")
        try:
            address = ipaddress.ip_address(host)
            tailnet_v4 = ipaddress.ip_network("100.64.0.0/10")
            tailnet_v6 = ipaddress.ip_network("fd7a:115c:a1e0::/48")
            if address.is_loopback or address in tailnet_v4 or address in tailnet_v6:
                continue
        except ValueError:
            if host == "localhost":
                continue
        listeners.add(f"tcp/{endpoint}")
    return listeners


def detect_listeners(state: dict, initialized: bool) -> None:
    current = external_listeners()
    baseline = set(state.get("listeners", []))
    pending = state.get("unexpectedListeners", {})
    if not isinstance(pending, dict):
        pending = {}
    if not initialized:
        state["listeners"] = sorted(current)
        state["unexpectedListeners"] = {}
        return
    for listener in list(pending):
        if listener not in current or listener in baseline:
            pending.pop(listener, None)
    for listener in sorted(current - baseline):
        streak = int(pending.get(listener, 0)) + 1
        pending[listener] = streak
        audit(f"unexpected public listener {listener} confirmation={streak}")
        if streak == CONFIRMATION_RUNS:
            emit(
                state,
                "server-new-listener",
                "critical",
                listener,
                f"listener:{listener}",
                window_seconds=INFRASTRUCTURE_ALERT_COOLDOWN,
            )
            baseline.add(listener)
            pending.pop(listener, None)
    state["listeners"] = sorted(baseline)
    state["unexpectedListeners"] = pending


def files_under(path: Path) -> list[Path]:
    if path.is_file():
        return [path]
    if path.is_dir():
        return sorted(item for item in path.rglob("*") if item.is_file() and not item.is_symlink())
    return []


def sensitive_hashes() -> dict[str, str]:
    hashes: dict[str, str] = {}
    for configured in SENSITIVE_PATHS:
        files = files_under(configured)
        if not files:
            hashes[str(configured)] = "missing"
        for item in files:
            try:
                digest = hashlib.sha256()
                with item.open("rb") as handle:
                    while chunk := handle.read(64 * 1024):
                        digest.update(chunk)
                hashes[str(item)] = digest.hexdigest()
            except OSError:
                hashes[str(item)] = "unreadable"
    return hashes


def detect_sensitive_files(state: dict, initialized: bool) -> None:
    current = sensitive_hashes()
    previous = state.get("sensitiveFiles", {})
    if initialized:
        changed = [name for name in sorted(set(current) | set(previous)) if current.get(name) != previous.get(name)]
        if changed:
            # Integrity changes are retained as forensic evidence, but a file
            # change by itself is not a reliable attack signal (package and
            # configuration updates legitimately touch these paths).
            audit(f"sensitive file changes observed count={len(changed)}")
    state["sensitiveFiles"] = current


def configuration_hash(command: list[str]) -> str:
    code, output = run(command)
    return hashlib.sha256(f"{code}\n{output}".encode()).hexdigest()


def detect_network_configuration(state: dict, initialized: bool) -> None:
    tailscale_hash = configuration_hash(["/usr/bin/tailscale", "serve", "status"])
    if initialized and state.get("tailscaleHash") and tailscale_hash != state["tailscaleHash"]:
        audit("Tailscale Serve or Funnel configuration changed")
    state["tailscaleHash"] = tailscale_hash

    firewall_hash = configuration_hash(["/usr/sbin/ufw", "status", "verbose"])
    if initialized and state.get("firewallHash") and firewall_hash != state["firewallHash"]:
        audit("UFW firewall configuration changed")
    state["firewallHash"] = firewall_hash

    firewall_code, firewall_output = run(["/usr/sbin/ufw", "status"])
    firewall_active = firewall_code == 0 and "status: active" in firewall_output.lower()
    previous_firewall_active = state.get("firewallActive")
    if firewall_active:
        inactive_streak = 0
    elif previous_firewall_active is True or int(state.get("firewallInactiveStreak", 0)) > 0:
        inactive_streak = int(state.get("firewallInactiveStreak", 0)) + 1
    else:
        # An intentionally inactive firewall present when this policy is first
        # installed is a baseline, not an incident.
        inactive_streak = 0
    if initialized and inactive_streak == CONFIRMATION_RUNS:
        emit(
            state,
            "server-firewall-changed",
            "critical",
            "UFW firewall disabled",
            "firewall-inactive",
            window_seconds=INFRASTRUCTURE_ALERT_COOLDOWN,
        )
    elif not firewall_active:
        audit(
            f"UFW firewall inactive confirmation={inactive_streak}"
            if inactive_streak
            else "UFW firewall inactive in existing baseline"
        )
    state["firewallInactiveStreak"] = inactive_streak
    state["firewallActive"] = firewall_active

    blocked = sum("UFW BLOCK" in message for message in journal_messages(["-k"]))
    if blocked >= FIREWALL_BLOCK_THRESHOLD:
        emit(
            state,
            "server-firewall-blocks",
            "critical",
            "UFW attack burst",
            "firewall-block-burst",
            blocked,
            window_seconds=AUTH_ALERT_COOLDOWN,
        )
    elif blocked:
        audit(f"firewall blocks below alert threshold count={blocked}")


def prune_dedupe(state: dict) -> None:
    cutoff = int(time.time()) - 7 * 24 * 60 * 60
    state["dedupe"] = {
        key: created for key, created in state.get("dedupe", {}).items()
        if isinstance(created, int) and created >= cutoff
    }


def main() -> int:
    state = load_state()
    if sys.argv[1:] == ["--self-test"]:
        prune_dedupe(state)
        emit(
            state,
            "server-monitor-self-test",
            "warning",
            "server-security-monitor",
            "self-test",
            window_seconds=60,
        )
        save_state(state)
        return 0
    if sys.argv[1:]:
        print("Unsupported arguments", file=sys.stderr)
        return 2
    initialized = bool(state.get("initialized"))
    prune_dedupe(state)
    detect_authentication(state)
    detect_fail2ban(state, initialized)
    detect_services(state, initialized)
    detect_listeners(state, initialized)
    detect_sensitive_files(state, initialized)
    detect_network_configuration(state, initialized)
    state["initialized"] = True
    state["lastRunAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    save_state(state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
