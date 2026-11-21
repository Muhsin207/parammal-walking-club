import hashlib
import os
import re
import secrets
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, render_template_string, request, send_from_directory, session
from flask_mail import Mail, Message
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import JSON, Uuid, event, text
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from werkzeug.security import check_password_hash, generate_password_hash


ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

environment = os.environ.get("ENVIRONMENT", "development").lower()
configured_database_path = os.environ.get("DATABASE_PATH", "").strip()
if environment == "production" and not configured_database_path:
    raise RuntimeError("Set DATABASE_PATH to a persistent SQLite file path in production.")
database_path = Path(configured_database_path).expanduser() if configured_database_path else ROOT / "data" / "parammal_walking_club.sqlite3"
if environment == "production" and not database_path.is_absolute():
    raise RuntimeError("Set DATABASE_PATH to an absolute path on the production persistent disk.")
if not database_path.is_absolute():
    database_path = ROOT / database_path
database_path = database_path.resolve()
database_path.parent.mkdir(parents=True, exist_ok=True)

secret_key = os.environ.get("SECRET_KEY", "").strip()
if environment == "production" and len(secret_key) < 32:
    raise RuntimeError("Set SECRET_KEY to a random value of at least 32 characters in production.")
if not secret_key:
    secret_key = secrets.token_urlsafe(48)

app = Flask(__name__)
app.config.update(
    SECRET_KEY=secret_key,
    SQLALCHEMY_DATABASE_URI=f"sqlite:///{database_path.as_posix()}",
    SQLALCHEMY_TRACK_MODIFICATIONS=False,
    SQLALCHEMY_ENGINE_OPTIONS={"connect_args": {"check_same_thread": False}},
    SESSION_COOKIE_NAME="pwc_session",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=environment == "production",
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    MAIL_SERVER=os.environ.get("MAIL_SERVER") or None,
    MAIL_PORT=int(os.environ.get("MAIL_PORT", "587")),
    MAIL_USE_TLS=os.environ.get("MAIL_USE_TLS", "true").lower() == "true",
    MAIL_USE_SSL=os.environ.get("MAIL_USE_SSL", "false").lower() == "true",
    MAIL_USERNAME=os.environ.get("MAIL_USERNAME") or None,
    MAIL_PASSWORD=os.environ.get("MAIL_PASSWORD") or None,
    MAIL_DEFAULT_SENDER=os.environ.get("MAIL_DEFAULT_SENDER") or None,
)

app_base_url = (
    os.environ.get("APP_BASE_URL")
    or os.environ.get("RENDER_EXTERNAL_URL")
    or "http://127.0.0.1:5000"
).rstrip("/")
parsed_app_base_url = urlsplit(app_base_url)
if environment == "production":
    if (
        parsed_app_base_url.scheme != "https"
        or not parsed_app_base_url.netloc
        or parsed_app_base_url.path not in {"", "/"}
        or parsed_app_base_url.query
        or parsed_app_base_url.fragment
    ):
        raise RuntimeError("Set APP_BASE_URL to the public HTTPS origin in production.")
    if not app.config["MAIL_SERVER"] or not (app.config["MAIL_DEFAULT_SENDER"] or app.config["MAIL_USERNAME"]):
        raise RuntimeError("Configure MAIL_SERVER and MAIL_DEFAULT_SENDER (or MAIL_USERNAME) in production.")
db = SQLAlchemy(app)
mail = Mail(app)
db_initialized = False
db_init_lock = threading.Lock()
magic_link_max_age = timedelta(minutes=15)
magic_link_rate_window = timedelta(minutes=15)
magic_link_max_requests = 3


def enable_sqlite_foreign_keys(connection, _record):
    connection.execute("PRAGMA foreign_keys=ON")


with app.app_context():
    event.listen(db.engine, "connect", enable_sqlite_foreign_keys)


