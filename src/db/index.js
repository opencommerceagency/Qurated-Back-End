// Import the pg module to interact with PostgreSQL
import pg from 'pg';

// I explicitly delete these environment variables from process.env 
// to prevent the pg library from picking up any unexpected global 
// configurations that might conflict with my explicit Pool config below.
delete process.env.PGUSER;
delete process.env.PGPASSWORD;
delete process.env.PGDATABASE;
delete process.env.PGPORT;
delete process.env.PGHOST;

// Destructure the Pool class from the pg default export
const { Pool } = pg;

// Initialize a new connection pool. This is the primary database 
// connection object used throughout the application to run queries.
// It uses a pool rather than a single client to handle multiple 
// concurrent requests efficiently.
export const pool = new Pool({
  user: 'qurated', // Default local development user
  host: '127.0.0.1', // Connect to localhost since the DB runs in Docker on the host network
  database: 'qurated_db', // The target database name
  password: 'qurated_dev_password', // Dev password
  port: 5433, // IMPORTANT: Docker maps 5432 inside the container to 5433 on the host!
});

// Export it as default so it can be imported cleanly
export default pool;
