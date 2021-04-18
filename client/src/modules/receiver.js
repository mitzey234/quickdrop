let crypto, aes256, ip, dgram, packetTracker, fs, zlib;
const now = require('nano-time');
const path = require('path');
const numCPUs = require('os').cpus().length/2;
if (numCPUs < 1) numCPUs = 1;
const cluster = require('cluster');
var main, socket, remoteSocket, parentUpdateInt, childUpdateInt;
var children = [];
var controlWaiting = false;
var updateRate = 1;
var stopping = false;

var lz4 = require('lz4');
var compressjs = require('compressjs');
var algorithm = compressjs.Lzjb;

var aFrames = [];

var mtu;
var mtuTesting = false; //toggles mtu responses for data handler
var transferInProg = false; //toggles fileData handler

if (cluster.isMaster) {
  // Fork workers.
  parent();
} else {
  child();
}

//Function where the parent starts at, functions below are used only by parent
function parent () {
  crypto = require('crypto');
  fs = require('fs');

  console.log("Receiver Thread " + process.pid + " Started");
  process.on("message", parentProcessMessage);

  console.log("Creating " + numCPUs + " children");
  for (var i = 0; i < numCPUs; i++) children.push(cluster.fork());
  for (i in children) {
    children[i].listIndex = i;
    children[i].on("message", onChildMessage.bind(children[i]));
    children[i].on("exit", onStop.bind(children[i]));
  }
}

function checkChildren () {
  var red = true;
  for (i in children) if (children[i].childReady == null) red = false;
  return red;
}

function checkChildrenInfo () {
  var red = true;
  for (i in children) if (children[i].info == null) red = false;
  return red;
}

function checkPorts () {
  var red = true;
  for (i in children) if (children[i].portReady == null) red = false;
  return red;
}

function checkStops () {
  var red = true;
  for (i in children) if (children[i] != null) red = false;
  return red;
}

//When a child process exits
function onStop () {
  //console.log("Child", this.listIndex, "Stopped");
  children[this.listIndex] = null;
  if (stopping == true) {
    var check = checkStops();
    if (check == true) childrenStopped();
  } else {
    console.log("Unexpected Child fall down! Transfer requires restart!");
    stop(true);
  }
}

function controlSend (m) {
  process.send({type: "CS", data: m});
}

function parentUpdate () {
  var sum = 0;
  for (i in children) {
    if (children[i].rate != null && !isNaN(children[i].rate)) sum+= children[i].rate;
  }
  //console.log(sum+"/s");
  var repairs = "";
  if (repairSeq > 0) repairs += "- " + Math.round(repairSeq/(Math.ceil(main.size/mtu)-1)*100) + "% Validated";
  console.log(main.sock.activeLink.mping+"ms", Math.round(pm.count()/(Math.ceil(main.size/mtu))*10000)/100 + "%", generateSize(sum)+"/s", repairs);
  var obj = {type: "UPDATE", progress: Math.round(pm.count()/(Math.ceil(main.size/mtu))*10000)/100, dataCount: pm.count()*mtu, speed: sum};
  process.send(obj);
  process.send({type: "SYNC", progress: pm.fileOutput()});
}

function parseControl (m) {
  //console.log("Parsing:", m);
  if (m.type == "INIT") {
    //console.log("Got Init", m);
    remoteSocket = {lport: m.lport, pport: m.pport};
    for (i in children) children[i].send({type: "remoteSocket", info: remoteSocket});
    var check = checkChildrenInfo();
    if (check == true) {
      var sockets = [];
      for (i in children) sockets.push(children[i].info);
      controlSend({type: "INIT", sockets: sockets});
    } else {
      controlWaiting = true;
    }
  } else if (m.type == "SIG") {
    for (i in children) children[i].send({type: "sig"});
  } else if (m.type == "MTU") {
    console.log("Started MTU Test");
    for (i in children) children[i].send({type: "mtu"});
  } else if (m.type == "MTUEND") {
    console.log("MTU Test Finished");
    mtu = m.mtu;
    packetTracker = require(path.join(__dirname,'./packetTracker.js'));
    if (main.progress != null) {
      if (main.lastMTU == mtu) pm = new packetTracker(main.progress);
      else {
        var newIndex = Math.floor(((main.lastMTU*main.progress.b)+main.lastMTU)/mtu)-1;
        if (newIndex < 0) newIndex = 0;
        pm = new packetTracker({arr: [], high: newIndex, based: newIndex});
      }
    } else {
      pm = new packetTracker();
    }
    controlSend({type: "TRANSTART"});
    if (parentUpdateInt != null) clearInterval(parentUpdateInt);
    if (!main.complete) parentUpdateInt = setInterval(parentUpdate, 1000/updateRate);
    if (main.complete == true) checkData();
    for (i in children) children[i].send({type: "mtuend"});
    console.log("Transfer Starting");
  } else if (m.type == "CHECKED") {
    repairSeq++;
    repairCheck(repairSeq);
  }
}

