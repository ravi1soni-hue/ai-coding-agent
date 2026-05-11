/**
 * Centralised debug logger. Emits nothing unless DEBUG=true is set in the
 * environment, keeping log volume well below Railway's 500 logs/sec limit in
 * production while still being useful during local development.
 */
const serialize = (data: any): string =>
  data !== undefined ? ' ' + JSON.stringify(data, (_k, v) => (typeof v === 'string' ? v.slice(0, 400) : v)) : '';

export const debug = (label: string, data?: any): void => {
  if (process.env.DEBUG === 'true') {
    // eslint-disable-next-line no-console
    console.log(`[${label}]${serialize(data)}`);
  }
};

export const warn = (label: string, data?: any): void => {
  // Warnings are always emitted — they indicate degraded behaviour, not
  // routine progress, so the volume stays low.
  // eslint-disable-next-line no-console
  console.warn(`[${label}]${serialize(data)}`);
};

export const error = (label: string, data?: any): void => {
  // Errors are always emitted.
  // eslint-disable-next-line no-console
  console.error(`[${label}]${serialize(data)}`);
};
