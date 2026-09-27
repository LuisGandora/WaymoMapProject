# Hosting the API on a DigitalOcean droplet

The FastAPI backend runs on one Ubuntu droplet: uvicorn under systemd, Caddy in front for free HTTPS (Vercel pages are HTTPS, so browsers block calls to a plain-HTTP API). The Next.js frontend stays on Vercel and calls `https://api.yourdomain.com`.

## What's in the repo

| File | Purpose |
|---|---|
| `Server/deploy/waymo-api.service` | systemd unit: uvicorn on `127.0.0.1:8000`, restarts on crash, 300 s start timeout. Expects user `waymo` and `/home/waymo/WaymoMapProject/Server`. |
| `Server/deploy/Caddyfile` | `api.example.com { reverse_proxy 127.0.0.1:8000 }`; change the hostname. Caddy gets and renews the certificate itself. |
| `Server/app/config.py` | `CORS_ORIGINS` (exact origins), `CORS_ORIGIN_REGEX` (Vercel previews), `AREA_BUFFER_MILES`. |

Not yet run on a real droplet: the unit and Caddyfile are untested until you do this.

## 1. Create the droplet (DigitalOcean dashboard)

- Create → Droplets. Image: **Ubuntu 24.04**. Your pinned `numpy`/`pandas` need Python 3.11+, and 24.04 ships 3.12.
- Size: **2 GB RAM** is enough for the traced Waymo area. With `AREA_BUFFER_MILES` at 3-4 the graph is about 2-2.5x bigger (32k nodes at 4 miles): 2 GB is probably fine, **4 GB** is the safe choice (credits cover it).
- Region: the closest to Miami you can pick (Atlanta if offered, otherwise New York). The frontend is on Vercel, so latency barely matters.
- Authentication: add your SSH key (`ssh-keygen -t ed25519` in PowerShell if you have none; paste the `.pub` file).
- Optionally enable the free Cloud Firewall: allow inbound 22, 80, 443 only.
- Create, then copy the droplet's IP.

## 2. DNS (GoDaddy)

Add an **A record**: host `api`, value = the droplet IP. Do this before starting Caddy, which needs it to get a certificate. Check with `nslookup api.yourdomain.com`.

## 3. First login and a `waymo` user

```bash
ssh root@<IP>
adduser --disabled-password --gecos "" waymo
rsync --archive --chown=waymo:waymo ~/.ssh /home/waymo
echo "waymo ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/waymo
apt update && apt install -y python3-venv git caddy
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw --force enable
exit
```

## 4. Install the app (as `waymo`)

```bash
ssh waymo@<IP>
git clone <your-repo-url> WaymoMapProject       # this folder name is what waymo-api.service expects
cd WaymoMapProject/Server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt       # if a build fails: sudo apt install build-essential, retry
```

Copy your `.env` from your PC instead of retyping keys (PowerShell, in the repo root):

```powershell
scp Server/.env waymo@<IP>:/home/waymo/WaymoMapProject/Server/.env
```

Then on the droplet edit it (`nano .env`):
- `CORS_ORIGINS=https://<your-app>.vercel.app,https://<yourdomain>` (exact origins: no trailing slash, no spaces needed). Optionally `CORS_ORIGIN_REGEX` for Vercel preview URLs.
- `AREA_BUFFER_MILES` must equal the value the data was built with on your PC.

## 5. Copy the data that isn't in git (PowerShell, repo root)

```powershell
scp -r Server/data/media waymo@<IP>:/home/waymo/WaymoMapProject/Server/data/
scp Server/data/graph.graphml waymo@<IP>:/home/waymo/WaymoMapProject/Server/data/
```

`graph.graphml` and `data/media/` are gitignored. Without the graph the server downloads it from OSM on first start (slow, and large if `AREA_BUFFER_MILES` is set). Make sure the `data/*.json` files are committed (or `scp` them too).

## 6. Start it (on the droplet)

```bash
cd ~/WaymoMapProject/Server
sudo cp deploy/waymo-api.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now waymo-api
sudo nano deploy/Caddyfile                       # change api.example.com to api.yourdomain.com
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
curl https://api.yourdomain.com/health           # expect {"ok":true,...}
journalctl -u waymo-api -f                       # logs; look for "warm: graph ... nodes"
```

## 7. Connect the other services

- **Vercel:** Project → Settings → Environment Variables: `NEXT_PUBLIC_API_URL=https://api.yourdomain.com` (Production, and Preview if used), then Redeploy. It is baked in at build time. Also set `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` there: the Next app's `client/app/api/narrate/route.ts` calls ElevenLabs itself.
- **Mongo Atlas:** Network Access → add the droplet IP. Put `MONGO_URI` in the droplet's `.env`.
- **Google Cloud:** if your Maps key is IP-restricted, allow the droplet IP (Street View, Places and Wikipedia lookups come from the server).

## Updating later

```bash
cd ~/WaymoMapProject && git pull && sudo systemctl restart waymo-api
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| Caddy has no certificate / HTTPS fails | DNS not pointing at the droplet yet, or ports 80/443 blocked (`ufw status`, Cloud Firewall). |
| 502 from Caddy | uvicorn isn't running or is still loading the graph: `systemctl status waymo-api`, `journalctl -u waymo-api`. |
| Killed / out of memory while loading | Too little RAM for the graph: resize the droplet, or lower `AREA_BUFFER_MILES` and rebuild. |
| CORS error in the browser | Vercel origin doesn't exactly match `CORS_ORIGINS` (`http` vs `https`, trailing slash). `sudo systemctl restart waymo-api` after editing `.env`. |
| Site still calls `localhost:8000` | `NEXT_PUBLIC_API_URL` changed but Vercel wasn't redeployed. |
| Map loads but photos are missing | `data/media/` wasn't copied (step 5). |