//This needs to be finished
async function checkData () {
  console.log("Transfer Complete, checking file..");
  if (parentUpdateInt != null) clearInterval(parentUpdateInt);
  var local = await generateSHA(main.path);
  if (main.sha == local) {
    console.log("File Transfer Complete!");
    for (i in children) children[i].send({type: "end"});
    controlSend({type: "FIN", progress: pm.fileOutput()});
    process.send({type: "COMPLETE", progress: pm.fileOutput()});
  } else {
    console.log("File Checksum Missmatch!\n" + main.sha + "\n" + local +"\nStarting Repair Process");
    //Begin file repair here
    if (main.fd == null) {
      if (fs.existsSync(main.path)) main.fd = fs.openSync(main.path, "r+");
      else main.fd = fs.openSync(main.path, "w+");
    }
    setInterval(parentUpdate, 1000/updateRate);
    repairSeq = 0;
    repairCheck(repairSeq);
  }
}

var repairSeq = 0;
function repairCheck () {
  if (repairSeq > (Math.ceil(main.size/mtu)-1)) return checkData();
  var idx = getIndex(repairSeq);
  var data = Buffer.alloc(idx.l);
  var read = fs.readSync(main.fd, data, 0, idx.l, idx.o);
  controlSend({type: "CHECK", seq: repairSeq, sum: sumOf(data)});
}

function sumOf (data) {
  var shasum = crypto.createHash('sha256');
  shasum.update(data);
  return shasum.digest('hex');
}

function generateSHA (file) {
  return new Promise(function(file, resolve, reject) {
    var shasum = crypto.createHash('sha256');

    // Updating shasum with file content
    var s = fs.ReadStream(file);
    s.on('data', function(data) {
      shasum.update(data)
    });

    // making digest
    s.on('end', function(sha, resolve) {
      var hash = shasum.digest('hex');
      resolve(hash);
    }.bind(null, shasum, resolve));
  }.bind(null, file));
}

function getIndex (index) {
  index = parseInt(index);
  var o = {};
  o.o = index*mtu; o.l = ((Math.ceil(main.size/mtu)-1 == index) ? (main.size % mtu) : mtu); o.i = index;
  return o;
}

function generateSize(a, b) {
  if (0 == a) return "0 Bytes";
  var c = 1000,
    d = b || 2,
    e = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"],
    f = Math.floor(Math.log(a) / Math.log(c));
  return parseFloat((a / Math.pow(c, f)).toFixed(d)) + " " + e[f]
}

//Messages from transfer to parent
async function parentProcessMessage (m) {
  if (m.type == "config") {
    main = m.config;
    for (i in children) children[i].send(m);
  } else if (m.type == "CS") {
    parseControl(m.data);
  } else if (m.type == "activeLink" && main != null && main.sock != null) {
    main.sock.activeLink = m.activeLink;
  } else if (m.type == "QUIT") {
    stop();
    process.exit(1);
  } else if (m.type == "STOP") {
    console.log("Transfer Stop Called");
    stop();
  }
}

