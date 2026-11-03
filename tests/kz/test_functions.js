let g = 10;
function add(a, b) {
    return a + b;
}
console.log(add(20, 22));
console.log(add(add(1, 2), 3));

function sumTo(n, max) {
    if (n > max) {
        return 0;
    }
    return n + sumTo(n + 1, max);
}
console.log(sumTo(1, 5));

function depth(n) {
    if (n < 100) {
        return depth(n + 1);
    }
    return n;
}
console.log(depth(0));

function readg() {
    return g;
}
console.log(readg());

function writeg() {
    g = 99;
    console.log(g);
}
writeg();
console.log(g);

function early(n) {
    let i = 0;
    while (i < 10) {
        if (i == n) {
            return i + 100;
        }
        i = i + 1;
    }
    return 0;
}
console.log(early(3));

function mk() {
    return [4, 5, 6];
}
function str() {
    return "hello";
}
console.log(mk()[1]);
console.log(str().length);

function two(n) {
    if (n > 3) {
        return 0;
    }
    return n + two(n + 1) + two(n + 2);
}
console.log(two(1));

function noargs() {
    return 7;
}
console.log(noargs());
console.log(add(5));
console.log(add(5, 6, 7));

function outer(a) {
    return add(a, 10);
}
console.log(outer(5));
