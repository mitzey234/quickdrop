const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
var network = require(path.join(__dirname, './modules/sigServer.js'));
const Peer = require(path.join(__dirname, './modules/peer.js'));
const Transfer = require(path.join(__dirname, './modules/transfer.js'));
var savePath = path.join(__dirname, "../");
var transferDataPath = path.join(__dirname, './data/transfers.json');

//For debugging
//console.log(crypto.getCurves());

var maxConcurrent = 10;
var transfers = {}; //Transfer storage
var connections = {}; //Active connections

const transferActiveStates = [2,3,4]; //array of transfer states considered active
const acceptableStates = [1]; //array of transfer states considered acceptable for allowing new connections
const startStates = [1, 5]; //States that should cause transfer startup on connect

var ignoreStates = [-4, -3, -2, -1, 0];

var rawFile;

if (fs.existsSync(transferDataPath)) {
  var rawdata = fs.readFileSync(transferDataPath);
  try {
    rawdata = JSON.parse(rawdata);
  } catch (e) {
    console.log("Transfers.json is damaged! Relocating file..");
    fs.renameSync(transferDataPath, transferDataPath+".damaged");
    console.log(e);
    return;
  }
  rawFile = rawdata;
  for (i in rawdata) {
    var e = rawdata[i];
    try {
      transfers[e.id] = new Transfer(e.name, e.sha, e.type, e.ext, e.startTime, e.id, e.path, e.size, null, network, e.compress, e.encrypt);
      transfers[e.id].onstateChange = onTransferStateChange;
      transfers[e.id].onDelete = onTransferDelete;
      var trans = transfers[e.id];
      for (x in e) {
        trans[x] = e[x];
      }
      if (transferActiveStates.includes(trans.state)) {
        trans.state = 1;
      }
    } catch (e) {
      console.log("Parsing errors detected in:", e);
    }
  }
}

setInterval(autoSave, 5000);

function autoSave () {
  var arr = [];
  for (i in transfers) if (!ignoreStates.includes(transfers[i].state)) arr.push(transfers[i].fileFriendly());
  var stringed = JSON.stringify(arr);
  if (stringed != rawFile) {
    //When changes detected
    fs.writeFileSync(transferDataPath, stringed);
    rawFile = stringed;
  }
}

network.start();

network.onOpen = function () {
  console.log("Connected to network, ready to start.");
  //sendFile("A:/DropBox/test.mp4", "99a21b2ca706d2332fb5debe60962231", 0, 0);
  ipcSend('networkOpen', network.ident);
}

network.onClose = function () {
  console.log("Network closed");
  ipcSend('networkClosed', network.ident);
}

network.onMessage = function (m) {
  //console.log(m);
  if (m.type == "CLIMESS") {
    if (m.data.type == "CONREQ" && connectionVerif(m.source)) {
      receivePeerConnection(m.source, m.data.candidates, m.data.pub);
      return;
    } else if (m.data.type == "TRANSREQ") {
      console.log("Transfer Request Received", m.data.name, m.source);
      onTransfer(m.data, m.source);
      //acceptReq(m.data.id);
      return;
    } else if (m.data.type == "TRANSRESP") {
      if (m.data != null && transfers[m.data.id] != null && transfers[m.data.id].type == 0 && transfers[m.data.id].state == 0) {
        transfers[m.data.id].setState(1);
        if (connections[transfers[m.data.id].destination] == null) createPeerConnection(transfers[m.data.id].destination);
        else {
          console.log("Reusing:", transfers[m.data.id].destination);
          transfers[m.data.id].sock = connections[transfers[m.data.id].destination];
          if (activeTransfers().length < maxConcurrent) transfers[m.data.id].start();
        }
      }
      return;
    } else if (m.data.type == "TRANSREC") {
      if (m.data != null && transfers[m.data.id] != null && transfers[m.data.id].type == 0) transfers[m.data.id].destination = m.source;
      if (m.data != null && transfers[m.data.id] != null && transfers[m.data.id].type == 0 && transfers[m.data.id].state == -1 && transfers[m.data.id].timeout != null) {
        console.log("Request Sent");
        clearTimeout(transfers[m.data.id].timeout);
        transfers[m.data.id].timeout = null;
        transfers[m.data.id].setState(0);
      }
      return;
    }
    if (connections[m.source] != null) return connections[m.source].parseMessage(m);
  }
  console.log("Message from network", m);
}

