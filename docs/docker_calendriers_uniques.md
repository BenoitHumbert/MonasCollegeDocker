# Unicité des calendriers : nettoyage et index en base

À placer dans le dossier Docker du serveur Directus de MonAS Collège (`monas_college_docker`).

Vérifié sur l'environnement local : Directus **12.0.2**, PostgreSQL **13.8** (image `postgis/postgis:13-master`).

## Pourquoi

Le backoffice vérifie qu'un calendrier existe avant de le créer. Si deux navigateurs (deux professeurs, deux onglets, un rechargement) font cette vérification en même temps, chacun crée son calendrier. Le code de l'application ne peut pas empêcher cette course. Seule la base de données le peut, avec un **index unique** sur `(school, category, back_to_school_year)` de la table `calendar`.

Une fois l'index en place, PostgreSQL refuse le second enregistrement et Directus répond par l'erreur `RECORD_NOT_UNIQUE`. Le backoffice sait déjà relire le calendrier existant quand l'insertion échoue.

## Pourquoi pas `docker-entrypoint-initdb.d`

Les scripts placés dans `/docker-entrypoint-initdb.d` ne s'exécutent **qu'à la toute première initialisation**, sur un volume de données vide. La base de production existe déjà : ils seraient ignorés.

## Valeurs à utiliser

- Fichiers compose : `compose.yml` (prod) et `compose.override.yml` (dev, fusionné automatiquement en local).
- Utilisateur PostgreSQL : `directus`. Base : `directus`.
- Conteneurs en local : `monas_college_docker-database-1` et `monas_college_docker-directus-1`. En prod, vérifier les noms avec `docker ps`.

Dans les commandes ci-dessous, `<db>` désigne le conteneur PostgreSQL et `<directus>` le conteneur Directus.

Pour ouvrir une console SQL :

```bash
docker exec -it <db> psql -U directus -d directus
```

## Règle : quel calendrier garder

Dans chaque groupe de doublons, on garde un seul calendrier, choisi dans cet ordre :

1. **celui qui a le plus d'activités**, pour ne jamais supprimer le calendrier où le plus de travail a été saisi ;
2. à nombre d'activités égal, **un calendrier publié** plutôt qu'un calendrier non publié ;
3. en cas d'égalité, **le plus ancien**. C'est celui qu'affiche le backoffice (vérifié en local le 21/10/2026). L'app mobile affiche au contraire le plus récent, mais une fois les doublons supprimés, les deux apps affichent le même calendrier.

Les autres sont supprimés entiers, sans fusion : leurs journées, leurs activités et, par la cascade, les inscriptions, équipes et formulaires de ces activités.

Si un calendrier supprimé était publié et que le calendrier gardé ne l'est pas, le calendrier gardé devient publié. Sinon, les élèves ne verraient plus aucun calendrier.

Avant de valider, la requête 1b et les contrôles de l'étape 2 montrent tout ce qui sera supprimé. Si une activité d'un calendrier supprimé doit être conservée, la recréer à la main dans le calendrier gardé avant l'étape 2.

---

## Étape 0 : sauvegarde (obligatoire)

En prod, arrêter d'abord Directus (`docker compose stop directus`). L'ordre complet est en 3.3.

```bash
docker exec <db> pg_dump -U directus directus > backup_avant_index_$(date +%Y%m%d).sql
```

Vérifier que le fichier n'est pas vide (`ls -lh backup_avant_index_*.sql`).

## Étape 1 : diagnostic (lecture seule)

### 1a. Clés étrangères

Avant tout nettoyage, confirmer que la structure de la prod est la même qu'en local :

```sql
SELECT conrelid::regclass AS table_enfant, a.attname AS colonne,
       confrelid::regclass AS parent,
       CASE confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
                        WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END AS on_delete
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
WHERE contype = 'f'
  AND confrelid IN ('calendar'::regclass, 'sport_day'::regclass, 'activity'::regclass)
ORDER BY parent, table_enfant;
```

Résultat attendu (local) :

| table_enfant | parent | on_delete |
|---|---|---|
| `sport_day.calendar` | calendar | CASCADE |
| `activity.sport_day` | sport_day | CASCADE |
| `registered_user`, `team`, `activity_forms`, `activity_directus_users` | activity | CASCADE |

> ⚠️ **Tout est en cascade.** Supprimer un calendrier supprime ses journées, leurs activités et toutes les inscriptions, équipes et formulaires de ces activités, sans confirmation. L'étape 2 supprime les doublons entiers : vérifier avec la requête 1b et l'essai à blanc ce qui sera perdu avant de valider.

