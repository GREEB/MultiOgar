// Library imports
var WebSocket = require('ws');
var http = require('http');
var fs = require("fs");
var ini = require('./modules/ini.js');
var os = require("os");
var QuadNode = require('./QuadNode.js');
var PlayerCommand = require('./modules/PlayerCommand');

// Project imports
var Packet = require('./packet');
var PlayerTracker = require('./PlayerTracker');
var PacketHandler = require('./PacketHandler');
var Entity = require('./entity');
var Gamemode = require('./gamemodes');
var BotLoader = require('./ai/BotLoader');
var Logger = require('./modules/log');

// GameServer implementation
function GameServer() {
    // Startup
    this.run = true;
    this.lastNodeId = 1;
    this.lastPlayerId = 1;
    this.clients = [];
    this.largestClient; // Required for spectators
    this.nodes = [];
    this.nodesVirus = [];   // Virus nodes
    this.nodesEjected = []; // Ejected mass nodes
    this.quadTree = null;

    this.currentFood = 0;
    this.movingNodes = []; // For move engine
    this.leaderboard = [];
    this.leaderboardType = -1; // no type

    this.bots = new BotLoader(this);
    this.log = new Logger();
    this.commands; // Command handler

    // Main loop tick
    this.startTime = +new Date;
    this.timeStamp = 0;
    this.updateTime = 0;
    this.updateTimeAvg = 0;
    this.timerLoopBind = null;
    this.mainLoopBind = null;
    
    this.tickCounter = 0;
    this.tickSpawn = 0; // Used with spawning food
    
    this.setBorder(10000, 10000);

    // Config
    this.config = {
        serverTimeout: 30,          // Seconds to keep connection alive for non-responding client
        serverMaxConnections: 64,   // Maximum amount of connections to the server. (0 for no limit)
        serverIpLimit: 4,           // Maximum amount of connections from the same IP (0 for no limit)
        serverPort: 443,            // Server port
        serverTracker: 0,           // Set to 1 if you want to show your server on the tracker http://ogar.mivabe.nl/master
        serverGamemode: 0,          // Gamemode, 0 = FFA, 1 = Teams
        serverBots: 0,              // Amount of player bots to spawn
        serverViewBaseX: 1920,      // Base client screen resolution. Used to calculate view area. Warning: high values may cause lag
        serverViewBaseY: 1080,      // min value is 1920x1080
        serverSpectatorScale: 0.4,  // Scale (field of view) used for free roam spectators (low value leads to lags, vanilla=0.4, old vanilla=0.25)
        serverStatsPort: 88,        // Port for stats server. Having a negative number will disable the stats server.
        serverStatsUpdate: 60,      // Amount of seconds per update for the server stats
        serverLogLevel: 1,          // Logging level of the server. 0 = No logs, 1 = Logs the console, 2 = Logs console and ip connections
        serverScrambleCoords: 1,    // Toggles scrambling of coordinates. 0 = No scrambling, 1 = lightweight scrambling. 2 = full scrambling (also known as scramble minimap, a little slow, some clients may not support it)
        serverMaxLB: 10,            // Controls the maximum players displayed on the leaderboard.
        serverChat: 1,              // Set to 1 to allow chat; 0 to disable chat.
        serverName: 'MultiOgar #1', // Server name
        serverWelcome1: 'Welcome to MultiOgar server!',      // First server welcome message
        serverWelcome2: '',         // Second server welcome message (for info, etc)
        
        borderWidth: 14142,         // Map border size (Vanilla value: 14142)
        borderHeight: 14142,        // Map border size (Vanilla value: 14142)
        
        foodMinSize: 10,            // Minimum food size (vanilla 10)
        foodMaxSize: 20,            // Maximum food size (vanilla 20)
        foodMinAmount: 100,         // Minimum food cells on the map
        foodMaxAmount: 500,         // Maximum food cells on the map
        foodSpawnAmount: 10,        // The amount of food to spawn per interval
        foodMassGrow: 1,            // Enable food mass grow ?
        spawnInterval: 20,          // The interval between each food cell spawn in ticks (1 tick = 50 ms)
        
        virusMinSize: 100,          // Minimum virus size (vanilla 100)
        virusMaxSize: 140,          // Maximum virus size (vanilla 140)
        virusMinAmount: 10,         // Minimum amount of viruses on the map.
        virusMaxAmount: 50,         // Maximum amount of viruses on the map. If this amount is reached, then ejected cells will pass through viruses.
        
        ejectSize: 37,              // Size of ejected cells (vanilla 37)
        ejectCooldown: 3,           // min ticks between ejects
        ejectSpawnPlayer: 50,       // Chance for a player to spawn from ejected mass
        
        playerMinSize: 32,          // Minimym size of the player cell (mass = 32*32/100 = 10.24)
        playerMaxSize: 1500,        // Maximum size of the player cell (mass = 1500*1500/100 = 22500)
        playerMaxCells: 16,         // Max cells the player is allowed to have
        playerSpeed: 1,             // Player speed multiplier
        playerDecayRate: .002,      // Amount of size lost per second
        playerRecombineTime: 30,    // Base amount of seconds before a cell is allowed to recombine
        playerMaxNickLength: 15,    // Maximum nick length
        playerDisconnectTime: 60,   // The amount of seconds it takes for a player cell to be removed after disconnection (If set to -1, cells are never removed)
        
        tourneyMaxPlayers: 12,      // Maximum amount of participants for tournament style game modes
        tourneyPrepTime: 10,        // Amount of ticks to wait after all players are ready (1 tick = 1000 ms)
        tourneyEndTime: 30,         // Amount of ticks to wait after a player wins (1 tick = 1000 ms)
        tourneyTimeLimit: 20,       // Time limit of the game, in minutes.
        tourneyAutoFill: 0,         // If set to a value higher than 0, the tournament match will automatically fill up with bots after this amount of seconds
        tourneyAutoFillPlayers: 1,  // The timer for filling the server with bots will not count down unless there is this amount of real players
    };
    
    this.ipBanList = [];
    
    // Parse config
    this.loadConfig();
    this.loadIpBanList();
    
    this.setBorder(this.config.borderWidth, this.config.borderHeight);
    this.quadTree = new QuadNode(this.border, 4, 100);
    
    // Gamemodes
    this.gameMode = Gamemode.get(this.config.serverGamemode);
}

