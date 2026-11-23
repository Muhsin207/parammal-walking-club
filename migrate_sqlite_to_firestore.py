import os
from datetime import timezone

import firebase_admin
from firebase_admin import firestore

from app import Member, SiteContent, WalkLog, app, db, initialize_database


PROJECT_ID = os.environ.get("FIREBASE_PROJECT_ID", "").strip()
MAX_BATCH_WRITES = 400


def main():
    if not PROJECT_ID:
        raise RuntimeError("Set FIREBASE_PROJECT_ID before running the migration.")

    firebase_admin.initialize_app(options={"projectId": PROJECT_ID})
    client = firestore.client()

    with app.app_context():
        initialize_database()
        members = {member.id: member for member in Member.query.all()}
        if not members:
            raise RuntimeError("No members found in the configured SQLite database; no Firestore data was written.")
        walks = (
            WalkLog.query.join(Member, WalkLog.member_id == Member.id)
            .order_by(WalkLog.id.asc())
            .all()
        )
        site_content = db.session.get(SiteContent, "main")

        batch = client.batch()
        pending_writes = 0
        for walk in walks:
            member = members.get(walk.member_id)
            if member is None:
                raise RuntimeError(f"Walk {walk.id} references a missing member; migration stopped.")
            created_at = walk.created_at
            if created_at.tzinfo is None:
                created_at = created_at.replace(tzinfo=timezone.utc)
            document = client.collection("walkLogs").document(f"legacy_{walk.id}")
            batch.set(document, {
                "memberId": f"legacy:{walk.member_id}",
                "name": member.display_name,
                "route": walk.route,
                "km": float(walk.distance_km),
                "mins": walk.duration_minutes,
                "date": walk.walk_date.isoformat(),
                "createdAt": created_at,
            })
            pending_writes += 1
            if pending_writes == MAX_BATCH_WRITES:
                batch.commit()
                batch = client.batch()
                pending_writes = 0

        if pending_writes:
            batch.commit()

        if site_content is not None:
            content_ref = client.collection("siteContent").document("main")
            if not content_ref.get().exists:
                content_ref.set(site_content.content)

    print(f"Migrated {len(walks)} historical walks to Firebase project {PROJECT_ID}.")
    print("Existing member passwords and administrator access were not migrated.")


if __name__ == "__main__":
    main()
