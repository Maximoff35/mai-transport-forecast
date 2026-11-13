"""Generate offline forecasts, shared demo defaults and comparison evidence."""

import csv
import json
from pathlib import Path

from config import load_config
from forecast import DATA, FIELDS, METHODS, backtest, compare_actions, forecast, quarter_label, read_history


HERE = Path(__file__).resolve().parent
config = load_config()
common = config["basin_demo"]
capacity = common["capacity_Mt_per_quarter"]
loss = common["repair_loss_Mt"]
reserve = common["reserve_Mt"]
allow_move = common["allow_move"]
labels = {"baltic": "Балтийский бассейн", "azov": "Азово-Черноморский бассейн",
          "far_east": "Дальневосточный бассейн"}
with DATA.open(encoding="utf-8-sig", newline="") as source:
    releases = {row["quarter"]: row for row in csv.DictReader(source)}
publication_dates = {period: row["published_on"] for period, row in releases.items()}
payload = {}
with (HERE / "backtest.csv").open("w", newline="", encoding="utf-8-sig") as metrics_file:
    writer = csv.writer(metrics_file)
    writer.writerow(["basin", "lead_quarters", "method", "n", "MAE_Mt", "WAPE_percent", "bias_Mt"])
    for basin in FIELDS:
        history = read_history(DATA, basin)
        first, last = min(history), max(history)
        projections = []
        for lead in range(1, 5):
            target = last + lead
            source_period = quarter_label(target - 4)
            projections.append({
                "period": quarter_label(target), "lead": lead,
                "value": forecast(history, last, target, "previous_year"),
                "source_period": source_period, "source_value": history[target - 4],
                "published_on": publication_dates[source_period],
                "source_url": releases[source_period]["source_url"],
            })
        metrics = []
        for lead in range(1, 5):
            for method in METHODS:
                mae, wape, bias = backtest(history, first + 12, last, lead, method)
                writer.writerow([basin, lead, method, last - first - 11,
                                 *(round(x, 4) for x in (mae, wape, bias))])
                if method == "previous_year":
                    metrics.append({"lead": lead, "n": last - first - 11,
                                    "mae": mae, "wape": wape, "bias": bias})
        payload[basin] = {
            "label": labels[basin], "last": quarter_label(last),
            "published_on": publication_dates[quarter_label(last)],
            "periods": [row["period"] for row in projections[-2:]],
            "loads": [row["value"] for row in projections[-2:]],
            "history": [{"period": quarter_label(q), "value": value,
                         "published_on": publication_dates[quarter_label(q)],
                         "source_url": releases[quarter_label(q)]["source_url"]}
                        for q, value in history.items()],
            "forecasts": projections, "accuracy": metrics,
        }

grid_start = max(round(capacity - 10, 1), loss, 0.1)
settings = {"as_of": config["as_of"], "basin_demo": common, "calendar": config["calendar"],
            "horizon_quarters": config.get("forecast", {}).get("horizon_quarters", 4),
            "grid_capacities": [round(grid_start + 2 * i, 1) for i in range(11)],
            "grid_shifts": list(range(10, -11, -2))}
template = (HERE / "demo-template.html").read_text(encoding="utf-8")
replacements = {
    "__MODEL_DATA__": json.dumps(payload, ensure_ascii=False).replace("</", r"<\/"),
    "__PLANNING_SETTINGS__": json.dumps(settings, ensure_ascii=False).replace("</", r"<\/"),
    "__CAPACITY__": str(capacity), "__REPAIR_LOSS__": str(loss), "__RESERVE__": str(reserve),
    "__AS_OF__": config["as_of"],
    "__RESERVE_LEAD__": str(config["calendar"]["reserve_lead_calendar_days"]),
    "__REPAIR_LEAD__": str(config["calendar"]["repair_move_lead_calendar_days"]),
    "__ALLOW_MOVE__": "checked" if allow_move else "",
}
for marker, value in replacements.items():
    template = template.replace(marker, value)
with (HERE / "Демо.html").open("w", encoding="utf-8", newline="\n") as destination:
    destination.write(template)

with (HERE / "scenario-grid.csv").open("w", newline="", encoding="utf-8-sig") as grid_file:
    writer = csv.writer(grid_file)
    writer.writerow(["basin", "capacity_Mt_per_quarter", "load_change_percent",
                     "base_gap_Mt", "reserve_gap_Mt", "move_gap_Mt", "best_gap_action"])
    for basin, model in payload.items():
        for grid_capacity in settings["grid_capacities"]:
            for shock in reversed(settings["grid_shifts"]):
                loads = {period: value * (1 + shock / 100)
                         for period, value in enumerate(model["loads"], start=1)}
                values = [round(x, 5) for x in compare_actions(loads, grid_capacity, 2, loss, reserve)[:3]]
                available = dict(zip(("base", "reserve", "move"), values))
                if not allow_move:
                    available.pop("move")
                    values[2] = ""
                best = [name for name, value in available.items() if value == min(available.values())]
                writer.writerow([basin, grid_capacity, shock, *values, "/".join(best)])


def over_plan(loads, available):
    return sum(max(load - limit, 0) for load, limit in zip(loads, available, strict=True))


# Historical replay uses the same scenario assumptions, with measures pre-agreed.
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
            base = (capacity, capacity - loss)
            peak = max(range(2), key=lambda i: predicted[i] - base[i])
            plans = {"base": base, "reserve": tuple(cap + reserve * (i == peak) for i, cap in enumerate(base))}
            if allow_move:
                plans["move"] = (capacity - loss, capacity)
            selected = min(plans, key=lambda action: over_plan(predicted, plans[action]))
            outcomes = {action: over_plan(actual, plan) for action, plan in plans.items()}
            best = min(outcomes.values())
            results = [outcomes["base"], outcomes["reserve"], outcomes.get("move", ""),
                       outcomes[selected], best, outcomes[selected] - best]
            writer.writerow([basin, quarter_label(origin), publication_dates[quarter_label(origin)],
                             *(quarter_label(target) for target in targets), selected,
                             *(round(value, 5) if isinstance(value, (int, float)) else value for value in results)])

# Derive a stronger control from the unchanged archived replay: reserve in every
# window. Its quarter placement still uses the forecast, so this is not an
# independent strategy without forecasting. Overlapping windows are not totals
# for a real multi-year operating programme.
with (HERE / "decision-replay.csv").open(encoding="utf-8-sig", newline="") as replay_file:
    replay_rows = list(csv.DictReader(replay_file))
with (HERE / "policy-comparison.csv").open("w", newline="", encoding="utf-8-sig") as control_file:
    writer = csv.writer(control_file)
    writer.writerow(["basin", "windows", "base_mean_gap_Mt", "forecast_choice_mean_gap_Mt",
                     "always_reserve_mean_gap_Mt", "selected_reserve_assignments",
                     "always_reserve_assignments", "reserve_Mt_per_assigned_quarter",
                     "reserve_placement_uses_forecast", "actions_pre_agreed"])
    for basin in FIELDS:
        rows = [row for row in replay_rows if row["basin"] == basin]
        means = [sum(float(row[field]) for row in rows) / len(rows) for field in
                 ("actual_under_base_Mt", "actual_under_selected_Mt", "actual_under_reserve_Mt")]
        writer.writerow([basin, len(rows), *(round(value, 5) for value in means),
                         sum(row["decision"] == "reserve" for row in rows), len(rows),
                         reserve, True, True])
