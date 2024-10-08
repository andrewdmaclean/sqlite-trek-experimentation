import dotenv from "dotenv";

dotenv.config({ path: "../../.env" });

import startDevCycle from "./devcycle.js";
import sqlite3 from "sqlite3";
import { createClient } from "@libsql/client"; // Turso Client
import { Database } from "@sqlitecloud/drivers";
import { App } from "@tinyhttp/app";
import ejs from "ejs";
import { urlencoded } from "milliparsec";
import sirv from "sirv";

// Configurations from environment variables
const CONFIG = {
  LOCAL_SQLITE: process.env.LOCAL_SQLITE,
  TURSO: {
    URL: process.env.TURSO_URL,
    AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
  },
  SQLITE_CLOUD_CONNECTION: process.env.SQLITE_CLOUD_CONNECTION,
};

// Search function to filter Star Trek series
const searchStarTrekSeries = (searchTerm, data) =>
  data.find(
    (item) =>
      [item.series_name, item.captain, item.description].some((field) =>
        field.toLowerCase().includes(searchTerm.toLowerCase())
      ) ||
      item.crew
        .split(",")
        .some((crewMember) =>
          crewMember.trim().toLowerCase().includes(searchTerm.toLowerCase())
        )
  );

// Query functions for databases
const queryLocalSQLite = (searchTerm) =>
  new Promise((resolve, reject) => {
    const db = new sqlite3.Database(CONFIG.LOCAL_SQLITE);
    db.all("SELECT * FROM star_trek_series", (err, rows) => {
      db.close();
      if (err) reject(err);
      resolve(searchStarTrekSeries(searchTerm, rows));
    });
  });

const queryTurso = async (searchTerm) => {
  const client = createClient({
    url: CONFIG.TURSO.URL,
    authToken: CONFIG.TURSO.AUTH_TOKEN,
  });
  const response = await client.execute("SELECT * FROM star_trek_series");
  return searchStarTrekSeries(searchTerm, response.rows);
};

const querySQLiteCloud = async (searchTerm) => {
  const db = new Database(CONFIG.SQLITE_CLOUD_CONNECTION);
  const response = await db.sql(`
    USE DATABASE test;
    SELECT * FROM star_trek_series;
  `);
  return searchStarTrekSeries(searchTerm, response);
};

function generateUserId() {
  return "user_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
}

async function run() {
  const devcycleClient = await startDevCycle();
  const app = new App();
  app.engine("ejs", ejs.renderFile);
  app.use(urlencoded());
  app.use(sirv("public")).listen(3000);

  let fullHost, hostname;

  app.use((req, res, next) => {
    req.user = {
      user_id: generateUserId(),
    };
    fullHost = req.headers.host;
    hostname = fullHost.split(":")[0];
    next();
  });

  app.get("/", (req, res) => {
    res.render("index.ejs", {
      query_time: null,
      db_type: null,
      data: null,
      host: `http://${hostname}:5000`,
    });
  });

  app.post("/search", async (req, res) => {
    const { user } = req;
    const searchTerm = req.body.query;
    const startTime = Date.now();

    if (!searchTerm) {
      return res.status(400).render("index.ejs", {
        query_time: null,
        db_type: null,
        data: "Please provide a search term",
        host: `http://${hostname}:5000`,
      });
    }

    try {
      const flag = devcycleClient.variable(
        user,
        "sqlite-trek-experiment",
        "local"
      );
      const dbQueries = {
        local: { query: queryLocalSQLite, dbType: "Local SQLite" },
        turso: { query: queryTurso, dbType: "Turso" },
        cloud: { query: querySQLiteCloud, dbType: "SQLite Cloud" },
      };
      const { query, dbType } = dbQueries[flag.value] || dbQueries.turso;

      const result = await query(searchTerm);
      const responseTime = Date.now() - startTime;

      res.render("index.ejs", {
        query_time: `${responseTime}ms`,
        db_type: dbType,
        data: result?.series_name
          ? result
          : `No results found for '${searchTerm}'`,
        host: `http://${hostname}:5000`,
      });

      // Track response time
      res.on("finish", () =>
        devcycleClient.track(user, {
          type: "response_time",
          value: responseTime,
        })
      );
    } catch (error) {
      res.status(500).render("index.ejs", {
        query_time: null,
        db_type: null,
        data: "Internal Server Error",
        host: `http://${hostname}:5000`,
      });
    }
  });

  return app;
}

export default run;
