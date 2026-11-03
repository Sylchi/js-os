let collision = 11;

function helper(x) {
    return x + 1;
}

function first(a, collision) {
    return helper(a);
}

console.log(first(3, 4));
console.log(collision);

function two(n) {
    if (n > 3) {
        return 0;
    }
    return n + two(n + 1) + two(n + 2);
}
console.log(two(1));
