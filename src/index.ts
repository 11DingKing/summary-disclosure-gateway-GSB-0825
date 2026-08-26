import { buildApp } from "./app";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

buildApp({ logger: true })
  .then((app) => app.listen({ port, host }))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
