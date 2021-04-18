const dgram = require('dgram');
const WebSocket = require('ws');
const fs = require('fs');
const crypto = require('crypto');
var ip = require('ip');
const si = require('systeminformation');
const path = require("path");

var serverLogPath = path.join(__dirname, "../data/serverLog.json");

var debug = false;
var identifier;
var publicIdent;

//We use a serverLog file to keep track of host and verification data
if (!fs.existsSync(serverLogPath)) {
  if (!fs.existsSync(path.join(__dirname, "../data"))) {
    fs.mkdirSync(path.join(__dirname, "../data"));
  }
  try {
    fs.writeFileSync(serverLogPath, "{}");
  } catch (e) {
    console.log("Error creating serverlog file, check file permissions. Error: " + e.code, e);
    process.exit(0);
  }
}

var serverLogs;
try {
  serverLogs = fs.readFileSync(serverLogPath, 'utf8');
  serverLogs = JSON.parse(serverLogs);
} catch (e) {
  console.log("Error reading serverlog file, check the file and try again. Error: " + e.code, e);
  process.exit(0);
}

//Catch any missing pieces of the serverlogs
if (serverLogs.verification == null) serverLogs.verification = {};
if (serverLogs.servers == null) serverLogs.servers = {};
fs.writeFileSync(serverLogPath, JSON.stringify(serverLogs));

//We get the client's idendification using systeminformation and SHA256
//This identifier is based off the systems UUID generated by the OS during machine installation
si.uuid(function (r) {
  var h = r.hardware;
  if (h == "") r.os;
  identifier = crypto.createHash('SHA256').update(h).digest('hex');
});

function ready () {
  searchForPeers();
}

var activeServer;
var servers = {}; //Signalling Servers

//How many pings in order to finish pingtest for Signal Servers
var pings = 10;

function pingRet () {
  var comp = true;
  for (i in servers) {
    var server = servers[i];
    if (server.UDPping && server.UDPping.resp == null) {
      comp = false;
      break;
    }
  }
  if (comp) {
    var arr = [];
    for (i in servers) {
      if (servers[i].UDPping && servers[i].UDPping.resp == "COMP") arr.push(servers[i]);
      delete servers[i].UDPping;
    }
    if (arr.length == 0) return connectVServer();
    arr.sort(function (a,b) {return a.ping-b.ping});
    if (debug) console.log("List of servers:", arr);
    connectTo(arr[0]);
  }
}

//Connect to signalling server
function connectTo (server) {
  if (activeServer != null) return;
  console.log("Connecting to Server:", server.id);
  //State: 0 = connecting, 1 = Authenticating, 3 = connected, 4 = closed, 5 = closing
  var peer = {server: server, ident: server.id, state: 0};
  activeServer = peer;
  peer.socket = new WebSocket('ws://' + server.address + ":" + server.port);

  peer.socket.on("open", onServerOpen.bind(peer));
  peer.socket.on("close", onServerClose.bind(peer));
  peer.socket.on("error", onServerError.bind(peer));
  peer.socket.on("message", onServerResp.bind(peer));

  peer.address = server.address;

  peer.pingTimeoutCount = 0;

  peer.socket.sendO = function (m) {
    if (this.socket.readyState != 1) return;
    this.socket.send(JSON.stringify(m));
  }.bind(peer);

  peer.close = function () {
    if (this.state == 4) return -1; //Connection already closed

    //try forcing the connection closed
    try {
      this.socket.close();
    } catch (e) {
      return;
    }
    activeServer = null;
  }
}

function onServerOpen () {
  this.state = 1; //Authenticating

  //When we connect to a peer we identify ourselves
  var o = {type: "CLIENT", ident: identifier};
  this.socket.sendO(o);
}

function onServerClose () {
  if (!this.err && this.state != 5) {
    console.log("Server Connection lost", this.ident);
  }

  if (this.err == "CLOSEBEFOREEST" && debug) console.log("Connection to server canceled:", this.ident);

  if (this.int != null) {
    clearInterval(this.int);
    this.int = null;
  }

  if (this.timeout != null) {
    clearTimeout(this.timeout);
    this.timeout = null;
  }

  if (module.exports.state == 1 && module.exports.onClose != null && typeof module.exports.onClose == 'function') module.exports.onClose();
  this.state = 4;
  module.exports.state = 0;
  activeServer = null;
  module.exports.server = null;
  publicIdent = null;
  module.exports.ident = null;
  servers = {};
  searchForPeers(); //Try to get back on the net
}