module.exports = GameServer;

GameServer.prototype.start = function() {
    this.timerLoopBind = this.timerLoop.bind(this);
    this.mainLoopBind = this.mainLoop.bind(this);
    
    // Logging
    this.log.setup(this);
    
    // Gamemode configurations
    this.gameMode.onServerInit(this);
    
    var options = {
        port: this.config.serverPort,
        perMessageDeflate: false
    };

    // Start the server
    this.socketServer = new WebSocket.Server(options, this.onServerSocketOpen.bind(this));
    this.socketServer.on('error', this.onServerSocketError.bind(this));
    this.socketServer.on('connection', this.onClientSocketOpen.bind(this));

    this.startStatsServer(this.config.serverStatsPort);
};

GameServer.prototype.onServerSocketError = function (error) {
    switch (error.code) {
        case "EADDRINUSE":
            console.log("[Error] Server could not bind to port " + this.config.serverPort + "! Please close out of Skype or change 'serverPort' in gameserver.ini to a different number.");
            break;
        case "EACCES":
            console.log("[Error] Please make sure you are running Ogar with root privileges.");
            break;
        default:
            console.log("[Error] Unhandled error code: " + error.code);
            break;
    }
    process.exit(1); // Exits the program
};

GameServer.prototype.onServerSocketOpen = function () {
    // Spawn starting food
    this.startingFood();
    
    // Start Main Loop
    setTimeout(this.timerLoopBind, 1);
    
    // Done
    console.log("[Game] Listening on port " + this.config.serverPort);
    console.log("[Game] Current game mode is " + this.gameMode.name);
    
    // Player bots (Experimental)
    if (this.config.serverBots > 0) {
        for (var i = 0; i < this.config.serverBots; i++) {
            this.bots.addBot();
        }
        console.log("[Game] Loaded " + this.config.serverBots + " player bots");
    }
};

GameServer.prototype.onClientSocketOpen = function (ws) {
    // Check blacklist first (if enabled).
    if (this.ipBanList && this.ipBanList.length > 0 && this.ipBanList.indexOf(ws._socket.remoteAddress) >= 0) {
        // IP banned
        ws.close(1000, "IP banned");
        return;
    }
    var totalConnections = 0;
    var ipConnections = 0;
    for (var i = 0; i < this.clients.length; i++) {
        var socket = this.clients[i];
        if (socket == null || socket.isConnected == null)
            continue;
        totalConnections++;
        if (socket.isConnected && socket.remoteAddress == ws._socket.remoteAddress)
            ipConnections++;
    }
    if (this.config.serverMaxConnections > 0 && totalConnections >= this.config.serverMaxConnections) {
        // Server full
        ws.close(1000, "No slots");
        return;
    }
    if (this.config.serverIpLimit > 0 && ipConnections >= this.config.serverIpLimit) {
        // IP limit reached
        ws.close(1000, "IP limit reached");
        return;
    }
    ws.isConnected = true;
    ws.remoteAddress = ws._socket.remoteAddress;
    ws.remotePort = ws._socket.remotePort;
    ws.lastAliveTime = +new Date;
    this.log.onConnect(ws.remoteAddress); // Log connections
    
    ws.playerTracker = new PlayerTracker(this, ws);
    ws.packetHandler = new PacketHandler(this, ws);
    ws.playerCommand = new PlayerCommand(this, ws.playerTracker);
    
    var gameServer = this;
    var onMessage = function (message) {
        gameServer.onClientSocketMessage(ws, message);
    };
    var onError = function (error) {
        gameServer.onClientSocketError(ws, error);
    };
    var onClose = function (reason) {
        gameServer.onClientSocketClose(ws, reason);
    };
    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);
    this.clients.push(ws);
};

GameServer.prototype.onClientSocketClose = function (ws, code) {
    this.log.onDisconnect(ws.remoteAddress);
    
    ws.isConnected = false;
    ws.sendPacket = function (data) { };
    ws.closeReason = { code: ws._closeCode, message: ws._closeMessage };
    ws.closeTime = +new Date;

    var color = this.getGrayColor(ws.playerTracker.getColor());
    ws.playerTracker.setColor(color);
    ws.playerTracker.setSkin("");
    // disconnected effect
    ws.playerTracker.cells.forEach(function (cell) {
        cell.setColor(color);
    }, this);
};

GameServer.prototype.onClientSocketError = function (ws, error) {
    ws.sendPacket = function (data) { };
    ws.close(1002, "Socket error");
};

GameServer.prototype.onClientSocketMessage = function (ws, message) {
    ws.packetHandler.handleMessage(message);
};

GameServer.prototype.setBorder = function(width, height) {
    var hw = width / 2;
    var hh = height / 2;
    this.border = {
        minx: -hw,
        miny: -hh,
        maxx: hw,
        maxy: hh,
        width: width,
        height: height,
        centerx: 0,
        centery: 0
    };
};

GameServer.prototype.getTick = function () {
    return this.tickCounter;
};

GameServer.prototype.getMode = function () {
    return this.gameMode;
};

GameServer.prototype.getNextNodeId = function() {
    // Resets integer
    if (this.lastNodeId > 2147483647) {
        this.lastNodeId = 1;
    }
    return this.lastNodeId++ >>> 0;
};

GameServer.prototype.getNewPlayerID = function() {
    // Resets integer
    if (this.lastPlayerId > 2147483647) {
        this.lastPlayerId = 1;
    }
    return this.lastPlayerId++ >>> 0;
};

GameServer.prototype.getRandomPosition = function() {
    return {
        x: Math.floor(this.border.minx + this.border.width * Math.random()),
        y: Math.floor(this.border.miny + this.border.height * Math.random())
    };
};

