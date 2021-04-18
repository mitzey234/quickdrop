const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const aes256 = require('aes256');
const ip = require('ip');

var sysInfo = {hostname: os.hostname(), username: os.userInfo().username};

function getCandidates () {
  var ifaces = os.networkInterfaces();
  var addresses = [];
  for (i in ifaces) {
    var interface = ifaces[i];
    for (x in interface) {
      if (interface[x].family == "IPv4" && interface[x].internal != true) addresses.push(interface[x].address);
    }
  }
  return addresses;
}

function generateKeys () {
  this.key.chain = crypto.createECDH('secp224r1');
  this.key.chain.generateKeys();
  this.key.pub = this.key.chain.getPublicKey().toString('base64');
}

function createSocket () {
  return new Promise(function(resolve, reject) {
    var sock = dgram.createSocket('udp4');
    //sock.resolve = resolve;
    sock.on("listening", function (a) {
      console.log("Socket port bound to: " + this.address().address + ":" + this.address().port);
      this.lport = this.address().port;
    });
    sock.on("message", function (res, m, r) {
      try {
        m = JSON.parse(m.toString());
      } catch (e) {
        return;
      }
      if (m.type == "CLIRESP") {
        this.pport = m.respPort;
        this.paddr = m.respAddress;
        if (ip.isPrivate(this.paddr) && m.reported != null) this.paddr = m.reported;
        clearTimeout(this.timeout);
        this.timeout = null;
        clearInterval(this.int);
        this.int = null;
        this.removeAllListeners("message");
        res(this);
      }
      //console.log(m.toString(), r);
    }.bind(sock, resolve));
    sock.send(Buffer.from(JSON.stringify({type: "CLIREQ"})), this.network.server.server.port, this.network.server.server.address);
    sock.int = setInterval(function (sock2) {
      sock2.send(Buffer.from(JSON.stringify({type: "CLIREQ"})), this.network.server.server.port, this.network.server.server.address);
    }.bind(this, sock), 1000);
    sock.timeout = setTimeout(function (socke) {
      socke.removeAllListeners("message");
      this(socke);
    }.bind(resolve, sock), 7000);
  }.bind(this));
}

function enc (m) {
  if (this.key.shared == null) return;
  if (typeof m == "object") {
    m = JSON.stringify(m);
  } else if (typeof m != "string") {
    m = m.toString();
  }
  return aes256.encrypt(this.key.shared, m);
}

function timeout () {
  console.log("Client Timed out");
  onProgUpdate.bind(this)("Socket Timeout");
  this.close();
}

function secondarySend (m) {
  this.targets.sort(function (a,b){return b.mping-a.mping});
  var link;
  for (i in this.targets) {
    if (this.targets[i].alive) {
      link = this.targets[i]
      break;
    }
  }
  if (link == null) return -1;
  if (this.activeLink == null) this.activeLink = link;
  if (this.activeLink != link) {
    this.activeLink = link;
    if (this.onLinkUpdate != null) this.onLinkUpdate(link);
  }
  m = enc.bind(this)(m);
  m = Buffer.from(m, 'base64');
  this.socket.send(m, link.port, link.addr);
}

function socketMess (m,r) {
  //console.log(m.toString(),r);
  try {
    m = JSON.parse(aes256.decrypt(this.key.shared, m.toString('base64')));
  } catch (e) {
    console.log(e, m.toString());
    return;
  }
  //console.log(2, m,r);
  if (m.type == "PING") {
    m = JSON.stringify({type: "PONG", id: m.id});
    m = enc.bind(this)(m);
    this.socket.send(Buffer.from(m, "base64"), r.port, r.address);
  } else if (m.type == "PONG" && m.id != null) {
    for (i in this.targets) {
      if (this.targets[i].id == m.id) {
        this.targets[i].pingResp();
        break;
      }
    }
  } else if (m.type == "READY") {
    this.peerReady = true;
    if (this.ready) secondarySend.bind(this)({type: "READYRESP"});
  } else if (m.type == "READYRESP") {
    this.peerReady = true;
    if (this.onConnect != null) this.onConnect(this);
  } else if (this.onMess) {
    this.onMess(m, this.machineID);
  }
}

