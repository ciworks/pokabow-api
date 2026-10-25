import { buildApp } from "./app.js";
import { config } from "./config.js";

const app = buildApp();

try {
  await app.listen({
    port: config.port,
    host: "192.168.0.189"
  });

  console.log(
    `Game API listening on port ${config.port}`
  );

} catch (error) {
  app.log.error(error);
  process.exit(1);
}