GameServer.prototype.getRandomSpawn = function(size) {
    // Random and secure spawns for players and viruses
    var pos = this.getRandomPosition();
    var unsafe = this.willCollide(pos, size);
    if (!unsafe) return pos;
    
    // just shift offset and try again
    var attempt = 1;
    var maxAttempt = 4;
    var dirx = pos.x < this.border.centerx ? 1 : -1;
    var diry = pos.y < this.border.centery ? 1 : -1;
    var stepx = this.border.width / (2 * maxAttempt);
    var stepy = this.border.height / (2 * maxAttempt);
    while (unsafe && attempt < maxAttempt) {
        pos.x += stepx * dirx;
        pos.y += stepy * diry;
        unsafe = this.willCollide(pos, size);
        attempt++;
    }
    // failed to find safe position
    return null;
};

GameServer.prototype.getGrayColor = function (rgb) {
    var luminance = Math.min(255, (rgb.r * 0.2125 + rgb.g * 0.7154 + rgb.b * 0.0721)) >>> 0;
    return {
        r: luminance,
        g: luminance,
        b: luminance
    };
};

GameServer.prototype.getRandomColor = function() {
    var h = 360 * Math.random();
    var s = 248 / 255;
    var v = 1;
    
    // hsv to rgb    
    var rgb = { r: v, g: v, b: v };    // achromatic (grey)
    if (s > 0) {
        h /= 60;			           // sector 0 to 5
        var i = Math.floor(h) >> 0;
        var f = h - i;			       // factorial part of h
        var p = v * (1 - s);
        var q = v * (1 - s * f);
        var t = v * (1 - s * (1 - f));
        switch (i) {
            case 0: rgb = { r: v, g: t, b: p }; break
            case 1: rgb = { r: q, g: v, b: p }; break
            case 2: rgb = { r: p, g: v, b: t }; break
            case 3: rgb = { r: p, g: q, b: v }; break
            case 4: rgb = { r: t, g: p, b: v }; break
            default: rgb = { r: v, g: p, b: q }; break
        }
    }
    // check color range
    rgb.r = Math.max(rgb.r, 0);
    rgb.g = Math.max(rgb.g, 0);
    rgb.b = Math.max(rgb.b, 0);
    rgb.r = Math.min(rgb.r, 1);
    rgb.g = Math.min(rgb.g, 1);
    rgb.b = Math.min(rgb.b, 1);
    return {
        r: (rgb.r * 255) >>> 0,
        g: (rgb.g * 255) >>> 0,
        b: (rgb.b * 255) >>> 0
    };
};

GameServer.prototype.updateNodeQuad = function (node) {
    var quadItem = node.quadItem;
    if (quadItem == null) {
        throw new TypeError("GameServer.updateNodeQuad: quadItem is null!");
    }
    // check for change
    if (node.position.x == quadItem.x &&
        node.position.y == quadItem.y &&
        node.getSize() == quadItem.size) {
        // no change
        return;
    }
    // update quadTree
    quadItem.x = node.position.x;
    quadItem.y = node.position.y;
    quadItem.size = node.getSize();
    quadItem.bound = {
        minx: node.quadItem.x - node.quadItem.size,
        miny: node.quadItem.y - node.quadItem.size,
        maxx: node.quadItem.x + node.quadItem.size,
        maxy: node.quadItem.y + node.quadItem.size
    };
    this.quadTree.update(quadItem);
};


GameServer.prototype.addNode = function(node) {
    node.quadItem = {
        cell: node,
        x: node.position.x,
        y: node.position.y,
        size: node.getSize()
    };
    node.quadItem.bound = {
        minx: node.quadItem.x - node.quadItem.size,
        miny: node.quadItem.y - node.quadItem.size,
        maxx: node.quadItem.x + node.quadItem.size,
        maxy: node.quadItem.y + node.quadItem.size
    };
    this.quadTree.insert(node.quadItem);
    
    this.nodes.push(node);

    // Adds to the owning player's screen
    if (node.owner) {
        node.setColor(node.owner.getColor());
        node.owner.cells.push(node);
        node.owner.socket.sendPacket(new Packet.AddNode(node.owner, node));
    }

    // Special on-add actions
    node.onAdd(this);
};

GameServer.prototype.removeNode = function(node) {
    if (node.quadItem == null) {
        throw new TypeError("GameServer.removeNode: attempt to remove invalid node!");
    }
    node.isRemoved = true;
    this.quadTree.remove(node.quadItem);
    node.quadItem = null;
    
    // Remove from main nodes list
    var index = this.nodes.indexOf(node);
    if (index != -1) {
        this.nodes.splice(index, 1);
    }

    // Remove from moving cells list
    index = this.movingNodes.indexOf(node);
    if (index != -1) {
        this.movingNodes.splice(index, 1);
    }

    // Special on-remove actions
    node.onRemove(this);
};

GameServer.prototype.updateSpawn = function() {
    // Spawn food
    this.tickSpawn++;
    if (this.tickSpawn >= this.config.spawnInterval) {
        this.tickSpawn = 0; // Reset
        
        this.updateFood();  // Spawn food
        this.updateVirus(); // Spawn viruses
    }
};

GameServer.prototype.updateClients = function () {
    for (var i = 0; i < this.clients.length; i++) {
        var socket = this.clients[i];
        socket.playerTracker.update();
    }
    // remove dead clients
    for (var i = 0; i < this.clients.length; ) {
        var socket = this.clients[i];
        if (socket.playerTracker.isRemoved) {
            this.clients.splice(i, 1);
        } else {
            i++;
        }
    }
};

GameServer.prototype.updateLeaderboard = function () {
    // Update leaderboard with the gamemode's method
    if ((this.tickCounter % 25) == 0) {
        this.leaderboard = [];
        this.leaderboardType = -1;
        this.gameMode.updateLB(this);

        if (!this.gameMode.specByLeaderboard) {
            // Get client with largest score if gamemode doesn't have a leaderboard
            var clients = this.clients.valueOf();
            
            // Use sort function
            clients.sort(function (a, b) {
                return b.playerTracker.getScore() - a.playerTracker.getScore();
            });
            //this.largestClient = clients[0].playerTracker;
            this.largestClient = null;
            if (clients[0] != null)
                this.largestClient = clients[0].playerTracker;
        } else {
            this.largestClient = this.gameMode.rankOne;
        }
    }
};

