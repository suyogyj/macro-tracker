# Macro Tracker (Indian Food Edition)

Static web app with an offline-first **IndexedDB** database (Dexie), **1014+ INDB foods** from `data/indb-foods.json`, and optional **Supabase** cloud sync for logs, custom foods, goals, and weight.

## Run locally

Serve the folder over HTTP (needed for `fetch` of `data/indb-foods.json`):

```bash
cd /path/to/macro_tracker
python3 -m http.server 8080
```

Open `http://localhost:8080`.

## Regenerate INDB JSON from Excel

```bash
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python3 scripts/indb_xlsx_to_json.py
```

Bump `INDB_BUNDLE_VERSION` in `app.js` when you ship a new `indb-foods.json` so browsers merge updates.

## GitHub Pages

- Enable **Pages** for the repo (root or `/docs`).
- Include **`.nojekyll`** (already in the repo) so static files are served as-is.
- If the site URL is `https://<user>.github.io/<repo>/`, keep paths relative (as in this project).

## Supabase setup (free tier)

### 1. Create a project

1. Go to [supabase.com](https://supabase.com) and sign in.
2. **New project** → choose org, name, database password, region → create.

### 2. Create the `user_data` table and RLS

1. Open **SQL Editor** → **New query**.
2. Paste the contents of [`supabase/migrations/001_user_data.sql`](supabase/migrations/001_user_data.sql) and run it.

This creates `public.user_data` with `user_id`, `payload` (JSON), `updated_at`, and row-level security so each user only sees their own row.

### 3. API keys

1. **Project Settings** → **API**.
2. Copy **Project URL** and the **anon public** key.

### 4. Auth URLs (magic link)

1. **Authentication** → **URL configuration**.
2. Set **Site URL** to your app origin, e.g. `https://<user>.github.io` or `http://localhost:8080`.
3. Under **Redirect URLs**, add the same URL **including path** if you use a subpath, e.g.  
   `https://<user>.github.io/macro_tracker/`  
   and your local dev URL.

### 5. Email (magic link)

Under **Authentication** → **Providers** → **Email**, keep **Email** enabled. On the free tier, use Supabase’s built-in mail or connect **SMTP** / **Resend** in **Project Settings** → **Auth** if you want more reliable delivery.

### 6. Configure the app

Edit [`config.js`](config.js):

```javascript
window.MACRO_TRACKER_CONFIG = {
    supabaseUrl: 'https://YOUR_PROJECT_REF.supabase.co',
    supabaseAnonKey: 'YOUR_ANON_KEY'
};
```

The **anon** key is designed to be public in the browser; access is restricted by **RLS** on `user_data`.

### 7. Using sync

1. Open the app → **Settings** → **Cloud sync**.
2. Enter your email → **Send magic link** → click the link in the email.
3. The app pulls when you sign in (if safe), pushes after edits (debounced), and when you leave the tab. Use **Pull from cloud** to overwrite local data with the server copy.

**Note:** Last write to the server wins if you use two devices without syncing in between; use **Save to cloud now** / **Pull from cloud** when switching devices.

## Data model

- **Catalog** (starter + INDB): stored only in IndexedDB, merged from `data/indb-foods.json`; not uploaded to Supabase.
- **Cloud payload:** user-created foods (`source === 'user'`), all logs, weight logs, and user settings.

## Backup file import

When restoring from JSON, **OK** = full replace; **Cancel** = merge only custom / user foods from the file (logs unchanged).
