// Definitions are sequential: a call before the definition is unknown and
// evaluates to 0. A later redefinition shadows the earlier one.
console.log(later(5));
function later(x) {
    return x + 1;
}
console.log(later(5));

function f() {
    return 1;
}
console.log(f());
function f() {
    return 2;
}
console.log(f());
