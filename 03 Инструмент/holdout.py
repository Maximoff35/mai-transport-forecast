"""Evaluate a supplied later-period observation against the archived forecast."""

import argparse
import csv
import json
import math
from datetime import date
from pathlib import Path

from forecast import DATA, FIELDS, forecast, quarter_index, quarter_label, read_history


def evaluate(basin, period, actual, source, verified_scope):
    history = read_history(DATA, basin)
    origin = max(history)
    target = quarter_index(period)
    if not math.isfinite(actual) or actual < 0 or not origin < target <= origin + 4:
        raise ValueError("Supply a finite nonnegative actual for one of the next four quarters.")
    if not source.startswith("https://"):
        raise ValueError("Supply the exact HTTPS source of the observation.")
    with DATA.open(encoding="utf-8-sig", newline="") as file:
        archived = list(csv.DictReader(file))[-1]
    prediction = forecast(history, origin, target, "previous_year")
    return {
        "basin": basin, "data_cutoff": quarter_label(origin), "archived_release_date": archived["published_on"],
        "target": period, "evaluation_date": date.today().isoformat(),
        "prediction_Mt": prediction, "supplied_observation_Mt": actual,
        "observation_minus_prediction_Mt": actual - prediction, "source": source,
        "comparison_status": "scope_confirmed_by_user" if verified_scope else "scope_requires_confirmation",
        "evaluation_design": "reconstructed_origin_retrocheck",
    }


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--basin", required=True, choices=FIELDS)
    cli.add_argument("--quarter", required=True)
    cli.add_argument("--actual", required=True, type=float, help="Observed quarter, not YTD, in million tonnes.")
    cli.add_argument("--source", required=True)
    cli.add_argument("--scope-confirmed", action="store_true")
    args = cli.parse_args()
    print(json.dumps(evaluate(args.basin, args.quarter, args.actual, args.source, args.scope_confirmed),
                     indent=2, ensure_ascii=False, allow_nan=False))
