"""Development entrypoint. `python run.py` behaves exactly as before.

The debugger is now tied to FLASK_ENV instead of being hardcoded on: it sat
as `debug=True` right next to `host="0.0.0.0"`, which puts the Werkzeug
interactive debugger on every interface of the plant network. For production
use serve.py, which runs a real WSGI server rather than this one.

Since 24 Oct 2026 (the app went live on the internet) the INTERACTIVE debugger
is never mounted, whatever FLASK_ENV says: development keeps its auto-reload
and debug mode, but /console and the in-browser tracebacks — Python run from a
web page, behind only a PIN — are gone."""
import os

from app import create_app

app = create_app()

if __name__ == "__main__":
    env = os.getenv("FLASK_ENV", "development")
    app.run(
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "5001")),
        debug=(env != "production"),
        use_debugger=False,
        threaded=True,
    )