//messages from child to parent
async function onChildMessage (m) {
  //console.log("Child Message:", m);
  if (m.type == "ready") {
    this.childReady = true;
    var check = checkChildren();
    if (check == true) process.send({type: "ready"});
  } else if (m.type == "init") {
    this.info = m.info;
    var check = checkChildrenInfo();
    if (check == true) {
      console.log("Children are ready");
      if (controlWaiting == true) {
        controlWaiting = false;
        var sockets = [];
        for (i in children) sockets.push(children[i].info);
        controlSend({type: "INIT", sockets: sockets});
      }
    }
  } else if (m.type == "portReady") {
    this.portReady = true;
    var check = checkPorts();
    if (check == true) console.log("Data ports ready");
  } else if (m.type == "mturead") {
    this.mtuRead = true;
    var red = true;
    for (i in children) if (children[i].mtuRead == null) red = false;
    if (red == true) {
      for (i in children) children[i].mtuRead = null;
      controlSend({type: "MTUSTART"});
    }
  } else if (m.type == "mturesp") {
    controlSend({type: "MTURESP", rec: m.rec});
  } else if (m.type == "parse") {
    for (i in m.arr) pm.push(m.arr[i]);
    //console.log((pm.count()/(Math.floor(main.size/mtu)+1)*100)+"%");
    if (pm.count() >= Math.ceil(main.size/mtu) && main.complete != true) {
      main.complete = true;
      clearInterval(parentUpdateInt);
      parentUpdateInt = null;
      checkData();
      var obj = {type: "UPDATE", progress: Math.round(pm.count()/(Math.ceil(main.size/mtu))*10000)/100, dataCount: pm.count()*mtu, speed: 0};
      process.send(obj);
      controlSend({type: "EOF"});
    }
  } else if (m.type == "speed") {
    this.rate = m.r;
  } else if (m.type == "stopcomplete") {
    this.send({type: "end"});
  }
}

function stop (err) {
  stopping = true;
  if (pm != null) pm.destroy();
  if (parentUpdateInt != null) {clearInterval(parentUpdateInt); parentUpdateInt = null;}
  for (i in children) {
    if (children[i] != null) {
      children[i].send({type: "stop"});
    }
  }
}

function childrenStopped () {
  console.log("Child Processes Exited");
  process.send({type: "STOPCOMPLETE", complete: main.complete, mtu: mtu, progress: pm.fileOutput()});
}

//Function where child starts, functions below are used only by child or parent at times
function child () {
  crypto = require('crypto');
  aes256 = require('aes256');
  ip = require('ip');
  zlib = require('zlib');
  dgram = require('dgram');
  fs = require('fs');

  process.on("message", childProcessMessage);
  process.send({type: "ready"});
}

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

function socketMess (m,r) {
  if (stopping) return;
  if (m.length <= 4) {
    if (m.toString() == "PING") {
      socket.send(Buffer.from("PONG"), r.port, r.address);
    } else if (m.toString() == "PONG" && remoteSocket.pingInt != null) {
      clearInterval(remoteSocket.pingInt);
      delete remoteSocket.pingInt;
      process.send({type: "portReady"});
    }
    return;
  }
  if (transferInProg) {
    try {
      if (main.encrypted) m = decrypt(m)
      if (main.compress) m = decomp(m);
    } catch (e) {
      console.log("Precheck Error:", e);
    }

    var b = m;
    var off = bufferIndexOf("=",b)+1; //Find the header separator index indicated by a "=";
    if (off == -1) return console.log("HeaderSeparator not found!");
    b = b.slice(off,b.length); // This will trim the header off till we just have our raw data.
    var header = m.slice(0, off-1).toString("ascii").split("|"); // This is our extracted header
    if (header.length < 3 || header.length > 4) return console.log("Header Failure:", m.slice(0, off-1)); //Header Size Missmatch
    var seq = parseInt(header[0],30); var sum = parseInt(header[1], 30); var off = parseInt(header[2], 30);
    if (isNaN(seq) || isNaN(sum) || isNaN(off)) return console.log("Int Err", seq, sum, off);
    if (sum != generateSum(b)) return console.log("Checksum Fail", sum, generateSum(b)); //Data failed Sum
    //No space code = ENOSPC
    fs.writeSync(main.fd, b, 0, b.length, off);

    var o = {type: "ACK", i: header[0]};
    if (stopping == false) socketSend(o, remoteSocket);

    dataCount += b.length;

    if (!aFrames.includes(seq)) aFrames.push(seq);
  } else if (mtuTesting == true) {
    process.send({type: "mturesp", rec: m.byteLength});
    return;
  }
}

