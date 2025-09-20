require("dotenv").config(); 

const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const multer = require("multer");
const fs = require("fs");
const fetch = require("node-fetch");
const { v4: uuidv4 } = require("uuid");
const i18n = require("i18n");

const app = express();
const PORT = process.env.PORT || 4087;
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  // Or simply: connectionString: process.env.DATABASE_URL
});
pool.connect()
  .then(() => console.log("✅ Connected to PostgreSQL"))
  .catch(err => console.error("❌ DB connection error:", err));

async function ensureTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        department_name TEXT,
        department_id TEXT,
        mobile_no BIGINT,
        otp TEXT,
        otp_expires TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS codinCluc (
        id SERIAL PRIMARY KEY,
        case_id TEXT UNIQUE,
        subject TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT,
        image_path TEXT,
        mobile_no BIGINT NOT NULL,
        location TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        status TEXT DEFAULT 'Submitted'
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS LoginDeatails (
        id SERIAL PRIMARY KEY,
        first_name VARCHAR(100) NOT NULL,
        last_name VARCHAR(100) NOT NULL,
        gender VARCHAR(20) NOT NULL,
        age INT CHECK (age >= 5 AND age <= 120),
        email_id VARCHAR(100) NOT NULL,
        address VARCHAR(250) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS missing_persons (
        id SERIAL PRIMARY KEY,
        case_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        age INT,
        gender TEXT,
        last_seen_date DATE,
        last_seen_location TEXT,
        description TEXT,
        media_path TEXT,
        reporter_mobile BIGINT,
        status TEXT DEFAULT 'Active',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log("✅ Tables ensured");
  } catch (err) {
    console.error("❌ Table creation error:", err);
  }
}

i18n.configure({
  locales: ["en", "hi", "bh", "bn"],
  defaultLocale: "en",
  cookie: "locale",
  directory: path.join(__dirname, "locales"),
  objectNotation: true,
  autoReload: true, 
  syncFiles: true, 
});

app.use(i18n.init);

app.use((req, res, next) => {
  if (req.query.lang) {
    res.cookie('locale', req.query.lang, { maxAge: 900000, httpOnly: true });
    return res.redirect('back');
  }
  next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/public", express.static(path.join(__dirname, "views", "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.use((req, res, next) => {
  res.locals.getMediaPath = (path) => {
    if (path && path.startsWith('/uploads/')) {
      return path;
    }
    return 'https://via.placeholder.com/320x200?text=No+Image';
  };
  next();
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "uploads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

function generateCaseId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "CASE-";
  for (let i = 0; i < 6; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

app.get("/", async (req, res) => {
  try {
    const statsResult = await pool.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'Resolved') AS resolved
       FROM codinCluc`
    );

    const total = parseInt(statsResult.rows[0].total, 10) || 0;
    const resolved = parseInt(statsResult.rows[0].resolved, 10) || 0;
    const pending = total - resolved;

    res.render("home", { stats: { total, resolved, pending } });
  } catch (err) {
    console.error("Error fetching complaint stats for homepage:", err);
    res.render("home", { stats: { total: 0, resolved: 0, pending: 0 } });
  }
});

app.get("/adminLogin", (req, res) => res.render("adminLogin", { message: null }));

app.post("/adminLogin", async (req, res) => {
  const { name, department_name, department_id, mobile_no } = req.body;
  if (!name || !department_name || !department_id || !mobile_no) {
    return res.json({ success: false, message: "All fields are required" });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = new Date(Date.now() + 5 * 60 * 1000);

  try {
    const existingAdmin = await pool.query(
      "SELECT id FROM admins WHERE department_id = $1",
      [department_id]
    );

    if (existingAdmin.rows.length > 0) {
      await pool.query(
        "UPDATE admins SET otp = $1, otp_expires = $2 WHERE department_id = $3",
        [otp, expires, department_id]
      );
    } else {
      await pool.query(
        `INSERT INTO admins (name, department_name, department_id, mobile_no, otp, otp_expires) VALUES ($1, $2, $3, $4, $5, $6)`,
        [name, department_name, department_id, mobile_no, otp, expires]
      );
    }

    console.log(`📩 OTP for ${name} (${department_id}): ${otp}`);
    res.json({ success: true, otp });
  } catch (err) {
    console.error("Error generating OTP:", err);
    res.json({ success: false, message: "Server error" });
  }
});

app.post("/verify-admin-otp", async (req, res) => {
  const { otpInput } = req.body;
  try {
    const result = await pool.query(
      "SELECT * FROM admins WHERE otp=$1 AND otp_expires > NOW() ORDER BY created_at DESC LIMIT 1",
      [otpInput]
    );
    if (result.rows.length === 0) return res.render("adminLogin", { message: "❌ Invalid or expired OTP" });
    res.redirect("/adminDashboard");
  } catch (err) {
    console.error(err);
    res.render("adminLogin", { message: "Database error" });
  }
});

app.get("/adminDashboard", async (req, res) => {
  try {
    const complaintsResult = await pool.query("SELECT * FROM codinCluc ORDER BY created_at DESC");
    const missingPersonsResult = await pool.query("SELECT * FROM missing_persons ORDER BY created_at DESC");
    res.render("adminDashboard", {
      complaints: complaintsResult.rows,
      missing_persons: missingPersonsResult.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Database error");
  }
});

app.get("/map-view", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT case_id, subject, location, status FROM codinCluc WHERE location IS NOT NULL AND location <> ''"
    );
    res.render("map", { complaints: result.rows });
  } catch (err) {
    console.error("Error fetching complaints for map:", err);
    res.status(500).send("Error loading map data");
  }
});

app.post("/mark-resolved/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("UPDATE codinCluc SET status='Resolved' WHERE id=$1", [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.json({ success: false });
  }
});

app.get("/userLogin", (req, res) => res.render("userLogin", { message: null }));

app.post("/userLogin", async (req, res) => {
  const { first_name, last_name, gender, age, email_id, address } = req.body;
  if (!first_name || !last_name || !gender || !age || !email_id || !address) {
    return res.render("userLogin", { message: "All fields are required" });
  }

  try {
    const result = await pool.query(
      "SELECT * FROM LoginDeatails WHERE first_name=$1 AND last_name=$2 LIMIT 1",
      [first_name, last_name]
    );

    if (result.rows.length === 0) {
      const insertResult = await pool.query(
        `INSERT INTO LoginDeatails (first_name, last_name, gender, age, email_id, address)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [first_name, last_name, gender, age, email_id, address]
      );
      return res.redirect('/?login=success');
    }

    res.redirect('/?login=success');
  } catch (err) {
    console.error(err);
    res.render("userLogin", { message: "Database error" });
  }
});

app.get("/complain", (req, res) => res.render("complain"));
app.get("/complainform", (req, res) => {
  const category = req.query.category || "Parks & Trees";
  res.render("complainform", { category });
});

app.get("/cycloneComplainform", (req, res) => {
  res.render("cycloneComplain");
});

app.post("/send-otp", async (req, res) => {
  const { mobile } = req.body;
  if (!mobile || !/^\d{10}$/.test(mobile)) {
    return res.status(400).json({ success: false, message: "Invalid mobile number." });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  console.log(`📱 OTP for ${mobile}: ${otp}`);

  res.json({
    success: true,
    message: "OTP sent successfully.",
    otp: otp,
  });
});

app.post("/submitComplaint", upload.single("media"), async (req, res) => {
  try {
    const { subject, description, location, mobile, otp, category } = req.body;
    const image_path = req.file ? "/uploads/" + req.file.filename : null;

    if (!subject || !description || !location || !category)
      return res.status(400).json({ success: false, message: "Missing required fields." });

    const caseId = generateCaseId();

    await pool.query(
      `INSERT INTO codinCluc (case_id, subject, description, category, image_path, location, mobile_no)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [caseId, subject, description, category, image_path, location ,mobile]
    );

    res.json({
      success: true,
      caseId: caseId,
      subject: subject,
      category: category,
      location: location,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Error submitting complaint to the database." });
  }
});

app.get("/complaint-submitted", (req, res) => {
  const { caseId, subject, location, status, category } = req.query;

  res.render("submit_success", {
    caseId: caseId || "N/A",
    subject: subject || "N/A",
    location: location || "N/A",
    status: status || "Submitted",
    category: category || "N/A"
  });
});

app.get("/trackStatus", (req, res) => {
  res.render("trackStatusForm", { complaint: null, message: null });
});

app.post("/trackStatus", async (req, res) => {
  const { caseId } = req.body;

  if (!caseId) {
    return res.render("trackStatusForm", { complaint: null, message: "⚠️ Please enter a Case ID" });
  }

  try {
    const result = await pool.query(
      "SELECT * FROM codinCluc WHERE UPPER(case_id) = UPPER($1)",
      [caseId.trim()]
    );

    if (result.rows.length === 0) {
      return res.render("trackStatusForm", { complaint: null, message: "❌ Case ID not found" });
    }

    const complaint = result.rows[0];

    const getStatusColor = (status) => {
      switch (status) {
        case "Submitted": return "#ff9800";
        case "In Review": return "#2196f3";
        case "Resolved": return "#4caf50";
        case "Closed": return "#9e9e9e";
        default: return "#000";
      }
    };

    res.render("trackStatusForm", { complaint, message: null, getStatusColor });
  } catch (err) {
    console.error("Error fetching complaint:", err);
    res.render("trackStatusForm", { complaint: null, message: "⚠️ Server error" });
  }
});

app.get("/my-complaints", (req, res) => {
  res.render("myComplaints", { complaints: [], mobile: null });
});

app.post("/my-complaints", async (req, res) => {
  const { mobile } = req.body;
  if (!mobile) {
    return res.render("myComplaints", { complaints: [], mobile: null, message: "Please enter a mobile number." });
  }
  try {
    const result = await pool.query(
      "SELECT * FROM codinCluc WHERE mobile_no = $1 ORDER BY created_at DESC",
      [mobile]
    );
    res.render("myComplaints", { complaints: result.rows, mobile: mobile });
  } catch (err) {
    console.error("Error fetching user complaints:", err);
    res.render("myComplaints", { complaints: [], mobile: mobile, message: "Error fetching complaints." });
  }
});

app.get("/fetchDetail", (req, res) => res.render("fetchDetail"));

app.get("/api/admins", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name, department_name, department_id, mobile_no FROM admins ORDER BY id");
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("Error fetching admins:", err);
    res.status(500).json({ success: false, message: "Server error while fetching admins" });
  }
});

app.get("/api/users", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, first_name, last_name, gender, age, address, email_id FROM LoginDeatails ORDER BY id");
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).json({ success: false, message: "Server error while fetching users" });
  }
});

app.get("/contactus", (req, res) => res.render("contactus", { message: null }));

app.get("/safety", (req, res) => {
  res.render("safety");
});

app.get("/emergency", (req, res) => {
  res.render("emergency");
});

app.get("/news", (req, res) => {
  res.render("news");
});

app.get("/api/news", async (req, res) => {
  const category = req.query.category || 'disaster';
  // TODO: Replace "YOUR_NEWSAPI_KEY_HERE" with your actual NewsAPI key.
  // For better security, store this key in an environment variable.
  const apiKey = process.env.NEWS_API_KEY || "YOUR_NEWSAPI_KEY_HERE";

  if (apiKey === "YOUR_NEWSAPI_KEY_HERE") {
    return res.status(500).json({
      status: "error",
      code: "apiKeyMissing",
      message: "NewsAPI key is not configured on the server."
    });
  }

  const query = category === "all" ? "earthquake OR flood OR cyclone OR drought OR landslide OR tsunami OR snow" : category;
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=en&sortBy=publishedAt&apiKey=${apiKey}`;

  try {
    const newsResponse = await fetch(url);
    const newsData = await newsResponse.json();
    res.json(newsData);
  } catch (error) {
    console.error("Error fetching news from NewsAPI:", error);
    res.status(500).json({
      status: "error",
      message: "Failed to fetch news from the provider."
    });
  }
});

app.get("/missing-complaint", (req, res) => {
  res.render("missing");
});

app.post("/submit-missing-person", upload.single("media"), async (req, res) => {
  try {
    const { name, age, gender, lastSeen, location, description, reporter_mobile } = req.body;
    const media_path = req.file ? "/uploads/" + req.file.filename : null;

    if (!name || !age || !gender || !lastSeen || !location || !reporter_mobile) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    const caseId = generateCaseId();

    await pool.query(
      `INSERT INTO missing_persons (case_id, name, age, gender, last_seen_date, last_seen_location, description, media_path, reporter_mobile)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [caseId, name, age, gender, lastSeen, location, description, media_path, reporter_mobile]
    );

    res.json({
      success: true,
      caseId: caseId,
      message: "Missing person report submitted successfully."
    });
  } catch (err) {
    console.error("Error submitting missing person report:", err);
    res.status(500).json({ success: false, message: "Error submitting report to the database." });
  }
});

app.get("/missing-persons", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM missing_persons ORDER BY created_at DESC");
    // This route is for the public list page, which is currently linked from the admin dashboard
    res.render("missing_persons_list", { missing_persons: result.rows });
  } catch (err) {
    console.error("Error fetching missing persons for public list:", err);
    res.status(500).send("Error fetching missing person reports.");
  }
});

ensureTables().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
});