function onServerError (e) {
  this.err = e.code;
  if (e.code == "ECONNREFUSED" || e.code == "ETIMEDOUT") {
    if (debug) console.log("Connection failed to peer:", this.ident);
  } else if (e.toString().indexOf("WebSocket was closed before the connection was established") > -1) {
    this.err = "CLOSEBEFOREEST";
  } else {
    console.log("Server connection error:", e);
  }
}

function onServerResp (m) {
  try {
    m = JSON.parse(m);
  } catch (e) {
    return this.close();
  }
  if (this.verified && !verifySig(signatureStringifyer(m), this.verified.key, m.signature)) return;
  if (m.type == "IDENT") {
    //This is where we handle verification messages from the server, this is were it tells us whether it accepts us or not

    for (i in m.nodes) registerPeer(m.nodes[i]);

    if (registerNewVerif(m.verif) == -1 || registerNewVerif(m.verif) == -2) {
      //Non-genuine verification sent or unknown central authority
      console.log("Non-genuine Server refused! Non-genuine verification sent");
      serverLogs.servers[this.ident].blocked = (Date.now() + (60000*5));
      fs.writeFileSync(serverLogPath, JSON.stringify(serverLogs));
      return this.close();
    }

    var verif = verify(m.ident, m.key);

    if (verif == null) {
      console.log("Non-genuine Server refused! Verification rejected");
      serverLogs.servers[this.ident].blocked = (Date.now() + (60000*5));
      fs.writeFileSync(serverLogPath, JSON.stringify(serverLogs));
      return this.close();
    }

    this.verified = verif;

    console.log("Your identifier is:", m.identifier);
    publicIdent = m.identifier;
    module.exports.ident = publicIdent;
    module.exports.server = activeServer;
    module.exports.state = 1;
    if (module.exports.onOpen != null && typeof module.exports.onOpen == 'function') module.exports.onOpen();

    this.int = setInterval(function () {
      if (this.timeout != null) return;
      this.socket.sendO({type: "PING"});
      this.timeout = setTimeout(function () {
        this.timeout = null;
        this.pingTimeoutCount++;
        if (debug) console.log(this.ident, "Peer Timeout! - " + this.pingTimeoutCount);
        if (this.pingTimeoutCount > 3) this.socket.close();
      }.bind(this), 5000);
    }.bind(this), 1000);

  } else if (m.type == "PING") {
    this.socket.sendO({type: "PONG"});
  } else if (m.type == "PONG" && this.timeout != null) {
    clearTimeout(this.timeout);
    this.timeout = null;
    this.pingTimeoutCount = 0;
  } else {
    if (module.exports.onMessage != null && typeof module.exports.onMessage == 'function') module.exports.onMessage(m);
    else console.log("Unknown Message", m);
  }
}

//Ping Tester
function UDPPingTest (server) {
  if (debug) console.log("UDP Ping Test:", server.id);
  if (server.UDPping != null) {
    server.UDPping.stop();
    delete server.UDPping;
  }
  var p = {};
  p.address = server.address;
  p.port = server.port;
  p.ident = server.id;
  p.arrs = [];
  p.timeouts = 0;
  p.client = dgram.createSocket('udp4');
  p.stop = function () {
    if (this.stop) return;
    if (this.timeo != null) clearTimeout(this.timeo);
    this.stop = true;
    this.client.close();
  }.bind(p);
  p.complete = function (resp) {
    if (debug) console.log("UDP Complete:", resp);
    if (this.UDPping == null) return;
    this.UDPping.stop();
    this.ping = avg(this.UDPping.arrs);
    this.UDPping.resp = resp;
    pingRet();
  }.bind(server);
  p.client.on('listening', function () {
    this.send();
  }.bind(p));
  p.client.on("message", function (m,r) {
    if (r.address != this.address || r.port != this.port) return;
    try {
      m = JSON.parse(m.toString());
    } catch (e) {
      return;
    }
    //if (debug) console.log(m);
    if (m.type == "PONG") {
      if (this.timeo != null) clearTimeout(this.timeo);
      this.timeo = null;
      this.arrs.push(Date.now() - this.time);
      this.timeouts = 0;
      if (this.arrs.length >= pings) this.complete("COMP");
      else this.send();
    }
  }.bind(p));
  p.send = function () {
    if (this.timeo != null) return;
    this.timeo = setTimeout(this.timeout.bind(this), 1000);

    this.time = Date.now();
    var msg = JSON.stringify({type: "CLIPING"});
    msg = Buffer.from(msg); //Convert to required buffer format
    try {
      this.client.send(msg, this.port, this.address);
    } catch (e) {
      this.complete("ERR");
    }
  }.bind(p);
  p.timeout = function () {
    this.timeo = null;
    this.timeouts++;
    if (this.timeouts >= 3) this.complete("TIMEOUT");
    else this.send();
  }
  p.client.bind(0);
  server.UDPping = p;
}

