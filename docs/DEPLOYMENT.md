# Deploying the remote profile

The remote profile is the only part of HomeRelay meant to be reachable from outside: the OAuth-protected `/mcp` an Alexa+ add-on calls, plus the public `/privacy` and `/terms` pages and the add-on images. The household web app, API and full MCP server stay on loopback. Every command below was run against the container on 2026-10-22, using Docker Desktop on Windows with Git Bash. The exceptions are anything that needs a real domain, which has not been deployed.

## Architecture

```
internet ──443──▶ Caddy (TLS, HSTS, 1 MB body cap, path allowlist) ──▶ homerelay-remote:3002 (container)
                                                                         ├─ non-root uid 1000, read-only root fs, no capabilities
                                                                         ├─ /data volume: homerelay.db (WAL) + documents/
                                                                         └─ healthcheck: GET /ready (database reachable)
```

The proxy forwards only `/mcp /oauth/* /.well-known/* /health /ready /privacy /terms /assets/addon/*`. Everything else gets a 404.

## 1. Configure (no secret ever printed or committed)

```bash
cp deploy/remote.env.example deploy/remote.env                  # git-ignored
HOMERELAY_OWNER_PASSWORD='…' npm run remote:owner               # hash goes to .data/remote-secrets/owner.env
npm run remote:client -- https://<redirect-uri-from-alexa-developer-hub>
# copy both values into deploy/remote.env, KEEPING the single quotes (Compose expands $ in unquoted values)
# set REMOTE_BASE_URL=https://<your-domain> and the LEGAL_* operator details, then:
rm -r .data/remote-secrets
```

The container gets only what is in `deploy/remote.env`. It never sees the app's `.env`, `APPROVAL_SECRET` or any LLM key.

## 2. Build and run

```bash
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps                  # wait for "healthy"
```

The image is three stages: esbuild bundle, then production dependencies (the compiler toolchain stays in that stage), then the runtime. The runtime is about 400 MB, contains no TypeScript, tsx or compiler, and pins `node:22.19.0-bookworm-slim`. Bad configuration exits at startup with one clear line (profile disabled, hash missing, non-HTTPS public URL). With `restart: unless-stopped`, Compose then retries; check `docker compose logs`.

**Docker Desktop on Windows:** if a build fails with `lookup production.cloudfront.docker.com: no such host`, run `docker pull node:22.19.0-bookworm-slim` once and build again. This was seen 2026-10-22 right after the engine started.

## 3. TLS

- **Public:** run Caddy on the host with `deploy/Caddyfile.example` (replace the hostname). It gets and renews a certificate automatically. Port 443 must reach it, and DNS must point at the host.
- **Local rehearsal** (verified): `docker compose -f deploy/docker-compose.yml --profile tls-local up -d` serves `https://localhost:8443` from Caddy's internal CA, loopback only. Trust that CA only per command: `docker compose … cp tls-local:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt` and `NODE_EXTRA_CA_CERTS=./caddy-root.crt`.

## 4. Verify from outside

```bash
export VERIFY_CLIENT_ID=… VERIFY_CLIENT_SECRET=… VERIFY_REDIRECT_URI=… VERIFY_OWNER_PASSWORD=…   # in your shell only
npm run verify:remote -- https://<domain> run ./state.json          # auth, tools, refresh, revocation, exposure, bad input
docker compose -f deploy/docker-compose.yml restart homerelay-remote
npm run verify:remote -- https://<domain> after-restart ./state.json   # persistence across restart
npm run verify:remote -- https://<domain> rate-limit
rm ./state.json                                                     # it holds a live refresh token
npm run test:soak:remote -- https://<domain> --minutes 120          # endurance; writes test situations, so use a test deployment
```

## 5. Backups and restore (both verified in the container)

```bash
# online, consistent snapshot + integrity check (safe while running); copy it off the host and encrypt it there
docker compose -f deploy/docker-compose.yml exec homerelay-remote node dist/scripts/backup.js /data/backups/$(date +%F)
docker run --rm -v homerelay_homerelay-data:/data -v "$PWD":/out alpine tar czf /out/homerelay-$(date +%F).tgz -C /data backups/$(date +%F)
# restore: stop, restore (the current files are moved aside, never deleted), start
docker compose -f deploy/docker-compose.yml stop homerelay-remote
docker compose -f deploy/docker-compose.yml run --rm --no-deps homerelay-remote node dist/scripts/restore.js /data/backups/<date>
docker compose -f deploy/docker-compose.yml start homerelay-remote
```

Volume names are prefixed with the Compose project name (`homerelay` by default; check `docker volume ls`). On Git Bash, prefix commands that pass `/data/…` paths with `MSYS_NO_PATHCONV=1`. HomeRelay does not encrypt backups itself. Schedule the backup command with cron or Task Scheduler.

## 6. Upgrade and roll back

```bash
docker tag homerelay-remote:local homerelay-remote:previous          # before building a new version
docker compose -f deploy/docker-compose.yml up -d --build            # migrations run at start; they only add (PRAGMA user_version)
# roll back: take a backup first; an older image cannot read a database migrated to a newer schema, so restore the pre-upgrade backup
docker tag homerelay-remote:previous homerelay-remote:local && docker compose -f deploy/docker-compose.yml up -d --no-build
```

## 7. Secret rotation and incident response

| Situation | Action |
|---|---|
| Suspected token theft, a lost device, or "sign everyone out" | `docker compose … exec homerelay-remote node dist/scripts/remote-setup.js revoke-all`. All codes and tokens stop working at once, and Alexa must re-link. |
| Owner password exposed | Create a new hash (`npm run remote:owner`), update `deploy/remote.env`, `docker compose … up -d`, then `revoke-all` |
| Client secret exposed | `npm run remote:client -- <same redirect URIs>`, replace the client entry, update the secret in the Alexa account-linking configuration, restart, then `revoke-all` |
| Host compromise suspected | Stop the stack, keep the volume and logs for analysis, rebuild the host, restore the last known-good backup, rotate the password and client secret, `revoke-all`, and notify affected people as the privacy policy commits |
| Lockout of the owner sign-in | Wait 15 minutes, or restart the container (the lockout counter is in memory) |

## 8. Monitoring and logs

- `GET /health` (liveness) and `GET /ready` (database reachable). Neither returns household data or configuration.
- One JSON line per request: method, path without the query string, status, duration. Tokens, `Authorization` headers, codes, state values and passwords are never logged (`tests/remote-oauth.test.ts`; the container logs were also checked after a full run). Logs rotate at 10 MB × 5 files.
- Watch for sustained 401/429 bursts on `/oauth/token` (credential guessing) and 5xx on `/mcp`.
- Dependencies: `npm audit` (0 vulnerabilities on 2026-10-22). Rebuild the image regularly to pick up base-image patches.

## What has not been done

No public host, domain or certificate exists for HomeRelay, so nothing has been deployed. Every check above ran against the local container (HTTP on 127.0.0.1, and HTTPS through the local-CA Caddy).
