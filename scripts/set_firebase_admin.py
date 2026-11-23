import argparse
import getpass
import os
import re

import firebase_admin
from firebase_admin import auth


def main():
    parser = argparse.ArgumentParser(description="Set or revoke a club administrator Firebase claim.")
    parser.add_argument("--revoke", action="store_true", help="Remove administrator access")
    args = parser.parse_args()

    mobile = re.sub(r"\D", "", getpass.getpass("Administrator's 10-digit mobile login: "))
    if not re.fullmatch(r"[6-9]\d{9}", mobile):
        parser.error("mobile must be a valid 10-digit Indian number starting with 6 to 9")

    project_id = os.environ.get("FIREBASE_PROJECT_ID", "").strip()
    if not project_id:
        parser.error("Set FIREBASE_PROJECT_ID before running this command")

    firebase_admin.initialize_app(options={"projectId": project_id})
    user = auth.get_user_by_email(f"{mobile}@members.local")
    claims = dict(user.custom_claims or {})
    if args.revoke:
        claims.pop("admin", None)
    else:
        claims["admin"] = True
    auth.set_custom_user_claims(user.uid, claims)
    action = "Revoked" if args.revoke else "Granted"
    print(f"{action} administrator access for Firebase user {user.uid}.")


if __name__ == "__main__":
    main()
