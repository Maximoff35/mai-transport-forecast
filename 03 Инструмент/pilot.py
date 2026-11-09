"""Score the paired pilot planned in upgrade 20."""

import argparse
import csv
import json
import math
from datetime import date, timedelta
from pathlib import Path

from checks import HERE, export
from planning import INPUTS


COLS = [
    "week_start", "issued_on", "arrivals_t", "effective_capacity_t", "baseline_forecast_t", "model_forecast_t",
    "baseline_orders", "baseline_on_time", "pilot_orders", "pilot_on_time", "data_origin",
]


def fixture():
    data = [
        (110, 100, 103, 107), (90, 100, 104, 94), (100, 100, 107, 99),
        (115, 100, 109, 112), (91, 100, 105, 95), (103, 100, 97, 101),
        (93, 100, 103, 95), (109, 100, 111, 107), (90, 100, 101, 96),
        (107, 100, 104, 105), (89, 100, 101, 91), (112, 100, 107, 108),
    ]
    start = date(2026, 8, 3)
    for i, (arrivals, cap, baseline, forecast) in enumerate(data):
        week = start + timedelta(weeks=i)
        yield [week, week - timedelta(days=3), 1000 * arrivals, 1000 * cap, 1000 * baseline, 1000 * forecast,
               "", "", "", "", "synthetic"]


def validate(rows):
    weeks = set()
    for row in rows:
        week = date.fromisoformat(row["week_start"])
        if week.weekday() != 0 or week in weeks or date.fromisoformat(row["issued_on"]) >= week:
            raise ValueError(f"Use unique Mondays and an issue date before the target week: {week}")
        weeks.add(week)
        if row["data_origin"] not in ("observed", "synthetic"):
            raise ValueError("Each row needs data_origin set to observed or synthetic.")
        for key in COLS[2:6]:
            value = float(row[key])
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"Invalid {key} for {week}")
    if weeks and (max(weeks) - min(weeks)).days != 7 * (len(weeks) - 1):
        raise ValueError("Pilot observations must cover consecutive calendar weeks.")


def score(rows, policy, phase="shadow", example=False):
    validate(rows)
    n = len(rows)
    observed = sum(float(row["arrivals_t"]) for row in rows)
    if n < policy["minimum_eligible_weeks"] or observed == 0:
        return {"phase": phase, "n": n, "status": "insufficient_data"}
    errors = {}
    alerts, misses = {}, {}
    for label in ("baseline", "model"):
        field = f"{label}_forecast_t"
        errors[label] = sum(abs(float(r[field]) - float(r["arrivals_t"])) for r in rows) / observed
        alerts[label] = sum(float(r[field]) > float(r["effective_capacity_t"]) >= float(r["arrivals_t"]) for r in rows)
        misses[label] = sum(float(r["arrivals_t"]) > float(r["effective_capacity_t"]) >= float(r[field]) for r in rows)
    negative_weeks = sum(float(r["arrivals_t"]) <= float(r["effective_capacity_t"]) for r in rows)
    positive_weeks = n - negative_weeks
    wape_improvement = (1 - errors["model"] / errors["baseline"]) if errors["baseline"] else None
    alert_improvement = (1 - alerts["model"] / alerts["baseline"]) if alerts["baseline"] else None
    criterion = (
        wape_improvement is not None and wape_improvement >= policy["target_relative_wape_improvement"]
        and negative_weeks >= policy["minimum_non_overload_weeks"]
        and positive_weeks >= policy["minimum_overload_weeks"]
        and misses["model"] <= misses["baseline"]
        and (alert_improvement >= policy["target_relative_false_alert_reduction"]
                                    if alert_improvement is not None else alerts["model"] == 0)
    )
    result = {"phase": phase, "n": n, "baseline_WAPE_percent": 100 * errors["baseline"],
              "model_WAPE_percent": 100 * errors["model"], "baseline_false_alerts": alerts["baseline"],
              "model_false_alerts": alerts["model"], "non_overload_weeks": negative_weeks,
              "overload_weeks": positive_weeks, "baseline_missed_overloads": misses["baseline"],
              "model_missed_overloads": misses["model"],
              "relative_WAPE_improvement": wape_improvement, "relative_false_alert_reduction": alert_improvement,
              "status": "review_for_controlled_trial" if criterion else "revise_before_trial"}
    if phase == "controlled":
        for row in rows:
            for name in ("baseline", "pilot"):
                orders = int(row[f"{name}_orders"])
                on_time = int(row[f"{name}_on_time"])
                if not 0 <= on_time <= orders:
                    raise ValueError(f"Invalid SLA counts for {name}")
        totals = {name: sum(int(r[f"{name}_orders"]) for r in rows) for name in ("baseline", "pilot")}
        if min(totals.values()) <= 0:
            raise ValueError("Both groups require observed orders for a controlled phase.")
        sla = {name: sum(int(r[f"{name}_on_time"]) for r in rows) / totals[name] for name in totals}
        change = 100 * (sla["pilot"] - sla["baseline"])
        result["observed_SLA_change_pp"] = change
        result["status"] = ("review_expansion" if criterion and change >= -policy["maximum_sla_drop_pp"]
                            else "hold_expansion")
    if example or any(row["data_origin"] == "synthetic" for row in rows):
        result["illustrative_status"] = result["status"]
        result["status"] = "synthetic_fixture_only"
    return result


def read(path):
    with path.open(encoding="utf-8-sig", newline="") as source:
        return list(csv.DictReader(source))


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--input", type=Path)
    cli.add_argument("--phase", choices=("shadow", "controlled"), default="shadow")
    args = cli.parse_args()
    policy = json.loads(INPUTS.read_text(encoding="utf-8"))["pilot"]
    if args.input:
        print(json.dumps(score(read(args.input), policy, args.phase), indent=2, allow_nan=False))
        return
    export("20-pilot-log-template.csv", COLS, [])
    export("20-pilot-synthetic-example.csv", COLS, fixture())
    result = score([dict(zip(COLS, map(str, row), strict=True)) for row in fixture()], policy, example=True)
    result_file = HERE / "evidence" / "20-pilot-example-result.json"
    result_file.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
