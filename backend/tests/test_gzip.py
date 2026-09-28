"""The gzip after_request: large JSON/text is compressed, small bodies and
streams are left alone, and a client that didn't ask for gzip gets plain bytes."""
import gzip
import json

from flask import Flask, Response, jsonify

from app import _register_gzip


def _app():
    app = Flask(__name__)
    _register_gzip(app)

    @app.route("/big")
    def big():
        return jsonify({"rows": [{"k": i, "name": "x" * 60} for i in range(300)]})

    @app.route("/small")
    def small():
        return jsonify({"ok": True})

    @app.route("/stream")
    def stream():
        return Response((f"data: {i}\n\n" for i in range(5)), mimetype="text/event-stream")

    return app.test_client()


def test_big_json_is_gzipped_and_round_trips():
    r = _app().get("/big", headers={"Accept-Encoding": "gzip"})
    assert r.headers.get("Content-Encoding") == "gzip"
    assert "accept-encoding" in r.headers.get("Vary", "").lower()
    body = json.loads(gzip.decompress(r.data))
    assert body["rows"][0]["name"] == "x" * 60 and len(body["rows"]) == 300
    assert int(r.headers["Content-Length"]) == len(r.data)


def test_small_body_is_not_gzipped():
    r = _app().get("/small", headers={"Accept-Encoding": "gzip"})
    assert "Content-Encoding" not in r.headers
    assert json.loads(r.data)["ok"] is True


def test_no_accept_encoding_stays_plain():
    r = _app().get("/big")  # no Accept-Encoding header
    assert "Content-Encoding" not in r.headers
    assert len(json.loads(r.data)["rows"]) == 300


def test_event_stream_is_never_gzipped():
    r = _app().get("/stream", headers={"Accept-Encoding": "gzip"})
    assert "Content-Encoding" not in r.headers