GameServer.prototype.onChatMessage = function (from, to, message) {
    if (message == null) return;
    message = message.trim();
    if (message == "") return;
    if (from && message.length > 0 && message[0] == '/') {
        // player command
        message = message.slice(1, message.length);
        from.socket.playerCommand.executeCommandLine(message);
        return;
    }
    if (!this.config.serverChat) {
        // chat is disabled
        return;
    }
    if (message.length > 128) message = message.slice(0, 128);
    //console.log("[CHAT] " + (from!=null && from.getName().length>0 ? from.getName() : "Spectator") + ": " + message);
    this.sendChatMessage(from, to, message);
};

GameServer.prototype.sendChatMessage = function (from, to, message) {
    for (var i = 0; i < this.clients.length; i++) {
        var client = this.clients[i];
        if (client == null) continue;
        if (to == null || to == client.playerTracker)
            client.sendPacket(new Packet.ChatMessage(from, message));
    }
}; 

GameServer.prototype.timerLoop = function () {
    var timeStep = this.updateTimeAvg >> 0;
    timeStep += 5;
    timeStep = Math.max(timeStep, 40);
    
    var ts = new Date().getTime();
    var dt = ts - this.timeStamp;
    if (dt < timeStep - 5) {
        setTimeout(this.timerLoopBind, ((timeStep-5) - dt) >> 0);
        return;
    }
    if (dt < timeStep - 1) {
        setTimeout(this.timerLoopBind, 0);
        return;
    }
    if (dt < timeStep) {
        //process.nextTick(this.timerLoopBind);
        setTimeout(this.timerLoopBind, 0);
        return;
    }
    // update average
    this.updateTimeAvg += 0.5 * (this.updateTime - this.updateTimeAvg);
    // calculate next
    if (this.timeStamp == 0)
        this.timeStamp = ts;
    this.timeStamp += timeStep;
    //process.nextTick(this.mainLoopBind);
    //process.nextTick(this.timerLoopBind);
    setTimeout(this.mainLoopBind, 0);
    setTimeout(this.timerLoopBind, 0);
};

GameServer.prototype.mainLoop = function() {
    var tStart = new Date().getTime();
    
    // Loop main functions
    if (this.run) {
        this.updateMoveEngine();
        this.updateSpawn();
        this.gameMode.onTick(this);
        if ((this.getTick() % (1000 / 40)) == 0) {
            // once per second
            this.updateMassDecay();
        }
    }
    this.updateClients();
    this.updateLeaderboard();
    
    // ping server tracker
    if (this.config.serverTracker && (this.getTick() % (30000/40)) == 0) {
        this.pingServerTracker();
    }
    
    //this.tt = 0;
    //this.tc = 0;
    //var t = process.hrtime();
    //this.updateMoveEngine();
    //this.t1 = toTime(process.hrtime(t));
    //t = process.hrtime();
    //this.updateSpawn();
    //this.t2 = toTime(process.hrtime(t));
    //t = process.hrtime();
    //this.gameMode.onTick(this);
    //this.t3 = toTime(process.hrtime(t));
    //t = process.hrtime();
    //this.updateMassDecay();
    //this.t4 = toTime(process.hrtime(t));
    //t = process.hrtime();
    //this.updateClients();
    //this.t5 = toTime(process.hrtime(t));
    //t = process.hrtime();
    //this.updateLeaderboard();
    //this.t6 = toTime(process.hrtime(t));
    //function toTime(tscTicks) {
    //    return tscTicks[0] * 1000 + tscTicks[1] / 1000000;
    //}
    
    if (this.run) {
        this.tickCounter++;
    }
    var tEnd = new Date().getTime();
    this.updateTime = tEnd - tStart;
};

GameServer.prototype.startingFood = function() {
    // Spawns the starting amount of food cells
    for (var i = 0; i < this.config.foodMinAmount; i++) {
        this.spawnFood();
    }
};

GameServer.prototype.updateFood = function() {
    var maxCount = this.config.foodMaxAmount - this.currentFood;
    var spawnCount = Math.min(maxCount, this.config.foodSpawnAmount);
    for (var i = 0; i < spawnCount; i++) {
        this.spawnFood();
    }
};

GameServer.prototype.updateVirus = function () {
    var maxCount = this.config.virusMaxAmount - this.nodesVirus.length;
    var spawnCount = Math.min(maxCount, 2);
    for (var i = 0; i < spawnCount; i++) {
        this.spawnVirus();
    }
};

GameServer.prototype.spawnFood = function() {
    var cell = new Entity.Food(this, null, this.getRandomPosition(), this.config.foodMinSize);
    if (this.config.foodMassGrow) {
        var size = cell.getSize();
        var maxGrow = this.config.foodMaxSize - size;
        size += maxGrow * Math.random();
        cell.setSize(size);
    }
    cell.setColor(this.getRandomColor());
    this.addNode(cell);
};

GameServer.prototype.spawnVirus = function () {
    // Spawns a virus
    var pos = this.getRandomSpawn(this.config.virusMinSize);
    if (pos == null) {
        // cannot find safe position => do not spawn
        return;
    }
    var v = new Entity.Virus(this, null, pos, this.config.virusMinSize);
    this.addNode(v);
};

GameServer.prototype.spawnPlayer = function(player, pos, size) {
    // Check if there are ejected mass in the world.
    if (this.nodesEjected.length > 0) {
        var index = Math.floor(Math.random() * 100) + 1;
        if (index >= this.config.ejectSpawnPlayer) {
            // Get ejected cell
            index = Math.floor(Math.random() * this.nodesEjected.length);
            var e = this.nodesEjected[index];
            if (e.boostDistance == 0) {
                // Remove ejected mass
                this.removeNode(e);
                // Inherit
                pos = {
                    x: e.position.x,
                    y: e.position.y
                };
            }
        }
    }
    if (pos == null) {
        // Get random pos
        pos = this.getRandomSpawn(this.config.playerMinSize);
        if (pos == null) {
            // cannot find safe position => spawn anyway at random position
            pos = this.getRandomPosition();
        }
    }
    if (size == null) {
        // Get starting mass
        size = this.config.playerMinSize;
    }

    // Spawn player and add to world
    var cell = new Entity.PlayerCell(this, player, pos, size);
    this.addNode(cell);

    // Set initial mouse coords
    player.mouse = {
        x: pos.x,
        y: pos.y
    };
};

