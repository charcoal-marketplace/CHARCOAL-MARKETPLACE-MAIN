require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const path = require("path");

const db = require("./config/db");

const app = express();
const PORT = Number(process.env.PORT || 8080);
const APP_NAME = "Charcoal Marketplace API";

app.set("trust proxy", 1);

/* =========================================================
   CONFIGURATION
========================================================= */

const configuredOrigins = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const routeStatus = {};

const requiredTables = [
  "users",
  "products",
  "orders",
  "order_items",
  "payments",
  "payment_logs",
  "cart",
  "earnings",
  "notifications",
  "admin_requests",
  "admin_invitations"
];

let databaseStatus = "checking";

function startupLine() {
  console.log("==================================================");
}

/* =========================================================
   CORS
   Same-origin Railway frontend/API requests do not need CORS.
   CORS remains available for optional external clients.
========================================================= */

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || !configuredOrigins.length) {
        return callback(null, true);
      }

      if (configuredOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("CORS origin not allowed"));
    },
    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS"
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
      "X-Request-ID"
    ],
    credentials: false
  })
);

/* =========================================================
   SECURITY
========================================================= */

app.use(
  helmet({
    crossOriginEmbedderPolicy: false,

    crossOriginOpenerPolicy: false,

    crossOriginResourcePolicy: false,

    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],

        scriptSrc: [
          "'self'",
          "https://sdk.minepi.com"
        ],

        scriptSrcAttr: [
          "'unsafe-inline'"
        ],

        styleSrc: [
          "'self'",
          "'unsafe-inline'"
        ],

        imgSrc: [
          "'self'",
          "data:",
          "blob:",
          "https:"
        ],

        connectSrc: [
          "'self'",
          "https:"
        ],

        fontSrc: [
          "'self'",
          "https:",
          "data:"
        ],

        objectSrc: [
          "'none'"
        ],

        frameAncestors: [
          "'self'"
        ]
      }
    }
  })
);

app.use(compression());

app.use(
  morgan(
    process.env.NODE_ENV === "production"
      ? "combined"
      : "dev"
  )
);

app.use(
  express.json({
    limit: "2mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "2mb"
  })
);

/* =========================================================
   AUTH RATE LIMIT
========================================================= */

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api/auth", authLimiter);

/* =========================================================
   ROOT / STATIC FRONTEND
========================================================= */

const publicRoot = __dirname;

app.get("/", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(publicRoot, "index.html"));
});

/* Friendly aliases for the main HTML pages. */
const pageAliases = {
  "/home": "home.html",
  "/profile": "profile.html",
  "/vendor": "vendor.html",
  "/checkout": "checkout.html",
  "/admin-login": "admin-login.html",
  "/vendor-login": "vendor-login.html",
  "/admin": "admin.html"
};

for (const [url, file] of Object.entries(pageAliases)) {
  app.get(url, (_req, res) => {
    res.redirect(302, `/${file}`);
  });
}

app.use(
  express.static(publicRoot, {
    index: false,
    extensions: false,
    maxAge: 0
  })
);

/* =========================================================
   UPLOADS
========================================================= */

app.use(
  "/uploads",
  express.static(
    path.join(publicRoot, "uploads"),
    {
      maxAge: "7d",
      index: false
    }
  )
);

/* =========================================================
   HEALTH
========================================================= */

app.get("/health", (_req, res) => {
  res.json({
    success: true,
    status: "healthy",
    service: APP_NAME,
    environment:
      process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString()
  });
});

app.get("/api/health", async (_req, res) => {
  let database = "disconnected";

  try {
    await new Promise((resolve, reject) => {
      db.query(
        "SELECT 1 AS connected",
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows);
        }
      );
    });

    database = "connected";
  } catch {}

  const failedRoutes =
    Object.values(routeStatus).filter(
      route => route.status !== "loaded"
    );

  const loadedRoutes =
    Object.values(routeStatus).filter(
      route => route.status === "loaded"
    );

  const healthy =
    database === "connected" &&
    failedRoutes.length === 0;

  res.status(healthy ? 200 : 503).json({
    success: healthy,
    status: healthy ? "healthy" : "degraded",
    service: APP_NAME,
    environment:
      process.env.NODE_ENV || "development",
    database,
    routes: {
      total: Object.keys(routeStatus).length,
      loaded: loadedRoutes.length,
      failed: failedRoutes.length
    },
    pi: {
      api_key:
        process.env.PI_API_KEY
          ? "configured"
          : "missing",
      super_admin:
        process.env.PI_SUPER_ADMIN_USERNAME
          ? "configured"
          : "missing"
    },
    cors: {
      configured: configuredOrigins.length > 0,
      origins: configuredOrigins.length
    },
    timestamp: new Date().toISOString()
  });
});

app.get("/api/health/routes", (_req, res) => {
  const routes =
    Object.entries(routeStatus).map(
      ([name, info]) => ({
        name,
        status: info.status,
        mount: info.mount,
        file: info.file,
        ...(info.error
          ? { error: info.error }
          : {})
      })
    );

  const failed =
    routes.filter(
      route => route.status !== "loaded"
    );

  res.status(failed.length ? 503 : 200).json({
    success: failed.length === 0,
    total: routes.length,
    loaded:
      routes.filter(
        route => route.status === "loaded"
      ).length,
    failed: failed.length,
    routes
  });
});

