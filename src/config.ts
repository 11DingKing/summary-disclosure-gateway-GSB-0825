const toInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: toInt(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  databaseUrl: process.env.DATABASE_URL ?? "file:./dev.db",
  pagination: {
    defaultPageSize: 20,
    maxPageSize: 100,
  },
  policy: {
    v1: {
      minCoveragePermille: 700,
    },
  },
} as const;
