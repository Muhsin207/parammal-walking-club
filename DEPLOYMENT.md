# Supabase deployment

The web app uses Supabase Auth and Postgres for authentication, profiles, walk history, and shared site content.

## Supabase project setup

1. Create a Supabase project.
2. In **Authentication -> Providers -> Email**, enable the Email provider.
3. In **Authentication -> Settings**, disable confirmation of new email addresses. The app uses internal mobile aliases rather than real inboxes.
4. Run `supabase/migrations/001_initial_schema.sql` in the Supabase SQL editor.
5. Run `supabase/migrations/002_profile_bootstrap.sql` in the SQL editor. This also repairs existing projects: it grants the profile permissions, creates profiles automatically for new signups, and backfills existing auth users whose profiles are missing. If `001_initial_schema.sql` was already applied, run `002_profile_bootstrap.sql` only.
6. Run `supabase/migrations/003_private_walk_history.sql` in the SQL editor to make walk records visible only to their signed-in owner. Existing records are preserved; records not linked to a current member account will not appear in personal history.
7. Copy the Project URL and publishable/anon key into `static/supabase-config.js`.
8. Run `python build_firebase.py` to generate the static `dist` folder.
9. Deploy `dist` to the selected static host.

The GitHub repository is `https://github.com/Muhsin207/parammal-walking-club`.

## Members and migration

Existing member accounts are not migrated automatically. Members must create a new account with their mobile number and password. Legacy walk records remain in SQLite unless a migration is run separately.

To grant administrator access, verify the member outside the app and run this SQL in Supabase:

```sql
update public.profiles
set is_admin = true
from auth.users
where profiles.id = auth.users.id
  and auth.users.email = '919876543210@members.local';
```

Replace the mobile alias in the example with the administrator's mobile number.

Walk history is visible only to the signed-in member who owns each record. GPS coordinates are processed in the browser and are not uploaded. The PWA requires an internet connection for Supabase data and authentication.

For Firebase deployments, deploy the updated `firestore.rules` and `firestore.indexes.json` as well.