class Member(db.Model):
    __tablename__ = "members"

    id = db.Column(Uuid(as_uuid=True), primary_key=True)
    email = db.Column(db.String(320), nullable=True, unique=True)
    mobile_number = db.Column(db.String(15), nullable=True, unique=True)
    password_hash = db.Column(db.String(255), nullable=True)
    display_name = db.Column(db.String(80), nullable=False)
    is_admin = db.Column(db.Boolean, nullable=False, default=False)
    monthly_goal_km = db.Column(db.Numeric(6, 2), nullable=False, default=30)
    session_version = db.Column(db.Integer, nullable=False, default=0)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))


class MagicLinkToken(db.Model):
    __tablename__ = "magic_link_tokens"

    id = db.Column(Uuid(as_uuid=True), primary_key=True)
    member_id = db.Column(Uuid(as_uuid=True), db.ForeignKey("members.id", ondelete="CASCADE"), nullable=False)
    token_hash = db.Column(db.String(64), nullable=False, unique=True)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))
    expires_at = db.Column(db.DateTime(timezone=True), nullable=False)
    used_at = db.Column(db.DateTime(timezone=True))


class WalkLog(db.Model):
    __tablename__ = "walk_logs"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    member_id = db.Column(Uuid(as_uuid=True), db.ForeignKey("members.id", ondelete="CASCADE"), nullable=False)
    route = db.Column(db.String(120), nullable=False)
    distance_km = db.Column(db.Numeric(6, 2), nullable=False)
    duration_minutes = db.Column(db.Integer, nullable=False)
    walk_date = db.Column(db.Date, nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))
    member = db.relationship(Member)


class SiteContent(db.Model):
    __tablename__ = "site_content"

    id = db.Column(db.String(20), primary_key=True)
    content = db.Column(JSON, nullable=False, default=dict)
    updated_at = db.Column(db.DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))


DEFAULT_ANNOUNCEMENT_CONTENT = {
    "enabled": True,
    "titleEn": "",
    "titleMl": "",
    "msgEn": "",
    "msgMl": "ചെറിയ ചുവടുകൾ, വലിയ മാറ്റങ്ങൾ.",
    "primaryLabel": "Learn More",
    "linkUrl": "",
}


def initialize_database():
    global db_initialized
    if db_initialized:
        return
    with db_init_lock:
        if db_initialized:
            return
        db.create_all()
        member_columns = {
            row[1] for row in db.session.execute(text("PRAGMA table_info(members)")).all()
        }
        if "mobile_number" not in member_columns:
            db.session.execute(text("ALTER TABLE members ADD COLUMN mobile_number VARCHAR(15)"))
        if "password_hash" not in member_columns:
            db.session.execute(text("ALTER TABLE members ADD COLUMN password_hash VARCHAR(255)"))
        db.session.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS ix_members_mobile_number "
            "ON members(mobile_number) WHERE mobile_number IS NOT NULL"
        ))
        db.session.execute(
            sqlite_insert(SiteContent)
            .values(
                id="main",
                content={
                    "bannerMode": "auto",
                    "slides": [],
                    "announcement": dict(DEFAULT_ANNOUNCEMENT_CONTENT),
                },
            )
            .on_conflict_do_nothing(index_elements=["id"])
        )
        site_content = db.session.get(SiteContent, "main")
        if site_content is not None and site_content.content.get("announcement") == {"enabled": False}:
            site_content.content = {
                **site_content.content,
                "announcement": dict(DEFAULT_ANNOUNCEMENT_CONTENT),
            }
        db.session.commit()
        db_initialized = True


@app.before_request
def ensure_database():
    initialize_database()


def api_error(message, status):
    return jsonify({"error": message}), status


def member_from_session():
    member_id = session.get("member_id")
    session_version = session.get("session_version")
    if not member_id or session_version is None:
        return None
    try:
        member = db.session.get(Member, uuid.UUID(member_id))
    except ValueError:
        session.clear()
        return None
    if member is None or member.session_version != session_version:
        session.clear()
        return None
    return member


