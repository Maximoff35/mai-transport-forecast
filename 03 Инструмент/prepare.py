"""Generate offline demo inputs and export the comparison evidence."""

import csv
import json
from pathlib import Path

from forecast import DATA, FIELDS, METHODS, backtest, compare_actions, forecast, quarter_label, read_history


HERE = Path(__file__).resolve().parent
labels = {"baltic": "Балтийский бассейн", "azov": "Азово-Черноморский бассейн",
          "far_east": "Дальневосточный бассейн"}
payload = {}
with DATA.open(encoding="utf-8-sig", newline="") as source:
    publication_dates = {row["quarter"]: row["published_on"] for row in csv.DictReader(source)}
with (HERE / "backtest.csv").open("w", newline="", encoding="utf-8-sig") as metrics_file:
    writer = csv.writer(metrics_file)
    writer.writerow(["basin", "lead_quarters", "method", "n", "MAE_Mt", "WAPE_percent", "bias_Mt"])
    for basin in FIELDS:
        history = read_history(DATA, basin)
        first, last = min(history), max(history)
        future = [forecast(history, last, index, "previous_year") for index in (last + 3, last + 4)]
        payload[basin] = {
            "label": labels[basin],
            "last": quarter_label(last),
            "periods": [quarter_label(index) for index in (last + 3, last + 4)],
            "loads": future,
        }
        for lead in range(1, 5):
            for method in METHODS:
                metrics = backtest(history, first + 12, last, lead, method)
                writer.writerow([basin, lead, method, last - first - 11, *(round(x, 4) for x in metrics)])

template = (HERE / "demo-template.html").read_text(encoding="utf-8")
(HERE / "Демо.html").write_text(template.replace("__MODEL_DATA__", json.dumps(payload, ensure_ascii=False)),
                               encoding="utf-8")

with (HERE / "scenario-grid.csv").open("w", newline="", encoding="utf-8-sig") as grid_file:
    writer = csv.writer(grid_file)
    writer.writerow(["basin", "capacity_Mt_per_quarter", "load_change_percent",
                     "base_gap_Mt", "reserve_gap_Mt", "move_gap_Mt", "best_gap_action"])
    for basin, model in payload.items():
        for capacity in range(58, 79, 2):
            for shock in range(-10, 11, 2):
                loads = {period: value * (1 + shock / 100)
                         for period, value in enumerate(model["loads"], start=1)}
                values = [round(x, 5) for x in compare_actions(loads, capacity, 2, 4, 3)[:3]]
                best = [name for name, value in zip(("base", "reserve", "move"), values)
                        if value == min(values)]
                writer.writerow([basin, capacity, shock, *values, "/".join(best)])


def over_plan(loads, available):
    return sum(max(load - capacity, 0) for load, capacity in zip(loads, available))


# Two full future quarters after the preceding quarter's publication.
# The capacity plans are hypothetical for every historical window.
with (HERE / "decision-replay.csv").open("w", newline="", encoding="utf-8-sig") as replay_file:
    writer = csv.writer(replay_file)
    writer.writerow(["basin", "origin", "issued_on", "first_target", "last_target", "decision",
                     "actual_under_base_Mt", "actual_under_reserve_Mt", "actual_under_move_Mt",
                     "actual_under_selected_Mt", "hindsight_best_Mt", "regret_Mt"])
    for basin in FIELDS:
        history = read_history(DATA, basin)
        for first in range(min(history) + 12, max(history)):
            origin = first - 2
            targets = (first, first + 1)
            predicted = [forecast(history, origin, target, "previous_year") for target in targets]
            actual = [history[target] for target in targets]
            base = (68, 64)
            peak = max(range(2), key=lambda i: predicted[i] - base[i])
            plans = {"base": base, "reserve": tuple(cap + 3 * (i == peak) for i, cap in enumerate(base)),
                     "move": (64, 68)}
            selected = min(plans, key=lambda action: over_plan(predicted, plans[action]))
            outcomes = {action: over_plan(actual, plan) for action, plan in plans.items()}
            best = min(outcomes.values())
            results = [*outcomes.values(), outcomes[selected], best, outcomes[selected] - best]
            writer.writerow([basin, quarter_label(origin), publication_dates[quarter_label(origin)],
                             *(quarter_label(target) for target in targets),
                             selected, *(round(value, 5) for value in results)])
