// Locals are per-call: writes inside a function do not leak into the caller.
let x = 1;
function test() {
    let x = 999;
    x = x + 1;
    console.log(x);
}
console.log("before");
test();
console.log("after");
console.log(x);
