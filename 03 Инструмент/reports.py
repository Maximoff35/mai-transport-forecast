"""Build the report, artifact manifest and offline evidence viewer."""

import csv
import html
import json
from pathlib import Path
from statistics import mean
from datetime import date

from config import load_config

from checks import HERE


EVIDENCE = HERE / "evidence"


def read(name):
    with (HERE / name).open(encoding="utf-8-sig", newline="") as file:
        return list(csv.DictReader(file))


def number(value):
    return f"{float(value):.2f}".replace(".", ",").rstrip("0").rstrip(",")


def build():
    config = load_config()
    stamp = date.fromisoformat(config["as_of"]).strftime("%d.%m.%Y")
    replay = read("decision-replay.csv")
    calendar = [r for r in read("evidence/13-decision-calendar.csv") if r["basin"] == "baltic"]
    deadlines = {r["action"]: r for r in calendar}
    names = {"base": "исходный план", "reserve": "резерв", "move": "перенос"}
    minimax = [r for r in read("evidence/11-minimax.csv") if r["basin"] == "baltic"]
    central = next(r for r in minimax if r["central_choice"] == "True")
    robust = next(r for r in minimax if r["minimax_choice"] == "True")
    minimax_text = (f"На Балтике минимакс выбирает {names[robust['action']]}. Худшее превышение "
                   f"{number(robust['worst_gap_Mt'])} млн т, изменение центрального результата "
                   f"{number(robust['minimax_reference_cost_Mt'])} млн т. Центральный выбор — {names[central['action']]}.")
    hybrid = [r for r in read("evidence/12-minimum-hybrid-reserve.csv") if r["scenario"] == "reference" and r["basin"] in ("baltic", "azov")]
    hybrid_text = ("; ".join(f"{dict(baltic='Балтика', azov='юг')[r['basin']]}: резерв без переноса {number(r['reserve_only_total_Mt'])}, после переноса {number(r['hybrid_total_Mt'])} млн т" for r in hybrid)
                   if hybrid else "Перенос отключён во входных условиях; гибридный вариант не рассчитывается.")
    cargo = next(r for r in read("evidence/14-cargo-compatibility.csv") if r["basin"] == "baltic" and r["period"] == "2025-Q2")
    terminal = {r["action"]: r for r in read("evidence/15-terminal-bottleneck.csv")}
    resources = [r for r in read("evidence/16-resource-conversion.csv") if r["scenario"] == "base"]
    maintenance = [r for r in read("evidence/18-maintenance-schedules.csv") if r["basin"] == "baltic"]
    old_plan = next(r for r in maintenance if r["baseline"] == "True")
    new_plan = next(r for r in maintenance if r["selected"] == "True")
    transfer = read("evidence/09-geographic-transfer.csv")
    far_mae = next(r["MAE_Mt"] for r in transfer
                   if r["basin"] == "far_east" and r["lead_quarters"] == "4" and r["method"] == "previous_year")
    grid_count = len(read("scenario-grid.csv"))
    replay_summary = []
    for basin, title in (("baltic", "Балтика"), ("azov", "юг"), ("far_east", "Дальний Восток")):
        rows = [r for r in replay if r["basin"] == basin]
        before = mean(float(r["actual_under_base_Mt"]) for r in rows)
        after = mean(float(r["actual_under_selected_Mt"]) for r in rows)
        replay_summary.append(f"{title} {number(before)} → {number(after)} млн т")

    manifest = [
        (1, "Карта смены решения", "Демо.html", "scenario-grid.csv",
         f"Проверены {grid_count} сочетания нагрузки и мощности по трём бассейнам. Каждая ячейка пересчитывается при выборе.",
         "Мощности и резерв задаёт пользователь. Учёт сроков можно явно включить или выключить."),
        (2, "Проверка устойчивости рекомендации", "Демо.html", "scenario-grid.csv",
         "Инструмент проверяет пять точек в диапазоне нагрузки вокруг ввода и сообщает, если предпочтительное действие меняется.",
         "Диапазон имеет смысл стресс-сценария. Вероятности этим точкам не присвоены."),
        (3, "Порог дополнительной цены", "Демо.html", "scenario-grid.csv",
         "Разница превышения между лучшим и следующим доступным действием даёт предельную доплату через ценность тонны снижения превышения.",
         "Расходы и стоимость тонны оценивает оператор. Сравнение в тоннах само по себе не определяет экономическую выгоду."),
        (4, "Ретропроверка выбора действий", "forecast.py", "decision-replay.csv",
         "Среднее превышение на двухквартальное окно. " + ". ".join(replay_summary) + ".",
         "По пять перекрывающихся окон. Оба целевых квартала начинаются после даты публикации входных данных. Мощности условны, действия считаются заранее согласованными."),
        (5, "Допустимость действий", "Демо.html", "evidence/13-calendar-qualified-actions.csv",
         f"Флажок переноса и календарь меняют набор действий. На {stamp} статус переноса: {deadlines['move']['status']}; срок согласования {deadlines['move']['assumed_lead_calendar_days']} дней.",
         "При выключенном календаре сравниваются заранее согласованные варианты."),
        (6, "Записка о сценарии", "Демо.html", "evidence/06-memo-example.txt",
         "Кнопка выгружает текущие вводные, сроки, доступные действия и результат в текстовый файл.",
         "Записка отражает параметры на момент выгрузки."),
        (7, "Аудит выпусков и пересмотров", "checks.py", "evidence/07-release-discrepancies.csv",
         "Проверены даты 18 выпусков. Медианный лаг 13 дней. PDF АСОП подтверждают другой компаратор Балтики за 2023 год 271,3 млн т и уровень юга за I полугодие 2024 года 139,9 млн т.",
         "Основной ряд сохраняет уровни новостных выпусков. Отдельная таблица показывает чувствительность к PDF-компараторам. Причина пересмотров не установлена."),
        (8, "Сверка следующего периода", "holdout.py", "evidence/08-frozen-holdout.csv",
         "Из июльского среза восстановлен прогноз Балтики на III квартал 2026 года 68,1 млн т. Вторичная публикация даёт предварительную сверку 69,2 млн т, отклонение +1,1.",
         "Это ретроспективная реконструкция. Сопоставимый первичный выпуск III квартала не подтверждён. Сверка вынесена за основную оценку точности."),
        (9, "Перенос на третий бассейн", "forecast.py", "evidence/09-geographic-transfer.csv",
         f"Дальневосточный бассейн прошёл тот же расчёт без настройки. MAE сезонного ориентира на горизонте четырёх кварталов {number(far_mae)} млн т.",
         "На каждый метод и горизонт шесть целевых кварталов. Это ограничивает силу вывода."),
        (10, "Несимметричные стрессы", "planning.py", "evidence/10-asymmetric-stress.csv",
         f"Профилей: {len(config['stress'])}, бассейнов: три. Нагрузка и мощность меняются независимо по кварталам.",
         "Квартал резервирования фиксируется до сравнения стрессов. Эти профили заданы как условия."),
        (11, "Выбор по худшему сценарию", "planning.py", "evidence/11-minimax.csv",
         minimax_text,
         "Таблица сравнивает предварительно согласованные действия. Их текущую календарную доступность показывает пункт 13."),
        (12, "Минимальный резерв после переноса", "planning.py", "evidence/12-minimum-hybrid-reserve.csv",
         hybrid_text,
         "Подбирается резерв для каждого заданного сценария с возможностью распределить его по кварталам. Это более гибкая постановка, чем один фиксированный слот H1."),
        (13, "Предельная дата решения", "planning.py", "evidence/13-decision-calendar.csv",
         f"Для Балтики: резерв {deadlines['reserve']['affected_quarter']} — решение до {deadlines['reserve']['latest_decision_date']}; перенос — до {deadlines['move']['latest_decision_date']}. Сроки взяты из входных условий.",
         "Сроки вводные. Второй CSV показывает результат после исключения закрытых действий."),
        (14, "Совместимость мощностей с грузом", "planning.py", "evidence/14-cargo-compatibility.csv",
         f"Балтика, II квартал 2025: превышение при общей мощности {number(cargo['aggregate_gap_Mt'])} млн т, при разделении грузов {number(cargo['segmented_gap_Mt'])} млн т.",
         f"Объёмы грузов опубликованы АСОП. Условные лимиты: сухие {number(config['cargo']['dry_capacity_Mt_per_quarter'])}, наливные {number(config['cargo']['liquid_capacity_Mt_per_quarter'])} млн т."),
        (15, "Ограничивающее звено терминала", "planning.py", "evidence/15-terminal-bottleneck.csv",
         f"Превышение в условном узле: база {number(terminal['base']['gap_Mt'])}, усиление причала {number(terminal['extra_berth']['gap_Mt'])}, железной дороги {number(terminal['extra_rail']['gap_Mt'])}, железной дороги и склада {number(terminal['extra_rail_and_yard']['gap_Mt'])} млн т.",
         "Мощности узла заданы в planning-inputs.json. Реальные терминальные данные нужны от оператора."),
        (16, "Перевод в смены и поезда", "planning.py", "evidence/16-resource-conversion.csv",
         "Ресурсные эквиваленты исходного превышения: " + "; ".join(f"{dict(shift='смены', train='поезда')[r['unit']]}: {r['minimum_units_if_compatible']}" for r in resources) + ".",
         "Нормы заданы в planning-inputs.json. Эквиваленты относятся к совместимому грузу и требуют снятия ограничения в нужном звене."),
        (17, "Накопление объёма и восстановление", "planning.py", "evidence/17-backlog-flow.csv",
         "Модель переносит необработанный объём между кварталами, сохраняет баланс и выдаёт пик, остаток и квартал восстановления.",
         "Фактические заявки и очередь не наблюдались. Годовой поток условно повторяет сезонный профиль, III–IV кварталы 2027 выходят за проверенный горизонт."),
        (18, "Календарь нескольких ремонтов", "planning.py", "evidence/18-maintenance-schedules.csv",
         f"Перебор учитывает окна, длительность и предел одновременных работ {config['maintenance']['max_concurrent_jobs']}. На Балтике превышение: исходный календарь {number(old_plan['annual_gap_Mt'])}, выбранный {number(new_plan['annual_gap_Mt'])} млн т.",
         "Ограничения и годовой поток условны. Результат требует подтверждения доступных окон."),
        (19, "Срок ввода новой инфраструктуры", "planning.py", "evidence/19-lugaport-timing.csv",
         f"Годовая проектная мощность {number(config['lugaport']['annual_nameplate_Mt'])} млн т. Условный квартал ввода {config['lugaport']['assumed_open_quarter']}, при задержке {config['lugaport']['assumed_delayed_quarter']}. Рассчитан требуемый резерв.",
         "Из Росморпорта взята только годовая мощность. График, доля совместимого груза, разгон и нагрузка узла заданы для сценария."),
        (20, "Пилот с критериями перехода", "pilot.py", "evidence/20-pilot-log-template.csv",
         f"Готовы форма журнала и программа оценки. Минимум {config['pilot']['minimum_eligible_weeks']} непрерывных недель; проверяются WAPE, ложные тревоги и пропуски перегрузок.",
         "Пилот предполагается после чемпионата. Учебный CSV имеет маркировку synthetic и сохраняет её в результате. Для расширения отдельно проверяется выполнение заявок в двух группах."),
    ]
    entries = []
    report = [
        "# Результаты двадцати расширений",
        "",
        f"Версия сценарных расчётов на {stamp}. Исторический срез и сохранённые источники остаются прежними. Все двадцать пунктов имеют работающий инструмент, расчёт или воспроизводимый протокол. Операционные параметры заданы в planning-inputs.json. Прогноз опирается на опубликованную перевалку. Сверка III квартала 2026 имеет ограничение по первичному источнику.",
        "",
    ]
    all_tables = {}
    for ident, title, entrypoint, evidence, result, limitation in manifest:
        entry = dict(id=ident, title=title, entrypoint=entrypoint, evidence=evidence, result=result, limitation=limitation,
                     status="реализовано с ограничением источника" if ident == 8 else "реализовано")
        entries.append(entry)
        report += [f"## {ident:02d} {title}", "", result, "", limitation, "",
                   f"[Расчёт или инструмент]({entrypoint}) · [Подтверждающий материал]({evidence})", ""]
        if evidence.endswith(".csv"):
            all_tables[evidence] = read(evidence)
    (HERE / "Результаты 20 расширений.md").write_text("\n".join(report), encoding="utf-8")
    (EVIDENCE / "manifest-20.json").write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # This snapshot permits offline inspection without fetch() permissions.
    tables = dict(all_tables)
    for additional in ("evidence/07-publication-lags.csv", "evidence/07-revision-stress.csv",
                       "evidence/13-calendar-qualified-actions.csv", "evidence/17-backlog-recovery.csv"):
        tables[additional] = read(additional)
    snapshot = json.dumps({"entries": entries, "tables": tables}, ensure_ascii=False).replace("</", r"<\/")
    template = (HERE / "lab-template.html").read_text(encoding="utf-8")
    (HERE / "Лаборатория.html").write_text(template.replace("__EVIDENCE__", snapshot), encoding="utf-8")


if __name__ == "__main__":
    build()
