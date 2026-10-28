// Stress 5: recursion 400 calls deep (a frame box for each call on the
// stack), and many small objects alive at once: each call makes an array
// that the next call points to.
function build(depth, parent) {
  const here = [depth, parent];
  if (depth === 0) return here;
  return build(depth - 1, here);
}
const last = build(400, null);

let length = 0;
for (let at = last; at; at = at[1]) length++;
console.log(length);