function randomString (len) {
  var result = '';
  var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (var x = 0; x < len; x++) result += characters.charAt(Math.floor(Math.random() * characters.length));
  return result;
}

function checkTargets () {
  var connected = false;
  for (i in this.targets) {
    if (this.targets[i].timeouts < 3) connected = true;
  }
  if (connected == false) {
    console.log("Connection to client lost");
    this.close();
  }
}

function initTargets () {
  onProgUpdate.bind(this)("Connecting");
  for (i in this.targets) {
    var target = this.targets[i];
    target.id = Date.now()+randomString(5);
    target.timeouts = 0;
    target.mping = -1;
    target.timeoutFunction = function (main) {
      this.timeout = null;
      this.inProg = false;
      this.timeouts++;
      if (this.timeouts >= 3) {
        this.timeouts = 3;
        this.alive = false;
      }
      this.mping = -1
      checkTargets.bind(main)();
    }.bind(target, this);
    target.pingResp = function (main) {
      this.mping = Date.now()-this.last;
      //console.log(this.id, this.mping+"ms");
      if (typeof main.onPingUpdate == "function") main.onPingUpdate(this.mping, this.id);
      clearTimeout(this.timeout);
      this.timeout = null;
      this.timeouts = 0;
      if (!this.alive) console.log(this.addr + ":" + this.port + " is alive - " + this.mping + "ms");
      this.alive = true;
      this.inProg = false;
      if (main.timeout != null) {
        clearTimeout(main.timeout);
        main.timeout = null;
        main.send = secondarySend;
        main.ready = true;
        main.send({type: "READY"});
        if (main.peerReady) secondarySend.bind(main)({type: "READYRESP"});
      }
    }.bind(target, this);
    target.ping = function (main) {
      if (this.inProg) return;
      this.inProg = true;
      this.last = Date.now();
      m = Buffer.from(enc.bind(main)({type: "PING", id: this.id}), 'base64');
      main.socket.send(m, this.port, this.addr);
      this.timeout = setTimeout(this.timeoutFunction, 1500);
    }.bind(target, this);
    target.pingInt = setInterval(target.ping, 250);
    this.targets[i] = target;
  }
}

function alternative (o, ignores) {
  var t = {};
  var objects = [];
  for (i in o) {
    if (ignores != null && ignores.includes(i)) continue;
    if (typeof o[i] == "object") {
      if (o[i] == null) continue;
      if (o[i].constructor.name == "Object") {
        t[i] = alternative(o[i]);
      } else if (o[i].constructor.name == "Array") {
        var sourceArr = o[i];
        var arr = [];
        for (x in sourceArr) {
          if (typeof sourceArr[x] == "object") {
            arr[x] = alternative(sourceArr[x]);
          } else {
            arr[x] = sourceArr[x];
          }
        }
        t[i] = arr;
      } else if (o[i].constructor.name == "Peer") {
        t[i] = alternative(o[i]);
      }
    } else if (typeof o[i] == "function") {
      //none
    } else {
      t[i] = o[i];
    }
  }
  return t;
}

function onProgUpdate (m) {
  if (this.onProg != null && typeof this.onProg == "function") this.onProg(m);
}

