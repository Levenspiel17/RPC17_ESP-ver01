import express from "express";
import { createServer as createViteServer } from "vite";
import { google } from "googleapis";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(cookieParser());

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", env: { 
    hasClientId: !!process.env.GOOGLE_CLIENT_ID,
    hasClientSecret: !!process.env.GOOGLE_CLIENT_SECRET,
    appUrl: process.env.APP_URL
  }});
});

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${process.env.APP_URL || 'http://localhost:3000'}/auth/google/callback`
);

// --- Auth Routes ---

app.get("/api/auth/google/url", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/drive.metadata.readonly",
      "https://www.googleapis.com/auth/userinfo.profile"
    ],
    prompt: "consent"
  });
  res.json({ url });
});

app.get("/auth/google/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code as string);
    // In a real app, store this in a database. Here we use a cookie for simplicity.
    // GUIDELINE: SameSite: 'none' and Secure: true are required for iframes
    res.cookie("google_tokens", JSON.stringify(tokens), {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    });

    res.send(`
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
          <p>Authentication successful. This window should close automatically.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Google Auth Error:", error);
    res.status(500).send("Authentication failed");
  }
});

app.get("/api/auth/status", (req, res) => {
  const tokens = req.cookies.google_tokens;
  res.json({ isAuthenticated: !!tokens });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("google_tokens", {
    secure: true,
    sameSite: "none"
  });
  res.json({ success: true });
});

// --- Sheets API Routes ---

const getAuthenticatedClient = (tokens: any) => {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  client.setCredentials(tokens);
  return client;
};

app.get("/api/sheets/list", async (req, res) => {
  const tokensStr = req.cookies.google_tokens;
  if (!tokensStr) return res.status(401).json({ error: "Not authenticated" });

  try {
    const tokens = JSON.parse(tokensStr);
    const auth = getAuthenticatedClient(tokens);
    const drive = google.drive({ version: "v3", auth });
    
    const response = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.spreadsheet'",
      fields: "files(id, name, modifiedTime)",
      orderBy: "modifiedTime desc",
      pageSize: 20
    });

    res.json(response.data.files);
  } catch (error) {
    console.error("List Sheets Error:", error);
    res.status(500).json({ error: "Failed to list spreadsheets" });
  }
});

app.get("/api/sheets/:spreadsheetId", async (req, res) => {
  const { spreadsheetId } = req.params;
  const tokensStr = req.cookies.google_tokens;
  if (!tokensStr) return res.status(401).json({ error: "Not authenticated" });

  try {
    const tokens = JSON.parse(tokensStr);
    const auth = getAuthenticatedClient(tokens);
    const sheets = google.sheets({ version: "v4", auth });

    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId
    });

    const sheetData = await Promise.all(
      (spreadsheet.data.sheets || []).map(async (sheet) => {
        const name = sheet.properties?.title || "Sheet1";
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `${name}!A1:Z100` // Limiting for performance/demo
        });
        return {
          name,
          data: response.data.values || []
        };
      })
    );

    res.json({
      name: spreadsheet.data.properties?.title,
      sheets: sheetData
    });
  } catch (error) {
    console.error("Get Sheet Error:", error);
    res.status(500).json({ error: "Failed to fetch spreadsheet data" });
  }
});

// --- Vite Middleware ---

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