Si la prod montre d'autres tables enfants, s'arrêter et adapter l'étape 2.

### 1b. Calendriers en double

Pour chaque calendrier en double : la décision (gardé ou supprimé, selon la règle ci-dessus), son état de publication, son écart avec le plus ancien du groupe et ce qu'il contient.

```sql
WITH stats AS (
  SELECT c.id, c.school, c.category, c.back_to_school_year, c.date_created, c.is_published,
         (SELECT COUNT(*) FROM sport_day sd WHERE sd.calendar = c.id) AS nb_journees,
         (SELECT COUNT(*) FROM activity a
            JOIN sport_day sd ON a.sport_day = sd.id
           WHERE sd.calendar = c.id) AS nb_activites,
         (SELECT COUNT(*) FROM registered_user ru
            JOIN activity a ON ru.activity = a.id
            JOIN sport_day sd ON a.sport_day = sd.id
           WHERE sd.calendar = c.id) AS nb_inscriptions
  FROM calendar c
),
ranked AS (
  SELECT s.*,
         ROW_NUMBER()      OVER w AS rang,
         MIN(date_created) OVER g AS date_plus_ancien,
         COUNT(*)          OVER g AS nb_doublons
  FROM stats s
  WINDOW g AS (PARTITION BY school, category, back_to_school_year),
         w AS (g ORDER BY nb_activites DESC, is_published IS TRUE DESC, date_created, id)
)
SELECT sc.name AS college, r.category, r.back_to_school_year,
       CASE WHEN r.rang = 1 THEN 'gardé' ELSE 'supprimé' END AS decision,
       r.id, r.is_published, r.date_created,
       r.date_created - r.date_plus_ancien AS ecart_avec_le_plus_ancien,
       r.nb_journees, r.nb_activites, r.nb_inscriptions
FROM ranked r
LEFT JOIN school sc ON sc.id = r.school
WHERE r.nb_doublons > 1
ORDER BY sc.name, r.category, r.back_to_school_year, r.rang;
```

À lire :

- **0 ligne** : aucun doublon.
- Lignes **`supprimé` avec `nb_activites = 0`** : copies vides, rien n'est perdu.
- Lignes **`supprimé` avec `nb_activites > 0`** : ces activités et leurs `nb_inscriptions` inscriptions seront **perdues**. Le détail (date, titre, inscriptions) s'affiche pendant l'essai à blanc de l'étape 2. En parler au professeur concerné avant de valider.
- **`ecart_avec_le_plus_ancien`** indique la cause probable :
  - **quelques secondes** : deux sessions ont créé le calendrier en même temps. C'est exactement ce que l'index empêchera.
  - **des heures ou des jours** : la vérification de l'application n'a pas vu le calendrier existant. Cause probable : les permissions Directus du rôle de l'utilisateur, qui ne lui donnent pas accès à ce calendrier. L'index bloquera aussi ces créations, mais le professeur concerné verra alors une erreur. Noter ces cas pour vérifier les permissions de lecture de `calendar`.

### 1c. Champs vides

PostgreSQL 13 considère deux valeurs `NULL` comme différentes : un calendrier sans école, sans catégorie ou sans année échapperait à l'index. La migration rend donc ces trois colonnes obligatoires, ce qui échoue s'il en reste un.

```sql
SELECT id, school, category, back_to_school_year, date_created
FROM calendar
WHERE school IS NULL OR category IS NULL OR back_to_school_year IS NULL;
```

