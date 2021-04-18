const {fork, spawn} = require("child_process");
const path = require('path');
const fs = require('fs');

//On process stop
function onStop () {
  var userStop = this.cprocess.userStop;
  this.cprocess.exited = true;
  this.cprocess = null;
  if (this.state == 7) return;
  if (this.state == 3 || this.state == 2) {
    console.log("Transmit process stopped unexpectedly! Transfer ERR!");
    stateChange.bind(this)(-4); //Transfer Err
    if (this.sock != null) this.sock.send({type: "STOPERR", transferID: this.id});
    return;
  }
  if (userStop) stateChange.bind(this)(5);
  else stateChange.bind(this)(1);
  console.log("Process Stopped");
}

//On Process errors
function onError (e) {
  console.log("Process Error:", e);
}

//changes main to a more friendly object
function translateMain () {
  return alternative(this);
}

//On message from transfer process
function onMessage (m) {
  if (m.type == "ready") {
    this.cprocess.send({type:"config", config: translateMain.bind(this)()});
  } else if (m.type == "CS") {
    m.type = "CONTROL";
    m.transferID = this.id;
    if (this.sock != null) this.sock.send(m);
  } else if (m.type == "START") {
    stateChange.bind(this)(3);
  } else if (m.type == "COMPLETE") {
    this.complete = true;
    this.info.progress = 100;
    this.info.speed = 0;
    this.info.dataCount = this.size;
    stateChange.bind(this)(7);
    if (m.progress != null) this.progress = m.progress;
    this.cprocess.send({type: "QUIT"});
  } else if (m.type == "STOPCOMPLETE") {
    if (m.mtu != null) this.lastMTU = m.mtu;
    if (m.complete != null) this.complete = m.complete;
    if (m.progress != null) this.progress = m.progress;
    if (this.type == 1) {
      //If receiver, pass along transfer state details
      if (this.sock != null) this.sock.send({type: "SYNC", progress: this.progress, complete: this.complete, transferID: this.id});
    }
    this.cprocess.send({type: "QUIT"});
  } else if (m.type == "SYNC") {
    this.progress = m.progress;
    if (this.sock != null) this.sock.send({type: "SYNC", progress: this.progress, transferID: this.id});
  } else if (m.type = "UPDATE") {
    this.info.progress = m.progress;
    this.info.speed = m.speed;
    this.info.est = secondsToHM(Math.round((this.size - m.dataCount)/m.speed)) + " Remaining";
    this.info.dataCount = m.dataCount;
    if (this.onstateChange != null) this.onstateChange(this.state);
  }
}

function secondsToHM(s) {
    let hours = Math.floor(s / 3600);
    let minutes = Math.floor((s - (hours * 3600)) / 60);
    let seconds = Math.floor(s - (hours * 3600) - (minutes * 60));
    let string = "";
    if (hours != null && hours != 0) string += hours + " Hour";
    if (hours != 1 && (hours != null && hours != 0)) string += "s";
    if (hours != null && hours != 0 && (minutes != 0 || seconds != 0)) string += " ";
    if (minutes != null && minutes != 0) string += minutes + " Minute";
    if (minutes != 1 && (minutes != null && minutes != 0)) string += "s";
    if (minutes != null && minutes != 0 && seconds != 0) string += " ";
    if (seconds != null && seconds != 0) string += seconds + " Second";
    if (seconds != 1 && (seconds != null && seconds != 0)) string += "s";
    if (string == "") return "No Data";
    return string;
  }

//Change transfer state and call the event if needed
function stateChange (state) {
  this.state = state;
  if (this.onstateChange != null) this.onstateChange(state);
}