function onTransfer (t, source) {
  if (transfers[t.id] != null) {
    transfers[t.id].source = source;
    return;
  }
  var o = new Transfer(t.name, t.sha, 1, t.ext, t.startTime, t.id, savePath+t.name, t.size, source, network, t.compress, t.encrypted);
  transfers[o.id] = o;
  transfers[o.id].onstateChange = onTransferStateChange;
  transfers[o.id].onDelete = onTransferDelete;
  ipcSend('transferCreate', transfers[o.id].fileFriendly());
}

function onTransferStateChange (state) {
  var machineID, g;
  if (this.type == 0) {
    machineID = this.destination;
  } else if (this.type == 1) {
    machineID = this.source;
  }
  if (machineID != null) g = getTransfers(machineID);
  ipcSend('transferStateUpdate', {transfer: this.fileFriendly(), state: state, transfers: g, totalStats: totalStats()});
}

function totalStats () {
  var o = {download: 0, upload: 0};
  for (i in transfers) {
    var t = transfers[i];
    if (!transferActiveStates.includes(t.state)) continue;
    if (t.type == 0 && t.info != null && t.info.speed != null) o.upload += t.info.speed;
    if (t.type == 1 && t.info != null && t.info.speed != null) o.download += t.info.speed;
  }
  return o;
}

function onTransferDelete () {
  var machineID = this.type == 0 ? this.destination : this.source;
  if (transfers[this.id] != null) delete transfers[this.id];
  ipcSend('transferDelete', {transfer: this.fileFriendly(), mid: machineID, transfers: getTransfers(machineID)});
}

//Get active transfers for peer
function getTransfers (machineID) {
  var arr = [];
  for (i in transfers) {
    if ((transfers[i].source == machineID || transfers[i].destination == machineID) && transfers[i].state != 7) arr.push(transfers[i].fileFriendly());
  }
  return arr;
}

function connectionVerif (machineID) {
  for (i in transfers) {
    var transfer = transfers[i];
    if (transfer.type == 1 && transfer.source == machineID && acceptableStates.includes(transfer.state)) return true;
  }
  return false;
}

async function acceptReq (id) {
  if (transfers[id] == null || (transfers[id] != null && transfers[id].state != 0)) return;
  var o = transfers[id];
  o.setState(1);

  var d = {};
  d.type = "CLIMESS";
  d.destination = o.source;
  d.data = {type: "TRANSRESP", id: o.id};
  network.send(d);

  if (connections[o.source] != null) {
    transfers[id].sock = connections[o.source];
    if (activeTransfers().length < maxConcurrent) transfers[id].start();
  }
}

//Compress = 1 is light compression, 2 is heavy compression, very CPU dependant and may require multithreading support later
async function sendFile(file, destination, compress, encrypt) {
  if (!fs.existsSync(file)) return -1; //File does not exist
  try {
    fs.accessSync(file, fs.R_OK);
  } catch (e) {
    return -2; //File is not readable
  }
  var fileStats = fs.statSync(file);
  var parse = path.parse(file);
  var time = Date.now();
  var sha = await generateSHA(file);
  var o = new Transfer(parse.base, sha, 0, parse.ext, time, SHA256(parse.base+time+sha+network.ident+destination), file, fileStats.size, destination, network, compress, encrypt);
  transfers[o.id] = o;
  transfers[o.id].onstateChange = onTransferStateChange;
  transfers[o.id].onDelete = onTransferDelete;
  ipcSend('transferCreate', transfers[o.id].fileFriendly());
}

function checkQueue () {
  for (i in transfers) {
    var transfer = transfers[i];
    if (transfer.state == 1 && transfer.type == 0 && connections[transfer.destination] == null && network != null && network.state == 1) {
      createPeerConnection(transfer.destination);
    }
  }
}

function onPeerClose () {
  delete connections[this.machineID];
  var t = this.fileFriendly();
  t.transfers = getTransfers(this.machineID);
  ipcSend('peerDisconnected', t);
  console.log("Link Closed with", this.machineID);
  for (i in transfers) {
    var transfer = transfers[i];
    if (transfer.type == 0 && transfer.destination == this.machineID) {
      transfer.sock = null;
      transfer.stop();
    }
    if (transfer.type == 1 && transfer.source == this.machineID) {
      transfer.sock = null;
      transfer.stop();
    }
  }
}

function onPeerOpen () {
  console.log("Connected to peer!");
  ipcSend('peerConnected', this.fileFriendly());
  for (i in transfers) {
    var transfer = transfers[i];
    if (transfer.type == 0 && transfer.destination == this.machineID) {
      transfer.sock = this;
      if (activeTransfers().length < maxConcurrent) transfer.start();
    }
    if (transfer.type == 1 && transfer.source == this.machineID) {
      transfer.sock = this;
      if (activeTransfers().length < maxConcurrent) transfer.start();
    }
  }
}