//Search for peers code
function searchForPeers () {
  console.log("Searching for peers");
  servers = {}

  //We don't serarch if we aren't verified and don't have keys
  if (serverLogs.publicKey == null) return console.log("No public key saved");

  //We use a variable 'servers' to store a list of possible servers to connect to
  var serversCache = [];
  //We poll from our list of known servers
  for (i in serverLogs.servers) serversCache.push(serverLogs.servers[i]);
  //And sort them by their reliability
  serversCache.sort(function (a,b) {return a.failedConnectAttempts-b.failedConnectAttempts;});

  //This is where we filter out candidates that may be best suited
  var targetServers = [];
  for (i in serversCache) {
    var server = serversCache[i];
    if (server.blocked != null) if (server.blocked > Date.now()) continue; //No blocked servers allowed
    if (server.state == 1) continue; //don't connect to peers we determined to be dead, 1 == dead, 0 == known good
    if (servers[server.id] != null) continue; //Don't connect to nodes we already have a connection with
    targetServers.push(server); //Save our top pick server
  }

  //If no other options still
  if (targetServers.length == 0) {
    for (i in serversCache) {
      var server = serversCache[i];
      if (server.blocked != null) if (server.blocked > Date.now()) continue; //Still don't like blocked hosts
      if (server.state == 0) continue; //We then decide to try hosts that are knon down
      if (peers[server.id] != null) continue;
      targetServers.push(server); //Save the target
    }
  }
  if (targetServers.length == 0) return setTimeout(connectVServer, 2000); //No cadidates, contact home

  //console.log(serversCache, targetServers);

  for (i in targetServers) {
    var id = targetServers[i].id;
    if (servers[id] != null) continue;
    var server = targetServers[i];
    var s = {};
    for (x in server) s[x] = server[x]; //Duplicate data to prevent modification
    servers[id] = s;
    UDPPingTest(servers[id]);
  }
}

function avg (arr) {
  var sum = 0;
  for (i in arr) sum += arr[i];
  return Math.round(sum/arr.length*10)/10;
}

//Get object lenth
function len (o) {
  var count = 0;
  for (i in o) count++;
  return count;
}

//verification server address
var verificationAddress = "connect.gameslab.ca:1099";
var verServer;

//This is used to store newly discovered peers to serverLog, only used for verification server peers, not other kinds
function addPeer (s) {
  if (s.id == null || s.ip == null || s.port == null) return -2;
  if (serverLogs.servers[s.id] != null && serverLogs.servers[s.id].id != null && serverLogs.servers[s.id].id == s.id) {
    if (serverLogs.servers[s.id].address != s.ip || serverLogs.servers[s.id].port != s.port) {
      var o = {address: s.ip, port: s.port, state: 0, lastConnection: serverLogs.servers[s.id].lastConnection, failedConnectAttempts: 0, id: s.id};
      serverLogs.servers[s.id] = o;
      fs.writeFileSync(serverLogPath, JSON.stringify(serverLogs));
      return 2;
    } else {
      return -1;
    }
  }
  var o = {address: s.ip, port: s.port, state: 0, lastConnection: null, failedConnectAttempts: 0, id: s.id};
  serverLogs.servers[s.id] = o;
  fs.writeFileSync(serverLogPath, JSON.stringify(serverLogs));
  return 1;
}

//Grabs existing public key for host
function verify (hostID, key) {
  var highest = null;
  for (i in serverLogs.verification) {
    if (serverLogs.verification[i].ident == hostID && key == serverLogs.verification[i].key && highest == null) highest = serverLogs.verification[i].verificationID;
    if (serverLogs.verification[i].ident == hostID && key == serverLogs.verification[i].key && serverLogs.verification[i].verificationID > highest) highest = serverLogs.verification[i].verificationID;
  }
  if (highest == null) return;
  return serverLogs.verification[highest];
}

