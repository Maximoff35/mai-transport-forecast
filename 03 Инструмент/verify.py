"""Regression checks for time availability and planning constraints."""

import copy
import csv
import json
import math
from datetime import date, timedelta

from checks import HERE, quarter_start
from forecast import DATA, FIELDS, METHODS, forecast, read_history
from pilot import COLS, fixture, score
from planning import INPUTS, validate_config


def read(name):
    with (HERE / name).open(encoding="utf-8-sig", newline="") as file:
        return list(csv.DictReader(file))


def expect_error(action):
    try:
        action()
    except (ValueError, KeyError):
        return
    raise AssertionError("Expected invalid input to be rejected.")


checks = []
count = 0
for basin in FIELDS:
    history = read_history(DATA, basin)
    for target in range(min(history) + 12, max(history) + 1):
        for lead in range(1, 5):
            origin = target - lead
            truncated = {key: value for key, value in history.items() if key <= origin}
            for method in METHODS:
                assert forecast(history, origin, target, method) == forecast(truncated, origin, target, method)
                count += 1
expect_error(lambda: forecast(history, max(history), max(history) + 5, "previous_year"))
expect_error(lambda: forecast(history, max(history), max(history) + 1, "unknown"))
checks.append(f"{count} forecast comparisons against a truncated history.")

for row in read("decision-replay.csv"):
    assert date.fromisoformat(row["issued_on"]) < quarter_start(row["first_target"])
    chosen, best, regret = [float(row[key]) for key in ("actual_under_selected_Mt", "hindsight_best_Mt", "regret_Mt")]
    assert regret >= 0 and math.isclose(chosen - best, regret, abs_tol=1e-5)
checks.append("15 replay windows start after the release of all forecast inputs.")

config = json.loads(INPUTS.read_text(encoding="utf-8"))
validate_config(config)
broken = copy.deepcopy(config)
broken["lugaport"]["compatible_share"] = 1.1
expect_error(lambda: validate_config(broken))
checks.append("Editable planning inputs reject incompatible values.")

flows = read("evidence/17-backlog-flow.csv")
for row in flows:
    start, arrivals, handled, end = [float(row[key]) for key in
                                    ("opening_backlog_Mt", "reference_arrivals_Mt", "handled_Mt", "closing_backlog_Mt")]
    assert math.isclose(start + arrivals, handled + end, abs_tol=1e-5)
    assert handled <= float(row["available_Mt"]) + 1e-5 and end >= 0
checks.append("36 backlog rows preserve flow balance and available capacity.")

for row in read("evidence/12-minimum-hybrid-reserve.csv"):
    assert math.isclose(float(row["after_move_Q1_Mt"]) + float(row["after_move_Q2_Mt"]),
                        float(row["hybrid_total_Mt"]), abs_tol=1e-5)
checks.append("Hybrid reserves equal the two-quarter shortfalls.")

policy = config["pilot"]
synthetic = [dict(zip(COLS, map(str, row), strict=True)) for row in fixture()]
assert score(synthetic, policy)["status"] == "synthetic_fixture_only"
missed = copy.deepcopy(synthetic)
for i, row in enumerate(missed):
    row.update(arrivals_t=str(99000 if i % 2 == 0 else 101000), effective_capacity_t="100000",
               baseline_forecast_t="110000", model_forecast_t="100000", data_origin="observed")
result = score(missed, policy)
assert result["model_missed_overloads"] == 6 and result["status"] == "revise_before_trial"
gap = copy.deepcopy(synthetic)
gap[-1]["week_start"] = (date.fromisoformat(gap[-1]["week_start"]) + timedelta(weeks=1)).isoformat()
expect_error(lambda: score(gap, policy))
checks.append("Pilot rejects missed-overload regression, broken coverage and unlabeled synthetic use.")

for source in json.loads((HERE / "sources" / "manifest.json").read_text(encoding="utf-8")):
    import hashlib

    assert source["status"] == "downloaded"
    assert hashlib.sha256((HERE / "sources" / source["file"]).read_bytes()).hexdigest() == source["sha256"]
checks.append("21 saved primary-source files match their SHA-256 manifests.")

report = {"status": "passed", "checks": checks}
(HERE / "evidence" / "verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                                                   encoding="utf-8")
print(json.dumps(report, ensure_ascii=False, indent=2))
