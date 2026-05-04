import express from 'express';
import { Client } from 'pg';

const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 3000;
const postgresUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL || '';

app.use(express.json());

app.get('/api/health', async (req, res) => {
  if (!postgresUrl) {
    return res.json({ status: 'ok', database: 'disabled' });
  }

  const client = new Client({ connectionString: postgresUrl });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    return res.status(500).json({ status: 'error', database: 'failed', error: String(error) });
  } finally {
    await client.end();
  }
});

app.get('/api/echo', (req, res) => {
  res.json({ message: 'Generated backend is running.', query: req.query });
});

app.listen(port, () => {
  console.log(`Generated backend listening on port ${port}`);
});