Doit renvoyer **0 ligne**. Sinon, compléter ou supprimer ces calendriers (en vérifiant d'abord leurs activités).

### 1d. Variantes de catégorie

`"bf"`, `"BF"` et `"bf "` sont trois valeurs différentes pour l'index. Ces calendriers ne seraient pas reconnus comme doublons.

```sql
SELECT s.name AS college, lower(trim(c.category)) AS categorie,
       c.back_to_school_year, array_agg(DISTINCT c.category) AS valeurs_brutes,
       COUNT(*) AS nb
FROM calendar c
LEFT JOIN school s ON s.id = c.school
GROUP BY s.name, c.school, lower(trim(c.category)), c.back_to_school_year
HAVING COUNT(DISTINCT c.category) > 1;
```

Doit renvoyer **0 ligne**. Sinon, signaler ces lignes avant d'aller plus loin : il faut décider à la main quelle valeur garder.

## Étape 2 : suppression des doublons (dans une transaction)

Pour chaque groupe en double, on garde le calendrier désigné par la règle (voir « Règle : quel calendrier garder ») et on supprime les autres entiers, sans fusion. La cascade supprime leurs journées, leurs activités, et les inscriptions, équipes et formulaires de ces activités. Si un calendrier supprimé était publié, le calendrier gardé devient publié.

```sql
BEGIN;

-- Calendriers à supprimer, avec le calendrier gardé de leur groupe
-- (le plus d'activités, puis publié, puis le plus ancien)
CREATE TEMP TABLE a_supprimer ON COMMIT DROP AS
WITH stats AS (
  SELECT c.id, c.school, c.category, c.back_to_school_year, c.date_created, c.is_published,
         (SELECT COUNT(*) FROM activity a
            JOIN sport_day sd ON a.sport_day = sd.id
           WHERE sd.calendar = c.id) AS nb_activites
  FROM calendar c
),
ranked AS (
  SELECT id,
         FIRST_VALUE(id) OVER w AS calendrier_garde,
         ROW_NUMBER()    OVER w AS rang
  FROM stats
  WINDOW w AS (PARTITION BY school, category, back_to_school_year
               ORDER BY nb_activites DESC, is_published IS TRUE DESC, date_created, id)
)
SELECT id AS calendrier, calendrier_garde FROM ranked WHERE rang >= 2;

-- Contrôle 1 : ce qui va être supprimé
SELECT
  (SELECT COUNT(*) FROM a_supprimer) AS calendriers,
  (SELECT COUNT(*) FROM sport_day
    WHERE calendar IN (SELECT calendrier FROM a_supprimer)) AS journees,
  (SELECT COUNT(*) FROM activity a
     JOIN sport_day sd ON a.sport_day = sd.id
    WHERE sd.calendar IN (SELECT calendrier FROM a_supprimer)) AS activites,
  (SELECT COUNT(*) FROM registered_user ru
     JOIN activity a ON ru.activity = a.id
     JOIN sport_day sd ON a.sport_day = sd.id
    WHERE sd.calendar IN (SELECT calendrier FROM a_supprimer)) AS inscriptions;

-- Contrôle 2 : détail des activités qui seront supprimées
SELECT sc.name AS college, c.category, c.back_to_school_year,
       sd.date::date AS jour, a.title, a.is_canceled,
       (SELECT COUNT(*) FROM registered_user ru WHERE ru.activity = a.id) AS inscriptions
FROM a_supprimer f
JOIN calendar c     ON c.id = f.calendrier
LEFT JOIN school sc ON sc.id = c.school
JOIN sport_day sd   ON sd.calendar = c.id
JOIN activity a     ON a.sport_day = sd.id
ORDER BY sc.name, c.category, jour;

-- Publication reportée sur le calendrier gardé
UPDATE calendar c
SET is_published = true
WHERE c.is_published IS NOT TRUE
  AND EXISTS (SELECT 1 FROM a_supprimer f
              JOIN calendar s ON s.id = f.calendrier
              WHERE f.calendrier_garde = c.id AND s.is_published);

-- Suppression (cascade : journées, activités, inscriptions, équipes, formulaires)
DELETE FROM calendar WHERE id IN (SELECT calendrier FROM a_supprimer);

-- Contrôle : relancer ici la requête 1b. Elle doit renvoyer 0 ligne.

ROLLBACK;   -- 1er passage : essai à blanc. Remplacer par COMMIT; une fois les contrôles validés.
```

Le bloc se termine par `ROLLBACK` : un premier passage ne modifie rien et sert à lire les contrôles. Si les chiffres et la liste des activités supprimées sont acceptables, relancer tout le bloc en remplaçant la dernière ligne par `COMMIT;`. Si une commande échoue en cours de route, PostgreSQL annule toute la transaction et rien n'est modifié.

Tant que les requêtes 1b et 1c renvoient des lignes, la migration de l'étape 3 échouera. La requête 1d ne la bloque pas, car des variantes de catégorie sont des valeurs différentes pour l'index. L'index ne les empêchera donc pas non plus : traiter ces lignes avant de continuer.

Après le `COMMIT`, ouvrir les calendriers concernés dans le backoffice **et** dans l'app mobile : un seul calendrier doit apparaître, avec ses activités.

## Étape 3 : créer l'index par une migration Directus

Directus exécute ses migrations à chaque démarrage (`node cli.js bootstrap` dans l'image officielle), y compris les migrations personnalisées. Une migration déjà appliquée est enregistrée dans la table `directus_migrations` et ne se rejoue pas. L'index fait ainsi partie de la configuration : toute base qui contient la table `calendar` et démarre avec ce dossier le reçoit, par exemple une copie de la prod restaurée en local. Pour une base vide, voir la remarque « Base vide » ci-dessous.

> ⚠️ **Dossier des migrations.** Directus 12 lit les migrations personnalisées dans `MIGRATIONS_PATH`, qui vaut **`./migrations`** par défaut, soit **`/directus/migrations`** dans le conteneur. L'ancien emplacement `extensions/migrations` n'est **plus lu** : un fichier qui s'y trouverait serait ignoré sans aucune erreur.

### 3.1 Le fichier de migration

Créer `migrations/20261021Z-calendar-unique.js` à côté de `compose.yml` :

```js
// Unicité des calendriers : un seul calendrier par (école, catégorie, année scolaire).
// Idempotente : peut être rejouée sans erreur, même si l'index existe déjà.

export async function up(knex) {
  // Base vide (installation neuve) : la table n'existe pas encore.
  // Ne rien faire, pour ne pas bloquer le démarrage de Directus.
  if (!(await knex.schema.hasTable('calendar'))) return;

  await knex.transaction(async (trx) => {
    // PostgreSQL 13 considère deux NULL comme différents : sans NOT NULL,
    // un calendrier incomplet échapperait à l'index.
    await trx.raw(`
      ALTER TABLE calendar
        ALTER COLUMN school SET NOT NULL,
        ALTER COLUMN category SET NOT NULL,
        ALTER COLUMN back_to_school_year SET NOT NULL
    `);
    await trx.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS calendar_school_category_year_uniq
        ON calendar (school, category, back_to_school_year)
    `);
  });
}

