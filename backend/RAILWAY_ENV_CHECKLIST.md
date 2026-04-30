# Railway Environment Variables Checklist

To ensure your backend works in Railway, set these variables in your Railway project dashboard (NOT just in .env):

- `OPENAI_API_KEY` — Your valid OpenAI API key
- `REDIS_URL` — Redis connection string
- `POSTGRES_URL` — Postgres connection string
- `RAILWAY_TOKEN` — Railway API token (if used)
- `GPT4O_MINI_MODEL` — Preferred model alias for GPT-4o-mini (example: `gpt-4o-mini`)
- `GPT5_MINI_MODEL` — Preferred model alias for GPT-5-mini (example: `gpt-5-mini`)
- `GPT5_2_MODEL` — Preferred model alias for orchestration model (example: `gpt-5-2`)
- `GPT4O_MODEL` — Preferred model alias for GPT-4o (example: `gpt-4o`)
- `EMBEDDING_MODEL` — Preferred model alias for embeddings (provider-specific)

Per-model API keys (recommended when your provider issues different keys per model):
- `GPT4O_MINI_API_KEY`
- `GPT5_MINI_API_KEY`
- `GPT5_2_API_KEY`
- `GPT4O_API_KEY`
- `EMBEDDING_API_KEY`

Legacy (optional):
- `GPT4O_MINI_MODEL_ID`, `GPT5_MINI_MODEL_ID`, `GPT5_2_MODEL_ID`, `GPT4O_MODEL_ID`, `EMBEDDING_MODEL_ID`
- In this codebase these legacy `*_MODEL_ID` values are treated as API key fallback fields for backward compatibility.
- Prefer the explicit `*_API_KEY` variables above for new setups.

## How to set variables in Railway
1. Go to your Railway project.
2. Click the 'Variables' tab.
3. Add each variable above with its value (copy from your local .env if needed).
4. Redeploy your service after saving.

**Note:**
- `.env` is NOT used in production on Railway unless you upload it as secrets.
- If you change a variable, redeploy for changes to take effect.
- Make sure your API key is valid and not expired/revoked.
- Keep model aliases (`*_MODEL`) and API keys (`*_API_KEY`) separate.