/* main breakdown
{
  startTime: 1617523954345,
  state: 2,
  name: 'test.mp4',
  sha: '978b92ee84c19db3109a28b77411d5e72fcd9818b7c03ffa904c252ad233051f',
  type: 1,
  ext: '.mp4',
  id: 'd3ccd6048689a0ff0c250d8dda3ef5c8650a372065491b527e56f921d8fb335c',
  path: './test.mp4',
  size: 493832016,
  source: '55a5cf13cf445842eb509b37b4186079',
  network: {
    state: 1,
    ident: '89cf0fe8361979432ff00dad11421fa9',
    server: {
      server: {
        address: '206.189.191.105',
        port: 1097,
        state: 0,
        failedConnectAttempts: 0,
        id: 'eab9f9f7478c51efcd975504f7f978a2333226703e6fed01d1caa47a5843736f',
        ping: 22.5
      },
      ident: 'eab9f9f7478c51efcd975504f7f978a2333226703e6fed01d1caa47a5843736f',
      state: 1,
      address: '206.189.191.105',
      pingTimeoutCount: 0,
      verified: {
        verificationID: 0,
        ident: 'eab9f9f7478c51efcd975504f7f978a2333226703e6fed01d1caa47a5843736f',
        key: '-----BEGIN PUBLIC KEY-----\n' +
          'MEkwEwYHKoZIzj0CAQYIKoZIzj0DAQEDMgAEXzVp9/Wj1bZSA/gAh65armwXaSqJ\n' +
          'JKJDZVhyqeRPW1nUBK4xFfaEzBsEQOxR/hQu\n' +
          '-----END PUBLIC KEY-----\n',
        status: true,
        signature: 'MDUCGB0cUw91ddsjLxn/1Lyc1/QEBIPS8u2pLAIZAPnn4jOCftG40AZRaoh3aDwWWexqnTquDw=='      }
    }
  },
  sock: {
    network: {
      state: 1,
      ident: '89cf0fe8361979432ff00dad11421fa9',
      server: {
        server: {
          address: '206.189.191.105',
          port: 1097,
          state: 0,
          failedConnectAttempts: 0,
          id: 'eab9f9f7478c51efcd975504f7f978a2333226703e6fed01d1caa47a5843736f',
          ping: 22.5
        },
        ident: 'eab9f9f7478c51efcd975504f7f978a2333226703e6fed01d1caa47a5843736f',
        state: 1,
        address: '206.189.191.105',
        pingTimeoutCount: 0,
        verified: {
          verificationID: 0,
          ident: 'eab9f9f7478c51efcd975504f7f978a2333226703e6fed01d1caa47a5843736f',
          key: '-----BEGIN PUBLIC KEY-----\n' +
            'MEkwEwYHKoZIzj0CAQYIKoZIzj0DAQEDMgAEXzVp9/Wj1bZSA/gAh65armwXaSqJ\n' +
            'JKJDZVhyqeRPW1nUBK4xFfaEzBsEQOxR/hQu\n' +
            '-----END PUBLIC KEY-----\n',
          status: true,
          signature: 'MDUCGB0cUw91ddsjLxn/1Lyc1/QEBIPS8u2pLAIZAPnn4jOCftG40AZRaoh3aDwWWexqnTquDw=='
        }
      }
    },
    key: {
      pub: 'BN6uVzR944UM4vBfex4hYogCKgPneF/dkne0cFtSv5824O+5Vqv2yTrZPMD8RWzh1epaI678tlDdXXvh2x63vF4=',
      shared: '8d69d66f72e277e458c8a0dafb855b5f73d1140a0d87cf9843646f32d31a67cf'
    },
    machineID: '55a5cf13cf445842eb509b37b4186079',
    public: [
      { addr: '192.168.1.127', port: 52053 },
      { addr: '10.100.208.20', port: 52053 },
      { addr: '169.254.80.92', port: 52053 },
      { addr: '131.162.53.29', port: 52053, public: true }
    ],
    secure: true,
    timeout: [
      {
        addr: '192.168.1.127',
        port: 52052,
        id: '16175239545043D1YO',
        timeouts: 0,
        mping: 2,
        inProg: false,
        last: 1617523954761,
        alive: true
      },
      ...
    ],
    ready: true,
    activeLink: {
      addr: '192.168.1.127',
      port: 52052,
      id: '16175239545043D1YO',
      timeouts: 0,
      mping: 2,
      inProg: false,
      last: 1617523954761,
      alive: true
    },
    peerReady: true
  }
}
*/

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

