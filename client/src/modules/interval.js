//Interval.js is respnsible for running a function a certain amount of times each second
const EventEmitter = require('events');
const NanoTimer = require('nanotimer');
const now = require('nano-time');

var c = 0;
var measuredSpeed = 0;
var lastUpdate = null;
var updateSpeed = 1;

var evt;

//setInterval(update,1000/updateSpeed);
//update();

//The updater, used for mesauring speed
/*
function update () {
  var e = parseFloat(now()/1000000000);
  var d = e - lastUpdate;
  lastUpdate=e;
  measuredSpeed = c/d;
  c = 0;
}
*/

//The execute function
function exec () {
  evt.emit('exec');
  //c++;
}

function pause () {
  while (ints.length > 0) clearInt(ints.pop());
  waitForPause = setTimeout(function () {
    waitForPause = null;
  }, 1200);
}

var ints = [];

/* Old code for pausing between speed changes
var waitForPause;
*/

var timers = {};

function setInts(f) {
  /* Old code for pausing between speed changes
  if (waitForPause != null) return -1;
  waitForPause = setTimeout(function () {
    waitForPause = null;
  }, 1200);
  */
  for (i in timers) {
    timers[i].clearTimeout();
    delete timers[i];
  }
  while (ints.length > 0) clearInt(ints.pop());
  var calc = Math.round(1000000000/f);
  for (var i = 0; i < f; i++) {
    var timerA = new NanoTimer();
    timerA.listId = len(timers);
    timers[timerA.listId] = timerA;
    timerA.setTimeout(function (timerA) {
      var int = setInt(exec, 1000);
      ints.push(int);
      delete timers[timerA.listId];
    }, [timerA], (calc*(i%1000000000))+'n');
  }
  evt.emit('complete');
}

function setInt (func, t) {
  var o = {};
  o.exec = func;
  o.continue = true;
  o.time = t*1000000;
  o.next = parseInt(now());
  o.check = function () {
    if (!this.continue) return;
    var current = parseInt(now());
    if (current >= this.next) {
      this.exec()
      this.next = this.next + this.time;
      this.check.bind(this)();
    } else {
      setTimeout(this.check.bind(this), ((this.next-current)/1000000));
    }
  }
  o.check();
  return o;
}

function clearInt (i) {
  i.continue = false;
}

//Returns length of an object
function len (a) {
	if (!a || (typeof a) != "object") return -1;
  var count = 0;
  for (i in a) count++;
  return count;
}

module.exports = class Interval {
  //S = initSpeed
  constructor(s) {
    if (!s) throw "Missing Speed Parameter!";
    this.speed = s; //Speed that is currently set, DO NOT CHANGE THIS, USE setSpeed()!
    this.paused = true;
    this.e = new EventEmitter();
    evt = this.e;
  }

  setSpeed (s) {
    if (setInts(s) == -1) return -1;
    this.paused = false;
    this.speed = s;
  }

  /*
  measuredSpeed () {
    return measuredSpeed;
  }
  */

  pause () {
    if (waitForPause != null) return;
    if (this.paused) return -1;
    this.paused = true;
    pause();
  }
}
