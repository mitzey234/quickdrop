const electron = require('electron');
clipboard = electron.clipboard;
const ipc = electron.ipcRenderer;

global.ipc = ipc;

ipc.on('networkOpen', function(event, arg) {
    console.log("Network connected: " + arg);
    document.getElementById("copyuuidButton").classList.remove("disabled");
    uuid = arg;
});

ipc.on('networkClosed', function (event, arg) {
  console.log("Network lost: " + arg);
  document.getElementById("copyuuidButton").classList.add("disabled");
  uuid = null;
});

ipc.on('peerProg', function (event, arg) {
  updatePeer(arg.peer, arg.msg)

});

ipc.on('peerPing', function (event, arg) {
  updatePeerPing(arg.peer, arg.msg);
});

ipc.on('peerConnected', function (event, arg) {
  //arg = peer
  peerConnected(arg);
});

ipc.on('peerDisconnected', function (event, arg) {
  //arg = peer
  peerDisconnected(arg);
});

ipc.on('transferStateUpdate', function (event, arg) {
  updateTransferEntries(arg.transfer);
  if (arg.state == 7 && document.getElementById("pte"+arg.transfer.id) != null) {
    $( "#pte"+arg.transfer.id ).remove();
  }
  var machineID;
  if (arg.transfer.type == 0) machineID = arg.transfer.destination;
  else if (arg.transfer.type == 1) machineID = arg.transfer.source;
  if (arg.transfers != null) {
    if (document.getElementById("navBadge"+machineID) != null) {
      document.getElementById("navBadge"+machineID).innerText = arg.transfers.length;
    }
    var dSum = 0;
    var uSum = 0;
    for (x in arg.transfers) {
      var t = arg.transfers[x];
      if ([2,3,4].includes(t.state)) {
        if (t.info != null && t.info.speed != null && t.type == 0) uSum += t.info.speed;
        if (t.info != null && t.info.speed != null && t.type == 1) dSum += t.info.speed;
      }
    }
    if (document.getElementById("tu"+machineID) != null) document.getElementById("tu"+machineID).innerText = "Upload: " + generateSize(uSum) +"/s";
    if (document.getElementById("td"+machineID) != null) document.getElementById("td"+machineID).innerText = "Download: " + generateSize(dSum) +"/s";
  }
  if (arg.totalStats != null) {
    document.getElementById("totalUpload").innerText = "Upload: " + generateSize(arg.totalStats.upload) +"/s";
    document.getElementById("totalDownload").innerText = "Download: " + generateSize(arg.totalStats.download) +"/s";
  }
  console.log(1, arg);
});

ipc.on('transferCreate', function (event, arg) {
  //arg = transfer
  updateTransferEntries(arg);
  console.log(arg);
});

ipc.on('transferDelete', function (event, arg) {
  //arg = transfer
  if (document.getElementById("pte"+arg.transfer.id) != null) {
    $( "#pte"+arg.transfer.id ).remove();
  }
  if (document.getElementById("ate"+arg.transfer.id) != null) {
    $( "#ate"+arg.transfer.id ).remove();
  }
  if (arg.transfers.length == 0) {
    $( "#nav"+arg.mid ).remove();
    $( "#"+arg.mid ).remove();
    if (activeTab == arg.mid) tabChange(document.getElementById("navtransfers"));
  }
  if (document.getElementById("navBadge"+arg.mid) != null) {
    document.getElementById("navBadge"+arg.mid).innerText = arg.transfers.length;
  }
});

ipc.send("attach", null);
