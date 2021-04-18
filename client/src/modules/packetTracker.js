//The packet manager is responsible for keeping track of the packets we have received
//and the packets that appear to have timed out.

//All of the code below to the footer is key to the packet manager's
//Packet tracking, which keeps track of already received packets for resume capability

var arr = {};

var high = 0;
var based = -1;

function len (o) {
  var count = 0;
  for (i in o) count++;
  return count;
}

function cleanUp () {
  var before = len(arr);
  for (i in arr) {
    if (i <= based) delete arr[i];
    else if (i > based) break;
  }
  while (true) {
    if (arr[based+1] != 1) break;
    else if (arr[based+1] == 1) {
      based++;
      delete arr[based];
    }
  }
}

var int;

//Footer here

//External Module code
module.exports = class PacketTracker {
	//a == (array)
  constructor(a) {
		if (a) {
			arr = a.a;
      high = a.h
      based = a.b;
		}

    int = setInterval(cleanUp, 500); //Memory saving function

		//This value is used for custom packetTimeouts
		//Defualt packet Timeout is 2000;
		this.timeout = null;
  }

	push(id) {
		if (id == null) return -2;
    if (id <= based) return -1; //Duplicate Packet
		if (arr[id] == null || arr[id] == 0) {
			arr[id] = 1;
      if (id > high) high = id;
      if (id == based + 1) based = based+1;
			return 1; //Packet was not duplicate
		} else {
			return -1; //Duplicate Packet
		}
	}

	//destroys any and all intervals
	destroy () {
		clearInterval(int);
		int = null;
	}

	//Return amount of packets received
	count () {
    cleanUp();
		return based+1+len(arr);
	}

  //Most Recent Packet ID
  high () {
    return high;
  }

	//Generate object to store locally
	fileOutput () {
		cleanUp();
		var localFile = {};
		localFile.a = arr;
    localFile.b = based;
    localFile.h = high;
		return localFile;
	}

  getBase () {
    return based;
  }
};