GameServer.prototype.willCollide = function (pos, size) {
    // Look if there will be any collision with the current nodes
    var bound = {
        minx: pos.x - size - 10,
        miny: pos.y - size - 10,
        maxx: pos.x + size + 10,
        maxy: pos.y + size + 10
    };
    return this.quadTree.any(
        bound, 
        function (item) {
            return item.cell.cellType != 1; // ignore food
        });
};

GameServer.prototype.getDist = function (x1, y1, x2, y2) {
    var dx = x2 - x1;
    var dy = y2 - x1;
    return Math.sqrt(dx * dx + dy * dy);
};

GameServer.prototype.abs = function (x) {
    return x < 0 ? -x : x;
};

// Checks cells for collision.
// Returns collision manifold or null if there is no collision
GameServer.prototype.checkCellCollision = function(cell, check) {
    var r = cell.getSize() + check.getSize();
    var dx = check.position.x - cell.position.x;
    var dy = check.position.y - cell.position.y;
    var squared = dx * dx + dy * dy;         // squared distance from cell to check
    if (squared > r * r) {
        // no collision
        return null;
    }
    // create collision manifold
    return {
        cell1: cell,
        cell2: check,
        r: r,               // radius sum
        dx: dx,             // delta x from cell1 to cell2
        dy: dy,             // delta y from cell1 to cell2
        squared: squared    // squared distance from cell1 to cell2
    };
};

// Resolves rigid body collision
GameServer.prototype.resolveRigidCollision = function (manifold, border) {
    // distance from cell1 to cell2
    var d = Math.sqrt(manifold.squared);
    if (d <= 0) return;
    var invd = 1 / d;
    
    // normal
    var nx = manifold.dx * invd;
    var ny = manifold.dy * invd;
    
    // body penetration distance
    var penetration = manifold.r - d;
    if (penetration <= 0) return;
    
    // penetration vector = penetration * normal
    var px = penetration * nx;
    var py = penetration * ny;
    
    // body impulse
    var totalMass = manifold.cell1.getMass() + manifold.cell2.getMass();
    if (totalMass <= 0) return;
    var invTotalMass = 1 / totalMass;
    var impulse1 = manifold.cell2.getMass() * invTotalMass;
    var impulse2 = manifold.cell1.getMass() * invTotalMass;
    
    // apply extrusion force
    manifold.cell1.position.x -= px * impulse1;
    manifold.cell1.position.y -= py * impulse1;
    manifold.cell2.position.x += px * impulse2;
    manifold.cell2.position.y += py * impulse2;
    // clip to border bounds
    manifold.cell1.checkBorder(border);
    manifold.cell2.checkBorder(border);
};

// Checks if collision is rigid body collision
GameServer.prototype.checkRigidCollision = function (manifold) {
    if (!manifold.cell1.owner || !manifold.cell2.owner)
        return false;
    if (manifold.cell1.owner != manifold.cell2.owner) {
        // Different owners
        return this.gameMode.haveTeams && 
            manifold.cell1.owner.getTeam() == manifold.cell2.owner.getTeam();
    }
    // The same owner
    if (manifold.cell1.owner.mergeOverride)
        return false;
    var tick = this.getTick();
    if (manifold.cell1.getAge(tick) < 15 || manifold.cell2.getAge(tick) < 15) {
        // just splited => ignore
        return false;
    }
    return !manifold.cell1.canRemerge() || !manifold.cell2.canRemerge();
};

// Resolves non-rigid body collision
GameServer.prototype.resolveCollision = function (manifold) {
    var minCell = manifold.cell1;
    var maxCell = manifold.cell2;
    // check if any cell already eaten
    if (minCell.isRemoved || maxCell.isRemoved)
        return;
    if (minCell.getSize() > maxCell.getSize()) {
        minCell = manifold.cell2;
        maxCell = manifold.cell1;
    }
    
    // check distance
    var eatDistance = maxCell.getSize() - minCell.getSize() / Math.PI;
    if (manifold.squared >= eatDistance * eatDistance) {
        // too far => can't eat
        return;
    }
    
    if (minCell.owner && minCell.owner == maxCell.owner) {
        // collision owned/owned => ignore or resolve or remerge
        
        var tick = this.getTick();
        if (minCell.getAge(tick) < 15 || maxCell.getAge(tick) < 15) {
            // just splited => ignore
            return;
        }
        if (!minCell.owner.mergeOverride) {
            // not force remerge => check if can remerge
            if (!minCell.canRemerge() || !maxCell.canRemerge()) {
                // cannot remerge
                return;
            }
        }
    } else {
        // collision owned/enemy => check if can eat
        
        // Team check
        if (this.gameMode.haveTeams && minCell.owner && maxCell.owner) {
            if (minCell.owner.getTeam() == maxCell.owner.getTeam()) {
                // cannot eat team member
                return;
            }
        }
        // Size check
        if (minCell.getSize() * 1.15 > maxCell.getSize()) {
            // too large => can't eat
            return;
        }
    }
    if (!maxCell.canEat(minCell)) {
        // maxCell don't want to eat
        return;
    }
    // Now maxCell can eat minCell
    minCell.isRemoved = true;
    
    // Disable mergeOverride on the last merging cell
    // We need to disable it before onCosume to prevent merging loop
    // (onConsume may cause split for big mass)
    if (minCell.owner && minCell.owner.cells.length <= 2) {
        minCell.owner.mergeOverride = false;
    }
    
    // Consume effect
    maxCell.onEat(minCell);
    minCell.onEaten(maxCell);
    
    // update bounds
    this.updateNodeQuad(maxCell);

    // Remove cell
    minCell.setKiller(maxCell);
    this.removeNode(minCell);
};

