# Macro Tracker (Indian Food Edition)

Static web app: you **must sign in** with email (Supabase magic link) before using the tracker. Each account gets **separate IndexedDB** storage on the device (`MacroTracker_<userId>`) plus its own row in Supabase, so two people can share one browser by signing out and signing in. Includes **1014+ INDB foods** from `data/indb-foods.json`.

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

### 5. Email (magic link) and sign-ups

Under **Authentication** → **Providers** → **Email**, keep **Email** enabled. Ensure **“Confirm email”** / signup settings match how you want first-time users to join (magic link creates the user on first use if sign-ups are allowed). On the free tier, use Supabase’s built-in mail or connect **SMTP** / **Resend** in **Project Settings** → **Auth** for more reliable delivery.

### 6. Configure the app

Edit [`config.js`](config.js):

```javascript
window.MACRO_TRACKER_CONFIG = {
    supabaseUrl: 'https://YOUR_PROJECT_REF.supabase.co',
    supabaseAnonKey: 'YOUR_ANON_KEY'
};
```

The **anon** key is designed to be public in the browser; access is restricted by **RLS** on `user_data`.

### 7. Sign-in flow (every visit)

1. Open the site → you see the **sign-in screen** until you authenticate.
2. Enter email → **Continue with email** → open the magic link. First-time addresses register automatically (if your project allows email sign-ups).
3. After login, the app opens. **Settings → Sign out** lets another person use the same device with their own data.

Sync: pulls when you sign in (when safe), pushes after edits (debounced) and when you leave the tab. **Pull from cloud** overwrites local synced data with the server copy.

**Note:** Last write to the server wins if two devices edit offline; use **Save to cloud now** / **Pull from cloud** when switching devices.

## Data model

- **Catalog** (starter + INDB): stored only in IndexedDB, merged from `data/indb-foods.json`; not uploaded to Supabase.
- **Cloud payload:** user-created foods (`source === 'user'`), all logs, weight logs, and user settings.

## Backup file import

When restoring from JSON, **OK** = full replace; **Cancel** = merge only custom / user foods from the file (logs unchanged).
