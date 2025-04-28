#!/bin/bash

# Ce script exécute manuellement le script de purge dans le container cron-purger

# Nom du container (à adapter si besoin)
CONTAINER_NAME="monas_college_docker-cron-purger-1"

echo "⏳ Lancement manuel de la purge Directus..."

docker exec -it $CONTAINER_NAME /usr/local/bin/purge_directus_activity_secure.sh

echo "✅ Purge terminée."

# monascollegedocker-directus-1