GameServer.prototype.updateMoveEngine = function () {
    // Move player cells
    for (var i in this.clients) {
        var client = this.clients[i].playerTracker;
        for (var j = 0; j < client.cells.length; j++) {
            var cell1 = client.cells[j];
            if (cell1.isRemoved)
                continue;
            cell1.updateRemerge(this);
            cell1.moveUser(this.border);
            cell1.move(this.border);
            this.updateNodeQuad(cell1);
        }
    }
    // Move moving cells
    for (var i = 0; i < this.movingNodes.length; ) {
        var cell1 = this.movingNodes[i];
        if (cell1.isRemoved)
            continue;
        cell1.move(this.border);
        this.updateNodeQuad(cell1);
        if (!cell1.isMoving)
            this.movingNodes.splice(i, 1);
        else
            i++;
    }
    
    // === check for collisions ===
    
    // Scan for player cells collisions
    var self = this;
    var rigidCollisions = [];
    var eatCollisions = [];
    for (var i in this.clients) {
        var client = this.clients[i].playerTracker;
        for (var j = 0; j < client.cells.length; j++) {
            var cell1 = client.cells[j];
            if (cell1 == null) continue;
            this.quadTree.find(cell1.quadItem.bound, function (item) {
                var cell2 = item.cell;
                if (cell2 == cell1) return;
                var manifold = self.checkCellCollision(cell1, cell2);
                if (manifold == null) return;
                if (self.checkRigidCollision(manifold))
                    rigidCollisions.push({ cell1: cell1, cell2: cell2 });
                else
                    eatCollisions.push({ cell1: cell1, cell2: cell2 });
            });
        }
    }
    
    // resolve rigid body collisions
    for (var z = 0; z < 2; z++) { // loop for better rigid body resolution quality (slow)
        for (var k = 0; k < rigidCollisions.length; k++) {
            var c = rigidCollisions[k];
            var manifold = this.checkCellCollision(c.cell1, c.cell2);
            if (manifold == null) continue;
            this.resolveRigidCollision(manifold, this.border);
            // position changed! don't forgot to update quad-tree
        }
    }
    // Update quad tree
    for (var k = 0; k < rigidCollisions.length; k++) {
        var c = rigidCollisions[k];
        this.updateNodeQuad(c.cell1);
        this.updateNodeQuad(c.cell2);
    }
    rigidCollisions = null;
    
    // resolve eat collisions
    for (var k = 0; k < eatCollisions.length; k++) {
        var c = eatCollisions[k];
        var manifold = this.checkCellCollision(c.cell1, c.cell2);
        if (manifold == null) continue;
        this.resolveCollision(manifold);
    }
    eatCollisions = null;
    
    //this.gameMode.onCellMove(cell1, this);
    
    // Scan for ejected cell collisions (scan for ejected or virus only)
    rigidCollisions = [];
    eatCollisions = [];
    var self = this;
    for (var i = 0; i < this.movingNodes.length; i++) {
        var cell1 = this.movingNodes[i];
        if (cell1.isRemoved) continue;
        this.quadTree.find(cell1.quadItem.bound, function (item) {
            var cell2 = item.cell;
            if (cell2 == cell1)
                return;
            var manifold = self.checkCellCollision(cell1, cell2);
            if (manifold == null) return;
            if (cell1.cellType == 3 && cell2.cellType == 3) {
                // ejected/ejected
                rigidCollisions.push({ cell1: cell1, cell2: cell2 });
                // add to moving nodes if needed
                if (!cell1.isMoving) {
                    cell1.isMoving = true
                    self.movingNodes.push(cell1);
                }
                if (!cell2.isMoving) {
                    cell2.isMoving = true
                    self.movingNodes.push(cell2);
                }
            }
            else {
                eatCollisions.push({ cell1: cell1, cell2: cell2 });
            }
        });
    }
        
    // resolve rigid body collisions
    for (var k = 0; k < rigidCollisions.length; k++) {
        var c = rigidCollisions[k];
        var manifold = this.checkCellCollision(c.cell1, c.cell2);
        if (manifold == null) continue;
        this.resolveRigidCollision(manifold, this.border);
        // position changed! don't forgot to update quad-tree
    }
    // Update quad tree
    for (var k = 0; k < rigidCollisions.length; k++) {
        var c = rigidCollisions[k];
        this.updateNodeQuad(c.cell1);
        this.updateNodeQuad(c.cell2);
    }
    rigidCollisions = null;
    
    // resolve eat collisions
    for (var k = 0; k < eatCollisions.length; k++) {
        var c = eatCollisions[k];
        var manifold = this.checkCellCollision(c.cell1, c.cell2);
        if (manifold == null) continue;
        this.resolveCollision(manifold);
    }
};

GameServer.prototype.splitCells = function(client) {
    // it seems that vanilla uses order by cell age
    //// sort by size descending
    //client.cells.sort(function (a, b) {
    //    return b.getSize() - a.getSize();
    //});
    var cellToSplit = [];
    for (var i = 0; i < client.cells.length; i++) {
        var cell = client.cells[i];
        if (cell.getSplitSize() < this.config.playerMinSize) {
            continue;
        }
        cellToSplit.push(cell);
        if (cellToSplit.length + client.cells.length >= this.config.playerMaxCells)
            break;
    }
    var splitCells = 0; // How many cells have been split
    for (var i = 0; i < cellToSplit.length; i++) {
        var cell = cellToSplit[i];
        var dx = client.mouse.x - cell.position.x;
        var dy = client.mouse.y - cell.position.y;
        var dl = dx * dx + dy * dy;
        if (dl < 1) {
            dx = 1;
            dy = 0;
        }
        var angle = Math.atan2(dx, dy);
        if (isNaN(angle)) angle = Math.PI / 2;

        if (this.splitPlayerCell(client, cell, angle, null)) {
            splitCells++;
        }
    }
};

