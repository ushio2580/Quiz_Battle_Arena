# Quiz Battle Arena (QBA)

A browser based classroom quiz game. A host creates and edits quiz sets, opens a room, and shares a short code or QR link. Students join with nicknames and move through a shared real time Survival Quiz match. The Node service validates movement, answer zones, health, hazards, timers, and tournament outcomes.

## Current implementation

The repository contains a complete first playable slice:

- Vite, vanilla JavaScript ES modules, Phaser arena rendering, and responsive desktop/mobile controls.
- Express, Socket.IO, SQLite, password hashing, opaque host sessions, per-room authorization, rate limits, and server-authoritative match simulation.
- Persistent host accounts, quiz sets, question rows, tournament records, snapshots, brackets, attempts, and results.
- Quiz editing, question reordering, 2–4 answer choices, per-question timing/damage/rewards, explanations, optional image references, preview, duplication, deletion, JSON/CSV/Excel import, and JSON export.
- An editable 30-question seed quiz is stored in `db/seed-data.json` and copied to a new host account.
- Real room codes, public join links, generated QR images, live lobby updates, host roster controls, host reattachment to live rooms, projector views, random single-elimination pairing, fair byes, match progression, and reconnect grace periods.
- Survival Quiz with private correct answers, per-player answer-zone arrangements, 0.75 second answer confirmation, a server clock, chaser monsters, warning spike traps, educational/arcade health rules, dash, and shield ability.
- Separate educational ranking and tournament placement, analytics, CSV results export, reduced motion/high contrast/text size preferences, and an automated Socket.IO integration test.

Only **Survival Quiz** is playable. Robot Duel, Quiz Royale, Co-op Boss Battle, the larger enemy roster, destructible objects, power-up drops, practice/review modes, manual matchmaking, third place match, and load testing are not implemented. The eight character choices are cosmetic selections; the first arena uses one original vector robot design. Image references are shown on the question panel but are loaded by player browsers from their URL or embedded data. Active matches live in server memory and are interrupted by a service restart; the next server start marks saved lobby and active tournament records as interrupted. Quiz sets and completed results persist.

## Requirements

- Node.js 20 or newer and npm.
- A compiler toolchain for `better-sqlite3` if a prebuilt binary is not available for your platform.
- A persistent writable directory for SQLite in production.

The checked-in dependency manifest is `package.json`. Run `npm install` to resolve dependencies and generate a local `package-lock.json` for repeat installs. This project was authored in an environment without Node.js/npm, so that generated lock file and executable build/test results could not be produced here.

## Run locally

1. Install Node.js 20+ and npm.
2. Install dependencies:

   ```sh
   npm install
   ```

3. Copy `.env.example` to `.env`, and set `SESSION_SECRET` to a unique random value (32 characters or longer). For a same-computer browser, keep `PUBLIC_BASE_URL=http://localhost:5173`.
4. Start the API and Socket.IO service:

   ```sh
   npm run server
   ```

5. In another terminal, start Vite:

   ```sh
   npm run dev
   ```

6. Open `http://localhost:5173`. Create a host account. The editable 30-question quiz is copied into the new account automatically.
7. To try real multiplayer locally, open the player join URL in a second browser or device. For a phone on the same Wi-Fi, set `PUBLIC_BASE_URL` to the computer’s LAN address on port `5173`, restart the API, and ensure the firewall allows port `5173`.
8. Run automated checks with `npm test`. The integration test launches a real local HTTP/Socket.IO server, creates a host and room, connects two independent sockets, checks that the correct answer stays private, and verifies server-applied movement.

For production-style local serving, run `npm run build` followed by `npm start`. Express serves `dist/` and the real-time backend from the same service.

## Database and migrations

SQLite opens at `DATABASE_PATH`, defaulting to `./data/qba.sqlite`. On startup, the service applies numbered SQL migrations from `db/migrations/` and inserts the seed quiz template if it is not present. `npm run db:seed` can apply the initial migration and seed template explicitly.

The host session token is random and only its HMAC digest is stored. In production set `SESSION_SECRET`; the application refuses to start with a short production secret. Host registration is open by default so the first administrator can register. After creating the host account, set `ALLOW_REGISTRATION=false` and redeploy.

