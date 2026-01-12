import { createApp } from "./app";
import { env } from "./env";
import { dbHealthcheck } from "./db";

async function main() {
  await dbHealthcheck();

  const app = createApp();
  app.listen(env.PORT, () => {
    console.log(`API rodando em http://localhost:${env.PORT}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
