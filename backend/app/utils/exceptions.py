"""Custom exception hierarchy for centralized, predictable error handling."""


class AppException(Exception):
    status_code = 500
    message = "Internal server error"

    def __init__(self, message=None, status_code=None, errors=None):
        super().__init__(message or self.message)
        if message:
            self.message = message
        if status_code:
            self.status_code = status_code
        self.errors = errors


class ValidationError(AppException):
    status_code = 422
    message = "Validation failed"


class NotFoundError(AppException):
    status_code = 404
    message = "Resource not found"


class ConflictError(AppException):
    status_code = 409
    message = "Resource conflict"


class BadRequestError(AppException):
    status_code = 400
    message = "Bad request"
