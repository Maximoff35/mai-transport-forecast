"""Exercise changed configuration through CLI, generated HTML and CSV evidence."""

import argparse
import csv
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

from config import load_config, validate_config


HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--temp-root", type=Path, default=HERE.parent / ".config-checks")
    args = parser.parse_args()
    if not args.node:
        parser.error("Pass --node PATH to run the JavaScript integration checks.")
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    original = load_config()
    temp_root = args.temp_root.resolve()
    temp_root.mkdir(parents=True, exist_ok=True)
    cases = []
    for allow_move in (True, False):
        config = json.loads(json.dumps(original))
        config["basin_demo"].update(capacity_Mt_per_quarter=71, repair_loss_Mt=5,
                                  reserve_Mt=2, allow_move=allow_move)
        config["as_of"] = "2026-09-01"
        config["calendar"].update(reserve_lead_calendar_days=30, repair_move_lead_calendar_days=60)
        config["forecast"] = {"horizon_quarters": 2}
        validate_config(config)
        with tempfile.TemporaryDirectory(prefix="mai-config-", dir=temp_root) as temporary:
            root = Path(temporary).resolve()
            assert root.parent == temp_root
            target = root / "instrument"
            shutil.copytree(HERE, target, ignore=shutil.ignore_patterns("__pycache__"))
            (target / "planning-inputs.json").write_text(json.dumps(config), encoding="utf-8")
            subprocess.run([sys.executable, str(target / "rebuild.py")], check=True,
                           capture_output=True, encoding="utf-8", env=env)
            subprocess.run([args.node, str(target / "verify-demo.cjs")], check=True,
                           capture_output=True, encoding="utf-8", env=env)
            cli = subprocess.run([sys.executable, str(target / "forecast.py"), "--horizon", "4"],
                                 check=True, capture_output=True, encoding="utf-8", env=env).stdout
            assert "cap=71.0 Mt/q, repair loss=5.0 Mt, reserve=2.0 Mt" in cli
            assert ("move repair excluded" in cli) == (not allow_move)
            short = subprocess.run([sys.executable, str(target / "forecast.py")], check=True,
                                   capture_output=True, encoding="utf-8", env=env).stdout
            assert "2026-Q4" in short and "  2027-Q1" not in short
            html = (target / "Демо.html").read_text(encoding="utf-8")
            settings = json.loads(re.search(r'<script id="planning-settings" type="application/json">(.*?)</script>', html)[1])
            assert settings["horizon_quarters"] == 2 and settings["as_of"] == "2026-09-01"
            with (target / "evidence/10-asymmetric-stress.csv").open(encoding="utf-8-sig") as file:
                rows = list(csv.DictReader(file))
            selected = [r for r in rows if r["basin"] == "baltic" and r["scenario"] == "reference"]
            assert {r["action"]: float(r["gap_Mt"]) for r in selected} == (
                {"base":0,"reserve":0,"move":0} if allow_move else {"base":0,"reserve":0})
            with (target / "decision-replay.csv").open(encoding="utf-8-sig") as file:
                replay = list(csv.DictReader(file))
            if not allow_move:
                assert all(r["decision"] != "move" and r["actual_under_move_Mt"] == "" for r in replay)
            assert "cap=71.0" in (target / "results.txt").read_text(encoding="utf-8")
            assert "2026-09-01" in (target / "evidence/13-decision-calendar.csv").read_text(encoding="utf-8-sig")
            cases.append({"allow_move":allow_move,"status":"passed"})
    invalid = json.loads(json.dumps(original))
    invalid["forecast"] = {"horizon_quarters":5}
    try:
        validate_config(invalid)
    except ValueError:
        pass
    else:
        raise AssertionError("Invalid horizon accepted")
    report = {"status":"passed", "changed_configuration_cases":cases, "invalid_horizon_rejected":True}
    (HERE / "evidence/config-verification.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
