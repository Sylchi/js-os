let x = 5;
if (x > 3) { console.log("then"); } else { console.log("else"); }
if (x < 3) { console.log("no"); } else { console.log("else2"); }
if (x < 3) {
  console.log("a");
} else if (x < 4) {
  console.log("b");
} else if (x < 6) {
  console.log("c");
} else {
  console.log("d");
}
let total = 0;
for (let i = 0; i < 5; i = i + 1) {
  if (i == 2) {
    total = total + 10;
  } else if (i == 3) {
    total = total + 100;
  } else {
    total = total + 1;
  }
}
console.log(total);
let a = [1, 2, 3];
if (a.length > 2) {
  let n = 0;
  while (n < a.length) {
    if (a[n] == 2) {
      console.log("two");
    }
    n = n + 1;
  }
} else {
  console.log("short");
}
if (1) {
  if (0) {
    console.log("inner no");
  } else {
    console.log("inner else");
  }
} else {
  console.log("outer else");
}
if (x == 5) {
  console.log("brace } in string");
}
if (x == 2) {
  console.log("never");
} else if (x == 5) {
  console.log("elseif match");
} else {
  console.log("last");
}
if (x == 2) {
  console.log("nope");
}else if(x == 5){
  console.log("inline elseif");
}else{
  console.log("inline last");
}
let s = "{";
if (s == "{") {
  console.log("brace match");
} else {
  console.log("no match");
}
let t = "}";
if (t == "}") {
  console.log("close match");
}
console.log("done");
