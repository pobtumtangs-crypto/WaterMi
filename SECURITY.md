# Security Policy

## Supported Versions

Security fixes are maintained on the `main` branch.

## Security Architecture Highlights

WaterMI implements layered security controls across the web app, API, database, and IoT firmware:

- **Authentication & Sessions:** Supabase Auth with per-user JWTs, AES-256-GCM encrypted `HttpOnly; SameSite=Lax` cookies (`__Host-watermi.sid` over HTTPS), server-enforced expiry, persistent session revocation (`revoked_sessions`), and minimum 8-character passwords.
- **Database Isolation:** PostgreSQL Row-Level Security (RLS) on `plants`, `checkups`, `revoked_sessions`, and `storage.objects`, ownership immutability triggers, and database-level `CHECK` constraints.
- **API & Web Protections:** Strict `Content-Security-Policy` (no `unsafe-inline`, no `innerHTML`), HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, same-origin CSRF checks, per-IP and per-user rate limiting, strict PNG/WebP magic-byte validation, and regional `blynk.cloud` SSRF allowlisting.
- **Secret Protection:** Per-plant Blynk Auth Tokens are encrypted at rest (`AES-256-GCM`), secrets are never committed to Git or bundled into Docker build contexts, and `Dockerfile` runs as non-root `USER node`.
- **IoT Transport Security:** ESP32 firmware (`arduino/watermi_blynk/watermi_blynk.ino`) communicates over TLS (`BlynkSimpleEsp32_SSL.h`, port 443) with hardware watchdog recovery and validated physical sensor bounds.

## Reporting a Vulnerability

If you discover a security issue in WaterMI:

1. **Do not** open a public GitHub issue with exploit details or exposed credentials.
2. Contact the repository owner privately via GitHub (or Private Vulnerability Reporting if enabled on the repository).
3. Include the affected component, reproduction steps, and potential impact.

If a real API key or access token is ever accidentally exposed, rotate it immediately in the corresponding provider dashboard (Supabase, Render, Google AI Studio, Groq, Pl@ntNet, or Blynk).
