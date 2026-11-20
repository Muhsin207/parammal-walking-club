# SQLite and Flask setup

DB Browser for SQLite is a desktop tool for viewing and editing a SQLite database file; it is not itself a web backend. Flask serves the app and reads/writes the same SQLite file. The app creates the file and tables automatically on its first request.

## Local setup on Windows

1. Open PowerShell in the project folder and create the Python environment:

   ```powershell
   Set-Location 'C:\Users\hp\Desktop\Parammal-Walking-Club'
   py -3.14 -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
   Copy-Item .env.example .env
   ```

   If `.env` already exists, edit it instead of copying over it.

2. In `.env`, the default `DATABASE_PATH=data/parammal_walking_club.sqlite3` creates the database in the project's `data` folder. Keep the local `.env` private; it is ignored by Git.
3. Start the server:

   ```powershell
   .\.venv\Scripts\python.exe app.py
   ```

4. Open `http://127.0.0.1:5000` in your browser (not `index.html` as a `file:///` URL). The first page request creates the SQLite file and tables.
5. In DB Browser for SQLite, choose **Open Database** and open `C:\Users\hp\Desktop\Parammal-Walking-Club\data\parammal_walking_club.sqlite3`. Use **Browse Data** to view rows or **Execute SQL** to run SQL. If you edit data, click **Write Changes**. Avoid manually changing schema/tables because the app expects its defined structure.

With SMTP unset locally, magic-link requests are printed in the PowerShell server window. Use that link to sign in during local development.

## Make the first account an administrator

Register and sign in to your account first. Then, in DB Browser's **Execute SQL** tab, run this query with your registered email:

```sql
UPDATE members
SET is_admin = 1
WHERE email = lower('your-admin@example.com');
```

Click **Write Changes**, then open `http://127.0.0.1:5000/#admin`. The `#admin` URL only opens the panel; the backend checks the administrator flag in the database for every content update.

## Publish on Render

Render's web-service filesystem is temporary unless you attach a persistent disk. Persistent disks require a paid web-service plan. Review the current price in Render before creating the service.

1. Put this project in a GitHub repository containing only the project files. Do not upload `.env` or the local `data/parammal_walking_club.sqlite3` file. The `.gitignore` excludes both.
2. In Render, choose **New → Web Service**, connect the repository, select the Docker runtime, and choose a region and paid plan.
3. Add a persistent disk with mount path `/var/data`. Choose a size that fits your needs; Render does not let you reduce the disk size later.
4. Add these environment variables in the Render dashboard:
   - `ENVIRONMENT=production`
   - `DATABASE_PATH=/var/data/parammal_walking_club.sqlite3`
   - `SECRET_KEY` — a unique random value of at least 32 characters. Generate it privately; do not commit or share it.
   - `MAIL_SERVER`, `MAIL_PORT`, `MAIL_USE_TLS` or `MAIL_USE_SSL`, `MAIL_USERNAME`, `MAIL_PASSWORD`, and `MAIL_DEFAULT_SENDER` from your SMTP provider.
   - `APP_BASE_URL` is optional on Render. The app uses Render's HTTPS service URL automatically unless you set `APP_BASE_URL`; for a custom domain, set it to that domain's HTTPS origin.
5. Create the service. The included Dockerfile binds Gunicorn to Render's `PORT`. The app creates its empty SQLite database on the first request. The first deployment contains no records from your computer.
6. Open the service's **Shell** in the Render dashboard after registering and signing in with your admin email. Run this command, replacing the email:

   ```sh
   python -c 'import os, sqlite3; c=sqlite3.connect(os.environ["DATABASE_PATH"]); r=c.execute("UPDATE members SET is_admin=1 WHERE email=lower(?)", ("your-admin@example.com",)); c.commit(); print("updated rows:", r.rowcount)'
   ```

   Then sign out and back in, and open the deployed URL with `#admin`.

Render's disk setup and service steps are documented at [Persistent Disks](https://render.com/docs/disks), [Web Services](https://render.com/docs/web-services), and [Deploy a Flask App](https://render.com/docs/deploy-flask).

## SQLite limitations

SQLite is one local file, not a network database service. Do not put it on a public share or try to open the server's live file in DB Browser on another computer. Download a protected backup to inspect it, and stop the app before replacing/restoring its database file. Keep automated backups and ensure they can be restored.

SQLite is suitable for a small club with modest write traffic and one app instance. If the club needs multiple app instances, frequent simultaneous writes, or stronger managed backup/availability features, use a hosted PostgreSQL service instead.

## Data and privacy

The new SQLite database starts empty; data from earlier browser storage or any unrelated database is not imported. Member names and walk date, route, and distance are publicly visible. GPS coordinates are used in the browser to calculate distance and are not uploaded. Obtain any consent required before inviting members.
