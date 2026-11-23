import os
import tempfile
import uuid
from pathlib import Path
from unittest import TestCase


_test_directory = tempfile.TemporaryDirectory()
os.environ["ENVIRONMENT"] = "development"
os.environ["DATABASE_PATH"] = str(Path(_test_directory.name) / "test.sqlite3")
os.environ["SECRET_KEY"] = "temporary-test-secret-key-not-for-production"

import app as app_module
from app import Member, app, db, generate_password_hash, load_or_create_secret_key, normalized_mobile


class MobileAuthTests(TestCase):
    @classmethod
    def setUpClass(cls):
        app.config["TESTING"] = True

    @classmethod
    def tearDownClass(cls):
        with app.app_context():
            db.session.remove()
            db.engine.dispose()
        _test_directory.cleanup()

    def setUp(self):
        with app.app_context():
            db.session.remove()
            db.drop_all()
            app_module.db_initialized = False
        self.client = app.test_client()

    def test_mobile_requires_ten_digit_indian_number(self):
        self.assertEqual(normalized_mobile("9876543210"), "9876543210")
        for invalid_mobile in ("1234567890", "5123456789", "987654321", "919876543210"):
            self.assertIsNone(normalized_mobile(invalid_mobile))
            response = self.client.post(
                "/api/auth/register",
                json={
                    "mobile": invalid_mobile,
                    "password": "test-password-123",
                    "displayName": "Invalid Number",
                },
            )
            self.assertEqual(response.status_code, 400)

    def test_legacy_country_prefixed_account_can_login_without_duplicate_signup(self):
        self.client.get("/api/health")
        mobile = "9123456789"
        with app.app_context():
            db.session.add(
                Member(
                    id=uuid.uuid4(),
                    email=f"91{mobile}@members.local",
                    mobile_number=f"91{mobile}",
                    password_hash=generate_password_hash("legacy-password-123"),
                    display_name="Legacy Member",
                )
            )
            db.session.commit()

        login = self.client.post(
            "/api/auth/login",
            json={"mobile": mobile, "password": "legacy-password-123"},
        )
        self.assertEqual(login.status_code, 200)

        duplicate_signup = self.client.post(
            "/api/auth/register",
            json={
                "mobile": mobile,
                "password": "another-password-123",
                "displayName": "Duplicate Member",
            },
        )
        self.assertEqual(duplicate_signup.status_code, 409)
        self.assertIn("Choose Login", duplicate_signup.get_json()["error"])

    def test_registration_keeps_member_signed_in_after_browser_restart(self):
        response = self.client.post(
            "/api/auth/register",
            json={
                "mobile": "9876543210",
                "password": "test-password-123",
                "displayName": "New Member",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("Expires=", response.headers.get("Set-Cookie", ""))

        session_cookie = self.client.get_cookie("pwc_session")
        restored_client = app.test_client()
        restored_client.set_cookie("pwc_session", session_cookie.value)
        self.assertEqual(restored_client.get("/api/auth/me").status_code, 200)

    def test_development_secret_key_is_stable_across_restarts(self):
        secret_key_path = Path(_test_directory.name) / "development.secret_key"

        first_secret_key = load_or_create_secret_key(secret_key_path)
        restarted_secret_key = load_or_create_secret_key(secret_key_path)
        self.assertEqual(restarted_secret_key, first_secret_key)
        self.assertGreaterEqual(len(first_secret_key), 32)