function onPeerProg (m) {
  ipcSend('peerProg', {peer: this.fileFriendly(), msg: m});
}

function onPeerLinkChange (link) {
  for (i in transfers) {
    var transfer = transfers[i];
    if (transfer.type == 0 && transfer.destination == this.machineID) {
      transfer.updateLink(link);
    }
    if (transfer.type == 1 && transfer.source == this.machineID) {
        transfer.updateLink(link);
    }
  }
}

function onPeerMess (m) {
  if (transfers[m.transferID] != null) {
    transfers[m.transferID].peerMessage(m);
  }
}

function onPeerPingUpdate (mping, id) {
  if (this != null && this.activeLink != null && id == this.activeLink.id) ipcSend('peerPing', {peer: this.fileFriendly(), msg: mping});
  for (i in transfers) {
    var transfer = transfers[i];
    if (transfer.type == 0 && transfer.destination == this.machineID && (transfer.state == 2 || transfer.state == 3 || transfer.state == 4)) {
      transfer.updatePing(mping, id);
    }
    if (transfer.type == 1 && transfer.source == this.machineID && (transfer.state == 2 || transfer.state == 3 || transfer.state == 4)) {
      transfer.updatePing(mping, id);
    }
  }
}

//Auto Disconnect
setInterval(function () {
  for (i in connections) {
    var con = connections[i];
    if (getTransfers(con.machineID) == 0) con.close();
  }
}, 60000);

async function createPeerConnection (machineID) {
  var o = new Peer(network);
  o.onClose = onPeerClose.bind(o);
  o.onConnect = onPeerOpen.bind(o);
  o.onLinkUpdate = onPeerLinkChange.bind(o);
  o.onMess = onPeerMess.bind(o);
  o.onPingUpdate = onPeerPingUpdate.bind(o);
  o.onProg = onPeerProg.bind(o);
  o.connect(machineID);
  connections[machineID] = o;
}

async function receivePeerConnection (machineID, candidates, pub) {
  console.log("Got peer", machineID);
  var o = new Peer(network);
  o.onClose = onPeerClose.bind(o);
  o.onConnect = onPeerOpen.bind(o);
  o.onLinkUpdate = onPeerLinkChange.bind(o);
  o.onMess = onPeerMess.bind(o);
  o.onPingUpdate = onPeerPingUpdate.bind(o);
  o.onProg = onPeerProg.bind(o);
  o.receive(machineID, candidates, pub);
  connections[machineID] = o;
}

function activeTransfers () {
  var arr = [];
  for (i in transfers) {
    if (transferActiveStates.includes(transfers[i].state)) arr.push();
  }
  return arr;
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

function SHA256 (text) {
  var shasum = crypto.createHash("sha256");
  shasum.update(text);
  return shasum.digest('hex');
}

function ipcSend (event, arg) {
  try {
    if (mainWindow != null && mainWindow.webContents != null) mainWindow.webContents.send(event, arg);
  } catch (e) {
    console.log(e, arg);
  }
}

if (process.argv[2] == "--headless") return;

//ELECTRON CODE STARTS HERE
const { app, BrowserWindow, ipcMain} = require('electron');
var mainWindow;

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) { // eslint-disable-line global-require
  app.quit();
}

const createWindow = () => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // and load the index.html of the app.
  mainWindow.loadFile(path.join(__dirname, './html/Quickshare.html'));

  // Open the DevTools.
  //mainWindow.webContents.openDevTools();
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createWindow);

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.on("sendFile", function (event, arg) {
  //console.log("Send:", arg);
  sendFile(arg.path, arg.dest, arg.comp, arg.enc);
});

ipcMain.on("attach", function (event, arg) {
  console.log("Got IPC attach");
  if (network.ident != null) ipcSend('networkOpen', network.ident);
  for (i in transfers) if (!ignoreStates.includes(transfers[i].state)) ipcSend('transferCreate', transfers[i].fileFriendly());
});

ipcMain.on("accept", function (event, arg) {
  console.log("Accept");
  acceptReq(arg);
});

ipcMain.on("resume", function (event, arg) {
  if (transfers[arg] != null) transfers[arg].start();
});

ipcMain.on("pause", function (event, arg) {
  if (transfers[arg] != null) transfers[arg].stop();
});

ipcMain.on("cancel", function (event, arg) {
  if (transfers[arg] != null) transfers[arg].cancel();
});

ipcMain.on("delete", function (event, arg) {
  if (transfers[arg] != null) {
    onTransferDelete.bind(transfers[arg])();
  }
});
