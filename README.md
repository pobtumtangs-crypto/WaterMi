# Leafwise

Plant and crop health checks with AI, for farmers and growers.

A mobile-friendly web app with three screens:

- **Dashboard:** your plants, their health trend and watering status.
- **Analyze:** take a photo of any plant or crop and get a health report.
- **Chat:** ask follow-up questions about a saved plant, or anything about growing.

## Setup

1. Install Node.js 22.9 or newer.
2. Get a free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
3. Copy `.env.example` to `.env` and put the key after `GEMINI_API_KEY=`.
4. Run `npm install`, then `npm start`.
5. Open http://localhost:3000.

- `npm run demo` runs with fake AI replies, so no key is needed.
- `npm test` runs the backend tests with a fake Gemini, so no key or internet is needed.

## Good to know

- Plants are saved in `data/db.json`, photos in `data/photos/`. Chat history is saved in the browser, so each device has its own.
- AI reports are suggestions from a photo, not a confirmed diagnosis.
- The heading font loads from Google Fonts. Without internet, a standard serif font is used.
- Optional: with `GROQ_API_KEY` set, analysis tries `qwen/qwen3.8-27b` on Groq (`GROQ_MODEL`) when every Gemini model is busy or at its limit. Not used for other Gemini errors or for chat. Chat has its own Gemini backup (`CHAT_FALLBACK_MODEL`, default `gemini-3.1-flash-lite`), which switches only before a reply starts. Groq listed this model as a preview, and its 8,000 tokens a minute on the tested account allow only about two analyses a minute. **The photo, note, plant record and any Pl@ntNet suggestions then go to Groq.**
- Optional: with `PLANTNET_API_KEY` set, each analysis also asks the [Pl@ntNet recognition API](https://my.plantnet.org) about the plant and its diseases (2 of the 500 free requests a day, JPEG and PNG only). Gemini gets the stronger matches as hints, and the report lists them. If Pl@ntNet fails, analysis carries on without it; the server log says why. **Photos are then sent to Pl@ntNet as well as Google.**
- If the main analysis model is busy or has reached its limit, the app tries lighter backups in order (`ANALYSIS_FALLBACK_MODEL`, comma-separated; by default `gemini-3.5-flash-lite`, then `gemini-3.1-flash-lite`) and the report says when a backup made it. Leave that setting empty in `.env` to turn backups off. Google's deprecation page listed `gemini-3.1-flash-lite` for shutdown on May 7, 2027.
- Model names are set in `.env`. If a model is retired, change `ANALYSIS_MODEL` or `CHAT_MODEL`.
- On Google's free tier, Google may use what you send (including photos) to improve its products.
- There are no accounts. The server only accepts connections from this computer unless you set `HOST=0.0.0.0` in `.env`.

## API details for the frontend

- A report made by the backup model has an extra `backup_model` field with that model's name.
- `confidence` and each problem's `severity` are `low`, `medium` or `high`.
- Other error codes besides `no_key`, `bad_key`, `quota` and `bad_model`: `bad_request`, `not_found`, `too_large`, `busy`, `ai_error`, `server_error`.
- If chat fails before the reply starts, the response is a normal JSON `{error, code}`. After it starts, the error arrives as `data: {"error": "...", "code": "..."}`.
# Trigger deploy
