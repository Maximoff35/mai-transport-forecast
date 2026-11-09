"""Reproduce the first forecasts and planning scenarios for MAI case A1."""

import argparse
import csv
import math
from pathlib import Path
from statistics import mean


DATA = Path(__file__).with_name("asop-verified.csv")
FIELDS = {"baltic": "baltic_ytd_million_tonnes",
          "azov": "azov_black_sea_ytd_million_tonnes",
          "far_east": "far_east_ytd_million_tonnes"}
METHODS = ("previous_quarter", "previous_year", "same_quarter_mean_2y")


def quarter_index(period):
    year, quarter = period.split("-Q")
    quarter = int(quarter)
    if quarter not in range(1, 5):
        raise ValueError(f"Invalid quarter: {period}")
    return int(year) * 4 + quarter - 1


def quarter_label(index):
    year, quarter = divmod(index, 4)
    return f"{year}-Q{quarter + 1}"


def read_history(path, basin):
    history = {}
    previous_total = 0
    with path.open(encoding="utf-8-sig", newline="") as source:
        for row in csv.DictReader(source):
            period = quarter_index(row["quarter"])
            total = float(row[FIELDS[basin]])
            if history and period != max(history) + 1:
                raise ValueError(f"Missing, duplicate or unordered quarter: {row['quarter']}")
            if not history and period % 4:
                raise ValueError("The first year must start at Q1.")
            if period % 4 == 0:
                previous_total = 0
            if not math.isfinite(total) or total <= previous_total:
                raise ValueError(f"Invalid cumulative total: {row['quarter']}")
            history[period] = round(total - previous_total, 1)
            previous_total = total
    if len(history) < 12:
        raise ValueError("At least 12 consecutive quarters are required.")
    return history


def forecast(history, origin, target, method):
    if method not in METHODS or origin not in history or not 1 <= target - origin <= 4:
        raise ValueError("Use a known method, an observed origin, and a horizon of 1–4 quarters.")
    if method == "previous_quarter":
        return history[origin]
    last_same_quarter = target - 4
    if method == "previous_year":
        return history[last_same_quarter]
    return mean((history[last_same_quarter], history[last_same_quarter - 4]))


def backtest(history, first, last, lead, method):
    pairs = [(forecast(history, target - lead, target, method), history[target])
             for target in range(first, last + 1)]
    errors = [actual - predicted for predicted, actual in pairs]
    mae = mean(map(abs, errors))
    wape = 100 * sum(map(abs, errors)) / sum(actual for _, actual in pairs)
    return mae, wape, mean(errors)


def compare_actions(loads, capacity, repair_at, repair_loss, reserve):
    if len(loads) != 2 or repair_at not in loads:
        raise ValueError("The repair comparison requires two quarters and a repair within that window.")
    base = {quarter: capacity for quarter in loads}
    base[repair_at] -= repair_loss
    peak = max(loads, key=lambda quarter: loads[quarter] - base[quarter])
    extra = {**base, peak: base[peak] + reserve}

    def gap(available):
        return sum(max(load - available[quarter], 0) for quarter, load in loads.items())

    candidates = {}
    for quarter in loads:
        if quarter != repair_at:
            moved = {**base, repair_at: capacity, quarter: capacity - repair_loss}
            candidates[quarter] = gap(moved)
    best = min(candidates, key=candidates.get)
    return gap(base), gap(extra), candidates[best], peak, best


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=DATA)
    parser.add_argument("--basin", choices=FIELDS, default="baltic")
    parser.add_argument("--capacity", type=float, default=68)
    parser.add_argument("--repair-loss", type=float, default=4)
    parser.add_argument("--reserve", type=float, default=3)
    parser.add_argument("--shock-percent", type=float, default=0)
    parser.add_argument("--repair-slot", type=int, choices=(1, 2), default=2,
                        help="Slot 1 or 2 in the two-quarter scenario window.")
    args = parser.parse_args()
    inputs = (args.capacity, args.repair_loss, args.reserve, args.shock_percent)
    if (not all(map(math.isfinite, inputs)) or args.capacity <= 0
            or not 0 <= args.repair_loss <= args.capacity or args.reserve < 0
            or args.shock_percent < -100):
        parser.error("Use finite inputs, positive capacity, repair loss within capacity, "
                     "nonnegative reserve, and load shock of at least -100%.")

    history = read_history(args.data, args.basin)
    origin = max(history)
    if len(history) < 16:
        parser.error("The forecast comparison needs at least 16 quarters.")
    first_test = min(history) + 12
    print(f"{args.basin} | data {quarter_label(min(history))} to {quarter_label(origin)}")
    print(f"Backtest {quarter_label(first_test)} to {quarter_label(origin)}, "
          f"n={origin - first_test + 1} per method and horizon")
    print("Lead   Method                  MAE Mt    WAPE %   Mean(actual-pred) Mt")
    for lead in (1, 2, 3, 4):
        for method in METHODS:
            mae, wape, bias = backtest(history, first_test, origin, lead, method)
            print(f"{lead:<6} {method:<23} {mae:7.2f} {wape:9.2f} {bias:18.2f}")

    # Keep the demo forecast rule fixed across both basins.
    future = {target: forecast(history, origin, target, "previous_year")
              for target in range(origin + 1, origin + 5)}
    print("Seasonal reference forecast (Mt)")
    for quarter, prediction in future.items():
        print(f"  {quarter_label(quarter)}   {prediction:.1f}")

    # The demo planning window uses the last two quarters of the forecast.
    loads = {quarter: value * (1 + args.shock_percent / 100)
             for quarter, value in list(future.items())[-2:]}
    repair_at = list(loads)[args.repair_slot - 1]
    base, reserve, move, peak, destination = compare_actions(
        loads, args.capacity, repair_at, args.repair_loss, args.reserve)
    print(f"Illustrative scenario: {quarter_label(min(loads))} to {quarter_label(max(loads))}")
    print(f"  assumed cap={args.capacity:.1f} Mt/q, repair loss={args.repair_loss:.1f} Mt, "
          f"reserve={args.reserve:.1f} Mt, load shock={args.shock_percent:+.1f}%")
    print(f"  base gap={base:.2f} Mt (repair {quarter_label(repair_at)})")
    print(f"  reserve gap={reserve:.2f} Mt (reserve {quarter_label(peak)})")
    print(f"  move repair gap={move:.2f} Mt (repair {quarter_label(destination)})")


if __name__ == "__main__":
    main()
