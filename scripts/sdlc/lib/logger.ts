// Structured logger.
// Emits one JSON line per log entry to stdout so GH Actions can parse them.

type Level = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  ts: string;
  level: Level;
  msg: string;
  [key: string]: unknown;
}

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  // GH Actions handles plain stdout fine; JSON makes future log search trivial.
  console.log(JSON.stringify(entry));
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};