// TODO: replace mass with size (Virus)
GameServer.prototype.splitPlayerCell = function (client, parent, angle, mass) {
    // Returns boolean whether a cell has been split or not. You can use this in the future.

    if (client.cells.length >= this.config.playerMaxCells) {
        // Player cell limit
        return false;
    }

    var size1 = 0;
    var size2 = 0;
    if (mass == null) {
        size1 = parent.getSplitSize();
        size2 = size1;
    } else {
        size2 = Math.sqrt(mass * 100);
        size1 = Math.sqrt(parent.getSize() * parent.getSize() - size2 * size2);
    }
    
    // Remove mass from parent cell first
    parent.setSize(size1);
    
    // make a small shift to the cell position to prevent extrusion in wrong direction
    var pos = {
        x: parent.position.x + 40 * Math.sin(angle),
        y: parent.position.y + 40 * Math.cos(angle)
    };
    
    // Create cell
    var newCell = new Entity.PlayerCell(this, client, pos, size2);
    newCell.setBoost(780, angle);
    
    // Add to node list
    this.addNode(newCell);
    return true;
};

GameServer.prototype.canEjectMass = function(client) {
    var tick = this.getTick();
    if (client.lastEject == null) {
        // first eject
        client.lastEject = tick;
        return true;
    }
    var dt = tick - client.lastEject;
    if (dt < this.config.ejectCooldown) {
        // reject (cooldown)
        return false;
    }
    client.lastEject = tick;
    return true;
};

GameServer.prototype.ejectMass = function(client) {
    if (!this.canEjectMass(client))
        return;
    for (var i = 0; i < client.cells.length; i++) {
        var cell = client.cells[i];

        if (!cell) {
            continue;
        }

        var size2 = this.config.ejectSize;
        var sizeSquared = cell.getSquareSize() - size2 * size2;
        if (sizeSquared < this.config.playerMinSize * this.config.playerMinSize) {
            continue;
        }
        var size1 = Math.sqrt(sizeSquared);

        var dx = client.mouse.x - cell.position.x;
        var dy = client.mouse.y - cell.position.y;
        var dl = dx * dx + dy * dy;
        if (dl < 1) {
            dx = 1;
            dy = 0;
        } else {
            dl = Math.sqrt(dl);
            dx /= dl;
            dy /= dl;
        }
        
        // Remove mass from parent cell first
        cell.setSize(size1);

        // Get starting position
        var pos = {
            x: cell.position.x + dx * cell.getSize(),
            y: cell.position.y + dy * cell.getSize()
        };
        
        var angle = Math.atan2(dx, dy);
        if (isNaN(angle)) angle = Math.PI / 2;
        
        // Randomize angle
        angle += (Math.random() * 0.6) - 0.3;

        // Create cell
        var ejected = new Entity.EjectedMass(this, null, pos, size2);
        ejected.ejector = cell;
        ejected.setColor(cell.getColor());
        ejected.setBoost(780, angle);

        this.addNode(ejected);
    }
};

GameServer.prototype.shootVirus = function(parent, angle) {
    var parentPos = {
        x: parent.position.x,
        y: parent.position.y,
    };

    var newVirus = new Entity.Virus(this, null, parentPos, this.config.virusMinSize);
    newVirus.setBoost(780, angle);

    // Add to moving cells list
    this.addNode(newVirus);
};

GameServer.prototype.getNearestVirus = function(cell) {
    // Loop through all viruses on the map. There is probably a more efficient way of doing this but whatever
    for (var i = 0; i < this.nodesVirus.length; i++) {
        var check = this.nodesVirus[i];
        if (check === null) continue;
        if (this.checkCellCollision(cell, check) != null)
            return check;
    }
};

GameServer.prototype.updateMassDecay = function() {
    var decay = 1 - (this.config.playerDecayRate * this.gameMode.decayMod);
    if (decay == 0) {
        return;
    }
    // Loop through all player cells
    for (var i = 0; i < this.clients.length; i++) {
        var playerTracker = this.clients[i].playerTracker;
        for (var j = 0; j < playerTracker.cells.length; j++) {
            var cell = playerTracker.cells[j];
            // TODO: check if non linear will be better
            var size = cell.getSize() * decay;
            size = Math.max(size, this.config.playerMinSize);
            if (size != cell.getSize()) {
                cell.setSize(size);
            }
        }
    }
};

GameServer.prototype.loadConfig = function() {
    try {
        // Load the contents of the config file
        var load = ini.parse(fs.readFileSync('./gameserver.ini', 'utf-8'));

        // Replace all the default config's values with the loaded config's values
        for (var obj in load) {
            this.config[obj] = load[obj];
        }
    } catch (err) {
        // No config
        console.log("[Game] Config not found... Generating new config");

        // Create a new config
        fs.writeFileSync('./gameserver.ini', ini.stringify(this.config));
    }
    // check config (min player size = 32 => mass = 10.24)
    this.config.playerMinSize = Math.max(32, this.config.playerMinSize);
};

GameServer.prototype.loadIpBanList = function () {
    var fileName = "./ipbanlist.txt";
    try {
        if (fs.existsSync(fileName)) {
            // Load and input the contents of the ipbanlist file
            this.ipBanList = fs.readFileSync(fileName, "utf8").split(/[\r\n]+/).filter(function (x) {
                return x != ''; // filter empty lines
            });
            console.log("[Game] " + this.ipBanList.length + " IP ban records loaded.");
        } else {
            console.log("[Game] " + fileName + " is missing.");
        }
    } catch (err) {
        console.log("[Game] Failed to load " + fileName + ": " + err.message);
    }
};

GameServer.prototype.saveIpBanList = function () {
    var fileName = "./ipbanlist.txt";
    try {
        var blFile = fs.createWriteStream(fileName);
        // Sort the blacklist and write.
        this.ipBanList.sort().forEach(function (v) {
            blFile.write(v + '\n');
        });
        blFile.end();
        console.log("[Game] " + this.ipBanList.length + " IP ban records saved.");
    } catch (err) {
        console.log("[Game] Failed to save " + fileName + ": " + err.message);
    }
};

