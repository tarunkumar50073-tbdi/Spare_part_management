"""Root-level launcher so the backend can be started as `python app/run.py`
from the repo root, without cd-ing into backend/ first."""
import os
import sys

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND_DIR = os.path.join(ROOT_DIR, "backend")
sys.path.insert(0, BACKEND_DIR)

from app import create_app  # noqa: E402  (backend/app package, resolved via sys.path above)

app = create_app()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001, debug=True)
