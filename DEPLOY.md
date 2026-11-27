# Deploying WaterMI (AI + Live ESP32 Sensors)

WaterMI is packaged with a `Dockerfile`, `railway.toml`, and `fly.toml` so it deploys cleanly with **persistent storage** for saved plants/photos (`/data`), **AI keys** via environment secrets, and **HTTPS** for your ESP32.

---

## Render

The Render Blueprint uses Docker and checks `/healthz`. For an existing Render service, set the health check path and environment variables in its dashboard before deploying the new commit.

1. Run `supabase-schema.sql` in the project's Supabase SQL Editor. Account-owned plants, checkups, and photos use Supabase. Existing local `data/db.json` records need an explicit account migration.
2. In Render, set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and a random `SESSION_SECRET`. The Blueprint generates the session secret for new services. Keep existing AI keys in Render and leave `MOCK_AI` disabled.
3. In Supabase Authentication → URL Configuration, set the Site URL to the deployed origin and add that origin with `/auth/callback` to Redirect URLs. Keep the Email provider enabled and disable the Google provider if it was previously configured.
4. Deploy the linked GitHub branch. Check `/healthz`, sign in, and confirm the plant list loads.

Web sessions are stored in AES-256-GCM encrypted HttpOnly cookies signed with `SESSION_SECRET`, so users stay signed in across Render restarts and spin-downs. API routes also accept `Authorization: Bearer <supabase-jwt>`. All plant data, checkups, and photos live in Supabase (no local disk required). Cloud sensor polling uses the Blynk token linked to each plant. The older device push endpoints require an authenticated session or Bearer JWT in this account-based configuration.

## Option A: Deploy on Railway (Recommended — Easiest)

1. **Push `leafwise/` to a GitHub repository** (note: `.gitignore` already keeps `.env`, `data/`, and `node_modules/` private and out of Git):
   ```bash
   cd /home/pobtum/Downloads/leafwise-project/leafwise
   git init
   git add .
   git commit -m "Initial WaterMI deploy"
   # Create a private repo on GitHub, then:
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git branch -M main
   git push -u origin main
   ```
2. Go to [railway.com](https://railway.com) -> **New Project** -> **Deploy from GitHub repo** -> select your repo.
   - Railway automatically detects `Dockerfile` and `railway.toml`.
3. **Add Persistent Storage** (so plants and photos are never lost on redeploy):
   - Open your service -> **Volumes** -> **Add Volume** -> set Mount Path to `/data`.
4. **Add your Environment Variables** (Service -> **Variables**):
   - `GEMINI_API_KEY` = your Google AI Studio key
   - `GROQ_API_KEY` = *(optional)* your Groq backup key
   - `PLANTNET_API_KEY` = *(optional)* your Pl@ntNet key
   - `DATA_DIR` = `/data`
   - `HOST` = `0.0.0.0`
   - `SENSOR_KEY` = *(optional)* a secret password if you want only your ESP32 to post sensor readings
5. **Generate a Public Domain**:
   - Service -> **Settings** -> **Networking** -> **Generate Domain** (e.g. `https://watermi-production.up.railway.app`).
6. Open your new HTTPS URL — WaterMI and AI analysis/chat are live!

---

## Option B: Deploy on Fly.io (CLI)

1. Install the Fly CLI:
   ```bash
   curl -L https://fly.io/install.sh | sh
   fly auth login
   ```
2. Launch the app from `leafwise/` (change `app = "watermi-app"` in `fly.toml` to a unique name):
   ```bash
   cd /home/pobtum/Downloads/leafwise-project/leafwise
   fly launch --no-deploy --copy-config
   ```
3. Create the persistent volume for saved plants and photos:
   ```bash
   fly volumes create watermi_data --region sin --size 1
   ```
4. Set your AI keys as Fly secrets:
   ```bash
   fly secrets set GEMINI_API_KEY="your-gemini-key"
   # Optional backups / plant ID / sensor protection:
   fly secrets set GROQ_API_KEY="your-groq-key" PLANTNET_API_KEY="your-plantnet-key"
   # Optional:
   # fly secrets set SENSOR_KEY="choose-a-secret"
   ```
5. Deploy:
   ```bash
   fly deploy
   ```
   Your live URL will be `https://<your-app-name>.fly.dev`.

---

## Connect Your ESP32 to the Deployed Website

1. Open your deployed WaterMI website and add a plant (or view an existing one).
2. Get its `PLANT_ID`:
   ```bash
   curl -s https://<your-live-domain>/api/plants | node -e "for (const p of JSON.parse(require('fs').readFileSync(0,'utf8'))) console.log(p.id, '-', p.name);"
   ```
3. Open `arduino/watermi_esp32/watermi_esp32.ino` in Arduino IDE and update:
   ```cpp
   const char* WIFI_SSID     = "YOUR_WIFI_NAME";
   const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

   const char* SERVER_URL    = "https://<your-live-domain>";
   const char* PLANT_ID      = "YOUR_PLANT_ID";
   const char* SENSOR_KEY    = ""; // Leave empty unless you set SENSOR_KEY in cloud env vars
   ```
4. Upload to your ESP32! It automatically uses HTTPS (`WiFiClientSecure`) when `SERVER_URL` starts with `https://`, so your ESP32 can send live readings from **any Wi-Fi network**, anywhere.