module.exports = class Transfer {
  constructor (name, sha, type, ext, startTime, id, path, size, machineID, network, compress, encrypted) {
    this.name = name;
    this.sha = sha;
    this.info = {};
    this.type = type; //0 = sending, 1 = receiving
    this.ext = ext;
    this.startTime = startTime;
    this.id = id;
    this.path = path;
    this.size = size;
    this.compress = compress;
    this.encrypted = encrypted;
    if (this.compress == 0) this.compress = null;
    if (this.encrypted == 0) this.encrypted = null;
    if (this.type == 0) this.destination = machineID;
    else this.source = machineID;
    this.network = network;

    this.cprocess = null;
    this.state = 0; //0 = Initialized, 1 = waiting, 2 = starting, 3 = transfering, 4 = stopping, 5 = stopped by user, 6 = canceled, 7 = complete

    //Transfer request Sync section
    if (this.type == 0) {
      //Transmitter
      this.request();
    } else if (this.type == 1) {
      //Reciever
      var d = {type: "CLIMESS", destination: machineID, data: {type: "TRANSREC", id: this.id}};
      this.network.send(d);
    }

    this.setState = stateChange.bind(this);
  }

  stop (state) {
    if (this.state != 2 && this.state != 3) return;
    stateChange.bind(this)(4); //stopping
    if (state == 5) {
      console.log("User stop requested");
      this.cprocess.userStop = true;
    } else console.log("Stopping");
    if (this.cprocess) this.cprocess.send({type: "STOP"});
    if (!this.peerStopReqested && this.sock != null) this.sock.send({type: "STOP", transferID: this.id});
    else this.peerStopReqested = null;
  }

  start () {
    if ((this.state != 1 && this.state != 5 && this.state != -4) || this.sock == null) return;
    stateChange.bind(this)(2);
    console.log("Starting");
    if (this.type == 0) this.cprocess = fork(path.join(__dirname, './transmitter.js'), {stdio: "pipe"});
    else if (this.type == 1) this.cprocess = fork(path.join(__dirname, './receiver.js'), {stdio: "pipe"});
    this.cprocess.stdout.on("data", function (d) {
      var a = d.toString().trim().split("\n");
      for (i in a) console.log("["+ (this.name) + "] " + a[i]);
    }.bind(this));
    this.cprocess.stderr.on("data", function (d) {
      var a = d.toString().trim().split("\n");
      for (i in a) console.log("["+ (this.name) + "] " + a[i]);
    }.bind(this));

    this.cprocess.on("message", onMessage.bind(this));
    this.cprocess.on("exit", onStop.bind(this));
    this.cprocess.on("error", onError.bind(this));

    this.sock.send({type:"STARTUP", transferID: this.id});

    //if (this.type == 0) setTimeout(this.stop.bind(this, 5), 3.5*1000);
    //if (this.type == 0) setTimeout(this.start.bind(this), 10 * 1000);
  }

  cancel () {
    if (this.timeout != null) {clearTimeout(this.timeout); this.timeout = null;}
    if (!this.peerCancelReqested && this.sock != null) this.sock.send({type: "CANCEL", transferID: this.id});
    this.stop();
    this.delete();
  }

  delete () {
    if (this.onDelete != null) this.onDelete();
  }

  updateLink (link) {
    if (this.state == 3) {
      console.log("Updating Link:", alternative(link));
      this.cprocess.send({type: "LINKUPDATE", link: alternative(link)});
    }
  }

  peerMessage (m) {
    if (m.type == "CONTROL") {
      m.type = "CS";
      if (this.cprocess != null) this.cprocess.send(m);
      if (m.data.type == "COMPLETE" && m.data.progress != null) this.progress = m.data.progress;
    } else if (m.type == "STOP") {
      console.log("Peer requested stop");
      this.peerStopReqested = true;
      this.stop();
    } else if (m.type == "STOPERR") {
      console.log("Peer requested stop due to peer side err");
      this.peerStopReqested = true;
      this.stop();
    } else if (m.type == "SYNC") {
      this.progress = m.progress;
      this.complete = m.complete;
    } else if (m.type == "STARTUP") {
      this.start();
    } else if (m.type == "CANCEL") {
      console.log("Peer requested cancel");
      this.peerCancelReqested = true;
      this.cancel()
    }
  }

  updatePing (mping, id) {
    if (this.sock != null && this.sock.activeLink != null && id == this.sock.activeLink.id && this.cprocess != null && !this.cprocess.exited) {
      this.cprocess.send({type:"activeLink", activeLink: alternative(this.sock.activeLink)});
    }
  }

  request () {
    if (this.timeout != null || this.type != 0 || (this.state != 0 && this.state != -2)) return;
    stateChange.bind(this)(-1); //Awaiting client receive

    var d = {};
    d.type = "CLIMESS";
    d.destination = this.destination;
    d.data = {type: "TRANSREQ", name: this.name, sha: this.sha, ext: this.ext, id: this.id, size: this.size, startTime: this.startTime, compress: this.compress, encrypted: this.encrypted};

    if (this.network.send(d) != -1) {
      console.log("Sending Request:", this.name, this.destination);
      this.timeout = setTimeout(function () {
        this.timeout = null;
        stateChange.bind(this)(-2); //Client did not respond
        console.log("Client Identifier timeout");
        this.request();
      }.bind(this), 7000);
    } else {
      stateChange.bind(this)(-3); //Waiting for network
    }
  }

  fileFriendly () {
    return alternative(this, ["network", "sock"])
  }

}