module.exports = class Peer {
	//a == (array)
  constructor(network) {
		this.network = network;
    this.key = {};
    this.socket = null;
  }

  close () {
    if (this.targets != null) {
      secondarySend.bind(this)({type: "CLOSE"});
      for (i in this.targets) {
        var target = this.targets[i];
        if (target.pingInt != null) clearInterval(target.pingInt);
        if (target.timeout != null) clearTimeout(target.timeout);
      }
    }
    if (this.socket != null) this.socket.close();
    if (this.timeout != null) clearTimeout(this.timeout);
    if (this.onClose != null) this.onClose();
  }

  parseMessage (m) {
    m = m.data;
    if (this.secure == true) {
      try {
        m = JSON.parse(aes256.decrypt(this.key.shared, m));
      } catch (e) {
        console.log("Decoding error:", e, m);
        return;
      }
    }
    //console.log("Parsing message:", m);
    if (m.type == "CONRESP") {
      this.key.shared = this.key.chain.computeSecret(m.pub, 'base64', 'hex');
      this.secure = true;
      var data = {type: "SENDCANDIDATES", candidates: this.candidates, info: sysInfo};
      this.send(data);
    } else if (m.type == "SENDCANDIDATES") {
      var data = {type: "RESPCANDIDATES", candidates: this.candidates, info: sysInfo};
      this.send(data);
      this.targets = m.candidates;
      this.info = m.info;
      //console.log("Got targets", this.targets);
      initTargets.bind(this)();
    } else if (m.type == "RESPCANDIDATES") {
      this.targets = m.candidates;
      this.info = m.info;
      //console.log("Got targets", this.targets);
      initTargets.bind(this)();
    }
  }

  send (m) {
    var o = {};
    o.type = "CLIMESS";
    o.destination = this.machineID;
    if (this.secure) o.data = enc.bind(this)(m);
    else o.data = m;
    this.network.send(o);
  }

  async receive (machineID, candidates, pub) {
    if (this.network == null || this.network.state != 1) return -1; //Network down
    this.machineID = machineID;
    onProgUpdate.bind(this)("Peer Object INIT");
    onProgUpdate.bind(this)("Generating Keys");
    generateKeys.bind(this)();
    this.key.shared = this.key.chain.computeSecret(pub, 'base64', 'hex');
    var o = {};
    onProgUpdate.bind(this)("Getting Candidates");
    var candidates = getCandidates();
    onProgUpdate.bind(this)("Creating Socket");
    this.socket = await createSocket.bind(this)();
    this.socket.on("message", socketMess.bind(this));
    for (i in candidates) candidates[i] = {addr: candidates[i], port: this.socket.lport};
    if (this.socket.pport != null && this.socket.paddr != null) candidates.push({addr: this.socket.paddr, port: this.socket.pport, public: true});
    this.candidates = candidates;
    onProgUpdate.bind(this)("Socket Created");
    var data = {type: "CONRESP", pub: this.key.pub};
    this.timeout = setTimeout(function () {
      this.timeout = null;
      timeout.bind(this)();
    }.bind(this), 5000);
    this.send(data);
    this.secure = true;
  }

  async connect (machineID) {
    if (this.network == null || this.network.state != 1) return -1; //Network down
    onProgUpdate.bind(this)("Peer Object INIT");
    this.machineID = machineID;
    onProgUpdate.bind(this)("Generating Keys");
    generateKeys.bind(this)();
    var o = {};
    onProgUpdate.bind(this)("Getting Candidates");
    var candidates = getCandidates();
    onProgUpdate.bind(this)("Creating Socket");
    this.socket = await createSocket.bind(this)();
    this.socket.on("message", socketMess.bind(this));
    for (i in candidates) candidates[i] = {addr: candidates[i], port: this.socket.lport};
    if (this.socket.pport != null && this.socket.paddr != null) candidates.push({addr: this.socket.paddr, port: this.socket.pport, public: true});
    //console.log("Remote:",socket.pport, socket.paddr);
    this.candidates = candidates;
    onProgUpdate.bind(this)("Socket Created");
    var data = {type: "CONREQ", pub: this.key.pub};
    this.timeout = setTimeout(function () {
      this.timeout = null;
      timeout.bind(this)();
    }.bind(this), 5000);
    this.send(data);
  }

  fileFriendly () {
    return alternative(this, ["network", "socket", "key"]);
  }

};