app.get("/api/health/database", async (_req, res) => {
  const tables = {};
  let failedCount = 0;

  for (const table of requiredTables) {
    try {
      await new Promise(
        (resolve, reject) => {
          db.query(
            `SELECT 1 FROM \`${table}\` LIMIT 1`,
            err => {
              if (err) return reject(err);
              resolve();
            }
          );
        }
      );

      tables[table] = {
        status: "OK"
      };
    } catch (error) {
      failedCount++;

      tables[table] = {
        status: "MISSING_OR_ERROR",
        error: error.message
      };
    }
  }

  const success = failedCount === 0;

  res.status(success ? 200 : 503).json({
    success,
    database: success ? "READY" : "NOT READY",
    total: requiredTables.length,
    working:
      requiredTables.length - failedCount,
    failed: failedCount,
    tables
  });
});

/* =========================================================
   ROUTE LOADER
========================================================= */

function loadRoute(
  routeName,
  mountPath,
  routeFile
) {
  try {
    const router = require(routeFile);

    if (!router) {
      throw new Error("Router returned empty value");
    }

    app.use(mountPath, router);

    routeStatus[routeName] = {
      status: "loaded",
      mount: mountPath,
      file: routeFile
    };

    console.log(
      `✅ ${mountPath} → ${routeFile} LOADED`
    );

    return true;
  } catch (error) {
    routeStatus[routeName] = {
      status: "failed",
      mount: mountPath,
      file: routeFile,
      error: error.message
    };

    console.error(
      `❌ ${mountPath} → ${routeFile} FAILED`
    );
    console.error(
      `   ERROR: ${error.stack || error.message}`
    );

    return false;
  }
}

/* =========================================================
   API ROUTES
========================================================= */

console.log("");
startupLine();
console.log("🔌 LOADING API ROUTES");
startupLine();

loadRoute(
  "auth",
  "/api/auth",
  "./routes/auth.routes"
);

loadRoute(
  "products",
  "/api/products",
  "./routes/product.routes"
);

loadRoute(
  "orders",
  "/api/orders",
  "./routes/orders.routes"
);

loadRoute(
  "payments",
  "/api/payments",
  "./routes/payment.routes"
);

loadRoute(
  "admin",
  "/api/admin",
  "./routes/admin.routes"
);

loadRoute(
  "admin-request",
  "/api/admin-request",
  "./routes/adminRequest.routes"
);

loadRoute(
  "notifications",
  "/api/notifications",
  "./routes/notifications.routes"
);

startupLine();
console.log("🔌 ROUTE LOADING FINISHED");
startupLine();
console.log("");

/* =========================================================
   404
========================================================= */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
    path: req.originalUrl,
    method: req.method
  });
});

/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

app.use((err, req, res, _next) => {
  console.error("==================================================");
  console.error("❌ SERVER ERROR");
  console.error("Message:", err.message);
  console.error("Path:", req.originalUrl);
  console.error("Method:", req.method);
  console.error("==================================================");

  if (
    err.message ===
    "CORS origin not allowed"
  ) {
    return res.status(403).json({
      success: false,
      message: "Origin not allowed"
    });
  }

  return res.status(500).json({
    success: false,
    message: "Internal server error"
  });
});

/* =========================================================
   DATABASE STARTUP CHECK
========================================================= */

db.query(
  "SELECT 1 AS connected",
  err => {
    if (err) {
      databaseStatus = "disconnected";
      console.error("");
      startupLine();
      console.error("❌ MYSQL CONNECTION FAILED");
      console.error(err.message);
      startupLine();
    } else {
      databaseStatus = "connected";
      console.log("");
      startupLine();
      console.log("✅ MYSQL CONNECTED SUCCESSFULLY");
      startupLine();
    }
  }
);

/* =========================================================
   SERVER START
========================================================= */

app.listen(PORT, () => {
  console.log("");
  startupLine();
  console.log("🚀 CHARCOAL MARKETPLACE");
  startupLine();
  console.log(`✅ Server running on port ${PORT}`);
  console.log(
    `🌐 Environment: ${
      process.env.NODE_ENV || "development"
    }`
  );
  console.log("");
  console.log(
    `🗄️ Database status: ${databaseStatus}`
  );
  console.log("");
  console.log(
    routeStatus.auth?.status === "loaded"
      ? "✅ Auth routes ready"
      : "❌ Auth routes FAILED"
  );
  console.log(
    process.env.PI_API_KEY
      ? "✅ PI_API_KEY configured"
      : "⚠️ PI_API_KEY missing"
  );
  console.log(
    process.env.PI_SUPER_ADMIN_USERNAME
      ? "✅ PI_SUPER_ADMIN_USERNAME configured"
      : "⚠️ PI_SUPER_ADMIN_USERNAME missing"
  );
  console.log("");
  startupLine();
  console.log("🟢 SERVER STARTUP COMPLETE");
  startupLine();
  console.log("");
});
