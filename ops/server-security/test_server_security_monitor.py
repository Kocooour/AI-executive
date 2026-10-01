#!/usr/bin/env python3

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("server_security_monitor.py")
SPEC = importlib.util.spec_from_file_location("server_security_monitor", MODULE_PATH)
monitor = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(monitor)


def state() -> dict:
    return {
        "auditKey": "11" * 32,
        "dedupe": {},
        "services": {service: "active" for service in monitor.SERVICES},
        "serviceDownStreaks": {},
        "failedUnits": [],
        "listeners": [],
        "unexpectedListeners": {},
    }


class HighConfidenceAlertPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.outbox_patch = patch.object(monitor, "OUTBOX", Path(self.temporary.name))
        self.outbox_patch.start()

    def tearDown(self) -> None:
        self.outbox_patch.stop()
        self.temporary.cleanup()

    def payloads(self) -> list[dict]:
        import json

        return [json.loads(path.read_text()) for path in Path(self.temporary.name).glob("*.json")]

    def test_small_ssh_scan_is_logged_but_not_paged(self) -> None:
        messages = ["Failed password for invalid user x from 203.0.113.1"] * 3
        with patch.object(monitor, "journal_messages", side_effect=[messages, []]):
            monitor.detect_authentication(state())
        self.assertEqual(self.payloads(), [])

    def test_large_ssh_burst_creates_one_aggregated_incident(self) -> None:
        messages = ["Failed password for invalid user x from 203.0.113.1"] * 20
        with patch.object(monitor, "journal_messages", side_effect=[messages, []]):
            monitor.detect_authentication(state())
        payloads = self.payloads()
        self.assertEqual(len(payloads), 1)
        self.assertEqual(payloads[0]["rule"], "server-ssh-auth-failures")
        self.assertEqual(payloads[0]["eventCount"], 20)

    def test_service_outage_requires_three_consecutive_checks(self) -> None:
        current = {service: "active" for service in monitor.SERVICES}
        current["tailscaled"] = "inactive"
        current_state = state()
        with (
            patch.object(monitor, "service_states", return_value=current),
            patch.object(monitor, "run", return_value=(0, "")),
        ):
            for expected in (0, 0, 1):
                monitor.detect_services(current_state, initialized=True)
                self.assertEqual(len(self.payloads()), expected)

    def test_existing_inactive_service_is_kept_as_baseline(self) -> None:
        current = {service: "active" for service in monitor.SERVICES}
        current["fail2ban"] = "inactive"
        current_state = state()
        current_state["services"]["fail2ban"] = "inactive"
        with (
            patch.object(monitor, "service_states", return_value=current),
            patch.object(monitor, "run", return_value=(0, "")),
        ):
            for _ in range(4):
                monitor.detect_services(current_state, initialized=True)
        self.assertEqual(self.payloads(), [])

    def test_public_listener_must_persist_for_three_checks(self) -> None:
        current_state = state()
        with patch.object(monitor, "external_listeners", return_value={"tcp/0.0.0.0:4444"}):
            for expected in (0, 0, 1):
                monitor.detect_listeners(current_state, initialized=True)
                self.assertEqual(len(self.payloads()), expected)


if __name__ == "__main__":
    unittest.main()
