# Railway Environment Variables Checklist

To ensure your backend works in Railway, set these variables in your Railway project dashboard (NOT just in .env):

- `OPENAI_API_KEY` — Your valid OpenAI API key
- `REDIS_URL` — Redis connection string
- `POSTGRES_URL` — Postgres connection string
- `RAILWAY_TOKEN` — Railway API token (if used)
- `GPT4O_MINI_MODEL_ID` — Model ID for GPT-4o-mini
- `GPT5_MINI_MODEL_ID` — Model ID for GPT-5-mini
- `GPT5_2_MODEL_ID` — Model ID for GPT-5.2
- `GPT4O_MODEL_ID` — Model ID for GPT-4o
- `EMBEDDING_MODEL_ID` — Model ID for embeddings

## How to set variables in Railway
1. Go to your Railway project.
2. Click the 'Variables' tab.
3. Add each variable above with its value (copy from your local .env if needed).
4. Redeploy your service after saving.

**Note:**
- `.env` is NOT used in production on Railway unless you upload it as secrets.
- If you change a variable, redeploy for changes to take effect.
- Make sure your OpenAI key is valid and not expired/revoked.
