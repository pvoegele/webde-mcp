# webde-mcp

Remote-MCP-Server (Streamable HTTP) für ein web.de-Postfach über IMAP/SMTP.
Läuft per Docker auf einem eigenen Server, Caddy davor sorgt für HTTPS.

## Tools

| Tool | Funktion |
|---|---|
| `list_folders` | Ordner mit Anzahl (ungelesener) Mails |
| `search_emails` | Suche nach Absender, Empfänger, Betreff, Volltext, Datum, ungelesen |
| `get_email` | Mail vollständig lesen (Text, Anhänge-Liste) |
| `mark_emails` | gelesen / ungelesen markieren |
| `move_emails` | in anderen Ordner verschieben (z.B. `Papierkorb`) |
| `save_draft` | Entwurf in „Entwürfe“ ablegen |
| `send_email` | senden über SMTP + Kopie in „Gesendet“ (abschaltbar mit `ALLOW_SEND=false`) |

## 1. web.de vorbereiten

1. Im web.de-Postfach: **Einstellungen → POP3/IMAP Abruf → „POP3 und IMAP Zugriff erlauben“** aktivieren.
2. Bei aktivierter Zwei-Faktor-Authentifizierung ein **anwendungsspezifisches Passwort** erzeugen und dieses als `WEBDE_PASSWORD` verwenden.

## 2. Auf dem Server deployen

Voraussetzung: Docker + Docker Compose, Ports 80/443 offen, DNS-A-Record der Domain zeigt auf den Server.

```bash
git clone <repo-url> webde-mcp && cd webde-mcp
cp .env.example .env
openssl rand -hex 32        # → als MCP_AUTH_TOKEN in .env eintragen
nano .env                   # DOMAIN, WEBDE_USER, WEBDE_PASSWORD setzen
chmod 600 .env
docker compose --profile caddy up -d --build   # siehe Varianten unten
curl https://<DOMAIN>/health   # → {"ok":true}
```

Update: `git pull && docker compose up -d --build`

### Variante A: Server hat noch keinen Webserver auf 80/443

```bash
docker compose --profile caddy up -d --build
```

### Variante B: Es läuft schon ein Reverse-Proxy (z.B. Caddy von n8n)

1. In `.env` ergänzen (Netzname mit `docker inspect <proxy-container>` ermitteln):
   ```
   PROXY_NETWORK=n8n_default
   COMPOSE_FILE=docker-compose.yml:docker-compose.shared-proxy.yml
   ```
2. `docker compose up -d --build`
3. Im Caddyfile des vorhandenen Proxys ergänzen und Caddy neu laden:
   ```
   46-224-219-63.sslip.io {
   	reverse_proxy webde-mcp:3000
   }
   ```
   `docker exec <proxy-container> caddy reload --config /etc/caddy/Caddyfile`

## 3. In Claude einbinden

**Claude Code:**

```bash
claude mcp add --transport http webde https://<DOMAIN>/mcp --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "webde": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<DOMAIN>/mcp", "--header", "Authorization: Bearer <MCP_AUTH_TOKEN>"]
    }
  }
}
```

## Lokal testen

```bash
npm ci && npm run build
WEBDE_USER=... WEBDE_PASSWORD=... MCP_AUTH_TOKEN=$(openssl rand -hex 32) npm start
npx @modelcontextprotocol/inspector   # → http://localhost:3000/mcp
```

## Sicherheit

- Zugangsdaten liegen nur in `.env` auf dem Server (nicht im Repo).
- Jeder Request an `/mcp` braucht den Bearer-Token; ohne Token → 401.
- Wer den Token hat, kann Mails lesen und – falls `ALLOW_SEND=true` – senden. Token geheim halten, bei Verdacht neu erzeugen.
