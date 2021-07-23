const express = require("express");
const cors = require("cors");
const app = express();
const asyncRedis = require("async-redis");
const redisClient = asyncRedis.createClient();
const axios = require("axios");
const credentials = require("./credentials");

app.use(cors());

// listen to port
const port = process.env.PORT || 3000;
let server = app.listen(port, function () {
  console.log(`listening to port ${port}...`);
});

// set up socket io with redis
const io = require("socket.io")(server, {
  cors: {
    origin: "*",
  },
});
const redisAdapter = require("socket.io-redis");
io.adapter(redisAdapter({ host: "localhost", port: 6379 }));

app.use(express.json());

const bufferTime = 5000;
const refreshInterval = 10000;

// Help functions
async function getUser(authorization) {
  let query = await axios({
    method: "get",
    url: "https://api.twitch.tv/helix/users",
    headers: {
      Authorization: authorization,
      "Client-ID": credentials.clientId,
    },
  });
  return query.data.data[0];
}

async function getRoom(name) {
  let users = await redisClient.hgetall(name + "::users");
  delete users["connections"];
  let queue = await redisClient.lrange(name + "::queue", 0, -1);
  for (let i = 0; i < queue.length; i++) {
    queue[i] = JSON.parse(queue[i]);
  }
  return {
    name: await redisClient.hget(name, "name"),
    description: await redisClient.hget(name, "description"),
    image: await redisClient.hget(name, "image"),
    queueLimit: parseInt(await redisClient.hget(name, "queueLimit")),
    currentMedia: JSON.parse(await redisClient.hget(name, "currentMedia")),
    likes: parseInt(await redisClient.hget(name + "::votes", "likes")),
    dislikes: parseInt(await redisClient.hget(name + "::votes", "dislikes")),
    queue: queue,
    connections: parseInt(
      await redisClient.hget(name + "::users", "connections")
    ),
    users: users,
  };
}

app.get("/signInUrl", function (req, res) {
  try {
    res.status(200).json({
      url: `https://id.twitch.tv/oauth2/authorize?response_type=code&client_id=${credentials.clientId}&redirect_uri=${credentials.returnURL}&scope=${credentials.scope}`,
    });
  } catch (err) {
    console.log(err);
    res.status(500).send("unknown error");
  }
});

app.get("/signIn", async function (req, res) {
  try {
    let code = req.query.code;
    try {
      var query = await axios({
        method: "post",
        url: `https://id.twitch.tv/oauth2/token?client_id=${credentials.clientId}&client_secret=${credentials.clientSecret}&code=${code}&grant_type=authorization_code&redirect_uri=http://localhost:8080/signIn`,
      });
    } catch (err) {
      res
        .status(err.response.status)
        .send(`twitch api responded with status ${err.response.status}`);
      return;
    }
    res.status(200).json({
      token: query.data.access_token,
      clientID: credentials.clientId,
    });
  } catch (err) {
    console.log(err);
    res.status(500).send("unknown error");
  }
});

app.get("/rooms", async function (req, res) {
  try {
    let roomPreviews = [];
    let rooms = (await redisClient.scan(0))[1];
    for (let i = 0; i < rooms.length; i++) {
      if (!rooms[i].includes(":")) {
        roomPreviews.push({
          name: await redisClient.hget(rooms[i], "name"),
          description: await redisClient.hget(rooms[i], "description"),
          image: await redisClient.hget(rooms[i], "image"),
          connections: parseInt(
            await redisClient.hget(rooms[i] + "::users", "connections")
          ),
        });
      }
    }
    res.status(200).json(roomPreviews);
  } catch (err) {
    console.log(err);
    res.status(500).send("unknown error");
  }
});

app.get("/rooms/:name", async function (req, res) {
  try {
    if (!(await redisClient.exists(req.params.name))) {
      res.status(404).send("room not found");
      return;
    }
    res.status(200).send(await getRoom(req.params.name));
  } catch (err) {
    console.log(err);
    res.status(500).send("unknown error");
  }
});

