"""Save immutable copies of the public primary-source releases used in the study."""

import csv
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

from forecast import DATA


HERE = Path(__file__).resolve().parent
SOURCES = HERE / "sources"


def fetch(record):
    name, url = record
    target = SOURCES / name
    try:
        request = Request(url, headers={"User-Agent": "Mozilla/5.0 it-plow-research"})
        with urlopen(request, timeout=20) as response:
            data = response.read()
            final_url = response.url
            content_type = response.headers.get("content-type", "")
        if len(data) < 100:
            raise ValueError("Source response is unexpectedly short.")
        target.write_bytes(data)
        return {"file": name, "url": url, "resolved_url": final_url, "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(), "content_type": content_type,
                "downloaded_utc": datetime.now(timezone.utc).isoformat(), "status": "downloaded"}
    except Exception as error:
        return {"file": name, "url": url, "status": "download_failed", "error": str(error)}


if __name__ == "__main__":
    SOURCES.mkdir(exist_ok=True)
    with DATA.open(encoding="utf-8-sig", newline="") as file:
        releases = list(csv.DictReader(file))
    requests = [(f"asop-{r['quarter']}.html", r["source_url"]) for r in releases]
    requests += [
        ("asop-2024-H1-comparators.pdf", "https://www.morport.com/sites/default/files/inline/files/basseyny_i_napravleniya_0.pdf"),
        ("asop-2024-Y-comparators.pdf", "https://www.morport.com/sites/default/files/inline/files/basseyny_i_napravleniya_1.pdf"),
        ("rosmorport-ustluga-development.html", "https://www.rosmorport.ru/filials/spb_developmentofports/"),
    ]
    with ThreadPoolExecutor(max_workers=4) as pool:
        records = list(pool.map(fetch, requests))
    (SOURCES / "manifest.json").write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"sources": len(records), "downloaded": sum(r["status"] == "downloaded" for r in records),
                      "failed": [r for r in records if r["status"] != "downloaded"]}, ensure_ascii=False, indent=2))
