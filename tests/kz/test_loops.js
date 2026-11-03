let i = 0;
while (i < 5) {
  console.log(i);
  i = i + 1;
}
for (let j = 0; j < 3; j = j + 1) {
  console.log(j);
}
let r = 0;
let c = 0;
while (c < 3) {
  let d = 0;
  while (d < 2) {
    let r = r + (c + d);
    let d = d + 1;
  }
  let c = c + 1;
}
console.log(r);
let a = [10, 20, 30, 40];
let n = 0;
while (n < a.length) {
  console.log(a[n]);
  n = n + 1;
}
let b = [];
for (let k = 0; k < 4; k = k + 1) {
  b.push(k + 1);
}
console.log(b);
console.log(b.length);
let q = 5;
while (q == 5) {
  console.log("eq");
  q = 6;
}
while (q != 8) {
  q = q + 1;
}
console.log(q);
for (let m = 0; m <= 2; m = m + 1) {
  console.log(m);
}
let z = 0;
while (z < 2)
{
  console.log("brace");
  z = z + 1
}
