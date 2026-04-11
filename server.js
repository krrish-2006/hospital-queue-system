require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const path = require("path");
const crypto = require("crypto");

const DOCTOR_EMAIL = "krrishjgd@gmail.com";
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-session-secret";

const app = express();

let databasePromise;

function connectToDatabase() {
    if (!process.env.MONGO_URI) {
        return Promise.reject(new Error("MONGO_URI is not configured"));
    }

    if (mongoose.connection.readyState === 1) {
        return Promise.resolve(mongoose.connection);
    }

    if (!databasePromise) {
        databasePromise = mongoose.connect(process.env.MONGO_URI)
            .then((connection) => {
                console.log("MongoDB connected");
                return connection;
            })
            .catch((error) => {
                databasePromise = null;
                throw error;
            });
    }

    return databasePromise;
}

const patientSchema = new mongoose.Schema({
    name: String,
    email: String,
    doctor: String,
    token: Number
});

const sessionSchema = new mongoose.Schema({
    sid: { type: String, unique: true, index: true },
    session: { type: mongoose.Schema.Types.Mixed, required: true },
    expiresAt: {
        type: Date,
        index: { expires: 0 }
    }
});

const Patient = mongoose.models.Patient || mongoose.model("Patient", patientSchema);
const SessionRecord = mongoose.models.SessionRecord || mongoose.model("SessionRecord", sessionSchema);

class MongoSessionStore extends session.Store {
    get(sid, callback) {
        connectToDatabase()
            .then(() => SessionRecord.findOne({ sid }).lean())
            .then((record) => callback(null, record ? record.session : null))
            .catch((error) => callback(error));
    }

    set(sid, sessionData, callback) {
        const expiresAt = sessionData.cookie?.expires
            ? new Date(sessionData.cookie.expires)
            : new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);

        connectToDatabase()
            .then(() => SessionRecord.findOneAndUpdate(
                { sid },
                { sid, session: sessionData, expiresAt },
                { upsert: true, setDefaultsOnInsert: true }
            ))
            .then(() => callback(null))
            .catch((error) => callback(error));
    }

    destroy(sid, callback) {
        connectToDatabase()
            .then(() => SessionRecord.deleteOne({ sid }))
            .then(() => callback(null))
            .catch((error) => callback(error));
    }

    touch(sid, sessionData, callback) {
        const expiresAt = sessionData.cookie?.expires
            ? new Date(sessionData.cookie.expires)
            : new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);

        connectToDatabase()
            .then(() => SessionRecord.updateOne(
                { sid },
                {
                    $set: {
                        expiresAt,
                        "session.cookie": sessionData.cookie
                    }
                }
            ))
            .then(() => callback(null))
            .catch((error) => callback(error));
    }
}

function buildBaseUrl(req) {
    if (process.env.APP_URL) {
        return process.env.APP_URL.replace(/\/$/, "");
    }

    const protocol = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.headers["x-forwarded-host"] || req.get("host");

    return `${protocol}://${host}`;
}

app.set("trust proxy", 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: new MongoSessionStore(),
    cookie: {
        secure: IS_PRODUCTION,
        sameSite: IS_PRODUCTION ? "none" : "lax",
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 * 7
    },
    genid: () => crypto.randomUUID()
}));

app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/auth/google/callback",
    proxy: true
}, (accessToken, refreshToken, profile, done) => done(null, profile)));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

app.get("/test", async (req, res) => {
    try {
        await connectToDatabase();
        res.send("TEST WORKING");
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/auth/google", (req, res, next) => {
    const callbackURL = `${buildBaseUrl(req)}/auth/google/callback`;

    passport.authenticate("google", {
        scope: ["profile", "email"],
        callbackURL
    })(req, res, next);
});

app.get("/auth/google/callback", (req, res, next) => {
    const callbackURL = `${buildBaseUrl(req)}/auth/google/callback`;

    passport.authenticate("google", {
        failureRedirect: "/",
        callbackURL
    })(req, res, next);
}, (req, res) => {
    res.redirect("/");
});

app.get("/user", (req, res) => {
    res.json(req.user || null);
});

app.post("/book", async (req, res) => {
    try {
        await connectToDatabase();

        const user = req.user;

        if (!user) {
            return res.status(401).json({ error: "Login required" });
        }

        const name = user.displayName;
        const email = user.emails[0].value;
        const { doctor } = req.body;

        const existingBooking = await Patient.findOne({ email });
        if (existingBooking) {
            return res.status(409).json({ error: "Booking already active" });
        }

        const last = await Patient.find({ doctor }).sort({ token: -1 }).limit(1);
        const token = last.length ? last[0].token + 1 : 1;

        const patient = new Patient({ name, email, doctor, token });
        await patient.save();

        res.json({ token, id: patient._id });
    } catch (error) {
        console.error("Booking failed:", error);
        res.status(500).json({ error: "Unable to book appointment" });
    }
});

app.get("/queue/:doctor", async (req, res) => {
    try {
        await connectToDatabase();

        const viewerEmail = req.user?.emails?.[0]?.value || null;
        const data = await Patient.find({ doctor: req.params.doctor }).sort({ token: 1 });

        res.json(data.map((patient) => {
            const isOwner = viewerEmail && patient.email === viewerEmail;

            return {
                _id: patient._id,
                token: patient.token,
                isOwner,
                name: isOwner ? patient.name : null
            };
        }));
    } catch (error) {
        console.error("Queue lookup failed:", error);
        res.status(500).json({ error: "Unable to load queue" });
    }
});

app.post("/next/:doctor", async (req, res) => {
    try {
        await connectToDatabase();

        const user = req.user;

        if (!user) {
            return res.status(401).json({ error: "Login required" });
        }

        const email = user.emails[0].value;
        if (email !== DOCTOR_EMAIL) {
            return res.status(403).json({ error: "Only doctor allowed" });
        }

        const doctor = req.params.doctor;
        const first = await Patient.findOne({ doctor }).sort({ token: 1 });

        if (first) {
            await Patient.deleteOne({ _id: first._id });
        }

        res.json({});
    } catch (error) {
        console.error("Queue advance failed:", error);
        res.status(500).json({ error: "Unable to advance queue" });
    }
});

app.post("/cancel", async (req, res) => {
    try {
        await connectToDatabase();

        const user = req.user;

        if (!user) {
            return res.status(401).json({ error: "Login required" });
        }

        const email = user.emails[0].value;
        const { id } = req.body;

        const result = await Patient.deleteOne({ _id: id, email });

        res.json({ deletedCount: result.deletedCount });
    } catch (error) {
        console.error("Cancellation failed:", error);
        res.status(500).json({ error: "Unable to cancel booking" });
    }
});

app.get("/logout", (req, res, next) => {
    req.logout((error) => {
        if (error) {
            return next(error);
        }

        req.session.destroy((sessionError) => {
            if (sessionError) {
                return next(sessionError);
            }

            res.clearCookie("connect.sid");
            res.redirect("/");
        });
    });
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

if (require.main === module) {
    const PORT = process.env.PORT || 3000;

    connectToDatabase()
        .then(() => {
            app.listen(PORT, () => {
                console.log(`Server running on port ${PORT}`);
            });
        })
        .catch((error) => {
            console.error("Failed to start server:", error);
            process.exit(1);
        });
}

module.exports = app;
