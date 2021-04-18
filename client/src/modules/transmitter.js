const os = require('os');
const path = require('path');
const crypto = require('crypto');
const aes256 = require('aes256');
const ip = require('ip');
const dgram = require('dgram');
const fs = require('fs');
const interval = require(path.join(__dirname, './interval.js'));

let main;
var socket; //File data socket
var remoteSockets;
var stop = false;

const lz4 = require('lz4');
const zlib = require('zlib');

var compressjs = require('compressjs');
var algorithm = compressjs.Lzjb;

var windowSize = 1;
var maxWindow = Math.pow(2,12);
var sequence = 0;
var mtuMax = 15000;
const im = new interval(1);
//im.e.on("exec", send);

console.log("Transmitter Thread " + process.pid + " Started");
process.send({type: "ready"});

process.on("message", processMessage);

function disableLookup (hostname, options, cb) {
  return cb(null, hostname, (ip.isV4Format(hostname) == 1) ? 4 : 6);
}

function createSocket () {
  return new Promise(function(resolve, reject) {
    var sock = dgram.createSocket({type: 'udp4', lookup: disableLookup});
    sock.resolve = resolve;
    sock.on("listening", function (a) {
      //console.log("Socket port bound to: " + this.address().address + ":" + this.address().port);
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
    sock.send(Buffer.from(JSON.stringify({type: "CLIREQ"})), main.sock.network.server.server.port, main.sock.network.server.server.address);
    sock.int = setInterval(function () {
      this.send(Buffer.from(JSON.stringify({type: "CLIREQ"})), main.sock.network.server.server.port, main.sock.network.server.server.address);
    }.bind(sock), 1000);
    sock.timeout = setTimeout(function (socke) {
      this(socke);
    }.bind(resolve, sock), 7000);
  });
}

//On file socket data
function socketMess (m,r) {
  if (m.length <= 4) {
    if (m.toString() == "PING") {
      socket.send(Buffer.from("PONG"), r.port, r.address);
    } else if (m.toString() == "PONG") {
      for (i in remoteSockets) {
        var remote = remoteSockets[i];
        var p;
        if (main.sock.activeLink.public == true) p = remote.pport;
        else p = remote.lport;
        if (p == r.port) {
          remote.ready = true;
          clearInterval(remote.pingInt);
          delete remote.pingInt;
          var check = checkRemotes();
          if (check) {
            console.log("Data ports ready");
            mtuTest();
          }
          break;
        }
      }
    }
  } else {
    try {
      m = JSON.parse(m.toString());
    } catch (e) {
      return console.log("File Port Parse Err:", m.toString());
    }
    m.i = parseInt(m.i, 30);
    if (m.type == "ACK" && packetTimeouts[m.i] != null && packetTimeouts[m.i].stop == null) {
      packetTimeouts[m.i].stop = true;
      if (packetTimeouts[m.i].t != null) clearTimeout(packetTimeouts[m.i].t);
      packetTimeouts[m.i].t = null;
      delete packetTimeouts[m.i];
      execute();
      acks++;
    }
  }
}

function checkRemotes () {
  var red = true;
  for (i in remoteSockets) if (remoteSockets[i].ready == null) red = false;
  return red;
}

function socketSend (m, remote) {
  if (!Buffer.isBuffer(m) && typeof m == "object") {
    m = JSON.stringify(m);
  }
  if (typeof m == "string") {
    m = Buffer.from(m);
  }
  var port;
  if (main.sock.activeLink.public == true) port = remote.pport;
  else port = remote.lport;
  if (stop == false && socket != null) socket.send(m, port, main.sock.activeLink.addr);
  delete m;
}

//Start probing the remote client sockets to secure multiple links
function startSignalling () {
  console.log("Starting Signalling");
  for (i in remoteSockets) {
    var remote = remoteSockets[i];
    remote.pingInt = setInterval(function (rem) {
      socketSend("PING", rem);
    }.bind(null, remote), 200);
  }
}

function controlSend (m) {
  process.send({type: "CS", data: m});
}

function startTransfer () {
  process.send({type: "START"});
  if (updateInt != null) clearInterval(updateInt);
  if (!main.complete) updateInt = setInterval(update, 1000/updateRate);
  if (flowInt != null) clearInterval(flowInt);
  flowInt = setInterval(dataFlow, 1000/flowUpdateRate)
  if (main.progress != null) {
    if (main.lastMTU == mtu) sequence = main.progress.b+1;
    else {
      var newIndex = Math.floor(((main.lastMTU*main.progress.b)+main.lastMTU)/mtu)-1;
      if (newIndex < 0) newIndex = 0;
      sequence = newIndex;
    }
  }
  console.log("Transfer Starting");
  if (!main.complete) execute();
}

var flowUpdateRate = 5; //Rate at which to tune the window size
var flowInt;
function dataFlow () {
  if (sends == acks && tos == 0) windowUp();
}

var tos = 0; //Timeouts per interval
var sends = 0; //Sends
var acks = 0; //Acknowledgements
var dataRate = 0; //Bytes per second
var totalSent = 0;

var ratios = [];
function avg (arr) {
  var sum = 0;
  for (i in arr) sum += arr[i];
  return sum/arr.length;
}

var updateInt;
var updateRate = 1;
function update () {
  var c = "";
  if (main.compress) c = Math.round((1-avg(ratios))*100)+"%"
  console.log(main.sock.activeLink.mping+"ms", Math.round(sequence/(Math.ceil(main.size/mtu)-1)*10000)/100 + "%", generateSize(dataRate)+"/s", c, "Window:", windowSize);
  var obj = {type: "UPDATE", progress: Math.round(sequence/(Math.ceil(main.size/mtu)-1)*10000)/100, dataCount: totalSent, speed: dataRate};
  process.send(obj);
  ///console.log(tos, sends, acks, generateSize(dataRate)+"/s")
  tos = 0;
  sends = 0;
  acks = 0;
  dataRate = 0;
  ratios = [];
}

var retransmits = [];

function generateSum (t) {
  var sum = 0;
  for (var i = 0; i < t.length; i++) sum += t[i];
  return sum;
}

function len (o) {
  var sum = 0;
  for (i in o) sum++;
  return sum;
}

function generateSize(a, b) {
  if (0 == a) return "0 Bytes";
  var c = 1000,
    d = b || 2,
    e = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"],
    f = Math.floor(Math.log(a) / Math.log(c));
  return parseFloat((a / Math.pow(c, f)).toFixed(d)) + " " + e[f]
}

//Last PacketIndex = Math.ceil(main.size/mtu)
function getIndex (index) {
  index = parseInt(index);
  var o = {};
  o.o = index*mtu; o.l = ((Math.ceil(main.size/mtu)-1 == index) ? (main.size % mtu) : mtu); o.i = index;
  return o;
}

function sumOf (data) {
  var shasum = crypto.createHash('sha256');
  shasum.update(data);
  return shasum.digest('hex');
}

function execute () {
  if (send() != -1 && stop == false) setImmediate(execute);
}

function send () {
  if (retransmits.length > 0) {
    var ind = retransmits.shift();
    if (packetTimeouts[ind] != null && packetTimeouts[ind].stop == true) return;
    sendData(getIndex(ind, 30), (packetTimeouts[ind].c*1000*Math.random()));
  }
  if (windowSize <= len(packetTimeouts) || main.pause || sequence > Math.ceil(main.size/mtu)-1) return -1; //Transfer progress blocked
  if (packetTimeouts[sequence] != null && packetTimeouts[sequence].stop == true) return;
  sendData(getIndex(sequence));
  sequence++;
  sends++;
}

var packetTimeouts = {}; //Storage of packets currently in transit
function sendData (idx, timeouts) {
  var data = Buffer.alloc(idx.l);
  var read = fs.readSync(main.fd, data, 0, idx.l, idx.o);
  totalSent += read;
  var head = idx.i.toString(30) + "|" + generateSum(data).toString(30) + "|" + idx.o.toString(30);
  if (timeouts != null) head += "|" + timeouts.toString(30);
  delete head;
  delete data;
  var b = Buffer.concat([Buffer.from(head + "="),data]);
  var beforeLength = b.byteLength;
  if (main.compress) b = comp(b);
  if (main.encrypted) b = enc(b);

  ratios.push(b.byteLength/beforeLength);

  dataRate += idx.l;
  if (stop == false) socketSend(b, remoteSockets[0]);
  delete b;
  remoteSockets.push(remoteSockets.shift());

  //t = timeout, i = index, c = timeout count
  if (packetTimeouts[idx.i] == null) packetTimeouts[idx.i] = {c: 0, i: idx.i};
  if (packetTimeouts[idx.i].t != null) {
    clearTimeout(packetTimeouts[idx.i]);
    packetTimeouts[idx.i] = null;
  }
  packetTimeouts[idx.i].t = setTimeout(pTimedOut.bind(packetTimeouts[idx.i]), (main.sock.activeLink.mping)+200);
}

function pTimedOut () {
  var ind = this.i;
  if (packetTimeouts[ind] == null) console.log("Timeout:", parseInt(ind, 30), this.stop, ((packetTimeouts[ind] != null) ? packetTimeouts[ind].c : null));
  if (this.stop || packetTimeouts[ind] == null) return;
  packetTimeouts[ind].t = null;
  packetTimeouts[ind].c++;
  if (!retransmits.includes(ind)) retransmits.push(ind);
  retransmits.sort(function (a,b) {return a-b;});

  windowDown();

  execute();
  tos++;
}

var windowUpWait; //Wait timeout that blocks increasing window size too often
var windowDownWait; //Wait timeout that blocks decreasing window size too often

function windowUp () {
  if (windowUpWait != null) return;
  windowUpWait = setTimeout(function () {windowUpWait = null}, 1000);
  windowSize = Math.floor(windowSize*1.2)+1;
  if (windowSize > maxWindow) windowSize = maxWindow;
}

function windowDown () {
  if (windowDownWait != null) return;
  windowDownWait = setTimeout(function () {windowDownWait = null}, 1000);
  windowSize = Math.floor(windowSize*0.8)-1;
  if (windowSize < 1) windowSize = 1;
}

var mtu = 100;
var mtuTimeout;
var lastGood;
function mtuTest () {
  console.log("Starting MTU Test");
  controlSend({type: "MTU"});
}

function mtuGo () {
  socketSend(Buffer.alloc(mtuMax), remoteSockets[0]);
  mtuTimeout = setTimeout(mtuTimedout, 500);
  while (mtu < mtuMax && mtuTimeout != null && stop == false) {
    socketSend(Buffer.alloc(mtu), remoteSockets[0]);
    mtu += 100;
  }
}

function mtuTimedout () {
  mtuTimeout = null;
  mtu = lastGood-100; //100 bytes resevered for overhead
  console.log("Found MTU:", lastGood);

  controlSend({type: "MTUEND", mtu: mtu});
  return;
}

function parseControl (m) {
  //console.log("Parsing:", m);
  if (m.type == "INIT") {
    //console.log("Got Init", m);
    remoteSockets = m.sockets;
    controlSend({type: "SIG"});
    startSignalling();
  } else if (m.type == "MTUSTART") {
    mtuGo();
  } else if (m.type == "MTURESP" && mtuTimeout != null && stop == false) {
    clearTimeout(mtuTimeout);
    if (m.rec == mtuMax) {
      lastGood = m.rec;
      return mtuTimedout();
    }
    mtuTimeout = setTimeout(mtuTimedout, 500);
    if (lastGood == null) lastGood = m.rec;
    if (lastGood < m.rec) lastGood = m.rec;
  } else if (m.type == "TRANSTART") {
    startTransfer();
  } else if (m.type == "EOF") {
    console.log("Awaiting file confirmation..");
    clearInterval(updateInt);
    updateInt = null;
  } else if (m.type == "FIN") {
    console.log("File Transfer Complete!");
    process.send({type: "COMPLETE"});
  } else if (m.type == "CHECK") {
    var idx = getIndex(m.seq);
    var data = Buffer.alloc(idx.l);
    if (main.fd == null) main.fd = fs.openSync(main.path,"r");
    var read = fs.readSync(main.fd, data, 0, idx.l, idx.o);
    if (m.sum != sumOf(data)) {
      if (!retransmits.includes(m.seq)) retransmits.push(m.seq);
      if (packetTimeouts[idx.i] == null) packetTimeouts[idx.i] = {c: 0, i: idx.i};
      execute();
    }
    controlSend({type: "CHECKED"});
  }
}

function enc (buff) {
  return aes256.encrypt(main.sock.key.shared, buff);
}

function comp (buff) {
  if (main.compress == 1) {
    return lz4.encode(buff);
  } else if (main.compress == 2) {
    return Buffer.from(algorithm.compressFile(buff));
  }
}

/*
Main looks like this for context
{
  sock: {
    machineID: '21fbb0e67430e62048b64657aca06cc9',
    targets: [ [Object], [Object] ],
    network: {
      state: 1,
      ident: '29bb8dc7afeb91725dbcd30960bccb14',
      server: [Object]
    },
    activeLink: target {
      addr: '72.201.46.8',
      port: 42587,
      public: true,
      id: '1615872164582KTAU4',
      alive: true
    }
  },
  name: 'test.txt',
  sha: 'c8d3b8711f9dbd4279ba09fed1a562c76895577e804936b0d6cd3603195ce412',
  type: 0,
  ext: '.txt',
  id: 'b308484cd712becb16df4cc2d0bffb46d5fa5ff4418717f00133d558f3096f9a',
  path: 'A:/Dropbox/Sliding Window Experiment/client/test.txt',
  destination: '21fbb0e67430e62048b64657aca06cc9'
}
*/

//Messages from transfer process
async function processMessage (m) {
  if (m.type == "config") {
    main = m.config;
    //console.log(main);
    main.fd = fs.openSync(main.path,"r");

    console.log("Sending", main.size, "Bytes");

    socket = await createSocket();
    socket.on("message", socketMess);
    socket.on('close', function () {
      console.log("Socket Closed");
      if (socket != null) socket = null;
    });
    controlSend({type:"INIT", lport: socket.lport, pport: socket.pport});
    //console.log(main);
  } else if (m.type == "CS") {
    parseControl(m.data);
  } else if (m.type == "activeLink" && main != null && main.sock != null) {
    main.sock.activeLink = m.activeLink;
  } else if (m.type == "QUIT") {
    if (main.fd != null) {fs.closeSync(main.fd); main.fd = null;}
    if (socket != null) socket.close();
    if (updateInt != null) {clearInterval(updateInt); updateInt = null;}
    if (flowInt != null) {clearInterval(flowInt); flowInt = null;}

    process.exit(1);
  } else if (m.type == "STOP") {
    console.log("Transfer Stop Called");
    stop = true;
    if (main.fd != null) {fs.closeSync(main.fd); main.fd = null;}
    if (socket != null) socket.close();
    for (i in packetTimeouts) if (packetTimeouts[i].t != null) clearTimeout(packetTimeouts[i].t);
    if (mtuTimeout != null) {clearTimeout(mtuTimeout); mtuTimeout = null;}
    var recordedMtu;
    if (lastGood >= mtu) recordedMtu = mtu;
    if (updateInt != null) {clearInterval(updateInt); updateInt = null;}
    if (flowInt != null) {clearInterval(flowInt); flowInt = null;}
    process.send({type: "STOPCOMPLETE", mtu: recordedMtu});
  }
}
