const WebSocket = require('ws');
const crypto = require('crypto');
const EventEmitter = require('events');
const ip = require('ip');

var peer;
var serverLogs;

//Setting up our events
function setupEvents () {

}

//When we get disconnected for any reason
function onDisconnect (reason) {
  peer.state = 2;
  peer.emit("close", reason);
}

//When we get a message from a peer
function onMessage (m) {
  try {
    m = JSON.parse(m);
  } catch (e) {
    return peer.close("MESSMALFORM");
  }
  peer.emit("message", m);
}

//When the connection is closed
function onClose () {
  //This is where we decide if a close was expected or not
  if ((peer.state == 0 && this.err == null) || (peer.state == 3 && this.err == null)) {
    onDisconnect("ERRUNEXPECTEDCLOSE");
  } else if (this.err != null) onDisconnect(this.err); //Closed due to unknown error
  else peer.emit("close", "CLOSED"); //Emmit the closed event
  peer.state = 2; //Set the peer state
}

//When the socket is open
function onOpen () {
  peer.state = 1; //Connected

  //When we connect to a peer we identify ourselves
  var o = {verif: peer.self.verification, type: "SIGSERVERCON", ident: peer.self.ident, port: peer.self.port, reported: peer.self.reported};
  peer.socket.sendSign(o);
}

//When errors occur
function onError (e) {
  this.err = e.code; //We set the error state of the peer connection

  //Deal with errors where the connection was just refused
  if (e.code != "ECONNREFUSED" && e.code != "ETIMEDOUT" && e.code != "ECONNRESET") {
    peer.emit("error", e); //Other errors we just spit them out
  }
}

//Sign the data with our priavte key
function keySign (data) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.write(data);
  signer.end();
  return signer.sign(peer.self.key.private, 'base64');
}

//Converts json objects to strings without signatures, helps with generating signatures and verification
function signatureStringifyer (o) {
  var string = "";
  for (i in o) if (i != "signature") string += o[i].toString();
  return string;
}

//state: 0 = Connecting, 1 = Connected, 2 = Closed, 3 = Authenticating
module.exports = class Peer extends EventEmitter {
  constructor (server, vars, slog, received) {
    //required variables for the object
    if (vars == null) throw "ERRNOIDENT";
    if (server == null) throw "ERRNOSERVER";
    if (slog == null) throw "ERRNOSLOG";

    super(); //This makes this whole thing work as a proper event emitter
    this.self = {};
    serverLogs = slog;
    peer = this;
    this.self.ident = vars.identifier; //Our ident code
    this.self.key = vars.keys; //our keys
    this.self.port = vars.listeningPort; //listening port
    this.self.reported = vars.reportedIP;
    this.id = server.id; //the ID or ident code of the server we are connecting to
    this.state = 0; //Connecting
    this.verified = null; //Verification entry of the peer
    this.type = "client"; //whether or not this is a client we connected to or one that connected to us

    if (received == null) {
      this.socket = new WebSocket('ws://' + server.address + ":" + server.port);
    } else {
      this.socket = received;
      this.socket.removeAllListeners("open");
      this.socket.removeAllListeners("close");
      this.socket.removeAllListeners("error");
      this.socket.removeAllListeners("message");
      this.state = 1; //Connected
    }

    //Setup our send function for signed messages
    this.socket.sendSign = function (m) {
      m.signature = keySign(signatureStringifyer(m));
      peer.socket.send(JSON.stringify(m));
    }

    this.self.verification = vars.verified; //Our verification entry for proving our verification to other peers

    //Set event handlers for the socket
    this.socket.on("open", onOpen);
    this.socket.on("close", onClose);
    this.socket.on("error", onError);
    this.socket.on("message", onMessage);
    //this.emit('connecting');
  }

  //close function for our object
  close () {
    if (this.state == 2) return -1; //Connection already closed

    //try forcing the connection closed
    try {
      this.socket.close();
    } catch (e) {
      if (e.toString().indexOf("WebSocket was closed before the connection was established") > -1) {
        peer.emit("close", "CLOSED");
      }
    }
  }

  //Send data to the peer
  send (data) {
    if (this.state != 1) return -1; //Don't do that if the peer is not connected yet
    data.signature = keySign(signatureStringifyer(data)); //Calculate signature
    this.socket.send(JSON.stringify(data)); //Send message
  }
}