//add or update a peer to the serverLogs
function registerPeer (server) {
  if (debug) console.log("New Peer found:", server.id);
  if (serverLogs.servers[server.id] != null) {
    var s = serverLogs.servers[server.id];
    if (s.lastConnection < server) {
      serverLogs.servers[server.id] = server;
    }
  } else {
    serverLogs.servers[server.id] = server;
  }
  fs.writeFileSync(serverLogPath, JSON.stringify(serverLogs));
}

//Converts json objects to strings without signatures, helps with generating signatures and verification
function signatureStringifyer (o) {
  var string = "";
  for (i in o) if (i != "signature" && o[i] != null) string += o[i].toString();
  return string;
}

//Verifies data vs a signature using a provided key
function verifySig (data, key, signature) {
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.write(data);
  verifier.end();

  try {
    return verifier.verify(key, signature, 'base64');
  } catch (e) {
    console.log("Verification of signature failed:", e);
    return false;
  }
}

//parse verification entry and make necessary changes if valid and verified
function registerNewVerif (v) {
  if (!serverLogs.publicKey) return -2; //Central server unknown
  if (serverLogs.verification[v.verificationID] != null) return -3; //verification already exists
  if (!verifySig(signatureStringifyer(v), serverLogs.publicKey, v.signature)) return -1; //Invalid Signature
  serverLogs.verification[v.verificationID] = v; //Save it
  fs.writeFileSync(serverLogPath, JSON.stringify(serverLogs)); //Write it
}

//Connect to verification server
function connectVServer () {
  if (verServer != null && !verServer.closing) return; //if already connected, don't continue
  console.log("Connecting to central..");

  //Create new socket for connecting
  verServer = new WebSocket('ws://' + verificationAddress);

  //When connected
  verServer.on("open", function () {
    if (debug) console.log("Connected to verification server!");
    var o = {type: "CLIENT"};
    verServer.send(JSON.stringify(o));
  });

  //Set our verification server message handler
  verServer.on("message", onVServerMess);

  //On errors
  verServer.on("error", function (e) {
    verServer.err = true; //This helps block some functions so errors don't occur
    if (e.code == "ECONNREFUSED" || e.code == "ETIMEDOUT") {
      if (debug) console.log("Failed to connect to Verification Server");
    } else console.log("Verification Server error", e);
  });

  //When verification server is lost
  verServer.on("close", function () {
    if (!verServer.err && !verServer.closing) console.log("Verification server lost");
    if (!verServer.closing) setTimeout(connectVServer, 5000); //Reconnect after 5 seconds
    else if (activeServer == null)searchForPeers();
    verServer = null;
  });
}

//On Verification message
function onVServerMess (m) {
  //We make sure we're dealing with objects, if errors we disconnect because thats sus
  try {
    m = JSON.parse(m);
  } catch (e) {
    console.log(e);
    return verServer.close();
  }

  if (serverLogs.publicKey != null && serverLogs.publicKey != m.publicKey) {
    console.log("WARNING: Public Key Missmatch from central!");
    return;
  }

  //Make sure the messages the server sends match what we expect from the verification server key
  if (serverLogs.publicKey != null) if (m.signature == null || !verifySig(signatureStringifyer(m), serverLogs.publicKey, m.signature)) return this.close();
  if (m.type == "INFO") {
    console.log("Got Central Info");
    verServer.closing = true;

    if (serverLogs.publicKey == null && m.publicKey != null) {
      serverLogs.publicKey = m.publicKey;
      fs.writeFileSync(serverLogPath, JSON.stringify(serverLogs));
    }

    if (m.nodes != null) for (i in m.nodes) addPeer(m.nodes[i]);

    if (m.verification != null) {
      for (i in m.verification) registerNewVerif(m.verification[i]);
    }

    try {
      verServer.close();
    } catch (e) {
      console.log(e);
      return
    }
  }
}

module.exports = {};

module.exports.start = function (central) {
  if (this.state == 1) return;
  this.state = 0; //0 Node is not connected, 1, node is connected to the network
  this.ident = null; //Public Identifier

  if (central != null) verificationAddress = central;

  var go = function () {
    if (identifier == null) {
      setTimeout(go, 100);
      return;
    }
    if (serverLogs.publicKey == null) connectVServer();
    else ready();
  }

  if (identifier == null) {
    console.log("Identifier Not ready, delaying");
    setTimeout(go, 100);
  } else {
    go();
  }
}

module.exports.send = function (message, raw) {
  if (raw == true) {
    if (activeServer.socket.readyState != 1) return;
    activeServer.socket.send(message);
  } else {
    if (activeServer != null && this.state == 1) activeServer.socket.sendO(message);
    else return -1;
  }
}
