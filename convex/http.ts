import { httpRouter } from "convex/server";
import { registerAuthRoutes } from "./routes/auth";
import { registerStripeRoutes } from "./routes/stripe";
import { registerApiRoutes } from "./routes/api";
import { registerMcpRoutes } from "./routes/mcp";
import { registerHealthRoutes } from "./routes/health";
import { registerOgRoutes } from "./routes/og";

// Each route module is owned by one agent; this file only composes them.
const http = httpRouter();
registerAuthRoutes(http);
registerStripeRoutes(http);
registerApiRoutes(http);
registerMcpRoutes(http);
registerHealthRoutes(http);
registerOgRoutes(http);
export default http;
