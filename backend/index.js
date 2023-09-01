const express = require("express")
const cors = require("cors")
const mongoose = require("mongoose")
const jwt = require("jsonwebtoken")
const bcrypt = require("bcryptjs")
const cookieParser = require("cookie-parser")
const ws = require("ws")
const fs = require("fs")
const app = express()
require("dotenv").config()
const User = require("./models/User")
const Message = require("./models/Message")

app.use(express.json())
app.use(cors(({
    credentials: true,
    origin: process.env.frontendUrl,
})))
app.use(cookieParser())
// to use the uploads directory in the server
app.use("/uploads", express.static(__dirname + "/uploads"))

mongoose.connect(process.env.mongoUrl)


app.get("/test", (req, res) => {
    res.json("alles ok")
})

app.post("/register", async (req, res) => {
    const { username, password } = req.body
    try {
        const existingUser = await User.findOne({ username })
        if (existingUser) {
            return res.status(400).json({ message: 'Username already exists' });
        }
        const hashedPassword = bcrypt.hashSync(password, bcrypt.genSaltSync(12))
        const createdUser = await User.create({
            username: username,
            password: hashedPassword
        })
        jwt.sign({ userId: createdUser._id, username }, process.env.jwtCle, { expiresIn: "1h" }, (er, token) => {
            if (er) console.error(er)
            res.cookie("token", token, { sameSite: "none", secure: "true" }).status(201).json({
                id: createdUser._id
            })
        })
    }
    catch (er) {
        if (er) console.error(er)
        res.status(500).json("error by Register")
    }
})

app.post("/login", async (req, res) => {
    const { username, password } = req.body
    try {
        const foundUser = await User.findOne({ username })
        if (foundUser) {
            const passOk = bcrypt.compareSync(password, foundUser.password)
            if (passOk) {
                jwt.sign({ userId: foundUser._id, username }, process.env.jwtCle, { expiresIn: "1h" }, (er, token) => {
                    if (er) console.error(er)
                    res.cookie("token", token, { sameSite: "none", secure: "true" }).status(201).json({
                        id: foundUser._id
                    })
                })
            }
        }
    }
    catch (er) {
        if (er) console.error(er)
        res.status(500).json("error by Login")
    }
})

app.post('/logout', (req, res) => {
    res.cookie('token', '', { sameSite: 'none', secure: true }).json('ok');
});

app.get("/profile", (req, res) => {
    const token = req.cookies?.token
    if (token) {
        jwt.verify(token, process.env.jwtCle, {}, (er, userData) => {
            if (er) console.error(er)
            res.json(userData)
        })
    }
    else {
        res.status(401).json("no token")
    }
})
app.get("/messages/:userId", async (req, res) => {
    const { userId } = req.params
    const userData = await getUserDataFromRequest(req)
    const ourUserId = userData.userId
    const messages = await Message.find({
        sender: { $in: [userId, ourUserId] },
        recipient: { $in: [userId, ourUserId] }
    }).sort({ createdAt: 1 })// with createdAt 1 first message on top last message on buttom
    res.json(messages)
})
async function getUserDataFromRequest(req) {
    return new Promise((resolve, reject) => {
        const token = req.cookies?.token
        if (token) {
            jwt.verify(token, process.env.jwtCle, {}, (err, userData) => {
                if (err) console.error(err)
                resolve(userData)
            })
        }
        else {
            reject("no token")
        }
    })
}
app.get("/people", async (req, res) => {
    const users = await User.find({}, { "_id": 1, username: 1 })
    res.json(users)
})

const server = app.listen(process.env.port, () => {
    console.log("app listening on Port 4000...")
})

const wss = new ws.WebSocketServer({ server })
wss.on("connection", (con, req) => {
    // con.send("hello")
    // console.log(req.headers)
    const cookies = req.headers.cookie
    if (cookies) {
        const cookieString = cookies.split(";").find(str => str.startsWith("token="))
        if (cookieString) {
            const token = cookieString.split("=")[1]
            if (token) {
                jwt.verify(token, process.env.jwtCle, {}, (er, userData) => {
                    if (er) console.error(er)
                    const { userId, username } = userData
                    con.userId = userId
                    con.username = username
                })
            }
        }
    }
    //kill old cons
    con.isAlive = true
    con.timer = setInterval(() => {
        con.ping()
        con.deathTimer = setTimeout(() => {
            con.isAlive = false
            clearInterval(con.timer)
            con.terminate()
            //notify again about online People
            notifyAboutOnlinePeople()
            console.log("dead")
        }, 1000)
    }, 3000)
    con.on("pong", () => {
        clearTimeout(con.deathTimer)
    })
    // console.log([...wss.clients].map(c=>c.username))
    function notifyAboutOnlinePeople() {
        [...wss.clients].forEach(client => {
            client.send(JSON.stringify({
                online: [...wss.clients].map(c => ({ userId: c.userId, username: c.username }))
            }))
        })
    }
    notifyAboutOnlinePeople()
    con.on("message", async (message) => {
        const messageData = JSON.parse(message.toString())
        const { recipient, text, file } = messageData
        let filename = null
        if (file) {
            console.log("size", file.data.length)
            const parts = file.name.split(".")
            const ext = parts[parts.length - 1]
            filename = Date.now() + "." + ext
            const path = __dirname + "/uploads/" + filename
            const bufferData = new Buffer(file.data.split(",")[1], "base64")
            fs.writeFile(path, bufferData, () => {
                console.log("file saved: " + path)
            })
        }
        if (recipient && (text || file)) {
            const messageDoc = await Message.create({
                sender: con.userId,
                recipient,
                text,
                file: file ? filename : null
            })
            console.log("created message");
            [...wss.clients].filter(c => c.userId === recipient).forEach(c => c.send(JSON.stringify({
                text,
                sender: con.userId,
                recipient,
                file: file ? filename : null,
                _id: messageDoc._id
            })))
        }
    })

})

