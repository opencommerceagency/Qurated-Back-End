// Migration runner using node-pg-migrate
import { runner } from 'node-pg-migrate';
import dotenv from 'dotenv';
dotenv.config();

// Run pending database migrations safely
export async function runMigrations() {
  // Connect using the database URL from the environment
  const databaseUrl = process.env.DATABASE_URL || 'postgres://qurated:qurated_dev_password@127.0.0.1:5433/qurated_db';

  // Apply pending migrations without destructive schema drops
  await runner({
    databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    verbose: true,
  });
}

// Run when executed directly
runMigrations().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});