GameServer.prototype.banIp = function (ip) {
    if (this.ipBanList.indexOf(ip) >= 0) {
        console.log("[Game] " + ip + " is already in the ban list!");
        return;
    }
    this.ipBanList.push(ip);
    console.log("[Game] The IP " + ip + " has been banned");
    this.clients.forEach(function (socket) {
        // If already disconnected or the ip does not match
        if (socket == null || !socket.isConnected || socket.remoteAddress != ip)
            return;
        
        // remove player cells
        socket.playerTracker.cells.forEach(function (cell) {
            this.removeNode(cell);
        }, this);
        
        // disconnect
        socket.close(1000, "Banned from server");
        var name = socket.playerTracker.getFriendlyName();
        console.log("[Game] Banned: \"" + name + "\" with Player ID " + socket.playerTracker.pID); // Redacted "with IP #.#.#.#" since it'll already be logged above
        this.sendChatMessage(null, null, "Banned \"" + name + "\""); // notify to don't confuse with server bug
    }, this);
    this.saveIpBanList();
};

GameServer.prototype.unbanIp = function (ip) {
    var index = this.ipBanList.indexOf(ip);
    if (index < 0) {
        console.log("[Game] IP " + ip + " is not in the ban list!");
        return;
    }
    this.ipBanList.splice(index, 1);
    console.log("[Game] Unbanned IP: " + ip);
    this.saveIpBanList();
};

// Kick player by ID. Use ID = 0 to kick all players
GameServer.prototype.kickId = function (id) {
    var count = 0;
    this.clients.forEach(function (socket) {
        if (socket.isConnected == false)
            return;
        if (id != 0 && socket.playerTracker.pID != id)
            return;
        // remove player cells
        socket.playerTracker.cells.forEach(function (cell) {
            this.removeNode(cell);
        }, this);
        // disconnect
        socket.close(1000, "Kicked from server");
        var name = socket.playerTracker.getFriendlyName();
        console.log("[Game] Kicked \"" + name + "\"");
        this.sendChatMessage(null, null, "Kicked \"" + name + "\""); // notify to don't confuse with server bug
        count++;
    }, this);
    if (count > 0)
        return;
    if (id == 0)
        console.log("[Game] No players to kick!");
    else
        console.log("[Game] Player with ID "+id+" not found!");
};

// Stats server

GameServer.prototype.startStatsServer = function(port) {
    // Do not start the server if the port is negative
    if (port < 1) {
        return;
    }

    // Create stats
    this.stats = "Test";
    this.getStats();

    // Show stats
    this.httpServer = http.createServer(function(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.writeHead(200);
        res.end(this.stats);
    }.bind(this));

    var getStatsBind = this.getStats.bind(this);
    // TODO: This causes error if something else already uses this port.  Catch the error.
    this.httpServer.listen(port, function () {
        // Stats server
        console.log("[Game] Loaded stats server on port " + port);
        setInterval(getStatsBind, this.config.serverStatsUpdate * 1000);
    }.bind(this));
};

GameServer.prototype.getStats = function() {
    // Get server statistics
    var totalPlayers = 0;
    var alivePlayers = 0;
    var spectatePlayers = 0;
    for (var i = 0; i < this.clients.length; i++) {
        var socket = this.clients[i];
        if (socket == null || !socket.isConnected)
            continue;
        totalPlayers++;
        if (socket.playerTracker.cells.length > 0)
            alivePlayers++;
        else
            spectatePlayers++;
    }
    var s = {
        'server_name': this.config.serverName,
        'server_chat': this.config.serverChat ? "true" : "false",
        'border_width': this.border.width,
        'border_height': this.border.height,
        'gamemode': this.gameMode.name,
        'max_players': this.config.serverMaxConnections,
        'current_players': totalPlayers,
        'alive': alivePlayers,
        'spectators': spectatePlayers,
        'update_time': this.updateTimeAvg.toFixed(3),
        'uptime': Math.round((new Date().getTime() - this.startTime)/1000/60),
        'start_time': this.startTime
    };
    this.stats = JSON.stringify(s);
};

// Custom prototype functions
WebSocket.prototype.sendPacket = function(packet) {
    if (packet == null) return;

    //if (this.readyState == WebSocket.OPEN && (this._socket.bufferSize == 0) && packet.build) {
    if (this.readyState == WebSocket.OPEN) {
        var buffer = packet.build(this.playerTracker.socket.packetHandler.protocol);
        if (buffer != null) {
            this.send(buffer, { binary: true });
        }
    } else {
        this.readyState = WebSocket.CLOSED;
        this.emit('close');
        this.removeAllListeners();
    }
};

// Ping the server tracker.
// To list us on the server tracker located at http://ogar.mivabe.nl/master
// Should be called every 30 seconds
GameServer.prototype.pingServerTracker = function () {
    // Get server statistics
    var totalPlayers = 0;
    var alivePlayers = 0;
    var spectatePlayers = 0;
    for (var i = 0; i < this.clients.length; i++) {
        var socket = this.clients[i];
        if (socket == null || !socket.isConnected)
            continue;
        totalPlayers++;
        if (socket.playerTracker.cells.length > 0)
            alivePlayers++;
        else
            spectatePlayers++;
    }
    /* Sending Ping */
    // Why don't just to use JSON?
    var data = 'current_players=' + totalPlayers +
               '&alive=' + alivePlayers +
               '&spectators=' + spectatePlayers +
               '&max_players=' + this.config.serverMaxConnections +
               '&sport=' + this.config.serverPort +
               '&gamemode=[*] ' + this.gameMode.name +  // we add [*] to indicate that this is multi-server
               '&agario=true' +                         // protocol version
               '&name=Unnamed Server' +                 // we cannot use it, because other value will be used as dns name
               '&opp=' + os.platform() + ' ' + os.arch() + // "win32 x64"
               '&uptime=' + process.uptime() +          // Number of seconds server has been running
               '&start_time=' + this.startTime;
    var options ={
        host: 'ogar.mivabe.nl',
        port: '80',
        path: '/master',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(data)
        }
    };
    var req = http.request(options, function (res) {
        if (res.statusCode != 200) {
            console.log("\u001B[1m\u001B[31m[Tracker Error] " + res.statusCode + "\u001B[0m");
        }
    });
    req.on('error', function (e) {
        console.log("\u001B[1m\u001B[31m[Tracker Error] " + e.message + "\u001B[0m");
    });
    req.write(data);
    req.end()
};

