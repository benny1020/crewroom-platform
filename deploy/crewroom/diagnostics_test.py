import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("crewroom_diagnostics", Path(__file__).with_name("diagnostics.py"))
diag = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diag)


class DiagnosticsPrivacyTests(unittest.TestCase):
    def test_only_fixed_error_classes_leave_log_classifier(self):
        secret = "SYNTHETIC_TEST_VALUE"
        raw = (f"DATABASE_URL=postgres://crewroom:{secret}@db:5432/crewroom\n"
               f"Bootstrap URL http://localhost:3118/invite/{secret}\n"
               f"BETTER_AUTH_SECRET={secret}\nError: EACCES permission denied {secret}\n"
               "Paperclip server failed to start\n")
        report = diag.classify_logs(raw)
        serialized = json.dumps(report)
        self.assertNotIn(secret, serialized)
        self.assertNotIn("http", serialized)
        self.assertIn("permission_denied", report["errorClasses"])
        self.assertIn("server_start_failed", report["errorClasses"])
        self.assertTrue(set(report["errorClasses"]).issubset(diag.ERROR_CLASSES))

    def test_health_and_container_fields_reject_untrusted_text(self):
        secret = "SYNTHETIC_TEST_VALUE"
        state = diag.sanitize_state({"status": secret, "health": {"token": secret},
            "Error": secret, "Env": [secret], "exitCode": "1", "oomKilled": False,
            "healthExitCodes": [0, 1, secret, True]})
        health = diag.sanitize_health({"status": {"token": secret}, "statusCode": 503, "body": secret})
        self.assertNotIn(secret, json.dumps([state, health]))
        self.assertEqual(state["status"], "unknown")
        self.assertEqual(state["healthExitCodes"], [0, 1])
        self.assertEqual(health, {"status": "invalid", "statusCode": 503})

    def test_real_diagnostic_shapes_survive_without_raw_log_output(self):
        secret = "SYNTHETIC_TEST_VALUE"
        calls = []
        def runner(command):
            calls.append(command)
            if command[0:2] == ["docker", "compose"]:
                return True, "a" * 64, ""
            if command[1] == "inspect":
                return True, json.dumps({"status": "running", "exitCode": 0, "oomKilled": False,
                    "restartCount": 0, "health": "unhealthy", "healthExitCodes": [1, 1]}), ""
            if command[1] == "logs":
                return True, f"Server startup recovery complete on 0.0.0.0:3100\nbootstrap={secret}", ""
            return True, json.dumps({"statusCode": 200, "status": "ok", "token": secret}), ""
        report = diag.collect("crewroom-ci", Path("private.env"), runner=runner)
        self.assertNotIn(secret, json.dumps(report))
        self.assertEqual(report["services"]["app"]["anonymousHealth"]["status"], "ok")
        self.assertEqual(report["services"]["app"]["state"]["health"], "unhealthy")
        self.assertTrue(report["services"]["app"]["milestones"]["startup_recovery_ready"])
        self.assertNotIn(".Config.Env", diag.STATE_TEMPLATE)
        self.assertNotIn(".Output", diag.STATE_TEMPLATE)
        self.assertFalse(report["rawLogsRetained"])

    def test_collection_failures_expose_no_subprocess_error_text(self):
        report = diag.collect("crewroom-ci", Path("private.env"), runner=lambda _: (False, "", "SECRET=SYNTHETIC_TEST_VALUE"))
        self.assertNotIn("SECRET", json.dumps(report))
        for item in report["services"].values():
            self.assertEqual(item["collectionErrors"], ["container_lookup_unavailable"])


if __name__ == "__main__":
    unittest.main()
