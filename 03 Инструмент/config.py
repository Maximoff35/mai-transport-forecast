"""Load and validate the shared scenario inputs without importing calculation modules."""

import json
import math
from datetime import date
from pathlib import Path

INPUTS = Path(__file__).with_name("planning-inputs.json")


def validate_config(config):
    def nonnegative(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0

    def length_two(values):
        return len(values) == 2 and all(nonnegative(x) for x in values)

    horizon = config.get("forecast", {}).get("horizon_quarters", 4)
    if type(horizon) is not int or not 1 <= horizon <= 4:
        raise ValueError("Forecast horizon must be an integer from 1 to 4.")
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


def load_config(path=INPUTS):
    config = json.loads(Path(path).read_text(encoding="utf-8"))
    validate_config(config)
    return config
