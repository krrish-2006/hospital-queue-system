
console.log("🔥 SERVER FILE IS RUNNING");
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

/* ================= MIDDLEWARE ================= */

app.use(express.json());

app.use(cors({
    origin: [
        "http://localhost:5500",
        "https://hospital-queue-system-yp10.onrender.com"
    ],
    credentials: true
}));

app.set('trust proxy', 1);

app.use(session({
    secret: 'secret123',
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: true,
        sameSite: "none"
    }
}));

app.use(passport.initialize());
app.use(passport.session());

/* ================= DATABASE ================= */

mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("MongoDB Connected"))
.catch(err => console.error("MongoDB Error:", err));

/* ================= PASSPORT ================= */

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "https://hospital-queue-system-yp10.onrender.com/auth/google/callback"
},
(accessToken, refreshToken, profile, done) => {
    return done(null, profile);
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

/* ================= MODEL ================= */

const Patient = mongoose.model('Patient', {
    name: String,
    email: String,
    doctor: String,
    token: Number
});

/* ================= SOCKET ================= */

async function sendQueue(doctor) {
    const data = await Patient.find({ doctor }).sort({ token: 1 });
    io.emit(`queue-${doctor}`, data);
}

/* ================= ROUTES ================= */

// TEST
app.get('/test', (req, res) => {
    res.send("TEST WORKING");
});

// GOOGLE LOGIN
app.get('/auth/google',
    passport.authenticate('google', { scope: ['profile', 'email'] })
);

// CALLBACK
app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/' }),
    (req, res) => {
        res.redirect('/');
    }
);

// GET USER
app.get('/user', (req, res) => {
    res.json(req.user || null);
});

// BOOK
app.post('/book', async (req, res) => {
    const user = req.user;

    if (!user) return res.status(401).json({ error: "Login required" });

    const name = user.displayName;
    const email = user.emails[0].value;
    const { doctor } = req.body;

    const last = await Patient.find({ doctor })
        .sort({ token: -1 })
        .limit(1);

    const token = last.length ? last[0].token + 1 : 1;

    const p = new Patient({ name, email, doctor, token });
    await p.save();

    await sendQueue(doctor);

    res.json({ token, id: p._id });
});

// GET QUEUE
app.get('/queue/:doctor', async (req, res) => {
    const data = await Patient.find({ doctor: req.params.doctor })
        .sort({ token: 1 });

    res.json(data);
});

// NEXT
app.post('/next/:doctor', async (req, res) => {
    const doctor = req.params.doctor;

    const first = await Patient.findOne({ doctor }).sort({ token: 1 });

    if (first) {
        await Patient.deleteOne({ _id: first._id });
    }

    await sendQueue(doctor);

    res.json({});
});

// CANCEL
app.post('/cancel', async (req, res) => {
    const user = req.user;

    if (!user) return res.status(401).json({ error: "Login required" });

    const email = user.emails[0].value;
    const { id, doctor } = req.body;

    await Patient.deleteOne({ _id: id, email });

    await sendQueue(doctor);

    res.json({});
});

// LOGOUT
app.get('/logout', (req, res) => {
    req.logout(() => {
        res.redirect('/');
    });
});

/* ================= STATIC ================= */

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

/* ================= SERVER ================= */

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});