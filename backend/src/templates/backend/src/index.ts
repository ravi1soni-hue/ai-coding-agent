import express from 'express';

const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

app.use(express.json());

app.get('/api/health', async (_req: any, res: any) => {
  // Keep this template lightweight: just indicate the service is up.
  // Projects that require full DB-backed endpoints will generate their own backend/src implementation.
  res.json({ status: 'ok', db: 'not-configured' });
});

app.get('/api/echo', (req: any, res: any) => {
  res.json({ message: 'NebulaDrive backend template running', query: req.query });
});

app.listen(port, () => {
  console.log(`NebulaDrive backend listening on port ${port}`);
});
