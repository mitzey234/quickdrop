# QuickDrop

QuickDrop is a free to use suite of software and servers that can be used to quickly, securely and completely transfer files from machine to machine using P2P based networking and a decentralized network. You can opt to create your own network or use the publicly available network. QuickDrop is made in Node.js and powered by electron.js


# Client

## Installing the client

No installation required, download a release and open the executable. The client is hardcoded to connect to public networks but will allow custom networks to be used in the future. Save directory config is a future feature. For now the program will save in the local directory of the program.

## Building the client

Building the client on your own machine requires having Node.js and NPM installed. If you meet these requirements use `npm i` and `npm run make` to build a executable version of QuickDrop. It will be placed in the `./out` folder.

## Running the client directly

If for some reason you want to run the client live without building, you can run the client in `./client` with `npm start`. This command will take care of all dependencies and launch the client.

# Semi-Decentralized Network

QuickDrop makes use of a semi-decentralized network of nodes. Each node is responsible for allowing clients to communicate with each other on a basic level. This network IS NOT designed for transfering file data or any large amounts of data. Nodes are also responsible for providing necessary client information between connecting clients to facilitate P2P connections.

## Node server

Node servers are designed to try and connect to the network by communicating with other nodes on the network. Node information is shared amongst other nodes on the network. TO secure the network, only verified nodes can interact with the network. This verification is safeguarded by private and public keys and managed by the verification server. Even if the verification server is unavailable, the network should still be able to fully function without it.

the node server is in `./SignalingServer` and contains a `sigServer.js` file that is to be run to start the server as such `node sigServer.js`.  Ports and verification server address information is hardcoded into the `sigServer.js` file and should be changed where necessary.

## Verification Server

The verification server is responsible for keeping the node network maintained and up to date. It also serves node server information to connecting clients to allow them to find a node they can connect to. This does mean that fresh clients will rely on the central verification server being online in order to find new nodes. The verification server also is responsible for verifying nodes and removing their verification if need be. This functionality is coming soon.
Start the server with `node verificationServer.js` which is located in `./VerificationServer`

# Issues
If you have any issues feel free to post them. Please remember there is only so much that can be done when you are on restricted networks. I might soon release a tool that can tell you your network type and help in troubleshooting any P2P issues you might be having. If you run into errors or crashes please provide me with screenshots or console output as well as what you did to reach that state. The best way to capture console output is to run the electron app through CMD / Terminal or by launching the app with `npm start` instead of the compiled version. Please note this repo will only be maintained as often as I can be available.

If you want to help with this project you may contact me at alex1001(at)live(dot)ca