def require_member():
    member = member_from_session()
    if member is None:
        return None, api_error("Sign in is required.", 401)
    return member, None


def require_admin():
    member, error = require_member()
    if error:
        return None, error
    if not member.is_admin:
        return None, api_error("Administrator access is required.", 403)
    return member, None


def normalized_email(value):
    email = str(value or "").strip().lower()
    if len(email) > 320 or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return None
    return email


def normalized_mobile(value):
    mobile = re.sub(r"\D", "", str(value or "").strip())
    if not re.fullmatch(r"[6-9][0-9]{9}", mobile):
        return None
    return mobile


def mobile_lookup_values(mobile):
    return (mobile, f"0{mobile}", f"91{mobile}", f"0091{mobile}")


def valid_http_url(value):
    parsed = urlsplit(str(value or "").strip())
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def send_magic_link(email, link):
    if not app.config["MAIL_SERVER"]:
        if environment == "production":
            raise RuntimeError("Production email is not configured. Set SMTP settings before sending sign-in links.")
        app.logger.warning("Development magic link for %s: %s", email, link)
        return

    sender = app.config["MAIL_DEFAULT_SENDER"] or app.config["MAIL_USERNAME"]
    if not sender:
        raise RuntimeError("Set MAIL_DEFAULT_SENDER or MAIL_USERNAME for outgoing email.")
    message = Message(
        subject="Your Parammal Walking Club sign-in link",
        sender=sender,
        recipients=[email],
        body=(
            "Use this one-time link to sign in to Parammal Walking Club:\n\n"
            f"{link}\n\n"
            "The link expires in 15 minutes. If you did not request it, you can ignore this email."
        ),
    )
    mail.send(message)


def member_json(member):
    return {
        "id": str(member.id),
        "name": member.display_name,
        "isAdmin": member.is_admin,
        "monthlyGoal": float(member.monthly_goal_km),
    }


@app.get("/")
def home():
    return send_from_directory(ROOT, "index.html")


@app.get("/service-worker.js")
def service_worker():
    response = send_from_directory(ROOT / "static", "service-worker.js", mimetype="application/javascript")
    response.headers["Service-Worker-Allowed"] = "/"
    return response


@app.get("/api/health")
def health():
    db.session.execute(text("SELECT 1"))
    return jsonify({"status": "ok"})


@app.post("/api/auth/register")
def register_member():
    payload = request.get_json(silent=True) or {}
    mobile = normalized_mobile(payload.get("mobile"))
    display_name = str(payload.get("displayName") or "").strip()
    password = str(payload.get("password") or "")
    if not mobile:
        return api_error("Enter a valid 10-digit Indian mobile number starting with 6 to 9.", 400)
    if not 1 <= len(display_name) <= 80:
        return api_error("Enter a display name between 1 and 80 characters.", 400)
    if len(password) < 8 or len(password) > 128:
        return api_error("Password must contain 8 to 128 characters.", 400)
    if Member.query.filter(Member.mobile_number.in_(mobile_lookup_values(mobile))).first() is not None:
        return api_error("An account with this mobile number already exists. Choose Login to sign in.", 409)

    member = Member(
        id=uuid.uuid4(),
        email=f"{mobile}@members.local",
        mobile_number=mobile,
        display_name=display_name,
        password_hash=generate_password_hash(password),
    )
    db.session.add(member)
    db.session.commit()
    session.clear()
    session.permanent = True
    session["member_id"] = str(member.id)
    session["session_version"] = member.session_version
    db.session.commit()
    return jsonify(member_json(member))