## GitHub setup

Create an empty GitHub repository, then from this project directory:

```sh
git init
git add .
git commit -m "Build Quiz Battle Arena core"
git branch -M main
git remote add origin https://github.com/YOUR-ACCOUNT/YOUR-REPOSITORY.git
git push -u origin main
```

Replace the repository URL with the empty repository you created. Do not commit `.env`, database files, host credentials, or service secrets.

## Railway deployment

The repository includes `Dockerfile` and `railway.json`. Railway builds one Node service, serves the Vite build and Socket.IO from it, binds `0.0.0.0:$PORT`, and checks `/api/health`.

1. Push the project to GitHub.
2. In Railway, create a project from the GitHub repository and deploy its service.
3. Add a Railway volume to the service and mount it at `/app/data`.
4. Set these service variables:

   ```text
   NODE_ENV=production
   HOST=0.0.0.0
   DATABASE_PATH=/app/data/qba.sqlite
   SESSION_SECRET=<a unique random value with at least 32 characters>
   PUBLIC_BASE_URL=https://<your-generated-domain>
   ALLOW_REGISTRATION=true
   ```

   Generate a secret locally with `openssl rand -base64 48` or use Railway’s secret generator. Set `PUBLIC_BASE_URL` to the HTTPS domain assigned to this service, without a trailing slash. The generated domain is available from the Railway service networking settings.
5. Generate a public HTTPS domain and redeploy after setting `PUBLIC_BASE_URL`. Confirm `/api/health` returns `{"ok":true,...}`.
6. Register the initial host account, then change `ALLOW_REGISTRATION` to `false` and redeploy.
7. Create a quiz or edit the seeded quiz, open a room, and scan its QR code from phones on separate networks.

Railway volumes are attached to a service at runtime; data written during image builds is not persisted. Keep the service at one replica because active tournament state is held in that Node process and SQLite is on one volume. Railway plan and volume costs depend on the current account and usage; check the provider’s current pricing before deployment.

## Render alternative

`render.yaml` defines a Docker web service, `/api/health` check, generated session secret, and a 1 GB disk mounted at `/var/data`. Set `PUBLIC_BASE_URL` to the final `https://<service>.onrender.com` URL in the Render dashboard. The service uses `DATABASE_PATH=/var/data/qba.sqlite`.

Render persistent disks are available on paid services, so this SQLite configuration is not a persistent free-tier deployment. A disk-backed Render service also runs one instance, which matches QBA’s in-memory active-match model. Check current Render plan and disk pricing before creating the service.

## Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP and Socket.IO port | `3000` |
| `HOST` | Bind address | `0.0.0.0` |
| `PUBLIC_BASE_URL` | Absolute URL used for QR codes and share links | Request URL fallback |
| `SESSION_SECRET` | HMAC key for opaque host/player session tokens | Development-only fallback |
| `DATABASE_PATH` | SQLite database file | `./data/qba.sqlite` |
| `ALLOW_REGISTRATION` | Permit new host accounts | `true` |
| `NODE_ENV` | Enables secure cookies and production checks | unset |

Do not scale this service to multiple independent instances. There is no distributed room registry, shared session routing, or persistent active-match recovery yet.

## Data and privacy

Students do not provide emails or accounts. Their nickname, selected character, question attempts, and tournament results are saved with the host’s tournament. Hosts can export results as CSV. Quiz edits after a tournament starts do not change that tournament’s frozen question snapshot. Closed and abandoned room state is cleaned from memory; saved quiz records and completed results remain in SQLite.

## Test status

Automated unit and live Socket.IO tests are included. They have **not been executed in this workspace** because Node.js and npm are unavailable here. No real-device browser test, cloud deploy, or concurrent load test has been run, so no browser compatibility or participant capacity claim is made.

## Troubleshooting

- `GET /api/me` returning `401` means the browser has no valid host session; sign in again.
- `POST /api/auth/register` returning `409` means that email already has an account; use the sign-in tab.
- A `500` includes a reference ID in the response and browser message. Search the Render service logs for that ID to find the server-side stack trace. Do not share passwords, session cookies, or `SESSION_SECRET` when sharing logs.
