const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');

const wss = new WebSocket.Server({port: 1099, host: "0.0.0.0"});
var ip = require('ip');
wss.on("connection", onConnection);

//check keys or create the missing file
if (!fs.existsSync(__dirname + "/keys.json")) {
  try {
    fs.writeFileSync(__dirname + "/keys.json", "{}");
  } catch (e) {
    console.log("Error creating keys file, check file permissions. Error: " + e.code, e);
    process.exit(0);
  }
}

var keys;
try {
  keys = fs.readFileSync(__dirname + "/keys.json", 'utf8');
  keys = JSON.parse(keys);
} catch (e) {
  console.log("Error reading keys file, check the file and try again. Error: " + e.code, e);
  process.exit(0);
}

//If we don't have generated keys, generate them
if (keys.private == null || keys.public == null) {
  console.log("Generating verification keypair");
  var k;
  try {
    k = crypto.generateKeyPairSync('ec', {
      namedCurve: "secp224r1",
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem'
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem'
      }
    });
  } catch (e) {
    //Catching errors
    console.log("Error generating keypair! ", e);
    process.exit(0);
  }
  keys.private = k.privateKey; //Save global vars
  keys.public = k.publicKey; //Save global vars

  //Save them
  fs.writeFileSync(__dirname + "/keys.json", JSON.stringify(keys));
  console.log("Created Keypair");
}

if (!fs.existsSync(__dirname + "/verification.json")) {
  try {
    fs.writeFileSync(__dirname + "/verification.json", "{}");
  } catch (e) {
    console.log("Error creating serverlog file, check file permissions. Error: " + e.code, e);
    process.exit(0);
  }
}

//Reading our verification
var verification;
try {
  verification = fs.readFileSync(__dirname + "/verification.json", 'utf8');
  verification = JSON.parse(verification);
} catch (e) {
  console.log("Error reading keys file, check the file and try again. Error: " + e.code, e);
  process.exit(0);
}

var blocked = []; //Blocked IP addresses, these are addresses that you don't want to take requests from

//Conected nodes
var nodes = {};

//When a verification request is recieved from a sigServer
function onVerifRequest (req) {
  console.log("Got Verification Request");
  //signRequest(req); //This is temporary, use this if you want all servers to get verified by default, NOT RECOMMENDED
}

//Signs the data with the verification servers's stored private key
function keySign (data) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.write(data);
  signer.end();
  return signer.sign(keys.private, 'base64');
}

//Check the signature of data vs a provided key
function checkSign (key, sign, data) {
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.write(data);
  verifier.end();
  try {
    return verifier.verify(key, sign, 'base64');;
  } catch (e) {
    return false;
  }
}

//Converts json objects to strings without signatures, helps with generating signatures and verification
function signatureStringifyer (o) {
  var string = "";
  for (i in o) if (i != "signature") string += o[i].toString();
  return string;
}

//Verifiy a particular server through their verification request
function signRequest (r) {
  var o = {};
  o.verificationID = len(verification); //We given them a ID based on a number
  o.ident = r.id; //Host ID number
  o.key = r.key; //Public key provided by the server for message verification
  o.status = true; //Whether or not this is a trusted node or not
  o.signature = keySign(signatureStringifyer(o)); //Signature to help nodes verifiy this is a valid signature
  console.log("Verified Server:", o);
  verification[o.verificationID] = o; //Store this verification
  fs.writeFileSync(__dirname + "/verification.json", JSON.stringify(verification));
  delete verifRequests[r.id];
}

//Current stored Verification requests
var verifRequests = {};

//Get length of object
function len (o) {
  var count = 0;
  for (i in o) count++;
  return count;
}

//Grabs existing public key for host
function verify (hostID) {
  var highest = null;
  for (i in verification) {
    if (verification[i].ident == hostID && highest == null) highest = verification[i].verificationID;
    if (verification[i].ident == hostID && verification[i].verificationID > highest) highest = verification[i].verificationID;
  }
  if (highest == null) return;
  if (verification[highest].status) return verification[highest];
  else return;
}

//Tells all noted about known hosts list
function notifyNodes (node) {
  var o = {};
  for (x in node) if (x != "ws") o[x] = node[x];

  for (i in nodes) {
    if (nodes[i].id == node.id) return;
    nodes[i].ws.sendSign({type: "NODES", arr: [o]});
  }
}

