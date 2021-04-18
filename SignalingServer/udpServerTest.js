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

control.bind(7676);
