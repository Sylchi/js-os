let g = 40;
function addg(x) {
    return x + g;
}
console.log(addg(2));

let state = 5;
function touch() {
    state = 99;
    return state;
}
console.log(touch());
console.log(state);

function sumTo(n) {
    let s = 0;
    let i = 0;
    while (i < n) {
        s = s + i;
        i = i + 1;
    }
    return s;
}
console.log(sumTo(5));

function classify(n) {
    if (n > 3) {
        return 1;
    } else {
        return 0;
    }
}
console.log(classify(5));
console.log(classify(2));

function seven() {
    return 7;
}
console.log(seven());

function greet() {
    return "hi";
}
console.log(greet());

function echo(x) {
    return x;
}
console.log(echo("ok"));

function sumFor(n) {
    let s = 0;
    for (let i = 0; i < n; i = i + 1) {
        s = s + i;
    }
    return s;
}
console.log(sumFor(6));

function find(n) {
    let i = 0;
    while (i < n) {
        if (i > 2) {
            return i;
        }
        i = i + 1;
    }
    return 0;
}
console.log(find(6));
console.log(find(1));

function identity(a) {
    return a;
}
console.log(identity([1, 2, 3])[1]);

function join(a, b) {
    return a + b;
}
console.log(join("hello", "world"));

function nothing() {
    let x = 5;
}
console.log(nothing());

function viaConsole(x) {
    console.log(x);
    return x + 1;
}
console.log(viaConsole(6));

function viaArray() {
    return [1, 2, 3];
}
console.log(viaArray()[1]);

let box = [9];
function viaIndex() {
    return box[0];
}
console.log(viaIndex());

function helper(x) {
    return x + 1;
}
function viaCall(x) {
    return helper(x);
}
console.log(viaCall(4));

let d0 = 1;
let d1 = 2;
let d2 = 3;
let d3 = 4;
let d4 = 5;
let d5 = 6;
let d6 = 7;
let d7 = 8;
let d8 = 9;
let d9 = 10;
let d10 = 11;
let d11 = 12;
let d12 = 13;
let d13 = 14;
let d14 = 15;
let d15 = 16;
let d16 = 17;
function many(x) {
    return x + d0 + d1 + d2 + d3 + d4 + d5 + d6 + d7 + d8 + d9 + d10 + d11 + d12 + d13 + d14 + d15 + d16;
}
console.log(many(1));
