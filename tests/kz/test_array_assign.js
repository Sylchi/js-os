let a = [10, 20, 30];
a[1] = 77;
console.log(a);
let i = 2;
a[i] = 88;
console.log(a);
a[0] = a[2];
console.log(a);
a[5] = 1;
a[-1] = 1;
console.log(a);
let arr = [1, 2];
arr[0] = 5;
console.log(arr);
let inner = [1, 2];
let outer = [inner, 3];
console.log(outer);
inner[0] = 9;
console.log(outer);
console.log(inner);
let lvl2 = [1, 2];
let lvl1 = [lvl2, 3];
let top = [lvl1, 4];
console.log(top);
lvl2[0] = 9;
console.log(top);
let n = [1, 2]
n[0] = 7
console.log(n)
