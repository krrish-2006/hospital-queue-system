const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { Server } = require('socket.io');
require('dotenv').config();

const app = express();

// TEST ROUTE
app.get('/test', (req, res) => {
    res.send("TEST WORKING");
});

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

// DB
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("MongoDB Connected"));

// GOOGLE AUTH
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

// MODEL
const Patient = mongoose.model('Patient', {
    name: String,
    email: String,
    doctor: String,
    token: Number
});

// SOCKET WILL BE SET AFTER SERVER START
let io;

// SEND QUEUE
async function sendQueue(doctor) {
    const data = await Patient.find({ doctor }).sort({ token: 1 });
    io.emit(`queue-${doctor}`, data);
}

// ROUTES
app.post('/book', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Login required" });

    const name = req.user.displayName;
    const email = req.user.emails[0].value;
    const { doctor } = req.body;

    const last = await Patient.find({ doctor }).sort({ token: -1 }).limit(1);
    const token = last.length ? last[0].token + 1 : 1;

    const p = new Patient({ name, email, doctor, token });
    await p.save();

    await sendQueue(doctor);
    res.json({ token, id: p._id });
});

app.get('/queue/:doctor', async (req, res) => {
    const data = await Patient.find({ doctor: req.params.doctor }).sort({ token: 1 });
    res.json(data);
});

app.post('/next/:doctor', async (req, res) => {
    const first = await Patient.findOne({ doctor: req.params.doctor }).sort({ token: 1 });
    if (first) await Patient.deleteOne({ _id: first._id });

    await sendQueue(req.params.doctor);
    res.json({});
});

app.post('/cancel', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Login required" });

    const email = req.user.emails[0].value;
    const { id, doctor } = req.body;

    await Patient.deleteOne({ _id: id, email });
    await sendQueue(doctor);

    res.json({});
});

// AUTH
app.get('/auth/google',
    passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/' }),
    (req, res) => res.redirect('/')
);

app.get('/user', (req, res) => {
    console.log("USER ROUTE HIT");
    res.json(req.user || null);
});

app.get('/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
});

// STATIC
const path = require('path');
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 🔥 START SERVER (ONLY ONCE)
const server = app.listen(process.env.PORT, () => {
    console.log("Server running on port " + process.env.PORT);
});

// SOCKET
io = new Server(server, { cors: { origin: "*" } });