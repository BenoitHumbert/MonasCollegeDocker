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
