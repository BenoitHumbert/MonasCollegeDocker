#!/bin/sh

DB_PASSWORD_FILE="/run/secrets/database_password"

# Lire le mot de passe sécurisé
if [ -f "$DB_PASSWORD_FILE" ]; then
  DB_PASSWORD=$(cat "$DB_PASSWORD_FILE")
else
  echo "$(date): ERREUR : Fichier de mot de passe introuvable à $DB_PASSWORD_FILE"
  exit 1
fi

DB_HOST="database"
DB_PORT="5432"
DB_NAME="directus"
DB_USER="directus"

# Exécuter la purge SQL
PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "
DELETE FROM directus_activity
WHERE timestamp < NOW() - INTERVAL '30 days';
"