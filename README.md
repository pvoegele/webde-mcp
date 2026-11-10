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
| `read_attachment` | Text eines Anhangs lesen (PDF/Text), um ihn einzuordnen |
| `get_filing_rules` | Regeln: was abgelegt wird, geschäftlich vs. privat, Ordner- und Dateinamen |
| `save_attachment_to_drive` | Anhang direkt nach Google Drive hochladen (nur wenn Google konfiguriert) |
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

## Google Drive: Anhänge einsortieren

Claude prüft Mails mit Anhängen, liest Rechnungen & Co. (`read_attachment`), entscheidet
**Automationsexperten** vs. **Privat** und lässt den Server die Datei direkt nach Drive hochladen:

```
Mail-Anhänge/
├── Automationsexperten/Rechnungen/2026/2026-11-03_Hetzner_Server-Rechnung.pdf
├── Privat/Versicherungen/2026/...
└── Zu prüfen/...            ← wenn die Zuordnung unklar ist
```

Bereits abgelegte Mails bekommen das IMAP-Schlagwort `$DriveSaved` und werden beim nächsten
Durchlauf übersprungen. Gleichnamige Dateien werden nicht überschrieben.
In Claude Code startet der Prompt `/mcp__webde__anhaenge_einsortieren` den kompletten Ablauf.

### Einrichtung (einmalig)

1. <https://console.cloud.google.com> → neues Projekt, z. B. `webde-mcp`.
2. **APIs & Dienste → Bibliothek → „Google Drive API“ → Aktivieren.**
3. **Google Auth Platform / OAuth-Zustimmungsbildschirm**: Typ *Extern*, App-Name `webde-mcp`, eigene E-Mail eintragen.
   Unter **Zielgruppe** auf **„App veröffentlichen“ (In Produktion)** stellen – im Test-Modus läuft der Zugang nach 7 Tagen ab.
4. **Clients → Client erstellen → Typ „Desktop-App“** → Client-ID und Clientschlüssel kopieren.
5. In `.env` eintragen: `GOOGLE_CLIENT_ID=…`, `GOOGLE_CLIENT_SECRET=…`, dann:
   ```bash
   docker compose up -d --build
   docker compose run --rm webde-mcp node dist/google-auth.js
   ```
   Link öffnen, Google-Konto wählen (Warnung „App nicht überprüft“ → *Erweitert → Weiter*),
   die `http://localhost/?code=…`-Adresse zurück ins Terminal kopieren.
6. Ausgegebene Zeile `GOOGLE_REFRESH_TOKEN=…` in `.env` eintragen, optional `BUSINESS_HINTS`
   (Firmenname, Adresse, USt-IdNr.), dann `docker compose up -d`.

Berechtigung ist nur `drive.file`: Der Server sieht ausschließlich die Dateien und Ordner, die er selbst angelegt hat.

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
