let i = 0;
while (i < 0) {
  console.log("never");
}
console.log("a");
for (let j = 5; j < 3; j = j + 1) {
  console.log("no");
}
console.log("b");
let x = 0;
while (x < 2) {
  console.log("s}");
  x = x + 1;
}
let y = 0;
for (; y < 2; y = y + 1) {
  console.log(y);
}
let z = 0;
for (let k = 0; k < 2;) {
  console.log("step empty");
  k = k + 1;
}
console.log("done");
