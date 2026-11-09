"""Run the operating scenarios for upgrades 10–19."""

import json
import math
from datetime import date, timedelta
from itertools import product

from checks import HERE, export, quarter_start
from forecast import DATA, FIELDS, forecast, quarter_label, read_history


INPUTS = HERE / "planning-inputs.json"


def validate_config(config):
    def nonnegative(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0

    def length_two(values):
        return len(values) == 2 and all(nonnegative(x) for x in values)

    common = config["basin_demo"]
    if (not all(nonnegative(common[key]) for key in ("capacity_Mt_per_quarter", "repair_loss_Mt", "reserve_Mt"))
            or common["capacity_Mt_per_quarter"] <= 0 or common["repair_loss_Mt"] > common["capacity_Mt_per_quarter"]):
        raise ValueError("Use positive capacity and nonnegative losses and reserve within capacity.")
    if not isinstance(common["allow_move"], bool):
        raise ValueError("allow_move must be true or false.")
    scenarios = config["stress"]
    if len({row["scenario"] for row in scenarios}) != len(scenarios):
        raise ValueError("Stress scenario names must be unique.")
    if any(not length_two(row["load_factor"]) or not length_two(row["capacity_factor"]) for row in scenarios):
        raise ValueError("Each stress needs two finite nonnegative load and capacity factors.")
    date.fromisoformat(config["as_of"])
    if any(type(days) is not int or days < 0 for days in config["calendar"].values()):
        raise ValueError("Lead times must be nonnegative whole calendar days.")
    cargo, terminal = config["cargo"], config["terminal"]
    values = [*cargo.values(), terminal["load_Mt_per_quarter"], terminal["capacity_boost_Mt"],
              *terminal["capacity_Mt_per_quarter"].values()]
    if not all(map(nonnegative, values)) or any(terminal[key] <= 0 for key in ("tonnes_per_shift", "tonnes_per_train")):
        raise ValueError("Use nonnegative loads and capacities and positive resource throughput.")
    jobs = config["maintenance"]["jobs"]
    capacity = config["maintenance"]["quarter_capacity_Mt"]
    if (len(capacity) != 4 or not all(map(nonnegative, capacity))
            or type(config["maintenance"]["max_concurrent_jobs"]) is not int
            or config["maintenance"]["max_concurrent_jobs"] < 1):
        raise ValueError("Provide four capacities and a positive integer maintenance concurrency limit.")
    if len({job["id"] for job in jobs}) != len(jobs):
        raise ValueError("Maintenance job identifiers must be unique.")
    for job in jobs:
        starts = job["allowed_start_quarters"]
        duration = job["duration_quarters"]
        if (type(duration) is not int or duration not in range(1, 5) or not starts
                or any(type(q) is not int or not 1 <= q <= 5 - duration for q in starts)
                or not nonnegative(job["loss_Mt_per_quarter"])):
            raise ValueError("Use valid maintenance windows, integer durations and nonnegative losses.")
    lug = config["lugaport"]
    if (not 0 <= lug["compatible_share"] <= 1 or not all(0 <= x <= 1 for x in lug["ramp_after_opening"])
            or not lug["ramp_after_opening"] or len(lug["hypothetical_node_load_Mt"]) != 4
            or not all(map(nonnegative, lug["hypothetical_node_load_Mt"]))
            or not nonnegative(lug["annual_nameplate_Mt"]) or not nonnegative(lug["base_node_capacity_Mt_per_quarter"])
            or any(type(lug[key]) is not int or lug[key] not in range(1, 5)
                   for key in ("assumed_open_quarter", "assumed_delayed_quarter"))):
        raise ValueError("Use finite infrastructure values, a four-quarter profile and ramp/share within 0–1.")


def gaps(loads, capacity):
    return [max(load - limit, 0) for load, limit in zip(loads, capacity, strict=True)]


def plans_for(capacities, loss, reserve, reserve_slot, allow_move):
    q1, q2 = capacities
    plans = {"base": [q1, max(q2 - loss, 0)]}
    extra = plans["base"].copy()
    extra[reserve_slot] += reserve
    plans["reserve"] = extra
    if allow_move:
        plans["move"] = [max(q1 - loss, 0), q2]
    return plans


def reference_loads():
    two, four = {}, {}
    for basin in FIELDS:
        history = read_history(DATA, basin)
        last = max(history)
        if quarter_label(last) != "2026-Q2":
            raise ValueError("These 2027 scenarios require the archived 2026-Q2 snapshot.")
        two[basin] = [forecast(history, last, target, "previous_year") for target in (last + 3, last + 4)]
        # For the four-quarter scenario reuse the most recent observed value for
        # each season. Q3–Q4 2027 extend beyond the backtested forecast horizon.
        four[basin] = two[basin] + [history[last - 3], history[last - 2]]
    return two, four


def stress_results(config, seasonal):
    common = config["basin_demo"]
    capacity = common["capacity_Mt_per_quarter"]
    loss = common["repair_loss_Mt"]
    reserve = common["reserve_Mt"]
    move = common["allow_move"]
    table, ranked, hybrid, slots = [], [], [], {}
    scenarios = config["stress"]
    if not scenarios or scenarios[0]["scenario"] != "reference":
        raise ValueError("The reference scenario must be the first stress scenario.")
    for basin, load in seasonal.items():
        peak = max(range(2), key=lambda i: load[i] - (capacity - loss * (i == 1)))
        slots[basin] = peak
        outcomes = {}
        for scenario in scenarios:
            demand = [x * f for x, f in zip(load, scenario["load_factor"], strict=True)]
            limits = [capacity * f for f in scenario["capacity_factor"]]
            plans = plans_for(limits, loss, reserve, peak, move)
            current = {key: sum(gaps(demand, plan)) for key, plan in plans.items()}
            outcomes[scenario["scenario"]] = current
            for key, plan in plans.items():
                table.append([basin, scenario["scenario"], key, peak + 1, *demand, *plan, current[key]])
            if "move" in plans:
                base_need, move_need = gaps(demand, plans["base"]), gaps(demand, plans["move"])
                hybrid.append([basin, scenario["scenario"], *base_need, *move_need, sum(base_need),
                               sum(move_need), sum(base_need) - sum(move_need), reserve,
                               max(sum(move_need) - reserve, 0)])
        base = outcomes["reference"]
        central = min(base, key=base.get)
        worst = {key: max(x[key] for x in outcomes.values()) for key in base}
        robust = min(worst, key=lambda key: (worst[key], base[key]))
        for key in base:
            worst_name = max(outcomes, key=lambda scenario: outcomes[scenario][key])
            ranked.append([basin, key, base[key], worst[key], worst_name, key == central, key == robust,
                           worst[central] - worst[robust], base[robust] - base[central]])
    export("10-asymmetric-stress.csv", ["basin", "scenario", "action", "reserve_slot_fixed",
           "load_Q1_Mt", "load_Q2_Mt", "available_Q1_Mt", "available_Q2_Mt", "gap_Mt"], table)
    export("11-minimax.csv", ["basin", "action", "reference_gap_Mt", "worst_gap_Mt", "worst_scenario",
           "central_choice", "minimax_choice", "minimax_worst_case_improvement_Mt", "minimax_reference_cost_Mt"], ranked)
    export("12-minimum-hybrid-reserve.csv", ["basin", "scenario", "reserve_only_Q1_Mt", "reserve_only_Q2_Mt",
           "after_move_Q1_Mt", "after_move_Q2_Mt", "reserve_only_total_Mt", "hybrid_total_Mt",
           "saving_Mt", "assumed_procurement_limit_Mt", "hybrid_gap_at_limit_Mt"], hybrid)
    return slots


def calendar(config, slots):
    settings = config["calendar"]
    today = date.fromisoformat(config["as_of"])
    rows = []
    seasonal, _ = reference_loads()
    for basin, peak in slots.items():
        actions = [
            ("reserve", f"2027-Q{peak + 1}", settings["reserve_lead_calendar_days"], True),
            ("move", "2027-Q1", settings["repair_move_lead_calendar_days"], config["basin_demo"]["allow_move"]),
        ]
        for action, quarter, lead, feasible in actions:
            start = quarter_start(quarter)
            latest = start - timedelta(days=lead)
            status = "disallowed" if not feasible else "within_window" if today <= latest else "window_passed"
            rows.append([basin, action, today, quarter, start, lead, latest, (latest - today).days, status])
    export("13-decision-calendar.csv", ["basin", "action", "assumed_decision_date", "affected_quarter",
           "quarter_start", "assumed_lead_calendar_days", "latest_decision_date", "days_left", "status"], rows)
    qualified = []
    common = config["basin_demo"]
    for basin, peak in slots.items():
        allowed = {row[1]: row[-1] == "within_window" for row in rows if row[0] == basin}
        plans = plans_for([common["capacity_Mt_per_quarter"]] * 2, common["repair_loss_Mt"],
                          common["reserve_Mt"], peak, allowed["move"])
        if not allowed["reserve"]:
            plans.pop("reserve")
        results = {name: sum(gaps(seasonal[basin], limits)) for name, limits in plans.items()}
        best = min(results.values())
        for name, result in results.items():
            qualified.append([basin, today, name, result, abs(result - best) < 1e-8,
                              allowed["reserve"], allowed["move"]])
    export("13-calendar-qualified-actions.csv", ["basin", "decision_date", "action", "gap_Mt",
           "best_within_calendar", "reserve_available", "move_available"], qualified)


def cargo_segments(config):
    # Two comparable ASOP releases in 2025. No Q2 2026 segment split is inferred.
    sources = [
        "https://www.morport.com/rus/news/gruzooborot-morskih-portov-rossii-za-pervyy-kvartal-2025-goda",
        "https://www.morport.com/rus/news/gruzooborot-morskih-portov-rossii-za-yanvar-iyun-2025-goda",
    ]
    ytd = {"baltic": [(31.7, 36.4), (63.6, 72.2)], "azov": [(25.8, 36.8), (49.9, 73.6)]}
    caps = [config["cargo"]["dry_capacity_Mt_per_quarter"], config["cargo"]["liquid_capacity_Mt_per_quarter"]]
    rows = []
    for basin, (q1, half) in ytd.items():
        q2 = [round(b - a, 1) for a, b in zip(q1, half, strict=True)]
        for i, cargo in enumerate((q1, q2)):
            segmented = gaps(cargo, caps)
            aggregate = max(sum(cargo) - sum(caps), 0)
            rows.append([basin, f"2025-Q{i+1}", *cargo, *caps, *segmented, sum(segmented), aggregate, sources[i]])
    export("14-cargo-compatibility.csv", ["basin", "period", "observed_dry_Mt", "observed_liquid_Mt",
           "assumed_dry_limit_Mt", "assumed_liquid_limit_Mt", "dry_gap_Mt", "liquid_gap_Mt",
           "segmented_gap_Mt", "aggregate_gap_Mt", "source"], rows)


def terminal_resources(config):
    settings = config["terminal"]
    original = settings["capacity_Mt_per_quarter"]
    load, boost = settings["load_Mt_per_quarter"], settings["capacity_boost_Mt"]
    rows = []
    for action, additions in (("base", ()), ("extra_berth", ("berth",)),
                              ("extra_rail", ("rail",)), ("extra_rail_and_yard", ("rail", "yard"))):
        caps = {name: capacity + (boost if name in additions else 0) for name, capacity in original.items()}
        bottleneck = min(caps.values())
        constraints = "/".join(name for name, capacity in caps.items() if capacity == bottleneck)
        rows.append([action, load, caps["berth"], caps["yard"], caps["rail"], constraints, bottleneck,
                     max(load - bottleneck, 0)])
    export("15-terminal-bottleneck.csv", ["action", "assumed_load_Mt", "berth_Mt", "yard_Mt", "rail_Mt",
           "limiting_links", "effective_capacity_Mt", "gap_Mt"], rows)
    conversions = []
    for row in rows:
        tonnes = round(row[-1] * 1_000_000)
        for key, unit in (("tonnes_per_shift", "shift"), ("tonnes_per_train", "train")):
            rate = settings[key]
            conversions.append([row[0], tonnes, unit, rate, math.ceil(tonnes / rate)])
    export("16-resource-conversion.csv", ["scenario", "gap_tonnes", "unit",
           "assumed_tonnes_per_unit", "minimum_units_if_compatible"], conversions)


def backlog(config, seasonal, slots):
    values = config["basin_demo"]
    cap, loss, reserve = [values[k] for k in ("capacity_Mt_per_quarter", "repair_loss_Mt", "reserve_Mt")]
    rows, summary = [], []
    for basin, loads in seasonal.items():
        for name, first_half in plans_for([cap, cap], loss, reserve, slots[basin], values["allow_move"]).items():
            pending = 0
            closing = []
            for i, (load, limit) in enumerate(zip(loads, first_half + [cap, cap], strict=True), 1):
                opening = pending
                available = load + opening
                handled = min(available, limit)
                pending = available - handled
                closing.append(pending)
                rows.append([basin, name, f"2027-Q{i}", load, limit, opening, handled, pending])
            peak = max(closing)
            last_nonempty = max((i for i, value in enumerate(closing, 1) if value > 1e-8), default=0)
            recovery = ("no_backlog" if last_nonempty == 0 else f"2027-Q{last_nonempty + 1}"
                        if last_nonempty < 4 else "not_recovered_within_2027")
            summary.append([basin, name, peak, sum(value > 1e-8 for value in closing), recovery, closing[-1]])
    export("17-backlog-flow.csv", ["basin", "action", "quarter", "reference_arrivals_Mt",
           "available_Mt", "opening_backlog_Mt", "handled_Mt", "closing_backlog_Mt"], rows)
    export("17-backlog-recovery.csv", ["basin", "action", "peak_closing_backlog_Mt",
           "quarters_with_closing_backlog", "recovery_after_last_nonempty_quarter", "year_end_backlog_Mt"], summary)


def maintenance(config, seasonal):
    settings = config["maintenance"]
    jobs = settings["jobs"]
    capacity = settings["quarter_capacity_Mt"]
    baseline = tuple(job["baseline_start_quarter"] for job in jobs)
    schedules = []
    for starts in product(*(job["allowed_start_quarters"] for job in jobs)):
        crew = [0] * 4
        loss = [0] * 4
        for start, job in zip(starts, jobs, strict=True):
            end = start + job["duration_quarters"] - 1
            if not (1 <= start <= end <= 4):
                break
            for i in range(start - 1, end):
                crew[i] += 1
                loss[i] += job["loss_Mt_per_quarter"]
        else:
            if max(crew) <= settings["max_concurrent_jobs"] and all(x <= y for x, y in zip(loss, capacity, strict=True)):
                schedules.append((starts, [x - y for x, y in zip(capacity, loss, strict=True)]))
    if not any(starts == baseline for starts, _ in schedules):
        raise ValueError("Maintenance baseline must be a feasible schedule.")
    rows = []
    for basin, loads in seasonal.items():
        ranked = [(starts, limits, gaps(loads, limits)) for starts, limits in schedules]
        selected = min(ranked, key=lambda row: (round(sum(row[2]), 9), max(row[2]), row[0]))[0]
        for starts, limits, deficits in ranked:
            label = "/".join(f"{job['id']}:Q{q}" for job, q in zip(jobs, starts, strict=True))
            rows.append([basin, label, *limits, sum(deficits), max(deficits),
                         starts == baseline, starts == selected])
    export("18-maintenance-schedules.csv", ["basin", "job_start_quarters", "available_Q1_Mt", "available_Q2_Mt",
           "available_Q3_Mt", "available_Q4_Mt", "annual_gap_Mt", "peak_gap_Mt", "baseline", "selected"], rows)


def infrastructure(config):
    settings = config["lugaport"]
    ramp = settings["ramp_after_opening"]
    quarterly_nameplate = settings["annual_nameplate_Mt"] / 4
    rows = []
    for name, opened in (("assumed_on_time", settings["assumed_open_quarter"]),
                          ("assumed_delayed", settings["assumed_delayed_quarter"])):
        for i, load in enumerate(settings["hypothetical_node_load_Mt"], 1):
            factor = ramp[min(i - opened, len(ramp) - 1)] if i >= opened else 0
            added = quarterly_nameplate * settings["compatible_share"] * factor
            effective = settings["base_node_capacity_Mt_per_quarter"] + added
            rows.append([name, f"2027-Q{i}", opened, settings["annual_nameplate_Mt"], factor, added,
                         load, effective, max(load - effective, 0), settings["nameplate_source"]])
    export("19-lugaport-timing.csv", ["scenario", "quarter", "assumed_open_quarter", "project_annual_nameplate_Mt",
           "assumed_ramp", "modeled_compatible_addition_Mt", "hypothetical_node_load_Mt",
           "modeled_available_Mt", "reserve_needed_Mt", "source_for_annual_nameplate_only"], rows)


def run():
    config = json.loads(INPUTS.read_text(encoding="utf-8"))
    validate_config(config)
    two, four = reference_loads()
    slots = stress_results(config, two)
    calendar(config, slots)
    cargo_segments(config)
    terminal_resources(config)
    backlog(config, four, slots)
    maintenance(config, four)
    infrastructure(config)


if __name__ == "__main__":
    run()
