"""Login rate limiting (security hardening).

conftest turns the limiter OFF for the suite (tests log in many times a
second); these cases flip it back on locally to prove it throttles.
"""
import pytest

from app.utils import rate_limit


@pytest.fixture()
def client(app):
    return app.test_client()


@pytest.fixture()
def limiter_on(app):
    app.config["RATE_LIMIT_ENABLED"] = True
    rate_limit.reset()
    yield
    app.config["RATE_LIMIT_ENABLED"] = False
    rate_limit.reset()


def test_login_throttled_after_max_attempts(client, app, limiter_on):
    limit = app.config["LOGIN_RATE_MAX"]
    body = {"username": "nobody", "password": "wrong"}
    statuses = [client.post("/api/v1/auth/login", json=body).status_code for _ in range(limit + 3)]
    # The first `limit` attempts are let through (bad creds → not 429); once the
    # window is exceeded the endpoint returns 429 before ever checking creds.
    assert 429 in statuses, "login endpoint was never rate-limited"
    assert statuses[:limit].count(429) == 0, "throttled before reaching the limit"


def test_login_not_throttled_when_disabled(client, app):
    app.config["RATE_LIMIT_ENABLED"] = False
    rate_limit.reset()
    codes = {
        client.post("/api/v1/auth/login", json={"username": "nobody", "password": "wrong"}).status_code
        for _ in range(app.config["LOGIN_RATE_MAX"] + 5)
    }
    assert 429 not in codes