app.post("/create", async function (req, res) {
  try {
    // authenticate user
    try {
      var user = await getUser(req.header("Authorization"));
    } catch (err) {
      res
        .status(err.response.status)
        .send(`twitch api responded with status ${err.response.status}`);
      return;
    }

    // just during alpha testing
    if (user.display_name != "erobb15") {
      res.status(403).send("Create is disabled during alpha testing :(");
      return;
    }

    // validate room
    if (await redisClient.exists(req.body.name)) {
      res.status(400).send("room name already exists");
      return;
    } else if (
      req.body.name == null ||
      req.body.description == null ||
      req.body.image == null
    ) {
      res.status(400).send("missing one or more body params");
      return;
    } else if (!/^[a-zA-Z0-9]{4,30}$/.test(req.body.name)) {
      res.status(400).send("name is invalid");
      return;
    } else if (!/^.[^;{}]{4,200}$/.test(req.body.description)) {
      res.status(400).send("description is invalid");
      return;
    } else if (
      !/^https:\/\/[a-z0-9]+\.[a-z0-9]+\.[a-z0-9]+\/.+$/.test(req.body.image)
    ) {
      res
        .status(400)
        .send(
          "image link is invalid (make sure it is in the form: https://subdomain.domain.ending/..."
        );
      return;
    }
    // create the room
    await redisClient.hset(
      req.body.name,
      "name",
      req.body.name,
      "owner",
      user.display_name,
      "description",
      req.body.description,
      "image",
      req.body.image,
      "queueLimit",
      25
    );
    await redisClient.hset(
      req.body.name + "::votes",
      "likes",
      0,
      "dislikes",
      0
    );
    await redisClient.hset(req.body.name + "::users", "connections", 0);
    // await redisClient.lpush(req.body.name + "::queue", "_");
    let room = await getRoom(req.body.name);
    res.status(201).json(room);
  } catch (err) {
    console.log(err);
    res.status(500).send("unknown error");
  }
});

// function from stack overflow
function YTDurationToSeconds(duration) {
  let match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
  match = match.slice(1).map(function (x) {
    if (x != null) {
      return x.replace(/\D/, "");
    }
  });
  let hours = parseInt(match[0]) || 0;
  let minutes = parseInt(match[1]) || 0;
  let seconds = parseInt(match[2]) || 0;
  return hours * 3600 + minutes * 60 + seconds;
}

app.post("/enqueue", async function (req, res) {
  try {
    // authenticate user
    try {
      var user = await getUser(req.header("Authorization"));
    } catch (err) {
      res
        .status(err.response.status)
        .send(`twitch api responded with status ${err.response.status}`);
      return;
    }

    // check if room exists
    if (!(await redisClient.exists(req.body.room))) {
      res.status(404).send("room not found");
      return;
    }

    // check if video at end of queue is same as one being added
    let lastInQueue = JSON.parse(
      await redisClient.lindex(req.body.room + "::queue", -1)
    );
    if (lastInQueue != null && lastInQueue.id == req.body.id) {
      res.status(400).send("media id was just added to queue");
      return;
    }

    // check if queue is full
    let queueLength = await redisClient.llen(req.body.room + "::queue");
    let queueLimit = parseInt(
      await redisClient.hget(req.body.room, "queueLimit")
    );
    if (queueLength != null && queueLength >= queueLimit) {
      res.status(400).send("queue is full");
      return;
    }

    let newMedia = {};
    // Validate based on host
    if (req.body.host == "youtube") {
      if (!/^[A-Za-z0-9_-]{11}$/.test(req.body.id)) {
        res.status(400).send("invalid youtube id");
        return;
      }
      try {
        var query = await axios({
          method: "get",
          url: `https://www.googleapis.com/youtube/v3/videos?part=snippet%2C+contentDetails%2C+status&id=${req.body.id}&key=${credentials.youtubeKey}`,
        });
        query = query.data;
      } catch (err) {
        res.status(400).send(`youtube responded with ${err.response.status}`);
        return;
      }
      if (query.items.length != 1) {
        res.status(400).send("youtube id not found");
        return;
      }
      if (query.items[0].kind != "youtube#video") {
        res.status(400).send("not of type youtube#video");
        return;
      }
      if (!query.items[0].status.embeddable) {
        res.status(400).send("not embeddable");
        return;
      }
      let duration = YTDurationToSeconds(
        query.items[0].contentDetails.duration
      );
      newMedia["duration"] = duration;
      newMedia["title"] = query.items[0].snippet.title;
    } else if (req.body.host == "streamable") {
      try {
        var query = await axios({
          method: "get",
          url: `https://api.streamable.com/videos/${req.body.id}`,
        });
        query = query.data;
      } catch (err) {
        res
          .status(400)
          .send(`streamable responded with ${err.response.status}`);
        return;
      }
      newMedia["duration"] = Math.ceil(query.files.original.duration);
      newMedia["title"] = query.title;
    } else if (req.body.host == "twitch") {
      try {
        var query = await axios({
          method: "get",
          url: `https://api.twitch.tv/helix/clips?id=${req.body.id}`,
          headers: {
            Authorization: req.header("Authorization"),
            "Client-ID": credentials.clientId,
          },
        });
        query = query.data;
      } catch (err) {
        res.status(400).send(`twitch responded with ${err.response.status}`);
        return;
      }
      if (query.data.length != 1) {
        res.status(404).send("clip not found");
        return;
      }
      let clip = query.data[0];
      newMedia["title"] = clip.title;
      newMedia["duration"] = clip.duration;
    } else {
      res.status(400).send("invalid host");
      return;
    }
    newMedia["host"] = req.body.host;
    newMedia["id"] = req.body.id;
    newMedia["addedBy"] = user.display_name;

    // add to queue
    await redisClient.rpush(
      req.body.room + "::queue",
      JSON.stringify(newMedia)
    );

    // tell everyone to enqueue
    io.to(req.body.room).emit("enqueue", newMedia);

    // play if queue is empty
    if (!(await redisClient.hexists("::dequeues", req.body.room))) {
      console.log(req.body.room + " - FIRST IN QUEUE");
      popAndPlay(req.body.room);
    }

    res.status(200).json(newMedia);
  } catch (err) {
    console.log(err);
    res.status(500).send("unknown error");
  }
});