export async function down(knex) {
  await knex.transaction(async (trx) => {
    await trx.raw('DROP INDEX IF EXISTS calendar_school_category_year_uniq');
    await trx.raw(`
      ALTER TABLE calendar
        ALTER COLUMN school DROP NOT NULL,
        ALTER COLUMN category DROP NOT NULL,
        ALTER COLUMN back_to_school_year DROP NOT NULL
    `);
  });
}
```

Remarques :

- **Syntaxe ESM** (`export`) : `/directus/package.json` déclare `"type": "module"`.
- **Version `20261021Z`** : Directus lit la version dans ce qui précède le premier `-`. Ses migrations internes s'appellent `AAAAMMJJ` + une lettre (la dernière appliquée en local est `20260512B`). Si une future version de Directus utilisait la même clé, il refuserait de démarrer (`Migration keys collide!`). La lettre `Z` rend cette collision très improbable. **Ne pas renommer le fichier** une fois la migration appliquée.
- **Transaction** : Directus n'en ouvre pas lui-même autour d'une migration. Elle est ouverte ici pour qu'un échec ne laisse pas la table à moitié modifiée.
- **Base vide** : sur une installation neuve, Directus crée ses tables système puis lance les migrations, avant que `calendar` existe. Sans la vérification `hasTable`, la migration échouerait et Directus ne pourrait pas s'installer. Avec elle, la migration ne fait rien mais est enregistrée comme appliquée. Une fois les collections recréées, supprimer sa ligne (`DELETE FROM directus_migrations WHERE version = '20261021Z';`) et redémarrer Directus pour qu'elle s'applique.
- **Effet de bord du `NOT NULL`** : dans l'admin Directus, retirer un calendrier de la liste des calendriers d'une école met son champ `school` à vide. Ce sera désormais refusé, ce qui évite de créer un calendrier orphelin.

### 3.2 Monter le dossier dans le conteneur

Dans `compose.yml`, service `directus`, ajouter la ligne du dossier `migrations` aux volumes existants :

```yaml
  directus:
    volumes:
      - directus_uploads:/directus/uploads
      - ./migrations:/directus/migrations
