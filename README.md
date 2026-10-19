# Haushaltsbuch

Eine kleine, selbst gehostete Web-App für das tägliche Haushaltsbuch: Ausgaben schnell erfassen, nach beliebigen Zeiträumen auswerten, Spartöpfe und einen groben Monatsüberblick führen.

- **Erfassen** mit Tastatur: Datum → Geschäft → Betrag → Kategorie → Enter. Vorschläge aus früheren Einträgen erscheinen grau im Feld und werden mit <kbd>Tab</kbd> übernommen. Nach der Wahl des Geschäfts wird die dort übliche Kategorie vorgeschlagen. Beträge wie `3,30+2,10` werden zusammengerechnet.
- **Auswertung** für aktuelle KW, letzte 7 Tage, aktuellen Monat, letzte 30 Tage, aktuelles Jahr, letzte 365 Tage oder einen freien Zeitraum (mit Blättern nach vorne und zurück), filterbar nach Kategorien und Geschäften (auch kombiniert). Verlauf, Anteile je Kategorie, Geschäfte, Einzelbuchungen und CSV-Export.
- **Feste Kategorien** mit eigener Farbe und eigenem Symbol, die überall gleich aussehen. Kategorien und Geschäfte lassen sich umbenennen und zusammenlegen.
- **Spartöpfe** mit Ein- und Auszahlungen und optionalem Sparziel.
- **Monatsüberblick** über regelmäßige Einnahmen und Fixkosten (monatlich, vierteljährlich, jährlich …).
- Heller und dunkler Modus, funktioniert auch am Handy.

Technik: Python 3 (nur Standardbibliothek) + SQLite, Oberfläche in reinem HTML/CSS/JavaScript. Keine Pakete, kein Build-Schritt. Symbole: [Lucide](https://lucide.dev) (ISC-Lizenz).

> **Datenschutz:** Echte Daten (Datenbank, Sicherungs- und Importdateien) gehören nie in dieses Repository. Die `.gitignore` schließt `*.db`, `*.json`, `*.ods` und `*.csv` aus.

---

## Lokal ausprobieren

```sh
python3 server.py            # → http://127.0.0.1:8085
```

Die Datenbank landet dann in `data/haushaltsbuch.db`.

---

## Einrichtung auf dem eigenen Server

Ziel: `https://haushaltsbuch.svetho.net`, geschützt mit Benutzername und Passwort. Die Befehle gehen von Debian/Ubuntu mit nginx aus und werden als root (bzw. mit `sudo`) ausgeführt.

### 1. DNS-Eintrag anlegen

Beim DNS-Anbieter von `svetho.net`:

| Typ | Name | Wert |
|---|---|---|
| `A` | `haushaltsbuch` | IPv4-Adresse des Servers |
| `AAAA` | `haushaltsbuch` | IPv6-Adresse des Servers (nur falls vorhanden) |

Alternativ ein `CNAME` von `haushaltsbuch` auf `svetho.net`, wenn die Hauptdomain auf denselben Server zeigt. Prüfen, ob er schon greift:

```sh
dig +short haushaltsbuch.svetho.net
```

### 2. Programm holen und als Dienst starten

```sh
apt install git python3 nginx certbot python3-certbot-nginx apache2-utils
git clone https://github.com/svethole/haushaltsbuch.git /opt/haushaltsbuch

cp /opt/haushaltsbuch/deploy/haushaltsbuch.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now haushaltsbuch
systemctl status haushaltsbuch          # sollte "active (running)" zeigen
curl -s http://127.0.0.1:8085/api/data | head -c 100
```

Der Dienst läuft unter einem eigenen, automatisch angelegten Benutzer und lauscht nur lokal auf Port 8085. Die Datenbank liegt in `/var/lib/haushaltsbuch/`.

### 3. Passwort anlegen

```sh
htpasswd -c /etc/nginx/htpasswd-haushaltsbuch DEINNAME     # -c nur beim ersten Mal!
htpasswd    /etc/nginx/htpasswd-haushaltsbuch ZWEITERNAME  # optional weiterer Zugang
chown root:www-data /etc/nginx/htpasswd-haushaltsbuch
chmod 640 /etc/nginx/htpasswd-haushaltsbuch
```

### 4. nginx einrichten

```sh
cp /opt/haushaltsbuch/deploy/nginx-haushaltsbuch.conf /etc/nginx/sites-available/haushaltsbuch
ln -s /etc/nginx/sites-available/haushaltsbuch /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

### 5. Zertifikat von Let's Encrypt

```sh
certbot --nginx -d haushaltsbuch.svetho.net
```

Auf die Frage nach der Umleitung von HTTP auf HTTPS mit „Redirect“ antworten (neuere Certbot-Versionen machen das automatisch). Die Verlängerung läuft danach von selbst; testen lässt sie sich mit `certbot renew --dry-run`.

Jetzt sollte `https://haushaltsbuch.svetho.net` nach Benutzername und Passwort fragen.

### 6. Bestehende Daten einspielen

Im Browser unter **Einstellungen → Datensicherung → Sicherung einspielen** die Importdatei (`haushaltsbuch-import.json`) auswählen. Achtung: Das ersetzt alle vorhandenen Daten.

### 7. Tägliche Sicherung

```sh
chmod +x /opt/haushaltsbuch/deploy/backup.sh
crontab -e
# Zeile ergänzen:
15 3 * * * /opt/haushaltsbuch/deploy/backup.sh
```

Die Sicherungen landen in `/var/backups/haushaltsbuch/` und werden 60 Tage aufbewahrt. Zusätzlich kann man in der App jederzeit unter **Einstellungen** eine Sicherung als JSON-Datei herunterladen.

### Aktualisieren

```sh
cd /opt/haushaltsbuch && git pull && systemctl restart haushaltsbuch
```

### Fehlersuche

```sh
journalctl -u haushaltsbuch -n 50      # Meldungen des Dienstes
tail -n 50 /var/log/nginx/error.log    # Meldungen von nginx
```

---

## Schnittstelle (für Neugierige)

Alle Antworten sind JSON, Beträge immer in Cent.

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/data` | alle Daten auf einmal |
| GET | `/api/export` | Sicherungsdatei |
| POST | `/api/import` | Sicherungsdatei einspielen (ersetzt alles) |
| POST/PUT/DELETE | `/api/expenses[/id]` | Ausgaben |
| POST/PUT/DELETE | `/api/categories[/id]` | Kategorien |
| POST | `/api/categories/{id}/merge` | Kategorie in eine andere überführen (`{"into": id}`) |
| POST | `/api/shops/rename` | Geschäft umbenennen/zusammenlegen (`{"from", "to"}`) |
| POST/PUT/DELETE | `/api/pots[/id]`, `/api/pot_tx[/id]` | Spartöpfe und deren Buchungen |
| POST/PUT/DELETE | `/api/recurring[/id]` | regelmäßige Einnahmen und Fixkosten |
