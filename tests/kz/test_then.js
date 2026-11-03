// .then() chaining over arbitrary receivers.
let x = 5;

x.then(r => { console.log(r); });

console.log(x.then(r => r + 1));

x.then(r => { console.log(r); }).then(r => { console.log(r + 1); });

function inc(n) { return n + 1; }
console.log(x.then(inc));

console.log(x.then((a, b) => a + 1));
console.log(x.then(() => 42));
console.log(x.then(r => { return r + 2; }));

let i = 0;
while (i < 2) {
  x.then(r => { console.log(r + i); });
  i = i + 1;
}