var dataCount = 0;

//Essentailly called at the start of the transfer
function start () {
  mtuTesting = false;
  transferInProg = true;
  childUpdateInt = setInterval(childUpdate, 1000/5);
  process.send({type: "START"});
  if (parentUpdateInt != null) clearInterval(parentUpdateInt);
  parentUpdateInt = setInterval(sendParentAcks, 150);
}

function childUpdate () {
  process.send({type: "speed", r: dataCount*5});
  dataCount = 0;
}

function avg (arr) {
  var sum = 0;
  for (i in arr) sum += arr[i];
  return (sum/arr.length);
}

function sendParentAcks () {
  if (aFrames.length > 0) {
    var arr = aFrames.splice(0,aFrames.length);
    var o = {}; o.type = "parse"; o.arr = arr;
    process.send(o);
  }
}

function bufferIndexOf (t,buffer) {
  for (var i = 0; i < buffer.byteLength; i++) if (buffer[i] == t.charCodeAt()) return i;
  return -1;
}

function generateSum (t) {
  var sum = 0;
  for (var i = 0; i < t.length; i++) sum += t[i];
  return sum;
}

function decomp (buff) {
  if (main.compress == 1) {
    return lz4.decode(buff);
  } else if (main.compress == 2) {
    return Buffer.from(algorithm.decompressFile(buff));
  }
}

function decrypt (buff) {
  return aes256.decrypt(main.sock.key.shared, buff);
}

function socketSend (m,remote) {
  if (!Buffer.isBuffer(m) && typeof m == "object") {
    m = JSON.stringify(m);
  }
  if (typeof m == "string") {
    m = Buffer.from(m);
  }
  var port;
  if (main.sock.activeLink.public == true) port = remote.pport;
  else port = remote.lport;
  var addr = main.sock.activeLink.addr;
  if (stopping == false && socket != null) socket.send(m, port, addr);
}

function startSignalling () {
  //console.log("Starting Signalling");
  remoteSocket.pingInt = setInterval(function () {
    socketSend("PING", remoteSocket);
  }, 200);
}

//messages from parent
async function childProcessMessage (m) {
  //console.log("Message from parent:", m);
  if (m.type == "config") {
    main = m.config;

    if (fs.existsSync(main.path)) main.fd = fs.openSync(main.path, "r+");
    else main.fd = fs.openSync(main.path, "w+");
    //var t = fs.fstatSync(main.fd);
    //fs.ftruncateSync(main.fd, t.size)

    socket = await createSocket();
    socket.on("message", socketMess);
    socket.on('close', function () {
      //console.log("Socket Closed");
      if (socket != null) socket = null;
    });
    var info = {lport: socket.lport, paddr: socket.paddr, pport: socket.pport};
    process.send({type: "init", info: info});
  } else if (m.type == "remoteSocket") {
    remoteSocket = m.info;
  } else if (m.type == "sig") {
    startSignalling();
  } else if (m.type == "mtu") {
    mtuTesting = true;
    process.send({type: "mturead"});
  } else if (m.type == "mtuend") {
    start()
  } else if (m.type == "end") {
    if (main.fd != null) {fs.closeSync(main.fd); main.fd = null;}
    if (socket != null) socket.close();
    //console.log("Child " + process.pid + " Exit");
    process.exit(1);
  } else if (m.type == "stop") {
    if (childUpdateInt != null) {clearInterval(childUpdateInt); childUpdateInt = null;}
    if (parentUpdateInt != null) {clearInterval(parentUpdateInt); parentUpdateInt = null;}
    if (remoteSocket.pingInt != null) {clearInterval(remoteSocket.pingInt); delete remoteSocket.pingInt;}
    if (main.fd != null) {fs.closeSync(main.fd); main.fd = null;}
    if (socket != null) socket.close();
    sendParentAcks();
    process.send({type: "stopcomplete"}); //Before closing the receiver child we need to transfer any stray data it might be holding
  }
}
