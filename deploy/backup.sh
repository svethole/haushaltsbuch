#!/bin/sh
# Tägliche Sicherung der Haushaltsbuch-Datenbank, behält die letzten 60 Tage.
# Einrichten (als root):  crontab -e  →  15 3 * * * /opt/haushaltsbuch/deploy/backup.sh
set -eu
SRC=/var/lib/haushaltsbuch/haushaltsbuch.db
DEST=/var/backups/haushaltsbuch
mkdir -p "$DEST"
chmod 700 "$DEST"
FILE="$DEST/haushaltsbuch-$(date +%F).db"
# Konsistente Kopie auch während der Server läuft
python3 -c "import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()" "$SRC" "$FILE"
find "$DEST" -name 'haushaltsbuch-*.db' -mtime +60 -delete