app.post("/vote", async function (req, res) {
  try {
    // authenticate user
    try {
      var user = await getUser(req.header("Authorization"));
    } catch (err) {
      res
        .status(err.response.status)
        .send(`twitch api responded with status ${err.response.status}`);
      return;
    }

    if (req.body.room == null || req.body.vote == null) {
      res.status(400).send("undefined body vars");
      return;
    }
    if (!(await redisClient.exists(req.body.room))) {
      res.status(404).send("room not found");
      return;
    }

    // 0: remove/no vote, 1 like, -1 dislike

    // fetch like an dislike data
    let likes = parseInt(
      await redisClient.hget(req.body.room + "::votes", "likes")
    );
    let dislikes = parseInt(
      await redisClient.hget(req.body.room + "::votes", "dislikes")
    );
    let voted = await redisClient.hexists(
      req.body.room + "::votes",
      user.display_name
    );
    let oldVote = voted
      ? await redisClient.hget(req.body.room + "::votes", user.display_name)
      : 0;
    console.log(`likes: ${likes}, dislikes: ${dislikes}, old vote: ${oldVote}`);

    // remove vote if voted
    if (oldVote == 1) {
      console.log("deleting like");
      console.log(likes - 1);
      await redisClient.hdel(req.body.room + "::votes", user.display_name);
      await redisClient.hset(req.body.room + "::votes", "likes", likes - 1);
    } else if (oldVote == -1) {
      console.log(dislikes - 1);
      console.log("deleting dislike");
      await redisClient.hdel(req.body.room + "::votes", user.display_name);
      await redisClient.hset(
        req.body.room + "::votes",
        "dislikes",
        dislikes - 1
      );
    }

    // add new vote
    let voteStatus = 0;
    if (req.body.vote == oldVote) {
      voteStatus = 0;
    } else if (req.body.vote == 1) {
      await redisClient.hset(req.body.room + "::votes", user.display_name, 1);
      await redisClient.hset(req.body.room + "::votes", "likes", likes + 1);
      voteStatus = 1;
    } else if (req.body.vote == -1) {
      await redisClient.hset(req.body.room + "::votes", user.display_name, -1);
      await redisClient.hset(
        req.body.room + "::votes",
        "dislikes",
        dislikes + 1
      );
      voteStatus = -1;
    } else if (req.body.vote != 0) {
      res.status(400).send("invalid vote");
      return;
    }

    let newLikes = parseInt(
      await redisClient.hget(req.body.room + "::votes", "likes")
    );
    let newDislikes = parseInt(
      await redisClient.hget(req.body.room + "::votes", "dislikes")
    );

    io.to(req.body.room).emit("updateVotes", {
      likes: newLikes,
      dislikes: newDislikes,
    });

    // Check if skip
    if (voteStatus == -1) {
      if (
        (newDislikes > 3 && newDislikes > newLikes / 4 + newLikes) ||
        user.display_name == "erobb15"
      ) {
        await redisClient.hset(
          "::dequeues",
          req.body.room,
          Date.now() - bufferTime
        );
        io.to(req.body.room).emit("skipping");
        // reset votes
        await redisClient.del(req.body.room + "::votes");
        await redisClient.hset(req.body.room + "::votes", "likes", 0);
        await redisClient.hset(req.body.room + "::votes", "dislikes", 0);
      }
    }

    res.status(200).json({ voteStatus });
  } catch (err) {
    console.log(err);
    res.status(500).send("unknown error");
  }
});

