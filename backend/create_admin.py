"""Create or reset an admin account.

    python create_admin.py

Run it on the machine that holds the database. The password is typed at the
prompt (getpass, so it is not echoed and never lands in shell history), and
only its hash is stored — the plain value is never written anywhere.
"""
import getpass
import sys

from run import app
from app.models.user import User
from app.repositories.user_repository import UserRepository


def prompt_password():
    for _ in range(3):
        first = getpass.getpass("Password: ")
        if len(first) < 8:
            print("  Too short — use at least 8 characters.")
            continue
        if first != getpass.getpass("Confirm password: "):
            print("  The two entries did not match.")
            continue
        return first
    raise SystemExit("Giving up after 3 attempts.")


def main():
    username = input("Admin username [admin]: ").strip() or "admin"
    full_name = input("Full name (optional): ").strip() or None

    with app.app_context():
        repo = UserRepository()
        existing = repo.get_by_username(username)
        if existing:
            answer = input(f"'{username}' already exists — reset its password? [y/N]: ").strip().lower()
            if answer != "y":
                raise SystemExit("Nothing changed.")

        password = prompt_password()

        if existing:
            existing.set_password(password)
            repo.update(existing, role="ADMIN", is_active=True,
                        full_name=full_name or existing.full_name)
            print(f"\nPassword reset for '{username}'.")
        else:
            user = User(username=username, full_name=full_name, role="ADMIN", is_active=True)
            user.set_password(password)
            repo.save(user)
            print(f"\nAdmin '{username}' created.")

        print("Sign in at the app's URL with this username and password.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("\nCancelled.")
