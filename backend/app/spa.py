"""Serves the built React app from the same process as the API.

In development the Vite dev server owns the browser and proxies /api here,
so this does nothing (there is no build to serve). Once deployed there is no
Vite: Flask hands out frontend/dist itself, which means one process, one
port, and no CORS at all — the browser is talking to the same origin it
loaded from. It also means the deployment has a single thing to keep alive
rather than a Python process and a Node process that have to agree on a
proxy target.
"""
import os

from flask import abort, send_from_directory

# Anything under these belongs to the API or the health probe and must never
# be answered with index.html, or a mistyped endpoint would return an HTML
# page with status 200 and the caller would parse it as JSON.
_API_PREFIXES = ("api/",)


def _dist_dir():
    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    project_root = os.path.dirname(backend_dir)
    return os.path.join(project_root, "frontend", "dist")


def register_spa(app):
    """Mount the built frontend at / when a build exists."""
    dist = _dist_dir()
    index = os.path.join(dist, "index.html")
    app.config["SPA_DIST_DIR"] = dist

    if not os.path.isfile(index):
        # No build yet — dev runs through Vite, so this is the normal case
        # locally. Deployments must run `npm run build` first.
        app.logger.info("No frontend build at %s; serving API only.", dist)
        return

    @app.route("/", defaults={"path": ""})
    @app.route("/<path:path>")
    def serve_spa(path):
        # A real API route is registered ahead of this catch-all and wins, so
        # anything under /api/ arriving here is an endpoint that does not
        # exist. It has to 404 as JSON: answering it with index.html would
        # hand the caller an HTML page with status 200 to parse as JSON.
        if path.startswith(_API_PREFIXES):
            abort(404)

        # Real files (JS bundles, CSS, the logo) are served as-is; every other
        # path is a client-side route like /short-parts, which only React
        # Router knows about, so it gets index.html and resolves in the
        # browser. Without this a refresh on any inner page 404s.
        if path:
            candidate = os.path.join(dist, path)
            if os.path.isfile(candidate):
                resp = send_from_directory(dist, path)
                # Vite fingerprints its bundles (index-<hash>.js / .css), so the
                # content behind a given URL never changes — cache them hard.
                if path.startswith("assets/"):
                    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
                return resp
        # index.html points at the CURRENT bundle hashes, so it must NEVER be
        # cached — otherwise the browser keeps loading an old build after a new
        # `npm run build` and the UI looks stale until a manual hard-refresh.
        resp = send_from_directory(dist, "index.html")
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        return resp
