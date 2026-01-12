import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { env } from "./env";
import { authRoutes } from "./routes/auth.routes";
import { meRoutes } from "./routes/me.routes";
import { projectsRoutes } from "./routes/projects.routes";
import { suggestionsRoutes } from "./routes/suggestions.routes";
import { backlogRoutes } from "./routes/backlog.routes";
import { adminRoutes } from "./routes/admin.routes";
import { errorHandler } from "./middleware/errorHandler";
import { adminUsersRoutes } from "./routes/admin.users.routes";
import { adminMembershipRoutes } from "./routes/admin.memberships.routes";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: false }));
  app.use(express.json({ limit: "1mb" }));

  app.use(rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
  }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use("/api", authRoutes);
  app.use("/api", meRoutes);
  app.use("/api", projectsRoutes);
  app.use("/api", suggestionsRoutes);
  app.use("/api", backlogRoutes);
  app.use("/api", adminRoutes);
	app.use("/api", adminUsersRoutes);
	app.use("/api", adminMembershipRoutes);

  app.use(errorHandler);

  return app;
}
