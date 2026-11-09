"""Regenerate all calculation artifacts without downloading or publishing anything."""

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
for name in ("checks.py", "prepare.py", "planning.py", "pilot.py", "reports.py", "verify.py"):
    subprocess.run([sys.executable, str(HERE / name)], check=True)