//On messages
function onMessage (m) {
  try {
    m = JSON.parse(m);
  } catch (e) {
    return this.close();
  }

  if (this.authed == null) {
    if (m.type == "CLIENT") {
      //When Clients send messages
      console.log("Client connected", this.ipAddress);
      clearTimeout(this.timeout); //Clients don't get timed out
      var arr = [];
      var resp = {};

      //make an array of connected nodes
      for (i in nodes) {
        if (ip.isPrivate(nodes[i].address)) continue; //No Private addresses
        var o = {};
        for (x in nodes[i]) if (x != "ws") o[x] = nodes[i][x]; // Make sure to not include the socket object in the response
        arr.push(o);
      }

      resp.type = "INFO";
      resp.verification = verification;
      resp.nodes = arr;
      resp.publicKey = keys.public;

      //Send clients important network info and disconnect
      this.sendSign(resp);
      return this.close();
    } else if (m.type == "SIGSERVER" && m.ident != null && m.key != null) {
      //If signalServer message
      //Check the validity of the message vs the public key provided
      if (m.key != null && !checkSign(m.key, m.signature, signatureStringifyer(m))) return this.close();

      //Check if server is verified
      var verif = verify(m.ident, m.key);
      if (verif != null) {
        //Verification passed
        clearTimeout(this.timeout); //Don't time out Sig Servers

        if (!checkSign(verif.key, m.signature, signatureStringifyer(m))) {
          //If the signatures don't add up with what is stored locally
          this.sendSign({type: "VERIF", key: keys.public, data: "SIGFAIL"});
          return this.close(); //Close Connection
        }

        //A verification server can only connect once
        if (nodes[verif.ident] != null) {
          this.sendSign({type: "VERIF", key: keys.public, data: "SIGINUSE"});
          return this.close(); //Close Connection
        }

        this.authed = verif; //Store verification information for this server
        this.listeningPort = m.port; //Store known listen port

        if (ip.isPrivate(this.ipAddress) && m.reported != null && !ip.isPrivate(m.reported)) this.ipAddress = m.reported;

        //Let server know it pass and provide known signatures
        this.sendSign({type: "VERIF", data: "PASS", key: keys.public, verification: verif, signatures: len(verification)});

        //Store this server connection to the connected nodes list
        nodes[verif.ident] = {ip: this.ipAddress, port: m.port, id: verif.ident, ws: this};
        console.log("Verified server connected: " + verif.ident, this.ipAddress);

        //Let other nodes know about this host
        notifyNodes(nodes[verif.ident]);
      } else {
        //Verification Failed
        var req = {};
        req.id = m.ident;
        req.key = m.key;
        req.ident = m.ident;

        //By default unknown sigServers are treated as a request to join the network
        if (verifRequests[req.id] == null) {
          verifRequests[req.id] = req;
          onVerifRequest(req);
        }

        //We still deny them however
        this.sendSign({type: "VERIF", key: keys.public, data: "FAIL"});
        this.close();
      }
    } else {
      this.close(); //Refuse unwanted connections
    }
  } else {
    if (!checkSign(this.authed.key, m.signature, signatureStringifyer(m))) return; //Ignore messages that don't seem legit

    //When a signal Server requests connected nodes
    if (m.type == "REQNODES") {
      var arr = [];

      //make an array of connected nodes
      for (i in nodes) {
        if (i == this.authed.ident) continue; //Doin't include the node that made the request
        if (ip.isPrivate(nodes[i].address)) continue;
        var o = {};
        for (x in nodes[i]) if (x != "ws") o[x] = nodes[i][x]; // Make sure to not include the socket object in the response
        arr.push(o);
      }

      //Send object
      this.sendSign({type: "NODES", arr: arr});
    } else if (m.type == "REQAUDITS" && m.arr != null && Array.isArray(m.arr)) {
      //Signal Server requested verifiection list for updates
      var arr = [];
      for (i in m.arr) for (x in verification) if (verification[x].verificationID == m.arr[i]) arr.push(verification[x]);
      this.sendSign({type: "AUDITS", arr: arr});
    } else if (m.type == "PING") {
      this.sendSign({type: "PONG"});
    } else if (m.type == "IPREPORT") {
      if (ip.isPrivate(this.ip) && m.data != null && !ip.isPrivate(m.data)) this.ip = m.data;
    }
  }
}

//When a connection comes in
function onConnection (ws, req) {
  //If we are waiting for our keys to be made we lock the server for a bit
  if (keys.private == null || keys.public == null) return ws.close();

  //Refuse connections from blocked IPs
  if (blocked.includes(req.socket.remoteAddress)) return ws.close();

  //We use a timeout system to avoid potential abuse or dead connections
  ws.timeout = setTimeout(function () {
    this.close();
  }.bind(ws), 1500);

  //log the IP
  ws.ipAddress = req.socket.remoteAddress;

  //This function allows us to send signed messages
  ws.sendSign = function (m) {
    m.signature = keySign(signatureStringifyer(m));
    ws.send(JSON.stringify(m));
  }

  //When the connection is closed
  ws.on("close", function () {
    //Clear timeout if any and remove node from network if needed
    clearTimeout(this.timeout);
    if (this.authed != null) {
      delete nodes[this.authed.ident];
    }
  });

  //Bind our message handler
  ws.on("message", onMessage);
}
