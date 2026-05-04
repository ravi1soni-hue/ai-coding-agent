import { pgQuery } from './postgres';

export type DatabaseQueryResult<T> = T[];

export async function query<T = unknown>(sql: string, params: unknown[] = []): Promise<DatabaseQueryResult<T>> {
  return pgQuery<T>(sql, params);
}

export { pgQuery };