@app.post("/api/auth/login")
def login_member():
    payload = request.get_json(silent=True) or {}
    mobile = normalized_mobile(payload.get("mobile"))
    password = str(payload.get("password") or "")
    if not mobile:
        return api_error("Enter a valid 10-digit Indian mobile number starting with 6 to 9.", 400)
    if not password:
        return api_error("Enter your password.", 400)
    candidates = Member.query.filter(Member.mobile_number.in_(mobile_lookup_values(mobile))).all()
    member = next(
        (
            candidate for candidate in candidates
            if candidate.password_hash and check_password_hash(candidate.password_hash, password)
        ),
        None,
    )
    if member is None:
        return api_error("Invalid mobile number or password.", 401)

    session.clear()
    session.permanent = True
    session["member_id"] = str(member.id)
    session["session_version"] = member.session_version
    db.session.commit()
    return jsonify(member_json(member))


VERIFY_PAGE = """
<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Confirm sign-in — Parammal Walking Club</title>
<body style="font:16px system-ui;max-width:480px;margin:12vh auto;padding:24px;color:#27151e">
  <h1>Confirm sign-in</h1>
  <p>Click below to use your one-time sign-in link.</p>
  <form method="post">
    <input type="hidden" name="token" value="{{ token }}">
    <button style="padding:12px 18px;font-size:16px">Sign in</button>
  </form>
</body>
</html>
"""


@app.route("/auth/verify", methods=["GET", "POST"])
def verify_magic_link():
    if request.method == "GET":
        token = request.args.get("token", "")
        if not token or len(token) > 200:
            return redirect("/?auth=expired")
        return render_template_string(VERIFY_PAGE, token=token)

    raw_token = request.form.get("token", "")
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    now = datetime.now(timezone.utc)
    token_row = MagicLinkToken.query.filter_by(token_hash=token_hash).one_or_none()
    if token_row is None or token_row.used_at is not None:
        return redirect("/?auth=expired")
    expires_at = token_row.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at <= now:
        return redirect("/?auth=expired")

    member = db.session.get(Member, token_row.member_id)
    if member is None:
        return redirect("/?auth=expired")
    consumed = (
        MagicLinkToken.query.filter_by(id=token_row.id, used_at=None)
        .filter(MagicLinkToken.expires_at > now)
        .update({MagicLinkToken.used_at: now}, synchronize_session=False)
    )
    if consumed != 1:
        db.session.rollback()
        return redirect("/?auth=expired")
    session.clear()
    session.permanent = True
    session["member_id"] = str(member.id)
    session["session_version"] = member.session_version
    db.session.commit()
    return redirect("/?auth=verified", code=303)


@app.get("/api/auth/me")
def auth_me():
    member, error = require_member()
    if error:
        return error
    return jsonify(member_json(member))


@app.post("/api/auth/logout")
def logout():
    member = member_from_session()
    if member is not None:
        member.session_version += 1
        db.session.commit()
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/settings/me")
def get_my_settings():
    member, error = require_member()
    if error:
        return error
    return jsonify({"monthlyGoal": float(member.monthly_goal_km)})


@app.put("/api/settings/me")
def update_my_settings():
    member, error = require_member()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    try:
        goal = float(payload.get("monthlyGoal"))
    except (TypeError, ValueError):
        return api_error("Monthly goal must be a number.", 400)
    if not 5 <= goal <= 500:
        return api_error("Monthly goal must be between 5 and 500 km.", 400)
    member.monthly_goal_km = round(goal, 2)
    db.session.commit()
    return jsonify({"monthlyGoal": float(member.monthly_goal_km)})


@app.get("/api/walks")
def list_walks():
    try:
        limit = min(500, max(1, int(request.args.get("limit", "100"))))
        offset = max(0, int(request.args.get("offset", "0")))
    except ValueError:
        return api_error("Limit and offset must be integers.", 400)

    query = WalkLog.query.join(Member, WalkLog.member_id == Member.id)
    total = query.count()
    rows = query.order_by(
        WalkLog.walk_date.desc(),
        WalkLog.created_at.desc(),
        WalkLog.id.desc(),
    ).offset(offset).limit(limit).all()
    return jsonify({
        "items": [
            {
                "id": row.id,
                "memberId": str(row.member_id),
                "name": row.member.display_name,
                "route": row.route,
                "km": float(row.distance_km),
                "mins": row.duration_minutes,
                "date": row.walk_date.isoformat(),
            }
            for row in rows
        ],
        "total": total,
        "limit": limit,
        "offset": offset,
    })


