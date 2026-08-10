"""Centralized exception handling registered on the Flask app."""
import logging
from marshmallow import ValidationError as MarshmallowValidationError
from sqlalchemy.exc import IntegrityError
from werkzeug.exceptions import HTTPException
from app.extensions import db
from app.utils.exceptions import AppException
from app.utils.response import error_response

error_logger = logging.getLogger("dxstore.errors")


def register_error_handlers(app):
    @app.errorhandler(AppException)
    def handle_app_exception(err):
        error_logger.error("AppException: %s | errors=%s", err.message, err.errors)
        return error_response(err.message, err.status_code, err.errors)

    @app.errorhandler(MarshmallowValidationError)
    def handle_marshmallow_error(err):
        return error_response("Validation failed", 422, err.messages)

    @app.errorhandler(IntegrityError)
    def handle_integrity_error(err):
        db.session.rollback()
        error_logger.error("IntegrityError: %s", str(err.orig))
        return error_response("Database integrity constraint violated", 409)

    @app.errorhandler(HTTPException)
    def handle_http_exception(err):
        return error_response(err.description, err.code)

    @app.errorhandler(Exception)
    def handle_unexpected_error(err):
        # Roll back any half-applied work so the (thread-local) session isn't
        # left dirty for the next request that reuses this connection.
        db.session.rollback()
        error_logger.exception("Unhandled exception: %s", err)
        return error_response("An unexpected error occurred", 500)
