import getpass
import os
import re

import firebase_admin
from firebase_admin import auth


def main():
    mobile = re.sub(r"\D", "", getpass.getpass("Member's 10-digit mobile login: "))
    if not re.fullmatch(r"[6-9]\d{9}", mobile):
        raise ValueError("Enter a valid 10-digit Indian mobile number starting with 6 to 9.")

    password = getpass.getpass("New password (8-128 characters): ")
    confirmation = getpass.getpass("Confirm new password: ")
    if not 8 <= len(password) <= 128:
        raise ValueError("Password must contain 8 to 128 characters.")
    if password != confirmation:
        raise ValueError("Passwords do not match.")

    project_id = os.environ.get("FIREBASE_PROJECT_ID", "").strip()
    if not project_id:
        raise RuntimeError("Set FIREBASE_PROJECT_ID before running this command.")

    firebase_admin.initialize_app(options={"projectId": project_id})
    user = auth.get_user_by_email(f"{mobile}@members.local")
    auth.update_user(user.uid, password=password)
    print("The member password was updated.")


if __name__ == "__main__":
    main()