@app.post("/api/walks")
def create_walk():
    member, error = require_member()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    route = str(payload.get("route") or "").strip()
    if not 1 <= len(route) <= 120:
        return api_error("Choose a valid route.", 400)
    try:
        distance = float(payload.get("km"))
        minutes = int(payload.get("mins"))
        walk_date = datetime.strptime(str(payload.get("date")), "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return api_error("Enter a valid distance, duration, and date.", 400)
    if not 0.05 <= distance <= 100:
        return api_error("Distance must be between 0.05 and 100 km.", 400)
    if not 1 <= minutes <= 600:
        return api_error("Duration must be between 1 and 600 minutes.", 400)

    row = WalkLog(
        member_id=member.id,
        route=route,
        distance_km=round(distance, 2),
        duration_minutes=minutes,
        walk_date=walk_date,
    )
    db.session.add(row)
    db.session.commit()
    return jsonify({"id": row.id}), 201


@app.get("/api/site-content")
def get_site_content():
    row = db.session.get(SiteContent, "main")
    if row is None:
        return api_error("Shared site content has not been initialized.", 503)
    return jsonify(row.content)


@app.put("/api/site-content")
def update_site_content():
    _, error = require_admin()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    mode = payload.get("bannerMode")
    slides = payload.get("slides")
    announcement = payload.get("announcement")
    if mode not in {"auto", "poster", "slides"} or not isinstance(slides, list) or len(slides) > 50:
        return api_error("Invalid poster settings.", 400)
    if not isinstance(announcement, dict):
        return api_error("Invalid announcement settings.", 400)

    cleaned_slides = []
    for slide in slides:
        if not isinstance(slide, dict):
            return api_error("Each poster must be an object.", 400)
        image = str(slide.get("image") or "").strip()
        caption = str(slide.get("caption") or "").strip()
        tag = str(slide.get("tag") or "").strip()
        if not valid_http_url(image) or len(caption) > 180 or len(tag) > 40:
            return api_error("Poster URLs must use http/https; captions and tags are limited in length.", 400)
        cleaned_slides.append({
            "id": str(slide.get("id") or uuid.uuid4()),
            "image": image,
            "caption": caption or "Parammal Walking Club",
            "tag": tag or "CLUB",
        })

    link_url = str(announcement.get("linkUrl") or "").strip()
    if link_url and not valid_http_url(link_url):
        return api_error("Announcement links must use http or https.", 400)
    cleaned_announcement = {
        "enabled": bool(announcement.get("enabled")),
        "titleEn": str(announcement.get("titleEn") or "ANNOUNCEMENT")[:120],
        "titleMl": str(announcement.get("titleMl") or "അറിയിപ്പ്")[:120],
        "msgEn": str(announcement.get("msgEn") or "")[:2000],
        "msgMl": str(announcement.get("msgMl") or "")[:2000],
        "primaryLabel": str(announcement.get("primaryLabel") or "Learn More")[:80],
        "linkUrl": link_url,
    }
    row = db.session.get(SiteContent, "main")
    if row is None:
        return api_error("Shared site content has not been initialized.", 503)
    row.content = {
        "bannerMode": mode,
        "slides": cleaned_slides,
        "announcement": cleaned_announcement,
    }
    row.updated_at = datetime.now(timezone.utc)
    db.session.commit()
    return jsonify({"ok": True})


@app.get("/<path:asset>")
def static_asset(asset):
    if asset == "favicon.ico":
        return "", 204
    return api_error("Not found.", 404)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")), debug=environment != "production")
