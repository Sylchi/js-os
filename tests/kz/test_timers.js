console.log("start");
let cancelled = setTimeout(() => { console.log("never"); }, 5);
clearTimeout(cancelled);
setTimeout(() => { console.log("zero"); }, 0);
setTimeout(() => { console.log("ten"); }, 10);
setTimeout(() => { console.log("twelve"); }, 12);
let id = setInterval(() => { console.log("tick"); }, 3);
setTimeout(() => { clearInterval(id); console.log("stop"); }, 8);
setTimeout(() => {
  console.log("outer");
  setTimeout(() => { console.log("inner"); }, 0);
}, 15);
setTimeout(() => console.log("expr"), 18);
console.log("end");