```

Compose fusionne les volumes avec ceux de `compose.override.yml` : la ligne vaut donc aussi en local, sans rien changer à l'override.

### 3.3 Ordre de déploiement

1. **En local d'abord** : lancer les requêtes 1b, 1c et 1d (0 ligne attendue), puis `docker compose up -d directus` et les contrôles de l'étape 4.
2. Commit sur `main`, puis merge de `main` vers `prod`.
3. **En prod**, avec Directus arrêté pendant toute l'opération. Prévoir 10 à 20 minutes de coupure, pendant lesquelles les trois frontends sont indisponibles, de préférence le soir ou le week-end :
   1. `docker compose stop directus` ;
   2. étape 0 (sauvegarde) ;
   3. étape 1 (1a à 1d) ;
   4. étape 2 si besoin : un essai à blanc (`ROLLBACK`), puis le passage réel (`COMMIT`). Relancer ensuite 1b, 1c et 1d (0 ligne) ;
   5. récupérer la branche `prod` (`git pull`) : fichier de migration et `compose.yml` ;
   6. `docker compose up -d directus` : Directus redémarre et applique la migration ;
   7. étape 4.

   Arrêter Directus garantit trois choses : la sauvegarde est cohérente, personne ne peut créer de doublon entre le nettoyage et la migration, et aucune activité ne peut être ajoutée dans une copie pendant le nettoyage. La cascade l'effacerait avec la copie.

> ⚠️ **Ne démarrez pas Directus avec la migration tant qu'il reste des doublons ou des champs vides.** La migration échouerait, `bootstrap` aussi, et avec `restart: always` Directus redémarrerait en boucle. Voir « En cas d'échec au démarrage ».

## Étape 4 : vérification

En prod, `LOG_LEVEL` vaut `error` : la ligne `Applying Calendar Unique...` n'apparaît pas dans les logs. On vérifie donc dans la base.

```bash
docker compose ps directus                        # « Up » depuis plusieurs minutes, pas « Restarting »
docker inspect -f '{{.RestartCount}}' <directus>  # doit rester à 0
docker exec <db> psql -U directus -d directus -c \
  "SELECT version, name, timestamp FROM directus_migrations WHERE version = '20261021Z';"
docker exec <db> psql -U directus -d directus -c "\d calendar"
```

> En local, le conteneur Directus apparaît déjà `unhealthy` : son healthcheck reçoit `403` sur `/server/health`. Ce problème existait avant cette opération. Vérifier en prod, avant l'intervention, s'il s'y produit aussi. Pour juger la migration, se fier à l'absence de redémarrages, pas à l'état de santé.

Attendu :

- une ligne `20261021Z | Calendar Unique` dans `directus_migrations` ;
- dans `\d calendar`, les colonnes `school`, `category` et `back_to_school_year` en `not null`, et l'index `"calendar_school_category_year_uniq" UNIQUE, btree (school, category, back_to_school_year)`.

Test de refus d'un doublon, sans rien enregistrer :

```sql
BEGIN;
INSERT INTO calendar (id, school, category, back_to_school_year, is_published, date_created)
SELECT gen_random_uuid(), school, category, back_to_school_year, false, now()
FROM calendar LIMIT 1;
-- Attendu : ERROR: duplicate key value violates unique constraint "calendar_school_category_year_uniq"
ROLLBACK;
```

Enfin, redémarrer une seconde fois (`docker compose restart directus`) : la migration ne doit pas se rejouer, et `directus_migrations` doit toujours contenir une seule ligne `20261021Z`.

## En cas d'échec au démarrage

Symptôme : le conteneur `directus` redémarre en boucle juste après le déploiement.

1. Lire l'erreur : `docker compose logs --tail 50 directus`.
2. Retirer temporairement la ligne `- ./migrations:/directus/migrations` de `compose.yml` (ou déplacer le fichier hors du dossier `migrations`), puis `docker compose up -d directus`. Directus redémarre sans la migration.
3. Corriger la cause : en général un doublon ou un champ vide restant (requêtes 1b et 1c, puis étape 2), ou une erreur dans le fichier de migration.
4. Remettre la ligne (ou le fichier) et relancer `docker compose up -d directus`.

Grâce à la transaction, une migration qui a échoué ne laisse aucune modification partielle et n'est pas enregistrée dans `directus_migrations` : elle se rejouera au démarrage suivant.

## Retour arrière

```sql
BEGIN;
DROP INDEX IF EXISTS calendar_school_category_year_uniq;
ALTER TABLE calendar
  ALTER COLUMN school DROP NOT NULL,
  ALTER COLUMN category DROP NOT NULL,
  ALTER COLUMN back_to_school_year DROP NOT NULL;
COMMIT;
```

Retirer aussi le fichier de migration : tant que sa ligne existe dans `directus_migrations`, il ne se rejouerait pas, mais il est plus clair de ne pas laisser un fichier inactif. Pour pouvoir le rejouer plus tard, supprimer aussi sa ligne :

```sql
DELETE FROM directus_migrations WHERE version = '20261021Z';
```

## À savoir côté application

L'index empêche les doublons de calendriers. Une correction reste à faire dans le backoffice Flutter, dans un chantier distinct :

- quand deux créations se croisent, la seconde reçoit le calendrier existant comme s'il venait d'être créé, et ajoute ses journées une seconde fois (`CalendarService.createCalendar`, puis `_addCalendarDays` chez les appelants). L'index ne bloque pas ce cas : il faudra que `createCalendar` indique s'il a créé le calendrier ou s'il l'a retrouvé.
