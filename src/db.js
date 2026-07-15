import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://user:password@localhost:5432/your_db',
});

export const query = (text, params) => pool.query(text, params);
export const end = () => pool.end();

export default {
  query,
  end,
};
