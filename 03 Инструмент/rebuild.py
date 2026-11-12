"""Regenerate all calculation artifacts without downloading or publishing anything."""

import subprocess
import sys
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
for name in ("checks.py", "prepare.py", "planning.py", "pilot.py", "reports.py", "verify.py"):
    subprocess.run([sys.executable, str(HERE / name)], check=True)

# Keep the console evidence synchronized with the shared scenario inputs.
outputs = []
env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
for basin in ("baltic", "azov", "far_east"):
    for shock in (0, 5, -5):
        result = subprocess.run([sys.executable, str(HERE / "forecast.py"), "--basin", basin,
                                 "--shock-percent", str(shock), "--horizon", "4"],
                                check=True, capture_output=True, encoding="utf-8", env=env)
        outputs.append(result.stdout.rstrip())
(HERE / "results.txt").write_bytes(("\n\n".join(outputs) + "\n").encode("utf-8"))
