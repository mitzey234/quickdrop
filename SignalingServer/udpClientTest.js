const dgram = require('dgram');

control = dgram.createSocket({type: 'udp4'});

control.on('listening', () => {
  const address = control.address();
  console.log(`On ${address.address}:${address.port}`);
});

control.on('message', function (m,r) {
  console.log(r,m.toString());
});

control.on('error', (e) => {
  console.error(e);
  process.exit(2);
});

setInterval(function () {
  control.send(new Buffer.from("TEST2"), 7676, "192.168.1.121");
}, 1000);