// socket
io.on("connection", (socket) => {
  // User joins to room
  socket.on("join", async (room) => {
    if (typeof room != "string") {
      socket.emit("error", "invalid room param");
      return;
    }
    if (!(await redisClient.exists(room))) {
      socket.emit("error", "room not found");
      return;
    }
    socket.join(room);
    io.to(room).emit("join");

    // Increment connections
    let connections = parseInt(
      await redisClient.hget(room + "::users", "connections")
    );
    connections++;
    await redisClient.hset(room + "::users", "connections", connections);

    // User leaves room
    socket.on("disconnecting", async () => {
      let joinedRooms = Array.from(socket.rooms);
      let room = joinedRooms[1];
      io.to(room).emit("leave");

      // Decrement connections
      let connections = parseInt(
        await redisClient.hget(room + "::users", "connections")
      );
      connections--;
      await redisClient.hset(room + "::users", "connections", connections);

      // Remove user if exists
      if (socket.userName != null) {
        io.to(room).emit("removeUser", socket.userName);
        await redisClient.hdel(room + "::users", socket.userName);
      }
    });
  });

  // add to user list
  socket.on("addUser", async (obj) => {
    try {
      let user = await getUser("Bearer " + obj.token);
      await redisClient.hset(
        obj.room + "::users",
        user.display_name,
        user.profile_image_url
      );
      socket.userName = user.display_name;
      let userObj = {};
      userObj[user.display_name] = user.profile_image_url;
      io.to(obj.room).emit("addUser", userObj);
    } catch (err) {
      socket.emit("error", "failed to add user: " + err);
    }
  });
});

// dequeue manager
async function popAndPlay(room) {
  let media = JSON.parse(await redisClient.lpop(room + "::queue"));
  if (media == null) {
    // end of queue reached
    redisClient.hdel("::dequeues", room);
    return;
  }
  console.log(`POP AND PLAY: ${media.id} to ${room}`);
  io.to(room).emit("play", media);
  await redisClient.hset(
    "::dequeues",
    room,
    Date.now() + bufferTime + media.duration * 1000
  );

  // set current media
  media.endTime =
    parseInt(await redisClient.hget("::dequeues", room)) - bufferTime;
  await redisClient.hset(room, "currentMedia", JSON.stringify(media));

  // Reset liked
  await redisClient.del(room + "::votes");
  await redisClient.hset(room + "::votes", "likes", 0);
  await redisClient.hset(room + "::votes", "dislikes", 0);
  io.to(room).emit("updateVotes", {
    likes: parseInt(await redisClient.hget(room + "::votes", "likes")),
    dislikes: parseInt(await redisClient.hget(room + "::votes", "dislikes")),
  });
}

setInterval(async function () {
  try {
    console.log("... scanning");
    let dequeues = await redisClient.hgetall("::dequeues");
    for (let room in dequeues) {
      if (parseInt(dequeues[room]) < Date.now()) {
        console.log(`.... time ${room}`);
        popAndPlay(room);
        io.to(room).emit("dequeue");
      } else {
        console.log(`.... not yet time ${room}`);
      }
    }
    console.log("... finished scanning");
  } catch (err) {
    console.log("DEQUEUE ERROR " + err);
  }
}, refreshInterval);
