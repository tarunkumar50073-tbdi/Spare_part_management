"""Production entrypoint — a real WSGI server instead of Flask's development
one.

    set FLASK_ENV=production
    python serve.py

Waitress rather than gunicorn: gunicorn needs fcntl and does not run on
Windows, which is where this is deployed. create_app() already refuses to
start in production without a real SECRET_KEY and an API_KEY, so this cannot
quietly come up on dev credentials.
"""
import os

from app import create_app

app = create_app(os.getenv("FLASK_ENV", "production"))

if __name__ == "__main__":
    try:
        from waitress import serve
    except ImportError:
        raise SystemExit(
            "waitress is not installed — run:  pip install -r requirements.txt\n"
            "(gunicorn will not work here; it has no Windows support.)"
        )

    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "5001"))
    # Threads, not processes: the Live Stock row cache and the ERP-ledger
    # poller are per-process state, so a multi-process server would run one
    # poller per worker and cache the same rows several times over.
    threads = int(os.getenv("WEB_THREADS", "8"))
    print(f"Serving on http://{host}:{port} with {threads} threads (waitress)")
    serve(app, host=host, port=port, threads=threads)
