"""Build auditable evidence for upgrades 07–09."""

import csv
from calendar import monthrange
from datetime import date
from pathlib import Path
from statistics import median

from forecast import DATA, FIELDS, METHODS, backtest, forecast, quarter_index, quarter_label, read_history


HERE = Path(__file__).resolve().parent
EVIDENCE = HERE / "evidence"


def export(name, headings, rows):
    EVIDENCE.mkdir(exist_ok=True)
    with (EVIDENCE / name).open("w", newline="", encoding="utf-8-sig") as destination:
        writer = csv.writer(destination)
        writer.writerow(headings)
        for row in rows:
            writer.writerow(round(x, 5) if isinstance(x, float) else x for x in row)


def quarter_start(label):
    year, quarter = label.split("-Q")
    return date(int(year), 3 * (int(quarter) - 1) + 1, 1)


def quarter_end(label):
    start = quarter_start(label)
    last_month = start.month + 2
    return date(start.year, last_month, monthrange(start.year, last_month)[1])


def audit():
    with DATA.open(encoding="utf-8-sig", newline="") as source:
        releases = list(csv.DictReader(source))
    lag_rows = []
    issues = {}
    for release in releases:
        period = release["quarter"]
        end = quarter_end(period)
        published = date.fromisoformat(release["published_on"])
        assert published > end and published <= date(2026, 11, 9), release
        issues[quarter_index(period)] = published
        lag_rows.append([period, end, published, (published - end).days, release["source_url"]])
    assert list(issues.values()) == sorted(set(issues.values()))
    export("07-publication-lags.csv", ["quarter", "quarter_end", "asop_publication", "lag_days", "source"], lag_rows)

    by_quarter = {row["quarter"]: row for row in releases}
    discrepancies = [
        ("baltic", "2023-Q4", "2024-Q4", 0.6, 271.3,
         "https://www.morport.com/sites/default/files/inline/files/basseyny_i_napravleniya_1.pdf"),
        ("baltic", "2023-Q2", "2024-Q2", 1.3, 138.5,
         "https://www.morport.com/sites/default/files/inline/files/basseyny_i_napravleniya_0.pdf"),
        ("azov", "2024-Q2", "2025-Q2", -11.9, None, ""),
        ("azov", "2024-Q2", "2024-Q2", None, 139.9,
         "https://www.morport.com/sites/default/files/inline/files/basseyny_i_napravleniya_0.pdf"),
    ]
    alternatives = {key: {r["quarter"]: float(r[column]) for r in releases} for key, column in FIELDS.items()}
    discrepancy_rows = []
    for basin, old, new, published_yoy, comparator, comparator_source in discrepancies:
        old_value = alternatives[basin][old]
        new_value = alternatives[basin][new]
        implied = round(new_value / (1 + published_yoy / 100), 1) if published_yoy is not None else ""
        discrepancy_rows.append([basin, old, new, old_value, new_value, (new_value / old_value - 1) * 100,
                                 published_yoy if published_yoy is not None else "", implied, comparator or "",
                                 comparator_source, by_quarter[old]["source_url"], by_quarter[new]["source_url"]])
        if comparator is not None:
            alternatives[basin][old] = comparator
    export("07-release-discrepancies.csv", ["basin", "old_release", "new_release", "old_published_ytd_Mt",
           "new_published_ytd_Mt", "derived_yoy_percent", "reported_yoy_percent", "implied_old_ytd_Mt",
           "verified_pdf_comparator_Mt", "comparator_pdf_source", "old_source", "new_source"], discrepancy_rows)

    sensitivity = []
    for basin in FIELDS:
        history = read_history(DATA, basin)
        first, last = min(history), max(history)
        alternative = {}
        prior = 0
        for label, total in alternatives[basin].items():
            index = quarter_index(label)
            if index % 4 == 0:
                prior = 0
            assert total > prior
            alternative[index] = round(total - prior, 1)
            prior = total
        for lead in range(1, 5):
            for method in METHODS:
                mae, *_ = backtest(history, first + 12, last, lead, method)
                shifted, *_ = backtest(alternative, first + 12, last, lead, method)
                sensitivity.append([basin, lead, method, mae, shifted, shifted - mae])
        for target in (last + 3, last + 4):
            assert forecast(history, last, target, "previous_year") == forecast(alternative, last, target, "previous_year")
    export("07-revision-stress.csv", ["basin", "lead_quarters", "method", "published_MAE_Mt",
                                    "pdf_comparator_stress_MAE_Mt", "delta_Mt"], sensitivity)
    return issues, median(row[3] for row in lag_rows)


def holdout(issues):
    origin = quarter_index("2026-Q2")
    target = quarter_index("2026-Q3")
    rows = []
    for basin in FIELDS:
        history = read_history(DATA, basin)
        prediction = forecast(history, origin, target, "previous_year")
        if basin == "baltic":
            cumulative = 199.5
            previous_cumulative = history[origin] + history[origin - 1]
            proxy = cumulative - previous_cumulative
            rows.append([basin, issues[origin], "2026-Q3", prediction, cumulative, previous_cumulative, proxy,
                         proxy - prediction, "retrospective_secondary_cross_check_scope_unconfirmed",
                         "https://mercora.ru/news/rossiyskiy-konteynernyy-rynok-za-9-mesyatsev-2026-10-15",
                         "https://47news.ru/articles/294272/"])
        else:
            rows.append([basin, issues[origin], "2026-Q3", prediction, "", "", "", "",
                         "comparable_public_value_not_verified", "", ""])
    export("08-frozen-holdout.csv", ["basin", "frozen_from_publication_date", "target", "seasonal_prediction_Mt",
           "secondary_ytd_Mt", "primary_prior_ytd_Mt", "provisional_quarter_Mt", "provisional_actual_minus_prediction_Mt",
           "evidence_status", "source_a", "source_b"], rows)


def transfer_test():
    rows = []
    for basin in FIELDS:
        history = read_history(DATA, basin)
        first, last = min(history), max(history)
        for horizon in (1, 4):
            for method in METHODS:
                mae, wape, bias = backtest(history, first + 12, last, horizon, method)
                rows.append([basin, "transfer_without_refit" if basin == "far_east" else "reference",
                             horizon, method, last - first - 11, mae, wape, bias])
    export("09-geographic-transfer.csv", ["basin", "evaluation_role", "lead_quarters", "method",
           "n", "MAE_Mt", "WAPE_percent", "bias_Mt"], rows)
    return next(row[5] for row in rows if row[:4] == ["far_east", "transfer_without_refit", 4, "previous_year"])


def run():
    issues, publication_lag = audit()
    holdout(issues)
    transfer_mae = transfer_test()
    return {"median_publication_lag_days": publication_lag, "far_east_seasonal_mae_Mt": transfer_mae}


if __name__ == "__main__":
    print(run())
