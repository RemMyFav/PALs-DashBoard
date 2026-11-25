# Deploy PALs over HTTPS

The Google Cloud VM runs the application with Docker Compose. Caddy runs on the VM and serves HTTPS for `pal.voltvivi.com`.

In Route 53, point the `pal.voltvivi.com` A record to the VM's static external IPv4. In Google Cloud, allow inbound TCP 80 and 443 to the VM. Keep the Compose port bound to `127.0.0.1:3000`.

On the VM, from the repository root, set `PUBLIC_URL=https://pal.voltvivi.com` in the server's `.env`. Keep that file on the server.

```sh
sudo docker compose up -d --wait
sudo apt update
sudo apt install -y caddy
sudo caddy validate --config deploy/Caddyfile
sudo install -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl -fsS https://pal.voltvivi.com/api/health
```

The install command replaces the host Caddy configuration and is intended for the dedicated PALs VM. If Caddy already serves other sites on the host, add the PALs site block to the existing configuration instead.

After changing the versioned Caddyfile, pull the update on the VM and repeat the validate, install, and reload commands.
